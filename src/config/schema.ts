import { z } from "zod";

export const ModelConfigSchema = z.object({
  provider: z.enum(["dashscope", "openai", "custom"]).default("dashscope"),
  name: z.string().default("qwen3.7-plus-2026-05-26"),
  baseURL: z
    .string()
    .default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  apiKey: z.string().default(""),
});

export const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.string()).default({}),
});

const MCPServerBaseSchema = {
  name: z
    .string()
    .trim()
    .min(1)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "MCP server name may only contain letters, numbers, underscores, and hyphens",
    ),
  enabled: z.boolean().default(true),
};

export const MCPServerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    ...MCPServerBaseSchema,
    type: z.literal("stdio"),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    ...MCPServerBaseSchema,
    type: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    requestTimeoutMs: z.number().positive().optional(),
  }),
]);

const MCPServersSchema = z
  .array(MCPServerConfigSchema)
  .default([])
  .superRefine((servers, ctx) => {
    const seen = new Set<string>();
    for (const [index, server] of servers.entries()) {
      if (seen.has(server.name)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "MCP server name must be unique",
        });
      }
      seen.add(server.name);
    }
  });

export const MCPConfigSchema = z.object({ servers: MCPServersSchema });

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(""),
  appSecret: z.string().default(""),
  port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.prefault({}),
});

export const ToolCapabilitySchema = z.enum([
  "read",
  "write",
  "execute",
  "delegate",
  "external",
]);

export const AgentProfileConfigSchema = z.object({
  description: z.string().default(""),
  systemPrompt: z.string().default(""),
  capabilities: z.array(ToolCapabilitySchema).min(1),
  tools: z.array(z.string().min(1)).optional(),
});

type AgentProfileConfig = z.infer<typeof AgentProfileConfigSchema>;

export const DEFAULT_AGENT_PROFILES: Record<string, AgentProfileConfig> = {
  general: {
    description: "通用单任务执行者",
    systemPrompt: "自主完成指定任务，并返回简洁、可验证的结果。",
    capabilities: ["read", "write", "execute", "delegate", "external"],
  },
  explorer: {
    description: "只读代码与资料探索者",
    systemPrompt: "只进行检索、阅读和分析，不修改任何状态。结论必须指出依据。",
    capabilities: ["read"],
  },
  editor: {
    description: "代码实现者",
    systemPrompt: "先理解现有实现，再完成必要修改并进行相称的验证。",
    capabilities: ["read", "write", "execute"],
  },
  reviewer: {
    description: "只读审查者",
    systemPrompt: "审查正确性、安全性和测试缺口，只报告有证据的问题。",
    capabilities: ["read"],
  },
};

export const AgentConfigSchema = z
  .object({
    maxSpawnDepth: z.number().min(0).max(5).default(1),
    maxConcurrent: z.number().min(1).max(10).default(3),
    defaultTimeout: z.number().positive().default(60_000),
    profiles: z.record(z.string().min(1), AgentProfileConfigSchema).default({}),
  })
  .transform((value) => ({
    ...value,
    profiles: { ...DEFAULT_AGENT_PROFILES, ...value.profiles },
  }));

export const SecurityConfigSchema = z.object({
  defaultRole: z.enum(["owner", "collaborator", "guest"]).default("owner"),
  auditLog: z.boolean().default(true),
  bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
  dataDir: z.string().default("."),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  docsDir: z.string().default("docs"),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default("."),
});

export const SessionConfigSchema = z.object({
  id: z.string().default("default"),
});

export const UsageConfigSchema = z.object({
  trackingFile: z.string().default(".usage/today.jsonl"),
});

export const SuperAgentConfigSchema = z.object({
  version: z.string().default("1.0"),
  model: ModelConfigSchema.prefault({}),
  plugins: z.array(PluginConfigSchema).default([]),
  mcp: MCPConfigSchema.prefault({}),
  channels: ChannelConfigSchema.prefault({}),
  agents: AgentConfigSchema.prefault({}),
  security: SecurityConfigSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
  rag: RagConfigSchema.prefault({}),
  cron: CronConfigSchema.prefault({}),
  session: SessionConfigSchema.prefault({}),
  usage: UsageConfigSchema.prefault({}),
});

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
