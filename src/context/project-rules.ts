import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const RULE_FILES = ["AGENTS.md", ".agents.md"] as const;

export interface ProjectRule {
  path: string;
  relativePath: string;
  content: string;
}

export async function loadProjectRules(
  workspaceDir: string,
  targetDir = workspaceDir,
): Promise<ProjectRule[]> {
  const workspace = await realpath(resolve(workspaceDir));
  const target = await realpath(resolve(targetDir));
  const targetRelative = relative(workspace, target);
  if (isOutside(targetRelative)) {
    throw new Error(`不能加载工作区之外的项目规则: ${target}`);
  }

  const directories = [workspace];
  if (targetRelative) {
    let current = workspace;
    for (const segment of targetRelative.split(sep)) {
      current = join(current, segment);
      directories.push(current);
    }
  }

  const rules: ProjectRule[] = [];
  for (const directory of directories) {
    for (const filename of RULE_FILES) {
      const path = join(directory, filename);
      try {
        const actualPath = await realpath(path);
        if (isOutside(relative(workspace, actualPath))) {
          throw new Error("规则文件指向工作区之外");
        }
        const content = await readFile(actualPath, "utf8");
        if (content.trim()) {
          rules.push({
            path,
            relativePath: relative(workspace, path) || filename,
            content: content.trim(),
          });
        }
        break;
      } catch (error) {
        if (isMissing(error)) continue;
        throw new Error(
          `读取项目规则 ${path} 失败: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }
  return rules;
}

export function formatProjectRules(rules: readonly ProjectRule[]): string {
  if (rules.length === 0) return "";
  return [
    "# 项目规则",
    "以下规则按工作区根目录到目标目录排列；后出现的更具体规则优先。",
    ...rules.map((rule) => `## ${rule.relativePath}\n\n${rule.content}`),
  ].join("\n\n");
}

function isOutside(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
