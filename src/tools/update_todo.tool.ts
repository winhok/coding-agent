import type { ToolDefinition } from "./registry";
import { isTodoStatus, TODO_STATUSES, todoManager } from "./todo_manager.ts";

export const updateTodoTool: ToolDefinition = {
  name: "update_todo",
  description:
    "更新某个计划步骤的执行状态。开始执行时标记为 running，完成后标记为 completed，失败时标记为 failed。",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "步骤 ID，由 create_todos 创建并返回。",
      },
      status: {
        type: "string",
        description: "新状态：running、completed 或 failed。",
        enum: ["running", "completed", "failed"],
      },
    },
    required: ["id", "status"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ id, status }: { id?: unknown; status?: unknown }) => {
    const normalizedId = typeof id === "string" ? id.trim() : "";

    if (!normalizedId) {
      return "错误：id 不能为空。";
    }

    if (!isTodoStatus(status) || status === "pending") {
      return `错误：无效状态 "${String(status)}"，可选值: ${TODO_STATUSES.filter((value) => value !== "pending").join(", ")}`;
    }

    const item = todoManager.updateStatus(normalizedId, status);
    if (!item) {
      return `错误：未找到 ID 为 "${normalizedId}" 的步骤。`;
    }

    return `步骤 #${item.id} "${item.description}" -> ${status}\n${todoManager.formatForPrompt()}`;
  },
};
