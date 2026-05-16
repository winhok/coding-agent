import { getCurrentTimeTool } from "./get_current_time.tool.ts";
import { listDirectoryTool } from "./list_directory.tool.ts";
import { readFileTool } from "./read_file.tool.ts";
import type { ToolDefinition } from "./registry";
import { writeFileTool } from "./write_file.tool.ts";

export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  getCurrentTimeTool,
];
