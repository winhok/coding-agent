import "dotenv/config";
import fs from "node:fs";
import { createInterface } from "node:readline";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { agentLoop } from "./agent/loop.ts";
import { terminalAgentEventSink } from "./agent/terminal-event-sink.js";
import { SubAgentRegistry } from "./agents/registry.js";
import type { SpawnContext } from "./agents/spawn.js";
import { FeishuChannel } from "./channels/feishu.js";
import { ChannelGateway } from "./channels/gateway.js";
import { createAgentCommands } from "./commands/agent.js";
import { createChannelCommands } from "./commands/channel.js";
import { contextCommands } from "./commands/context.js";
import { createCronCommands } from "./commands/cron.js";
import { dreamCommands } from "./commands/dream.js";
import { type CommandContext, createDispatcher } from "./commands/index.js";
import { memoryCommands } from "./commands/memory.js";
import { createPluginCommands } from "./commands/plugin.js";
import { ragCommands } from "./commands/rag.js";
import { createSecurityCommands } from "./commands/security.js";
import { createSkillCommands } from "./commands/skill.js";
import { loadConfig } from "./config/loader.js";
import type { SuperAgentConfig } from "./config/schema.js";
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
import { CronService } from "./cron/service.js";
import { MemoryStore } from "./memory/store.js";
import { PluginManager } from "./plugins/manager.js";
import type { PluginDefinition } from "./plugins/types.js";
import { createDashScopeEmbedder } from "./rag/embedder.js";
import { importDocuments } from "./rag/ingest.js";
import { SqliteVectorStore } from "./rag/sqlite-store.js";
import { HookPipeline } from "./security/hooks.js";
import type {
  ApprovalRequest,
  RequestApproval,
} from "./security/permissions.js";
import { remapMessageTimestamps, SessionStore } from "./session/store.js";
import { SkillLoader } from "./skills/loader.js";
import { createCronTool } from "./tools/cron-tools.js";
import { allTools } from "./tools/index.ts";
import { MCPClient } from "./tools/mcp-client.ts";
import { createMemoryTool } from "./tools/memory-tools.js";
import { createRagTools } from "./tools/rag-tools.js";
import { ToolRegistry } from "./tools/registry.js";
import { createSkillTool } from "./tools/skill-tool.js";
import { createSpawnTool } from "./tools/spawn-tools.js";
import { createToolSearchTool } from "./tools/tool-search.js";
import { LocalTraceRecorder } from "./trace/recorder.js";
import { promptTokensFromUsage, UsageTracker } from "./usage/tracker.js";

// ── 加载配置 ────────────────────────────────
const config = loadConfig();

const MODEL_CONFIG = {
  id: config.model.name,
  name: config.model.name,
  contextWindowTokens: 1_000_000,
  effectiveContextWindowTokens: 950_000,
} as const;
const AUTOCOMPACT_THRESHOLD_RATIO = 0.2;
const AUTOCOMPACT_THRESHOLD_TOKENS = Math.round(
  MODEL_CONFIG.contextWindowTokens * AUTOCOMPACT_THRESHOLD_RATIO,
);

function resolveApiKey(modelConfig: SuperAgentConfig["model"]): string {
  const configuredKey = modelConfig.apiKey.startsWith("${")
    ? ""
    : modelConfig.apiKey;
  const apiKey = configuredKey || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing model API key. Run pnpm run init or set DASHSCOPE_API_KEY.",
    );
  }
  return apiKey;
}

function createModel(modelConfig: SuperAgentConfig["model"], apiKey: string) {
  const provider = createOpenAI({ baseURL: modelConfig.baseURL, apiKey });
  return provider.chat(modelConfig.name);
}

const apiKey = resolveApiKey(config.model);
const model = createModel(config.model, apiKey);

const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

const memoryStore = new MemoryStore(config.memory.dataDir);
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

const vectorStore = config.rag.enabled
  ? new SqliteVectorStore("knowledge.db")
  : undefined;
const embedFn = config.rag.enabled
  ? createDashScopeEmbedder(apiKey)
  : undefined;
if (vectorStore && embedFn) {
  registry.register(...createRagTools(vectorStore, embedFn));
}

const skillLoader = new SkillLoader(".");
const loadedSkills = skillLoader.load();
registry.register(createSkillTool(skillLoader));

// ── Plugins ────────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>();

// ── Security: Hook Pipeline ────────────────────────────────
const hookPipeline = new HookPipeline();

if (config.security.auditLog) {
  hookPipeline.registerPre("audit-log", (toolName, input) => {
    if (toolName === "write_file" || toolName === "edit_file") {
      const path = (input as { path?: unknown })?.path || "unknown";
      console.log(`  [audit] 文件写入操作: ${toolName} → ${String(path)}`);
    }
    return { action: "allow" };
  });
}

if (config.security.bashTimestamp) {
  hookPipeline.registerPost("bash-timestamp", (toolName, _input, output) => {
    if (toolName === "bash") {
      const timestamp = new Date().toISOString();
      return { action: "modify", modifiedOutput: `[${timestamp}]\n${output}` };
    }
    return { action: "allow" };
  });
}

registry.setHookPipeline(hookPipeline);
registry.setRole(config.security.defaultRole);

// ── Cron Service ────────────────────────────────
const cronService = config.cron.enabled
  ? new CronService(config.cron.dataDir)
  : undefined;
if (cronService) registry.register(createCronTool(cronService));

// ── Sub-Agent ────────────────────────────────
const agentRegistry = new SubAgentRegistry({
  maxSpawnDepth: config.agents.maxSpawnDepth,
  maxConcurrent: config.agents.maxConcurrent,
  defaultTimeout: config.agents.defaultTimeout,
});

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
  if (!vectorStore || !embedFn || !fs.existsSync(config.rag.docsDir)) return;

  const files = fs
    .readdirSync(config.rag.docsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => `${config.rag.docsDir}/${file}`);

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

export async function startAgent(): Promise<void> {
  await connectMCP();

  console.log("  加载插件...");
  for (const pluginConfig of config.plugins) {
    const definition = availablePlugins.get(pluginConfig.name);
    if (!definition) {
      console.log(`  ✗ ${pluginConfig.name} — 未知插件`);
      continue;
    }
    if (!pluginConfig.enabled) {
      console.log(`  - ${pluginConfig.name} — 已禁用`);
      continue;
    }
    try {
      const tools = await pluginManager.load(definition);
      console.log(`  ✓ ${pluginConfig.name} — ${tools.length} 个工具`);
    } catch {
      console.log(`  ✗ ${pluginConfig.name} — 加载失败`);
    }
  }

  const store = new SessionStore(config.session.id);
  let messages: ModelMessage[] = [];
  const timestamps = new Map<number, number>();
  const tracker = new UsageTracker(config.usage.trackingFile);

  const tokenTracker = new TokenTracker(
    MODEL_CONFIG.effectiveContextWindowTokens,
  );
  const isContinue = process.argv.includes("--continue");

  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("memoryContext", memoryContext(memoryStore))
    .pipe("skillContext", () => skillLoader.buildPromptSection())
    .pipe("sessionContext", sessionContext());
  if (vectorStore) builder.pipe("ragContext", ragContext(vectorStore));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let approvalQueue = Promise.resolve();

  const requestApproval: RequestApproval = (request) => {
    const decision = approvalQueue.then(() => promptForApproval(request));
    approvalQueue = decision.then(
      () => undefined,
      () => undefined,
    );
    return decision;
  };

  function promptForApproval(request: ApprovalRequest): Promise<boolean> {
    const input = request.input as Record<string, unknown> | null;
    const target =
      request.tool === "bash"
        ? String(input?.command ?? "")
        : typeof input?.path === "string"
          ? input.path
          : String(JSON.stringify(request.input) ?? request.input ?? "").slice(
              0,
              160,
            );

    console.log(`\n  [权限确认] ${request.tool}: ${target}`);
    console.log(`  原因: ${request.reason}`);
    return new Promise((resolve) => {
      rl.question("  允许执行? (y/N) ", (answer) => {
        resolve(answer.trim().toLowerCase().startsWith("y"));
      });
    });
  }

  function makePromptCtx(): PromptContext {
    return {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId: config.session.id,
    };
  }

  function getSpawnContext(): SpawnContext {
    return {
      model,
      registry,
      agentRegistry,
      buildSystem: () => builder.build(makePromptCtx()),
      currentDepth: 0,
    };
  }

  registry.register(createSpawnTool(agentRegistry, getSpawnContext));

  // ── Channel Gateway ───────────────────────
  const gateway = new ChannelGateway({
    model,
    registry,
    buildSystem: () => builder.build(makePromptCtx()),
  });

  if (config.channels.feishu.enabled) {
    gateway.register(
      new FeishuChannel({
        appId: config.channels.feishu.appId,
        appSecret: config.channels.feishu.appSecret,
      }),
    );
  }

  const dispatch = createDispatcher([
    ...contextCommands,
    ...memoryCommands,
    ...(vectorStore ? ragCommands : []),
    ...dreamCommands,
    ...createSkillCommands(skillLoader),
    ...createPluginCommands(pluginManager, availablePlugins),
    ...createChannelCommands(gateway),
    ...createSecurityCommands(registry, hookPipeline),
    ...(cronService ? createCronCommands(cronService) : []),
    ...createAgentCommands(agentRegistry),
  ]);

  console.log("  启动 Channel...");
  await gateway.startAll();

  if (cronService) {
    cronService.load();
    cronService.setExecutor({
      runAgentPrompt: async (prompt) => {
        const cronMessages: ModelMessage[] = [
          { role: "user", content: prompt },
        ];
        const system = builder.build(makePromptCtx());
        await agentLoop({
          model,
          registry,
          messages: cronMessages,
          system,
          eventSink: terminalAgentEventSink,
        });
        const lastMessage = cronMessages[cronMessages.length - 1];
        if (!lastMessage) return "(无输出)";
        if (typeof lastMessage.content === "string") return lastMessage.content;
        if (Array.isArray(lastMessage.content)) {
          return (
            lastMessage.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("") || "(无输出)"
          );
        }
        return String(lastMessage.content);
      },
      notify: (message) => {
        console.log(`\n${message}`);
      },
    });
    cronService.start();
  }
  const cronJobs = cronService?.list() ?? [];
  console.log(`  Cron: ${cronJobs.length} 个任务已加载`);

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
        cronService?.stop();
        await gateway.stopAll();
        await pluginManager.unloadAll();
        await registry.closeAllMCP();
        vectorStore?.close();
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
        ...(vectorStore ? { vectorStore } : {}),
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
      const trace = await LocalTraceRecorder.start({
        sessionId: config.session.id,
        model: model.modelId || config.model.name,
      });
      let newMessages: ModelMessage[];
      try {
        const result = await agentLoop({
          model,
          registry,
          messages,
          system: currentSystem,
          tracker,
          onStepUsage: async (usage, responseMessages, needsFollowUp) => {
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
          eventSink: terminalAgentEventSink,
          trace,
          requestApproval,
        });
        newMessages = result.appendedMessages;
        await trace.finish("completed");
        console.log(`  [Trace] ${trace.filePath}`);
      } catch (error) {
        await trace.finish("failed", error);
        console.error(
          `  [Agent] ${error instanceof Error ? error.message : String(error)}`,
        );
        ask();
        return;
      }

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

  console.log('Super Agent v0.19 — Sub-Agent 机制 (type "/exit" to quit)');
  console.log("快捷命令：");
  console.log("  /cron            — 查看定时任务");
  console.log("  /cron logs       — 查看执行记录");
  console.log("  /agents          — 查看子 Agent 运行记录");
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
  if (cronService) console.log(`  Cron: ${cronJobs.length} 个定时任务`);
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
