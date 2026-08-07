import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  formatProjectRules,
  loadProjectRules,
} from "../src/context/project-rules.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("project rules", () => {
  it("loads scoped rules from the workspace root to the target directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "coding-agent-rules-"));
    tempDirs.push(workspace);
    const target = join(workspace, "packages", "app");
    await mkdir(target, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "root rule");
    await writeFile(join(workspace, ".agents.md"), "ignored fallback");
    await writeFile(join(workspace, "packages", ".agents.md"), "package rule");

    const rules = await loadProjectRules(workspace, target);

    assert.deepEqual(
      rules.map((rule) => rule.relativePath),
      ["AGENTS.md", "packages/.agents.md"],
    );
    assert.match(formatProjectRules(rules), /root rule/);
    assert.match(formatProjectRules(rules), /package rule/);
  });

  it("rejects a target outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "coding-agent-rules-"));
    tempDirs.push(workspace);

    await assert.rejects(loadProjectRules(workspace, tmpdir()), /工作区之外/);
  });

  it("does not hide rule read failures", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const workspace = await mkdtemp(join(tmpdir(), "coding-agent-rules-"));
    tempDirs.push(workspace);
    const file = join(workspace, "AGENTS.md");
    await writeFile(file, "private");
    await chmod(file, 0o000);

    await assert.rejects(loadProjectRules(workspace), /AGENTS\.md/);
    await chmod(file, 0o600);
  });

  it("rejects rule files that are symlinked outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "coding-agent-rules-"));
    const outside = await mkdtemp(
      join(tmpdir(), "coding-agent-rules-outside-"),
    );
    tempDirs.push(workspace, outside);
    await writeFile(join(outside, "rules.md"), "injected rule");
    await symlink(join(outside, "rules.md"), join(workspace, "AGENTS.md"));

    await assert.rejects(loadProjectRules(workspace), /工作区之外/);
  });
});
