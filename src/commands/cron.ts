import type { CronService } from "../cron/service.js";
import type { CommandHandler } from "./index.js";

export function createCronCommands(cronService: CronService): CommandHandler[] {
  const handler: CommandHandler = (cmd) => {
    if (!cmd.startsWith("/cron")) return false;

    const sub = cmd.slice(5).trim();

    if (!sub || sub === "list") {
      const jobs = cronService.list();
      if (jobs.length === 0) {
        console.log("  暂无定时任务");
      } else {
        console.log(`  定时任务 (${jobs.length}):`);
        for (const job of jobs) {
          const icon =
            job.status === "running"
              ? "⟳"
              : job.status === "scheduled"
                ? "◉"
                : job.status === "disabled"
                  ? "○"
                  : "·";
          console.log(
            `    ${icon} ${job.config.id} — ${job.config.name} [${job.config.schedule}] (${job.status})`,
          );
        }
      }
      return true;
    }

    if (sub === "logs") {
      const logs = cronService.getRecentLogs(undefined, 10);
      if (logs.length === 0) {
        console.log("  暂无执行记录");
      } else {
        console.log("  最近执行记录:");
        for (const log of logs) {
          const icon = log.status === "success" ? "✓" : "✗";
          console.log(
            `    ${icon} ${log.jobId} @ ${log.startedAt} — ${log.output?.slice(0, 80) || log.error || ""}`,
          );
        }
      }
      return true;
    }

    console.log("  用法: /cron [list|logs]");
    return true;
  };

  return [handler];
}
