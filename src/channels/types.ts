export interface IncomingMessage {
  /** Provider-stable event identifier used for transport-level deduplication. */
  transportEventId: string;
  /** Bot/application account that received the event. */
  accountId: string;
  /** Provider conversation identifier, such as a Feishu chat_id. */
  conversationId: string;
  /** Optional topic/thread identity inside the conversation. */
  threadId?: string;
  /** Provider message identifier that an outbound reply must target. */
  replyToMessageId?: string;
  /** Whether the provider reply must remain inside the source thread/topic. */
  replyInThread?: boolean;
  senderId: string;
  senderName: string;
  text: string;
  receivedAt: number;
  raw?: unknown;
}

export interface OutgoingMessage {
  conversationId: string;
  threadId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  text: string;
  /** Stable local delivery intent identifier. */
  deliveryId: string;
}

export interface ChannelSendReceipt {
  /** Provider-confirmed identity. A send without one has an unknown outcome. */
  platformMessageId: string;
  deliveredAt: number;
}

export type ChannelSendFailureCertainty = "not_sent" | "unknown";

/** A channel send failure that distinguishes safe retry from ambiguous delivery. */
export class ChannelSendError extends Error {
  constructor(
    message: string,
    readonly certainty: ChannelSendFailureCertainty,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChannelSendError";
  }
}

export type ChannelStatus =
  | { state: "registered" }
  | { state: "starting" }
  | { state: "running" }
  | { state: "stopped" }
  | { state: "failed"; error: string };

export type ChannelAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ChannelDefinition {
  name: string;
  description: string;
  accountId: string;

  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  send(message: OutgoingMessage): Promise<ChannelSendReceipt>;
  authorize?(
    message: IncomingMessage,
  ): ChannelAuthorization | Promise<ChannelAuthorization>;

  onMessage?: (handler: (msg: IncomingMessage) => void | Promise<void>) => void;
}
