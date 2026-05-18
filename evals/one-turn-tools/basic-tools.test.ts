import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { stepCountIs, ToolLoopAgent } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { allTools } from "../../src/tools/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import {
  cleanupTempDir,
  makeTempDir,
  mockToolCallResponse,
  withMutedConsole,
  withWorkingDir,
} from "../../tests/helpers.ts";

async function runOneTurnToolCall(
  toolName: string,
  input: Record<string, unknown>,
) {
  const registry = new ToolRegistry();
  registry.register(...allTools);
  const agent = new ToolLoopAgent({
    model: new MockLanguageModelV3({
      doGenerate: async () => mockToolCallResponse(toolName, input),
    }),
    stopWhen: stepCountIs(1),
    tools: registry.toAISDKFormat(),
  });

  return withMutedConsole(() => agent.generate({ prompt: `call ${toolName}` }));
}

describe("one-turn-tools with MockLanguageModelV3", () => {
  it("executes read_file from a mocked tool call", async () => {
    const dir = makeTempDir();
    try {
      const file = "package.json";
      writeFileSync(join(dir, file), '{"name":"eval-fixture"}\n', "utf-8");

      const result = await withWorkingDir(dir, () =>
        runOneTurnToolCall("read_file", { path: file }),
      );
      assert.equal(result.toolCalls[0]?.toolName, "read_file");
      assert.match(String(result.toolResults[0]?.output), /eval-fixture/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("executes write_file from a mocked tool call", async () => {
    const dir = makeTempDir();
    try {
      const file = "output.txt";

      const result = await withWorkingDir(dir, () =>
        runOneTurnToolCall("write_file", { path: file, content: "mock write" }),
      );
      assert.equal(result.toolCalls[0]?.toolName, "write_file");
      assert.equal(readFileSync(join(dir, file), "utf-8"), "mock write");
      assert.match(String(result.toolResults[0]?.output), /已写入/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("executes list_directory from a mocked tool call", async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "README.md"), "# eval\n", "utf-8");

      const result = await withWorkingDir(dir, () =>
        runOneTurnToolCall("list_directory", { path: "." }),
      );
      assert.equal(result.toolCalls[0]?.toolName, "list_directory");
      assert.match(String(result.toolResults[0]?.output), /README\.md/);
      assert.match(String(result.toolResults[0]?.output), /src/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("executes get_current_time from a mocked tool call", async () => {
    const result = await runOneTurnToolCall("get_current_time", {
      reason: "eval",
    });

    assert.equal(result.toolCalls[0]?.toolName, "get_current_time");
    assert.equal(typeof result.toolResults[0]?.output, "string");
    assert.ok(String(result.toolResults[0]?.output).length > 0);
  });
});
