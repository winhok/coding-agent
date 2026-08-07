import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { connectMCPServers } from "../../src/tools/mcp-connect.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

describe("configured MCP connections", () => {
  it("connects enabled servers independently and skips disabled servers", async () => {
    const registry = new ToolRegistry();
    const fixture = resolve("tests/fixtures/mcp-stdio-server.ts");

    const results = await connectMCPServers(
      [
        {
          name: "disabled",
          enabled: false,
          type: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", fixture],
          env: {},
        },
        {
          name: "broken",
          enabled: true,
          type: "stdio",
          command: "__coding_agent_missing_mcp_server__",
          args: [],
          env: {},
        },
        {
          name: "local",
          enabled: true,
          type: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", fixture],
          env: { MCP_TEST_MARKER: "multi-server" },
        },
      ],
      registry,
    );

    try {
      assert.equal(results.length, 2);
      assert.equal(results[0]?.name, "broken");
      assert.equal(results[0]?.status, "failed");
      assert.equal(results[1]?.name, "local");
      assert.equal(results[1]?.status, "connected");
      assert.deepEqual(results[1]?.tools, ["mcp__local__echo_owner"]);

      const tool = registry.get("mcp__local__echo_owner");
      assert.ok(tool);
      assert.equal(
        await tool.execute({ owner: "octo" }),
        "owner=octo; marker=multi-server",
      );
      assert.equal(registry.get("mcp__disabled__echo_owner"), undefined);
    } finally {
      await registry.closeAllMCP();
    }
  });
});
