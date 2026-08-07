import type { CommandHandler } from "./index.js";

export const ragCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== "/rag" && cmd !== "rag") return false;
    const vs = ctx.vectorStore;
    if (!vs) return false;
    console.log(`\n[知识库] ${vs.size()} 个片段`);
    const sources = vs.sources();
    if (sources.length > 0) console.log(`  来源: ${sources.join(", ")}`);
    console.log("");
    return true;
  },

  (cmd, ctx) => {
    if (!cmd.startsWith("/ingest ")) return false;
    const path = cmd.slice("/ingest ".length).trim();
    console.log(`\n[导入] 正在处理 ${path}...`);
    const ragIngestTool = ctx.registry
      .getActiveTools()
      .find((tool) => tool.name === "rag_ingest");
    if (!ragIngestTool) {
      console.log("  RAG 导入工具未启用\n");
      return true;
    }
    ragIngestTool.execute({ path }).then((result) => {
      console.log(`  ${result}\n`);
      ctx.ask();
    });
    return "async";
  },
];
