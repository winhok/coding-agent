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
import { allTools } from "./tools/index.ts";
import { MCPClient } from "./tools/mcp-client.ts";
import { type MCPToolClient, ToolRegistry } from "./tools/registry.ts";

const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  throw new Error("Missing DASHSCOPE_API_KEY environment variable");
}

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey,
});

const model: LanguageModel = qwen.chat("qwen-plus-latest");

const GITHUB_MCP_REMOTE_URL = "https://api.githubcopilot.com/mcp/";

export type ConnectMCPOptions = {
  githubToken?: string;
  canSpawn?: () => boolean | Promise<boolean>;
  createClient?: (githubToken: string) => MCPToolClient;
  log?: (message: string) => void;
};

type RuntimeOptions = ConnectMCPOptions & {
  model?: LanguageModel;
  connectMCP?: boolean;
};

type AgentTools = ReturnType<ToolRegistry["toAISDKFormat"]>;

export type CodingAgentRuntime = {
  agent: Agent<never, AgentTools>;
  registry: ToolRegistry;
  registeredMCPTools: string[];
  close(): Promise<void>;
};

async function detectCanSpawn(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createGitHubMCPClient(githubToken: string): MCPToolClient {
  return new MCPClient({
    type: "http",
    url: GITHUB_MCP_REMOTE_URL,
    headers: { Authorization: `Bearer ${githubToken}` },
  });
}

export async function connectMCP(
  targetRegistry: ToolRegistry,
  options: ConnectMCPOptions = {},
): Promise<string[]> {
  const log = options.log ?? console.log;
  const githubToken =
    options.githubToken ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  if (!githubToken) {
    log("\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，跳过 GitHub MCP");
    return [];
  }

  if (options.createClient) {
    const canSpawn = options.canSpawn
      ? await options.canSpawn()
      : await detectCanSpawn();
    if (!canSpawn) {
      log("\n当前环境无法启动 MCP 子进程，跳过 GitHub MCP");
      return [];
    }
  }

  log(`\n连接 GitHub MCP Server: ${GITHUB_MCP_REMOTE_URL}`);
  try {
    const client = options.createClient
      ? options.createClient(githubToken)
      : createGitHubMCPClient(githubToken);
    const tools = await targetRegistry.registerMCPServer("github", client);
    log(`  已注册 ${tools.length} 个 MCP 工具`);
    return tools;
  } catch (err) {
    log(
      `  MCP 连接失败，已跳过 GitHub MCP: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

const SYSTEM = `你是 Coding Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(...allTools);
  return registry;
}

export function createAgent(
  registry: ToolRegistry,
  runtimeModel: LanguageModel = model,
): Agent<never, AgentTools> {
  return new ToolLoopAgent<never, AgentTools>({
    id: "coding-agent",
    model: runtimeModel,
    instructions: SYSTEM,
    tools: registry.toAISDKFormat(),
    stopWhen: stepCountIs(15),
    maxRetries: 0,
  });
}

export async function createRuntime(
  options: RuntimeOptions = {},
): Promise<CodingAgentRuntime> {
  const runtimeRegistry = createRegistry();
  const registeredMCPTools =
    options.connectMCP === false
      ? []
      : await connectMCP(runtimeRegistry, options);
  const runtimeAgent = createAgent(runtimeRegistry, options.model ?? model);

  return {
    agent: runtimeAgent,
    registry: runtimeRegistry,
    registeredMCPTools,
    close: async () => {
      await runtimeRegistry.closeAllMCP();
    },
  };
}

async function runCliAgent(): Promise<void> {
  const runtime = await createRuntime();
  const { registry } = runtime;

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
        await runtime.close();
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
  runCliAgent().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
