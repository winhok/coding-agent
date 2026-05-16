import type { ToolDefinition } from "./registry.ts";

export const getCurrentTimeTool: ToolDefinition = {
  name: "get_current_time",
  description: "返回当前系统时间",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "获取当前时间的理由" },
    },
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async () => {
    return new Date().toLocaleString();
  },
};
