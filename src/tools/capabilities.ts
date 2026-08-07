export type ToolCapability =
  | "read"
  | "write"
  | "execute"
  | "delegate"
  | "external"
  | "state";

export interface CapabilityTool {
  capabilities?: readonly ToolCapability[];
  isReadOnly?: boolean;
}

export function inferToolCapabilities(tool: CapabilityTool): ToolCapability[] {
  if (tool.capabilities && tool.capabilities.length > 0) {
    return [...tool.capabilities];
  }
  if (tool.isReadOnly === true) return ["read"];
  if (tool.isReadOnly === false) return ["write"];
  return ["external"];
}
