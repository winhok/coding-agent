import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type AgentEvent, agentLoop } from "../../src/agent/loop.ts";
import { GuardrailAuditStore } from "../../src/guardrails/audit.ts";
import { SemanticGuardrailRunner } from "../../src/guardrails/semantic.ts";
import { GuardrailService } from "../../src/guardrails/service.ts";
import type { GuardrailDecision } from "../../src/guardrails/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { LocalTraceRecorder } from "../../src/trace/recorder.ts";
import { createTestRunContext } from "../helpers.ts";

describe("guardrail observability and retention", () => {
  it("removes expired and over-capacity details while retaining aggregate metrics", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guardrail-retention-"));
    const file = path.join(directory, "audit.jsonl");
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new GuardrailAuditStore(file, 2, 100, () => now);

    store.append(subject("first"), decision("first", "passed"));
    now += 50;
    store.append(subject("second"), decision("second", "blocked"));
    now += 60;
    store.append(subject("third"), decision("third", "passed"));

    assert.deepEqual(
      store.list().map((record) => record.requestHash),
      ["second", "third"],
    );
    assert.equal(store.getMetrics().expiredDetails, 1);
    assert.equal(store.getMetrics().byOutcome.passed, 1);
    assert.doesNotMatch(readFileSync(file, "utf8"), /"requestHash":"first"/);

    store.append(subject("fourth"), decision("fourth", "passed"));
    assert.deepEqual(
      store.list().map((record) => record.requestHash),
      ["third", "fourth"],
    );
    assert.equal(store.getMetrics().expiredDetails, 2);
  });

  it("emits and traces redacted output decisions with stable metadata", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guardrail-events-"));
    const trace = await LocalTraceRecorder.start({
      directory,
      sessionId: "guardrail-events",
      model: "mock",
    });
    const events: AgentEvent[] = [];
    const registry = new ToolRegistry();
    const result = await agentLoop({
      model: textModel("synthetic rejected content"),
      registry,
      messages: [{ role: "user", content: "test" }],
      system: "test",
      runContext: createTestRunContext(registry),
      outputGuardrail: {
        check: async () => decision("output-hash", "blocked"),
        replacement: () => "safe replacement",
      },
      eventSink: (event) => {
        events.push(event);
      },
      trace,
    });

    assert.equal(result.text, "safe replacement");
    const guardrailEvent = events.find(
      (event) => event.type === "guardrail_decision",
    );
    assert.deepEqual(guardrailEvent, {
      type: "guardrail_decision",
      stage: "output",
      outcome: "blocked",
      category: "sensitive_data",
      severity: "critical",
      ruleId: "TEST-RULE",
      enforcementMode: "enforce",
      policyVersion: "test-v1",
      durationMs: 1,
      result: "[redacted:sensitive_data]",
    });
    const traceText = readFileSync(trace.filePath, "utf8");
    assert.match(traceText, /"type":"guardrail_decision"/);
    assert.match(traceText, /"stage":"output"/);
    assert.doesNotMatch(traceText, /synthetic rejected content/);
  });

  it("fails closed when audit storage cannot persist a decision", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "guardrail-fail-closed-"),
    );
    const invalid = path.join(directory, "parent-file");
    writeFileSync(invalid, "not a directory");
    const store = new GuardrailAuditStore(path.join(invalid, "audit.jsonl"));

    assert.throws(() =>
      store.append(subject("blocked"), decision("blocked", "blocked")),
    );
  });

  it("records consistent terminal outcomes for every runtime surface", () => {
    const store = new GuardrailAuditStore();
    const outcomes = [
      "passed",
      "blocked",
      "review_required",
      "timed_out",
      "errored",
      "cancelled",
      "cancellation_incomplete",
    ] as const;
    const sources = ["cli", "feishu", "cron", "child"] as const;

    for (const [index, outcome] of outcomes.entries()) {
      store.appendTerminal({
        source: sources[index % sources.length] ?? "cli",
        role: "owner",
        outcome,
        policyVersion: "test-v1",
        requestHash: `request-${index}`,
        durationMs: index,
      });
    }

    assert.deepEqual(
      store.list().map((record) => record.outcome),
      outcomes,
    );
    assert.equal(
      store.list().every((record) => record.stage === "run"),
      true,
    );
  });

  it("never persists a model-controlled semantic rule identifier", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "semantic-audit-redaction-"),
    );
    const file = path.join(directory, "audit.jsonl");
    const injected = "sk-model_echoed_secret_1234567890";
    const audit = new GuardrailAuditStore(file);
    const semantic = new SemanticGuardrailRunner({
      mode: "shadow",
      timeoutMs: 100,
      maxOutputTokens: 300,
      retries: 0,
      concurrency: 1,
      queueSize: 1,
      classifiers: [
        {
          id: "semantic-input",
          classify: async () => ({
            tripwire: true,
            category: "prompt_injection",
            severity: "high",
            ruleId: injected,
          }),
        },
      ],
    });
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit,
      semantic,
    });

    await service.checkInputWithSemantic(
      { text: "benign input", source: "cli", role: "owner" },
      new AbortController().signal,
    );

    const persisted = readFileSync(file, "utf8");
    assert.doesNotMatch(persisted, new RegExp(injected));
    assert.match(persisted, /SEMANTIC-[a-f0-9]{16}/);
  });
});

function subject(text: string) {
  return { text, source: "cli" as const, role: "owner" as const };
}

function decision(
  requestHash: string,
  outcome: "passed" | "blocked",
): GuardrailDecision {
  return {
    outcome,
    policyVersion: "test-v1",
    requestHash,
    durationMs: 1,
    findings:
      outcome === "blocked"
        ? [
            {
              category: "sensitive_data",
              severity: "critical",
              ruleId: "TEST-RULE",
              evidence: "[redacted:sensitive_data]",
              mandatory: true,
            },
          ]
        : [],
  };
}

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "text" },
          { type: "text-delta" as const, id: "text", delta: text },
          { type: "text-end" as const, id: "text" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: undefined },
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
    }),
  });
}
