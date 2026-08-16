import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAllowedSenders } from "../src/config/init.ts";

describe("config initialization", () => {
  it("normalizes and deduplicates Feishu sender IDs", () => {
    assert.deepEqual(parseAllowedSenders("ou_one, ou_two，ou_one\nou_three"), [
      "ou_one",
      "ou_two",
      "ou_three",
    ]);
    assert.deepEqual(parseAllowedSenders("  "), []);
  });
});
