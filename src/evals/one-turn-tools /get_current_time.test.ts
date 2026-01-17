import assert from "node:assert";
import { describe, it } from "node:test";

import { stepCountIs, ToolLoopAgent } from "ai";

import { claude_opus_4_5_20251101 } from "../../models.ts";
import { getCurrentTimeToolInputSchema } from "../../tools/get_current_time.tool.ts";
import { tools } from "../../tools/index.ts";

const agent = new ToolLoopAgent({
  model: claude_opus_4_5_20251101,
  stopWhen: stepCountIs(1),
  tools,
});

describe("Get current time", () => {
  it("should call", async () => {
    const prompt = "What time is it now?";

    const { toolCalls } = await agent.generate({ prompt });

    assert.doesNotThrow(() =>
      getCurrentTimeToolInputSchema.parse(toolCalls[0]?.input),
    );
    assert.ok(toolCalls.length > 0);
    assert.ok(toolCalls[0]?.toolName.includes("get_current_time"));
  });
});
