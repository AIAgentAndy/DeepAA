import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {afterEach, describe, expect, test} from "vitest";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {migrateDeepaaDatabase} from "../src/lib/db/schema.js";
import {runPlanEstimateBackfill, MAX_PLAN_ESTIMATE_BACKFILL_ROWS, PLAN_ESTIMATE_BACKFILL_LOOKBACK_MS} from "../src/lib/plan-estimate/backfill.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});

function makeDb() {
  const db = new DeepaaDatabase(":memory:");
  db.pragma("journal_mode = WAL");
  /* 测试只造账本行（不建上游 raw 引用），关闭外键检查；被测 backfill 仅 UPDATE，不依赖外键语义。 */
  db.pragma("foreign_keys = OFF");
  migrateDeepaaDatabase(db);
  return db;
}

interface LedgerRowSeed {
  exchangeId: string;
  capturedAt: string;
  billingChannel: "plan" | "subscription" | "pay_as_you_go";
  planCreditUnit?: string;
  planEstimatedStatus?: string;
  planEstimatedMethod?: string;
  referenceCostNano?: number | null;
}

function seedLedgerRow(db: DeepaaDatabase, seed: LedgerRowSeed) {
  db.prepare(`
    INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor,
      created_at, rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens,
      output_tokens, currency, vendor_cost, actual_cost, vendor_cost_cny, actual_cost_cny,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      billing_channel, plan_credit_unit, plan_credit_cost, plan_credit_formula_version,
      reference_cost_nano, plan_estimated_status, plan_estimated_method, plan_estimated_cost_nano,
      plan_estimate_detail_json
    ) VALUES(
      ?, ?, 'fp', 'claude', 'claude-x', 'anthropic',
      ?, 1, 0, 0, 0, 0, 'USD', 0, 0, 0, 0,
      0, 'provider_usage', 'high', '{}',
      ?, ?, NULL, '',
      ?, ?, ?, ?, ?
    )`).run(
    seed.exchangeId, "target-sub", seed.capturedAt,
    seed.billingChannel, seed.planCreditUnit ?? "",
    seed.referenceCostNano ?? null,
    seed.planEstimatedStatus ?? null,
    seed.planEstimatedMethod ?? null,
    seed.planEstimatedStatus === "estimated" ? 1_000_000_000 : null,
    seed.planEstimatedStatus === "unavailable"
      ? JSON.stringify({consumedBasis: "market_blocked", quotaUnit: "percent"})
      : null,
  );
}

function seedSnapshot(
  db: DeepaaDatabase,
  capturedAt: string,
  used: number,
  resetAt: string | null,
  windowLabel = "weekly",
) {
  db.prepare(`
    INSERT INTO plan_quota_snapshots(
      target_id, plan_sync_id, console_account_id, credential_id, provider_type,
      plan_name, window_label, used, total, remaining, unit, reset_at, raw_json, captured_at
    ) VALUES('target-sub', NULL, NULL, NULL, 'anthropic-subscription',
      'Claude Max', ?, ?, 100, NULL, 'percent', ?, '{}', ?)`)
    .run(windowLabel, used, resetAt, capturedAt);
}

interface LedgerEstimateRow {
  plan_estimated_status: string | null;
  plan_estimated_method: string | null;
  plan_estimated_cost_nano: number | null;
  plan_estimated_currency: string | null;
  plan_estimate_detail_json: string | null;
}

function readLedger(db: DeepaaDatabase, exchangeId: string): LedgerEstimateRow {
  return db.prepare(`
    SELECT plan_estimated_status, plan_estimated_method, plan_estimated_cost_nano,
      plan_estimated_currency, plan_estimate_detail_json
    FROM usage_ledger WHERE exchange_id = ?`).get(exchangeId) as LedgerEstimateRow;
}

function readCursor(db: DeepaaDatabase): {baseline_captured_at: string; baseline_used: number} | undefined {
  return db.prepare(`
    SELECT baseline_captured_at, baseline_used FROM plan_estimate_settlements
    WHERE target_id = 'target-sub' AND window_label = 'weekly'`).get() as
    {baseline_captured_at: string; baseline_used: number} | undefined;
}

describe("额度差分估算回填（编排层集成）", () => {
  test("端到端：两张周窗快照差分 → 补写 blocked 行 + 脏桶标记 + 结算游标落库；公式行与 payg 行不被触碰", () => {
    const db = makeDb();
    seedLedgerRow(db, {
      exchangeId: "ex-blocked-1", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 2_000_000_000,
    });
    seedLedgerRow(db, {
      exchangeId: "ex-blocked-2", capturedAt: "2026-09-28T10:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 8_000_000_000,
    });
    /* 公式估算行：绝不参与、绝不被覆盖。 */
    seedLedgerRow(db, {
      exchangeId: "ex-formula", capturedAt: "2026-09-28T11:00:00.000Z",
      billingChannel: "plan", planCreditUnit: "积分", planEstimatedStatus: "estimated",
      planEstimatedMethod: "formula", referenceCostNano: 5_000_000_000,
    });
    /* 按量行：不在回填范围。 */
    seedLedgerRow(db, {
      exchangeId: "ex-payg", capturedAt: "2026-09-28T12:00:00.000Z",
      billingChannel: "pay_as_you_go", referenceCostNano: 1_000_000_000,
    });
    /* 周窗起点（reset 10-05 − 7 天 = 09-28T00:00）之前的 blocked 行：其用量不在本
       周窗 percent 里，纳入只会虚增分摊——窗口起点边界排除（水位线制）。 */
    seedLedgerRow(db, {
      exchangeId: "ex-before", capturedAt: "2026-09-27T00:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    const resetAt = "2026-10-05T00:00:00.000Z";
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 40, resetAt);
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 55, resetAt);

    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "anthropic-subscription",
      monthlyFee: 1400, feeCurrency: "CNY",
    });
    expect(outcome).toMatchObject({
      status: "estimated", windowLabel: "weekly", updatedRows: 2, deferredRows: 0,
      periodFrom: "2026-09-28T08:00:00.000Z", periodTo: "2026-09-28T20:00:00.000Z",
    });
    /* 周期价值 1400 × 7/30 × 15/100 = 49 CNY；份额 2:8。 */
    const row1 = readLedger(db, "ex-blocked-1");
    const row2 = readLedger(db, "ex-blocked-2");
    expect(row1.plan_estimated_status).toBe("estimated");
    expect(row1.plan_estimated_method).toBe("quota_delta");
    expect(row1.plan_estimated_currency).toBe("CNY");
    expect(row1.plan_estimated_cost_nano).toBe(9_800_000_000);
    expect(row2.plan_estimated_cost_nano).toBe(39_200_000_000);
    const detail = JSON.parse(row1.plan_estimate_detail_json!);
    expect(detail).toMatchObject({
      consumedBasis: "quota_delta", deltaUsed: 15, total: 100, windowLabel: "weekly",
    });
    /* 公式行 / 按量行 / 窗口起点外行：全部不动。 */
    expect(readLedger(db, "ex-formula").plan_estimated_method).toBe("formula");
    expect(readLedger(db, "ex-payg").plan_estimated_status).toBeNull();
    expect(readLedger(db, "ex-before").plan_estimated_status).toBe("unavailable");
    /* 结算游标推进到终点批（水位线制，schema v52）。 */
    expect(readCursor(db)).toMatchObject({baseline_captured_at: "2026-09-28T20:00:00.000Z", baseline_used: 55});
    /* 脏桶：两行不同小时 → 两个桶，reason 含 plan_estimate_backfill。 */
    const buckets = db.prepare(`
      SELECT bucket_start_utc FROM analytics_dirty_buckets
      WHERE reason LIKE '%plan_estimate_backfill%' ORDER BY bucket_start_utc`).all() as Array<{bucket_start_utc: string}>;
    expect(buckets.map(row => row.bucket_start_utc)).toEqual([
      "2026-09-28T09:00:00.000Z", "2026-09-28T10:00:00.000Z",
    ]);
    db.close();
  });

  test("幂等：同快照对重复运行不再改动（候选已空 → 短路）；公式行永不被覆盖", () => {
    const db = makeDb();
    seedLedgerRow(db, {
      exchangeId: "ex-1", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    const resetAt = "2026-10-05T00:00:00.000Z";
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 40, resetAt);
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 55, resetAt);
    const first = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 20, feeCurrency: "USD",
    });
    expect(first.status).toBe("estimated");
    const second = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 20, feeCurrency: "USD",
    });
    /* 候选行已全部补写 → 第一道门禁（待补写行存在性）短路；账本零变化。 */
    expect(second).toEqual({status: "short_circuit"});
    expect(readLedger(db, "ex-1").plan_estimated_method).toBe("quota_delta");
    db.close();
  });

  test("水位线制（2026-10-09）：平坦期积累的行在刻度跳动时全量归属，不再只分给最后一批切片", () => {
    const db = makeDb();
    /* 快照：A(10%) → B(10% 平) → C(25% 跳动)。r1 在平坦期 [A,B)、r2 在 [B,C)。 */
    const resetAt = "2026-10-05T00:00:00.000Z";
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 10, resetAt);
    seedSnapshot(db, "2026-09-28T12:00:00.000Z", 10, resetAt);
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 25, resetAt);
    seedLedgerRow(db, {
      exchangeId: "ex-flat-1", capturedAt: "2026-09-28T09:30:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    seedLedgerRow(db, {
      exchangeId: "ex-flat-2", capturedAt: "2026-09-28T15:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 3_000_000_000,
    });
    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    expect(outcome).toMatchObject({status: "estimated", updatedRows: 2, deferredRows: 0});
    /* 旧实现：跳动的 15% 只分给 [B,C) 的 ex-flat-2，ex-flat-1 永久孤儿。
       水位线制：Δ15% 按市价份额 1:3 分给两行，周期价值 = 1200×7/30×0.15 = 42。 */
    const row1 = readLedger(db, "ex-flat-1");
    const row2 = readLedger(db, "ex-flat-2");
    expect(row1.plan_estimated_cost_nano).toBe(10_500_000_000);
    expect(row2.plan_estimated_cost_nano).toBe(31_500_000_000);
    db.close();
  });

  test("派生迟到行（根因 C）：落库晚于结算的行由下一个刻度补算，游标保证同段不重复分摊", () => {
    const db = makeDb();
    const resetAt = "2026-10-05T00:00:00.000Z";
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 10, resetAt);
    seedSnapshot(db, "2026-09-28T12:00:00.000Z", 20, resetAt);
    seedLedgerRow(db, {
      exchangeId: "ex-ontime", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    /* 第一轮：10→20 差分结算 ex-ontime（价值 = 1200×7/30×0.1 = 28）。 */
    const first = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    expect(first).toMatchObject({status: "estimated", updatedRows: 1});
    expect(readLedger(db, "ex-ontime").plan_estimated_cost_nano).toBe(28_000_000_000);
    /* 模拟派生迟到：同秒竞争行此刻才落库（created_at 在已结算周期内）。 */
    seedLedgerRow(db, {
      exchangeId: "ex-late", capturedAt: "2026-09-28T09:30:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    /* 无新快照时复跑：最新两批 (08:00,12:00) 差分已被游标消费 → 不重复分摊。 */
    expect(runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    })).toMatchObject({status: "skip", reason: "no_pairable_window"});
    expect(readLedger(db, "ex-late").plan_estimated_status).toBe("unavailable");
    /* 下一个刻度到来：迟到行由新差分段（12:00→16:00，20→30）补算。 */
    seedSnapshot(db, "2026-09-28T16:00:00.000Z", 30, resetAt);
    const second = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    expect(second).toMatchObject({
      status: "estimated", updatedRows: 1,
      periodFrom: "2026-09-28T12:00:00.000Z", periodTo: "2026-09-28T16:00:00.000Z",
    });
    const late = readLedger(db, "ex-late");
    expect(late.plan_estimated_cost_nano).toBe(28_000_000_000);
    expect(JSON.parse(late.plan_estimate_detail_json!)).toMatchObject({periodFrom: "2026-09-28T12:00:00.000Z"});
    db.close();
  });

  test("锚窗制（2026-10-09）：最长窗口优先、配对失败不降级到 5h；只有 5h 快照的目标仍可用 5h", () => {
    const db = makeDb();
    const resetWeekly = "2026-10-05T00:00:00.000Z";
    const resetMonthly = "2026-10-28T00:00:00.000Z";
    const reset5h = "2026-09-28T13:00:00.000Z";
    /* monthly/weekly 平坦（整数刻度常态），5h 在跳动——锚窗=monthly，5h 不得被 consult。 */
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 3, resetMonthly, "monthly");
    seedSnapshot(db, "2026-09-28T12:00:00.000Z", 3, resetMonthly, "monthly");
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 5, resetWeekly, "weekly");
    seedSnapshot(db, "2026-09-28T12:00:00.000Z", 5, resetWeekly, "weekly");
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 10, reset5h, "5h");
    seedSnapshot(db, "2026-09-28T12:00:00.000Z", 30, reset5h, "5h");
    seedLedgerRow(db, {
      exchangeId: "ex-anchor", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    /* 锚窗 monthly 平坦 → 不结算；5h 的 10→30 跳动被无视（不混用价值基数）。 */
    expect(outcome).toMatchObject({status: "skip", reason: "no_pairable_window"});
    expect(readLedger(db, "ex-anchor").plan_estimated_status).toBe("unavailable");

    /* 对照目标：只有 5h 快照（清掉 monthly/weekly 后重新造数）→ 锚窗 5h，windowDays=5/24。 */
    db.prepare(`DELETE FROM plan_quota_snapshots WHERE window_label IN ('monthly','weekly')`).run();
    const outcome5h = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1440, feeCurrency: "CNY",
    });
    expect(outcome5h).toMatchObject({status: "estimated", windowLabel: "5h", updatedRows: 1});
    /* 周期价值 = 1440 × (5/24)/30 × 20/100 = 2 CNY。 */
    expect(readLedger(db, "ex-anchor").plan_estimated_cost_nano).toBe(2_000_000_000);
    db.close();
  });

  test("reset 过渡（2026-10-09）：旧周期正常结算后，新周期第一批的已有消耗开仓归属窗口起点以来的行", () => {
    const db = makeDb();
    /* 旧周窗 [09-21, 09-28)、新周窗 [09-28, 10-05)。 */
    const resetOld = "2026-09-28T00:00:00.000Z";
    const resetNew = "2026-10-05T00:00:00.000Z";
    seedSnapshot(db, "2026-09-27T20:00:00.000Z", 0, resetOld);
    seedSnapshot(db, "2026-09-27T22:00:00.000Z", 10, resetOld);
    /* 新周期第一批：已含 5% 消耗（reset 后、下一次轮询前的本地用量）。 */
    seedSnapshot(db, "2026-09-28T02:00:00.000Z", 5, resetNew);
    seedLedgerRow(db, {
      exchangeId: "ex-old", capturedAt: "2026-09-27T21:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    seedLedgerRow(db, {
      exchangeId: "ex-new", capturedAt: "2026-09-28T01:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    expect(outcome).toMatchObject({status: "estimated", updatedRows: 2});
    /* 旧周期 0→10：价值 28 给 ex-old；新周期开仓 0→5：价值 14 给 ex-new
       （候选下界 = 新 reset − 7 天 = 09-28T00:00，ex-old 已 estimated 自动出局）。 */
    expect(readLedger(db, "ex-old").plan_estimated_cost_nano).toBe(28_000_000_000);
    const newRow = readLedger(db, "ex-new");
    expect(newRow.plan_estimated_cost_nano).toBe(14_000_000_000);
    expect(JSON.parse(newRow.plan_estimate_detail_json!)).toMatchObject({
      consumedBasis: "quota_delta", usedFrom: 0, usedTo: 5, windowLabel: "weekly",
    });
    db.close();
  });

  test("门禁短路：积分公式供应商（无待补写行）零扫描返回 short_circuit", () => {
    const db = makeDb();
    seedLedgerRow(db, {
      exchangeId: "ex-formula", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "plan", planCreditUnit: "积分",
      planEstimatedStatus: "estimated", planEstimatedMethod: "formula",
    });
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 40, "2026-10-05T00:00:00.000Z");
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 55, "2026-10-05T00:00:00.000Z");
    expect(runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "zhipu", monthlyFee: 200, feeCurrency: "CNY",
    })).toEqual({status: "short_circuit"});
    db.close();
  });

  test("门禁不含 none 行（2026-09-30 收窄）：无市价行（model=unknown 等）不再把短路顶开", () => {
    const db = makeDb();
    seedLedgerRow(db, {
      exchangeId: "ex-none", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "plan", planCreditUnit: "",
      planEstimatedStatus: "none", referenceCostNano: null,
    });
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 40, "2026-10-05T00:00:00.000Z");
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 55, "2026-10-05T00:00:00.000Z");
    expect(runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "opencode-go", monthlyFee: 10, feeCurrency: "USD",
    })).toEqual({status: "short_circuit"});
    /* none 行保持原状，绝不因门禁收窄而被补写或改写。 */
    expect(readLedger(db, "ex-none").plan_estimated_status).toBe("none");
    db.close();
  });

  test("跨 reset_at：旧窗尾行（最后一次轮询后、窗口关闭前）由残差中点补算；月费缺失 → skip", () => {
    const db = makeDb();
    seedLedgerRow(db, {
      exchangeId: "ex-1", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 40, "2026-10-05T00:00:00.000Z");
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 3, "2026-10-12T00:00:00.000Z");
    /* 月费缺失门禁在结算前生效（结算后无 pending 会先短路）。 */
    expect(runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "anthropic-subscription",
      monthlyFee: undefined, feeCurrency: undefined,
    })).toMatchObject({status: "skip", reason: "no_monthly_fee"});
    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "anthropic-subscription",
      monthlyFee: 1400, feeCurrency: "CNY",
    });
    /* 行 09:00 在旧窗 [09-28, 10-05) 内、晚于唯一的旧窗观测（08:00 的 40%）——
       其用量在整数刻度下不可见，跨 reset 由残差中点（0.5%×窗口价值）补算：
       1400 × 7/30 × 0.5/100 = 1.6333 CNY。 */
    expect(outcome).toMatchObject({status: "estimated", updatedRows: 1});
    const row = readLedger(db, "ex-1");
    expect(row.plan_estimated_method).toBe("quota_delta");
    expect(row.plan_estimated_cost_nano).toBe(Math.round(1400 * 1e9 * (7 / 30) * 0.005));
    expect(JSON.parse(row.plan_estimate_detail_json!)).toMatchObject({
      consumedBasis: "reset_residual", midpointPercent: 0.5,
      periodFrom: "2026-09-28T08:00:00.000Z", periodTo: "2026-10-05T00:00:00.000Z",
    });
    db.close();
  });

  test("同批多密钥快照聚合后与上一批配对；单批不配对（等待下一批）", () => {
    const db = makeDb();
    seedLedgerRow(db, {
      exchangeId: "ex-1", capturedAt: "2026-09-28T09:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    const resetAt = "2026-10-05T00:00:00.000Z";
    /* 第一批：两个密钥行（同 captured_at 聚合 used=40）。 */
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 25, resetAt);
    db.prepare(`INSERT INTO plan_quota_snapshots(
      target_id, provider_type, window_label, used, total, unit, reset_at, raw_json, captured_at
    ) VALUES('target-sub', 'anthropic-subscription', 'weekly', 15, 100, 'percent', ?, '{}', '2026-09-28T08:00:00.000Z')`)
      .run(resetAt);
    /* 只有第一批 → 无法配对。 */
    expect(runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "anthropic-subscription",
      monthlyFee: 1400, feeCurrency: "CNY",
    })).toMatchObject({status: "skip", reason: "no_pairable_window"});
    /* 第二批（聚合 used=60）：Δ=20 → 周期价值 1400×7/30×0.2。 */
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 60, resetAt);
    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "anthropic-subscription",
      monthlyFee: 1400, feeCurrency: "CNY",
    });
    expect(outcome).toMatchObject({status: "estimated", updatedRows: 1});
    const row = readLedger(db, "ex-1");
    expect(row.plan_estimated_cost_nano).toBe(Math.round(1400 * 1e9 * (7 / 30) * 0.2));
    db.close();
  });

  test("行数上限：maxRows 截断本轮并顺延（游标不推进，下轮份额分母含本段已补写行、总额守恒）", () => {
    const db = makeDb();
    for (let index = 0; index < 3; index += 1) {
      seedLedgerRow(db, {
        exchangeId: `ex-${index}`, capturedAt: `2026-09-28T09:0${index}:00.000Z`,
        billingChannel: "subscription", planCreditUnit: "",
        planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
      });
    }
    const resetAt = "2026-10-05T00:00:00.000Z";
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 40, resetAt);
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 70, resetAt);
    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1400, feeCurrency: "CNY", maxRows: 2,
    });
    expect(outcome).toMatchObject({status: "estimated", updatedRows: 2, deferredRows: 1});
    expect(readLedger(db, "ex-0").plan_estimated_method).toBe("quota_delta");
    expect(readLedger(db, "ex-2").plan_estimated_status).toBe("unavailable");
    /* 截断时游标停在基线批：同一差分段下轮重开给剩余行。 */
    expect(readCursor(db)).toMatchObject({baseline_captured_at: "2026-09-28T08:00:00.000Z", baseline_used: 40});
    const second = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1400, feeCurrency: "CNY",
    });
    expect(second).toMatchObject({status: "estimated", updatedRows: 1, deferredRows: 0});
    /* 截断守恒：份额分母 = 全部应归属行（3 行各 1/3），两轮合计 = 周期价值
       1400×7/30×0.3 = 98 CNY（每行 round(98e9/3)，合计允许 ±2 nano 舍入差）。 */
    const nanos = [0, 1, 2].map(index => readLedger(db, `ex-${index}`).plan_estimated_cost_nano!);
    const total = nanos.reduce((sum, nano) => sum + nano, 0);
    expect(total).toBeGreaterThanOrEqual(98_000_000_000 - 2);
    expect(total).toBeLessThanOrEqual(98_000_000_000 + 2);
    for (const nano of nanos) {
      expect(nano).toBeGreaterThanOrEqual(32_666_666_667 - 2);
      expect(nano).toBeLessThanOrEqual(32_666_666_667 + 2);
    }
    db.close();
  });

  test("比率兜底（A1）：pre-sync 历史行按已结算比率一次性补算；证据不足等待、补后幂等", () => {
    const db = makeDb();
    const resetAt = "2026-10-05T00:00:00.000Z";
    /* 已结算证据：3 行 quota_delta（0→30 差分，价值 = 1200×7/30×0.3 = 84，
       市价合计 6 → 比率 14）。 */
    for (let index = 0; index < 3; index += 1) {
      db.prepare(`INSERT INTO usage_ledger(
        exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor, created_at,
        rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
        currency, vendor_cost, actual_cost, vendor_cost_cny, actual_cost_cny, duration_ms,
        usage_source, usage_confidence, pricing_snapshot_json, billing_channel, plan_credit_unit,
        reference_cost_nano, plan_estimated_status, plan_estimated_method, plan_estimated_cost_nano)
        VALUES(?, 'target-sub', 'fp', 'claude', 'x', 'anthropic', ?, 1, 0, 0, 0, 0,
        'CNY', 0, 0, 0, 0, 0,
        'provider_usage', 'high', '{}', 'subscription', '',
        ?, 'estimated', 'quota_delta', ?)`)
        .run(`ex-ev-${index}`, `2026-09-28T09:0${index}:00.000Z`,
          2_000_000_000, 28_000_000_000);
    }
    /* pre-sync 行：早于最老快照（09-28T08:00）。 */
    seedLedgerRow(db, {
      exchangeId: "ex-presync", capturedAt: "2026-09-27T10:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    seedSnapshot(db, "2026-09-28T08:00:00.000Z", 0, resetAt);
    seedSnapshot(db, "2026-09-28T20:00:00.000Z", 30, resetAt);
    /* 证据 3 行 < 门槛 5 → 比率兜底不触发，但差分结算照常（证据行已是 estimated，
       候选空 → 无结算）；ex-presync 保持 unavailable。 */
    const first = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    expect(first).toMatchObject({status: "skip", reason: "no_pairable_window"});
    expect(readLedger(db, "ex-presync").plan_estimated_status).toBe("unavailable");
    /* 证据补足到 5 行 → 比率 = Σest/Σmarket = (5×28)/(5×2) = 14；
       ex-presync 市价 ¥1 → 补 ￥14。 */
    for (let index = 3; index < 5; index += 1) {
      db.prepare(`INSERT INTO usage_ledger(
        exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor, created_at,
        rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
        currency, vendor_cost, actual_cost, vendor_cost_cny, actual_cost_cny, duration_ms,
        usage_source, usage_confidence, pricing_snapshot_json, billing_channel, plan_credit_unit,
        reference_cost_nano, plan_estimated_status, plan_estimated_method, plan_estimated_cost_nano)
        VALUES(?, 'target-sub', 'fp', 'claude', 'x', 'anthropic', ?, 1, 0, 0, 0, 0,
        'CNY', 0, 0, 0, 0, 0,
        'provider_usage', 'high', '{}', 'subscription', '',
        ?, 'estimated', 'quota_delta', ?)`)
        .run(`ex-ev-${index}`, `2026-09-28T09:0${index}:00.000Z`,
          2_000_000_000, 28_000_000_000);
    }
    const second = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    expect(second).toMatchObject({status: "estimated", ratioFallbackRows: 1});
    const row = readLedger(db, "ex-presync");
    expect(row.plan_estimated_method).toBe("ratio_fallback");
    expect(row.plan_estimated_cost_nano).toBe(Math.round(1_000_000_000 * 14));
    expect(JSON.parse(row.plan_estimate_detail_json!)).toMatchObject({
      consumedBasis: "ratio_fallback", fallbackRatio: 14, evidenceRows: 5,
      evidenceMarketCny: 10, evidenceEstimateCny: 140,
    });
    /* 幂等：补写后无 pending → 门禁短路（比率行不进入证据防自增强）。 */
    expect(runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    })).toEqual({status: "short_circuit"});
    db.close();
  });

  test("reset 残差（A2）：最后轮询后、窗口关闭前的尾巴行按中点补算，不与新窗开仓重叠", () => {
    const db = makeDb();
    const resetOld = "2026-09-28T00:00:00.000Z";
    const resetNew = "2026-10-05T00:00:00.000Z";
    /* 旧窗 [09-21, 09-28)：0→10 在 22:00 观测到（结算 r1）；
       r-tail 在 23:00（最后一次轮询后、窗口终点前）= 整数刻度零头。 */
    seedSnapshot(db, "2026-09-27T20:00:00.000Z", 0, resetOld);
    seedSnapshot(db, "2026-09-27T22:00:00.000Z", 10, resetOld);
    seedSnapshot(db, "2026-09-28T02:00:00.000Z", 5, resetNew);
    seedLedgerRow(db, {
      exchangeId: "r1", capturedAt: "2026-09-27T21:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    seedLedgerRow(db, {
      exchangeId: "r-tail", capturedAt: "2026-09-27T23:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    /* 新窗行：reset 之后创建，由开仓（0→5）归属，绝不与残差重叠。 */
    seedLedgerRow(db, {
      exchangeId: "r-new", capturedAt: "2026-09-28T01:00:00.000Z",
      billingChannel: "subscription", planCreditUnit: "",
      planEstimatedStatus: "unavailable", referenceCostNano: 1_000_000_000,
    });
    const outcome = runPlanEstimateBackfill(db, {
      targetId: "target-sub", providerType: "openai-subscription",
      monthlyFee: 1200, feeCurrency: "CNY",
    });
    expect(outcome).toMatchObject({status: "estimated", updatedRows: 3});
    /* r1：差分 0→10 = 28。 */
    expect(readLedger(db, "r1").plan_estimated_cost_nano).toBe(28_000_000_000);
    /* r-tail：残差中点 1200×7/30×0.5% = 1.4。 */
    const tail = readLedger(db, "r-tail");
    expect(tail.plan_estimated_method).toBe("quota_delta");
    expect(tail.plan_estimated_cost_nano).toBe(Math.round(1200 * 1e9 * (7 / 30) * 0.005));
    expect(JSON.parse(tail.plan_estimate_detail_json!)).toMatchObject({
      consumedBasis: "reset_residual", usedTo: 10, midpointPercent: 0.5,
      periodTo: "2026-09-28T00:00:00.000Z",
    });
    /* r-new：新窗开仓 0→5 = 14（含 r-tail 之后 reset 前的 5% 消耗属新窗观测）。 */
    expect(readLedger(db, "r-new").plan_estimated_cost_nano).toBe(14_000_000_000);
    db.close();
  });

  test("隔离数据目录红线：测试自建临时 DEEPAA_DATA_DIR，绝不触碰真实 ~/.deepaa", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "plan-estimate-test-"));
    tempDirs.push(dataDir);
    await mkdir(join(dataDir, "config"), {recursive: true});
    await writeFile(join(dataDir, "config", "marker.json"), "{}", "utf8");
    expect(PLAN_ESTIMATE_BACKFILL_LOOKBACK_MS).toBe(30 * 24 * 3_600_000);
    expect(MAX_PLAN_ESTIMATE_BACKFILL_ROWS).toBeGreaterThan(0);
    expect(dataDir).toContain(tmpdir());
  });
});
