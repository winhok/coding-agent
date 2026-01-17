import { tool } from "ai";
import z from "zod";

export const getCurrentTimeToolInputSchema = z.object({
  reason: z.string().describe("The reason for getting the current time."),
});

export const get_current_time = tool({
  description: "Return the system current time.",
  inputSchema: getCurrentTimeToolInputSchema,
  execute: async (): Promise<string> => {
    return new Date().toLocaleString();
  },
});
