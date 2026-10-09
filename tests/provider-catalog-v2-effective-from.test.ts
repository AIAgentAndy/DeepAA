import {describe, expect, test} from "vitest";
import {computeTokenCost, effectiveEntryAt, type ModelPriceEntry, type PricingConfigV2, type PriceRateSegment} from "../src/lib/pricing.js";
import {mergeProviderCatalogPricing} from "../src/lib/provider-catalog/pricing.js";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";
import {computePlanCreditForLedger} from "../src/lib/ingestion/exchange-processor.js";

/**
 * 价格时间线计费（终极方案 2026-09-10）：模型级 rateTimeline（多段时间区间，
 * 同一时间唯一价格）——计费按 captured_at 选段（effectiveFrom ≤ captured_at 的最后一段），
 * captured_at 早于所有段时取首段（历史现状）。user_override 手工价时间不变。
 */

function entryWith(overrides: Partial<ModelPriceEntry>): ModelPriceEntry {
  return {
    id: "catalog:deepseek:deepseek-v4-flash",
    vendor: "deepseek",
    runtimeModelId: "deepseek-v4-flash",
    patterns: ["deepseek-v4-flash"],
    pricing: {input: 2, output: 8, cachedInput: 0.04},
    priceSchedules: [{
      timezone: "Asia/Shanghai",
      label: "闲时",
      windows: [{days: [5, 6], start: "00:00", end: "24:00"}],
      rates: {input: 1, output: 4, cachedInput: 0.02},
    }],
    currency: "CNY",
    confidence: "official",
    ...overrides,
  };
}

const timeline: PriceRateSegment[] = [
  {pricing: {input: 4, output: 12, cachedInput: 0.16}, priceSchedules: [{
    timezone: "Asia/Shanghai", label: "闲时",
    windows: [{days: [5, 6], start: "00:00", end: "24:00"}],
    rates: {input: 2, output: 6, cachedInput: 0.08},
  }]},
  {effectiveFrom: "2026-09-10T12:00:00+08:00", pricing: {input: 2, output: 8, cachedInput: 0.04}, priceSchedules: [{
    timezone: "Asia/Shanghai", label: "闲时",
    windows: [{days: [5, 6], start: "00:00", end: "24:00"}],
    rates: {input: 1, output: 4, cachedInput: 0.02},
  }], changeNote: "官方调价公告"},
];

const usage = {inputTokens: 1_000_000, outputTokens: 1_000_000};

function configWith(entry: ModelPriceEntry): PricingConfigV2 {
  return {version: 2, currency: "CNY", unit: "per_million_tokens", models: [entry]};
}

describe("时间线段选择计费", () => {
  const entry = entryWith({rateTimeline: timeline});
  const base = {targetId: "t1", capturedAt: "", agentName: "codex"};

  test("12:00 前按段1（历史），12:00 起按段2（新价）", () => {
    const before = computeTokenCost(configWith(entry), "deepseek-v4-flash", usage, {...base, capturedAt: "2026-09-10T11:59:00+08:00"});
    const after = computeTokenCost(configWith(entry), "deepseek-v4-flash", usage, {...base, capturedAt: "2026-09-10T12:01:00+08:00"});
    expect(before.officialTotalCost).toBeCloseTo(4 + 12);
    expect(after.officialTotalCost).toBeCloseTo(2 + 8);
  });

  test("闲时档同步切换（周六生效：11:59 按旧闲时，12:01 后按新闲时）", () => {
    const saturday = entryWith({rateTimeline: [
      timeline[0]!,
      {...timeline[1]!, effectiveFrom: "2026-09-12T12:00:00+08:00"},
    ]});
    const before = computeTokenCost(configWith(saturday), "deepseek-v4-flash", usage, {...base, capturedAt: "2026-09-12T11:59:00+08:00"});
    const after = computeTokenCost(configWith(saturday), "deepseek-v4-flash", usage, {...base, capturedAt: "2026-09-12T12:01:00+08:00"});
    expect(before.pricingSnapshot?.scheduleLabel).toBe("闲时");
    expect(before.officialTotalCost).toBeCloseTo(2 + 6);
    expect(after.officialTotalCost).toBeCloseTo(1 + 4);
  });

  test("多段：中段过期后选最后段；三段场景", () => {
    const threeSegment = entryWith({rateTimeline: [
      timeline[0]!,
      timeline[1]!,
      {effectiveFrom: "2026-09-15T12:00:00+08:00", pricing: {input: 1, output: 4, cachedInput: 0.02}},
    ]});
    // 9-14（段2 生效中）
    const mid = computeTokenCost(configWith(threeSegment), "deepseek-v4-flash", usage, {...base, capturedAt: "2026-09-14T10:00:00+08:00"});
    expect(mid.officialTotalCost).toBeCloseTo(2 + 8);
    // 9-16（段3 生效）
    const latest = computeTokenCost(configWith(threeSegment), "deepseek-v4-flash", usage, {...base, capturedAt: "2026-09-16T10:00:00+08:00"});
    expect(latest.officialTotalCost).toBeCloseTo(1 + 4);
  });

  test("无时间线/单段条目按顶层字段计费", () => {
    expect(effectiveEntryAt(entryWith({}), "2026-09-10T11:00:00+08:00")?.pricing.input).toBe(2);
    expect(effectiveEntryAt(entryWith({rateTimeline: [timeline[0]!]}), "2099-01-01T00:00:00+08:00")?.pricing.input).toBe(4);
  });

  test("user_override 手工价时间不变：时间线不参与 payg 计费", () => {
    const manual = entryWith({rateTimeline: timeline, confidence: "user_override", pricing: {input: 99, output: 99}});
    const cost = computeTokenCost(configWith(manual), "deepseek-v4-flash", usage, {...base, capturedAt: "2026-09-10T12:01:00+08:00"});
    expect(cost.officialTotalCost).toBeCloseTo(99 + 99);
  });
});

describe("合并时间线（目录 → 价格中心）", () => {
  function catalogWithTimeline() {
    return normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.09.10.02",
      publishedAt: "2026-09-10T11:00:00+08:00",
      providers: {
        deepseek: {
          name: "DeepSeek", brandId: "deepseek", pricingProviderId: "deepseek", region: "cn", category: "official",
          models: [{
            id: "deepseek-v4-flash",
            category: "chat",
            rateTimeline: [
              {pricing: {input: 4, output: 12, cachedInput: 0.16}},
              {effectiveFrom: "2026-09-10T12:00:00+08:00", pricing: {input: 2, output: 8, cachedInput: 0.04}, changeNote: "官方调价"},
            ],
          }],
        },
      },
    }).catalog;
  }

  test("目录时间线整列落盘：顶层=最后一段、历史段保留", () => {
    const current = configWith(entryWith({rateTimeline: undefined}));
    const merged = mergeProviderCatalogPricing(current, catalogWithTimeline());
    const entry = merged.models.find(item => item.runtimeModelId === "deepseek-v4-flash");
    expect(entry?.rateTimeline).toHaveLength(2);
    expect(entry?.pricing).toEqual({input: 2, output: 8, cachedInput: 0.04});
    expect(entry?.rateTimeline?.[0]?.pricing).toEqual({input: 4, output: 12, cachedInput: 0.16});
    expect(entry?.rateTimeline?.[1]?.changeNote).toBe("官方调价");
    // 端到端：11:59 → 旧价 4+12；12:01 → 新价 2+8。
    const config = {version: 2, currency: "CNY", unit: "per_million_tokens", models: merged.models} as PricingConfigV2;
    expect(computeTokenCost(config, "deepseek-v4-flash", usage, {capturedAt: "2026-09-10T11:59:00+08:00"}).officialTotalCost).toBeCloseTo(4 + 12);
    expect(computeTokenCost(config, "deepseek-v4-flash", usage, {capturedAt: "2026-09-10T12:01:00+08:00"}).officialTotalCost).toBeCloseTo(2 + 8);
  });

  test("多版本同步不破坏时间线（历史段始终保留）", () => {
    const first = mergeProviderCatalogPricing(configWith(entryWith({rateTimeline: undefined})), catalogWithTimeline());
    const second = mergeProviderCatalogPricing(first, catalogWithTimeline());
    const entry = second.models.find(item => item.runtimeModelId === "deepseek-v4-flash");
    expect(entry?.rateTimeline).toHaveLength(2);
    expect(entry?.rateTimeline?.[0]?.pricing.input).toBe(4);
  });

  test("套餐系数时间线段参与计费", () => {
    const rules = {
      formula: "afp_weighted" as const,
      divisor: 10000,
      modelFactors: {"deepseek-v4-flash": {input: 0.5, output: 0.5}},
      quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
    };
    const entry = entryWith({
      rateTimeline: [
        {pricing: {input: 4, output: 12}, planFactors: {input: 5.5, output: 5.5}},
        {effectiveFrom: "2026-09-10T12:00:00+08:00", pricing: {input: 2, output: 8}},
      ],
      planCreditRules: rules,
    });
    const planUsage = {inputTokens: 10_000, cacheReadTokens: 0, outputTokens: 10_000, totalTokens: 20_000};
    const before = computePlanCreditForLedger(
      {pricingConfig: configWith(entry), model: "deepseek-v4-flash", capturedAt: "2026-09-10T11:00:00+08:00", billingChannel: "plan"},
      {inputTokens: 0, outputTokens: 0, currency: "CNY", priced: true, pricingSnapshot: {unit: "USD_per_million_tokens", matchStrategy: "pattern", priceEntryId: entry.id, baseRates: {input: 2, output: 8}, rateMultiplier: 1}},
      planUsage,
    );
    // 生效前：段1 系数 5.5 → (10000×5.5 + 10000×5.5)/10000 = 11 AFP。
    expect(before.planCreditCost).toBeCloseTo(11);
    const after = computePlanCreditForLedger(
      {pricingConfig: configWith(entry), model: "deepseek-v4-flash", capturedAt: "2026-09-10T13:00:00+08:00", billingChannel: "plan"},
      {inputTokens: 0, outputTokens: 0, currency: "CNY", priced: true, pricingSnapshot: {unit: "USD_per_million_tokens", matchStrategy: "pattern", priceEntryId: entry.id, baseRates: {input: 2, output: 8}, rateMultiplier: 1}},
      planUsage,
    );
    // 生效后：无段2 系数 → 使用顶层 planCreditRules 的 0.5。
    expect(after.planCreditCost).toBeCloseTo(1);
  });
});
