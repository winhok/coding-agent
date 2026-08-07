import fs from "node:fs";
import path from "node:path";
import type { MemoryEntry } from "./store.js";

export interface ValidationIssue {
  kind: "stale_path" | "never_used" | "duplicate_name";
  message: string;
}

export interface ValidationReport {
  entry: MemoryEntry;
  issues: ValidationIssue[];
}

const PATH_RE =
  /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g;

export function extractPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(PATH_RE)) {
    const matchedPath = match[1];
    if (matchedPath) paths.add(matchedPath);
  }
  return Array.from(paths);
}

const TTL_BY_TYPE: Record<MemoryEntry["type"], number> = {
  user: 365,
  feedback: 90,
  project: 30,
  reference: 14,
};

export function validateEntry(
  entry: MemoryEntry,
  baseDir = ".",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const referencedPath of extractPaths(entry.content)) {
    const absolutePath = path.isAbsolute(referencedPath)
      ? referencedPath
      : path.join(baseDir, referencedPath);
    if (!fs.existsSync(absolutePath)) {
      issues.push({
        kind: "stale_path",
        message: `引用的路径不存在：${referencedPath}`,
      });
    }
  }

  if (entry.lastReadAt) {
    const staleDays = TTL_BY_TYPE[entry.type];
    const daysSinceLastRead =
      (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24);
    if (daysSinceLastRead > staleDays) {
      issues.push({
        kind: "never_used",
        message: `已 ${Math.floor(daysSinceLastRead)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
      });
    }
  }

  return issues;
}

export function lintAll(
  entries: MemoryEntry[],
  baseDir = ".",
): ValidationReport[] {
  const reports: ValidationReport[] = [];
  const nameCount = new Map<string, number>();

  for (const entry of entries) {
    nameCount.set(entry.name, (nameCount.get(entry.name) ?? 0) + 1);
  }

  for (const entry of entries) {
    const issues = validateEntry(entry, baseDir);
    const duplicateCount = nameCount.get(entry.name) ?? 0;
    if (duplicateCount > 1) {
      issues.push({
        kind: "duplicate_name",
        message: `存在 ${duplicateCount} 条同名记忆，可能需要合并`,
      });
    }
    if (issues.length > 0) reports.push({ entry, issues });
  }

  return reports;
}
