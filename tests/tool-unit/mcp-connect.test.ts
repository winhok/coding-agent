import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolRegistry } from "../../src/tools/registry.ts";

async function loadIndexModule() {
  process.env.DASHSCOPE_API_KEY ??= "test-api-key";
  return import("../../src/index.ts");
}

describe("connectMCP", () => {
  it("skips GitHub MCP without registering mock tools when the real server fails", async () => {
    const { connectMCP } = await loadIndexModule();
    const registry = new ToolRegistry();
    const logs: string[] = [];

    const registered = await connectMCP(registry, {
      githubToken: "test-token",
      canSpawn: async () => true,
      createClient: () => ({
        connect: async () => {
          throw new Error("server unavailable");
        },
        listTools: async () => [],
        callTool: async () => "",
        close: async () => {},
      }),
      log: (message: string) => logs.push(message),
    });

    assert.deepEqual(registered, []);
    assert.equal(
      registry.getAll().some((tool) => tool.name.startsWith("mcp__github__")),
      false,
    );
    assert.equal(logs.join("\n").includes("Mock"), false);
  });

  it("registers real GitHub MCP tools when the server connects", async () => {
    const { connectMCP } = await loadIndexModule();
    const registry = new ToolRegistry();

    const registered = await connectMCP(registry, {
      githubToken: "test-token",
      canSpawn: async () => true,
      createClient: () => ({
        connect: async () => {},
        listTools: async () => [
          {
            name: "list_issues",
            description: "List issues",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        callTool: async () => "[]",
        close: async () => {},
      }),
      log: () => {},
    });

    assert.deepEqual(registered, ["mcp__github__list_issues"]);
    assert.notEqual(registry.get("mcp__github__list_issues"), undefined);
  });

  it("creates runtime agents after MCP tools are registered", async () => {
    const { createRuntime } = await loadIndexModule();

    const runtime = await createRuntime({
      githubToken: "test-token",
      canSpawn: async () => true,
      createClient: () => ({
        connect: async () => {},
        listTools: async () => [
          {
            name: "list_issues",
            description: "List issues",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        callTool: async () => "[]",
        close: async () => {},
      }),
      log: () => {},
    });

    try {
      assert.notEqual(
        runtime.registry.get("mcp__github__list_issues"),
        undefined,
      );
      assert.notEqual(runtime.agent.tools.mcp__github__list_issues, undefined);
    } finally {
      await runtime.close();
    }
  });
});
