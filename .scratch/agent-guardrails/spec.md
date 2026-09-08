Status: ready-for-agent

# Agent Guardrails

## Problem Statement

The Agent currently has role-based tool authorization, approval handling, cancellation, hooks, tracing, and channel-specific delivery, but it does not have one coherent Guardrail boundary for validating user input and final Agent output.

This leaves several user-facing risks:

- A malicious or prompt-injected request can reach the model before its intent is classified.
- A semantically unauthorized request may attempt to use an otherwise available tool.
- Sensitive content can be streamed, persisted, traced, or delivered before a final compliance check runs.
- Main Agent, child Agent, CLI, Feishu, and Cron paths can apply different protections and create bypasses.
- A late Guardrail result may cancel the model but cannot undo a tool side effect or retract text that has already been shown.
- Guardrail failures, policy blocks, infrastructure errors, and incomplete cancellation are not represented as distinct runtime outcomes.

The user needs a unified safety boundary that preserves the latency benefit of parallel input checks without allowing tool execution or user-visible output before the request has been approved. The design must fit the existing AI SDK 7-based custom Agent loop rather than replacing it with another Agent framework.

## Solution

Add a native Guardrail subsystem to the existing Agent runtime. It will provide input, tool, and output protection across CLI, Feishu, Cron, main Agent, and child Agent execution.

Input Guardrails will support blocking and parallel modes. In parallel mode, the model may begin generating while Guardrails run, but generated text remains buffered and tool calls wait at the unified execution gate. A passing result releases buffered events and permits tools; a blocking result cancels the run and discards buffered output.

Tool Guardrails will extend the existing authorization, approval, hook, and audit pipeline. Deterministic rules will protect every tool invocation, while model-based semantic checks will be reserved for high-risk operations where rules alone are insufficient.

Output Guardrails will inspect terminal Agent output before it enters normal conversation history or any delivery outbox. Low- and medium-risk output may receive one tool-free repair attempt followed by another check. High- and critical-risk output will be discarded and replaced with a deterministic safe response.

Deterministic hard rules will be enforced immediately. Model-based Guardrails will initially run in Shadow mode and move to enforcement only after the agreed evaluation thresholds are met. Structured errors, events, policy versions, redacted audit data, and bounded Owner review will make Guardrail decisions observable and recoverable without introducing a reusable bypass.

## User Stories

1. As a CLI user, I want malicious or injected requests detected before tools execute, so that my local environment is protected.
2. As a Feishu user, I want unsafe requests blocked consistently with CLI requests, so that changing channels does not bypass policy.
3. As an operator, I want Cron runs protected without assuming unattended execution implies approval, so that scheduled work cannot silently perform unsafe actions.
4. As a main Agent user, I want Guardrails applied at the start and end of each run, so that both my request and the final response are validated.
5. As a parent Agent, I want child Agent tasks checked against the original user intent and delegated task, so that delegation cannot widen authority.
6. As a parent Agent, I want child Agent output checked before it becomes a tool result, so that unsafe content cannot contaminate my context.
7. As a user, I want normal requests to avoid an additional serial model delay, so that Guardrails do not make routine interactions unnecessarily slow.
8. As a security-conscious user, I want text buffered until parallel input checks pass, so that rejected runs reveal no generated content.
9. As a security-conscious user, I want tools held until parallel input checks pass, so that cancellation never has to undo an early side effect.
10. As a user, I want final answers checked before they are displayed, so that secrets or disallowed content are not streamed and retracted too late.
11. As an operator, I want tool activity visible without exposing raw sensitive parameters or results, so that progress remains useful and safe.
12. As an operator, I want deterministic rules evaluated before model classifiers, so that obvious violations fail quickly and predictably.
13. As an operator, I want semantic Guardrails to use structured results, so that policy decisions are machine-readable and testable.
14. As an operator, I want Guardrail results classified by risk category and severity, so that different risks receive appropriate handling.
15. As an operator, I want the categories to include prompt injection, privilege escalation, sensitive data, unsafe action, and policy bypass, so that the main execution risks are distinguishable.
16. As an operator, I want risk severity expressed as low, medium, high, or critical, so that policy aggregation is deterministic.
17. As an operator, I want any blocking result to dominate allowing results, so that permissive checks cannot cancel a safety decision.
18. As an operator, I want hard rules to dominate model judgments, so that probabilistic output cannot weaken deterministic protections.
19. As an operator, I want all already-started semantic checks collected, so that one request produces a complete redacted risk record.
20. As a user, I want blocked requests to receive a clear safe explanation and permitted alternatives, so that I can reformulate legitimate work.
21. As a user, I do not want internal detection rules disclosed in rejection messages, so that attackers cannot tune requests against them.
22. As an operator, I want blocked responses generated from deterministic templates, so that the rejection path does not reintroduce dangerous content.
23. As an operator, I want low-risk review responses optionally rewritten by a restricted model, so that safe guidance can remain natural.
24. As an operator, I want output repair limited to one attempt, so that the system cannot enter an expensive or unsafe repair loop.
25. As an operator, I want output repair to have no tools, so that a compliance rewrite cannot create new side effects.
26. As an Owner, I want to review a likely false positive, so that legitimate work is recoverable.
27. As an Owner, I want approval bound to the request hash, conversation, identity, policy version, and expiry, so that it cannot be replayed.
28. As a non-Owner user, I want no self-service bypass phrase, so that prompt injection cannot manufacture approval.
29. As an operator, I want deterministic prohibitions to remain non-overridable, so that Owner review cannot disable the safety boundary itself.
30. As an operator, I want known-secret matching performed without storing secret plaintext, so that detection does not create another secret database.
31. As an operator, I want common secret formats and sensitive field names detected, so that likely credentials are not emitted.
32. As an operator, I want ordinary opaque IDs distinguished from secrets, so that output Guardrails do not block normal technical results excessively.
33. As an operator, I want custom deterministic rules configurable, so that project-specific sensitive material can be protected.
34. As an operator, I want current input checked with a redacted safety summary rather than the full history, so that checks remain bounded and data-minimal.
35. As an operator, I want previously checked history represented by inherited risk labels, so that old content is not repeatedly sent to classifiers.
36. As an operator, I want Guardrail policy inherited by child Agents and only restrictable further, so that child profiles cannot loosen parent policy.
37. As an operator, I want risk labels and approval constraints propagated to descendants, so that nested delegation retains the original boundary.
38. As an operator, I want Guardrail model settings separate from the main Agent settings, so that cost, latency, and availability can be tuned independently.
39. As an operator, I want the Guardrail model to reuse the current provider by default, so that the first release does not require another vendor.
40. As an operator, I want a short Guardrail timeout, bounded output, and at most one retry, so that classifiers cannot stall Agent work indefinitely.
41. As an operator, I want high-risk classifier failure to fail closed, so that an outage does not permit dangerous work.
42. As a user performing read-only work, I want explicitly configured low-risk failures to degrade with an audit record, so that availability can be preserved safely.
43. As an operator, I want Guardrail model work isolated in its own bounded concurrency pool, so that an attack cannot exhaust the main Agent pool.
44. As an operator, I want queue overflow governed by entry-point risk, so that overload behavior is explicit rather than accidental.
45. As an operator, I want hard rules enabled by default after installation, so that core safety does not depend on an optional switch.
46. As an operator, I want model Guardrails to begin in Shadow mode, so that false positives can be measured before enforcement.
47. As an operator, I want policy configuration validated at startup, so that malformed settings are detected before a run starts.
48. As an operator, I want a hard-rule configuration failure to prevent startup, so that the runtime never silently loses mandatory controls.
49. As an operator, I want an optional model-classifier configuration failure to leave hard rules active and report a degraded state, so that partial protection remains visible.
50. As an operator, I want policy versions included in Guardrail events and traces, so that decisions can be reproduced after configuration changes.
51. As an operator, I want configuration changes to require restart in the first release, so that one run cannot observe multiple policy versions.
52. As an operator, I want Guardrail outcomes distinguished as passed, blocked, review required, timed out, errored, cancelled, or cancellation incomplete, so that incidents are diagnosable.
53. As an operator, I want Tripwire exceptions to carry structured risk details, so that each adapter can map the same decision to its own user experience.
54. As a CLI user, I want a Tripwire mapped to a stable terminal response, so that a policy block is not shown as an unexplained stack trace.
55. As a Feishu user, I want a Tripwire mapped to a safe channel response, so that I know the run was intentionally stopped.
56. As a Cron operator, I want review-required work paused and announced through the configured notification path, so that unsafe work is neither executed nor silently dropped.
57. As an operator, I want cancellation to propagate through model streams, tool gates, and approval waits, so that a blocked run reaches quiescence.
58. As an operator, I want a cancellation convergence timeout, so that stuck providers are reported as incomplete cancellation instead of complete protection.
59. As an operator, I want blocked output excluded from normal conversation history, so that later turns cannot consume unsafe content.
60. As an operator, I want blocked input excluded from normal model context, so that later turns are not contaminated by rejected instructions.
61. As an Owner, I want an isolated pending-review record to recover a specific blocked request, so that normal history remains clean.
62. As an operator, I want audit evidence stored as hashes, redacted summaries, rule identifiers, and metadata, so that investigations do not require raw unsafe content.
63. As an operator, I want Guardrail audit retention bounded by time and capacity, so that sensitive metadata does not grow forever.
64. As an operator, I want detailed audit records retained for 30 days by default, so that recent incidents remain investigable.
65. As an operator, I want expired details reduced to non-sensitive aggregate metrics, so that long-term trends remain available without retaining evidence.
66. As a developer, I want existing successful AgentLoop results to remain compatible, so that current callers do not require a wholesale migration.
67. As a developer, I want optional Guardrail summaries added without replacing existing success fields, so that integrations can adopt the feature incrementally.
68. As a developer, I want dedicated Guardrail events rather than inferring policy from generic failures, so that adapters and tests can respond precisely.
69. As a developer, I want input, tool, and output Guardrails implemented around existing runtime seams, so that the current framework and business contracts remain intact.
70. As a developer, I want synthetic secrets and anonymized attack samples in tests, so that the test suite does not contain production credentials or personal data.
71. As an operator, I want labeled benign and malicious evaluation samples, so that model Guardrail quality can be measured objectively.
72. As an operator, I want critical and high-risk samples to have zero false negatives in the release evaluation set, so that enforcement begins from a strict baseline.
73. As an operator, I want benign false blocks below one percent before enforcement, so that normal use remains practical.
74. As an operator, I want P95 latency and additional token usage measured, so that the cost of protection remains visible.
75. As an operator, I want blocked runs to demonstrate zero tool execution and zero premature output, so that the main safety promises are proven behaviorally.
76. As an operator, I want online Shadow decisions sampled manually before enforcement, so that the offline set is checked against real traffic patterns.

## Implementation Decisions

- Preserve the existing AI SDK 7 custom Agent loop. Do not add or migrate runtime orchestration to `@openai/agents`; adopt its Guardrail concepts within the current architecture.
- Introduce one native Guardrail contract shared by input and output checks. Each result includes a Tripwire decision and optional structured diagnostic information.
- Represent risk separately from the Tripwire decision. A result includes a stable category, severity, policy/rule identifiers, enforcement mode, and redacted evidence suitable for audit.
- Provide dedicated input and output Tripwire error classes. Core runtime code throws these structured errors; CLI, Feishu, Cron, and child-Agent adapters map them to channel-appropriate behavior.
- Keep the existing successful AgentLoop result contract and add only optional Guardrail summary data. Existing callers must continue to work when Guardrails are disabled or pass.
- Use the existing Agent loop as the primary orchestration seam. Guardrail coordination begins before the first model step and output validation completes before the run emits its successful terminal result.
- Input Guardrails support blocking and parallel execution. Parallel is the normal low-latency mode; blocking remains available for high-risk entry points or policies.
- Parallel mode permits the model request to start but does not permit unvalidated effects. Text events are buffered, and tool execution waits on a run-scoped input-approval gate.
- A blocking input result aborts the run-scoped child controller. The run waits for model streaming, tool gating, and pending approvals to settle before reporting the Tripwire.
- Cancellation has a bounded convergence period. Failure to settle is recorded and surfaced as cancellation incomplete rather than falsely reported as fully cancelled.
- The unified tool execution pipeline remains the only tool-body execution boundary. It waits for the run-scoped input gate before authorization, approval, locking, and tool execution can complete.
- Every tool receives deterministic Guardrail checks through the unified execution path. Model-based tool classification is optional and restricted to operations whose risk cannot be decided cheaply and deterministically.
- Existing role authorization and human approval remain authoritative. Guardrails add risk validation and cannot grant a capability denied by the role or permission policy.
- Mandatory non-overridable rules cover known-secret exfiltration, workspace path escape, explicit role-policy bypass, forged approval, attempts to disable the safety pipeline, and unauthorized destructive or external actions.
- Deterministic Guardrails run synchronously before model classifiers. If they pass, independent semantic Guardrails run concurrently. Already-started results are collected for audit and the final decision uses the highest severity.
- A block cannot be cancelled by another Guardrail returning allow. Mandatory hard-rule blocks cannot be overridden.
- Model Guardrails return schema-validated structured output. Invalid structure follows the configured classifier failure policy and is never treated silently as allow.
- The initial semantic taxonomy includes prompt injection, privilege escalation, sensitive data, unsafe action, and policy bypass, with low, medium, high, and critical severities.
- The normalized input view contains current text, safe attachment metadata, source, role, conversation identity, and a redacted inherited safety summary. Binary attachment contents, image analysis, and arbitrary object serialization are not part of the first release.
- Historical messages are checked when they enter the system. Later turns reuse redacted summaries and risk labels instead of resending the full history to Guardrail models.
- Child Agents check both the original user risk context and the delegated task. They inherit parent policies, risk labels, approval restrictions, and mandatory rules, and may only narrow those policies.
- Child Agent terminal output passes an output Guardrail before becoming a parent-visible tool result. The main Agent terminal output receives a second final check before delivery.
- Final answer text is buffered in every channel until output validation succeeds. Intermediate tool names and status may remain live, but tool parameters and results pass deterministic redaction before display.
- Output Guardrails run before normal history persistence, successful trace completion, and delivery-outbox creation. Rejected candidate output is not committed to normal conversation state.
- Low- and medium-risk output may receive one repair attempt. Repair receives only the redacted candidate, risk codes, and constrained rewrite instructions; it has no tools. The repaired result is checked again.
- High- and critical-risk output is discarded immediately and replaced with a deterministic category-specific safe response.
- User-facing block responses explain the broad reason and suggest allowed alternatives without exposing detection prompts, thresholds, patterns, or secret values.
- Blocked input does not enter ordinary model context. A reviewable request is stored only as an isolated pending-review record containing the minimum data necessary for a bound approval flow.
- Owner approval is allowed only for reviewable probabilistic decisions. It is bound to the actor identity, request hash, conversation, policy version, and short expiry. Any change invalidates the approval.
- CLI approval uses an explicit tokenized action rather than natural-language confirmation. Feishu approval uses an identity-bound interactive action. Cron never grants automatic Owner approval and pauses review-required work.
- Known secrets are compared in memory or through irreversible fingerprints. Logs and traces never persist their plaintext. Detection combines known-secret matches, common credential formats, sensitive field names, and project-configured rules.
- Guardrail configuration uses the existing schema-validated configuration system. It defines global baseline policy plus entry-point and Agent-specific tightening overrides; overrides cannot weaken mandatory rules.
- The first release loads policy at startup and does not hot-reload. Every decision records the active policy version.
- Mandatory hard-rule configuration failure prevents startup. Optional semantic-model configuration failure retains mandatory checks and exposes an explicit degraded state.
- Guardrail model configuration is separate from the main Agent configuration but defaults to the current provider. It includes model name, timeout, token budget, retry count, concurrency, queue size, and failure behavior.
- Initial semantic limits are a three-second per-check timeout, one retry at most, and approximately 300 output tokens for structured classification. These defaults remain configurable and are tuned using traces.
- High-risk timeout, unavailable-model, and invalid-output cases fail closed. Explicitly classified low-risk read-only paths may use an audited fail-open policy.
- Guardrail model calls use a separate bounded concurrency pool and queue. Queue overflow follows the entry-point risk policy rather than consuming unlimited resources.
- Deterministic hard rules are enabled by default. Semantic Guardrails start in Shadow mode and do not block until promoted using the agreed evaluation gate.
- Guardrail audit records include outcome, category, severity, rule identifier, policy version, entry point, timing, request hash, redacted evidence, approval state, and cancellation state.
- Audit storage is bounded by retention and capacity. Detailed records default to 30 days; expiry retains only non-sensitive aggregates.
- Guardrail-aware traces distinguish passed, blocked, review required, timed out, errored, cancelled, and cancellation incomplete outcomes.
- Local CLI, Feishu Channel, Cron, main Agent, and child Agent all consume the same core decisions. Adapter-specific responses must not reimplement or weaken policy.

## Testing Decisions

- Test externally observable safety behavior rather than private implementation details. Tests should assert whether the model started, whether events became visible, whether a tool body executed, what entered conversation state, what was delivered, and which structured outcome the caller received.
- Prefer the existing AgentLoop test seam as the highest common seam. Mock language models, a real ToolRegistry, run-scoped cancellation, and captured typed events can exercise input coordination, buffered output, tool gating, terminal output validation, and result compatibility together.
- Use the existing unified tool execution pipeline seam for focused policy tests that require exact authorization, approval, Guardrail ordering, locking, cancellation, and audit outcomes.
- Use the existing Channel Gateway/store seam for tests covering atomic message persistence, outbox delivery, retries, blocked turns, and Feishu-facing behavior.
- Use the existing child-Agent registry/spawn seam for inheritance, delegated-input validation, output validation before parent consumption, timeout, and cancellation behavior.
- Use configuration-loader tests for schema defaults, mandatory-rule validation, non-weakening overrides, policy versions, degraded optional classifiers, and invalid startup states.
- Preserve prior AgentLoop behavioral tests as compatibility coverage for Guardrail-disabled and all-passing runs.
- Verify blocking input mode does not call the main model when a Guardrail trips.
- Verify parallel input mode may start the model but emits no text, executes no tool body, and persists no assistant output before the Guardrail passes.
- Verify a passing parallel Guardrail releases buffered events in their original order and allows the queued tool call exactly once.
- Verify a blocking parallel Guardrail aborts the model, rejects the tool gate, discards buffered text, and reports the structured input Tripwire.
- Verify cancellation during Guardrail classification, model streaming, tool gating, and approval waiting reaches a settled terminal state.
- Inject a non-cooperative model or check to verify the cancellation-convergence timeout reports cancellation incomplete.
- Verify deterministic rules run before semantic classifiers and avoid unnecessary model calls when they block.
- Verify concurrent semantic checks aggregate completed results and select the highest-severity outcome.
- Verify an allow result cannot override a block and a child override cannot weaken parent or mandatory policy.
- Verify every registered tool path reaches the unified Guardrail execution boundary, including dynamically discovered tools and child-Agent spawning.
- Verify blocked tool invocations do not acquire a destructive execution lock or call the tool body.
- Verify tool status remains observable while raw secret-bearing parameters and outputs are redacted.
- Verify output text remains invisible and undelivered until the final output Guardrail passes.
- Verify rejected final output never enters normal conversation history, successful trace output, or a channel outbox.
- Verify one low-risk repair can pass and be delivered, a failed repair is not retried again, and repair has no tools.
- Verify high- and critical-risk output skips repair and returns the deterministic safe template.
- Verify child output is checked before becoming a parent tool result and main output is checked independently afterward.
- Verify blocked input remains outside normal history while a reviewable request creates only a minimal isolated record.
- Verify an Owner approval works only for the exact actor, conversation, request hash, policy version, and unexpired approval.
- Verify replay, altered requests, expired approvals, non-Owner actions, and mandatory-rule overrides are rejected.
- Verify Cron review-required runs pause, notify, and do not automatically retry or execute tools.
- Verify classifier timeout, unavailable model, invalid schema, retry exhaustion, queue overflow, and degraded configuration follow their configured fail-open or fail-closed behavior.
- Verify known-secret matching and audit redaction using synthetic credentials only. No real credential, personal datum, or raw production attack sample may enter fixtures.
- Maintain a labeled evaluation corpus containing benign requests, direct attacks, indirect prompt injection, privilege escalation, sensitive-data requests, dangerous tools, delegated bypass attempts, and false-positive edge cases.
- Before semantic enforcement, require zero false negatives for critical/high samples in the release corpus and less than one percent false blocks for benign samples.
- Record P95 Guardrail latency, added model tokens, cancellation success, premature-output count, and post-block tool execution count during evaluation.
- Require zero premature output and zero post-block tool execution in automated tests and sampled Shadow observations.
- Treat local automated verification as evidence for runtime contracts only. Real provider behavior, Feishu interactive approval, production latency, and real-traffic false-positive rates require separate external acceptance.

## Out of Scope

- Replacing the existing AI SDK 7 Agent loop with the OpenAI Agents SDK or another orchestration framework.
- Building a general-purpose moderation platform for every category of harmful, illegal, adult, or political content.
- Image understanding, audio moderation, OCR, or inspection of full binary attachment contents in the first release.
- A web-based policy administration console or remote policy service.
- Runtime hot reload of Guardrail policies.
- Permanent or reusable user bypasses.
- Allowing mandatory deterministic safety rules to be overridden.
- Unlimited output-repair retries or tool-enabled repair Agents.
- Persisting raw blocked prompts, raw rejected output, plaintext known secrets, or unredacted production incidents in audit records or test fixtures.
- Guaranteeing rollback of external side effects that completed outside the Guardrail boundary.
- Claiming real provider, Feishu, or production acceptance from mocked or local tests alone.

## Further Notes

- The design intentionally separates latency optimization from safety guarantees. Parallel model generation is acceptable only because user-visible output and tool execution remain gated.
- Input and output Guardrails do not replace role authorization, tool approval, path containment, or other deterministic execution controls. These layers reinforce one another.
- The repository already carries unrelated dependency and skill-installation changes. Guardrail implementation must preserve those changes and stage only explicitly authorized files if later committed.
- The first implementation should favor a small number of high-level seams: AgentLoop for orchestration, the unified tool pipeline for effects, and Channel Gateway/store for durable delivery. New lower-level seams should be added only where fault injection cannot be expressed through these existing boundaries.
- The semantic enforcement gate is deliberately strict. The initial corpus can be modest, but high-risk misses, output-before-check, and tool-after-block are release blockers.
