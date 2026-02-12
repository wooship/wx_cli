import OpenAI from 'openai';
import { AppConfig, ModelConfig } from './config.js';
import { logger } from '../utils/logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: any[];
}

export interface ModelResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | undefined;
}

export interface ModelAdapter {
  readonly name: string;
  readonly provider: string;
  
  validateConfig(config: ModelConfig): boolean;
  sendMessage(messages: ChatMessage[], options?: ModelOptions): Promise<ModelResponse>;
  streamMessage(messages: ChatMessage[], options?: ModelOptions): AsyncIterable<string>;
  supportsTools(): boolean;
}

export class ModelManager {
  private adapters: Map<string, ModelAdapter> = new Map();

  constructor(private config: AppConfig) {
    this.initializeAdapters();
  }

  private initializeAdapters(): void {
    for (const [name, modelConfig] of Object.entries(this.config.models.available)) {
      const adapter = this.createAdapter(modelConfig);
      if (adapter) {
        this.adapters.set(name, adapter);
      }
    }
  }

  private createAdapter(config: ModelConfig): ModelAdapter | null {
    // 检测提供商类型
    if (config.baseUrl.includes('openai.com') || config.baseUrl.includes('api.openai.com')) {
      return new OpenAIAdapter(config);
    } else if (config.baseUrl.includes('anthropic.com')) {
      return new AnthropicAdapter(config);
    } else {
      // 默认为OpenAI兼容的API
      return new OpenAIAdapter(config);
    }
  }

  async sendMessage(messages: ChatMessage[], options: ModelOptions = {}): Promise<ModelResponse> {
    const modelName = options.model || this.config.models.default;
    const adapter = this.adapters.get(modelName);

    if (!adapter) {
      throw new Error(`模型 ${modelName} 未找到或未配置`);
    }

    try {
      return await adapter.sendMessage(messages, options);
    } catch (error) {
      logger.error(`模型调用失败 (${modelName}):`, error);
      throw error;
    }
  }

  async *streamMessage(messages: ChatMessage[], options: ModelOptions = {}): AsyncIterable<string> {
    const modelName = options.model || this.config.models.default;
    const adapter = this.adapters.get(modelName);

    if (!adapter) {
      throw new Error(`模型 ${modelName} 未找到或未配置`);
    }

    try {
      yield* adapter.streamMessage(messages, { ...options, stream: true });
    } catch (error) {
      logger.error(`模型流式调用失败 (${modelName}):`, error);
      throw error;
    }
  }

  async testConnection(): Promise<{ [model: string]: boolean }> {
    const results: { [model: string]: boolean } = {};

    for (const [name, adapter] of this.adapters.entries()) {
      try {
        await adapter.sendMessage([
          { role: 'user', content: 'Hello' }
        ], { maxTokens: 5 });
        results[name] = true;
      } catch (error) {
        results[name] = false;
        logger.error(`模型 ${name} 连接测试失败:`, error);
      }
    }

    return results;
  }

  getAvailableModels(): string[] {
    return Array.from(this.adapters.keys()).filter((model): model is string => model !== undefined);
  }
}

class OpenAIAdapter implements ModelAdapter {
  readonly name = 'OpenAI';
  readonly provider = 'openai';
  private client: OpenAI;

  constructor(private config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  validateConfig(config: ModelConfig): boolean {
    return !!(config.apiKey && config.baseUrl && config.modelName);
  }

  async sendMessage(messages: ChatMessage[], options: ModelOptions = {}): Promise<ModelResponse> {
    const requestOptions: any = {
      model: options.model || this.config.modelName,
      messages: messages as any,
      temperature: options.temperature ?? 0.7,
    };

    if (options.maxTokens !== undefined) {
      requestOptions.max_tokens = options.maxTokens;
    }
    if (options.tools !== undefined) {
      requestOptions.tools = options.tools;
    }

    const response = await this.client.chat.completions.create(requestOptions);

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('模型未返回有效响应');
    }

    return {
      content: choice.message?.content || '',
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };
  }

  async *streamMessage(messages: ChatMessage[], options: ModelOptions = {}): AsyncIterable<string> {
    const requestOptions: any = {
      model: options.model || this.config.modelName,
      messages: messages as any,
      temperature: options.temperature ?? 0.7,
      stream: true,
    };

    if (options.maxTokens !== undefined) {
      requestOptions.max_tokens = options.maxTokens;
    }
    if (options.tools !== undefined) {
      requestOptions.tools = options.tools;
    }

    const stream = await this.client.chat.completions.create(requestOptions);

    for await (const chunk of stream as any) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  supportsTools(): boolean {
    return true;
  }
}

class AnthropicAdapter implements ModelAdapter {
  readonly name = 'Anthropic';
  readonly provider = 'anthropic';
  private client: OpenAI;

  constructor(private config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  validateConfig(config: ModelConfig): boolean {
    return !!(config.apiKey && config.baseUrl && config.modelName);
  }

  async sendMessage(messages: ChatMessage[], options: ModelOptions = {}): Promise<ModelResponse> {
    // Anthropic API与OpenAI兼容，可以直接使用OpenAI客户端
    const requestOptions: any = {
      model: options.model || this.config.modelName,
      messages: messages as any,
      temperature: options.temperature ?? 0.7,
    };

    if (options.maxTokens !== undefined) {
      requestOptions.max_tokens = options.maxTokens;
    }

    const response = await this.client.chat.completions.create(requestOptions);

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('模型未返回有效响应');
    }

    return {
      content: choice.message?.content || '',
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };
  }

  async *streamMessage(messages: ChatMessage[], options: ModelOptions = {}): AsyncIterable<string> {
    const requestOptions: any = {
      model: options.model || this.config.modelName,
      messages: messages as any,
      temperature: options.temperature ?? 0.7,
      stream: true,
    };

    if (options.maxTokens !== undefined) {
      requestOptions.max_tokens = options.maxTokens;
    }

    const stream = await this.client.chat.completions.create(requestOptions);

    for await (const chunk of stream as any) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  supportsTools(): boolean {
    return false; // Anthropic Claude目前不支持工具调用
  }
}