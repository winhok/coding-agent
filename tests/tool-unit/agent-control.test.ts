import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detect,
  hashToolCall,
  recordCall,
  resetHistory,
} from "../../src/agent/loop-detection.ts";
import { calculateDelay, isRetryable } from "../../src/agent/retry.ts";

describe("tool-unit agent control", () => {
  it("hashes tool arguments independent of object key order", () => {
    assert.equal(
      hashToolCall("read_file", { path: "a", mode: "text" }),
      hashToolCall("read_file", { mode: "text", path: "a" }),
    );
  });

  it("warns and then stops repeated calls before the agent step limit", () => {
    resetHistory();
    try {
      for (let i = 0; i < 10; i++) {
        recordCall("read_file", { path: "package.json" });
      }

      const warning = detect("read_file", { path: "package.json" });
      assert.equal(warning.stuck, true);
      if (warning.stuck) {
        assert.equal(warning.level, "warning");
        assert.equal(warning.detector, "generic_repeat");
      }

      for (let i = 10; i < 20; i++) {
        recordCall("read_file", { path: "package.json" });
      }

      const critical = detect("read_file", { path: "package.json" });
      assert.equal(critical.stuck, true);
      if (critical.stuck) {
        assert.equal(critical.level, "critical");
        assert.equal(critical.detector, "generic_repeat");
      }
    } finally {
      resetHistory();
    }
  });

  it("uses the global circuit breaker for varied tool calls", () => {
    resetHistory();
    try {
      for (let i = 0; i < 30; i++) {
        recordCall("read_file", { path: `file-${i}.ts` });
      }

      const result = detect("grep", { pattern: "next" });
      assert.equal(result.stuck, true);
      if (result.stuck) {
        assert.equal(result.level, "critical");
        assert.equal(result.detector, "global_circuit_breaker");
        assert.equal(result.count, 30);
      }
    } finally {
      resetHistory();
    }
  });

  it("classifies retryable and non-retryable errors", () => {
    assert.equal(isRetryable(new Error("HTTP 429 rate limited")), true);
    assert.equal(isRetryable(new Error("HTTP 500 upstream")), true);
    assert.equal(isRetryable(new Error("HTTP 401 unauthorized")), false);
    assert.equal(isRetryable(new Error("ECONNRESET")), true);
    assert.equal(isRetryable("not an Error"), false);
  });

  it("calculates bounded exponential backoff with jitter", () => {
    const delay = calculateDelay(1, 100, 100);
    assert.ok(delay >= 75, `delay too low: ${delay}`);
    assert.ok(delay <= 125, `delay too high: ${delay}`);
  });
});
