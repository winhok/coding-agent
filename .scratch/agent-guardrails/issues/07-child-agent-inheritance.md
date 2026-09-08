# 07: Child Agent policy inheritance and checked return

**What to build:** Carry the original user risk context into delegated work, prevent child profiles from weakening parent policy, and check child output before it becomes a parent-visible tool result.

**Blocked by:** 03: Final output Guardrail and safe replacement; 04: Unified tool Guardrail and activity redaction.

**Status:** ready-for-agent

- [ ] A child run checks both inherited user risk context and the delegated task.
- [ ] Child policy can narrow but cannot widen the parent policy, mandatory rules, risk labels, or approval constraints.
- [ ] Nested descendants retain the same non-weakening invariant.
- [ ] A blocked child executes no tool and returns a redacted structured failure rather than unsafe partial text.
- [ ] Child terminal output passes an output Guardrail before it becomes a parent tool result.
- [ ] Main Agent terminal output is checked independently after consuming safe child results.
- [ ] Parent cancellation and child timeout continue to settle pending Guardrail, model, tool, and approval work.
