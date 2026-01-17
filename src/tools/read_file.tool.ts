import { readFile } from "node:fs/promises";

import { tool } from "ai";
import z from "zod";

export const readFileToolInputSchema = z.object({
  filePath: z
    .string()
    .describe(
      "The path to the file to read, e.g. 'package.json' or './src/index.ts'",
    ),
  reason: z.string().describe("The reason for reading the file."),
});

export const read_file = tool({
  description: "Read the content of a file at the specified path.",
  inputSchema: readFileToolInputSchema,
  execute: async ({ filePath }): Promise<string> => {
    try {
      const content = await readFile(filePath, "utf8");
      return content;
    } catch (error) {
      return `Error reading file: ${error}`;
    }
  },
});
