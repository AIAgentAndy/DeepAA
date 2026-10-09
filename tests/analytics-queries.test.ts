import {describe, expect, test} from "vitest";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {computePlanRealCostNano, loadAnalyticsDashboard} from "../src/lib/db/analytics-queries.js";
import {queryTokenPricingSqlite} from "../src/lib/db/token-pricing-queries.js";
import {createRollupRepository} from "../src/lib/analytics/rollup-repository.js";
import {createSqliteFixture} from "./helpers/sqlite-fixture.js";

interface LedgerSeed {
  exchangeId: string;
  capturedAt: string;
  targetId?: string;
  agent?: string;
  model?: string;
  vendor?: string;
  vendorFamily?: string | null;
  billingChannel?: string | null;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  derivedTotal?: number;
  vendorCostNano?: number;
  actualCostNano?: number;
  referenceCostNano?: number | null;
  planCreditCost?: number | null;
  planEstimatedCostNano?: number | null;
  planEstimatedStatus?: string | null;
  resultClass?: string;
  durationMs?: number | null;
  currency?: string;
  usageSource?: string;
  usageQuality?: string;
}

/** 直接写入 usage_ledger 并重建所在小时桶，保证账本 → 小时事实链路真实走过。 */
async function seedAndRollup(fixture: Awaited<ReturnType<typeof createSqliteFixture>>, seeds: LedgerSeed[]) {
  fixture.db.pragma("foreign_keys = OFF");
  const insert = fixture.db.prepare(`INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor,
      rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens,
      output_tokens, reasoning_tokens, total_tokens, currency, vendor_cost,
      actual_cost, duration_ms, usage_source, usage_confidence,
      pricing_snapshot_json, created_at, request_kind, result_class,
      usage_quality, pricing_status, audit_eligible, derived_total_tokens,
      total_tokens_basis, cost_basis, vendor_cost_nano, actual_cost_nano,
      billing_channel, vendor_family, reference_cost_nano, plan_credit_cost,
      plan_estimated_cost, plan_estimated_currency, plan_estimated_fx,
      plan_estimated_cost_nano, plan_estimated_status
    ) VALUES (?, ?, 'fp', ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?,
      ?, 'exact', '{}', ?, 'model', ?,
      ?, 'priced', 0, ?, 'derived', 'payg_rate', ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?)`);
  for (const seed of seeds) {
    const input = seed.inputTokens ?? 0;
    const cacheRead = seed.cacheReadTokens ?? 0;
    const cacheWrite = seed.cacheWriteTokens ?? 0;
    const output = seed.outputTokens ?? 0;
    const derived = seed.derivedTotal ?? input + cacheRead + cacheWrite + output;
    insert.run(
      seed.exchangeId,
      seed.targetId ?? "t",
      seed.agent ?? "codex",
      seed.model ?? "m",
      seed.vendor ?? "v",
      input, cacheRead, cacheWrite, output,
      derived,
      seed.currency ?? "USD",
      (seed.vendorCostNano ?? 0) / 1e9,
      (seed.actualCostNano ?? seed.vendorCostNano ?? 0) / 1e9,
      seed.durationMs ?? 100,
      seed.usageSource ?? "provider_usage",
      seed.capturedAt,
      seed.resultClass ?? "success",
      seed.usageQuality ?? "exact",
      derived,
      seed.vendorCostNano ?? 0,
      seed.actualCostNano ?? seed.vendorCostNano ?? 0,
      seed.billingChannel ?? null,
      seed.vendorFamily ?? null,
      seed.referenceCostNano ?? null,
      seed.planCreditCost ?? null,
      seed.planEstimatedStatus === "estimated" && seed.planEstimatedCostNano !== undefined && seed.planEstimatedCostNano !== null
        ? seed.planEstimatedCostNano / 1e9
        : null,
      seed.planEstimatedStatus === "estimated" ? "CNY" : null,
      seed.planEstimatedStatus === "estimated" ? 1 : null,
      seed.planEstimatedCostNano ?? null,
      seed.planEstimatedStatus ?? null,
    );
  }
  const repository = createRollupRepository(fixture.db);
  const buckets = new Set(seeds.map(seed => `${seed.capturedAt.slice(0, 13)}:00:00.000Z`));
  for (const bucket of buckets) {
    await repository.rebuildBucket(bucket);
  }
  return repository;
}

const RANGE = {
  start: "2026-08-27T00:00:00.000Z",
  end: "2026-08-28T00:00:00.000Z",
  granularity: "hour" as const,
  bucketStep: 1,
  bucketCount: 24,
  timezone: "UTC",
  now: "2026-08-27T12:00:00.000Z",
};

describe("仪表盘查询（时间范围口径）", () => {
  test("Token 三分与双口径费用按 billing_channel 严格拆分", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "payg-1", capturedAt: "2026-08-27T05:10:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, vendorCostNano: 2_000_000_000, actualCostNano: 1_500_000_000, durationMs: 1200},
        {exchangeId: "payg-2", capturedAt: "2026-08-27T05:40:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 50, outputTokens: 10, resultClass: "upstream_error", vendorCostNano: 500_000_000, durationMs: 800},
        {exchangeId: "plan-1", capturedAt: "2026-08-27T06:15:00.000Z", billingChannel: "plan", vendorFamily: "zhipu", referenceCostNano: 3_400_000_000, planCreditCost: 42.5, inputTokens: 200, outputTokens: 60},
        {exchangeId: "out-1", capturedAt: "2026-08-27T23:59:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 10, vendorCostNano: 100_000_000},
        {exchangeId: "prev-1", capturedAt: "2026-08-26T10:00:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 70, vendorCostNano: 900_000_000},
      ]);

      const result = await loadAnalyticsDashboard(fixture.db, RANGE);

      expect(result.summary.totalTokens).toBe(100 + 40 + 30 + 50 + 10 + 200 + 60 + 10);
      expect(result.summary.inputTokens).toBe(100 + 50 + 200 + 10);
      expect(result.summary.outputTokens).toBe(40 + 10 + 60);
      expect(result.summary.cacheTokens).toBe(30);
      /* 金额列消费口径（2026-09-17）：payg-2 为 upstream_error 失败行，不计入金额。 */
      expect(result.summary.paygCostNano).toBe(2_000_000_000 + 100_000_000);
      expect(result.summary.paygActualCostNano).toBe(1_500_000_000 + 100_000_000);
      expect(result.summary.marketCostNano).toBe(3_400_000_000);
      expect(result.summary.marketRequestCount).toBe(1);
      expect(result.summary.planCreditCost).toBeCloseTo(42.5, 6);
      expect(result.summary.requestCount).toBe(4);
      expect(result.summary.successRate).toBeCloseTo(3 / 4, 6);
      expect(result.summary.failureCount).toBe(1);
      expect(result).not.toHaveProperty("comparison");
    } finally {
      await fixture.cleanup();
    }
  });

  test("趋势零填充当前小时桶且不返回上一周期序列", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "a", capturedAt: "2026-08-27T01:05:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 10, vendorCostNano: 100_000_000},
        {exchangeId: "b", capturedAt: "2026-08-26T01:20:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 20, vendorCostNano: 200_000_000},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.trend.buckets).toHaveLength(24);
      expect(result.trend.buckets[1].totalTokens).toBe(10);
      expect(result.trend.buckets[0].totalTokens).toBe(0);
      expect(result.trend).not.toHaveProperty("prev");
      expect(result.trend.candidateBuckets).toBe(1);
      expect(result.limited).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("48 小时按连续 2 小时桶聚合，不合并不同日期的相同小时", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "day-1", capturedAt: "2026-08-27T01:05:00.000Z", inputTokens: 10},
        {exchangeId: "day-2", capturedAt: "2026-08-28T01:05:00.000Z", inputTokens: 20},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, {
        ...RANGE,
        end: "2026-08-29T00:00:00.000Z",
        bucketStep: 2,
        bucketCount: 24,
      });
      expect(result.trend.buckets).toHaveLength(24);
      expect(result.trend.buckets[0].totalTokens).toBe(10);
      expect(result.trend.buckets[12].totalTokens).toBe(20);
      expect(result.models.items.every(item => item.series.length === 24)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("模型趋势：top5 + 其他合并，序列按桶对齐", async () => {
    const fixture = await createSqliteFixture();
    try {
      const seeds: LedgerSeed[] = [];
      for (let i = 0; i < 7; i += 1) {
        seeds.push({
          exchangeId: `m-${i}`,
          capturedAt: `2026-08-27T0${i % 8}:10:00.000Z`,
          model: `model-${i}`,
          billingChannel: "pay_as_you_go",
          inputTokens: (i + 1) * 100,
          vendorCostNano: (i + 1) * 100_000_000,
        });
      }
      await seedAndRollup(fixture, seeds);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.models.items).toHaveLength(6);
      expect(result.models.items[0].model).toBe("model-6");
      expect(result.models.items[5].model).toContain("其他");
      expect(result.models.otherModelCount).toBe(2);
      expect(result.models.limited).toBe(true);
      for (const item of result.models.items) {
        expect(item.series).toHaveLength(24);
      }
      expect(result.models.items[0].series.reduce((acc, value) => acc + value, 0)).toBe(700);
    } finally {
      await fixture.cleanup();
    }
  });

  test("供应商健康度：成功率与平均耗时按真实供应商目标（target_id）聚合", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "z1", capturedAt: "2026-08-27T02:00:00.000Z", targetId: "open.zhipu.example", vendorFamily: "zhipu", inputTokens: 10, durationMs: 1000},
        {exchangeId: "z2", capturedAt: "2026-08-27T02:10:00.000Z", targetId: "open.zhipu.example", vendorFamily: "zhipu", inputTokens: 20, durationMs: 3000, resultClass: "success"},
        {exchangeId: "z3", capturedAt: "2026-08-27T02:20:00.000Z", targetId: "open.zhipu.example", vendorFamily: "zhipu", inputTokens: 30, durationMs: 5000, resultClass: "upstream_error"},
        {exchangeId: "k1", capturedAt: "2026-08-27T02:30:00.000Z", targetId: "moonshot.example", vendorFamily: "moonshot", inputTokens: 40, durationMs: 2000},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      const zhipu = result.vendors.find(vendor => vendor.targetId === "open.zhipu.example");
      const moonshot = result.vendors.find(vendor => vendor.targetId === "moonshot.example");
      expect(zhipu).toBeDefined();
      expect(zhipu!.name).toBe("open.zhipu.example");
      expect(zhipu!.legacy).toBe(false);
      expect(zhipu!.vendorFamily).toBe("zhipu");
      expect(zhipu!.successCount).toBe(2);
      expect(zhipu!.failureCount).toBe(1);
      expect(zhipu!.successRate).toBeCloseTo(2 / 3, 6);
      expect(zhipu!.avgDurationMs).toBeCloseTo(3000, 6);
      expect(moonshot!.successRate).toBe(1);
      expect(moonshot!.avgDurationMs).toBe(2000);
      expect(result.vendors[0].targetId).toBe("open.zhipu.example");
    } finally {
      await fixture.cleanup();
    }
  });

  test("缺失 target_id 的历史账本聚成 legacy 桶并标注，不与真实供应商混排", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "legacy-openai-1", capturedAt: "2026-08-27T02:00:00.000Z", targetId: "", vendor: "openai", vendorFamily: null, inputTokens: 30},
        {exchangeId: "legacy-openai-2", capturedAt: "2026-08-27T02:10:00.000Z", targetId: "", vendor: "openai", vendorFamily: "", inputTokens: 20},
        {exchangeId: "legacy-unknown", capturedAt: "2026-08-27T02:20:00.000Z", targetId: "", vendor: "unknown", vendorFamily: "unknown", inputTokens: 5},
        // 同样的价格中心 vendor（openai），但属于真实目标：必须独立成行，不得并入 legacy 桶。
        {exchangeId: "known-target", capturedAt: "2026-08-27T02:30:00.000Z", targetId: "relay.example", vendor: "openai", vendorFamily: null, inputTokens: 7},
      ]);

      const result = await loadAnalyticsDashboard(fixture.db, RANGE);

      const legacyOpenai = result.vendors.find(vendor => vendor.legacy && vendor.vendorFamily === "openai");
      expect(legacyOpenai).toBeDefined();
      expect(legacyOpenai!.name).toBe("openai");
      expect(legacyOpenai!.targetId).toBeNull();
      expect(legacyOpenai!.totalTokens).toBe(50);
      const legacyUnknown = result.vendors.find(vendor => vendor.legacy && vendor.vendorFamily === "unknown");
      expect(legacyUnknown!.totalTokens).toBe(5);
      const known = result.vendors.find(vendor => vendor.targetId === "relay.example");
      expect(known).toBeDefined();
      expect(known!.legacy).toBe(false);
      expect(known!.totalTokens).toBe(7);
    } finally {
      await fixture.cleanup();
    }
  });

  test("套餐/订阅通道按目标聚合，且不混入按量目标", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "p1", capturedAt: "2026-08-27T03:00:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", model: "glm-5.3", referenceCostNano: 5_000_000_000, planCreditCost: 100, inputTokens: 500},
        {exchangeId: "p2", capturedAt: "2026-08-27T03:30:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", model: "glm-5.3", referenceCostNano: 2_000_000_000, inputTokens: 300},
        {exchangeId: "p3", capturedAt: "2026-08-27T04:00:00.000Z", targetId: "kimi-plan", billingChannel: "plan", vendorFamily: "moonshot", model: "kimi-for-coding", referenceCostNano: 1_000_000_000, inputTokens: 100},
        {exchangeId: "payg-x", capturedAt: "2026-08-27T04:30:00.000Z", targetId: "zhipu-coding", billingChannel: "pay_as_you_go", inputTokens: 999, vendorCostNano: 1_000_000_000},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.plans).toHaveLength(2);
      const zhipu = result.plans.find(plan => plan.targetId === "zhipu-coding");
      expect(zhipu!.channel).toBe("plan");
      expect(zhipu!.requestCount).toBe(2);
      expect(zhipu!.marketCostNano).toBe(7_000_000_000);
      expect(zhipu!.creditCost).toBeCloseTo(100, 6);
      expect(zhipu!.models).toEqual(["glm-5.3"]);
      expect(result.plans.find(plan => plan.targetId === "kimi-plan")!.totalTokens).toBe(100);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Agent 维度聚合与热力图固定最近本地日窗口", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "a1", capturedAt: "2026-08-27T05:00:00.000Z", agent: "zcode", billingChannel: "pay_as_you_go", inputTokens: 100, vendorCostNano: 1_000_000_000},
        {exchangeId: "a2", capturedAt: "2026-08-27T05:30:00.000Z", agent: "codex", billingChannel: "pay_as_you_go", inputTokens: 50, vendorCostNano: 500_000_000},
        {exchangeId: "h1", capturedAt: "2026-08-21T05:00:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 70, vendorCostNano: 100_000_000},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.agents[0].agent).toBe("zcode");
      expect(result.agents[0].totalTokens).toBe(100);
      expect(result.heatmap.days).toHaveLength(7);
      // 固定最近 7 天窗口（now=08-27T12:00 → 08-20T12:00 起）：08-21T05 在窗口内且落在 08-21 本地日
      const totals = result.heatmap.days.map(day => day.total).reduce((acc, value) => acc + value, 0);
      expect(totals).toBe(100 + 50 + 70);
    } finally {
      await fixture.cleanup();
    }
  });

  test("热力图小时随所选时区转换，并可跨到前一自然日", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "timezone-hour", capturedAt: "2026-08-27T03:10:00.000Z", inputTokens: 42},
      ]);
      const cases = [
        {timezone: "Etc/GMT-8", date: "2026-08-27", hour: 11},
        {timezone: "UTC", date: "2026-08-27", hour: 3},
        {timezone: "Etc/GMT+8", date: "2026-08-26", hour: 19},
      ];

      for (const item of cases) {
        const result = await loadAnalyticsDashboard(fixture.db, {...RANGE, timezone: item.timezone});
        const day = result.heatmap.days.find(candidate => candidate.date === item.date);
        expect(day, `${item.timezone} 应包含 ${item.date}`).toBeDefined();
        expect(day!.values[item.hour], `${item.timezone} 应落在 ${item.hour} 点`).toBe(42);
        expect(day!.values.filter(value => value > 0)).toEqual([42]);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("多币种时返回分币种明细，金额按人民币统一口径聚合（2026-09-05 四层分离）", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "ex-usd", targetId: "t1", model: "m1", capturedAt: "2026-08-27T06:15:00.000Z", inputTokens: 1, outputTokens: 1, vendorCostNano: 1_000_000_000, actualCostNano: 1_000_000_000, currency: "USD"},
        {exchangeId: "ex-cny", targetId: "t2", model: "m2", capturedAt: "2026-08-27T06:20:00.000Z", inputTokens: 1, outputTokens: 1, vendorCostNano: 2_000_000_000, actualCostNano: 2_000_000_000, currency: "CNY"},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.summary.hasMultipleSourceCurrencies).toBe(true);
      // facts 金额列写入时已按结算系数物化为人民币：多原始币种不再阻断汇总。
      expect(result.summary.paygCostNano).toBe(3_000_000_000);
      expect(result.summary.paygActualCostNano).toBe(3_000_000_000);
      expect(result.summary.sourceCurrencies.map(currency => currency.currency).sort()).toEqual(["CNY", "USD"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("零金额占位币种行不阻断多币种判定（未计价失败请求不拦汇总）", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "ex-cny", targetId: "t1", model: "glm-5.3-flash", capturedAt: "2026-08-27T06:15:00.000Z", inputTokens: 1, outputTokens: 1, vendorCostNano: 2_000_000_000, actualCostNano: 2_000_000_000, currency: "CNY"},
        // 新写入路径：未计价请求币种为 'unknown'，金额为 0。
        {exchangeId: "ex-unknown", targetId: "t1", model: "unknown", capturedAt: "2026-08-27T06:16:00.000Z", inputTokens: 1, outputTokens: 0, currency: "unknown"},
        // 历史存量：四层分离前未计价请求落的 'USD' 占位，金额为 0。
        {exchangeId: "ex-legacy-usd", targetId: "t1", model: "unknown", capturedAt: "2026-08-27T06:17:00.000Z", inputTokens: 1, outputTokens: 0, currency: "USD"},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.summary.hasMultipleSourceCurrencies).toBe(false);
      expect(result.summary.paygCostNano).toBe(2_000_000_000);
      expect(result.summary.paygActualCostNano).toBe(2_000_000_000);
    } finally {
      await fixture.cleanup();
    }
  });

  test("范围内全部为未计价零金额行时正常返回零金额", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "ex-unknown-1", targetId: "t1", model: "unknown", capturedAt: "2026-08-27T06:15:00.000Z", inputTokens: 1, outputTokens: 0, currency: "unknown"},
        {exchangeId: "ex-unknown-2", targetId: "t1", model: "unknown", capturedAt: "2026-08-27T06:16:00.000Z", inputTokens: 1, outputTokens: 0, currency: "unknown"},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.summary.hasMultipleSourceCurrencies).toBe(false);
      /* 2026-09-16 模型口径：unknown 模型行不计入 KPI，改以 auxiliaryRequestCount 透出。 */
      expect(result.summary.requestCount).toBe(0);
      expect(result.summary.auxiliaryRequestCount).toBe(2);
      expect(result.summary.paygCostNano).toBe(0);
      expect(result.summary.paygActualCostNano).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("unknown 模型辅助行不计入 KPI，口径与 Token 价格页默认过滤对齐（2026-09-16）", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "aux-1", targetId: "t1", model: "unknown", capturedAt: "2026-08-27T05:00:00.000Z", inputTokens: 500, outputTokens: 100},
        {exchangeId: "aux-2", targetId: "t1", model: "unknown", capturedAt: "2026-08-27T05:10:00.000Z", inputTokens: 300, outputTokens: 50, resultClass: "cancelled"},
        {exchangeId: "model-1", targetId: "t1", model: "glm-5.3", capturedAt: "2026-08-27T05:20:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 100, outputTokens: 40, vendorCostNano: 1_000_000_000},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      /* 汇总：只有模型请求计入；辅助行单独透出 */
      expect(result.summary.requestCount).toBe(1);
      expect(result.summary.auxiliaryRequestCount).toBe(2);
      expect(result.summary.totalTokens).toBe(140);
      expect(result.summary.paygCostNano).toBe(1_000_000_000);
      /* 趋势、模型维度同步排除 unknown 行 */
      expect(result.trend.buckets.reduce((acc, bucket) => acc + bucket.requestCount, 0)).toBe(1);
      expect(result.models.items.map(item => item.model)).toEqual(["glm-5.3"]);
      expect(result.costLeaderboard.rows).toHaveLength(1);
      expect(result.costLeaderboard.rows[0]?.model).toBe("glm-5.3");
    } finally {
      await fixture.cleanup();
    }
  });

  test("按量倍率前/倍率后与 Token 价格页同一表达式：估算用量行倍率后记 0（2026-09-16）", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "exact-1", capturedAt: "2026-08-27T05:00:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 100, outputTokens: 40, vendorCostNano: 2_000_000_000, actualCostNano: 1_500_000_000},
        /* tokenizer_estimated 行：账本口径「估算用量不纳入实际总消费」——倍率前计供应商成本，倍率后记 0 */
        {exchangeId: "est-1", capturedAt: "2026-08-27T05:10:00.000Z", billingChannel: "pay_as_you_go", inputTokens: 500, outputTokens: 100, vendorCostNano: 800_000_000, actualCostNano: 70_000_000, usageSource: "tokenizer_estimated", usageQuality: "estimated"},
      ]);
      const dashboard = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(dashboard.summary.paygCostNano).toBe(2_800_000_000);
      expect(dashboard.summary.paygActualCostNano).toBe(1_500_000_000);

      /* 同一窗口、同一过滤（默认结果口径 + 按量）下，Token 价格页汇总必须与仪表盘 KPI 完全一致 */
      const filters = new URLSearchParams({start: RANGE.start, end: RANGE.end});
      const pricing = queryTokenPricingSqlite(fixture.db, filters, new Date(RANGE.now));
      expect(pricing.summary.paygVendorCost).toBeCloseTo(dashboard.summary.paygCostNano / 1e9, 6);
      expect(pricing.summary.paygActualCost).toBeCloseTo(dashboard.summary.paygActualCostNano / 1e9, 6);
    } finally {
      await fixture.cleanup();
    }
  });

  test("范围无数据时全零且不报错", async () => {
    const fixture = await createSqliteFixture();
    try {
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.summary.requestCount).toBe(0);
      expect(result.summary.successRate).toBeNull();
      expect(result.trend.buckets).toHaveLength(24);
      expect(result.models.items).toHaveLength(0);
      expect(result.plans).toHaveLength(0);
      expect(result.vendors).toHaveLength(0);
      expect(result.costLeaderboard.rows).toHaveLength(0);
      expect(result.costLeaderboard.limited).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("computePlanRealCostNano：月费 × 积分比率 × 窗口天数折算", () => {
    /* 月窗口：fee 100 × (500/5000) × (30/30) = $10 */
    expect(computePlanRealCostNano({monthlyFee: 100, creditsConsumed: 500, quotaTotal: 5000, windowDays: 30})).toBe(10_000_000_000);
    /* 周窗口按 7/30 折算：100 × 0.1 × 7/30 ≈ $0.2333 */
    expect(computePlanRealCostNano({monthlyFee: 100, creditsConsumed: 500, quotaTotal: 5000, windowDays: 7})).toBe(2_333_333_333);
    /* 5 小时窗口按 (5/24)/30 折算 */
    expect(computePlanRealCostNano({monthlyFee: 240, creditsConsumed: 10, quotaTotal: 1000, windowDays: 5 / 24})).toBe(Math.round(240e9 * 0.01 * (5 / 24) / 30));
    /* 缺月费 / 缺额度 / 非法值 → null；零消耗 → 0 */
    expect(computePlanRealCostNano({monthlyFee: undefined, creditsConsumed: 500, quotaTotal: 5000, windowDays: 30})).toBeNull();
    expect(computePlanRealCostNano({monthlyFee: 100, creditsConsumed: 500, quotaTotal: undefined, windowDays: 30})).toBeNull();
    expect(computePlanRealCostNano({monthlyFee: 100, creditsConsumed: 500, quotaTotal: 0, windowDays: 30})).toBeNull();
    expect(computePlanRealCostNano({monthlyFee: -1, creditsConsumed: 500, quotaTotal: 5000, windowDays: 30})).toBeNull();
    expect(computePlanRealCostNano({monthlyFee: 100, creditsConsumed: 0, quotaTotal: undefined, windowDays: undefined})).toBe(0);
  });

  test("summary 量/套拆分与套餐真实成本：月费×积分比率，多窗口取最长", async () => {
    const fixture = await createSqliteFixture();
    const previousDataDir = process.env.DEEPAA_DATA_DIR;
    try {
      /* proxy-config 提供月费与目标名：DEEPAA_DATA_DIR 指向 fixture 临时目录 */
      await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
        version: 3,
        targets: [
          {id: "zhipu-coding", name: "智谱 Coding", pricing: {planMonthlyFee: 200}},
          {id: "relay.example", name: "Relay"},
        ],
      }), "utf8");
      process.env.DEEPAA_DATA_DIR = fixture.dataDir;
      /* 套餐额度快照：weekly 跨两个密钥合计 5000；5h 窗口不得干扰（优先级更低）。
         同一密钥只取最新快照，不重复累计。 */
      const insertQuota = fixture.db.prepare(`INSERT INTO plan_quota_snapshots(
        target_id, credential_id, provider_type, window_label, used, total, remaining, unit, captured_at
      ) VALUES (?, ?, 'zhipu', ?, ?, ?, NULL, 'credits', ?)`);
      insertQuota.run("zhipu-coding", "key-a", "weekly", 300, 3000, "2026-08-27T08:00:00.000Z");
      insertQuota.run("zhipu-coding", "key-b", "weekly", 200, 2000, "2026-08-27T08:00:00.000Z");
      insertQuota.run("zhipu-coding", "key-a", "5h", 50, 300, "2026-08-27T08:00:00.000Z");

      await seedAndRollup(fixture, [
        /* 入账冻结（2026-09-15）：估算金额由派生期写入，查询端只读聚合值。
           预期口径仍为 200 × (500/5000) × (7/30)，按当时 weekly 窗口折算后冻结。 */
        {exchangeId: "plan-1", capturedAt: "2026-08-27T03:00:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", model: "glm-5.3", referenceCostNano: 5_000_000_000, planCreditCost: 400, planEstimatedCostNano: Math.round(200e9 * 0.1 * (7 / 30)) * 400 / 500, planEstimatedStatus: "estimated", inputTokens: 500, outputTokens: 40, cacheReadTokens: 60},
        {exchangeId: "plan-2", capturedAt: "2026-08-27T03:30:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", model: "glm-5.3", referenceCostNano: 2_000_000_000, planCreditCost: 100, planEstimatedCostNano: Math.round(200e9 * 0.1 * (7 / 30)) * 100 / 500, planEstimatedStatus: "estimated", inputTokens: 300, outputTokens: 20, resultClass: "upstream_error"},
        {exchangeId: "payg-1", capturedAt: "2026-08-27T04:00:00.000Z", targetId: "relay.example", billingChannel: "pay_as_you_go", model: "gpt-5.6", inputTokens: 900, outputTokens: 100, cacheWriteTokens: 50, vendorCostNano: 3_000_000_000, actualCostNano: 2_000_000_000},
        {exchangeId: "payg-2", capturedAt: "2026-08-27T04:30:00.000Z", targetId: "relay.example", billingChannel: "pay_as_you_go", model: "gpt-5.6", inputTokens: 60, resultClass: "upstream_error", vendorCostNano: 100_000_000},
      ]);

      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      /* 量/套拆分：请求数与 Token 构成 */
      expect(result.summary.requestCount).toBe(4);
      expect(result.summary.planRequestCount).toBe(2);
      expect(result.summary.planTokens).toBe(920);
      expect(result.summary.paygInputTokens).toBe(960);
      expect(result.summary.paygOutputTokens).toBe(100);
      expect(result.summary.paygCacheTokens).toBe(50);
      expect(result.summary.planInputTokens).toBe(800);
      expect(result.summary.planOutputTokens).toBe(60);
      expect(result.summary.planCacheTokens).toBe(60);
      /* 量/套拆分：成功率 */
      expect(result.summary.paygSuccessCount).toBe(1);
      expect(result.summary.paygFailureCount).toBe(1);
      expect(result.summary.paygSuccessRate).toBeCloseTo(0.5, 6);
      expect(result.summary.planSuccessCount).toBe(1);
      expect(result.summary.planFailureCount).toBe(1);
      expect(result.summary.planSuccessRate).toBeCloseTo(0.5, 6);
      /* 套餐成本估算（入账冻结）：金额消费口径只含 plan-1（plan-2 为 upstream_error 不计费）
         = 200 × (400/5000) × (7/30)，按 plan-1 积分占比 400/500 折算。 */
      expect(result.summary.planCreditCost).toBeCloseTo(400, 6);
      expect(result.summary.planRealCostNano).toBeCloseTo(Math.round(200e9 * 0.1 * (7 / 30)) * 400 / 500, 6);
      expect(result.summary.planRealCostUnavailable).toBe(false);
      /* 套餐卡金额块：真实成本与 summary 同口径 */
      const planCard = result.plans.find(plan => plan.targetId === "zhipu-coding");
      expect(planCard).toBeDefined();
      expect(planCard!.planRealCostNano).toBeCloseTo(Math.round(200e9 * 0.1 * (7 / 30)) * 400 / 500, 6);
      expect(planCard!.marketCostNano).toBe(5_000_000_000);
      /* 趋势桶带积分与通道请求数，供 KPI 卡按维度画趋势线（两笔套餐消耗同在 03:00 桶） */
      expect(result.trend.buckets[3].planCreditCost).toBeCloseTo(400, 6);
      expect(result.trend.buckets[3].planRequestCount).toBe(2);
      expect(result.trend.buckets[3].planTokens).toBe(920);
      expect(result.trend.buckets[4].planCreditCost).toBe(0);
      expect(result.trend.buckets[4].planRequestCount).toBe(0);
    } finally {
      if (previousDataDir === undefined) delete process.env.DEEPAA_DATA_DIR;
      else process.env.DEEPAA_DATA_DIR = previousDataDir;
      await fixture.cleanup();
    }
  });

  test("套餐月费或周期额度缺失时 planRealCostUnavailable 置位", async () => {
    const fixture = await createSqliteFixture();
    const previousDataDir = process.env.DEEPAA_DATA_DIR;
    try {
      /* 无 proxy-config（无月费）、无额度快照，但存在套餐消耗 */
      delete process.env.DEEPAA_DATA_DIR;
      await seedAndRollup(fixture, [
        {exchangeId: "plan-1", capturedAt: "2026-08-27T03:00:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", model: "glm-5.3", referenceCostNano: 5_000_000_000, planCreditCost: 400, inputTokens: 500},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.summary.planRealCostUnavailable).toBe(true);
      expect(result.summary.planRealCostNano).toBe(0);
      expect(result.summary.planRequestCount).toBe(1);
    } finally {
      if (previousDataDir === undefined) delete process.env.DEEPAA_DATA_DIR;
      else process.env.DEEPAA_DATA_DIR = previousDataDir;
      await fixture.cleanup();
    }
  });

  test("成本排行榜：目标×模型分组、每百万真实成本降序、legacy 行兜底", async () => {    const fixture = await createSqliteFixture();
    const previousDataDir = process.env.DEEPAA_DATA_DIR;
    try {
      await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
        version: 3,
        targets: [
          {id: "zhipu-coding", name: "智谱 Coding", pricing: {planMonthlyFee: 200}},
          {id: "relay.example", name: "Relay"},
        ],
      }), "utf8");
      process.env.DEEPAA_DATA_DIR = fixture.dataDir;
      const insertQuota = fixture.db.prepare(`INSERT INTO plan_quota_snapshots(
        target_id, provider_type, window_label, used, total, remaining, unit, captured_at
      ) VALUES (?, 'zhipu', 'monthly', ?, ?, NULL, 'credits', '2026-08-27T08:00:00.000Z')`);
      insertQuota.run("zhipu-coding", 300, 5000);

      await seedAndRollup(fixture, [
        /* 套餐行：入账冻结估算 $20（200 元月费 × 500/5000 × 30/30）；Token 800 → $25k/M（应排第一） */
        {exchangeId: "plan-1", capturedAt: "2026-08-27T03:00:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", model: "glm-5.3", referenceCostNano: 5_000_000_000, planCreditCost: 500, planEstimatedCostNano: 20_000_000_000, planEstimatedStatus: "estimated", inputTokens: 800},
        /* 按量行：$2 实付 / 10M Token → $0.2/M */
        {exchangeId: "payg-1", capturedAt: "2026-08-27T04:00:00.000Z", targetId: "relay.example", billingChannel: "pay_as_you_go", model: "gpt-5.6", inputTokens: 9_000_000, outputTokens: 1_000_000, vendorCostNano: 3_000_000_000, actualCostNano: 2_000_000_000},
        /* legacy 行：无目标信息，仅按量实付参与 */
        {exchangeId: "legacy-1", capturedAt: "2026-08-27T05:00:00.000Z", targetId: "", vendor: "openai", vendorFamily: "openai", billingChannel: "pay_as_you_go", model: "gpt-4o", inputTokens: 4_000_000, vendorCostNano: 500_000_000, actualCostNano: 400_000_000},
      ]);

      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      const rows = result.costLeaderboard.rows;
      expect(rows).toHaveLength(3);
      /* 每百万真实成本降序：glm（$25,000/M）> gpt-4o（$0.1/M）> gpt-5.6（$0.2/M）? 修正：gpt-4o 0.4e9/4e6*1e6=1e8（$0.1/M），gpt-5.6 2e9/1e7*1e6=2e8（$0.2/M）→ gpt-5.6 在前 */
      expect(rows[0].model).toBe("glm-5.3");
      expect(rows[0].targetName).toBe("智谱 Coding");
      expect(rows[0].planRealCostNano).toBe(20_000_000_000);
      expect(rows[0].planEstimatedPending).toBe(false);
      expect(rows[0].realCostNano).toBe(20_000_000_000);
      expect(rows[0].costPerMillionNano).toBe(Math.round((20e9 / 800) * 1e6));
      expect(rows[1].model).toBe("gpt-5.6");
      expect(rows[1].targetName).toBe("Relay");
      expect(rows[1].realCostNano).toBe(2_000_000_000);
      expect(rows[1].costPerMillionNano).toBe(200_000_000);
      expect(rows[2].model).toBe("gpt-4o");
      expect(rows[2].targetName).toBe("旧数据");
      expect(rows[2].costPerMillionNano).toBe(100_000_000);
      expect(result.costLeaderboard.candidateCount).toBe(3);
      expect(result.costLeaderboard.limited).toBe(false);
    } finally {
      if (previousDataDir === undefined) delete process.env.DEEPAA_DATA_DIR;
      else process.env.DEEPAA_DATA_DIR = previousDataDir;
      await fixture.cleanup();
    }
  });

  test("成本排行榜：分组超出扫描上限时有界截断并返回 limited 标记", async () => {
    const fixture = await createSqliteFixture();
    try {
      /* 205 个模型×目标分组，超过 200 的扫描硬界：只处理 200、候选 205、标记 limited，行数不超 10。 */
      const seeds: LedgerSeed[] = [];
      for (let index = 0; index < 205; index += 1) {
        seeds.push({
          exchangeId: `many-${index}`,
          capturedAt: "2026-08-27T02:00:00.000Z",
          targetId: "relay.example",
          billingChannel: "pay_as_you_go",
          model: `model-${String(index).padStart(3, "0")}`,
          inputTokens: 100 + index,
          vendorCostNano: 1_000_000_000 + index,
        });
      }
      await seedAndRollup(fixture, seeds);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.costLeaderboard.candidateCount).toBe(205);
      expect(result.costLeaderboard.processedCount).toBe(200);
      expect(result.costLeaderboard.limited).toBe(true);
      expect(result.costLeaderboard.rows.length).toBeLessThanOrEqual(10);
      /* 截断路径下排序仍按每百万估算成本降序。 */
      const perMillions = result.costLeaderboard.rows.map(row => row.costPerMillionNano ?? Number.POSITIVE_INFINITY);
      expect([...perMillions].sort((left, right) => right - left)).toEqual(perMillions);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("仪表盘查询（币种与套餐估算冻结口径 2026-09-15）", () => {
  test("多原始币种不隐藏金额：hasMultipleSourceCurrencies 仅作附注，人民币金额照常返回", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        /* CNY 原始币种行（智谱 1:1） */
        {exchangeId: "cny-1", capturedAt: "2026-08-27T02:00:00.000Z", billingChannel: "pay_as_you_go", currency: "CNY", vendorCostNano: 8_000_000_000, actualCostNano: 8_000_000_000},
        /* USD 原始币种行（官方全球 7.085 折算后的人民币 nano） */
        {exchangeId: "usd-1", capturedAt: "2026-08-27T03:00:00.000Z", billingChannel: "pay_as_you_go", currency: "USD", vendorCostNano: 35_425_000_000, actualCostNano: 35_425_000_000},
        /* 未计价 unknown 行：0 金额不参与币种判定 */
        {exchangeId: "unk-1", capturedAt: "2026-08-27T04:00:00.000Z", billingChannel: "pay_as_you_go", currency: "unknown"},
      ]);

      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.summary.hasMultipleSourceCurrencies).toBe(true);
      expect(result.summary.settlementCurrency).toBe("CNY");
      expect(result.summary.sourceCurrencies.map(item => item.currency)).toEqual(["CNY", "USD"]);
      /* 关键契约：多币种时金额字段仍必须返回（前端不得显示 —）。 */
      expect(result.summary.paygActualCostNano).toBe(8_000_000_000 + 35_425_000_000);
      expect(result.summary.paygCostNano).toBe(8_000_000_000 + 35_425_000_000);
    } finally {
      await fixture.cleanup();
    }
  });

  test("单币种范围 hasMultipleSourceCurrencies=false，unknown 占位不触发多币种", async () => {
    const fixture = await createSqliteFixture();
    try {
      await seedAndRollup(fixture, [
        {exchangeId: "cny-1", capturedAt: "2026-08-27T02:00:00.000Z", billingChannel: "pay_as_you_go", currency: "CNY", vendorCostNano: 1_000_000_000},
        {exchangeId: "unk-1", capturedAt: "2026-08-27T03:00:00.000Z", billingChannel: "pay_as_you_go", currency: "unknown"},
      ]);
      const result = await loadAnalyticsDashboard(fixture.db, RANGE);
      expect(result.summary.hasMultipleSourceCurrencies).toBe(false);
      expect(result.summary.sourceCurrencies.map(item => item.currency)).toEqual(["CNY"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("套餐成本估算读入账冻结聚合值；旧口径行标注部分估算", async () => {
    const fixture = await createSqliteFixture();
    try {
      await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
        version: 3,
        targets: [
          {id: "zhipu-coding", name: "智谱 Coding", pricing: {planMonthlyFee: 200}},
        ],
      }), "utf8");
      const previousDataDir = process.env.DEEPAA_DATA_DIR;
      process.env.DEEPAA_DATA_DIR = fixture.dataDir;
      try {
        await seedAndRollup(fixture, [
          /* 新口径：入账时冻结 20 元估算 */
          {exchangeId: "plan-new", capturedAt: "2026-08-27T03:00:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", referenceCostNano: 5_000_000_000, planCreditCost: 500, planEstimatedCostNano: 20_000_000_000, planEstimatedStatus: "estimated"},
          /* 旧口径：有消耗但 status 为 NULL（不回填），必须触发部分估算标注 */
          {exchangeId: "plan-legacy", capturedAt: "2026-08-27T04:00:00.000Z", targetId: "zhipu-coding", billingChannel: "plan", vendorFamily: "zhipu", referenceCostNano: 1_000_000_000, planCreditCost: 100},
        ]);

        const result = await loadAnalyticsDashboard(fixture.db, RANGE);
        /* 冻结聚合：只计新口径冻结值；旧口径行不入金额、只入 pending。 */
        expect(result.summary.planRealCostNano).toBe(20_000_000_000);
        expect(result.summary.planRealCostUnavailable).toBe(true);
        /* 套餐分组行同样读冻结值并携带 pending 标注。 */
        const planRow = result.plans.find(row => row.targetId === "zhipu-coding");
        expect(planRow?.planRealCostNano).toBe(20_000_000_000);
        expect(planRow?.planEstimatedPending).toBe(true);
        /* 趋势桶携带冻结估算列。 */
        const bucketWithPlan = result.trend.buckets.find(bucket => bucket.planEstimatedNano > 0);
        expect(bucketWithPlan?.planEstimatedNano).toBe(20_000_000_000);
      } finally {
        if (previousDataDir === undefined) delete process.env.DEEPAA_DATA_DIR;
        else process.env.DEEPAA_DATA_DIR = previousDataDir;
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("分析三列消费口径 = 按量实付 + 套餐成本估算（2026-09-29），套餐不按市价展示", async () => {
    const fixture = await createSqliteFixture();
    try {
      const previousDataDir = process.env.DEEPAA_DATA_DIR;
      process.env.DEEPAA_DATA_DIR = fixture.dataDir;
      try {
        await seedAndRollup(fixture, [
          /* 按量行：倍率后实付 1.5 元 */
          {exchangeId: "payg-1", capturedAt: "2026-08-27T05:00:00.000Z", targetId: "relay-1", agent: "codex", model: "gpt-x", billingChannel: "pay_as_you_go", inputTokens: 100, outputTokens: 20, vendorCostNano: 2_000_000_000, actualCostNano: 1_500_000_000},
          /* 套餐行：市价 296.67 元（reference_cost），套餐成本估算 2 元（入账冻结） */
          {exchangeId: "plan-1", capturedAt: "2026-08-27T06:00:00.000Z", targetId: "zhipu-coding", agent: "claude", model: "glm-5.3", billingChannel: "plan", vendorFamily: "zhipu", inputTokens: 500, outputTokens: 60, referenceCostNano: 296_670_000_000, planCreditCost: 400, planEstimatedCostNano: 2_000_000_000, planEstimatedStatus: "estimated"},
        ]);
        const result = await loadAnalyticsDashboard(fixture.db, RANGE);
        /* 模型：估算真实成本 = 实付 + 套餐估算，绝不把市价当作消费。 */
        const glm = result.models.items.find(item => item.model === "glm-5.3");
        expect(glm!.marketCostNano).toBe(296_670_000_000);
        expect(glm!.planEstimatedNano).toBe(2_000_000_000);
        expect(glm!.actualCostNano).toBe(0);
        expect(glm!.totalCostNano).toBe(2_000_000_000);
        expect(glm!.planEstimatedPending).toBe(0);
        const gpt = result.models.items.find(item => item.model === "gpt-x");
        expect(gpt!.totalCostNano).toBe(1_500_000_000);
        /* 供应商与 Agent 分组同样返回套餐估算聚合与 pending 字段。 */
        const zhipuVendor = result.vendors.find(vendor => vendor.targetId === "zhipu-coding");
        expect(zhipuVendor!.marketCostNano).toBe(296_670_000_000);
        expect(zhipuVendor!.actualCostNano).toBe(0);
        expect(zhipuVendor!.planEstimatedNano).toBe(2_000_000_000);
        expect(zhipuVendor!.planEstimatedPending).toBe(0);
        const claudeAgent = result.agents.find(agent => agent.agent === "claude");
        expect(claudeAgent!.actualCostNano).toBe(0);
        expect(claudeAgent!.planEstimatedNano).toBe(2_000_000_000);
        const codexAgent = result.agents.find(agent => agent.agent === "codex");
        expect(codexAgent!.actualCostNano).toBe(1_500_000_000);
        expect(codexAgent!.planEstimatedNano).toBe(0);
      } finally {
        if (previousDataDir === undefined) delete process.env.DEEPAA_DATA_DIR;
        else process.env.DEEPAA_DATA_DIR = previousDataDir;
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("分析三列部分估算标注：旧口径套餐行 pending 透出", async () => {
    const fixture = await createSqliteFixture();
    try {
      const previousDataDir = process.env.DEEPAA_DATA_DIR;
      process.env.DEEPAA_DATA_DIR = fixture.dataDir;
      try {
        await seedAndRollup(fixture, [
          /* 旧口径套餐行：有消耗但估算 status 为 NULL，pending 必须在模型/供应商/Agent 三端透出 */
          {exchangeId: "plan-legacy", capturedAt: "2026-08-27T03:00:00.000Z", targetId: "zhipu-coding", agent: "claude", model: "glm-5.3", billingChannel: "plan", vendorFamily: "zhipu", inputTokens: 200, referenceCostNano: 1_000_000_000, planCreditCost: 100},
        ]);
        const result = await loadAnalyticsDashboard(fixture.db, RANGE);
        const glm = result.models.items.find(item => item.model === "glm-5.3");
        expect(glm!.planEstimatedNano).toBe(0);
        expect(glm!.planEstimatedPending).toBe(1);
        const zhipuVendor = result.vendors.find(vendor => vendor.targetId === "zhipu-coding");
        expect(zhipuVendor!.planEstimatedPending).toBe(1);
        const claudeAgent = result.agents.find(agent => agent.agent === "claude");
        expect(claudeAgent!.planEstimatedPending).toBe(1);
      } finally {
        if (previousDataDir === undefined) delete process.env.DEEPAA_DATA_DIR;
        else process.env.DEEPAA_DATA_DIR = previousDataDir;
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
