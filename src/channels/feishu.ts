import type {
  ChannelDefinition,
  ChannelReviewAction,
  ChannelReviewActionResult,
  ChannelSendReceipt,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";
import { ChannelSendError } from "./types.js";

interface FeishuConfig {
  appId: string;
  appSecret: string;
  allowedSenders?: readonly string[];
}

interface FeishuReceiveEvent {
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string;
    create_time?: string;
    root_id?: string;
    thread_id?: string;
    mentions?: Array<{ key: string }>;
  };
  sender: { sender_id?: { open_id?: string } };
}

interface FeishuCardActionEvent {
  open_id: string;
  action: { value?: Record<string, unknown> };
}

/** Convert Feishu transport fields without conflating reply trees with topics. */
export function mapFeishuIncomingMessage(
  data: FeishuReceiveEvent,
  accountId: string,
): IncomingMessage | undefined {
  if (data.message.message_type !== "text") return undefined;

  const content = JSON.parse(data.message.content) as { text?: string };
  let text = content.text || "";
  for (const mention of data.message.mentions ?? []) {
    text = text.replace(mention.key, "").trim();
  }
  if (!text) return undefined;

  const threadId = data.message.thread_id?.trim();
  const rootId = data.message.root_id?.trim();
  const messageId = data.message.message_id;
  const senderId = data.sender.sender_id?.open_id || "unknown";
  return {
    transportEventId: messageId,
    accountId,
    conversationId: data.message.chat_id,
    ...(threadId
      ? { threadId, replyToMessageId: rootId || messageId, replyInThread: true }
      : rootId
        ? { replyToMessageId: messageId }
        : {}),
    senderId,
    senderName: senderId,
    text,
    receivedAt: Number(data.message.create_time) || Date.now(),
    raw: data,
  };
}

export function mapFeishuReviewAction(
  data: FeishuCardActionEvent,
  accountId: string,
): ChannelReviewAction | undefined {
  const value = data.action.value;
  if (
    value?.action !== "guardrail_approve" ||
    typeof value.token !== "string" ||
    typeof value.conversationId !== "string" ||
    !data.open_id
  ) {
    return undefined;
  }
  return {
    accountId,
    actorId: data.open_id,
    conversationId: value.conversationId,
    token: value.token,
  };
}

export class FeishuChannel implements ChannelDefinition {
  name = "feishu";
  description = "飞书 Bot 消息通道（长连接模式）";

  get accountId(): string {
    return this.config.appId;
  }

  private config: FeishuConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private reviewHandler?: (
    action: ChannelReviewAction,
  ) => ChannelReviewActionResult | Promise<ChannelReviewActionResult>;
  private wsClient?: InstanceType<
    typeof import("@larksuiteoapi/node-sdk").WSClient
  >;
  private larkClient?: InstanceType<
    typeof import("@larksuiteoapi/node-sdk").Client
  >;

  authorize(message: IncomingMessage) {
    const allowed = this.config.allowedSenders ?? [];
    if (allowed.includes(message.senderId)) {
      return { allowed: true as const };
    }
    return {
      allowed: false as const,
      reason: `sender ${message.senderId} is not in the Feishu allowlist`,
    };
  }

  authorizeReviewAction(action: ChannelReviewAction) {
    const allowed = this.config.allowedSenders ?? [];
    return allowed.includes(action.actorId)
      ? { allowed: true as const }
      : {
          allowed: false as const,
          reason: `actor ${action.actorId} is not in the Feishu allowlist`,
        };
  }

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onReviewAction(
    handler: (
      action: ChannelReviewAction,
    ) => ChannelReviewActionResult | Promise<ChannelReviewActionResult>,
  ): void {
    this.reviewHandler = handler;
  }

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new ChannelSendError(
        "飞书已启用但 APP_ID / APP_SECRET 未完整配置",
        "not_sent",
      );
    }
    if (!this.config.allowedSenders?.length) {
      throw new ChannelSendError(
        "飞书已启用但未配置允许的用户 open_id",
        "not_sent",
      );
    }

    const lark = await import("@larksuiteoapi/node-sdk");

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const dispatcher = new lark.EventDispatcher({});

    dispatcher.register({
      "im.message.receive_v1": async (data) => {
        const message = mapFeishuIncomingMessage(data, this.config.appId);
        if (message && this.messageHandler) await this.messageHandler(message);
      },
      "card.action.trigger": async (data: FeishuCardActionEvent) => {
        const action = mapFeishuReviewAction(data, this.config.appId);
        if (!action || !this.reviewHandler) {
          return { toast: { type: "error", content: "审批操作无效。" } };
        }
        const result = await this.reviewHandler(action);
        return {
          toast: {
            type: result.accepted ? "success" : "error",
            content: result.message,
          },
        };
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

  async send(message: OutgoingMessage): Promise<ChannelSendReceipt> {
    if (!this.larkClient) {
      throw new ChannelSendError("飞书客户端未启动，消息尚未发送", "not_sent");
    }

    try {
      const content = message.review
        ? JSON.stringify({
            config: { wide_screen_mode: true },
            header: {
              template: "orange",
              title: { tag: "plain_text", content: "Guardrail Owner 审批" },
            },
            elements: [
              { tag: "markdown", content: message.text },
              {
                tag: "action",
                actions: [
                  {
                    tag: "button",
                    text: { tag: "plain_text", content: "批准此请求" },
                    type: "primary",
                    value: {
                      action: "guardrail_approve",
                      token: message.review.token,
                      conversationId: message.conversationId,
                    },
                  },
                ],
              },
            ],
          })
        : JSON.stringify({ text: message.text });
      const msgType = message.review ? "interactive" : "text";
      const response = message.replyToMessageId
        ? await this.larkClient.im.message.reply({
            path: { message_id: message.replyToMessageId },
            data: {
              msg_type: msgType,
              content,
              ...(message.replyInThread ? { reply_in_thread: true } : {}),
            },
          })
        : await this.larkClient.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: message.conversationId,
              msg_type: msgType,
              content,
            },
          });
      const platformMessageId = response.data?.message_id?.trim();
      if (!platformMessageId) {
        throw new ChannelSendError(
          "飞书已接受发送请求，但未返回 message_id，投递结果未知",
          "unknown",
        );
      }
      return { platformMessageId, deliveredAt: Date.now() };
    } catch (err) {
      if (err instanceof ChannelSendError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new ChannelSendError(`飞书发送结果未知: ${detail}`, "unknown", {
        cause: err,
      });
    }
  }
}
