import Ajv, { type ValidateFunction } from "ajv";
import { classifyBashCommand } from "../security/bash-classifier.js";
import type { HookPipeline } from "../security/hooks.js";

export const DEFAULT_MAX_RESULT_CHARS = 3000;

export interface ExecutableTool {
  name: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  maxResultChars?: number;
  // biome-ignore lint/suspicious/noExplicitAny: registered tools have heterogeneous validated inputs
  execute: (input: any) => Promise<unknown>;
}

interface ExecuteOptions {
  useLocks: boolean;
  hookPipeline: HookPipeline | undefined;
  authorize: (toolName: string, input: unknown) => boolean;
}

export type ToolExecutionOutcome =
  | "completed"
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
    // biome-ignore lint/suspicious/noExplicitAny: the AI SDK validates each tool's schema before execution
    input: any,
    { useLocks, hookPipeline, authorize }: ExecuteOptions,
  ): Promise<string> {
    const startedAt = Date.now();

    if (hookPipeline) {
      const preResult = await hookPipeline.runPre(tool.name, input);
      if (preResult.action === "block") {
        const reason = preResult.reason || "操作被阻止";
        this.recordAudit(tool.name, input, "blocked", startedAt, reason);
        return `[Hook 拦截] ${reason}`;
      }
      if (
        preResult.action === "modify" &&
        preResult.modifiedInput !== undefined
      ) {
        input = preResult.modifiedInput;
      }
    }

    const validationError = this.validateInput(tool, input);
    if (validationError) {
      this.recordAudit(tool.name, input, "invalid", startedAt, validationError);
      return `[参数校验失败] ${tool.name}: ${validationError}`;
    }

    if (!authorize(tool.name, input)) {
      const reason = "当前角色无权使用此工具";
      this.recordAudit(tool.name, input, "denied", startedAt, reason);
      return `[拒绝执行] ${reason}: ${tool.name}`;
    }

    const command = getCommand(input);
    if (tool.name === "bash" && command) {
      const risk = classifyBashCommand(command);
      if (risk.level === "dangerous") {
        const reason = `检测到危险操作: ${risk.reason}`;
        this.recordAudit(tool.name, input, "denied", startedAt, reason);
        return `[拒绝执行] ${reason}\n命令: ${command}`;
      }
      if (risk.level === "moderate") {
        console.log(`  [安全] ⚠ ${risk.reason}: ${command}`);
      }
    }

    if (useLocks) {
      if (tool.isConcurrencySafe === true) {
        await this.acquireConcurrent();
      } else {
        await this.acquireExclusive();
      }
    }

    try {
      const raw = await tool.execute(input);
      const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
      let output = truncateResult(text, tool.maxResultChars);

      if (hookPipeline) {
        const postResult = await hookPipeline.runPost(tool.name, input, output);
        if (postResult.modifiedOutput !== undefined) {
          output = String(postResult.modifiedOutput);
        }
      }

      this.recordAudit(tool.name, input, "completed", startedAt);
      return output;
    } catch (error) {
      this.recordAudit(
        tool.name,
        input,
        "failed",
        startedAt,
        error instanceof Error ? error.message : String(error),
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
  ): void {
    this.auditLog.push({
      timestamp: startedAt,
      durationMs: Date.now() - startedAt,
      tool,
      input,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
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

function getCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("command" in input)) {
    return undefined;
  }
  return typeof input.command === "string" ? input.command : undefined;
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
