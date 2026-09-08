import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type AgentEvent, agentLoop } from "../../src/agent/loop.ts";
import { GuardrailAuditStore } from "../../src/guardrails/audit.ts";
import { GuardrailService } from "../../src/guardrails/service.ts";
import type { GuardrailDecision } from "../../src/guardrails/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { LocalTraceRecorder } from "../../src/trace/recorder.ts";
import { createTestRunContext } from "../helpers.ts";

const TEST_USAGE = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const PASSED: GuardrailDecision = {
  outcome: "passed",
  policyVersion: "test-v1",
  requestHash: "passed-hash",
  durationMs: 1,
  findings: [],
};

describe("final output guardrail", () => {
  it("detects known secrets, credential formats, and configured sensitive fields without auditing plaintext", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guardrail-output-"));
    const auditFile = path.join(directory, "audit.jsonl");
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(auditFile),
      knownSecrets: ["synthetic-known-value"],
      sensitiveFields: ["internal_code"],
    });

    const samples = [
      "synthetic-known-value",
      "sk-synthetic_12345678901234567890",
      "internal_code=synthetic-field-value",
    ];
    for (const text of samples) {
      const decision = service.checkOutput({
        text,
        source: "cli",
        role: "owner",
      });
      assert.equal(decision?.outcome, "blocked");
      assert.ok(
        decision?.findings.every(
          (finding) =>
            finding.category === "sensitive_data" &&
            (finding.severity === "high" || finding.severity === "critical"),
        ),
      );
    }

    const stored = readFileSync(auditFile, "utf8");
    assert.doesNotMatch(stored, /synthetic-known-value/);
    assert.doesNotMatch(stored, /sk-synthetic_/);
    assert.doesNotMatch(stored, /synthetic-field-value/);
    assert.match(stored, /"stage":"output"/);
  });

  it("holds passing text until validation and releases the unchanged deltas once", async () => {
    const check = deferred<GuardrailDecision>();
    const candidateSeen = deferred<void>();
    const events: AgentEvent[] = [];
    const registry = new ToolRegistry();
    const run = agentLoop({
      model: textModel("safe answer"),
      registry,
      messages: [{ role: "user", content: "answer" }],
      system: "test",
      runContext: createTestRunContext(registry),
      outputGuardrail: {
        check: async (text) => {
          assert.equal(text, "safe answer");
          candidateSeen.resolve();
          return check.promise;
        },
        replacement: () => "not used",
      },
      eventSink: (event) => {
        events.push(event);
      },
    });

    await candidateSeen.promise;
    assert.equal(
      events.some((event) => event.type === "text_delta"),
      false,
    );
    check.resolve(PASSED);
    const result = await run;

    assert.equal(result.text, "safe answer");
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
      "safe answer",
    );
    assert.equal(result.guardrails?.output?.outcome, "passed");
  });

  it("replaces blocked output before events, history, and trace persistence", async () => {
    const secret = "sk-synthetic_12345678901234567890";
    const replacement = "响应包含敏感凭证，已被安全保护替换。";
    const directory = mkdtempSync(path.join(tmpdir(), "guardrail-trace-"));
    const trace = await LocalTraceRecorder.start({
      directory,
      sessionId: "output-test",
      model: "mock",
    });
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
    });
    const events: AgentEvent[] = [];
    const messages = [{ role: "user" as const, content: "answer" }];
    const registry = new ToolRegistry();
    let checks = 0;

    const result = await agentLoop({
      model: textModel(`credential: ${secret}`),
      registry,
      messages,
      system: "test",
      runContext: createTestRunContext(registry),
      outputGuardrail: {
        check: async (text) => {
          checks++;
          return service.checkOutput({ text, source: "cli", role: "owner" });
        },
        replacement: () => replacement,
      },
      eventSink: (event) => {
        events.push(event);
      },
      trace,
    });

    assert.equal(checks, 1);
    assert.equal(result.text, replacement);
    assert.equal(result.guardrails?.output?.outcome, "blocked");
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
      replacement,
    );
    assert.doesNotMatch(JSON.stringify(messages), /sk-synthetic_/);
    assert.match(JSON.stringify(messages), /安全保护替换/);
    assert.doesNotMatch(readFileSync(trace.filePath, "utf8"), /sk-synthetic_/);
  });

  it("checks a tool-call step that becomes the max-step terminal output", async () => {
    const secret = "sk-synthetic_12345678901234567890";
    const replacement = "terminal output blocked";
    const service = new GuardrailService({
      enabled: true,
      policyVersion: "test-v1",
      audit: new GuardrailAuditStore(),
    });
    const events: AgentEvent[] = [];
    const messages = [{ role: "user" as const, content: "use a tool" }];
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => "ok",
    });

    const result = await agentLoop({
      model: mixedToolModel(secret),
      registry,
      messages,
      system: "test",
      runContext: createTestRunContext(registry),
      maxSteps: 1,
      outputGuardrail: {
        check: async (text) =>
          service.checkOutput({ text, source: "cli", role: "owner" }),
        replacement: () => replacement,
      },
      eventSink: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.termination, "max_steps");
    assert.equal(result.text, replacement);
    assert.equal(result.guardrails?.output?.outcome, "blocked");
    assert.doesNotMatch(JSON.stringify(messages), /sk-synthetic_/);
    assert.doesNotMatch(JSON.stringify(events), /sk-synthetic_/);
  });
});

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
            usage: TEST_USAGE,
          },
        ],
      }),
    }),
  });
}

function mixedToolModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "text" },
          { type: "text-delta" as const, id: "text", delta: text },
          { type: "text-end" as const, id: "text" },
          {
            type: "tool-call" as const,
            toolCallId: "echo-1",
            toolName: "echo",
            input: "{}",
          },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            logprobs: undefined,
            usage: TEST_USAGE,
          },
        ],
      }),
    }),
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
