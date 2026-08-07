import type { CapabilityTool, ToolCapability } from "../tools/capabilities.js";
import { inferToolCapabilities } from "../tools/capabilities.js";

export type Role = "owner" | "collaborator" | "guest";

export interface UserIdentity {
  id: string;
  name: string;
  role: Role;
}

export interface RolePolicy {
  capabilities: ToolCapability[];
  allowedTools?: string[] | undefined;
  deniedTools?: string[] | undefined;
}

export type RolePolicies = Record<Role, RolePolicy>;

const ALL_CAPABILITIES: ToolCapability[] = [
  "read",
  "write",
  "execute",
  "delegate",
  "external",
  "state",
];

export const DEFAULT_ROLE_POLICIES: RolePolicies = {
  owner: { capabilities: ALL_CAPABILITIES },
  collaborator: {
    capabilities: ["read", "write", "delegate", "external", "state"],
  },
  guest: { capabilities: ["read", "state"] },
};

export function canUseTool(
  role: Role,
  tool: CapabilityTool & { name: string },
  policies: RolePolicies = DEFAULT_ROLE_POLICIES,
): boolean {
  const policy = policies[role];
  if (policy.deniedTools?.includes(tool.name)) return false;
  if (policy.allowedTools && !policy.allowedTools.includes(tool.name)) {
    return false;
  }
  const allowed = new Set(policy.capabilities);
  return inferToolCapabilities(tool).every((capability) =>
    allowed.has(capability),
  );
}

export function filterToolsForRole<T extends CapabilityTool & { name: string }>(
  tools: readonly T[],
  role: Role,
  policies: RolePolicies = DEFAULT_ROLE_POLICIES,
): T[] {
  return tools.filter((tool) => canUseTool(role, tool, policies));
}
