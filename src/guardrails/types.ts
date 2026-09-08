export const GUARDRAIL_CATEGORIES = [
  "prompt_injection",
  "privilege_escalation",
  "sensitive_data",
  "unsafe_action",
  "policy_bypass",
] as const;

export type GuardrailCategory = (typeof GUARDRAIL_CATEGORIES)[number];
export type GuardrailSeverity = "low" | "medium" | "high" | "critical";

export interface NormalizedGuardrailInput {
  text: string;
  source: "cli" | "feishu" | "cron" | "child";
  role: "owner" | "collaborator" | "guest";
  conversationId?: string;
}

export interface NormalizedGuardrailOutput {
  text: string;
  source: NormalizedGuardrailInput["source"];
  role: NormalizedGuardrailInput["role"];
  conversationId?: string;
}

export interface NormalizedGuardrailTool {
  tool: string;
  input: unknown;
  workingDir: string;
  source: NormalizedGuardrailInput["source"];
  role: NormalizedGuardrailInput["role"];
  conversationId?: string;
}

export interface RunToolGuardrail {
  check(input: {
    tool: string;
    input: unknown;
    workingDir: string;
  }): GuardrailDecision | undefined;
  redact(value: unknown): unknown;
  rejection(decision: GuardrailDecision): string;
}

export interface GuardrailFinding {
  category: GuardrailCategory;
  severity: GuardrailSeverity;
  ruleId: string;
  evidence: string;
  mandatory: true;
}

export interface GuardrailDecision {
  outcome: "passed" | "blocked";
  policyVersion: string;
  requestHash: string;
  durationMs: number;
  findings: GuardrailFinding[];
}

export interface GuardrailSummary {
  input?: Omit<GuardrailDecision, "findings"> & {
    categories: GuardrailCategory[];
    cancellation?: "complete" | "incomplete";
  };
  output?: Omit<GuardrailDecision, "findings"> & {
    categories: GuardrailCategory[];
  };
}

export class InputTripwireError extends Error {
  readonly name = "InputTripwireError";

  constructor(
    readonly decision: GuardrailDecision,
    readonly cancellation: "complete" | "incomplete" = "complete",
  ) {
    super(
      "请求触发了安全保护，未交给模型处理。请移除绕过策略、敏感信息或未经授权的高风险操作后重试。",
    );
  }
}
