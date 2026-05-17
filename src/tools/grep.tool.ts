import { spawn } from "node:child_process";
import type { ToolDefinition } from "./registry";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_LIMIT = 200;

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "在文件中搜索匹配指定模式的内容。返回匹配的行号和内容",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索模式（正则表达式）" },
      path: {
        type: "string",
        description: "搜索路径（文件或目录），默认当前目录",
      },
      maxResults: {
        type: "number",
        description: "最多返回多少条结果，默认 50，最大 200",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({
    pattern,
    path = ".",
    maxResults = DEFAULT_MAX_RESULTS,
  }: {
    pattern: string;
    path?: string;
    maxResults?: number;
  }) => {
    const limit = normalizeMaxResults(maxResults);
    const args = [
      "--line-number",
      "--with-filename",
      "--no-heading",
      "--color",
      "never",
      "--",
      pattern,
      path,
    ];

    const { matches, truncated, error } = await runRipgrep(args, limit);
    if (error !== undefined) return `搜索出错：${error}`;
    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;

    const suffix = truncated ? `\n\n... 仅显示前 ${limit} 条` : "";
    return matches.join("\n") + suffix;
  },
};

function normalizeMaxResults(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(Math.floor(value), 1), MAX_RESULTS_LIMIT);
}

async function runRipgrep(
  args: string[],
  limit: number,
): Promise<{ matches: string[]; truncated: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("rg", args);
    const matches: string[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let truncated = false;

    function collectLine(line: string): void {
      if (line.length === 0 || truncated) return;
      if (matches.length < limit) {
        matches.push(line);
        return;
      }

      truncated = true;
      child.kill();
    }

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        collectLine(stdoutBuffer.slice(0, newlineIndex));
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      resolve({ matches, truncated, error: error.message });
    });

    child.on("close", (code, signal) => {
      collectLine(stdoutBuffer);

      if (truncated || signal === "SIGTERM") {
        resolve({ matches, truncated: true });
        return;
      }

      if (code === 0 || code === 1) {
        resolve({ matches, truncated });
        return;
      }

      resolve({
        matches,
        truncated,
        error: stderr.trim() || `rg exited with code ${code ?? "unknown"}`,
      });
    });
  });
}
