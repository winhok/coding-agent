import { createHash } from "node:crypto";
import path from "node:path";
import type {
  GuardrailDecision,
  GuardrailFinding,
  NormalizedGuardrailTool,
} from "./types.js";

const SECRET_PATTERN =
  /(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|bearer\s+[a-z0-9._~+/=-]{16,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[a-z0-9_./+\-=]{12,})/i;
const BYPASS_PATTERN =
  /(?:disable|bypass|circumvent)\s+(?:the\s+)?(?:safety|guardrails?|approval|permissions?)|(?:关闭|绕过|规避)(?:安全|护栏|审批|权限)/i;
const UNSAFE_PATTERN =
  /(?:rm\s+-rf\s+(?:\/|~|\$HOME)|mkfs(?:\.|\s)|dd\s+if=.*\s+of=\/dev\/|git\s+(?:push\s+--force|reset\s+--hard|clean\s+-[a-z]*f))/i;
const PATH_KEY = /(?:^|_)(?:path|file|dir|directory|cwd|working_dir)$/i;
const APPROVAL_KEY =
  /(?:^|_)(?:approved|approval|owner_approval|review_token)$/i;

export interface DeterministicToolOptions {
  knownSecrets?: readonly string[];
}

export function evaluateDeterministicTool(
  tool: NormalizedGuardrailTool,
  policyVersion: string,
  options: DeterministicToolOptions = {},
): GuardrailDecision {
  const startedAt = performance.now();
  const serialized = stableStringify(tool.input);
  const findings: GuardrailFinding[] = [];

  if (
    SECRET_PATTERN.test(serialized) ||
    options.knownSecrets?.some(
      (secret) => secret.length >= 4 && serialized.includes(secret),
    )
  ) {
    findings.push(finding("GR-TOOL-SECRET-001", "sensitive_data"));
  }
  if (containsWorkspaceEscape(tool.input, tool.workingDir)) {
    findings.push(finding("GR-TOOL-PATH-001", "unsafe_action"));
  }
  if (containsForgedApproval(tool.input)) {
    findings.push(finding("GR-TOOL-APPROVAL-001", "privilege_escalation"));
  }
  if (BYPASS_PATTERN.test(serialized)) {
    findings.push(finding("GR-TOOL-BYPASS-001", "policy_bypass"));
  }
  if (UNSAFE_PATTERN.test(serialized)) {
    findings.push(finding("GR-TOOL-UNSAFE-001", "unsafe_action"));
  }

  return {
    outcome: findings.length > 0 ? "blocked" : "passed",
    policyVersion,
    requestHash: createHash("sha256").update(serialized).digest("hex"),
    durationMs: Math.max(0, performance.now() - startedAt),
    findings,
  };
}

function containsWorkspaceEscape(value: unknown, workingDir: string): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_KEY.test(key) && typeof child === "string") {
      const resolved = path.resolve(workingDir, child);
      const relative = path.relative(workingDir, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`))
        return true;
    }
    if (containsWorkspaceEscape(child, workingDir)) return true;
  }
  return false;
}

function containsForgedApproval(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (APPROVAL_KEY.test(key) && child !== false && child != null) return true;
    if (containsForgedApproval(child)) return true;
  }
  return false;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function finding(
  ruleId: string,
  category: GuardrailFinding["category"],
): GuardrailFinding {
  return {
    category,
    severity: "critical",
    ruleId,
    evidence: `[redacted:${category}]`,
    mandatory: true,
  };
}
