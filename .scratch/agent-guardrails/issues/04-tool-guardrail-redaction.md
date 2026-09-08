# 04: Unified tool Guardrail and activity redaction

**What to build:** Route every tool invocation through deterministic Guardrail checks at the existing execution boundary while keeping safe progress visible. Tool parameters, results, events, and audit previews are redacted before they can leak sensitive information.

**Blocked by:** 02: Parallel input check and effect-release gate.

**Status:** ready-for-agent

- [ ] Registered, dynamically discovered, MCP-backed, and child-spawn tools cannot bypass the unified execution boundary.
- [ ] Mandatory rules block known-secret exfiltration, workspace escape, forged approval, policy bypass, and unauthorized destructive or external actions.
- [ ] Guardrails cannot grant a capability denied by role authorization or existing approval policy.
- [ ] A blocked invocation neither acquires a destructive execution lock nor calls the tool body.
- [ ] Tool names and safe state transitions remain observable while sensitive parameters and results are replaced by bounded redacted summaries.
- [ ] Existing authorization, approval, locking, cancellation, and audit behavior remains compatible for passing calls.
