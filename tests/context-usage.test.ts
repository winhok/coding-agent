import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PromptBuilder,
  renderPromptSections,
} from "../src/context/prompt-builder.ts";
import {
  buildContextSnapshot,
  renderContextMatrix,
  renderContextView,
  renderUsageView,
} from "../src/context/view.ts";
import {
  computeCost,
  normalizeUsage,
  promptTokensFromUsage,
  UsageTracker,
} from "../src/usage/tracker.ts";

describe("usage tracking", () => {
  it("normalizes AI SDK 7 cache usage", () => {
    const usage = normalizeUsage({
      inputTokens: 100,
      outputTokens: 10,
      inputTokenDetails: {
        noCacheTokens: 60,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      },
      outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
      totalTokens: 110,
    });

    assert.deepEqual(usage, {
      inputTokens: 60,
      outputTokens: 10,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
    assert.equal(promptTokensFromUsage(usage), 100);
  });

  it("tracks actual cache usage and savings", () => {
    const tracker = new UsageTracker();
    const record = tracker.record("claude-haiku-4-5", {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });

    assert.equal(record.inputTokens, 100);
    assert.equal(record.cacheReadTokens, 100);
    assert.ok(tracker.totals().savedCost > 0);
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
      effectiveWindowTokens: 950_000,
      autocompactThresholdTokens: 200_000,
      systemPromptChars: 350,
      toolDescriptionChars: 700,
      memoryChars: 0,
      ragChars: 0,
      skillsChars: 0,
      messages: [{ role: "user", content: "hello" }],
      tokenMeasurement: {
        observedPromptTokens: null,
        pendingEstimatedTokens: 0,
      },
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

  it("separates effective capacity and API measurement from estimated categories", () => {
    const snapshot = buildContextSnapshot({
      modelName: "Test Model",
      modelId: "test-model",
      windowTokens: 1_000_000,
      effectiveWindowTokens: 950_000,
      autocompactThresholdTokens: 200_000,
      systemPromptChars: 350,
      toolDescriptionChars: 700,
      memoryChars: 35,
      ragChars: 70,
      skillsChars: 0,
      messages: [],
      tokenMeasurement: {
        observedPromptTokens: 4_500,
        pendingEstimatedTokens: 100,
      },
    });

    assert.equal(snapshot.usedTokens, 4_600);
    assert.equal(snapshot.autocompactReserveTokens, 750_000);
    assert.equal(snapshot.safetyReserveTokens, 50_000);
    assert.notEqual(snapshot.estimatedBreakdownTokens, snapshot.usedTokens);

    const output = renderContextView(snapshot);
    assert.match(output, /4\.6k\/950\.0k effective tokens/);
    assert.match(output, /Nominal window: 1\.0M tokens/);
    assert.match(output, /Measurement: API 4\.5k \+100 pending estimate/);
    assert.match(output, /Autocompact reserve: 750\.0k/);
    assert.match(output, /Safety reserve: 50\.0k/);
  });

  it("builds the sent prompt from the same named sections used for metering", () => {
    const builder = new PromptBuilder()
      .pipe("coreRules", () => "core")
      .pipe("memoryContext", () => "memory")
      .pipe("ragContext", () => null);
    const context = {
      toolCount: 0,
      deferredToolSummary: "",
      sessionMessageCount: 0,
      sessionId: "test",
    };
    const sections = builder.buildSections(context);

    assert.deepEqual(sections, [
      { name: "coreRules", text: "core" },
      { name: "memoryContext", text: "memory" },
    ]);
    assert.equal(builder.build(context), renderPromptSections(sections));
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
