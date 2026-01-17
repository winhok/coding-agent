import type { ModelMessage } from "ai";
import { agent } from "../agent.ts";
import { uiStore } from "../ui/ui.store.ts";

type ToolRequest = { toolName: string; args?: string; reason?: string };

class AgentService {
  private abortController?: AbortController;

  generateStream(messages: ModelMessage[]) {
    this.abortController = new AbortController();
    return agent.stream({ messages, abortSignal: this.abortController.signal });
  }

  abort(reason?: string): void {
    this.abortController?.abort(reason);
  }

  async requestTool({ toolName, args, reason }: ToolRequest): Promise<boolean> {
    try {
      return await new Promise<boolean>((resolve) => {
        uiStore.approval = {
          toolName,
          resolve,
          ...(args !== undefined && { args }),
          ...(reason !== undefined && { reason }),
        };
      });
    } finally {
      uiStore.approval = undefined;
    }
  }
}

export const agentService = new AgentService();
