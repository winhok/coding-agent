import fs from "node:fs";
import path from "node:path";
import type { GuardrailDecision, NormalizedGuardrailInput } from "./types.js";

export interface GuardrailAuditRecord {
  timestamp: string;
  source: NormalizedGuardrailInput["source"];
  role: NormalizedGuardrailInput["role"];
  outcome: GuardrailDecision["outcome"];
  policyVersion: string;
  requestHash: string;
  durationMs: number;
  findings: GuardrailDecision["findings"];
}

export class GuardrailAuditStore {
  private records: GuardrailAuditRecord[] = [];

  constructor(
    private readonly file?: string,
    private readonly capacity = 1_000,
  ) {}

  append(input: NormalizedGuardrailInput, decision: GuardrailDecision): void {
    const record: GuardrailAuditRecord = {
      timestamp: new Date().toISOString(),
      source: input.source,
      role: input.role,
      outcome: decision.outcome,
      policyVersion: decision.policyVersion,
      requestHash: decision.requestHash,
      durationMs: decision.durationMs,
      findings: decision.findings,
    };
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.shift();
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
  }

  list(): readonly GuardrailAuditRecord[] {
    return this.records;
  }
}
