import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelMessage } from "ai";
import Database from "better-sqlite3";
import type { IncomingMessage, OutgoingMessage } from "./types.js";

export type TurnQueueStatus = "pending" | "running" | "completed" | "failed";
export type OutboxStatus =
  | "pending"
  | "sending"
  | "delivered"
  | "failed"
  | "unknown";

export interface QueuedTurn {
  id: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  logicalMessageId: string;
  message: IncomingMessage;
  status: TurnQueueStatus;
}

export interface OutboxEntry {
  id: string;
  channelName: string;
  conversationKey: string;
  turnId: string;
  message: OutgoingMessage;
  status: OutboxStatus;
  attempts: number;
}

interface StatusRow {
  status: string;
}

interface TurnRow {
  id: string;
  channel_name: string;
  account_id: string;
  conversation_key: string;
  logical_message_id: string;
  payload_json: string;
  status: TurnQueueStatus;
}

interface MessageRow {
  sequence: number;
  message_json: string;
  created_at: number;
}

interface ContextProjectionRow {
  source_sequence: number;
  messages_json: string;
  timestamps_json: string;
  summary: string | null;
}

interface OutboxRow {
  id: string;
  channel_name: string;
  conversation_key: string;
  turn_id: string;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
}

export interface AcceptIngressResult {
  accepted: boolean;
  conversationKey: string;
  logicalMessageId: string;
  turnId?: string;
}

export interface RejectIngressResult extends AcceptIngressResult {
  outbox?: OutboxEntry;
}

export interface ChannelQueueStats {
  pendingTurns: number;
  failedTurns: number;
  pendingDeliveries: number;
  failedDeliveries: number;
  unknownDeliveries: number;
}

export interface ConversationContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  sourceSequence: number;
  summary?: string;
}

const DEFAULT_LEASE_MS = 30_000;

export class ChannelStoreLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelStoreLeaseError";
  }
}

/** SQLite authority for channel ingress, turn admission, history, and delivery. */
export class ChannelStore {
  private readonly db: Database.Database;
  private readonly ownerToken = randomUUID();
  private readonly leaseMs: number;
  private leaseTimer?: NodeJS.Timeout;
  private leaseLost = false;
  private closed = false;

  constructor(
    dbPath = ".sessions/channels/state.sqlite",
    options: { leaseMs?: number } = {},
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000) {
      throw new TypeError("ChannelStore leaseMs must be an integer >= 1000");
    }
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.createTables();
    this.migrateOwnershipColumns();
    this.acquireLease();
    this.recoverInterruptedWork();
    this.startLeaseHeartbeat();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_ingress (
        logical_message_id TEXT PRIMARY KEY,
        transport_event_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('adopted', 'failed')),
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS channel_turn_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        logical_message_id TEXT NOT NULL UNIQUE,
        channel_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT,
        owner_token TEXT
      );
      CREATE INDEX IF NOT EXISTS channel_turn_pending_idx
        ON channel_turn_queue(conversation_key, status, created_at);

      CREATE TABLE IF NOT EXISTS channel_session_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(turn_id, position)
      );
      CREATE INDEX IF NOT EXISTS channel_session_order_idx
        ON channel_session_messages(conversation_key, sequence);

      CREATE TABLE IF NOT EXISTS channel_context_projection (
        conversation_key TEXT PRIMARY KEY,
        source_sequence INTEGER NOT NULL,
        messages_json TEXT NOT NULL,
        timestamps_json TEXT NOT NULL,
        summary TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        turn_id TEXT NOT NULL UNIQUE,
        channel_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'delivered', 'failed', 'unknown')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT,
        platform_message_id TEXT,
        owner_token TEXT
      );
      CREATE INDEX IF NOT EXISTS channel_outbox_pending_idx
        ON channel_outbox(channel_name, status, created_at);

      CREATE TABLE IF NOT EXISTS channel_gateway_lease (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        owner_token TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  private migrateOwnershipColumns(): void {
    for (const table of ["channel_turn_queue", "channel_outbox"] as const) {
      const columns = this.db.pragma(`table_info(${table})`) as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === "owner_token")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN owner_token TEXT`);
      }
    }
  }

  private acquireLease(): void {
    const now = Date.now();
    const acquire = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO channel_gateway_lease
           (id, owner_token, owner_pid, acquired_at, heartbeat_at, expires_at)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             owner_token = excluded.owner_token,
             owner_pid = excluded.owner_pid,
             acquired_at = excluded.acquired_at,
             heartbeat_at = excluded.heartbeat_at,
             expires_at = excluded.expires_at
           WHERE channel_gateway_lease.expires_at <= ?`,
        )
        .run(this.ownerToken, process.pid, now, now, now + this.leaseMs, now);
      const row = this.db
        .prepare(
          "SELECT owner_token, owner_pid, expires_at FROM channel_gateway_lease WHERE id = 1",
        )
        .get() as
        | { owner_token: string; owner_pid: number; expires_at: number }
        | undefined;
      if (row?.owner_token !== this.ownerToken) {
        throw new ChannelStoreLeaseError(
          `Channel state is already owned by process ${row?.owner_pid ?? "unknown"} until ${new Date(row?.expires_at ?? now).toISOString()}`,
        );
      }
    });
    try {
      acquire();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private startLeaseHeartbeat(): void {
    const intervalMs = Math.max(250, Math.floor(this.leaseMs / 3));
    this.leaseTimer = setInterval(() => {
      if (this.closed || this.leaseLost) return;
      try {
        const now = Date.now();
        const changed = this.db
          .prepare(
            `UPDATE channel_gateway_lease
             SET heartbeat_at = ?, expires_at = ?
             WHERE id = 1 AND owner_token = ?`,
          )
          .run(now, now + this.leaseMs, this.ownerToken);
        if (changed.changes !== 1) this.leaseLost = true;
      } catch {
        // A transient SQLite lock is safe: the existing expiry still fences us.
      }
    }, intervalMs);
    this.leaseTimer.unref?.();
  }

  private assertLeaseOwned(): void {
    if (this.closed) throw new ChannelStoreLeaseError("ChannelStore is closed");
    const row = this.db
      .prepare(
        "SELECT expires_at FROM channel_gateway_lease WHERE id = 1 AND owner_token = ?",
      )
      .get(this.ownerToken) as { expires_at: number } | undefined;
    if (this.leaseLost || !row || row.expires_at <= Date.now()) {
      this.leaseLost = true;
      throw new ChannelStoreLeaseError("ChannelStore lost its gateway lease");
    }
  }

  private recoverInterruptedWork(): void {
    this.assertLeaseOwned();
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE channel_turn_queue
         SET status = 'failed', updated_at = ?, owner_token = NULL,
             last_error = COALESCE(last_error, 'process stopped during running turn; outcome unknown')
         WHERE status = 'running'`,
      )
      .run(now);
    this.db
      .prepare(
        "UPDATE channel_outbox SET status = 'unknown', updated_at = ?, owner_token = NULL, last_error = COALESCE(last_error, 'process stopped during send attempt') WHERE status = 'sending'",
      )
      .run(now);
  }

  static conversationKey(
    channelName: string,
    message: IncomingMessage,
  ): string {
    return JSON.stringify([
      channelName,
      message.accountId,
      message.conversationId,
      message.threadId ?? null,
    ]);
  }

  static logicalMessageId(
    channelName: string,
    message: IncomingMessage,
  ): string {
    return JSON.stringify([
      channelName,
      message.accountId,
      message.transportEventId,
    ]);
  }

  acceptIngress(
    channelName: string,
    message: IncomingMessage,
  ): AcceptIngressResult {
    const conversationKey = ChannelStore.conversationKey(channelName, message);
    const logicalMessageId = ChannelStore.logicalMessageId(
      channelName,
      message,
    );
    const turnId = randomUUID();
    const now = Date.now();
    const { raw: _raw, ...durableMessage } = message;
    const payload = JSON.stringify(durableMessage);
    const accept = this.db.transaction(() => {
      this.assertLeaseOwned();
      const existing = this.db
        .prepare(
          "SELECT status FROM channel_ingress WHERE logical_message_id = ?",
        )
        .get(logicalMessageId) as StatusRow | undefined;
      if (existing) return false;

      this.db
        .prepare(
          `INSERT INTO channel_turn_queue
           (id, conversation_key, logical_message_id, channel_name, account_id,
            payload_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          turnId,
          conversationKey,
          logicalMessageId,
          channelName,
          message.accountId,
          payload,
          now,
          now,
        );
      // The durable turn row is the recovery authority. Ingress can be adopted
      // in the same transaction without waiting for model execution.
      this.db
        .prepare(
          `INSERT INTO channel_ingress
           (logical_message_id, transport_event_id, channel_name, account_id,
            conversation_key, payload_json, status, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'adopted', ?, ?)`,
        )
        .run(
          logicalMessageId,
          message.transportEventId,
          channelName,
          message.accountId,
          conversationKey,
          payload,
          message.receivedAt,
          now,
        );
      return true;
    });

    const accepted = accept();
    return {
      accepted,
      conversationKey,
      logicalMessageId,
      ...(accepted ? { turnId } : {}),
    };
  }

  rejectIngress(
    channelName: string,
    message: IncomingMessage,
    safeReply: string,
  ): RejectIngressResult {
    const conversationKey = ChannelStore.conversationKey(channelName, message);
    const logicalMessageId = ChannelStore.logicalMessageId(
      channelName,
      message,
    );
    const turnId = randomUUID();
    const outboxId = randomUUID();
    const now = Date.now();
    const { raw: _raw, ...routingMessage } = message;
    const durableMessage = { ...routingMessage, text: "[guardrail-blocked]" };
    const outgoing: OutgoingMessage = {
      conversationId: message.conversationId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.replyToMessageId
        ? { replyToMessageId: message.replyToMessageId }
        : {}),
      ...(message.replyInThread
        ? { replyInThread: message.replyInThread }
        : {}),
      text: safeReply,
      deliveryId: outboxId,
    };
    const reject = this.db.transaction(() => {
      this.assertLeaseOwned();
      const existing = this.db
        .prepare(
          "SELECT status FROM channel_ingress WHERE logical_message_id = ?",
        )
        .get(logicalMessageId) as StatusRow | undefined;
      if (existing) return false;
      const payload = JSON.stringify(durableMessage);
      this.db
        .prepare(
          `INSERT INTO channel_turn_queue
           (id, conversation_key, logical_message_id, channel_name, account_id,
            payload_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
        )
        .run(
          turnId,
          conversationKey,
          logicalMessageId,
          channelName,
          message.accountId,
          payload,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO channel_ingress
           (logical_message_id, transport_event_id, channel_name, account_id,
            conversation_key, payload_json, status, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'adopted', ?, ?)`,
        )
        .run(
          logicalMessageId,
          message.transportEventId,
          channelName,
          message.accountId,
          conversationKey,
          payload,
          message.receivedAt,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO channel_outbox
           (id, conversation_key, turn_id, channel_name, payload_json,
            status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          outboxId,
          conversationKey,
          turnId,
          channelName,
          JSON.stringify(outgoing),
          now,
          now,
        );
      return true;
    });
    const accepted = reject();
    return {
      accepted,
      conversationKey,
      logicalMessageId,
      ...(accepted
        ? {
            turnId,
            outbox: {
              id: outboxId,
              channelName,
              conversationKey,
              turnId,
              message: outgoing,
              status: "pending" as const,
              attempts: 0,
            },
          }
        : {}),
    };
  }

  listPendingConversationKeys(): string[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_key FROM channel_turn_queue
         WHERE status = 'pending' GROUP BY conversation_key ORDER BY MIN(sequence)`,
      )
      .all() as Array<{ conversation_key: string }>;
    return rows.map((row) => row.conversation_key);
  }

  pendingChannelForConversation(conversationKey: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT channel_name FROM channel_turn_queue
         WHERE conversation_key = ? AND status = 'pending'
         ORDER BY sequence LIMIT 1`,
      )
      .get(conversationKey) as { channel_name: string } | undefined;
    return row?.channel_name;
  }

  hasFailedTurn(conversationKey: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS found FROM channel_turn_queue WHERE conversation_key = ? AND status = 'failed' LIMIT 1",
      )
      .get(conversationKey) as { found: number } | undefined;
    return row !== undefined;
  }

  claimNextTurn(conversationKey: string): QueuedTurn | undefined {
    const claim = this.db.transaction(() => {
      this.assertLeaseOwned();
      const row = this.db
        .prepare(
          `SELECT id, channel_name, account_id, conversation_key,
                  logical_message_id, payload_json, status
           FROM channel_turn_queue
           WHERE conversation_key = ? AND status = 'pending'
           ORDER BY sequence LIMIT 1`,
        )
        .get(conversationKey) as TurnRow | undefined;
      if (!row) return undefined;
      const changed = this.db
        .prepare(
          "UPDATE channel_turn_queue SET status = 'running', updated_at = ?, owner_token = ? WHERE id = ? AND status = 'pending'",
        )
        .run(Date.now(), this.ownerToken, row.id);
      return changed.changes === 1
        ? { ...row, status: "running" as const }
        : undefined;
    });
    const row = claim();
    if (!row) return undefined;
    return {
      id: row.id,
      channelName: row.channel_name,
      accountId: row.account_id,
      conversationKey: row.conversation_key,
      logicalMessageId: row.logical_message_id,
      message: JSON.parse(row.payload_json) as IncomingMessage,
      status: row.status,
    };
  }

  appendTurnMessages(
    conversationKey: string,
    turnId: string,
    messages: readonly ModelMessage[],
    startPosition: number,
  ): void {
    this.assertLeaseOwned();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO channel_session_messages
       (conversation_key, turn_id, position, message_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const append = this.db.transaction(() => {
      const now = Date.now();
      for (const [offset, message] of messages.entries()) {
        insert.run(
          conversationKey,
          turnId,
          startPosition + offset,
          JSON.stringify(message),
          now,
        );
      }
    });
    append();
  }

  loadConversation(conversationKey: string): ModelMessage[] {
    return this.loadConversationContext(conversationKey).messages;
  }

  loadConversationContext(conversationKey: string): ConversationContext {
    const projection = this.db
      .prepare(
        `SELECT source_sequence, messages_json, timestamps_json, summary
         FROM channel_context_projection WHERE conversation_key = ?`,
      )
      .get(conversationKey) as ContextProjectionRow | undefined;
    const projectedMessages = projection
      ? (JSON.parse(projection.messages_json) as ModelMessage[])
      : [];
    const projectedTimestamps = projection
      ? (JSON.parse(projection.timestamps_json) as number[])
      : [];
    const rows = this.db
      .prepare(
        `SELECT sequence, message_json, created_at
         FROM channel_session_messages
         WHERE conversation_key = ? AND sequence > ? ORDER BY sequence`,
      )
      .all(conversationKey, projection?.source_sequence ?? 0) as MessageRow[];
    const messages = [
      ...projectedMessages,
      ...rows.map((row) => JSON.parse(row.message_json) as ModelMessage),
    ];
    const timestamps = new Map<number, number>();
    for (const [index, timestamp] of projectedTimestamps.entries()) {
      timestamps.set(index, timestamp);
    }
    for (const [offset, row] of rows.entries()) {
      timestamps.set(projectedMessages.length + offset, row.created_at);
    }
    const sourceSequence =
      rows.at(-1)?.sequence ?? projection?.source_sequence ?? 0;
    return {
      messages,
      timestamps,
      sourceSequence,
      ...(projection?.summary ? { summary: projection.summary } : {}),
    };
  }

  /** Persist the active model view while retaining immutable session messages. */
  saveContextProjection(
    conversationKey: string,
    context: ConversationContext,
  ): void {
    this.assertLeaseOwned();
    const timestamps = context.messages.map(
      (_, index) => context.timestamps.get(index) ?? Date.now(),
    );
    this.db
      .prepare(
        `INSERT INTO channel_context_projection
         (conversation_key, source_sequence, messages_json, timestamps_json,
          summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_key) DO UPDATE SET
           source_sequence = excluded.source_sequence,
           messages_json = excluded.messages_json,
           timestamps_json = excluded.timestamps_json,
           summary = excluded.summary,
           updated_at = excluded.updated_at
         WHERE excluded.source_sequence >= channel_context_projection.source_sequence`,
      )
      .run(
        conversationKey,
        context.sourceSequence,
        JSON.stringify(context.messages),
        JSON.stringify(timestamps),
        context.summary ?? null,
        Date.now(),
      );
  }

  completeTurnWithOutbox(
    turn: QueuedTurn,
    assistantMessages: readonly ModelMessage[],
    replyText: string,
    startPosition = 1,
    options: { review?: OutgoingMessage["review"] } = {},
  ): OutboxEntry | undefined {
    const complete = this.db.transaction(() => {
      this.assertLeaseOwned();
      this.appendTurnMessages(
        turn.conversationKey,
        turn.id,
        assistantMessages,
        startPosition,
      );
      let outbox: OutboxEntry | undefined;
      if (replyText) {
        const id = randomUUID();
        const message: OutgoingMessage = {
          conversationId: turn.message.conversationId,
          ...(turn.message.threadId ? { threadId: turn.message.threadId } : {}),
          ...(turn.message.replyToMessageId
            ? { replyToMessageId: turn.message.replyToMessageId }
            : {}),
          ...(turn.message.replyInThread
            ? { replyInThread: turn.message.replyInThread }
            : {}),
          text: replyText,
          deliveryId: id,
          ...(options.review ? { review: options.review } : {}),
        };
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO channel_outbox
             (id, conversation_key, turn_id, channel_name, payload_json,
              status, attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .run(
            id,
            turn.conversationKey,
            turn.id,
            turn.channelName,
            JSON.stringify(message),
            now,
            now,
          );
        outbox = {
          id,
          channelName: turn.channelName,
          conversationKey: turn.conversationKey,
          turnId: turn.id,
          message,
          status: "pending",
          attempts: 0,
        };
      }
      const changed = this.db
        .prepare(
          "UPDATE channel_turn_queue SET status = 'completed', updated_at = ?, last_error = NULL, owner_token = NULL WHERE id = ? AND status = 'running' AND owner_token = ?",
        )
        .run(Date.now(), turn.id, this.ownerToken);
      if (changed.changes !== 1) {
        throw new Error(`Turn ${turn.id} lost running ownership before commit`);
      }
      return outbox;
    });
    return complete();
  }

  failTurn(turnId: string, error: unknown): void {
    this.assertLeaseOwned();
    this.db
      .prepare(
        "UPDATE channel_turn_queue SET status = 'failed', updated_at = ?, last_error = ?, owner_token = NULL WHERE id = ? AND status = 'running' AND owner_token = ?",
      )
      .run(Date.now(), errorMessage(error), turnId, this.ownerToken);
  }

  releaseTurn(turnId: string): void {
    this.assertLeaseOwned();
    this.db
      .prepare(
        "UPDATE channel_turn_queue SET status = 'pending', updated_at = ?, owner_token = NULL WHERE id = ? AND status = 'running' AND owner_token = ?",
      )
      .run(Date.now(), turnId, this.ownerToken);
  }

  listOutboxConversationKeys(channelName?: string): string[] {
    const clause = channelName ? "AND channel_name = ?" : "";
    const rows = this.db
      .prepare(
        `SELECT conversation_key
         FROM channel_outbox
         WHERE status IN ('pending', 'failed', 'unknown') ${clause}
         GROUP BY conversation_key ORDER BY MIN(sequence)`,
      )
      .all(...(channelName ? [channelName] : [])) as Array<{
      conversation_key: string;
    }>;
    return rows.map((row) => row.conversation_key);
  }

  nextDeliverableOutbox(conversationKey: string): OutboxEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT id, channel_name, conversation_key, turn_id, payload_json,
                status, attempts
         FROM channel_outbox
         WHERE conversation_key = ? AND status IN ('pending', 'failed', 'unknown')
         ORDER BY sequence LIMIT 1`,
      )
      .get(conversationKey) as OutboxRow | undefined;
    if (!row || row.status === "unknown") return undefined;
    return outboxFromRow(row);
  }

  claimOutbox(id: string): OutboxEntry | undefined {
    const claim = this.db.transaction(() => {
      this.assertLeaseOwned();
      const row = this.db
        .prepare(
          `SELECT id, channel_name, conversation_key, turn_id, payload_json,
                  status, attempts
           FROM channel_outbox WHERE id = ? AND status IN ('pending', 'failed')`,
        )
        .get(id) as OutboxRow | undefined;
      if (!row) return undefined;
      const changed = this.db
        .prepare(
          `UPDATE channel_outbox
           SET status = 'sending', attempts = attempts + 1, updated_at = ?, owner_token = ?
           WHERE id = ? AND status IN ('pending', 'failed')`,
        )
        .run(Date.now(), this.ownerToken, id);
      if (changed.changes !== 1) return undefined;
      return { ...row, status: "sending" as const, attempts: row.attempts + 1 };
    });
    const row = claim();
    return row ? outboxFromRow(row) : undefined;
  }

  completeOutbox(id: string, platformMessageId: string): void {
    this.assertLeaseOwned();
    const changed = this.db
      .prepare(
        `UPDATE channel_outbox
         SET status = 'delivered', updated_at = ?, last_error = NULL,
             platform_message_id = ?, owner_token = NULL
         WHERE id = ? AND status = 'sending' AND owner_token = ?`,
      )
      .run(Date.now(), platformMessageId, id, this.ownerToken);
    if (changed.changes !== 1) {
      throw new ChannelStoreLeaseError(
        `Outbox ${id} lost sending ownership before commit`,
      );
    }
  }

  failOutbox(id: string, status: "failed" | "unknown", error: unknown): void {
    this.assertLeaseOwned();
    this.db
      .prepare(
        "UPDATE channel_outbox SET status = ?, updated_at = ?, last_error = ?, owner_token = NULL WHERE id = ? AND status = 'sending' AND owner_token = ?",
      )
      .run(status, Date.now(), errorMessage(error), id, this.ownerToken);
  }

  getTurnStatus(turnId: string): TurnQueueStatus | undefined {
    const row = this.db
      .prepare("SELECT status FROM channel_turn_queue WHERE id = ?")
      .get(turnId) as StatusRow | undefined;
    return row?.status as TurnQueueStatus | undefined;
  }

  getOutboxStatus(id: string): OutboxStatus | undefined {
    const row = this.db
      .prepare("SELECT status FROM channel_outbox WHERE id = ?")
      .get(id) as StatusRow | undefined;
    return row?.status as OutboxStatus | undefined;
  }

  getChannelStats(channelName: string): ChannelQueueStats {
    const turnRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM channel_turn_queue
         WHERE channel_name = ? AND status IN ('pending', 'failed') GROUP BY status`,
      )
      .all(channelName) as Array<{ status: TurnQueueStatus; count: number }>;
    const outboxRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM channel_outbox
         WHERE channel_name = ? AND status IN ('pending', 'failed', 'unknown') GROUP BY status`,
      )
      .all(channelName) as Array<{ status: OutboxStatus; count: number }>;
    const turnCount = (status: TurnQueueStatus) =>
      turnRows.find((row) => row.status === status)?.count ?? 0;
    const outboxCount = (status: OutboxStatus) =>
      outboxRows.find((row) => row.status === status)?.count ?? 0;
    return {
      pendingTurns: turnCount("pending"),
      failedTurns: turnCount("failed"),
      pendingDeliveries: outboxCount("pending"),
      failedDeliveries: outboxCount("failed"),
      unknownDeliveries: outboxCount("unknown"),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    try {
      this.db
        .prepare(
          "DELETE FROM channel_gateway_lease WHERE id = 1 AND owner_token = ?",
        )
        .run(this.ownerToken);
    } finally {
      this.db.close();
    }
  }
}

function outboxFromRow(row: OutboxRow): OutboxEntry {
  return {
    id: row.id,
    channelName: row.channel_name,
    conversationKey: row.conversation_key,
    turnId: row.turn_id,
    message: JSON.parse(row.payload_json) as OutgoingMessage,
    status: row.status,
    attempts: row.attempts,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
