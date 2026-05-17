import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ToolDefinition,
  ToolRegistry,
  truncateResult,
} from "../../tools/registry.ts";
import { withMutedConsole } from "../../verification/helpers.ts";

describe("tool-unit registry", () => {
  it("truncates long tool results while preserving head and tail", () => {
    const result = truncateResult("abcdefghij", 6);

    assert.equal(result, "abc\n\n... 省略 4 字符...\n\nhij");
  });

  it("serializes non-concurrency-safe tools behind active read tools", async () => {
    let releaseRead!: () => void;
    let readStarted!: () => void;
    let readFinished = false;
    let writeObservedReadFinished: boolean | undefined;

    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const releaseReadPromise = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const safeRead: ToolDefinition = {
      name: "safe_read",
      description: "safe read",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => {
        readStarted();
        await releaseReadPromise;
        readFinished = true;
        return "read";
      },
    };
    const exclusiveWrite: ToolDefinition = {
      name: "exclusive_write",
      description: "exclusive write",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: false,
      execute: async () => {
        writeObservedReadFinished = readFinished;
        return "write";
      },
    };

    const registry = new ToolRegistry();
    registry.register(safeRead, exclusiveWrite);
    const formatted = registry.toAISDKFormat();

    await withMutedConsole(async () => {
      const readPromise = formatted.safe_read.execute({});
      await readStartedPromise;

      const writePromise = formatted.exclusive_write.execute({});
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(writeObservedReadFinished, undefined);

      releaseRead();
      assert.equal(await readPromise, "read");
      assert.equal(await writePromise, "write");
    });
    assert.equal(writeObservedReadFinished, true);
  });

  it("lets concurrency-safe tools run together", async () => {
    let started = 0;
    let releaseReads!: () => void;
    const releaseReadsPromise = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });

    const makeReadTool = (name: string): ToolDefinition => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => {
        started++;
        await releaseReadsPromise;
        return name;
      },
    });

    const registry = new ToolRegistry();
    registry.register(makeReadTool("read_a"), makeReadTool("read_b"));
    const formatted = registry.toAISDKFormat();

    await withMutedConsole(async () => {
      const first = formatted.read_a.execute({});
      const second = formatted.read_b.execute({});
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(started, 2);

      releaseReads();
      assert.equal(await first, "read_a");
      assert.equal(await second, "read_b");
    });
  });
});
