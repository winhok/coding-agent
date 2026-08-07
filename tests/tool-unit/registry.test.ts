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

    assert.equal(result, "abc\n\n... [省略 4 字符] ...\n\nhij");
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
      isReadOnly: true,
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
      isReadOnly: false,
      execute: async () => {
        writeObservedReadFinished = readFinished;
        return "write";
      },
    };

    const registry = new ToolRegistry();
    registry.register(safeRead, exclusiveWrite);
    const formatted = registry.toAISDKFormat({
      requestApproval: async () => true,
    });
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
      isReadOnly: true,
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

  it("provides an unlocked snapshot that excludes spawn_agent", async () => {
    let releaseParent!: () => void;
    let parentStarted!: () => void;
    const parentStartedPromise = new Promise<void>((resolve) => {
      parentStarted = resolve;
    });
    const releaseParentPromise = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });

    const registry = new ToolRegistry();
    registry.register(
      {
        name: "spawn_agent",
        description: "parent spawn",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        execute: async () => {
          parentStarted();
          await releaseParentPromise;
          return "parent";
        },
      },
      {
        name: "child_read",
        description: "child read",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        execute: async () => "child",
      },
    );

    const locked = registry.toAISDKFormat();
    const parent = locked.spawn_agent;
    assert.ok(parent);
    const parentPromise = parent.execute({});
    await parentStartedPromise;

    const unlocked = registry.toAISDKFormatUnlocked(new Set(["spawn_agent"]));
    assert.equal(unlocked.spawn_agent, undefined);
    assert.equal(await unlocked.child_read?.execute({}), "child");

    releaseParent();
    assert.equal(await parentPromise, "parent");
  });

  it("registers MCP tools as deferred, serialized unknown capabilities", async () => {
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

    assert.equal(tool?.isReadOnly, undefined);
    assert.equal(tool?.isConcurrencySafe, false);
    assert.equal(tool?.shouldDefer, true);
  });

  it("keeps deferred tools inactive until an exact search discovers them", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp__github__list_issues",
      description: "List issues",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      searchHint: "github issues",
      execute: async () => "[]",
    });

    assert.deepEqual(registry.getActiveTools(), []);
    assert.equal(registry.toAISDKFormat().mcp__github__list_issues, undefined);
    assert.match(registry.getDeferredToolSummary(), /github issues/);

    assert.equal(
      registry.searchTools("mcp__github__list_issues")[0]?.name,
      "mcp__github__list_issues",
    );
    assert.equal(registry.getActiveTools().length, 1);
    assert.notEqual(
      registry.toAISDKFormat().mcp__github__list_issues,
      undefined,
    );
  });

  it("moves discovered tool tokens from deferred to active", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "deferred_tool",
      description: "Deferred tool",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      execute: async () => "ok",
    });

    const before = registry.countTokenEstimate();
    registry.searchTools("deferred_tool");
    const after = registry.countTokenEstimate();

    assert.equal(before.active, 0);
    assert.equal(before.total, before.deferred);
    assert.equal(after.deferred, 0);
    assert.equal(after.total, after.active);
    assert.equal(after.total, before.total);
  });

  it("unregisters tools and clears their discovered state", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "plugin__query",
      description: "Plugin query",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      execute: async () => "ok",
    });
    registry.searchTools("plugin__query");

    assert.equal(registry.unregister("plugin__query"), true);
    assert.equal(registry.get("plugin__query"), undefined);

    registry.register({
      name: "plugin__query",
      description: "Plugin query",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      execute: async () => "ok",
    });
    assert.deepEqual(registry.getActiveTools(), []);
  });

  it("closes and forgets an MCP client when tool discovery fails", async () => {
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

    await registry.closeAllMCP();

    assert.equal(closed, true);
  });

  it("attempts to close every MCP client even when one close fails", async () => {
    const registry = new ToolRegistry();
    const closed: string[] = [];

    for (const name of ["first", "second"]) {
      await registry.registerMCPServer(name, {
        connect: async () => {},
        listTools: async () => [],
        callTool: async () => "unused",
        close: async () => {
          closed.push(name);
          if (name === "first") throw new Error("close failed");
        },
      });
    }

    await assert.rejects(() => registry.closeAllMCP(), /close failed/);
    assert.deepEqual(closed, ["first", "second"]);

    await registry.closeAllMCP();
    assert.deepEqual(closed, ["first", "second"]);
  });
});
