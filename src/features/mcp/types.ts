import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type {
  CallbackManager,
  CallbackManagerForToolRun,
} from "@langchain/core/callbacks/manager";
import type {
} from "@modelcontextprotocol/sdk/client";
import { z } from "zod";

/**
 * Zod schema for validating the output handling configuration.
 */
export const outputHandlingSchema = z
  .object({
    /**
    * If `true`, the `stdout` from the tool will be returned as the tool's
    * output. Otherwise, the tool's output will be the JSON-stringified
    * payload. Defaults to `false`.
    */
    preferStdout: z.boolean().optional(),
    /**
    * If `true`, the tool's output will be a JSON-stringified object
    * containing the `stdout`, `stderr`, and `payload` from the tool.
    * Otherwise, the tool's output will be determined by `preferStdout`.
    * Defaults to `false`.
    */
    bundle: z.boolean().optional(),
  })
  .optional();

/**
* Zod schema for validating the restart configuration.
*/
export const restartSchema = z.object({
  /**
  * Whether to automatically restart the server if it exits. Defaults to `false`.
  */
  enabled: z.boolean().optional(),
  /**
  * The maximum number of times to attempt to restart the server. `undefined` means no limit.
  */
  maxAttempts: z.number().int().optional(),
  /**
  * The delay in milliseconds between restart attempts. Defaults to `1000`.
  */
  delayMs: z.number().int().optional(),
});

/**
* Zod schema for validating the reconnect configuration.
*/
export const reconnectSchema = z.object({
  /**
  * Whether to automatically reconnect to the server if the connection is lost. Defaults to `false`.
  */
  enabled: z.boolean().optional(),
  /**
  * The maximum number of times to attempt to reconnect to the server. `undefined` means no limit.
  */
  maxAttempts: z.number().int().optional(),
  /**
  * The delay in milliseconds between reconnect attempts. Defaults to `1000`.
  */
  delayMs: z.number().int().optional(),
});

/**
* Zod schema for validating a stdio connection configuration.
*/
export const stdioConnectionSchema = z.object({
  /**
  * The transport type. Must be `stdio`.
  */
  transport: z.literal("stdio").optional(),
  /**
  * The command to execute to start the server.
  */
  command: z.string(),
  /**
  * The arguments to pass to the command. Defaults to an empty array.
  */
  args: z.array(z.string()).optional(),
  /**
  * Restart configuration.
  */
  restart: restartSchema.optional(),
  /**
  * Output handling configuration.
  */
  outputHandling: outputHandlingSchema.optional(),
});

/**
* Zod schema for validating a streamable HTTP connection configuration.
*/
export const streamableHTTPConnectionSchema = z.object({
  /**
  * The transport type. Can be `http` or `sse`. Defaults to `http`.
  */
  transport: z.enum(["http", "sse"]).optional(),
  /**
  * The URL of the server.
  */
  url: z.string().url(),
  /**
  * The headers to send with each request.
  */
  headers: z.record(z.string()).optional(),
  /**
  * Reconnect configuration.
  */
  reconnect: reconnectSchema.optional(),
});

/**
* Zod schema for validating a generic connection configuration. This is a
* union of the stdio and streamable HTTP schemas.
*/
export const connectionSchema = z.union([
  stdioConnectionSchema,
  streamableHTTPConnectionSchema,
]);

/**
* Type definition for the output handling configuration.
*/
export type OutputHandling = z.infer<typeof outputHandlingSchema>;

/**
* Type definition for a stdio connection configuration.
*/
export type StdioConnection = StdioServerParameters & { command: string };

/**
* Type definition for a streamable HTTP connection configuration.
*/
export type StreamableHTTPConnection = (SSEClientTransportOptions | StreamableHTTPClientTransportOptions) & { url: string };

/**
* Type definition for a generic connection configuration.
*/
export type Connection = z.infer<typeof connectionSchema>;

/**
* Zod schema for validating the client configuration.
*/
export const clientConfigSchema = z.object({
  /**
  * A map of server names to connection configurations.
  */
  mcpServers: z.record(connectionSchema).optional(),
  /**
   * Whether to throw an error if loading tools from a server fails. Defaults to `true`.
  */
  throwOnLoadError: z.boolean().optional(),
  /**
  * Whether to prefix the tool name with the server name. Defaults to `true`.
  */
  prefixToolNameWithServerName: z.boolean().optional(),
  /**
  * An additional prefix to add to the tool name. This is useful for
  * ensuring that tool names are unique across all servers.
  */
  additionalToolNamePrefix: z.string().optional(),
  /**
  * The default timeout in milliseconds for tool calls. `undefined` means no timeout.
  */
  defaultToolTimeout: z.number().int().optional(),
  /**
  * Global output handling configuration. This can be overridden on a
  * per-server basis.
  */
  outputHandling: outputHandlingSchema.optional(),
});

/**
* Type definition for the client configuration.
*/
export type ClientConfig = z.infer<typeof clientConfigSchema>;

/**
* Type definition for the options that can be passed to the `loadMcpTools` function.
*/
export type LoadMcpToolsOptions = Pick<
  ClientConfig,
  | "throwOnLoadError"
  | "prefixToolNameWithServerName"
  | "additionalToolNamePrefix"
  | "defaultToolTimeout"
  | "outputHandling"
> & {
  /**
  * An optional callback that will be called with progress updates as the
  * tools are loaded.
  */
  onProgress?: (message: string) => void;
};

export type ResolvedStdioConnection = StdioConnection;
export type ResolvedStreamableHTTPConnection = StreamableHTTPConnection;