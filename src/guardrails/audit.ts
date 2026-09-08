import fs from "node:fs";
import path from "node:path";
import type {
  GuardrailDecision,
  NormalizedGuardrailInput,
  NormalizedGuardrailOutput,
  NormalizedGuardrailTool,
  SemanticGuardrailAggregate,
} from "./types.js";

export interface GuardrailAuditRecord {
  timestamp: string;
  stage: "input" | "output" | "tool";
  tool?: string;
  source: NormalizedGuardrailInput["source"];
  role: NormalizedGuardrailInput["role"];
  outcome: GuardrailDecision["outcome"] | SemanticGuardrailAggregate["outcome"];
  policyVersion: string;
  requestHash: string;
  durationMs: number;
  findings: GuardrailDecision["findings"];
  semantic?: Pick<
    SemanticGuardrailAggregate,
    "mode" | "enforcement" | "failureAction" | "highestSeverity" | "checks"
  >;
}

export class GuardrailAuditStore {
  private records: GuardrailAuditRecord[] = [];

  constructor(
    private readonly file?: string,
    private readonly capacity = 1_000,
  ) {}

  append(
    input:
      | NormalizedGuardrailInput
      | NormalizedGuardrailOutput
      | NormalizedGuardrailTool,
    decision: GuardrailDecision,
    stage: GuardrailAuditRecord["stage"] = "input",
  ): void {
    const record: GuardrailAuditRecord = {
      timestamp: new Date().toISOString(),
      stage,
      ...(stage === "tool" && "tool" in input ? { tool: input.tool } : {}),
      source: input.source,
      role: input.role,
      outcome: decision.outcome,
      policyVersion: decision.policyVersion,
      requestHash: decision.requestHash,
      durationMs: decision.durationMs,
      findings: decision.findings,
    };
    this.store(record);
  }

  appendSemantic(
    input: NormalizedGuardrailInput,
    semantic: SemanticGuardrailAggregate,
    policyVersion: string,
  ): void {
    this.store({
      timestamp: new Date().toISOString(),
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

  list(): readonly GuardrailAuditRecord[] {
    return this.records;
  }

  private store(record: GuardrailAuditRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.shift();
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
  }
}
