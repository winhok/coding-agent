import fs from "node:fs";
import { type SuperAgentConfig, SuperAgentConfigSchema } from "./schema.js";

export const CONFIG_FILE = "super-agent.config.json";

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(ENV_VAR_RE, (match, name: string) => {
      const value = process.env[name];
      if (value === undefined) {
        console.warn(`  ⚠ 环境变量 ${name} 未设置，保留原值`);
        return match;
      }
      return value;
    });
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
  if (!fs.existsSync(path)) {
    console.log(`  未找到 ${path}，使用默认配置`);
    console.log("  运行 pnpm run init 生成配置文件\n");
    return SuperAgentConfigSchema.parse({});
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`解析 ${path} 失败: ${(error as Error).message}`);
  }

  const substituted = substituteEnvVars(raw);
  const result = SuperAgentConfigSchema.safeParse(substituted);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`配置文件校验失败: ${issues}`);
  }

  console.log(`  ✓ 已加载 ${path}`);
  return result.data;
}
