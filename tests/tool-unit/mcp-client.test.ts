import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { MCPClient } from "../../src/tools/mcp-client.ts";

describe("MCPClient", () => {
  it("connects to a real stdio MCP server and adapts tools to the registry interface", async () => {
    const serverPath = resolve("tests/fixtures/mcp-stdio-server.ts");
    const client = new MCPClient(
      process.execPath,
      ["--import", "tsx", serverPath],
      { MCP_TEST_MARKER: "test-token" },
    );

    try {
      await client.connect();

      assert.deepEqual(await client.listTools(), [
        {
          name: "echo_owner",
          description: "Echo owner through a real stdio MCP server",
          inputSchema: {
            type: "object",
            properties: { owner: { type: "string" } },
            required: ["owner"],
            $schema: "http://json-schema.org/draft-07/schema#",
          },
        },
      ]);
      assert.equal(
        await client.callTool("echo_owner", { owner: "octo" }),
        "owner=octo; marker=test-token",
      );
    } finally {
      await client.close();
    }
  });

  it("connects through the SDK streamable HTTP transport with bearer auth", async () => {
    const requests: Array<{
      url: string;
      authorization: string;
      accept: string;
      body: JsonRpcRequest;
    }> = [];

    const client = new MCPClient({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer test-token" },
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as JsonRpcRequest;
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          accept: new Headers(init?.headers).get("accept") ?? "",
          body,
        });

        if (body.method === "initialize") {
          return jsonRpcResponse(body.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "test-http-mcp", version: "1.0.0" },
          });
        }

        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }

        if (body.method === "tools/list") {
          return jsonRpcResponse(body.id, {
            tools: [
              {
                name: "echo_repo",
                description: "Echo repo through streamable HTTP",
                inputSchema: {
                  type: "object",
                  properties: { repo: { type: "string" } },
                  required: ["repo"],
                },
              },
            ],
          });
        }

        if (body.method === "tools/call") {
          const repo = body.params?.arguments?.repo;
          return jsonRpcResponse(body.id, {
            content: [{ type: "text", text: `repo=${String(repo)}` }],
          });
        }

        throw new Error(`Unexpected MCP method: ${body.method}`);
      },
    });

    try {
      await client.connect();

      assert.deepEqual(await client.listTools(), [
        {
          name: "echo_repo",
          description: "Echo repo through streamable HTTP",
          inputSchema: {
            type: "object",
            properties: { repo: { type: "string" } },
            required: ["repo"],
          },
        },
      ]);
      assert.equal(
        await client.callTool("echo_repo", { repo: "hello" }),
        "repo=hello",
      );
      assert.deepEqual(
        requests.map((request) => request.authorization),
        [
          "Bearer test-token",
          "Bearer test-token",
          "Bearer test-token",
          "Bearer test-token",
        ],
      );
      assert.ok(
        requests.every(
          (request) => request.url === "https://api.githubcopilot.com/mcp/",
        ),
      );
      assert.ok(
        requests.every(
          (request) => request.accept === "application/json, text/event-stream",
        ),
      );
    } finally {
      await client.close();
    }
  });

  it("times out non-GET streamable HTTP requests", async () => {
    const client = new MCPClient({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      requestTimeoutMs: 20,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as JsonRpcRequest;

        if (body.method === "initialize") {
          return jsonRpcResponse(body.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "test-http-mcp", version: "1.0.0" },
          });
        }

        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }

        if (body.method === "tools/list") {
          return rejectOnAbort(init?.signal);
        }

        throw new Error(`Unexpected MCP method: ${body.method}`);
      },
    });

    try {
      await client.connect();
      const start = Date.now();
      await assert.rejects(
        () => client.listTools(),
        /timed out|aborted|TimeoutError/i,
      );
      assert.ok(Date.now() - start < 500);
    } finally {
      await client.close();
    }
  });

  it("marks MCP tool-level failures in the returned output", async () => {
    const client = new MCPClient({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as JsonRpcRequest;

        if (body.method === "initialize") {
          return jsonRpcResponse(body.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "test-http-mcp", version: "1.0.0" },
          });
        }

        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }

        if (body.method === "tools/call") {
          return jsonRpcResponse(body.id, {
            isError: true,
            content: [{ type: "text", text: "permission denied" }],
          });
        }

        throw new Error(`Unexpected MCP method: ${body.method}`);
      },
    });

    try {
      await client.connect();

      assert.equal(
        await client.callTool("create_issue", {}),
        "[MCP tool error] permission denied",
      );
    } finally {
      await client.close();
    }
  });
});

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: { arguments?: Record<string, unknown> };
};

function jsonRpcResponse(
  id: string | number | null | undefined,
  result: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rejectOnAbort(
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}
