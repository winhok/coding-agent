import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "coding-agent-eval-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function mockUsage(inputTokens = 1, outputTokens = 1) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

export function mockTextResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

export function mockToolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = `${toolName}-call`,
) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

export async function withMutedConsole<T>(
  fn: () => Promise<T> | T,
): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}
