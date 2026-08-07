import type { MemoryEntry } from "./store.js";

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
}

/**
 * 简单的中英文分词：
 * - 英文 / 数字按非字母数字分隔
 * - 中文按字切分（记忆条目通常很短，这里够用）
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let buffer = "";

  for (const char of lower) {
    if (/[a-z0-9_]/.test(char)) {
      buffer += char;
    } else if (/[一-龥]/.test(char)) {
      if (buffer) {
        tokens.push(buffer);
        buffer = "";
      }
      tokens.push(char);
    } else if (buffer) {
      tokens.push(buffer);
      buffer = "";
    }
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

const K1 = 1.5;
const B = 0.75;

export function bm25Search(
  entries: MemoryEntry[],
  query: string,
  topK = 5,
): SearchHit[] {
  if (entries.length === 0 || !query.trim()) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const docs = entries.map((entry) =>
    tokenize(
      `${entry.name} ${entry.name} ${entry.name} ${entry.description} ${entry.description} ${entry.content}`,
    ),
  );
  const averageDocumentLength =
    docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;

  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const hits: SearchHit[] = [];
  for (const [index, entry] of entries.entries()) {
    const doc = docs[index];
    if (!doc) continue;

    let score = 0;
    for (const queryToken of queryTokens) {
      const frequency = documentFrequency.get(queryToken) ?? 0;
      if (frequency === 0) continue;

      const termFrequency = doc.filter((token) => token === queryToken).length;
      if (termFrequency === 0) continue;

      const inverseDocumentFrequency = Math.log(
        (docs.length - frequency + 0.5) / (frequency + 0.5) + 1,
      );
      const normalizedFrequency =
        (termFrequency * (K1 + 1)) /
        (termFrequency +
          K1 * (1 - B + (B * doc.length) / Math.max(averageDocumentLength, 1)));
      score += inverseDocumentFrequency * normalizedFrequency;
    }
    if (score > 0) hits.push({ entry, score });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}
