import type { ModelMessage } from "ai";
import type { StepUsage } from "../usage/tracker.js";

export type AgentLoopTermination = "completed" | "loop_detected" | "max_steps";

export interface AgentLoopStats {
  steps: number;
  toolCalls: number;
  retries: number;
  usage: StepUsage;
}

export interface AgentLoopResult {
  appendedMessages: ModelMessage[];
  text: string;
  termination: AgentLoopTermination;
  stats: AgentLoopStats;
}

export type AgentEvent =
  | { type: "run_started"; maxSteps: number }
  | { type: "step_started"; step: number }
  | { type: "text_delta"; step: number; text: string }
  | { type: "tool_started"; step: number; tool: string; input: unknown }
  | {
      type: "loop_detected";
      step: number;
      level: "warning" | "critical";
      message: string;
    }
  | { type: "tool_finished"; step: number; tool: string; output: string }
  | { type: "tool_failed"; step: number; tool: string; error: unknown }
  | {
      type: "retry_scheduled";
      step: number;
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: unknown;
    }
  | {
      type: "cache_usage";
      step: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      cost: number;
      currency: "USD" | "CNY";
    }
  | { type: "step_finished"; step: number; text: string; hasToolCall: boolean }
  | { type: "step_continuing"; step: number }
  | { type: "run_finished"; result: AgentLoopResult }
  | { type: "run_failed"; error: unknown };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
