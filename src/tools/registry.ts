import { jsonSchema } from "ai";
import type { HookPipeline } from "../security/hooks.js";
import { canUseTool, type Role } from "../security/roles.js";
import {
  DEFAULT_MAX_RESULT_CHARS,
  type ExecutableTool,
  type ToolExecutionAuditEntry,
  type ToolExecutionContext,
  ToolExecutionPipeline,
  truncateResult,
} from "./execution-pipeline.js";

export interface ToolDefinition extends ExecutableTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  shouldDefer?: boolean; // 是否延迟加载
  searchHint?: string; // 搜索提示词，帮助 ToolSearch 匹配
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolClient {
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private mcpClients: MCPToolClient[] = [];
  private executionPipeline = new ToolExecutionPipeline();

  private discoveredTools = new Set<string>();
  private currentRole: Role = "owner";
  private hookPipeline?: HookPipeline;

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  unregister(name: string): boolean {
    this.discoveredTools.delete(name);
    return this.tools.delete(name);
  }

  async registerMCPServer(
    serverName: string,
    client: MCPToolClient,
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        maxResultChars: DEFAULT_MAX_RESULT_CHARS,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }

  setRole(role: Role): void {
    this.currentRole = role;
  }

  getRole(): Role {
    return this.currentRole;
  }

  setHookPipeline(pipeline: HookPipeline): void {
    this.hookPipeline = pipeline;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getExecutionAuditLog(): readonly ToolExecutionAuditEntry[] {
    return this.executionPipeline.getAuditLog();
  }

  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      if (!canUseTool(this.currentRole, tool.name)) {
        return false;
      }
      return true;
    });
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => {
      return (
        tool.shouldDefer &&
        !this.discoveredTools.has(tool.name) &&
        canUseTool(this.currentRole, tool.name)
      );
    });

    if (deferred.length === 0) return "";

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : "";
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join("\n")}`;
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    // 支持逗号分隔的多个工具名，如 "mcp__github__list_issues,mcp__github__search_repositories"
    const names = q.includes(",")
      ? q
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
      : [q];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (
        tool &&
        tool.name !== "tool_search" &&
        canUseTool(this.currentRole, tool.name)
      ) {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }

    return results;
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      if (!canUseTool(this.currentRole, tool.name)) continue;

      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  private formatTools(
    useLocks: boolean,
    excludeTools?: Set<string>,
    executionContext?: ToolExecutionContext,
  ): Record<string, any> {
    const result: Record<string, any> = {};
    const activeTools = this.getActiveTools().filter(
      (tool) => !excludeTools?.has(tool.name),
    );

    for (const tool of activeTools) {
      const hookPipeline = this.hookPipeline;

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: (input: any) =>
          this.executionPipeline.execute(tool, input, {
            useLocks,
            hookPipeline,
            authorize: (toolName) => canUseTool(this.currentRole, toolName),
            requestApproval: executionContext?.requestApproval,
          }),
      };
    }
    return result;
  }

  toAISDKFormatUnlocked(
    excludeTools?: Set<string>,
    executionContext?: ToolExecutionContext,
  ): Record<string, any> {
    return this.formatTools(false, excludeTools, executionContext);
  }

  toAISDKFormat(executionContext?: ToolExecutionContext): Record<string, any> {
    return this.formatTools(true, undefined, executionContext);
  }
}

export { truncateResult };
