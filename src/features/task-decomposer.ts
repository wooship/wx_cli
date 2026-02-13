import { ModelManager } from '../core/model.js';
import { logger } from '../utils/logger.js';
import { Intent, Action, SubTask, TaskPlan, TaskContext } from './types.js';
import { ConnectionManager } from './mcp/connection.js';
import { ExecutionResult } from './command-executor.js';

export class TaskDecomposer {
  private planIdCounter = 0;

  constructor(
    private modelManager: ModelManager,
    private connectionManager: ConnectionManager
  ) {}

  async createInitialPlan(goal: string): Promise<TaskPlan> {
    const systemPrompt = this.getInitialPlanningSystemPrompt();
    const userPrompt = `请为以下用户目标制定任务计划: "${goal}"`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      const content = this.cleanResponseContent(response.content);
      const planData = JSON.parse(content);
      const subTasks = this.parseSubTasks(planData);

      const plan: TaskPlan = {
        id: ++this.planIdCounter,
        subTasks,
        goal,
        timestamp: new Date(),
        isReplan: false
      };

      logger.info(`创建初始任务计划，包含 ${subTasks.length} 个子任务`);

      return plan;
    } catch (error) {
      logger.error('创建初始任务计划失败:', error);
      return {
        id: ++this.planIdCounter,
        subTasks: [],
        goal,
        timestamp: new Date(),
        isReplan: false
      };
    }
  }

  async planNextSubTask(context: TaskContext): Promise<SubTask | null> {
    const systemPrompt = this.getIncrementalPlanningSystemPrompt();
    const contextInfo = this.formatContextForPlanning(context);
    const userPrompt = `基于当前执行上下文，规划下一个子任务：\n\n${contextInfo}\n\n如果任务已完成，请返回 { "completed": true }`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      const content = this.cleanResponseContent(response.content);
      const result = JSON.parse(content);

      if (result.completed || result.complete) {
        logger.info('任务目标已完成');
        return null;
      }

      if (!result.subTask) {
        throw new Error('LLM 未返回有效的子任务');
      }

      const nextTaskId = context.chatHistory.filter(m => m.messageType === 'task_goal').length + 1;
      const subTask: SubTask = {
        id: nextTaskId,
        type: result.subTask.type,
        category: result.subTask.category || '',
        description: result.subTask.description || `任务 ${nextTaskId}`,
        successCriteria: result.subTask.successCriteria
      };

      logger.info(`规划下一个子任务 [${nextTaskId}]: ${subTask.description}`);

      return subTask;
    } catch (error) {
      logger.error('规划下一个子任务失败:', error);
      return null;
    }
  }

  async replanWithFeedback(
    lastResult: ExecutionResult,
    context: TaskContext,
    errorReason: string,
    suggestion?: string
  ): Promise<TaskPlan> {
    const systemPrompt = this.getReplanningSystemPrompt();
    const contextInfo = this.formatContextForPlanning(context);

    const userPrompt = `请分析上述失败信息和当前执行进度，重新规划后续的所有任务以完成用户目标。

【用户目标】: ${context.originalGoal}
【失败原因】: ${errorReason}

【当前上下文】
${contextInfo}

【要求】
1. 重新规划所有后续任务
2. 只返回后续任务，不要包含已经完成的任务
3. 参考聊天历史中的失败记录，避免重复错误`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      const content = this.cleanResponseContent(response.content);

      if (!content || content.trim() === '') {
        throw new Error('LLM 返回空响应');
      }

      let planData: any;
      let parseError: Error | null = null;
      const maxRetries = 2;
      
      for (let retry = 0; retry <= maxRetries; retry++) {
        try {
          planData = JSON.parse(content);
          parseError = null;
          break;
        } catch (e) {
          parseError = e as Error;
          logger.warn(`JSON解析尝试 ${retry + 1}/${maxRetries + 1} 失败，尝试修复...`);
          
          const braceStart = content.indexOf('{');
          const bracketStart = content.indexOf('[');
          
          if (braceStart !== -1 || bracketStart !== -1) {
            const fixedContent = this.cleanResponseContent(content);
            try {
              planData = JSON.parse(fixedContent);
              parseError = null;
              logger.info('JSON 修复成功');
              break;
            } catch {
            }
          }
          
          if (retry === maxRetries) {
            logger.error('解析 LLM 响应 JSON 失败，已达最大重试次数:', content.slice(0, 200));
            throw new Error(`JSON 解析失败，已重试 ${maxRetries + 1} 次`);
          }
        }
      }

      if (parseError) {
        throw parseError;
      }

      const subTasks = this.parseSubTasks(planData);

      if (subTasks.length === 0) {
        logger.warn('重新规划未生成任何子任务');
      }

      const plan: TaskPlan = {
        id: ++this.planIdCounter,
        subTasks,
        goal: context.originalGoal,
        timestamp: new Date(),
        isReplan: true,
        replanReason: errorReason
      };

      logger.info(`基于失败反馈重新规划后续任务，包含 ${subTasks.length} 个新子任务`);

      return plan;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('重新规划任务失败:', errorMessage);
      return {
        id: ++this.planIdCounter,
        subTasks: [],
        goal: context.originalGoal,
        timestamp: new Date(),
        isReplan: true,
        replanReason: errorReason
      };
    }
  }

  async checkGoalCompleted(context: TaskContext): Promise<{ completed: boolean; message: string }> {
    if (context.chatHistory.length === 0) {
      return { completed: false, message: '尚未执行任何任务' };
    }

    const systemPrompt = `你是一个任务完成度评估专家。根据用户原始目标和聊天历史，判断是否已达到最终目标。
返回 JSON: { "completed": boolean, "message": "完成情况描述" }`;

    const contextSummary = this.formatContextSummary(context);

    const userPrompt = `评估任务完成度：\n用户目标: ${context.originalGoal}\n聊天历史:\n${contextSummary}`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      const content = this.cleanResponseContent(response.content);
      const result = JSON.parse(content);

      return {
        completed: result.completed,
        message: result.message
      };
    } catch (error) {
      logger.error('评估任务完成度失败:', error);
      return { completed: false, message: '无法评估完成度' };
    }
  }

  async decompose(input: string, context: any = {}): Promise<Intent> {
    const mcpClients = this.connectionManager.getAllClients();
    let mcpToolInfo = '';
    if (mcpClients.length > 0) {
      const toolPromises = mcpClients.map(async ({ serverName, client }) => {
        try {
          const { tools: toolDefs } = await client.listTools();
          let serverTools = '';
          for (const toolDef of toolDefs) {
            serverTools += `- ${serverName}/${toolDef.name}: ${toolDef.description}\n`;
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
          }
          return serverTools;
        } catch (error) {
          logger.error('获取MCP工具信息失败:', error);
          return '';
        }
      });
      const toolInfos = await Promise.all(toolPromises);
      mcpToolInfo = toolInfos.join('\n');
    }

    const systemPrompt = `你是一个顶级任务规划和意图识别引擎。你的核心任务是分析用户的复杂需求，并将其分解成一个结构严谨、可直接执行的单一意图(Intent)JSON对象。你需要根据用户的意图，在不同类型的可用工具中做出最合理的选择。

【可用工具】
你拥有三大类工具：
1.  **Shell命令 (shell-command)**: 用于执行系统命令、文件查找、文本搜索等。
    -   \`type\`: "shell-command"
    -   \`category\`: "shell-execute", "shell-find", "shell-grep" 等。
    -   \`action.type\`: "shell-execute"
    -   \`action.parameters\`: { "command": "要执行的命令", "args": ["参数1", "参数2"] }

2.  **文件操作 (file-operation)**: 用于创建、读取、写入、删除文件或目录。
    -   \`type\`: "file-operation"
    -   \`category\`: "file-read", "file-write", "file-delete", "dir-create" 等。
    -   \`action.type\`: "file-read", "file-write" 等。
    -   \`action.parameters\`: { "path": "文件路径", "content": "文件内容" }

3.  **MCP 远程工具 (mcp-tool)**: 用于与外部服务（如浏览器）交互。
${mcpToolInfo}

【核心指令】
1.  **意图识别**: 准确判断用户的核心意图。如果用户指令明显是关于文件或系统命令（如 "列出目录", "查找文件", "删除日志"），必须优先选择 "shell-command" 或 "file-operation" 类型的意图。只有当用户明确提到网站、浏览器或需要联网查询时，才使用 "mcp-tool"。
2.  **一步到位**: 将用户的整个需求分解成一个扁平的、包含所有执行步骤的 "actions" 数组。
3.  **参数完整性**: 为每个 Action 填充**必须**的 "parameters"。
4.  **纯净JSON**: 绝对不能返回任何JSON对象之外的文本、解释或代码块标记。

【输出格式要求】
你必须严格按照以下JSON结构返回：
{
  "type": "意图类型 (必须是 'shell-command', 'file-operation', 或 'mcp-tool')",
  "category": "具体类别",
  "confidence": 0.9,
  "parameters": {},
  "actions": [
    {
      "type": "操作类型 (例如 'shell-execute', 'file-read', 'mcp-tool-call')",
      "description": "对这个操作步骤的清晰、自然的中文描述",
      "parameters": { ... }
    }
  ]
}

【示例】
**示例 1：Shell 操作**
用户输入: "列出当前目录，然后查找名为 'readme.md' 的文件"
返回:
{
  "type": "shell-command",
  "category": "shell-batch",
  "confidence": 0.98,
  "parameters": {},
  "actions": [
    {
      "type": "shell-execute",
      "description": "列出当前目录中的所有文件和文件夹",
      "parameters": { "command": "ls", "args": ["-l"] }
    },
    {
      "type": "shell-execute",
      "description": "在当前目录及其子目录中查找名为 'readme.md' 的文件",
      "parameters": { "command": "find", "args": [".", "-name", "readme.md"] }
    }
  ]
}

**示例 2：浏览器操作**
用户输入: "打开百度，搜索今日金价"
返回:
{
  "type": "mcp-tool",
  "category": "browser-automation",
  "confidence": 0.95,
  "parameters": {},
  "actions": [
    {
      "type": "mcp-tool-call",
      "description": "打开百度首页",
      "parameters": {
        "server": "chrome-devtools",
        "tool": "navigate_page",
        "args": { "url": "https://www.baidu.com" }
      }
    },
    {
      "type": "mcp-tool-call",
      "description": "在搜索框中输入'今日金价'",
      "parameters": {
        "server": "chrome-devtools",
        "tool": "type_text",
        "args": { "text": "今日金价" }
      }
    }
  ]
}`;

    const userPrompt = `请分解以下用户需求: "${input}"\n上下文: ${JSON.stringify(context, null, 2)}`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      let content = this.cleanResponseContent(response.content);
      const intentData = JSON.parse(content) as Intent;
      
      this.validateIntent(intentData);

      logger.debug(`任务分解和意图识别成功，生成 ${intentData.actions.length} 个actions。`);
      
      return intentData;

    } catch (error) {
      logger.error('任务分解和意图识别失败:', error);
      return {
        type: 'unknown',
        category: 'unknown',
        confidence: 0,
        parameters: {},
        actions: []
      };
    }
  }

  private validateIntent(intent: Intent): void {
    if (!intent.type || !intent.category) {
      throw new Error('意图数据缺少必要字段');
    }
    if (intent.confidence < 0 || intent.confidence > 1) {
      throw new Error('置信度必须在0-1之间');
    }
    if (!Array.isArray(intent.actions)) {
      intent.actions = [];
    }
    if (typeof intent.parameters !== 'object') {
      intent.parameters = {};
    }
  }

  private cleanResponseContent(content: string): string {
    let cleaned = content.trim();
    
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7, -3).trim();
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3, -3).trim();
    } else if (cleaned.startsWith('`')) {
      cleaned = cleaned.slice(1, -1).trim();
    }

    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    
    let jsonStart = -1;
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      jsonStart = firstBrace;
    } else if (firstBracket !== -1) {
      jsonStart = firstBracket;
    }

    if (jsonStart !== -1) {
      let braceCount = 0;
      let bracketCount = 0;
      let inString = false;
      let escapeNext = false;

      for (let i = jsonStart; i < cleaned.length; i++) {
        const char = cleaned[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"' || char === "'") {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (char === '[') bracketCount++;
        if (char === ']') bracketCount--;

        if (braceCount === 0 && bracketCount === 0 && i > jsonStart) {
          return cleaned.substring(jsonStart, i + 1).trim();
        }
      }

      return cleaned.substring(jsonStart).trim();
    }

    return cleaned;
  }

  private async getMcpToolInfo(): Promise<string> {
    const mcpClients = this.connectionManager.getAllClients();
    if (mcpClients.length === 0) return '';

    const toolPromises = mcpClients.map(async ({ serverName, client }) => {
      try {
        const { tools: toolDefs } = await client.listTools();
        let serverTools = '';
        for (const toolDef of toolDefs) {
          serverTools += `- ${serverName}/${toolDef.name}: ${toolDef.description}\n`;
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
        }
        return serverTools;
      } catch (error) {
        logger.error('获取MCP工具信息失败:', error);
        return '';
      }
    });
    const toolInfos = await Promise.all(toolPromises);
    return toolInfos.join('\n');
  }

  private getInitialPlanningSystemPrompt(): string {
    return `你是一个专业的任务规划专家。你的任务是将用户的目标分解为一组可执行的原子子任务。

【可用任务类型】
1. Shell命令 (shell-command): 执行系统命令、文件操作、查找、搜索等
2. 文件操作 (file-operation): 读取、写入、复制、移动、删除文件
3. MCP工具 (mcp-tool): 与外部服务交互（如浏览器自动化）
4. AI对话 (ai-chat): 与模型进行文本交互

【核心原则】
- 将复杂任务分解为独立的、可验证的子任务
- 每个子任务应该是原子操作，可以独立执行和验证
- 子任务之间应该有明确的依赖关系和顺序
- 为每个子任务定义成功的标准
- 不要预设任何参数，参数在执行时根据实际情况生成

【示例】
用户目标: 打开百度搜索今日金价
返回:
{
  "subTasks": [
    {
      "id": 1,
      "type": "mcp-tool",
      "category": "browser-automation",
      "description": "打开百度首页",
      "successCriteria": "页面成功加载"
    },
    {
      "id": 2,
      "type": "mcp-tool",
      "category": "browser-automation",
      "description": "在搜索框中输入'今日金价'",
      "successCriteria": "搜索框中显示'今日金价'"
    },
    {
      "id": 3,
      "type": "mcp-tool",
      "category": "browser-automation",
      "description": "点击搜索或按回车执行搜索",
      "successCriteria": "页面跳转到搜索结果"
    }
  ]
}`;
  }

  private getIncrementalPlanningSystemPrompt(): string {
    return `你是一个专业的增量任务规划专家。你的任务是基于当前执行进度，规划下一个子任务。

【可用任务类型】
1. Shell命令 (shell-command): 执行系统命令、文件操作、查找、搜索等
2. 文件操作 (file-operation): 读取、写入、复制、移动、删除文件
3. MCP工具 (mcp-tool): 与外部服务交互（如浏览器自动化）
4. AI对话 (ai-chat): 与模型进行文本交互

【关键要求】
- 分析已完成的工作和当前上下文
- 规划下一个最合理的子任务
- 如果用户目标已经达成，返回 { "completed": true }

【子任务格式】
subTask 对象必须包含以下字段：
- type: 任务类型 ("shell-command", "file-operation", "mcp-tool", "ai-chat")
- category: 任务分类 (如 "browser-automation", "file-ops" 等)
- description: 清晰的任务描述（必需）
- successCriteria: 成功标准（可选）

【输出格式】
返回纯JSON，不要包含任何解释或markdown标记：
{"subTask": {...}} 或 {"completed": true}

示例:
{
  "subTask": {
    "type": "mcp-tool",
    "category": "browser-automation",
    "description": "在搜索框中输入'今日金价'",
    "successCriteria": "搜索框中显示'今日金价'"
  }
}`;
  }

  private getReplanningSystemPrompt(): string {
    return `你是一个专业的任务调整专家。你的任务是针对失败的子任务，重新规划后续的所有任务。

【可用任务类型】
1. Shell命令 (shell命令): 执行系统命令
2. 文件操作 (file-operation): 读取、写入、复制、移动、删除文件
3. MCP工具 (mcp-tool): 与外部服务交互（如浏览器自动化）
4. AI对话 (ai-chat): 与模型进行文本交互

【重规划原则】
- 分析失败原因和错误信息，找出根本原因
- 基于当前上下文和用户目标，重新规划所有后续任务
- 不要包含已完成的任务
- 可以包含多个后续任务

【重要】返回纯JSON，subTasks 数组，不要包含任何解释、说明文字或markdown标记：` + JSON.stringify({
  subTasks: [
    { id: 1, type: "mcp-tool", category: "browser-automation", description: "清晰描述任务1", successCriteria: "成功标准" },
    { id: 2, type: "mcp-tool", category: "browser-automation", description: "清晰描述任务2", successCriteria: "成功标准" }
  ]
}, null, 2) + `
JSON必须以 { 开始，以 } 结束，中间不要有换行后的多余文字。`;
  }

  private parseSubTasks(planData: any): SubTask[] {
    if (!planData.subTasks || !Array.isArray(planData.subTasks)) {
      return [];
    }

    const typeMapping: Record<string, string> = {
      'shell命令': 'shell-command',
      'shell-command': 'shell-command',
      'shell command': 'shell-command',
      '文件操作': 'file-operation',
      'file-operation': 'file-operation',
      'file operation': 'file-operation',
      'mcp-tool': 'mcp-tool',
      'mcp tool': 'mcp-tool',
      'ai-chat': 'ai-chat',
      'ai chat': 'ai-chat',
      'ai对话': 'ai-chat'
    };

    return planData.subTasks.map((task: any, index: number) => {
      const rawType = task.type || '';
      const normalizedType = typeMapping[rawType] || rawType;

      return {
        id: task.id || index + 1,
        type: normalizedType,
        category: task.category || '',
        description: task.description || '',
        successCriteria: task.successCriteria
      };
    });
  }

  private formatContextForPlanning(context: TaskContext): string {
    if (context.chatHistory.length === 0) {
      return `用户目标: ${context.originalGoal}\n\n尚未执行任何任务。`;
    }

    const parts = [
      `用户目标: ${context.originalGoal}`,
      '',
      '【执行历史 - 完整对话记录】'
    ];

    context.chatHistory.forEach(msg => {
      const roleLabel = msg.role === 'user' ? '我' : msg.role === 'assistant' ? 'AI' : '系统';
      const typeLabel = `[${msg.messageType}]`;

      if (msg.messageType === 'task_goal' && msg.subtaskId) {
        parts.push(`\n${roleLabel} (子任务${msg.subtaskId}): ${msg.content}`);
      } else if (msg.messageType === 'tool_execution' && msg.subtaskId) {
        parts.push(`\n${roleLabel} (子任务${msg.subtaskId}): 执行工具: ${msg.content}`);
        if (msg.metadata?.toolArgs) {
          parts.push(`  参数: ${JSON.stringify(msg.metadata.toolArgs, null, 2)}`);
        }
      } else if (msg.messageType === 'tool_result' && msg.subtaskId) {
        parts.push(`\n${roleLabel} (子任务${msg.subtaskId}): 返回结果: ${msg.content}`);
        if (msg.metadata?.success === false && msg.metadata?.error) {
          parts.push(`  失败: ${msg.metadata.error}`);
        }
      } else if (msg.messageType === 'verification') {
        parts.push(`\n${roleLabel}: 验证: ${msg.content}`);
      } else if (msg.messageType === 'error') {
        parts.push(`\n${roleLabel}: 错误: ${msg.content}`);
      } else if (msg.messageType === 'replan') {
        parts.push(`\n${roleLabel}: 重新规划: ${msg.content}`);
      } else {
        parts.push(`\n${roleLabel}: ${msg.content}`);
      }
    });

    if (context.pendingTasks.length > 0) {
      parts.push(`\n\n待执行任务: ${context.pendingTasks.length} 个`);
    }

    return parts.join('\n');
  }

  private formatContextSummary(context: TaskContext): string {
    const parts = [
      `用户目标: ${context.originalGoal}`,
      `已执行任务数: ${context.chatHistory.filter(m => m.messageType === 'task_goal').length}`,
      `待执行任务: ${context.pendingTasks.length} 个`,
      '',
      '【完整聊天历史】'
    ];

    context.chatHistory.forEach(msg => {
      const roleLabel = msg.role === 'user' ? '我' : msg.role === 'assistant' ? 'AI' : '系统';
      const typeLabel = msg.messageType ? `[${msg.messageType}]` : '';
      const taskId = msg.subtaskId ? ` (任务${msg.subtaskId})` : '';

      parts.push(`${roleLabel}${typeLabel}${taskId}: ${msg.content}`);
    });

    return parts.join('\n');
  }
}
