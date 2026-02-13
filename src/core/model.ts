import OpenAI from 'openai';
import { AppConfig, ModelConfig } from './config.js';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

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
  private enableChatLogging: boolean = true;
  private chatLogDir: string = path.join(process.cwd(), '.wx-cli', 'conversations');

  constructor(private config: AppConfig) {
    this.initializeAdapters();
    this.setupChatLogging();
  }

  private async setupChatLogging(): Promise<void> {
    try {
      await fs.mkdir(this.chatLogDir, { recursive: true });

      const files = await fs.readdir(this.chatLogDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      for (const file of jsonFiles) {
        await fs.unlink(path.join(this.chatLogDir, file));
      }
      
      if (jsonFiles.length > 0) {
        logger.debug(`已清理 ${jsonFiles.length} 个旧的对话日志文件`);
      }
    } catch (error) {
      logger.warn(`无法创建对话日志目录: ${this.chatLogDir}`);
      this.enableChatLogging = false;
    }
  }

  private async saveInteraction(
    messages: ChatMessage[],
    response: ModelResponse,
    options: ModelOptions = {},
    error?: any
  ): Promise<void> {
    if (!this.enableChatLogging) return;

    try {
      const timestamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, -1);
      const filename = `conversation-${timestamp}.json`;
      const filepath = path.join(this.chatLogDir, filename);

      const logData = {
        timestamp: new Date().toISOString(),
        model: options.model || this.config.models.default,
        options: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          stream: options.stream,
        },
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          name: msg.name,
        })),
        response: {
          content: response.content,
          usage: response.usage,
          error: error ? error.message : undefined,
        },
      };

      await fs.writeFile(filepath, JSON.stringify(logData, null, 2), 'utf-8');
      logger.debug(`对话已保存到: ${filepath}`);
    } catch (error) {
      logger.error('保存对话失败:', error);
    }
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
      const response = await adapter.sendMessage(messages, options);
      await this.saveInteraction(messages, response, options);
      return response;
    } catch (error) {
      const errorResponse: ModelResponse = {
        content: '',
        usage: undefined
      };
      await this.saveInteraction(messages, errorResponse, options, error);
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
      let fullContent = '';
      const chunks: string[] = [];

      for await (const chunk of adapter.streamMessage(messages, { ...options, stream: true })) {
        chunks.push(chunk);
        fullContent += chunk;
        yield chunk;
      }

      const response: ModelResponse = {
        content: fullContent,
        usage: undefined
      };
      await this.saveInteraction(messages, response, { ...options, stream: true });
    } catch (error) {
      const errorResponse: ModelResponse = {
        content: '',
        usage: undefined
      };
      await this.saveInteraction(messages, errorResponse, { ...options, stream: true }, error);
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