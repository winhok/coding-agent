import "dotenv/config";
import { createInterface } from "node:readline";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { agentLoop } from "./agent/loop.ts";
import {
  estimateTokens,
  microcompact,
  summarize,
} from "./context/compressor.js";
import { applyDefense, TokenTracker } from "./context/defense.js";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  type PromptContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder.js";
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "./context/view.js";
import { SessionStore } from "./session/store.js";
import { allTools } from "./tools/index.ts";
import { MCPClient } from "./tools/mcp-client.ts";
import { type ToolDefinition, ToolRegistry } from "./tools/registry.js";
import { UsageTracker } from "./usage/tracker.js";

const MODEL_NAME = "Qwen 3.7 Plus (2026-05-26)";
const CONTEXT_WINDOW_TOKENS = 1_000_000;
const AUTOCOMPACT_THRESHOLD_TOKENS = 200_000;

const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  throw new Error("Missing DASHSCOPE_API_KEY environment variable");
}

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey,
});

const model = qwen.chat("qwen3.7-plus-2026-05-26");

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

  const store = new SessionStore("default");
  let messages: ModelMessage[] = [];
  const timestamps = new Map<number, number>();
  const tokenTracker = new TokenTracker();
  const usageTracker = new UsageTracker();
  const isContinue = process.argv.includes("--continue");

  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log("[Session] 新会话");
  }

  let summary = "";

  tokenTracker.addMessages(messages);

  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("sessionContext", sessionContext());

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: "default",
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

      if (trimmed === "/context") {
        const toolDescriptionChars = registry
          .getActiveTools()
          .reduce(
            (total, tool) =>
              total +
              JSON.stringify({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }).length,
            0,
          );
        const snapshot = buildContextSnapshot({
          modelName: MODEL_NAME,
          modelId: model.modelId,
          windowTokens: CONTEXT_WINDOW_TOKENS,
          systemPromptChars: SYSTEM.length,
          toolDescriptionChars,
          memoryChars: 0,
          skillsChars: 0,
          messages,
          autocompactBufferTokens:
            CONTEXT_WINDOW_TOKENS - AUTOCOMPACT_THRESHOLD_TOKENS,
        });
        console.log(renderContextView(snapshot));
        ask();
        return;
      }

      if (trimmed === "/usage") {
        console.log(renderUsageView(usageTracker));
        ask();
        return;
      }

      if (trimmed.startsWith("/cache")) {
        const mode = trimmed.split(/\s+/)[1];
        if (mode === "on" || mode === "off") {
          usageTracker.setCacheEnabled(mode === "on");
          const message =
            mode === "on"
              ? "按 API 返回的 cache token 计算实际费用"
              : "后续 cache token 将按普通 input 全价计算（仅成本模拟，不改变服务端行为）";
          console.log(`  [Cache] ${message}`);
        } else {
          console.log(
            `  [Cache] 当前为${usageTracker.cacheEnabled ? "实际计费" : "无缓存成本模拟"}模式。用法：/cache on | /cache off`,
          );
        }
        console.log(
          "  [Cache] 当前使用 qwen3.7-plus-2026-05-26 的隐式缓存，未添加显式缓存标记。",
        );
        ask();
        return;
      }

      const userMsg: ModelMessage = { role: "user", content: trimmed };
      messages.push(userMsg);
      tokenTracker.addMessage(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      const turnDefense = applyDefense(messages, timestamps);
      tokenTracker.replaceMessages(messages, turnDefense.messages);
      messages = turnDefense.messages;

      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, SYSTEM, usageTracker);

      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) {
        timestamps.set(i, now);
      }
      store.appendAll(newMessages);

      const status = tokenTracker.status;
      console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`);

      const currentTokens = estimateTokens(messages);
      if (currentTokens > 200_000) {
        console.log(`\n  [压缩检查] ~${currentTokens} tokens, 触发压缩...`);
        const mc2 = microcompact(messages);
        messages = mc2.messages;
        if (mc2.cleared > 0)
          console.log(`  [Microcompact] 清理了 ${mc2.cleared} 个工具结果`);

        const comp2 = await summarize(model, messages, summary);
        if (comp2.compressedCount > 0) {
          messages = comp2.messages;
          summary = comp2.summary;
          console.log(
            `  [Summarization] 压缩了 ${comp2.compressedCount} 条消息, ~${estimateTokens(messages)} tokens`,
          );
        }
      }

      ask();
    });
  }

  ask();
}

main().catch(console.error);
