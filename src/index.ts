import "dotenv/config";
import { createInterface } from "node:readline";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { agentLoop } from "./agent/loop.ts";
import { contextCommands } from "./commands/context.js";
import { type CommandContext, createDispatcher } from "./commands/index.js";
import { memoryCommands } from "./commands/memory.js";
import {
  estimateTokens,
  microcompact,
  summarize,
} from "./context/compressor.js";
import { applyDefense, TokenTracker } from "./context/defense.js";
import {
  coreRules,
  deferredTools,
  memoryContext,
  PromptBuilder,
  type PromptContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder.js";
import { MemoryStore } from "./memory/store.js";
import { remapMessageTimestamps, SessionStore } from "./session/store.js";
import { allTools } from "./tools/index.ts";
import { MCPClient } from "./tools/mcp-client.ts";
import { createMemoryTool } from "./tools/memory-tools.js";
import { ToolRegistry } from "./tools/registry.js";
import { createToolSearchTool } from "./tools/tool-search.js";
import { promptTokensFromUsage, UsageTracker } from "./usage/tracker.js";

const MODEL_CONFIG = {
  id: "qwen3.7-plus-2026-05-26",
  name: "Qwen 3.7 Plus (2026-05-26)",
  contextWindowTokens: 1_000_000,
  effectiveContextWindowTokens: 950_000,
} as const;
const AUTOCOMPACT_THRESHOLD_RATIO = 0.2;
const AUTOCOMPACT_THRESHOLD_TOKENS = Math.round(
  MODEL_CONFIG.contextWindowTokens * AUTOCOMPACT_THRESHOLD_RATIO,
);

const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  throw new Error("Missing DASHSCOPE_API_KEY environment variable");
}

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey,
});

const model = qwen.chat(MODEL_CONFIG.id);

const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

const memoryStore = new MemoryStore(".");
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

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

const dispatch = createDispatcher([...contextCommands, ...memoryCommands]);

async function main() {
  await connectMCP();

  const store = new SessionStore("default");
  let messages: ModelMessage[] = [];
  const timestamps = new Map<number, number>();
  const tracker = new UsageTracker(".usage/today.jsonl");

  const tokenTracker = new TokenTracker(
    MODEL_CONFIG.effectiveContextWindowTokens,
  );
  const isContinue = process.argv.includes("--continue");

  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("memory", memoryContext(memoryStore))
    .pipe("sessionContext", sessionContext());

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function makePromptCtx(): PromptContext {
    return {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId: "default",
    };
  }

  if (isContinue && store.exists()) {
    const loaded = store.load();
    messages = loaded.messages;
    for (const [index, timestamp] of loaded.timestamps) {
      timestamps.set(index, timestamp);
    }
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log("[Session] 新会话");
  }

  let summary = "";

  tokenTracker.addMessages(messages);

  builder.debug(makePromptCtx());

  const activeTools = registry.getActiveTools();
  console.log(`活跃工具: ${activeTools.length} 个`);

  function replaceMessages(nextMessages: ModelMessage[]) {
    const nextTimestamps = remapMessageTimestamps(
      messages,
      nextMessages,
      timestamps,
    );
    tokenTracker.replaceMessages(messages, nextMessages);
    messages.splice(0, messages.length, ...nextMessages);
    timestamps.clear();
    for (const [index, timestamp] of nextTimestamps) {
      timestamps.set(index, timestamp);
    }
  }

  async function compactIfNeeded(): Promise<boolean> {
    const currentTokens = tokenTracker.estimatedTokens;
    if (currentTokens <= AUTOCOMPACT_THRESHOLD_TOKENS) return false;

    console.log(`\n  [压缩检查] ~${currentTokens} tokens, 触发压缩...`);
    const compacted = microcompact(messages);
    replaceMessages(compacted.messages);
    if (compacted.cleared > 0) {
      console.log(`  [Microcompact] 清理了 ${compacted.cleared} 个工具结果`);
    }

    const compression = await summarize(model, messages, summary);
    if (compression.compressedCount > 0) {
      replaceMessages(compression.messages);
      summary = compression.summary;
      console.log(
        `  [Summarization] 压缩了 ${compression.compressedCount} 条消息, ~${estimateTokens(messages)} tokens`,
      );
    }
    return true;
  }

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (trimmed === "/exit") {
        console.log("Bye!");
        await registry.closeAllMCP();
        rl.close();
        return;
      }
      if (!trimmed) {
        ask();
        return;
      }

      const ctx: CommandContext = {
        messages,
        timestamps,
        registry,
        builder,
        tracker,
        sessionStore: store,
        model,
        makePromptCtx,
        ask,
        replaceMessages,
        memoryStore,
        modelName: MODEL_CONFIG.name,
        modelId: typeof model === "string" ? model : model.modelId,
        contextWindowTokens: MODEL_CONFIG.contextWindowTokens,
        autocompactThresholdTokens: AUTOCOMPACT_THRESHOLD_TOKENS,
        estimatedContextTokens: tokenTracker.estimatedTokens,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === "async") return;
      if (handled) {
        ask();
        return;
      }

      const userMsg: ModelMessage = { role: "user", content: trimmed };
      messages.push(userMsg);
      tokenTracker.addMessage(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      const turnDefense = applyDefense(
        messages,
        timestamps,
        MODEL_CONFIG.effectiveContextWindowTokens,
      );
      replaceMessages(turnDefense.messages);
      await compactIfNeeded();

      const currentSystem = builder.build(makePromptCtx());
      const newMessages = await agentLoop(
        model,
        registry,
        messages,
        currentSystem,
        tracker,
        async (usage, responseMessages, needsFollowUp) => {
          const promptTokens = promptTokensFromUsage(usage);
          if (promptTokens > 0) tokenTracker.updateFromAPI(promptTokens);
          tokenTracker.addMessages(responseMessages);
          const responseStart = messages.length - responseMessages.length;
          const now = Date.now();
          for (let index = responseStart; index < messages.length; index++) {
            timestamps.set(index, now);
          }
          if (needsFollowUp) await compactIfNeeded();
        },
      );

      const now = Date.now();
      for (const message of newMessages) {
        const index = messages.indexOf(message);
        if (index >= 0 && !timestamps.has(index)) timestamps.set(index, now);
      }
      store.appendAll(newMessages);

      const status = tokenTracker.status;
      console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`);

      await compactIfNeeded();

      ask();
    });
  }

  console.log('Super Agent v0.11 — Memory System (type "/exit" to quit)');
  console.log("快捷命令：");
  console.log("  /memory         — 查看所有记忆");
  console.log("  /memory search <关键词> — 搜索记忆");
  console.log("  /context        — 终端里看 context 占用矩阵");
  console.log("  /usage          — 累计 token 用量和成本");
  console.log("  /status         — 当前消息数、token 和记忆数");
  console.log("  /exit           — 退出");
  console.log("");
  console.log(`  已加载 ${memoryStore.list().length} 条历史记忆`);
  console.log("");

  ask();
}

main().catch(console.error);
