import type { GuardrailAuditStore } from "./audit.js";
import { evaluateDeterministicInput } from "./deterministic.js";
import { evaluateDeterministicOutput } from "./deterministic-output.js";
import { evaluateDeterministicTool } from "./deterministic-tool.js";
import { redactSensitiveValue } from "./redaction.js";
import {
  type SemanticGuardrailRunner,
  unavailableSemanticResult,
} from "./semantic.js";
import {
  type GuardrailDecision,
  InputTripwireError,
  type NormalizedGuardrailInput,
  type NormalizedGuardrailOutput,
  type NormalizedGuardrailTool,
  type RunToolGuardrail,
} from "./types.js";

export interface GuardrailServiceOptions {
  enabled: boolean;
  policyVersion: string;
  audit: GuardrailAuditStore;
  knownSecrets?: readonly string[];
  sensitiveFields?: readonly string[];
  semantic?: SemanticGuardrailRunner;
  semanticUnavailableReason?: string;
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

  async checkInputWithSemantic(
    input: NormalizedGuardrailInput,
    signal: AbortSignal,
  ): Promise<GuardrailDecision | undefined> {
    const deterministic = this.checkInput(input);
    if (!deterministic) return undefined;
    return this.checkSemanticInput(input, deterministic, signal);
  }

  async checkSemanticInput(
    input: NormalizedGuardrailInput,
    deterministic: GuardrailDecision,
    signal: AbortSignal,
  ): Promise<GuardrailDecision> {
    const semantic = this.options.semantic
      ? await this.options.semantic.evaluate(input.text, { signal })
      : this.options.semanticUnavailableReason
        ? unavailableSemanticResult(input.text)
        : undefined;
    if (!semantic) return deterministic;
    this.options.audit.appendSemantic(
      input,
      semantic,
      this.options.policyVersion,
    );
    return { ...deterministic, semantic };
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

  checkTool(tool: NormalizedGuardrailTool): GuardrailDecision | undefined {
    if (!this.options.enabled) return undefined;
    const decision = evaluateDeterministicTool(
      tool,
      this.options.policyVersion,
      this.options.knownSecrets
        ? { knownSecrets: this.options.knownSecrets }
        : {},
    );
    this.options.audit.append(tool, decision, "tool");
    return decision;
  }

  createToolGuardrail(context: {
    source: NormalizedGuardrailTool["source"];
    role: NormalizedGuardrailTool["role"];
    conversationId?: string;
  }): RunToolGuardrail {
    return {
      check: ({ tool, input, workingDir }) =>
        this.checkTool({ tool, input, workingDir, ...context }),
      redact: (value) => redactSensitiveValue(value, this.options.knownSecrets),
      rejection: safeToolRejection,
    };
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

function safeToolRejection(_decision: GuardrailDecision): string {
  return "该工具调用触发了安全保护，未执行。请移除敏感信息、越界路径或绕过内容后重试。";
}
