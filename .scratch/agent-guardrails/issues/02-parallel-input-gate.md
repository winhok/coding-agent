# 02: Parallel input check and effect-release gate

**What to build:** Allow input Guardrails and the main model to start concurrently while holding generated text and tool effects until the request passes. A block cancels the run, discards buffered output, and waits for the model, tool gate, and approval work to settle.

**Blocked by:** 01: Deterministic CLI input Guardrail.

**Status:** ready-for-agent

- [ ] Blocking mode completes Guardrails before starting the main model.
- [ ] Parallel mode may start the model immediately but exposes no text and executes no tool body before Guardrails pass.
- [ ] Passing checks release buffered events in their original order and allow each queued tool call exactly once.
- [ ] A Tripwire aborts model streaming, rejects queued tool work, discards buffered text, and produces one structured terminal outcome.
- [ ] Cancellation propagates through classification, streaming, the tool gate, and approval waits without leaving later approvals stalled.
- [ ] A non-cooperative dependency is bounded by a convergence timeout and reported as cancellation incomplete rather than successfully cancelled.
