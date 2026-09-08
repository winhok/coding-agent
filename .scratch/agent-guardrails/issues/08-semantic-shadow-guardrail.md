# 08: Semantic Guardrail in Shadow mode

**What to build:** Add an independently configured model classifier that returns schema-validated risk results, runs within bounded resources, aggregates concurrent checks, and records Shadow decisions without blocking user work by default.

**Blocked by:** 01: Deterministic CLI input Guardrail.

**Status:** ready-for-agent

- [ ] Semantic Guardrails default to the current provider but support an independent model, timeout, token budget, retry, concurrency, and queue configuration.
- [ ] Initial defaults bound a check to three seconds, one retry at most, and approximately 300 output tokens.
- [ ] Classifier output is schema validated and uses the agreed categories and severities.
- [ ] Independent semantic checks run concurrently, completed results are retained, and the aggregate decision uses the highest severity.
- [ ] Mandatory deterministic rules run first and avoid unnecessary classifier calls when they block.
- [ ] Shadow mode records what would have happened without altering successful model, tool, output, or delivery behavior.
- [ ] Optional classifier misconfiguration leaves hard rules active and reports a model-Guardrail-unavailable state.
- [ ] Timeout, malformed output, provider failure, retry exhaustion, and queue overflow follow explicit risk-based failure policies.
