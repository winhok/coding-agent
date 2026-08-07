import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "./execution-pipeline.js";
import type { ToolDefinition } from "./registry";
import { resolveWorkspacePath } from "./workspace.js";

const execFileAsync = promisify(execFile);

/** diff 输出最大长度 */
const MAX_DIFF_LENGTH = 10_000;

export const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description:
    "查看当前仓库的代码变更详情（git diff）。返回具体的增删行内容。可以通过 path 参数查看指定文件的变更。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "可选，只查看指定文件的变更" },
      staged: {
        type: "boolean",
        description: "是否查看暂存区的变更（git diff --staged），默认 false",
      },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: MAX_DIFF_LENGTH + 200,
  execute: async (
    input: { path?: unknown; staged?: unknown },
    context?: ToolExecutionContext,
  ) => {
    const staged = input.staged === true;
    const path =
      typeof input.path === "string" && input.path.trim()
        ? input.path
        : undefined;

    const args = ["diff"];
    if (staged) args.push("--staged");
    try {
      if (path) {
        const resolved = await resolveWorkspacePath(
          context?.workingDir ?? process.cwd(),
          path,
          { mustExist: true },
        );
        args.push("--", resolved.relativePath);
      }
      const { stdout } = await execFileAsync("git", args, {
        cwd: context?.workingDir ?? process.cwd(),
        maxBuffer: 1024 * 1024,
      });

      if (!stdout.trim()) {
        return staged ? "暂存区没有变更。" : "没有未暂存的变更。";
      }

      if (stdout.length > MAX_DIFF_LENGTH) {
        const truncated = stdout.slice(0, MAX_DIFF_LENGTH);
        return `${truncated}\n\n... diff 输出过长，已截断（共 ${stdout.length} 字符）`;
      }

      return stdout;
    } catch (error: unknown) {
      return `获取 git diff 出错：${formatGitDiffError(error)}`;
    }
  },
};

function formatGitDiffError(error: unknown): string {
  if (isExecFileError(error)) {
    const stderr = error.stderr.trim();
    if (stderr) return stderr;
  }

  return String(error);
}

function isExecFileError(error: unknown): error is { stderr: string } {
  return (
    error != null &&
    typeof error === "object" &&
    "stderr" in error &&
    typeof (error as { stderr: unknown }).stderr === "string"
  );
}
