import type { MemoryStore } from "../memory/store.js";
import type { SqliteVectorStore } from "../rag/sqlite-store.js";
import type { PromptPipe } from "./prompt-builder.js";

export function repositoryRules(rules: string | undefined): PromptPipe {
  return {
    name: "projectRules",
    surface: "system",
    render: () => rules || null,
  };
}

export function memoryContext(memoryStore: MemoryStore): PromptPipe {
  return {
    name: "memoryContext",
    surface: "runtime",
    render: (ctx) => memoryStore.buildPromptSection(ctx.toolView.has("memory")),
  };
}

export function ragContext(vectorStore: SqliteVectorStore): PromptPipe {
  return {
    name: "ragContext",
    surface: "runtime",
    requiresTools: ["rag_search"],
    render: () => {
      const size = vectorStore.size();
      if (size === 0) return null;
      const sources = vectorStore.sources();
      return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(", ")}）。使用 rag_search 工具搜索知识库。`;
    },
  };
}
