import type { SkillLoader } from "../skills/loader.js";
import type { ToolDefinition } from "./registry.js";

export function createSkillTool(skillLoader: SkillLoader): ToolDefinition {
  const skills = skillLoader.listModelInvocable();

  return {
    name: "skill",
    description:
      "按需加载 Skill 的完整领域指导。用户任务与系统提示中的 Skill 匹配时，必须先调用此工具，再按照返回的指导继续执行。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: skills.map((skill) => skill.name),
          description: "要加载的 Skill 名称",
        },
        args: { type: "string", description: "传给 Skill 的用户指令或参数" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 100_000,
    execute: async ({ name, args }: { name: string; args?: string }) => {
      const skill = skillLoader.get(name);
      if (!skill) return `找不到 Skill: ${name}`;
      if (skill.disableModelInvocation) {
        return `Skill ${name} 禁止由模型自动调用`;
      }

      return [
        `[已加载 Skill: ${skill.name}]`,
        "",
        skillLoader.buildSkillContent(skill, args),
      ].join("\n");
    },
  };
}
