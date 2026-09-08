import { createHash } from "node:crypto";
import { z } from "zod";
import { abortReason, raceWithAbort } from "../security/abort.js";
import {
  GUARDRAIL_CATEGORIES,
  type GuardrailSeverity,
  type SemanticCheckResult,
  type SemanticCheckStatus,
  type SemanticGuardrailAggregate,
} from "./types.js";

export const SemanticGuardrailResultSchema = z.object({
  tripwire: z.boolean(),
  category: z.enum(GUARDRAIL_CATEGORIES),
  severity: z.enum(["low", "medium", "high", "critical"]),
});

export type SemanticGuardrailResult = z.infer<
  typeof SemanticGuardrailResultSchema
>;

export interface SemanticClassifier {
  id: string;
  classify(input: {
    text: string;
    signal: AbortSignal;
    maxOutputTokens: number;
  }): Promise<unknown>;
}

export interface SemanticGuardrailRunnerOptions {
  mode: "shadow" | "enforce";
  timeoutMs: number;
  maxOutputTokens: number;
  retries: number;
  concurrency: number;
  queueSize: number;
  classifiers: readonly SemanticClassifier[];
  failurePolicy?: Record<GuardrailSeverity, "open" | "closed">;
}

const DEFAULT_FAILURE_POLICY = {
  low: "open",
  medium: "open",
  high: "closed",
  critical: "closed",
} as const;

const SEVERITY_RANK: Record<GuardrailSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export class SemanticGuardrailRunner {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly options: SemanticGuardrailRunnerOptions) {}

  get mode(): SemanticGuardrailRunnerOptions["mode"] {
    return this.options.mode;
  }

  async evaluate(
    text: string,
    options: { signal?: AbortSignal; risk?: GuardrailSeverity } = {},
  ): Promise<SemanticGuardrailAggregate> {
    const startedAt = performance.now();
    const requestHash = createHash("sha256").update(text).digest("hex");
    const risk = options.risk ?? "low";
    const failureAction = (this.options.failurePolicy ??
      DEFAULT_FAILURE_POLICY)[risk];
    if (this.options.classifiers.length === 0) {
      return {
        mode: this.options.mode,
        outcome: "unavailable",
        enforcement: "allowed",
        failureAction,
        requestHash,
        durationMs: Math.max(0, performance.now() - startedAt),
        checks: [],
      };
    }

    const signal = options.signal ?? new AbortController().signal;
    const checks = await Promise.all(
      this.options.classifiers.map((classifier) =>
        this.runClassifier(classifier, text, signal),
      ),
    );
    const completed = checks.flatMap((check) =>
      check.status === "completed" && check.decision ? [check.decision] : [],
    );
    const highestSeverity = completed.reduce<GuardrailSeverity | undefined>(
      (highest, decision) =>
        !highest || SEVERITY_RANK[decision.severity] > SEVERITY_RANK[highest]
          ? decision.severity
          : highest,
      undefined,
    );
    const tripwire = completed.some((decision) => decision.tripwire);
    const failure = selectFailure(checks);
    const shouldBlock =
      tripwire || (failure !== undefined && failureAction === "closed");
    const enforcement =
      this.options.mode === "enforce" && shouldBlock ? "blocked" : "allowed";
    const outcome = tripwire
      ? this.options.mode === "enforce"
        ? "blocked"
        : "would_block"
      : (failure ?? "passed");

    return {
      mode: this.options.mode,
      outcome,
      enforcement,
      failureAction,
      requestHash,
      durationMs: Math.max(0, performance.now() - startedAt),
      ...(highestSeverity ? { highestSeverity } : {}),
      checks,
    };
  }

  private async runClassifier(
    classifier: SemanticClassifier,
    text: string,
    signal: AbortSignal,
  ): Promise<SemanticCheckResult> {
    const startedAt = performance.now();
    const checkId = safeClassifierId(classifier.id);
    const acquired = await this.acquire(signal);
    if (!acquired) {
      return {
        id: checkId,
        status: "queue_overflow",
        attempts: 0,
        durationMs: Math.max(0, performance.now() - startedAt),
      };
    }

    let status: SemanticCheckStatus = "errored";
    let attempts = 0;
    try {
      for (let attempt = 0; attempt <= this.options.retries; attempt++) {
        attempts++;
        const timeoutController = new AbortController();
        const timer = setTimeout(
          () =>
            timeoutController.abort(
              new DOMException("Semantic guardrail timed out", "TimeoutError"),
            ),
          this.options.timeoutMs,
        );
        const attemptSignal = AbortSignal.any([
          signal,
          timeoutController.signal,
        ]);
        try {
          const raw = await raceWithAbort(
            classifier.classify({
              text,
              signal: attemptSignal,
              maxOutputTokens: this.options.maxOutputTokens,
            }),
            attemptSignal,
          );
          const parsed = SemanticGuardrailResultSchema.safeParse(raw);
          if (parsed.success) {
            return {
              id: checkId,
              status: "completed",
              attempts,
              durationMs: Math.max(0, performance.now() - startedAt),
              decision: {
                ...parsed.data,
                ruleId: semanticRuleId(classifier.id),
              },
            };
          }
          status = "malformed";
        } catch {
          if (signal.aborted) throw abortReason(signal);
          status =
            timeoutController.signal.reason instanceof DOMException &&
            timeoutController.signal.reason.name === "TimeoutError"
              ? "timed_out"
              : "errored";
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        id: checkId,
        status,
        attempts,
        durationMs: Math.max(0, performance.now() - startedAt),
      };
    } finally {
      this.release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.active < this.options.concurrency) {
      this.active++;
      return true;
    }
    if (this.queue.length >= this.options.queueSize) return false;
    let wake!: () => void;
    const waiting = new Promise<void>((resolve) => {
      wake = resolve;
      this.queue.push(wake);
    });
    try {
      await raceWithAbort(waiting, signal);
    } catch (error) {
      const index = this.queue.indexOf(wake);
      if (index >= 0) this.queue.splice(index, 1);
      throw error;
    }
    this.active++;
    return true;
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

function safeClassifierId(id: string): string {
  const normalized = id.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 64);
  return normalized || "semantic-classifier";
}

function semanticRuleId(classifierId: string): string {
  return `SEMANTIC-${createHash("sha256")
    .update(classifierId)
    .digest("hex")
    .slice(0, 16)}`;
}

export function unavailableSemanticResult(
  text: string,
): SemanticGuardrailAggregate {
  return {
    mode: "shadow",
    outcome: "unavailable",
    enforcement: "allowed",
    failureAction: "open",
    requestHash: createHash("sha256").update(text).digest("hex"),
    durationMs: 0,
    checks: [],
  };
}

function selectFailure(
  checks: readonly SemanticCheckResult[],
): Exclude<SemanticCheckStatus, "completed"> | undefined {
  const priority: Array<Exclude<SemanticCheckStatus, "completed">> = [
    "queue_overflow",
    "timed_out",
    "malformed",
    "errored",
  ];
  return priority.find((status) =>
    checks.some((check) => check.status === status),
  );
}
