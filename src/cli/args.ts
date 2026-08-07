export type ApprovalMode = "ask" | "never" | "always";

export type CliRequest =
  | { command: "help" }
  | { command: "version" }
  | { command: "init" }
  | {
      command: "interactive";
      continueSession: boolean;
      approvalMode: "ask" | "always";
    }
  | {
      command: "ask" | "plan";
      prompt: string;
      output: "text" | "json";
      continueSession: boolean;
      approvalMode: "never" | "always";
    };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(args: readonly string[]): CliRequest {
  if (args.includes("--help") || args.includes("-h")) {
    return { command: "help" };
  }
  if (args.includes("--version") || args.includes("-v")) {
    return { command: "version" };
  }

  let json = false;
  let continueSession = false;
  let approvalMode: ApprovalMode | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--continue") {
      continueSession = true;
      continue;
    }
    if (arg === "--approval-mode") {
      const value = args[++index];
      if (value !== "ask" && value !== "never" && value !== "always") {
        throw new CliUsageError("--approval-mode 必须是 ask、never 或 always");
      }
      approvalMode = value;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new CliUsageError(`未知选项: ${arg}`);
    }
    if (arg !== undefined) positional.push(arg);
  }

  const command = positional[0];
  if (!command) {
    if (json) throw new CliUsageError("--json 只能用于 ask 或 plan 模式");
    if (approvalMode === "never") {
      throw new CliUsageError("交互模式不支持 --approval-mode never");
    }
    return {
      command: "interactive",
      continueSession,
      approvalMode: approvalMode ?? "ask",
    };
  }

  if (command === "help") return { command: "help" };
  if (command === "version") return { command: "version" };
  if (command === "init") {
    if (positional.length > 1 || json || continueSession || approvalMode) {
      throw new CliUsageError("init 不接受其他参数或选项");
    }
    return { command: "init" };
  }
  if (command === "interactive") {
    if (positional.length > 1 || json) {
      throw new CliUsageError("interactive 不接受任务或 --json");
    }
    if (approvalMode === "never") {
      throw new CliUsageError("交互模式不支持 --approval-mode never");
    }
    return { command, continueSession, approvalMode: approvalMode ?? "ask" };
  }
  if (command !== "ask" && command !== "plan") {
    throw new CliUsageError(`未知命令: ${command}`);
  }

  const prompt = positional.slice(1).join(" ").trim();
  if (!prompt) throw new CliUsageError(`${command} 需要提供任务描述`);
  if (approvalMode === "ask") {
    throw new CliUsageError(
      "非交互模式不支持 ask 审批；请使用 never（默认）或显式选择 always",
    );
  }
  return {
    command,
    prompt,
    output: json ? "json" : "text",
    continueSession,
    approvalMode: approvalMode ?? "never",
  };
}

export function formatHelp(version: string): string {
  return `coding-agent v${version}

用法:
  coding-agent                              启动交互模式
  coding-agent interactive [--continue]     显式启动交互模式
  coding-agent ask <任务> [选项]             执行单次任务
  coding-agent plan <任务> [选项]            只分析并生成计划
  coding-agent init                         生成配置

选项:
  --json                    只向 stdout 输出最终 JSON（ask/plan）
  --continue                恢复配置指定的会话
  --approval-mode <模式>    ask | never | always
  --help, -h                显示帮助
  --version, -v             显示版本

退出码:
  0  完成
  1  参数、配置或运行错误
  2  达到循环限制，任务未完整结束
  3  操作被权限或安全策略拒绝
  130 收到 SIGINT
  143 收到 SIGTERM

安全规则:
  ask/plan 默认 approval-mode=never，ask 只开放只读工具。
  plan 在执行层只开放只读工具，不会修改文件或执行命令。
  approval-mode=always 会自动批准敏感操作，请仅在受控环境使用。
  plan 无论选择哪种审批模式都保持只读。`;
}
