import { DynamicStructuredTool } from "@langchain/core/tools";
import { z, type ZodRawShape } from "zod";
import { type Client } from "@modelcontextprotocol/sdk/client";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type LoadMcpToolsOptions } from "./types.js";

/**
 * Loads tools from an MCP server and converts them to LangChain-compatible tools.
 * @param serverName - The name of the server to load tools from.
 * @param client - The MCP client to use for loading tools.
 * @param options - Options for loading the tools.
 * @returns An array of LangChain-compatible tools.
 */
export async function loadMcpTools(
  serverName: string,
  client: Client,
  options: LoadMcpToolsOptions
): Promise<DynamicStructuredTool[]> {
  const {
    throwOnLoadError = true,
    prefixToolNameWithServerName = true,
    additionalToolNamePrefix = "",
  } = options;

  try {
    const { tools: toolDefs } = await client.listTools();
    const tools = toolDefs.map((toolDef: Tool) => {
      const toolName = prefixToolNameWithServerName
        ? `${serverName}.${toolDef.name}`
        : toolDef.name;
      const finalToolName = `${additionalToolNamePrefix}${toolName}`;

      const tool = new DynamicStructuredTool({
        name: finalToolName,
        description: toolDef.description ?? "",
        schema: z.object(
          (toolDef.inputSchema.properties ?? {}) as ZodRawShape
        ),
        func: async (input: z.infer<z.ZodObject<any, any, any, any, any>>) => {
          const response = await client.callTool({
            name: toolDef.name,
            input,
          });

          // TODO: Add output handling logic from langchain-mcp-adapters
          if (response.stdout) {
            return response.stdout;
          }
          return JSON.stringify(response.payload);
        },
      });

      return tool;
    });

    return tools;
  } catch (error) {
    if (throwOnLoadError) {
      throw error;
    }
    console.error(
      `Failed to load tools from server "${serverName}": ${error}`
    );
    return [];
  }
}