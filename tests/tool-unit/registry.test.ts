import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ToolDefinition,
  ToolRegistry,
  truncateResult,
} from "../../src/tools/registry.ts";
import { withMutedConsole } from "../helpers.ts";

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
    const formattedRead = formatted.safe_read;
    const formattedWrite = formatted.exclusive_write;
    assert.ok(formattedRead);
    assert.ok(formattedWrite);

    await withMutedConsole(async () => {
      const readPromise = formattedRead.execute({});
      await readStartedPromise;

      const writePromise = formattedWrite.execute({});
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
    const firstRead = formatted.read_a;
    const secondRead = formatted.read_b;
    assert.ok(firstRead);
    assert.ok(secondRead);

    await withMutedConsole(async () => {
      const first = firstRead.execute({});
      const second = secondRead.execute({});
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(started, 2);

      releaseReads();
      assert.equal(await first, "read_a");
      assert.equal(await second, "read_b");
    });
  });

  it("registers MCP tools conservatively by default", async () => {
    const registry = new ToolRegistry();

    await registry.registerMCPServer("github", {
      connect: async () => {},
      listTools: async () => [
        {
          name: "create_issue",
          description: "Create an issue",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      callTool: async () => "ok",
      close: async () => {},
    });

    const tool = registry.get("mcp__github__create_issue");

    assert.equal(tool?.isReadOnly, false);
    assert.equal(tool?.isConcurrencySafe, false);
  });

  it("closes a connected MCP client when tool discovery fails", async () => {
    const registry = new ToolRegistry();
    let closed = false;

    await assert.rejects(
      () =>
        registry.registerMCPServer("broken", {
          connect: async () => {},
          listTools: async () => {
            throw new Error("list failed");
          },
          callTool: async () => "unused",
          close: async () => {
            closed = true;
          },
        }),
      /list failed/,
    );

    assert.equal(closed, true);
  });
});
