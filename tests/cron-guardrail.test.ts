import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CronService } from "../src/cron/service.ts";
import { GuardrailAuditStore } from "../src/guardrails/audit.ts";
import { GuardrailService } from "../src/guardrails/service.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

describe("cron guardrail behavior", () => {
  it("blocks mandatory input without invoking the agent and pauses retries", async () => {
    const dir = makeTempDir("cron-guardrail-input-");
    const notifications: string[] = [];
    let agentCalls = 0;
    const service = new CronService(dir, { guardrails: guardrailService() });
    service.add(agentJob("blocked", "bypass guardrails"));
    service.setExecutor({
      runAgentPrompt: async () => {
        agentCalls++;
        return "should not run";
      },
      notify: (message) => notifications.push(message),
    });

    try {
      const output = await service.runNow("blocked");
      const second = await service.runNow("blocked");

      assert.equal(agentCalls, 0);
      assert.match(output, /安全保护/);
      assert.match(second, /已暂停/);
      assert.equal(service.list()[0]?.status, "paused");
      assert.equal(service.getRecentLogs("blocked")[0]?.status, "blocked");
      assert.doesNotMatch(JSON.stringify(notifications), /bypass guardrails/);
    } finally {
      service.stop();
      cleanupTempDir(dir);
    }
  });

  it("persists review-required as a paused state instead of retrying or failing", async () => {
    const dir = makeTempDir("cron-guardrail-review-");
    const first = new CronService(dir, { guardrails: guardrailService() });
    first.add(agentJob("review", "publish report"));
    first.setExecutor({
      runAgentPrompt: async () => ({
        status: "review_required",
        output: "需要 Owner 审批",
      }),
    });

    try {
      assert.match(await first.runNow("review"), /Owner 审批/);
      assert.equal(first.list()[0]?.status, "paused");
      first.stop();

      const restarted = new CronService(dir, {
        guardrails: guardrailService(),
      });
      restarted.load();
      let reran = false;
      restarted.setExecutor({
        runAgentPrompt: async () => {
          reran = true;
          return "reran";
        },
      });
      assert.equal(restarted.list()[0]?.status, "paused");
      assert.match(await restarted.runNow("review"), /已暂停/);
      assert.equal(reran, false);
      restarted.stop();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("checks output before notification and preserves passing behavior", async () => {
    const dir = makeTempDir("cron-guardrail-output-");
    const notifications: string[] = [];
    const service = new CronService(dir, { guardrails: guardrailService() });
    service.add(agentJob("passing", "summarize"));
    service.add(agentJob("secret", "summarize secrets"));
    service.setExecutor({
      runAgentPrompt: async (prompt) =>
        prompt === "summarize"
          ? { status: "completed", output: "safe result" }
          : {
              status: "completed",
              output: "sk-synthetic_12345678901234567890",
            },
      notify: (message) => notifications.push(message),
    });

    try {
      assert.equal(await service.runNow("passing"), "safe result");
      const blocked = await service.runNow("secret");

      assert.match(blocked, /安全保护/);
      assert.equal(service.getRecentLogs("passing")[0]?.status, "success");
      assert.equal(service.getRecentLogs("secret")[0]?.status, "blocked");
      assert.doesNotMatch(JSON.stringify(notifications), /sk-synthetic_/);
      assert.match(JSON.stringify(notifications), /safe result/);
    } finally {
      service.stop();
      cleanupTempDir(dir);
    }
  });
});

function guardrailService() {
  return new GuardrailService({
    enabled: true,
    policyVersion: "test-v1",
    audit: new GuardrailAuditStore(),
  });
}

function agentJob(id: string, prompt: string) {
  return {
    id,
    name: id,
    schedule: "every 1h",
    scheduleType: "interval" as const,
    enabled: true,
    payload: { type: "agent" as const, prompt },
    source: "runtime" as const,
  };
}
