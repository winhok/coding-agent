import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("ui agent boundary", () => {
  it("receives the runtime agent instead of importing a singleton service", async () => {
    const userInputPath = fileURLToPath(
      new URL("../../src/ui/userInput.tsx", import.meta.url),
    );

    const source = await readFile(userInputPath, "utf8");

    assert.doesNotMatch(source, /from "\.\.\/index\.ts"/);
    assert.doesNotMatch(source, /agent\.service/);
  });

  it("exports an async runtime factory from src/index", async () => {
    process.env.DASHSCOPE_API_KEY ??= "test-api-key";

    const { createRuntime } = await import("../../src/index.ts");

    assert.equal(typeof createRuntime, "function");
  });

  it("bootstraps runtime before rendering the Ink app", async () => {
    const mainPath = fileURLToPath(
      new URL("../../src/main.ts", import.meta.url),
    );

    const source = await readFile(mainPath, "utf8");

    assert.match(source, /createRuntime/);
    assert.match(source, /createElement\(App,\s*\{\s*runtime/);
  });

  it("cleans dist before production builds", async () => {
    const packagePath = fileURLToPath(
      new URL("../../package.json", import.meta.url),
    );
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

    assert.match(packageJson.scripts.build, /clean/);
    assert.match(packageJson.scripts.prepare, /clean/);
  });
});
