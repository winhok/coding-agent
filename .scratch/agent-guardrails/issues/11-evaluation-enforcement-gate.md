# 11: Guardrail evaluation and enforcement gate

**What to build:** Provide the evidence and configuration gate required to promote semantic Guardrails from Shadow observation to enforced blocking without weakening deterministic protections.

**Blocked by:** 05: Feishu atomic Guardrail storage and delivery; 06: Cron unattended Guardrail behavior; 07: Child Agent policy inheritance and checked return; 08: Semantic Guardrail in Shadow mode; 09: Bounded output repair and Owner review; 10: Guardrail observability, retention, and terminal states.

**Status:** ready-for-agent

- [ ] A labeled corpus covers benign work, direct attacks, indirect prompt injection, privilege escalation, sensitive-data requests, dangerous tools, delegated bypass attempts, and false-positive edge cases.
- [ ] Fixtures contain only synthetic secrets and anonymized attack examples.
- [ ] Evaluation reports critical/high false negatives, benign false blocks, P95 latency, added tokens, cancellation success, premature output, and post-block tool execution.
- [ ] Promotion requires zero critical/high false negatives in the release corpus and less than one percent false blocks on benign samples.
- [ ] Automated tests and sampled Shadow observations demonstrate zero premature output and zero post-block tool execution.
- [ ] Enforcement is an explicit validated policy change and cannot disable mandatory hard rules.
- [ ] The report separates local runtime evidence from unverified provider, Feishu, and production behavior.
