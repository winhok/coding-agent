import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FeishuChannel,
  mapFeishuIncomingMessage,
  mapFeishuReviewAction,
} from "../src/channels/feishu.ts";
import { ChannelSendError } from "../src/channels/types.ts";

interface FeishuMessageClientMock {
  im: {
    message: {
      create: (request: unknown) => Promise<{ data?: { message_id?: string } }>;
      reply: (request: unknown) => Promise<{ data?: { message_id?: string } }>;
    };
  };
}

function channelWithClient(client: FeishuMessageClientMock): FeishuChannel {
  const channel = new FeishuChannel({ appId: "app", appSecret: "secret" });
  (channel as unknown as { larkClient: FeishuMessageClientMock }).larkClient =
    client;
  return channel;
}

describe("feishu channel delivery", () => {
  it("fails closed when the sender allowlist is empty", async () => {
    const channel = new FeishuChannel({
      appId: "app",
      appSecret: "secret",
      allowedSenders: [],
    });
    const authorization = channel.authorize({
      transportEventId: "event-1",
      accountId: "app",
      conversationId: "chat-1",
      senderId: "ou_unknown",
      senderName: "Unknown",
      text: "hello",
      receivedAt: Date.now(),
    });

    assert.equal(authorization.allowed, false);
    await assert.rejects(
      channel.start(),
      (error: unknown) =>
        error instanceof ChannelSendError && error.certainty === "not_sent",
    );

    const trustedChannel = new FeishuChannel({
      appId: "app",
      appSecret: "secret",
      allowedSenders: ["ou_trusted"],
    });
    assert.equal(
      trustedChannel.authorize({
        transportEventId: "event-2",
        accountId: "app",
        conversationId: "chat-1",
        senderId: "ou_trusted",
        senderName: "Trusted",
        text: "hello",
        receivedAt: Date.now(),
      }).allowed,
      true,
    );
  });

  it("keeps a root-only reply as a normal reply", () => {
    const message = mapFeishuIncomingMessage(
      {
        message: {
          message_id: "reply-message",
          chat_id: "chat-1",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
          root_id: "root-message",
        },
        sender: { sender_id: { open_id: "user-1" } },
      },
      "app",
    );

    assert.equal(message?.replyToMessageId, "reply-message");
    assert.equal(message?.threadId, undefined);
    assert.equal(message?.replyInThread, undefined);
  });

  it("uses thread_id as the only inbound topic identity", () => {
    const message = mapFeishuIncomingMessage(
      {
        message: {
          message_id: "topic-reply",
          chat_id: "chat-1",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
          root_id: "topic-root",
          thread_id: "omt-topic",
        },
        sender: { sender_id: { open_id: "user-1" } },
      },
      "app",
    );

    assert.equal(message?.threadId, "omt-topic");
    assert.equal(message?.replyToMessageId, "topic-root");
    assert.equal(message?.replyInThread, true);
  });

  it("replies to the source message inside a topic", async () => {
    const requests: unknown[] = [];
    const channel = channelWithClient({
      im: {
        message: {
          create: async () => {
            throw new Error("top-level create must not be used");
          },
          reply: async (request) => {
            requests.push(request);
            return { data: { message_id: "reply-message-1" } };
          },
        },
      },
    });

    const receipt = await channel.send({
      conversationId: "chat-1",
      threadId: "topic-1",
      replyToMessageId: "root-message-1",
      replyInThread: true,
      text: "hello",
      deliveryId: "delivery-1",
    });

    assert.equal(receipt.platformMessageId, "reply-message-1");
    assert.deepEqual(requests, [
      {
        path: { message_id: "root-message-1" },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "hello" }),
          reply_in_thread: true,
        },
      },
    ]);
  });

  it("omits reply_in_thread for a normal reply", async () => {
    const requests: unknown[] = [];
    const channel = channelWithClient({
      im: {
        message: {
          create: async () => {
            throw new Error("top-level create must not be used");
          },
          reply: async (request) => {
            requests.push(request);
            return { data: { message_id: "normal-reply-1" } };
          },
        },
      },
    });

    await channel.send({
      conversationId: "chat-1",
      replyToMessageId: "source-reply-1",
      text: "hello",
      deliveryId: "delivery-1",
    });

    assert.deepEqual(requests, [
      {
        path: { message_id: "source-reply-1" },
        data: { msg_type: "text", content: JSON.stringify({ text: "hello" }) },
      },
    ]);
  });

  it("treats a response without message_id as an unknown delivery", async () => {
    const channel = channelWithClient({
      im: {
        message: {
          create: async () => ({ data: {} }),
          reply: async () => ({ data: {} }),
        },
      },
    });

    await assert.rejects(
      channel.send({
        conversationId: "chat-1",
        text: "hello",
        deliveryId: "delivery-1",
      }),
      (error: unknown) =>
        error instanceof ChannelSendError && error.certainty === "unknown",
    );
  });

  it("maps identity-bound review callbacks and sends review as an interactive card", async () => {
    const action = mapFeishuReviewAction(
      {
        open_id: "ou_owner",
        action: {
          value: {
            action: "guardrail_approve",
            token: "review-token",
            conversationId: "chat-1",
          },
        },
      },
      "app",
    );
    assert.deepEqual(action, {
      accountId: "app",
      actorId: "ou_owner",
      conversationId: "chat-1",
      token: "review-token",
    });

    const requests: unknown[] = [];
    const channel = channelWithClient({
      im: {
        message: {
          create: async (request) => {
            requests.push(request);
            return { data: { message_id: "card-1" } };
          },
          reply: async () => ({ data: { message_id: "unused" } }),
        },
      },
    });
    await channel.send({
      conversationId: "chat-1",
      text: "需要审批",
      deliveryId: "delivery-review",
      review: { token: "review-token", expiresAt: "2030-01-01T00:00:00.000Z" },
    });

    assert.match(JSON.stringify(requests), /"msg_type":"interactive"/);
    assert.match(JSON.stringify(requests), /guardrail_approve/);
    assert.match(JSON.stringify(requests), /review-token/);
  });
});
