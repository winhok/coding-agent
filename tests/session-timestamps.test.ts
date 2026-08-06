import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelMessage } from "ai";
import { remapMessageTimestamps } from "../src/session/store.ts";

describe("message timestamp remapping", () => {
  it("preserves retained message timestamps after compaction shifts indices", () => {
    const before: ModelMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old response" },
      { role: "user", content: "recent" },
      { role: "assistant", content: "recent response" },
    ];
    const summary: ModelMessage = { role: "user", content: "summary" };
    const recentUser = before[2];
    const recentAssistant = before[3];
    assert.ok(recentUser);
    assert.ok(recentAssistant);
    const after = [summary, recentUser, recentAssistant];
    const timestamps = new Map([
      [0, 100],
      [1, 200],
      [2, 300],
      [3, 400],
    ]);

    assert.deepEqual(
      [...remapMessageTimestamps(before, after, timestamps, 999)],
      [
        [0, 999],
        [1, 300],
        [2, 400],
      ],
    );
  });

  it("preserves timestamps by index for same-shape defense replacements", () => {
    const before: ModelMessage[] = [{ role: "user", content: "before" }];
    const after: ModelMessage[] = [{ role: "user", content: "after" }];

    assert.deepEqual(
      [...remapMessageTimestamps(before, after, new Map([[0, 123]]), 999)],
      [[0, 123]],
    );
  });
});
