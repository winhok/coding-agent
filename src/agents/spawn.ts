import { type LanguageModel, type ModelMessage, streamText } from "ai";
import type { RequestApproval } from "../security/permissions.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SubAgentRegistry } from "./registry.js";
import type { SpawnRequest } from "./types.js";

export interface SpawnContext {
  model: LanguageModel;
  registry: ToolRegistry;
  agentRegistry: SubAgentRegistry;
  buildSystem: () => string;
  currentDepth: number;
  requestApproval?: RequestApproval;
}

const MAX_STEPS = 30;
const EXCLUDED_TOOLS = new Set(["spawn_agent"]);

const AGENT_COLORS = [
  "\x1b[36m",
  "\x1b[33m",
  "\x1b[35m",
  "\x1b[32m",
  "\x1b[34m",
];
const RESET = "\x1b[0m";

function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[index % AGENT_COLORS.length] ?? "";
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}

function extractLastAssistantText(messages: ModelMessage[]): string {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!lastAssistant) return "";
  if (typeof lastAssistant.content === "string") return lastAssistant.content;
  if (!Array.isArray(lastAssistant.content)) return "";
  return lastAssistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!ok) return `[spawn] 拒绝: ${reason}`;

  const runId = ctx.agentRegistry.generateId();
  const tag = agentTag(index, runId);
  const messages: ModelMessage[] = [{ role: "user", content: request.task }];
  ctx.agentRegistry.register({
    id: runId,
    task: request.task,
    status: "running",
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  });

  const timeout =
    request.timeout || ctx.agentRegistry.getConfig().defaultTimeout;
  const controller = new AbortController();
  console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`);

  try {
    const system = `${ctx.buildSystem()}\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。`;
    const tools = ctx.registry.toAISDKFormatUnlocked(
      EXCLUDED_TOOLS,
      ctx.requestApproval
        ? { requestApproval: ctx.requestApproval }
        : undefined,
    );
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      let step = 0;
      while (step < MAX_STEPS) {
        step++;
        const isLastStep = step === MAX_STEPS;
        console.log(
          `  ${tag} Step ${step}/${MAX_STEPS}${isLastStep ? " (总结)" : ""}`,
        );
        if (isLastStep) {
          messages.push({
            role: "user",
            content:
              "你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。",
          });
        }

        const result = streamText({
          model: ctx.model,
          system,
          tools,
          toolChoice: isLastStep ? "none" : "auto",
          messages,
          maxRetries: 0,
          abortSignal: controller.signal,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        });
        let hasToolCall = false;
        for await (const part of result.stream) {
          if (part.type === "tool-call") {
            hasToolCall = true;
            const argsPreview = JSON.stringify(part.input).slice(0, 80);
            console.log(`  ${tag} 调用 ${part.toolName}(${argsPreview})`);
          }
        }

        const finalStep = await result.finalStep;
        messages.push(...finalStep.response.messages);
        if (!hasToolCall) break;
      }
    } finally {
      clearTimeout(timer);
    }

    const output = extractLastAssistantText(messages) || "(无输出)";
    ctx.agentRegistry.complete(runId, output);
    console.log(`  ${tag} 完成 ✓ (${output.length} 字符)`);
    return output;
  } catch (error) {
    const isAbort =
      (error instanceof Error && error.name === "AbortError") ||
      controller.signal.aborted;
    const errorMessage = isAbort
      ? `执行超时 (${timeout / 1000}s)`
      : error instanceof Error
        ? error.message
        : String(error);
    ctx.agentRegistry.fail(runId, errorMessage, isAbort);
    console.log(`  ${tag} ${isAbort ? "超时" : "失败"} ✗: ${errorMessage}`);

    if (isAbort) {
      const partial = extractLastAssistantText(messages);
      if (partial) return `[部分结果] ${partial}`;
    }
    return `[sub-agent 执行失败] ${errorMessage}`;
  }
}

export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
  const maxConcurrent = ctx.agentRegistry.getConfig().maxConcurrent;
  const available = maxConcurrent - ctx.agentRegistry.getActiveRuns().length;
  if (available <= 0) {
    return requests.map((request) => ({
      task: request.task,
      result: `[spawn] 拒绝: 已达最大并发数 ${maxConcurrent}`,
    }));
  }

  const toRun = requests.slice(0, available);
  const rejected = requests.slice(available);
  if (rejected.length > 0) {
    console.log(
      `  ⚠ 请求 ${requests.length} 个子 Agent，但最大并发为 ${maxConcurrent}，只执行前 ${toRun.length} 个`,
    );
  }
  console.log(`\n  ┌─ 派发 ${toRun.length} 个子 Agent 并行执行 ─┐`);
  const results = await Promise.all(
    toRun.map(async (request, index) => ({
      task: request.task,
      result: await spawnAgent(request, ctx, index),
    })),
  );
  for (const request of rejected) {
    results.push({
      task: request.task,
      result: `[spawn] 拒绝: 超出最大并发数 ${maxConcurrent}，本次未执行`,
    });
  }
  console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
  return results;
}
