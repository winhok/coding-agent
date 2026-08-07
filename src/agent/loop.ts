import {
  type LanguageModel,
  type LanguageModelResponseMetadata,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
} from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import {
  normalizeUsage,
  type StepUsage,
  type UsageTracker,
} from "../usage/tracker.js";
import { detect, recordCall, resetHistory } from "./loop-detection.js";
import { calculateDelay, isRetryable, sleep } from "./retry.js";

const MAX_STEPS = 50;
const MAX_RETRIES = 3;

export async function agentLoop(
  model: LanguageModel,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker?: UsageTracker,
  onStepUsage?: (
    usage: StepUsage,
    responseMessages: ModelMessage[],
    needsFollowUp: boolean,
  ) => void | Promise<void>,
) {
  let step = 0;
  const appendedMessages: ModelMessage[] = [];
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

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
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        });

        for await (const part of result.stream) {
          switch (part.type) {
            case "text-delta":
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case "tool-call": {
              hasToolCall = true;
              console.log(
                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
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
              recordCall(part.toolName, part.input);
              break;
            }

            case "tool-result": {
              const output =
                typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output);
              const preview =
                part.toolName === "spawn_agent" || output.length <= 120
                  ? output
                  : `${output.slice(0, 120)}...`;
              console.log(`  [结果: ${part.toolName}] ${preview}`);
              break;
            }
          }
        }

        const finalStep = await result.finalStep;
        stepResponse = finalStep.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`,
        );
        await sleep(delay);
        hasToolCall = false;
        fullText = "";
        shouldBreak = false;
      }
    }
    if (shouldBreak) {
      console.log("\n[循环检测触发，Agent 已停止]");
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
    const stepRecord = tracker?.record(modelId, norm);
    await onStepUsage?.(norm, responseMessages, hasToolCall);

    if (
      stepRecord &&
      (stepRecord.cacheReadTokens > 0 || stepRecord.cacheWriteTokens > 0)
    ) {
      const isHit = stepRecord.cacheReadTokens > 0;
      const tag = isHit
        ? "\x1b[38;5;36m✓ cache hit\x1b[0m"
        : "\x1b[38;5;220m✎ cache write\x1b[0m";
      const detail = isHit
        ? `read ${stepRecord.cacheReadTokens}`
        : `write ${stepRecord.cacheWriteTokens}`;
      const currency = stepRecord.currency === "CNY" ? "¥" : "$";
      console.log(
        `  [${tag}] ${detail} tokens · 本步 ${currency}${stepRecord.cost.toFixed(5)}`,
      );
    }
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("  → 继续下一步...");
  }
  if (step >= MAX_STEPS) {
    console.log("\n[达到最大步数]");
  }
  return appendedMessages;
}
