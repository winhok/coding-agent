import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config/loader.js";
import { SuperAgentConfigSchema } from "../src/config/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config", () => {
  it("fills nested defaults from an empty object", () => {
    const config = SuperAgentConfigSchema.parse({});

    assert.equal(config.model.name, "qwen3.7-plus-2026-05-26");
    assert.equal(config.agents.maxConcurrent, 3);
    assert.equal(config.channels.feishu.enabled, false);
    assert.equal(config.security.defaultRole, "owner");
    assert.equal(config.rag.enabled, true);
  });

  it("substitutes environment variables before validation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "super-agent.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        model: { apiKey: `$${"{TEST_CONFIG_API_KEY}"}` },
        agents: { maxConcurrent: 5 },
      }),
    );

    const previous = process.env.TEST_CONFIG_API_KEY;
    process.env.TEST_CONFIG_API_KEY = "test-key";
    try {
      const config = loadConfig(configPath);
      assert.equal(config.model.apiKey, "test-key");
      assert.equal(config.agents.maxConcurrent, 5);
      assert.equal(config.agents.maxSpawnDepth, 1);
    } finally {
      if (previous === undefined) delete process.env.TEST_CONFIG_API_KEY;
      else process.env.TEST_CONFIG_API_KEY = previous;
    }
  });
});
