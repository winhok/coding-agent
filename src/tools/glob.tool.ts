import fg from "fast-glob";
import type { ToolExecutionContext } from "./execution-pipeline.js";
import type { ToolDefinition } from "./registry";
import {
  assertWorkspaceGlobPattern,
  resolveWorkspacePath,
} from "./workspace.js";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_LIMIT = 200;

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "按文件路径模式列出项目中的文件。适合查看项目结构、找到特定类型的文件；如果要搜索文件内容，请使用 grep。" +
    '支持 glob 模式，如 "**/*.ts"、"src/**/*.test.ts"',
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: '文件路径 glob 模式，如 "**/*.ts"、"src/*.json"',
      },
      path: { type: "string", description: "搜索起始目录，默认当前目录" },
      maxResults: {
        type: "number",
        description: "最多返回多少个文件，默认 50，最大 200",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async (
    {
      pattern,
      path = ".",
      maxResults = DEFAULT_MAX_RESULTS,
    }: { pattern: string; path?: string; maxResults?: number },
    context?: ToolExecutionContext,
  ) => {
    const limit = normalizeMaxResults(maxResults);

    try {
      assertWorkspaceGlobPattern(pattern);
      const directory = await resolveWorkspacePath(
        context?.workingDir ?? process.cwd(),
        path,
        { mustExist: true },
      );
      const results = await fg(pattern, {
        cwd: directory.absolutePath,
        ignore: ["node_modules/**", ".git/**"],
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
      });
      if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;

      const sorted = results.sort();
      const suffix =
        sorted.length > limit ? `\n\n... 仅显示前 ${limit} 个` : "";
      return sorted.slice(0, limit).join("\n") + suffix;
    } catch (error: unknown) {
      return `列出文件出错：${String(error)}`;
    }
  },
};

function normalizeMaxResults(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(Math.floor(value), 1), MAX_RESULTS_LIMIT);
}
