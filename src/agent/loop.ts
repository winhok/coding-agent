import {
  type LanguageModel,
  type LanguageModelResponseMetadata,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
} from "ai";
import { InputEffectGate } from "../guardrails/input-gate.js";
import { isReviewable } from "../guardrails/review.js";
import {
  type GuardrailDecision,
  type GuardrailSummary,
  InputTripwireError,
} from "../guardrails/types.js";
import { raceWithAbort } from "../security/abort.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { LocalTraceRecorder } from "../trace/recorder.js";
import {
  normalizeUsage,
  type StepUsage,
  type UsageTracker,
} from "../usage/tracker.js";
import type {
  AgentEventSink,
  AgentLoopResult,
  AgentLoopStats,
  AgentLoopTermination,
} from "./events.js";
import { ToolLoopDetector } from "./loop-detection.js";
import { calculateDelay, isRetryable, sleep } from "./retry.js";
import type { AgentRunContext } from "./run-context.js";

const MAX_STEPS = 50;
const MAX_RETRIES = 3;

export interface AgentLoopOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  messages: ModelMessage[];
  system: string;
  runContext: AgentRunContext;
  tracker?: UsageTracker;
  onStepUsage?: (
    usage: StepUsage,
    responseMessages: ModelMessage[],
    needsFollowUp: boolean,
  ) => void | Promise<void>;
  onStepCompleted?: (messages: ModelMessage[]) => void | Promise<void>;
  trace?: LocalTraceRecorder;
  eventSink?: AgentEventSink;
  maxSteps?: number;
  maxRetries?: number;
  forceFinalStep?: boolean;
  inputGuardrail?: {
    mode: "blocking" | "parallel";
    check: (signal: AbortSignal) => Promise<GuardrailDecision | undefined>;
    cancellationConvergenceTimeoutMs?: number;
  };
  outputGuardrail?: OutputGuardrailOptions;
}

export interface OutputGuardrailOptions {
  check: (
    text: string,
    signal: AbortSignal,
  ) => Promise<GuardrailDecision | undefined>;
  replacement: (decision: GuardrailDecision) => string;
  repair?: (input: {
    candidate: string;
    ruleIds: string[];
    signal: AbortSignal;
  }) => Promise<string>;
  redact?: (value: unknown) => unknown;
  requestReview?: (decision: GuardrailDecision) => {
    token?: string;
    expiresAt: string;
    message: string;
  };
}

const EMPTY_USAGE: StepUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const DEFAULT_CANCELLATION_CONVERGENCE_TIMEOUT_MS = 2_000;

export async function agentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const { inputGuardrail, ...baseOptions } = options;
  if (!inputGuardrail) return runAgentLoopCore(baseOptions);

  const runController = new AbortController();
  const runSignal = AbortSignal.any([
    baseOptions.runContext.signal,
    runController.signal,
  ]);
  const gate = new InputEffectGate();
  const bufferedEvents: Parameters<AgentEventSink>[0][] = [];
  const targetSink = baseOptions.eventSink;
  let released = inputGuardrail.mode === "blocking";
  let releasePromise = Promise.resolve();
  const guardedSink: AgentEventSink = async (event) => {
    if (!released) {
      bufferedEvents.push(event);
      return;
    }
    await releasePromise;
    await targetSink?.(event);
  };
  const runContext: AgentRunContext = {
    ...baseOptions.runContext,
    signal: runSignal,
    inputEffectGate: gate,
  };
  const coreOptions = { ...baseOptions, runContext, eventSink: guardedSink };
  const check = raceWithAbort(
    Promise.resolve().then(() => inputGuardrail.check(runSignal)),
    runSignal,
  ).then((decision) => {
    if (decision?.outcome === "blocked") {
      throw new InputTripwireError(decision);
    }
    return decision;
  });

  if (inputGuardrail.mode === "blocking") {
    const decision = await check;
    gate.pass();
    return withInputSummary(await runAgentLoopCore(coreOptions), decision);
  }

  const core = runAgentLoopCore(coreOptions);
  void core.catch(() => undefined);
  let decision: GuardrailDecision | undefined;
  try {
    decision = await check;
  } catch (error) {
    gate.block(error);
    runController.abort(error);
    bufferedEvents.length = 0;
    const converged = await settlesWithin(
      core,
      inputGuardrail.cancellationConvergenceTimeoutMs ??
        DEFAULT_CANCELLATION_CONVERGENCE_TIMEOUT_MS,
    );
    if (error instanceof InputTripwireError && !converged) {
      throw new InputTripwireError(error.decision, "incomplete");
    }
    throw error;
  }

  releasePromise = flushEvents(bufferedEvents.splice(0), targetSink);
  released = true;
  gate.pass();
  await releasePromise;
  return withInputSummary(await core, decision);
}

async function runAgentLoopCore({
  model,
  registry,
  messages,
  system,
  runContext,
  tracker,
  onStepUsage,
  onStepCompleted,
  trace,
  eventSink,
  maxSteps = MAX_STEPS,
  maxRetries = MAX_RETRIES,
  forceFinalStep = false,
  outputGuardrail,
}: Omit<AgentLoopOptions, "inputGuardrail">): Promise<AgentLoopResult> {
  let step = 0;
  let toolCalls = 0;
  let retries = 0;
  let finalText = "";
  let termination: AgentLoopTermination | undefined;
  const totalUsage = { ...EMPTY_USAGE };
  const appendedMessages: ModelMessage[] = [];
  let outputGuardrailSummary: GuardrailSummary["output"];
  const loopDetector = new ToolLoopDetector();
  const emit = async (event: Parameters<AgentEventSink>[0]) => {
    await eventSink?.(event);
  };

  await emit({ type: "run_started", maxSteps });

  try {
    while (step < maxSteps) {
      step++;
      const stepAppendStart = appendedMessages.length;
      const isLastStep = forceFinalStep && step === maxSteps;
      if (isLastStep) {
        const finalInstruction: ModelMessage = {
          role: "user",
          content:
            "你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。",
        };
        messages.push(finalInstruction);
        appendedMessages.push(finalInstruction);
      }
      await emit({ type: "step_started", step });

      await trace?.recordStepStarted({ step, system, messages });

      let hasToolCall = false;
      let fullText = "";
      let shouldBreak = false;
      let stepResponse: LanguageModelResponseMetadata | undefined;
      let stepUsage: LanguageModelUsage | undefined;
      const bufferedTextEvents: Parameters<AgentEventSink>[0][] = [];

      for (let attempt = 1; ; attempt++) {
        let streamError: unknown;
        try {
          const result = streamText({
            model,
            system,
            tools: registry.toAISDKFormat(runContext),
            toolChoice: isLastStep ? "none" : "auto",
            messages,
            maxRetries: 0,
            abortSignal: runContext.signal,
            providerOptions: { openai: { parallelToolCalls: true } },
            onError: ({ error }) => {
              streamError ??= error;
            },
          });

          for await (const part of result.stream) {
            switch (part.type) {
              case "text-delta":
                if (outputGuardrail) {
                  bufferedTextEvents.push({
                    type: "text_delta",
                    step,
                    text: part.text,
                  });
                } else {
                  await emit({ type: "text_delta", step, text: part.text });
                }
                fullText += part.text;
                break;

              case "tool-call": {
                hasToolCall = true;
                toolCalls++;
                await emit({
                  type: "tool_started",
                  step,
                  tool: part.toolName,
                  input:
                    runContext.toolGuardrail?.redact(part.input) ?? part.input,
                });

                const detection = loopDetector.detect(
                  part.toolName,
                  part.input,
                );
                if (detection.stuck) {
                  await emit({
                    type: "loop_detected",
                    step,
                    level: detection.level,
                    message: detection.message,
                  });
                  if (detection.level === "critical") {
                    shouldBreak = true;
                  } else {
                    const warningMessage: ModelMessage = {
                      role: "user" as const,
                      content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                    };
                    messages.push(warningMessage);
                    appendedMessages.push(warningMessage);
                  }
                }
                loopDetector.recordCall(part.toolName, part.input);
                break;
              }

              case "tool-result": {
                const output =
                  typeof part.output === "string"
                    ? part.output
                    : JSON.stringify(part.output);
                await emit({
                  type: "tool_finished",
                  step,
                  tool: part.toolName,
                  output: String(
                    runContext.toolGuardrail?.redact(output) ?? output,
                  ),
                });
                break;
              }

              case "tool-error":
                await emit({
                  type: "tool_failed",
                  step,
                  tool: part.toolName,
                  error:
                    runContext.toolGuardrail?.redact(
                      part.error instanceof Error
                        ? part.error.message
                        : part.error,
                    ) ?? part.error,
                });
                break;

              case "error":
                streamError = part.error;
                break;
            }
          }

          if (streamError !== undefined) throw streamError;

          const finalStep = await result.finalStep;
          stepResponse = finalStep.response;
          stepUsage = await result.usage;
          break;
        } catch (error) {
          const effectiveError = streamError ?? error;
          await trace?.recordAttemptError(step, attempt, effectiveError);
          if (attempt > maxRetries || !isRetryable(effectiveError)) {
            throw effectiveError;
          }
          const delay = calculateDelay(attempt);
          retries++;
          await emit({
            type: "retry_scheduled",
            step,
            attempt,
            maxRetries,
            delayMs: delay,
            error: effectiveError,
          });
          await sleep(delay);
          hasToolCall = false;
          fullText = "";
          shouldBreak = false;
          bufferedTextEvents.length = 0;
        }
      }
      if (shouldBreak) {
        await runContext.inputEffectGate?.wait(runContext.signal);
        if (outputGuardrail) {
          const guarded = await resolveGuardedOutput(
            fullText,
            [],
            bufferedTextEvents,
            step,
            outputGuardrail,
            runContext.signal,
          );
          fullText = guarded.text;
          outputGuardrailSummary = mergeOutputSummary(
            outputGuardrailSummary,
            guarded.summary,
          );
          await flushEvents(guarded.events, eventSink);
        }
        finalText = fullText;
        termination = "loop_detected";
        break;
      }

      if (!stepResponse || !stepUsage) {
        throw new Error(
          "Model step completed without response metadata or usage",
        );
      }

      await runContext.inputEffectGate?.wait(runContext.signal);

      let responseMessages: ModelMessage[] = runContext.toolGuardrail
        ? (runContext.toolGuardrail.redact(
            stepResponse.messages,
          ) as ModelMessage[])
        : stepResponse.messages;
      if (outputGuardrail) {
        const guarded = await resolveGuardedOutput(
          fullText,
          responseMessages,
          bufferedTextEvents,
          step,
          outputGuardrail,
          runContext.signal,
        );
        fullText = guarded.text;
        responseMessages = guarded.messages;
        outputGuardrailSummary = mergeOutputSummary(
          outputGuardrailSummary,
          guarded.summary,
        );
        bufferedTextEvents.splice(
          0,
          bufferedTextEvents.length,
          ...guarded.events,
        );
      }
      await flushEvents(bufferedTextEvents, eventSink);

      messages.push(...responseMessages);
      appendedMessages.push(...responseMessages);

      const modelId = typeof model === "string" ? model : model.modelId;
      const norm = normalizeUsage(stepUsage);
      totalUsage.inputTokens += norm.inputTokens;
      totalUsage.outputTokens += norm.outputTokens;
      totalUsage.cacheReadTokens += norm.cacheReadTokens;
      totalUsage.cacheWriteTokens += norm.cacheWriteTokens;
      await trace?.recordStepCompleted({
        step,
        text: redactReviewToken(
          fullText,
          outputGuardrailSummary?.review?.token,
        ),
        outputMessages: responseMessages,
        usage: norm,
      });
      await onStepCompleted?.(appendedMessages.slice(stepAppendStart));
      const stepRecord = tracker?.record(modelId, norm);
      await onStepUsage?.(norm, responseMessages, hasToolCall);

      if (
        stepRecord &&
        (stepRecord.cacheReadTokens > 0 || stepRecord.cacheWriteTokens > 0)
      ) {
        await emit({
          type: "cache_usage",
          step,
          cacheReadTokens: stepRecord.cacheReadTokens,
          cacheWriteTokens: stepRecord.cacheWriteTokens,
          cost: stepRecord.cost,
          currency: stepRecord.currency,
        });
      }
      finalText = fullText;
      await emit({ type: "step_finished", step, text: fullText, hasToolCall });
      if (!hasToolCall) {
        termination = "completed";
        break;
      }

      await emit({ type: "step_continuing", step });
    }
    termination ??= "max_steps";
  } catch (error) {
    await emit({ type: "run_failed", error });
    throw error;
  }

  const stats: AgentLoopStats = {
    steps: step,
    toolCalls,
    retries,
    usage: totalUsage,
  };
  const result: AgentLoopResult = {
    appendedMessages,
    text: finalText,
    termination,
    stats,
    ...(outputGuardrailSummary
      ? { guardrails: { output: outputGuardrailSummary } }
      : {}),
  };
  await emit({ type: "run_finished", result });
  return result;
}

async function flushEvents(
  events: Parameters<AgentEventSink>[0][],
  sink: AgentEventSink | undefined,
): Promise<void> {
  for (const event of events) await sink?.(event);
}

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withInputSummary(
  result: AgentLoopResult,
  decision: GuardrailDecision | undefined,
): AgentLoopResult {
  if (!decision) return result;
  const input: NonNullable<GuardrailSummary["input"]> = {
    outcome: decision.outcome,
    policyVersion: decision.policyVersion,
    requestHash: decision.requestHash,
    durationMs: decision.durationMs,
    categories: decision.findings.map((finding) => finding.category),
  };
  return { ...result, guardrails: { ...result.guardrails, input } };
}

function decisionSummary(
  decision: GuardrailDecision,
): NonNullable<GuardrailSummary["output"]> {
  return {
    outcome: decision.outcome,
    policyVersion: decision.policyVersion,
    requestHash: decision.requestHash,
    durationMs: decision.durationMs,
    categories: decision.findings.map((finding) => finding.category),
  };
}

async function resolveGuardedOutput(
  text: string,
  messages: ModelMessage[],
  events: Parameters<AgentEventSink>[0][],
  step: number,
  guardrail: OutputGuardrailOptions,
  signal: AbortSignal,
): Promise<{
  text: string;
  messages: ModelMessage[];
  events: Parameters<AgentEventSink>[0][];
  summary?: NonNullable<GuardrailSummary["output"]>;
}> {
  let decision = await guardrail.check(text, signal);
  if (!decision) return { text, messages, events };
  let summary = decisionSummary(decision);
  if (decision.outcome !== "blocked") {
    return { text, messages, events, summary };
  }

  if (isReviewable(decision) && guardrail.repair) {
    try {
      const redacted = String(guardrail.redact?.(text) ?? text).slice(0, 4_000);
      const repaired = await guardrail.repair({
        candidate: redacted,
        ruleIds: decision.findings.map((finding) => finding.ruleId),
        signal,
      });
      signal.throwIfAborted();
      const repairedDecision = await guardrail.check(repaired, signal);
      if (!repairedDecision || repairedDecision.outcome === "passed") {
        return {
          text: repaired,
          messages: replaceAssistantText(messages, repaired),
          events: [{ type: "text_delta", step, text: repaired }],
          summary: {
            ...(repairedDecision
              ? decisionSummary(repairedDecision)
              : decisionSummary({ ...decision, outcome: "passed" })),
            repair: "passed",
          },
        };
      }
      decision = repairedDecision;
      summary = { ...decisionSummary(decision), repair: "failed" };
    } catch {
      signal.throwIfAborted();
      summary = { ...summary, repair: "failed" };
    }
  }

  const review = isReviewable(decision)
    ? guardrail.requestReview?.(decision)
    : undefined;
  const replacement = review?.message ?? guardrail.replacement(decision);
  const historyReplacement = redactReviewToken(replacement, review?.token);
  return {
    text: replacement,
    messages: replaceAssistantText(messages, historyReplacement),
    events: [{ type: "text_delta", step, text: replacement }],
    summary: {
      ...summary,
      ...(review
        ? {
            review: {
              ...(review.token ? { token: review.token } : {}),
              expiresAt: review.expiresAt,
            },
          }
        : {}),
    },
  };
}

function redactReviewToken(text: string, token: string | undefined): string {
  return token ? text.split(token).join("[REVIEW_TOKEN_ISSUED]") : text;
}

function mergeOutputSummary(
  current: GuardrailSummary["output"],
  next: GuardrailSummary["output"],
): GuardrailSummary["output"] {
  if (!next) return current;
  if (!current) return next;
  if (current.outcome === "blocked") return current;
  return {
    ...next,
    ...(current.repair ? { repair: current.repair } : {}),
    ...(current.review ? { review: current.review } : {}),
  };
}

function replaceAssistantText(
  messages: ModelMessage[],
  replacement: string,
): ModelMessage[] {
  let replaced = false;
  const safeMessages = messages.map((message): ModelMessage => {
    if (message.role !== "assistant") return message;
    replaced = true;
    if (typeof message.content === "string") {
      return { ...message, content: replacement };
    }
    return {
      ...message,
      content: [
        { type: "text", text: replacement },
        ...message.content.filter((part) => part.type !== "text"),
      ],
    };
  });
  return replaced
    ? safeMessages
    : [{ role: "assistant", content: replacement }, ...safeMessages];
}

export type {
  AgentEvent,
  AgentEventSink,
  AgentLoopResult,
  AgentLoopStats,
  AgentLoopTermination,
} from "./events.js";
