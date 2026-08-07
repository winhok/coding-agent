import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubAgentRegistry } from "../../src/agents/registry.ts";

describe("tool-unit sub-agent", () => {
  it("enforces depth and concurrency limits", () => {
    const registry = new SubAgentRegistry({
      maxSpawnDepth: 1,
      maxConcurrent: 1,
    });

    assert.match(registry.canSpawn(1).reason ?? "", /最大嵌套深度 1/);

    const id = registry.generateId();
    registry.register({
      id,
      task: "running task",
      status: "running",
      depth: 1,
      startedAt: new Date().toISOString(),
    });
    assert.match(registry.canSpawn(0).reason ?? "", /最大并发数 1/);

    registry.complete(id, "done");
    assert.equal(registry.get(id)?.status, "completed");
    assert.equal(registry.get(id)?.result, "done");
    assert.equal(registry.canSpawn(0).ok, true);
  });
});
