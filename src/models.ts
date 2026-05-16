/**
 * 模型接入层。
 *
 * 这里负责：
 *   1. 把内部消息格式（src/types.ts 里的 Message / ToolCall）翻译成
 *      模型 API 真正接受的格式；
 *   2. 把 API 的返回结果归一化回内部的 ModelResponse。
 *
 * 设计原则：模型 API 的具体格式只在本文件里出现，其它模块（agent.ts、
 * 工具实现、UI 等）始终只认 src/types.ts 里的内部类型，不直接依赖
 * OpenAI / Anthropic 任意一家的 SDK 类型。
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import "dotenv/config";

import OpenAI from "openai";
import type { Message, ModelResponse, Tool, ToolCall } from "./types";

const anthropic = createAnthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || "",
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

export const claude_opus_4_5_20251101: LanguageModel = anthropic(
  "claude-opus-4-5-20251101",
);

/**
 * 基于 OpenAI SDK 的模型客户端封装。
 *
 * 选择 OpenAI SDK 作为底座，是因为「OpenAI Chat Completions」格式
 * 已经事实上成为业界通用接口——智谱 GLM、DeepSeek、Moonshot、
 * Together、Groq、本地 vLLM 等绝大多数提供商都兼容。只要传入对应的
 * baseURL + apiKey，就能切换提供商，无需为每家单独写适配层。
 *
 * 构造参数：
 * - apiKey:  必填，提供商的密钥
 * - baseURL: 可选，自定义网关 / 第三方兼容服务的入口
 * - model:   可选，模型名（默认 gpt-4o）
 */
export class Model {
  private client: OpenAI;
  private model: string;

  constructor(options: { apiKey: string; baseURL?: string; model?: string }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    this.model = options.model ?? "gpt-4o";
  }

  /**
   * 发起一次模型调用。
   *
   * 流程：
   *   内部 Message[]  ──toOpenAIMessage──▶  OpenAI 请求体
   *                                                │
   *                                                ▼
   *                                         API 返回 choice
   *                                                │
   *           ◀───────  归一化为 ModelResponse  ──┘
   *
   * 工具定义也会被转成 OpenAI 的 `{ type: "function", function: {...} }`
   * 形态。注意我们的 Tool.parameters 已经是 JSON Schema，所以这里
   * 直接透传，零转换成本（呼应 types.ts 里关于 parameters 的设计决策）。
   */
  async chat(messages: Message[], tools?: Tool[]): Promise<ModelResponse> {
    const toolDefinitions: OpenAI.ChatCompletionTool[] = (tools ?? []).map(
      (t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }),
    );

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI chat completion returned no choices");
    }

    const content = choice.message.content ?? "";
    // OpenAI 把 arguments 以 JSON 字符串返回，这里在边界一次性 parse 掉，
    // 让上层（agent loop / 工具执行器）拿到的就是 Record<string, unknown>，
    // 不需要每个工具自己再处理字符串。
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap(
      (tc): ToolCall[] => {
        if (tc.type !== "function") {
          return [];
        }

        return [
          {
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments),
          },
        ];
      },
    );

    return {
      content,
      // 没有工具调用时省略字段，避免下游用 `if (resp.toolCalls)`
      // 时被空数组误判为「有工具调用」，也符合 exactOptionalPropertyTypes。
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

/**
 * 把内部 Message 翻译成 OpenAI ChatCompletionMessageParam。
 *
 * 这是「内部协议 ↔ 外部 API」的唯一桥梁，所有命名差异都收敛在这里。
 *
 * ─────────────────────────────────────────────
 *  关键差异：tool_result（内部） ↔ tool（OpenAI）
 * ─────────────────────────────────────────────
 * 我们故意让内部 role 叫 `tool_result` 而不是直接沿用 OpenAI 的 `tool`，
 * 出于两个考虑：
 *
 * 1. 语义更清晰。
 *    `tool_result` 一眼就知道是「工具执行后的结果」，比泛化的 `tool`
 *    更自描述。在读 agent loop 代码时，`switch (msg.role)` 中看到
 *    `case "tool_result":` 比 `case "tool":` 更容易理解这条消息的含义。
 *
 * 2. 解耦内部模型和外部 API。
 *    如果直接用 OpenAI 的 `tool` 作 role，所有模块都得跟着它的命名走。
 *    将来换成 Anthropic（用 `tool_use` / `tool_result` content block）
 *    或其它协议时，差异就会扩散到整个项目。
 *    现在只有这一个 `toOpenAIMessage` 函数需要懂 API 格式，其它模块
 *    都不关心——加新 provider 时也只是再写一个 toXxxMessage 而已。
 *
 * discriminated union + switch 在这里恰好提供了 exhaustiveness 保护：
 * 漏掉任何一种 role，TS 都会立刻报错（返回类型不匹配）。
 */
function toOpenAIMessage(msg: Message): OpenAI.ChatCompletionMessageParam {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content };
    case "user":
      return { role: "user", content: msg.content };
    case "assistant":
      return {
        role: "assistant",
        content: msg.content,
        // OpenAI 要求 tool_calls 字段「要么不存在、要么是非空数组」，
        // 所以用条件展开避免传一个空数组上去。
        // arguments 在内部是对象，发出去时再 stringify 成 JSON 字符串
        // （和上面 chat() 里 JSON.parse 是镜像操作）。
        ...(msg.toolCalls && msg.toolCalls.length > 0
          ? {
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            }
          : {}),
      };
    case "tool_result":
      // 注意：内部 role 叫 tool_result，OpenAI API 叫 tool。
      // 命名差异在这里完成转换，详细原因见函数顶部注释。
      return {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.result,
      };
  }
}
