import type { LanguageModel, ModelMessage } from "ai";
import { type AgentEvent, agentLoop } from "../agent/loop.js";
import {
  type AgentRunContext,
  deriveAgentRunContext,
} from "../agent/run-context.js";
import type { SkillView } from "../skills/loader.js";
import type { ToolRegistry, ToolView } from "../tools/registry.js";
import { LocalTraceRecorder } from "../trace/recorder.js";
import type { UsageTracker } from "../usage/tracker.js";
import { resolveSubAgentProfile } from "./profiles.js";
import type { SubAgentRegistry } from "./registry.js";
import type { SpawnRequest, SubAgentProfile } from "./types.js";

export interface SpawnContextBase {
  model: LanguageModel;
  registry: ToolRegistry;
  agentRegistry: SubAgentRegistry;
  profiles: Record<string, SubAgentProfile>;
  currentDepth: number;
  tracker?: UsageTracker;
  traceDirectory?: string;
  projectRules?: string;
}

export interface SpawnContext extends SpawnContextBase {
  parentRunContext: AgentRunContext;
}

const MAX_STEPS = 30;

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

function buildSubAgentSystem(
  profileName: string,
  profile: SubAgentProfile,
  toolView: ToolView,
  skillView: SkillView,
  workingDir: string,
  projectRules?: string,
): string {
  const activeTools = toolView
    .getActiveTools()
    .map((tool) => tool.name)
    .join(", ");
  const deferred = toolView.getDeferredToolSummary();
  const skills = toolView.hasSkillCatalogTool()
    ? skillView.buildPromptSection()
    : null;
  return [
    `你是独立执行单个任务的子 Agent，Profile 为 ${profileName}。`,
    profile.systemPrompt,
    "只处理收到的任务；不要假设主 Agent 的对话历史。需要多个独立信息时可并行调用工具。",
    `当前工作目录：${workingDir}`,
    projectRules,
    `当前可见工具：${activeTools || "无"}`,
    deferred,
    skills,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
  parallel = false,
): Promise<string> {
  let resolved: ReturnType<typeof resolveSubAgentProfile>;
  try {
    resolved = resolveSubAgentProfile(request, ctx.profiles, parallel);
  } catch (error) {
    return `[spawn] 拒绝: ${error instanceof Error ? error.message : String(error)}`;
  }

  const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!ok) return `[spawn] 拒绝: ${reason}`;

  const runId = ctx.agentRegistry.generateId();
  const tag = agentTag(index, runId);
  const messages: ModelMessage[] = [{ role: "user", content: request.task }];
  ctx.agentRegistry.register({
    id: runId,
    task: request.task,
    profile: resolved.name,
    status: "running",
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  });

  const timeout =
    request.timeout || ctx.agentRegistry.getConfig().defaultTimeout;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("子 Agent 执行超时", "TimeoutError"));
  }, timeout);
  const signal = AbortSignal.any([
    ctx.parentRunContext.signal,
    controller.signal,
  ]);
  const childToolView = ctx.parentRunContext.toolView.restrict(
    resolved.selection,
  );
  const childRunContext = deriveAgentRunContext(ctx.parentRunContext, {
    runId,
    agentId: runId,
    signal,
    toolView: childToolView,
  });
  let partialText = "";
  let trace: LocalTraceRecorder | undefined;

  const eventSink = (event: AgentEvent): void => {
    switch (event.type) {
      case "step_started":
        partialText = "";
        console.log(`  ${tag} Step ${event.step}/${MAX_STEPS}`);
        break;
      case "text_delta":
        partialText += event.text;
        break;
      case "tool_started":
        console.log(
          `  ${tag} 调用 ${event.tool}(${JSON.stringify(event.input).slice(0, 80)})`,
        );
        break;
      case "loop_detected":
        console.log(`  ${tag} ${event.message}`);
        break;
      case "retry_scheduled":
        console.log(
          `  ${tag} 模型调用重试 ${event.attempt}/${event.maxRetries}`,
        );
        break;
    }
  };

  try {
    trace = await LocalTraceRecorder.start({
      ...(ctx.traceDirectory ? { directory: ctx.traceDirectory } : {}),
      sessionId: runId,
      model: typeof ctx.model === "string" ? ctx.model : ctx.model.modelId,
    });
    ctx.agentRegistry.attachTrace(runId, trace.filePath);
    console.log(
      `  ${tag} 启动 [${resolved.name}${parallel ? ", 并行只读" : ""}]: ${request.task.slice(0, 50)}`,
    );
    const result = await agentLoop({
      model: ctx.model,
      registry: ctx.registry,
      messages,
      system: buildSubAgentSystem(
        resolved.name,
        resolved.profile,
        childRunContext.toolView,
        childRunContext.skillView,
        childRunContext.workingDir,
        ctx.projectRules,
      ),
      runContext: childRunContext,
      ...(ctx.tracker ? { tracker: ctx.tracker } : {}),
      eventSink,
      ...(trace ? { trace } : {}),
      maxSteps: MAX_STEPS,
      forceFinalStep: true,
    });
    const output = result.text || "(无输出)";
    ctx.agentRegistry.complete(runId, output, result.stats);
    await trace.finish("completed");
    console.log(
      `  ${tag} 完成 ✓ (${result.stats.steps} steps, ${result.stats.toolCalls} tools, ${output.length} 字符)`,
    );
    return output;
  } catch (error) {
    const isAbort =
      (error instanceof Error && error.name === "AbortError") || signal.aborted;
    const errorMessage = isAbort
      ? timedOut
        ? `执行超时 (${timeout / 1000}s)`
        : "随父 Agent 运行取消"
      : error instanceof Error
        ? error.message
        : String(error);
    ctx.agentRegistry.fail(runId, errorMessage, isAbort);
    await trace?.finish(isAbort ? "cancelled" : "failed", error);
    console.log(`  ${tag} ${isAbort ? "超时" : "失败"} ✗: ${errorMessage}`);
    if (isAbort && partialText) return `[部分结果] ${partialText}`;
    return `[sub-agent 执行失败] ${errorMessage}`;
  } finally {
    clearTimeout(timer);
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
  console.log(`\n  ┌─ 派发 ${toRun.length} 个只读子 Agent 并行执行 ─┐`);
  const results = await Promise.all(
    toRun.map(async (request, index) => ({
      task: request.task,
      result: await spawnAgent(request, ctx, index, true),
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
