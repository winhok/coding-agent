import type { CommandHandler } from "./index.js";

export const memoryCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== "/memory" && cmd !== "memory") return false;
    const entries = ctx.memoryStore.list();
    const reports = ctx.memoryStore.lint();
    console.log(
      `\n[记忆系统] 共 ${entries.length} 条记忆，${reports.length} 条有警告`,
    );
    for (const entry of entries) {
      const hasIssue = reports.some(
        (report) => report.entry.filePath === entry.filePath,
      );
      const flag = hasIssue ? "⚠️ " : "   ";
      console.log(
        `${flag} [${entry.type}] ${entry.name} — ${entry.description}`,
      );
    }
    console.log("");
    return true;
  },

  (cmd, ctx) => {
    if (cmd !== "/lint" && cmd !== "lint") return false;
    const reports = ctx.memoryStore.lint();
    if (reports.length === 0) {
      console.log("\n[lint] 记忆库健康，没有发现问题。\n");
      return true;
    }

    console.log(`\n[lint] 记忆库 ${reports.length} 条有警告：`);
    for (const report of reports) {
      console.log(
        `  📁 ${report.entry.filePath.split(/[\\/]/).pop()}  [${report.entry.type}] ${report.entry.name}`,
      );
      for (const issue of report.issues) {
        console.log(`     • ${issue.kind}: ${issue.message}`);
      }
    }
    console.log("");
    return true;
  },

  (cmd, ctx) => {
    const match = cmd.match(/^(?:\/memory search|搜记忆)(?:\s+(.+))?$/);
    if (!match) return false;
    const query = match[1]?.trim();
    if (!query) {
      console.log("\n用法：/memory search <关键词>\n");
      return true;
    }
    const results = ctx.memoryStore.search(query, 5);
    console.log(`\n[BM25 搜索] "${query}" → ${results.length} 条结果：`);
    for (const hit of results) {
      console.log(
        `  [score=${hit.score.toFixed(2)}] [${hit.entry.type}] ${hit.entry.name} — ${hit.entry.description}`,
      );
    }
    console.log("");
    return true;
  },
];
