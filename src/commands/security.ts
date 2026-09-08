import type { OwnerReviewManager } from "../guardrails/review.js";
import type { HookPipeline } from "../security/hooks.js";
import type { Role } from "../security/roles.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CommandHandler } from "./index.js";

export function createSecurityCommands(
  registry: ToolRegistry,
  hookPipeline: HookPipeline,
  review?: {
    manager: OwnerReviewManager;
    actorId: string;
    conversationId: string;
    policyVersion: string;
  },
): CommandHandler[] {
  return [
    (cmd, ctx) => {
      const match = cmd.match(/^\/guardrail\s+approve\s+([A-Za-z0-9_-]+)$/);
      if (!match) return false;
      if (!review || registry.getRole() !== "owner") {
        console.log("\n[guardrail] 仅 Owner 可处理审批。\n");
        return true;
      }
      const token = match[1] ?? "";
      const binding = {
        actorId: review.actorId,
        conversationId: review.conversationId,
        policyVersion: review.policyVersion,
      };
      review.manager.approve(token, binding);
      const approved = review.manager.approvedRecovery(token, binding);
      if (approved) {
        const assistant = {
          role: "assistant" as const,
          content: approved.recovery.text,
        };
        ctx.sessionStore.append(assistant);
        ctx.replaceMessages([...ctx.messages, assistant]);
      }
      const consumed = approved
        ? review.manager.consume(token, approved.binding)
        : false;
      console.log(
        consumed
          ? `\n[guardrail] 审批通过，已恢复结果：\n${approved?.recovery.text ?? ""}\n`
          : "\n[guardrail] 审批 token 无效、已使用、已过期或绑定不匹配。\n",
      );
      return true;
    },
    // /role [owner|collaborator|guest]
    (cmd, _ctx) => {
      const match = cmd.match(/^\/role(?:\s+(owner|collaborator|guest))?$/);
      if (!match) return false;

      if (match[1]) {
        const role = match[1] as Role;
        registry.setRole(role);
        const toolCount = registry.getActiveTools().length;
        console.log(
          `\n[security] 角色切换为 ${role}，可用工具: ${toolCount} 个\n`,
        );
      } else {
        const role = registry.getRole();
        const toolCount = registry.getActiveTools().length;
        console.log(
          `\n[security] 当前角色: ${role}，可用工具: ${toolCount} 个\n`,
        );
      }
      return true;
    },

    // /hooks
    (cmd, _ctx) => {
      if (cmd !== "/hooks") return false;

      const hooks = hookPipeline.list();
      console.log("\n[hooks]");
      if (hooks.pre.length > 0) {
        console.log("  Pre-Tool Hooks:");
        for (const name of hooks.pre) console.log(`    - ${name}`);
      }
      if (hooks.post.length > 0) {
        console.log("  Post-Tool Hooks:");
        for (const name of hooks.post) console.log(`    - ${name}`);
      }
      if (hooks.pre.length === 0 && hooks.post.length === 0) {
        console.log("  没有注册的 Hook");
      }
      console.log("");
      return true;
    },
  ];
}
