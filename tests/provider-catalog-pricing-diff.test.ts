import {describe, expect, test} from "vitest";
import {diffPricingCenterAgainstCatalog} from "../src/lib/provider-catalog/pricing-diff.js";
import {planCreditRuleChanges} from "../src/lib/provider-catalog/diff.js";
import {normalizePricingConfig, type PricingConfig} from "../src/lib/pricing.js";
import type {ProviderCatalog} from "../src/lib/provider-catalog/types.js";

function catalogWith(
  models: Array<Record<string, unknown>>,
  providerExtras: Record<string, unknown> = {},
  pricingProviderId = "demo",
): ProviderCatalog {
  return {
    schemaVersion: 2,
    catalogRevision: "2026.09.03.01",
    publishedAt: "2026-09-03T00:00:00+08:00",
    providers: {
      demo: {
        name: "Demo",
        brandId: "demo",
        pricingProviderId,
        region: "global",
        category: "official",
        defaultTimezone: "Asia/Shanghai",
        ...providerExtras,
        models: models as never,
      },
    },
  } as ProviderCatalog;
}

function paygCampaign(id: string, rates: Record<string, number>, period: Record<string, string> = {from: "2026-07-01T00:00:00Z"}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    channel: "payg",
    scope: {models: ["m1"]},
    period,
    effect: {kind: "priceOverride", rates},
    ...extra,
  };
}

function pricingCenterWith(models: Array<Record<string, unknown>>): PricingConfig {
  return normalizePricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: models as never,
  });
}

describe("官方目录与价格中心逐字段差异（v2）", () => {
  test("价格中心与目录一致时无差异", () => {
    const catalog = catalogWith([
      {id: "m1", category: "chat", pricing: {input: 5, output: 30}},
    ]);
    const pricing = pricingCenterWith([
      {id: "catalog:demo:m1", vendor: "demo", runtimeModelId: "m1", patterns: ["m1"], pricing: {input: 5, output: 30}, confidence: "official"},
    ]);
    const diff = diffPricingCenterAgainstCatalog(pricing, catalog);
    expect(diff.hasUpdates).toBe(false);
    expect(diff.providers).toEqual([]);
  });

  test("目录新增模型与价格变化逐字段标出", () => {
    const catalog = catalogWith([
      {id: "m1", category: "chat", pricing: {input: 6, output: 30}},
      {id: "m2", category: "chat", pricing: {input: 1, output: 2, longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5}}},
    ]);
    const pricing = pricingCenterWith([
      {id: "catalog:demo:m1", vendor: "demo", runtimeModelId: "m1", patterns: ["m1"], pricing: {input: 5, output: 30}, confidence: "official"},
    ]);
    const diff = diffPricingCenterAgainstCatalog(pricing, catalog);
    expect(diff.hasUpdates).toBe(true);
    expect(diff.changedModelCount).toBe(2);
    const provider = diff.providers[0]!;
    const changed = provider.models.find(model => model.modelId === "m1")!;
    expect(changed.added).toBe(false);
    expect(changed.changes).toContainEqual(expect.objectContaining({field: "input", before: "5/M", after: "6/M", kind: "changed"}));
    const added = provider.models.find(model => model.modelId === "m2")!;
    expect(added.added).toBe(true);
    expect(added.changes.some(change => change.field === "longContext" && change.after.includes("272,000"))).toBe(true);
  });

  test("套餐积分规则（Profile/Campaign 投影）的活动变化按字段级摘要标出", () => {
    const catalog = catalogWith(
      [{id: "m1", category: "chat", pricing: {input: 5, output: 30}, planProfileRef: "p1", planFactors: {input: 2.3, output: 8, cachedInput: 0.56}}],
      {
        planProfiles: {
          p1: {
            calculator: {kind: "token_weighted", divisor: 10000},
            timezone: "Asia/Shanghai",
            peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00"}],
            quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
          },
        },
        campaigns: [{
          id: "demo.m1.plan.1", channel: "plan", profileRef: "p1",
          scope: {models: ["m1"], agents: ["zcode"]},
          period: {from: "2026-06-01T00:00:00+08:00", to: "2027-01-01T00:00:00+08:00"},
          effect: {kind: "creditMultiplier", value: 0.67},
        }],
      },
    );
    const pricing = pricingCenterWith([
      {
        id: "catalog:demo:m1", vendor: "demo", runtimeModelId: "m1", patterns: ["m1"],
        pricing: {input: 5, output: 30}, confidence: "official",
        planCreditRules: {
          formula: "token_weighted", currency: "CNY", divisor: 10000,
          modelFactors: {"m1": {input: 2.3, output: 8, cachedInput: 0.56}},
          peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00"}],
          quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
        },
      },
    ]);
    const diff = diffPricingCenterAgainstCatalog(pricing, catalog);
    const changes = diff.providers[0]!.models[0]!.changes;
    const promotionChange = changes.find(change => change.field.startsWith("planCredit.promotion."));
    expect(promotionChange).toBeDefined();
    expect(promotionChange!.kind).toBe("added");
    expect(promotionChange!.after).toContain("×0.67");
    expect(promotionChange!.after).toContain("zcode");
  });

  test("user_override 手工价不参与目录对比", () => {
    const catalog = catalogWith([
      {id: "m1", category: "chat", pricing: {input: 99, output: 99}},
    ]);
    const pricing = pricingCenterWith([
      {id: "catalog:demo:m1", vendor: "demo", runtimeModelId: "m1", patterns: ["m1"], pricing: {input: 1, output: 2}, confidence: "user_override"},
    ]);
    const diff = diffPricingCenterAgainstCatalog(pricing, catalog);
    expect(diff.hasUpdates).toBe(false);
  });
});

describe("按量促销（payg Campaign 投影）与服务档位价格集 diff（回归守卫）", () => {
  const baseEntry = {id: "catalog:demo:m1", vendor: "demo", runtimeModelId: "m1", patterns: ["m1"], pricing: {input: 5, output: 30}, confidence: "official"};

  test("促销价格变化与上下架必须触发 diff", () => {
    const center = pricingCenterWith([{
      ...baseEntry,
      promotions: [{from: "2026-07-01T00:00:00Z", label: "限时优惠", priceOverride: {input: 4, output: 20}}],
    }]);
    // 价格变化（实扣 4 → 3）：per-key 字段 promotions.<models>:<区间>:<agents>。
    const changed = diffPricingCenterAgainstCatalog(center, catalogWith(
      [{id: "m1", category: "chat", pricing: {input: 5, output: 30}}],
      {campaigns: [paygCampaign("demo.m1.payg.1", {input: 3, output: 20}, {from: "2026-07-01T00:00:00Z"})]},
    ));
    const promoChange = changed.providers[0]!.models[0]!.changes.find(item => item.field.startsWith("promotions."));
    expect(promoChange?.kind).toBe("changed");
    expect(promoChange?.after).toContain("实扣 3/20");
    // 目录下架促销（价格中心仍持有）→ after 显示移除。
    const removed = diffPricingCenterAgainstCatalog(center, catalogWith([
      {id: "m1", category: "chat", pricing: {input: 5, output: 30}},
    ]));
    expect(removed.providers[0]!.models[0]!.changes.some(item => item.field.startsWith("promotions.") && item.after === "移除")).toBe(true);
  });

  test("已有促销再新增第二条：逐条粒度判 added", () => {
    const center = pricingCenterWith([{
      ...baseEntry,
      promotions: [{from: "2026-07-01T00:00:00Z", label: "限时优惠", priceOverride: {input: 4, output: 20}}],
    }]);
    const diff = diffPricingCenterAgainstCatalog(center, catalogWith(
      [{id: "m1", category: "chat", pricing: {input: 5, output: 30}}],
      {campaigns: [
        paygCampaign("demo.m1.payg.1", {input: 4, output: 20}, {from: "2026-07-01T00:00:00Z"}, {label: "限时优惠"}),
        paygCampaign("demo.m1.payg.2", {input: 2, output: 10}, {from: "2026-09-03T00:00:00+08:00", to: "2026-09-10T00:00:00+08:00"}, {label: "限时 5 折", priority: 100}),
      ]},
    ));
    const promoChanges = diff.providers[0]!.models[0]!.changes.filter(item => item.field.startsWith("promotions."));
    expect(promoChanges).toHaveLength(1);
    expect(promoChanges[0]!.kind).toBe("added");
    expect(promoChanges[0]!.after).toContain("实扣 2/10");
  });

  test("serviceTierPricing 变化必须触发 diff；新增条目汇总 fast 档与促销", () => {
    const changed = diffPricingCenterAgainstCatalog(
      pricingCenterWith([{...baseEntry, serviceTierPricing: {fastMultiplier: 1.5}}]),
      catalogWith([{id: "m1", category: "chat", pricing: {input: 5, output: 30}, serviceTierPricing: {fastMultiplier: 2}}]),
    );
    // 逐键粒度（2026-09-22；2026-10-07 倍率制）：只出变化的 fastMultiplier 一条。
    const fastChange = changed.providers[0]!.models[0]!.changes.find(item => item.field === "serviceTierPricing.fastMultiplier");
    expect(fastChange?.kind).toBe("changed");
    expect(fastChange?.label).toBe("服务档位价格 · fastMultiplier");
    expect(fastChange?.after).toContain("Fast 2×");

    const added = diffPricingCenterAgainstCatalog(pricingCenterWith([]), catalogWith(
      [{id: "m1", category: "chat", pricing: {input: 5, output: 30}, serviceTierPricing: {fastMultiplier: 2}}],
      {campaigns: [paygCampaign("demo.m1.payg.1", {input: 4, output: 20})]},
    ));
    const addedChanges = added.providers[0]!.models[0]!.changes;
    expect(addedChanges.some(item => item.field === "serviceTierPricing" && item.kind === "added" && item.after.includes("Fast 2×"))).toBe(true);
    // 整条目新增时按整字段汇总展示促销摘要；逐条粒度只用于既有条目的变更比较。
    expect(addedChanges.some(item => item.field === "promotions" && item.kind === "added" && item.after.includes("实扣 4/20"))).toBe(true);
  });

  test("priceSchedules 多档仅一档变化：只出该档条目，未变档零噪音", () => {
    const schedule = (label: string, input: number) => ({
      label,
      timezone: "Asia/Shanghai",
      windows: [{days: [0, 1, 2, 3, 4], start: "00:00", end: "09:00"}],
      rates: {input, output: 4.5, cachedInput: 0.05},
    });
    const center = pricingCenterWith([{...baseEntry, priceSchedules: [schedule("闲时", 1.5), schedule("忙时", 3)] as never}]);
    const catalog = catalogWith([
      {...{id: "m1", category: "chat", pricing: {input: 5, output: 30}}, priceSchedules: [schedule("闲时", 1.5), schedule("忙时", 2.4)]},
    ]);
    const diff = diffPricingCenterAgainstCatalog(center, catalog);
    const changes = diff.providers[0]!.models[0]!.changes.filter(item => item.field.startsWith("priceSchedules."));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("priceSchedules.忙时");
    expect(changes[0]!.label).toBe("时段费率 · 忙时");
    expect(changes[0]!.before).toContain("输入 3/输出 4.5");
    expect(changes[0]!.after).toContain("输入 2.4/输出 4.5");
  });

  test("rateTimeline 多段仅一段变化：只出该段条目（含 changeNote 文案差异）", () => {
    const segment = (effectiveFrom: string | undefined, input: number, note?: string) => ({
      ...(effectiveFrom ? {effectiveFrom} : {}),
      pricing: {input, output: 16, cachedInput: 0.4},
      ...(note ? {changeNote: note} : {}),
    });
    const center = pricingCenterWith([{...baseEntry, rateTimeline: [segment(undefined, 4), segment("2026-10-01T00:00:00+08:00", 2)] as never}]);
    const catalog = catalogWith([
      {...{id: "m1", category: "chat", pricing: {input: 5, output: 30}}, rateTimeline: [segment(undefined, 4), segment("2026-10-01T00:00:00+08:00", 2, "官方调价公告")]},
    ]);
    const diff = diffPricingCenterAgainstCatalog(center, catalog);
    const changes = diff.providers[0]!.models[0]!.changes.filter(item => item.field.startsWith("rateTimeline."));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("rateTimeline.2026-10-01T00:00:00+08:00");
    expect(changes[0]!.label).toBe("价格时间线 · 2026-10-01 00:00 起");
    expect(changes[0]!.after).toContain("（官方调价公告）");
    // 未变的历史段（无 effectiveFrom 首段）不得产生噪音条目
    expect(changes.some(item => item.field === "rateTimeline.#0")).toBe(false);
  });
});

describe("套餐积分规则通知内容（2026-09-30：具体内容取代「（无）→ 已配置」）", () => {
  const marketShareRules = {
    formula: "market_share" as const,
    unit: "USD",
    quotaWindows: [
      {id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const},
      {id: "monthly" as const, label: "每月", reset: "monthly" as const},
    ],
    quotaTiers: {
      go: {quotaByWindow: {monthly: 60}, monthlyFee: 10},
      "go-plus": {quotaByWindow: {monthly: 180}, monthlyFee: 40},
    },
  };

  test("整组新增：after 摘要带公式、单位、窗口与各档位额度（不再是空泛「已配置」）", () => {
    const changes = planCreditRuleChanges(marketShareRules, undefined);
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.field).toBe("planCredit.rules");
    expect(change.kind).toBe("added");
    expect(change.after).toContain("市价份额估算（无逐请求积分）");
    expect(change.after).toContain("单位 USD");
    expect(change.after).toContain("窗口 5 小时 / 每月");
    expect(change.after).toContain("档位 go：额度 monthly $60 · 月费 $10");
    expect(change.after).toContain("档位 go-plus：额度 monthly $180 · 月费 $40");
    expect(change.after).not.toBe("已配置");
  });

  test("整组删除：before 摘要同样展开内容", () => {
    const changes = planCreditRuleChanges(undefined, marketShareRules as never);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("changed");
    expect(changes[0]!.before).toContain("档位 go：额度 monthly $60");
    expect(changes[0]!.after).toBe("未配置");
  });

  test("quotaTiers-only 变化：出具体档位条目（修复此前落不进任何条目导致永不同步）", () => {
    const previous = {...marketShareRules, quotaTiers: {go: {quotaByWindow: {monthly: 40}, monthlyFee: 10}, "go-plus": {quotaByWindow: {monthly: 120}, monthlyFee: 40}}};
    const changes = planCreditRuleChanges(marketShareRules, previous as never);
    expect(changes.map(change => change.field)).toEqual([
      "planCredit.quotaTiers.go",
      "planCredit.quotaTiers.go-plus",
    ]);
    expect(changes[0]!.before).toBe("额度 monthly $40 · 月费 $10");
    expect(changes[0]!.after).toBe("额度 monthly $60 · 月费 $10");
  });

  test("单位变化出条目；quotaWindows 变化出摘要", () => {
    const previous = {...marketShareRules, unit: undefined, quotaWindows: [{id: "monthly" as const, label: "每月", reset: "monthly" as const}]};
    const changes = planCreditRuleChanges(marketShareRules, previous as never);
    expect(changes.map(change => change.field)).toEqual(["planCredit.unit", "planCredit.quotaWindows"]);
    expect(changes[0]!.before).toBe("默认");
    expect(changes[0]!.after).toBe("USD");
    expect(changes[1]!.before).toBe("每月");
    expect(changes[1]!.after).toBe("5 小时 / 每月");
  });
});
