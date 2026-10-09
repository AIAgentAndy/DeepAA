import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

const MAX_BREAKDOWN = 50;
const TOP_MODELS = 5;
const HEATMAP_DAYS = 7;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
/** Token 成本排行榜返回条数与扫描上限（分组数有界，遵守大数据红线）。 */
const COST_LEADERBOARD_ROWS = 10;
const COST_LEADERBOARD_SCAN = 200;

/**
 * 仪表盘统一「模型请求口径」（2026-09-16 用户确认）：unknown 模型行（辅助/探测/未识别
 * 请求，费用恒为 0）不再计入 KPI 与图表，与 Token 价格页默认口径对齐；
 * 被排除的请求量经 summary.auxiliaryRequestCount 透出作附注。
 */
const MODEL_SCOPE_PREDICATE = "COALESCE(model, 'unknown') <> 'unknown'";

/**
 * 消费口径（2026-09-17 用户确认）：仪表盘全部「金额」列只统计成功/已取消/补差行，
 * 与 Token 价格页默认结果筛选完全一致（`success,cancelled,reconciled`）；失败请求上
 * 多为估算的虚拟费用不计入金额。请求/Token 列保持全量观测口径，不受本谓词影响。
 */
const CONSUMPTION_RESULT_SCOPE = "result_class IN ('success', 'cancelled', 'reconciled')";

/* 套餐成本估算已冻结到 usage_ledger/facts（2026-09-15 入账冻结），查询端只读聚合值；
   readPlanTargetInfos 仅用于目标显示名。 */
import {
  readPlanTargetInfos,
  type PlanTargetInfo as TargetInfo,
} from "./plan-real-cost";
export {
  computePlanRealCostNano,
  type PlanQuotaTotal,
  type PlanTargetInfo as TargetInfo,
} from "./plan-real-cost";

export interface DashboardQueryInput {
  /** 查询窗口起点（ISO UTC，含）。 */
  start: string;
  /** 查询窗口终点（ISO UTC，排他）。 */
  end: string;
  /** hour = 逐小时出桶；day = 按本地日合并。 */
  granularity: "hour" | "day";
  /** hour 表示小时步长，day 表示本地自然日步长。 */
  bucketStep: number;
  bucketCount: number;
  timezone: string;
  now?: string;
  limit?: number;
}

export interface DashboardTrendBucket {
  start: string;
  end: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  paygCostNano: number;
  actualCostNano: number;
  marketCostNano: number;
  planCreditCost: number;
  /** 入账冻结的套餐成本估算（人民币 nano）。 */
  planEstimatedNano: number;
  /** 套餐/订阅通道请求数（KPI 卡 量/套 维度趋势线）。 */
  planRequestCount: number;
  /** 套餐/订阅通道 Token（KPI 卡 量/套 维度趋势线）。 */
  planTokens: number;
}

export interface DashboardModelTrend {
  model: string;
  requestCount: number;
  totalTokens: number;
  paygCostNano: number;
  actualCostNano: number;
  marketCostNano: number;
  /** 入账冻结的套餐成本估算（人民币 nano）。 */
  planEstimatedNano: number;
  /** 含未完成估算的套餐请求（缺月费/额度或旧口径行），消费为部分估算。 */
  planEstimatedPending: number;
  /** 估算真实成本 = 按量倍率后实付 + 套餐成本估算（2026-09-29 用户确认，与 KPI/排行榜同口径）。 */
  totalCostNano: number;
  series: number[];
}

/** Token 成本排行榜样目：估算成本 = 按量倍率后实付 + 套餐成本估算（入账冻结）。 */
export interface DashboardCostLeaderboardRow {
  targetId: string;
  targetName: string;
  model: string;
  channel: string;
  requestCount: number;
  totalTokens: number;
  actualCostNano: number;
  marketCostNano: number;
  creditCost: number;
  planRealCostNano: number;
  /** 该行含未完成估算的套餐请求（旧口径或缺月费/额度），总额为部分估算。 */
  planEstimatedPending: boolean;
  realCostNano: number;
  costPerMillionNano: number | null;
}

export interface DashboardQueryResult {
  range: {
    start: string;
    end: string;
    granularity: "hour" | "day";
    bucketStep: number;
    bucketCount: number;
    timezone: string;
  };
  summary: {
    requestCount: number;
    modelRequestCount: number;
    /** 被口径排除的辅助/探测/未识别（unknown 模型）请求行数，仅作附注展示。 */
    auxiliaryRequestCount: number;
    successCount: number;
    errorCount: number;
    cancelledCount: number;
    incompleteCount: number;
    failureCount: number;
    successRate: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    paygCostNano: number | null;
    paygActualCostNano: number | null;
    marketCostNano: number | null;
    marketRequestCount: number;
    planCreditCost: number;
    /* —— KPI 卡 量/套 维度拆分：按量 = 非 plan/subscription（含 unknown），套 = plan/subscription —— */
    /** 套餐/订阅通道请求数。 */
    planRequestCount: number;
    /** 套餐/订阅通道 Token。 */
    planTokens: number;
    paygSuccessCount: number;
    paygFailureCount: number;
    paygSuccessRate: number | null;
    planSuccessCount: number;
    planFailureCount: number;
    planSuccessRate: number | null;
    paygInputTokens: number;
    paygOutputTokens: number;
    paygCacheTokens: number;
    planInputTokens: number;
    planOutputTokens: number;
    planCacheTokens: number;
    /**
     * 套餐成本估算（nano，2026-09-15 入账冻结）：入账时按当次价格版本汇率与最新额度
     * 快照折算，历史不随后续汇率/月费变化漂移。旧口径行不回填，为 0 并配合 pending 标注。
     */
    planRealCostNano: number | null;
    /** 存在套餐通道消耗但估算缺失（月费/额度不足或旧口径行），总额为部分估算。 */
    planRealCostUnavailable: boolean;
    /** 待补估算请求数（2026-10-09 徽标收敛）：小字「N 条估算待补」的数据源。 */
    planEstimatedPendingCount: number;
    exactTokenRequestCount: number;
    unavailableTokenRequestCount: number;
    avgDurationMs: number | null;
    /** 原始币种超过一种（仅作附注；金额始终为人民币统一口径，可直接加总）。 */
    hasMultipleSourceCurrencies: boolean;
    /** 一期统一人民币结算口径。 */
    settlementCurrency: "CNY";
    /** 原始币种分布（金额为该币种行的人民币折算值，供附注展示币种列表）。 */
    sourceCurrencies: Array<{currency: string; settledPaygNano: number; settledMarketNano: number}>;
  };
  trend: {
    granularity: "hour" | "day";
    bucketCount: number;
    buckets: DashboardTrendBucket[];
    candidateBuckets: number;
    processedBuckets: number;
  };
  models: {
    items: DashboardModelTrend[];
    otherModelCount: number;
    candidateCount: number;
    processedCount: number;
    limited: boolean;
    hasMore: boolean;
  };
  vendors: Array<{
    targetId: string | null;
    name: string;
    legacy: boolean;
    vendorFamily: string;
    requestCount: number;
    totalTokens: number;
    paygCostNano: number;
    actualCostNano: number;
    marketCostNano: number;
    /** 入账冻结的套餐成本估算（人民币 nano）。 */
    planEstimatedNano: number;
    /** 含未完成估算的套餐请求（缺月费/额度或旧口径行），消费为部分估算。 */
    planEstimatedPending: number;
    successCount: number;
    failureCount: number;
    successRate: number | null;
    avgDurationMs: number | null;
  }>;
  agents: Array<{agent: string; requestCount: number; totalTokens: number; paygCostNano: number; actualCostNano: number; marketCostNano: number;
    /** 入账冻结的套餐成本估算（人民币 nano）。 */
    planEstimatedNano: number;
    /** 含未完成估算的套餐请求（缺月费/额度或旧口径行），消费为部分估算。 */
    planEstimatedPending: number;}>;
  plans: Array<{
    targetId: string;
    name: string;
    channel: string;
    vendorFamily: string;
    models: string[];
    requestCount: number;
    totalTokens: number;
    marketCostNano: number;
    creditCost: number;
    creditUnit: string | null;
    /** 套餐成本估算（入账冻结）；历史口径行经 planEstimatedPending 标注部分估算。 */
    planRealCostNano: number | null;
    planEstimatedPending: boolean;
  }>;
  costLeaderboard: {
    rows: DashboardCostLeaderboardRow[];
    candidateCount: number;
    processedCount: number;
    limited: boolean;
  };
  heatmap: {
    days: Array<{date: string; weekday: number; values: number[]; total: number}>;
  };
  freshness: {asOf: string | null; lagSeconds: number | null; staleBuckets: number};
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
}

const TREND_SELECT = `SUM(request_count) AS requestCount,
    SUM(success_count) AS successCount,
    SUM(error_count + incomplete_count) AS failureCount,
    SUM(input_tokens) AS inputTokens,
    SUM(output_tokens) AS outputTokens,
    SUM(cache_read_tokens + cache_write_tokens) AS cacheTokens,
    SUM(total_tokens) AS totalTokens,
    /* 金额列消费口径（2026-09-17），请求/Token 列全量 */
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN vendor_cost_nano ELSE 0 END) AS paygCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN actual_cost_nano ELSE 0 END) AS actualCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END) AS marketCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN COALESCE(plan_credit_cost, 0) ELSE 0 END) AS planCreditCost,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_nano ELSE 0 END), 0) AS planEstimatedNano,
    SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN request_count ELSE 0 END) AS planRequestCount,
    SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN total_tokens ELSE 0 END) AS planTokens`;

export async function loadAnalyticsDashboard(db: DeepaaDatabase, input: DashboardQueryInput): Promise<DashboardQueryResult> {
  const limit = Math.min(Math.max(1, input.limit ?? MAX_BREAKDOWN), MAX_BREAKDOWN);
  const where = `bucket_start_utc >= ? AND bucket_start_utc < ? AND ${MODEL_SCOPE_PREDICATE}`;
  const args = [input.start, input.end];

  const targetInfos = await readTargetInfos();
  const auxiliaryRequestCount = countAuxiliaryRequests(db, input.start, input.end);
  const summary = await sumFacts(db, where, args, auxiliaryRequestCount);
  const trend = loadTrend(db, input);
  const models = await loadModelTrend(db, input, limit);
  const vendors = await loadVendorStats(db, where, args, limit, targetInfos);
  const agents = loadAgentStats(db, where, args, limit);
  const plans = await loadPlanChannelBreakdown(db, where, args, input, targetInfos);
  const costLeaderboard = await loadCostLeaderboard(db, where, args, targetInfos);
  const heatmap = loadHeatmap(db, input);
  const freshness = loadFreshness(db);

  const candidateCount = trend.candidateBuckets;
  const processedCount = trend.processedBuckets;
  return {
    range: {
      start: input.start,
      end: input.end,
      granularity: input.granularity,
      bucketStep: input.bucketStep,
      bucketCount: input.bucketCount,
      timezone: input.timezone,
    },
    summary,
    trend,
    models,
    vendors,
    agents,
    plans,
    costLeaderboard,
    heatmap,
    freshness,
    candidateCount,
    processedCount,
    limited: candidateCount > processedCount,
    hasMore: candidateCount > processedCount,
  };
}

/* ==================== 汇总 ==================== */

/** 被模型口径排除的辅助/探测/未识别（unknown 模型）请求行数，仅供附注展示。 */
function countAuxiliaryRequests(db: DeepaaDatabase, start: string, end: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(request_count), 0) AS aux
    FROM analytics_hourly_facts
    WHERE bucket_start_utc >= ? AND bucket_start_utc < ? AND COALESCE(model, 'unknown') = 'unknown'`)
    .get(start, end) as {aux: number};
  return Number(row.aux ?? 0);
}

interface SumRow {
  requestCount: number;
  successCount: number;
  errorCount: number;
  cancelledCount: number;
  incompleteCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  paygCostNano: number;
  actualCostNano: number;
  marketCostNano: number;
  marketRequestCount: number;
  planCreditCost: number;
  planRequestCount: number;
  planTokens: number;
  paygSuccessCount: number;
  paygFailureCount: number;
  planSuccessCount: number;
  planFailureCount: number;
  paygInputTokens: number;
  paygOutputTokens: number;
  paygCacheTokens: number;
  planInputTokens: number;
  planOutputTokens: number;
  planCacheTokens: number;
  exactTokenRequestCount: number;
  unavailableTokenRequestCount: number;
  durationSumMs: number;
  durationSampleCount: number;
  currencyCount: number;
  planEstimatedNano: number;
  planEstimatedPending: number;
}

function sumFactsRow(db: DeepaaDatabase, whereSql: string, args: Array<string>): SumRow {
  return db.prepare(`SELECT
    COALESCE(SUM(request_count), 0) AS requestCount,
    COALESCE(SUM(success_count), 0) AS successCount,
    COALESCE(SUM(error_count), 0) AS errorCount,
    COALESCE(SUM(cancelled_count), 0) AS cancelledCount,
    COALESCE(SUM(incomplete_count), 0) AS incompleteCount,
    COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
    COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
    COALESCE(SUM(total_tokens), 0) AS totalTokens,
    /* 金额列为消费口径（2026-09-17）：只统计成功/已取消/补差行，与 Token 价格页默认
       结果筛选一致；请求/Token 拆分列保持全量。 */
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN vendor_cost_nano ELSE 0 END), 0) AS paygCostNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN actual_cost_nano ELSE 0 END), 0) AS actualCostNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END), 0) AS marketCostNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_request_count ELSE 0 END), 0) AS marketRequestCount,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_credit_cost ELSE 0 END), 0) AS planCreditCost,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_nano ELSE 0 END), 0) AS planEstimatedNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_pending_request_count ELSE 0 END), 0) AS planEstimatedPending,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN request_count ELSE 0 END), 0) AS planRequestCount,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN total_tokens ELSE 0 END), 0) AS planTokens,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN 0 ELSE success_count END), 0) AS paygSuccessCount,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN 0 ELSE error_count + incomplete_count END), 0) AS paygFailureCount,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN success_count ELSE 0 END), 0) AS planSuccessCount,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN error_count + incomplete_count ELSE 0 END), 0) AS planFailureCount,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN 0 ELSE input_tokens END), 0) AS paygInputTokens,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN 0 ELSE output_tokens END), 0) AS paygOutputTokens,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN 0 ELSE cache_read_tokens + cache_write_tokens END), 0) AS paygCacheTokens,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN input_tokens ELSE 0 END), 0) AS planInputTokens,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN output_tokens ELSE 0 END), 0) AS planOutputTokens,
    COALESCE(SUM(CASE WHEN billing_channel IN ('plan','subscription') THEN cache_read_tokens + cache_write_tokens ELSE 0 END), 0) AS planCacheTokens,
    COALESCE(SUM(exact_token_request_count), 0) AS exactTokenRequestCount,
    COALESCE(SUM(unavailable_token_request_count), 0) AS unavailableTokenRequestCount,
    COALESCE(SUM(duration_sum_ms), 0) AS durationSumMs,
    COALESCE(SUM(duration_sample_count), 0) AS durationSampleCount,
    /* 金额列为人民币统一口径（四层分离物化），币种判定只看消费口径内实际承载金额的行：
       未计价/零金额行（含 'unknown' 占位币种）不参与，避免 0 金额污染阻断汇总。 */
    COUNT(DISTINCT CASE WHEN ${CONSUMPTION_RESULT_SCOPE} AND (vendor_cost_nano != 0 OR actual_cost_nano != 0
      OR reference_cost_nano != 0) THEN currency END) AS currencyCount
    FROM analytics_hourly_facts WHERE ${whereSql}`).get(...args) as SumRow;
}

async function sumFacts(
  db: DeepaaDatabase,
  whereSql: string,
  args: Array<string>,
  auxiliaryRequestCount: number,
): Promise<DashboardQueryResult["summary"]> {
  const row = sumFactsRow(db, whereSql, args);
  /* sourceCurrencies：币种分布只取消费口径内金额非零的行；金额为人民币折算值（命名已注明 settled），
     不再冒充原币种金额。 */
  const sourceCurrencies = db.prepare(`SELECT currency,
    SUM(vendor_cost_nano) AS settledPaygNano, SUM(reference_cost_nano) AS settledMarketNano
    FROM analytics_hourly_facts WHERE ${whereSql} AND ${CONSUMPTION_RESULT_SCOPE}
    GROUP BY currency
    HAVING SUM(vendor_cost_nano) != 0 OR SUM(reference_cost_nano) != 0 OR SUM(actual_cost_nano) != 0
    ORDER BY currency ASC LIMIT 32`).all(...args) as Array<{currency: string; settledPaygNano: number; settledMarketNano: number}>;
  const hasMultipleSourceCurrencies = Number(row.currencyCount ?? 0) > 1;
  const auditedCount = row.successCount + row.errorCount + row.incompleteCount;

  return {
    requestCount: row.requestCount,
    modelRequestCount: row.requestCount,
    auxiliaryRequestCount,
    successCount: row.successCount,
    errorCount: row.errorCount,
    cancelledCount: row.cancelledCount,
    incompleteCount: row.incompleteCount,
    failureCount: row.errorCount + row.incompleteCount,
    successRate: auditedCount > 0 ? row.successCount / auditedCount : null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheTokens: row.cacheReadTokens + row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    /* 2026-09-05 四层分离 + 2026-09-15 入账冻结：facts 金额列为人民币统一口径，
       套餐估算读取入账时冻结聚合值，多原始币种不影响汇总。 */
    paygCostNano: row.paygCostNano,
    paygActualCostNano: row.actualCostNano,
    marketCostNano: row.marketCostNano,
    marketRequestCount: row.marketRequestCount,
    planCreditCost: row.planCreditCost,
    planRequestCount: row.planRequestCount,
    planTokens: row.planTokens,
    paygSuccessCount: row.paygSuccessCount,
    paygFailureCount: row.paygFailureCount,
    paygSuccessRate: (row.paygSuccessCount + row.paygFailureCount) > 0
      ? row.paygSuccessCount / (row.paygSuccessCount + row.paygFailureCount)
      : null,
    planSuccessCount: row.planSuccessCount,
    planFailureCount: row.planFailureCount,
    planSuccessRate: (row.planSuccessCount + row.planFailureCount) > 0
      ? row.planSuccessCount / (row.planSuccessCount + row.planFailureCount)
      : null,
    paygInputTokens: row.paygInputTokens,
    paygOutputTokens: row.paygOutputTokens,
    paygCacheTokens: row.paygCacheTokens,
    planInputTokens: row.planInputTokens,
    planOutputTokens: row.planOutputTokens,
    planCacheTokens: row.planCacheTokens,
    planRealCostNano: row.planEstimatedNano,
    planRealCostUnavailable: row.planEstimatedPending > 0,
    planEstimatedPendingCount: row.planEstimatedPending,
    exactTokenRequestCount: row.exactTokenRequestCount,
    unavailableTokenRequestCount: row.unavailableTokenRequestCount,
    avgDurationMs: row.durationSampleCount > 0 ? row.durationSumMs / row.durationSampleCount : null,
    hasMultipleSourceCurrencies,
    settlementCurrency: "CNY" as const,
    sourceCurrencies,
  };
}

/* ==================== 趋势（当前周期零填充） ==================== */

interface TrendRow extends Record<string, unknown> {
  bucketStartUtc: string;
}

function loadTrend(db: DeepaaDatabase, input: DashboardQueryInput): DashboardQueryResult["trend"] {
  const where = `bucket_start_utc >= ? AND bucket_start_utc < ? AND ${MODEL_SCOPE_PREDICATE}`;
  const rows = db.prepare(`SELECT bucket_start_utc AS bucketStartUtc, ${TREND_SELECT}
    FROM analytics_hourly_facts WHERE ${where}
    GROUP BY bucket_start_utc ORDER BY bucket_start_utc ASC`).all(input.start, input.end) as TrendRow[];
  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  const dayMode = input.granularity === "day";
  const localDay = dayMode ? localDayKeyFactory(input.timezone) : undefined;
  const bucketMs = (dayMode ? DAY_MS : HOUR_MS) * input.bucketStep;
  const firstDayMs = dayMode ? parseLocalDayKey(localDay!(startMs)).getTime() : 0;

  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  if (!dayMode) {
    const bucketMs = input.bucketStep * HOUR_MS;
    for (let ms = startMs; ms < endMs; ms += bucketMs) {
      keyIndex.set(new Date(ms).toISOString(), keys.length);
      keys.push(new Date(ms).toISOString());
    }
  } else {
    const firstKey = localDay!(startMs);
    const lastKey = localDay!(endMs - 1);
    let cursor = parseLocalDayKey(firstKey);
    const endCursor = parseLocalDayKey(lastKey);
    while (cursor <= endCursor) {
      const key = formatLocalDayKey(cursor);
      keyIndex.set(key, keys.length);
      keys.push(key);
      cursor = new Date(cursor.getTime() + input.bucketStep * DAY_MS);
    }
  }

  const buckets: DashboardTrendBucket[] = keys.map((key, index) => ({
    start: key,
    end: dayMode
      ? new Date(parseLocalDayKey(key).getTime() + input.bucketStep * DAY_MS).toISOString()
      : new Date(startMs + (index + 1) * bucketMs).toISOString(),
    requestCount: 0, successCount: 0, failureCount: 0,
    inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0,
    paygCostNano: 0, actualCostNano: 0, marketCostNano: 0, planCreditCost: 0,
    planEstimatedNano: 0, planRequestCount: 0, planTokens: 0,
  }));
  for (const row of rows) {
    const index = dayMode
      ? Math.floor((parseLocalDayKey(localDay!(Date.parse(row.bucketStartUtc))).getTime() - firstDayMs) / (input.bucketStep * DAY_MS))
      : Math.floor((Date.parse(row.bucketStartUtc) - startMs) / bucketMs);
    if (index < 0 || index >= buckets.length) continue;
    const bucket = buckets[index];
    bucket.requestCount += Number(row.requestCount ?? 0);
    bucket.successCount += Number(row.successCount ?? 0);
    bucket.failureCount += Number(row.failureCount ?? 0);
    bucket.inputTokens += Number(row.inputTokens ?? 0);
    bucket.outputTokens += Number(row.outputTokens ?? 0);
    bucket.cacheTokens += Number(row.cacheTokens ?? 0);
    bucket.totalTokens += Number(row.totalTokens ?? 0);
    bucket.paygCostNano += Number(row.paygCostNano ?? 0);
    bucket.actualCostNano += Number(row.actualCostNano ?? 0);
    bucket.marketCostNano += Number(row.marketCostNano ?? 0);
    bucket.planCreditCost += Number(row.planCreditCost ?? 0);
    bucket.planEstimatedNano += Number(row.planEstimatedNano ?? 0);
    bucket.planRequestCount += Number(row.planRequestCount ?? 0);
    bucket.planTokens += Number(row.planTokens ?? 0);
  }

  return {
    granularity: input.granularity,
    bucketCount: buckets.length,
    buckets,
    candidateBuckets: rows.length,
    processedBuckets: rows.length,
  };
}

/* ==================== 模型维度趋势 ==================== */

async function loadModelTrend(db: DeepaaDatabase, input: DashboardQueryInput, limit: number): Promise<DashboardQueryResult["models"]> {
  const where = `bucket_start_utc >= ? AND bucket_start_utc < ? AND ${MODEL_SCOPE_PREDICATE}`;
  const topSize = Math.min(TOP_MODELS, limit);
  const ranked = db.prepare(`SELECT COALESCE(model, 'unknown') AS model,
    SUM(request_count) AS requestCount, SUM(total_tokens) AS totalTokens,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN vendor_cost_nano ELSE 0 END) AS paygCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN actual_cost_nano ELSE 0 END) AS actualCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END) AS marketCostNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_nano ELSE 0 END), 0) AS planEstimatedNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_pending_request_count ELSE 0 END), 0) AS planEstimatedPending
    FROM analytics_hourly_facts WHERE ${where}
    GROUP BY COALESCE(model, 'unknown')
    ORDER BY (SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN vendor_cost_nano ELSE 0 END) + SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END)) DESC, model ASC
    LIMIT ?`).all(input.start, input.end, topSize + 1) as Array<{
      model: string; requestCount: number; totalTokens: number; paygCostNano: number; actualCostNano: number; marketCostNano: number;
      planEstimatedNano: number; planEstimatedPending: number;
    }>;
  const candidateCount = ranked.length > topSize
    ? Number((db.prepare(`SELECT COUNT(DISTINCT COALESCE(model, 'unknown')) AS count
        FROM analytics_hourly_facts WHERE ${where}`).get(input.start, input.end) as {count: number}).count)
    : ranked.length;
  const top = ranked.slice(0, topSize);
  const otherRows = ranked.slice(topSize);
  const otherModelCount = Math.max(0, candidateCount - top.length);

  const names = top.map(row => row.model);
  if (otherRows.length > 0) names.push("__other__");
  const seriesMap = new Map<string, number[]>(names.map(name => [name, new Array(input.bucketCount).fill(0)]));
  const dayMode = input.granularity === "day";
  const localDay = dayMode ? localDayKeyFactory(input.timezone) : undefined;
  const startMs = Date.parse(input.start);
  const firstDayMs = dayMode ? parseLocalDayKey(localDay!(startMs)).getTime() : 0;
  const bucketMs = (dayMode ? DAY_MS : HOUR_MS) * input.bucketStep;

  if (names.length > 0) {
    const placeholders = names.map(() => "?").join(",");
    const seriesRows = db.prepare(`SELECT bucket_start_utc AS bucketStartUtc, COALESCE(model, 'unknown') AS model,
      SUM(total_tokens) AS totalTokens
      FROM analytics_hourly_facts
      WHERE bucket_start_utc >= ? AND bucket_start_utc < ? AND ${MODEL_SCOPE_PREDICATE}
        AND COALESCE(model, 'unknown') IN (${placeholders})
      GROUP BY bucket_start_utc, COALESCE(model, 'unknown')`).all(input.start, input.end, ...names) as Array<{
        bucketStartUtc: string; model: string; totalTokens: number;
      }>;
    const others = new Set(otherRows.map(row => row.model));
    for (const row of seriesRows) {
      const rowMs = Date.parse(row.bucketStartUtc);
      const bucketIndex = dayMode
        ? Math.floor((parseLocalDayKey(localDay!(rowMs)).getTime() - firstDayMs) / bucketMs)
        : Math.floor((rowMs - startMs) / bucketMs);
      if (bucketIndex < 0 || bucketIndex >= input.bucketCount) continue;
      const name = others.has(row.model) ? "__other__" : row.model;
      const series = seriesMap.get(name);
      if (series) series[bucketIndex] += Number(row.totalTokens ?? 0);
    }
  }

  const items: DashboardModelTrend[] = top.map(row => ({
    model: row.model,
    requestCount: row.requestCount,
    totalTokens: row.totalTokens,
    paygCostNano: row.paygCostNano,
    actualCostNano: row.actualCostNano,
    marketCostNano: row.marketCostNano,
    planEstimatedNano: row.planEstimatedNano,
    planEstimatedPending: row.planEstimatedPending,
    /* 估算真实成本（2026-09-29）：按量实付 + 套餐成本估算，与 KPI 金额卡/排行榜同口径。 */
    totalCostNano: row.actualCostNano + row.planEstimatedNano,
    series: seriesMap.get(row.model)!,
  }));
  if (otherRows.length > 0) {
    const tokens = otherRows.reduce((acc, row) => acc + row.totalTokens, 0);
    const requests = otherRows.reduce((acc, row) => acc + row.requestCount, 0);
    const payg = otherRows.reduce((acc, row) => acc + row.paygCostNano, 0);
    const actual = otherRows.reduce((acc, row) => acc + row.actualCostNano, 0);
    const market = otherRows.reduce((acc, row) => acc + row.marketCostNano, 0);
    const planEstimated = otherRows.reduce((acc, row) => acc + row.planEstimatedNano, 0);
    const planPending = otherRows.reduce((acc, row) => acc + row.planEstimatedPending, 0);
    items.push({
      model: `其他 ${otherModelCount} 个`,
      requestCount: requests,
      totalTokens: tokens,
      paygCostNano: payg,
      actualCostNano: actual,
      marketCostNano: market,
      planEstimatedNano: planEstimated,
      planEstimatedPending: planPending,
      totalCostNano: actual + planEstimated,
      series: seriesMap.get("__other__")!,
    });
  }
  return {
    items,
    otherModelCount,
    candidateCount,
    processedCount: items.length,
    limited: candidateCount > items.length,
    hasMore: candidateCount > items.length,
  };
}

/* ==================== 供应商 / Agent ==================== */

async function loadVendorStats(db: DeepaaDatabase, whereSql: string, args: Array<string>, limit: number, targetInfos: Map<string, TargetInfo>): Promise<DashboardQueryResult["vendors"]> {
  // 供应商维度 = 供应商管理页维护的真实目标（target_id）；vendor_family 只作展示徽标，
  // 不再作为分组主体（价格中心 vendor 会把 gpt 系列误聚成 "openai" 这类供应商族名）。
  // 缺失 target_id 的历史账本行按价格中心 vendor 聚成“旧数据”桶，不与真实供应商混排。
  const groupKeyExpr = `CASE WHEN target_id IS NOT NULL AND target_id != ''
    THEN 'target:' || target_id
    ELSE 'legacy:' || COALESCE(NULLIF(NULLIF(vendor_family, 'unknown'), ''), NULLIF(NULLIF(vendor, 'unknown'), ''), 'unknown') END`;
  const rows = db.prepare(`SELECT ${groupKeyExpr} AS groupKey,
    COALESCE(MAX(NULLIF(vendor_family, 'unknown')), 'unknown') AS vendorFamily,
    SUM(request_count) AS requestCount, SUM(total_tokens) AS totalTokens,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN vendor_cost_nano ELSE 0 END) AS paygCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN actual_cost_nano ELSE 0 END) AS actualCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END) AS marketCostNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_nano ELSE 0 END), 0) AS planEstimatedNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_pending_request_count ELSE 0 END), 0) AS planEstimatedPending,
    SUM(success_count) AS successCount, SUM(error_count + incomplete_count) AS failureCount,
    SUM(duration_sum_ms) AS durationSumMs, SUM(duration_sample_count) AS durationSampleCount
    FROM analytics_hourly_facts WHERE ${whereSql}
    GROUP BY ${groupKeyExpr}
    ORDER BY SUM(total_tokens) DESC, groupKey ASC
    LIMIT ?`).all(...args, limit) as Array<{
      groupKey: string; vendorFamily: string; requestCount: number; totalTokens: number; paygCostNano: number; actualCostNano: number; marketCostNano: number;
      planEstimatedNano: number; planEstimatedPending: number;
      successCount: number; failureCount: number; durationSumMs: number; durationSampleCount: number;
    }>;
  return rows.map(row => {
    const audited = row.successCount + row.failureCount;
    const targetId = row.groupKey.startsWith("target:")
      ? row.groupKey.slice("target:".length)
      : null;
    const isTarget = targetId !== null;
    // legacy 桶的展示名取自分组键里的价格中心 vendor（vendor_family 列在该桶内可能为 NULL）。
    const legacyVendor = targetId === null ? (row.groupKey.slice("legacy:".length) || "unknown") : null;
    return {
      targetId,
      name: isTarget ? (targetInfos.get(targetId)?.name ?? targetId) : legacyVendor!,
      legacy: !isTarget,
      vendorFamily: isTarget ? row.vendorFamily : legacyVendor!,
      requestCount: row.requestCount,
      totalTokens: row.totalTokens,
      paygCostNano: row.paygCostNano,
      actualCostNano: row.actualCostNano,
      marketCostNano: row.marketCostNano,
      planEstimatedNano: row.planEstimatedNano,
      planEstimatedPending: row.planEstimatedPending,
      successCount: row.successCount,
      failureCount: row.failureCount,
      successRate: audited > 0 ? row.successCount / audited : null,
      avgDurationMs: row.durationSampleCount > 0 ? row.durationSumMs / row.durationSampleCount : null,
    };
  });
}

function loadAgentStats(db: DeepaaDatabase, whereSql: string, args: Array<string>, limit: number): DashboardQueryResult["agents"] {
  return db.prepare(`SELECT COALESCE(agent_id, 'unknown') AS agent,
    SUM(request_count) AS requestCount, SUM(total_tokens) AS totalTokens,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN vendor_cost_nano ELSE 0 END) AS paygCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN actual_cost_nano ELSE 0 END) AS actualCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END) AS marketCostNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_nano ELSE 0 END), 0) AS planEstimatedNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_pending_request_count ELSE 0 END), 0) AS planEstimatedPending
    FROM analytics_hourly_facts WHERE ${whereSql}
    GROUP BY COALESCE(agent_id, 'unknown')
    ORDER BY SUM(total_tokens) DESC, agent ASC
    LIMIT ?`).all(...args, limit) as DashboardQueryResult["agents"];
}

/* ==================== 套餐 / 订阅通道 ==================== */

async function loadPlanChannelBreakdown(db: DeepaaDatabase, whereSql: string, args: Array<string>, input: DashboardQueryInput, targetInfos: Map<string, TargetInfo>): Promise<DashboardQueryResult["plans"]> {
  const rows = db.prepare(`SELECT target_id,
    COALESCE(MAX(CASE WHEN billing_channel IN ('plan','subscription') THEN billing_channel END), 'plan') AS channel,
    COALESCE(MAX(NULLIF(vendor_family, 'unknown')), 'unknown') AS vendorFamily,
    SUM(request_count) AS requestCount, SUM(total_tokens) AS totalTokens,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END) AS marketCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_credit_cost ELSE 0 END) AS creditCost,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_nano ELSE 0 END), 0) AS planEstimatedNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_pending_request_count ELSE 0 END), 0) AS planEstimatedPending,
    MAX(CASE WHEN plan_credit_unit NOT IN ('not_applicable', 'unknown') THEN plan_credit_unit END) AS creditUnit
    FROM analytics_hourly_facts
    WHERE ${whereSql} AND billing_channel IN ('plan', 'subscription')
    GROUP BY target_id
    ORDER BY SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END) DESC, target_id ASC
    LIMIT ?`).all(...args, Math.min(input.limit ?? MAX_BREAKDOWN, MAX_BREAKDOWN)) as Array<{
      target_id: string; channel: string; vendorFamily: string; requestCount: number; totalTokens: number;
      marketCostNano: number; creditCost: number; planEstimatedNano: number; planEstimatedPending: number; creditUnit: string | null;
    }>;
  if (rows.length === 0) return [];

  const modelRows = db.prepare(`SELECT target_id, COALESCE(model, 'unknown') AS model,
    SUM(total_tokens) AS totalTokens
    FROM analytics_hourly_facts
    WHERE ${whereSql} AND billing_channel IN ('plan', 'subscription')
    GROUP BY target_id, COALESCE(model, 'unknown')
    ORDER BY SUM(total_tokens) DESC
    LIMIT 200`).all(...args) as Array<{target_id: string; model: string; totalTokens: number}>;
  const topModels = new Map<string, string[]>();
  for (const row of modelRows) {
    const list = topModels.get(row.target_id) ?? [];
    if (list.length < 2) list.push(row.model);
    topModels.set(row.target_id, list);
  }

  return rows.map(row => {
    /* 套餐成本估算：读入账冻结聚合值（2026-09-15），与 summary 同口径。 */
    return {
      targetId: row.target_id,
      name: targetInfos.get(row.target_id)?.name ?? row.target_id,
      channel: row.channel,
      vendorFamily: row.vendorFamily,
      models: topModels.get(row.target_id) ?? [],
      requestCount: row.requestCount,
      totalTokens: row.totalTokens,
      marketCostNano: row.marketCostNano,
      creditCost: row.creditCost,
      creditUnit: row.creditUnit,
      planRealCostNano: row.planEstimatedNano,
      planEstimatedPending: row.planEstimatedPending > 0,
    };
  });
}

/** 有界读取 proxy-config.json 的目标显示名与套餐月费（共享模块委托）。 */
function readTargetInfos(dataDir?: string): Promise<Map<string, TargetInfo>> {
  return readPlanTargetInfos(dataDir);
}

/* ==================== Token 成本排行榜（每百万 Token 估算成本） ==================== */

async function loadCostLeaderboard(
  db: DeepaaDatabase,
  whereSql: string,
  args: Array<string>,
  targetInfos: Map<string, TargetInfo>,
): Promise<DashboardQueryResult["costLeaderboard"]> {
  interface GroupRow {
    targetId: string;
    model: string;
    requestCount: number;
    totalTokens: number;
    actualCostNano: number;
    marketCostNano: number;
    creditCost: number;
    planCredits: number;
    planEstimatedNano: number;
    planEstimatedPending: number;
    channelCount: number;
    channelSample: string;
  }
  /* 空 target_id 与 vendors 同口径归一为 unknown（legacy 旧数据桶）。
     排行榜是 Token 价格页「按目标+模型聚合」的仪表盘对应视图：请求/Token/金额整行
     都采用消费口径，保证「每百万 Token 估算成本」与该页 breakdown 默认值可比。 */
  const targetKeyExpr = `CASE WHEN target_id IS NOT NULL AND target_id != '' THEN target_id ELSE 'unknown' END`;
  const scanned = db.prepare(`SELECT ${targetKeyExpr} AS targetId, COALESCE(model, 'unknown') AS model,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN request_count ELSE 0 END) AS requestCount,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN total_tokens ELSE 0 END) AS totalTokens,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN actual_cost_nano ELSE 0 END) AS actualCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN reference_cost_nano ELSE 0 END) AS marketCostNano,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN COALESCE(plan_credit_cost, 0) ELSE 0 END) AS creditCost,
    SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} AND billing_channel IN ('plan','subscription') THEN COALESCE(plan_credit_cost, 0) ELSE 0 END) AS planCredits,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_nano ELSE 0 END), 0) AS planEstimatedNano,
    COALESCE(SUM(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN plan_estimated_pending_request_count ELSE 0 END), 0) AS planEstimatedPending,
    COUNT(DISTINCT CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN billing_channel END) AS channelCount,
    COALESCE(MAX(CASE WHEN ${CONSUMPTION_RESULT_SCOPE} THEN NULLIF(billing_channel, 'unknown') END), 'unknown') AS channelSample
    FROM analytics_hourly_facts WHERE ${whereSql}
    GROUP BY ${targetKeyExpr}, COALESCE(model, 'unknown')
    LIMIT ${COST_LEADERBOARD_SCAN + 1}`).all(...args) as GroupRow[];
  const truncated = scanned.length > COST_LEADERBOARD_SCAN;
  const groups = truncated ? scanned.slice(0, COST_LEADERBOARD_SCAN) : scanned;
  const candidateCount = truncated
    ? Number((db.prepare(`SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM analytics_hourly_facts WHERE ${whereSql}
        GROUP BY ${targetKeyExpr}, COALESCE(model, 'unknown'))`).get(...args) as {count: number}).count)
    : groups.length;

  const rows: DashboardCostLeaderboardRow[] = groups.map(group => {
    const knownTarget = group.targetId !== "unknown";
    /* 套餐部分：读入账冻结估算聚合（2026-09-15），pending 仅作部分估算标注。 */
    const planReal = group.planEstimatedNano;
    const realCost = group.actualCostNano + planReal;
    const costPerMillion = group.totalTokens > 0
      ? Math.round((realCost / group.totalTokens) * 1e6)
      : null;
    return {
      targetId: group.targetId,
      targetName: knownTarget ? (targetInfos.get(group.targetId)?.name ?? group.targetId) : "旧数据",
      model: group.model,
      channel: group.channelCount > 1 ? "mixed" : group.channelSample,
      requestCount: group.requestCount,
      totalTokens: group.totalTokens,
      actualCostNano: group.actualCostNano,
      marketCostNano: group.marketCostNano,
      creditCost: group.creditCost,
      planRealCostNano: planReal,
      planEstimatedPending: group.planEstimatedPending > 0,
      realCostNano: realCost,
      costPerMillionNano: costPerMillion,
    };
  });
  /* 排序：每百万成本降序；不可估（null）与零 Token 行排最后，按 Token 量稳定排序。 */
  rows.sort((left, right) => {
    if (left.costPerMillionNano !== null && right.costPerMillionNano !== null && left.costPerMillionNano !== right.costPerMillionNano) {
      return right.costPerMillionNano - left.costPerMillionNano;
    }
    if (left.costPerMillionNano === null && right.costPerMillionNano !== null) return 1;
    if (right.costPerMillionNano === null && left.costPerMillionNano !== null) return -1;
    if (left.totalTokens !== right.totalTokens) return right.totalTokens - left.totalTokens;
    return left.targetId.localeCompare(right.targetId) || left.model.localeCompare(right.model);
  });
  return {
    rows: rows.slice(0, COST_LEADERBOARD_ROWS),
    candidateCount,
    processedCount: groups.length,
    limited: truncated || candidateCount > COST_LEADERBOARD_ROWS,
  };
}

/* ==================== 热力图（固定最近 7 个本地日） ==================== */

function loadHeatmap(db: DeepaaDatabase, input: DashboardQueryInput): DashboardQueryResult["heatmap"] {
  const nowMs = input.now !== undefined ? Date.parse(input.now) : Date.now();
  const localDay = localDayKeyFactory(input.timezone);
  const localDateHour = localDateHourFactory(input.timezone);
  const windowStartMs = nowMs - HEATMAP_DAYS * DAY_MS;
  const rows = db.prepare(`SELECT bucket_start_utc AS bucketStartUtc, SUM(total_tokens) AS totalTokens
    FROM analytics_hourly_facts
    WHERE bucket_start_utc >= ? AND bucket_start_utc < ? AND ${MODEL_SCOPE_PREDICATE}
    GROUP BY bucket_start_utc`).all(new Date(windowStartMs).toISOString(), new Date(nowMs).toISOString()) as Array<{bucketStartUtc: string; totalTokens: number}>;
  const values = new Map<string, number[]>();
  for (let dayOffset = HEATMAP_DAYS - 1; dayOffset >= 0; dayOffset -= 1) {
    values.set(localDay(nowMs - dayOffset * DAY_MS), new Array(24).fill(0));
  }
  for (const row of rows) {
    const bucketMs = Date.parse(row.bucketStartUtc);
    const local = localDateHour(bucketMs);
    const key = local.date;
    const dayValues = values.get(key);
    if (!dayValues) continue;
    dayValues[local.hour] += Number(row.totalTokens ?? 0);
  }
  const days = [...values.entries()].map(([date, dayValues]) => ({
    date,
    weekday: parseLocalDayKey(date).getUTCDay(),
    values: dayValues,
    total: dayValues.reduce((acc, value) => acc + value, 0),
  }));
  return {days};
}

/* ==================== 新鲜度 ==================== */

function loadFreshness(db: DeepaaDatabase): DashboardQueryResult["freshness"] {
  const state = db.prepare("SELECT rollup_watermark_at AS rollupWatermarkAt, last_ledger_created_at AS ledgerLatestAt FROM analytics_worker_state WHERE id = 1").get() as {rollupWatermarkAt?: string; ledgerLatestAt?: string} | undefined;
  const stale = Number((db.prepare("SELECT COUNT(*) AS count FROM analytics_dirty_buckets WHERE status <> 'completed'").get() as {count: number}).count);
  const latest = state?.ledgerLatestAt ? Date.parse(state.ledgerLatestAt) : Number.NaN;
  const watermark = state?.rollupWatermarkAt ? Date.parse(state.rollupWatermarkAt) : Number.NaN;
  return {
    asOf: Number.isFinite(watermark) ? new Date(watermark).toISOString() : null,
    lagSeconds: Number.isFinite(latest) && Number.isFinite(watermark) ? Math.max(0, Math.floor((latest - watermark) / 1000)) : null,
    staleBuckets: stale,
  };
}

/* ==================== 本地日键工具 ==================== */

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const dateHourFormatters = new Map<string, Intl.DateTimeFormat>();

function localDayKeyFactory(timezone: string): (ms: number) => string {
  let formatter = dayKeyFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"});
    dayKeyFormatters.set(timezone, formatter);
  }
  return (ms: number) => formatter.format(new Date(ms));
}

/** 直接按所选时区返回本地日期和 0-23 小时，避免把本地日期键当成 UTC 午夜。 */
function localDateHourFactory(timezone: string): (ms: number) => {date: string; hour: number} {
  let formatter = dateHourFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    dateHourFormatters.set(timezone, formatter);
  }
  return (ms: number) => {
    const parts = formatter!.formatToParts(new Date(ms));
    const values = new Map(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return {
      date: `${values.get("year")}-${values.get("month")}-${values.get("day")}`,
      hour: Math.min(23, Math.max(0, Number(values.get("hour") ?? "0"))),
    };
  };
}

/** "YYYY-MM-DD" -> UTC midnight of that calendar date（仅用于键排序与间隔推进）。 */
function parseLocalDayKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatLocalDayKey(cursor: Date): string {
  const year = cursor.getUTCFullYear();
  const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
  const day = String(cursor.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
