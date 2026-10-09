import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {describe, expect, test} from "vitest";
import {migrateDeepaaDatabase} from "../src/lib/db/schema.js";
import {ensurePricingConfigRevision, loadPricingConfigAt} from "../src/lib/ingestion/pricing-revisions.js";

function memoryDb(): DeepaaDatabase {
  const db = new DeepaaDatabase(":memory:");
  db.pragma("journal_mode = WAL");
  migrateDeepaaDatabase(db);
  return db;
}

describe("价格版本哈希语义", () => {
  test("priceSchedules 与 planCreditRules 变化产生新价格版本", () => {
    const db = memoryDb();
    const base = {
      version: 2 as const,
      currency: "USD",
      models: [{
        id: "m1",
        vendor: "deepseek",
        patterns: ["m1"],
        pricing: {input: 1, output: 1},
        confidence: "official" as const,
      }],
    };
    const withSchedule = {
      ...base,
      models: [{
        ...base.models[0],
        priceSchedules: [{
          label: "闲时",
          windows: [{start: "00:00", end: "24:00"}],
          rates: {input: 0.5, output: 0.5},
        }],
        planCreditRules: {
          formula: "money_to_credits" as const,
          currency: "CNY" as const,
          creditsPerCurrency: 142.85714285714286,
          quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
        },
      }],
    };

    const first = ensurePricingConfigRevision(db, base);
    const second = ensurePricingConfigRevision(db, withSchedule);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);

    const third = ensurePricingConfigRevision(db, withSchedule);
    expect(third.created).toBe(false);
    expect(third.id).toBe(second.id);
  });

  test("按量促销与服务档位价格变化产生新价格版本（2026-09-08 断链修复回归）", () => {
    const db = memoryDb();
    const base = {
      version: 2 as const,
      currency: "USD",
      models: [{
        id: "glm-5.3-flash",
        vendor: "zhipu-cn",
        patterns: ["glm-5.3-flash"],
        pricing: {input: 0.8, output: 2.8, cachedInput: 0.23},
        confidence: "official" as const,
      }],
    };
    // 仅新增按量促销：catalog_hash 必须变化，否则目录促销更新后 Worker 永远读旧牌价。
    const withPromotion = {
      ...base,
      models: [{
        ...base.models[0],
        promotions: [{
          from: "2026-09-08T00:00:00+08:00",
          to: "2026-09-09T23:59:59+08:00",
          label: "GLM-5.3-Flash 限时 5 折",
          priceOverride: {input: 0.4, output: 1.4, cachedInput: 0.115},
        }],
      }],
    };
    const first = ensurePricingConfigRevision(db, base);
    const second = ensurePricingConfigRevision(db, withPromotion);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    // 仅变促销倍率：同样必须产生新版本。
    const withMultiplier = {
      ...base,
      models: [{
        ...base.models[0],
        promotions: [{
          from: "2026-09-08T00:00:00+08:00",
          multiplier: 0.5,
        }],
      }],
    };
    const third = ensurePricingConfigRevision(db, withMultiplier);
    expect(third.created).toBe(true);
    expect(third.id).not.toBe(second.id);
    // 仅新增服务档位倍率（2026-10-07 倍率制）：同样必须产生新版本。
    const withFast = {
      ...base,
      models: [{
        ...base.models[0],
        serviceTierPricing: {fastMultiplier: 1.5},
      }],
    };
    const fourth = ensurePricingConfigRevision(db, withFast);
    expect(fourth.created).toBe(true);
    expect(fourth.id).not.toBe(third.id);
  });

  test("套餐促销每日时间窗变化产生新价格版本", () => {
    const db = memoryDb();
    const rulesBase = {
      formula: "token_weighted" as const,
      divisor: 10000,
      modelFactors: {"glm-5.3-flash": {input: 2.3, output: 8, cachedInput: 0.56}},
      quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
      promotions: [{
        from: "2026-09-03T00:00:00+08:00",
        to: "2026-09-21T09:00:00+08:00",
        models: ["glm-5.3-flash"],
        multiplier: 0.5,
      }],
    };
    const base = {
      version: 2 as const,
      currency: "USD",
      models: [{
        id: "glm-5.3-flash",
        vendor: "zhipu-cn",
        patterns: ["glm-5.3-flash"],
        pricing: {input: 0.8, output: 2.8, cachedInput: 0.23},
        planCreditRules: rulesBase,
        confidence: "official" as const,
      }],
    };
    const withWindows = {
      ...base,
      models: [{
        ...base.models[0],
        planCreditRules: {
          ...rulesBase,
          promotions: [{
            ...rulesBase.promotions[0],
            windows: [{start: "23:00", end: "24:00"}, {start: "00:00", end: "09:00"}],
          }],
        },
      }],
    };
    const first = ensurePricingConfigRevision(db, base);
    const second = ensurePricingConfigRevision(db, withWindows);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
  });

  test("fx 快照变化产生新价格版本并随快照恢复（2026-09-15 断链修复回归）", () => {
    const db = memoryDb();
    const base = {
      version: 2 as const,
      currency: "USD",
      models: [{
        id: "gpt-5.6",
        vendor: "openai",
        patterns: ["gpt-5.6"],
        pricing: {input: 5, output: 30},
        confidence: "official" as const,
      }],
    };
    const withFx = {...base, fx: {rates: {"USD/CNY": 7.085}, asOf: "2026-09-04", source: "erate.xyz"}};
    const withFxUpdated = {...base, fx: {rates: {"USD/CNY": 7.15}, asOf: "2026-09-15", source: "erate.xyz"}};

    // 显式递增 effectiveAt：默认取毫秒时钟，同毫秒内连建多个版本会撞 effective_at，
    // loadPricingConfigAt 同点按 id 取最新，恢复断言便不再确定（全量套件下真实复现过）。
    const first = ensurePricingConfigRevision(db, base, "2026-09-01T00:00:00.000Z");
    // 仅新增 fx：必须产生新版本——否则 Worker 恒按编译期常量折算，目录汇率更新脱钩。
    const second = ensurePricingConfigRevision(db, withFx, "2026-09-04T00:00:00.000Z");
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    // 仅更新汇率数值：同样产生新版本，此后请求按新汇率入账。
    const third = ensurePricingConfigRevision(db, withFxUpdated, "2026-09-15T00:00:00.000Z");
    expect(third.created).toBe(true);
    expect(third.id).not.toBe(second.id);
    // 相同 fx 重复提交：去重短路。
    const fourth = ensurePricingConfigRevision(db, withFxUpdated);
    expect(fourth.created).toBe(false);
    expect(fourth.id).toBe(third.id);

    // 按捕获时间恢复：新版本快照必须带回 fx；旧版本（无 fx）保持 undefined 回退口径。
    const beforeFx = loadPricingConfigAt(db, "2020-01-01T00:00:00.000Z");
    expect(beforeFx?.config.fx).toBeUndefined();
    const afterFxUpdated = loadPricingConfigAt(db, "2100-01-01T00:00:00.000Z");
    expect(afterFxUpdated?.config.fx?.rates["USD/CNY"]).toBe(7.15);
    const afterFirstFx = loadPricingConfigAt(db, second.effectiveAt);
    expect(afterFirstFx?.config.fx?.rates["USD/CNY"]).toBe(7.085);
  });

  test("目标级结算系数变化产生新价格版本并随版本恢复（2026-09-23 方案 B 回归）", () => {
    const db = memoryDb();
    const base = {
      version: 2 as const,
      currency: "USD",
      models: [{
        id: "glm-5.3",
        vendor: "auto-code.net",
        patterns: ["glm-5.3"],
        pricing: {input: 5, output: 30},
        confidence: "relay_synced" as const,
      }],
    };
    const withFx16 = {...base, targetSettlementFx: {"auto-code.net": 16}};
    const withFxOne16th = {...base, targetSettlementFx: {"auto-code.net": 0.0625}};

    const first = ensurePricingConfigRevision(db, base, "2026-09-20T00:00:00.000Z");
    // 仅新增/修改目标结算系数：必须产生新版本——缺漏会因 hash 短路导致改系数不落版本。
    const second = ensurePricingConfigRevision(db, withFx16, "2026-09-22T00:00:00.000Z");
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    const third = ensurePricingConfigRevision(db, withFxOne16th, "2026-09-23T04:00:00.000Z");
    expect(third.created).toBe(true);
    expect(third.id).not.toBe(second.id);
    // 相同系数重复提交：去重短路。
    const fourth = ensurePricingConfigRevision(db, withFxOne16th);
    expect(fourth.created).toBe(false);
    expect(fourth.id).toBe(third.id);

    // 按捕获时间恢复：系数随版本带回；旧版本（无该字段）保持 undefined 回退现读口径。
    const legacy = loadPricingConfigAt(db, "2026-09-21T00:00:00.000Z");
    expect(legacy?.config.targetSettlementFx).toBeUndefined();
    const at16 = loadPricingConfigAt(db, "2026-09-22T12:00:00.000Z");
    expect(at16?.config.targetSettlementFx?.["auto-code.net"]).toBe(16);
    const atOne16th = loadPricingConfigAt(db, "2026-09-23T12:00:00.000Z");
    expect(atOne16th?.config.targetSettlementFx?.["auto-code.net"]).toBe(0.0625);
  });

  test("带 +08:00 的 capturedAt 按真实时刻恢复 UTC 价格版本", () => {
    const db = memoryDb();
    const base = {
      version: 2 as const,
      currency: "USD",
      models: [{
        id: "m1",
        vendor: "openai",
        patterns: ["m1"],
        pricing: {input: 1, output: 1},
        confidence: "official" as const,
      }],
    };
    const first = ensurePricingConfigRevision(db, base, "2026-09-22T00:00:00.000Z");
    const second = ensurePricingConfigRevision(db, {
      ...base,
      models: [{...base.models[0], pricing: {input: 9, output: 9}}],
    }, "2026-09-23T01:00:00.000Z");
    expect(second.id).not.toBe(first.id);
    // 2026-09-23 08:00 +08 = 2026-09-23 00:00Z，早于第二版 01:00Z，
    // 不能因字符串日期更晚而错误命中新价格。
    const loaded = loadPricingConfigAt(db, "2026-09-23T08:00:00+08:00");
    expect(loaded?.config.models.find(item => item.id === "m1")?.pricing?.input).toBe(1);
  });
});
