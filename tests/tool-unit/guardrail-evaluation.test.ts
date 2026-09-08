import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type AgentEvent, agentLoop } from "../../src/agent/loop.ts";
import { GuardrailConfigSchema } from "../../src/config/schema.ts";
import { GuardrailAuditStore } from "../../src/guardrails/audit.ts";
import {
  evaluateGuardrailCorpus,
  loadGuardrailCorpus,
  promotionReportHash,
  validatePromotionEvidence,
  validatePromotionReport,
} from "../../src/guardrails/evaluation.ts";
import { SemanticGuardrailRunner } from "../../src/guardrails/semantic.ts";
import { GuardrailService } from "../../src/guardrails/service.ts";
import { InputTripwireError } from "../../src/guardrails/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createTestRunContext } from "../helpers.ts";

const CORPUS = path.resolve("evals/guardrails/corpus.json");

describe("guardrail evaluation and enforcement gate", () => {
  it("loads a synthetic corpus covering required attack and false-positive classes", () => {
    const corpus = loadGuardrailCorpus(CORPUS);

    assert.equal(
      corpus.every((sample) => !/real[_-]?secret/i.test(sample.text)),
      true,
    );
    assert.deepEqual(
      new Set(corpus.flatMap((sample) => sample.category ?? [])),
      new Set([
        "prompt_injection",
        "privilege_escalation",
        "sensitive_data",
        "unsafe_action",
        "policy_bypass",
      ]),
    );
    assert.equal(
      corpus.some((sample) => sample.id === "indirect-injection"),
      true,
    );
    assert.equal(
      corpus.some((sample) => sample.id === "delegated-bypass"),
      true,
    );
    assert.equal(
      corpus.filter((sample) => sample.label === "benign").length >= 5,
      true,
    );
  });

  it("produces an eligible report only at the agreed safety thresholds", async () => {
    const corpus = loadGuardrailCorpus(CORPUS);
    const report = await evaluateGuardrailCorpus({
      corpus,
      policyVersion: "test-v1",
      classifierConfig: { model: "test-classifier", promptVersion: 1 },
      classify: async (sample) => ({
        blocked: sample.expectedBlock,
        latencyMs: sample.expectedBlock ? 12 : 5,
        addedTokens: 20,
      }),
      runtimeEvidence: {
        cancellationAttempts: 4,
        cancellationSuccesses: 4,
        prematureOutputCount: 0,
        postBlockToolExecutions: 0,
      },
    });

    assert.equal(report.metrics.criticalHighFalseNegatives, 0);
    assert.equal(report.metrics.benignFalseBlockRate, 0);
    assert.equal(report.metrics.p95LatencyMs, 12);
    assert.equal(report.metrics.prematureOutputCount, 0);
    assert.equal(report.metrics.postBlockToolExecutions, 0);
    assert.equal(report.eligibleForEnforcement, true);
    assert.deepEqual(report.verification, {
      localRuntime: true,
      provider: false,
      feishu: false,
      production: false,
    });
    assert.equal(validatePromotionReport(report).success, true);

    const unsafe = {
      ...report,
      metrics: { ...report.metrics, criticalHighFalseNegatives: 1 },
      eligibleForEnforcement: true,
    };
    assert.equal(validatePromotionReport(unsafe).success, false);
  });

  it("binds enforcement to an explicit validated report path and hash", async () => {
    assert.equal(
      GuardrailConfigSchema.safeParse({ semantic: { mode: "enforce" } })
        .success,
      false,
    );
    const corpus = loadGuardrailCorpus(CORPUS);
    const report = await evaluateGuardrailCorpus({
      corpus,
      policyVersion: "test-v1",
      classifierConfig: { model: "test-classifier", promptVersion: 1 },
      classify: async (sample) => ({
        blocked: sample.expectedBlock,
        latencyMs: 1,
        addedTokens: 1,
      }),
      runtimeEvidence: {
        cancellationAttempts: 1,
        cancellationSuccesses: 1,
        prematureOutputCount: 0,
        postBlockToolExecutions: 0,
      },
    });
    const directory = mkdtempSync(path.join(tmpdir(), "guardrail-promotion-"));
    const reportFile = path.join(directory, "report.json");
    writeFileSync(reportFile, JSON.stringify(report));
    const sha256 = promotionReportHash(reportFile);

    assert.equal(
      validatePromotionEvidence({
        reportFile,
        sha256,
        policyVersion: "test-v1",
        corpusFile: CORPUS,
        classifierConfig: { model: "test-classifier", promptVersion: 1 },
      }).eligibleForEnforcement,
      true,
    );
    assert.throws(() =>
      validatePromotionEvidence({
        reportFile,
        sha256: "0".repeat(64),
        policyVersion: "test-v1",
        corpusFile: CORPUS,
        classifierConfig: { model: "test-classifier", promptVersion: 1 },
      }),
    );
    assert.throws(() =>
      validatePromotionEvidence({
        reportFile,
        sha256,
        policyVersion: "test-v1",
        corpusFile: CORPUS,
        classifierConfig: { model: "different-classifier", promptVersion: 1 },
      }),
    );
    assert.equal(
      GuardrailConfigSchema.safeParse({
        semantic: {
          mode: "enforce",
          promotionReport: { path: reportFile, corpusPath: CORPUS, sha256 },
        },
      }).success,
      true,
    );
    assert.equal(
      GuardrailConfigSchema.safeParse({
        mandatoryRules: false,
        semantic: {
          mode: "enforce",
          promotionReport: { path: reportFile, corpusPath: CORPUS, sha256 },
        },
      }).success,
      false,
    );
  });

  it("turns a promoted semantic tripwire into an enforced input block", async () => {
    const semantic = new SemanticGuardrailRunner({
      mode: "enforce",
      timeoutMs: 100,
      maxOutputTokens: 300,
      retries: 0,
      concurrency: 1,
      queueSize: 1,
      classifiers: [
        {
          id: "enforced",
          classify: async () => ({
            tripwire: true,
            category: "prompt_injection",
            severity: "high",
            ruleId: "SEM-ENFORCED",
          }),
        },
      ],
    });
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
      semantic,
    });

    const decision = await service.checkInputWithSemantic(
      { text: "subtle attack", source: "cli", role: "owner" },
      new AbortController().signal,
    );

    assert.equal(decision?.outcome, "blocked");
    assert.equal(decision?.findings[0]?.mandatory, false);
    assert.equal(decision?.semantic?.enforcement, "blocked");
  });

  it("enforced semantic blocking produces no premature output or post-block tool execution", async () => {
    const classifier = deferred<unknown>();
    let modelStarted = false;
    let toolExecuted = false;
    const events: AgentEvent[] = [];
    const semantic = new SemanticGuardrailRunner({
      mode: "enforce",
      timeoutMs: 1_000,
      maxOutputTokens: 300,
      retries: 0,
      concurrency: 1,
      queueSize: 1,
      classifiers: [
        { id: "enforced", classify: async () => classifier.promise },
      ],
    });
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
      semantic,
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "mutate",
      description: "mutate",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => {
        toolExecuted = true;
        return "mutated";
      },
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelStarted = true;
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: "mutate-1",
                toolName: "mutate",
                input: "{}",
              },
              {
                type: "finish" as const,
                finishReason: {
                  unified: "tool-calls" as const,
                  raw: undefined,
                },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              },
            ],
          }),
        };
      },
    });
    const input = {
      text: "subtle request",
      source: "cli" as const,
      role: "owner" as const,
    };
    const run = agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: input.text }],
      system: "test",
      runContext: createTestRunContext(registry),
      inputGuardrail: {
        mode: "parallel",
        check: (signal) => service.checkInputWithSemantic(input, signal),
      },
      eventSink: (event) => {
        events.push(event);
      },
    });

    await waitUntil(() => modelStarted);
    classifier.resolve({
      tripwire: true,
      category: "prompt_injection",
      severity: "high",
      ruleId: "SEM-ENFORCED",
    });
    await assert.rejects(run, InputTripwireError);

    assert.equal(toolExecuted, false);
    assert.equal(
      events.some((event) => event.type === "text_delta"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "tool_started"),
      false,
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not met");
}
