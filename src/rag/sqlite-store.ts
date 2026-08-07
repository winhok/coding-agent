import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Chunk } from "./chunker.js";
import { cosineSimilarity, type EmbeddingFn, embed } from "./embedder.js";
import { mmrSelect, type SearchResult, type StoredChunk } from "./search.js";

export interface SqliteVectorStoreOptions {
  loadVectorExtension?: (db: Database.Database) => void;
}

interface ChunkRow {
  id: string;
  text: string;
  source: string;
  chunk_index: number;
  embedding: string;
  updated_at: number;
}

export class SqliteVectorStore {
  private db: Database.Database;
  private vectorExtensionAvailable = false;

  constructor(
    dbPath: string = "knowledge.db",
    options: SqliteVectorStoreOptions = {},
  ) {
    this.db = new Database(dbPath);
    this.createBaseTables();

    try {
      const loadVectorExtension = options.loadVectorExtension ?? sqliteVec.load;
      loadVectorExtension(this.db);
      this.createVectorTable();
      this.backfillVectorTable();
      this.vectorExtensionAvailable = true;
    } catch {
      this.vectorExtensionAvailable = false;
    }
  }

  private createBaseTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'text-embedding-v3',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        source TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, id UNINDEXED, source UNINDEXED
      );

      CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source);
    `);
  }

  private createVectorTable(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[128]
      );
    `);
  }

  private backfillVectorTable(): void {
    const rows = this.db
      .prepare("SELECT id, embedding FROM chunks")
      .all() as Array<{ id: string; embedding: string }>;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO chunks_vec (id, embedding)
       VALUES (?, ?)`,
    );
    const backfill = this.db.transaction(() => {
      for (const row of rows) {
        const embedding = JSON.parse(row.embedding) as number[];
        insert.run(row.id, Buffer.from(new Float32Array(embedding).buffer));
      }
    });
    backfill();
  }

  add(chunk: Chunk, embedding: number[]): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chunks
      (id, text, source, chunk_index, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.id,
        chunk.text,
        chunk.source,
        chunk.index,
        JSON.stringify(embedding),
        now,
      );

    if (this.vectorExtensionAvailable) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO chunks_vec (id, embedding)
        VALUES (?, ?)`,
        )
        .run(chunk.id, Buffer.from(new Float32Array(embedding).buffer));
    }

    this.db.prepare("DELETE FROM chunks_fts WHERE id = ?").run(chunk.id);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)`,
      )
      .run(chunk.id, chunk.text, chunk.source);
  }

  addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
    const tx = this.db.transaction(() => {
      for (const { chunk, embedding } of items) this.add(chunk, embedding);
    });
    tx();
  }

  documentHash(source: string): string | undefined {
    const row = this.db
      .prepare("SELECT content_hash FROM documents WHERE source = ?")
      .get(source) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  countSource(source: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = ?")
      .get(source) as { n: number };
    return row.n;
  }

  replaceSource(
    source: string,
    items: Array<{ chunk: Chunk; embedding: number[] }>,
    contentHash: string,
  ): void {
    const replace = this.db.transaction(() => {
      if (this.vectorExtensionAvailable) {
        const oldIds = this.db
          .prepare("SELECT id FROM chunks WHERE source = ?")
          .all(source) as Array<{ id: string }>;
        const deleteVector = this.db.prepare(
          "DELETE FROM chunks_vec WHERE id = ?",
        );
        for (const { id } of oldIds) deleteVector.run(id);
      }
      this.db.prepare("DELETE FROM chunks_fts WHERE source = ?").run(source);
      this.db.prepare("DELETE FROM chunks WHERE source = ?").run(source);

      for (const { chunk, embedding } of items) this.add(chunk, embedding);

      this.db
        .prepare(
          `INSERT OR REPLACE INTO documents (source, content_hash, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(source, contentHash, Date.now());
    });
    replace();
  }

  vectorSearch(
    queryEmbedding: number[],
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    if (!this.vectorExtensionAvailable) {
      return this.vectorSearchWithCosine(queryEmbedding, topK);
    }

    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
    try {
      const rows = this.db
        .prepare(
          `
        SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding, c.updated_at
        FROM chunks_vec v
        JOIN chunks c ON c.id = v.id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `,
        )
        .all(buf, topK) as Array<ChunkRow & { distance: number }>;

      return rows.map((r) => ({
        chunk: {
          id: r.id,
          text: r.text,
          source: r.source,
          index: r.chunk_index,
          tokenEstimate: Math.ceil(r.text.length / 4),
          embedding: JSON.parse(r.embedding),
          addedAt: r.updated_at,
        },
        score: 1 - r.distance,
      }));
    } catch {
      return this.vectorSearchWithCosine(queryEmbedding, topK);
    }
  }

  private vectorSearchWithCosine(
    queryEmbedding: number[],
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, text, source, chunk_index, embedding, updated_at
         FROM chunks`,
      )
      .all() as ChunkRow[];

    return rows
      .map((r) => {
        const embedding = JSON.parse(r.embedding) as number[];
        return {
          chunk: {
            id: r.id,
            text: r.text,
            source: r.source,
            index: r.chunk_index,
            tokenEstimate: Math.ceil(r.text.length / 4),
            embedding,
            addedAt: r.updated_at,
          },
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  keywordSearch(
    query: string,
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === null) return [];

    let rows: Array<Omit<ChunkRow, "updated_at"> & { rank: number }>;
    try {
      rows = this.db
        .prepare(
          `
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
        )
        .all(ftsQuery, topK) as typeof rows;
    } catch {
      return [];
    }

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        addedAt: 0,
      },
      score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
    }));
  }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as {
      n: number;
    };
    return row.n;
  }

  clear(): void {
    this.db.exec(
      "DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM documents;",
    );
    if (this.vectorExtensionAvailable) {
      this.db.exec("DELETE FROM chunks_vec;");
    }
  }

  sources(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT source FROM chunks")
      .all() as Array<{ source: string }>;
    return rows.map(({ source }) => source);
  }

  close(): void {
    this.db.close();
  }

  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    const candidateCount = Math.min(topK * 4, this.size());
    if (candidateCount === 0) return [];

    const [queryVec] = await embed(embedFn, [query]);
    if (queryVec === undefined) {
      throw new Error("Missing query embedding");
    }

    const vectorResults = this.vectorSearch(queryVec, candidateCount);

    const keywordResults = this.keywordSearch(query, candidateCount);

    const vecScores = normalizeMinMax(vectorResults.map((r) => r.score));
    const kwScores = normalizeMinMax(keywordResults.map((r) => r.score));

    const candidates = new Map<string, SearchResult>();
    for (const [i, result] of vectorResults.entries()) {
      const vectorScore = vecScores[i];
      if (vectorScore === undefined) continue;

      const id = result.chunk.id;
      candidates.set(id, {
        chunk: result.chunk,
        score: vectorScore * 0.7,
        vectorScore,
        keywordScore: 0,
      });
    }
    for (const [i, result] of keywordResults.entries()) {
      const keywordScore = kwScores[i];
      if (keywordScore === undefined) continue;

      const id = result.chunk.id;
      const existing = candidates.get(id);
      if (existing) {
        existing.keywordScore = keywordScore;
        existing.score += keywordScore * 0.3;
      } else {
        candidates.set(id, {
          chunk: result.chunk,
          score: keywordScore * 0.3,
          vectorScore: 0,
          keywordScore,
        });
      }
    }

    const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

    return mmrSelect(sorted, topK);
  }
}

function buildFtsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu);
  if (terms === null || terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
}

function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map((s) => (s - min) / range);
}
