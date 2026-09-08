import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type AgentEvent, agentLoop } from "../../src/agent/loop.ts";
import {
  type GuardrailDecision,
  InputTripwireError,
} from "../../src/guardrails/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
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

const BLOCKED: GuardrailDecision = {
  outcome: "blocked",
  policyVersion: "test-v1",
  requestHash: "blocked-hash",
  durationMs: 1,
  findings: [
    {
      category: "policy_bypass",
      severity: "critical",
      ruleId: "GR-BYPASS-TEST",
      evidence: "[redacted:policy_bypass]",
      mandatory: true,
    },
  ],
};

describe("input guardrail coordination", () => {
  it("completes a blocking check before starting the model", async () => {
    const check = deferred<GuardrailDecision>();
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls++;
        return textStream("should not run");
      },
    });
    const registry = new ToolRegistry();
    const run = agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "blocked" }],
      system: "test",
      runContext: createTestRunContext(registry),
      inputGuardrail: { mode: "blocking", check: async () => check.promise },
    });

    await Promise.resolve();
    assert.equal(modelCalls, 0);
    check.reject(new InputTripwireError(BLOCKED));
    await assert.rejects(run, InputTripwireError);
    assert.equal(modelCalls, 0);
  });

  it("starts the model in parallel but releases text and a queued tool exactly once only after pass", async () => {
    const check = deferred<GuardrailDecision>();
    const events: AgentEvent[] = [];
    const executions: string[] = [];
    let inputCommitted = false;
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls++;
        return modelCalls === 1
          ? toolCallStream("call-1", "echo", { value: "alpha" })
          : textStream("done");
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      isReadOnly: true,
      execute: async ({ value }: { value: string }) => {
        assert.equal(inputCommitted, true);
        executions.push(value);
        return value;
      },
    });

    const run = agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "echo" }],
      system: "test",
      runContext: createTestRunContext(registry),
      inputGuardrail: { mode: "parallel", check: async () => check.promise },
      onInputGuardrailPassed: () => {
        inputCommitted = true;
      },
      eventSink: (event) => {
        events.push(event);
      },
    });

    await waitUntil(() => modelCalls === 1);
    assert.equal(events.length, 0);
    assert.deepEqual(executions, []);
    assert.equal(inputCommitted, false);

    check.resolve(PASSED);
    const result = await run;

    assert.equal(result.text, "done");
    assert.deepEqual(executions, ["alpha"]);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "guardrail_decision",
        "run_started",
        "step_started",
        "tool_started",
        "tool_finished",
        "step_finished",
        "step_continuing",
        "step_started",
        "text_delta",
        "step_finished",
        "run_finished",
      ],
    );
    assert.equal(result.guardrails?.input?.outcome, "passed");
  });

  it("discards buffered output and rejects tool and approval work on a parallel Tripwire", async () => {
    const check = deferred<GuardrailDecision>();
    const events: AgentEvent[] = [];
    let executed = false;
    let approvalRequested = false;
    let inputCommitted = false;
    const model = new MockLanguageModelV4({
      doStream: async () => toolCallStream("write-1", "mutate", {}),
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "mutate",
      description: "mutate",
      parameters: { type: "object", properties: {} },
      isReadOnly: false,
      execute: async () => {
        executed = true;
        return "changed";
      },
    });
    const run = agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "mutate" }],
      system: "test",
      runContext: createTestRunContext(registry, {
        requestApproval: async () => {
          approvalRequested = true;
          return true;
        },
      }),
      inputGuardrail: { mode: "parallel", check: async () => check.promise },
      onInputGuardrailPassed: () => {
        inputCommitted = true;
      },
      eventSink: (event) => {
        events.push(event);
      },
    });

    await Promise.resolve();
    check.reject(new InputTripwireError(BLOCKED));
    await assert.rejects(
      run,
      (error: unknown) =>
        error instanceof InputTripwireError &&
        error.cancellation === "complete",
    );
    assert.equal(executed, false);
    assert.equal(approvalRequested, false);
    assert.equal(inputCommitted, false);
    assert.deepEqual(
      events.map((event) => event.type),
      ["guardrail_decision", "guardrail_terminal"],
    );
  });

  it("reports cancellation incomplete when a non-cooperative model misses the convergence deadline", async () => {
    const modelStarted = deferred<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelStarted.resolve();
        return { stream: new ReadableStream() };
      },
    });
    const registry = new ToolRegistry();
    const run = agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "blocked" }],
      system: "test",
      runContext: createTestRunContext(registry),
      inputGuardrail: {
        mode: "parallel",
        check: async () => {
          await modelStarted.promise;
          throw new InputTripwireError(BLOCKED);
        },
        cancellationConvergenceTimeoutMs: 10,
      },
    });

    await assert.rejects(
      run,
      (error: unknown) =>
        error instanceof InputTripwireError &&
        error.cancellation === "incomplete",
    );
  });

  it("propagates caller cancellation through classification and model streaming", async () => {
    const controller = new AbortController();
    const modelStarted = deferred<void>();
    let classifierCancelled = false;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelStarted.resolve();
        return { stream: new ReadableStream() };
      },
    });
    const registry = new ToolRegistry();
    const run = agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "cancel" }],
      system: "test",
      runContext: createTestRunContext(registry, { signal: controller.signal }),
      inputGuardrail: {
        mode: "parallel",
        check: async (signal) =>
          new Promise<GuardrailDecision>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                classifierCancelled = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
        cancellationConvergenceTimeoutMs: 10,
      },
    });

    await modelStarted.promise;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(run, { name: "AbortError" });
    assert.equal(classifierCancelled, true);
  });

  it("cancels approval waiting after the input gate has passed", async () => {
    const controller = new AbortController();
    const approvalStarted = deferred<void>();
    let executed = false;
    const model = new MockLanguageModelV4({
      doStream: async () => toolCallStream("write-1", "mutate", {}),
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "mutate",
      description: "mutate",
      parameters: { type: "object", properties: {} },
      isReadOnly: false,
      execute: async () => {
        executed = true;
        return "changed";
      },
    });
    const run = agentLoop({
      model,
      registry,
      messages: [{ role: "user", content: "mutate" }],
      system: "test",
      runContext: createTestRunContext(registry, {
        signal: controller.signal,
        requestApproval: async () => {
          approvalStarted.resolve();
          return new Promise<boolean>(() => {});
        },
      }),
      inputGuardrail: { mode: "parallel", check: async () => PASSED },
    });

    await approvalStarted.promise;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(run, { name: "AbortError" });
    assert.equal(executed, false);
  });
});

function textStream(text: string) {
  return {
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
  };
}

function toolCallStream(
  id: string,
  name: string,
  input: Record<string, unknown>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: id,
          toolName: name,
          input: JSON.stringify(input),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          logprobs: undefined,
          usage: TEST_USAGE,
        },
      ],
    }),
  };
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
