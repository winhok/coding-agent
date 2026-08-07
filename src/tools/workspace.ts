import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface WorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export async function resolveWorkspacePath(
  workingDir: string,
  inputPath: string,
  options: { mustExist: boolean; forbidGit?: boolean },
): Promise<WorkspacePath> {
  const root = await realpath(resolve(workingDir));
  const candidate = resolve(root, inputPath);
  assertInside(root, candidate);

  let safePath = candidate;
  if (options.mustExist) {
    safePath = await realpath(candidate);
    assertInside(root, safePath);
  } else {
    safePath = await resolveExistingTargetOrParent(root, candidate);
  }

  const relativePath = relative(root, safePath) || ".";
  if (options.forbidGit && hasGitSegment(relativePath)) {
    throw new WorkspacePathError("不允许修改 .git 目录下的文件");
  }
  return { absolutePath: safePath, relativePath };
}

async function resolveExistingTargetOrParent(
  root: string,
  candidate: string,
): Promise<string> {
  if (await pathExists(candidate)) {
    const actual = await resolveExistingPath(candidate);
    assertInside(root, actual);
    return actual;
  }

  let current = dirname(candidate);
  while (true) {
    if (await pathExists(current)) {
      const actualParent = await resolveExistingPath(current);
      assertInside(root, actualParent);
      return resolve(actualParent, relative(current, candidate));
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new WorkspacePathError("无法找到可写入的工作区父目录");
    }
    current = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function resolveExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) {
      throw new WorkspacePathError("不能写入无法安全解析的符号链接");
    }
    throw error;
  }
}

function assertInside(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new WorkspacePathError("不能访问工作目录之外的路径");
  }
}

function hasGitSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes(".git");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class WorkspacePathError extends Error {}

export function assertWorkspaceGlobPattern(pattern: string): void {
  const candidate = pattern.replace(/^!+/, "");
  if (isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) {
    throw new WorkspacePathError("glob 模式不能访问工作目录之外的路径");
  }
}
