import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentRunContext } from "../../src/agent/run-context.ts";
import { bashTool } from "../../src/tools/bash.tool.ts";
import { globTool } from "../../src/tools/glob.tool.ts";
import { readFileTool } from "../../src/tools/read_file.tool.ts";
import { writeFileTool } from "../../src/tools/write_file.tool.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace execution context", () => {
  it("runs shell commands in the injected working directory", async () => {
    const workspace = await makeTemp("workspace");
    const result = String(
      await bashTool.execute(
        { command: "pwd" },
        createAgentRunContext(workspace),
      ),
    );

    assert.match(
      result,
      new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("blocks reads and writes that escape through symbolic links", async () => {
    const workspace = await makeTemp("workspace");
    const outside = await makeTemp("outside");
    await writeFile(join(outside, "secret.txt"), "secret");
    await mkdir(join(outside, "target"));
    await symlink(join(outside, "secret.txt"), join(workspace, "secret-link"));
    await symlink(join(outside, "target"), join(workspace, "write-link"));
    await symlink(
      join(outside, "missing.txt"),
      join(workspace, "dangling-link"),
    );
    const context = createAgentRunContext(workspace);

    assert.match(
      String(await readFileTool.execute({ path: "secret-link" }, context)),
      /不能读取工作目录之外/,
    );
    assert.match(
      String(
        await writeFileTool.execute(
          { path: "write-link/new.txt", content: "escape" },
          context,
        ),
      ),
      /不能写入工作目录之外/,
    );
    assert.match(
      String(
        await writeFileTool.execute(
          { path: "dangling-link", content: "escape" },
          context,
        ),
      ),
      /不能写入工作目录之外/,
    );
  });

  it("blocks glob patterns that traverse outside the workspace", async () => {
    const workspace = await makeTemp("workspace");
    const context = createAgentRunContext(workspace);

    assert.match(
      String(
        await globTool.execute({ pattern: "../**/*.txt", path: "." }, context),
      ),
      /不能访问工作目录之外/,
    );
  });
});

async function makeTemp(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `coding-agent-${label}-`));
  tempDirs.push(dir);
  return dir;
}
