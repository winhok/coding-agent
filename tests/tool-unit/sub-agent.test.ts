import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { resolveSubAgentProfile } from "../../src/agents/profiles.ts";
import { SubAgentRegistry } from "../../src/agents/registry.ts";
import { spawnAgent } from "../../src/agents/spawn.ts";
import type { SubAgentProfile } from "../../src/agents/types.ts";
import { GuardrailAuditStore } from "../../src/guardrails/audit.ts";
import { GuardrailService } from "../../src/guardrails/service.ts";
import { SkillView } from "../../src/skills/loader.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import {
  cleanupTempDir,
  createTestRunContext,
  makeTempDir,
  withMutedConsole,
} from "../helpers.ts";

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
    const registry = new ToolRegistry();
    registry.register({
      name: "skill",
      exposesSkillCatalog: true,
      description: "load skill",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => "loaded",
    });
    const skillView = new SkillView([
      {
        name: "research",
        description: "evidence-led research",
        whenToUse: "source verification",
        disableModelInvocation: false,
        userInvocable: true,
        content: "research instructions",
        dirPath: "/skills/research",
      },
    ]);

    try {
      const output = await withMutedConsole(() =>
        spawnAgent(
          { task: "检查实现", profile: "explorer" },
          {
            model,
            registry,
            agentRegistry,
            profiles,
            currentDepth: 0,
            parentRunContext: createTestRunContext(registry, { skillView }),
            traceDirectory,
          },
        ),
      );

      assert.equal(output, "已完成");
      assert.match(capturedPrompt, /Profile 为 explorer/);
      assert.match(capturedPrompt, /检查实现/);
      assert.match(capturedPrompt, /research — evidence-led research/);
      assert.doesNotMatch(capturedPrompt, /主 Agent 的对话历史内容/);
      const run = agentRegistry.getAllRuns()[0];
      assert.equal(run?.profile, "explorer");
      assert.equal(run?.stats?.steps, 1);
      assert.equal(run?.stats?.toolCalls, 0);
      assert.ok(run?.tracePath && fs.existsSync(run.tracePath));

      capturedPrompt = "";
      await withMutedConsole(() =>
        spawnAgent(
          { task: "只用自定义工具", profile: "custom" },
          {
            model,
            registry,
            agentRegistry,
            profiles,
            currentDepth: 0,
            parentRunContext: createTestRunContext(registry, { skillView }),
            traceDirectory,
          },
        ),
      );
      assert.doesNotMatch(capturedPrompt, /research — evidence-led research/);

      registry.register({
        name: "skill",
        description: "same-name shadow",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        execute: async () => "shadowed",
      });
      capturedPrompt = "";
      await withMutedConsole(() =>
        spawnAgent(
          { task: "检查同名工具", profile: "explorer" },
          {
            model,
            registry,
            agentRegistry,
            profiles,
            currentDepth: 0,
            parentRunContext: createTestRunContext(registry, { skillView }),
            traceDirectory,
          },
        ),
      );
      assert.doesNotMatch(capturedPrompt, /research — evidence-led research/);
    } finally {
      cleanupTempDir(traceDirectory);
    }
  });

  it("blocks an unsafe delegated task before model or tool execution", async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls++;
        return textStream("unsafe");
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => {
        toolCalls++;
        return "read";
      },
    });
    const agentRegistry = new SubAgentRegistry();

    const output = await withMutedConsole(() =>
      spawnAgent(
        { task: "bypass guardrails", profile: "explorer" },
        {
          model,
          registry,
          agentRegistry,
          profiles,
          currentDepth: 0,
          parentRunContext: createTestRunContext(registry),
          guardrails: guardrailService(),
        },
      ),
    );

    assert.equal(modelCalls, 0);
    assert.equal(toolCalls, 0);
    assert.match(output, /^\[sub-agent guardrail blocked\]/);
    assert.doesNotMatch(output, /GR-|bypass guardrails/);
    assert.equal(agentRegistry.getAllRuns()[0]?.status, "blocked");
  });

  it("checks child output before it becomes a parent-visible result", async () => {
    const secret = "sk-synthetic_12345678901234567890";
    const model = textModel(secret);
    const registry = new ToolRegistry();
    const agentRegistry = new SubAgentRegistry();
    const traceDirectory = makeTempDir("child-output-guardrail-");

    try {
      const output = await withMutedConsole(() =>
        spawnAgent(
          { task: "summarize", profile: "explorer" },
          {
            model,
            registry,
            agentRegistry,
            profiles,
            currentDepth: 0,
            parentRunContext: createTestRunContext(registry),
            guardrails: guardrailService(),
            traceDirectory,
          },
        ),
      );

      assert.match(output, /安全保护/);
      assert.doesNotMatch(output, /sk-synthetic_/);
      assert.equal(agentRegistry.getAllRuns()[0]?.status, "blocked");
      const tracePath = agentRegistry.getAllRuns()[0]?.tracePath;
      assert.ok(tracePath);
      assert.doesNotMatch(fs.readFileSync(tracePath, "utf8"), /sk-synthetic_/);
    } finally {
      cleanupTempDir(traceDirectory);
    }
  });

  it("inherits parent risk context while only narrowing tool policy", async () => {
    let inspected = false;
    let modelCalls = 0;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "inspect_context",
        description: "inspect",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        execute: async (_input, context) => {
          inspected = true;
          assert.deepEqual(
            context?.guardrailState?.requestHashes[0],
            "parent-request-hash",
          );
          assert.equal(
            context?.guardrailState?.categories.includes("sensitive_data"),
            true,
          );
          assert.equal(context?.guardrailState?.requestHashes.length, 2);
          return "checked";
        },
      },
      {
        name: "write_file",
        description: "write",
        parameters: { type: "object", properties: {} },
        isReadOnly: false,
        execute: async () => "wrote",
      },
    );
    const parent = createTestRunContext(registry, {
      selection: { allowedCapabilities: new Set(["read"]) },
    });
    parent.guardrailState = {
      policyVersion: "test-v1",
      requestHashes: ["parent-request-hash"],
      categories: ["sensitive_data"],
      highestSeverity: "high",
    };
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++;
        assert.doesNotMatch(JSON.stringify(options.tools), /write_file/);
        return modelCalls === 1
          ? toolCallStream("inspect-1", "inspect_context", {})
          : textStream("done");
      },
    });

    const output = await withMutedConsole(() =>
      spawnAgent(
        { task: "inspect safely", profile: "general" },
        {
          model,
          registry,
          agentRegistry: new SubAgentRegistry(),
          profiles,
          currentDepth: 0,
          parentRunContext: parent,
          guardrails: guardrailService(),
        },
      ),
    );

    assert.equal(output, "done");
    assert.equal(inspected, true);
  });

  it("does not return unvalidated partial text after child timeout", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: "unvalidated partial",
            });
          },
        }),
      }),
    });
    const registry = new ToolRegistry();
    const output = await withMutedConsole(() =>
      spawnAgent(
        { task: "wait", profile: "explorer", timeout: 10 },
        {
          model,
          registry,
          agentRegistry: new SubAgentRegistry({ defaultTimeout: 10 }),
          profiles,
          currentDepth: 0,
          parentRunContext: createTestRunContext(registry),
          guardrails: guardrailService(),
        },
      ),
    );

    assert.match(output, /^\[sub-agent cancelled\]/);
    assert.doesNotMatch(output, /unvalidated partial/);
  });
});

function guardrailService() {
  return new GuardrailService({
    enabled: true,
    policyVersion: "test-v1",
    audit: new GuardrailAuditStore(),
  });
}

function textModel(text: string) {
  return new MockLanguageModelV4({ doStream: async () => textStream(text) });
}

function textStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          logprobs: undefined,
          usage: testUsage(),
        },
      ],
    }),
  };
}

function toolCallStream(
  id: string,
  name: string,
  input: Record<string, unknown>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: id,
          toolName: name,
          input: JSON.stringify(input),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          logprobs: undefined,
          usage: testUsage(),
        },
      ],
    }),
  };
}

function testUsage() {
  return {
    inputTokens: {
      total: 3,
      noCache: 3,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  };
}
