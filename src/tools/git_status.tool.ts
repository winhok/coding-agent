import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "./registry";

const execFileAsync = promisify(execFile);

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description:
    "查看当前仓库的 git 状态。返回修改、暂存、未追踪的文件列表。适合在修改文件后检查变更情况。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async () => {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      });

      const status = stdout.trim();
      if (!status) {
        return "工作目录干净，没有未提交的变更。";
      }

      return `当前变更:\n${status}`;
    } catch (error: unknown) {
      return `获取 git 状态出错：${formatGitStatusError(error)}`;
    }
  },
};

function formatGitStatusError(error: unknown): string {
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
