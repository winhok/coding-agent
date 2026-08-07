import type { SubAgentRegistry } from "../agents/registry.js";
import type { CommandHandler } from "./index.js";

export function createAgentCommands(
  agentRegistry: SubAgentRegistry,
): CommandHandler[] {
  const handler: CommandHandler = (command) => {
    if (!command.startsWith("/agents")) return false;

    const runs = agentRegistry.getAllRuns();
    if (runs.length === 0) {
      console.log("  暂无子 Agent 记录");
      return true;
    }

    const active = runs.filter((run) => run.status === "running");
    const completed = runs.filter((run) => run.status === "completed");
    const failed = runs.filter(
      (run) => run.status === "error" || run.status === "timeout",
    );

    console.log(`  子 Agent 记录 (${runs.length}):`);
    for (const run of runs) {
      const icon =
        run.status === "running" ? "⟳" : run.status === "completed" ? "✓" : "✗";
      const detail =
        run.status === "completed"
          ? `${run.result?.slice(0, 60)}...`
          : run.status === "running"
            ? "执行中..."
            : run.error;
      console.log(
        `    ${icon} ${run.id} [${run.profile}] (depth=${run.depth}) — ${run.task.slice(0, 40)}`,
      );
      console.log(`      ${detail}`);
      if (run.stats) {
        console.log(
          `      ${run.stats.steps} steps · ${run.stats.toolCalls} tools · ${run.stats.retries} retries`,
        );
      }
    }

    const config = agentRegistry.getConfig();
    console.log(
      `\n  活跃: ${active.length}/${config.maxConcurrent} | 完成: ${completed.length} | 失败: ${failed.length}`,
    );
    console.log(
      `  最大深度: ${config.maxSpawnDepth} | 最大并发: ${config.maxConcurrent}`,
    );
    return true;
  };

  return [handler];
}
