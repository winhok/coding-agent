import { createHash } from "node:crypto";
import fs from "node:fs";
import { chunkDocument } from "./chunker.js";
import { type EmbeddingFn, embed } from "./embedder.js";
import type { SqliteVectorStore } from "./sqlite-store.js";

export interface IngestResult {
  source: string;
  status: "imported" | "skipped";
  chunks: number;
}

export interface ImportSummary {
  imported: IngestResult[];
  skipped: IngestResult[];
  failed: Array<{ source: string; error: string }>;
}

export async function ingestDocument(
  source: string,
  vectorStore: SqliteVectorStore,
  embedFn: EmbeddingFn,
): Promise<IngestResult> {
  const text = fs.readFileSync(source, "utf-8");
  const contentHash = createHash("sha256").update(text).digest("hex");
  if (vectorStore.documentHash(source) === contentHash) {
    return {
      source,
      status: "skipped",
      chunks: vectorStore.countSource(source),
    };
  }

  const chunks = chunkDocument(source, text);
  const embeddings = await embed(
    embedFn,
    chunks.map((chunk) => chunk.text),
  );
  const items = chunks.map((chunk, index) => {
    const embedding = embeddings[index];
    if (embedding === undefined) {
      throw new Error(`Missing embedding for ${chunk.id}`);
    }
    return { chunk, embedding };
  });

  vectorStore.replaceSource(source, items, contentHash);
  return { source, status: "imported", chunks: chunks.length };
}

export async function importDocuments(
  sources: string[],
  vectorStore: SqliteVectorStore,
  embedFn: EmbeddingFn,
): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: [], skipped: [], failed: [] };
  for (const source of sources) {
    try {
      const result = await ingestDocument(source, vectorStore, embedFn);
      summary[result.status].push(result);
    } catch (error) {
      summary.failed.push({
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
