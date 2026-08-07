import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DIMS } from "../src/rag/embedder.ts";
import { SqliteVectorStore } from "../src/rag/sqlite-store.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

function unitVector(index: number): number[] {
  const vector = Array<number>(DIMS).fill(0);
  vector[index] = 1;
  return vector;
}

describe("SQLite vector search fallback", () => {
  it("keeps vector search available when sqlite-vec fails to load", () => {
    const store = new SqliteVectorStore(":memory:", {
      loadVectorExtension: () => {
        throw new Error("sqlite-vec unavailable");
      },
    });

    store.add(
      {
        id: "docs/a.md#0",
        text: "alpha",
        source: "docs/a.md",
        index: 0,
        tokenEstimate: 1,
      },
      unitVector(0),
    );
    store.add(
      {
        id: "docs/b.md#0",
        text: "beta",
        source: "docs/b.md",
        index: 0,
        tokenEstimate: 1,
      },
      unitVector(1),
    );

    assert.deepEqual(
      store.vectorSearch(unitVector(0), 1).map(({ chunk }) => chunk.id),
      ["docs/a.md#0"],
    );

    store.clear();
    assert.equal(store.size(), 0);
  });

  it("uses persisted embeddings after the database is reopened", () => {
    const tempDir = makeTempDir("coding-agent-rag-");
    const dbPath = join(tempDir, "knowledge.db");
    const unavailableExtension = {
      loadVectorExtension: () => {
        throw new Error("sqlite-vec unavailable");
      },
    };

    try {
      const original = new SqliteVectorStore(dbPath, unavailableExtension);
      original.add(
        {
          id: "docs/persisted.md#0",
          text: "persisted",
          source: "docs/persisted.md",
          index: 0,
          tokenEstimate: 2,
        },
        unitVector(2),
      );
      original.close();

      const reopened = new SqliteVectorStore(dbPath, unavailableExtension);
      assert.deepEqual(
        reopened.vectorSearch(unitVector(2), 1).map(({ chunk }) => chunk.id),
        ["docs/persisted.md#0"],
      );
      reopened.close();
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("returns the same Top-K order with and without sqlite-vec", () => {
    const tempDir = makeTempDir("coding-agent-rag-");
    const dbPath = join(tempDir, "knowledge.db");
    const mixedVector = Array<number>(DIMS).fill(0);
    mixedVector[0] = 0.8;
    mixedVector[1] = 0.6;
    const items = [
      { id: "exact", text: "exact", embedding: unitVector(0) },
      { id: "mixed", text: "mixed", embedding: mixedVector },
      { id: "other", text: "other", embedding: unitVector(1) },
    ];

    try {
      const accelerated = new SqliteVectorStore(dbPath);
      for (const [index, item] of items.entries()) {
        accelerated.add(
          {
            id: item.id,
            text: item.text,
            source: "docs/vectors.md",
            index,
            tokenEstimate: 1,
          },
          item.embedding,
        );
      }
      const acceleratedIds = accelerated
        .vectorSearch(unitVector(0), 2)
        .map(({ chunk }) => chunk.id);
      accelerated.close();

      const fallback = new SqliteVectorStore(dbPath, {
        loadVectorExtension: () => {
          throw new Error("sqlite-vec unavailable");
        },
      });
      const fallbackIds = fallback
        .vectorSearch(unitVector(0), 2)
        .map(({ chunk }) => chunk.id);
      fallback.close();

      assert.deepEqual(acceleratedIds, ["exact", "mixed"]);
      assert.deepEqual(fallbackIds, acceleratedIds);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("indexes embeddings written while sqlite-vec was unavailable after it recovers", () => {
    const tempDir = makeTempDir("coding-agent-rag-");
    const dbPath = join(tempDir, "knowledge.db");

    try {
      const fallback = new SqliteVectorStore(dbPath, {
        loadVectorExtension: () => {
          throw new Error("sqlite-vec unavailable");
        },
      });
      fallback.add(
        {
          id: "recovered",
          text: "recovered",
          source: "docs/recovered.md",
          index: 0,
          tokenEstimate: 2,
        },
        unitVector(3),
      );
      fallback.close();

      const recovered = new SqliteVectorStore(dbPath);
      assert.deepEqual(
        recovered.vectorSearch(unitVector(3), 1).map(({ chunk }) => chunk.id),
        ["recovered"],
      );
      recovered.close();
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
