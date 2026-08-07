import type { SubAgentRegistry } from "../agents/registry.js";
import type { SpawnContext } from "../agents/spawn.js";
import { spawnAgent, spawnParallel } from "../agents/spawn.js";
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
      },
    },
    isConcurrencySafe: false,
    isReadOnly: true,
    execute: async (input: { task?: string; tasks?: string[] }) => {
      const context = getSpawnContext();

      if (input.tasks && input.tasks.length > 0) {
        const results = await spawnParallel(
          input.tasks.map((task) => ({ task })),
          context,
        );
        return results
          .map(
            (result, index) =>
              `## 子 Agent ${index + 1}: ${result.task.slice(0, 40)}\n\n${result.result}`,
          )
          .join("\n\n---\n\n");
      }

      if (input.task) return spawnAgent({ task: input.task }, context);
      return "需要提供 task 或 tasks 参数";
    },
  };
}
