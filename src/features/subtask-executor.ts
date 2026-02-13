import { ModelManager } from '../core/model.js';
import { CommandExecutor, ExecutionResult } from './command-executor.js';
import { ConnectionManager } from './mcp/connection.js';
import { logger } from '../utils/logger.js';
import { SubTask, TaskContext, ChatMessage } from './types.js';

export interface SubTaskExecutionResult {
  subtaskId: number;
  success: boolean;
  executionResult: ExecutionResult;
  chatMessages: ChatMessage[];
}

export class SubTaskExecutor {
  constructor(
    private modelManager: ModelManager,
    private commandExecutor: CommandExecutor,
    private connectionManager: ConnectionManager
  ) {}

  async executeSubTask(subTask: SubTask, context: TaskContext): Promise<SubTaskExecutionResult> {
    const chatMessages: ChatMessage[] = [];
    const startTime = Date.now();

    // 1. 添加任务目标到聊天历史
    const goalMessage: ChatMessage = {
      id: this.generateId(),
      timestamp: new Date(),
      role: 'system',
      content: `子任务目标: ${subTask.description}${subTask.successCriteria ? `\n成功标准: ${subTask.successCriteria}` : ''}`,
      messageType: 'task_goal',
      subtaskId: subTask.id
    };
    chatMessages.push(goalMessage);

    // 2. 如果是 MCP 工具类型，获取工具信息并让 LLM 生成参数
    let executionResult: ExecutionResult;
    if (subTask.type === 'mcp-tool') {
      executionResult = await this.executeMcpWithLLM(subTask, context, chatMessages);
    } else {
      executionResult = await this.executeDefault(subTask, context, chatMessages);
    }

    // 3. 验证结果
    const verificationResult = await this.verifyResult(subTask, executionResult, context, chatMessages);

    const success = verificationResult.isSuccess;

    return {
      subtaskId: subTask.id,
      success,
      executionResult,
      chatMessages
    };
  }

  private async executeMcpWithLLM(
    subTask: SubTask,
    context: TaskContext,
    chatMessages: ChatMessage[]
  ): Promise<ExecutionResult> {
    // 1. 获取 MCP 工具信息
    const toolDocs = await this.getMcpToolDocs();

    // 2. 构建聊天历史上下文
    const chatHistoryContext = this.buildChatHistoryContext(context, chatMessages);

    // 3. 让 LLM 生成工具调用参数
    const prompt = `你是一个参数生成专家。根据子任务目标、聊天历史和 MCP 工具文档，生成具体的工具调用参数。

【子任务目标】
${subTask.description}

【MCP 工具文档】
${toolDocs}

【完整聊天历史】
${chatHistoryContext}

【要求】
- 根据子任务目标选择合适的 MCP 工具
- 从聊天历史中提取必要的参数值
- 生成完整的工具调用参数
- 返回真实的参数值，不要使用占位符或解释性文字
- 不要添加任何解释，直接返回 JSON

返回格式:
{
  "server": "serverName",
  "tool": "toolName",
  "args": {
    "参数名": "参数值"
  }
}`;

    try {
      const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }], { temperature: 0.1 });
      const toolCall = JSON.parse(this.cleanJsonResponse(response.content));

      // 记录工具执行消息
      const toolExecutionMsg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'user',
        content: `执行 ${toolCall.server}/${toolCall.tool}`,
        messageType: 'tool_execution',
        subtaskId: subTask.id,
        metadata: {
          toolName: `${toolCall.server}/${toolCall.tool}`,
          toolArgs: toolCall.args
        }
      };
      chatMessages.push(toolExecutionMsg);

      // 执行工具调用
      const command = {
        type: 'mcp-tool' as const,
        description: subTask.description,
        operation: { server: toolCall.server, tool: toolCall.tool, args: toolCall.args },
        executor: 'mcp-tool' as const,
        parameters: {}
      };

      const result = await this.commandExecutor.executeCommand(command);

        // 记录工具结果
        const toolResultMsg: ChatMessage = {
          id: this.generateId(),
          timestamp: new Date(),
          role: 'assistant',
          content: `工具返回: ${JSON.stringify(result.output)}`,
          messageType: 'tool_result',
          subtaskId: subTask.id,
          metadata: {
            toolName: `${toolCall.server}/${toolCall.tool}`,
            toolArgs: toolCall.args,
            success: result.success && !result.output?.isError,
            ...(result.error ? { error: result.error } : {}),
            ...(result.output?.isError ? { error: 'Tool returned error' } : {})
          }
        };
        chatMessages.push(toolResultMsg);

        const toolSuccess = result.success && !result.output?.isError;

        return {
          ...result,
          success: toolSuccess
        };
    } catch (error) {
      logger.error('LLM 生成工具参数失败:', error);

      const errorMsg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'system',
        content: `生成工具参数失败: ${error instanceof Error ? error.message : String(error)}`,
        messageType: 'error',
        subtaskId: subTask.id
      };
      chatMessages.push(errorMsg);

      return {
        success: false,
        command: {} as any,
        output: { error: error instanceof Error ? error.message : String(error) },
        error: error instanceof Error ? error.message : String(error),
        duration: 0,
        timestamp: new Date()
      };
    }
  }

  private async executeDefault(
    subTask: SubTask,
    context: TaskContext,
    chatMessages: ChatMessage[]
  ): Promise<ExecutionResult> {
    if (subTask.type === 'ai-chat') {
      return await this.executeAIChatWithContext(subTask, context, chatMessages);
    }

    if (subTask.type === 'shell-command') {
      return await this.executeShellWithLLM(subTask, context, chatMessages);
    }

    if (subTask.type === 'file-operation') {
      return await this.executeFileOpWithLLM(subTask, context, chatMessages);
    }

    throw new Error(`未知的子任务类型: ${subTask.type}`);
  }

  private async executeShellWithLLM(
    subTask: SubTask,
    context: TaskContext,
    chatMessages: ChatMessage[]
  ): Promise<ExecutionResult> {
    const chatHistory = this.buildChatHistoryContext(context, chatMessages);

    const prompt = `你是一个命令行专家。根据任务描述和聊天历史，生成具体的 shell 命令。

【任务描述】
${subTask.description}

【聊天历史】
${chatHistory}

【要求】
- 生成可直接执行的 shell 命令
- 命令要简洁、安全
- 只返回命令字符串，不要任何解释

示例:
find . -name "*.txt"
cat readme.md
ls -la`;

    try {
      const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }], { temperature: 0.1 });

      let commandStr = response.content.trim();
      commandStr = commandStr.replace(/^```shell\s*/, '').replace(/^```\s*$/, '').replace(/\s*```$/, '').trim();

      const command = {
        type: subTask.type,
        description: subTask.description,
        operation: { command: commandStr },
        executor: 'shellOps' as const,
        parameters: {}
      };

      const execMsg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'user',
        content: `执行命令: ${commandStr}`,
        messageType: 'tool_execution',
        subtaskId: subTask.id
      };
      chatMessages.push(execMsg);

      const result = await this.commandExecutor.executeCommand(command);

      let content: string;
      const output = result.output;

      if (output?.stdout) {
        content = output.stdout;
      } else if (output?.stderr) {
        content = `错误: ${output.stderr}`;
      } else if (typeof output === 'string') {
        content = output;
      } else {
        content = result.success ? '命令执行成功' : `命令执行失败: ${result.error}`;
      }

      const msg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'assistant',
        content,
        messageType: 'tool_result',
        subtaskId: subTask.id,
        metadata: {
          success: result.success
        }
      };
      chatMessages.push(msg);

      return result;
    } catch (error) {
      const errorMsg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'system',
        content: `生成命令失败: ${error instanceof Error ? error.message : String(error)}`,
        messageType: 'error',
        subtaskId: subTask.id
      };
      chatMessages.push(errorMsg);

      return {
        success: false,
        command: {} as any,
        output: { error: error instanceof Error ? error.message : String(error) },
        error: error instanceof Error ? error.message : String(error),
        duration: 0,
        timestamp: new Date()
      };
    }
  }

  private async executeFileOpWithLLM(
    subTask: SubTask,
    context: TaskContext,
    chatMessages: ChatMessage[]
  ): Promise<ExecutionResult> {
    const chatHistory = this.buildChatHistoryContext(context, chatMessages);

    const prompt = `你是一个文件操作专家。根据任务描述和聊天历史，生成具体的文件操作参数。

【任务描述】
${subTask.description}

【聊天历史】
${chatHistory}

【要求】
- 操作类型: read, write, copy, move, delete, create-dir
- 只返回 JSON，不要任何解释

返回格式:
{
  "type": "操作类型",
  "path": "文件路径",
  "content": "写入内容(仅write需要)",
  "targetPath": "目标路径(仅copy/move需要)"
}`;

    try {
      const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }], { temperature: 0.1 });

      let content = response.content.trim();
      content = content.replace(/^```json\s*/, '').replace(/^```\s*$/, '').replace(/\s*```$/, '').trim();

      const operation = JSON.parse(content);

      const command = {
        type: subTask.type,
        description: subTask.description,
        operation,
        executor: 'fileOps' as const,
        parameters: {}
      };

      const execMsg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'user',
        content: `执行文件操作: ${operation.type} ${operation.path}`,
        messageType: 'tool_execution',
        subtaskId: subTask.id
      };
      chatMessages.push(execMsg);

      const result = await this.commandExecutor.executeCommand(command);

      let resultContent: string;
      if (result.output) {
        resultContent = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      } else {
        resultContent = result.success ? '操作成功' : `操作失败: ${result.error}`;
      }

      const msg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'assistant',
        content: resultContent,
        messageType: 'tool_result',
        subtaskId: subTask.id,
        metadata: {
          success: result.success
        }
      };
      chatMessages.push(msg);

      return result;
    } catch (error) {
      const errorMsg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'system',
        content: `生成文件操作失败: ${error instanceof Error ? error.message : String(error)}`,
        messageType: 'error',
        subtaskId: subTask.id
      };
      chatMessages.push(errorMsg);

      return {
        success: false,
        command: {} as any,
        output: { error: error instanceof Error ? error.message : String(error) },
        error: error instanceof Error ? error.message : String(error),
        duration: 0,
        timestamp: new Date()
      };
    }
  }

  private async executeAIChatWithContext(
    subTask: SubTask,
    context: TaskContext,
    chatMessages: ChatMessage[]
  ): Promise<ExecutionResult> {
    const chatHistory = this.buildChatHistoryContext(context, chatMessages);

    const prompt = `你是一个智能助手。根据聊天历史完成以下任务：\n\n【任务描述】\n${subTask.description}\n\n【聊天历史】\n${chatHistory}`;

    const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }], { temperature: 0.7 });

    const msg: ChatMessage = {
      id: this.generateId(),
      timestamp: new Date(),
      role: 'assistant',
      content: response.content,
      messageType: 'tool_result',
      subtaskId: subTask.id,
      metadata: {
        success: true
      }
    };
    chatMessages.push(msg);

    return {
      success: true,
      command: {} as any,
      output: { content: response.content },
      duration: 0,
      timestamp: new Date()
    };
  }

  private async verifyResult(
    subTask: SubTask,
    executionResult: ExecutionResult,
    context: TaskContext,
    chatMessages: ChatMessage[]
  ): Promise<{ isSuccess: boolean; reason: string }> {
    const execSuccess = executionResult.success && !executionResult.output?.isError;

    // 如果工具执行本身失败，不需要 LLM 验证
    if (!execSuccess) {
      const errorReason = executionResult.output?.isError ?
        `工具返回错误` :
        (executionResult.error || '执行失败');

      const msg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'system',
        content: `验证: 失败 - ${errorReason}`,
        messageType: 'verification',
        subtaskId: subTask.id
      };
      chatMessages.push(msg);

      return { isSuccess: false, reason: errorReason };
    }

    const prompt = `你是一个结果验证专家。判断子任务是否成功。

【子任务目标】
${subTask.description}

【执行结果】
${JSON.stringify(executionResult.output, null, 2)}

【错误信息】
${executionResult.error || '无'}

返回 JSON: { "isSuccess": boolean, "reason": "中文理由" }`;

    try {
      const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }], { temperature: 0.1 });

      if (!response.content || response.content.trim() === '') {
        const msg: ChatMessage = {
          id: this.generateId(),
          timestamp: new Date(),
          role: 'system',
          content: `验证: 失败 - LLM返回空响应`,
          messageType: 'verification',
          subtaskId: subTask.id
        };
        chatMessages.push(msg);
        return { isSuccess: false, reason: 'LLM返回空响应' };
      }

      const result = JSON.parse(this.cleanJsonResponse(response.content));

      const msg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'system',
        content: `验证: ${result.isSuccess ? '成功' : '失败'} - ${result.reason}`,
        messageType: 'verification',
        subtaskId: subTask.id
      };
      chatMessages.push(msg);

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const details = errorMsg || (typeof error === 'object' ? JSON.stringify(error) : String(error));
      logger.error('LLM 验证失败:', error);

      const msg: ChatMessage = {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'system',
        content: `验证: 失败 - LLM验证失败${details ? `: ${details}` : ''}`,
        messageType: 'verification',
        subtaskId: subTask.id
      };
      chatMessages.push(msg);

      return {
        isSuccess: false,
        reason: `LLM验证失败${details ? `: ${details}` : ''}`
      };
    }
  }

  private cleanJsonResponse(content: string): string {
    let cleaned = content.trim();

    cleaned = cleaned.replace(/^```json\s*/i, '');
    cleaned = cleaned.replace(/^```\s*/, '');
    cleaned = cleaned.replace(/\s*```$/, '');

    return cleaned.trim();
  }

  private async getMcpToolDocs(): Promise<string> {
    const mcpClients = this.connectionManager.getAllClients();
    if (mcpClients.length === 0) return '';

    const toolPromises = mcpClients.map(async ({ serverName, client }) => {
      try {
        const { tools: toolDefs } = await client.listTools();
        let serverTools = `## ${serverName}\n`;
        for (const toolDef of toolDefs) {
          serverTools += `- ${toolDef.name}: ${toolDef.description}\n`;
          if (toolDef.inputSchema?.properties) {
            serverTools += `  参数:\n`;
            for (const [paramName, paramSchema] of Object.entries(toolDef.inputSchema.properties)) {
              const schema = paramSchema as any;
              const required = toolDef.inputSchema.required?.includes(paramName) ? ' (必需)' : ' (可选)';
              const type = schema.type || 'any';
              const desc = schema.description ? ` - ${schema.description}` : '';
              serverTools += `    ${paramName}: ${type}${required}${desc}\n`;
            }
          }
          serverTools += '\n';
        }
        return serverTools;
      } catch (error) {
        logger.error('获取MCP工具文档失败:', error);
        return '';
      }
    });
    const toolDocs = await Promise.all(toolPromises);
    return toolDocs.join('\n');
  }

  private buildChatHistoryContext(context: TaskContext, currentMessages: ChatMessage[]): string {
    if (context.chatHistory.length === 0) {
      return '尚无历史记录';
    }

    const parts = ['【完整聊天历史】'];
    context.chatHistory.forEach(msg => {
      const roleLabel = msg.role === 'user' ? '我' : msg.role === 'assistant' ? 'AI' : '系统';
      const typeLabel = msg.messageType ? `[${msg.messageType}]` : '';
      const taskId = msg.subtaskId ? ` (任务${msg.subtaskId})` : '';

      parts.push(`\n${roleLabel}${typeLabel}${taskId}: ${msg.content}`);
    });

    return parts.join('\n');
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private async generateSummary(subTask: SubTask, chatMessages: ChatMessage[]): Promise<ChatMessage | null> {
    const toolResultMsg = chatMessages.find(m => m.messageType === 'tool_result' && m.metadata?.success);

    if (!toolResultMsg || !toolResultMsg.content) {
      return null;
    }

    const prompt = `你是一个总结专家。根据任务描述和执行结果，用简洁的语言向用户汇报。

【任务描述】
${subTask.description}

【执行结果】
${toolResultMsg.content.slice(0, 2000)}

【要求】
- 直接向用户汇报结果，不要重复任务描述
- 简洁明了，一句话或几句话
- 如果结果是文件内容，直接展示关键内容`;

    try {
      const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }], { temperature: 0.7 });

      return {
        id: this.generateId(),
        timestamp: new Date(),
        role: 'assistant',
        content: response.content,
        messageType: 'summary',
        subtaskId: subTask.id,
        metadata: {
          success: true
        }
      };
    } catch (error) {
      return null;
    }
  }
}
