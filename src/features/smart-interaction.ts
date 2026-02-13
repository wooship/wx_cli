import { CommandTranslator, TranslationResult, Command } from './command-translator.js';
import { CommandExecutor, BatchExecutionResult, ExecutionResult } from './command-executor.js';
import { TaskDecomposer } from './task-decomposer.js';
import { SubTaskExecutor, SubTaskExecutionResult } from './subtask-executor.js';
import { ConnectionManager } from './mcp/connection.js';
import { Intent, Action, SubTask, TaskContext, TaskSummary, TaskExecutionStatus, TaskPlan, ChatMessage } from './types.js';
import { logger } from '../utils/logger.js';
import { MultiServerMCPClient } from './mcp/client.js';
import { ModelManager } from '../core/model.js';
import readline from 'readline';

export interface InteractionResult {
  input: string;
  success: boolean;
  timestamp: Date;
  duration: number;
  finalMessage: string;
}

export interface InteractionOptions {
  autoExecute?: boolean;
  confirmRiskyOperations?: boolean;
  silent?: boolean;
  rl?: any;
}

export class SmartInteraction {
  private history: InteractionResult[] = [];

  constructor(
    private taskDecomposer: TaskDecomposer,
    private commandTranslator: CommandTranslator,
    private commandExecutor: CommandExecutor,
    private modelManager: ModelManager,
    private mcpClient: MultiServerMCPClient,
    private connectionManager: ConnectionManager
  ) {
    if (mcpClient && (commandTranslator as any).mcpClient === undefined) {
      (commandTranslator as any).mcpClient = mcpClient;
    }
  }

  async processInput(input: string, options: InteractionOptions = {}): Promise<InteractionResult> {
    const startTime = Date.now();
    const overallResult: InteractionResult = {
      input,
      success: false,
      timestamp: new Date(),
      duration: 0,
      finalMessage: ''
    };

    try {
      if (!options.silent) logger.info(`开始处理目标: "${input}"`);

      // 1. 初始化 Context
      const context = this.initializeContext(input);

      // 2. 创建初始计划
      const initialPlan = await this.taskDecomposer.createInitialPlan(input);
      context.pendingTasks = initialPlan.subTasks;

      if (!options.silent) this.displayTaskPlan(context);

      // 3. 创建 SubTaskExecutor
      const subTaskExecutor = new SubTaskExecutor(
        this.modelManager,
        this.commandExecutor,
        this.connectionManager
      );

      // 4. 执行任务循环
      const maxCycles = 20;
      let cycleCount = 0;
      let lastGoalCheck: { completed: boolean; message: string } | null = null;

      while (cycleCount < maxCycles) {
        cycleCount++;

        // 检查是否还有待执行任务
        if (context.pendingTasks.length === 0) {
          lastGoalCheck = await this.taskDecomposer.checkGoalCompleted(context);
          if (lastGoalCheck.completed) {
            break;
          } else {
            const additionalTask = await this.taskDecomposer.planNextSubTask(context);
            if (!additionalTask) {
              if (!options.silent) logger.success('✓ 任务已完成');
              break;
            }
            context.pendingTasks.push(additionalTask);
            continue;
          }
        }

        // 获取下一个任务
        const nextSubTask = context.pendingTasks.shift();
        if (!nextSubTask) continue;

        // 确认高风险操作
        if (options.confirmRiskyOperations && this.isRiskySubTask(nextSubTask)) {
          const confirmed = await this.confirmSubTask(nextSubTask, options.rl);
          if (!confirmed) {
            if (!options.silent) logger.warn('用户取消执行');
            break;
          }
        }

        // 执行子任务
        const executionResult = await subTaskExecutor.executeSubTask(nextSubTask, context);

        // 更新 Context: 添加聊天记录
        executionResult.chatMessages.forEach(msg => {
          context.chatHistory.push(msg);
        });
        context.lastUpdated = new Date();

        // 检查是否成功
        if (!executionResult.success) {
          if (!options.silent) {
            logger.warn(`✗ 子任务失败: ${nextSubTask.description}`);
            // 显示最后的错误消息
            const errorMsg = executionResult.chatMessages.find(m => m.messageType === 'error');
            if (errorMsg) {
              logger.warn(errorMsg.content);
            }
          }

          // 重新规划
          const errorReason = executionResult.executionResult.error || '执行失败';
          const lastResult = executionResult.executionResult;

          try {
            const newPlan = await this.taskDecomposer.replanWithFeedback(
              lastResult as any,
              context,
              errorReason
            );
            context.pendingTasks = newPlan.subTasks;

            // 添加 replan 消息到历史
            const replanMsg: ChatMessage = {
              id: this.generateId(),
              timestamp: new Date(),
              role: 'system',
              content: `因失败重新规划: ${errorReason}`,
              messageType: 'replan'
            };
            context.chatHistory.push(replanMsg);

            if (!options.silent) {
              logger.info(`\n🔄 重新规划，共 ${context.pendingTasks.length} 个任务`);
              this.displayTaskPlan(context);
            }
            continue;
          } catch (replanError) {
            logger.error('重规划失败:', replanError);
            overallResult.finalMessage = `重规划失败`;
            break;
          }
        }

        if (!options.silent) {
          logger.info(`✓ 完成: ${nextSubTask.description}`);
        }
      }

      // 5. 生成最终摘要
      const summary = await this.generateTaskSummary(context, lastGoalCheck);

      overallResult.success = summary.status === TaskExecutionStatus.COMPLETED;
      overallResult.duration = Date.now() - startTime;
      overallResult.finalMessage = summary.finalMessage;

      this.history.push(overallResult);

      if (!options.silent) {
        logger.success(`✓ ${summary.finalMessage}`);
        this.displaySummary(summary);
      }

      return overallResult;

    } catch (error: any) {
      if (error instanceof Error) {
        logger.error(`处理失败: ${error.message}`, { stack: error.stack });
      } else {
        logger.error('处理失败:', JSON.stringify(error, null, 2));
      }
      overallResult.success = false;
      overallResult.duration = Date.now() - startTime;
      overallResult.finalMessage = `处理失败: ${error instanceof Error ? error.message : String(error)}`;
      return overallResult;
    }
  }

  private initializeContext(input: string): TaskContext {
    return {
      originalGoal: input,
      pendingTasks: [],
      chatHistory: [],
      startTime: new Date(),
      lastUpdated: new Date()
    };
  }

  private displayTaskPlan(context: TaskContext): void {
    logger.info('\n📋 任务计划:');
    logger.info(`目标: ${context.originalGoal}`);

    if (context.pendingTasks.length > 0) {
      logger.info(`待执行任务 (${context.pendingTasks.length} 个):`);
      logger.info('========================================');
      context.pendingTasks.forEach((task, index) => {
        logger.raw(`  ${index + 1}. ${task.description}`);
      });
    }

    // if (context.chatHistory.length > 0) {
    //   logger.info('');
    //   logger.info(`聊天记录数: ${context.chatHistory.length}`);
    // }

    logger.info('========================================');
  }

  private isRiskySubTask(subTask: SubTask): boolean {
    const riskyTypes = ['file-delete', 'file-move', 'shell-execute'];
    return riskyTypes.includes(subTask.type);
  }

  private async confirmSubTask(subTask: SubTask, rl?: any): Promise<boolean> {
    if (!rl) return true;

    logger.warn('\n⚠ 高风险操作需要确认:');
    logger.raw(`  操作: ${subTask.description}`);
    logger.raw(`  类型: ${subTask.type}`);

    return new Promise((resolve) => {
      rl.question('? 是否继续? (y/N) ', (answer: string) => {
        const normalizedAnswer = answer.trim().toLowerCase();
        resolve(normalizedAnswer === 'y' || normalizedAnswer === 'yes');
      });
    });
  }

  private async generateTaskSummary(context: TaskContext, goalCheckResult?: { completed: boolean; message: string } | null): Promise<TaskSummary> {
    const goalCheck = goalCheckResult ?? await this.taskDecomposer.checkGoalCompleted(context);

    const successCount = context.chatHistory.filter(m => m.messageType === 'tool_result' && m.metadata?.success).length;
    const failureCount = context.chatHistory.filter(m => m.messageType === 'tool_result' && m.metadata?.success === false).length;

    let finalMessage = goalCheck.message || '任务结束';

    if (goalCheck.completed && successCount > 0) {
      for (let i = context.chatHistory.length - 1; i >= 0; i--) {
        const msg = context.chatHistory[i];

        if (!msg || msg.messageType !== 'tool_result' || !msg.metadata?.success) {
          continue;
        }

        const content = msg.content;

        if (!content || content.length < 20) {
          continue;
        }

        const skipPattern = /^(工具返回|命令执行|操作执行|AI对话执行|文件操作执行)/;

        if (skipPattern.test(content)) {
          continue;
        }

        if (content.startsWith('total ') && content.includes('drwxr-xr-x')) {
          continue;
        }

        finalMessage = content;
        break;
      }

      if (!finalMessage || finalMessage === '任务结束') {
        finalMessage = await this.generateFinalSummary(context);
      }
    }

    return {
      originalGoal: context.originalGoal,
      status: goalCheck.completed ? TaskExecutionStatus.COMPLETED : TaskExecutionStatus.FAILED,
      totalDuration: Date.now() - context.startTime.getTime(),
      successCount,
      failureCount,
      finalMessage
    };
  }

  private displaySummary(summary: TaskSummary): void {
    logger.info('\n=== 任务执行汇总 ===');
    logger.info(`最终状态: ${summary.status}`);
    logger.info(`总耗时: ${summary.totalDuration}ms`);
    logger.info(`成功: ${summary.successCount} | 失败: ${summary.failureCount}`);
    logger.info('====================\n');
  }

  private async generateFinalSummary(context: TaskContext): Promise<string> {
    const chatHistoryText = context.chatHistory.map(msg => {
      const role = msg.role === 'user' ? '我' : msg.role === 'assistant' ? 'AI' : '系统';
      return `${role}: ${msg.content}`;
    }).join('\n\n');

    const prompt = `你是一个总结专家。用户的目标是: ${context.originalGoal}

请根据执行历史，用简洁的语言向用户汇报最终结果。

执行历史:
${chatHistoryText}

要求:
- 直接向用户汇报结果
- 简洁明了，一两句话
- 不要重复原始命令输出
- 如果有具体数据或答案，直接给出`;

    try {
      const response = await this.modelManager.sendMessage([{ role: 'user', content: prompt }], { temperature: 0.7 });
      return response.content;
    } catch (error) {
      return '任务完成';
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  getHistory(): InteractionResult[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
    logger.success('交互历史已清空');
  }

  async cleanup(): Promise<void> {
    try {
      await this.commandExecutor.cleanup();
      if (this.mcpClient) {
        await this.mcpClient.close();
      }
      this.clearHistory();
    } catch (error: any) {
      logger.error('清理失败:', error);
    }
  }
}
