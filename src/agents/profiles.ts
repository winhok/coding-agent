import type { ToolCapability } from "../tools/execution-pipeline.js";
import type { ToolSelection } from "../tools/registry.js";
import type { SpawnRequest, SubAgentProfile } from "./types.js";

const CHILD_DENIED_CAPABILITIES = new Set<ToolCapability>(["delegate"]);

export interface ResolvedSubAgentProfile {
  name: string;
  profile: SubAgentProfile;
  selection: ToolSelection;
}

/** Resolves configurable profile policy into an execution-layer tool filter. */
export function resolveSubAgentProfile(
  request: SpawnRequest,
  profiles: Record<string, SubAgentProfile>,
  parallel = false,
): ResolvedSubAgentProfile {
  const name = request.profile ?? (parallel ? "explorer" : "general");
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`未知子 Agent Profile: ${name}`);
  }

  const profileTools = profile.tools ? new Set(profile.tools) : undefined;
  const requestTools = request.tools ? new Set(request.tools) : undefined;
  const allowedTools = intersectTools(profileTools, requestTools);

  return {
    name,
    profile,
    selection: {
      allowedCapabilities: new Set(profile.capabilities),
      deniedCapabilities: CHILD_DENIED_CAPABILITIES,
      ...(allowedTools ? { allowedTools } : {}),
      ...(parallel ? { readOnlyOnly: true } : {}),
    },
  };
}

function intersectTools(
  profileTools?: ReadonlySet<string>,
  requestTools?: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (!profileTools && !requestTools) return undefined;
  if (!profileTools) return requestTools;
  if (!requestTools) return profileTools;
  return new Set([...profileTools].filter((name) => requestTools.has(name)));
}
