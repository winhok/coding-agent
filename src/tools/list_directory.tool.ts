import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "./registry";

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "列出指定目录下的文件和子目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认为当前目录" },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = "." }: { path?: string }) => {
    const resolved = resolve(path);
    return readdirSync(resolved)
      .map((name: string) => {
        const stat = statSync(join(resolved, name));
        return `${stat.isDirectory() ? "📁" : "📄"} ${name}`;
      })
      .join("\n");
  },
};
