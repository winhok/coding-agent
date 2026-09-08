# 05: Feishu atomic Guardrail storage and delivery

**What to build:** Apply the same input, tool, and output protection to Feishu conversations, with atomic persistence and outbox behavior so blocked content is neither committed nor sent.

**Blocked by:** 03: Final output Guardrail and safe replacement; 04: Unified tool Guardrail and activity redaction.

**Status:** ready-for-agent

- [ ] Feishu input receives the same mandatory policy baseline as CLI input and cannot weaken hard rules.
- [ ] Parallel checks expose no generated text or unsafe tool activity before the input passes.
- [ ] Rejected input and candidate output do not enter normal conversation history or the delivery outbox.
- [ ] A passing final response is persisted and enqueued exactly once after output validation.
- [ ] User-visible tool progress contains only redacted summaries.
- [ ] A structured Tripwire maps to a stable Feishu-safe response without exposing internal detection details.
- [ ] Context-overflow and delivery retry behavior cannot re-run a tool after Guardrail-related activity has occurred.
