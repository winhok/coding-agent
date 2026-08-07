import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
