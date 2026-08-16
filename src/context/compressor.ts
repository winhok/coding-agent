import { generateText, type LanguageModel, type ModelMessage } from "ai";
import {
  isToolResultPart,
  textToolResultOutput,
  toolResultOutputToText,
} from "./tool-result-output.js";

function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") {
          chars += part.text.length;
        } else if ("output" in part) {
          chars += toolResultOutputToText(part.output).length;
        } else if ("input" in part) {
          chars +=
            String("toolName" in part ? part.toolName : "").length +
            String("toolCallId" in part ? part.toolCallId : "").length +
            JSON.stringify(part.input ?? {}).length;
        } else {
          chars += JSON.stringify(part).length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

const CLEARABLE_TOOLS = new Set([
  "read_file",
  "bash",
  "grep",
  "glob",
  "list_directory",
  "edit_file",
  "write_file",
]);
const KEEP_RECENT_TOOL_RESULTS = 3;

export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  let cleared = 0;
  const toolResultIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "tool") {
      toolResultIndices.push(i);
    }
  }

  const toClear = toolResultIndices.slice(
    0,
    Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS),
  );

  const result = messages.map((msg, idx) => {
    if (!toClear.includes(idx)) return msg;
    if (msg.role !== "tool") return msg;

    const toolName = msg.content.find(isToolResultPart)?.toolName ?? "unknown";
    if (!CLEARABLE_TOOLS.has(toolName)) return msg;

    cleared++;
    return {
      ...msg,
      content: msg.content.map((part) =>
        isToolResultPart(part)
          ? { ...part, output: textToolResultOutput("[tool result cleared]") }
          : part,
      ),
    };
  });

  return { messages: result, cleared };
}

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号、工具名、toolCallId 和参数等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 保留未完成操作、失败原因、用户约束和下一步，不要把计划误写成已完成`;

const CONTEXT_TOKEN_THRESHOLD = 300;
const KEEP_RECENT_MESSAGES = 6;

export interface SummarizeOptions {
  thresholdTokens?: number;
  keepRecentMessages?: number;
  maxOutputTokens?: number;
}

export interface CompactionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

export class CompactionCircuitBreaker {
  private failures = 0;

  constructor(readonly maxFailures = 3) {}

  get isOpen(): boolean {
    return this.failures >= this.maxFailures;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
  }
}

export function serializeMessageForCompaction(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((rawPart) => {
      const part = rawPart as unknown as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "tool-call") {
        return `[tool-call name=${String(part.toolName ?? "unknown")} toolCallId=${String(part.toolCallId ?? "unknown")}] ${JSON.stringify(part.input ?? {})}`;
      }
      if (part.type === "tool-result" && "output" in part) {
        return `[tool-result name=${String(part.toolName ?? "unknown")} toolCallId=${String(part.toolCallId ?? "unknown")}] ${toolResultOutputToText(part.output as Parameters<typeof toolResultOutputToText>[0])}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  existingSummary?: string,
  options: SummarizeOptions = {},
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokens(messages);
  const thresholdTokens = options.thresholdTokens ?? CONTEXT_TOKEN_THRESHOLD;
  const keepRecentMessages = options.keepRecentMessages ?? KEEP_RECENT_MESSAGES;
  const maxOutputTokens = options.maxOutputTokens ?? 4_000;
  if (
    tokenEstimate < thresholdTokens ||
    messages.length <= keepRecentMessages
  ) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  const splitIdx = Math.max(0, messages.length - keepRecentMessages);

  let alignedIdx = splitIdx;
  while (alignedIdx > 0 && messages[alignedIdx]?.role !== "user") {
    alignedIdx--;
  }
  if (alignedIdx === 0) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  const toCompress = messages.slice(0, alignedIdx);
  const toKeep = messages.slice(alignedIdx);

  const conversationText = toCompress
    .map((msg) => {
      const content = serializeMessageForCompaction(msg);
      return content ? `**${msg.role}**: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!conversationText.trim()) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText;

  const { text, finishReason } = await generateText({
    model,
    system: `${COMPRESS_PROMPT}\n- 摘要输出不得超过 ${maxOutputTokens} tokens`,
    prompt: userPrompt,
    maxOutputTokens,
  });
  if (finishReason !== "stop") {
    throw new Error(
      `Compaction ended with ${finishReason} before a complete summary was confirmed`,
    );
  }
  const summary = text.trim();
  if (!summary) throw new Error("Compaction returned an empty summary");

  const summaryMessage: ModelMessage = {
    role: "user",
    content: `<compacted-summary>\n${summary}\n</compacted-summary>`,
  };
  const newMessages: ModelMessage[] = [summaryMessage, ...toKeep];
  if (estimateTokens(newMessages) >= tokenEstimate) {
    throw new Error("Compaction made no token progress");
  }

  return { messages: newMessages, summary, compressedCount: toCompress.length };
}

export function pruneOldestContext(
  messages: ModelMessage[],
  targetTokens: number,
  existingSummary?: string,
): CompactionResult {
  let keepFrom = -1;
  for (let index = 1; index < messages.length; index++) {
    if (messages[index]?.role !== "user") continue;
    if (estimateTokens(messages.slice(index)) <= targetTokens) {
      keepFrom = index;
      break;
    }
  }
  if (keepFrom < 1) {
    return { messages, summary: existingSummary ?? "", compressedCount: 0 };
  }

  const summary = existingSummary?.trim()
    ? existingSummary
    : "较早的对话已从活动上下文中移除；完整记录仍保存在持久化会话历史中。";
  const marker: ModelMessage = {
    role: "user",
    content: `<compacted-summary kind="deterministic-prune">\n${summary}\n</compacted-summary>`,
  };
  return {
    messages: [marker, ...messages.slice(keepFrom)],
    summary,
    compressedCount: keepFrom,
  };
}

export { estimateTokens };
