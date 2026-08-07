import { readFileSync } from "node:fs";
import { CliUsageError, formatHelp, parseCliArgs } from "./args.js";

export const CLI_EXIT = {
  success: 0,
  error: 1,
  incomplete: 2,
  permissionDenied: 3,
  interrupted: 130,
  terminated: 143,
} as const;

export interface CliExecutionResult {
  status: "completed" | "incomplete" | "permission_denied";
  answer: string;
  termination: "completed" | "loop_detected" | "max_steps";
  stats: {
    steps: number;
    toolCalls: number;
    retries: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
  };
  tracePath: string;
}

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface CliDependencies {
  loadAgent: () => Promise<{
    startAgent: (options: {
      mode: "interactive" | "ask" | "plan";
      prompt?: string;
      output: "terminal" | "quiet";
      continueSession: boolean;
      approvalMode: "ask" | "never" | "always";
    }) => Promise<CliExecutionResult | undefined>;
  }>;
  loadInit: () => Promise<{ runInit: () => Promise<void> }>;
  version: string;
}

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const defaultDependencies: CliDependencies = {
  loadAgent: () => import("../main.js"),
  loadInit: () => import("../config/init.js"),
  version: readPackageVersion(),
};

export async function runCli(
  args: readonly string[],
  io: CliIO = defaultIO,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  let request: ReturnType<typeof parseCliArgs>;
  try {
    request = parseCliArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`参数错误: ${message}\n\n${formatHelp(dependencies.version)}\n`);
    return CLI_EXIT.error;
  }

  if (request.command === "help") {
    io.stdout(`${formatHelp(dependencies.version)}\n`);
    return CLI_EXIT.success;
  }
  if (request.command === "version") {
    io.stdout(`coding-agent v${dependencies.version}\n`);
    return CLI_EXIT.success;
  }
  if (request.command === "init") {
    try {
      await (await dependencies.loadInit()).runInit();
      return CLI_EXIT.success;
    } catch (error) {
      io.stderr(`初始化失败: ${errorMessage(error)}\n`);
      return CLI_EXIT.error;
    }
  }

  const nonInteractive = request.command !== "interactive";
  const jsonMode =
    (request.command === "ask" || request.command === "plan") &&
    request.output === "json";
  const restoreConsole = nonInteractive ? redirectConsoleLogs(io) : undefined;
  try {
    const result = await (await dependencies.loadAgent()).startAgent({
      mode: request.command,
      ...(request.command === "interactive" ? {} : { prompt: request.prompt }),
      output: request.command === "interactive" ? "terminal" : "quiet",
      continueSession: request.continueSession,
      approvalMode: request.approvalMode,
    });

    if (!result) return CLI_EXIT.success;
    if (jsonMode) io.stdout(`${JSON.stringify(result)}\n`);
    else io.stdout(`${result.answer}\n`);

    if (result.status === "permission_denied") {
      return CLI_EXIT.permissionDenied;
    }
    if (result.status === "incomplete") return CLI_EXIT.incomplete;
    return CLI_EXIT.success;
  } catch (error) {
    io.stderr(`运行失败: ${errorMessage(error)}\n`);
    return CLI_EXIT.error;
  } finally {
    restoreConsole?.();
  }
}

function redirectConsoleLogs(io: CliIO): () => void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...values: unknown[]) => {
    io.stderr(`${values.map(String).join(" ")}\n`);
  };
  console.warn = (...values: unknown[]) => {
    io.stderr(`${values.map(String).join(" ")}\n`);
  };
  console.error = (...values: unknown[]) => {
    io.stderr(`${values.map(String).join(" ")}\n`);
  };
  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string"
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof CliUsageError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
