import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "./registry";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;
const MAX_OUTPUT_LENGTH = 10_000;

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作。默认超时时间为 30 秒。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      timeout: {
        type: "number",
        description: "超时时间（毫秒），默认 30000，最大 120000",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: MAX_OUTPUT_LENGTH,
  execute: async (input: { command?: unknown; timeout?: unknown }) => {
    const command = input.command;
    if (typeof command !== "string" || !command.trim()) {
      return "错误：命令不能为空。";
    }

    const timeout = normalizeTimeout(input.timeout);

    try {
      await execAsync("echo test", { timeout: 1_000, maxBuffer: 1024 * 1024 });
    } catch {
      return `[bash 不可用] 当前环境（WebContainer）不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 1024 * 1024,
      });

      return formatCommandResult(stdout, stderr);
    } catch (error: unknown) {
      return formatCommandError(error);
    }
  },
};

function normalizeTimeout(value: unknown): number {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT;
  return Math.min(Math.floor(timeout), MAX_TIMEOUT);
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;

  const headSize = Math.floor(MAX_OUTPUT_LENGTH * 0.6);
  const tailSize = MAX_OUTPUT_LENGTH - headSize;
  const head = output.slice(0, headSize);
  const tail = output.slice(-tailSize);
  const dropped = output.length - headSize - tailSize;

  return `${head}\n\n... 输出过长，已截断（省略 ${dropped} 字符）...\n\n${tail}`;
}

function formatCommandResult(stdout: string, stderr: string): string {
  const parts: string[] = [];

  if (stdout.trim()) {
    parts.push(`stdout:\n${truncateOutput(stdout.trim())}`);
  }

  if (stderr.trim()) {
    parts.push(`stderr:\n${truncateOutput(stderr.trim())}`);
  }

  if (parts.length === 0) {
    return "命令执行成功（无输出）。";
  }

  return parts.join("\n\n");
}

function formatCommandError(error: unknown): string {
  if (isExecError(error)) {
    const parts: string[] = [`exit code: ${error.code}`];

    if (error.stdout.trim()) {
      parts.push(`stdout:\n${truncateOutput(error.stdout.trim())}`);
    }

    if (error.stderr.trim()) {
      parts.push(`stderr:\n${truncateOutput(error.stderr.trim())}`);
    }

    if (error.killed) {
      parts.push("命令因超时被终止。");
    }

    return parts.join("\n\n");
  }

  return `执行命令出错：${String(error)}`;
}

function isExecError(
  error: unknown,
): error is {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
} {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code: unknown }).code === null ||
      typeof (error as { code: unknown }).code === "number") &&
    "stdout" in error &&
    typeof (error as { stdout: unknown }).stdout === "string" &&
    "stderr" in error &&
    typeof (error as { stderr: unknown }).stderr === "string" &&
    "killed" in error &&
    typeof (error as { killed: unknown }).killed === "boolean"
  );
}
