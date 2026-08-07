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

export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  maxConcurrent: z.number().min(1).max(10).default(3),
  defaultTimeout: z.number().positive().default(60_000),
});

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
