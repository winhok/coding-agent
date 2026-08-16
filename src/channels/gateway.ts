import type { LanguageModel, ModelMessage } from "ai";
import { type AgentLoopResult, agentLoop } from "../agent/loop.js";
import type { AgentRunContext } from "../agent/run-context.js";
import { terminalAgentEventSink } from "../agent/terminal-event-sink.js";
import {
  CompactionCircuitBreaker,
  type CompactionResult,
  microcompact,
  pruneOldestContext,
  summarize,
} from "../context/compressor.js";
import { applyDefense, estimateMessageTokens } from "../context/defense.js";
import {
  type PromptAssembly,
  PromptSnapshotState,
  renderPromptSnapshot,
} from "../context/prompt-builder.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  type AcceptIngressResult,
  type ChannelQueueStats,
  ChannelStore,
  type ConversationContext,
  type OutboxEntry,
} from "./store.js";
import {
  type ChannelDefinition,
  ChannelSendError,
  type ChannelStatus,
  type IncomingMessage,
} from "./types.js";

interface RunChannelTurnOptions {
  messages: ModelMessage[];
  runContext: AgentRunContext;
  system: string;
}

interface GatewayOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  createRunContext: () => AgentRunContext;
  buildPrompt: (runContext: AgentRunContext) => PromptAssembly;
  statePath?: string;
  store?: ChannelStore;
  runTurn?: (options: RunChannelTurnOptions) => Promise<AgentLoopResult>;
  contextWindowTokens?: number;
  autoCompactThresholdTokens?: number;
  summarizeContext?: (
    messages: ModelMessage[],
    existingSummary?: string,
  ) => Promise<CompactionResult>;
  maxConversationRuntimeStates?: number;
}

export interface ChannelInfo {
  name: string;
  description: string;
  accountId: string;
  status: ChannelStatus;
  queues: ChannelQueueStats;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 950_000;
const DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS = 200_000;
const DEFAULT_MAX_CONVERSATION_RUNTIME_STATES = 256;
const CONTEXT_OVERFLOW_REPLY =
  "当前会话上下文仍然过大，已完成安全压缩但无法处理这条消息。请缩短单条消息，或开始一个新的话题后重试。";

export function createChannelGatewayForMode(
  mode: "interactive" | "ask" | "plan",
  create: () => ChannelGateway,
): ChannelGateway | undefined {
  return mode === "interactive" ? create() : undefined;
}

/** Durable channel admission, per-conversation execution, and delivery runtime. */
export class ChannelGateway {
  private readonly channels = new Map<string, ChannelDefinition>();
  private readonly statuses = new Map<string, ChannelStatus>();
  private readonly drains = new Map<string, Promise<void>>();
  private readonly deliveryDrains = new Map<string, Promise<void>>();
  private readonly promptSnapshots = new Map<string, PromptSnapshotState>();
  private readonly compactionBreakers = new Map<
    string,
    CompactionCircuitBreaker
  >();
  private readonly options: GatewayOptions;
  private readonly store: ChannelStore;
  private stopping = false;

  constructor(options: GatewayOptions) {
    this.options = options;
    this.store = options.store ?? new ChannelStore(options.statePath);
  }

  register(channel: ChannelDefinition): void {
    if (this.channels.has(channel.name)) {
      throw new Error(`Channel ${channel.name} is already registered`);
    }
    this.channels.set(channel.name, channel);
    this.statuses.set(channel.name, { state: "registered" });

    channel.onMessage?.(async (msg) => {
      try {
        await this.accept(channel.name, msg);
      } catch (error) {
        console.error(
          `  [${channel.name}] 接收消息失败: ${errorMessage(error)}`,
        );
        throw error;
      }
    });
  }

  async startAll(): Promise<void> {
    this.stopping = false;
    for (const [name, channel] of this.channels) {
      this.statuses.set(name, { state: "starting" });
      try {
        await channel.start();
        this.statuses.set(name, { state: "running" });
        console.log(`  [gateway] ✓ ${name} 已启动`);
        this.scheduleOutbox(name);
      } catch (error) {
        const message = errorMessage(error);
        this.statuses.set(name, { state: "failed", error: message });
        console.error(`  [gateway] ✗ ${name} 启动失败: ${message}`);
      }
    }
    for (const conversationKey of this.store.listPendingConversationKeys()) {
      if (this.canDrainConversation(conversationKey)) {
        this.scheduleConversation(conversationKey);
      }
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await this.waitForIdle();
    const failures: Error[] = [];
    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
        this.statuses.set(name, { state: "stopped" });
      } catch (error) {
        const message = errorMessage(error);
        this.statuses.set(name, { state: "failed", error: message });
        failures.push(new Error(`${name}: ${message}`, { cause: error }));
      }
    }
    this.store.close();
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more channels failed to stop");
    }
  }

  /** Durable admission returns after the turn queue owns recovery. */
  async accept(
    channelName: string,
    message: IncomingMessage,
  ): Promise<AcceptIngressResult> {
    const channel = this.channels.get(channelName);
    if (!channel) throw new Error(`Unknown channel: ${channelName}`);
    if (message.accountId !== channel.accountId) {
      throw new Error(
        `Channel account mismatch: expected ${channel.accountId}, received ${message.accountId}`,
      );
    }
    if (!message.transportEventId.trim()) {
      throw new Error("Channel message is missing transportEventId");
    }
    if (!message.conversationId.trim()) {
      throw new Error("Channel message is missing conversationId");
    }
    const authorization = await channel.authorize?.(message);
    if (authorization && !authorization.allowed) {
      throw new Error(`Channel message denied: ${authorization.reason}`);
    }

    const accepted = this.store.acceptIngress(channelName, message);
    if (accepted.accepted) {
      console.log(
        `\n  [${channelName}] ${message.senderName}: ${message.text}`,
      );
      if (this.canDrainConversation(accepted.conversationKey)) {
        this.scheduleConversation(accepted.conversationKey);
      }
    }
    return accepted;
  }

  private scheduleConversation(conversationKey: string): void {
    if (this.stopping || this.drains.has(conversationKey)) return;
    const task = this.drainConversation(conversationKey)
      .catch((error) => {
        console.error(`  [gateway] 会话处理失败: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.drains.delete(conversationKey);
        if (!this.stopping) {
          // Close the accept-vs-finally race: a message may have been durably
          // admitted after the loop observed an empty queue.
          if (this.canDrainConversation(conversationKey)) {
            this.scheduleConversation(conversationKey);
          }
        }
      });
    this.drains.set(conversationKey, task);
  }

  private canDrainConversation(conversationKey: string): boolean {
    const channelName =
      this.store.pendingChannelForConversation(conversationKey);
    return (
      channelName !== undefined &&
      !this.store.hasFailedTurn(conversationKey) &&
      this.statuses.get(channelName)?.state === "running"
    );
  }

  private async drainConversation(conversationKey: string): Promise<void> {
    while (!this.stopping) {
      const turn = this.store.claimNextTurn(conversationKey);
      if (!turn) return;
      const channel = this.channels.get(turn.channelName);
      if (
        !channel ||
        this.statuses.get(turn.channelName)?.state !== "running"
      ) {
        this.store.releaseTurn(turn.id);
        return;
      }

      try {
        const runContext = this.options.createRunContext();
        const prompt = this.options.buildPrompt(runContext);
        const snapshotState = this.getPromptSnapshotState(
          turn.conversationKey,
          this.store.loadConversationContext(turn.conversationKey).messages,
        );
        const snapshotMessages = snapshotState
          .selectUpdates(prompt.snapshots)
          .map(renderPromptSnapshot);
        const userMessage: ModelMessage = {
          role: "user",
          content: turn.message.text,
        };
        const inputMessages = [...snapshotMessages, userMessage];
        this.store.appendTurnMessages(
          turn.conversationKey,
          turn.id,
          inputMessages,
          0,
        );
        let context = await this.prepareConversationContext(
          turn.conversationKey,
          false,
        );
        const system = prompt.system;
        let uncommittedToolActivity = false;
        let nextTurnPosition = inputMessages.length;
        const committedMessages = new Set<ModelMessage>();
        const commitStepMessages = (messages: ModelMessage[]) => {
          this.store.appendTurnMessages(
            turn.conversationKey,
            turn.id,
            messages,
            nextTurnPosition,
          );
          nextTurnPosition += messages.length;
          for (const message of messages) committedMessages.add(message);
          uncommittedToolActivity = false;
        };
        let result: AgentLoopResult;
        try {
          result = await this.runTurn(
            { messages: context.messages, runContext, system },
            () => {
              uncommittedToolActivity = true;
            },
            commitStepMessages,
          );
        } catch (error) {
          if (!isContextOverflowError(error)) throw error;

          context = await this.prepareConversationContext(
            turn.conversationKey,
            true,
          );
          const retrySafe = !this.options.runTurn && !uncommittedToolActivity;
          if (retrySafe) {
            try {
              result = await this.runTurn(
                { messages: context.messages, runContext, system },
                () => {
                  uncommittedToolActivity = true;
                },
                commitStepMessages,
              );
            } catch (retryError) {
              if (!isContextOverflowError(retryError)) throw retryError;
              const assistant: ModelMessage = {
                role: "assistant",
                content: CONTEXT_OVERFLOW_REPLY,
              };
              const outbox = this.store.completeTurnWithOutbox(
                turn,
                [assistant],
                CONTEXT_OVERFLOW_REPLY,
                nextTurnPosition,
              );
              if (outbox) this.scheduleDelivery(outbox);
              continue;
            }
          } else {
            const assistant: ModelMessage = {
              role: "assistant",
              content: CONTEXT_OVERFLOW_REPLY,
            };
            const outbox = this.store.completeTurnWithOutbox(
              turn,
              [assistant],
              CONTEXT_OVERFLOW_REPLY,
              nextTurnPosition,
            );
            if (outbox) this.scheduleDelivery(outbox);
            continue;
          }
        }
        const outbox = this.store.completeTurnWithOutbox(
          turn,
          result.appendedMessages.filter(
            (message) => !committedMessages.has(message),
          ),
          result.text,
          nextTurnPosition,
        );
        if (outbox) this.scheduleDelivery(outbox);
      } catch (error) {
        this.store.failTurn(turn.id, error);
        throw error;
      }
    }
  }

  private async prepareConversationContext(
    conversationKey: string,
    force: boolean,
  ): Promise<ConversationContext> {
    const loaded = this.store.loadConversationContext(conversationKey);
    const originalMessagesJson = JSON.stringify(loaded.messages);
    const originalSummary = loaded.summary;
    const contextWindowTokens =
      this.options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const compactThresholdTokens =
      this.options.autoCompactThresholdTokens ??
      DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS;
    const breaker = this.getCompactionBreaker(conversationKey);

    const defense = applyDefense(
      loaded.messages,
      loaded.timestamps,
      contextWindowTokens,
    );
    let messages = microcompact(defense.messages).messages;
    let timestamps = new Map(loaded.timestamps);
    let summary = loaded.summary;
    let tokenEstimate = estimateMessageTokens(messages);

    if ((force || tokenEstimate > compactThresholdTokens) && !breaker.isOpen) {
      try {
        const compacted = this.options.summarizeContext
          ? await this.options.summarizeContext(messages, summary)
          : await summarize(this.options.model, messages, summary, {
              thresholdTokens: Math.max(
                1,
                Math.floor(compactThresholdTokens * 0.8),
              ),
            });
        if (
          compacted.compressedCount > 0 &&
          estimateMessageTokens(compacted.messages) < tokenEstimate
        ) {
          timestamps = timestampsForCompactedSuffix(
            timestamps,
            messages.length,
            compacted.messages.length,
          );
          messages = compacted.messages;
          summary = compacted.summary;
          tokenEstimate = estimateMessageTokens(messages);
          breaker.recordSuccess();
        }
      } catch (error) {
        breaker.recordFailure();
        console.error(
          `  [gateway] 上下文摘要失败，将保留防护后的投影: ${errorMessage(error)}`,
        );
      }
    }

    const recoverBreaker = breaker.isOpen;
    if ((recoverBreaker || force) && tokenEstimate > compactThresholdTokens) {
      const fallback = pruneOldestContext(
        messages,
        Math.max(
          1,
          Math.min(
            compactThresholdTokens,
            Math.floor(contextWindowTokens * 0.5),
          ),
        ),
        summary,
      );
      timestamps = timestampsForCompactedSuffix(
        timestamps,
        messages.length,
        fallback.messages.length,
      );
      messages = fallback.messages;
      summary = fallback.summary;
      if (recoverBreaker) {
        breaker.recordSuccess();
        console.error(
          fallback.compressedCount > 0
            ? `  [gateway] 连续摘要失败 3 次，已确定性移除 ${fallback.compressedCount} 条旧消息；后续请求将重试摘要`
            : "  [gateway] 连续摘要失败 3 次，但没有可安全裁剪的旧轮次；后续请求仍将重试摘要",
        );
      }
    }

    const context: ConversationContext = {
      messages,
      timestamps,
      sourceSequence: loaded.sourceSequence,
      ...(summary ? { summary } : {}),
    };
    if (
      JSON.stringify(messages) !== originalMessagesJson ||
      summary !== originalSummary
    ) {
      this.store.saveContextProjection(conversationKey, context);
      this.promptSnapshots.get(conversationKey)?.restore(messages);
    }
    return context;
  }

  private getPromptSnapshotState(
    conversationKey: string,
    messages: readonly ModelMessage[],
  ): PromptSnapshotState {
    let state = this.promptSnapshots.get(conversationKey);
    if (!state) {
      state = new PromptSnapshotState();
      state.restore(messages);
    }
    this.touchRuntimeState(this.promptSnapshots, conversationKey, state);
    return state;
  }

  private getCompactionBreaker(
    conversationKey: string,
  ): CompactionCircuitBreaker {
    let breaker = this.compactionBreakers.get(conversationKey);
    if (!breaker) {
      breaker = new CompactionCircuitBreaker();
    }
    this.touchRuntimeState(this.compactionBreakers, conversationKey, breaker);
    return breaker;
  }

  private touchRuntimeState<T>(
    states: Map<string, T>,
    conversationKey: string,
    state: T,
  ): void {
    states.delete(conversationKey);
    states.set(conversationKey, state);
    const capacity =
      this.options.maxConversationRuntimeStates ??
      DEFAULT_MAX_CONVERSATION_RUNTIME_STATES;
    while (states.size > capacity) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  }

  private runTurn(
    options: RunChannelTurnOptions,
    onToolActivity: () => void,
    onStepCompleted: (messages: ModelMessage[]) => void,
  ): Promise<AgentLoopResult> {
    if (this.options.runTurn) return this.options.runTurn(options);
    return agentLoop({
      model: this.options.model,
      registry: this.options.registry,
      messages: options.messages,
      system: options.system,
      runContext: options.runContext,
      onStepCompleted,
      eventSink: async (event) => {
        if (event.type === "tool_started") onToolActivity();
        await terminalAgentEventSink(event);
      },
    });
  }

  private scheduleOutbox(channelName: string): void {
    for (const conversationKey of this.store.listOutboxConversationKeys(
      channelName,
    )) {
      this.scheduleDeliveryConversation(conversationKey);
    }
  }

  private scheduleDelivery(entry: OutboxEntry): void {
    this.scheduleDeliveryConversation(entry.conversationKey);
  }

  private scheduleDeliveryConversation(conversationKey: string): void {
    if (this.stopping || this.deliveryDrains.has(conversationKey)) return;
    let observedEmpty = false;
    const task = this.drainDeliveries(conversationKey)
      .then((value) => {
        observedEmpty = value;
      })
      .catch((error) => {
        console.error(`  [gateway] 发送队列失败: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.deliveryDrains.delete(conversationKey);
        if (
          !this.stopping &&
          observedEmpty &&
          this.store.nextDeliverableOutbox(conversationKey)
        ) {
          this.scheduleDeliveryConversation(conversationKey);
        }
      });
    this.deliveryDrains.set(conversationKey, task);
  }

  private async drainDeliveries(conversationKey: string): Promise<boolean> {
    while (!this.stopping) {
      const entry = this.store.nextDeliverableOutbox(conversationKey);
      if (!entry) return true;
      try {
        await this.deliver(entry);
      } catch (error) {
        console.error(
          `  [${entry.channelName}] 发送失败: ${errorMessage(error)}`,
        );
        return false;
      }
    }
    return false;
  }

  private async deliver(entry: OutboxEntry): Promise<void> {
    const claimed = this.store.claimOutbox(entry.id);
    if (!claimed) return;
    const channel = this.channels.get(claimed.channelName);
    if (
      !channel ||
      this.statuses.get(claimed.channelName)?.state !== "running"
    ) {
      const error = new ChannelSendError("channel is not running", "not_sent");
      this.store.failOutbox(claimed.id, "failed", error);
      throw error;
    }
    try {
      const receipt = await channel.send(claimed.message);
      const platformMessageId = receipt.platformMessageId.trim();
      if (!platformMessageId) {
        throw new ChannelSendError(
          `${claimed.channelName} returned an empty platform message id`,
          "unknown",
        );
      }
      this.store.completeOutbox(claimed.id, platformMessageId);
      console.log(
        `  [${claimed.channelName}] → ${claimed.message.text.slice(0, 80)}${claimed.message.text.length > 80 ? "..." : ""}`,
      );
    } catch (error) {
      const status =
        error instanceof ChannelSendError && error.certainty === "not_sent"
          ? "failed"
          : "unknown";
      this.store.failOutbox(claimed.id, status, error);
      throw error;
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.drains.size > 0 || this.deliveryDrains.size > 0) {
      await Promise.allSettled([
        ...this.drains.values(),
        ...this.deliveryDrains.values(),
      ]);
    }
  }

  list(): ChannelInfo[] {
    return Array.from(this.channels.values()).map((channel) => ({
      name: channel.name,
      description: channel.description,
      accountId: channel.accountId,
      status: this.statuses.get(channel.name) ?? { state: "registered" },
      queues: this.store.getChannelStats(channel.name),
    }));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampsForCompactedSuffix(
  before: Map<number, number>,
  beforeLength: number,
  afterLength: number,
): Map<number, number> {
  const result = new Map<number, number>([[0, Date.now()]]);
  const keptCount = Math.max(0, afterLength - 1);
  const keptFrom = Math.max(0, beforeLength - keptCount);
  for (let index = 0; index < keptCount; index++) {
    result.set(index + 1, before.get(keptFrom + index) ?? Date.now());
  }
  return result;
}

function isContextOverflowError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value == null || seen.has(value)) return false;
    if (typeof value === "object" || typeof value === "function") {
      seen.add(value);
    }
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    const text = [
      value instanceof Error ? value.message : String(value),
      typeof record?.responseBody === "string" ? record.responseBody : "",
      typeof record?.code === "string" ? record.code : "",
      typeof record?.type === "string" ? record.type : "",
    ]
      .join(" ")
      .toLowerCase();
    if (
      record?.statusCode === 413 ||
      /context[_ -]?(length|window).*(exceed|overflow|limit|maximum)|prompt.*too.*long|too many tokens|maximum context|context_length_exceeded/.test(
        text,
      )
    ) {
      return true;
    }
    if (record) {
      if (
        visit(record.cause) ||
        visit(record.lastError) ||
        visit(record.data)
      ) {
        return true;
      }
      if (Array.isArray(record.errors) && record.errors.some(visit))
        return true;
    }
    return false;
  };
  return visit(error);
}
