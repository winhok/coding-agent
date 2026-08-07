import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { resolveSubAgentProfile } from "../../src/agents/profiles.ts";
import { SubAgentRegistry } from "../../src/agents/registry.ts";
import { spawnAgent } from "../../src/agents/spawn.ts";
import type { SubAgentProfile } from "../../src/agents/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { cleanupTempDir, makeTempDir, withMutedConsole } from "../helpers.ts";

const profiles: Record<string, SubAgentProfile> = {
  general: {
    description: "general",
    systemPrompt: "general",
    capabilities: ["read", "write", "delegate"],
  },
  explorer: {
    description: "explorer",
    systemPrompt: "explorer",
    capabilities: ["read"],
  },
  custom: {
    description: "custom",
    systemPrompt: "custom",
    capabilities: ["read", "write"],
    tools: ["read_file", "edit_file"],
  },
};

describe("tool-unit sub-agent", () => {
  it("enforces depth and concurrency limits", () => {
    const registry = new SubAgentRegistry({
      maxSpawnDepth: 1,
      maxConcurrent: 1,
    });

    assert.match(registry.canSpawn(1).reason ?? "", /最大嵌套深度 1/);

    const id = registry.generateId();
    registry.register({
      id,
      task: "running task",
      profile: "general",
      status: "running",
      depth: 1,
      startedAt: new Date().toISOString(),
    });
    assert.match(registry.canSpawn(0).reason ?? "", /最大并发数 1/);

    registry.complete(id, "done");
    assert.equal(registry.get(id)?.status, "completed");
    assert.equal(registry.get(id)?.result, "done");
    assert.equal(registry.canSpawn(0).ok, true);
  });

  it("resolves configurable profiles and only narrows task tool scope", () => {
    const resolved = resolveSubAgentProfile(
      { task: "edit", profile: "custom", tools: ["read_file", "bash"] },
      profiles,
    );

    assert.equal(resolved.name, "custom");
    assert.deepEqual(
      [...(resolved.selection.allowedTools ?? [])],
      ["read_file"],
    );
    assert.equal(resolved.selection.allowedCapabilities?.has("write"), true);
    assert.equal(resolved.selection.deniedCapabilities?.has("delegate"), true);
  });

  it("forces parallel tasks through the read-only execution policy", () => {
    const resolved = resolveSubAgentProfile(
      { task: "compare", profile: "general" },
      profiles,
      true,
    );

    assert.equal(resolved.selection.readOnlyOnly, true);
    assert.equal(resolved.selection.deniedCapabilities?.has("delegate"), true);
  });

  it("rejects unknown profile names", () => {
    assert.throws(
      () =>
        resolveSubAgentProfile({ task: "work", profile: "missing" }, profiles),
      /未知子 Agent Profile/,
    );
  });

  it("runs through the shared agent loop with isolated profile context and stats", async () => {
    const traceDirectory = makeTempDir("coding-agent-sub-trace-");
    let capturedPrompt = "";
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        capturedPrompt = JSON.stringify(options.prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "已完成" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 3,
                    noCache: 3,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 2, text: 2, reasoning: undefined },
                },
              },
            ],
          }),
        };
      },
    });
    const agentRegistry = new SubAgentRegistry();

    try {
      const output = await withMutedConsole(() =>
        spawnAgent(
          { task: "检查实现", profile: "explorer" },
          {
            model,
            registry: new ToolRegistry(),
            agentRegistry,
            profiles,
            currentDepth: 0,
            workingDir: process.cwd(),
            traceDirectory,
          },
        ),
      );

      assert.equal(output, "已完成");
      assert.match(capturedPrompt, /Profile 为 explorer/);
      assert.match(capturedPrompt, /检查实现/);
      assert.doesNotMatch(capturedPrompt, /主 Agent 的对话历史内容/);
      const run = agentRegistry.getAllRuns()[0];
      assert.equal(run?.profile, "explorer");
      assert.equal(run?.stats?.steps, 1);
      assert.equal(run?.stats?.toolCalls, 0);
      assert.ok(run?.tracePath && fs.existsSync(run.tracePath));
    } finally {
      cleanupTempDir(traceDirectory);
    }
  });
});
