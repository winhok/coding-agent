import { tool } from "ai";
import { globby } from "globby";
import z from "zod";

export const listFilesToolInputSchema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob pattern to match files, e.g. '**/*.ts' or 'src/**/*'. Use '**/*' to list all files recursively.",
    ),
  reason: z.string().describe("The reason for listing the files."),
});

export const list_files = tool({
  description:
    "List files matching a glob pattern. Supports recursive search and file type filtering.",
  inputSchema: listFilesToolInputSchema,
  execute: async ({ pattern }): Promise<string> => {
    try {
      const files = await globby(pattern, { gitignore: true, dot: false });
      return files.length > 0
        ? files.join("\n")
        : "No files found matching the pattern.";
    } catch (error) {
      return `Error listing files: ${error}`;
    }
  },
});
