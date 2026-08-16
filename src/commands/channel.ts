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
        const status =
          channel.status.state === "failed"
            ? `failed: ${channel.status.error}`
            : channel.status.state;
        console.log(
          `  ${channel.name} — ${channel.description} — ${status} — turns pending/failed ${channel.queues.pendingTurns}/${channel.queues.failedTurns}, delivery pending/failed/unknown ${channel.queues.pendingDeliveries}/${channel.queues.failedDeliveries}/${channel.queues.unknownDeliveries}`,
        );
      }
      console.log("");
      return true;
    },
  ];
}
