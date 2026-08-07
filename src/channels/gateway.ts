import type { LanguageModel, ModelMessage } from "ai";
import { agentLoop } from "../agent/loop.js";
import type { ToolRegistry } from "../tools/registry.js";
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

interface GatewayOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  buildSystem: () => string;
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>();
  private sessions = new Map<string, ModelMessage[]>();
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);

    channel.onMessage?.((msg: IncomingMessage) => {
      this.handleIncoming(channel.name, msg).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [${channel.name}] 处理消息失败: ${message}`);
      });
    });
  }

  async startAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        await channel.start();
        console.log(`  [gateway] ✓ ${name} 已启动`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [gateway] ✗ ${name} 启动失败: ${message}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [, channel] of this.channels) {
      await channel.stop();
    }
  }

  private async handleIncoming(
    channelName: string,
    msg: IncomingMessage,
  ): Promise<void> {
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    const messages = this.sessions.get(sessionKey) ?? [];
    this.sessions.set(sessionKey, messages);

    const userMsg: ModelMessage = { role: "user", content: msg.text };
    messages.push(userMsg);

    const system = this.options.buildSystem();
    await agentLoop(
      this.options.model,
      this.options.registry,
      messages,
      system,
    );

    const lastMsg = messages[messages.length - 1];
    let replyText = "";
    if (lastMsg?.role === "assistant") {
      const content = lastMsg.content;
      if (typeof content === "string") {
        replyText = content;
      } else if (Array.isArray(content)) {
        replyText = content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
      }
    }

    if (replyText) {
      const channel = this.channels.get(channelName);
      if (channel) {
        const outgoing: OutgoingMessage = {
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        };
        await channel.send(outgoing);
        console.log(
          `  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? "..." : ""}`,
        );
      }
    }
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map((channel) => ({
      name: channel.name,
      description: channel.description,
    }));
  }
}
