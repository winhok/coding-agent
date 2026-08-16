import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  CompactionCircuitBreaker,
  estimateTokens,
  pruneOldestContext,
  serializeMessageForCompaction,
  summarize,
} from "../src/context/compressor.ts";

describe("context compaction reliability", () => {
  it("preserves tool call identity and arguments in compression input", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-exact-123",
          toolName: "read_file",
          input: { path: "/workspace/exact.ts", line: 42 },
        },
      ],
    } as ModelMessage;

    const serialized = serializeMessageForCompaction(message);
    assert.match(serialized, /read_file/);
    assert.match(serialized, /call-exact-123/);
    assert.match(serialized, /\/workspace\/exact\.ts/);
    assert.match(serialized, /42/);
  });

  it("opens after consecutive failures and resets after success", () => {
    const breaker = new CompactionCircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.isOpen, false);
    breaker.recordFailure();
    assert.equal(breaker.isOpen, true);
    breaker.recordSuccess();
    assert.equal(breaker.isOpen, false);
  });

  it("rejects a summary truncated by the output token limit", async () => {
    const model = completionModel("partial summary", "length");
    const messages = conversationWithLargeToolCall("x".repeat(8_000));

    await assert.rejects(
      summarize(model, messages, "", {
        thresholdTokens: 1,
        keepRecentMessages: 2,
        maxOutputTokens: 32,
      }),
      /ended with length/,
    );
  });

  it("uses the same large tool-call arguments for size and progress checks", async () => {
    const messages = conversationWithLargeToolCall("x".repeat(20_080));
    assert.ok(estimateTokens(messages) > 5_000);

    const result = await summarize(
      completionModel("complete compact summary", "stop"),
      messages,
      "",
      { thresholdTokens: 1, keepRecentMessages: 2 },
    );
    assert.ok(result.compressedCount > 0);
    assert.ok(estimateTokens(result.messages) < estimateTokens(messages));
  });

  it("deterministically prunes an old prefix when summarization is unavailable", () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user" as const,
      content: `${index}-${"x".repeat(200)}`,
    }));
    const result = pruneOldestContext(messages, 120);

    assert.ok(result.compressedCount > 0);
    assert.match(String(result.messages[0]?.content), /deterministic-prune/);
    assert.ok(estimateTokens(result.messages) < estimateTokens(messages));
  });
});

function completionModel(text: string, finishReason: "stop" | "length") {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: finishReason, raw: finishReason },
      usage: {
        inputTokens: {
          total: 100,
          noCache: 100,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

function conversationWithLargeToolCall(argument: string): ModelMessage[] {
  return [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "large-call",
          toolName: "write_file",
          input: { content: argument },
        },
      ],
    } as ModelMessage,
    { role: "user", content: "middle-1" },
    { role: "assistant", content: "middle-2" },
    { role: "user", content: "recent-1" },
    { role: "assistant", content: "recent-2" },
  ];
}
