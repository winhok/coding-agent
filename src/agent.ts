import "dotenv/config";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createOpenAI } from "@ai-sdk/openai";
import {
  type Agent,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
} from "ai";
import { agentLoop, type BudgetState } from "./agent/loop.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { allTools } from "./tools/tools.ts";

const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  throw new Error("Missing DASHSCOPE_API_KEY environment variable");
}

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey,
});

const model: LanguageModel = qwen.chat("qwen-plus-latest");

const registry = new ToolRegistry();
registry.register(...allTools);

const SYSTEM = `你是 Coding Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

type AgentTools = ReturnType<ToolRegistry["toAISDKFormat"]>;
export const agent: Agent<never, AgentTools> = new ToolLoopAgent<
  never,
  AgentTools
>({
  id: "coding-agent",
  model,
  instructions: SYSTEM,
  tools: registry.toAISDKFormat(),
  stopWhen: stepCountIs(15),
  maxRetries: 0,
});

function runCliAgent(): void {
  console.log(`已注册 ${registry.getAll().length} 个工具：`);

  for (const tool of registry.getAll()) {
    const flags = [
      tool.isConcurrencySafe ? "可并发" : "串行",
      tool.isReadOnly ? "只读" : "读写",
    ].join(",");
    console.log(`  - ${tool.name}（${flags}）`);
  }

  const messages: ModelMessage[] = [];
  // 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
  const budget: BudgetState = { used: 0, limit: 15000 };
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function ask() {
    rl.question("\nYou:", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        console.log("\nBye!");
        rl.close();
        return;
      }

      messages.push({ role: "user", content: trimmed });

      await agentLoop(model, registry, messages, SYSTEM, budget);

      ask();
    });
  }

  console.log('欢迎使用 Coding Agent！输入 "exit" 退出。');
  ask();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCliAgent();
}
