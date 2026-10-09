import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { agentDisplayName } from "./agent-display";
import {
  queryTokenPricingSqlite,
  type TokenPricingLedgerRow,
} from "./db/token-pricing-queries";
import { resolveLongContextRates } from "./pricing";
import type { LongContextMatchInfo, PricingRates, PricingSnapshot, UsageLedgerEntry } from "./pricing";
import {parsePlanEstimateDetailRecord, type PlanEstimateDetailInput} from "./token-pricing-display";
import type {SharedSelection, TokenPricingHierarchySelection} from "./shared-selection";

export interface TokenPricingOption {
  value: string;
  label: string;
  vendor?: string;
  vendors?: string[];
}

export interface TokenPricingFacets {
  targets: TokenPricingOption[];
  agents: TokenPricingOption[];
  sessions: TokenPricingOption[];
  threads: TokenPricingOption[];
  turns: TokenPricingOption[];
  steps: TokenPricingOption[];
  models: TokenPricingOption[];
  vendors: TokenPricingOption[];
  schedules: TokenPricingOption[];
}

export interface TokenPricingSummary {
  requestCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  vendorCost: number;
  actualCost: number;
  /** 按量通道（含 unknown 旧行）倍率前/倍率后金额；总消费卡「量」行。 */
  paygVendorCost: number;
  paygActualCost: number;
  /** 套餐/订阅通道市价（供应商成本口径）；总消费卡「套」行。 */
  planMarketCost: number;
  /** 套餐/订阅通道积分消耗合计。 */
  planCredits: number;
  /** 套餐成本估算（入账冻结聚合值，2026-09-15）；含未完成估算请求时配合 unavailable 标注。 */
  planRealCost?: number;
  /** 存在套餐消耗但估算缺失（月费/额度不足或旧口径行），总额为部分估算。 */
  planRealCostUnavailable?: boolean;
  /** 待补估算请求数（2026-10-09 徽标收敛）：小字「N 条估算待补」的数据源。 */
  planEstimatedPendingCount?: number;
  averageDurationSeconds?: number;
  medianDurationSeconds?: number;
  durationSampleCount: number;
  /** 套餐积分合计；无套餐折算口径时缺省。 */
  planCreditCost?: number;
  planCreditUnit?: string;
}

export interface TokenPricingBreakdown {
  targetId: string;
  model: string;
  requestCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  vendorCost: number;
  actualCost: number;
  /** 该组内套餐/订阅通道请求数；>0 时按套餐真实成本口径展示消费列。 */
  planRequestCount: number;
  /** 套餐成本估算（入账冻结聚合值，2026-09-15）。 */
  planRealCost?: number;
  /** 组内有套餐消耗但估算缺失（月费/额度不足或旧口径行），总额为部分估算。 */
  planRealCostUnavailable?: boolean;
  /** 待补估算请求数（2026-10-09 徽标收敛）：小字「N 条估算待补」的数据源。 */
  planEstimatedPendingCount?: number;
  /** 估算成本口径的每百万 Token 成本（组内估算完整时存在）。 */
  realCostPerMillionTokens?: number;
  averageDurationSeconds?: number;
  medianDurationSeconds?: number;
  durationSampleCount: number;
  totalTokens: number;
  actualCostPerMillionTokens?: number;
  /** 高峰/闲时维度；仅时段费率模型有值。 */
  scheduleLabel?: string;
  planCreditCost?: number;
  planCreditUnit?: string;
}

export interface TokenPricingItem {
  exchangeId: string;
  requestKind?: string;
  /** 计费通道（pay_as_you_go/plan/subscription）；旧行缺省按按量展示。 */
  billingChannel?: string;
  /** 请求结果分类：success/failure/cancelled/incomplete/reconciled。 */
  resultClass?: string;
  /** 内部 AgentStep.id（列表展示用）。 */
  stepId?: string;
  /** Agent 侧业务值（原生会话/线程/Turn/Step 标识）；无则缺省。 */
  externalSessionId?: string;
  externalThreadId?: string;
  externalTurnId?: string;
  externalStepId?: string;
  targetId: string;
  agentFingerprintId: string;
  agentName: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  model: string;
  vendor: string;
  rateMultiplier: number;
  createdAt: string;
  capturedAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  /** 首字时间（毫秒）：转发开始到首个上游响应 chunk；旧数据缺省。 */
  firstTokenMs?: number;
  hasUsage: boolean;
  usageSource: string;
  usageConfidence: string;
  unpricedReason?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  inputUnitPrice?: number;
  cacheReadUnitPrice?: number;
  cacheWriteUnitPrice?: number;
  outputUnitPrice?: number;
  inputCost?: number;
  cacheReadCost?: number;
  cacheCreationCost?: number;
  outputCost?: number;
  vendorCost?: number;
  actualCost?: number;
  /**
   * 人民币口径金额（2026-09-23 用户确认：明细行与汇总统一人民币展示）。
   * 原币种账本值 × 入账冻结结算系数；vendor_cost=0 的行按快照公式金额 × 系数兜底
   * （与 LEDGER_VENDOR_COST_EXPR 同口径）。原币种值保留在 vendorCost/actualCost
   * 供公式浮窗展示计算过程。
   */
  vendorCostCny?: number;
  actualCostCny?: number;
  fxRateToCny?: number;
  vendorCostFormula?: string;
  actualCostFormula?: string;
  currency: string;
  /** 原始上游响应状态码，来自 raw_exchange_refs 轻量索引；失败/估算行用于展示状态。 */
  responseStatus?: number;
  diagnosticCodes?: string[];
  /** 高峰/闲时维度；仅时段费率模型有值。 */
  scheduleLabel?: string;
  timezone?: string;
  /** 命中的按量促销展示名；仅官方通道促销期内有值。 */
  promotionLabel?: string;
  /** 本单命中的服务档位（fast/priority 请求参数）；未命中时缺省。 */
  serviceTier?: string;
  /** 本单命中的长上下文档位（展示层按派生同规则复算）；未命中时缺省。 */
  longContextTier?: LongContextMatchInfo;
  planCreditCost?: number;
  planCreditUnit?: string;
  /** 套餐积分计算公式（派生时快照）；仅套餐通道请求携带。 */
  planCreditFormula?: string;
  /** 多行实际计算过程（含真实 token 数，\n 分隔）。 */
  planCreditFormulaDetail?: string;
  /** 套餐成本估算（入账时冻结值，2026-09-15）。 */
  planRealCost?: number;
  /** 入账冻结的估算依据（结构化，2026-10-09 B2/B3：note 由客户端按查看者时区现算）。 */
  planEstimateDetail?: PlanEstimateDetailInput;
  /** 入账冻结的人民币 nano（原始依据字段，供备注还原）。 */
  planEstimatedCostNano?: number;
  planEstimatedCurrency?: string;
  planEstimatedFx?: number;
  planEstimatedStatus?: string;
  /** 估算来源（v49）：formula=派生期公式/守卫；quota_delta=额度差分回填（近似）。 */
  planEstimatedMethod?: string;
  planEstimateDetailJson?: string;
  /**
   * 小时对账标注（2026-09-26 用户确认，只读 join、不改账本）：
   * 原始请求行 = matched（站点实扣/差额/置信度）；补差行 = adjustment（指向原始请求）。
   */
  recon?: TokenPricingReconAnnotation;
}

export interface TokenPricingReconAnnotation {
  kind: "matched" | "adjustment";
  /** 归属置信：exact（request ID）/ high（四类真实 Token）/ weak（模型+端点+时间唯一）。 */
  confidence: "exact" | "high" | "weak";
  siteAmountNano: number;
  localAmountNano: number;
  adjustmentNano: number;
  hourStartUtc: string;
  /** 补差行挂账的原始请求；点击经 Step 深链在交互内容页定位。 */
  linkedExchangeId?: string;
  linkedStepId?: string;
  /** 原始请求的六元组业务上下文（补差行「原始记录」新标签深链用）。 */
  linkedSelection?: SharedSelection;
  /** 站点明细明示的折扣节省额（nano）；仅站点声明折扣已应用时存在，无任何推断。 */
  siteDiscountNano?: number;
  /** 折扣声明全额解释了差额（|siteDiscountNano − |adjustmentNano|| ≤ 2 nano）。 */
  discountExplainsDelta?: boolean;
}

/** 折扣归因容差：站点对 actual_cost 与 saved_amount 分别舍入，nano 级允许 ±2。 */
export const RECON_DISCOUNT_MATCH_TOLERANCE_NANO = 2;

export interface TokenPricingState {
  items: TokenPricingItem[];
  summary: TokenPricingSummary;
  breakdown: TokenPricingBreakdown[];
  breakdownCandidateCount: number;
  breakdownProcessedCount: number;
  total: number;
  candidateCount: number;
  limit: number;
  offset: number;
  cursor?: string;
  nextCursor?: string;
  hasMore?: boolean;
  start: string;
  end: string;
  processedCount: number;
  durationHydration: {
    requestedCount: number;
    processedCount: number;
    matchedCount: number;
  };
  facets: TokenPricingFacets;
  resolvedSelection?: TokenPricingHierarchySelection;
  limited: {
    sortWindow: boolean;
    ledgerScan: boolean;
    facets: boolean;
    facetLimits: TokenPricingFacetLimits;
    durationHydration: boolean;
    indexScan: boolean;
    breakdown: boolean;
  };
}

export interface TokenPricingLoadOptions {
  dataDir?: string;
  db?: DeepaaDatabase;
  now?: Date;
  /** 仅保留调用兼容性；SQLite 查询通过 SQL LIMIT 固定限制扫描。 */
  maxLedgerScanLines?: number;
}

export interface TokenPricingFacetLimits {
  targets: boolean;
  agents: boolean;
  sessions: boolean;
  threads: boolean;
  turns: boolean;
  steps: boolean;
  models: boolean;
  vendors: boolean;
  schedules: boolean;
}

interface StoredPricingSnapshot extends Partial<PricingSnapshot> {
  priced?: boolean;
  unpricedReason?: UsageLedgerEntry["unpricedReason"];
  currency?: string;
  /** 派生时实际采用的套餐积分计算逻辑；仅套餐通道请求携带。 */
  planCreditFormula?: string;
  /** 多行实际计算过程（含真实 token 数，\n 分隔）。 */
  planCreditFormulaDetail?: string;
}

/**
 * 明细行套餐估算装饰（2026-09-15 入账冻结）：金额与依据均来自入账时冻结的
 * plan_estimated_* 列与 detail JSON，查询端不再读取汇率/月费/额度现算。
 */
function applyPlanRealCost(
  items: TokenPricingItem[],
): void {
  for (const item of items) {
    if (item.planEstimatedStatus !== "estimated" || item.planEstimatedCostNano === undefined) continue;
    item.planRealCost = item.planEstimatedCostNano / 1e9;
    // 2026-10-09 B2/B3：？公式改由客户端用共享 note 函数现算（查看者时区 +
    // 份额全链路展开），服务端只下发结构化依据；与会话追踪同一实现。
    item.planEstimateDetail = parsePlanEstimateDetailRecord(item.planEstimateDetailJson);
  }
}

/** Token 价格页只查询 SQLite；旧 JSONL 账本不再作为运行时回退。 */
export async function loadTokenPricingState(
  filters: URLSearchParams = new URLSearchParams(),
  options: TokenPricingLoadOptions = {},
): Promise<TokenPricingState> {
  if (!options.db) throw new Error("Token 价格查询必须使用 SQLite 数据库依赖。");
  const result = queryTokenPricingSqlite(options.db, filters, options.now);
  const facetsLimited = Object.values(result.facetLimits).some(Boolean);
  const items = result.rows.map(sqliteLedgerRowToItem);
  applyPlanRealCost(items);
  attachReconciliationAnnotations(options.db, items);
  return {
    items,
    summary: result.summary,
    breakdown: result.breakdown,
    breakdownCandidateCount: result.breakdownCandidateCount,
    breakdownProcessedCount: result.breakdownProcessedCount,
    total: result.total,
    candidateCount: result.candidateCount,
    limit: result.limit,
    offset: 0,
    cursor: result.cursor,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    start: result.start,
    end: result.end,
    processedCount: result.processedCount,
    durationHydration: {
      requestedCount: 0,
      processedCount: 0,
      matchedCount: 0,
    },
    facets: result.facets,
    resolvedSelection: result.resolvedSelection,
    limited: {
      sortWindow: false,
      ledgerScan: false,
      facets: facetsLimited,
      facetLimits: result.facetLimits,
      durationHydration: false,
      indexScan: false,
      breakdown: result.breakdownLimited,
    },
  };
}

/**
 * 为当前页明细行附加小时对账标注：原始行显示「已对账」证据，
 * 补差行标注其挂账的原始请求并可经 Step 深链跳转。
 * 只读 join、只限当前页 exchange ID 集合（IN 列表 ≤ 页大小），不触碰账本。
 */
function attachReconciliationAnnotations(
  db: DeepaaDatabase, items: TokenPricingItem[],
): void {
  if (items.length === 0) return;
  const ids = items.map(item => item.exchangeId);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT exchange_id AS exchangeId, adjustment_exchange_id AS adjustmentExchangeId,
       confidence, site_amount_nano AS siteAmountNano,
       local_amount_nano AS localAmountNano, adjustment_nano AS adjustmentNano,
       site_discount_nano AS siteDiscountNano, hour_start_utc AS hourStartUtc
     FROM relay_reconciliation_matches
     WHERE exchange_id IN (${placeholders}) OR adjustment_exchange_id IN (${placeholders})`,
  ).all(...ids, ...ids) as Array<{
    exchangeId: string; adjustmentExchangeId: string | null;
    confidence: "exact" | "high" | "weak";
    siteAmountNano: number; localAmountNano: number; adjustmentNano: number;
    siteDiscountNano: number | null; hourStartUtc: string;
  }>;
  if (rows.length === 0) return;
  const byOriginal = new Map(rows.map(row => [row.exchangeId, row]));
  const byAdjustment = new Map(rows
    .filter(row => row.adjustmentExchangeId)
    .map(row => [row.adjustmentExchangeId!, row]));
  // 补差行指向的原始请求可能不在当前页；只按链接到的少量 ID 有界解析
  // Step 与六元组业务上下文（新标签深链用），join 账本均为主键/唯一索引命中。
  const linkedIds = [...new Set([...byAdjustment.values()].map(row => row.exchangeId))];
  const linkedPlaceholders = linkedIds.map(() => "?").join(",");
  interface LinkedContext {
    exchangeId: string; stepId: string;
    targetId: string; agentName: string;
    sessionId: string | null; threadId: string | null; turnId: string | null;
  }
  const linkedByExchange = new Map(linkedIds.length > 0
    ? (db.prepare(
      `SELECT s.exchange_id AS exchangeId, s.id AS stepId,
         u.target_id AS targetId, u.agent_name AS agentName,
         u.agent_session_id AS sessionId, u.agent_thread_id AS threadId,
         u.agent_turn_id AS turnId
       FROM agent_steps s JOIN usage_ledger u ON u.exchange_id = s.exchange_id
       WHERE s.exchange_id IN (${linkedPlaceholders})`,
    ).all(...linkedIds) as LinkedContext[])
      .map(row => [row.exchangeId, row])
    : []);
  /** 折扣归因只认站点声明且全额解释差额；比率巧合一律不标注。 */
  const discountExplains = (row: typeof rows[number]): boolean =>
    row.siteDiscountNano !== null && row.siteDiscountNano >= 0
    && Math.abs(row.siteDiscountNano - Math.abs(row.adjustmentNano))
      <= RECON_DISCOUNT_MATCH_TOLERANCE_NANO;
  for (const item of items) {
    const adjustment = byAdjustment.get(item.exchangeId);
    if (adjustment) {
      const linked = linkedByExchange.get(adjustment.exchangeId);
      item.recon = {
        kind: "adjustment", confidence: adjustment.confidence,
        siteAmountNano: adjustment.siteAmountNano,
        localAmountNano: adjustment.localAmountNano,
        adjustmentNano: adjustment.adjustmentNano,
        hourStartUtc: adjustment.hourStartUtc,
        linkedExchangeId: adjustment.exchangeId,
        ...(adjustment.siteDiscountNano !== null
          ? {siteDiscountNano: adjustment.siteDiscountNano} : {}),
        ...(discountExplains(adjustment) ? {discountExplainsDelta: true} : {}),
        ...(linked ? {
          linkedStepId: linked.stepId,
          linkedSelection: {
            target: linked.targetId,
            agent: linked.agentName,
            ...(linked.sessionId ? {session: linked.sessionId} : {}),
            ...(linked.threadId ? {thread: linked.threadId} : {}),
            ...(linked.turnId ? {turn: linked.turnId} : {}),
            step: linked.stepId,
          },
        } : {}),
      };
      continue;
    }
    const matched = byOriginal.get(item.exchangeId);
    if (matched) {
      item.recon = {
        kind: "matched", confidence: matched.confidence,
        siteAmountNano: matched.siteAmountNano,
        localAmountNano: matched.localAmountNano,
        adjustmentNano: matched.adjustmentNano,
        hourStartUtc: matched.hourStartUtc,
        ...(matched.siteDiscountNano !== null
          ? {siteDiscountNano: matched.siteDiscountNano} : {}),
        ...(discountExplains(matched) ? {discountExplainsDelta: true} : {}),
      };
    }
  }
}

/** 价格快照 JSON 只解析当前页；汇总、筛选和 facets 均在 SQL 中完成。 */
function sqliteLedgerRowToItem(row: TokenPricingLedgerRow): TokenPricingItem {
  const snapshot = parseStoredPricingSnapshot(row.pricingSnapshotJson);
  // 展示层按派生同规则复算长上下文档位（2026-09-22 修复：公式/单价此前漏套 ×2/×1.5），
  // 保证计算过程浮窗的分项单价与账本落库金额自洽。
  const longContextTier = snapshot?.baseRates
    ? resolveLongContextRates(
        snapshot.baseRates,
        row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens,
      )
    : undefined;
  const rates = longContextTier?.rates ?? snapshot?.baseRates;
  const hasUsage = row.usageSource !== "unavailable" || [
    row.inputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.outputTokens,
  ].some(value => value > 0);
  const vendorCostFormula = rates && hasUsage
    ? costFormula(row, rates)
    : undefined;
  const inputCost = cost(row.inputTokens, rates?.input);
  const cacheReadCost = cost(row.cacheReadTokens, rates?.cachedInput);
  const cacheCreationCost = cost(row.cacheWriteTokens, rates?.cacheWrite);
  const outputCost = cost(row.outputTokens, rates?.output);
  // 历史账本 vendor_cost 为 0 时（写入时官方价未命中），若快照保留费率与用量，
  // 按公式对应金额只读兜底展示，与“供应商成本计算公式”保持一致。
  const computedVendorCost = vendorCostFormula !== undefined
    ? (inputCost ?? 0) + (cacheReadCost ?? 0) + (cacheCreationCost ?? 0) + (outputCost ?? 0)
    : undefined;
  // 人民币口径（2026-09-23）：账本物化列优先；缺失时按原币种 × 入账冻结系数折算；
  // vendor_cost=0 的快照公式兜底同样乘系数（与 LEDGER_VENDOR_COST_EXPR 同口径）。
  const fxRateToCny = row.fxRateToCny ?? 1;
  const vendorCostCny = row.vendorCostCny !== undefined
    ? row.vendorCostCny
    : row.vendorCost > 0
      ? row.vendorCost * fxRateToCny
      : computedVendorCost !== undefined
        ? computedVendorCost * fxRateToCny
        : undefined;
  const actualCostCny = row.actualCostCny !== undefined
    ? row.actualCostCny
    : row.actualCost > 0
      ? row.actualCost * fxRateToCny
      : undefined;
  return {
    exchangeId: row.exchangeId,
    requestKind: row.requestKind,
    ...(row.billingChannel ? {billingChannel: row.billingChannel} : {}),
    resultClass: row.resultClass,
    ...(row.agentStepId ? {stepId: row.agentStepId} : {}),
    ...(row.externalSessionId ? {externalSessionId: row.externalSessionId} : {}),
    ...(row.externalThreadId ? {externalThreadId: row.externalThreadId} : {}),
    ...(row.externalTurnId ? {externalTurnId: row.externalTurnId} : {}),
    ...(row.externalStepId ? {externalStepId: row.externalStepId} : {}),
    targetId: row.targetId,
    agentFingerprintId: row.agentFingerprintId,
    agentName: agentDisplayName(row.agentName || "unknown"),
    sessionId: row.agentSessionId ?? "",
    threadId: row.agentThreadId ?? "",
    turnId: row.agentTurnId ?? "",
    model: row.model || snapshot?.matchedModel || "未知模型",
    vendor: row.vendor || snapshot?.vendor || "未知供应商",
    rateMultiplier: snapshot?.rateMultiplier ?? row.rateMultiplier,
    createdAt: row.createdAt,
    durationSeconds: row.durationMs > 0 ? row.durationMs / 1_000 : undefined,
    ...(row.firstTokenMs !== undefined && row.firstTokenMs > 0
      ? {firstTokenMs: row.firstTokenMs}
      : {}),
    hasUsage,
    usageSource: row.usageSource || "unavailable",
    usageConfidence: row.usageConfidence || "unavailable",
    unpricedReason: snapshot?.unpricedReason,
    inputTokens: row.inputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheWriteTokens,
    outputTokens: row.outputTokens,
    inputUnitPrice: rates?.input,
    cacheReadUnitPrice: rates?.cachedInput,
    cacheWriteUnitPrice: rates?.cacheWrite,
    outputUnitPrice: rates?.output,
    inputCost,
    cacheReadCost,
    cacheCreationCost,
    outputCost,
    vendorCost: row.vendorCost > 0 ? row.vendorCost : (computedVendorCost ?? row.vendorCost),
    actualCost: row.actualCost,
    ...(vendorCostCny !== undefined ? {vendorCostCny} : {}),
    ...(actualCostCny !== undefined ? {actualCostCny} : {}),
    fxRateToCny,
    vendorCostFormula,
    actualCostFormula: vendorCostFormula
      ? `(${vendorCostFormula}) * ${formatFormulaNumber(snapshot?.rateMultiplier ?? row.rateMultiplier)}（价格倍率）`
      : undefined,
    currency: snapshot?.currency ?? "USD",
    responseStatus: row.responseStatus,
    diagnosticCodes: row.diagnosticCodes,
    ...(row.scheduleLabel ? {scheduleLabel: row.scheduleLabel} : {}),
    ...(row.timezone ? {timezone: row.timezone} : {}),
    ...(longContextTier ? {longContextTier: longContextTier.match} : {}),
    ...(snapshot?.promotionLabel ? {promotionLabel: snapshot.promotionLabel} : {}),
    ...(snapshot?.serviceTier ? {serviceTier: snapshot.serviceTier} : {}),
    ...(row.planCreditCost !== undefined && row.planCreditCost !== null
      ? {planCreditCost: row.planCreditCost}
      : {}),
    ...(row.planCreditUnit ? {planCreditUnit: row.planCreditUnit} : {}),
    ...(row.planEstimatedCostNano !== undefined ? {planEstimatedCostNano: row.planEstimatedCostNano} : {}),
    ...(row.planEstimatedCurrency ? {planEstimatedCurrency: row.planEstimatedCurrency} : {}),
    ...(row.planEstimatedFx !== undefined ? {planEstimatedFx: row.planEstimatedFx} : {}),
    ...(row.planEstimatedStatus ? {planEstimatedStatus: row.planEstimatedStatus} : {}),
    ...(row.planEstimatedMethod ? {planEstimatedMethod: row.planEstimatedMethod} : {}),
    ...(row.planEstimateDetailJson ? {planEstimateDetailJson: row.planEstimateDetailJson} : {}),
    ...(snapshot?.planCreditFormula ? {planCreditFormula: snapshot.planCreditFormula} : {}),
    ...(snapshot?.planCreditFormulaDetail ? {planCreditFormulaDetail: snapshot.planCreditFormulaDetail} : {}),
  };
}

function parseStoredPricingSnapshot(value: string): StoredPricingSnapshot | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as StoredPricingSnapshot
      : undefined;
  } catch {
    return undefined;
  }
}

function costFormula(row: TokenPricingLedgerRow, rates: PricingRates): string | undefined {
  const terms = [
    formulaTerm(row.inputTokens, rates.input),
    formulaTerm(row.cacheReadTokens, rates.cachedInput),
    formulaTerm(row.cacheWriteTokens, rates.cacheWrite),
    formulaTerm(row.outputTokens, rates.output),
  ].filter((term): term is string => term !== undefined);
  return terms.length > 0 ? terms.join(" +\n") : undefined;
}

function formulaTerm(tokens: number, rate: number | undefined): string | undefined {
  if (tokens <= 0 || rate === undefined) return undefined;
  return `${tokens.toLocaleString("en-US")} / 1000000 * ${formatFormulaNumber(rate)}`;
}

function cost(tokens: number, perMillion: number | undefined): number | undefined {
  return perMillion === undefined ? undefined : (tokens / 1_000_000) * perMillion;
}

function formatFormulaNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
}
