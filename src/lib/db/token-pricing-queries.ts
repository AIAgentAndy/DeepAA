import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { agentDisplayName } from "../agent-display";
import type {
  TokenPricingBreakdown,
  TokenPricingFacetLimits,
  TokenPricingOption,
  TokenPricingSummary,
} from "../token-pricing";
import type { TokenPricingHierarchySelection } from "../shared-selection";
import {
  LEDGER_ACTUAL_COST_EXPR,
  LEDGER_VENDOR_COST_EXPR,
  ledgerRequestCountExpr,
  ledgerTokenExpr,
} from "./ledger-cost-exprs";

const DEFAULT_LIMIT = 10;
const HARD_LIMIT = 100;
const FACET_LIMIT = 100;
const BREAKDOWN_LIMIT = 1_000;
const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1_000;

/** 金额表达式唯一事实来源在 ledger-cost-exprs.ts：Token 价格页与仪表盘 facts 物化共用同一份，
 * 禁止再各自内联副本（2026-09-16 对齐倍率前/倍率后口径）。 */
const ESTIMATED_COST_EXPR = LEDGER_ACTUAL_COST_EXPR;
const VENDOR_COST_EXPR = LEDGER_VENDOR_COST_EXPR;

/** 计费通道谓词：NULL/''/unknown 旧行归按量；plan/subscription 归套餐口径（与仪表盘一致）。 */
const IS_PLAN_CHANNEL_EXPR = `COALESCE(u.billing_channel, '') IN ('plan', 'subscription')`;

export interface TokenPricingLedgerRow {
  exchangeId: string;
  /** model=正常模型请求；reconciliation=对账补差行（只计金额）。 */
  requestKind?: string;
  /** 计费通道（pay_as_you_go/plan/subscription）；旧行缺省按按量展示。 */
  billingChannel?: string;
  /** 请求结果分类：success/failure/cancelled/incomplete/reconciled；结果筛选与列展示共用。 */
  resultClass?: string;
  /** Agent 侧业务值（如 Codex/Claude 原生会话、线程、Turn 标识）；无则缺省。 */
  externalSessionId?: string;
  externalThreadId?: string;
  externalTurnId?: string;
  /** 原生 Step 键（如 dsh session:step:N）；多数 Agent 无。 */
  externalStepId?: string;
  agentSessionId: string | null;
  agentThreadId: string | null;
  agentTurnId?: string;
  agentStepId?: string;
  targetId: string;
  agentFingerprintId: string;
  agentName: string;
  model: string;
  vendor: string;
  rateMultiplier: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  vendorCost: number;
  actualCost: number;
  /** 人民币物化金额与入账冻结结算系数（2026-09-23 明细行人民币口径）：原币种 × fx。 */
  vendorCostCny?: number;
  actualCostCny?: number;
  fxRateToCny: number;
  currency?: string;
  durationMs: number;
  firstTokenMs?: number;
  usageSource: string;
  usageConfidence: string;
  pricingSnapshotJson: string;
  createdAt: string;
  responseStatus?: number;
  diagnosticCodes?: string[];
  scheduleLabel?: string;
  timezone?: string;
  planCreditCost?: number;
  planCreditUnit?: string;
  /** 入账冻结的套餐成本估算（2026-09-15）。 */
  planEstimatedCost?: number;
  planEstimatedCurrency?: string;
  planEstimatedFx?: number;
  planEstimatedCostNano?: number;
  planEstimatedStatus?: string;
  /** 估算来源（v49）：formula=派生期公式/守卫；quota_delta=额度差分回填（近似）。 */
  planEstimatedMethod?: string;
  planEstimateDetailJson?: string;
}

export interface TokenPricingSqliteResult {
  rows: TokenPricingLedgerRow[];
  summary: TokenPricingSummary;
  breakdown: TokenPricingBreakdown[];
  breakdownCandidateCount: number;
  breakdownProcessedCount: number;
  breakdownLimited: boolean;
  total: number;
  candidateCount: number;
  processedCount: number;
  limit: number;
  start: string;
  end: string;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  facets: {
    targets: TokenPricingOption[];
    agents: TokenPricingOption[];
    sessions: TokenPricingOption[];
    threads: TokenPricingOption[];
    turns: TokenPricingOption[];
    steps: TokenPricingOption[];
    models: TokenPricingOption[];
    vendors: TokenPricingOption[];
    schedules: TokenPricingOption[];
  };
  facetLimits: TokenPricingFacetLimits;
  resolvedSelection?: TokenPricingHierarchySelection;
}

interface QueryContext {
  selection: TokenPricingHierarchySelection;
  selectionRequested: boolean;
  selectionValid: boolean;
  hasExplicitDateRange: boolean;
  start: string;
  end: string;
  /** 供应商（target_id）多选（2026-10-10）：逗号分隔解析、大小写不敏感；空数组=不过滤。 */
  targets: string[];
  agent?: string;
  model?: string;
  vendor?: string;
  schedule?: string;
  includeAuxiliary: boolean;
  /** 估算待补筛选（2026-10-09 #5 徽标跳转；2026-10-10 增排除）：
   *  "1"=仅待补（plan_estimated_status='unavailable'）；"exclude"=排除待补（其余行，含按量 NULL）。 */
  estimatePending: "1" | "exclude" | undefined;
  channel?: string;
  /**
   * 请求结果多选（逗号分隔 token）：success / failure / cancelled / incomplete / reconciled；
   * "all" = 全量不过滤；缺省 = 默认口径「成功+已取消+补差」（= 站点已计费口径）。
   */
  result: string;
  tokenComponent?: string;
}

interface LedgerRow {
  exchange_id: string;
  agent_session_id: string | null;
  agent_thread_id: string | null;
  agent_turn_id: string | null;
  agent_step_id: string | null;
  target_id: string;
  agent_fingerprint_id: string;
  agent_name: string;
  model: string;
  vendor: string;
  rate_multiplier: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  vendor_cost: number;
  actual_cost: number;
  vendor_cost_cny?: number | null;
  actual_cost_cny?: number | null;
  fx_rate_to_cny?: number | null;
  currency?: string | null;
  duration_ms: number;
  first_token_ms?: number | null;
  usage_source: string;
  usage_confidence: string;
  pricing_snapshot_json: string;
  created_at: string;
  response_status?: number | null;
  diagnostic_codes_json?: string | null;
  external_session_id?: string | null;
  external_conversation_id?: string | null;
  external_thread_id?: string | null;
  native_turn_id?: string | null;
  native_step_id?: string | null;
  schedule_label?: string | null;
  schedule_timezone?: string | null;
  plan_credit_cost?: number | null;
  plan_credit_unit?: string | null;
  plan_estimated_cost?: number | null;
  plan_estimated_currency?: string | null;
  plan_estimated_fx?: number | null;
  plan_estimated_cost_nano?: number | null;
  plan_estimated_status?: string | null;
  plan_estimated_method?: string | null;
  plan_estimate_detail_json?: string | null;
  request_kind?: string | null;
  result_class?: string | null;
  billing_channel?: string | null;
}

interface SummaryRow {
  request_count: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  vendor_cost: number;
  actual_cost: number;
  payg_vendor_cost: number;
  payg_actual_cost: number;
  plan_market_cost: number;
  plan_credits: number;
  duration_total_ms: number;
  duration_sample_count: number;
  median_duration_ms: number;
  plan_credit_cost: number;
  plan_credit_unit: string | null;
  plan_estimated_nano: number;
  plan_estimated_pending: number;
}

interface BreakdownRow {
  target_id: string;
  model: string;
  request_count: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  vendor_cost: number;
  actual_cost: number;
  plan_request_count: number;
  duration_total_ms: number;
  duration_sample_count: number;
  median_duration_ms: number | null;
  candidate_count: number;
  schedule_label: string | null;
  plan_credit_cost: number;
  plan_credit_unit: string | null;
  plan_estimated_nano: number;
  plan_estimated_pending: number;
}

interface PathRow {
  session_id: string;
  thread_id: string;
  turn_id: string | null;
  step_id: string | null;
  exchange_id: string | null;
  start_time: string;
  end_time: string;
}

interface FacetRow {
  value: string;
  label_value?: string | null;
  vendor?: string | null;
  item_count?: number | null;
  step_index?: number | null;
}

interface CursorPayload {
  v: 1;
  createdAt: string;
  exchangeId: string;
}

export function queryTokenPricingSqlite(
  db: DeepaaDatabase,
  filters: URLSearchParams,
  now = new Date(),
): TokenPricingSqliteResult {
  const context = resolveQueryContext(db, filters, now);
  const limit = normalizeLimit(filters.get("limit"));
  const cursor = decodeCursor(filters.get("cursor") || undefined);
  const base = buildLedgerWhere(context);
  const summaryRow = db.prepare(
    `SELECT
       SUM(${ledgerRequestCountExpr()}) AS request_count,
       COALESCE(SUM(${ledgerTokenExpr("input_tokens")}), 0) AS input_tokens,
       COALESCE(SUM(${ledgerTokenExpr("cache_read_tokens")}), 0) AS cache_read_tokens,
       COALESCE(SUM(${ledgerTokenExpr("cache_write_tokens")}), 0) AS cache_write_tokens,
       COALESCE(SUM(${ledgerTokenExpr("output_tokens")}), 0) AS output_tokens,
       COALESCE(SUM(${VENDOR_COST_EXPR}), 0) AS vendor_cost,
       COALESCE(SUM(${ESTIMATED_COST_EXPR}), 0) AS actual_cost,
       COALESCE(SUM(CASE WHEN NOT ${IS_PLAN_CHANNEL_EXPR} THEN ${VENDOR_COST_EXPR} ELSE 0 END), 0) AS payg_vendor_cost,
       COALESCE(SUM(CASE WHEN NOT ${IS_PLAN_CHANNEL_EXPR} THEN ${ESTIMATED_COST_EXPR} ELSE 0 END), 0) AS payg_actual_cost,
       COALESCE(SUM(CASE WHEN ${IS_PLAN_CHANNEL_EXPR} THEN ${VENDOR_COST_EXPR} ELSE 0 END), 0) AS plan_market_cost,
       COALESCE(SUM(CASE WHEN ${IS_PLAN_CHANNEL_EXPR} THEN COALESCE(u.plan_credit_cost, 0) ELSE 0 END), 0) AS plan_credits,
       COALESCE(SUM(u.plan_credit_cost), 0) AS plan_credit_cost,
       MAX(u.plan_credit_unit) AS plan_credit_unit,
       COALESCE(SUM(CASE WHEN ${IS_PLAN_CHANNEL_EXPR} THEN COALESCE(u.plan_estimated_cost_nano, 0) ELSE 0 END), 0) AS plan_estimated_nano,
       COALESCE(SUM(CASE WHEN u.plan_estimated_status = 'unavailable'
         OR (u.plan_estimated_status IS NULL AND ${IS_PLAN_CHANNEL_EXPR}
           AND (COALESCE(u.plan_credit_cost, 0) > 0 OR COALESCE(u.reference_cost_nano, 0) > 0))
         THEN 1 ELSE 0 END), 0) AS plan_estimated_pending,
       COALESCE(SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END), 0)
         AS duration_total_ms,
       COALESCE(SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END), 0)
         AS duration_sample_count,
       COALESCE((
         SELECT AVG(duration_ms) FROM (
           SELECT duration_ms,
             ROW_NUMBER() OVER (ORDER BY duration_ms) AS row_num,
             COUNT(*) OVER () AS total_count
           FROM usage_ledger u2
           ${whereSql([...base.where.map(clause => clause.replaceAll("u.", "u2.")), "u2.duration_ms > 0"])}
         )
         WHERE row_num IN ((total_count + 1) / 2, (total_count + 2) / 2)
       ), 0) AS median_duration_ms
     FROM usage_ledger u
     ${whereSql(base.where)}`,
  ).get(...base.params, ...base.params) as SummaryRow;
  const breakdownRows = db.prepare(
    `SELECT
       target_id,
       model,
       u.schedule_label AS schedule_label,
       SUM(${ledgerRequestCountExpr()}) AS request_count,
       COALESCE(SUM(${ledgerTokenExpr("input_tokens")}), 0) AS input_tokens,
       COALESCE(SUM(${ledgerTokenExpr("cache_read_tokens")}), 0) AS cache_read_tokens,
       COALESCE(SUM(${ledgerTokenExpr("cache_write_tokens")}), 0) AS cache_write_tokens,
       COALESCE(SUM(${ledgerTokenExpr("output_tokens")}), 0) AS output_tokens,
       COALESCE(SUM(${VENDOR_COST_EXPR}), 0) AS vendor_cost,
       COALESCE(SUM(${ESTIMATED_COST_EXPR}), 0) AS actual_cost,
       SUM(CASE WHEN ${IS_PLAN_CHANNEL_EXPR} THEN 1 ELSE 0 END) AS plan_request_count,
       COALESCE(SUM(u.plan_credit_cost), 0) AS plan_credit_cost,
       MAX(u.plan_credit_unit) AS plan_credit_unit,
       COALESCE(SUM(CASE WHEN ${IS_PLAN_CHANNEL_EXPR} THEN COALESCE(u.plan_estimated_cost_nano, 0) ELSE 0 END), 0) AS plan_estimated_nano,
       COALESCE(SUM(CASE WHEN u.plan_estimated_status = 'unavailable'
         OR (u.plan_estimated_status IS NULL AND ${IS_PLAN_CHANNEL_EXPR}
           AND (COALESCE(u.plan_credit_cost, 0) > 0 OR COALESCE(u.reference_cost_nano, 0) > 0))
         THEN 1 ELSE 0 END), 0) AS plan_estimated_pending,
       COALESCE(SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END), 0)
         AS duration_total_ms,
       COALESCE(SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END), 0)
         AS duration_sample_count,
       AVG(CASE WHEN duration_ms > 0
         AND row_num IN ((valid_count + 1) / 2, (valid_count + 2) / 2)
         THEN duration_ms END) AS median_duration_ms,
       COUNT(*) OVER() AS candidate_count
     FROM (
       SELECT u.*,
         json_extract(u.pricing_snapshot_json, '$.scheduleLabel') AS schedule_label,
         ROW_NUMBER() OVER (
           PARTITION BY u.target_id, u.model,
             json_extract(u.pricing_snapshot_json, '$.scheduleLabel')
           ORDER BY CASE WHEN u.duration_ms > 0 THEN 1 ELSE 0 END DESC, u.duration_ms
         ) AS row_num,
         COUNT(*) OVER (
           PARTITION BY u.target_id, u.model,
             json_extract(u.pricing_snapshot_json, '$.scheduleLabel')
         ) AS total_count,
         SUM(CASE WHEN u.duration_ms > 0 THEN 1 ELSE 0 END)
           OVER (
             PARTITION BY u.target_id, u.model,
               json_extract(u.pricing_snapshot_json, '$.scheduleLabel')
           ) AS valid_count
       FROM usage_ledger u
       ${whereSql(base.where)}
     ) u
     GROUP BY u.target_id, u.model, u.schedule_label
     ORDER BY request_count DESC, u.target_id ASC, u.model ASC, u.schedule_label ASC
     LIMIT ?`,
  ).all(...base.params, BREAKDOWN_LIMIT + 1) as BreakdownRow[];
  const breakdownLimited = breakdownRows.length > BREAKDOWN_LIMIT;
  const breakdownPage = breakdownRows.slice(0, BREAKDOWN_LIMIT);
  const pageWhere = [...base.where];
  const pageParams = [...base.params];
  if (cursor) {
    pageWhere.push(
      "(u.created_at < ? OR (u.created_at = ? AND u.exchange_id < ?))",
    );
    pageParams.push(cursor.createdAt, cursor.createdAt, cursor.exchangeId);
  }
  const pageRows = db.prepare(
    `SELECT u.*,
       json_extract(u.pricing_snapshot_json, '$.scheduleLabel') AS schedule_label,
       json_extract(u.pricing_snapshot_json, '$.timezone') AS schedule_timezone,
       r.status AS response_status, r.diagnostic_codes_json,
       ses.external_session_id AS external_session_id,
       ses.external_conversation_id AS external_conversation_id,
       thr.external_thread_id AS external_thread_id,
       tn.native_turn_id AS native_turn_id,
       st.native_step_id AS native_step_id
     FROM usage_ledger u
     LEFT JOIN raw_exchange_refs r ON r.exchange_id = u.exchange_id
     LEFT JOIN agent_sessions ses ON ses.id = u.agent_session_id
     LEFT JOIN agent_threads thr ON thr.id = u.agent_thread_id
     LEFT JOIN agent_turns tn ON tn.id = u.agent_turn_id
     LEFT JOIN agent_steps st ON st.id = u.agent_step_id
     ${whereSql(pageWhere)}
     ORDER BY u.created_at DESC, u.exchange_id DESC
     LIMIT ?`,
  ).all(...pageParams, limit + 1) as LedgerRow[];
  // 历史账本 vendor 可能已固化为 unknown；按最新策略里的供应商偏好做只读展示兜底，不改写账本。
  const {targetVendorById, modelVendorByTarget} = loadTargetVendorPreferences(db);
  const rows = pageRows.slice(0, limit).map(row => ({
    ...row,
    vendor: row.vendor === "unknown"
      ? modelVendorByTarget.get(row.target_id)?.get(row.model) ?? targetVendorById.get(row.target_id) ?? row.vendor
      : row.vendor,
  })).map(mapLedgerRow);
  const hasMore = pageRows.length > limit;
  const nextCursor = hasMore && rows.length > 0
    ? encodeCursor(rows.at(-1)!)
    : undefined;
  const facets = loadFacets(db, context);
  const durationSampleCount = summaryRow.duration_sample_count;
  const inputBase = summaryRow.input_tokens + summaryRow.cache_read_tokens;

  return {
    rows,
    summary: {
      requestCount: summaryRow.request_count,
      inputTokens: summaryRow.input_tokens,
      cacheReadTokens: summaryRow.cache_read_tokens,
      cacheCreationTokens: summaryRow.cache_write_tokens,
      outputTokens: summaryRow.output_tokens,
      cacheHitRate: inputBase > 0 ? summaryRow.cache_read_tokens / inputBase : 0,
      vendorCost: summaryRow.vendor_cost,
      actualCost: summaryRow.actual_cost,
      paygVendorCost: summaryRow.payg_vendor_cost,
      paygActualCost: summaryRow.payg_actual_cost,
      planMarketCost: summaryRow.plan_market_cost,
      planCredits: summaryRow.plan_credits,
      averageDurationSeconds: durationSampleCount > 0
        ? summaryRow.duration_total_ms / durationSampleCount / 1_000
        : undefined,
      medianDurationSeconds: summaryRow.median_duration_ms > 0
        ? summaryRow.median_duration_ms / 1_000
        : undefined,
      durationSampleCount,
      ...(summaryRow.plan_credit_cost > 0 ? {planCreditCost: summaryRow.plan_credit_cost} : {}),
      ...(summaryRow.plan_credit_unit ? {planCreditUnit: summaryRow.plan_credit_unit} : {}),
      /* 套餐成本估算：读入账冻结聚合（2026-09-15），不再读时现算。 */
      planRealCost: summaryRow.plan_estimated_nano / 1e9,
      planRealCostUnavailable: summaryRow.plan_estimated_pending > 0,
      planEstimatedPendingCount: summaryRow.plan_estimated_pending,
    },
    breakdown: breakdownPage.map(mapBreakdownRow),
    breakdownCandidateCount: breakdownRows[0]?.candidate_count || 0,
    breakdownProcessedCount: breakdownRows.length,
    breakdownLimited,
    total: summaryRow.request_count,
    candidateCount: summaryRow.request_count,
    processedCount: rows.length,
    limit,
    start: context.start,
    end: context.end,
    cursor: filters.get("cursor") || undefined,
    nextCursor,
    hasMore,
    facets: facets.values,
    facetLimits: facets.limited,
    resolvedSelection: context.selectionValid && context.selectionRequested
      ? context.selection
      : undefined,
  };
}

function mapBreakdownRow(row: BreakdownRow): TokenPricingBreakdown {
  const totalTokens = row.input_tokens
    + row.cache_read_tokens
    + row.cache_write_tokens
    + row.output_tokens;
  const inputBase = row.input_tokens + row.cache_read_tokens;
  return {
    targetId: row.target_id,
    model: row.model,
    requestCount: row.request_count,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    cacheHitRate: inputBase > 0 ? row.cache_read_tokens / inputBase : 0,
    vendorCost: row.vendor_cost,
    actualCost: row.actual_cost,
    planRequestCount: row.plan_request_count,
    averageDurationSeconds: row.duration_sample_count > 0
      ? row.duration_total_ms / row.duration_sample_count / 1_000
      : undefined,
      medianDurationSeconds: row.median_duration_ms !== null && row.median_duration_ms > 0
        ? row.median_duration_ms / 1_000
        : undefined,
    durationSampleCount: row.duration_sample_count,
    totalTokens,
    actualCostPerMillionTokens: totalTokens > 0
      ? row.actual_cost / totalTokens * 1_000_000
      : undefined,
    ...(row.schedule_label ? {scheduleLabel: row.schedule_label} : {}),
    ...(row.plan_credit_cost > 0 ? {planCreditCost: row.plan_credit_cost} : {}),
    ...(row.plan_credit_unit ? {planCreditUnit: row.plan_credit_unit} : {}),
    /* 套餐成本估算：读入账冻结聚合（2026-09-15），不再读时现算；纯按量组不带套餐估算。 */
    ...(row.plan_request_count > 0 ? {planRealCost: row.plan_estimated_nano / 1e9} : {}),
    ...(row.plan_request_count > 0 ? {planRealCostUnavailable: row.plan_estimated_pending > 0} : {}),
    ...(row.plan_request_count > 0 ? {planEstimatedPendingCount: row.plan_estimated_pending} : {}),
    ...(row.plan_request_count > 0 && row.plan_estimated_pending === 0 && totalTokens > 0
      ? {realCostPerMillionTokens: row.plan_estimated_nano / 1e9 / totalTokens * 1_000_000}
      : {}),
  };
}

function resolveQueryContext(
  db: DeepaaDatabase,
  filters: URLSearchParams,
  now: Date,
): QueryContext {
  const requested = {
    session: normalized(filters.get("session")),
    thread: normalized(filters.get("thread")),
    turn: normalized(filters.get("turn")),
    step: normalized(filters.get("step")),
  };
  const selectionRequested = Object.values(requested).some(Boolean);
  const path = resolvePath(db, requested);
  const selection: TokenPricingHierarchySelection = path
    ? {
        session: path.session_id,
        thread: path.thread_id,
        turn: path.turn_id ?? "",
        step: requested.step && path.step_id ? path.step_id : "",
      }
    : { session: "", thread: "", turn: "", step: "" };
  const explicitStart = normalizeIso(filters.get("start"));
  const explicitEnd = normalizeIso(filters.get("end"));
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const defaultStart = new Date(nowMs - DEFAULT_RANGE_MS).toISOString();
  const defaultEnd = new Date(nowMs).toISOString();
  return {
    selection,
    selectionRequested,
    selectionValid: !selectionRequested || path !== undefined,
    hasExplicitDateRange: explicitStart !== undefined || explicitEnd !== undefined,
    targets: splitCommaValues(filters.get("target")),
    agent: normalized(filters.get("agent")),
    model: normalized(filters.get("model")),
    vendor: normalized(filters.get("vendor")),
    schedule: normalized(filters.get("schedule")),
    includeAuxiliary: filters.get("includeAuxiliary") === "yes",
    estimatePending: normalizePendingFilter(filters.get("pending")),
    channel: normalized(filters.get("channel")),
    result: normalizeResultFilter(filters.get("result")),
    tokenComponent: normalized(filters.get("tokenComponent")),
    start: explicitStart || (path?.start_time ?? defaultStart),
    end: explicitEnd || (path?.end_time ?? defaultEnd),
  };
}

function resolvePath(
  db: DeepaaDatabase,
  requested: TokenPricingHierarchySelection,
): PathRow | undefined {
  if (requested.step) {
    return db.prepare(
      `SELECT st.agent_session_id AS session_id,
         st.agent_thread_id AS thread_id, st.agent_turn_id AS turn_id,
         st.id AS step_id, st.exchange_id, st.timestamp AS start_time,
         st.timestamp AS end_time
       FROM agent_steps st WHERE st.id = ? OR st.exchange_id = ?
       ORDER BY CASE WHEN st.id = ? THEN 0 ELSE 1 END LIMIT 1`,
    ).get(requested.step, requested.step, requested.step) as PathRow | undefined;
  }
  if (requested.turn) {
    return db.prepare(
      `SELECT agent_session_id AS session_id, agent_thread_id AS thread_id,
         id AS turn_id, NULL AS step_id, NULL AS exchange_id, start_time, end_time
       FROM agent_turns WHERE id = ? LIMIT 1`,
    ).get(requested.turn) as PathRow | undefined;
  }
  if (requested.thread) {
    return db.prepare(
      `SELECT agent_session_id AS session_id, id AS thread_id,
         NULL AS turn_id, NULL AS step_id, NULL AS exchange_id, start_time, end_time
       FROM agent_threads WHERE id = ? LIMIT 1`,
    ).get(requested.thread) as PathRow | undefined;
  }
  if (requested.session) {
    return db.prepare(
      `SELECT id AS session_id, '' AS thread_id,
         NULL AS turn_id, NULL AS step_id, NULL AS exchange_id, start_time, end_time
       FROM agent_sessions WHERE id = ? LIMIT 1`,
    ).get(requested.session) as PathRow | undefined;
  }
  return undefined;
}

function buildLedgerWhere(context: QueryContext): {
  where: string[];
  params: unknown[];
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (context.selection.step) {
    // step 级深链不带显式时间范围时，默认窗口坍缩为 step 时刻（start=end）；
    // 补差行 created_at 挂的是站点完成时刻，天然晚于本地请求时刻，会被零宽窗滤掉。
    // 挂靠本 step 的补差行因此豁免时间窗，保证「原始记录深链同时看到原行与补差行」；
    // 普通行及其它（非 step）查询的时间窗语义完全不变。
    where.push(
      `((u.created_at >= ? AND u.created_at <= ?) OR (u.request_kind = 'reconciliation' AND EXISTS(
        SELECT 1 FROM relay_reconciliation_matches m
        JOIN usage_ledger o ON o.exchange_id = m.exchange_id
        WHERE m.adjustment_exchange_id = u.exchange_id AND o.agent_step_id = ?)))`,
    );
    params.push(context.start, context.end, context.selection.step);
  } else {
    where.push("u.created_at >= ?", "u.created_at <= ?");
    params.push(context.start, context.end);
  }
  if (!context.selectionValid) where.push("1 = 0");
  addCaseInsensitiveIn(where, params, "u.target_id", context.targets);
  addCaseInsensitiveExact(where, params, "u.agent_name", context.agent);
  if (context.schedule) {
    where.push("json_extract(u.pricing_snapshot_json, '$.scheduleLabel') = ?");
    params.push(context.schedule);
  }
  addExact(where, params, "u.agent_session_id", context.selection.session);
  if (context.selection.thread) {
    where.push(
      `u.agent_thread_id IN (
        SELECT tc.descendant_thread_id FROM thread_closure tc
        WHERE tc.ancestor_thread_id = ?
      )`,
    );
    params.push(context.selection.thread);
  }
  addExact(where, params, "u.agent_turn_id", context.selection.turn);
  if (context.selection.step) {
    // step 级筛选同时命中挂靠该 Step 原始请求的补差行（request_kind=reconciliation
    // 的 agent_step_id 恒 NULL）；经 relay_reconciliation_matches.adjustment_exchange_id
    // 回原行精确判定，不做任何时间/归属近似。索引：idx_relay_reconciliation_matches_adjustment
    // + usage_ledger 主键 + idx_usage_step。
    where.push(
      `(u.agent_step_id = ? OR (u.request_kind = 'reconciliation' AND EXISTS(
        SELECT 1 FROM relay_reconciliation_matches m
        JOIN usage_ledger o ON o.exchange_id = m.exchange_id
        WHERE m.adjustment_exchange_id = u.exchange_id AND o.agent_step_id = ?)))`,
    );
    params.push(context.selection.step, context.selection.step);
  }
  if (context.model) {
    // 模型筛选为精确匹配：glm-5.3 不应命中 glm-5.3-flash 等共享前缀模型。
    where.push("LOWER(u.model) = ?");
    params.push(context.model.toLowerCase());
  }
  if (context.vendor) {
    where.push("INSTR(LOWER(u.vendor), ?) > 0");
    params.push(context.vendor.toLowerCase());
  }
  if (context.channel) {
    const channels = context.channel
      .split(",")
      .map(item => item.trim().toLowerCase())
      .filter(channel => ["pay_as_you_go", "plan", "subscription"].includes(channel));
    if (channels.length > 0) {
      // 旧行通道为 NULL，按量口径与小时事实聚合保持一致（NULL 归入按量）。
      const includesPayg = channels.includes("pay_as_you_go");
      const literals = [
        ...(includesPayg ? ["pay_as_you_go"] : []),
        ...channels.filter(channel => channel !== "pay_as_you_go"),
      ];
      where.push(`COALESCE(u.billing_channel, 'pay_as_you_go') IN (${literals.map(() => "?").join(", ")})`);
      params.push(...literals);
    }
  }
  if (context.result !== "all") {
    // 多选结果过滤："all" 全量不过滤；其余按 token 展开为 result_class 集合。
    const classes: string[] = [...new Set(context.result.split(",")
      .flatMap(token => RESULT_TOKEN_CLASSES[token] ?? []))];
    if (classes.length > 0) {
      addCaseInsensitiveExactList(where, params, "u.result_class", classes);
    }
  }
  // 补差行（request_kind=reconciliation）始终参与金额；请求/Token 计数走聚合共享表达式
  // 的取代语义（2026-09-29 用户确认）：用量载体补差行计入，被取代原行排他，
  // 纯金额更正行仍零请求零 Token。
  // Token 构成多选：逗号 token 展开为 OR 组合（任一选中构成有用量即命中）。
  if (context.tokenComponent) {
    const components = new Set(context.tokenComponent
      .split(",")
      .map(item => item.trim().toLowerCase())
      .filter(item => ["input", "output", "cache"].includes(item)));
    const clauses = [
      components.has("input") ? "u.input_tokens > 0" : null,
      components.has("output") ? "u.output_tokens > 0" : null,
      components.has("cache") ? "(u.cache_read_tokens + u.cache_write_tokens) > 0" : null,
    ].filter(Boolean);
    if (clauses.length > 0) where.push(`(${clauses.join(" OR ")})`);
  }
  if (!context.includeAuxiliary) {
    // 默认不展示辅助/未识别请求：unknown 模型在账本中均为辅助、探测或未识别行，费用恒为 0。
    where.push("u.model <> 'unknown'");
  }
  if (context.estimatePending === "1") {
    // 估算待补筛选（2026-10-09 #5 徽标跳转）：只看套餐/订阅通道待补行；
    // 按量行 plan_estimated_status 为 NULL，天然排除，无需通道条件。
    where.push("u.plan_estimated_status = 'unavailable'");
  } else if (context.estimatePending === "exclude") {
    // 排除待补（2026-10-10）：待补行不展示；按量行 status 为 NULL，保留。
    where.push("(u.plan_estimated_status IS NULL OR u.plan_estimated_status <> 'unavailable')");
  }
  return { where, params };
}

function loadFacets(
  db: DeepaaDatabase,
  context: QueryContext,
): {
  values: TokenPricingSqliteResult["facets"];
  limited: TokenPricingFacetLimits;
} {
  const timeParams = [context.start, context.end];
  const useGlobalTargetFacet = context.selectionRequested && !context.hasExplicitDateRange;
  const targetFacetSql = useGlobalTargetFacet
    ? `SELECT target_id AS value, target_id AS label_value
       FROM usage_ledger
       GROUP BY target_id
       ORDER BY MAX(created_at) DESC, target_id ASC`
    : `SELECT target_id AS value, target_id AS label_value
       FROM usage_ledger
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY target_id
       ORDER BY MAX(created_at) DESC, target_id ASC`;
  const targetFacetParams = useGlobalTargetFacet ? [] : [context.start, context.end];
  const targets = loadFacet(
    db,
    targetFacetSql,
    targetFacetParams,
    context.targets,
    "SELECT target_id AS value, target_id AS label_value FROM usage_ledger WHERE target_id = ? LIMIT 1",
    simpleOption,
  );
  const agents = loadFacet(
    db,
    `SELECT agent_name AS value, agent_name AS label_value
     FROM usage_ledger
     WHERE created_at >= ? AND created_at <= ?
     GROUP BY agent_name
     ORDER BY MAX(created_at) DESC, agent_name ASC`,
    timeParams,
    context.agent ? [context.agent] : [],
    "SELECT agent_name AS value, agent_name AS label_value FROM usage_ledger WHERE agent_name = ? LIMIT 1",
    (row) => ({ value: row.value, label: agentDisplayName(row.value) }),
  );

  const sessionWhere = ["1 = 1"];
  const sessionParams: unknown[] = [];
  addCaseInsensitiveIn(sessionWhere, sessionParams, "target_id", context.targets);
  addCaseInsensitiveExact(sessionWhere, sessionParams, "agent_name", context.agent);
  const sessions = loadFacet(
    db,
    `SELECT id AS value, COALESCE(external_session_id, id) AS label_value,
       request_count AS item_count
     FROM agent_sessions ${whereSql(sessionWhere)}
     ORDER BY end_time DESC, id DESC`,
    sessionParams,
    context.selection.session ? [context.selection.session] : [],
    `SELECT id AS value, COALESCE(external_session_id, id) AS label_value,
       request_count AS item_count FROM agent_sessions WHERE id = ? LIMIT 1`,
    sessionOption,
  );
  const threads = context.selection.session
    ? loadFacet(
        db,
        `SELECT id AS value, display_name AS label_value,
           request_count AS item_count
         FROM agent_threads WHERE agent_session_id = ?
         ORDER BY end_time DESC, id DESC`,
        [context.selection.session],
        context.selection.thread ? [context.selection.thread] : [],
        `SELECT id AS value, display_name AS label_value,
           request_count AS item_count FROM agent_threads WHERE id = ? LIMIT 1`,
        threadOption,
      )
    : emptyFacet();
  const turns = context.selection.thread
    ? loadFacet(
        db,
        `SELECT id AS value, id AS label_value, step_count AS item_count
         FROM agent_turns WHERE agent_thread_id = ?
         ORDER BY end_time DESC, id DESC`,
        [context.selection.thread],
        context.selection.turn ? [context.selection.turn] : [],
        `SELECT id AS value, id AS label_value, step_count AS item_count
         FROM agent_turns WHERE id = ? LIMIT 1`,
        turnOption,
      )
    : emptyFacet();
  const steps = context.selection.turn
    ? loadFacet(
        db,
        `SELECT id AS value, id AS label_value,
           step_index
         FROM agent_steps WHERE agent_turn_id = ?
         ORDER BY step_index DESC, id DESC`,
        [context.selection.turn],
        context.selection.step ? [context.selection.step] : [],
        `SELECT id AS value, id AS label_value,
           step_index FROM agent_steps WHERE id = ? LIMIT 1`,
        stepOption,
      )
    : emptyFacet();

  const nonCatalogContext = {
    ...context,
    model: "",
    vendor: "",
  };
  const ledger = buildLedgerWhere(nonCatalogContext);
  const models = loadFacet(
    db,
    `SELECT model AS value, model AS label_value, vendor
     FROM usage_ledger u ${whereSql(ledger.where)}
     GROUP BY model, vendor
     ORDER BY MAX(created_at) DESC, model ASC`,
    ledger.params,
    context.model ? [context.model] : [],
    "SELECT model AS value, model AS label_value, vendor FROM usage_ledger WHERE model = ? LIMIT 1",
    modelOption,
  );
  const vendors = loadFacet(
    db,
    `SELECT vendor AS value, vendor AS label_value
     FROM usage_ledger u ${whereSql(ledger.where)}
     GROUP BY vendor
     ORDER BY MAX(created_at) DESC, vendor ASC`,
    ledger.params,
    context.vendor ? [context.vendor] : [],
    "SELECT vendor AS value, vendor AS label_value FROM usage_ledger WHERE vendor = ? LIMIT 1",
    simpleOption,
  );
  const schedules = loadFacet(
    db,
    `SELECT json_extract(pricing_snapshot_json, '$.scheduleLabel') AS value,
            json_extract(pricing_snapshot_json, '$.scheduleLabel') AS label_value
     FROM usage_ledger
     WHERE created_at >= ? AND created_at <= ?
       AND json_extract(pricing_snapshot_json, '$.scheduleLabel') IS NOT NULL
     GROUP BY value
     ORDER BY value ASC`,
    timeParams,
    context.schedule ? [context.schedule] : [],
    `SELECT json_extract(pricing_snapshot_json, '$.scheduleLabel') AS value,
            json_extract(pricing_snapshot_json, '$.scheduleLabel') AS label_value
     FROM usage_ledger
     WHERE json_extract(pricing_snapshot_json, '$.scheduleLabel') = ?
     LIMIT 1`,
    simpleOption,
  );

  return {
    values: {
      targets: targets.items,
      agents: agents.items,
      sessions: sessions.items,
      threads: threads.items,
      turns: turns.items,
      steps: steps.items,
      models: models.items,
      vendors: vendors.items,
      schedules: schedules.items,
    },
    limited: {
      targets: targets.limited,
      agents: agents.limited,
      sessions: sessions.limited,
      threads: threads.limited,
      turns: turns.limited,
      steps: steps.limited,
      models: models.limited,
      vendors: vendors.limited,
      schedules: schedules.limited,
    },
  };
}

interface FacetResult {
  items: TokenPricingOption[];
  limited: boolean;
}

function loadFacet(
  db: DeepaaDatabase,
  sql: string,
  params: unknown[],
  selected: string[],
  exactSql: string,
  map: (row: FacetRow) => TokenPricingOption,
): FacetResult {
  const rows = db.prepare(`${sql}\nLIMIT ?`).all(...params, FACET_LIMIT + 1) as FacetRow[];
  const page = rows.slice(0, FACET_LIMIT);
  const selectedRows = selected
    .map((value) => page.find((row) => row.value === value)
      ?? db.prepare(exactSql).get(value) as FacetRow | undefined)
    .filter((row): row is FacetRow => row !== undefined);
  const selectedIds = new Set(selectedRows.map((row) => row.value));
  const rest = page.filter((row) => !selectedIds.has(row.value));
  return {
    items: [...selectedRows, ...rest].slice(0, FACET_LIMIT).map(map),
    limited: rows.length > FACET_LIMIT,
  };
}

function emptyFacet(): FacetResult {
  return { items: [], limited: false };
}

function simpleOption(row: FacetRow): TokenPricingOption {
  return { value: row.value, label: row.label_value || row.value };
}

function sessionOption(row: FacetRow): TokenPricingOption {
  return {
    value: row.value,
    label: `${row.label_value || shortId(row.value)} · ${shortId(row.value)} · ${row.item_count ?? 0} 请求`,
  };
}

function threadOption(row: FacetRow): TokenPricingOption {
  return {
    value: row.value,
    label: `${row.label_value || "Thread"} · ${shortId(row.value)} · ${row.item_count ?? 0} 请求`,
  };
}

function turnOption(row: FacetRow): TokenPricingOption {
  return {
    value: row.value,
    label: `${shortId(row.value)} · ${row.item_count ?? 0} Step`,
  };
}

function stepOption(row: FacetRow): TokenPricingOption {
  return {
    value: row.value,
    label: `步骤 ${row.step_index ?? "?"} · ${shortId(row.value)}`,
  };
}

function modelOption(row: FacetRow): TokenPricingOption {
  return {
    value: row.value,
    label: row.vendor ? `${row.value} · ${row.vendor}` : row.value,
    vendor: row.vendor ?? undefined,
  };
}

function mapLedgerRow(row: LedgerRow): TokenPricingLedgerRow {
  return {
    exchangeId: row.exchange_id,
    requestKind: row.request_kind ?? undefined,
    resultClass: row.result_class ?? undefined,
    externalSessionId: row.external_session_id ?? row.external_conversation_id ?? undefined,
    externalThreadId: row.external_thread_id ?? undefined,
    externalTurnId: row.native_turn_id ?? undefined,
    externalStepId: row.native_step_id ?? undefined,
    agentSessionId: row.agent_session_id,
    agentThreadId: row.agent_thread_id,
    agentTurnId: row.agent_turn_id ?? undefined,
    agentStepId: row.agent_step_id ?? undefined,
    targetId: row.target_id,
    agentFingerprintId: row.agent_fingerprint_id,
    agentName: row.agent_name,
    model: row.model,
    vendor: row.vendor,
    rateMultiplier: row.rate_multiplier,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    vendorCost: row.vendor_cost,
    actualCost: row.actual_cost,
    ...(row.vendor_cost_cny !== null && row.vendor_cost_cny !== undefined
      ? {vendorCostCny: row.vendor_cost_cny}
      : {}),
    ...(row.actual_cost_cny !== null && row.actual_cost_cny !== undefined
      ? {actualCostCny: row.actual_cost_cny}
      : {}),
    fxRateToCny: row.fx_rate_to_cny ?? 1,
    ...(row.currency ? {currency: row.currency} : {}),
    durationMs: row.duration_ms,
    ...(row.first_token_ms !== null && row.first_token_ms !== undefined
      ? {firstTokenMs: row.first_token_ms}
      : {}),
    usageSource: row.usage_source,
    usageConfidence: row.usage_confidence,
    pricingSnapshotJson: row.pricing_snapshot_json,
    createdAt: row.created_at,
    responseStatus: row.response_status === null || row.response_status === undefined
      ? undefined
      : row.response_status,
    diagnosticCodes: parseDiagnosticCodes(row.diagnostic_codes_json),
    ...(row.billing_channel ? {billingChannel: row.billing_channel} : {}),
    ...(row.schedule_label ? {scheduleLabel: row.schedule_label} : {}),
    ...(row.schedule_timezone ? {timezone: row.schedule_timezone} : {}),
    ...(row.plan_credit_cost !== null && row.plan_credit_cost !== undefined
      ? {planCreditCost: row.plan_credit_cost}
      : {}),
    ...(row.plan_credit_unit ? {planCreditUnit: row.plan_credit_unit} : {}),
    ...(row.plan_estimated_cost !== null && row.plan_estimated_cost !== undefined
      ? {planEstimatedCost: row.plan_estimated_cost}
      : {}),
    ...(row.plan_estimated_currency ? {planEstimatedCurrency: row.plan_estimated_currency} : {}),
    ...(row.plan_estimated_fx !== null && row.plan_estimated_fx !== undefined
      ? {planEstimatedFx: row.plan_estimated_fx}
      : {}),
    ...(row.plan_estimated_cost_nano !== null && row.plan_estimated_cost_nano !== undefined
      ? {planEstimatedCostNano: row.plan_estimated_cost_nano}
      : {}),
    ...(row.plan_estimated_status ? {planEstimatedStatus: row.plan_estimated_status} : {}),
    ...(row.plan_estimated_method ? {planEstimatedMethod: row.plan_estimated_method} : {}),
    ...(row.plan_estimate_detail_json ? {planEstimateDetailJson: row.plan_estimate_detail_json} : {}),
  };
}

function parseDiagnosticCodes(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((code): code is string => typeof code === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从最新价格策略读取供应商兜底展示数据：
 * targetId → 供应商偏好，以及 targetId + 模型 → 价格中心条目映射供应商。
 * 只用于 unknown 供应商的只读展示兜底，不改写账本。
 */
function loadTargetVendorPreferences(db: DeepaaDatabase): {
  targetVendorById: Map<string, string>;
  modelVendorByTarget: Map<string, Map<string, string>>;
} {
  const policyJson = db.prepare(
    `SELECT b.config_json
     FROM pricing_policy_blobs b
     JOIN pricing_config_revisions r ON r.policy_hash = b.hash
     ORDER BY r.effective_at DESC, r.id DESC
     LIMIT 1`,
  ).pluck().get() as string | undefined;
  if (!policyJson) return {targetVendorById: new Map(), modelVendorByTarget: new Map()};
  try {
    const parsed = JSON.parse(policyJson) as {
      targetVendorPreferences?: Record<string, string>;
      targetModelMappings?: Record<string, Record<string, {vendor?: string; priceEntryId?: string}>>;
    };
    const targetVendorById = new Map(Object.entries(parsed.targetVendorPreferences || {}));
    const modelVendorByTarget = new Map<string, Map<string, string>>();
    for (const [targetId, models] of Object.entries(parsed.targetModelMappings || {})) {
      const modelVendors = new Map<string, string>();
      for (const [modelId, mapping] of Object.entries(models)) {
        if (mapping?.vendor) modelVendors.set(modelId, mapping.vendor);
      }
      if (modelVendors.size > 0) modelVendorByTarget.set(targetId, modelVendors);
    }
    return {targetVendorById, modelVendorByTarget};
  } catch {
    return {targetVendorById: new Map(), modelVendorByTarget: new Map()};
  }
}

function encodeCursor(row: TokenPricingLedgerRow): string {
  const payload: CursorPayload = {
    v: 1,
    createdAt: row.createdAt,
    exchangeId: row.exchangeId,
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function decodeCursor(value: string | undefined): CursorPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf-8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.v !== 1
      || typeof parsed.createdAt !== "string"
      || typeof parsed.exchangeId !== "string"
    ) return undefined;
    return { v: 1, createdAt: parsed.createdAt, exchangeId: parsed.exchangeId };
  } catch {
    return undefined;
  }
}

function normalizeLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), HARD_LIMIT);
}

function normalizeIso(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function normalized(value: string | null): string {
  return value?.trim() || "";
}

/** 逗号多值解析（trim、去空、大小写不敏感去重，保留首现顺序）：供应商等多选筛选用。 */
function splitCommaValues(value: string | null): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of (value ?? "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(trimmed);
  }
  return values;
}

/** 多值精确匹配（大小写不敏感）：单值退化为 =，多值 IN；空数组不加条件。 */
function addCaseInsensitiveIn(
  where: string[],
  params: unknown[],
  column: string,
  values: readonly string[],
): void {
  if (values.length === 0) return;
  where.push(values.length === 1
    ? `LOWER(${column}) = ?`
    : `LOWER(${column}) IN (${values.map(() => "?").join(",")})`);
  params.push(...values.map(value => value.toLowerCase()));
}

/** 多值精确匹配（大小写不敏感语义与单值一致：此处类名均为小写字面量，直接 IN）。 */
function addCaseInsensitiveExactList(
  where: string[],
  params: unknown[],
  column: string,
  values: readonly string[],
): void {
  where.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

/** 估算待补筛选："1"=仅待补、"exclude"=排除待补；缺省与未知值=全部。 */
function normalizePendingFilter(value: string | null): "1" | "exclude" | undefined {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed === "1" || trimmed === "exclude" ? trimmed : undefined;
}

/** 结果 token → 账本 result_class 集合；失败与不完整各管各的值域，all=显式全选不过滤。 */
const RESULT_TOKEN_CLASSES: Record<string, readonly string[]> = {
  success: ["success"],
  failure: ["client_error", "upstream_error", "proxy_error"],
  cancelled: ["cancelled"],
  incomplete: ["incomplete"],
  reconciled: ["reconciled"],
};

/** 默认口径「成功+已取消+补差」：与中转站消费统计（不含失败、断开已计量计费）对齐。 */
const DEFAULT_RESULT_TOKENS = "success,cancelled,reconciled";

/**
 * 请求结果多选筛选：token 逗号分隔；"all"=显式全选（不加结果过滤）；
 * 缺省与非法值收敛为默认口径「成功+已取消+补差」。
 */
function normalizeResultFilter(value: string | null): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed) return DEFAULT_RESULT_TOKENS;
  if (trimmed === "all") return "all";
  const tokens = [...new Set(trimmed.split(",")
    .map(token => token.trim())
    .filter(token => token in RESULT_TOKEN_CLASSES))];
  return tokens.length > 0 ? tokens.join(",") : DEFAULT_RESULT_TOKENS;
}

function addExact(
  where: string[],
  params: unknown[],
  column: string,
  value: string,
): void {
  if (!value) return;
  where.push(`${column} = ?`);
  params.push(value);
}

function addCaseInsensitiveExact(
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value) return;
  where.push(`LOWER(${column}) = ?`);
  params.push(value.toLowerCase());
}

function whereSql(where: string[]): string {
  return where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
}

function shortId(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
