import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { InputEffectGate } from "../guardrails/input-gate.js";
import type { RequestApproval } from "../security/permissions.js";
import type { SkillView } from "../skills/loader.js";
import type { ToolView } from "../tools/registry.js";
import { TodoManager } from "../tools/todo_manager.ts";

export interface AgentRunContext {
  runId: string;
  agentId: string;
  depth: number;
  parentRunId?: string;
  workingDir: string;
  todoManager: TodoManager;
  signal: AbortSignal;
  toolView: ToolView;
  skillView: SkillView;
  requestApproval?: RequestApproval;
  inputEffectGate?: InputEffectGate;
}

export interface AgentRunContextOptions {
  runId?: string;
  agentId?: string;
  depth?: number;
  parentRunId?: string;
  todoManager?: TodoManager;
  signal?: AbortSignal;
  toolView: ToolView;
  skillView: SkillView;
  requestApproval?: RequestApproval;
  inputEffectGate?: InputEffectGate;
}

export function createAgentRunContext(
  workingDir: string,
  options: AgentRunContextOptions,
): AgentRunContext {
  const runId = options.runId ?? randomUUID();
  return {
    runId,
    agentId: options.agentId ?? runId,
    depth: options.depth ?? 0,
    workingDir: resolve(workingDir),
    todoManager: options.todoManager ?? new TodoManager(),
    signal: options.signal ?? new AbortController().signal,
    toolView: options.toolView,
    skillView: options.skillView,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.requestApproval
      ? { requestApproval: options.requestApproval }
      : {}),
    ...(options.inputEffectGate
      ? { inputEffectGate: options.inputEffectGate }
      : {}),
  };
}

export interface ChildAgentRunContextOptions {
  runId?: string;
  agentId?: string;
  workingDir?: string;
  signal?: AbortSignal;
  toolView: ToolView;
  skillView?: SkillView;
  requestApproval?: RequestApproval;
}

export function deriveAgentRunContext(
  parent: AgentRunContext,
  options: ChildAgentRunContextOptions,
): AgentRunContext {
  return createAgentRunContext(options.workingDir ?? parent.workingDir, {
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    depth: parent.depth + 1,
    parentRunId: parent.runId,
    signal: options.signal ?? parent.signal,
    toolView: options.toolView,
    skillView: options.skillView ?? parent.skillView,
    ...((options.requestApproval ?? parent.requestApproval)
      ? { requestApproval: options.requestApproval ?? parent.requestApproval }
      : {}),
    ...(parent.inputEffectGate
      ? { inputEffectGate: parent.inputEffectGate }
      : {}),
  });
}
