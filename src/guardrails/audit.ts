import fs from "node:fs";
import path from "node:path";
import type {
  GuardrailDecision,
  GuardrailTerminalOutcome,
  NormalizedGuardrailInput,
  NormalizedGuardrailOutput,
  NormalizedGuardrailTool,
  SemanticGuardrailAggregate,
} from "./types.js";

export interface GuardrailAuditRecord {
  timestamp: string;
  stage: "input" | "output" | "tool" | "run";
  tool?: string;
  source: NormalizedGuardrailInput["source"];
  role: NormalizedGuardrailInput["role"];
  outcome:
    | GuardrailDecision["outcome"]
    | SemanticGuardrailAggregate["outcome"]
    | GuardrailTerminalOutcome;
  policyVersion: string;
  requestHash: string;
  durationMs: number;
  findings: GuardrailDecision["findings"];
  semantic?: Pick<
    SemanticGuardrailAggregate,
    "mode" | "enforcement" | "failureAction" | "highestSeverity" | "checks"
  >;
}

export interface GuardrailAggregateMetrics {
  expiredDetails: number;
  byOutcome: Record<string, number>;
  byStage: Record<string, number>;
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export class GuardrailAuditStore {
  private records: GuardrailAuditRecord[] = [];
  private metrics: GuardrailAggregateMetrics = {
    expiredDetails: 0,
    byOutcome: {},
    byStage: {},
  };

  constructor(
    private readonly file?: string,
    private readonly capacity = 1_000,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (file) this.load();
  }

  append(
    input:
      | NormalizedGuardrailInput
      | NormalizedGuardrailOutput
      | NormalizedGuardrailTool,
    decision: GuardrailDecision,
    stage: GuardrailAuditRecord["stage"] = "input",
  ): void {
    this.store({
      timestamp: new Date(this.now()).toISOString(),
      stage,
      ...(stage === "tool" && "tool" in input ? { tool: input.tool } : {}),
      source: input.source,
      role: input.role,
      outcome: decision.outcome,
      policyVersion: decision.policyVersion,
      requestHash: decision.requestHash,
      durationMs: decision.durationMs,
      findings: decision.findings,
    });
  }

  appendSemantic(
    input: NormalizedGuardrailInput,
    semantic: SemanticGuardrailAggregate,
    policyVersion: string,
  ): void {
    this.store({
      timestamp: new Date(this.now()).toISOString(),
      stage: "input",
      source: input.source,
      role: input.role,
      outcome: semantic.outcome,
      policyVersion,
      requestHash: semantic.requestHash,
      durationMs: semantic.durationMs,
      findings: [],
      semantic: {
        mode: semantic.mode,
        enforcement: semantic.enforcement,
        failureAction: semantic.failureAction,
        ...(semantic.highestSeverity
          ? { highestSeverity: semantic.highestSeverity }
          : {}),
        checks: semantic.checks,
      },
    });
  }

  appendTerminal(input: {
    source: NormalizedGuardrailInput["source"];
    role: NormalizedGuardrailInput["role"];
    outcome: GuardrailTerminalOutcome;
    policyVersion: string;
    requestHash: string;
    durationMs: number;
  }): void {
    this.store({
      timestamp: new Date(this.now()).toISOString(),
      stage: "run",
      source: input.source,
      role: input.role,
      outcome: input.outcome,
      policyVersion: input.policyVersion,
      requestHash: input.requestHash,
      durationMs: input.durationMs,
      findings: [],
    });
  }

  list(): readonly GuardrailAuditRecord[] {
    return [...this.records];
  }

  getMetrics(): GuardrailAggregateMetrics {
    return {
      expiredDetails: this.metrics.expiredDetails,
      byOutcome: { ...this.metrics.byOutcome },
      byStage: { ...this.metrics.byStage },
    };
  }

  private load(): void {
    if (!this.file) return;
    if (fs.existsSync(this.file)) {
      this.records = fs
        .readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as GuardrailAuditRecord];
          } catch {
            return [];
          }
        });
    }
    const metricsFile = this.metricsFile();
    if (metricsFile && fs.existsSync(metricsFile)) {
      try {
        this.metrics = JSON.parse(
          fs.readFileSync(metricsFile, "utf8"),
        ) as GuardrailAggregateMetrics;
      } catch {
        this.metrics = { expiredDetails: 0, byOutcome: {}, byStage: {} };
      }
    }
    if (this.prune()) this.persist();
  }

  private store(record: GuardrailAuditRecord): void {
    this.records.push(record);
    this.prune();
    if (this.file) this.persist();
  }

  private prune(): boolean {
    const cutoff = this.now() - this.retentionMs;
    const retained: GuardrailAuditRecord[] = [];
    const removed: GuardrailAuditRecord[] = [];
    for (const record of this.records) {
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < cutoff) {
        removed.push(record);
      } else retained.push(record);
    }
    while (retained.length > this.capacity) {
      const record = retained.shift();
      if (record) removed.push(record);
    }
    this.records = retained;
    for (const record of removed) this.aggregate(record);
    return removed.length > 0;
  }

  private aggregate(record: GuardrailAuditRecord): void {
    this.metrics.expiredDetails++;
    this.metrics.byOutcome[record.outcome] =
      (this.metrics.byOutcome[record.outcome] ?? 0) + 1;
    this.metrics.byStage[record.stage] =
      (this.metrics.byStage[record.stage] ?? 0) + 1;
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      this.records.map((record) => JSON.stringify(record)).join("\n") +
        (this.records.length > 0 ? "\n" : ""),
      { mode: 0o600 },
    );
    fs.chmodSync(this.file, 0o600);
    const metricsFile = this.metricsFile();
    if (metricsFile) {
      fs.writeFileSync(metricsFile, `${JSON.stringify(this.metrics)}\n`, {
        mode: 0o600,
      });
      fs.chmodSync(metricsFile, 0o600);
    }
  }

  private metricsFile(): string | undefined {
    return this.file ? `${this.file}.metrics.json` : undefined;
  }
}
