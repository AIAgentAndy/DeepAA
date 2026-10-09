/**
 * usage_ledger 金额聚合表达式的唯一事实来源（别名固定为 `u`）。
 *
 * 消费端必须保持同一条表达式，禁止各自内联副本：
 * - Token 价格页（token-pricing-queries.ts）逐行/汇总直接使用；
 * - 仪表盘小时事实物化（analytics/rollup-repository.ts）包一层通道 CASE 后
 *   `ROUND(expr * 1e9)` 落入 facts 金额列（2026-09-16 用户确认对齐）。
 * 任何一端语义变化必须同步评估另一端，并提升 rollup PROJECTION_VERSION 驱动既有桶重滚。
 */

/** 倍率后实付（CNY）：估算/不可用 Token 或明确未取得审计资格的请求不纳入实际总消费。
 * 兼容旧行：旧行 usage_quality 为空时仍按旧 usage_source 规则判断。 */
export const LEDGER_ACTUAL_COST_EXPR = `CASE
  WHEN u.usage_source IN ('tokenizer_estimated', 'heuristic_estimated', 'estimated', 'unavailable')
    OR (u.usage_quality = 'estimated' AND u.usage_source NOT IN ('provider_usage', 'provider_count_tokens', 'reconstructed_stream_usage'))
    OR (u.usage_quality = 'unavailable' AND u.usage_source = 'unavailable')
  THEN 0 ELSE COALESCE(u.actual_cost_cny, u.actual_cost) END`;

/** 倍率前供应商成本（CNY）：与明细展示一致，账本 vendor_cost 为 0 但价格快照保留
 * 费率与用量时，按公式对应金额兜底，避免汇总“倍率前”显示为 0/-。仅对
 * vendor_cost = 0 的行求值 JSON。 */
export const LEDGER_VENDOR_COST_EXPR = `
  CASE
    WHEN COALESCE(u.vendor_cost_cny, u.vendor_cost) > 0 THEN COALESCE(u.vendor_cost_cny, u.vendor_cost)
    WHEN json_valid(u.pricing_snapshot_json)
      AND json_extract(u.pricing_snapshot_json, '$.baseRates') IS NOT NULL
    THEN
      ((u.input_tokens / 1000000.0) * COALESCE(json_extract(u.pricing_snapshot_json, '$.baseRates.input'), 0)
      + (u.cache_read_tokens / 1000000.0) * COALESCE(json_extract(u.pricing_snapshot_json, '$.baseRates.cachedInput'), 0)
      + CASE
          WHEN COALESCE(u.cache_write_5m_tokens, 0) + COALESCE(u.cache_write_1h_tokens, 0) > 0
          THEN (u.cache_write_5m_tokens / 1000000.0)
            * COALESCE(
              json_extract(u.pricing_snapshot_json, '$.baseRates.cacheWrite5m'),
              json_extract(u.pricing_snapshot_json, '$.baseRates.cacheWrite'),
              0
            )
            + (u.cache_write_1h_tokens / 1000000.0)
            * COALESCE(
              json_extract(u.pricing_snapshot_json, '$.baseRates.cacheWrite1h'),
              json_extract(u.pricing_snapshot_json, '$.baseRates.cacheWrite'),
              0
            )
          ELSE (u.cache_write_tokens / 1000000.0)
            * COALESCE(json_extract(u.pricing_snapshot_json, '$.baseRates.cacheWrite'), 0)
        END
      + (u.output_tokens / 1000000.0) * COALESCE(json_extract(u.pricing_snapshot_json, '$.baseRates.output'), 0))
      * COALESCE(u.fx_rate_to_cny, 1)
    ELSE COALESCE(u.vendor_cost_cny, u.vendor_cost)
  END
`;

/**
 * 被「用量载体」补差行取代的原行（2026-09-29 用户确认）：原行无可信用量（失败/取消
 * 且估算类，本地金额 0）且已有站点真值承载时，其请求与估算 Token 在聚合中让位，
 * 防止与载体行的站点真值双算。m.exchange_id 恒指向原始请求行，补差行自身不会命中。
 */
export const LEDGER_SUPERSEDED_EXPR = `EXISTS(
  SELECT 1 FROM relay_reconciliation_matches m
  WHERE m.exchange_id = u.exchange_id AND m.usage_carrier = 1
)`;

/** 用量载体补差行：matched 归属且站点四类 token 已落到本补差行。 */
export const LEDGER_USAGE_CARRIER_EXPR = `EXISTS(
  SELECT 1 FROM relay_reconciliation_matches m
  WHERE m.adjustment_exchange_id = u.exchange_id AND m.usage_carrier = 1
)`;

/**
 * 请求计数 CASE（取代语义）：普通行计 1，被载体取代的原行计 0（该请求已由载体行
 * 代表）；补差行仅用量载体计 1，纯金额更正行仍不是真实请求。消费端包 SUM() 使用，
 * 与 Token 价格页汇总/分组、仪表盘 facts 的 request_count 同一份表达式。
 */
export function ledgerRequestCountExpr(): string {
  return `CASE
    WHEN COALESCE(u.request_kind, '') = 'reconciliation'
      THEN (CASE WHEN ${LEDGER_USAGE_CARRIER_EXPR} THEN 1 ELSE 0 END)
    WHEN ${LEDGER_SUPERSEDED_EXPR} THEN 0
    ELSE 1
  END`;
}

const LEDGER_TOKEN_COLUMNS = new Set([
  "input_tokens", "cache_read_tokens", "cache_write_tokens",
  "output_tokens", "reasoning_tokens",
] as const);

/**
 * Token 列求和 CASE（取代语义）：被载体取代的原行估算 Token 不再计入（站点真值
 * 已由载体行承载），其余行照常；载体行自身的站点 token 经普通求和自然计入。
 */
export function ledgerTokenExpr(column: string): string {
  if (!LEDGER_TOKEN_COLUMNS.has(column as never)) {
    throw new Error(`ledgerTokenExpr 不支持的列：${column}`);
  }
  return `CASE WHEN ${LEDGER_SUPERSEDED_EXPR} THEN 0 ELSE COALESCE(u.${column}, 0) END`;
}

/** Token 总量列（同取代语义）：被取代原行的估算总量让位，其余取派生/供应商总量。 */
export const LEDGER_TOTAL_TOKENS_EXPR = `CASE WHEN ${LEDGER_SUPERSEDED_EXPR}
  THEN 0 ELSE COALESCE(u.derived_total_tokens, u.provider_total_tokens, 0) END`;
