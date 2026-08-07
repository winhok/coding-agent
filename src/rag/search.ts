import type { Chunk } from "./chunker.js";

export interface StoredChunk extends Chunk {
  embedding: number[];
  addedAt: number;
}

export interface SearchResult {
  chunk: StoredChunk;
  score: number;
  vectorScore: number;
  keywordScore: number;
}

const MMR_LAMBDA = 0.7;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function mmrSelect(
  results: SearchResult[],
  topK: number,
): SearchResult[] {
  if (topK <= 0 || results.length === 0) return [];
  if (results.length <= topK) return results;

  const first = results[0];
  if (first === undefined) return [];

  const selected: SearchResult[] = [first];
  const remaining = results.slice(1);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if (candidate === undefined) continue;

      const relevance = candidate.score;
      const maxSim = Math.max(
        ...selected.map((s) =>
          jaccardSimilarity(s.chunk.text, candidate.chunk.text),
        ),
      );
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    const [best] = remaining.splice(bestIdx, 1);
    if (best === undefined) break;
    selected.push(best);
  }

  return selected;
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
