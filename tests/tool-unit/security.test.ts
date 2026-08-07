import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBashCommand } from "../../src/security/bash-classifier.ts";
import { HookPipeline } from "../../src/security/hooks.ts";
import { canUseTool, filterToolsForRole } from "../../src/security/roles.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { withMutedConsole } from "../helpers.ts";

describe("security roles", () => {
  it("applies owner, collaborator, and guest tool access", () => {
    assert.equal(canUseTool("owner", "bash"), true);
    assert.equal(canUseTool("collaborator", "bash"), false);
    assert.equal(canUseTool("collaborator", "write_file"), true);
    assert.equal(canUseTool("guest", "read_file"), true);
    assert.equal(canUseTool("guest", "write_file"), false);
    assert.deepEqual(
      filterToolsForRole(["read_file", "write_file", "bash"], "guest"),
      ["read_file"],
    );
  });

  it("filters the tools exposed by the registry when the role changes", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: {} },
        execute: async () => "read",
      },
      {
        name: "bash",
        description: "bash",
        parameters: { type: "object", properties: {} },
        execute: async () => "bash",
      },
    );

    assert.equal(registry.getRole(), "owner");
    assert.deepEqual(Object.keys(registry.toAISDKFormat()), [
      "read_file",
      "bash",
    ]);

    registry.setRole("collaborator");
    assert.deepEqual(Object.keys(registry.toAISDKFormat()), ["read_file"]);

    registry.setRole("guest");
    assert.deepEqual(Object.keys(registry.toAISDKFormat()), ["read_file"]);
  });

  it("does not reveal or discover deferred tools denied to the role", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp__github__list_issues",
      description: "list issues",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      searchHint: "github issues",
      execute: async () => "[]",
    });

    registry.setRole("guest");

    assert.equal(registry.getDeferredToolSummary(), "");
    assert.deepEqual(registry.searchTools("mcp__github__list_issues"), []);
    assert.deepEqual(registry.countTokenEstimate(), {
      active: 0,
      deferred: 0,
      total: 0,
    });
  });
});

describe("bash classifier", () => {
  it("classifies safe, moderate, and dangerous commands", () => {
    assert.deepEqual(classifyBashCommand("pwd"), { level: "safe" });
    assert.deepEqual(classifyBashCommand("git push origin main"), {
      level: "moderate",
      reason: "Git 推送",
    });
    assert.deepEqual(classifyBashCommand("rm -rf /"), {
      level: "dangerous",
      reason: "强制删除文件",
    });
    assert.deepEqual(classifyBashCommand("git push --force origin main"), {
      level: "dangerous",
      reason: "Git 强制推送",
    });
    assert.deepEqual(classifyBashCommand("git reset --hard HEAD~1"), {
      level: "dangerous",
      reason: "Git 硬重置",
    });
    assert.deepEqual(classifyBashCommand("git clean -fd"), {
      level: "dangerous",
      reason: "Git 清理未跟踪文件",
    });
  });

  it("blocks dangerous bash commands before execution", async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "bash",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executed = true;
        return "executed";
      },
    });

    const bash = registry.toAISDKFormat().bash;
    assert.ok(bash);
    const output = await bash.execute({ command: "sudo rm -rf /" });

    assert.equal(executed, false);
    assert.match(output, /^\[拒绝执行\]/);
  });

  it("classifies the final input after pre hooks modify a command", async () => {
    let executed = false;
    const hooks = new HookPipeline();
    hooks.registerPre("rewrite-command", () => ({
      action: "modify",
      modifiedInput: { command: "sudo rm -rf /" },
    }));
    const registry = new ToolRegistry();
    registry.setHookPipeline(hooks);
    registry.register({
      name: "bash",
      description: "bash",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async () => {
        executed = true;
        return "executed";
      },
    });

    const bash = registry.toAISDKFormat().bash;
    assert.ok(bash);
    const output = await withMutedConsole(() =>
      bash.execute({ command: "pwd" }),
    );

    assert.equal(executed, false);
    assert.match(output, /^\[拒绝执行\]/);
    assert.equal(registry.getExecutionAuditLog().at(-1)?.outcome, "denied");
  });

  it("revalidates pre-hook-modified input before authorization", async () => {
    let executed = false;
    const hooks = new HookPipeline();
    hooks.registerPre("break-schema", () => ({
      action: "modify",
      modifiedInput: { command: 42 },
    }));
    const registry = new ToolRegistry();
    registry.setHookPipeline(hooks);
    registry.register({
      name: "bash",
      description: "bash",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async () => {
        executed = true;
        return "executed";
      },
    });

    const bash = registry.toAISDKFormat().bash;
    assert.ok(bash);
    const output = await withMutedConsole(() =>
      bash.execute({ command: "pwd" }),
    );

    assert.equal(executed, false);
    assert.match(output, /^\[参数校验失败\]/);
    assert.equal(registry.getExecutionAuditLog().at(-1)?.outcome, "invalid");
  });

  it("authorizes against the current role immediately before execution", async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "bash",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executed = true;
        return "executed";
      },
    });
    const bashFromOwnerSnapshot = registry.toAISDKFormat().bash;
    assert.ok(bashFromOwnerSnapshot);

    registry.setRole("collaborator");
    const output = await bashFromOwnerSnapshot.execute({});

    assert.equal(executed, false);
    assert.match(output, /^\[拒绝执行\]/);
    assert.equal(registry.getExecutionAuditLog().at(-1)?.outcome, "denied");
  });

  it("allows read-only tools without asking and audits the decision", async () => {
    let approvalRequested = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "read_only",
      description: "read",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => "ok",
    });

    const tool = registry.toAISDKFormat({
      requestApproval: async () => {
        approvalRequested = true;
        return false;
      },
    }).read_only;
    assert.ok(tool);

    assert.equal(await tool.execute({}), "ok");
    assert.equal(approvalRequested, false);
    assert.deepEqual(registry.getExecutionAuditLog().at(-1)?.permission, {
      level: "allow",
      approval: "not_required",
    });
  });

  it("allows task bookkeeping without treating it as an external mutation", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "create_todos",
      description: "plan",
      parameters: { type: "object", properties: {} },
      isReadOnly: false,
      execute: async () => "planned",
    });
    const tool = registry.toAISDKFormat().create_todos;
    assert.ok(tool);

    assert.equal(await tool.execute({}), "planned");
    assert.deepEqual(registry.getExecutionAuditLog().at(-1)?.permission, {
      level: "allow",
      approval: "not_required",
    });
  });

  it("asks for the final input before executing a mutating tool", async () => {
    const seen: unknown[] = [];
    const hooks = new HookPipeline();
    hooks.registerPre("rewrite", () => ({
      action: "modify",
      modifiedInput: { path: "final.txt" },
    }));
    const registry = new ToolRegistry();
    registry.setHookPipeline(hooks);
    registry.register({
      name: "write_file",
      description: "write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      isReadOnly: false,
      execute: async (input) => String(input.path),
    });

    const tool = registry.toAISDKFormat({
      requestApproval: async (request) => {
        seen.push(request.input);
        return true;
      },
    }).write_file;
    assert.ok(tool);

    assert.equal(
      await withMutedConsole(() => tool.execute({ path: "original.txt" })),
      "final.txt",
    );
    assert.deepEqual(seen, [{ path: "final.txt" }]);
    assert.deepEqual(registry.getExecutionAuditLog().at(-1)?.permission, {
      level: "ask",
      approval: "approved",
    });
  });

  it("denies an ask decision when approval is rejected or unavailable", async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "unknown_tool",
      description: "unknown",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executed = true;
        return "executed";
      },
    });

    const unavailable = registry.toAISDKFormat().unknown_tool;
    assert.ok(unavailable);
    assert.match(await unavailable.execute({}), /没有审批通道/);

    const rejected = registry.toAISDKFormat({
      requestApproval: async () => false,
    }).unknown_tool;
    assert.ok(rejected);
    assert.match(await rejected.execute({}), /用户拒绝/);
    assert.equal(executed, false);
    assert.deepEqual(registry.getExecutionAuditLog().at(-1)?.permission, {
      level: "ask",
      approval: "rejected",
    });
  });

  it("redacts secrets from the execution audit", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_only",
      description: "read",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => "ok",
    });
    const tool = registry.toAISDKFormat().read_only;
    assert.ok(tool);

    await tool.execute({
      query: "public",
      apiKey: "top-secret",
      nested: { authorization: "Bearer secret" },
    });

    assert.deepEqual(registry.getExecutionAuditLog().at(-1)?.input, {
      query: "public",
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]" },
    });
  });
});

describe("hook pipeline", () => {
  it("chains input and output modifications around tool execution", async () => {
    const seenInputs: unknown[] = [];
    const pipeline = new HookPipeline();
    pipeline.registerPre("first", (_toolName, input) => ({
      action: "modify",
      modifiedInput: { value: Number((input as { value: number }).value) + 1 },
    }));
    pipeline.registerPre("second", (_toolName, input) => {
      seenInputs.push(input);
      return { action: "allow" };
    });
    pipeline.registerPost("suffix", (_toolName, _input, output) => ({
      action: "modify",
      modifiedOutput: `${output}!`,
    }));

    const registry = new ToolRegistry();
    registry.setHookPipeline(pipeline);
    registry.register({
      name: "custom_tool",
      description: "custom",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async (input: { value: number }) => String(input.value),
    });

    const customTool = registry.toAISDKFormat().custom_tool;
    assert.ok(customTool);
    const output = await withMutedConsole(() =>
      customTool.execute({ value: 1 }),
    );

    assert.deepEqual(seenInputs, [{ value: 2 }]);
    assert.equal(output, "2!");
    assert.deepEqual(registry.getExecutionAuditLog().at(-1), {
      timestamp: registry.getExecutionAuditLog().at(-1)?.timestamp,
      durationMs: registry.getExecutionAuditLog().at(-1)?.durationMs,
      tool: "custom_tool",
      input: { value: 2 },
      outcome: "completed",
      permission: { level: "allow", approval: "not_required" },
    });
    assert.deepEqual(pipeline.list(), {
      pre: ["first", "second"],
      post: ["suffix"],
    });
  });

  it("blocks execution and isolates hook failures", async () => {
    let executed = false;
    const pipeline = new HookPipeline();
    pipeline.registerPre("broken", () => {
      throw new Error("hook failed");
    });
    pipeline.registerPre("guard", () => ({
      action: "block",
      reason: "not allowed",
    }));

    const registry = new ToolRegistry();
    registry.setHookPipeline(pipeline);
    registry.register({
      name: "custom_tool",
      description: "custom",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => {
        executed = true;
        return "executed";
      },
    });

    const customTool = registry.toAISDKFormat().custom_tool;
    assert.ok(customTool);

    const originalError = console.error;
    console.error = () => {};
    try {
      const output = await withMutedConsole(() => customTool.execute({}));
      assert.equal(output, "[Hook 拦截] not allowed");
    } finally {
      console.error = originalError;
    }
    assert.equal(executed, false);
    assert.equal(registry.getExecutionAuditLog().at(-1)?.outcome, "blocked");
  });

  it("audits tool execution failures before rethrowing", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "failing_tool",
      description: "fails",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => {
        throw new Error("boom");
      },
    });
    const failingTool = registry.toAISDKFormat().failing_tool;
    assert.ok(failingTool);

    await assert.rejects(() => failingTool.execute({}), /boom/);

    assert.deepEqual(registry.getExecutionAuditLog().at(-1), {
      timestamp: registry.getExecutionAuditLog().at(-1)?.timestamp,
      durationMs: registry.getExecutionAuditLog().at(-1)?.durationMs,
      tool: "failing_tool",
      input: {},
      outcome: "failed",
      reason: "boom",
      permission: { level: "allow", approval: "not_required" },
    });
  });
});
