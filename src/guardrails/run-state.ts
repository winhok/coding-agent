import type {
  GuardrailDecision,
  GuardrailRunState,
  GuardrailSeverity,
} from "./types.js";

const RANK: Record<GuardrailSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function extendGuardrailRunState(
  parent: GuardrailRunState | undefined,
  decision: GuardrailDecision,
): GuardrailRunState {
  const severities = [
    ...(parent?.highestSeverity ? [parent.highestSeverity] : []),
    ...decision.findings.map((finding) => finding.severity),
    ...(decision.semantic?.highestSeverity
      ? [decision.semantic.highestSeverity]
      : []),
  ];
  const highestSeverity = severities.reduce<GuardrailSeverity | undefined>(
    (highest, severity) =>
      !highest || RANK[severity] > RANK[highest] ? severity : highest,
    undefined,
  );
  return {
    policyVersion: decision.policyVersion,
    requestHashes: [...(parent?.requestHashes ?? []), decision.requestHash],
    categories: [
      ...new Set([
        ...(parent?.categories ?? []),
        ...decision.findings.map((finding) => finding.category),
      ]),
    ],
    ...(highestSeverity ? { highestSeverity } : {}),
  };
}
