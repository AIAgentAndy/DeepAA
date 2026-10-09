/**
 * 额度差分估算回填编排层（唯一 IO 层）。
 *
 * 设计文档：docs/额度差分估算回填机制设计文档.md。由套餐同步完成钩子触发，
 * 2026-10-09 水位线制修订（用户确认）：不再限定「最近两批快照之间」的候选行——
 * percent 为整数刻度时平坦期可长达数小时，tick 到来时的差分覆盖自上次结算以来的
 * 全部待补写行（刻度是窗口内累计值四舍五入，跳动即含此前隐藏用量，全量归属在
 * 数学上正确）。三条红线不变：不碰派生链、不碰查询链语义（只补写冻结列 + 标脏桶
 * 由既有 rollup 重滚）、只单向补写 unavailable → estimated（条件 UPDATE 原子幂等，
 * 绝不覆盖任何已估算行）。
 *
 * 锚窗制（2026-10-09 用户确认）：按目标实际存在的快照窗口静态选最长锚窗
 * （monthly/30d > weekly 系 > 5h），配对失败不降级到短窗——同一目标相邻时段的价值
 * 基数不再混用（旧行为：周窗平Δ → 跌 5h，42% 行按 5h 时间份额计价）。
 *
 * 结算游标（plan_estimate_settlements，schema v52）：每 (target, 锚窗) 记录已消费到
 * 的快照批。派生完成钩子与低频定时会复跑本函数，同一差分段绝不重复分摊；行数预算
 * 截断时不推进游标，下轮对剩余 pending 行继续分摊同一段周期价值（总额守恒）。
 *
 * 门禁由账本事实驱动：存在 plan/subscription 通道、无积分 unit、状态
 * unavailable（market_blocked，有市价但额度刻度不可除）的行才继续——积分公式
 * 供应商（派生期已精确估算）自动短路零开销。none 行（连市价都没有，如
 * model=unknown）不参与：分摊按市价份额，none 行结构上不可能被补写。
 */
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {readLatestUsdCnyRate} from "@/lib/db/plan-real-cost";
import {resolvePlanEstimateStrategy} from "./registry";
import {
  buildQuotaDeltaDetail,
  computeQuotaDeltaAllocation,
  type BackfillCandidate,
  type PairedQuotaSnapshot,
} from "./strategy";

/** 单次回填行数上限（防大事务）；超出按 capturedAt 升序顺延下一轮（游标不推进）。 */
export const MAX_PLAN_ESTIMATE_BACKFILL_ROWS = 5000;

/** 候选行回看上限：与套餐快照保留策略（90 天）内的近 30 天对齐（2026-10-09 用户确认）。 */
export const PLAN_ESTIMATE_BACKFILL_LOOKBACK_MS = 30 * 24 * 3_600_000;

/** 单次运行消费的快照批上限（5 分钟节拍 × 30 天 ≈ 8640 批，防御性收紧）。 */
const MAX_SETTLEMENT_BATCHES = 4320;

/** reset 残差中点（2026-10-09 A2 用户确认）：闭窗最后一段消耗 ∈ [0,1%)，取中点。 */
export const RESET_RESIDUAL_MIDPOINT_PERCENT = 0.5;

/** 比率兜底证据门槛（2026-10-09 A1 用户确认）：已结算 ≥5 行且市价合计 ≥￥1。 */
export const RATIO_EVIDENCE_MIN_ROWS = 5;
export const RATIO_EVIDENCE_MIN_MARKET_NANO = 1_000_000_000;

export type PlanEstimateBackfillOutcome =
  | {status: "short_circuit"}
  | {status: "skip"; reason: string}
  | {
      status: "estimated";
      windowLabel: string;
      periodFrom: string;
      periodTo: string;
      updatedRows: number;
      deferredRows: number;
      periodValueNano: number;
      /** 比率兜底补写行数（A1，method=ratio_fallback；>0 时携带）。 */
      ratioFallbackRows?: number;
    };

interface AggregatedSnapshotBatch {
  capturedAt: string;
  used: number;
  total: number;
  resetAt: string | null;
}

interface SettlementCursor {
  capturedAt: string;
  used: number;
  total: number;
  resetAt: string | null;
}

function pendingRowsExist(db: DeepaaDatabase, targetId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM usage_ledger
    WHERE target_id = ?
      AND billing_channel IN ('plan', 'subscription')
      AND (plan_credit_unit IS NULL OR plan_credit_unit = '')
      AND plan_estimated_status = 'unavailable'
    LIMIT 1`).get(targetId) !== undefined;
}

/** 锚窗选择（F2）：目标实际存在快照的窗口里取策略优先序（最长）第一个。 */
function anchorWindowLabel(
  db: DeepaaDatabase,
  targetId: string,
  priority: readonly string[],
  windowDays: Readonly<Record<string, number>>,
): string | undefined {
  const rows = db.prepare(`
    SELECT DISTINCT window_label FROM plan_quota_snapshots
    WHERE target_id = ? AND used IS NOT NULL AND total IS NOT NULL`)
    .all(targetId) as Array<{window_label: string}>;
  const available = new Set(rows.map(row => row.window_label));
  for (const label of priority) {
    if (available.has(label) && windowDays[label] !== undefined) return label;
  }
  return undefined;
}

/** 锚窗快照批（按 captured_at 聚合多密钥、升序、30 天回看有界）。 */
function snapshotBatches(
  db: DeepaaDatabase,
  targetId: string,
  windowLabel: string,
  lookbackStartIso: string,
): AggregatedSnapshotBatch[] {
  return db.prepare(`
    SELECT captured_at AS capturedAt, SUM(used) AS used, SUM(total) AS total, MAX(reset_at) AS resetAt
    FROM plan_quota_snapshots
    WHERE target_id = ? AND window_label = ? AND used IS NOT NULL AND total IS NOT NULL
      AND captured_at >= ?
    GROUP BY captured_at
    ORDER BY captured_at ASC
    LIMIT ${MAX_SETTLEMENT_BATCHES}`).all(targetId, windowLabel, lookbackStartIso) as AggregatedSnapshotBatch[];
}

function readSettlementCursor(
  db: DeepaaDatabase,
  targetId: string,
  windowLabel: string,
): SettlementCursor | undefined {
  const row = db.prepare(`
    SELECT baseline_captured_at AS capturedAt, baseline_used AS used,
      baseline_total AS total, baseline_reset_at AS resetAt
    FROM plan_estimate_settlements
    WHERE target_id = ? AND window_label = ?`)
    .get(targetId, windowLabel) as SettlementCursor | undefined;
  return row ?? undefined;
}

function hasAnySettlementCursor(db: DeepaaDatabase, targetId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM plan_estimate_settlements WHERE target_id = ? LIMIT 1`)
    .get(targetId) !== undefined;
}

function upsertSettlementCursor(
  db: DeepaaDatabase,
  targetId: string,
  windowLabel: string,
  cursor: SettlementCursor,
): void {
  db.prepare(`
    INSERT INTO plan_estimate_settlements(
      target_id, window_label, baseline_captured_at, baseline_used,
      baseline_total, baseline_reset_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?
    ) ON CONFLICT(target_id, window_label) DO UPDATE SET
      baseline_captured_at = excluded.baseline_captured_at,
      baseline_used = excluded.baseline_used,
      baseline_total = excluded.baseline_total,
      baseline_reset_at = excluded.baseline_reset_at,
      updated_at = excluded.updated_at`)
    .run(targetId, windowLabel, cursor.capturedAt, cursor.used,
      cursor.total, cursor.resetAt, new Date().toISOString());
}

function collectCandidates(
  db: DeepaaDatabase,
  targetId: string,
  periodFrom: string,
  periodTo: string,
  limit: number,
): BackfillCandidate[] {
  return db.prepare(`
    SELECT exchange_id AS exchangeId, created_at AS capturedAt, reference_cost_nano AS referenceCostNano
    FROM usage_ledger
    WHERE target_id = ?
      AND billing_channel IN ('plan', 'subscription')
    AND (plan_credit_unit IS NULL OR plan_credit_unit = '')
    AND plan_estimated_status = 'unavailable'
    AND created_at >= ? AND created_at < ?
    ORDER BY created_at ASC, exchange_id ASC
    LIMIT ?`).all(targetId, periodFrom, periodTo, limit) as BackfillCandidate[];
}

/**
 * 本差分段全部应归属行的市价聚合（2026-10-09 截断守恒）：pending 行 + 本段
 * （periodFrom/periodTo 相同）已补写行。截断续跑时份额分母稳定，周期价值跨轮
 * 分摊总额守恒（旧行为：重跑时分母只剩 pending，整段价值被重复分摊）。
 * created_at 范围与 detail 段键是两个维度：候选范围按窗口起点下界圈定，
 * 已补写行按冻结的结算段键（earlier/later 快照时刻）精确匹配。
 */
function periodMarketAggregate(
  db: DeepaaDatabase,
  targetId: string,
  createdFrom: string,
  createdTo: string,
  periodKeyFrom: string,
  periodKeyTo: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(reference_cost_nano), 0) AS marketNano
    FROM usage_ledger
    WHERE target_id = ?
      AND billing_channel IN ('plan', 'subscription')
      AND (plan_credit_unit IS NULL OR plan_credit_unit = '')
      AND created_at >= ? AND created_at < ?
      AND reference_cost_nano > 0
      AND (plan_estimated_status = 'unavailable'
        OR (plan_estimated_method = 'quota_delta'
          AND json_extract(plan_estimate_detail_json, '$.periodFrom') = ?
          AND json_extract(plan_estimate_detail_json, '$.periodTo') = ?))`)
    .get(targetId, createdFrom, createdTo, periodKeyFrom, periodKeyTo) as {marketNano: number};
  return row.marketNano;
}

/** 比率兜底候选（A1）：早于最老快照批的 pending 行（回看下界有界）。 */
function collectRatioFallbackCandidates(
  db: DeepaaDatabase,
  targetId: string,
  fromIso: string,
  beforeIso: string,
  limit: number,
): BackfillCandidate[] {
  return db.prepare(`
    SELECT exchange_id AS exchangeId, created_at AS capturedAt, reference_cost_nano AS referenceCostNano
    FROM usage_ledger
    WHERE target_id = ?
      AND billing_channel IN ('plan', 'subscription')
      AND (plan_credit_unit IS NULL OR plan_credit_unit = '')
      AND plan_estimated_status = 'unavailable'
      AND created_at >= ? AND created_at < ?
    ORDER BY created_at ASC, exchange_id ASC
    LIMIT ?`).all(targetId, fromIso, beforeIso, limit) as BackfillCandidate[];
}

/** 比率兜底证据（A1）：该目标全部已结算行的 估算/市价 聚合；
 *  排除 ratio_fallback 行自身（防比率自增强漂移）。 */
function readEstimateRatioEvidence(
  db: DeepaaDatabase,
  targetId: string,
): {count: number; marketNano: number; estimateNano: number} {
  return db.prepare(`
    SELECT COUNT(*) AS count,
      COALESCE(SUM(reference_cost_nano), 0) AS marketNano,
      COALESCE(SUM(plan_estimated_cost_nano), 0) AS estimateNano
    FROM usage_ledger
    WHERE target_id = ?
      AND billing_channel IN ('plan', 'subscription')
      AND plan_estimated_status = 'estimated'
      AND reference_cost_nano > 0
      AND (plan_estimated_method IS NULL OR plan_estimated_method != 'ratio_fallback')`)
    .get(targetId) as {count: number; marketNano: number; estimateNano: number};
}

function markDirtyBuckets(db: DeepaaDatabase, capturedAtList: readonly string[]): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO analytics_dirty_buckets(bucket_start_utc, reason, first_seen_at, last_seen_at, available_at)
    VALUES(?, 'plan_estimate_backfill', ?, ?, ?)
    ON CONFLICT(bucket_start_utc) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      reason = CASE WHEN analytics_dirty_buckets.reason = excluded.reason
        THEN analytics_dirty_buckets.reason
        ELSE analytics_dirty_buckets.reason || ',' || excluded.reason END,
      status = CASE WHEN analytics_dirty_buckets.status = 'completed' THEN 'pending'
        ELSE analytics_dirty_buckets.status END,
      available_at = MIN(analytics_dirty_buckets.available_at, excluded.available_at)`);
  const buckets = new Set(capturedAtList.map(capturedAt =>
    new Date(Math.floor(Date.parse(capturedAt) / 3_600_000) * 3_600_000).toISOString()));
  for (const bucket of buckets) upsert.run(bucket, now, now, now);
}

/** 窗口起点（reset_at − 窗口天数）：额度 percent 只累计本周期用量，
 *  周期起点之前的行其用量不在任何差分里，纳入只会虚增分摊。 */
function windowStartIso(resetAt: string | null, windowDays: number): string | null {
  if (!resetAt) return null;
  const startMs = Date.parse(resetAt) - windowDays * 86_400_000;
  return Number.isFinite(startMs) ? new Date(startMs).toISOString() : null;
}

/** 候选下界：max(窗口起点, 30 天回看)。窗口起点缺失（reset_at 空）只留回看下界。 */
function candidateLowerBound(
  laterCapturedAt: string,
  resetAt: string | null,
  windowDays: number,
): string {
  const bounds = [Date.parse(laterCapturedAt) - PLAN_ESTIMATE_BACKFILL_LOOKBACK_MS];
  const windowStart = windowStartIso(resetAt, windowDays);
  if (windowStart !== null) bounds.push(Date.parse(windowStart));
  return new Date(Math.max(...bounds)).toISOString();
}

interface SettlementApply {
  applied: boolean;
  updatedRows: number;
  deferredRows: number;
  periodValueNano: number;
  updates: Array<{
    exchangeId: string;
    capturedAt: string;
    costCurrencyValue: number;
    currency: "CNY" | "USD";
    fx: number;
    nano: number;
    detailJson: string;
    /** 本行市价 nano（运行内认领剥离与分母修正用）。 */
    referenceCostNano: number;
  }>;
}

export function runPlanEstimateBackfill(
  db: DeepaaDatabase,
  input: {
    targetId: string;
    providerType: string;
    monthlyFee: number | undefined;
    feeCurrency: "CNY" | "USD" | undefined;
    maxRows?: number;
  },
): PlanEstimateBackfillOutcome {
  /* 门禁短路：无待补写行（积分公式供应商常态）零开销返回。 */
  if (!pendingRowsExist(db, input.targetId)) return {status: "short_circuit"};
  if (input.monthlyFee === undefined || !Number.isFinite(input.monthlyFee) || input.monthlyFee < 0) {
    return {status: "skip", reason: "no_monthly_fee"};
  }
  /* 属性收窄不进闭包（settle 在下方定义），先提为常量。 */
  const monthlyFee = input.monthlyFee;
  const feeCurrency = input.feeCurrency === "USD" ? "USD" : "CNY";
  const maxRows = input.maxRows ?? MAX_PLAN_ESTIMATE_BACKFILL_ROWS;
  const strategy = resolvePlanEstimateStrategy(input.providerType);
  const anchor = anchorWindowLabel(db, input.targetId, strategy.windowPriority, strategy.windowDays);
  if (anchor === undefined) return {status: "skip", reason: "no_pairable_window"};
  const windowDays = strategy.windowDays[anchor]!;

  const lookbackStartIso = new Date(Date.now() - PLAN_ESTIMATE_BACKFILL_LOOKBACK_MS).toISOString();
  const batches = snapshotBatches(db, input.targetId, anchor, lookbackStartIso);
  if (batches.length === 0) return {status: "skip", reason: "no_pairable_window"};

  /* 结算基线：有游标且游标批仍在回看窗口内则从它继续；否则以最老可用批初始化
     （更早差分随快照保留策略不可恢复，诚实放弃）。 */
  const storedCursor = readSettlementCursor(db, input.targetId, anchor);
  let index = storedCursor
    ? batches.findIndex(batch => batch.capturedAt === storedCursor.capturedAt)
    : -1;
  const firstRun = !hasAnySettlementCursor(db, input.targetId);
  if (index === -1) index = 0;
  const fxUsdCny = readLatestUsdCnyRate(db);

  const updateStmt = db.prepare(`
    UPDATE usage_ledger SET
      plan_estimated_status = 'estimated',
      plan_estimated_cost = ?,
      plan_estimated_currency = ?,
      plan_estimated_fx = ?,
      plan_estimated_cost_nano = ?,
      plan_estimate_detail_json = ?,
      plan_estimated_method = 'quota_delta'
    WHERE exchange_id = ? AND plan_estimated_status = 'unavailable'`);

  /** 单次结算：构造配对 → 全量 pending 候选 → 事务外收集 UPDATE 载荷。
      段键（aggregate 匹配与 detail 冻结共用）= earlier/later 的展示周期。 */
  const settle = (
    earlier: PairedQuotaSnapshot,
    later: PairedQuotaSnapshot,
    budget: number,
  ): SettlementApply => {
    const lowerBound = candidateLowerBound(later.capturedAt, later.resetAt, windowDays);
    const periodKey = `${earlier.capturedAt}\u0000${later.capturedAt}`;
    const candidates = collectCandidates(db, input.targetId, lowerBound, later.capturedAt, budget + 1)
      .filter(candidate => !claimedExchangeIds.has(candidate.exchangeId));
    /* 聚合按已提交状态读库；本运行内前序结算尚未提交，其行需从 pending 口径中
       剥离（他段行既不在本段分母、也不再重复排队；同段行——残差与残差中点
       共用段键——保留在分母，守恒语义不变）。 */
    const otherPeriodQueuedMarket = queuedUpdates
      .filter(queued => queued.periodKey !== periodKey)
      .reduce((sum, queued) => sum + queued.marketNano, 0);
    const marketTotalNano = Math.max(0, periodMarketAggregate(
      db, input.targetId, lowerBound, later.capturedAt, earlier.capturedAt, later.capturedAt,
    ) - otherPeriodQueuedMarket);
    const allocation = computeQuotaDeltaAllocation({
      monthlyFee,
      feeCurrency,
      fxUsdCny,
      windowDays,
      earlier,
      later,
      candidates,
      maxRows: budget,
      marketTotalNano,
    });
    if (allocation.status === "skip") {
      return {applied: false, updatedRows: 0, deferredRows: 0, periodValueNano: 0, updates: []};
    }
    return {
      applied: true,
      updatedRows: 0,
      deferredRows: allocation.deferredRows,
      periodValueNano: allocation.periodValueNano,
      updates: allocation.rows.map(row => ({
        exchangeId: row.exchangeId,
        capturedAt: row.capturedAt,
        costCurrencyValue: row.nano / allocation.fx / 1e9,
        currency: allocation.currency,
        fx: allocation.fx,
        nano: row.nano,
        detailJson: buildQuotaDeltaDetail(allocation, row),
        referenceCostNano: row.referenceCostNano,
      })),
    };
  };

  /** reset 残差中点结算（2026-10-09 A2）：合成 Δ = 0.5%×总额度 的配对复用分摊
      机制，段键与残差结算一致（守恒聚合共用）；detail 重写为中点语义。
      候选上界 = 旧窗口终点（base.resetAt）：最后一次轮询之后、窗口关闭之前的
      行正是整数刻度看不见的零头；≥ 终点的行属新窗口（开仓/后续 tick 归属）。 */
  const settleResidual = (
    base: AggregatedSnapshotBatch,
    lastOld: AggregatedSnapshotBatch,
    budget: number,
  ): SettlementApply => {
    const total = lastOld.total > 0 ? lastOld.total : 100;
    const midpointDelta = total * (RESET_RESIDUAL_MIDPOINT_PERCENT / 100);
    const boundary = base.resetAt ?? lastOld.capturedAt;
    const lowerBound = candidateLowerBound(boundary, base.resetAt, windowDays);
    const periodKey = `${base.capturedAt}\u0000${boundary}`;
    const candidates = collectCandidates(db, input.targetId, lowerBound, boundary, budget + 1)
      .filter(candidate => !claimedExchangeIds.has(candidate.exchangeId));
    if (!candidates.some(candidate => candidate.referenceCostNano > 0)) {
      return {applied: false, updatedRows: 0, deferredRows: 0, periodValueNano: 0, updates: []};
    }
    const otherPeriodQueuedMarket = queuedUpdates
      .filter(queued => queued.periodKey !== periodKey)
      .reduce((sum, queued) => sum + queued.marketNano, 0);
    const marketTotalNano = Math.max(0, periodMarketAggregate(
      db, input.targetId, lowerBound, boundary, base.capturedAt, boundary,
    ) - otherPeriodQueuedMarket);
    const allocation = computeQuotaDeltaAllocation({
      monthlyFee,
      feeCurrency,
      fxUsdCny,
      windowDays,
      earlier: {windowLabel: anchor, used: base.used, total, resetAt: lastOld.resetAt ?? "", capturedAt: base.capturedAt},
      later: {windowLabel: anchor, used: base.used + midpointDelta, total, resetAt: lastOld.resetAt ?? "", capturedAt: boundary},
      candidates,
      maxRows: budget,
      marketTotalNano,
    });
    if (allocation.status === "skip") {
      return {applied: false, updatedRows: 0, deferredRows: 0, periodValueNano: 0, updates: []};
    }
    return {
      applied: true,
      updatedRows: 0,
      deferredRows: allocation.deferredRows,
      periodValueNano: allocation.periodValueNano,
      updates: allocation.rows.map(row => ({
        exchangeId: row.exchangeId,
        capturedAt: row.capturedAt,
        costCurrencyValue: row.nano / allocation.fx / 1e9,
        currency: allocation.currency,
        fx: allocation.fx,
        nano: row.nano,
        detailJson: JSON.stringify({
          consumedBasis: "reset_residual",
          monthlyFee,
          currency: allocation.currency,
          ...(allocation.currency === "USD" ? {fxUsdCny: allocation.fx} : {}),
          windowLabel: anchor,
          windowDays,
          usedTo: lastOld.used,
          total,
          midpointPercent: RESET_RESIDUAL_MIDPOINT_PERCENT,
          periodFrom: base.capturedAt,
          periodTo: boundary,
          requestCount: allocation.rows.length,
          shareOfMarketCost: row.share,
        }),
        referenceCostNano: row.referenceCostNano,
      })),
    };
  };

  let budget = maxRows;
  let totalUpdated = 0;
  let totalDeferred = 0;
  let totalPeriodValueNano = 0;
  let firstPeriod: {from: string; to: string} | undefined;
  let lastPeriod: {from: string; to: string} | undefined;
  const pendingUpdates: SettlementApply["updates"] = [];
  /* 单次运行内多个结算共用一次延迟提交（事务在循环后）；SQL 读到的是已提交状态，
     前序结算认领的行必须从后续结算的候选与分母中剥离（2026-10-09 修复：
     重复排队 + 跨段分母失真）。 */
  const claimedExchangeIds = new Set<string>();
  const queuedUpdates: Array<{exchangeId: string; marketNano: number; periodKey: string}> = [];

  const record = (apply: SettlementApply, periodFrom: string, periodTo: string): boolean => {
    if (!apply.applied) return false;
    pendingUpdates.push(...apply.updates);
    const periodKey = `${periodFrom}\u0000${periodTo}`;
    for (const row of apply.updates) {
      claimedExchangeIds.add(row.exchangeId);
      queuedUpdates.push({exchangeId: row.exchangeId, marketNano: row.referenceCostNano, periodKey});
    }
    totalUpdated += apply.updates.length;
    totalDeferred += apply.deferredRows;
    totalPeriodValueNano += apply.periodValueNano;
    firstPeriod ??= {from: periodFrom, to: periodTo};
    lastPeriod = {from: periodFrom, to: periodTo};
    budget -= apply.updates.length;
    return true;
  };

  const snapshotOf = (batch: AggregatedSnapshotBatch): PairedQuotaSnapshot => ({
    windowLabel: anchor, used: batch.used, total: batch.total,
    resetAt: batch.resetAt ?? "", capturedAt: batch.capturedAt,
  });

  /* 首次运行（或锚窗切换前从未结算过）且基线批已有消耗：开仓结算 0 → 基线用量，
     归属窗口起点以来的本地行。锚窗切换（旧窗口已有游标）不开仓，避免跨窗重复归属。
     开仓被行数预算截断时不落游标，下轮对剩余 pending 行重开同一段价值（总额守恒）。 */
  const baseBatch = batches[index]!;
  let openingTruncated = false;
  if (firstRun && baseBatch.used > 0 && baseBatch.total > 0 && baseBatch.resetAt) {
    const windowStart = windowStartIso(baseBatch.resetAt, windowDays);
    if (windowStart !== null) {
      const opening = settle(
        {windowLabel: anchor, used: 0, total: baseBatch.total, resetAt: baseBatch.resetAt, capturedAt: windowStart},
        snapshotOf(baseBatch),
        budget,
      );
      if (record(opening, windowStart, baseBatch.capturedAt) && opening.deferredRows > 0) {
        openingTruncated = true;
      }
    }
  }

  /* 结算循环：逐批推进；同周期正差分结算，跨 reset 先闭旧周期残差再开新周期。
     行数预算截断（deferredRows>0）时不推进游标，下轮对剩余行分摊同一段价值。 */
  while (index + 1 < batches.length && budget > 0) {
    const base = batches[index]!;
    const next = batches[index + 1]!;
    if (base.resetAt && next.resetAt === base.resetAt) {
      if (next.used > base.used && next.total > 0) {
        const apply = settle(snapshotOf(base), snapshotOf(next), budget);
        const settled = record(apply, base.capturedAt, next.capturedAt);
        if (settled && apply.deferredRows > 0) break;
      }
      index += 1;
      continue;
    }
    /* 周期切换：旧 reset 的最后一批闭残差（若有正差分）。 */
    let lastOldIndex = index;
    while (lastOldIndex + 1 < batches.length
      && base.resetAt !== null
      && batches[lastOldIndex + 1]!.resetAt === base.resetAt) {
      lastOldIndex += 1;
    }
    const lastOld = batches[lastOldIndex]!;
    if (lastOld.used > base.used && lastOld.total > 0) {
      const residue = settle(snapshotOf(base), snapshotOf(lastOld), budget);
      const settled = record(residue, base.capturedAt, lastOld.capturedAt);
      if (settled && residue.deferredRows > 0) break;
    }
    /* reset 残差中点（2026-10-09 A2 用户确认）：闭窗最后一段的消耗在整数刻度下
       ∈ [0, 1%)，刻度不可见；对闭窗范围内剩余 pending 行按 0.5%×窗口价值×市价
       份额补算（期望误差 ±0.5%×窗口价值，每周有界）。method 仍为 quota_delta、
       detail.consumedBasis=reset_residual——与残差共用段键，聚合守恒机制不变。 */
    if (budget > 0) {
      const residual = settleResidual(base, lastOld, budget);
      if (record(residual, base.capturedAt, base.resetAt ?? lastOld.capturedAt) && residual.deferredRows > 0) break;
    }
    /* 新周期开仓：第一批的已有消耗归属窗口起点以来的本地行。开仓截断时游标停在
       base（旧基线），下轮残差零差分直接推进到过渡、对剩余行重开同一段价值。 */
    const firstNewIndex = lastOldIndex + 1;
    if (firstNewIndex >= batches.length) break;
    const firstNew = batches[firstNewIndex]!;
    if (firstNew.used > 0 && firstNew.total > 0 && firstNew.resetAt) {
      const newWindowStart = windowStartIso(firstNew.resetAt, windowDays);
      if (newWindowStart !== null) {
        const opening = settle(
          {windowLabel: anchor, used: 0, total: firstNew.total, resetAt: firstNew.resetAt, capturedAt: newWindowStart},
          snapshotOf(firstNew),
          budget,
        );
        if (record(opening, newWindowStart, firstNew.capturedAt) && opening.deferredRows > 0) break;
      }
    }
    index = firstNewIndex;
  }

  /* A1 比率兜底（2026-10-09 用户确认）：早于最老快照批的 pending 行结构上无法
     差分归属（pre-sync 历史行、开仓后迟到行等），按该目标已结算行（任意 method，
     排除兜底行自身防自增强）的 估算÷市价 比率一次性补算。证据门槛防新目标小样本
     瞎算；不足则继续等待（正常使用数小时内积累够）。主循环零结算时仍可独立运行。 */
  const oldestBatchAt = batches[0]!.capturedAt;
  const runRatioFallbackPass = (): number => {
    const candidates = collectRatioFallbackCandidates(db, input.targetId, lookbackStartIso, oldestBatchAt, maxRows)
      .filter(row => row.referenceCostNano > 0);
    if (candidates.length === 0) return 0;
    const evidence = readEstimateRatioEvidence(db, input.targetId);
    if (evidence.count < RATIO_EVIDENCE_MIN_ROWS || evidence.marketNano < RATIO_EVIDENCE_MIN_MARKET_NANO) return 0;
    const ratioNano = evidence.estimateNano / evidence.marketNano;
    /* 独立 UPDATE（method=ratio_fallback，区别于差分家族的 quota_delta）：
       该标记同时是证据查询的自增强排除键与展示端文案分支依据。 */
    const ratioUpdate = db.prepare(`
      UPDATE usage_ledger SET
        plan_estimated_status = 'estimated',
        plan_estimated_cost = ?,
        plan_estimated_currency = ?,
        plan_estimated_fx = ?,
        plan_estimated_cost_nano = ?,
        plan_estimate_detail_json = ?,
        plan_estimated_method = 'ratio_fallback'
      WHERE exchange_id = ? AND plan_estimated_status = 'unavailable'`);
    let written = 0;
    const ratioCommit = db.transaction(() => {
      const touchedAt: string[] = [];
      for (const row of candidates) {
        const nano = Math.round(row.referenceCostNano * ratioNano);
        const result = ratioUpdate.run(
          nano / 1e9, "CNY", 1, nano,
          JSON.stringify({
            consumedBasis: "ratio_fallback",
            monthlyFee,
            fallbackRatio: ratioNano,
            evidenceRows: evidence.count,
            evidenceMarketCny: evidence.marketNano / 1e9,
            evidenceEstimateCny: evidence.estimateNano / 1e9,
          }),
          row.exchangeId,
        );
        if (result.changes > 0) {
          written += 1;
          touchedAt.push(row.capturedAt);
        }
      }
      if (touchedAt.length > 0) markDirtyBuckets(db, touchedAt);
    });
    ratioCommit();
    return written;
  };

  if (totalUpdated === 0) {
    /* 主循环零结算（平Δ/无配对）时比率兜底仍是独立通道：pre-sync 行的治愈
       不依赖差分信号，只依赖已结算证据。 */
    const ratioOnly = runRatioFallbackPass();
    if (ratioOnly > 0) {
      return {
        status: "estimated",
        windowLabel: anchor,
        periodFrom: oldestBatchAt,
        periodTo: oldestBatchAt,
        updatedRows: 0,
        deferredRows: 0,
        periodValueNano: 0,
        ratioFallbackRows: ratioOnly,
      };
    }
    return {status: "skip", reason: "no_pairable_window"};
  }

  /* 单事务：行补写 + 脏桶 + 游标推进原子提交；行更新失败则游标不前进，下轮重算同段。
     开仓截断时不写游标（基线批之前的价值未分摊完，游标推进会永久吞掉剩余行）。 */
  const finalBase = batches[index]!;
  const commit = db.transaction((): number => {
    const touchedAt: string[] = [];
    for (const row of pendingUpdates) {
      const result = updateStmt.run(
        row.costCurrencyValue, row.currency, row.fx, row.nano, row.detailJson, row.exchangeId,
      );
      if (result.changes > 0) touchedAt.push(row.capturedAt);
    }
    if (touchedAt.length > 0) markDirtyBuckets(db, touchedAt);
    if (!openingTruncated) {
      upsertSettlementCursor(db, input.targetId, anchor, {
        capturedAt: finalBase.capturedAt,
        used: finalBase.used,
        total: finalBase.total,
        resetAt: finalBase.resetAt,
      });
    }
    return touchedAt.length;
  });
  const committedRows = commit();

  const ratioFallbackRows = runRatioFallbackPass();

  return {
    status: "estimated",
    windowLabel: anchor,
    periodFrom: firstPeriod?.from ?? finalBase.capturedAt,
    periodTo: lastPeriod?.to ?? finalBase.capturedAt,
    updatedRows: committedRows,
    deferredRows: totalDeferred,
    periodValueNano: totalPeriodValueNano,
    ...(ratioFallbackRows > 0 ? {ratioFallbackRows} : {}),
  };
}
