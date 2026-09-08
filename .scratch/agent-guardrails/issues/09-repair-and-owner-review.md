# 09: Bounded output repair and Owner review

**What to build:** Recover legitimate low- and medium-risk results through one tool-free repair attempt and allow an Owner to approve a specific reviewable request without creating a reusable policy bypass.

**Blocked by:** 05: Feishu atomic Guardrail storage and delivery; 06: Cron unattended Guardrail behavior; 07: Child Agent policy inheritance and checked return; 08: Semantic Guardrail in Shadow mode.

**Status:** ready-for-agent

- [ ] Low- and medium-risk output can receive one constrained repair attempt using only redacted candidate content and risk identifiers.
- [ ] The repair has no tools, is checked again, and cannot retry more than once.
- [ ] High- and critical-risk output and mandatory-rule blocks cannot enter the repair or review path.
- [ ] CLI review uses an explicit tokenized action rather than natural-language confirmation.
- [ ] Feishu review requires an identity-bound interactive action from an Owner.
- [ ] Approval is valid only for the exact actor, conversation, request hash, policy version, and unexpired time window.
- [ ] Replay, alteration, expiry, non-Owner action, and policy-version changes invalidate approval.
- [ ] Cron records review-required work but never self-approves it.
