import { Intent, Action } from './types.js';
import { FileOperations, FileOperation } from './file-ops.js';
import { ShellOperations, ShellCommand } from './shell-ops.js';
import { ModelManager } from '../core/model.js';
import { MultiServerMCPClient } from './mcp/client.js';
import { logger } from '../utils/logger.js';

export interface Command {
  type: 'file-operation' | 'shell-command' | 'ai-chat' | 'mcp-tool';
  description: string;
  operation: FileOperation | ShellCommand | string | any;
  executor: 'fileOps' | 'shellOps' | 'modelManager' | 'mcp-tool';
  parameters: Record<string, any>;
}

export interface TranslationResult {
  success: boolean;
  commands: Command[];
  warnings: string[];
  errors: string[];
}

export class CommandTranslator {

  constructor(
    private fileOps: FileOperations,
    private shellOps: ShellOperations,
    private modelManager: ModelManager,
    private mcpClient?: MultiServerMCPClient
  ) {}

  async translateIntent(intent: Intent, executionHistory?: any[]): Promise<TranslationResult> {
    if (intent.type === 'ai-chat') {
      return { success: true, commands: await this.translateAIChat(intent), warnings: [], errors: [] };
    }
    if (intent.type === 'mcp-tool') {
        return { success: true, commands: await this.translateMCPTool(intent), warnings: [], errors: [] };
    }
    if (intent.type === 'shell-command') {
      return { success: true, commands: await this.translateShellCommand(intent), warnings: [], errors: [] };
    }
    if (intent.type === 'file-operation') {
      return { success: true, commands: await this.translateFileOperation(intent), warnings: [], errors: [] };
    }

    try {
      const result = await this.translateWithLLM(intent, executionHistory);
      for (const command of result.commands) {
        const validation = await this.validateCommand(command);
        if (!validation.valid) {
          result.errors.push(...validation.errors);
          result.success = false;
        }
      }
      return result;
    } catch (error: any) {
      logger.error('LLM 命令翻译失败:', error);
      return { success: false, commands: [], warnings: [], errors: [`命令翻译失败: ${error.message}`] };
    }
  }

  private async translateWithLLM(intent: Intent, executionHistory?: any[]): Promise<TranslationResult> {
    let mcpToolsInfo = ''; // ... (generation logic)
    let historyInfo = '';
    if (executionHistory && executionHistory.length > 0) {
        historyInfo = `\n【执行历史记录】\n` + executionHistory.map((r, i) => `${i+1}. ${r.command.description} -> ${r.success ? 'Success' : 'Failed'}`).join('\n');
    }

    const prompt = `
你是一个命令翻译专家。请将以下用户意图转换为具体的可执行命令配置。
【意图信息】
类型: ${intent.type}
类别: ${intent.category}
参数: ${JSON.stringify(intent.parameters, null, 2)}
动作: ${JSON.stringify(intent.actions, null, 2)}
${mcpToolsInfo}
${historyInfo}

【要求】
返回一个 JSON 对象，包含 "commands" 数组...
`;

    const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }]);
    const content = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(content);
    logger.info('从 LLM 收到的原始命令数据:', JSON.stringify(data, null, 2));

    // 将 LLM 返回的结构适配到内部 Command 结构
    const commands: Command[] = (data.commands || []).map((cmd: any) => {
      const newCmd: Command = {
        type: cmd.type,
        description: cmd.description,
        parameters: cmd.parameters || {},
        // 关键修复：根据 type 设置 executor
        executor: cmd.type === 'shell-command' ? 'shellOps' :
                  cmd.type === 'file-operation' ? 'fileOps' :
                  cmd.type === 'mcp-tool' ? 'mcp-tool' :
                  cmd.type === 'ai-chat' ? 'modelManager' : '' as any,
        // 关键修复：将 parameters 赋值给 operation
        operation: cmd.parameters || {}
      };
      return newCmd;
    });

    return { success: true, commands: commands, warnings: [], errors: [] };
  }

  private async translateAIChat(intent: Intent): Promise<Command[]> {
    return [{
      type: 'ai-chat',
      description: intent.actions[0]?.description || 'AI对话',
      operation: intent.parameters.message || '',
      executor: 'modelManager',
      parameters: intent.parameters
    }];
  }

  private async translateMCPTool(intent: Intent): Promise<Command[]> {
    const commands: Command[] = [];
    if (intent.actions && intent.actions.length > 0) {
      for (const action of intent.actions) {
        const { server, tool, args } = action.parameters;
        if (!server || !tool) {
          logger.warn(`MCP action "${action.description}" 缺少 server 或 tool 参数，已跳过`);
          continue;
        }
        commands.push({
          type: 'mcp-tool',
          description: action.description || '执行MCP工具',
          executor: 'mcp-tool',
          operation: { server, tool, args, description: action.description, },
          parameters: action.parameters,
        });
      }
    }
    return commands;
  }

  private async translateShellCommand(intent: Intent): Promise<Command[]> {
    const commands: Command[] = [];
    for (const action of intent.actions) {
      const { command, args } = action.parameters;
      if (!command) {
        logger.warn(`Shell action "${action.description}" 缺少 command 参数，已跳过`);
        continue;
      }
      commands.push({
        type: 'shell-command',
        description: action.description,
        executor: 'shellOps',
        operation: { command, args: args || [] },
        parameters: action.parameters,
      });
    }
    return commands;
  }

  private async translateFileOperation(intent: Intent): Promise<Command[]> {
    const commands: Command[] = [];
    for (const action of intent.actions) {
      const { type, path, content, destination } = action.parameters;
      if (!type || !path) {
        logger.warn(`File action "${action.description}" 缺少 type 或 path 参数，已跳过`);
        continue;
      }
      commands.push({
        type: 'file-operation',
        description: action.description,
        executor: 'fileOps',
        operation: { type, path, content, destination },
        parameters: action.parameters,
      });
    }
    return commands;
  }

  private async validateCommand(command: Command): Promise<{ valid: boolean; errors: string[] }> {
    return { valid: true, errors: [] };
  }

  displayTranslationResult(result: TranslationResult): void {
    // ...
  }

  displayCommand(cmd: Command): string {
    let details = '';
    if (cmd.type === 'shell-command') {
      const shellCmd = cmd.operation as ShellCommand | string;
      const cmdStr = typeof shellCmd === 'string' ? shellCmd : `${shellCmd.command} ${shellCmd.args?.join(' ') || ''}`;
      details = `执行Shell命令: ${cmdStr}`;
    } else if (cmd.type === 'file-operation') {
      const fileOp = cmd.operation as FileOperation;
      details = `文件操作: ${fileOp.type} ${fileOp.path}`;
    } else if (cmd.type === 'mcp-tool') {
        const mcpOp = cmd.operation as any;
        details = `执行MCP工具: ${mcpOp.server}/${mcpOp.tool}`;
    } else {
      details = cmd.description;
    }
    return details;
  }
}