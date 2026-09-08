import { createHash } from "node:crypto";
import type {
  GuardrailDecision,
  GuardrailFinding,
  NormalizedGuardrailInput,
} from "./types.js";

interface Rule {
  id: string;
  category: GuardrailFinding["category"];
  severity: GuardrailFinding["severity"];
  pattern: RegExp;
}

const MANDATORY_RULES: readonly Rule[] = [
  {
    id: "GR-INJECT-001",
    category: "prompt_injection",
    severity: "high",
    pattern:
      /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|prompts?)|忽略(?:之前|以上|系统|开发者)(?:的)?(?:指令|提示)/i,
  },
  {
    id: "GR-PRIV-001",
    category: "privilege_escalation",
    severity: "critical",
    pattern:
      /(?:pretend|act)\s+(?:that\s+)?(?:you are|i am)\s+(?:the\s+)?(?:owner|admin|root)|假装(?:你|我)是(?:所有者|管理员|root)/i,
  },
  {
    id: "GR-SECRET-001",
    category: "sensitive_data",
    severity: "critical",
    pattern:
      /(?:sk-[a-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[a-z0-9_./+\-=]{12,})/i,
  },
  {
    id: "GR-UNSAFE-001",
    category: "unsafe_action",
    severity: "critical",
    pattern:
      /(?:rm\s+-rf\s+(?:\/|~|\$HOME)|mkfs(?:\.|\s)|dd\s+if=.*\s+of=\/dev\/|删除(?:整个)?(?:根目录|主目录))/i,
  },
  {
    id: "GR-BYPASS-001",
    category: "policy_bypass",
    severity: "critical",
    pattern:
      /(?:disable|bypass|circumvent)\s+(?:the\s+)?(?:safety|guardrails?|approval|permissions?)|(?:关闭|绕过|规避)(?:安全|护栏|审批|权限)(?:检查|机制|策略)?/i,
  },
];

export function evaluateDeterministicInput(
  input: NormalizedGuardrailInput,
  policyVersion: string,
): GuardrailDecision {
  const startedAt = performance.now();
  const findings = MANDATORY_RULES.filter((rule) =>
    rule.pattern.test(input.text),
  ).map((rule) => ({
    category: rule.category,
    severity: rule.severity,
    ruleId: rule.id,
    evidence: `[redacted:${rule.category}]`,
    mandatory: true as const,
  }));
  return {
    outcome: findings.length > 0 ? "blocked" : "passed",
    policyVersion,
    requestHash: createHash("sha256").update(input.text).digest("hex"),
    durationMs: Math.max(0, performance.now() - startedAt),
    findings,
  };
}
