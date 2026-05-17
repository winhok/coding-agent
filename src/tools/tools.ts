import { bashTool } from "./bash.tool.ts";
import { createTodosTool } from "./create_todos.tool.ts";
import { editFileTool } from "./edit_file.tool.ts";
import { getCurrentTimeTool } from "./get_current_time.tool.ts";
import { gitDiffTool } from "./git_diff.tool.ts";
import { gitStatusTool } from "./git_status.tool.ts";
import { globTool } from "./glob.tool.ts";
import { grepTool } from "./grep.tool.ts";
import { listDirectoryTool } from "./list_directory.tool.ts";
import { readFileTool } from "./read_file.tool.ts";
import type { ToolDefinition } from "./registry";
import { updateTodoTool } from "./update_todo.tool.ts";
import { writeFileTool } from "./write_file.tool.ts";

export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  getCurrentTimeTool,
  bashTool,
  grepTool,
  globTool,
  editFileTool,
  gitStatusTool,
  gitDiffTool,
  createTodosTool,
  updateTodoTool,
];
