import fs from "node:fs";
import path from "node:path";

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  content: string;
  dirPath: string;
}

const SKILLS_DIR = ".skills";
const SKILL_FILE = "SKILL.md";
const SKILL_DIR_PLACEHOLDER = "$" + "{SKILL_DIR}";

export class SkillLoader {
  private readonly baseDir: string;
  private skills = new Map<string, SkillDefinition>();

  constructor(baseDir = ".") {
    this.baseDir = baseDir;
  }

  private get skillsDir(): string {
    return path.join(this.baseDir, SKILLS_DIR);
  }

  load(): SkillDefinition[] {
    this.skills.clear();
    if (!fs.existsSync(this.skillsDir)) return [];

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(this.skillsDir, entry.name, SKILL_FILE);
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, "utf-8");
      const parsed = this.parseFrontmatter(raw);

      const skill: SkillDefinition = {
        name: entry.name,
        description: parsed.description,
        disableModelInvocation: parsed.disableModelInvocation,
        userInvocable: parsed.userInvocable,
        content: parsed.content,
        dirPath: path.join(this.skillsDir, entry.name),
        ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      };
      this.skills.set(skill.name, skill);
    }

    return this.list();
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  listModelInvocable(): SkillDefinition[] {
    return this.list().filter((skill) => !skill.disableModelInvocation);
  }

  listUserInvocable(): SkillDefinition[] {
    return this.list().filter((skill) => skill.userInvocable);
  }

  buildSkillContent(skill: SkillDefinition, args = ""): string {
    let content = [
      `Skill 目录: ${skill.dirPath}`,
      "",
      skill.content.replaceAll(SKILL_DIR_PLACEHOLDER, skill.dirPath),
    ].join("\n");

    const instruction = args.trim();
    if (!instruction) return content;
    if (content.includes("$ARGUMENTS")) {
      return content.replaceAll("$ARGUMENTS", instruction);
    }
    content += `\n\n用户指令: ${instruction}`;
    return content;
  }

  buildPromptSection(): string | null {
    if (this.skills.size === 0) return null;

    const available = this.listModelInvocable().map((skill) => {
      const hint = skill.whenToUse ? ` (适用场景: ${skill.whenToUse})` : "";
      return `  ${skill.name} — ${skill.description}${hint}`;
    });

    if (available.length === 0) return null;
    return [
      "可用的 Skills（匹配用户任务时，先调用 skill 工具加载）：",
      ...available,
    ].join("\n");
  }

  private parseFrontmatter(raw: string): {
    description: string;
    whenToUse?: string;
    disableModelInvocation: boolean;
    userInvocable: boolean;
    content: string;
  } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return {
        description: "",
        disableModelInvocation: false,
        userInvocable: true,
        content: raw,
      };
    }

    const frontmatter = match[1];
    const body = match[2];
    if (frontmatter === undefined || body === undefined) {
      return {
        description: "",
        disableModelInvocation: false,
        userInvocable: true,
        content: raw,
      };
    }

    const meta: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
      const index = line.indexOf(":");
      if (index <= 0) continue;

      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }

    const whenToUse = meta.when_to_use;
    return {
      description: meta.description || "",
      disableModelInvocation: parseBoolean(
        meta["disable-model-invocation"],
        false,
      ),
      userInvocable: parseBoolean(meta["user-invocable"], true),
      content: body.trim(),
      ...(whenToUse ? { whenToUse } : {}),
    };
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["false", "no", "off", "0"].includes(value.toLowerCase());
}
