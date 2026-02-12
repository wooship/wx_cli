import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SSEClientTransport,
  type SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod/v3";
import { loadMcpTools } from "./tools.js";
import { ConnectionManager } from "./connection.js";
import {
  type ClientConfig,
  type Connection,
  type ResolvedStdioConnection,
  type ResolvedStreamableHTTPConnection,
  type LoadMcpToolsOptions,
} from "./types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// const debugLog = getDebugLog();

/**
 * Error class for MCP client operations
 */
export class MCPClientError extends Error {
  constructor(
    message: string,
    public readonly serverName?: string
  ) {
    super(message);
    this.name = "MCPClientError";
  }
}

/**
 * Client for connecting to multiple MCP servers and loading LangChain-compatible tools.
 */
export class MultiServerMCPClient {
  #serverNameToTools: Record<string, DynamicStructuredTool[]> = {};
  #mcpServers: Record<string, ResolvedStdioConnection | ResolvedStreamableHTTPConnection>;
  #loadToolsOptions: Record<string, LoadMcpToolsOptions> = {};
  #clientConnections: ConnectionManager;
  #config: ClientConfig;

  get config(): ClientConfig {
    return JSON.parse(JSON.stringify(this.#config));
  }

  constructor(config: ClientConfig | Record<string, Connection>) {
    // Basic config parsing and validation will be added here.
    // For now, this is a simplified version.
    if ("mcpServers" in config) {
      this.#config = config as ClientConfig;
      this.#mcpServers = config.mcpServers as Record<string, ResolvedStdioConnection | ResolvedStreamableHTTPConnection>;
    } else {
      this.#config = { mcpServers: config as Record<string, Connection> };
      this.#mcpServers = config as Record<string, ResolvedStdioConnection | ResolvedStreamableHTTPConnection>;
    }
    
    this.#clientConnections = new ConnectionManager(this.#config);
  }

  public getConnectionManager(): ConnectionManager {
    return this.#clientConnections;
  }

  public async loadServersFromConfig(config: ClientConfig) {
    await this.close();
    this.#config = config;
    if (config.mcpServers) {
      this.#mcpServers = config.mcpServers as Record<string, ResolvedStdioConnection | ResolvedStreamableHTTPConnection>;
      this.#clientConnections = new ConnectionManager(this.#config);
      await this.initializeConnections();
    }
  }

  async initializeConnections(): Promise<Record<string, DynamicStructuredTool[]>> {
    for (const [serverName, connection] of Object.entries(this.#mcpServers)) {
      if ("command" in connection) { // Stdio connection
        const client = await this.#clientConnections.createClient("stdio", serverName, connection);
        this.#serverNameToTools[serverName] = await loadMcpTools(serverName, client, this.#loadToolsOptions[serverName] ?? {});
      } else { // HTTP/SSE connection
        const transport = (connection as any).transport === "sse" ? "sse" : "http";
        const client = await this.#clientConnections.createClient(transport, serverName, connection);
        this.#serverNameToTools[serverName] = await loadMcpTools(serverName, client, this.#loadToolsOptions[serverName] ?? {});
      }
    }
    return this.#serverNameToTools;
  }

  async getTools(...servers: string[]): Promise<DynamicStructuredTool[]> {
    await this.initializeConnections();
    if (servers.length === 0) {
      return Object.values(this.#serverNameToTools).flat();
    }
    return servers.flatMap(serverName => this.#serverNameToTools[serverName] || []);
  }

  async getClient(serverName: string): Promise<Client | undefined> {
    await this.initializeConnections();
    return this.#clientConnections.get(serverName);
  }

  async close(): Promise<void> {
    await this.#clientConnections.delete();
    this.#serverNameToTools = {};
  }

  public listConfiguredServers(): void {
    if (!this.#mcpServers || Object.keys(this.#mcpServers).length === 0) {
      console.log('No MCP servers configured in config.json.');
      return;
    }

    console.log('Configured MCP Servers:');
    for (const serverName of Object.keys(this.#mcpServers)) {
      console.log(`  - ${serverName}`);
    }
  }

  async showServerTools(serverName: string): Promise<void> {
    const client = this.#clientConnections.get(serverName);
    if (!client) {
      console.log(`MCP server '${serverName}' not found or not connected.`);
      return;
    }
    
    try {
      const { tools } = await client.listTools();
      console.log(`\n工具列表 - 服务器: ${serverName}`);
      if (tools.length === 0) {
        console.log('  无可用工具');
      } else {
        for (const tool of tools) {
          console.log(`\n  - ${tool.name}: ${tool.description}`);
          if (tool.inputSchema?.properties) {
            console.log(`    参数:`);
            for (const [paramName, paramSchema] of Object.entries(tool.inputSchema.properties)) {
              const schema = paramSchema as any;
              const required = tool.inputSchema.required?.includes(paramName) ? ' (必需)' : ' (可选)';
              const type = schema.type || 'any';
              const desc = schema.description ? ` - ${schema.description}` : '';
              console.log(`      ${paramName}: ${type}${required}${desc}`);
            }
          }
        }
      }
      console.log('');
    } catch (error) {
      console.error(`Error getting tools for server ${serverName}:`, error);
    }
  }

  async showStatus(): Promise<void> {
    const serverNames = this.#clientConnections.getAllServerNames();
    if (serverNames.length === 0) {
      console.log('No MCP servers connected.');
      return;
    }

    console.log('MCP Server Status:');
    for (const serverName of serverNames) {
      const client = this.#clientConnections.get(serverName);
      if (client) {
        const status = client.transport ? client.transport.constructor.name : 'disconnected';
        console.log(`  - ${serverName}: ${status}`);
      } else {
        console.log(`  - ${serverName}: not found`);
      }
    }
  }

  async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    const client = this.#clientConnections.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    try {
      console.log(`Calling tool ${toolName} on server ${serverName} with args:`, args);
      const response = await client.callTool({
        name: toolName,
        arguments: args
      });
      //不需要输出 Tool response
      // console.log('Tool response:', response);
      return response;
    } catch (error) {
      console.error(`Error calling tool ${toolName} on server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * 获取指定服务器的工具列表和详细信息
   */
  async getServerTools(serverName: string): Promise<any[]> {
    const client = this.#clientConnections.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    try {
      const { tools } = await client.listTools();
      return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));
    } catch (error) {
      console.error(`Error getting tools for server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * 获取所有服务器的工具信息
   */
  async getAllTools(): Promise<Record<string, any[]>> {
    const toolsByServer: Record<string, any[]> = {};
    
    for (const serverName of Object.keys(this.#mcpServers)) {
      try {
        toolsByServer[serverName] = await this.getServerTools(serverName);
      } catch (error) {
        console.error(`Failed to get tools for server ${serverName}:`, error);
        toolsByServer[serverName] = [];
      }
    }
    
    return toolsByServer;
  }
}