import { tool } from "ai";
import z from "zod";

import { agentService } from "../services/agent.service.ts";

export const getCurrentTimeToolInputSchema = z.object({
  reason: z.string().describe("The reason for getting the current time."),
});

export const get_current_time = tool({
  description: "Return the system current time.",
  inputSchema: getCurrentTimeToolInputSchema,
  execute: async (): Promise<string> => {
    const approved = await agentService.requestTool({
      toolName: "get_current_time",
    });
    if (approved) {
      return new Date().toLocaleString();
    }
    return "User rejected the request.";
  },
});
