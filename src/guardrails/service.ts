import type { GuardrailAuditStore } from "./audit.js";
import { evaluateDeterministicInput } from "./deterministic.js";
import { evaluateDeterministicOutput } from "./deterministic-output.js";
import {
  type GuardrailDecision,
  InputTripwireError,
  type NormalizedGuardrailInput,
  type NormalizedGuardrailOutput,
} from "./types.js";

export interface GuardrailServiceOptions {
  enabled: boolean;
  policyVersion: string;
  audit: GuardrailAuditStore;
  knownSecrets?: readonly string[];
  sensitiveFields?: readonly string[];
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

  checkOutput(
    output: NormalizedGuardrailOutput,
  ): GuardrailDecision | undefined {
    if (!this.options.enabled) return undefined;
    const decision = evaluateDeterministicOutput(
      output,
      this.options.policyVersion,
      {
        ...(this.options.knownSecrets
          ? { knownSecrets: this.options.knownSecrets }
          : {}),
        ...(this.options.sensitiveFields
          ? { sensitiveFields: this.options.sensitiveFields }
          : {}),
      },
    );
    this.options.audit.append(output, decision, "output");
    return decision;
  }
}

export function safeOutputReplacement(decision: GuardrailDecision): string {
  const category = decision.findings[0]?.category;
  switch (category) {
    case "sensitive_data":
      return "响应可能包含敏感信息，已被安全保护拦截。请缩小请求范围或移除凭证后重试。";
    case "unsafe_action":
      return "响应包含不安全的操作内容，已被安全保护拦截。请改为描述安全目标后重试。";
    case "policy_bypass":
    case "prompt_injection":
    case "privilege_escalation":
      return "响应违反了当前安全策略，已被安全保护拦截。请调整请求后重试。";
    default:
      return "响应未通过安全检查，已被拦截。请调整请求后重试。";
  }
}
