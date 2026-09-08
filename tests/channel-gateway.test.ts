import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type LanguageModel,
  type ModelMessage,
  simulateReadableStream,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import Database from "better-sqlite3";
import type { AgentLoopResult } from "../src/agent/loop.ts";
import {
  ChannelGateway,
  createChannelGatewayForMode,
} from "../src/channels/gateway.ts";
import { ChannelStore, ChannelStoreLeaseError } from "../src/channels/store.ts";
import {
  type ChannelDefinition,
  ChannelSendError,
  type ChannelSendReceipt,
  type IncomingMessage,
  type OutgoingMessage,
} from "../src/channels/types.ts";
import type { PromptAssembly } from "../src/context/prompt-builder.ts";
import { GuardrailAuditStore } from "../src/guardrails/audit.ts";
import { GuardrailService } from "../src/guardrails/service.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import {
  cleanupTempDir,
  createTestRunContext,
  makeTempDir,
  withMutedConsole,
} from "./helpers.ts";

class TestChannel implements ChannelDefinition {
  readonly name = "test";
  readonly description = "test channel";
  readonly accountId = "account-1";
  readonly sent: OutgoingMessage[] = [];
  startError?: Error;
  sendError?: Error;
  sendReceipt?: ChannelSendReceipt;

  start(): void {
    if (this.startError) throw this.startError;
  }

  stop(): void {}

  async send(message: OutgoingMessage): Promise<ChannelSendReceipt> {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
    if (this.sendReceipt) return this.sendReceipt;
    return {
      platformMessageId: `platform-${message.deliveryId}`,
      deliveredAt: Date.now(),
    };
  }
}

function incoming(
  transportEventId: string,
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    transportEventId,
    accountId: "account-1",
    conversationId: "chat-1",
    senderId: "user-1",
    senderName: "User One",
    text: transportEventId,
    receivedAt: Date.now(),
    ...overrides,
  };
}

function completed(text: string): AgentLoopResult {
  const assistant: ModelMessage = { role: "assistant", content: text };
  return {
    appendedMessages: [assistant],
    text,
    termination: "completed",
    stats: {
      steps: 1,
      toolCalls: 0,
      retries: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };
}

function runtimeSnapshot(text: string) {
  return {
    surface: "runtime" as const,
    text,
    digest: createHash("sha256").update(`runtime\0${text}`).digest("hex"),
  };
}

function createGateway(
  statePath: string,
  channel: TestChannel,
  runTurn: (messages: ModelMessage[]) => Promise<AgentLoopResult>,
  contextOptions: {
    contextWindowTokens?: number;
    autoCompactThresholdTokens?: number;
    summarizeContext?: (
      messages: ModelMessage[],
      existingSummary?: string,
    ) => Promise<{
      messages: ModelMessage[];
      summary: string;
      compressedCount: number;
    }>;
    buildPrompt?: () => PromptAssembly;
    maxConversationRuntimeStates?: number;
    guardrails?: GuardrailService;
  } = {},
): ChannelGateway {
  const registry = new ToolRegistry();
  const gateway = new ChannelGateway({
    model: {} as LanguageModel,
    registry,
    createRunContext: () => createTestRunContext(registry),
    buildPrompt: () => ({ system: "system", snapshots: [], sections: [] }),
    statePath,
    runTurn: ({ messages }) => runTurn(messages),
    ...contextOptions,
  });
  gateway.register(channel);
  return gateway;
}

describe("channel gateway", () => {
  it("atomically rejects unsafe Feishu input without normal history or model execution", async () => {
    const dir = makeTempDir("channel-guardrail-input-");
    const statePath = join(dir, "state.sqlite");
    const channel = new TestChannel();
    let modelCalls = 0;
    const guardrails = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
    });
    const store = new ChannelStore(statePath);
    const registry = new ToolRegistry();
    const gateway = new ChannelGateway({
      model: {} as LanguageModel,
      registry,
      createRunContext: () => createTestRunContext(registry),
      buildPrompt: () => ({ system: "system", snapshots: [], sections: [] }),
      store,
      guardrails,
      runTurn: async () => {
        modelCalls++;
        return completed("unsafe");
      },
    });
    gateway.register(channel);

    try {
      await gateway.startAll();
      const message = incoming("blocked-feishu", { text: "bypass guardrails" });
      const accepted = await gateway.accept("test", message);
      const duplicate = await gateway.accept("test", message);
      await gateway.waitForIdle();

      assert.equal(accepted.accepted, true);
      assert.equal(duplicate.accepted, false);
      assert.equal(modelCalls, 0);
      assert.equal(channel.sent.length, 1);
      assert.match(channel.sent[0]?.text ?? "", /安全保护/);
      assert.doesNotMatch(JSON.stringify(channel.sent), /bypass guardrails/);
      assert.deepEqual(store.loadConversation(accepted.conversationKey), []);
    } finally {
      await gateway.stopAll();
      cleanupTempDir(dir);
    }
  });

  it("replaces rejected Feishu output before atomic history and outbox commit", async () => {
    const dir = makeTempDir("channel-guardrail-output-");
    const statePath = join(dir, "state.sqlite");
    const channel = new TestChannel();
    const secret = "sk-synthetic_12345678901234567890";
    const guardrails = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
    });
    const store = new ChannelStore(statePath);
    const registry = new ToolRegistry();
    const gateway = new ChannelGateway({
      model: {} as LanguageModel,
      registry,
      createRunContext: () => createTestRunContext(registry),
      buildPrompt: () => ({ system: "system", snapshots: [], sections: [] }),
      store,
      guardrails,
      runTurn: async () => completed(`credential: ${secret}`),
    });
    gateway.register(channel);

    try {
      await gateway.startAll();
      const accepted = await gateway.accept("test", incoming("blocked-output"));
      await gateway.waitForIdle();

      assert.equal(channel.sent.length, 1);
      assert.match(channel.sent[0]?.text ?? "", /安全保护/);
      assert.doesNotMatch(JSON.stringify(channel.sent), /sk-synthetic_/);
      const history = store.loadConversation(accepted.conversationKey);
      assert.doesNotMatch(JSON.stringify(history), /sk-synthetic_/);
      assert.match(JSON.stringify(history), /安全保护/);
    } finally {
      await gateway.stopAll();
      cleanupTempDir(dir);
    }
  });

  it("does not construct or lease channel state outside interactive mode", () => {
    const dir = makeTempDir("channel-mode-boundary-");
    const statePath = join(dir, "state.sqlite");
    const owner = new ChannelStore(statePath);
    let constructions = 0;
    const create = () => {
      constructions++;
      return new ChannelGateway({
        model: {} as LanguageModel,
        registry: new ToolRegistry(),
        createRunContext: () => createTestRunContext(new ToolRegistry()),
        buildPrompt: () => ({ system: "system", snapshots: [], sections: [] }),
        statePath,
      });
    };

    try {
      assert.equal(createChannelGatewayForMode("ask", create), undefined);
      assert.equal(createChannelGatewayForMode("plan", create), undefined);
      assert.equal(constructions, 0);
    } finally {
      owner.close();
      cleanupTempDir(dir);
    }
  });

  it("does not let a second store recover work owned by a live process", () => {
    const dir = makeTempDir("channel-live-owner-");
    const statePath = join(dir, "state.sqlite");
    const firstStore = new ChannelStore(statePath);
    try {
      const accepted = firstStore.acceptIngress(
        "test",
        incoming("event-live-owner"),
      );
      assert.ok(accepted.turnId);
      assert.ok(firstStore.claimNextTurn(accepted.conversationKey));

      assert.throws(() => new ChannelStore(statePath), ChannelStoreLeaseError);
      assert.equal(firstStore.getTurnStatus(accepted.turnId), "running");
      assert.equal(firstStore.getChannelStats("test").failedTurns, 0);
    } finally {
      firstStore.close();
      cleanupTempDir(dir);
    }
  });

  it("does not replay a turn whose process-level outcome is unknown", () => {
    const dir = makeTempDir("channel-running-recovery-");
    const statePath = join(dir, "state.sqlite");
    const firstStore = new ChannelStore(statePath);
    const accepted = firstStore.acceptIngress(
      "test",
      incoming("event-running"),
    );
    const pending = firstStore.acceptIngress(
      "test",
      incoming("event-pending", { conversationId: "chat-pending" }),
    );
    assert.equal(accepted.accepted, true);
    assert.equal(pending.accepted, true);
    assert.ok(firstStore.claimNextTurn(accepted.conversationKey));
    firstStore.close();

    const recovered = new ChannelStore(statePath);
    try {
      assert.deepEqual(recovered.getChannelStats("test"), {
        pendingTurns: 1,
        failedTurns: 1,
        pendingDeliveries: 0,
        failedDeliveries: 0,
        unknownDeliveries: 0,
      });
      assert.equal(
        recovered.claimNextTurn(accepted.conversationKey),
        undefined,
      );
      assert.equal(
        recovered.claimNextTurn(pending.conversationKey)?.logicalMessageId,
        pending.logicalMessageId,
      );
    } finally {
      recovered.close();
      cleanupTempDir(dir);
    }
  });

  it("fences a stale owner after its lease is reclaimed", () => {
    const dir = makeTempDir("channel-owner-fence-");
    const statePath = join(dir, "state.sqlite");
    const firstStore = new ChannelStore(statePath, { leaseMs: 60_000 });
    const accepted = firstStore.acceptIngress(
      "test",
      incoming("event-stale-owner"),
    );
    assert.ok(accepted.turnId);
    const turnId = accepted.turnId;
    assert.ok(firstStore.claimNextTurn(accepted.conversationKey));

    const db = new Database(statePath);
    db.prepare(
      "UPDATE channel_gateway_lease SET expires_at = 0 WHERE id = 1",
    ).run();
    db.close();

    const recoveredStore = new ChannelStore(statePath);
    try {
      assert.equal(recoveredStore.getTurnStatus(turnId), "failed");
      assert.throws(
        () => firstStore.releaseTurn(turnId),
        ChannelStoreLeaseError,
      );
    } finally {
      firstStore.close();
      recoveredStore.close();
      cleanupTempDir(dir);
    }
  });

  it("durably deduplicates ingress and serializes turns per conversation", async () => {
    const dir = makeTempDir("channel-gateway-");
    const statePath = join(dir, "state.sqlite");
    const channel = new TestChannel();
    let active = 0;
    let maxActive = 0;
    const histories: ModelMessage[][] = [];
    const gateway = createGateway(statePath, channel, async (messages) => {
      active++;
      maxActive = Math.max(maxActive, active);
      histories.push([...messages]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return completed(`reply-${histories.length}`);
    });

    try {
      await withMutedConsole(() => gateway.startAll());
      const first = await gateway.accept("test", incoming("event-1"));
      const duplicate = await gateway.accept("test", incoming("event-1"));
      const second = await gateway.accept("test", incoming("event-2"));
      await gateway.waitForIdle();

      assert.equal(first.accepted, true);
      assert.equal(duplicate.accepted, false);
      assert.equal(second.accepted, true);
      assert.equal(maxActive, 1);
      assert.equal(histories.length, 2);
      assert.equal(histories[0]?.length, 1);
      assert.equal(histories[1]?.length, 3);
      assert.deepEqual(
        channel.sent.map((message) => message.text),
        ["reply-1", "reply-2"],
      );
      assert.deepEqual(gateway.list()[0]?.queues, {
        pendingTurns: 0,
        failedTurns: 0,
        pendingDeliveries: 0,
        failedDeliveries: 0,
        unknownDeliveries: 0,
      });
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("preserves provider reply routing through the durable outbox", async () => {
    const dir = makeTempDir("channel-thread-route-");
    const channel = new TestChannel();
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      channel,
      async () => completed("thread reply"),
    );
    try {
      await withMutedConsole(() => gateway.startAll());
      await gateway.accept(
        "test",
        incoming("event-thread", {
          threadId: "topic-1",
          replyToMessageId: "root-message-1",
          replyInThread: true,
        }),
      );
      await gateway.waitForIdle();

      assert.deepEqual(channel.sent[0], {
        conversationId: "chat-1",
        threadId: "topic-1",
        replyToMessageId: "root-message-1",
        replyInThread: true,
        text: "thread reply",
        deliveryId: channel.sent[0]?.deliveryId,
      });
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("allows different conversations to execute concurrently", async () => {
    const dir = makeTempDir("channel-concurrency-");
    const channel = new TestChannel();
    let active = 0;
    let maxActive = 0;
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      channel,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return completed("reply");
      },
    );

    try {
      await withMutedConsole(() => gateway.startAll());
      await gateway.accept(
        "test",
        incoming("event-a", { conversationId: "chat-a" }),
      );
      await gateway.accept(
        "test",
        incoming("event-b", { conversationId: "chat-b" }),
      );
      await gateway.waitForIdle();
      assert.equal(maxActive, 2);
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("does not retry an ambiguous send or rerun the completed model turn", async () => {
    const dir = makeTempDir("channel-unknown-");
    const statePath = join(dir, "state.sqlite");
    const firstChannel = new TestChannel();
    firstChannel.sendError = new Error("connection lost after request write");
    let modelRuns = 0;
    const firstGateway = createGateway(statePath, firstChannel, async () => {
      modelRuns++;
      return completed("reply");
    });

    await withMutedConsole(() => firstGateway.startAll());
    await firstGateway.accept("test", incoming("event-unknown"));
    await firstGateway.waitForIdle();
    assert.equal(firstGateway.list()[0]?.queues.unknownDeliveries, 1);
    await withMutedConsole(() => firstGateway.stopAll());

    const recoveredChannel = new TestChannel();
    const recoveredGateway = createGateway(
      statePath,
      recoveredChannel,
      async () => {
        modelRuns++;
        return completed("must not run");
      },
    );
    try {
      await withMutedConsole(() => recoveredGateway.startAll());
      await recoveredGateway.waitForIdle();
      assert.equal(modelRuns, 1);
      assert.equal(recoveredChannel.sent.length, 0);
      assert.equal(recoveredGateway.list()[0]?.queues.unknownDeliveries, 1);
    } finally {
      await withMutedConsole(() => recoveredGateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("does not mark an adapter receipt without a platform identity delivered", async () => {
    const dir = makeTempDir("channel-empty-receipt-");
    const channel = new TestChannel();
    channel.sendReceipt = { platformMessageId: "", deliveredAt: Date.now() };
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      channel,
      async () => completed("reply"),
    );
    try {
      await withMutedConsole(() => gateway.startAll());
      await gateway.accept("test", incoming("event-empty-receipt"));
      await gateway.waitForIdle();
      assert.equal(gateway.list()[0]?.queues.unknownDeliveries, 1);
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("retries a definitely-not-sent outbox entry without rerunning the turn", async () => {
    const dir = makeTempDir("channel-retry-");
    const statePath = join(dir, "state.sqlite");
    const firstChannel = new TestChannel();
    firstChannel.sendError = new ChannelSendError("offline", "not_sent");
    let modelRuns = 0;
    const firstGateway = createGateway(statePath, firstChannel, async () => {
      modelRuns++;
      return completed("durable reply");
    });

    await withMutedConsole(() => firstGateway.startAll());
    await firstGateway.accept("test", incoming("event-retry"));
    await firstGateway.waitForIdle();
    assert.equal(firstGateway.list()[0]?.queues.failedDeliveries, 1);
    await withMutedConsole(() => firstGateway.stopAll());

    const recoveredChannel = new TestChannel();
    const recoveredGateway = createGateway(
      statePath,
      recoveredChannel,
      async () => {
        modelRuns++;
        return completed("must not run");
      },
    );
    try {
      await withMutedConsole(() => recoveredGateway.startAll());
      await recoveredGateway.waitForIdle();
      assert.equal(modelRuns, 1);
      assert.deepEqual(
        recoveredChannel.sent.map((message) => message.text),
        ["durable reply"],
      );
      assert.equal(recoveredGateway.list()[0]?.queues.failedDeliveries, 0);
    } finally {
      await withMutedConsole(() => recoveredGateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("reports a startup failure instead of a false running status", async () => {
    const dir = makeTempDir("channel-health-");
    const channel = new TestChannel();
    channel.startError = new Error("invalid credentials");
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      channel,
      async () => completed("unused"),
    );
    try {
      await withMutedConsole(() => gateway.startAll());
      assert.deepEqual(gateway.list()[0]?.status, {
        state: "failed",
        error: "invalid credentials",
      });
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("blocks later turns when an earlier turn fails", async () => {
    const dir = makeTempDir("channel-failed-turn-");
    const channel = new TestChannel();
    let modelRuns = 0;
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      channel,
      async () => {
        modelRuns++;
        throw new Error("model failed after admission");
      },
    );
    try {
      await withMutedConsole(() => gateway.startAll());
      await gateway.accept("test", incoming("event-failed"));
      await gateway.waitForIdle();
      await gateway.accept("test", incoming("event-after-failure"));
      await gateway.waitForIdle();

      assert.equal(modelRuns, 1);
      assert.deepEqual(gateway.list()[0]?.queues, {
        pendingTurns: 1,
        failedTurns: 1,
        pendingDeliveries: 0,
        failedDeliveries: 0,
        unknownDeliveries: 0,
      });
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("persists a compacted active context while retaining full audit history", async () => {
    const dir = makeTempDir("channel-context-projection-");
    const statePath = join(dir, "state.sqlite");
    const channel = new TestChannel();
    const histories: ModelMessage[][] = [];
    const summarizeContext = async (messages: ModelMessage[]) => {
      if (messages.length < 3) {
        return { messages, summary: "", compressedCount: 0 };
      }
      return {
        messages: [
          { role: "user" as const, content: "[durable summary]" },
          ...messages.slice(-2),
        ],
        summary: "durable summary",
        compressedCount: messages.length - 2,
      };
    };
    const firstGateway = createGateway(
      statePath,
      channel,
      async (messages) => {
        histories.push([...messages]);
        return completed("x".repeat(80));
      },
      {
        contextWindowTokens: 200,
        autoCompactThresholdTokens: 20,
        summarizeContext,
      },
    );

    await withMutedConsole(() => firstGateway.startAll());
    await firstGateway.accept(
      "test",
      incoming("x".repeat(80), { transportEventId: "projection-1" }),
    );
    await firstGateway.accept(
      "test",
      incoming("y".repeat(80), { transportEventId: "projection-2" }),
    );
    await firstGateway.waitForIdle();
    await withMutedConsole(() => firstGateway.stopAll());

    const recoveredChannel = new TestChannel();
    const recoveredGateway = createGateway(
      statePath,
      recoveredChannel,
      async (messages) => {
        histories.push([...messages]);
        return completed("recovered");
      },
      {
        contextWindowTokens: 200,
        autoCompactThresholdTokens: 20,
        summarizeContext,
      },
    );
    try {
      await withMutedConsole(() => recoveredGateway.startAll());
      await recoveredGateway.accept("test", incoming("projection-3"));
      await recoveredGateway.waitForIdle();

      assert.ok(
        histories
          .at(-1)
          ?.some((message) => message.content === "[durable summary]"),
      );
      const db = new Database(statePath);
      const auditCount = db
        .prepare("SELECT COUNT(*) AS count FROM channel_session_messages")
        .get() as { count: number };
      const projectionCount = db
        .prepare("SELECT COUNT(*) AS count FROM channel_context_projection")
        .get() as { count: number };
      db.close();
      assert.equal(auditCount.count, 6);
      assert.equal(projectionCount.count, 1);
    } finally {
      await withMutedConsole(() => recoveredGateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("injects a prompt snapshot once and replaces it when the digest changes", async () => {
    const dir = makeTempDir("channel-prompt-snapshot-");
    const channel = new TestChannel();
    const histories: ModelMessage[][] = [];
    let version = "one";
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      channel,
      async (messages) => {
        histories.push([...messages]);
        return completed("ok");
      },
      {
        buildPrompt: () => ({
          system: "system",
          sections: [],
          snapshots: [
            { surface: "workspace", text: `rules-${version}`, digest: version },
          ],
        }),
      },
    );

    try {
      await withMutedConsole(() => gateway.startAll());
      await gateway.accept("test", incoming("snapshot-1"));
      await gateway.waitForIdle();
      await gateway.accept("test", incoming("snapshot-2"));
      await gateway.waitForIdle();
      version = "two";
      await gateway.accept("test", incoming("snapshot-3"));
      await gateway.waitForIdle();

      const countSnapshots = (messages: ModelMessage[]) =>
        messages.filter(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("<prompt-snapshot"),
        ).length;
      assert.equal(countSnapshots(histories[0] ?? []), 1);
      assert.equal(countSnapshots(histories[1] ?? []), 1);
      assert.equal(countSnapshots(histories[2] ?? []), 2);
      assert.match(JSON.stringify(histories[2]), /rules-two/);
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("restores prompt snapshot state after a gateway restart", async () => {
    const dir = makeTempDir("channel-prompt-snapshot-restart-");
    const statePath = join(dir, "state.sqlite");
    const prompt = () => ({
      system: "system",
      sections: [],
      snapshots: [runtimeSnapshot("memory")],
    });
    const first = createGateway(
      statePath,
      new TestChannel(),
      async () => completed("first"),
      { buildPrompt: prompt },
    );
    await withMutedConsole(() => first.startAll());
    await first.accept("test", incoming("snapshot-restart-1"));
    await first.waitForIdle();
    await withMutedConsole(() => first.stopAll());

    const histories: ModelMessage[][] = [];
    const second = createGateway(
      statePath,
      new TestChannel(),
      async (messages) => {
        histories.push([...messages]);
        return completed("second");
      },
      { buildPrompt: prompt },
    );
    try {
      await withMutedConsole(() => second.startAll());
      await second.accept("test", incoming("snapshot-restart-2"));
      await second.waitForIdle();
      const snapshots = (histories[0] ?? []).filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<prompt-snapshot"),
      );
      assert.equal(snapshots.length, 1);
    } finally {
      await withMutedConsole(() => second.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("bounds per-conversation runtime state and restores evicted snapshots", async () => {
    const dir = makeTempDir("channel-runtime-state-lru-");
    const histories: ModelMessage[][] = [];
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      new TestChannel(),
      async (messages) => {
        histories.push([...messages]);
        return completed("ok");
      },
      {
        maxConversationRuntimeStates: 2,
        buildPrompt: () => ({
          system: "system",
          sections: [],
          snapshots: [runtimeSnapshot("memory")],
        }),
      },
    );
    try {
      await withMutedConsole(() => gateway.startAll());
      for (const conversationId of ["one", "two", "three", "one"]) {
        await gateway.accept(
          "test",
          incoming(`lru-${conversationId}-${histories.length}`, {
            conversationId,
          }),
        );
        await gateway.waitForIdle();
      }

      const runtime = gateway as unknown as {
        promptSnapshots: Map<string, unknown>;
        compactionBreakers: Map<string, unknown>;
      };
      assert.equal(runtime.promptSnapshots.size, 2);
      assert.equal(runtime.compactionBreakers.size, 2);
      const revisited = histories.at(-1) ?? [];
      assert.equal(
        revisited.filter(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("<prompt-snapshot"),
        ).length,
        1,
      );
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("retries gateway summarization after the breaker fallback", async () => {
    const dir = makeTempDir("channel-summary-breaker-recovery-");
    let attempts = 0;
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      new TestChannel(),
      async () => completed("x".repeat(80)),
      {
        contextWindowTokens: 200,
        autoCompactThresholdTokens: 1,
        summarizeContext: async (messages) => {
          attempts++;
          if (attempts <= 3) throw new Error("temporary summary failure");
          return {
            messages: [
              { role: "user", content: "[recovered summary]" },
              ...messages.slice(-2),
            ],
            summary: "recovered summary",
            compressedCount: Math.max(0, messages.length - 2),
          };
        },
      },
    );
    try {
      await withMutedConsole(() => gateway.startAll());
      for (let index = 0; index < 4; index++) {
        await gateway.accept("test", incoming(`breaker-${index}`));
        await gateway.waitForIdle();
      }
      assert.equal(attempts, 4);
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("does not permanently block a conversation after context overflow", async () => {
    const dir = makeTempDir("channel-context-overflow-");
    const channel = new TestChannel();
    let modelRuns = 0;
    const gateway = createGateway(
      join(dir, "state.sqlite"),
      channel,
      async () => {
        modelRuns++;
        if (modelRuns === 1) {
          throw new Error("context_length_exceeded: maximum context window");
        }
        return completed("recovered on later turn");
      },
      { contextWindowTokens: 100, autoCompactThresholdTokens: 50 },
    );
    try {
      await withMutedConsole(() => gateway.startAll());
      await gateway.accept("test", incoming("overflow-1"));
      await gateway.waitForIdle();
      await gateway.accept("test", incoming("overflow-2"));
      await gateway.waitForIdle();

      assert.equal(modelRuns, 2);
      assert.equal(channel.sent.length, 2);
      assert.equal(channel.sent[1]?.text, "recovered on later turn");
      assert.deepEqual(gateway.list()[0]?.queues, {
        pendingTurns: 0,
        failedTurns: 0,
        pendingDeliveries: 0,
        failedDeliveries: 0,
        unknownDeliveries: 0,
      });
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });

  it("recovers a production stream overflow after persisting the completed tool step", async () => {
    const dir = makeTempDir("channel-stream-overflow-");
    const statePath = join(dir, "state.sqlite");
    const channel = new TestChannel();
    const registry = new ToolRegistry();
    let toolExecutions = 0;
    registry.register({
      name: "mutate_once",
      description: "records one external mutation",
      parameters: { type: "object", properties: {} },
      isReadOnly: false,
      execute: async () => {
        toolExecutions++;
        return "mutation-complete";
      },
    });

    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++;
        if (modelCalls === 1) {
          return toolCallStreamForGateway("mutation-1", "mutate_once");
        }
        if (modelCalls === 2) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "error" as const,
                  error: Object.assign(
                    new Error(
                      "context_length_exceeded: maximum context window",
                    ),
                    { code: "context_length_exceeded" },
                  ),
                },
              ],
            }),
          };
        }
        assert.match(JSON.stringify(options.prompt), /mutation-complete/);
        return textStreamForGateway("recovered without rerunning tool");
      },
    });
    const gateway = new ChannelGateway({
      model,
      registry,
      createRunContext: () =>
        createTestRunContext(registry, { requestApproval: async () => true }),
      buildPrompt: () => ({ system: "system", snapshots: [], sections: [] }),
      statePath,
      contextWindowTokens: 10_000,
      autoCompactThresholdTokens: 9_000,
      summarizeContext: async (messages) => ({
        messages,
        summary: "",
        compressedCount: 0,
      }),
    });
    gateway.register(channel);

    try {
      await withMutedConsole(() => gateway.startAll());
      await gateway.accept("test", incoming("production-overflow"));
      await gateway.waitForIdle();

      assert.equal(modelCalls, 3);
      assert.equal(toolExecutions, 1);
      assert.equal(channel.sent[0]?.text, "recovered without rerunning tool");
      assert.deepEqual(gateway.list()[0]?.queues, {
        pendingTurns: 0,
        failedTurns: 0,
        pendingDeliveries: 0,
        failedDeliveries: 0,
        unknownDeliveries: 0,
      });

      const db = new Database(statePath);
      const rows = db
        .prepare(
          "SELECT message_json FROM channel_session_messages ORDER BY sequence",
        )
        .all() as Array<{ message_json: string }>;
      db.close();
      assert.match(
        rows.map((row) => row.message_json).join("\n"),
        /mutation-complete/,
      );

      await gateway.accept("test", incoming("after-production-overflow"));
      await gateway.waitForIdle();
      assert.equal(modelCalls, 4);
      assert.equal(toolExecutions, 1);
      assert.equal(channel.sent.length, 2);
    } finally {
      await withMutedConsole(() => gateway.stopAll());
      cleanupTempDir(dir);
    }
  });
});

function toolCallStreamForGateway(toolCallId: string, toolName: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "tool-call" as const, toolCallId, toolName, input: "{}" },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
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
}

function textStreamForGateway(text: string) {
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
}
