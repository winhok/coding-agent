import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolExecutionContext } from "./execution-pipeline.js";
import type { ToolDefinition } from "./registry";
import { resolveWorkspacePath, WorkspacePathError } from "./workspace.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "创建或覆盖文件，写入完整文件内容。写入前会自动创建不存在的父目录。如果只修改文件的一小部分，优先使用 edit_file。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isConcurrencySafe: false, // 写操作不能并行
  isReadOnly: false, // 写操作不能是只读的
  execute: async (
    { path, content }: { path: string; content: string },
    context?: ToolExecutionContext,
  ) => {
    try {
      const resolved = await resolveWorkspacePath(
        context?.workingDir ?? process.cwd(),
        path,
        { mustExist: false, forbidGit: true },
      );
      await mkdir(dirname(resolved.absolutePath), { recursive: true });
      await writeFile(resolved.absolutePath, content, "utf-8");

      const lineCount = content.split("\n").length;
      return `已写入 ${content.length} 字符到 ${resolved.relativePath}（${lineCount} 行）`;
    } catch (error: unknown) {
      if (error instanceof WorkspacePathError) {
        return error.message.includes(".git")
          ? `错误：${error.message}。`
          : "错误：不能写入工作目录之外的文件。";
      }
      return `写入文件出错：${String(error)}`;
    }
  },
};
