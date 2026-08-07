import fs from "node:fs";
import { createInterface } from "node:readline";
import { CONFIG_FILE } from "./loader.js";
import { DEFAULT_AGENT_PROFILES } from "./schema.js";

function envReference(name: string): string {
  return `\${${name}}`;
}

export async function runInit(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      console.log(question);
      rl.question("  > ", resolve);
    });

  console.log("\n  Super Agent 初始化向导\n");

  if (fs.existsSync(CONFIG_FILE)) {
    const overwrite = await ask(`  ${CONFIG_FILE} 已存在，覆盖? (y/N): `);
    if (overwrite.toLowerCase() !== "y") {
      console.log("  已取消\n");
      rl.close();
      return;
    }
  }

  console.log("  选择模型:\n");
  console.log("    1. qwen3.7-plus-2026-05-26   (推荐)\n");
  await ask("  模型 [1]: ");

  const apiKey = await ask(
    "\n  DashScope API Key (留空则从环境变量 DASHSCOPE_API_KEY 读取): ",
  );

  const enableFeishu =
    (await ask("\n  启用飞书 Channel? (y/N): ")).toLowerCase() === "y";
  let feishuAppId = "";
  let feishuAppSecret = "";
  if (enableFeishu) {
    feishuAppId = await ask("  飞书 App ID: ");
    feishuAppSecret = await ask("  飞书 App Secret: ");
  }

  const concurrentStr = await ask("\n  子 Agent 最大并发数 [3]: ");
  const maxConcurrent = Number.parseInt(concurrentStr, 10) || 3;

  const config = {
    version: "1.0",
    model: {
      provider: "dashscope",
      name: "qwen3.7-plus-2026-05-26",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: envReference("DASHSCOPE_API_KEY"),
    },
    plugins: [],
    mcp: { servers: [] },
    channels: {
      feishu: {
        enabled: enableFeishu,
        appId: envReference("FEISHU_APP_ID"),
        appSecret: envReference("FEISHU_APP_SECRET"),
        port: 3000,
      },
    },
    agents: {
      maxSpawnDepth: 1,
      maxConcurrent,
      defaultTimeout: 60_000,
      profiles: DEFAULT_AGENT_PROFILES,
    },
    security: { defaultRole: "owner", auditLog: true, bashTimestamp: true },
    memory: { dataDir: "." },
    rag: { enabled: true, docsDir: "docs" },
    cron: { enabled: true, dataDir: "." },
    session: { id: "default" },
    usage: { trackingFile: ".usage/today.jsonl" },
  };

  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\n  ✓ ${CONFIG_FILE} 已生成`);

  const envLines: string[] = [];
  if (apiKey) envLines.push(`DASHSCOPE_API_KEY=${apiKey}`);
  if (enableFeishu && feishuAppId) {
    envLines.push(`FEISHU_APP_ID=${feishuAppId}`);
    envLines.push(`FEISHU_APP_SECRET=${feishuAppSecret}`);
  }
  if (envLines.length > 0) {
    fs.writeFileSync(".env", `${envLines.join("\n")}\n`);
    console.log("  ✓ .env 已生成");
  }

  console.log("\n  启动 Agent: pnpm start\n");
  rl.close();
}
