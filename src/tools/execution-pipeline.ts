import Ajv, { type ValidateFunction } from "ajv";
import type { AgentRunContext } from "../agent/run-context.js";
import { abortReason, raceWithAbort } from "../security/abort.js";
import type { HookPipeline } from "../security/hooks.js";
import {
  decideToolPermission,
  type PermissionLevel,
  type RequestApproval,
} from "../security/permissions.js";
import type { ToolCapability } from "./capabilities.js";

export const DEFAULT_MAX_RESULT_CHARS = 3000;
const MAX_AUDIT_ENTRIES = 1000;
const MAX_AUDIT_STRING_CHARS = 1000;
const SENSITIVE_AUDIT_KEY =
  /(?:authorization|cookie|password|secret|token|api[_-]?key)/i;

export interface ExecutableTool {
  name: string;
  parameters: Record<string, unknown>;
  capabilities?: ToolCapability[];
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  holdsExecutionLock?: boolean;
  maxResultChars?: number;
  execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<unknown>;
}

export interface ToolExecutionContext extends AgentRunContext {
  toolName?: string;
  toolCallId?: string;
}

export type { ToolCapability } from "./capabilities.js";

interface ExecuteOptions {
  useLocks: boolean;
  hookPipeline: HookPipeline | undefined;
  authorize: (toolName: string, input: unknown) => boolean;
  requestApproval: RequestApproval | undefined;
  executionContext: ToolExecutionContext;
}

export type ToolExecutionOutcome =
  | "completed"
  | "aborted"
  | "blocked"
  | "invalid"
  | "denied"
  | "failed";

export interface ToolExecutionAuditEntry {
  timestamp: number;
  durationMs: number;
  tool: string;
  input: unknown;
  outcome: ToolExecutionOutcome;
  reason?: string;
  permission?: {
    level: PermissionLevel;
    approval:
      | "not_required"
      | "approved"
      | "rejected"
      | "cancelled"
      | "unavailable";
  };
}

/**
 * Runs tools through the registry's execution policy in one place.
 *
 * Inputs are already parsed by the AI SDK. The pipeline then applies pre hooks,
 * validates the final input, authorizes and classifies that final input, acquires
 * the concurrency lock, executes, post-processes, and records the outcome.
 */
export class ToolExecutionPipeline {
  private ajv = new Ajv({ allErrors: true, strict: false });
  private validators = new WeakMap<ExecutableTool, ValidateFunction>();
  private auditLog: ToolExecutionAuditEntry[] = [];
  private exclusiveLock = false;
  private concurrentCount = 0;
  private waitQueue: Array<() => void> = [];

  async execute(
    tool: ExecutableTool,
    input: unknown,
    {
      useLocks,
      hookPipeline,
      authorize,
      requestApproval,
      executionContext,
    }: ExecuteOptions,
  ): Promise<string> {
    const startedAt = Date.now();
    const safeAuditInput = (value: unknown) =>
      executionContext.toolGuardrail?.redact(value) ?? value;
    executionContext.signal.throwIfAborted();
    await executionContext.inputEffectGate?.wait(executionContext.signal);
    executionContext.signal.throwIfAborted();

    if (hookPipeline) {
      const preResult = await hookPipeline.runPre(tool.name, input);
      if (preResult.action === "block") {
        const reason = preResult.reason || "操作被阻止";
        this.recordAudit(
          tool.name,
          safeAuditInput(input),
          "blocked",
          startedAt,
          reason,
        );
        return `[Hook 拦截] ${reason}`;
      }
      if (
        preResult.action === "modify" &&
        preResult.modifiedInput !== undefined
      ) {
        input = preResult.modifiedInput;
      }
      executionContext.signal.throwIfAborted();
    }

    const validationError = this.validateInput(tool, input);
    if (validationError) {
      this.recordAudit(
        tool.name,
        safeAuditInput(input),
        "invalid",
        startedAt,
        validationError,
      );
      return `[参数校验失败] ${tool.name}: ${validationError}`;
    }
    const validatedInput = input as Record<string, unknown>;

    if (!authorize(tool.name, validatedInput)) {
      const reason = "当前角色无权使用此工具";
      this.recordAudit(
        tool.name,
        safeAuditInput(validatedInput),
        "denied",
        startedAt,
        reason,
        { level: "deny", approval: "not_required" },
      );
      return `[拒绝执行] ${reason}: ${tool.name}`;
    }

    const guardrailDecision = executionContext.toolGuardrail?.check({
      tool: tool.name,
      input: validatedInput,
      workingDir: executionContext.workingDir,
    });
    if (guardrailDecision) {
      await executionContext.reportGuardrailDecision?.(
        "tool",
        guardrailDecision,
      );
    }
    if (guardrailDecision?.outcome === "blocked") {
      const reason =
        executionContext.toolGuardrail?.rejection(guardrailDecision);
      this.recordAudit(
        tool.name,
        safeAuditInput(validatedInput),
        "blocked",
        startedAt,
        reason,
      );
      return `[安全保护] ${reason}`;
    }

    const decision = decideToolPermission(tool, validatedInput);
    let approval: NonNullable<
      ToolExecutionAuditEntry["permission"]
    >["approval"] = "not_required";

    if (decision.level === "deny") {
      this.recordAudit(
        tool.name,
        safeAuditInput(validatedInput),
        "denied",
        startedAt,
        decision.reason,
        { level: decision.level, approval },
      );
      return `[拒绝执行] ${decision.reason}: ${tool.name}`;
    }

    if (decision.level === "ask") {
      if (!requestApproval) {
        const reason = `${decision.reason}，但当前运行环境没有审批通道`;
        this.recordAudit(
          tool.name,
          safeAuditInput(validatedInput),
          "denied",
          startedAt,
          reason,
          { level: decision.level, approval: "unavailable" },
        );
        return `[拒绝执行] ${reason}: ${tool.name}`;
      }

      let approved = false;
      try {
        approved = await raceWithAbort(
          requestApproval({
            tool: tool.name,
            input: validatedInput,
            reason: decision.reason,
            ...(executionContext.toolCallId
              ? { toolCallId: executionContext.toolCallId }
              : {}),
            signal: executionContext.signal,
          }),
          executionContext.signal,
        );
        executionContext.signal.throwIfAborted();
      } catch (error) {
        if (executionContext.signal.aborted) {
          const reason = abortReason(executionContext.signal);
          this.recordAudit(
            tool.name,
            safeAuditInput(validatedInput),
            "aborted",
            startedAt,
            reason.message,
            { level: decision.level, approval: "cancelled" },
          );
          throw reason;
        }
        const message = error instanceof Error ? error.message : String(error);
        const reason = `${decision.reason}，审批失败: ${message}`;
        this.recordAudit(
          tool.name,
          safeAuditInput(validatedInput),
          "denied",
          startedAt,
          reason,
          { level: decision.level, approval: "unavailable" },
        );
        return `[拒绝执行] ${reason}: ${tool.name}`;
      }

      approval = approved ? "approved" : "rejected";
      if (!approved) {
        const reason = `用户拒绝: ${decision.reason}`;
        this.recordAudit(
          tool.name,
          safeAuditInput(validatedInput),
          "denied",
          startedAt,
          reason,
          { level: decision.level, approval },
        );
        return `[拒绝执行] ${reason}: ${tool.name}`;
      }
    }

    const permission = { level: decision.level, approval };

    if (useLocks) {
      if (tool.isConcurrencySafe === true) {
        await this.acquireConcurrent();
      } else {
        await this.acquireExclusive();
      }
    }

    try {
      executionContext.signal.throwIfAborted();
      const raw = await tool.execute(validatedInput, executionContext);
      executionContext.signal.throwIfAborted();
      const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
      let output = truncateResult(text, tool.maxResultChars);

      if (hookPipeline) {
        const postResult = await hookPipeline.runPost(
          tool.name,
          validatedInput,
          output,
        );
        if (postResult.modifiedOutput !== undefined) {
          output = String(postResult.modifiedOutput);
        }
        executionContext.signal.throwIfAborted();
      }

      const redactedOutput = executionContext.toolGuardrail?.redact(output);
      if (redactedOutput !== undefined) output = String(redactedOutput);

      this.recordAudit(
        tool.name,
        safeAuditInput(validatedInput),
        "completed",
        startedAt,
        undefined,
        permission,
      );
      return output;
    } catch (error) {
      const aborted = executionContext.signal.aborted;
      this.recordAudit(
        tool.name,
        safeAuditInput(validatedInput),
        aborted ? "aborted" : "failed",
        startedAt,
        error instanceof Error ? error.message : String(error),
        permission,
      );
      throw error;
    } finally {
      if (useLocks) {
        if (tool.isConcurrencySafe === true) {
          this.releaseConcurrent();
        } else {
          this.releaseExclusive();
        }
      }
    }
  }

  getAuditLog(): readonly ToolExecutionAuditEntry[] {
    return [...this.auditLog];
  }

  private validateInput(
    tool: ExecutableTool,
    input: unknown,
  ): string | undefined {
    try {
      let validate = this.validators.get(tool);
      if (!validate) {
        validate = this.ajv.compile(tool.parameters);
        this.validators.set(tool, validate);
      }
      if (validate(input)) return undefined;
      return this.ajv.errorsText(validate.errors, { separator: "; " });
    } catch (error) {
      return `无效的工具 Schema: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private recordAudit(
    tool: string,
    input: unknown,
    outcome: ToolExecutionOutcome,
    startedAt: number,
    reason?: string,
    permission?: ToolExecutionAuditEntry["permission"],
  ): void {
    this.auditLog.push({
      timestamp: startedAt,
      durationMs: Date.now() - startedAt,
      tool,
      input: sanitizeAuditValue(input),
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(permission === undefined ? {} : { permission }),
    });
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) this.auditLog.shift();
  }

  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }
}

function sanitizeAuditValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_AUDIT_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (value.length <= MAX_AUDIT_STRING_CHARS) return value;
    return `${value.slice(0, MAX_AUDIT_STRING_CHARS)}... [TRUNCATED]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeAuditValue(item, "", depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeAuditValue(entryValue, entryKey, depth + 1),
      ]),
  );
}

export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
