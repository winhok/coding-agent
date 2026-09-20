import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliUsageError, formatHelp, parseCliArgs } from "../src/cli/args.ts";
import { CLI_EXIT, type CliExecutionResult, runCli } from "../src/cli/run.ts";

describe("CLI interface", () => {
  it("parses interactive, ask, plan, help and version requests", () => {
    assert.deepEqual(parseCliArgs([]), {
      command: "interactive",
      continueSession: false,
      approvalMode: "ask",
    });
    assert.deepEqual(parseCliArgs(["ask", "检查", "项目", "--json"]), {
      command: "ask",
      prompt: "检查 项目",
      output: "json",
      continueSession: false,
      approvalMode: "never",
    });
    assert.deepEqual(parseCliArgs(["plan", "重构", "--continue"]), {
      command: "plan",
      prompt: "重构",
      output: "text",
      continueSession: true,
      approvalMode: "never",
    });
    assert.deepEqual(parseCliArgs(["--help"]), { command: "help" });
    assert.deepEqual(parseCliArgs(["--version"]), { command: "version" });
  });

  it("rejects unknown options, missing tasks and unsafe implicit approvals", () => {
    assert.throws(() => parseCliArgs(["--wat"]), CliUsageError);
    assert.throws(() => parseCliArgs(["ask"]), /需要提供任务描述/);
    assert.throws(
      () => parseCliArgs(["ask", "work", "--approval-mode", "ask"]),
      /非交互模式不支持 ask 审批/,
    );
    assert.throws(
      () => parseCliArgs(["--no-confirm"]),
      /未知选项: --no-confirm/,
    );
  });

  it("documents safe non-interactive defaults and plan isolation", () => {
    const help = formatHelp("1.2.3");
    assert.match(help, /ask\/plan 默认 approval-mode=never/);
    assert.match(help, /ask 只开放只读工具/);
    assert.match(help, /plan 在执行层只开放只读工具/);
    assert.match(help, /130 收到 SIGINT/);
    assert.match(help, /143 收到 SIGTERM/);
    assert.match(help, /coding-agent v1\.2\.3/);
  });

  it("passes explicit execution policy to the runtime", async () => {
    let received: unknown;
    const exitCode = await runCli(
      ["ask", "implement", "--approval-mode", "always"],
      { stdout: () => {}, stderr: () => {} },
      {
        version: "1.0.0",
        loadInit: async () => ({ runInit: async () => {} }),
        loadAgent: async () => ({
          startAgent: async (options) => {
            received = options;
            return undefined;
          },
        }),
      },
    );

    assert.equal(exitCode, CLI_EXIT.success);
    assert.deepEqual(received, {
      mode: "ask",
      prompt: "implement",
      output: "quiet",
      continueSession: false,
      approvalMode: "always",
    });
  });

  it("keeps JSON stdout machine-readable and maps status to exit codes", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const completed: CliExecutionResult = {
      status: "completed",
      answer: "完成",
      termination: "completed",
      stats: {
        steps: 1,
        toolCalls: 0,
        retries: 0,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      tracePath: ".traces/test.jsonl",
    };
    const exitCode = await runCli(
      ["ask", "test", "--json"],
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      {
        version: "1.0.0",
        loadInit: async () => ({ runInit: async () => {} }),
        loadAgent: async () => ({
          startAgent: async () => {
            console.log("diagnostic");
            return completed;
          },
        }),
      },
    );

    assert.equal(exitCode, CLI_EXIT.success);
    assert.deepEqual(JSON.parse(stdout.join("")), completed);
    assert.match(stderr.join(""), /diagnostic/);
  });

  it("returns stable codes for usage, incomplete and permission failures", async () => {
    const silent = { stdout: () => {}, stderr: () => {} };
    const base: CliExecutionResult = {
      status: "incomplete",
      answer: "partial",
      termination: "max_steps",
      stats: {
        steps: 50,
        toolCalls: 1,
        retries: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      tracePath: "trace",
    };
    const dependencies = {
      version: "1.0.0",
      loadInit: async () => ({ runInit: async () => {} }),
      loadAgent: async () => ({ startAgent: async () => base }),
    };

    assert.equal(await runCli(["wat"], silent, dependencies), CLI_EXIT.error);
    assert.equal(
      await runCli(["ask", "work"], silent, dependencies),
      CLI_EXIT.incomplete,
    );
    base.status = "permission_denied";
    assert.equal(
      await runCli(["ask", "work"], silent, dependencies),
      CLI_EXIT.permissionDenied,
    );
  });
});
