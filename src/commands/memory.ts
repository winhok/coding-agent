import type { CommandHandler } from "./index.js";

export const memoryCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== "/memory") return false;
    const entries = ctx.memoryStore.list();
    console.log(`\n[记忆系统] 共 ${entries.length} 条记忆`);
    for (const e of entries)
      console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log("");
    return true;
  },

  (cmd, ctx) => {
    const match = cmd.match(/^\/memory search(?:\s+(.+))?$/);
    if (!match) return false;
    const query = match[1]?.trim();
    if (!query) {
      console.log("\n用法：/memory search <关键词>\n");
      return true;
    }
    const results = ctx.memoryStore.search(query);
    console.log(`\n[记忆搜索] "${query}" → ${results.length} 条结果`);
    for (const e of results)
      console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log("");
    return true;
  },
];
