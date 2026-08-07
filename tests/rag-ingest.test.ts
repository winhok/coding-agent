import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CommandContext } from "../src/commands/index.ts";
import { ragCommands } from "../src/commands/rag.ts";
import { chunkDocument } from "../src/rag/chunker.ts";
import { createMockEmbedder } from "../src/rag/embedder.ts";
import { importDocuments, ingestDocument } from "../src/rag/ingest.ts";
import { SqliteVectorStore } from "../src/rag/sqlite-store.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const unavailableExtension = {
  loadVectorExtension: () => {
    throw new Error("sqlite-vec unavailable");
  },
};

describe("RAG document ingestion", () => {
  it("accepts only the slash-prefixed ingest command", async () => {
    const command = ragCommands[1];
    assert.ok(command);
    assert.equal(command("ingest docs/a.md", {} as CommandContext), false);

    let receivedPath = "";
    let asked = false;
    const context = {
      registry: {
        getActiveTools: () => [
          {
            name: "rag_ingest",
            execute: async ({ path }: { path: string }) => {
              receivedPath = path;
              return "ok";
            },
          },
        ],
      },
      ask: () => {
        asked = true;
      },
    } as unknown as CommandContext;

    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.equal(command("/ingest docs/a.md", context), "async");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.log = originalLog;
    }

    assert.equal(receivedPath, "docs/a.md");
    assert.equal(asked, true);
  });

  it("skips unchanged content and replaces every old source chunk", async () => {
    const tempDir = makeTempDir("coding-agent-rag-ingest-");
    const source = join(tempDir, "document.md");
    const store = new SqliteVectorStore(":memory:", unavailableExtension);

    try {
      fs.writeFileSync(
        source,
        `${"first sentence. ".repeat(100)}\n\nobsolete tail`,
      );
      const first = await ingestDocument(source, store, createMockEmbedder());
      assert.equal(first.status, "imported");
      assert.ok(first.chunks > 1);

      const unchanged = await ingestDocument(
        source,
        store,
        createMockEmbedder(),
      );
      assert.equal(unchanged.status, "skipped");

      fs.writeFileSync(source, "replacement only");
      const replaced = await ingestDocument(
        source,
        store,
        createMockEmbedder(),
      );
      assert.equal(replaced.status, "imported");
      assert.equal(store.countSource(source), 1);
      assert.equal(store.keywordSearch("obsolete", 10).length, 0);
      assert.deepEqual(
        store.keywordSearch("replacement", 10).map(({ chunk }) => chunk.id),
        [`${source}#0`],
      );
    } finally {
      store.close();
      cleanupTempDir(tempDir);
    }
  });

  it("continues after one document fails", async () => {
    const tempDir = makeTempDir("coding-agent-rag-ingest-");
    const valid = join(tempDir, "valid.md");
    const missing = join(tempDir, "missing.md");
    const store = new SqliteVectorStore(":memory:", unavailableExtension);
    fs.writeFileSync(valid, "valid document");

    try {
      const summary = await importDocuments(
        [missing, valid],
        store,
        createMockEmbedder(),
      );
      assert.equal(summary.failed.length, 1);
      assert.equal(summary.imported.length, 1);
      assert.equal(store.countSource(valid), 1);
    } finally {
      store.close();
      cleanupTempDir(tempDir);
    }
  });

  it("rolls back source replacement when a vector write fails", () => {
    const store = new SqliteVectorStore(":memory:");
    const original = chunkDocument("docs/atomic.md", "original content")[0];
    const replacement = chunkDocument(
      "docs/atomic.md",
      "replacement content",
    )[0];
    assert.ok(original);
    assert.ok(replacement);

    try {
      store.replaceSource(
        original.source,
        [{ chunk: original, embedding: Array<number>(128).fill(0) }],
        "original-hash",
      );
      assert.throws(() =>
        store.replaceSource(
          replacement.source,
          [{ chunk: replacement, embedding: [1] }],
          "replacement-hash",
        ),
      );
      assert.equal(store.documentHash(original.source), "original-hash");
      assert.equal(store.keywordSearch("original", 5).length, 1);
      assert.equal(store.keywordSearch("replacement", 5).length, 0);
    } finally {
      store.close();
    }
  });

  it("handles FTS special characters without throwing", () => {
    const store = new SqliteVectorStore(":memory:", unavailableExtension);
    try {
      const chunk = chunkDocument(
        "docs/language.md",
        "C++ hello-world quoted text",
      )[0];
      assert.ok(chunk);
      store.replaceSource(
        chunk.source,
        [{ chunk, embedding: Array<number>(128).fill(0) }],
        "hash",
      );
      for (const query of ["C++", "hello-world", 'unclosed"', "+++"]) {
        assert.doesNotThrow(() => store.keywordSearch(query, 5));
      }
    } finally {
      store.close();
    }
  });

  it("hard-splits text without sentence boundaries", () => {
    const chunks = chunkDocument("docs/long.md", "x".repeat(3000));
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.text.length <= 1024));
  });
});
