import type { ModelMessage } from "ai";
import { agentLoop } from "../agent/loop.js";
import type { SkillLoader } from "../skills/loader.js";
import type { CommandHandler } from "./index.js";

export function createSkillCommands(
  skillLoader: SkillLoader,
): CommandHandler[] {
  return [
    (cmd) => {
      if (cmd !== "/skill" && cmd !== "/skill list" && cmd !== "skill list") {
        return false;
      }

      const skills = skillLoader.listUserInvocable();
      if (skills.length === 0) {
        console.log(
          "\n[skills] 没有找到任何 skill。在 .skills/ 目录下创建 skill-name/SKILL.md 即可。\n",
        );
        return true;
      }

      console.log(`\n[skills] 共 ${skills.length} 个可用：`);
      for (const skill of skills) {
        console.log(`  /${skill.name} — ${skill.description}`);
        if (skill.whenToUse) {
          console.log(`    适用场景: ${skill.whenToUse}`);
        }
      }
      console.log("");
      return true;
    },

    (cmd, ctx) => {
      if (!cmd.startsWith("/")) return false;

      const [name, ...args] = cmd.slice(1).split(/\s+/);
      if (!name) return false;
      const skill = skillLoader.get(name);
      if (!skill?.userInvocable) return false;

      console.log(`\n[skills] 加载 ${name}，开始执行...`);

      const content = skillLoader.buildSkillContent(skill, args.join(" "));

      const userMessage: ModelMessage = { role: "user", content };
      ctx.messages.push(userMessage);
      ctx.timestamps.set(ctx.messages.length - 1, Date.now());
      ctx.sessionStore.append(userMessage);

      const currentSystem = ctx.builder.build(ctx.makePromptCtx());
      agentLoop(
        ctx.model,
        ctx.registry,
        ctx.messages,
        currentSystem,
        ctx.tracker,
      ).then((newMessages) => {
        const now = Date.now();
        for (const message of newMessages) {
          const index = ctx.messages.indexOf(message);
          if (index >= 0) ctx.timestamps.set(index, now);
        }
        ctx.sessionStore.appendAll(newMessages);
        ctx.ask();
      });

      return "async";
    },
  ];
}
