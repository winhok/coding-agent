import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GuardrailConfigSchema } from "../../src/config/schema.ts";
import { GuardrailAuditStore } from "../../src/guardrails/audit.ts";
import {
  SemanticGuardrailResultSchema,
  SemanticGuardrailRunner,
} from "../../src/guardrails/semantic.ts";
import { GuardrailService } from "../../src/guardrails/service.ts";
import { InputTripwireError } from "../../src/guardrails/types.ts";

describe("semantic guardrail shadow runner", () => {
  it("provides bounded Shadow defaults", () => {
    const config = GuardrailConfigSchema.parse({});

    assert.deepEqual(config.semantic, {
      enabled: true,
      mode: "shadow",
      model: "",
      baseURL: "",
      apiKey: "",
      timeoutMs: 3_000,
      maxOutputTokens: 300,
      retries: 1,
      concurrency: 2,
      queueSize: 100,
    });
  });

  it("validates classifier output against agreed categories and severities", () => {
    assert.equal(
      SemanticGuardrailResultSchema.safeParse({
        tripwire: true,
        category: "prompt_injection",
        severity: "high",
        ruleId: "SEM-INJECTION",
      }).success,
      true,
    );
    assert.equal(
      SemanticGuardrailResultSchema.safeParse({
        tripwire: true,
        category: "unknown",
        severity: "severe",
        ruleId: "bad",
      }).success,
      false,
    );
  });

  it("runs independent checks concurrently, retains results, and aggregates the highest severity", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let started = 0;
    const runner = new SemanticGuardrailRunner({
      mode: "shadow",
      timeoutMs: 1_000,
      maxOutputTokens: 300,
      retries: 0,
      concurrency: 2,
      queueSize: 10,
      classifiers: [
        {
          id: "injection",
          classify: async () => {
            started++;
            return first.promise;
          },
        },
        {
          id: "exfiltration",
          classify: async () => {
            started++;
            return second.promise;
          },
        },
      ],
    });
    const resultPromise = runner.evaluate("benign-looking request");

    await waitUntil(() => started === 2);
    first.resolve({
      tripwire: false,
      category: "prompt_injection",
      severity: "low",
      ruleId: "SEM-INJECTION",
    });
    second.resolve({
      tripwire: true,
      category: "sensitive_data",
      severity: "critical",
      ruleId: "SEM-EXFILTRATION",
    });
    const result = await resultPromise;

    assert.equal(result.outcome, "would_block");
    assert.equal(result.highestSeverity, "critical");
    assert.deepEqual(
      result.checks.map((check) => check.id),
      ["injection", "exfiltration"],
    );
    assert.equal(
      result.checks.every((check) => check.status === "completed"),
      true,
    );
  });

  it("runs deterministic rules first and keeps Shadow decisions non-blocking", async () => {
    let classifierCalls = 0;
    const runner = new SemanticGuardrailRunner({
      mode: "shadow",
      timeoutMs: 100,
      maxOutputTokens: 300,
      retries: 0,
      concurrency: 1,
      queueSize: 1,
      classifiers: [
        {
          id: "semantic",
          classify: async () => {
            classifierCalls++;
            return {
              tripwire: true,
              category: "prompt_injection",
              severity: "high",
              ruleId: "SEM-TEST",
            };
          },
        },
      ],
    });
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
      semantic: runner,
    });

    await assert.rejects(
      service.checkInputWithSemantic(
        { text: "bypass guardrails", source: "cli", role: "owner" },
        new AbortController().signal,
      ),
      InputTripwireError,
    );
    assert.equal(classifierCalls, 0);

    const decision = await service.checkInputWithSemantic(
      { text: "summarize this file", source: "cli", role: "owner" },
      new AbortController().signal,
    );
    assert.equal(classifierCalls, 1);
    assert.equal(decision?.outcome, "passed");
    assert.equal(decision?.semantic?.outcome, "would_block");
  });

  it("reports an unavailable optional classifier while retaining hard rules", async () => {
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
      semanticUnavailableReason: "invalid semantic model configuration",
    });

    const decision = await service.checkInputWithSemantic(
      { text: "summarize this file", source: "cli", role: "owner" },
      new AbortController().signal,
    );

    assert.equal(decision?.outcome, "passed");
    assert.equal(decision?.semantic?.outcome, "unavailable");
    await assert.rejects(
      service.checkInputWithSemantic(
        { text: "bypass guardrails", source: "cli", role: "owner" },
        new AbortController().signal,
      ),
      InputTripwireError,
    );
  });

  it("distinguishes timeout, malformed output, provider failure, retry exhaustion, and queue overflow", async () => {
    const timeout = runnerFor(async () => new Promise(() => {}), {
      timeoutMs: 5,
      retries: 1,
    });
    const timedOut = await timeout.evaluate("test");
    assert.equal(timedOut.outcome, "timed_out");
    assert.equal(timedOut.checks[0]?.attempts, 2);

    const malformed = await runnerFor(async () => ({ nope: true }), {
      retries: 1,
    }).evaluate("test");
    assert.equal(malformed.outcome, "malformed");
    assert.equal(malformed.checks[0]?.attempts, 2);

    const providerFailure = await runnerFor(async () => {
      throw new Error("provider unavailable");
    }).evaluate("test");
    assert.equal(providerFailure.outcome, "errored");

    const held = deferred<unknown>();
    const queued = runnerFor(async () => held.promise, {
      concurrency: 1,
      queueSize: 0,
    });
    const active = queued.evaluate("first");
    await Promise.resolve();
    const overflow = await queued.evaluate("second");
    assert.equal(overflow.outcome, "queue_overflow");
    held.resolve({
      tripwire: false,
      category: "prompt_injection",
      severity: "low",
      ruleId: "SEM-OK",
    });
    await active;
  });

  it("settles tracked Shadow observations before runtime shutdown", async () => {
    const result = deferred<unknown>();
    const audit = new GuardrailAuditStore();
    const runner = runnerFor(async () => result.promise);
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit,
      semantic: runner,
    });
    const input = {
      text: "summarize",
      source: "cli" as const,
      role: "owner" as const,
    };
    const deterministic = service.checkInput(input);
    assert.ok(deterministic);
    service.observeSemanticInput(
      input,
      deterministic,
      new AbortController().signal,
    );
    const settled = service.settleSemanticObservations();
    result.resolve({
      tripwire: false,
      category: "prompt_injection",
      severity: "low",
      ruleId: "SEM-PASS",
    });
    await settled;

    assert.equal(
      audit.list().some((record) => record.semantic?.mode === "shadow"),
      true,
    );
  });
});

function runnerFor(
  classify: () => Promise<unknown>,
  overrides: Partial<{
    timeoutMs: number;
    retries: number;
    concurrency: number;
    queueSize: number;
  }> = {},
) {
  return new SemanticGuardrailRunner({
    mode: "shadow",
    timeoutMs: overrides.timeoutMs ?? 100,
    maxOutputTokens: 300,
    retries: overrides.retries ?? 0,
    concurrency: overrides.concurrency ?? 1,
    queueSize: overrides.queueSize ?? 1,
    classifiers: [{ id: "test", classify }],
  });
}

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
