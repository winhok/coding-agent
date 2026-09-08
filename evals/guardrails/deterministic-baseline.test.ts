import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { GuardrailAuditStore } from "../../src/guardrails/audit.ts";
import {
  evaluateGuardrailCorpus,
  loadGuardrailCorpus,
} from "../../src/guardrails/evaluation.ts";
import { GuardrailService } from "../../src/guardrails/service.ts";
import { InputTripwireError } from "../../src/guardrails/types.ts";

test("deterministic baseline reports gaps without claiming promotion eligibility", async () => {
  const corpus = loadGuardrailCorpus(
    path.resolve("evals/guardrails/corpus.json"),
  );
  const service = new GuardrailService({
    enabled: true,
    policyVersion: "eval-v1",
    audit: new GuardrailAuditStore(),
  });
  const report = await evaluateGuardrailCorpus({
    corpus,
    policyVersion: "eval-v1",
    classifierConfig: { type: "deterministic-baseline", version: 1 },
    classify: async (sample) => {
      const startedAt = performance.now();
      let blocked = false;
      try {
        service.checkInput({ text: sample.text, source: "cli", role: "owner" });
      } catch (error) {
        if (!(error instanceof InputTripwireError)) throw error;
        blocked = true;
      }
      return {
        blocked,
        latencyMs: Math.max(0, performance.now() - startedAt),
        addedTokens: 0,
      };
    },
    runtimeEvidence: {
      cancellationAttempts: 0,
      cancellationSuccesses: 0,
      prematureOutputCount: 0,
      postBlockToolExecutions: 0,
    },
  });

  assert.equal(report.metrics.criticalHighFalseNegatives > 0, true);
  assert.equal(report.metrics.prematureOutputCount, 0);
  assert.equal(report.metrics.postBlockToolExecutions, 0);
  assert.equal(report.eligibleForEnforcement, false);
  assert.deepEqual(report.verification, {
    localRuntime: true,
    provider: false,
    feishu: false,
    production: false,
  });
});
