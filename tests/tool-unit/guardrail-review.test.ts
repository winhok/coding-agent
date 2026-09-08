import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommandContext } from "../../src/commands/index.ts";
import { createSecurityCommands } from "../../src/commands/security.ts";
import { OwnerReviewManager } from "../../src/guardrails/review.ts";
import type { GuardrailDecision } from "../../src/guardrails/types.ts";
import { HookPipeline } from "../../src/security/hooks.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

describe("owner guardrail review", () => {
  it("binds approval and one-time consumption to actor, conversation, request, policy, and expiry", () => {
    let now = 1_000;
    const reviews = new OwnerReviewManager({ ttlMs: 100, now: () => now });
    const binding = {
      actorId: "owner-1",
      conversationId: "conversation-1",
      requestHash: "request-1",
      policyVersion: "policy-1",
    };
    const review = reviews.create(reviewableDecision(), binding);

    assert.equal(
      reviews.approve(review.token, { ...binding, actorId: "not-owner" }),
      false,
    );
    assert.equal(
      reviews.approve(review.token, {
        ...binding,
        conversationId: "conversation-2",
      }),
      false,
    );
    assert.equal(
      reviews.approve(review.token, { ...binding, policyVersion: "policy-2" }),
      false,
    );
    assert.equal(reviews.approve(review.token, binding), true);
    assert.equal(
      reviews.consume(review.token, { ...binding, requestHash: "altered" }),
      false,
    );
    assert.equal(reviews.consume(review.token, binding), true);
    assert.equal(reviews.consume(review.token, binding), false);

    const expired = reviews.create(reviewableDecision(), binding);
    now = 1_101;
    assert.equal(reviews.approve(expired.token, binding), false);
  });

  it("does not create reviews for mandatory, high, or critical findings", () => {
    const reviews = new OwnerReviewManager();
    const binding = {
      actorId: "owner",
      conversationId: "conversation",
      requestHash: "request",
      policyVersion: "policy",
    };

    assert.throws(() => reviews.create(decision("medium", true), binding));
    assert.throws(() => reviews.create(decision("high", false), binding));
    assert.throws(() => reviews.create(decision("critical", false), binding));
  });

  it("requires an explicit tokenized CLI action from the Owner", () => {
    const reviews = new OwnerReviewManager();
    const registry = new ToolRegistry();
    const binding = {
      actorId: "cli:session",
      conversationId: "session",
      requestHash: "request-1",
      policyVersion: "policy-1",
    };
    const first = reviews.create(reviewableDecision(), binding);
    const handlers = createSecurityCommands(registry, new HookPipeline(), {
      manager: reviews,
      actorId: binding.actorId,
      conversationId: binding.conversationId,
      policyVersion: binding.policyVersion,
    });

    assert.equal(
      handlers.some(
        (handler) =>
          handler(`/guardrail approve ${first.token}`, {} as CommandContext) ===
          true,
      ),
      true,
    );
    assert.equal(reviews.consume(first.token, binding), true);

    const denied = reviews.create(reviewableDecision(), binding);
    registry.setRole("collaborator");
    handlers.some((handler) =>
      handler(`/guardrail approve ${denied.token}`, {} as CommandContext),
    );
    assert.equal(reviews.consume(denied.token, binding), false);
  });
});

function reviewableDecision(): GuardrailDecision {
  return decision("medium", false);
}

function decision(
  severity: "medium" | "high" | "critical",
  mandatory: boolean,
): GuardrailDecision {
  return {
    outcome: "blocked",
    policyVersion: "policy-1",
    requestHash: "request-1",
    durationMs: 1,
    findings: [
      {
        category: "sensitive_data",
        severity,
        ruleId: "TEST",
        evidence: "[redacted]",
        mandatory,
      },
    ],
  };
}
