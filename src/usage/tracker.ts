import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LanguageModelUsage } from "ai";

/** 官方直连实时 API 价格，单位为对应币种 / 1M tokens。 */
export type PricingCurrency = "USD" | "CNY";

export interface TokenPricingTier {
  upToInputTokens?: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelPricing {
  currency: PricingCurrency;
  tiers: readonly [TokenPricingTier, ...TokenPricingTier[]];
  /** 对显式缓存额外收取的存储费：对应币种 / 1M cached tokens / hour。 */
  cacheStorage?: number;
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
  // Anthropic Claude API；cacheWrite 使用默认 5 分钟 TTL。
  "claude-fable-5": {
    currency: "USD",
    tiers: [{ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }],
  },
  "claude-opus-5": {
    currency: "USD",
    tiers: [{ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  },
  // Sonnet 5 官方 API 推广价有效至 2026-08-31，之后恢复 3 / 15。
  "claude-sonnet-5": {
    currency: "USD",
    tiers: [{ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }],
  },
  "claude-haiku-4-5": {
    currency: "USD",
    tiers: [{ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
  },

  // OpenAI Standard API；超过 272K input tokens 时整次请求按长上下文价计费。
  "gpt-5.6-sol": {
    currency: "USD",
    tiers: [
      {
        upToInputTokens: 272_000,
        input: 5,
        output: 30,
        cacheWrite: 6.25,
        cacheRead: 0.5,
      },
      { input: 10, output: 45, cacheWrite: 12.5, cacheRead: 1 },
    ],
  },
  "gpt-5.6-terra": {
    currency: "USD",
    tiers: [
      {
        upToInputTokens: 272_000,
        input: 2.5,
        output: 15,
        cacheWrite: 3.125,
        cacheRead: 0.25,
      },
      { input: 5, output: 22.5, cacheWrite: 6.25, cacheRead: 0.5 },
    ],
  },
  "gpt-5.6-luna": {
    currency: "USD",
    tiers: [
      {
        upToInputTokens: 272_000,
        input: 1,
        output: 6,
        cacheWrite: 1.25,
        cacheRead: 0.1,
      },
      { input: 2, output: 9, cacheWrite: 2.5, cacheRead: 0.2 },
    ],
  },

  // DeepSeek 官方直连 API；缓存自动建立，不单收写入与存储费。
  "deepseek-v4-flash": {
    currency: "USD",
    tiers: [{ input: 0.14, output: 0.28, cacheWrite: 0, cacheRead: 0.0028 }],
  },
  "deepseek-v4-pro": {
    currency: "USD",
    tiers: [{ input: 0.435, output: 0.87, cacheWrite: 0, cacheRead: 0.003625 }],
  },

  // 国内厂商官方中国区按量 API，保持人民币原价，不做汇率换算。
  // Qwen3.7 Plus 2026-05-26 固定快照。当前未加显式 cache_control，
  // cacheRead 使用隐式缓存价；隐式写入不额外收费，miss 按普通 input 计价。
  "qwen3.7-plus-2026-05-26": {
    currency: "CNY",
    tiers: [
      {
        upToInputTokens: 256_000,
        input: 2,
        output: 8,
        cacheWrite: 2,
        cacheRead: 0.4,
      },
      {
        upToInputTokens: 1_000_000,
        input: 6,
        output: 24,
        cacheWrite: 6,
        cacheRead: 1.2,
      },
    ],
  },
};

function getModelPricing(model: string): ModelPricing {
  const pricing = PRICE_TABLE[model];
  if (!pricing) throw new Error(`Unknown model pricing: ${model}`);
  return pricing;
}

function inputLikeTokens(usage: StepUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function getTokenPricing(model: string, usage: StepUsage): TokenPricingTier {
  const pricing = getModelPricing(model);
  const inputTokens = inputLikeTokens(usage);
  const tier = pricing.tiers.find(
    (candidate) =>
      candidate.upToInputTokens === undefined ||
      inputTokens <= candidate.upToInputTokens,
  );
  if (!tier) throw new Error(`No pricing tier configured for model: ${model}`);
  return tier;
}

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheStorageTokenHours?: number;
}

export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: number;
  currency: PricingCurrency;
}

export class UsageTracker {
  private steps: StepRecord[] = [];
  private logPath: string | undefined;
  private currency: PricingCurrency | undefined;
  private cacheAccountingEnabled = true;

  constructor(logPath?: string) {
    this.logPath = logPath;
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  /**
   * Qwen 的隐式缓存无法从请求侧强制关闭。关闭此开关时，只把后续命中的
   * cache token 按普通 input 计价，方便用 /cache off 对比无缓存基线。
   */
  setCacheEnabled(enabled: boolean): void {
    this.cacheAccountingEnabled = enabled;
  }

  get cacheEnabled(): boolean {
    return this.cacheAccountingEnabled;
  }

  record(model: string, usage: StepUsage): StepRecord {
    const pricing = getModelPricing(model);
    if (this.currency && this.currency !== pricing.currency) {
      throw new Error(
        `Cannot mix ${this.currency} and ${pricing.currency} pricing in one tracker`,
      );
    }
    this.currency = pricing.currency;

    const billableUsage = this.cacheAccountingEnabled
      ? usage
      : {
          ...usage,
          inputTokens:
            usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
    const cost = computeCost(model, billableUsage);
    const record: StepRecord = {
      ts: Date.now(),
      model,
      cost,
      currency: pricing.currency,
      ...billableUsage,
    };
    this.steps.push(record);

    if (this.logPath) {
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
    }
    return record;
  }

  totals() {
    const t = this.steps.reduce(
      (a, s) => ({
        inputTokens: a.inputTokens + s.inputTokens,
        outputTokens: a.outputTokens + s.outputTokens,
        cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
        cacheStorageTokenHours:
          a.cacheStorageTokenHours + (s.cacheStorageTokenHours ?? 0),
        cost: a.cost + s.cost,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheStorageTokenHours: 0,
        cost: 0,
      },
    );
    const totalInputLike =
      t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0;
    // 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付
    const baselineCost = (() => {
      let c = 0;
      for (const s of this.steps) {
        const p = getTokenPricing(s.model, s);
        const inputLike = inputLikeTokens(s);
        c += (inputLike * p.input) / 1_000_000;
        c += (s.outputTokens * p.output) / 1_000_000;
      }
      return c;
    })();
    return {
      ...t,
      currency: this.currency,
      hitRate,
      baselineCost,
      savedCost: baselineCost - t.cost,
      steps: this.steps.length,
    };
  }

  recent(n: number): StepRecord[] {
    return this.steps.slice(-n);
  }
}

export function computeCost(model: string, usage: StepUsage): number {
  const pricing = getModelPricing(model);
  const p = getTokenPricing(model, usage);
  const tokenCost =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000;
  const storageCost =
    ((usage.cacheStorageTokenHours ?? 0) * (pricing.cacheStorage ?? 0)) /
    1_000_000;
  return tokenCost + storageCost;
}

export function normalizeUsage(
  usage: LanguageModelUsage | null | undefined,
): StepUsage {
  if (!usage)
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

  const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const rawInputTokens = usage.inputTokens ?? 0;
  const inputTokens =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, rawInputTokens - cacheRead - cacheWrite);

  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
