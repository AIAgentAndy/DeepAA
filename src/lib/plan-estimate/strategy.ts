/**
 * 额度差分估算策略（纯函数层）。
 *
 * 设计文档：docs/额度差分估算回填机制设计文档.md（2026-09-29 用户确认）。
 * 职责：快照配对校验、周期价值计算（时间份额假设）、按请求市价份额分摊；
 * 全部无 IO、可穷举单测。编排与落库见 ./backfill.ts。
 *
 * 核心公式：
 *   周期价值（CNY）= 月费(CNY) × 窗口天数/30 × (ΔUsed ÷ Total)
 *   每行估算 nano = 周期价值 nano × (本行 reference_cost ÷ Σ周期内待补写行 reference_cost)
 * 满耗极限自检：一周用满 → 周期成本 = 月费×7/30，一个月各周累计 = 月费。
 */

/** 已通过配对校验的快照（backfill 聚合批次后的形态）。 */
export interface PairedQuotaSnapshot {
  windowLabel: string;
  used: number;
  total: number;
  resetAt: string;
  capturedAt: string;
}

/** 周期内待补写账本行（backfill 归集后传入）。 */
export interface BackfillCandidate {
  exchangeId: string;
  capturedAt: string;
  referenceCostNano: number;
}

export interface QuotaDeltaAllocationInput {
  monthlyFee: number;
  feeCurrency: "CNY" | "USD";
  /** 月费 USD 时的入账汇率（CNY 月费传 1）。 */
  fxUsdCny: number;
  windowDays: number;
  /** 周期起点快照（早）。 */
  earlier: PairedQuotaSnapshot;
  /** 周期终点快照（晚），须与 earlier 同窗口同 reset_at。 */
  later: PairedQuotaSnapshot;
  /** 待补写行（含无市价行，策略内过滤），按 capturedAt 升序。 */
  candidates: ReadonlyArray<BackfillCandidate>;
  /** 单次回填行数上限（防大事务），超出按 capturedAt 顺延下轮。 */
  maxRows: number;
  /**
   * 本差分段全部应归属行的市价聚合（2026-10-09 截断守恒）：分母 = pending 行 +
   * 本段（periodFrom/periodTo 相同）已补写行，跨轮重跑份额稳定、总额守恒。
   * 缺省回退「当前候选集内市价总和」（纯函数单测口径）。
   */
  marketTotalNano?: number;
}

export interface QuotaDeltaRowAllocation {
  exchangeId: string;
  capturedAt: string;
  referenceCostNano: number;
  /** 本行市价占周期内待补写行市价总和的份额（0~1）。 */
  share: number;
  nano: number;
}

export type QuotaDeltaAllocation =
  | {
      status: "skip";
      reason: "non_positive_delta" | "no_market_cost" | "no_candidates";
      windowLabel: string;
      periodFrom: string;
      periodTo: string;
    }
  | {
      status: "estimated";
      windowLabel: string;
      periodFrom: string;
      periodTo: string;
      currency: "CNY" | "USD";
      /** 入账汇率（CNY=1）。 */
      fx: number;
      monthlyFee: number;
      windowDays: number;
      usedFrom: number;
      usedTo: number;
      total: number;
      deltaUsed: number;
      /** 周期价值（人民币 nano）。 */
      periodValueNano: number;
      rows: QuotaDeltaRowAllocation[];
      /** 因行数上限顺延到下轮的行数（含无市价不参与者之外的待补写行）。 */
      deferredRows: number;
    };

/** 配对校验：同窗口、同 reset_at（非空）、时间序严格递增。跨周期（重置）绝不配对。 */
export function canPairQuotaSnapshots(
  earlier: {windowLabel: string; resetAt: string | null | undefined},
  later: {windowLabel: string; resetAt: string | null | undefined; capturedAt: string},
  earlierCapturedAt: string,
): boolean {
  if (earlier.windowLabel !== later.windowLabel) return false;
  if (!later.resetAt || earlier.resetAt !== later.resetAt) return false;
  return earlierCapturedAt < later.capturedAt;
}

export function computeQuotaDeltaAllocation(input: QuotaDeltaAllocationInput): QuotaDeltaAllocation {
  const {earlier, later} = input;
  const base = {
    windowLabel: later.windowLabel,
    periodFrom: earlier.capturedAt,
    periodTo: later.capturedAt,
  };
  const deltaUsed = later.used - earlier.used;
  if (!(deltaUsed > 0) || !(later.total > 0)) {
    return {status: "skip", reason: "non_positive_delta", ...base};
  }
  const marketRows = input.candidates.filter(row => row.referenceCostNano > 0);
  if (marketRows.length === 0) {
    return {status: "skip", reason: input.candidates.length === 0 ? "no_candidates" : "no_market_cost", ...base};
  }
  /* 行数上限：按 capturedAt 升序取前 N（candidates 已升序），其余顺延下轮。
     份额分母优先用全量聚合（截断续跑守恒）；缺省回退候选集内总和。
     deferredRows 只统计本轮未更新的 pending 行（聚合含已补写行，不参与该口径）。 */
  const bounded = marketRows.slice(0, input.maxRows);
  const marketTotal = input.marketTotalNano !== undefined && input.marketTotalNano > 0
    ? input.marketTotalNano
    : bounded.reduce((sum, row) => sum + row.referenceCostNano, 0);
  const deferredRows = marketRows.length - bounded.length;
  const fx = input.feeCurrency === "USD" ? (Number.isFinite(input.fxUsdCny) && input.fxUsdCny > 0 ? input.fxUsdCny : 1) : 1;
  const feeCny = input.monthlyFee * fx;
  const periodValueNano = Math.round(feeCny * 1e9 * (input.windowDays / 30) * (deltaUsed / later.total));
  const rows: QuotaDeltaRowAllocation[] = bounded.map(row => {
    const share = row.referenceCostNano / marketTotal;
    return {
      exchangeId: row.exchangeId,
      capturedAt: row.capturedAt,
      referenceCostNano: row.referenceCostNano,
      share,
      nano: Math.round(periodValueNano * share),
    };
  });
  return {
    status: "estimated",
    ...base,
    currency: input.feeCurrency,
    fx,
    monthlyFee: input.monthlyFee,
    windowDays: input.windowDays,
    usedFrom: earlier.used,
    usedTo: later.used,
    total: later.total,
    deltaUsed,
    periodValueNano,
    rows,
    deferredRows,
  };
}

/** quota_delta 行的入账 detail JSON（浮窗据此还原差分依据）。 */
export function buildQuotaDeltaDetail(allocation: Extract<QuotaDeltaAllocation, {status: "estimated"}>, row: QuotaDeltaRowAllocation): string {
  return JSON.stringify({
    consumedBasis: "quota_delta",
    monthlyFee: allocation.monthlyFee,
    currency: allocation.currency,
    windowLabel: allocation.windowLabel,
    windowDays: allocation.windowDays,
    usedFrom: allocation.usedFrom,
    usedTo: allocation.usedTo,
    total: allocation.total,
    deltaUsed: allocation.deltaUsed,
    periodFrom: allocation.periodFrom,
    periodTo: allocation.periodTo,
    requestCount: allocation.rows.length,
    shareOfMarketCost: row.share,
    fxUsdCny: allocation.currency === "USD" ? allocation.fx : undefined,
  });
}
