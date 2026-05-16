/**
 * Agent 运行时核心类型定义。
 *
 * 这里手写了一套最小化的对话 / 工具调用抽象，
 * 思路接近 OpenAI / Anthropic 早期 function-calling 协议。
 */

/**
 * 一条对话消息（discriminated union，按 role 区分形态）。
 *
 * - system:      系统提示，给模型设定身份/规则
 * - user:        用户输入
 * - assistant:   模型回复，可附带本轮要发起的工具调用
 * - tool_result: 工具执行结果，需通过 toolCallId 关联到对应的 assistant.toolCalls[i]
 *
 * 设计决策：为什么用联合类型而不是一个统一对象？
 * 因为不同角色的消息结构本质上不同：assistant 消息可能带 toolCalls，
 * tool_result 消息需要 toolCallId 来和原始工具调用对应。
 * 联合类型让每条消息的结构更精确，TypeScript 会在 switch (msg.role)
 * 之类的使用点自动帮你做类型收窄，避免出现"宽对象 + 一堆可选字段"
 * 那种运行时容易漏判的写法。
 */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      /** 本轮模型决定发起的工具调用（可能为空） */
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool_result";
      /** 关联到 assistant 消息中的某个 ToolCall.id */
      toolCallId: string;
      /** 工具执行后的字符串化结果 */
      result: string;
    };

/** 一次工具调用请求。 */
export interface ToolCall {
  /** 唯一 ID，用于把后续的 tool_result 回链到这次调用 */
  id: string;
  /** 工具名，必须能在工具注册表中找到 */
  name: string;
  /** 调用参数，结构由各工具自身的 schema 决定 */
  arguments: Record<string, unknown>;
}

/** Agent 的运行时上下文：贯穿整个任务循环。 */
export interface AgentState {
  /** 完整对话历史，作为下一次调用模型的输入 */
  messages: Message[];
  /** 当前任务的描述（一次会话级别的目标） */
  task: string;
  /** 工具执行时使用的工作目录 */
  workingDir: string;
}

/** 一个可被 Agent 调用的工具的完整描述。 */
export interface Tool {
  name: string;
  description: string;
  /**
   * JSON-Schema 风格的参数定义，用于发给模型做 function-calling。
   *
   * 设计决策：为什么是手写的 JSON Schema 而不是 class / 装饰器？
   * 因为 parameters 最终要原样发给模型 API（OpenAI / Anthropic 等
   * function-calling 协议接受的就是 JSON Schema 格式）。
   * 用 class 或 TS 装饰器反而需要一层运行时反射 / 转换，
   * 直接写 JSON Schema 是「最短路径」，零转换成本。
   */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  /**
   * 工具实际执行体；返回字符串结果，由调用方包装为 tool_result 消息。
   *
   * 设计决策：为什么 execute 要接收 state 参数？
   * 因为很多工具需要知道当前运行上下文，最典型的是工作目录
   * （比如搜索工具要在 state.workingDir 下执行 rg、读文件工具要
   * 解析相对路径）。把 state 作为参数显式注入，而不是让工具自己
   * 去访问全局 / 单例，可以保持工具的无状态性：
   *   - 单元测试时直接构造一个 state 传进去即可
   *   - 多 Agent 实例并发不会互相串状态
   *   - 后续做沙箱 / 路径权限隔离也有现成的传递通道
   */
  execute: (
    args: Record<string, unknown>,
    state: AgentState,
  ) => Promise<string>;
}

/** 模型一次回复的归一化结果。 */
export interface ModelResponse {
  /** 模型的文本输出 */
  content: string;
  /** 模型本轮决定发起的工具调用（如果有） */
  toolCalls?: ToolCall[];
}
