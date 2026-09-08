import type { GuardrailAuditStore } from "./audit.js";
import { evaluateDeterministicInput } from "./deterministic.js";
import {
  type GuardrailDecision,
  InputTripwireError,
  type NormalizedGuardrailInput,
} from "./types.js";

export interface GuardrailServiceOptions {
  enabled: boolean;
  policyVersion: string;
  audit: GuardrailAuditStore;
}

export class GuardrailService {
  constructor(private readonly options: GuardrailServiceOptions) {}

  checkInput(input: NormalizedGuardrailInput): GuardrailDecision | undefined {
    if (!this.options.enabled) return undefined;
    const decision = evaluateDeterministicInput(
      input,
      this.options.policyVersion,
    );
    this.options.audit.append(input, decision);
    if (decision.outcome === "blocked") throw new InputTripwireError(decision);
    return decision;
  }
}
