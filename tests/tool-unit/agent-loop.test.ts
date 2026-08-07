import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type AgentEvent, agentLoop } from "../../src/agent/loop.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createToolSearchTool } from "../../src/tools/tool-search.ts";

const TEST_USAGE = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

describe("agent loop interface", () => {
  it("executes multiple tool calls and feeds their results into the next model step", async () => {
    let modelCalls = 0;
    const observedValues: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++;
        if (modelCalls === 2) {
          const prompt = JSON.stringify(options.prompt);
          assert.match(prompt, /echo:alpha/);
          assert.match(prompt, /echo:beta/);
          return textStream("两个工具都已完成");
        }
        return toolCallStream([
          { id: "call-1", name: "echo", input: { value: "alpha" } },
          { id: "call-2", name: "echo", input: { value: "beta" } },
        ]);
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      isReadOnly: true,
      execute: async ({ value }: { value: string }) => {
        observedValues.push(value);
        return `echo:${value}`;
      },
    });

    const result = await agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "echo twice" }],
      system: "test",
      workingDir: process.cwd(),
    });

    assert.equal(result.text, "两个工具都已完成");
    assert.equal(result.stats.steps, 2);
    assert.equal(result.stats.toolCalls, 2);
    assert.deepEqual(observedValues.sort(), ["alpha", "beta"]);
  });

  it("makes an exactly discovered deferred tool available on the next step", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++;
        if (modelCalls === 1) {
          assert.doesNotMatch(JSON.stringify(options.tools), /deferred_tool/);
          return toolCallStream([
            {
              id: "search-1",
              name: "tool_search",
              input: { query: "deferred_tool" },
            },
          ]);
        }
        if (modelCalls === 2) {
          assert.match(JSON.stringify(options.tools), /deferred_tool/);
          return toolCallStream([
            { id: "deferred-1", name: "deferred_tool", input: {} },
          ]);
        }
        return textStream("deferred complete");
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "deferred_tool",
      description: "deferred",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      shouldDefer: true,
      execute: async () => "deferred result",
    });
    registry.register(createToolSearchTool(registry));

    const result = await agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "discover" }],
      system: "test",
      workingDir: process.cwd(),
    });

    assert.equal(result.text, "deferred complete");
    assert.equal(result.stats.steps, 3);
    assert.equal(result.stats.toolCalls, 2);
  });

  it("feeds an approval rejection back to the model without executing the tool", async () => {
    let modelCalls = 0;
    let executed = false;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++;
        if (modelCalls === 1) {
          return toolCallStream([{ id: "write-1", name: "mutate", input: {} }]);
        }
        assert.match(JSON.stringify(options.prompt), /用户拒绝/);
        return textStream("已停止修改");
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "mutate",
      description: "mutate",
      parameters: { type: "object", properties: {} },
      isReadOnly: false,
      execute: async () => {
        executed = true;
        return "changed";
      },
    });

    const result = await agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "mutate" }],
      system: "test",
      workingDir: process.cwd(),
      requestApproval: async () => false,
    });

    assert.equal(executed, false);
    assert.equal(result.text, "已停止修改");
    assert.equal(result.stats.steps, 2);
  });

  it("returns a structured completed result and emits typed events", async () => {
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "完成" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              logprobs: undefined,
              usage: TEST_USAGE,
            },
          ],
        }),
      }),
    });
    const messages = [{ role: "user" as const, content: "测试" }];

    const result = await agentLoop({
      model,
      registry: new ToolRegistry(),
      messages,
      system: "test",
      workingDir: process.cwd(),
      eventSink: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.termination, "completed");
    assert.equal(result.text, "完成");
    assert.equal(result.stats.steps, 1);
    assert.equal(result.stats.toolCalls, 0);
    assert.deepEqual(result.stats.usage, {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(result.appendedMessages.length, 1);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "run_started",
        "step_started",
        "text_delta",
        "step_finished",
        "run_finished",
      ],
    );
  });

  it("reports max_steps without invoking the model", async () => {
    let modelCalled = false;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalled = true;
        throw new Error("should not run");
      },
    });

    const result = await agentLoop({
      model,
      registry: new ToolRegistry(),
      messages: [{ role: "user", content: "测试" }],
      system: "test",
      workingDir: process.cwd(),
      maxSteps: 0,
      eventSink: (event) => {
        events.push(event);
      },
    });

    assert.equal(modelCalled, false);
    assert.equal(result.termination, "max_steps");
    assert.equal(result.stats.steps, 0);
    assert.deepEqual(
      events.map((event) => event.type),
      ["run_started", "run_finished"],
    );
  });
});

function toolCallStream(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.id,
          toolName: call.name,
          input: JSON.stringify(call.input),
        })),
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
