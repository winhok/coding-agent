import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PluginManager } from "../src/plugins/manager.ts";
import type { PluginDefinition } from "../src/plugins/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const originalTestPluginValue = process.env.TEST_PLUGIN_VALUE;

afterEach(() => {
  if (originalTestPluginValue === undefined) {
    delete process.env.TEST_PLUGIN_VALUE;
  } else {
    process.env.TEST_PLUGIN_VALUE = originalTestPluginValue;
  }
});

describe("plugin manager", () => {
  it("resolves config, namespaces tools, and unloads plugin resources", async () => {
    process.env.TEST_PLUGIN_VALUE = "from-env";
    const registry = new ToolRegistry();
    const manager = new PluginManager(registry);
    let receivedConfig: Record<string, string | number | boolean> = {};
    let destroyed = false;
    const plugin: PluginDefinition = {
      name: "example",
      version: "1.0.0",
      description: "Example plugin",
      config: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: PluginManager resolves this placeholder.
        value: "${TEST_PLUGIN_VALUE}",
        enabled: false,
      },
      activate(api) {
        receivedConfig = api.getConfig();
        api.registerTools([
          {
            name: "query",
            description: "Query example data",
            parameters: { type: "object", properties: {} },
            execute: async () => "ok",
          },
        ]);
      },
      destroy() {
        destroyed = true;
      },
    };

    const tools = await manager.load(plugin, { enabled: true });

    assert.deepEqual(receivedConfig, { value: "from-env", enabled: true });
    assert.deepEqual(tools, ["example__query"]);
    assert.equal(
      registry.get("example__query")?.description,
      "[Plugin:example] Query example data",
    );
    assert.deepEqual(manager.list(), [
      {
        name: "example",
        version: "1.0.0",
        description: "Example plugin",
        tools: ["example__query"],
      },
    ]);

    assert.equal(await manager.unload("example"), true);
    assert.equal(destroyed, true);
    assert.equal(registry.get("example__query"), undefined);
    assert.equal(await manager.unload("example"), false);
  });

  it("rejects loading the same plugin twice", async () => {
    const manager = new PluginManager(new ToolRegistry());
    const plugin: PluginDefinition = {
      name: "duplicate",
      version: "1.0.0",
      description: "Duplicate plugin",
      activate() {},
    };

    await manager.load(plugin);

    await assert.rejects(() => manager.load(plugin), /已加载/);
  });
});
