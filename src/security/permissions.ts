import { classifyBashCommand } from "./bash-classifier.js";

export type PermissionLevel = "allow" | "ask" | "deny";

export interface PermissionDecision {
  level: PermissionLevel;
  reason: string;
}

export interface ApprovalRequest {
  tool: string;
  input: unknown;
  reason: string;
}

export type RequestApproval = (request: ApprovalRequest) => Promise<boolean>;

interface PermissionTool {
  name: string;
  isReadOnly?: boolean;
  capabilities?: readonly string[];
}

/**
 * Resolves the default permission for the final, validated tool input.
 * Unknown capabilities require approval so newly registered tools cannot gain
 * write access merely by being absent from a name-based allowlist.
 */
export function decideToolPermission(
  tool: PermissionTool,
  input: unknown,
): PermissionDecision {
  if (tool.name === "bash") {
    const command = getCommand(input);
    const risk = command
      ? classifyBashCommand(command)
      : { level: "safe" as const };

    if (risk.level === "dangerous") {
      return { level: "deny", reason: `检测到危险操作: ${risk.reason}` };
    }

    return {
      level: "ask",
      reason:
        risk.level === "moderate"
          ? `Shell 命令可能改变系统状态: ${risk.reason}`
          : "Shell 命令需要用户确认",
    };
  }

  if (tool.capabilities?.includes("state")) {
    return { level: "allow", reason: "仅更新当前任务的内部状态" };
  }

  if (tool.isReadOnly === true) {
    return { level: "allow", reason: "只读工具自动放行" };
  }

  if (tool.isReadOnly === false) {
    return { level: "ask", reason: "工具会修改状态，需要用户确认" };
  }

  return { level: "ask", reason: "工具风险未知，需要用户确认" };
}

function getCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("command" in input)) {
    return undefined;
  }
  return typeof input.command === "string" ? input.command : undefined;
}
