import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AppConfig {
  models: {
    default: string;
    available: Record<string, ModelConfig>;
  };
  features: {
    autoSave: boolean;
    streamOutput: boolean;
  };
  mcpServers?: Record<string, any>;
}

export class ConfigManager {
  private static configDir = join(homedir(), '.wx-cli');
  private static configPath = join(this.configDir, 'config.json');

  static async load(): Promise<AppConfig> {
    if (!existsSync(this.configPath)) {
      return await this.createDefaultConfig();
    }

    try {
      const configData = await readFile(this.configPath, 'utf-8');
      return JSON.parse(configData);
    } catch (error) {
      console.error('配置文件损坏，使用默认配置:', error);
      return await this.createDefaultConfig();
    }
  }

  static async save(config: AppConfig): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }

    await writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  static async reset(): Promise<void> {
    if (existsSync(this.configPath)) {
      await writeFile(this.configPath, JSON.stringify(this.getDefaultConfig(), null, 2), 'utf-8');
    } else {
      await this.createDefaultConfig();
    }
  }

  private static async createDefaultConfig(): Promise<AppConfig> {
    const config = this.getDefaultConfig();
    await this.save(config);
    return config;
  }

  private static getDefaultConfig(): AppConfig {
    return {
      models: {
        default: 'gpt-4',
        available: {
          'gpt-4': {
            apiKey: process.env.OPENAI_API_KEY || '',
            baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            modelName: 'gpt-4'
          }
        }
      },
      features: {
        autoSave: true,
        streamOutput: true
      },
      mcpServers: {}
    };
  }

  static getConfigPath(): string {
    return this.configPath;
  }

  static getConfigDir(): string {
    return this.configDir;
  }
}