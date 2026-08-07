import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelMessage } from "ai";
import type { CommandContext } from "../src/commands/index.ts";
import { createSkillCommands } from "../src/commands/skill.ts";
import { SkillLoader } from "../src/skills/loader.ts";
import { createSkillTool } from "../src/tools/skill-tool.ts";
import { cleanupTempDir, makeTempDir, withMutedConsole } from "./helpers.ts";

function writeSkill(
  baseDir: string,
  name: string,
  description: string,
  whenToUse?: string,
): void {
  const skillDir = join(baseDir, ".skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: "${description}"`,
      ...(whenToUse ? [`when_to_use: '${whenToUse}'`] : []),
      "---",
      "",
      `# ${name}`,
      "",
      "按既定流程执行。",
    ].join("\n"),
  );
}

describe("SkillLoader", () => {
  it("advertises metadata without injecting full skill content", () => {
    const dir = makeTempDir("coding-agent-skills-");
    try {
      writeSkill(dir, "code-review", "审查代码", "用户要求 review 时");
      writeSkill(dir, "research", "技术调研");

      const loader = new SkillLoader(dir);
      assert.equal(loader.load().length, 2);
      assert.equal(loader.get("code-review")?.whenToUse, "用户要求 review 时");

      const prompt = loader.buildPromptSection();
      assert.match(prompt ?? "", /code-review — 审查代码/);
      assert.match(prompt ?? "", /适用场景: 用户要求 review 时/);
      assert.match(prompt ?? "", /research — 技术调研/);
      assert.doesNotMatch(prompt ?? "", /按既定流程执行/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("uses the whole file as content when frontmatter is absent", () => {
    const dir = makeTempDir("coding-agent-skills-");
    const skillDir = join(dir, ".skills", "plain");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(join(skillDir, "SKILL.md"), "# Plain\n\n直接执行。");

    try {
      const loader = new SkillLoader(dir);
      loader.load();
      assert.deepEqual(loader.get("plain"), {
        name: "plain",
        description: "",
        disableModelInvocation: false,
        userInvocable: true,
        content: "# Plain\n\n直接执行。",
        dirPath: skillDir,
      });
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("skill commands", () => {
  it("lists user-invocable skills without load or unload commands", async () => {
    const dir = makeTempDir("coding-agent-skills-");
    try {
      writeSkill(dir, "code-review", "审查代码");
      const loader = new SkillLoader(dir);
      loader.load();
      const [list] = createSkillCommands(loader);
      assert.ok(list);

      await withMutedConsole(() => {
        assert.equal(list("/skill", {} as CommandContext), true);
        assert.equal(
          list("/skill load code-review", {} as CommandContext),
          false,
        );
        assert.equal(
          list("/skill unload code-review", {} as CommandContext),
          false,
        );
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("delegates explicit skills to the shared user turn runner", async () => {
    const dir = makeTempDir("coding-agent-skills-");
    try {
      writeSkill(dir, "code-review", "审查代码");
      const loader = new SkillLoader(dir);
      loader.load();
      const [, run] = createSkillCommands(loader);
      assert.ok(run);

      const submitted: ModelMessage[] = [];
      const ctx = {
        runUserTurn(message: ModelMessage) {
          submitted.push(message);
        },
      } as unknown as CommandContext;

      const handled = await withMutedConsole(() =>
        run("/code-review 检查 src/rag", ctx),
      );

      assert.equal(handled, "async");
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0]?.role, "user");
      assert.match(String(submitted[0]?.content), /用户指令: 检查 src\/rag/);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("skill tool", () => {
  it("loads full content on demand and passes user arguments", async () => {
    const dir = makeTempDir("coding-agent-skills-");
    try {
      writeSkill(dir, "code-review", "审查代码");
      const loader = new SkillLoader(dir);
      loader.load();
      const skill = loader.get("code-review");
      assert.ok(skill);
      skill.content += `\n读取 ${"$" + "{SKILL_DIR}"}/checklist.md。`;
      const tool = createSkillTool(loader);
      const properties = tool.parameters.properties as Record<string, unknown>;
      const nameSchema = properties.name as { enum: string[] };

      assert.deepEqual(nameSchema.enum, ["code-review"]);
      const result = await tool.execute({
        name: "code-review",
        args: "检查 src/rag",
      });
      assert.match(String(result), /\[已加载 Skill: code-review\]/);
      assert.match(String(result), /按既定流程执行/);
      assert.match(
        String(result),
        new RegExp(`${skill.dirPath}/checklist\\.md`),
      );
      assert.match(String(result), /用户指令: 检查 src\/rag/);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
