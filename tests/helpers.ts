import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRunContext,
  createAgentRunContext,
} from "../src/agent/run-context.ts";
import type { RequestApproval } from "../src/security/permissions.ts";
import { SkillView } from "../src/skills/loader.ts";
import { ToolRegistry, type ToolSelection } from "../src/tools/registry.ts";

export function createTestRunContext(
  registryOrWorkingDir: ToolRegistry | string = new ToolRegistry(),
  options: {
    workingDir?: string;
    selection?: ToolSelection;
    signal?: AbortSignal;
    requestApproval?: RequestApproval;
    skillView?: SkillView;
  } = {},
): AgentRunContext {
  const registry =
    typeof registryOrWorkingDir === "string"
      ? new ToolRegistry()
      : registryOrWorkingDir;
  const workingDir =
    typeof registryOrWorkingDir === "string"
      ? registryOrWorkingDir
      : (options.workingDir ?? process.cwd());
  return createAgentRunContext(workingDir, {
    toolView: registry.createView(options.selection),
    skillView: options.skillView ?? new SkillView([]),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.requestApproval
      ? { requestApproval: options.requestApproval }
      : {}),
  });
}

export function makeTempDir(prefix = "coding-agent-fixture-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function withMutedConsole<T>(
  fn: () => Promise<T> | T,
): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

export async function withWorkingDir<T>(
  dir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}
