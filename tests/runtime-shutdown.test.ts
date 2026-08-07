import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeShutdown } from "../src/runtime/shutdown.ts";

describe("runtime shutdown", () => {
  it("closes every resource in order once even when one fails", async () => {
    const closed: string[] = [];
    const failures: string[] = [];
    const shutdown = createRuntimeShutdown(
      [
        {
          name: "cron",
          close: () => {
            closed.push("cron");
          },
        },
        {
          name: "channel",
          close: () => {
            closed.push("channel");
            throw new Error("stop failed");
          },
        },
        {
          name: "mcp",
          close: async () => {
            closed.push("mcp");
          },
        },
      ],
      (task) => failures.push(task),
    );

    assert.equal(shutdown.started, false);
    await Promise.all([shutdown.run(), shutdown.run()]);

    assert.equal(shutdown.started, true);
    assert.deepEqual(closed, ["cron", "channel", "mcp"]);
    assert.deepEqual(failures, ["channel"]);
  });
});
