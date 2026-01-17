import { TextInput } from "@inkjs/ui";
import {
  convertToModelMessages,
  createIdGenerator,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { useReducer } from "react";
import { agentService } from "../services/agent.service.ts";
import { boxStyles, theme } from "./theme.ts";
import { uiStore } from "./ui.store.ts";

export function UserInput(): ReactNode {
  const [key, forceUpdate] = useReducer((p) => p + 1, 0);

  async function handleSubmit(value: string) {
    forceUpdate();
    try {
      uiStore.isThinking = true;

      const userMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: value }],
      };

      uiStore.messages.push(userMessage);

      const result = await agentService.generateStream(
        await convertToModelMessages(uiStore.messages),
      );

      const uiMessageStream = readUIMessageStream({
        stream: result.toUIMessageStream({
          generateMessageId: createIdGenerator({
            prefix: "assistant",
            size: 16,
          }),
        }),
      });

      for await (const uiMessage of uiMessageStream) {
        const index = uiStore.messages.findIndex((m) => m.id === uiMessage.id);
        if (index > -1) {
          uiStore.messages[index] = uiMessage;
        } else {
          uiStore.messages.push(uiMessage);
        }
      }

      const { totalTokens } = await result.totalUsage;
      uiStore.totalUsedTokens = totalTokens ?? 0;
    } finally {
      uiStore.isThinking = false;
    }
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box
        borderStyle={boxStyles.input}
        borderColor={theme.input.border}
        paddingX={2}
        paddingY={1}
        flexDirection="row"
        gap={2}
      >
        <Text color={theme.primary}>❯</Text>
        <Box flexGrow={1}>
          <TextInput
            key={key}
            placeholder="Type your message..."
            onSubmit={handleSubmit}
          />
        </Box>
      </Box>
    </Box>
  );
}
