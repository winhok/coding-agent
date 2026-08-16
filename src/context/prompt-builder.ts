import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { SkillView } from "../skills/loader.js";
import type { ToolView } from "../tools/registry.js";

export type PromptSurface = "system" | "workspace" | "runtime";

export interface PromptContext {
  toolView: ToolView;
  skillView: SkillView;
}

export interface PromptPipe {
  name: string;
  surface: PromptSurface;
  requiresTools?: readonly string[];
  render: (ctx: PromptContext) => string | null;
}

export interface PromptSection {
  name: string;
  surface: PromptSurface;
  text: string;
}

export interface PromptSnapshot {
  surface: Exclude<PromptSurface, "system">;
  text: string;
  digest: string;
}

export interface PromptAssembly {
  system: string;
  snapshots: PromptSnapshot[];
  sections: PromptSection[];
}

function joinSections(sections: PromptSection[]): string {
  return sections.map((section) => section.text).join("\n\n");
}

const EMPTY_SNAPSHOT_TEXT = "（当前没有此类上下文。）";
const SNAPSHOT_WRAPPER_PATTERN =
  /^<prompt-snapshot surface="(workspace|runtime)" digest="([a-f0-9]{64})">\n\[(工作区上下文|运行时上下文)完整快照\] 本快照替代此前同 surface 的所有快照。\n\n([\s\S]*)\n<\/prompt-snapshot>$/;

function snapshotBody(text: string): string {
  return text || EMPTY_SNAPSHOT_TEXT;
}

function snapshotDigest(surface: PromptSnapshot["surface"], text: string) {
  return createHash("sha256")
    .update(`${surface}\0${snapshotBody(text)}`)
    .digest("hex");
}

export class PromptBuilder {
  private readonly pipes: PromptPipe[] = [];

  pipe(pipe: PromptPipe): this {
    if (this.pipes.some((candidate) => candidate.name === pipe.name)) {
      throw new Error(`Prompt pipe ${pipe.name} is already registered`);
    }
    this.pipes.push(pipe);
    return this;
  }

  assemble(ctx: PromptContext): PromptAssembly {
    const sections: PromptSection[] = [];
    for (const pipe of this.pipes) {
      if (pipe.requiresTools?.some((toolName) => !ctx.toolView.has(toolName))) {
        continue;
      }
      const text = pipe.render(ctx);
      if (text?.trim()) {
        sections.push({ name: pipe.name, surface: pipe.surface, text });
      }
    }

    const system = joinSections(
      sections.filter((section) => section.surface === "system"),
    );
    const snapshots = (["workspace", "runtime"] as const).map((surface) => {
      const text = joinSections(
        sections.filter((section) => section.surface === surface),
      );
      return { surface, text, digest: snapshotDigest(surface, text) };
    });
    return { system, snapshots, sections };
  }

  debug(ctx: PromptContext): void {
    const assembly = this.assemble(ctx);
    console.log("\n=== Prompt Pipe Debug ===");
    const enabled = new Set(assembly.sections.map((section) => section.name));
    for (const pipe of this.pipes) {
      const section = assembly.sections.find(
        (candidate) => candidate.name === pipe.name,
      );
      const status = enabled.has(pipe.name)
        ? `[ON:${pipe.surface}] ${section?.text.length ?? 0} chars`
        : "[OFF]";
      console.log(`  ${pipe.name}: ${status}`);
    }
    console.log("========================\n");
  }
}

export class PromptSnapshotState {
  private readonly digests = new Map<PromptSnapshot["surface"], string>();

  restore(messages: readonly ModelMessage[]): void {
    this.digests.clear();
    for (const message of messages) {
      if (message.role !== "user" || typeof message.content !== "string") {
        continue;
      }
      const match = message.content.match(SNAPSHOT_WRAPPER_PATTERN);
      if (!match) continue;
      const surface = match[1] as PromptSnapshot["surface"];
      const digest = match[2];
      const label = match[3];
      const body = match[4];
      const expectedLabel =
        surface === "workspace" ? "工作区上下文" : "运行时上下文";
      if (
        label !== expectedLabel ||
        digest === undefined ||
        body === undefined ||
        snapshotDigest(surface, body) !== digest
      ) {
        continue;
      }
      this.digests.set(surface, digest);
    }
  }

  selectUpdates(snapshots: PromptSnapshot[]): PromptSnapshot[] {
    const updates: PromptSnapshot[] = [];
    for (const snapshot of snapshots) {
      const previous = this.digests.get(snapshot.surface);
      this.digests.set(snapshot.surface, snapshot.digest);
      if (previous === snapshot.digest) continue;
      if (previous === undefined && !snapshot.text) continue;
      updates.push(snapshot);
    }
    return updates;
  }
}

export function renderPromptSnapshot(snapshot: PromptSnapshot): ModelMessage {
  const label =
    snapshot.surface === "workspace" ? "工作区上下文" : "运行时上下文";
  const content = snapshotBody(snapshot.text);
  return {
    role: "user",
    content: `<prompt-snapshot surface="${snapshot.surface}" digest="${snapshot.digest}">\n[${label}完整快照] 本快照替代此前同 surface 的所有快照。\n\n${content}\n</prompt-snapshot>`,
  };
}

export function coreRules(): PromptPipe {
  return {
    name: "coreRules",
    surface: "system",
    render: () => `你是 Super Agent，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`,
  };
}

export function toolGuide(): PromptPipe {
  return {
    name: "toolGuide",
    surface: "system",
    render: () =>
      "工具是否可用以当前请求提供的工具定义为准；不要调用未提供的工具。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。",
  };
}

export function delegationGuide(): PromptPipe {
  return {
    name: "delegationGuide",
    surface: "runtime",
    requiresTools: ["spawn_agent"],
    render: () =>
      "涉及多个可独立执行的调研或对比目标时，可以用 spawn_agent 并行执行。",
  };
}

export function deferredTools(): PromptPipe {
  return {
    name: "deferredTools",
    surface: "runtime",
    requiresTools: ["tool_search"],
    render: (ctx) => {
      const summary = ctx.toolView.getDeferredToolSummary();
      if (!summary) return null;
      return `如果需要的工具不在当前列表中，使用 tool_search 搜索。${summary}`;
    },
  };
}
