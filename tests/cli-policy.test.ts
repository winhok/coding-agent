import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCliModePolicy } from "../src/cli/mode-policy.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

describe("CLI mode policy", () => {
  it("enforces plan mode as read-only without delegation", () => {
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
      {
        name: "bash",
        description: "execute",
        parameters: { type: "object", properties: {} },
        isReadOnly: false,
        capabilities: ["execute"],
        execute: async () => "bash",
      },
      {
        name: "spawn_agent",
        description: "delegate",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        capabilities: ["delegate"],
        execute: async () => "spawn",
      },
      {
        name: "mcp__remote__unknown",
        description: "external",
        parameters: { type: "object", properties: {} },
        execute: async () => "external",
      },
    );

    const policy = resolveCliModePolicy("plan", "base");
    const tools = registry.toAISDKFormat(undefined, policy.toolSelection);

    assert.deepEqual(Object.keys(tools), ["read_file"]);
    assert.match(policy.system, /不得修改文件/);
  });

  it("makes non-interactive ask read-only unless approval is explicit", () => {
    const policy = resolveCliModePolicy("ask", "base", "never");
    assert.equal(policy.toolSelection?.readOnlyOnly, true);
    assert.equal(
      policy.toolSelection?.deniedCapabilities?.has("delegate"),
      true,
    );

    const approvedPolicy = resolveCliModePolicy("ask", "base", "always");
    assert.equal(approvedPolicy.system, "base");
    assert.equal(approvedPolicy.toolSelection, undefined);
  });

  it("does not narrow interactive mode", () => {
    const policy = resolveCliModePolicy("interactive", "base", "ask");
    assert.equal(policy.system, "base");
    assert.equal(policy.toolSelection, undefined);
  });
});
