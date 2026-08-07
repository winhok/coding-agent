import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type AgentEvent, agentLoop } from "../../src/agent/loop.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

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
