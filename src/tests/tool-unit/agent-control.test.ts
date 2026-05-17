import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detect,
  hashToolCall,
  recordCall,
  resetHistory,
} from "../../agent/loop-detection.ts";
import { calculateDelay, isRetryable } from "../../agent/retry.ts";

describe("tool-unit agent control", () => {
  it("hashes tool arguments independent of object key order", () => {
    assert.equal(
      hashToolCall("read_file", { path: "a", mode: "text" }),
      hashToolCall("read_file", { mode: "text", path: "a" }),
    );
  });

  it("detects repeated identical tool calls", () => {
    resetHistory();
    try {
      for (let i = 0; i < 5; i++) {
        recordCall("read_file", { path: "package.json" });
      }

      const result = detect("read_file", { path: "package.json" });
      assert.equal(result.stuck, true);
      if (result.stuck) {
        assert.equal(result.level, "warning");
        assert.equal(result.detector, "generic_repeat");
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
