import {describe, expect, test} from "vitest";
import {computeTokenCost, type ModelPriceEntry, type PricingConfigV2} from "../src/lib/pricing.js";
import {computePlanCreditForLedger} from "../src/lib/ingestion/exchange-processor.js";

/**
 * 通道边界（2026-10-09 二次用户确认修订，同日撤销「market_share 例外」）：
 * 1. PAYG 促销（promotions）对官方预设通道统一生效——含 plan/subscription 与
 *    market_share 聚合订阅条目（OpenCode Go）：目录供应商行独立维护定价与促销，
 *    条目上的促销只可能是该供应商自己的官方促销，估算公式的分子（价格）与
 *    分母（额度）同价格体系、由目录同一次修订统一维护；
 *    中转站/非官方目标始终按牌价；
 * 2. 套餐积分折算（money_to_credits）只允许官方基础牌价（entry.pricing），
 *    不得读取 PAYG 已生效费率（snapshot.baseRates 已叠加时段/促销/fast）——
 *    因此订阅/套餐通道套促销不影响积分估算输入。
 */

const usage = {inputTokens: 100_000, outputTokens: 10_000};

function configWithEntry(entry: ModelPriceEntry): PricingConfigV2 {
  return {
    version: 2,
    currency: "CNY",
    unit: "per_million_tokens",
    models: [entry],
  };
}

const minimaxEntry: ModelPriceEntry = {
  id: "catalog:minimax-cn:MiniMax-M3",
  vendor: "minimax-cn",
  runtimeModelId: "MiniMax-M3",
  patterns: ["MiniMax-M3"],
  pricing: {input: 2.1, output: 8.4, cachedInput: 0.42},
  currency: "CNY",
  confidence: "official",
  planCreditRules: {
    formula: "money_to_credits",
    currency: "CNY",
    creditsPerCurrency: 1000 / 7,
    quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
  },
};

describe("PAYG 促销通道闸门", () => {
  const entry: ModelPriceEntry = {
    ...minimaxEntry,
    id: "catalog:demo:promo-model",
    vendor: "demo",
    runtimeModelId: "promo-model",
    patterns: ["promo-model"],
    planCreditRules: undefined,
    promotions: [{
      from: "2026-01-01T00:00:00+08:00",
      models: ["promo-model"],
      priceOverride: {input: 1, output: 4},
      label: "限时 5 折",
    }],
  };
  const base = {targetId: "t1", agentName: "codex", capturedAt: "2026-09-10T10:00:00+08:00", officialPresetVendor: "demo"};

  test("pay_as_you_go 官方通道：促销照常生效（回归保护）", () => {
    const cost = computeTokenCost(configWithEntry(entry), "promo-model", usage, base);
    expect(cost.priced).toBe(true);
    expect(cost.pricingSnapshot?.promotionLabel).toBe("限时 5 折");
    expect(cost.officialTotalCost).toBeCloseTo(100_000 / 1e6 * 1 + 10_000 / 1e6 * 4);
  });

  test("缺省通道（UI 估算等调用方）：保持旧行为，促销生效", () => {
    const cost = computeTokenCost(configWithEntry(entry), "promo-model", usage, {...base, billingChannel: undefined});
    expect(cost.pricingSnapshot?.promotionLabel).toBe("限时 5 折");
  });

  /* 2026-10-09 修订：官方预设的 plan/subscription 通道按官方实扣促销价计市价参考
     （量纲守卫后市价只用于展示与差分份额；积分折算输入仍读 entry.pricing，见下方独立守卫）。 */
  test("plan 通道（官方预设）：促销生效，市价参考按促销价", () => {
    const cost = computeTokenCost(configWithEntry(entry), "promo-model", usage, {...base, billingChannel: "plan"});
    expect(cost.pricingSnapshot?.promotionLabel).toBe("限时 5 折");
    expect(cost.officialTotalCost).toBeCloseTo(100_000 / 1e6 * 1 + 10_000 / 1e6 * 4);
  });

  test("subscription 通道（官方预设）：促销生效", () => {
    const cost = computeTokenCost(configWithEntry(entry), "promo-model", usage, {...base, billingChannel: "subscription"});
    expect(cost.pricingSnapshot?.promotionLabel).toBe("限时 5 折");
    expect(cost.officialTotalCost).toBeCloseTo(100_000 / 1e6 * 1 + 10_000 / 1e6 * 4);
  });

  test("中转站/非官方目标：plan 通道不套促销，按牌价计费", () => {
    const cost = computeTokenCost(configWithEntry(entry), "promo-model", usage, {
      ...base, billingChannel: "plan", officialPresetVendor: undefined,
    });
    expect(cost.pricingSnapshot?.promotionLabel).toBeUndefined();
    expect(cost.officialTotalCost).toBeCloseTo(100_000 / 1e6 * 2.1 + 10_000 / 1e6 * 8.4);
  });

  test("market_share 聚合订阅条目（OpenCode Go）：官方预设同样统一套促销（分子分母同源，2026-10-09 二次修订）", () => {
    const marketShareEntry: ModelPriceEntry = {
      ...entry,
      planCreditRules: {
        formula: "market_share",
        currency: "USD",
        quotaWindows: [{id: "monthly", label: "月度", reset: "calendar_month"}],
        quotaTiers: {go: {quotaByWindow: {monthly: 20}, monthlyFee: 10}},
      },
    };
    for (const billingChannel of ["plan", "subscription", "pay_as_you_go"] as const) {
      const cost = computeTokenCost(configWithEntry(marketShareEntry), "promo-model", usage, {...base, billingChannel});
      expect(cost.pricingSnapshot?.promotionLabel).toBe("限时 5 折");
      expect(cost.officialTotalCost).toBeCloseTo(100_000 / 1e6 * 1 + 10_000 / 1e6 * 4);
    }
  });
});

describe("套餐积分换算输入边界（money_to_credits）", () => {
  test("积分只按 entry.pricing 官方牌价折算，不读 snapshot.baseRates 生效价", () => {
    // snapshot.baseRates 模拟已被时段/促销污染的 PAYG 生效价（1/4/0.1）。
    const result = computePlanCreditForLedger(
      {
        pricingConfig: configWithEntry(minimaxEntry),
        model: "MiniMax-M3",
        capturedAt: "2026-09-10T10:00:00+08:00",
        billingChannel: "plan",
      },
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        currency: "CNY",
        priced: true,
        pricingSnapshot: {
          unit: "USD_per_million_tokens",
          matchStrategy: "pattern",
          priceEntryId: minimaxEntry.id,
          baseRates: {input: 1, output: 4, cachedInput: 0.1},
          rateMultiplier: 1,
        },
      },
      {inputTokens: usage.inputTokens, cacheReadTokens: 0, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens},
      "codex",
    );
    const officialCost = 100_000 / 1e6 * 2.1 + 10_000 / 1e6 * 8.4;
    const pollutedCost = 100_000 / 1e6 * 1 + 10_000 / 1e6 * 4;
    expect(result.planCreditCost).toBeCloseTo(officialCost * (1000 / 7));
    expect(result.planCreditCost).not.toBeCloseTo(pollutedCost * (1000 / 7));
    expect(result.planCreditUnit).toBe("积分");
  });

  test("非 plan 通道不折算积分", () => {
    const result = computePlanCreditForLedger(
      {pricingConfig: configWithEntry(minimaxEntry), model: "MiniMax-M3", capturedAt: "2026-09-10T10:00:00+08:00", billingChannel: "pay_as_you_go"},
      {inputTokens: 0, outputTokens: 0, currency: "CNY", priced: true},
      {inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0},
    );
    expect(result.planCreditCost).toBeUndefined();
    expect(result.planCreditUnit).toBeUndefined();
  });
});
