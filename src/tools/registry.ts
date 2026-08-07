import { jsonSchema } from "ai";
import { createAgentRunContext } from "../agent/run-context.js";
import type { HookPipeline } from "../security/hooks.js";
import {
  canUseTool,
  DEFAULT_ROLE_POLICIES,
  type Role,
  type RolePolicies,
} from "../security/roles.js";
import { inferToolCapabilities } from "./capabilities.js";
import {
  DEFAULT_MAX_RESULT_CHARS,
  type ExecutableTool,
  type ToolCapability,
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

export interface ToolSelection {
  allowedCapabilities?: ReadonlySet<ToolCapability>;
  allowedTools?: ReadonlySet<string>;
  deniedCapabilities?: ReadonlySet<ToolCapability>;
  readOnlyOnly?: boolean;
}

export interface ToolExecutionOptions {
  workingDir?: string;
  todoManager?: ToolExecutionContext["todoManager"];
  requestApproval?: ToolExecutionContext["requestApproval"];
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
  private rolePolicies: RolePolicies = DEFAULT_ROLE_POLICIES;
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
    try {
      await client.connect();
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
          isConcurrencySafe: false,
          maxResultChars: DEFAULT_MAX_RESULT_CHARS,
          shouldDefer: true,
          searchHint: `${serverName} ${tool.name} ${tool.description}`,
          execute: async (input: any) => {
            return toolClient.callTool(originalName, input);
          },
        });

        registered.push(prefixedName);
      }

      this.mcpClients.push(client);
      return registered;
    } catch (error) {
      try {
        await client.close();
      } catch {
        // Preserve the connection/discovery error that made registration fail.
      }
      throw error;
    }
  }

  async closeAllMCP(): Promise<void> {
    const clients = this.mcpClients.splice(0);
    const results = await Promise.allSettled(
      clients.map((client) => client.close()),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      const detail = failures
        .map((failure) =>
          failure instanceof Error ? failure.message : String(failure),
        )
        .join("; ");
      throw new AggregateError(
        failures,
        `Failed to close MCP clients: ${detail}`,
      );
    }
  }

  setRole(role: Role): void {
    this.currentRole = role;
  }

  getRole(): Role {
    return this.currentRole;
  }

  setRolePolicies(policies: RolePolicies): void {
    this.rolePolicies = policies;
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

  getActiveTools(selection?: ToolSelection): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      if (!canUseTool(this.currentRole, tool, this.rolePolicies)) {
        return false;
      }
      return this.matchesSelection(tool, selection);
    });
  }

  getDeferredToolSummary(selection?: ToolSelection): string {
    const deferred = this.getAll().filter((tool) => {
      return (
        tool.shouldDefer &&
        !this.discoveredTools.has(tool.name) &&
        canUseTool(this.currentRole, tool, this.rolePolicies) &&
        this.matchesSelection(tool, selection)
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
        canUseTool(this.currentRole, tool, this.rolePolicies)
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
      if (!canUseTool(this.currentRole, tool, this.rolePolicies)) continue;

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
    executionOptions?: ToolExecutionOptions,
    selection?: ToolSelection,
  ): Record<string, any> {
    const result: Record<string, any> = {};
    const activeTools = this.getActiveTools(selection);
    const executionContext = normalizeExecutionContext(executionOptions);

    for (const tool of activeTools) {
      const hookPipeline = this.hookPipeline;

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: (input: any) =>
          this.executionPipeline.execute(tool, input, {
            useLocks: tool.holdsExecutionLock !== false,
            hookPipeline,
            authorize: (toolName) => {
              const currentTool = this.tools.get(toolName);
              return (
                currentTool !== undefined &&
                canUseTool(this.currentRole, currentTool, this.rolePolicies) &&
                this.matchesSelection(currentTool, selection)
              );
            },
            requestApproval: executionContext?.requestApproval,
            executionContext,
          }),
      };
    }
    return result;
  }

  toAISDKFormat(
    executionContext?: ToolExecutionOptions,
    selection?: ToolSelection,
  ): Record<string, any> {
    return this.formatTools(executionContext, selection);
  }

  private matchesSelection(
    tool: ToolDefinition,
    selection?: ToolSelection,
  ): boolean {
    if (!selection) return true;
    if (selection.allowedTools && !selection.allowedTools.has(tool.name)) {
      return false;
    }
    if (selection.readOnlyOnly && tool.isReadOnly !== true) return false;

    const capabilities = toolCapabilities(tool);
    if (
      selection.deniedCapabilities &&
      capabilities.some((capability) =>
        selection.deniedCapabilities?.has(capability),
      )
    ) {
      return false;
    }
    if (
      selection.allowedCapabilities &&
      !capabilities.every((capability) =>
        selection.allowedCapabilities?.has(capability),
      )
    ) {
      return false;
    }
    return true;
  }
}

export function toolCapabilities(tool: ToolDefinition): ToolCapability[] {
  return inferToolCapabilities(tool);
}

export { truncateResult };

function normalizeExecutionContext(
  options?: ToolExecutionOptions,
): ToolExecutionContext {
  const fallback = createAgentRunContext(options?.workingDir ?? process.cwd());
  return {
    workingDir: fallback.workingDir,
    todoManager: options?.todoManager ?? fallback.todoManager,
    ...(options?.requestApproval
      ? { requestApproval: options.requestApproval }
      : {}),
  };
}
