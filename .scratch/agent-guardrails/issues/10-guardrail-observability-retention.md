# 10: Guardrail observability, retention, and terminal states

**What to build:** Make Guardrail behavior diagnosable across every entry point through consistent events, traces, audit records, retention, and explicit failure or cancellation outcomes.

**Blocked by:** 05: Feishu atomic Guardrail storage and delivery; 06: Cron unattended Guardrail behavior; 07: Child Agent policy inheritance and checked return; 08: Semantic Guardrail in Shadow mode; 09: Bounded output repair and Owner review.

**Status:** ready-for-agent

- [ ] CLI, Feishu, Cron, main Agent, and child Agent report passed, blocked, review required, timed out, errored, cancelled, and cancellation-incomplete outcomes consistently.
- [ ] Events and traces identify the Guardrail stage, category, severity, rule, enforcement mode, policy version, timing, and redacted result.
- [ ] Audit records contain request hashes and minimum necessary metadata without raw blocked input, rejected output, or plaintext secrets.
- [ ] Detailed audit retention defaults to 30 days and is bounded by capacity.
- [ ] Expiry removes detailed evidence while preserving only non-sensitive aggregate metrics.
- [ ] Storage or trace failures cannot silently convert a block into an allow.
- [ ] Operators can distinguish a policy decision from classifier infrastructure failure and incomplete cancellation.
