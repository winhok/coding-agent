import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bashTool } from "../../tools/bash.tool.ts";
import { editFileTool } from "../../tools/edit_file.tool.ts";
import { getCurrentTimeTool } from "../../tools/get_current_time.tool.ts";
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
      ]),
    );
  });

  it("reads, writes, and lists files deterministically", async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, "note.txt");
      const nested = join(dir, "nested");
      mkdirSync(nested);

      const writeResult = await writeFileTool.execute({
        path: file,
        content: "hello eval",
      });
      assert.equal(readFileSync(file, "utf-8"), "hello eval");
      assert.match(String(writeResult), /已写入 10 字符/);

      const readResult = await readFileTool.execute({ path: file });
      assert.equal(readResult, "hello eval");

      const listResult = String(await listDirectoryTool.execute({ path: dir }));
      assert.match(listResult, /note\.txt/);
      assert.match(listResult, /nested/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("edits exactly one matching range and rejects ambiguous edits", async () => {
    const dir = makeTempDir();
    try {
      const uniqueFile = join(dir, "unique.txt");
      writeFileSync(uniqueFile, "alpha\nbeta\n", "utf-8");

      const editResult = await editFileTool.execute({
        path: uniqueFile,
        old_string: "beta",
        new_string: "gamma",
      });
      assert.match(String(editResult), /已替换/);
      assert.equal(readFileSync(uniqueFile, "utf-8"), "alpha\ngamma\n");

      const missingResult = await editFileTool.execute({
        path: uniqueFile,
        old_string: "missing",
        new_string: "value",
      });
      assert.match(String(missingResult), /未找到匹配内容/);

      const ambiguousFile = join(dir, "ambiguous.txt");
      writeFileSync(ambiguousFile, "same\nsame\n", "utf-8");
      const ambiguousResult = await editFileTool.execute({
        path: ambiguousFile,
        old_string: "same",
        new_string: "other",
      });
      assert.match(String(ambiguousResult), /找到 2 处匹配/);
      assert.equal(readFileSync(ambiguousFile, "utf-8"), "same\nsame\n");
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

  it("returns the current time and executes bash when the host supports it", async () => {
    assert.equal(typeof (await getCurrentTimeTool.execute({})), "string");

    const bashResult = String(
      await bashTool.execute({ command: "printf eval-ok" }),
    );
    assert.ok(
      bashResult === "eval-ok" || bashResult.includes("[bash 不可用]"),
      `unexpected bash result: ${bashResult}`,
    );
  });
});
