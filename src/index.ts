import "dotenv/config";
import { createInterface } from "node:readline";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel, ModelMessage } from "ai";
import { agentLoop } from "./agent/loop.ts";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  type PromptContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder.js";
import { SessionStore } from "./session/store.js";
import { allTools } from "./tools/index.ts";
import { MCPClient } from "./tools/mcp-client.ts";
import { type ToolDefinition, ToolRegistry } from "./tools/registry.ts";

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

const toolSearchTool: ToolDefinition = {
  name: "tool_search",
  description:
    "获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query);
    if (results.length === 0) return `没有找到工具: ${query}`;
    return results.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};
registry.register(toolSearchTool);

const GITHUB_MCP_REMOTE_URL = "https://api.githubcopilot.com/mcp/";

export async function connectMCP(targetRegistry = registry) {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  if (!githubToken) {
    console.log("\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，跳过 GitHub MCP");
    return [];
  }

  console.log(`\n连接 GitHub MCP Server: ${GITHUB_MCP_REMOTE_URL}`);
  try {
    const client = new MCPClient({
      type: "http",
      url: GITHUB_MCP_REMOTE_URL,
      headers: { Authorization: `Bearer ${githubToken}` },
    });
    const tools = await targetRegistry.registerMCPServer("github", client);
    console.log(`  已注册 ${tools.length} 个 MCP 工具`);
    return tools;
  } catch (err) {
    console.log(
      `  MCP 连接失败，已跳过 GitHub MCP: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

async function main() {
  await connectMCP();

  const isContinue = process.argv.includes("--continue");
  const sessionId = "default";
  const store = new SessionStore(sessionId);

  let messages: ModelMessage[] = [];
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(
      `\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`,
    );
  } else {
    console.log(`\n[Session] 新会话 "${sessionId}"`);
  }

  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("sessionContext", sessionContext());

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  };

  const SYSTEM = builder.build(promptCtx);

  builder.debug(promptCtx);

  const activeTools = registry.getActiveTools();
  console.log(`活跃工具: ${activeTools.length} 个`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        console.log("Bye!");
        await registry.closeAllMCP();
        rl.close();
        return;
      }

      const userMsg: ModelMessage = { role: "user", content: trimmed };
      messages.push(userMsg);
      store.append(userMsg);

      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, SYSTEM);

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      store.appendAll(newMessages);

      ask();
    });
  }

  ask();
}
