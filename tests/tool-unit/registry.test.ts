import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTodosTool } from "../../src/tools/create_todos.tool.ts";
import {
  type ToolDefinition,
  ToolRegistry,
  truncateResult,
} from "../../src/tools/registry.ts";
import { createToolSearchTool } from "../../src/tools/tool-search.ts";
import { updateTodoTool } from "../../src/tools/update_todo.tool.ts";
import { createTestRunContext, withMutedConsole } from "../helpers.ts";

describe("tool-unit registry", () => {
  it("isolates todo state between agent run contexts", async () => {
    const registry = new ToolRegistry();
    registry.register(createTodosTool, updateTodoTool);
    const firstRun = registry.toAISDKFormat(createTestRunContext(registry));
    const secondRun = registry.toAISDKFormat(createTestRunContext(registry));

    await firstRun.create_todos?.execute({ todos: ["first run"] });

    assert.match(
      String(
        await secondRun.update_todo?.execute({ id: "1", status: "completed" }),
      ),
      /未找到/,
    );
    assert.match(
      String(
        await firstRun.update_todo?.execute({ id: "1", status: "completed" }),
      ),
      /first run/,
    );
  });

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
    const formatted = registry.toAISDKFormat(
      createTestRunContext(registry, { requestApproval: async () => true }),
    );
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
    const formatted = registry.toAISDKFormat(createTestRunContext(registry));
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

  it("filters tools by capabilities and task-level scope", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "spawn_agent",
        description: "parent spawn",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        capabilities: ["delegate"],
        holdsExecutionLock: false,
        execute: async () => "parent",
      },
      {
        name: "child_read",
        description: "child read",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        execute: async () => "child",
      },
      {
        name: "child_write",
        description: "child write",
        parameters: { type: "object", properties: {} },
        isReadOnly: false,
        execute: async () => "write",
      },
    );

    const selected = registry.toAISDKFormat(
      createTestRunContext(registry, {
        selection: {
          allowedCapabilities: new Set(["read"]),
          deniedCapabilities: new Set(["delegate"]),
          allowedTools: new Set(["child_read", "child_write"]),
        },
      }),
    );

    assert.deepEqual(Object.keys(selected), ["child_read"]);
  });

  it("does not let the orchestration tool hold the child execution lock", async () => {
    let childRan = false;
    const registry = new ToolRegistry();
    const childRead: ToolDefinition = {
      name: "child_read",
      description: "child read",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => {
        childRan = true;
        return "child";
      },
    };
    registry.register(childRead, {
      name: "spawn_agent",
      description: "spawn",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      capabilities: ["delegate"],
      holdsExecutionLock: false,
      execute: async (_input, context) => {
        assert.ok(context);
        const child = registry.toAISDKFormat(context).child_read;
        assert.ok(child);
        return child.execute({});
      },
    });

    assert.equal(
      await registry
        .toAISDKFormat(createTestRunContext(registry))
        .spawn_agent?.execute({}),
      "child",
    );
    assert.equal(childRan, true);
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

    const runContext = createTestRunContext(registry);
    assert.deepEqual(runContext.toolView.getActiveTools(), []);
    assert.equal(
      registry.toAISDKFormat(runContext).mcp__github__list_issues,
      undefined,
    );
    assert.match(runContext.toolView.getDeferredToolSummary(), /github issues/);

    assert.equal(
      runContext.toolView.searchTools("mcp__github__list_issues")[0]?.name,
      "mcp__github__list_issues",
    );
    assert.equal(runContext.toolView.getActiveTools().length, 1);
    assert.notEqual(
      registry.toAISDKFormat(runContext).mcp__github__list_issues,
      undefined,
    );
  });

  it("isolates deferred discovery between run-scoped tool views", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "deferred_tool",
      description: "deferred",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      shouldDefer: true,
      execute: async () => "ok",
    });
    const first = createTestRunContext(registry);
    const second = createTestRunContext(registry);

    first.toolView.searchTools("deferred_tool");

    assert.equal(first.toolView.has("deferred_tool"), true);
    assert.equal(second.toolView.has("deferred_tool"), false);
    assert.equal(registry.toAISDKFormat(second).deferred_tool, undefined);
  });

  it("does not let tool_search discover tools outside the run view", async () => {
    const registry = new ToolRegistry();
    registry.register(createToolSearchTool(), {
      name: "deferred_write",
      description: "write",
      parameters: { type: "object", properties: {} },
      isReadOnly: false,
      shouldDefer: true,
      execute: async () => "written",
    });
    const context = createTestRunContext(registry, {
      selection: { readOnlyOnly: true },
    });
    const search = registry.toAISDKFormat(context).tool_search;
    assert.ok(search);

    assert.match(
      String(await search.execute({ query: "deferred_write" })),
      /没有找到工具/,
    );
    assert.equal(context.toolView.has("deferred_write"), false);
  });

  it("only narrows a parent tool view and cannot restore hidden tools", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        execute: async () => "read",
      },
      {
        name: "write_file",
        description: "write",
        parameters: { type: "object", properties: {} },
        isReadOnly: false,
        execute: async () => "write",
      },
    );
    const parent = registry.createView({
      allowedTools: new Set(["read_file"]),
    });
    const child = parent.restrict({
      allowedTools: new Set(["read_file", "write_file"]),
    });

    assert.deepEqual(
      child.getActiveTools().map((tool) => tool.name),
      ["read_file"],
    );
  });

  it("rejects a run context created by a different registry", () => {
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    const context = createTestRunContext(first);

    assert.throws(
      () => second.toAISDKFormat(context),
      /toolView 不属于当前 ToolRegistry/,
    );
  });

  it("passes the SDK call identity and cancellation signal into tool context", async () => {
    const registry = new ToolRegistry();
    let observedCallId: string | undefined;
    let observedSignal: AbortSignal | undefined;
    registry.register({
      name: "inspect_context",
      description: "inspect",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async (_input, context) => {
        observedCallId = context?.toolCallId;
        observedSignal = context?.signal;
        return "ok";
      },
    });
    const runContext = createTestRunContext(registry);
    const callController = new AbortController();
    const tool = registry.toAISDKFormat(runContext).inspect_context;
    assert.ok(tool);

    await tool.execute(
      {},
      { toolCallId: "call-123", abortSignal: callController.signal },
    );

    assert.equal(observedCallId, "call-123");
    assert.notEqual(observedSignal, runContext.signal);
    callController.abort();
    assert.equal(observedSignal?.aborted, true);
  });

  it("does not publish a successful result after the caller cancels", async () => {
    const registry = new ToolRegistry();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    registry.register({
      name: "cancellable_read",
      description: "read",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async (_input, context) => {
        started();
        await new Promise<void>((resolve) =>
          context?.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return "late success";
      },
    });
    const controller = new AbortController();
    const context = createTestRunContext(registry);
    const tool = registry.toAISDKFormat(context).cancellable_read;
    assert.ok(tool);

    const result = tool.execute({}, { abortSignal: controller.signal });
    await startedPromise;
    controller.abort(new DOMException("cancelled", "AbortError"));

    await assert.rejects(() => result, /cancelled/);
    assert.equal(registry.getExecutionAuditLog().at(-1)?.outcome, "aborted");
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
