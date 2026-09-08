# 06: Cron unattended Guardrail behavior

**What to build:** Protect scheduled Agent runs with the same Guardrail policy while treating the lack of an interactive user as no approval. Blocked or review-required work remains inactive and produces an operator-visible notification.

**Blocked by:** 03: Final output Guardrail and safe replacement; 04: Unified tool Guardrail and activity redaction.

**Status:** ready-for-agent

- [ ] Cron cannot infer Owner approval from unattended execution or from prompt text.
- [ ] Mandatory blocks execute no tool and emit a redacted, category-specific notification.
- [ ] Review-required runs pause with a stable state instead of executing, failing as a generic error, or automatically retrying dangerous work.
- [ ] Passing scheduled runs preserve their existing execution and notification behavior.
- [ ] Output is checked before notification and prohibited candidate text is never delivered.
- [ ] Restart and retry behavior does not duplicate a blocked, paused, or previously completed side effect.
