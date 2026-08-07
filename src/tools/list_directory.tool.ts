import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionContext } from "./execution-pipeline.js";
import type { ToolDefinition } from "./registry";
import { resolveWorkspacePath } from "./workspace.js";

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
  execute: async (
    { path = "." }: { path?: string },
    context?: ToolExecutionContext,
  ) => {
    const resolved = await resolveWorkspacePath(
      context?.workingDir ?? process.cwd(),
      path,
      { mustExist: true },
    );
    return readdirSync(resolved.absolutePath)
      .map((name: string) => {
        const stat = statSync(join(resolved.absolutePath, name));
        return `${stat.isDirectory() ? "📁" : "📄"} ${name}`;
      })
      .join("\n");
  },
};
