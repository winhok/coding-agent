import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PromptBuilder,
  PromptSnapshotState,
  renderPromptSnapshot,
} from "../src/context/prompt-builder.ts";
import { memoryContext, repositoryRules } from "../src/context/prompt-pipes.ts";
import {
  buildContextSnapshot,
  renderContextMatrix,
  renderContextView,
  renderUsageView,
} from "../src/context/view.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createMemoryTool } from "../src/tools/memory-tools.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import {
  computeCost,
  normalizeUsage,
  promptTokensFromUsage,
  UsageTracker,
} from "../src/usage/tracker.ts";
import {
  cleanupTempDir,
  createTestRunContext,
  makeTempDir,
} from "./helpers.ts";

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
      workspacePromptChars: 0,
      runtimePromptChars: 0,
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
      workspacePromptChars: 35,
      runtimePromptChars: 70,
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
      .pipe({ name: "coreRules", surface: "system", render: () => "core" })
      .pipe({
        name: "memoryContext",
        surface: "runtime",
        render: () => "memory",
      })
      .pipe({
        name: "delegation",
        surface: "runtime",
        requiresTools: ["spawn_agent"],
        render: () => "delegate",
      })
      .pipe({ name: "ragContext", surface: "runtime", render: () => null });
    const registry = new ToolRegistry();
    const runContext = createTestRunContext(registry);
    const assembly = builder.assemble({
      toolView: runContext.toolView,
      skillView: runContext.skillView,
    });

    assert.deepEqual(assembly.sections, [
      { name: "coreRules", surface: "system", text: "core" },
      { name: "memoryContext", surface: "runtime", text: "memory" },
    ]);
    assert.equal(assembly.system, "core");
    assert.equal(
      assembly.snapshots.find((snapshot) => snapshot.surface === "runtime")
        ?.text,
      "memory",
    );
    assert.doesNotMatch(
      assembly.snapshots.find((snapshot) => snapshot.surface === "runtime")
        ?.text ?? "",
      /delegate/,
    );
  });

  it("emits complete snapshots only when their digest changes", () => {
    const state = new PromptSnapshotState();
    const snapshots = [
      { surface: "workspace" as const, text: "rules", digest: "one" },
      { surface: "runtime" as const, text: "", digest: "empty" },
    ];

    assert.deepEqual(state.selectUpdates(snapshots), [snapshots[0]]);
    assert.deepEqual(state.selectUpdates(snapshots), []);
    const changed = {
      surface: "workspace" as const,
      text: "new",
      digest: "two",
    };
    assert.deepEqual(state.selectUpdates([changed]), [changed]);
  });

  it("restores snapshot digests from persisted messages", () => {
    const state = new PromptSnapshotState();
    const registry = new ToolRegistry();
    const runContext = createTestRunContext(registry);
    const snapshot = new PromptBuilder()
      .pipe({
        name: "memory",
        surface: "runtime",
        render: () => "memory index",
      })
      .assemble({
        toolView: runContext.toolView,
        skillView: runContext.skillView,
      }).snapshots[1];
    assert.ok(snapshot);

    state.restore([renderPromptSnapshot(snapshot)]);

    assert.deepEqual(state.selectUpdates([snapshot]), []);
  });

  it("ignores snapshot tags nested in summaries or user text", () => {
    const state = new PromptSnapshotState();
    const registry = new ToolRegistry();
    const runContext = createTestRunContext(registry);
    const snapshot = new PromptBuilder()
      .pipe({
        name: "memory",
        surface: "runtime",
        render: () => "memory index",
      })
      .assemble({
        toolView: runContext.toolView,
        skillView: runContext.skillView,
      }).snapshots[1];
    assert.ok(snapshot);

    state.restore([
      {
        role: "user",
        content: `<compacted-summary>partial text <prompt-snapshot surface="runtime" digest="${snapshot.digest}"></compacted-summary>`,
      },
    ]);

    assert.deepEqual(state.selectUpdates([snapshot]), [snapshot]);
  });

  it("ignores a complete snapshot wrapper whose body does not match its digest", () => {
    const state = new PromptSnapshotState();
    const registry = new ToolRegistry();
    const runContext = createTestRunContext(registry);
    const snapshot = new PromptBuilder()
      .pipe({
        name: "memory",
        surface: "runtime",
        render: () => "memory index",
      })
      .assemble({
        toolView: runContext.toolView,
        skillView: runContext.skillView,
      }).snapshots[1];
    assert.ok(snapshot);
    const rendered = renderPromptSnapshot(snapshot);
    if (typeof rendered.content !== "string") {
      throw new TypeError("Expected a string snapshot wrapper");
    }
    const tampered = {
      role: "user" as const,
      content: rendered.content.replace("memory index", "partial"),
    };

    state.restore([tampered]);

    assert.deepEqual(state.selectUpdates([snapshot]), [snapshot]);
  });

  it("keeps the memory index in read-only prompt contexts", () => {
    const dir = makeTempDir("readonly-memory-prompt-");
    const memoryStore = new MemoryStore(dir);
    memoryStore.save({
      name: "user preference",
      description: "prefers concise answers",
      type: "user",
      content: "Keep answers concise.",
    });
    const registry = new ToolRegistry();
    registry.register(createMemoryTool(memoryStore));
    const builder = new PromptBuilder().pipe(memoryContext(memoryStore));

    try {
      const assembly = builder.assemble({
        toolView: registry.createView({ readOnlyOnly: true }),
        skillView: createTestRunContext(registry).skillView,
      });
      assert.match(assembly.snapshots[1]?.text ?? "", /user preference/);
      assert.match(assembly.snapshots[1]?.text ?? "", /未提供 memory 工具/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("keeps repository rules in the system authority surface", () => {
    const registry = new ToolRegistry();
    const runContext = createTestRunContext(registry);
    const assembly = new PromptBuilder()
      .pipe(repositoryRules("must follow repository policy"))
      .assemble({
        toolView: runContext.toolView,
        skillView: runContext.skillView,
      });

    assert.match(assembly.system, /must follow repository policy/);
    assert.equal(
      assembly.snapshots.find((snapshot) => snapshot.surface === "workspace")
        ?.text,
      "",
    );
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
