import type {TokenUsageSummary} from "../harness/stream-response.js";
import type {StreamConnectionStatus} from "../harness/types.js";
import type {TokenCost} from "../pricing.js";
import type {
  PricingStatus,
  ReferenceCostStatus,
  ResultClass,
  TotalTokensBasis,
  UsageQuality,
} from "./types.js";

export type RequestKind = "model" | "auxiliary" | "token_count" | "metadata" | "health_check" | "unknown";
export type ReasoningSemantics = "output_subset" | "separate" | "unknown";
export type CostBasis = "payg_rate" | "target_multiplier" | "plan_credit" | "official_reference" | "subscription_observed" | "unavailable";

export interface LedgerMetricInput {
  usage: TokenUsageSummary;
  cost?: Pick<TokenCost, "priced" | "unpricedReason" | "officialTotalCost" | "totalCost" | "currency" | "vendor" | "pricingSnapshot">;
  requestKind?: RequestKind;
  responseStatus?: number;
  isStreaming?: boolean;
  streamComplete?: boolean;
  /** 代理捕获的连接收尾状态；中断集合（abort/reset/error）表示响应未完整送达。 */
  connectionStatus?: StreamConnectionStatus;
  /** 协议终态事件已见（message_stop / response.completed / [DONE]）：
   * 客户端在完整响应后立即断连会被记为 client_aborted，但站点已正常计费，应视为成功。 */
  terminalSeen?: boolean;
  billingChannel?: "pay_as_you_go" | "plan" | "subscription";
  reasoningSemantics?: ReasoningSemantics;
}

export interface LedgerMetricResult {
  requestKind: RequestKind;
  resultClass: ResultClass;
  usageQuality: UsageQuality;
  pricingStatus: PricingStatus;
  auditEligible: boolean;
  auditExclusionReason?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  providerTotalTokens?: number;
  derivedTotalTokens?: number;
  totalTokensBasis: TotalTokensBasis;
  reasoningSemantics: ReasoningSemantics;
  referenceCostStatus: ReferenceCostStatus;
  costBasis: CostBasis;
  /** 请求耗时是否计入时长样本；断流/未完成请求不计入，避免污染平均耗时。 */
  durationSampleEligible: boolean;
}

const INTERRUPTED_CONNECTION_STATUSES: ReadonlySet<StreamConnectionStatus> = new Set([
  "client_aborted",
  "upstream_aborted",
  "connection_reset",
  "connection_error",
  "proxy_stream_error",
]);

/**
 * 断流判定：connectionStatus 属于中断集合时视为流未完整送达。
 * 非流式请求正常结束时 connectionStatus 为 open_completed/unknown/undefined。
 */
export function streamCompleteFromConnectionStatus(
  connectionStatus: StreamConnectionStatus | undefined,
): boolean {
  return connectionStatus === undefined
    || !INTERRUPTED_CONNECTION_STATUSES.has(connectionStatus);
}

export function usageQualityFromSource(
  source: TokenUsageSummary["source"],
  confidence: TokenUsageSummary["usageConfidence"],
  streamComplete = true,
): UsageQuality {
  if (source === "unavailable" || confidence === "unavailable") return "unavailable";
  // 断流时估算类（tokenizer/启发式/重建）一律不可信：半截响应不能冒充估算样本。
  if (!streamComplete && source !== "provider_usage" && source !== "provider_count_tokens") {
    return "unavailable";
  }
  if (source === "provider_usage" || source === "provider_count_tokens") {
    return "exact";
  }
  if (source === "reconstructed_stream_usage" && streamComplete && confidence === "exact") {
    return "exact";
  }
  return "estimated";
}

export function classifyResultClass(
  status: number | undefined,
  streamComplete = true,
  connectionStatus?: StreamConnectionStatus,
): ResultClass {
  if (status === undefined || !Number.isFinite(status)) return "unknown";
  if (status === 499 || status === 408) return "cancelled";
  if (status >= 200 && status < 300) {
    if (streamComplete) return "success";
    // 2xx 但连接中断：客户端主动取消归 cancelled，上游中断归 incomplete。
    return connectionStatus === "client_aborted" ? "cancelled" : "incomplete";
  }
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500) return "upstream_error";
  return "unknown";
}

export function classifyPricingStatus(cost: LedgerMetricInput["cost"]): PricingStatus {
  if (!cost) return "not_applicable";
  if (cost.priced === true) return "priced";
  switch (cost.unpricedReason) {
    case "model_ambiguous": return "unpriced_ambiguous";
    case "pricing_stale": return "unpriced_stale";
    case "price_unverified": return "unpriced_unverified";
    default: return "unpriced_unmatched";
  }
}

export function deriveTotalTokens(usage: TokenUsageSummary): {
  providerTotalTokens?: number;
  derivedTotalTokens?: number;
  basis: TotalTokensBasis;
} {
  const providerTotalTokens = finiteNonNegative(usage.totalTokens);
  const input = finiteNonNegative(usage.inputTokens);
  const cacheRead = finiteNonNegative(usage.cacheReadTokens);
  const cacheWrite = finiteNonNegative(usage.cacheCreationTokens);
  const output = finiteNonNegative(usage.outputTokens);
  if (input !== undefined && output !== undefined) {
    return {
      providerTotalTokens,
      derivedTotalTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0) + output,
      basis: "derived",
    };
  }
  const totalInput = finiteNonNegative(usage.totalInputTokens);
  if (totalInput !== undefined && output !== undefined) {
    return {providerTotalTokens, derivedTotalTokens: totalInput + output, basis: "derived"};
  }
  if (providerTotalTokens !== undefined) {
    return {providerTotalTokens, basis: "provider"};
  }
  return {basis: "unavailable"};
}

export function buildLedgerMetrics(input: LedgerMetricInput): LedgerMetricResult {
  const streamComplete = input.streamComplete !== false
    && streamCompleteFromConnectionStatus(input.connectionStatus);
  let quality = usageQualityFromSource(input.usage.source, input.usage.usageConfidence, streamComplete);
  // 断流且 provider usage 全 0/缺失：上游没有返回真实 usage（例如 Anthropic
  // 兼容上游只在 message_start 发占位 0、断流时 message_delta 未送达），
  // 按不可用处理，避免把 0 token 冒充 exact。
  if (quality === "exact" && !streamComplete && providerUsageAllZero(input.usage)) {
    quality = "unavailable";
  }
  const pricingStatus = classifyPricingStatus(input.cost);
  const requestKind = input.requestKind ?? "model";
  let resultClass = classifyResultClass(input.responseStatus, streamComplete, input.connectionStatus);
  // 2026-09-03 用户确认判定收紧：协议终态已见 + provider 真实用量 → 视为成功。
  // 客户端在收到完整响应后立即断连会被传输层记为 client_aborted（cancelled），
  // 但协议已完整收尾、token 全部消耗、站点正常扣款，cancelled 语义会误导对账。
  if (resultClass === "cancelled" && input.terminalSeen === true
    && input.usage.source === "provider_usage") {
    resultClass = "success";
  }
  const totals = deriveTotalTokens(input.usage);
  const auditEligible = requestKind === "model"
    && input.billingChannel !== "plan"
    && input.billingChannel !== "subscription"
    && quality === "exact"
    && pricingStatus === "priced"
    && totals.derivedTotalTokens !== undefined;
  let auditExclusionReason: string | undefined;
  if (!auditEligible) {
    if (requestKind !== "model") auditExclusionReason = "non_model_request";
    else if (input.billingChannel === "plan" || input.billingChannel === "subscription") auditExclusionReason = "billing_channel_not_payg";
    else if (quality !== "exact") auditExclusionReason = `usage_${quality}`;
    else if (pricingStatus !== "priced") auditExclusionReason = pricingStatus;
    else auditExclusionReason = "derived_total_unavailable";
  }
  const referenceCostStatus: ReferenceCostStatus = input.billingChannel === "plan" || input.billingChannel === "subscription"
    ? (pricingStatus === "priced" ? (quality === "exact" ? "available" : "estimated") : "missing_price")
    : "unavailable";
  const costBasis: CostBasis = input.billingChannel === "plan"
    ? "official_reference"
    : input.billingChannel === "subscription"
      ? "subscription_observed"
      : pricingStatus === "priced" ? "payg_rate" : "unavailable";
  return {
    requestKind,
    resultClass,
    usageQuality: quality,
    pricingStatus,
    auditEligible,
    auditExclusionReason,
    inputTokens: finiteNonNegative(input.usage.inputTokens) ?? 0,
    cacheReadTokens: finiteNonNegative(input.usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: finiteNonNegative(input.usage.cacheCreationTokens) ?? 0,
    outputTokens: finiteNonNegative(input.usage.outputTokens) ?? 0,
    reasoningTokens: finiteNonNegative(input.usage.reasoningTokens) ?? 0,
    providerTotalTokens: totals.providerTotalTokens,
    derivedTotalTokens: totals.derivedTotalTokens,
    totalTokensBasis: totals.basis,
    reasoningSemantics: input.reasoningSemantics ?? "output_subset",
    referenceCostStatus,
    costBasis,
    durationSampleEligible: streamComplete,
  };
}

/** provider usage 全字段都缺失或为 0 时，视为没有拿到真实 usage。 */
function providerUsageAllZero(usage: TokenUsageSummary): boolean {
  const values = [
    usage.inputTokens,
    usage.totalInputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ];
  return values.every(value => value === undefined || value === 0);
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
