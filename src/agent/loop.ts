import {
  type LanguageModel,
  type LanguageModelResponseMetadata,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
} from "ai";
import type { RequestApproval } from "../security/permissions.js";
import type { ToolRegistry, ToolSelection } from "../tools/registry.js";
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
import { createAgentRunContext } from "./run-context.js";

const MAX_STEPS = 50;
const MAX_RETRIES = 3;

export interface AgentLoopOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  messages: ModelMessage[];
  system: string;
  workingDir: string;
  tracker?: UsageTracker;
  onStepUsage?: (
    usage: StepUsage,
    responseMessages: ModelMessage[],
    needsFollowUp: boolean,
  ) => void | Promise<void>;
  trace?: LocalTraceRecorder;
  eventSink?: AgentEventSink;
  maxSteps?: number;
  maxRetries?: number;
  requestApproval?: RequestApproval;
  toolSelection?: ToolSelection;
  abortSignal?: AbortSignal;
  forceFinalStep?: boolean;
}

const EMPTY_USAGE: StepUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export async function agentLoop({
  model,
  registry,
  messages,
  system,
  workingDir,
  tracker,
  onStepUsage,
  trace,
  eventSink,
  maxSteps = MAX_STEPS,
  maxRetries = MAX_RETRIES,
  requestApproval,
  toolSelection,
  abortSignal,
  forceFinalStep = false,
}: AgentLoopOptions): Promise<AgentLoopResult> {
  let step = 0;
  let toolCalls = 0;
  let retries = 0;
  let finalText = "";
  let termination: AgentLoopTermination | undefined;
  const totalUsage = { ...EMPTY_USAGE };
  const appendedMessages: ModelMessage[] = [];
  const loopDetector = new ToolLoopDetector();
  const runContext = createAgentRunContext(workingDir);
  const toolExecutionContext = requestApproval
    ? { ...runContext, requestApproval }
    : runContext;

  const emit = async (event: Parameters<AgentEventSink>[0]) => {
    await eventSink?.(event);
  };

  await emit({ type: "run_started", maxSteps });

  try {
    while (step < maxSteps) {
      step++;
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

      for (let attempt = 1; ; attempt++) {
        try {
          const result = streamText({
            model,
            system,
            tools: registry.toAISDKFormat(toolExecutionContext, toolSelection),
            toolChoice: isLastStep ? "none" : "auto",
            messages,
            maxRetries: 0,
            ...(abortSignal ? { abortSignal } : {}),
            providerOptions: { openai: { parallelToolCalls: true } },
            onError: () => {},
          });

          for await (const part of result.stream) {
            switch (part.type) {
              case "text-delta":
                await emit({ type: "text_delta", step, text: part.text });
                fullText += part.text;
                break;

              case "tool-call": {
                hasToolCall = true;
                toolCalls++;
                await emit({
                  type: "tool_started",
                  step,
                  tool: part.toolName,
                  input: part.input,
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
                  output,
                });
                break;
              }

              case "tool-error":
                await emit({
                  type: "tool_failed",
                  step,
                  tool: part.toolName,
                  error: part.error,
                });
                break;
            }
          }

          const finalStep = await result.finalStep;
          stepResponse = finalStep.response;
          stepUsage = await result.usage;
          break;
        } catch (error) {
          await trace?.recordAttemptError(step, attempt, error);
          if (attempt > maxRetries || !isRetryable(error as Error)) throw error;
          const delay = calculateDelay(attempt);
          retries++;
          await emit({
            type: "retry_scheduled",
            step,
            attempt,
            maxRetries,
            delayMs: delay,
            error,
          });
          await sleep(delay);
          hasToolCall = false;
          fullText = "";
          shouldBreak = false;
        }
      }
      if (shouldBreak) {
        finalText = fullText;
        termination = "loop_detected";
        break;
      }

      if (!stepResponse || !stepUsage) {
        throw new Error(
          "Model step completed without response metadata or usage",
        );
      }

      const responseMessages = stepResponse.messages;
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
        text: fullText,
        outputMessages: responseMessages,
        usage: norm,
      });
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
  };
  await emit({ type: "run_finished", result });
  return result;
}

export type {
  AgentEvent,
  AgentEventSink,
  AgentLoopResult,
  AgentLoopStats,
  AgentLoopTermination,
} from "./events.js";
