import { renderPromptSections } from "../context/prompt-builder.js";
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "../context/view.js";
import type { CommandHandler } from "./index.js";

export const contextCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== "/context") return false;
    const sections = ctx.builder.buildSections(ctx.makePromptCtx());
    const system = renderPromptSections(sections);
    const memoryChars = sectionChars(sections, "memoryContext");
    const ragChars = sectionChars(sections, "ragContext");
    const skillsChars = sectionChars(sections, "skillContext");
    const snapshot = buildContextSnapshot({
      modelName: ctx.modelName,
      modelId: ctx.modelId,
      windowTokens: ctx.contextWindowTokens,
      effectiveWindowTokens: ctx.effectiveContextWindowTokens,
      autocompactThresholdTokens: ctx.autocompactThresholdTokens,
      systemPromptChars: Math.max(
        0,
        system.length - memoryChars - ragChars - skillsChars,
      ),
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
      ragChars,
      skillsChars,
      messages: ctx.messages,
      tokenMeasurement: ctx.tokenMeasurement,
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

function sectionChars(
  sections: Array<{ name: string; text: string }>,
  name: string,
): number {
  return sections
    .filter((section) => section.name === name)
    .reduce((total, section) => total + section.text.length, 0);
}
