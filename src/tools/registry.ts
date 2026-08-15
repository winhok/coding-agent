import { jsonSchema } from "ai";
import type { JSONSchema7 } from "json-schema";
import type { AgentRunContext } from "../agent/run-context.js";
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
  description: string;
  parametersForContext?: (context: AgentRunContext) => Record<string, unknown>;
  exposesSkillCatalog?: boolean;
  shouldDefer?: boolean; // 是否延迟加载
  searchHint?: string; // 搜索提示词，帮助 ToolSearch 匹配
}

export interface ToolSelection {
  allowedCapabilities?: ReadonlySet<ToolCapability>;
  allowedTools?: ReadonlySet<string>;
  deniedCapabilities?: ReadonlySet<ToolCapability>;
  readOnlyOnly?: boolean;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolClient {
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
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
          parameters: tool.inputSchema,
          isConcurrencySafe: false,
          maxResultChars: DEFAULT_MAX_RESULT_CHARS,
          shouldDefer: true,
          searchHint: `${serverName} ${tool.name} ${tool.description}`,
          execute: async (input, context) => {
            return toolClient.callTool(originalName, input, context?.signal);
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

  createView(selection?: ToolSelection): ToolView {
    return new ToolView(this, selection, new Set());
  }

  canUseCurrentRole(tool: ToolDefinition): boolean {
    return canUseTool(this.currentRole, tool, this.rolePolicies);
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

  formatToolsForView(view: ToolView, executionContext: AgentRunContext) {
    const activeTools = view.getActiveTools();

    return Object.fromEntries(
      activeTools.map((tool) => {
        const hookPipeline = this.hookPipeline;
        const parameters =
          tool.parametersForContext?.(executionContext) ?? tool.parameters;
        const scopedTool: ToolDefinition = { ...tool, parameters };

        return [
          tool.name,
          {
            description: tool.description,
            inputSchema: jsonSchema(parameters as JSONSchema7),
            execute: (
              input: unknown,
              options?: { toolCallId?: string; abortSignal?: AbortSignal },
            ) => {
              const callContext: ToolExecutionContext = {
                ...executionContext,
                signal: fuseAbortSignals(
                  executionContext.signal,
                  options?.abortSignal,
                ),
                toolName: tool.name,
                ...(options?.toolCallId
                  ? { toolCallId: options.toolCallId }
                  : {}),
              };
              return this.executionPipeline.execute(
                scopedTool,
                input as Record<string, unknown>,
                {
                  useLocks: tool.holdsExecutionLock !== false,
                  hookPipeline,
                  authorize: (toolName) => {
                    const currentTool = this.tools.get(toolName);
                    return currentTool === tool && view.canExecute(toolName);
                  },
                  requestApproval: callContext.requestApproval,
                  executionContext: callContext,
                },
              );
            },
          },
        ] as const;
      }),
    );
  }

  toAISDKFormat(executionContext: AgentRunContext) {
    if (!executionContext.toolView.isOwnedBy(this)) {
      throw new Error("AgentRunContext.toolView 不属于当前 ToolRegistry");
    }
    return executionContext.toolView.toAISDKFormat(executionContext);
  }

  matchesSelection(tool: ToolDefinition, selection?: ToolSelection): boolean {
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

export class ToolView {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly selection: ToolSelection | undefined,
    private readonly discoveredTools: Set<string>,
  ) {}

  restrict(selection?: ToolSelection): ToolView {
    if (!selection) return this;
    const narrowed = intersectToolSelections(this.selection, selection);
    const discovered = new Set(
      [...this.discoveredTools].filter((name) => {
        const tool = this.registry.get(name);
        return tool !== undefined && this.isVisible(tool, narrowed);
      }),
    );
    return new ToolView(this.registry, narrowed, discovered);
  }

  getActiveTools(): ToolDefinition[] {
    return this.registry.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name))
        return false;
      return this.isVisible(tool, this.selection);
    });
  }

  getDeferredToolSummary(): string {
    const deferred = this.registry
      .getAll()
      .filter(
        (tool) =>
          tool.shouldDefer === true &&
          !this.discoveredTools.has(tool.name) &&
          this.isVisible(tool, this.selection),
      );
    if (deferred.length === 0) return "";
    const lines = deferred.map((tool) => {
      const hint = tool.searchHint ? ` — ${tool.searchHint}` : "";
      return `  - ${tool.name}${hint}`;
    });
    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join("\n")}`;
  }

  searchTools(query: string): ToolDefinition[] {
    const names = splitToolQuery(query);
    const results: ToolDefinition[] = [];
    for (const name of names) {
      const tool = this.registry.get(name);
      if (
        tool &&
        tool.name !== "tool_search" &&
        this.isVisible(tool, this.selection)
      ) {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }
    return results;
  }

  canExecute(name: string): boolean {
    const tool = this.registry.get(name);
    return (
      tool !== undefined &&
      (!tool.shouldDefer || this.discoveredTools.has(name)) &&
      this.isVisible(tool, this.selection)
    );
  }

  has(name: string): boolean {
    return this.canExecute(name);
  }

  hasSkillCatalogTool(): boolean {
    const tool = this.registry.get("skill");
    return tool?.exposesSkillCatalog === true && this.canExecute(tool.name);
  }

  isOwnedBy(registry: ToolRegistry): boolean {
    return this.registry === registry;
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;
    for (const tool of this.registry.getAll()) {
      if (!this.isVisible(tool, this.selection)) continue;
      const tokens = Math.ceil(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }).length / 4,
      );
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }
    return { active, deferred, total: active + deferred };
  }

  toAISDKFormat(executionContext: AgentRunContext) {
    if (executionContext.toolView !== this) {
      throw new Error("AgentRunContext.toolView 与执行 ToolView 不一致");
    }
    return this.registry.formatToolsForView(this, executionContext);
  }

  private isVisible(
    tool: ToolDefinition,
    selection: ToolSelection | undefined,
  ): boolean {
    return (
      this.registry.canUseCurrentRole(tool) &&
      this.registry.matchesSelection(tool, selection)
    );
  }
}

export function intersectToolSelections(
  parent: ToolSelection | undefined,
  child: ToolSelection | undefined,
): ToolSelection | undefined {
  if (!parent) return child;
  if (!child) return parent;
  const allowedCapabilities = intersectOptionalSets(
    parent.allowedCapabilities,
    child.allowedCapabilities,
  );
  const allowedTools = intersectOptionalSets(
    parent.allowedTools,
    child.allowedTools,
  );
  const deniedCapabilities = unionOptionalSets(
    parent.deniedCapabilities,
    child.deniedCapabilities,
  );
  return {
    ...(allowedCapabilities ? { allowedCapabilities } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(deniedCapabilities ? { deniedCapabilities } : {}),
    ...(parent.readOnlyOnly || child.readOnlyOnly
      ? { readOnlyOnly: true }
      : {}),
  };
}

export function toolCapabilities(tool: ToolDefinition): ToolCapability[] {
  return inferToolCapabilities(tool);
}

export { truncateResult };

function splitToolQuery(query: string): string[] {
  const trimmed = query.trim();
  return trimmed.includes(",")
    ? trimmed
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [trimmed];
}

function intersectOptionalSets<T>(
  left: ReadonlySet<T> | undefined,
  right: ReadonlySet<T> | undefined,
): ReadonlySet<T> | undefined {
  if (!left) return right;
  if (!right) return left;
  return new Set([...left].filter((value) => right.has(value)));
}

function unionOptionalSets<T>(
  left: ReadonlySet<T> | undefined,
  right: ReadonlySet<T> | undefined,
): ReadonlySet<T> | undefined {
  if (!left) return right;
  if (!right) return left;
  return new Set([...left, ...right]);
}

function fuseAbortSignals(
  primary: AbortSignal,
  secondary?: AbortSignal,
): AbortSignal {
  return secondary ? AbortSignal.any([primary, secondary]) : primary;
}
