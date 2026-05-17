import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, ToolLoopAgent } from "ai";

import { ToolRegistry } from "../../tools/registry.ts";
import { allTools } from "../../tools/tools.ts";

const runRealModelEvals = process.env.RUN_REAL_MODEL_EVALS === "1";

function createDashScopeModel() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DASHSCOPE_API_KEY environment variable");
  }

  const qwen = createOpenAI({
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey,
  });
  return qwen.chat("qwen-plus-latest");
}

async function generateToolCall(prompt: string) {
  const registry = new ToolRegistry();
  registry.register(...allTools);
  const agent = new ToolLoopAgent({
    model: createDashScopeModel(),
    stopWhen: stepCountIs(1),
    tools: registry.toAISDKFormat(),
  });

  return agent.generate({ prompt });
}

describe("smoke-real-model one-turn routing", {
  skip: !runRealModelEvals,
}, () => {
  it("routes a read request to read_file", async () => {
    const result = await generateToolCall("read package.json");
    assert.equal(result.toolCalls[0]?.toolName, "read_file");
  });

  it("routes a write request to write_file", async () => {
    const result = await generateToolCall("Write 'hello world' to output.txt");
    assert.equal(result.toolCalls[0]?.toolName, "write_file");
  });

  it("routes a directory request to list_directory", async () => {
    const result = await generateToolCall(
      "List all files in the current directory",
    );
    assert.equal(result.toolCalls[0]?.toolName, "list_directory");
  });

  it("routes a time request to get_current_time", async () => {
    const result = await generateToolCall("What time is it now?");
    assert.equal(result.toolCalls[0]?.toolName, "get_current_time");
  });
});
