import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {describe, expect, test} from "vitest";
import {migrateDeepaaDatabase} from "../src/lib/db/schema.js";
import {
  computePlanEstimateForLedger,
  loadPlanQuotaWindows,
  resolvePlanQuotaTotal,
} from "../src/lib/db/plan-real-cost.js";

describe("套餐成本估算入账冻结（2026-09-15）", () => {
  test("积分制：月费（原币种）×消耗比率×窗口天数，USD 月费按当次汇率折算", () => {
    /* CNY 月费：200 元 × 500/5000 × 7/30 */
    const cny = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 500,
      planCreditUnit: "credits",
      monthlyFee: 200,
      feeCurrency: "CNY",
      quotaTotal: 5000,
      windowDays: 7,
      windowLabel: "weekly",
      fxUsdCny: 7.085,
    });
    expect(cny.status).toBe("estimated");
    expect(cny.nano).toBe(Math.round(200e9 * 0.1 * (7 / 30)));
    expect(cny.currency).toBe("CNY");
    expect(cny.fx).toBe(1);
    expect(cny.cost).toBe(cny.nano! / 1e9);
    const detailCny = JSON.parse(cny.detailJson!);
    expect(detailCny).toMatchObject({monthlyFee: 200, consumed: 500, consumedBasis: "credits", quotaTotal: 5000, windowDays: 7, windowLabel: "weekly"});

    /* USD 月费（如 OpenCode Go 10 USD）：按入账时当次价格版本汇率折算后冻结。 */
    const usd = computePlanEstimateForLedger({
      billingChannel: "subscription",
      planCreditCost: 30,
      planCreditUnit: "usd",
      monthlyFee: 10,
      feeCurrency: "USD",
      quotaTotal: 60 * 7.085,
      windowDays: 30,
      fxUsdCny: 7.085,
    });
    expect(usd.status).toBe("estimated");
    expect(usd.currency).toBe("USD");
    expect(usd.fx).toBe(7.085);
    /* 10 USD × 30/(60×7.085) = 0.7057 USD ≈ 5 CNY（比率按 CNY 同口径）。 */
    expect(usd.cost).toBeCloseTo(10 * (30 / (60 * 7.085)), 6);
    expect(usd.nano).toBe(Math.round(10 * 7.085e9 * (30 / (60 * 7.085))));
    expect(JSON.parse(usd.detailJson!).fxUsdCny).toBe(7.085);
  });

  test("积分制零消耗是真实零估算（免费活动），不回退市价、不置 unavailable", () => {
    const estimate = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 0,
      planCreditUnit: "credits",
      referenceCostNano: 5_000_000_000,
      monthlyFee: 200,
      feeCurrency: "CNY",
      quotaTotal: 5000,
      windowDays: 30,
      fxUsdCny: 7.085,
    });
    expect(estimate.status).toBe("estimated");
    expect(estimate.nano).toBe(0);
    expect(JSON.parse(estimate.detailJson!).consumed).toBe(0);
  });

  test("美元额度制（无积分 unit）回退套餐通道市价作消耗；缺失月费/额度置 unavailable", () => {
    const fallback = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 0,
      referenceCostNano: 35_425_000_000,
      monthlyFee: 10,
      feeCurrency: "USD",
      quotaTotal: 60 * 7.085,
      quotaUnit: "CNY",
      windowDays: 7,
      fxUsdCny: 7.085,
    });
    expect(fallback.status).toBe("estimated");
    expect(JSON.parse(fallback.detailJson!)).toMatchObject({consumed: 35.425, consumedBasis: "market_cny"});

    const noFee = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 500,
      planCreditUnit: "credits",
      monthlyFee: undefined,
      quotaTotal: 5000,
      windowDays: 30,
      fxUsdCny: 7.085,
    });
    expect(noFee.status).toBe("unavailable");

    const noQuota = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 500,
      planCreditUnit: "credits",
      monthlyFee: 200,
      quotaTotal: undefined,
      windowDays: undefined,
      fxUsdCny: 7.085,
    });
    expect(noQuota.status).toBe("unavailable");
  });

  test("量纲守卫（2026-09-29 一期）：percent/AFP 额度禁用市价回退，金额口径唯一放行", () => {
    /* OpenAI/Anthropic 订阅：percent 快照（total=100）+ 市价消耗 → 拦截，不产出元÷百分比的伪估算。 */
    const percentBlocked = computePlanEstimateForLedger({
      billingChannel: "subscription",
      referenceCostNano: 2_940_000_000,
      monthlyFee: 20,
      feeCurrency: "USD",
      quotaTotal: 100,
      quotaUnit: "percent",
      windowDays: 30,
      windowLabel: "monthly",
      fxUsdCny: 7.085,
    });
    expect(percentBlocked.status).toBe("unavailable");
    expect(JSON.parse(percentBlocked.detailJson!)).toMatchObject({consumedBasis: "market_blocked", quotaUnit: "percent"});

    /* 火山套餐无积分系数模型（如 deepseek-v4.1-flash）：AFP 额度 + 市价消耗 → 拦截。 */
    const afpBlocked = computePlanEstimateForLedger({
      billingChannel: "plan",
      referenceCostNano: 180_000_000,
      monthlyFee: 249,
      feeCurrency: "CNY",
      quotaTotal: 1500,
      quotaUnit: "AFP",
      windowDays: 30,
      windowLabel: "monthly",
      fxUsdCny: 7.085,
    });
    expect(afpBlocked.status).toBe("unavailable");
    expect(JSON.parse(afpBlocked.detailJson!).consumedBasis).toBe("market_blocked");

    /* 金额口径（OpenCode Go 特判产物）唯一放行市价回退；积分制不受守卫影响。 */
    const monetaryAllowed = computePlanEstimateForLedger({
      billingChannel: "plan",
      referenceCostNano: 35_425_000_000,
      monthlyFee: 10,
      feeCurrency: "USD",
      quotaTotal: 60 * 7.085,
      quotaUnit: "USD",
      windowDays: 7,
      fxUsdCny: 7.085,
    });
    expect(monetaryAllowed.status).toBe("estimated");
    const integralUnaffected = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 500,
      planCreditUnit: "积分",
      monthlyFee: 200,
      feeCurrency: "CNY",
      quotaTotal: 5000,
      quotaUnit: "credits",
      windowDays: 7,
      fxUsdCny: 7.085,
    });
    expect(integralUnaffected.status).toBe("estimated");

    /* 快照无 unit（旧数据）时同样拦截：宁缺毋假。 */
    const legacyNoUnit = computePlanEstimateForLedger({
      billingChannel: "subscription",
      referenceCostNano: 2_940_000_000,
      monthlyFee: 20,
      feeCurrency: "USD",
      quotaTotal: 100,
      windowDays: 30,
      fxUsdCny: 7.085,
    });
    expect(legacyNoUnit.status).toBe("unavailable");
  });

  test("量纲守卫（2026-10-20 二期，MiniMax 事故）：积分分子 + percent 额度 → unavailable 交差分回填；credits/count 刻度不受影响", () => {
    /* 事故样本（minimax.cn 2026-10-19）：money_to_credits 官方换算 5.54952 积分 ÷
       percent 快照 total=100 → ¥0.317 虚高估算（真实周额度量级 1.3万~3.8万积分）。
       二期守卫把拦截范围扩展到积分路径。 */
    const blocked = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 5.54952,
      planCreditUnit: "积分",
      monthlyFee: 24.5,
      feeCurrency: "CNY",
      quotaTotal: 100,
      quotaUnit: "percent",
      windowDays: 7,
      windowLabel: "weekly",
      fxUsdCny: 7.085,
    });
    expect(blocked.status).toBe("unavailable");
    expect(blocked.nano).toBeUndefined();
    expect(JSON.parse(blocked.detailJson!)).toMatchObject({
      monthlyFee: 24.5,
      consumed: 5.54952,
      consumedBasis: "credits_percent_blocked",
      quotaTotal: 100,
      quotaUnit: "percent",
      windowDays: 7,
      windowLabel: "weekly",
    });

    /* 智谱形态（unit=credits 真实积分数快照）：不拦截，公式路径精确。 */
    const creditsScale = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 500,
      planCreditUnit: "积分",
      monthlyFee: 200,
      feeCurrency: "CNY",
      quotaTotal: 5000,
      quotaUnit: "credits",
      windowDays: 7,
      fxUsdCny: 7.085,
    });
    expect(creditsScale.status).toBe("estimated");
    expect(creditsScale.nano).toBe(Math.round(200e9 * 0.1 * (7 / 30)));

    /* MiniMax 接口将来恢复 count 刻度（真实额度数）：公式路径自动恢复精确。 */
    const countScale = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 5.54952,
      planCreditUnit: "积分",
      monthlyFee: 24.5,
      feeCurrency: "CNY",
      quotaTotal: 20000,
      quotaUnit: "count",
      windowDays: 7,
      fxUsdCny: 7.085,
    });
    expect(countScale.status).toBe("estimated");
    expect(countScale.nano).toBe(Math.round(24.5e9 * (5.54952 / 20000) * (7 / 30)));

    /* unit 缺省（快照无 unit 的积分行）：维持既有行为不拦截，不误伤旧数据。 */
    const noUnit = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 500,
      planCreditUnit: "积分",
      monthlyFee: 200,
      feeCurrency: "CNY",
      quotaTotal: 5000,
      windowDays: 7,
      fxUsdCny: 7.085,
    });
    expect(noUnit.status).toBe("estimated");

    /* 积分零消耗 + percent 额度：真实零估算语义不变（creditsConsumed=0 → nano=0）。 */
    const zeroCredit = computePlanEstimateForLedger({
      billingChannel: "plan",
      planCreditCost: 0,
      planCreditUnit: "积分",
      monthlyFee: 24.5,
      feeCurrency: "CNY",
      quotaTotal: 100,
      quotaUnit: "percent",
      windowDays: 7,
      fxUsdCny: 7.085,
    });
    expect(zeroCredit.status).toBe("estimated");
    expect(zeroCredit.nano).toBe(0);
  });

  test("非套餐通道返回 none", () => {
    expect(computePlanEstimateForLedger({billingChannel: "pay_as_you_go", planCreditCost: 10, fxUsdCny: 7}).status).toBe("none");
    expect(computePlanEstimateForLedger({fxUsdCny: 7}).status).toBe("none");
  });

  test("额度窗口解析：跨密钥合计、最长窗口优先、OpenCode Go 按请求时汇率折算", () => {
    const db = new DeepaaDatabase(":memory:");
    db.pragma("journal_mode = WAL");
    migrateDeepaaDatabase(db);
    const insertQuota = db.prepare(`INSERT INTO plan_quota_snapshots(
      target_id, credential_id, provider_type, window_label, used, total, remaining, unit, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'credits', ?)`);
    insertQuota.run("zhipu", "key-a", "zhipu", "weekly", 300, 3000, "2026-09-15T08:00:00.000Z");
    insertQuota.run("zhipu", "key-b", "zhipu", "weekly", 200, 2000, "2026-09-15T08:00:00.000Z");
    insertQuota.run("zhipu", "key-a", "zhipu", "5h", 50, 300, "2026-09-15T08:00:00.000Z");
    insertQuota.run("go", "key-a", "opencode-go", "monthly", 10, 100, "2026-09-15T08:00:00.000Z");
    // OpenCode Go 实际快照为 percent 口径：常量特判移除后按原样透传。
    insertQuota.run("go-percent", "key-a", "opencode-go", "monthly", 3, 100, "2026-09-15T08:00:00.000Z");
    db.prepare(`UPDATE plan_quota_snapshots SET unit='percent' WHERE target_id='go-percent'`).run();

    const windows = loadPlanQuotaWindows(db);
    /* weekly 跨密钥合计 5000，优先级高于 5h（300）。 */
    const zhipu = resolvePlanQuotaTotal(windows.get("zhipu"), 7.085);
    expect(zhipu).toMatchObject({total: 5000, windowDays: 7, windowLabel: "weekly", unit: "credits"});
    /* OpenCode Go 美元常量特判已移除（2026-09-30 用户确认）：credits 绝对值照常透传；
       percent 快照原样透传（无额度语义，不计金额口径），估算分母改由条目
       market_share 规则（planTier × planMonthlyLimitUsd）解析，解析不到按
       market_blocked 诚实降级——绝不用写死常量兜底。 */
    const go = resolvePlanQuotaTotal(windows.get("go"), 7.15);
    expect(go).toMatchObject({total: 100, windowDays: 30, windowLabel: "monthly", unit: "credits"});
    const goPercent = resolvePlanQuotaTotal(windows.get("go-percent"), 7.15);
    expect(goPercent).toMatchObject({total: 100, windowDays: 30, windowLabel: "monthly", unit: "percent"});
    /* percent 口径进入估算即 market_blocked（量纲不可除），unavailable 降级。 */
    expect(computePlanEstimateForLedger({
      billingChannel: "plan",
      referenceCostNano: 1_000_000_000,
      monthlyFee: 10,
      feeCurrency: "USD",
      quotaTotal: goPercent!.total,
      quotaUnit: goPercent!.unit,
      windowDays: goPercent!.windowDays,
      windowLabel: goPercent!.windowLabel,
      fxUsdCny: 7.15,
    }).status).toBe("unavailable");
  });
});
