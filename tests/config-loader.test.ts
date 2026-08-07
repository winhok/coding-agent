import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config/loader.js";
import { SuperAgentConfigSchema } from "../src/config/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config", () => {
  it("fills nested defaults from an empty object", () => {
    const config = SuperAgentConfigSchema.parse({});

    assert.equal(config.model.name, "qwen3.7-plus-2026-05-26");
    assert.equal(config.agents.maxConcurrent, 3);
    assert.deepEqual(config.agents.profiles.explorer?.capabilities, ["read"]);
    assert.equal(config.channels.feishu.enabled, false);
    assert.equal(config.security.defaultRole, "owner");
    assert.equal(config.rag.enabled, true);
    assert.deepEqual(config.mcp.servers, []);
  });

  it("merges configured sub-agent profiles with built-in defaults", () => {
    const config = SuperAgentConfigSchema.parse({
      agents: {
        profiles: {
          researcher: {
            description: "research",
            systemPrompt: "find evidence",
            capabilities: ["read", "external"],
          },
        },
      },
    });

    assert.deepEqual(config.agents.profiles.researcher?.capabilities, [
      "read",
      "external",
    ]);
    assert.ok(config.agents.profiles.general);
  });

  it("substitutes environment variables before validation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "super-agent.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        model: { apiKey: `$${"{TEST_CONFIG_API_KEY}"}` },
        agents: { maxConcurrent: 5 },
        mcp: {
          servers: [
            {
              name: "github",
              type: "http",
              url: "https://example.com/mcp",
              headers: {
                Authorization: `Bearer $${"{TEST_CONFIG_MCP_TOKEN}"}`,
              },
            },
          ],
        },
      }),
    );

    const previous = process.env.TEST_CONFIG_API_KEY;
    const previousMcpToken = process.env.TEST_CONFIG_MCP_TOKEN;
    process.env.TEST_CONFIG_API_KEY = "test-key";
    process.env.TEST_CONFIG_MCP_TOKEN = "mcp-token";
    try {
      const config = loadConfig(configPath);
      assert.equal(config.model.apiKey, "test-key");
      assert.equal(config.agents.maxConcurrent, 5);
      assert.equal(config.agents.maxSpawnDepth, 1);
      assert.deepEqual(config.mcp.servers, [
        {
          name: "github",
          enabled: true,
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer mcp-token" },
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.TEST_CONFIG_API_KEY;
      else process.env.TEST_CONFIG_API_KEY = previous;
      if (previousMcpToken === undefined)
        delete process.env.TEST_CONFIG_MCP_TOKEN;
      else process.env.TEST_CONFIG_MCP_TOKEN = previousMcpToken;
    }
  });

  it("rejects duplicate MCP server names", () => {
    assert.throws(
      () =>
        SuperAgentConfigSchema.parse({
          mcp: {
            servers: [
              { name: "docs", type: "stdio", command: "node" },
              { name: "docs", type: "http", url: "https://example.com/mcp" },
            ],
          },
        }),
      /MCP server name must be unique/,
    );
  });

  it("rejects MCP server names that cannot form safe tool namespaces", () => {
    assert.throws(
      () =>
        SuperAgentConfigSchema.parse({
          mcp: {
            servers: [
              { name: "internal docs", type: "stdio", command: "node" },
            ],
          },
        }),
      /MCP server name may only contain/,
    );
  });

  it("throws configuration errors instead of terminating the process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-config-"));
    tempDirs.push(dir);
    const malformedPath = path.join(dir, "malformed.json");
    const invalidPath = path.join(dir, "invalid.json");
    fs.writeFileSync(malformedPath, "{");
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({ agents: { maxConcurrent: 0 } }),
    );

    assert.throws(() => loadConfig(malformedPath), /解析 .* 失败/);
    assert.throws(() => loadConfig(invalidPath), /配置文件校验失败/);
  });
});
