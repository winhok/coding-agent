import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bashTool } from "../../tools/bash.tool.ts";
import { editFileTool } from "../../tools/edit_file.tool.ts";
import { getCurrentTimeTool } from "../../tools/get_current_time.tool.ts";
import { gitDiffTool } from "../../tools/git_diff.tool.ts";
import { gitStatusTool } from "../../tools/git_status.tool.ts";
import { globTool } from "../../tools/glob.tool.ts";
import { grepTool } from "../../tools/grep.tool.ts";
import { listDirectoryTool } from "../../tools/list_directory.tool.ts";
import { readFileTool } from "../../tools/read_file.tool.ts";
import { allTools } from "../../tools/tools.ts";
import { writeFileTool } from "../../tools/write_file.tool.ts";
import { cleanupTempDir, makeTempDir } from "../../verification/helpers.ts";

describe("tool-unit tools", () => {
  it("registers every implemented tool", () => {
    const names = new Set(allTools.map((tool) => tool.name));

    assert.deepEqual(
      names,
      new Set([
        "read_file",
        "write_file",
        "list_directory",
        "get_current_time",
        "bash",
        "grep",
        "glob",
        "edit_file",
        "git_status",
        "git_diff",
      ]),
    );
  });

  it("reads, writes, and lists files deterministically", async () => {
    const dir = makeTempDir();
    try {
      const nested = join(dir, "nested");
      mkdirSync(nested);

      const writeResult = await withWorkingDir(dir, () =>
        writeFileTool.execute({ path: "note.txt", content: "hello eval" }),
      );
      const file = join(dir, "note.txt");
      assert.equal(readFileSync(file, "utf-8"), "hello eval");
      assert.match(String(writeResult), /已写入 10 字符/);

      const readResult = await withWorkingDir(dir, () =>
        readFileTool.execute({ path: "note.txt" }),
      );
      assert.match(String(readResult), /文件: note\.txt \(1 行\)/);
      assert.match(String(readResult), /显示第 1-1 行/);
      assert.match(String(readResult), /1: hello eval/);

      const listResult = String(await listDirectoryTool.execute({ path: dir }));
      assert.match(listResult, /note\.txt/);
      assert.match(listResult, /nested/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("read_file supports line ranges and blocks unsafe targets", async () => {
    const dir = makeTempDir();
    const outsideDir = makeTempDir();
    try {
      await withWorkingDir(dir, async () => {
        writeFileSync(
          join(dir, "long.txt"),
          Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n"),
          "utf-8",
        );

        const rangeResult = String(
          await readFileTool.execute({
            path: "long.txt",
            startLine: 2,
            endLine: 4,
          }),
        );
        assert.match(rangeResult, /文件: long\.txt \(250 行\)/);
        assert.match(rangeResult, /显示第 2-4 行/);
        assert.match(rangeResult, /2: line 2/);
        assert.match(rangeResult, /4: line 4/);
        assert.doesNotMatch(rangeResult, /5: line 5/);
        assert.match(rangeResult, /共 250 行，仅显示第 2-4 行/);

        const defaultRangeResult = String(
          await readFileTool.execute({ path: "long.txt", startLine: 240 }),
        );
        assert.match(defaultRangeResult, /显示第 240-250 行/);
        assert.match(defaultRangeResult, /250: line 250/);

        const outsideFile = join(outsideDir, "outside.txt");
        writeFileSync(outsideFile, "outside", "utf-8");
        const unsafeResult = await readFileTool.execute({ path: outsideFile });
        assert.match(String(unsafeResult), /不能读取工作目录之外/);

        const missingResult = await readFileTool.execute({
          path: "missing.txt",
        });
        assert.match(String(missingResult), /文件不存在 missing\.txt/);
      });
    } finally {
      cleanupTempDir(dir);
      cleanupTempDir(outsideDir);
    }
  });

  it("write_file creates parent directories and blocks unsafe targets", async () => {
    const dir = makeTempDir();
    try {
      await withWorkingDir(dir, async () => {
        const nestedResult = await writeFileTool.execute({
          path: "nested/deep/note.txt",
          content: "one\ntwo",
        });
        assert.equal(
          readFileSync(join(dir, "nested", "deep", "note.txt"), "utf-8"),
          "one\ntwo",
        );
        assert.match(String(nestedResult), /nested\/deep\/note\.txt/);
        assert.match(String(nestedResult), /2 行/);

        const traversalResult = await writeFileTool.execute({
          path: "../outside.txt",
          content: "blocked",
        });
        assert.match(String(traversalResult), /不能写入工作目录之外/);

        const gitResult = await writeFileTool.execute({
          path: ".git/config",
          content: "blocked",
        });
        assert.match(String(gitResult), /不允许修改 \.git/);
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("edits exactly one matching range and rejects ambiguous edits", async () => {
    const dir = makeTempDir();
    try {
      const uniqueFile = join(dir, "unique.txt");
      writeFileSync(uniqueFile, "alpha\nbeta\n", "utf-8");

      await withWorkingDir(dir, async () => {
        const editResult = await editFileTool.execute({
          path: "unique.txt",
          old_string: "beta",
          new_string: "gamma",
        });
        assert.match(String(editResult), /已修改 unique\.txt/);
        assert.match(String(editResult), /位置：第 2-2 行/);
        assert.match(String(editResult), /1 行 -> 1 行/);
        assert.equal(readFileSync(uniqueFile, "utf-8"), "alpha\ngamma\n");

        const missingResult = await editFileTool.execute({
          path: "unique.txt",
          old_string: "missing",
          new_string: "value",
        });
        assert.match(
          String(missingResult),
          /未在 unique\.txt 中找到指定的 old_string/,
        );

        const ambiguousFile = join(dir, "ambiguous.txt");
        writeFileSync(ambiguousFile, "same\nsame\n", "utf-8");
        const ambiguousResult = await editFileTool.execute({
          path: "ambiguous.txt",
          old_string: "same",
          new_string: "other",
        });
        assert.match(String(ambiguousResult), /old_string 在文件中出现了多次/);
        assert.equal(readFileSync(ambiguousFile, "utf-8"), "same\nsame\n");
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("edit_file blocks unsafe targets and empty old_string", async () => {
    const dir = makeTempDir();
    const outsideDir = makeTempDir();
    try {
      await withWorkingDir(dir, async () => {
        const outsideFile = join(outsideDir, "outside.txt");
        writeFileSync(outsideFile, "outside", "utf-8");
        const traversalResult = await editFileTool.execute({
          path: outsideFile,
          old_string: "outside",
          new_string: "changed",
        });
        assert.match(String(traversalResult), /不能修改工作目录之外/);
        assert.equal(readFileSync(outsideFile, "utf-8"), "outside");

        mkdirSync(join(dir, ".git"));
        writeFileSync(join(dir, ".git", "config"), "config", "utf-8");
        const gitResult = await editFileTool.execute({
          path: ".git/config",
          old_string: "config",
          new_string: "changed",
        });
        assert.match(String(gitResult), /不允许修改 \.git/);

        writeFileSync(join(dir, "note.txt"), "note", "utf-8");
        const emptyResult = await editFileTool.execute({
          path: "note.txt",
          old_string: "",
          new_string: "prefix",
        });
        assert.match(String(emptyResult), /old_string 不能为空/);
        assert.equal(readFileSync(join(dir, "note.txt"), "utf-8"), "note");
      });
    } finally {
      cleanupTempDir(dir);
      cleanupTempDir(outsideDir);
    }
  });

  it("edit_file gives a line hint when only the first line matches", async () => {
    const dir = makeTempDir();
    try {
      await withWorkingDir(dir, async () => {
        writeFileSync(
          join(dir, "hint.txt"),
          "alpha\nbeta = 2;\ngamma\n",
          "utf-8",
        );

        const result = await editFileTool.execute({
          path: "hint.txt",
          old_string: "beta = 2\nmissing",
          new_string: "replacement",
        });

        assert.match(String(result), /未在 hint\.txt 中找到完全匹配的内容/);
        assert.match(
          String(result),
          /第一行 "beta = 2" 在第 2 行附近有部分匹配/,
        );
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("searches files with glob and grep using ripgrep defaults", async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "node_modules"));
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
      writeFileSync(
        join(dir, "src", "main.ts"),
        "const marker = 1;\n",
        "utf-8",
      );
      writeFileSync(
        join(dir, "src", "case.ts"),
        "const Marker = 2;\n",
        "utf-8",
      );
      writeFileSync(
        join(dir, "node_modules", "hidden.ts"),
        "const marker = 3;\n",
        "utf-8",
      );
      writeFileSync(
        join(dir, ".git", "config"),
        "const marker = 4;\n",
        "utf-8",
      );

      const globResult = String(
        await globTool.execute({ pattern: "**/*.ts", path: dir }),
      );
      assert.match(globResult, /src\/main\.ts/);
      assert.doesNotMatch(globResult, /node_modules/);

      const grepResult = String(
        await grepTool.execute({ pattern: "marker", path: dir }),
      );
      assert.match(grepResult, /src\/main\.ts:1/);
      assert.doesNotMatch(grepResult, /src\/case\.ts/);
      assert.doesNotMatch(grepResult, /node_modules/);
      assert.doesNotMatch(grepResult, /\.git/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("limits grep results globally", async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(
        join(dir, "src", "one.txt"),
        "needle one\nneedle two\n",
        "utf-8",
      );
      writeFileSync(
        join(dir, "src", "two.txt"),
        "needle three\nneedle four\n",
        "utf-8",
      );

      const grepResult = String(
        await grepTool.execute({ pattern: "needle", path: dir, maxResults: 2 }),
      );

      const lines = grepResult.split("\n");
      assert.equal(lines.filter((line) => line.includes("needle")).length, 2);
      assert.match(grepResult, /仅显示前 2 条/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("limits glob results globally", async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "one.ts"), "", "utf-8");
      writeFileSync(join(dir, "src", "two.ts"), "", "utf-8");
      writeFileSync(join(dir, "src", "three.ts"), "", "utf-8");

      const globResult = String(
        await globTool.execute({
          pattern: "src/*.ts",
          path: dir,
          maxResults: 2,
        }),
      );

      const lines = globResult.split("\n");
      assert.equal(lines.filter((line) => line.endsWith(".ts")).length, 2);
      assert.match(globResult, /仅显示前 2 个/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("returns the current time and executes bash when the host supports it", async () => {
    assert.equal(typeof (await getCurrentTimeTool.execute({})), "string");

    const bashResult = String(
      await bashTool.execute({ command: "printf eval-ok" }),
    );
    assert.ok(
      bashResult === "stdout:\neval-ok" || bashResult.includes("[bash 不可用]"),
      `unexpected bash result: ${bashResult}`,
    );
  });

  it("formats bash stdout and stderr on successful commands", async () => {
    const bashResult = String(
      await bashTool.execute({
        command: `node -e "console.log('out'); console.error('err')"`,
      }),
    );

    if (bashResult.includes("[bash 不可用]")) return;

    assert.match(bashResult, /stdout:\nout/);
    assert.match(bashResult, /stderr:\nerr/);
  });

  it("formats bash failures with exit code, stdout, and stderr", async () => {
    const bashResult = String(
      await bashTool.execute({
        command: `node -e "console.log('out'); console.error('err'); process.exit(7)"`,
      }),
    );

    if (bashResult.includes("[bash 不可用]")) return;

    assert.match(bashResult, /exit code: 7/);
    assert.match(bashResult, /stdout:\nout/);
    assert.match(bashResult, /stderr:\nerr/);
  });

  it("honors bash timeout arguments", async () => {
    const bashResult = String(
      await bashTool.execute({
        command: `node -e "setTimeout(() => {}, 200)"`,
        timeout: 20,
      }),
    );

    if (bashResult.includes("[bash 不可用]")) return;

    assert.match(bashResult, /命令因超时被终止/);
  });

  it("truncates long bash output before returning directly", async () => {
    const bashResult = String(
      await bashTool.execute({
        command: `node -e "process.stdout.write('x'.repeat(12000))"`,
      }),
    );

    if (bashResult.includes("[bash 不可用]")) return;

    assert.ok(bashResult.length < 12000, `output was not truncated`);
    assert.match(bashResult, /输出过长，已截断/);
  });

  it("reports git short status for the current working directory", async () => {
    const dir = makeTempDir();
    try {
      await withWorkingDir(dir, async () => {
        await bashTool.execute({ command: "git init" });
        writeFileSync(join(dir, "note.txt"), "dirty", "utf-8");

        const statusResult = String(await gitStatusTool.execute({}));

        assert.match(statusResult, /当前变更:/);
        assert.match(statusResult, /\?\? note\.txt/);
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("reports unstaged, staged, and path-scoped git diffs", async () => {
    const dir = makeTempDir();
    try {
      await withWorkingDir(dir, async () => {
        await initGitRepo();
        writeFileSync(join(dir, "note.txt"), "base\n", "utf-8");
        writeFileSync(join(dir, "other.txt"), "same\n", "utf-8");
        await bashTool.execute({ command: "git add note.txt other.txt" });
        await bashTool.execute({
          command:
            "git -c user.email=test@example.com -c user.name=Test commit -m init",
        });

        writeFileSync(join(dir, "note.txt"), "base\nchanged\n", "utf-8");
        const unstagedResult = String(await gitDiffTool.execute({}));

        assert.match(unstagedResult, /diff --git a\/note\.txt b\/note\.txt/);
        assert.match(unstagedResult, /\+changed/);

        await bashTool.execute({ command: "git add note.txt" });
        const noUnstagedResult = String(await gitDiffTool.execute({}));
        assert.equal(noUnstagedResult, "没有未暂存的变更。");

        const stagedResult = String(
          await gitDiffTool.execute({ staged: true }),
        );
        assert.match(stagedResult, /diff --git a\/note\.txt b\/note\.txt/);
        assert.match(stagedResult, /\+changed/);

        const pathResult = String(
          await gitDiffTool.execute({ staged: true, path: "other.txt" }),
        );
        assert.equal(pathResult, "暂存区没有变更。");
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("truncates long git diff output", async () => {
    const dir = makeTempDir();
    try {
      await withWorkingDir(dir, async () => {
        await initGitRepo();
        writeFileSync(join(dir, "long.txt"), "base\n", "utf-8");
        await bashTool.execute({ command: "git add long.txt" });
        await bashTool.execute({
          command:
            "git -c user.email=test@example.com -c user.name=Test commit -m init",
        });
        writeFileSync(
          join(dir, "long.txt"),
          `base\n${"x".repeat(12_000)}\n`,
          "utf-8",
        );

        const diffResult = String(await gitDiffTool.execute({}));

        assert.ok(diffResult.length < 12_000, "diff output was not truncated");
        assert.match(diffResult, /diff 输出过长，已截断/);
        assert.match(diffResult, /共 \d+ 字符/);
      });
    } finally {
      cleanupTempDir(dir);
    }
  });
});

async function initGitRepo(): Promise<void> {
  await bashTool.execute({ command: "git init" });
}

async function withWorkingDir<T>(
  dir: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}
