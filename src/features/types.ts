
export interface Intent {
  type: 'file-operation' | 'shell-command' | 'mcp-tool' | 'ai-chat' | 'unknown';
  category: string;
  confidence: number;
  parameters: Record<string, any>;
  actions: Action[];
}

export interface Action {
  type: 'file-read' | 'file-write' | 'file-copy' | 'file-move' | 'file-delete' | 'dir-create' |
        'shell-execute' | 'shell-batch' | 'shell-system-info' | 'shell-find' | 'shell-grep' |
        'mcp-tool-call' | 'ai-chat';
  description: string;
  parameters: Record<string, any>;
}

/**
 * 任务状态枚举
 */
export type TaskStatus = 'pending' | 'success' | 'failed';

/**
 * 带状态的任务
 */
export interface TaskWithStatus extends SubTask {
  status: TaskStatus;
  result?: SubTaskResult;
  retryCount?: number;
  isFollowUpTask?: boolean;
}

/**
 * 单个子任务的定义
 * 每个子任务都是原子操作，可以直接执行
 */
export interface SubTask {
  /** 子任务序号 */
  id: number;
  /** 子任务类型 */
  type: 'file-operation' | 'shell-command' | 'mcp-tool' | 'ai-chat';
  /** 子任务类别 */
  category: string;
  /** 子任务描述 */
  description: string;
  /** 子任务参数 */
  parameters: Record<string, any>;
  /** 预期的成功标准（用于结果验证） */
  successCriteria?: string;
}

/**
 * 子任务执行结果
 */
export interface SubTaskResult {
  /** 子任务ID */
  taskId: number;
  /** 子任务描述 */
  description: string;
  /** 是否成功执行 */
  success: boolean;
  /** 执行输出 */
  output: {
    data?: any;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
  };
  /** 执行耗时（毫秒） */
  duration: number;
  /** 执行时间 */
  timestamp: Date;
  /** 结果验证信息 */
  verification: {
    verified: boolean;
    isSuccess: boolean;
    reason: string;
    suggestion?: string;
  };
  /** 是否达到子任务目标 */
  goalMet: boolean;
}

/**
 * 任务执行上下文
 * 包含所有已执行子任务的信息和累积的输出结果
 */
export interface TaskContext {
  /** 用户原始目标 */
  originalGoal: string;
  /** 待执行的子任务列表 */
  pendingTasks: SubTask[];
  /** 已完成的子任务结果列表 */
  completedTasks: SubTaskResult[];
  /** 累积的输出数据（用于传递给下一个子任务） */
  accumulatedData: Record<string, any>;
  /** 上一个子任务的输出（用于下一个子任务的输入） */
  lastOutput?: {
    data?: any;
    stdout?: string;
    stderr?: string;
    success: boolean;
  };
  /** 最后的错误信息（如果有） */
  lastError?: {
    taskId: number;
    description: string;
    error: string;
    suggestion?: string;
  };
  /** 累积的所有模型建议（失败历史的宝贵信息） */
  accumulatedSuggestions: Array<{
    taskId: number;
    description: string;
    error: string;
    suggestion: string;
    timestamp: Date;
  }>;
  /** 已完成的子任务数量 */
  completedCount: number;
  /** 任务开始时间 */
  startTime: Date;
  /** 上次更新时间 */
  lastUpdated: Date;
}

/**
 * 任务计划
 * 包含待执行的子任务列表
 */
export interface TaskPlan {
  /** 计划ID */
  id: number;
  /** 子任务列表 */
  subTasks: SubTask[];
  /** 用户目标 */
  goal: string;
  /** 计划创建时间 */
  timestamp: Date;
  /** 是否是重新规划 */
  isReplan: boolean;
  /** 重新规划的原因 */
  replanReason?: string;
}

/**
 * 任务执行状态
 */
export enum TaskExecutionStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  REPLANNING = 'replanning',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

/**
 * 任务执行汇总
 */
export interface TaskSummary {
  /** 原始目标 */
  originalGoal: string;
  /** 最终状态 */
  status: TaskExecutionStatus;
  /** 总执行时间（毫秒） */
  totalDuration: number;
  /** 成功的子任务数量 */
  successCount: number;
  /** 失败的子任务数量 */
  failureCount: number;
  /** 所有子任务结果 */
  results: SubTaskResult[];
  /** 最终输出/完成消息 */
  finalMessage: string;
}