import { writeFile } from "node:fs/promises";

import { tool } from "ai";
import z from "zod";

export const writeFileToolInputSchema = z.object({
  filePath: z
    .string()
    .describe(
      "The path to the file to write, e.g. 'output.txt' or './src/config.ts'",
    ),
  content: z.string().describe("The content to write to the file."),
  reason: z.string().describe("The reason for writing the file."),
});

export const write_file = tool({
  description:
    "Write content to a file at the specified path. Creates the file if it doesn't exist, overwrites if it does.",
  inputSchema: writeFileToolInputSchema,
  execute: async ({ filePath, content }): Promise<string> => {
    try {
      await writeFile(filePath, content, "utf8");
      return `Successfully wrote to ${filePath}`;
    } catch (error) {
      return `Error writing file: ${error}`;
    }
  },
});
