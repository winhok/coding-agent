import "dotenv/config";
import fs from "node:fs";
import { createInterface } from "node:readline";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { agentLoop } from "./agent/loop.ts";
import { FeishuChannel } from "./channels/feishu.js";
import { ChannelGateway } from "./channels/gateway.js";
import { createChannelCommands } from "./commands/channel.js";
import { contextCommands } from "./commands/context.js";
import { dreamCommands } from "./commands/dream.js";
import { type CommandContext, createDispatcher } from "./commands/index.js";
import { memoryCommands } from "./commands/memory.js";
import { createPluginCommands } from "./commands/plugin.js";
import { ragCommands } from "./commands/rag.js";
import { createSecurityCommands } from "./commands/security.js";
import { createSkillCommands } from "./commands/skill.js";
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
import { memoryContext, ragContext } from "./context/prompt-pipes.js";
import { MemoryStore } from "./memory/store.js";
import { PluginManager } from "./plugins/manager.js";
import type { PluginDefinition } from "./plugins/types.js";
import { createDashScopeEmbedder } from "./rag/embedder.js";
import { importDocuments } from "./rag/ingest.js";
import { SqliteVectorStore } from "./rag/sqlite-store.js";
import { HookPipeline } from "./security/hooks.js";
import { remapMessageTimestamps, SessionStore } from "./session/store.js";
import { SkillLoader } from "./skills/loader.js";
import { allTools } from "./tools/index.ts";
import { MCPClient } from "./tools/mcp-client.ts";
import { createMemoryTool } from "./tools/memory-tools.js";
import { createRagTools } from "./tools/rag-tools.js";
import { ToolRegistry } from "./tools/registry.js";
import { createSkillTool } from "./tools/skill-tool.js";
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

const vectorStore = new SqliteVectorStore("knowledge.db");
const embedFn = createDashScopeEmbedder(apiKey);
registry.register(...createRagTools(vectorStore, embedFn));

const skillLoader = new SkillLoader(".");
const loadedSkills = skillLoader.load();
registry.register(createSkillTool(skillLoader));

// ── Plugins ────────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>();

// ── Security: Hook Pipeline ────────────────────────────────
const hookPipeline = new HookPipeline();

// 示例 Pre Hook: 写文件前记录审计日志
hookPipeline.registerPre("audit-log", (toolName, input) => {
  if (toolName === "write_file" || toolName === "edit_file") {
    const path = (input as { path?: unknown })?.path || "unknown";
    console.log(`  [audit] 文件写入操作: ${toolName} → ${String(path)}`);
  }
  return { action: "allow" };
});

// 示例 Post Hook: 给 bash 输出加时间戳
hookPipeline.registerPost("bash-timestamp", (toolName, _input, output) => {
  if (toolName === "bash") {
    const timestamp = new Date().toISOString();
    return { action: "modify", modifiedOutput: `[${timestamp}]\n${output}` };
  }
  return { action: "allow" };
});

registry.setHookPipeline(hookPipeline);

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

async function importNewDocuments(): Promise<void> {
  if (!fs.existsSync("docs")) return;

  const files = fs
    .readdirSync("docs")
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/${file}`);

  if (files.length === 0) return;

  console.log(`  发现 ${files.length} 个候选文档，检查知识库更新...`);
  const summary = await importDocuments(files, vectorStore, embedFn);
  for (const result of summary.imported) {
    console.log(`    ${result.source} → ${result.chunks} 个片段`);
  }
  for (const failure of summary.failed) {
    console.log(`    ${failure.source} → 导入失败: ${failure.error}`);
  }
  console.log(
    `  知识库就绪：导入 ${summary.imported.length}，跳过 ${summary.skipped.length}，失败 ${summary.failed.length}，共 ${vectorStore.size()} 个片段\n`,
  );
}

async function main() {
  await connectMCP();

  console.log("  加载插件...");
  for (const [name, definition] of availablePlugins) {
    try {
      const tools = await pluginManager.load(definition);
      console.log(`  ✓ ${name} — ${tools.length} 个工具`);
    } catch {
      console.log(`  ✗ ${name} — 加载失败`);
    }
  }

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
    .pipe("memoryContext", memoryContext(memoryStore))
    .pipe("ragContext", ragContext(vectorStore))
    .pipe("skillContext", () => skillLoader.buildPromptSection())
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

  // ── Channel Gateway ───────────────────────
  const gateway = new ChannelGateway({
    model,
    registry,
    buildSystem: () => builder.build(makePromptCtx()),
  });

  const feishuAppId = process.env.FEISHU_APP_ID || "";
  const feishuAppSecret = process.env.FEISHU_APP_SECRET || "";
  if (feishuAppId && feishuAppSecret) {
    gateway.register(
      new FeishuChannel({ appId: feishuAppId, appSecret: feishuAppSecret }),
    );
  } else {
    console.log("  飞书未配置 APP_ID / APP_SECRET，跳过注册");
  }

  const dispatch = createDispatcher([
    ...contextCommands,
    ...memoryCommands,
    ...ragCommands,
    ...dreamCommands,
    ...createSkillCommands(skillLoader),
    ...createPluginCommands(pluginManager, availablePlugins),
    ...createChannelCommands(gateway),
    ...createSecurityCommands(registry, hookPipeline),
  ]);

  console.log("  启动 Channel...");
  await gateway.startAll();

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
        await gateway.stopAll();
        await pluginManager.unloadAll();
        await registry.closeAllMCP();
        vectorStore.close();
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
        vectorStore,
        modelName: MODEL_CONFIG.name,
        modelId: typeof model === "string" ? model : model.modelId,
        contextWindowTokens: MODEL_CONFIG.contextWindowTokens,
        effectiveContextWindowTokens: MODEL_CONFIG.effectiveContextWindowTokens,
        autocompactThresholdTokens: AUTOCOMPACT_THRESHOLD_TOKENS,
        estimatedContextTokens: tokenTracker.estimatedTokens,
        tokenMeasurement: tokenTracker.measurement,
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

  console.log('Super Agent v0.17 — Permissions & Hooks (type "/exit" to quit)');
  console.log("快捷命令：");
  console.log("  /role [角色]     — 查看/切换角色 (owner|collaborator|guest)");
  console.log("  /hooks           — 查看 Hook 管线");
  console.log("  /channel         — 查看通道状态");
  console.log("  /plugin          — 查看插件状态");
  console.log("  /plugin load X   — 加载插件");
  console.log("  /plugin unload X — 卸载插件");
  console.log("  /skill          — 查看可用的 skills");
  console.log("  /code-review    — 直接加载并执行 code-review skill");
  console.log("  /ingest <path>  — 导入文档到知识库");
  console.log("  /rag            — 查看知识库状态");
  console.log("  /memory         — 查看记忆（带 ⚠️ 标记）");
  console.log("  /memory search <关键词> — 搜索记忆");
  console.log("  /lint           — 扫描记忆库");
  console.log("  /dream          — 记忆整理（lint → 清理 → 合并 → 报告）");
  console.log("  /context        — 终端里看 context 占用矩阵");
  console.log("  /usage          — 累计 token 用量和成本");
  console.log("  /status         — 当前消息数、token 和记忆数");
  console.log("  /exit           — 退出");
  console.log("");
  console.log(`  已加载 ${memoryStore.list().length} 条历史记忆`);
  const role = registry.getRole();
  const toolCount = registry.getActiveTools().length;
  const hooks = hookPipeline.list();
  console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
  console.log(
    `  Hook: ${hooks.pre.length} 个 pre + ${hooks.post.length} 个 post`,
  );
  const pluginList = pluginManager.list();
  if (pluginList.length > 0) {
    console.log(`  已加载 ${pluginList.length} 个插件：`);
    for (const plugin of pluginList) {
      console.log(`    ${plugin.name} — ${plugin.tools.join(", ")}`);
    }
  }
  if (loadedSkills.length > 0) {
    console.log(`  发现 ${loadedSkills.length} 个 skill：`);
    for (const skill of loadedSkills) {
      console.log(`    /${skill.name} — ${skill.description}`);
    }
  }
  console.log("");

  await importNewDocuments();
  ask();
}

main().catch(console.error);
