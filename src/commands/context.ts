import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "../context/view.js";
import type { CommandHandler } from "./index.js";

export const contextCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== "/context") return false;
    const SYSTEM = ctx.builder.build(ctx.makePromptCtx());
    const memoryChars = ctx.memoryStore.buildPromptSection().length;
    const snapshot = buildContextSnapshot({
      modelName: ctx.modelName,
      modelId: ctx.modelId,
      windowTokens: ctx.contextWindowTokens,
      systemPromptChars: Math.max(0, SYSTEM.length - memoryChars),
      toolDescriptionChars: ctx.registry
        .getActiveTools()
        .reduce(
          (total, tool) =>
            total +
            JSON.stringify({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }).length,
          0,
        ),
      memoryChars,
      skillsChars: 0,
      messages: ctx.messages,
      autocompactBufferTokens:
        ctx.contextWindowTokens - ctx.autocompactThresholdTokens,
    });
    console.log(renderContextView(snapshot));
    return true;
  },

  (cmd, ctx) => {
    if (cmd !== "/usage") return false;
    console.log(renderUsageView(ctx.tracker));
    return true;
  },

  (cmd, ctx) => {
    if (cmd !== "/status") return false;
    const memCount = ctx.memoryStore.list().length;
    console.log(
      `\n[状态] ${ctx.messages.length} 条消息, ~${ctx.estimatedContextTokens} tokens, ${memCount} 条记忆\n`,
    );
    return true;
  },
];
