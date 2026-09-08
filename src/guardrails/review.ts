import { createHash, randomBytes } from "node:crypto";
import type { GuardrailDecision, GuardrailSeverity } from "./types.js";

export interface ReviewBinding {
  actorId: string;
  conversationId: string;
  requestHash: string;
  policyVersion: string;
}

export interface ReviewRecovery {
  text: string;
  channel?: {
    channelName: string;
    conversationKey: string;
    conversationId: string;
    threadId?: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
  };
}

interface ReviewRecord extends ReviewBinding {
  tokenHash: string;
  expiresAt: number;
  status: "pending" | "approved";
  recovery: ReviewRecovery;
}

export interface OwnerReviewManagerOptions {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
}

const SEVERITY_RANK: Record<GuardrailSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export class OwnerReviewManager {
  private readonly records = new Map<string, ReviewRecord>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: OwnerReviewManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.capacity = options.capacity ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  create(
    decision: GuardrailDecision,
    binding: ReviewBinding,
    recovery: ReviewRecovery = { text: "" },
  ): { token: string; expiresAt: string } {
    this.pruneExpired();
    if (!isReviewable(decision)) {
      throw new Error("Mandatory or high-risk decisions cannot be reviewed");
    }
    if (
      !binding.requestHash ||
      binding.policyVersion !== decision.policyVersion
    ) {
      throw new Error("Review binding does not match the policy decision");
    }
    const token = randomBytes(24).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = this.now() + this.ttlMs;
    this.records.set(tokenHash, {
      tokenHash,
      ...binding,
      expiresAt,
      status: "pending",
      recovery,
    });
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      this.records.delete(oldest);
    }
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  approve(
    token: string,
    binding: Omit<ReviewBinding, "requestHash"> & { requestHash?: string },
  ): boolean {
    this.pruneExpired();
    const record = this.records.get(hashToken(token));
    if (
      record?.status !== "pending" ||
      record.expiresAt <= this.now() ||
      record.actorId !== binding.actorId ||
      record.conversationId !== binding.conversationId ||
      record.policyVersion !== binding.policyVersion ||
      (binding.requestHash !== undefined &&
        record.requestHash !== binding.requestHash)
    ) {
      return false;
    }
    record.status = "approved";
    return true;
  }

  consume(token: string, binding: ReviewBinding): boolean {
    this.pruneExpired();
    const tokenHash = hashToken(token);
    const record = this.records.get(tokenHash);
    if (
      record?.status !== "approved" ||
      record.expiresAt <= this.now() ||
      !sameBinding(record, binding)
    ) {
      return false;
    }
    this.records.delete(tokenHash);
    return true;
  }

  approvedRecovery(
    token: string,
    binding: Omit<ReviewBinding, "requestHash"> & { requestHash?: string },
  ):
    | { reviewId: string; binding: ReviewBinding; recovery: ReviewRecovery }
    | undefined {
    this.pruneExpired();
    const reviewId = hashToken(token);
    const record = this.records.get(reviewId);
    if (
      record?.status !== "approved" ||
      record.expiresAt <= this.now() ||
      record.actorId !== binding.actorId ||
      record.conversationId !== binding.conversationId ||
      record.policyVersion !== binding.policyVersion ||
      (binding.requestHash !== undefined &&
        record.requestHash !== binding.requestHash)
    ) {
      return undefined;
    }
    return {
      reviewId,
      binding: {
        actorId: record.actorId,
        conversationId: record.conversationId,
        requestHash: record.requestHash,
        policyVersion: record.policyVersion,
      },
      recovery: record.recovery,
    };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [tokenHash, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(tokenHash);
    }
  }
}

export function isReviewable(decision: GuardrailDecision): boolean {
  if (decision.findings.length === 0) return false;
  if (decision.findings.some((finding) => finding.mandatory)) return false;
  return decision.findings.every(
    (finding) => SEVERITY_RANK[finding.severity] <= SEVERITY_RANK.medium,
  );
}

function sameBinding(record: ReviewRecord, binding: ReviewBinding): boolean {
  return (
    record.actorId === binding.actorId &&
    record.conversationId === binding.conversationId &&
    record.requestHash === binding.requestHash &&
    record.policyVersion === binding.policyVersion
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
