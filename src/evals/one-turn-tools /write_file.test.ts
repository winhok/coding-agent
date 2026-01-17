import assert from "node:assert";
import { describe, it } from "node:test";

import { stepCountIs, ToolLoopAgent } from "ai";

import { claude_opus_4_5_20251101 } from "../../models.ts";
import { tools } from "../../tools/index.ts";
import { writeFileToolInputSchema } from "../../tools/write_file.tool.ts";

const agent = new ToolLoopAgent({
  model: claude_opus_4_5_20251101,
  stopWhen: stepCountIs(1),
  tools,
});

describe("Write file", () => {
  it("should call", async () => {
    const prompt = "Write 'hello world' to output.txt";

    const { toolCalls } = await agent.generate({ prompt });

    assert.doesNotThrow(() =>
      writeFileToolInputSchema.parse(toolCalls[0]?.input),
    );
    assert.ok(toolCalls.length > 0);
    assert.ok(toolCalls[0]?.toolName.includes("write_file"));
  });
});
