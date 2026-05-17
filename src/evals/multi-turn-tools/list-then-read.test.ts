import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { stepCountIs, ToolLoopAgent } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { ToolRegistry } from "../../tools/registry.ts";
import { allTools } from "../../tools/tools.ts";
import {
  cleanupTempDir,
  makeTempDir,
  mockTextResponse,
  mockToolCallResponse,
  withMutedConsole,
} from "../helpers.ts";

describe("multi-turn-tools with MockLanguageModelV3", () => {
  it("can list a directory, read a discovered file, and finish", async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, "target.txt");
      writeFileSync(file, "multi turn content\n", "utf-8");

      const registry = new ToolRegistry();
      registry.register(...allTools);

      let callCount = 0;
      const steps: Array<{
        text: string;
        toolCalls: Array<{ toolName: string }>;
        toolResults: Array<{ output: unknown }>;
      }> = [];

      const agent = new ToolLoopAgent({
        model: new MockLanguageModelV3({
          doGenerate: async () => {
            callCount++;
            if (callCount === 1) {
              return mockToolCallResponse("list_directory", { path: dir });
            }
            if (callCount === 2) {
              return mockToolCallResponse("read_file", { path: file });
            }
            return mockTextResponse("finished after reading target.txt");
          },
        }),
        stopWhen: stepCountIs(3),
        tools: registry.toAISDKFormat(),
        onStepFinish: (step) => {
          steps.push({
            text: step.text,
            toolCalls: step.toolCalls.map((call) => ({
              toolName: call.toolName,
            })),
            toolResults: step.toolResults.map((result) => ({
              output: result.output,
            })),
          });
        },
      });

      const result = await withMutedConsole(() =>
        agent.generate({ prompt: "find and read target.txt" }),
      );

      assert.equal(callCount, 3);
      assert.equal(result.text, "finished after reading target.txt");
      assert.deepEqual(
        steps.map((step) => step.toolCalls[0]?.toolName ?? "text"),
        ["list_directory", "read_file", "text"],
      );
      assert.match(String(steps[0]?.toolResults[0]?.output), /target\.txt/);
      assert.match(
        String(steps[1]?.toolResults[0]?.output),
        /multi turn content/,
      );
    } finally {
      cleanupTempDir(dir);
    }
  });
});
