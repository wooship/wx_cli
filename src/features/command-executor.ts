import { Command } from './command-translator.js';
import { FileOperations } from './file-ops.js';
import { ShellOperations, CommandResult } from './shell-ops.js';
import { ModelManager } from '../core/model.js';
import { MultiServerMCPClient } from './mcp/client.js';
import { logger } from '../utils/logger.js';

export interface VerificationResult {
  verified: boolean;
  isSuccess: boolean;
  reason: string;
  suggestion?: string;
}

export interface ExecutionResult {
  success: boolean;
  command: Command;
  output?: any;
  error?: string;
  verification?: VerificationResult;
  duration: number;
  timestamp: Date;
}

export interface BatchExecutionResult {
  results: ExecutionResult[];
  successCount: number;
  failureCount: number;
  totalDuration: number;
}

export class CommandExecutor {
  private executionHistory: ExecutionResult[] = [];

  constructor(
    private fileOps: FileOperations,
    private shellOps: ShellOperations,
    private modelManager: ModelManager,
    private mcpClient: MultiServerMCPClient
  ) {}

  async executeCommand(command: Command): Promise<ExecutionResult> {
    const startTime = Date.now();
    const result: ExecutionResult = {
      success: false,
      command,
      duration: 0,
      timestamp: new Date()
    };
    try {
      logger.info(`执行: ${command.description}`);
      switch (command.executor) {
        case 'fileOps':
          result.output = await this.executeFileOperation(command);
          result.success = true;
          break;
        case 'shellOps':
          const shellResult = await this.executeShellCommand(command);
          result.output = shellResult;
          const verification = await this.verifyShellCommand(command, shellResult);
          result.verification = verification;
          if (verification.verified) {
            result.success = verification.isSuccess;
            if (!result.success) result.error = verification.reason;
          } else {
            result.success = shellResult.success;
            if (!result.success) result.error = shellResult.stderr || '命令执行失败';
          }
          break;
        case 'modelManager':
          result.output = await this.executeAIChat(command);
          result.success = true;
          break;
        case 'mcp-tool':
          result.output = await this.executeMcpTool(command);
          result.success = true; // 硬编码，垃圾 AI
          break;
        default:
          throw new Error(`未知的执行器: ${command.executor}`);
      }
      if (!result.verification?.verified) {
        if (!result.success) 
          logger.error(`✗ 执行失败`);
      }
    } catch (error: any) {
      result.success = false;
      result.error = error.message;
      logger.error(`✗ 执行失败: ${error.message}`);
    } finally {
      result.duration = Date.now() - startTime;
      this.executionHistory.push(result);
    }
    return result;
  }

  async executeCommands(
    commands: Command[],
    onAfterCommandExecute?: (command: Command, result: ExecutionResult, isLast: boolean) => Promise<'continue' | 'stop' | 'retry'>
  ): Promise<BatchExecutionResult> {
    const results: ExecutionResult[] = [];
    const startTime = Date.now();
    logger.info(`开始批量执行 ${commands.length} 个命令`);
    let i = 0;
    while (i < commands.length) {
      const command = commands[i];
      if (!command) {
        i++;
        continue;
      }
      const result = await this.executeCommand(command);
      results.push(result);
      if (onAfterCommandExecute) {
        const isLast = i === commands.length - 1;
        const action = await onAfterCommandExecute(command, result, isLast);
        if (action === 'stop') {
          logger.warn('用户终止了批量执行');
          break;
        }
        if (action === 'retry') {
          logger.info(`重试命令: ${command.description}`);
          results.pop();
          continue;
        }
      }
      if (!result.success && this.isCriticalOperation(command)) {
        logger.error('重要操作失败，停止执行后续命令');
        break;
      }
      i++;
    }
    const totalDuration = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;
    const batchResult: BatchExecutionResult = {
      results,
      successCount,
      failureCount,
      totalDuration,
    };
    this.displayBatchResult(batchResult);
    return batchResult;
  }

  private async executeFileOperation(command: Command): Promise<any> {
    const operation = command.operation as any;
    switch (operation.type) {
        case 'read': return await this.fileOps.readFile(operation.path, operation.encoding);
        case 'write': if (!operation.content) throw new Error('写入操作缺少内容'); return await this.fileOps.writeFile(operation.path, operation.content, operation.encoding);
        case 'copy': if (!operation.targetPath) throw new Error('复制操作缺少目标路径'); return await this.fileOps.copy(operation.path, operation.targetPath);
        case 'move': if (!operation.targetPath) throw new Error('移动操作缺少目标路径'); return await this.fileOps.move(operation.path, operation.targetPath);
        case 'delete': return await this.fileOps.delete(operation.path, operation.recursive);
        case 'create-dir': return await this.fileOps.createDirectory(operation.path, operation.recursive);
        default: throw new Error(`未知的文件操作类型: ${operation.type}`);
    }
  }

  private async executeShellCommand(command: Command): Promise<any> {
    const operation = command.operation as any;
    return typeof operation === 'string' ? await this.shellOps.executeCommand(operation) : await this.shellOps.executeCommand(operation);
  }

  private async executeMcpTool(command: Command): Promise<any> {
    const { server, tool, args } = command.operation as any;
    if (!this.mcpClient) throw new Error('MCP 客户端未初始化');
    logger.info(`调用 MCP 工具: ${server}/${tool}`);
    if (args) logger.debug(`  参数: ${JSON.stringify(args, null, 2)}`);
    return await this.mcpClient.callTool(server, tool, args);
  }

  private async executeAIChat(command: Command): Promise<any> {
    const message = command.operation as string;
    const messages = [{ role: 'user' as const, content: message }];
    return await this.modelManager.sendMessage(messages);
  }

  private async verifyShellCommand(command: Command, result: CommandResult): Promise<VerificationResult> {
    try {
        const prompt = `你是一个智能命令行助手。请根据用户的意图和命令执行结果，判断命令是否成功执行并达到了预期目标。\n\n【用户意图】\n${command.description}\n\n【执行命令】\n${result.command}\n\n【执行结果】\nExit Code: ${result.exitCode}\nStdout:\n${result.stdout ? result.stdout.slice(0, 1000) : '(empty)'}\nStderr:\n${result.stderr ? result.stderr.slice(0, 1000) : '(empty)'}\n\n请严格通过 JSON 格式返回分析结果：\n{\n  "isSuccess": boolean,\n  "reason": "判断理由",\n  "suggestion": "如果失败，给出建议"\n}`;
        const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }]);
        const content = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
        const analysis = JSON.parse(content);
        if (analysis.isSuccess) logger.info(`✓ 结果校验成功: ${analysis.reason}`);
        else logger.warn(`✗ 结果校验失败: ${analysis.reason}`);
        return { verified: true, ...analysis };
    } catch (error) {
        logger.error('命令执行结果校验失败:', error);
        return { verified: false, isSuccess: result.success, reason: 'AI校验失败，仅基于退出代码判断' };
    }
  }

  isCriticalOperation(command: Command): boolean {
    const criticalTypes = ['file-delete', 'file-move'];
    if (command.type === 'file-operation') {
      const op = command.operation as any;
      return criticalTypes.includes(op.type);
    }
    return false;
  }

  private displayBatchResult(result: BatchExecutionResult): void {
    if (result.failureCount > 0) {
      logger.error('失败的命令:');
      result.results.filter(r => !r.success).forEach((failed, index) => {
        logger.error(`  ${index + 1}. ${failed.command.description}`);
        logger.warn(`     错误: ${failed.error}`);
      });
    }
  }

  getExecutionHistory(): ExecutionResult[] {
    return [...this.executionHistory];
  }

  async cleanup(): Promise<void> {
    try {
      await this.shellOps.cleanup();
      this.executionHistory = [];
    } catch (error: any) {
      logger.error('资源清理失败:', error);
    }
  }
}