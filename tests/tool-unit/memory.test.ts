import assert from "node:assert/strict";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type CommandContext,
  createDispatcher,
} from "../../src/commands/index.ts";
import { memoryCommands } from "../../src/commands/memory.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createMemoryTool } from "../../src/tools/memory-tools.ts";
import { cleanupTempDir, makeTempDir, withMutedConsole } from "../helpers.ts";

describe("memory store", () => {
  it("updates the same logical memory without creating a duplicate", () => {
    const dir = makeTempDir();
    try {
      const store = new MemoryStore(dir);
      const first = store.save({
        name: "A+B",
        description: "first",
        type: "project",
        content: "version one",
      });
      const second = store.save({
        name: "A+B",
        description: "second",
        type: "project",
        content: "version two",
      });

      assert.equal(second, first);
      assert.equal(store.list().length, 1);
      assert.match(store.loadFile(first) ?? "", /version two/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("keeps different names that normalize to the same slug", () => {
    const dir = makeTempDir();
    try {
      const store = new MemoryStore(dir);
      const first = store.save({
        name: "A+B",
        description: "plus",
        type: "project",
        content: "plus content",
      });
      const second = store.save({
        name: "A B",
        description: "space",
        type: "project",
        content: "space content",
      });

      assert.notEqual(second, first);
      assert.equal(store.list().length, 2);
      assert.match(store.loadFile(first) ?? "", /plus content/);
      assert.match(store.loadFile(second) ?? "", /space content/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("creates distinct filenames across types and for names without a slug", () => {
    const dir = makeTempDir();
    try {
      const store = new MemoryStore(dir);
      const userFile = store.save({
        name: "✨",
        description: "user",
        type: "user",
        content: "user content",
      });
      const projectFile = store.save({
        name: "✨",
        description: "project",
        type: "project",
        content: "project content",
      });

      assert.match(userFile, /^user_memory-[a-f0-9]{12}\.md$/);
      assert.match(projectFile, /^project_memory-[a-f0-9]{12}\.md$/);
      assert.notEqual(projectFile, userFile);
      assert.equal(store.list().length, 2);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("blocks paths and symlinks outside the memory directory", async () => {
    const dir = makeTempDir();
    try {
      const store = new MemoryStore(dir);
      store.init();
      const outsideFile = join(dir, "outside.md");
      writeFileSync(outsideFile, "outside", "utf-8");

      assert.throws(() => store.loadFile("../outside.md"), /非法记忆文件名/);
      assert.throws(() => store.delete(outsideFile), /非法记忆文件名/);
      assert.throws(() => store.loadFile("MEMORY.md"), /非法记忆文件名/);

      const linkName = "project_link.md";
      symlinkSync(outsideFile, join(dir, ".memory", linkName));
      assert.throws(() => store.loadFile(linkName), /目录之外/);
      assert.equal(store.list().length, 0);
      assert.equal(existsSync(outsideFile), true);

      const tool = createMemoryTool(store);
      assert.match(
        String(
          await tool.execute({ action: "delete", filename: "../outside.md" }),
        ),
        /删除失败：非法记忆文件名/,
      );
      assert.equal(
        await tool.execute({ action: "search" }),
        "搜索失败：需要 query 参数",
      );
      assert.equal(existsSync(outsideFile), true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("memory commands", () => {
  it("handles a missing query as usage instead of a model prompt", async () => {
    const queries: string[] = [];
    const ctx = {
      memoryStore: {
        search(query: string) {
          queries.push(query);
          return [];
        },
      },
    } as unknown as CommandContext;
    const dispatch = createDispatcher(memoryCommands);

    const handled = await withMutedConsole(() =>
      dispatch("/memory search", ctx),
    );

    assert.equal(handled, true);
    assert.deepEqual(queries, []);
  });

  it("supports only the production memory search command", async () => {
    const queries: string[] = [];
    const ctx = {
      memoryStore: {
        search(query: string) {
          queries.push(query);
          return [];
        },
      },
    } as unknown as CommandContext;
    const dispatch = createDispatcher(memoryCommands);

    await withMutedConsole(() => dispatch("/memory search alpha", ctx));
    const aliasHandled = await withMutedConsole(() =>
      dispatch("memory search beta", ctx),
    );

    assert.deepEqual(queries, ["alpha"]);
    assert.equal(aliasHandled, false);
  });
});
