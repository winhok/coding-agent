import type { ToolSelection } from "../tools/registry.js";

export interface CliModePolicy {
  system: string;
  toolSelection?: ToolSelection;
}

const READ_ONLY_TOOL_SELECTION: ToolSelection = {
  readOnlyOnly: true,
  deniedCapabilities: new Set(["delegate"]),
};

/** Converts a CLI mode into model instructions and enforceable tool policy. */
export function resolveCliModePolicy(
  mode: "interactive" | "ask" | "plan",
  baseSystem: string,
  approvalMode: "ask" | "never" | "always" = "ask",
): CliModePolicy {
  if (mode === "plan") {
    return {
      system: `${baseSystem}\n\n[计划模式]\n只分析任务并生成具体、可验证的执行计划。不得修改文件、执行命令、调用外部服务或委派任务。最终直接输出计划。`,
      toolSelection: READ_ONLY_TOOL_SELECTION,
    };
  }
  if (mode === "ask" && approvalMode === "never") {
    return {
      system: `${baseSystem}\n\n[非交互只读模式]\n当前没有审批通道，只进行读取和分析。`,
      toolSelection: READ_ONLY_TOOL_SELECTION,
    };
  }
  return { system: baseSystem };
}
