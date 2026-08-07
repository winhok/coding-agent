import type { ChannelGateway } from "../channels/gateway.js";
import type { CommandHandler } from "./index.js";

export function createChannelCommands(
  gateway: ChannelGateway,
): CommandHandler[] {
  return [
    (cmd) => {
      if (cmd !== "/channel" && cmd !== "/channel list") return false;

      const channels = gateway.list();
      if (channels.length === 0) {
        console.log("\n[channels] 没有注册的通道。\n");
        return true;
      }

      console.log("\n[channels]");
      for (const channel of channels) {
        console.log(`  ${channel.name} — ${channel.description}`);
      }
      console.log("");
      return true;
    },
  ];
}
