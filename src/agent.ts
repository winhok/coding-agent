import { ToolLoopAgent } from "ai";
import { claude_opus_4_5_20251101 } from "./models.ts";
import { tools } from "./tools/index.ts";

export const agent = new ToolLoopAgent({
  model: claude_opus_4_5_20251101,
  tools,
});
