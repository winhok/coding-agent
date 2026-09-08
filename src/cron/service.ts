import { createHash } from "node:crypto";
import type { GuardrailService } from "../guardrails/service.js";
import {
  safeCronInputRejection,
  safeOutputReplacement,
} from "../guardrails/service.js";
import {
  type GuardrailDecision,
  type GuardrailTerminalOutcome,
  InputTripwireError,
} from "../guardrails/types.js";
import { getNextCronTime, parseSchedule } from "./parser.js";
import { CronStore } from "./store.js";
import type {
  CronJobConfig,
  CronJobState,
  JobPayload,
  RunLog,
} from "./types.js";

const QUOTES = [
  "“知之为知之，不知为不知，是知也。” —— 孔子",
  "“学而不思则罔，思而不学则殆。” —— 孔子",
  "“千里之行，始于足下。” —— 老子",
  "“天行健，君子以自强不息。” —— 《周易》",
  "“不积跬步，无以至千里。” —— 荀子",
  "“Stay hungry, stay foolish.” —— Steve Jobs",
  "“The best way to predict the future is to invent it.” —— Alan Kay",
  "“Talk is cheap. Show me the code.” —— Linus Torvalds",
  "“Simplicity is the ultimate sophistication.” —— Leonardo da Vinci",
  "“First, solve the problem. Then, write the code.” —— John Johnson",
];

export interface CronExecutor {
  runAgentPrompt: (
    prompt: string,
    timeout?: number,
  ) => Promise<string | CronAgentExecutionResult>;
  notify?: (message: string) => void;
}

export interface CronAgentExecutionResult {
  status: "completed" | "blocked" | "review_required";
  output: string;
}

export class CronService {
  private jobs = new Map<string, CronJobState>();
  private store: CronStore;
  private executor?: CronExecutor;
  private running = false;

  constructor(
    baseDir = ".",
    private readonly options: { guardrails?: GuardrailService } = {},
  ) {
    this.store = new CronStore(baseDir);
    this.store.init();
  }

  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  load(): void {
    const configs = this.store.loadJobs();
    for (const config of configs) {
      if (config.enabled) {
        const pause = this.store.getPause(config.id);
        this.jobs.set(config.id, {
          config,
          timerId: null,
          consecutiveFailures: 0,
          running: false,
          ...(pause ? { pause } : {}),
        });
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const state of this.jobs.values()) {
      if (state.config.enabled && !state.pause) this.scheduleJob(state);
    }
  }

  stop(): void {
    this.running = false;
    for (const state of this.jobs.values()) {
      if (state.timerId) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
    }
  }

  add(config: CronJobConfig): void {
    if (this.jobs.has(config.id)) {
      throw new Error(`任务 ${config.id} 已存在`);
    }
    const state: CronJobState = {
      config,
      timerId: null,
      consecutiveFailures: 0,
      running: false,
    };
    this.jobs.set(config.id, state);
    this.persist();
    if (this.running && config.enabled) this.scheduleJob(state);
  }

  remove(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    if (state.timerId) clearTimeout(state.timerId);
    this.jobs.delete(id);
    this.store.clearPause(id);
    this.persist();
    return true;
  }

  enable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = true;
    state.consecutiveFailures = 0;
    delete state.pause;
    this.store.clearPause(id);
    this.persist();
    if (this.running) this.scheduleJob(state);
    return true;
  }

  disable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = false;
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    this.persist();
    return true;
  }

  list(): Array<{ config: CronJobConfig; status: string; lastRun?: RunLog }> {
    return Array.from(this.jobs.values()).map((state) => ({
      config: state.config,
      status: state.running
        ? "running"
        : state.pause
          ? "paused"
          : !state.config.enabled
            ? "disabled"
            : state.timerId
              ? "scheduled"
              : "idle",
      ...(state.lastRun ? { lastRun: state.lastRun } : {}),
    }));
  }

  async runNow(id: string): Promise<string> {
    const state = this.jobs.get(id);
    if (!state) return `任务 ${id} 不存在`;
    if (state.pause) return `任务 ${id} 已暂停: ${state.pause.reason}`;
    return this.executeJob(state);
  }

  getRecentLogs(jobId?: string, limit?: number): RunLog[] {
    return this.store.getRecentLogs(jobId, limit);
  }

  private scheduleJob(state: CronJobState): void {
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }

    try {
      const parsed = parseSchedule(state.config.schedule);
      let delayMs: number;

      switch (parsed.type) {
        case "interval":
          if (parsed.intervalMs === undefined) {
            throw new Error("无效的 interval 调度");
          }
          delayMs = parsed.intervalMs;
          break;
        case "once": {
          if (!parsed.onceAt) throw new Error("无效的 once 调度");
          const diff = parsed.onceAt.getTime() - Date.now();
          if (diff <= 0) {
            void this.executeJob(state).then(() => {
              if (!state.pause) this.remove(state.config.id);
            });
            return;
          }
          delayMs = diff;
          break;
        }
        case "cron": {
          if (!parsed.cronInstance) throw new Error("无效的 cron 调度");
          delayMs = getNextCronTime(parsed.cronInstance);
          break;
        }
      }

      state.timerId = setTimeout(async () => {
        await this.executeJob(state);
        if (
          parsed.type !== "once" &&
          state.config.enabled &&
          !state.pause &&
          this.running
        ) {
          this.scheduleJob(state);
        } else if (parsed.type === "once" && !state.pause) {
          this.remove(state.config.id);
        }
      }, delayMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  [cron] ✗ 调度失败 ${state.config.id}: ${message}`);
    }
  }

  private async executeJob(state: CronJobState): Promise<string> {
    if (state.running) return "任务正在执行中";
    state.running = true;

    const startedAt = new Date().toISOString();
    let output = "";
    let status: RunLog["status"] = "success";
    let terminalOutcome: GuardrailTerminalOutcome = "passed";
    let error: string | undefined;

    try {
      const timeout = state.config.timeout || 60000;
      const result = await this.runPayload(state.config.payload, timeout);
      output = result.output;
      if (result.status === "completed") {
        state.consecutiveFailures = 0;
        delete state.pause;
        this.store.clearPause(state.config.id);
      } else {
        status = result.status;
        terminalOutcome =
          result.status === "review_required" ? "review_required" : "blocked";
        state.consecutiveFailures = 0;
        state.pause = {
          status: result.status,
          reason: output,
          updatedAt: new Date().toISOString(),
        };
        this.store.setPause(state.config.id, state.pause);
      }
    } catch (caughtError) {
      const rawMessage =
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError);
      const message = String(
        this.options.guardrails?.redactActivity(rawMessage) ?? rawMessage,
      );
      status = message.includes("timeout") ? "timeout" : "error";
      terminalOutcome = status === "timeout" ? "timed_out" : "errored";
      error = message;
      output = `执行失败: ${message}`;
      state.consecutiveFailures++;

      const maxRetries = state.config.maxRetries ?? 3;
      if (state.consecutiveFailures >= maxRetries) {
        state.config.enabled = false;
        console.log(
          `  [cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`,
        );
        this.persist();
      }
    } finally {
      state.running = false;
    }

    this.options.guardrails?.recordTerminal({
      source: "cron",
      role: "owner",
      outcome: terminalOutcome,
      requestHash: createHash("sha256")
        .update(JSON.stringify(state.config.payload))
        .digest("hex"),
    });

    const log: RunLog = {
      jobId: state.config.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      output: output.slice(0, 1000),
      ...(error ? { error } : {}),
    };
    state.lastRun = log;
    this.store.appendLog(log);

    if (this.executor?.notify) {
      const icon =
        status === "success"
          ? "✓"
          : status === "error" || status === "timeout"
            ? "✗"
            : "!";
      this.executor.notify(
        `[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`,
      );
    }

    return output;
  }

  private async runPayload(
    payload: JobPayload,
    timeout: number,
  ): Promise<CronAgentExecutionResult> {
    if (!this.executor) {
      return {
        status: "completed",
        output: "[cron] 未设置执行器，无法运行任务",
      };
    }

    if (payload.type === "agent") {
      let deterministic: GuardrailDecision | undefined;
      if (this.options.guardrails) {
        try {
          deterministic = this.options.guardrails.checkInput({
            text: payload.prompt,
            source: "cron",
            role: "owner",
          });
        } catch (error) {
          if (!(error instanceof InputTripwireError)) throw error;
          return {
            status: "blocked",
            output: safeCronInputRejection(error.decision),
          };
        }
        if (deterministic) {
          if (this.options.guardrails.isSemanticEnforced()) {
            deterministic = await this.options.guardrails.checkSemanticInput(
              { text: payload.prompt, source: "cron", role: "owner" },
              deterministic,
              new AbortController().signal,
            );
            if (deterministic.outcome === "blocked") {
              return {
                status: "blocked",
                output: safeCronInputRejection(deterministic),
              };
            }
          } else {
            this.options.guardrails.observeSemanticInput(
              { text: payload.prompt, source: "cron", role: "owner" },
              deterministic,
              new AbortController().signal,
            );
          }
        }
      }
      const raw = await this.executor.runAgentPrompt(payload.prompt, timeout);
      const result =
        typeof raw === "string"
          ? { status: "completed" as const, output: raw }
          : raw;
      if (result.status === "review_required") {
        return {
          status: "review_required",
          output: "定时任务需要 Owner 审批，已暂停等待人工处理。",
        };
      }
      if (result.status === "blocked") {
        return {
          status: "blocked",
          output: String(
            this.options.guardrails?.redactActivity(result.output) ??
              result.output,
          ),
        };
      }
      if (!this.options.guardrails) {
        return result;
      }
      const outputDecision = this.options.guardrails.checkOutput({
        text: result.output,
        source: "cron",
        role: "owner",
      });
      return outputDecision?.outcome === "blocked"
        ? { status: "blocked", output: safeOutputReplacement(outputDecision) }
        : result;
    }

    if (payload.type === "handler") {
      if (payload.handler === "random-quote") {
        return {
          status: "completed",
          output: QUOTES[Math.floor(Math.random() * QUOTES.length)] ?? "",
        };
      }
      return {
        status: "completed",
        output: `[handler] ${payload.handler} — handler 类型需要通过插件注册`,
      };
    }

    return { status: "completed", output: "未知 payload 类型" };
  }

  private persist(): void {
    const configs = Array.from(this.jobs.values())
      .filter((state) => state.config.source === "runtime")
      .map((state) => state.config);
    const existing = this.store
      .loadJobs()
      .filter((job) => job.source === "config");
    this.store.saveJobs([...existing, ...configs]);
  }
}
