import { readFile } from "node:fs/promises";
import type { ToolExecutionContext } from "./execution-pipeline.js";
import type { ToolDefinition } from "./registry";
import { resolveWorkspacePath, WorkspacePathError } from "./workspace.js";

const MAX_LINES = 200;

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "读取指定路径的文件内容。可以指定起始行和结束行，适合读取大文件的特定部分。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      startLine: {
        type: "number",
        description: "起始行号（从 1 开始），默认 1",
      },
      endLine: { type: "number", description: "结束行号，默认最多读取 200 行" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 50000,
  execute: async (
    {
      path,
      startLine,
      endLine,
    }: { path: string; startLine?: number; endLine?: number },
    context?: ToolExecutionContext,
  ) => {
    const firstLine = normalizeLineNumber(startLine, 1);
    const lastLine = Math.max(
      firstLine,
      normalizeLineNumber(endLine, firstLine + MAX_LINES - 1),
    );

    try {
      const resolved = await resolveWorkspacePath(
        context?.workingDir ?? process.cwd(),
        path,
        { mustExist: true },
      );
      const content = await readFile(resolved.absolutePath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const selectedLines = lines.slice(firstLine - 1, lastLine);
      const displayedEndLine =
        selectedLines.length > 0
          ? firstLine + selectedLines.length - 1
          : firstLine;

      const numberedLines = selectedLines.map(
        (line, index) => `${firstLine + index}: ${line}`,
      );

      const header = `文件: ${resolved.relativePath} (${totalLines} 行)`;
      const range = `显示第 ${firstLine}-${displayedEndLine} 行`;
      const truncation =
        displayedEndLine < totalLines
          ? `\n\n... 共 ${totalLines} 行，仅显示第 ${firstLine}-${displayedEndLine} 行。可以使用 startLine 和 endLine 参数读取更多内容。`
          : "";

      return `${header}\n${range}\n\n${numberedLines.join("\n")}${truncation}`;
    } catch (error: unknown) {
      if (error instanceof WorkspacePathError) {
        return "错误：不能读取工作目录之外的文件。";
      }
      if (isNodeError(error) && error.code === "ENOENT") {
        return `错误：文件不存在 ${path}`;
      }
      return `读取文件出错：${String(error)}`;
    }
  },
};

function normalizeLineNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 1) return fallback;
  return Math.floor(numberValue);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
