import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "./registry";

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
  execute: async ({ path, content }: { path: string; content: string }) => {
    const workspaceDir = resolve(process.cwd());
    const filePath = resolve(workspaceDir, path);
    const relativePath = relative(workspaceDir, filePath);

    if (isOutsideWorkspace(relativePath)) {
      return "错误：不能写入工作目录之外的文件。";
    }

    if (hasGitSegment(relativePath)) {
      return "错误：不允许修改 .git 目录下的文件。";
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");

      const lineCount = content.split("\n").length;
      return `已写入 ${content.length} 字符到 ${relativePath}（${lineCount} 行）`;
    } catch (error: unknown) {
      return `写入文件出错：${String(error)}`;
    }
  },
};

function isOutsideWorkspace(relativePath: string): boolean {
  return (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  );
}

function hasGitSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).includes(".git");
}
