import type { PluginManager } from "../plugins/manager.js";
import type { PluginDefinition } from "../plugins/types.js";
import type { CommandHandler } from "./index.js";

export function createPluginCommands(
  pluginManager: PluginManager,
  availablePlugins: Map<string, PluginDefinition>,
): CommandHandler[] {
  return [
    // /plugin 或 /plugin list
    (cmd) => {
      if (cmd !== "/plugin" && cmd !== "/plugin list") return false;

      const loaded = pluginManager.list();
      const unloaded = Array.from(availablePlugins.entries()).filter(
        ([name]) => !loaded.find((plugin) => plugin.name === name),
      );

      if (loaded.length === 0 && unloaded.length === 0) {
        console.log("\n[plugins] 没有可用的插件。\n");
        return true;
      }

      console.log("\n[plugins]");
      if (loaded.length > 0) {
        console.log("  已加载：");
        for (const plugin of loaded) {
          console.log(
            `    ${plugin.name} v${plugin.version} — ${plugin.description}`,
          );
          console.log(`      工具: ${plugin.tools.join(", ")}`);
        }
      }
      if (unloaded.length > 0) {
        console.log("  可加载：");
        for (const [name, definition] of unloaded) {
          console.log(
            `    ${name} v${definition.version} — ${definition.description}`,
          );
        }
      }
      console.log("");
      return true;
    },

    // /plugin load <name>
    (cmd) => {
      const match = cmd.match(/^\/plugin\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      if (!name) return false;

      const definition = availablePlugins.get(name);
      if (!definition) {
        console.log(`\n[plugins] 找不到插件: ${name}\n`);
        return true;
      }

      if (pluginManager.get(name)) {
        console.log(`\n[plugins] ${name} 已经加载了\n`);
        return true;
      }

      pluginManager
        .load(definition)
        .then((tools) => {
          console.log(
            `\n[plugins] 已加载 ${name}，注册了 ${tools.length} 个工具：`,
          );
          for (const tool of tools) console.log(`    ${tool}`);
          console.log("");
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`\n[plugins] 加载 ${name} 失败: ${message}\n`);
        });

      return true;
    },

    // /plugin unload <name>
    (cmd) => {
      const match = cmd.match(/^\/plugin\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      if (!name) return false;

      pluginManager.unload(name).then((ok) => {
        if (ok) {
          console.log(`\n[plugins] 已卸载 ${name}，相关工具已移除\n`);
        } else {
          console.log(`\n[plugins] ${name} 未加载\n`);
        }
      });

      return true;
    },
  ];
}
