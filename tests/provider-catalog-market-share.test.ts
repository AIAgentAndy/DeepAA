import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import {parseProviderCatalogText} from "../src/lib/provider-catalog/normalize.js";
import {compileProviderModelEntries} from "../src/lib/provider-catalog/compiler.js";
import {CALCULATOR_REGISTRY, validateProfileCalculator} from "../src/lib/provider-catalog/calculator-registry.js";
import {computePlanCreditForLedger} from "../src/lib/ingestion/exchange-processor.js";
import {computePlanEstimateForLedger, resolveMarketShareQuotaTotal} from "../src/lib/db/plan-real-cost.js";
import {computePlanCredit} from "../src/lib/plan-credit.js";
import type {ModelPriceEntry, PricingConfigV2} from "../src/lib/pricing.js";

/**
 * market_share 公式族（2026-09-30 OpenCode Go，用户确认方案）：
 * 上游 usage 只回 percent 且不返回档位标识 → 额度经目录外挂（模型×档位月度美元
 * 额度 planMonthlyLimitUsd），档位由套餐同步配置显式选择（target.pricing.planTier）；
 * 估算 = 市价消耗 × 月费 ÷ 所选档位模型月度额度（固定月窗）；解析不到即
 * market_blocked 诚实降级，绝不用写死常量兜底。
 */

describe("market_share 编译链（随包目录）", () => {
  test("opencode-go 全部计价模型投影 quotaTiers（档位月度额度 + 档位月费），免费模型不投影", async () => {
    const text = await readFile(join(process.cwd(), "data/defaults/llm_catalog.jsonl"), "utf8");
    const catalog = parseProviderCatalogText(text).catalog;
    const entries = compileProviderModelEntries(catalog, "opencode-go");

    const glm = entries.get("glm-5.3");
    expect(glm?.planCreditRules).toMatchObject({
      formula: "market_share",
      unit: "USD",
      quotaTiers: {
        go: {quotaByWindow: {monthly: 15}, monthlyFee: 10},
        "go-plus": {quotaByWindow: {monthly: 120}, monthlyFee: 40},
      },
    });
    expect(entries.get("hy3")?.planCreditRules?.quotaTiers?.go?.quotaByWindow.monthly).toBe(60);
    expect(entries.get("gpt-6-luna")?.planCreditRules?.quotaTiers?.["go-plus"]?.quotaByWindow.monthly).toBe(60);

    // 20 个计价模型全部带规则；两个限时免费模型（无额度语义）不带。
    const withRules = [...entries.values()].filter(entry => entry.planCreditRules?.formula === "market_share");
    expect(withRules).toHaveLength(20);
    expect(entries.get("longcat-2.5-preview-free")?.planCreditRules).toBeUndefined();
    expect(entries.get("space-bunny-free")?.planCreditRules).toBeUndefined();

    // 长上下文档倍率化（2026-10-07）：目录只保留倍率，各通道长档价由
    // 实际基数×倍率推导（resolveLongContextRates 消费；绝对价 rates 已随迁移清除）。
    const qwen = entries.get("qwen3.7-plus");
    expect(qwen?.pricing?.longContext).toMatchObject({thresholdTokens: 256000, inputMultiplier: 3, outputMultiplier: 3});
    expect(qwen?.pricing?.longContext?.rates).toBeUndefined();
    const luna = entries.get("gpt-5.6-luna");
    expect(luna?.pricing?.longContext).toMatchObject({thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5});
    expect(luna?.pricing?.longContext?.rates).toBeUndefined();
  });
});

describe("market_share 校验与投影（合成目录）", () => {
  function fixtureCatalog(modelOverride: Record<string, unknown>) {
    const meta = {schemaVersion: 2, catalogRevision: "2026.09.30.04", publishedAt: "2026-09-30T23:00:00+08:00"};
    const provider = {
      catalogKey: "opencode-go",
      name: "OpenCode Go",
      brandId: "opencode",
      pricingProviderId: "opencode-go",
      region: "global",
      category: "aggregator",
      planTiers: [
        {id: "go", name: "OpenCode Go", monthlyFee: 10},
        {id: "go-plus", name: "OpenCode Go Plus", monthlyFee: 40},
      ],
      planProfiles: {
        "opencode-go-quota-v1": {calculator: {kind: "market_share", unit: "USD"}},
      },
      models: [
        {
          id: "demo-model",
          category: "chat",
          pricing: {input: 1, output: 4, cachedInput: 0.2},
          planProfileRef: "opencode-go-quota-v1",
          ...modelOverride,
        },
      ],
    };
    return parseProviderCatalogText(`${JSON.stringify(meta)}\n${JSON.stringify(provider)}\n`).catalog;
  }

  test("planMonthlyLimitUsd 非法值（负数/空对象）整目录隔离", () => {
    expect(() => fixtureCatalog({planMonthlyLimitUsd: {go: -15}})).toThrow(/planMonthlyLimitUsd/u);
    expect(() => fixtureCatalog({planMonthlyLimitUsd: {}})).toThrow(/planMonthlyLimitUsd/u);
  });

  test("calculator 校验：market_share 必须声明 unit=USD", () => {
    expect(validateProfileCalculator({calculator: {kind: "market_share", unit: "USD"}})).toEqual([]);
    expect(validateProfileCalculator({calculator: {kind: "market_share"}}))
      .toEqual(["market_share 计算器必须声明 unit=USD（模型级 planMonthlyLimitUsd 为美元口径）"]);
    expect(CALCULATOR_REGISTRY.market_share.formula).toBe("market_share");
  });

  test("缺 planMonthlyLimitUsd 的模型按 MARKET_SHARE_LIMITS_MISSING 诊断隔离，不投影规则", () => {
    const catalog = fixtureCatalog({});
    const entries = compileProviderModelEntries(catalog, "opencode-go");
    expect(entries.get("demo-model")?.planCreditRules).toBeUndefined();
  });
});

describe("market_share 运行时（分母解析与估算）", () => {
  const rules = {
    formula: "market_share" as const,
    unit: "USD",
    quotaTiers: {
      go: {quotaByWindow: {monthly: 15}, monthlyFee: 10},
      "go-plus": {quotaByWindow: {monthly: 120}, monthlyFee: 40},
    },
  };

  test("resolveMarketShareQuotaTotal：档位命中按月窗折算 CNY；未选/未命中/其它公式返回 undefined", () => {
    expect(resolveMarketShareQuotaTotal(rules, "go", 7)).toEqual({
      total: 105, windowDays: 30, windowLabel: "monthly", unit: "CNY", monthlyLimitUsd: 15,
    });
    expect(resolveMarketShareQuotaTotal(rules, "go-plus", 7)?.total).toBe(840);
    expect(resolveMarketShareQuotaTotal(rules, undefined, 7)).toBeUndefined();
    expect(resolveMarketShareQuotaTotal(rules, "go-pro", 7)).toBeUndefined();
    expect(resolveMarketShareQuotaTotal({...rules, formula: "token_weighted"}, "go", 7)).toBeUndefined();
    expect(resolveMarketShareQuotaTotal({formula: "market_share", unit: "USD"}, "go", 7)).toBeUndefined();
  });

  test("computePlanCredit：market_share 不产出逐请求积分", () => {
    const result = computePlanCredit({
      model: "glm-5.3",
      rules: {...rules, quotaWindows: [{id: "monthly", label: "每月", reset: "monthly"}]},
      rates: {input: 1.4, output: 4.4, cachedInput: 0.26},
      usage: {inputTokens: 1000, outputTokens: 1000},
    });
    expect(result.creditCost).toBeUndefined();
  });

  const entry: ModelPriceEntry = {
    id: "catalog:opencode-go:glm-5.3",
    vendor: "opencode-go",
    runtimeModelId: "glm-5.3",
    patterns: ["glm-5.3"],
    pricing: {input: 1.4, output: 4.4, cachedInput: 0.26},
    currency: "USD",
    confidence: "official",
    planCreditRules: {...rules, quotaWindows: [{id: "monthly", label: "每月", reset: "monthly"}]},
  };
  const config: PricingConfigV2 = {
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [entry],
    fx: {rates: {"USD/CNY": 7}, asOf: "2026-09-30", source: "test"},
  };
  const costStub = {
    inputTokens: 0,
    outputTokens: 0,
    currency: "USD" as const,
    priced: true,
    pricingSnapshot: {
      unit: "USD_per_million_tokens" as const,
      matchStrategy: "pattern" as const,
      priceEntryId: entry.id,
      baseRates: {input: 1.4, output: 4.4, cachedInput: 0.26},
      rateMultiplier: 1,
    },
  };

  test("computePlanCreditForLedger：market_share 只产分母不产积分；未选档位无分母", () => {
    const usage = {inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0};
    const withTier = computePlanCreditForLedger(
      {pricingConfig: config, model: "glm-5.3", capturedAt: "2026-09-30T10:00:00Z", billingChannel: "plan", targetPlanTier: "go"},
      costStub,
      usage,
    );
    expect(withTier.planCreditCost).toBeUndefined();
    expect(withTier.planCreditUnit).toBeUndefined();
    expect(withTier.marketShareQuotaTotal).toEqual({total: 105, windowDays: 30, windowLabel: "monthly", unit: "CNY", monthlyLimitUsd: 15});

    const noTier = computePlanCreditForLedger(
      {pricingConfig: config, model: "glm-5.3", capturedAt: "2026-09-30T10:00:00Z", billingChannel: "plan", targetPlanTier: undefined},
      costStub,
      usage,
    );
    expect(noTier.planCreditCost).toBeUndefined();
    expect(noTier.marketShareQuotaTotal).toBeUndefined();
  });

  test("端到端估算：市价 0.1 × 月费 10 ÷ 额度 15（go 档）；无分母（percent 快照）按 market_blocked 降级", () => {
    /* 市价 0.1 USD = 0.7 CNY（fx 7）；额度 15 USD = 105 CNY；月费 10 USD = 70 CNY。
       估算 = 70 × 0.7/105 × 30/30 = 0.4667 CNY（≈ 0.1 × 10/15）。 */
    const quota = resolveMarketShareQuotaTotal(rules, "go", 7)!;
    const estimated = computePlanEstimateForLedger({
      billingChannel: "plan",
      referenceCostNano: 0.7 * 1e9,
      monthlyFee: 10,
      feeCurrency: "USD",
      quotaTotal: quota.total,
      quotaUnit: quota.unit,
      windowDays: quota.windowDays,
      windowLabel: quota.windowLabel,
      fxUsdCny: 7,
      modelId: "glm-5.3",
      planTier: "go",
      monthlyLimitUsd: quota.monthlyLimitUsd,
    });
    expect(estimated.status).toBe("estimated");
    expect(estimated.nano).toBe(Math.round(10 * 7 * 1e9 * (0.7 / 105) * (30 / 30)));
    /* 逐步公式依据（2026-09-30）：四件套齐备时落明细，展示端据此展开
       「消耗￥ = $×汇率 → ÷ 档位额度$×汇率 → × 档位月费$×汇率」逐步行。 */
    const estimatedDetail = JSON.parse(estimated.detailJson!) as Record<string, unknown>;
    expect(estimatedDetail).toMatchObject({
      consumedBasis: "market_cny",
      modelId: "glm-5.3",
      planTier: "go",
      monthlyLimitUsd: 15,
      quotaTotal: 105,
    });
    expect(estimatedDetail.consumedUsd as number).toBeCloseTo(0.1, 10);

    /* 未选档位/条目无规则：快照窗口只剩 percent 口径（total=100）→ market_blocked，
       诚实降级 unavailable（绝不写死常量兜底）。 */
    const blocked = computePlanEstimateForLedger({
      billingChannel: "plan",
      referenceCostNano: 0.7 * 1e9,
      monthlyFee: 10,
      feeCurrency: "USD",
      quotaTotal: 100,
      quotaUnit: "percent",
      windowDays: 30,
      windowLabel: "monthly",
      fxUsdCny: 7,
    });
    expect(blocked.status).toBe("unavailable");
    expect(JSON.parse(blocked.detailJson!)).toMatchObject({consumedBasis: "market_blocked", quotaUnit: "percent"});
  });
});
