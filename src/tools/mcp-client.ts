import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallToolResult,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

type MCPClientConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string> | undefined;
    }
  | {
      type: "http";
      url: string | URL;
      headers?: Record<string, string> | undefined;
      fetch?: typeof fetch | undefined;
      requestTimeoutMs?: number | undefined;
    };

const MCP_STREAMABLE_HTTP_ACCEPT = "application/json, text/event-stream";
const DEFAULT_MCP_HTTP_REQUEST_TIMEOUT_MS = 60_000;

function createHttpFetchWithTimeout(
  baseFetch: typeof fetch,
  requestTimeoutMs = DEFAULT_MCP_HTTP_REQUEST_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return baseFetch(input, init);
    }

    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) {
      headers.set("accept", MCP_STREAMABLE_HTTP_ACCEPT);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
      requestTimeoutMs,
    );
    timeout.unref?.();

    const parentSignal = init?.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abortFromParent);
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason);
    }

    try {
      return await baseFetch(input, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

export class MCPClient {
  private client = new Client(
    { name: "coding-agent", version: "1.0.0" },
    { capabilities: {} },
  );
  private config: MCPClientConfig;

  constructor(
    configOrCommand: MCPClientConfig | string,
    args: string[] = [],
    env?: Record<string, string>,
  ) {
    this.config =
      typeof configOrCommand === "string"
        ? { type: "stdio", command: configOrCommand, args, env }
        : configOrCommand;
  }

  async connect() {
    if (this.config.type === "http") {
      const baseFetch = this.config.fetch ?? globalThis.fetch.bind(globalThis);
      const transport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
        {
          ...(this.config.headers && {
            requestInit: { headers: new Headers(this.config.headers) },
          }),
          fetch: createHttpFetchWithTimeout(
            baseFetch,
            this.config.requestTimeoutMs,
          ),
        },
      );
      await this.client.connect(transport as Parameters<Client["connect"]>[0]);
      return;
    }

    const transportConfig = {
      command: this.config.command,
      args: this.config.args,
      ...(this.config.env && {
        env: { ...getDefaultEnvironment(), ...this.config.env },
      }),
    };

    const transport = new StdioClientTransport(transportConfig);
    await this.client.connect(transport);
  }

  async listTools() {
    const tools = [];
    let cursor: string | undefined;

    do {
      const result = await this.client.listTools(
        cursor ? { cursor } : undefined,
      );
      tools.push(
        ...result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        })),
      );
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = (await this.client.callTool(
      { name, arguments: args },
      CallToolResultSchema,
    )) as CallToolResult;
    const texts = (result.content ?? []).flatMap((content) =>
      content.type === "text" && content.text ? [content.text] : [],
    );
    let output = "(无返回内容)";

    if (texts.length > 0) {
      output = texts.join("\n");
    } else if (result.structuredContent) {
      output = JSON.stringify(result.structuredContent, null, 2);
    } else if (result.toolResult !== undefined) {
      output = JSON.stringify(result.toolResult, null, 2);
    }

    if (result.isError) return `[MCP tool error] ${output}`;
    return output;
  }

  async close() {
    await this.client.close();
  }
}
