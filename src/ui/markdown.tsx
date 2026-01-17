import dedent from "dedent";
import { Text } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { ReactNode } from "react";

// biome-ignore lint/suspicious/noExplicitAny: <expected>
marked.use(markedTerminal() as any);

type MarkdownProps = { children: string; isStreaming: boolean };

export function Markdown({ children, isStreaming }: MarkdownProps): ReactNode {
  const text = marked.parse(dedent(children));
  return <Text dimColor={isStreaming}>{text}</Text>;
}
