import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type AgentEvent, agentLoop } from "../../src/agent/loop.ts";
import { GuardrailAuditStore } from "../../src/guardrails/audit.ts";
import { GuardrailService } from "../../src/guardrails/service.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createTestRunContext } from "../helpers.ts";

const TEST_USAGE = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

describe("tool guardrail", () => {
  it("blocks mandatory risks before the tool body", async () => {
    const knownSecret = "synthetic-known-tool-secret";
    const audit = new GuardrailAuditStore();
    const service = guardrailService(audit, [knownSecret]);
    const cases = [
      { value: knownSecret, rule: "GR-TOOL-SECRET" },
      { path: "../../outside.txt", rule: "GR-TOOL-PATH" },
      { approved: true, rule: "GR-TOOL-APPROVAL" },
      { value: "bypass guardrails", rule: "GR-TOOL-BYPASS" },
      { command: "rm -rf /", rule: "GR-TOOL-UNSAFE" },
    ];

    for (const input of cases) {
      let executed = false;
      const registry = new ToolRegistry();
      registry.register({
        name: "probe",
        description: "probe",
        parameters: { type: "object", additionalProperties: true },
        isReadOnly: true,
        execute: async () => {
          executed = true;
          return "ran";
        },
      });
      const context = createTestRunContext(registry);
      context.toolGuardrail = service.createToolGuardrail({
        source: "cli",
        role: "owner",
      });

      const output = await registry
        .toAISDKFormat(context)
        .probe?.execute(input);

      assert.equal(executed, false);
      assert.match(String(output), /^\[安全保护\]/);
      assert.match(
        audit.list().at(-1)?.findings[0]?.ruleId ?? "",
        new RegExp(input.rule),
      );
    }
  });

  it("rejects before acquiring an exclusive execution lock", async () => {
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const releaseReadPromise = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "active_read",
        description: "active read",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        isConcurrencySafe: true,
        execute: async () => {
          readStarted();
          await releaseReadPromise;
          return "read";
        },
      },
      {
        name: "blocked_write",
        description: "blocked write",
        parameters: { type: "object", additionalProperties: true },
        isReadOnly: true,
        isConcurrencySafe: false,
        execute: async () => "should not run",
      },
    );
    const context = createTestRunContext(registry);
    context.toolGuardrail = guardrailService().createToolGuardrail({
      source: "cli",
      role: "owner",
    });
    const tools = registry.toAISDKFormat(context);

    const read = tools.active_read?.execute({});
    await readStartedPromise;
    const blocked = await Promise.race([
      tools.blocked_write?.execute({ value: "bypass guardrails" }),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 20)),
    ]);

    assert.match(String(blocked), /^\[安全保护\]/);
    releaseRead();
    await read;
  });

  it("redacts tool parameters, results, model context, events, and audit previews", async () => {
    const secret = "synthetic-tool-result-secret";
    const events: AgentEvent[] = [];
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++;
        if (modelCalls === 1) return toolCallStream("secret-1", "secret", {});
        const prompt = JSON.stringify(options.prompt);
        assert.doesNotMatch(prompt, new RegExp(secret));
        assert.match(prompt, /REDACTED/);
        return textStream("safe final");
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "secret",
      description: "secret",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => ({ password: secret, note: `Bearer ${secret}` }),
    });
    const context = createTestRunContext(registry);
    context.toolGuardrail = guardrailService(undefined, [
      secret,
    ]).createToolGuardrail({ source: "cli", role: "owner" });

    const result = await agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "get secret" }],
      system: "test",
      runContext: context,
      eventSink: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.text, "safe final");
    assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
    assert.match(JSON.stringify(events), /secret/);
    assert.equal(
      events.some(
        (event) =>
          event.type === "guardrail_decision" && event.stage === "tool",
      ),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(registry.getExecutionAuditLog()),
      new RegExp(secret),
    );
  });

  it("removes blocked tool arguments before they enter later model context", async () => {
    const secret = "synthetic-blocked-argument";
    let executed = false;
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++;
        if (modelCalls === 1) {
          return toolCallStream("blocked-1", "probe", { note: secret });
        }
        assert.doesNotMatch(JSON.stringify(options.prompt), new RegExp(secret));
        assert.match(JSON.stringify(options.prompt), /REDACTED/);
        return textStream("blocked safely");
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "probe",
      description: "probe",
      parameters: { type: "object", additionalProperties: true },
      isReadOnly: true,
      execute: async () => {
        executed = true;
        return "ran";
      },
    });
    const context = createTestRunContext(registry);
    context.toolGuardrail = guardrailService(undefined, [
      secret,
    ]).createToolGuardrail({ source: "cli", role: "owner" });
    const messages = [{ role: "user" as const, content: "probe" }];

    const result = await agentLoop({
      model,
      registry,
      messages,
      system: "test",
      runContext: context,
    });

    assert.equal(executed, false);
    assert.doesNotMatch(JSON.stringify(messages), new RegExp(secret));
    assert.equal(result.guardrails?.terminal, "blocked");
    assert.equal(result.guardrails?.tool?.outcome, "blocked");
  });

  it("routes registered, deferred, MCP, and child-spawn tools through the same check", async () => {
    const audit = new GuardrailAuditStore();
    const service = guardrailService(audit);
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "regular",
        description: "regular",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        execute: async () => "regular",
      },
      {
        name: "deferred",
        description: "deferred",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        shouldDefer: true,
        execute: async () => "deferred",
      },
      {
        name: "spawn_agent",
        description: "spawn",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        capabilities: ["delegate"],
        holdsExecutionLock: false,
        execute: async () => "child",
      },
    );
    await registry.registerMCPServer("test", {
      connect: async () => {},
      listTools: async () => [
        {
          name: "remote",
          description: "remote",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      callTool: async () => "remote",
      close: async () => {},
    });
    const context = createTestRunContext(registry);
    context.toolGuardrail = service.createToolGuardrail({
      source: "cli",
      role: "owner",
    });
    context.toolView.searchTools("deferred,mcp__test__remote");
    const tools = registry.toAISDKFormat(context);

    await tools.regular?.execute({});
    await tools.deferred?.execute({});
    await tools.mcp__test__remote?.execute({});
    await tools.spawn_agent?.execute({});

    assert.deepEqual(
      audit
        .list()
        .filter((record) => record.stage === "tool")
        .map((record) => record.tool),
      ["regular", "deferred", "mcp__test__remote", "spawn_agent"],
    );
  });
});

function guardrailService(
  audit = new GuardrailAuditStore(),
  knownSecrets: readonly string[] = [],
) {
  return new GuardrailService({
    enabled: true,
    policyVersion: "test-v1",
    audit,
    knownSecrets,
  });
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
          usage: TEST_USAGE,
        },
      ],
    }),
  };
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
          usage: TEST_USAGE,
        },
      ],
    }),
  };
}
