import type { MCPServerConfig } from "../config/schema.js";
import { MCPClient } from "./mcp-client.js";
import type { ToolRegistry } from "./registry.js";

export type MCPConnectionResult =
  | { name: string; status: "connected"; tools: string[] }
  | { name: string; status: "failed"; error: string };

/** Connects configured MCP servers independently so one failure cannot hide the rest. */
export async function connectMCPServers(
  servers: readonly MCPServerConfig[],
  registry: ToolRegistry,
): Promise<MCPConnectionResult[]> {
  const results: MCPConnectionResult[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;

    try {
      const client = new MCPClient(toClientConfig(server));
      const tools = await registry.registerMCPServer(server.name, client);
      results.push({ name: server.name, status: "connected", tools });
    } catch (error) {
      results.push({
        name: server.name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function toClientConfig(server: MCPServerConfig) {
  if (server.type === "stdio") {
    return {
      type: "stdio" as const,
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }

  return {
    type: "http" as const,
    url: server.url,
    ...(Object.keys(server.headers).length > 0
      ? { headers: server.headers }
      : {}),
    ...(server.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: server.requestTimeoutMs }),
  };
}
