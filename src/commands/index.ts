import type { LanguageModel, ModelMessage } from "ai";
import type { TokenMeasurement } from "../context/defense.js";
import type {
  PromptBuilder,
  PromptContext,
} from "../context/prompt-builder.js";
import type { MemoryStore } from "../memory/store.js";
import type { SqliteVectorStore } from "../rag/sqlite-store.js";
import type { SessionStore } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { UsageTracker } from "../usage/tracker.js";

export interface CommandContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  sessionStore: SessionStore;
  model: LanguageModel;
  makePromptCtx: () => PromptContext;
  ask: () => void;
  replaceMessages: (messages: ModelMessage[]) => void;
  memoryStore: MemoryStore;
  vectorStore?: SqliteVectorStore;
  modelName: string;
  modelId: string;
  contextWindowTokens: number;
  effectiveContextWindowTokens: number;
  autocompactThresholdTokens: number;
  estimatedContextTokens: number;
  tokenMeasurement: TokenMeasurement;
}

export type CommandHandler = (
  cmd: string,
  ctx: CommandContext,
) => boolean | "async";

export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx);
      if (result) return result;
    }
    return false;
  };
}
