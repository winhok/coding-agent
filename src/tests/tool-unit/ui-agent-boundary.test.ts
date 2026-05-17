import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("ui agent boundary", () => {
  it("wires UserInput directly to src/agent instead of agent.service", async () => {
    const userInputPath = fileURLToPath(
      new URL("../../ui/userInput.tsx", import.meta.url),
    );

    const source = await readFile(userInputPath, "utf8");

    assert.match(source, /from "\.\.\/agent\.ts"/);
    assert.doesNotMatch(source, /agent\.service/);
  });

  it("exports an AI SDK agent from src/agent", async () => {
    process.env.DASHSCOPE_API_KEY ??= "test-api-key";

    const { agent } = await import("../../agent.ts");

    assert.equal(agent.version, "agent-v1");
    assert.equal(typeof agent.stream, "function");
  });
});
