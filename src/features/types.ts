
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

export type TaskStatus = 'pending' | 'success' | 'failed';

export interface SubTask {
  id: number;
  type: 'file-operation' | 'shell-command' | 'mcp-tool' | 'ai-chat';
  category: string;
  description: string;
  successCriteria?: string;
}

export interface ChatMessage {
  id: string;
  timestamp: Date;
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageType: 'task_goal' | 'tool_execution' | 'tool_result' | 'verification' | 'suggestion' | 'error' | 'replan' | 'summary';
  subtaskId?: number;
  metadata?: {
    toolName?: string;
    toolArgs?: Record<string, any>;
    success?: boolean;
    error?: string;
  };
}

export interface TaskContext {
  originalGoal: string;
  pendingTasks: SubTask[];
  chatHistory: ChatMessage[];
  startTime: Date;
  lastUpdated: Date;
}

export interface TaskPlan {
  id: number;
  subTasks: SubTask[];
  goal: string;
  timestamp: Date;
  isReplan: boolean;
  replanReason?: string;
}

export enum TaskExecutionStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  REPLANNING = 'replanning',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

export interface TaskSummary {
  originalGoal: string;
  status: TaskExecutionStatus;
  totalDuration: number;
  successCount: number;
  failureCount: number;
  finalMessage: string;
}
