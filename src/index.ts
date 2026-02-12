#!/usr/bin/env node

import { interactiveMode } from './cli/interactive.js';
import { logger } from './utils/logger.js';
import { ConfigManager } from './core/config.js';
import { MultiServerMCPClient } from './features/mcp/client.js';

async function main() {
  try {
    const config = await ConfigManager.load();
    const mcpClient = new MultiServerMCPClient(config.mcpServers || {});

    // The MCPClient constructor now handles the chrome-devtools connection.
    // We can remove the manual connection logic.

    await interactiveMode(mcpClient);
  } catch (error) {
    logger.error('应用启动出错:', error);
    process.exit(1);
  }
}

main();