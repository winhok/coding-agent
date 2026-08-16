import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "../context/view.js";
import type { CommandHandler } from "./index.js";

export const contextCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== "/context") return false;
    const assembly = ctx.builder.assemble(ctx.makePromptCtx());
    const conversationMessages = ctx.messages.filter(
      (message) => !promptSnapshotSurface(message),
    );
    const snapshot = buildContextSnapshot({
      modelName: ctx.modelName,
      modelId: ctx.modelId,
      windowTokens: ctx.contextWindowTokens,
      effectiveWindowTokens: ctx.effectiveContextWindowTokens,
      autocompactThresholdTokens: ctx.autocompactThresholdTokens,
      systemPromptChars: assembly.system.length,
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
      workspacePromptChars: promptSnapshotChars(ctx.messages, "workspace"),
      runtimePromptChars: promptSnapshotChars(ctx.messages, "runtime"),
      messages: conversationMessages,
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

function promptSnapshotSurface(
  message: import("ai").ModelMessage,
): "workspace" | "runtime" | undefined {
  if (typeof message.content !== "string") return undefined;
  const match = message.content.match(
    /^<prompt-snapshot surface="(workspace|runtime)"/,
  );
  return match?.[1] as "workspace" | "runtime" | undefined;
}

function promptSnapshotChars(
  messages: import("ai").ModelMessage[],
  surface: "workspace" | "runtime",
): number {
  return messages.reduce(
    (total, message) =>
      promptSnapshotSurface(message) === surface &&
      typeof message.content === "string"
        ? total + message.content.length
        : total,
    0,
  );
}
