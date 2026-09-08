import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelMessage } from "ai";
import { redactSensitiveValue } from "../guardrails/redaction.js";
import type { StepUsage } from "../usage/tracker.js";

type TraceStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "review_required"
  | "timed_out"
  | "errored"
  | "cancellation_incomplete";

export interface GuardrailTraceInput {
  stage: "input" | "tool" | "output";
  outcome: string;
  category?: string;
  severity?: string;
  ruleId?: string;
  enforcementMode: "enforce" | "shadow";
  policyVersion: string;
  durationMs: number;
  result: string;
}

interface TraceOptions {
  directory?: string;
  sessionId: string;
  model: string;
}

interface StepStartedInput {
  step: number;
  system: string;
  messages: ModelMessage[];
}

interface StepCompletedInput {
  step: number;
  text: string;
  outputMessages: ModelMessage[];
  usage: StepUsage;
}

interface TraceEvent {
  type?: string;
  traceId?: string;
  step?: number;
  durationMs?: number;
  status?: string;
  context?: { messages?: unknown[] };
  output?: { messages?: unknown[] };
  usage?: { inputTokens?: number; outputTokens?: number };
}

function sanitize(value: unknown, key = ""): unknown {
  return redactSensitiveValue(value, [], key);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "default";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function toolNames(messages: unknown[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        isRecord(part) &&
        part.type === "tool-call" &&
        typeof part.toolName === "string"
      ) {
        names.push(part.toolName);
      }
    }
  }
  return names;
}

export class LocalTraceRecorder {
  readonly traceId: string;
  readonly filePath: string;
  private readonly startedAt = Date.now();
  private readonly stepStartedAt = new Map<number, number>();
  private writeFailed = false;

  private constructor(options: TraceOptions) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.traceId = `${safeName(options.sessionId)}-${stamp}`;
    this.filePath = join(
      options.directory ?? ".traces",
      `${this.traceId}.jsonl`,
    );
  }

  static async start(options: TraceOptions): Promise<LocalTraceRecorder> {
    const recorder = new LocalTraceRecorder(options);
    await mkdir(dirname(recorder.filePath), { recursive: true });
    await recorder.write({
      type: "trace_started",
      traceId: recorder.traceId,
      sessionId: options.sessionId,
      model: options.model,
      timestamp: new Date().toISOString(),
    });
    return recorder;
  }

  async recordStepStarted(input: StepStartedInput): Promise<void> {
    this.stepStartedAt.set(input.step, Date.now());
    await this.write({
      type: "step_started",
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      context: sanitize({ system: input.system, messages: input.messages }),
    });
  }

  async recordAttemptError(
    step: number,
    attempt: number,
    error: unknown,
  ): Promise<void> {
    await this.write({
      type: "step_attempt_failed",
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step,
      attempt,
      error: errorMessage(error),
    });
  }

  async recordStepCompleted(input: StepCompletedInput): Promise<void> {
    const startedAt = this.stepStartedAt.get(input.step) ?? Date.now();
    await this.write({
      type: "step_completed",
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      durationMs: Date.now() - startedAt,
      output: sanitize({ text: input.text, messages: input.outputMessages }),
      usage: input.usage,
    });
  }

  async recordGuardrail(input: GuardrailTraceInput): Promise<void> {
    await this.write({
      type: "guardrail_decision",
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      ...(sanitize(input) as Record<string, unknown>),
    });
  }

  async finish(status: TraceStatus, error?: unknown): Promise<void> {
    await this.write({
      type: "trace_finished",
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      status,
      durationMs: Date.now() - this.startedAt,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    });
  }

  private async write(event: Record<string, unknown>): Promise<void> {
    if (this.writeFailed) return;
    try {
      await appendFile(
        this.filePath,
        `${JSON.stringify(sanitize(event))}\n`,
        "utf8",
      );
    } catch (error) {
      this.writeFailed = true;
      console.warn(`  [Trace] 写入失败，已停止记录: ${errorMessage(error)}`);
    }
  }
}

export async function inspectTrace(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf8");
  const events = content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
  const started = events.find((event) => event.type === "trace_started");
  const finished = [...events]
    .reverse()
    .find((event) => event.type === "trace_finished");
  const lines = [`Trace ${started?.traceId ?? filePath}`];

  for (const event of events) {
    if (event.type === "step_started") {
      lines.push(
        `  Step ${event.step}: context ${event.context?.messages?.length ?? 0} messages`,
      );
    }
    if (event.type === "step_completed") {
      const names = toolNames(event.output?.messages ?? []);
      const tools = names.length > 0 ? ` · tools: ${names.join(", ")}` : "";
      const tokens =
        (event.usage?.inputTokens ?? 0) + (event.usage?.outputTokens ?? 0);
      lines.push(
        `    completed in ${event.durationMs ?? 0}ms · ${tokens} tokens${tools}`,
      );
    }
  }

  lines.push(`  Status: ${finished?.status ?? "incomplete"}`);
  return lines.join("\n");
}
