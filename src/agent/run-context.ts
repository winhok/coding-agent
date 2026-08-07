import { resolve } from "node:path";
import { TodoManager } from "../tools/todo_manager.ts";

export interface AgentRunContext {
  workingDir: string;
  todoManager: TodoManager;
}

export function createAgentRunContext(workingDir: string): AgentRunContext {
  return { workingDir: resolve(workingDir), todoManager: new TodoManager() };
}
