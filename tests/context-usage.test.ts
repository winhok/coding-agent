import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildContextSnapshot,
  renderContextMatrix,
  renderUsageView,
} from "../src/context/view.ts";
import {
  computeCost,
  normalizeUsage,
  UsageTracker,
} from "../src/usage/tracker.ts";

describe("usage tracking", () => {
  it("normalizes AI SDK 7 cache usage", () => {
    assert.deepEqual(
      normalizeUsage({
        inputTokens: 100,
        outputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 60,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
        },
        outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
        totalTokens: 110,
      }),
      {
        inputTokens: 60,
        outputTokens: 10,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      },
    );
  });

  it("keeps the previous cache savings when no-cache simulation is enabled", () => {
    const tracker = new UsageTracker();
    tracker.record("claude-haiku-4-5", {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
    const savedBefore = tracker.totals().savedCost;

    tracker.setCacheEnabled(false);
    const simulatedMiss = tracker.record("claude-haiku-4-5", {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });

    assert.equal(simulatedMiss.inputTokens, 200);
    assert.equal(simulatedMiss.cacheReadTokens, 0);
    assert.ok(Math.abs(tracker.totals().savedCost - savedBefore) < 1e-12);
  });

  it("prices the fixed Qwen snapshot with implicit cache rates", () => {
    const cost = computeCost("qwen3.7-plus-2026-05-26", {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
    });

    assert.equal(cost, 0.003);
  });
});

describe("context and usage views", () => {
  it("renders a 16 by 16 context matrix", () => {
    const snapshot = buildContextSnapshot({
      modelName: "Test Model",
      modelId: "test-model",
      windowTokens: 1_000_000,
      systemPromptChars: 350,
      toolDescriptionChars: 700,
      memoryChars: 0,
      skillsChars: 0,
      messages: [{ role: "user", content: "hello" }],
      autocompactBufferTokens: 50_000,
    });
    const rows = renderContextMatrix(snapshot).split("\n");

    assert.equal(rows.length, 16);
    for (const row of rows) {
      const ansiPattern = new RegExp(
        `${String.fromCharCode(27)}\\[[0-9;]*m`,
        "g",
      );
      const cells = row.replaceAll(ansiPattern, "").split(" ");
      assert.equal(cells.length, 16);
    }
  });

  it("uses the tracker currency in the usage view", () => {
    const tracker = new UsageTracker();
    tracker.record("qwen3.7-plus-2026-05-26", {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    assert.match(renderUsageView(tracker), /¥/);
  });
});
