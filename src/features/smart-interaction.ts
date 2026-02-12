import { CommandTranslator, TranslationResult, Command } from './command-translator.js';
import { CommandExecutor, BatchExecutionResult, ExecutionResult } from './command-executor.js';
import { TaskDecomposer } from './task-decomposer.js';
import { Intent, Action, SubTask, TaskContext, SubTaskResult, TaskSummary, TaskExecutionStatus, TaskPlan } from './types.js';
import { logger } from '../utils/logger.js';
import { MultiServerMCPClient } from './mcp/client.js';
import { ModelManager } from '../core/model.js';
import readline from 'readline';

export interface InteractionResult {
  input: string;
  subtasks?: string[];
  intent: Intent | null;
  commandTranslations: TranslationResult[];
  execution: BatchExecutionResult | null;
  success: boolean;
  timestamp: Date;
  duration: number;
}

export interface InteractionOptions {
  autoExecute?: boolean;
  confirmRiskyOperations?: boolean;
  silent?: boolean;
  rl?: any;
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
    private mcpClient?: MultiServerMCPClient
  ) {
    if (mcpClient && (commandTranslator as any).mcpClient === undefined) {
      (commandTranslator as any).mcpClient = mcpClient;
    }
  }

  async processInput(input: string, options: InteractionOptions = {}): Promise<InteractionResult> {
    const startTime = Date.now();
    const overallResult: InteractionResult = {
      input,
      intent: null,
      commandTranslations: [],
      execution: { results: [], successCount: 0, failureCount: 0, totalDuration: 0 },
      success: false,
      timestamp: new Date(),
      duration: 0
    };

    try {
      if (!options.silent) logger.info(`开始处理目标: "${input}"`);

      const context = this.initializeContext(input);
      const initialPlan = await this.taskDecomposer.createInitialPlan(input);
      context.pendingTasks = initialPlan.subTasks;

      if (!options.silent) this.displayTaskPlan(context);

      const maxCycles = 20;
      let cycleCount = 0;

      while (cycleCount < maxCycles) {
        cycleCount++;

        if (context.pendingTasks.length === 0) {
          const goalCheck = await this.taskDecomposer.checkGoalCompleted(context);
          if (goalCheck.completed) {
            if (!options.silent) logger.success(`✓ ${goalCheck.message}`);
            overallResult.success = true;
            break;
          } else {
            const additionalTask = await this.taskDecomposer.planNextSubTask(context);
            if (!additionalTask) {
              if (!options.silent) logger.success('✓ 任务已完成');
              overallResult.success = true;
              break;
            }
            context.pendingTasks.push(additionalTask);
            continue;
          }
        }

        const nextSubTask = context.pendingTasks.shift();
        if (!nextSubTask) continue;

        if (options.confirmRiskyOperations && this.isRiskySubTask(nextSubTask)) {
          const confirmed = await this.confirmSubTask(nextSubTask, options.rl);
          if (!confirmed) {
            if (!options.silent) logger.warn('用户取消执行');
            break;
          }
        }

        const subTaskResult = await this.executeSubTask(nextSubTask, context, options);
        context.completedTasks.push(subTaskResult);
        context.completedCount++;
        context.lastUpdated = new Date();

        const lastOutput: any = {
          success: subTaskResult.success
        };
        if (subTaskResult.output.data !== undefined) {
          lastOutput.data = subTaskResult.output.data;
        }
        if (subTaskResult.output.stdout !== undefined) {
          lastOutput.stdout = subTaskResult.output.stdout;
        }
        if (subTaskResult.output.stderr !== undefined) {
          lastOutput.stderr = subTaskResult.output.stderr;
        }
        context.lastOutput = lastOutput;

        if (subTaskResult.output.data && typeof subTaskResult.output.data === 'object') {
          Object.assign(context.accumulatedData, subTaskResult.output.data);
        }

        if (overallResult.execution) {
          overallResult.execution.results.push({
            success: subTaskResult.success,
            command: this.subTaskToCommand(nextSubTask),
            output: subTaskResult.output.data || subTaskResult.output,
            duration: subTaskResult.duration,
            timestamp: subTaskResult.timestamp
          });
          overallResult.execution.totalDuration += subTaskResult.duration;
          if (subTaskResult.success) {
            overallResult.execution.successCount++;
          } else {
            overallResult.execution.failureCount++;
          }
        }

        if (!subTaskResult.success || !subTaskResult.goalMet) {
          const errorReason = subTaskResult.verification.reason || '执行失败';
          const suggestion = subTaskResult.verification.suggestion;

          if (!options.silent) logger.warn(`✗ 子任务失败: ${errorReason}`);
          if (suggestion) {
            if (!options.silent) logger.info(`建议: ${suggestion}`);

            context.accumulatedSuggestions.push({
              taskId: subTaskResult.taskId,
              description: subTaskResult.description,
              error: errorReason,
              suggestion,
              timestamp: new Date()
            });
          }

          context.lastError = {
            taskId: subTaskResult.taskId,
            description: subTaskResult.description,
            error: errorReason,
            ...(suggestion ? { suggestion } : {})
          };

          try {
            const newPlan = await this.taskDecomposer.replanWithFeedback(subTaskResult, context, errorReason, suggestion);
            context.pendingTasks = newPlan.subTasks;

            if (!options.silent) {
              logger.info(`\n🔄 重新规划后续任务，共 ${context.pendingTasks.length} 个`);
              this.displayTaskPlan(context);
            }
            continue;
          } catch (replanError) {
            logger.error('重规划过程中出错:', replanError);
            if (!options.silent) logger.warn('重规划失败，任务终止');
            break;
          }
        }
      }

      const summary = await this.generateTaskSummary(context, options.silent);
      overallResult.success = summary.status === TaskExecutionStatus.COMPLETED;
      overallResult.duration = Date.now() - startTime;

      this.history.push(overallResult);

      if (!options.silent) {
        const finalSummary = await this.generateFinalSummary(context);
        logger.success(`✓ ${finalSummary}`);
        this.displaySummary(summary);
      }

      return overallResult;

    } catch (error: any) {
      if (error instanceof Error) {
        logger.error(`智能交互处理失败: ${error.message}`, { stack: error.stack });
      } else {
        logger.error('智能交互处理失败:', JSON.stringify(error, null, 2));
      }
      overallResult.success = false;
      overallResult.duration = Date.now() - startTime;
      return overallResult;
    }
  }

  private initializeContext(input: string): TaskContext {
    return {
      originalGoal: input,
      pendingTasks: [],
      completedTasks: [],
      accumulatedData: {},
      completedCount: 0,
      startTime: new Date(),
      lastUpdated: new Date(),
      accumulatedSuggestions: []
    };
  }

  private displayTaskPlan(context: TaskContext): void {
    logger.info('\n📋 任务计划:');
    logger.info(`目标: ${context.originalGoal}`);

    if (context.pendingTasks.length > 0) {
      logger.info(`待执行任务 (${context.pendingTasks.length} 个):`);
      logger.info('');
      context.pendingTasks.forEach((task, index) => {
        logger.raw(`  ${index + 1}. ${task.description}`);
      });
    }

    if (context.completedTasks.length > 0) {
      logger.info('历史任务(3):');
      context.completedTasks.slice(-3).forEach(task => {
        if (task.success) {
          logger.info(`  ✓ ${task.description}`);
        } else {
          logger.error(`  ✗ ${task.description}`);
        }
      });
    }
    logger.info('');
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
    logger.raw(`  参数: ${JSON.stringify(subTask.parameters, null, 2)}`);

    return new Promise((resolve) => {
      rl.question('? 是否继续? (y/N) ', (answer: string) => {
        const normalizedAnswer = answer.trim().toLowerCase();
        resolve(normalizedAnswer === 'y' || normalizedAnswer === 'yes');
      });
    });
  }

  private async executeSubTask(subTask: SubTask, context: TaskContext, options: InteractionOptions = {}): Promise<SubTaskResult> {
    const startTime = Date.now();

    const command = this.subTaskToCommand(subTask, context);

    const executionResult = await this.commandExecutor.executeCommand(command);

    const verification: any = executionResult.verification || { verified: false, isSuccess: executionResult.success, reason: '未验证' };

    if (!verification.verified && subTask.successCriteria) {
      const llmVerification = await this.verifyWithLLM(subTask, executionResult, context);
      Object.assign(verification, llmVerification);
    }

    const goalMet = verification.isSuccess && executionResult.success;

    return {
      taskId: subTask.id,
      description: subTask.description,
      success: executionResult.success,
      output: {
        data: executionResult.output,
        stdout: executionResult.output?.stdout,
        stderr: executionResult.output?.stderr,
        exitCode: executionResult.output?.exitCode,
        error: executionResult.error
      } as any,
      duration: Date.now() - startTime,
      timestamp: new Date(),
      verification,
      goalMet
    };
  }

  private subTaskToCommand(subTask: SubTask, context?: TaskContext): Command {
    const command: Command = {
      type: subTask.type,
      description: subTask.description,
      operation: subTask.parameters,
      executor: subTask.type === 'shell-command' ? 'shellOps' :
                subTask.type === 'file-operation' ? 'fileOps' :
                subTask.type === 'mcp-tool' ? 'mcp-tool' : 'modelManager',
      parameters: subTask.parameters
    };

    return command;
  }

  private async verifyWithLLM(subTask: SubTask, executionResult: ExecutionResult, context: TaskContext): Promise<any> {
    const systemPrompt = `你是一个执行结果验证专家。基于子任务的成功标准，判断执行是否达成了目标。
返回 JSON: { "isSuccess": boolean, "reason": "中文理由（最多50字）" }`;

    const userPrompt = `验证子任务执行结果：
子任务目标: ${subTask.description}
成功标准: ${subTask.successCriteria || '默认基于exitCode判断'}
执行类型: ${subTask.type}
执行参数: ${JSON.stringify(subTask.parameters, null, 2)}
执行结果: ${JSON.stringify(executionResult.output, null, 2)}
错误信息: ${executionResult.error || '无'}
累积数据: ${JSON.stringify(context.accumulatedData, null, 2).slice(0, 500)}`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.1 });

      const content = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(content);

      if (!result.isSuccess) {
        result.suggestion = await this.getSuggestionFromLLM(subTask, executionResult, result.reason, context);
      }

      return { verified: true, ...result };
    } catch (error) {
      logger.error('LLM验证失败:', error);
      return { verified: false, isSuccess: executionResult.success, reason: '验证失败，默认基于执行结果判断' };
    }
  }

  private async getSuggestionFromLLM(subTask: SubTask, executionResult: ExecutionResult, errorReason: string, context: TaskContext): Promise<string> {
    const systemPrompt = `你是一个问题解决专家。基于失败的子任务，给出一个简洁的补救建议（最多30字）。`;

    const userPrompt = `失败的子任务：
描述: ${subTask.description}
错误原因: ${errorReason}
执行结果: ${JSON.stringify(executionResult.output, null, 2)}
累积数据: ${JSON.stringify(context.accumulatedData, null, 2).slice(0, 300)}`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.3 });

      return response.content.trim();
    } catch (error) {
      logger.error('生成建议失败:', error);
      return '无建议';
    }
  }

  private async generateTaskSummary(context: TaskContext, silent = false): Promise<TaskSummary> {
    const goalCheck = await this.taskDecomposer.checkGoalCompleted(context);

    return {
      originalGoal: context.originalGoal,
      status: goalCheck.completed ? TaskExecutionStatus.COMPLETED : TaskExecutionStatus.FAILED,
      totalDuration: Date.now() - context.startTime.getTime(),
      successCount: context.completedTasks.filter(t => t.success).length,
      failureCount: context.completedTasks.filter(t => !t.success).length,
      results: context.completedTasks,
      finalMessage: goalCheck.message || '任务结束'
    };
  }

  private async generateFinalSummary(context: TaskContext): Promise<string> {
    if (context.completedTasks.length === 0) {
      return '未执行任何任务';
    }

    const lastTask = context.completedTasks[context.completedTasks.length - 1];
    if (!lastTask) {
      return `已完成：${context.originalGoal}`;
    }

    const keyResults = context.completedTasks
      .filter(t => t.success && t.output?.data)
      .slice(-3)
      .map(t => t.output?.data)
      .filter(Boolean);

    const systemPrompt = `你是一个任务执行总结专家。请用简洁的中文（1-2句话）总结任务结果。
要求：
- 直接给出用户最关心的核心结果
- 不要提及执行过程、失败尝试、循环次数等细节
- 不要使用"已成功完成"、"任务目标已达成"等套话
- 格式：直接描述结果或者告诉用户想知道的答案`;

    const userPrompt = `用户目标: ${context.originalGoal}
最后执行结果: ${JSON.stringify(lastTask.output?.data || lastTask, null, 2).slice(0, 500)}
关键数据: ${keyResults.map(k => JSON.stringify(k)).join('\n')}`;

    try {
      const response = await this.modelManager.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.3 });

      return response.content.trim();
    } catch (error) {
      return `已完成：${context.originalGoal}`;
    }
  }

  private displaySummary(summary: TaskSummary): void {
    logger.info('\n=== 任务执行汇总 ===');
    logger.info(`最终状态: ${summary.status}`);
    logger.info(`总耗时: ${summary.totalDuration}ms`);
    logger.info(`完成: ${summary.successCount} | 报错: ${summary.failureCount}`);
    logger.info('====================\n');
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
      logger.error('智能交互清理失败:', error);
    }
  }
}
