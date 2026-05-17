import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "./registry";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: {
        type: "string",
        description: "要被替换的原始文本（必须精确匹配）",
        minLength: 1,
      },
      new_string: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({
    path,
    old_string,
    new_string,
  }: {
    path: string;
    old_string: string;
    new_string: string;
  }) => {
    const workspaceDir = resolve(process.cwd());
    const filePath = resolve(workspaceDir, path);
    const relativePath = relative(workspaceDir, filePath);

    if (isOutsideWorkspace(relativePath)) {
      return "错误：不能修改工作目录之外的文件。";
    }

    if (hasGitSegment(relativePath)) {
      return "错误：不允许修改 .git 目录下的文件。";
    }

    if (!old_string) {
      return "错误：old_string 不能为空。";
    }

    try {
      const content = await readFile(filePath, "utf-8");

      const firstIndex = content.indexOf(old_string);
      if (firstIndex === -1) {
        return formatNotFoundError(content, old_string, relativePath);
      }

      const secondIndex = content.indexOf(old_string, firstIndex + 1);
      if (secondIndex !== -1) {
        return (
          "错误：old_string 在文件中出现了多次，请提供更长的上下文来精确定位。\n" +
          `文件：${relativePath}`
        );
      }

      const updated = content.replace(old_string, new_string);
      await writeFile(filePath, updated, "utf-8");

      const startLine = content.slice(0, firstIndex).split("\n").length;
      const oldLineCount = old_string.split("\n").length;
      const newLineCount = new_string.split("\n").length;

      return [
        `已修改 ${relativePath}`,
        `位置：第 ${startLine}-${startLine + oldLineCount - 1} 行`,
        `${oldLineCount} 行 -> ${newLineCount} 行`,
      ].join("\n");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return `错误：文件不存在 ${path}`;
      }
      return `修改文件出错：${String(error)}`;
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

function formatNotFoundError(
  fileContent: string,
  oldString: string,
  relativePath: string,
): string {
  const firstLine = oldString.split("\n")[0] ?? "";
  const fuzzyIndex = fileContent.indexOf(firstLine);

  if (firstLine.length > 3 && fuzzyIndex !== -1) {
    const lineNum = fileContent.slice(0, fuzzyIndex).split("\n").length;
    return (
      `错误：未在 ${relativePath} 中找到完全匹配的内容。\n` +
      `但第一行 "${firstLine}" 在第 ${lineNum} 行附近有部分匹配。\n` +
      "请使用 read_file 读取该位置附近的代码，确认准确内容后再重试。"
    );
  }

  return `错误：未在 ${relativePath} 中找到指定的 old_string。请先用 read_file 确认文件内容。`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
