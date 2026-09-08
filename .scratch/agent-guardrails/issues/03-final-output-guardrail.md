# 03: Final output Guardrail and safe replacement

**What to build:** Validate terminal CLI output before it is displayed, persisted, or marked successful. Sensitive or prohibited output is discarded and replaced by a deterministic category-specific response.

**Blocked by:** 02: Parallel input check and effect-release gate.

**Status:** ready-for-agent

- [ ] Final answer text remains buffered until every applicable output Guardrail passes.
- [ ] Known synthetic secrets, common credential formats, and configured sensitive fields are detected without persisting secret plaintext.
- [ ] High- and critical-risk candidate output is discarded without a repair attempt and replaced with a safe deterministic message.
- [ ] Rejected candidate output never enters normal conversation history, successful trace output, or a user-visible stream.
- [ ] Passing output is released once with unchanged content and preserves existing successful-run behavior.
- [ ] Output Tripwires are distinguishable from generic model or runtime failures.
