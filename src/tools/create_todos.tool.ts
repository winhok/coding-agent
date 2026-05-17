import type { ToolDefinition } from "./registry";
import { todoManager } from "./todo_manager.ts";

export const createTodosTool: ToolDefinition = {
  name: "create_todos",
  description:
    "创建或替换当前任务计划。适合在开始复杂任务前把目标拆成多个可跟踪步骤。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "计划步骤列表。每一项应该是一个清晰、可执行的步骤描述。",
        items: { type: "string" },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ todos }: { todos?: unknown }) => {
    if (!Array.isArray(todos)) {
      return "错误：todos 必须是字符串数组。";
    }

    const descriptions = todos
      .map((todo) => (typeof todo === "string" ? todo.trim() : ""))
      .filter((todo) => todo.length > 0);

    if (descriptions.length === 0) {
      return "错误：todos 至少需要包含一个非空步骤。";
    }

    todoManager.create(descriptions);
    return `已创建 ${descriptions.length} 个计划步骤：\n${todoManager.formatForPrompt()}`;
  },
};
