import type { SubAgentRegistry } from "../agents/registry.js";
import type { SpawnContext } from "../agents/spawn.js";
import { spawnAgent, spawnParallel } from "../agents/spawn.js";
import type { ToolExecutionContext } from "./execution-pipeline.js";
import type { ToolDefinition } from "./registry.js";

export function createSpawnTool(
  _agentRegistry: SubAgentRegistry,
  getSpawnContext: () => SpawnContext,
): ToolDefinition {
  return {
    name: "spawn_agent",
    description:
      "派一个子 Agent 去执行任务。子 Agent 有独立的上下文，完成后返回结果摘要。遇到多项独立调研任务或需要并行对比时，使用 tasks 同时派多个子 Agent。",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "单个任务描述（与 tasks 二选一）",
        },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "多个任务描述，并行执行（与 task 二选一）",
        },
        profile: {
          type: "string",
          description:
            "子 Agent Profile 名称。单任务默认 general，并行任务默认 explorer",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "可选的任务级工具范围，只能缩小 Profile 权限",
        },
        timeout: { type: "number", description: "可选超时时间（毫秒）" },
      },
    },
    isConcurrencySafe: false,
    isReadOnly: true,
    capabilities: ["delegate"],
    holdsExecutionLock: false,
    execute: async (
      input: {
        task?: string;
        tasks?: string[];
        profile?: string;
        tools?: string[];
        timeout?: number;
      },
      executionContext?: ToolExecutionContext,
    ) => {
      const baseContext = getSpawnContext();
      const context: SpawnContext = {
        ...baseContext,
        workingDir: executionContext?.workingDir ?? baseContext.workingDir,
        ...(executionContext?.requestApproval
          ? { requestApproval: executionContext.requestApproval }
          : {}),
      };

      if (input.tasks && input.tasks.length > 0) {
        const results = await spawnParallel(
          input.tasks.map((task) => ({
            task,
            ...(input.profile ? { profile: input.profile } : {}),
            ...(input.tools ? { tools: input.tools } : {}),
            ...(input.timeout ? { timeout: input.timeout } : {}),
          })),
          context,
        );
        return results
          .map(
            (result, index) =>
              `## 子 Agent ${index + 1}: ${result.task.slice(0, 40)}\n\n${result.result}`,
          )
          .join("\n\n---\n\n");
      }

      if (input.task) {
        return spawnAgent(
          {
            task: input.task,
            ...(input.profile ? { profile: input.profile } : {}),
            ...(input.tools ? { tools: input.tools } : {}),
            ...(input.timeout ? { timeout: input.timeout } : {}),
          },
          context,
        );
      }
      return "需要提供 task 或 tasks 参数";
    },
  };
}
