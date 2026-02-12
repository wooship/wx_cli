import { ConfigManager } from '../core/config.js';
import { ModelManager, ChatMessage } from '../core/model.js';
import { logger } from '../utils/logger.js';
import { FileOperations } from '../features/file-ops.js';
import { ShellOperations } from '../features/shell-ops.js';
import { CommandTranslator } from '../features/command-translator.js';
import { CommandExecutor } from '../features/command-executor.js';
import { SmartInteraction } from '../features/smart-interaction.js';
import { TaskDecomposer } from '../features/task-decomposer.js';
import { MultiServerMCPClient } from '../features/mcp/client.js';
import readline from 'readline';
import chalk from 'chalk';

export async function interactiveMode(mcpClient: MultiServerMCPClient): Promise<void> {
  const config = await ConfigManager.load();
  await mcpClient.loadServersFromConfig(config);
  const modelManager = new ModelManager(config);
  const fileOps = new FileOperations();
  const shellOps = new ShellOperations();
  
  const connectionManager = mcpClient.getConnectionManager();
  const taskDecomposer = new TaskDecomposer(modelManager, connectionManager);
  const commandTranslator = new CommandTranslator(fileOps, shellOps, modelManager, mcpClient);
  const commandExecutor = new CommandExecutor(fileOps, shellOps, modelManager, mcpClient);
  const smartInteraction = new SmartInteraction(taskDecomposer, commandTranslator, commandExecutor, modelManager, mcpClient);

  logger.info('欢迎使用 wx-cli ---- 开源、纯净的智能CLI！');
  logger.info('输入 /help 查看可用命令');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('> ')
  });

  const messages: ChatMessage[] = [];

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (input.startsWith('/')) {
      await handleCommand(input, { modelManager, config, fileOps, shellOps, smartInteraction, messages, rl, mcpClient });
    } else {
      await handleSmartInput(input, smartInteraction, messages, modelManager, config, rl);
    }
    rl.prompt();
  }).on('close', async () => {
    logger.info("正在清理资源并退出...");
    await smartInteraction.cleanup();
    process.exit(0);
  });
}

interface CommandHandlerParams {
  modelManager: ModelManager;
  config: any;
  fileOps: FileOperations;
  shellOps: ShellOperations;
  smartInteraction: SmartInteraction;
  messages: ChatMessage[];
  rl: readline.Interface;
  mcpClient: MultiServerMCPClient;
}

async function handleCommand(input: string, params: CommandHandlerParams): Promise<void> {
  const [command, ...args] = input.slice(1).split(' ');
  const { smartInteraction, messages, rl, mcpClient } = params;

  switch (command) {
    case 'help':
      showHelp();
      break;
    case 'exit':
      rl.close();
      break;
    case 'clear':
        messages.length = 0;
        console.clear();
        logger.info('对话历史已清除');
        break;
    case 'mcp':
      await handleMcpCommand(args, mcpClient);
      break;
    default:
      logger.warn(`未知命令: ${command}，输入 /help 查看可用命令`);
  }
}

function showHelp(): void {
    logger.raw(`
  可用命令:
    /help              - 显示此帮助信息
    /exit              - 退出交互模式
    /clear             - 清除对话历史
    /mcp list          - 列出配置文件中所有的MCP服务器
    /mcp status        - 显示MCP连接状态
    /mcp tools <name>  - 显示指定MCP服务器上的可用工具
   `);
}

async function handleMcpCommand(args: string[], mcpClient: MultiServerMCPClient): Promise<void> {
  const subCommand = args[0];
  const serverName = args[1];

  switch (subCommand) {
    case 'list':
      mcpClient.listConfiguredServers();
      break;
    case 'status':
      await mcpClient.showStatus();
      break;
    case 'tools':
      if (!serverName) {
        logger.warn('请提供MCP服务器名称. 用法: /mcp tools <server-name>');
        return;
      }
      await mcpClient.showServerTools(serverName);
      break;
    default:
      logger.warn(`未知的 /mcp 命令: ${subCommand}。可用命令: list, status, tools`);
  }
}


async function handleSmartInput(
    input: string,
    smartInteraction: SmartInteraction,
    messages: ChatMessage[],
    modelManager: ModelManager,
    config: any,
    rl: readline.Interface
  ): Promise<void> {
    if (!input) return;

    const result = await smartInteraction.processInput(input, {
      autoExecute: true,
      confirmRiskyOperations: true,
      rl
    });
  
    const shouldFallbackToChat = !result.success;

    if (shouldFallbackToChat) {
      
      messages.push({ role: 'user', content: input });
  
      try {
          logger.info("AI 正在思考...");
          const response = await modelManager.sendMessage(messages);
          logger.raw(`\nAI: ${response.content}\n`);
          messages.push({ role: 'assistant', content: response.content });
      } catch (error) {
        logger.error('AI响应失败:', error);
      }
    }
}
