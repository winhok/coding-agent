import type { AgentEventSink } from "./events.js";

/** Terminal adapter for the typed events emitted by the core agent loop. */
export const terminalAgentEventSink: AgentEventSink = (event) => {
  switch (event.type) {
    case "run_started":
    case "run_failed":
      break;
    case "step_started":
      console.log(`\n--- Step ${event.step} ---`);
      break;
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_started":
      console.log(`  [调用: ${event.tool}(${JSON.stringify(event.input)})]`);
      break;
    case "loop_detected":
      console.log(`  ${event.message}`);
      break;
    case "tool_finished": {
      const preview =
        event.tool === "spawn_agent" || event.output.length <= 120
          ? event.output
          : `${event.output.slice(0, 120)}...`;
      console.log(`  [结果: ${event.tool}] ${preview}`);
      break;
    }
    case "tool_failed":
      console.log(
        `  [失败: ${event.tool}] ${event.error instanceof Error ? event.error.message : String(event.error)}`,
      );
      break;
    case "retry_scheduled":
      console.log(
        `  [重试] 第 ${event.attempt}/${event.maxRetries} 次，${event.delayMs}ms 后...`,
      );
      break;
    case "cache_usage": {
      const isHit = event.cacheReadTokens > 0;
      const tag = isHit
        ? "\x1b[38;5;36m✓ cache hit\x1b[0m"
        : "\x1b[38;5;220m✎ cache write\x1b[0m";
      const detail = isHit
        ? `read ${event.cacheReadTokens}`
        : `write ${event.cacheWriteTokens}`;
      const currency = event.currency === "CNY" ? "¥" : "$";
      console.log(
        `  [${tag}] ${detail} tokens · 本步 ${currency}${event.cost.toFixed(5)}`,
      );
      break;
    }
    case "step_finished":
      if (!event.hasToolCall && event.text) console.log();
      break;
    case "step_continuing":
      console.log("  → 继续下一步...");
      break;
    case "run_finished":
      if (event.result.termination === "loop_detected") {
        console.log("\n[循环检测触发，Agent 已停止]");
      } else if (event.result.termination === "max_steps") {
        console.log("\n[达到最大步数]");
      }
      break;
  }
};
