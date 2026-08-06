import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";

const SESSION_DIR = ".sessions";
const DEFAULT_SESSION = "default";

export interface SessionEntry {
  type: "message";
  timestamp: string;
  message: ModelMessage;
}

export interface LoadedSession {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
}

export function remapMessageTimestamps(
  before: ModelMessage[],
  after: ModelMessage[],
  timestamps: Map<number, number>,
  now: number = Date.now(),
): Map<number, number> {
  const byMessage = new Map<ModelMessage, number>();
  for (let index = 0; index < before.length; index++) {
    const message = before[index];
    const timestamp = timestamps.get(index);
    if (message && timestamp !== undefined) byMessage.set(message, timestamp);
  }

  const sameShape = before.length === after.length;
  const remapped = new Map<number, number>();
  for (let index = 0; index < after.length; index++) {
    const message = after[index];
    if (!message) continue;
    const timestamp =
      byMessage.get(message) ??
      (sameShape ? timestamps.get(index) : undefined) ??
      now;
    remapped.set(index, timestamp);
  }
  return remapped;
}

export class SessionStore {
  private dir: string;
  private sessionId: string;

  constructor(sessionId: string = DEFAULT_SESSION, dir: string = SESSION_DIR) {
    this.sessionId = sessionId;
    this.dir = dir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  append(message: ModelMessage, timestamp: Date = new Date()): void {
    const entry: SessionEntry = {
      type: "message",
      timestamp: timestamp.toISOString(),
      message,
    };
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  appendAll(messages: ModelMessage[]): void {
    for (const msg of messages) {
      this.append(msg);
    }
  }

  load(): LoadedSession {
    const empty: LoadedSession = {
      messages: [],
      timestamps: new Map<number, number>(),
    };
    if (!existsSync(this.filePath)) return empty;

    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return empty;

    const messages: ModelMessage[] = [];
    const timestamps = new Map<number, number>();
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === "message") {
          const index = messages.length;
          messages.push(entry.message);
          const timestamp = Date.parse(entry.timestamp);
          if (!Number.isNaN(timestamp)) timestamps.set(index, timestamp);
        }
      } catch {
        // skip malformed lines
      }
    }
    return { messages, timestamps };
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  getMessageCount(): number {
    return this.load().messages.length;
  }
}
