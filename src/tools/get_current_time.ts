import { tool } from "ai";
import z from "zod";

export const get_current_time = tool({
  description: "Retrun the system current time.",
  inputSchema: z.object({}),
  execute: async () => {
    return new Date().toLocaleString();
  },
});
