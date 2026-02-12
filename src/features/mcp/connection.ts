import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type ClientConfig,
  type ResolvedStdioConnection,
  type ResolvedStreamableHTTPConnection,
} from "./types.js";

export interface ManagedClient {
  serverName: string;
  client: Client;
}

/**
 * Manages the client connections to the MCP servers.
 */
export class ConnectionManager {
  private readonly clients = new Map<string, Client>();

  constructor(private readonly config: ClientConfig) {}

  public has(serverName: string): boolean {
    return this.clients.has(serverName);
  }

  public get(serverName: string): Client | undefined {
    return this.clients.get(serverName);
  }

  public async createClient(
    transport: "stdio" | "sse" | "http",
    serverName: string,
    connection: ResolvedStdioConnection | ResolvedStreamableHTTPConnection
  ): Promise<Client> {
    if (this.clients.has(serverName)) {
      return this.clients.get(serverName)!;
    }

    let clientTransport;
    if (transport === "stdio") {
      clientTransport = new StdioClientTransport(
        connection as StdioServerParameters
      );
    } else if (transport === "sse") {
      if (!("url" in connection)) {
        throw new Error("URL is required for SSE transport");
      }
      clientTransport = new SSEClientTransport(
        new URL(connection.url),
        connection as SSEClientTransportOptions
      );
    } else {
      if (!("url" in connection)) {
        throw new Error("URL is required for HTTP transport");
      }
      clientTransport = new StreamableHTTPClientTransport(
        new URL(connection.url),
        connection as StreamableHTTPClientTransportOptions
      );
    }

    const client = new Client({ name: "wx-cli-mcp-client", version: "1.0.0" });
    await client.connect(clientTransport as any);
    this.clients.set(serverName, client);
    return client;
  }

  public async delete(serverName?: string): Promise<void> {
    if (serverName) {
      const client = this.clients.get(serverName);
      if (client) {
        await client.close();
        this.clients.delete(serverName);
      }
    } else {
      await Promise.all(
        [...this.clients.values()].map((client) => client.close())
      );
      this.clients.clear();
    }
  }

  public getAllClients(): ManagedClient[] {
    return [...this.clients.entries()].map(([serverName, client]) => ({
      serverName,
      client,
    }));
  }

  public getAllServerNames(): string[] {
    return [...this.clients.keys()];
  }
}