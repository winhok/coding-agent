import { Badge, Spinner } from "@inkjs/ui";
import type { UIMessage } from "ai";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { useSnapshot } from "valtio";
import { Approval } from "./approval.tsx";
import { Markdown } from "./markdown.tsx";
import { boxStyles, theme } from "./theme.ts";
import { uiStore } from "./ui.store.ts";

type MessageProps = { message: UIMessage };

type ToolCallProps = { type: string; input: unknown; output: unknown };

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function formatValue(value: unknown, maxLength: number): string {
  const str = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return truncate(str, maxLength);
}

function UserMessage({ message }: MessageProps): ReactNode {
  return (
    <Box justifyContent="flex-end" paddingRight={2}>
      <Box
        borderStyle={boxStyles.message}
        borderColor={theme.user.border}
        paddingX={2}
        paddingY={1}
        flexDirection="row"
        gap={2}
      >
        <Text>
          {message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")}
        </Text>
        <Badge color={theme.user.badge}>YOU</Badge>
      </Box>
    </Box>
  );
}

function ToolCall({ type, input, output }: ToolCallProps): ReactNode {
  const inputStr = formatValue(input, 60);
  const outputStr = formatValue(output, 80);

  return (
    <Box
      flexDirection="column"
      borderStyle={boxStyles.tool}
      borderColor={theme.tool.border}
      paddingX={1}
      marginY={1}
    >
      <Box gap={1}>
        <Text color={theme.tool.name} bold>
          ⚡ {type}
        </Text>
      </Box>
      {inputStr && inputStr !== "{}" && (
        <Box paddingLeft={2}>
          <Text color={theme.tool.input} dimColor>
            › {inputStr}
          </Text>
        </Box>
      )}
      {outputStr && (
        <Box paddingLeft={2}>
          <Text color={theme.tool.output}>✓ {outputStr}</Text>
        </Box>
      )}
    </Box>
  );
}

function renderMessagePart(
  part: UIMessage["parts"][number],
  index: number,
): ReactNode {
  if (part.type === "text" && part.text.trim()) {
    const isStreaming = part.state === "streaming";
    return (
      <Markdown key={index.toString()} isStreaming={isStreaming}>
        {part.text}
      </Markdown>
    );
  }
  if ("toolCallId" in part) {
    return (
      <ToolCall
        key={index.toString()}
        type={part.type}
        input={part.input}
        output={part.output}
      />
    );
  }
  return null;
}

function AIMessage({ message }: MessageProps): ReactNode {
  return (
    <Box paddingX={2} flexDirection="column">
      <Box gap={2} marginBottom={1}>
        <Badge color={theme.ai.badge}>AI</Badge>
        <Text dimColor>───────────────────</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={4} gap={1}>
        {message.parts.map(renderMessagePart).filter(Boolean)}
      </Box>
    </Box>
  );
}

export function AIThinking(): ReactNode {
  return (
    <Box gap={2} paddingX={2}>
      <Badge color={theme.ai.badge}>AI</Badge>
      <Spinner label="Thinking..." type="dots" />
    </Box>
  );
}

function renderMessage(message: UIMessage): ReactNode {
  if (message.role === "user") {
    return <UserMessage key={message.id} message={message} />;
  }
  return <AIMessage key={message.id} message={message} />;
}

export function Messages(): ReactNode {
  const snap = useSnapshot(uiStore);
  const messages = snap.messages as unknown as UIMessage[];

  return (
    <Box flexDirection="column" flexGrow={1} gap={2}>
      {messages.map(renderMessage)}
      {snap.isThinking && <AIThinking />}
      {snap.approval && <Approval />}
    </Box>
  );
}
