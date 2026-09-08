# 01: Deterministic CLI input Guardrail

**What to build:** Deliver the first complete Guardrail path for CLI runs: validated policy configuration, normalized input, deterministic risk classification, a structured input Tripwire, a safe user-facing rejection, and redacted audit evidence. Existing successful AgentLoop results remain compatible.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Mandatory rules classify prompt injection, privilege escalation, sensitive data, unsafe action, and policy bypass with stable severity and rule identifiers.
- [ ] A mandatory block prevents the main model from starting and returns a deterministic CLI-safe explanation without exposing rule internals.
- [ ] Blocked input does not enter normal model context or conversation history.
- [ ] Audit output contains policy version, request hash, timing, outcome, and redacted evidence without storing the rejected plaintext or known secrets.
- [ ] Passing and Guardrail-disabled runs preserve the existing successful result contract and event ordering.
- [ ] Invalid mandatory policy configuration prevents startup, while tests use only synthetic sensitive values.
