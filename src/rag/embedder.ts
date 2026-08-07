const DIMS = 128;

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
  return async (texts: string[]) => {
    const resp = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-v3",
          input: texts,
          dimensions: DIMS,
        }),
      },
    );
    if (!resp.ok) {
      throw new Error(
        `Embedding API error: ${resp.status} ${await resp.text()}`,
      );
    }
    const data = (await resp.json()) as any;
    return data.data.map((d: any) => d.embedding as number[]);
  };
}

const embedCache = new Map<string, number[]>();

export async function embed(
  fn: EmbeddingFn,
  texts: string[],
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  const uncached: { idx: number; text: string }[] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (text === undefined) continue;

    const cached = embedCache.get(text);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ idx: i, text });
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(uncached.map((u) => u.text));
    for (const [i, item] of uncached.entries()) {
      const vector = vectors[i];
      if (vector === undefined) {
        throw new Error(`Missing embedding at index ${i}`);
      }

      results[item.idx] = vector;
      embedCache.set(item.text, vector);
    }
  }

  return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: ${a.length} !== ${b.length}`,
    );
  }

  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    const aValue = a[i];
    const bValue = b[i];
    if (aValue === undefined || bValue === undefined) continue;

    dot += aValue * bValue;
    normA += aValue * aValue;
    normB += bValue * bValue;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export { DIMS };
