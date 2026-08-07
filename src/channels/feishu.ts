import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export class FeishuChannel implements ChannelDefinition {
  name = "feishu";
  description = "飞书 Bot 消息通道（长连接模式）";

  private config: FeishuConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private wsClient?: InstanceType<
    typeof import("@larksuiteoapi/node-sdk").WSClient
  >;
  private larkClient?: InstanceType<
    typeof import("@larksuiteoapi/node-sdk").Client
  >;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      console.log("    飞书未配置 APP_ID / APP_SECRET，跳过启动");
      return;
    }

    const lark = await import("@larksuiteoapi/node-sdk");

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const dispatcher = new lark.EventDispatcher({});

    dispatcher.register({
      "im.message.receive_v1": (data) => {
        if (data.message.message_type !== "text") return;

        const content = JSON.parse(data.message.content);
        let text = content.text || "";
        if (data.message.mentions) {
          for (const mention of data.message.mentions) {
            text = text.replace(mention.key, "").trim();
          }
        }

        if (text && this.messageHandler) {
          this.messageHandler({
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || "unknown",
            senderName: data.sender.sender_id?.open_id || "unknown",
            text,
            raw: data,
          });
        }
      },
    });

    const wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });
    this.wsClient = wsClient;

    await wsClient.start({ eventDispatcher: dispatcher });
    console.log("    飞书长连接已建立（无需 ngrok）");
  }

  async stop(): Promise<void> {
    this.wsClient?.close();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(
        `    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`,
      );
      return;
    }

    try {
      await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: message.channelId,
          msg_type: "text",
          content: JSON.stringify({ text: message.text }),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`    [feishu] 发送失败: ${message}`);
    }
  }
}
