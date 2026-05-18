import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallToolResult,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type MCPTextContent = Extract<
  CallToolResult["content"][number],
  { type: "text" }
>;

function isTextContent(
  content: CallToolResult["content"][number],
): content is MCPTextContent {
  return content.type === "text";
}

type StdioMCPClientConfig = {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
};

type HttpMCPClientConfig = {
  type: "http";
  url: string | URL;
  headers?: Record<string, string> | undefined;
  fetch?: StreamableHTTPClientTransportOptions["fetch"] | undefined;
  requestTimeoutMs?: number | undefined;
};

type MCPClientConfig = StdioMCPClientConfig | HttpMCPClientConfig;

const MCP_STREAMABLE_HTTP_ACCEPT = "application/json, text/event-stream";
const DEFAULT_MCP_HTTP_REQUEST_TIMEOUT_MS = 60_000;

function createHttpFetchWithTimeout(
  baseFetch: NonNullable<StreamableHTTPClientTransportOptions["fetch"]>,
  requestTimeoutMs = DEFAULT_MCP_HTTP_REQUEST_TIMEOUT_MS,
): NonNullable<StreamableHTTPClientTransportOptions["fetch"]> {
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

  constructor(config: MCPClientConfig);
  constructor(command: string, args: string[], env?: Record<string, string>);
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

  async connect(): Promise<void> {
    if (this.config.type === "http") {
      const transportOptions: StreamableHTTPClientTransportOptions = {};
      if (this.config.headers) {
        transportOptions.requestInit = {
          headers: new Headers(this.config.headers),
        };
      }
      const baseFetch = this.config.fetch ?? globalThis.fetch.bind(globalThis);
      transportOptions.fetch = createHttpFetchWithTimeout(
        baseFetch,
        this.config.requestTimeoutMs,
      );

      const transport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
        transportOptions,
      );
      await this.client.connect(transport as Parameters<Client["connect"]>[0]);
      return;
    }

    const transportConfig: StdioServerParameters = {
      command: this.config.command,
      args: this.config.args,
    };

    if (this.config.env) {
      transportConfig.env = { ...getDefaultEnvironment(), ...this.config.env };
    }

    const transport = new StdioClientTransport(transportConfig);
    await this.client.connect(transport);
  }

  async listTools(): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
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

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.client.callTool(
      { name, arguments: args },
      CallToolResultSchema,
    )) as CallToolResult;
    const output = formatCallToolResult(result);

    if (result.isError) return `[MCP tool error] ${output}`;
    return output;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function formatCallToolResult(result: CallToolResult): string {
  const texts = (result.content ?? [])
    .filter(isTextContent)
    .filter((content) => content.text)
    .map((content) => content.text);

  if (texts.length > 0) return texts.join("\n");
  if (result.structuredContent)
    return JSON.stringify(result.structuredContent, null, 2);
  if (result.toolResult !== undefined)
    return JSON.stringify(result.toolResult, null, 2);
  return "(无返回内容)";
}
