import { createHash } from "node:crypto";
import type {
  GuardrailDecision,
  GuardrailFinding,
  NormalizedGuardrailOutput,
} from "./types.js";

interface OutputRule {
  id: string;
  category: GuardrailFinding["category"];
  severity: GuardrailFinding["severity"];
  pattern: RegExp;
  mandatory: boolean;
}

const OUTPUT_RULES: readonly OutputRule[] = [
  {
    id: "GR-OUT-CREDENTIAL-001",
    category: "sensitive_data",
    severity: "critical",
    pattern:
      /(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|bearer\s+[a-z0-9._~+/=-]{16,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[a-z0-9_./+\-=]{12,})/i,
    mandatory: true,
  },
  {
    id: "GR-OUT-UNSAFE-001",
    category: "unsafe_action",
    severity: "critical",
    pattern:
      /(?:rm\s+-rf\s+(?:\/|~|\$HOME)|mkfs(?:\.|\s)|dd\s+if=.*\s+of=\/dev\/|删除(?:整个)?(?:根目录|主目录))/i,
    mandatory: true,
  },
  {
    id: "GR-OUT-BYPASS-001",
    category: "policy_bypass",
    severity: "high",
    pattern:
      /(?:disable|bypass|circumvent)\s+(?:the\s+)?(?:safety|guardrails?|approval|permissions?)|(?:关闭|绕过|规避)(?:安全|护栏|审批|权限)(?:检查|机制|策略)?/i,
    mandatory: true,
  },
  {
    id: "GR-OUT-PII-001",
    category: "sensitive_data",
    severity: "medium",
    pattern:
      /(?:(?:e-?mail|邮箱)\s*[:=]\s*[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:phone|mobile|电话|手机号)\s*[:=]\s*\+?[0-9][0-9\s-]{7,})/i,
    mandatory: false,
  },
];

export interface DeterministicOutputOptions {
  knownSecrets?: readonly string[];
  sensitiveFields?: readonly string[];
}

export function evaluateDeterministicOutput(
  output: NormalizedGuardrailOutput,
  policyVersion: string,
  options: DeterministicOutputOptions = {},
): GuardrailDecision {
  const startedAt = performance.now();
  const findings: GuardrailFinding[] = OUTPUT_RULES.filter((rule) =>
    rule.pattern.test(output.text),
  ).map((rule) =>
    finding(rule.id, rule.category, rule.severity, rule.mandatory),
  );

  if (
    options.knownSecrets?.some(
      (secret) => secret.length >= 4 && output.text.includes(secret),
    )
  ) {
    findings.push(
      finding("GR-OUT-KNOWN-SECRET-001", "sensitive_data", "critical", true),
    );
  }

  for (const field of options.sensitiveFields ?? []) {
    const fieldPattern = new RegExp(
      `(?:["']?${escapeRegExp(field)}["']?)\\s*[:=]\\s*["']?[^\\s,"'}]{4,}`,
      "i",
    );
    if (fieldPattern.test(output.text)) {
      findings.push(
        finding("GR-OUT-SENSITIVE-FIELD-001", "sensitive_data", "high", true),
      );
      break;
    }
  }

  return {
    outcome: findings.length > 0 ? "blocked" : "passed",
    policyVersion,
    requestHash: createHash("sha256").update(output.text).digest("hex"),
    durationMs: Math.max(0, performance.now() - startedAt),
    findings,
  };
}

function finding(
  ruleId: string,
  category: GuardrailFinding["category"],
  severity: GuardrailFinding["severity"],
  mandatory: boolean,
): GuardrailFinding {
  return {
    category,
    severity,
    ruleId,
    evidence: `[redacted:${category}]`,
    mandatory,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
