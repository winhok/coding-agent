import type { ToolModelMessage, ToolResultPart } from "ai";

type ToolResultOutput = ToolResultPart["output"];

export function isToolResultPart(
  part: ToolModelMessage["content"][number],
): part is ToolResultPart {
  return part.type === "tool-result";
}

export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: "text", value };
}

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason
        ? `[execution denied: ${output.reason}]`
        : "[execution denied]";
    case "content":
      return output.value
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[media: ${"mediaType" in part && part.mediaType ? part.mediaType : part.type}]`,
        )
        .join("\n");
  }
}
