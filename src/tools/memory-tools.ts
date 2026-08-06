import type { MemoryStore } from "../memory/store.js";
import type { ToolDefinition } from "./registry.js";

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: "memory",
    description:
      "管理跨会话记忆。同 type、同原始名称的 save 会更新已有记忆。action: save（保存）| list（列表）| search（搜索）| read（读取）| delete（删除）",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "list", "search", "read", "delete"],
        },
        name: { type: "string", description: "记忆名称（save 时必填）" },
        description: {
          type: "string",
          description: "一句话描述（save 时必填）",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "记忆类型（save 时必填）",
        },
        content: { type: "string", description: "记忆内容（save 时必填）" },
        query: { type: "string", description: "搜索关键词（search 时必填）" },
        filename: {
          type: "string",
          description: "文件名（read/delete 时必填）",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: any) => {
      switch (args.action) {
        case "save": {
          if (!args.name || !args.type || !args.content) {
            return "保存失败：需要 name、type、content 参数";
          }
          try {
            const filename = memoryStore.save({
              name: args.name,
              description: args.description || args.name,
              type: args.type,
              content: args.content,
            });
            return `已保存到记忆: ${filename}`;
          } catch (error) {
            return `保存失败：${getErrorMessage(error)}`;
          }
        }
        case "list": {
          const entries = memoryStore.list();
          if (entries.length === 0) return "当前没有存储任何记忆。";
          return (
            `记忆列表（共 ${entries.length} 条记忆）：\n` +
            entries
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join("\n")
          );
        }
        case "search": {
          if (typeof args.query !== "string" || !args.query.trim()) {
            return "搜索失败：需要 query 参数";
          }
          const results = memoryStore.search(args.query);
          if (results.length === 0)
            return `没有找到与 "${args.query}" 相关的记忆。`;
          return (
            `搜索结果（${results.length} 条匹配）：\n` +
            results
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join("\n")
          );
        }
        case "read": {
          if (typeof args.filename !== "string" || !args.filename) {
            return "读取失败：需要 filename 参数";
          }
          try {
            return (
              memoryStore.loadFile(args.filename) ??
              `文件不存在: ${args.filename}`
            );
          } catch (error) {
            return `读取失败：${getErrorMessage(error)}`;
          }
        }
        case "delete": {
          if (typeof args.filename !== "string" || !args.filename) {
            return "删除失败：需要 filename 参数";
          }
          try {
            return memoryStore.delete(args.filename)
              ? `已删除: ${args.filename}`
              : `文件不存在: ${args.filename}`;
          } catch (error) {
            return `删除失败：${getErrorMessage(error)}`;
          }
        }
        default:
          return `未知操作: ${args.action}`;
      }
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
