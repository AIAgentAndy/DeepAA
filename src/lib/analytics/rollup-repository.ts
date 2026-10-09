import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  LEDGER_ACTUAL_COST_EXPR,
  LEDGER_SUPERSEDED_EXPR,
  LEDGER_TOTAL_TOKENS_EXPR,
  LEDGER_USAGE_CARRIER_EXPR,
  LEDGER_VENDOR_COST_EXPR,
  ledgerRequestCountExpr,
  ledgerTokenExpr,
} from "../db/ledger-cost-exprs";

const HOUR_MS = 60 * 60 * 1_000;
/* v6（2026-09-16 用户确认）：按量金额物化改用与 Token 价格页完全相同的共享表达式
   （ledger-cost-exprs.ts）——倍率后对估算/不可用用量行记 0（原先 facts 无条件计入
   actual_cost_nano，导致仪表盘 0.59 vs Token 页 0.45 的差额）；提升版本驱动既有桶重滚。
   v7（2026-09-29 用户确认）：请求/Token 列改用取代语义共享表达式——用量载体补差行
   （原行无可信用量、站点真值已承载）计入请求与 Token，被取代原行（含其估算 token）
   排他；金额表达式未变。提升版本驱动既有桶重滚，不重算价格、不动账本原行。 */
const PROJECTION_VERSION = 7;

export interface RollupRepository {
  rebuildBucket(bucketStartUtc: string): Promise<{processedCount: number; candidateCount: number}>;
  rebuildRecentBuckets(now?: Date, count?: number): Promise<number>;
  markDirtyBucket(bucketStartUtc: string, reason?: string): void;
  getWatermark(): {rollupWatermarkAt: string | null; lastLedgerCreatedAt: string | null; staleBuckets: number};
  upsertBillingWindow(input: BillingWindowInput): BillingWindowSummary;
}

export interface BillingWindowInput {
  billingWindowId: string;
  targetId: string;
  billingChannel: "plan" | "subscription";
  vendorFamily?: string;
  windowStart: string;
  windowEnd: string;
  currency?: string;
  feeNano?: number;
  feeSource?: string;
  feeConfidence?: string;
  planName?: string;
  completeness?: "complete" | "incomplete";
}

export interface BillingWindowSummary {
  billingWindowId: string;
  referenceCostNano: number;
  referenceTokenCount: number;
  estimatedTokenCount: number;
  unpricedRequestCount: number;
  estimatedSavingsNano: number | null;
  valueMultiple: number | null;
  savingsRate: number | null;
  valueEstimationStatus: string;
}

export function createRollupRepository(db: DeepaaDatabase): RollupRepository {
  const rebuildBucket = async (bucketStartUtc: string) => {
    const start = Date.parse(bucketStartUtc);
    if (!Number.isFinite(start)) throw new Error("bucketStartUtc 必须是有效 ISO 时间。");
    const end = new Date(start + HOUR_MS).toISOString();
    const now = new Date().toISOString();
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM analytics_hourly_facts WHERE bucket_start_utc = ?").run(bucketStartUtc);
      const inserted = db.prepare(`
        INSERT INTO analytics_hourly_facts(
          bucket_start_utc, target_id, agent_id, vendor, vendor_family,
          billing_channel, model, currency, cost_basis, request_kind,
          result_class, usage_quality, pricing_status, plan_credit_unit,
          plan_credit_formula_version, request_count, model_request_count,
          auxiliary_request_count, success_count, error_count, cancelled_count,
          incomplete_count, input_tokens, cache_read_tokens, cache_write_tokens,
          output_tokens, reasoning_tokens, total_tokens,
          exact_token_request_count, estimated_token_request_count,
          unavailable_token_request_count, priced_request_count,
          unpriced_request_count, audit_eligible_request_count,
          vendor_cost_nano, actual_cost_nano, reference_cost_nano,
          reference_cost_request_count, reference_cost_exact_request_count,
          reference_cost_estimated_request_count, plan_credit_cost,
          plan_estimated_nano, plan_estimated_pending_request_count,
          duration_sum_ms, duration_sample_count, duration_min_ms,
          duration_max_ms, duration_histogram_json, tool_call_count,
          last_ledger_created_at, updated_at, projection_version
        )
        SELECT
          ?, COALESCE(u.target_id, 'unknown'), COALESCE(u.agent_name, 'unknown'),
          COALESCE(u.vendor, 'unknown'), COALESCE(u.vendor_family, 'unknown'),
          COALESCE(u.billing_channel, 'unknown'), COALESCE(u.model, 'unknown'),
          COALESCE(u.currency, 'unknown'), COALESCE(u.cost_basis, 'unavailable'),
          COALESCE(u.request_kind, 'unknown'), COALESCE(u.result_class, 'unknown'),
          COALESCE(u.usage_quality, 'unavailable'), COALESCE(u.pricing_status, 'not_applicable'),
          COALESCE(u.plan_credit_unit, 'not_applicable'),
          COALESCE(u.plan_credit_formula_version, 'not_applicable'),
          SUM(${ledgerRequestCountExpr()}),
          SUM(CASE WHEN ${LEDGER_SUPERSEDED_EXPR} THEN 0
            WHEN COALESCE(u.request_kind, 'model') = 'model'
              OR (COALESCE(u.request_kind, '') = 'reconciliation' AND ${LEDGER_USAGE_CARRIER_EXPR})
            THEN 1 ELSE 0 END),
          SUM(CASE WHEN COALESCE(u.request_kind, 'model') NOT IN ('model', 'reconciliation') THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.result_class = 'success' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.result_class IN ('client_error','upstream_error','proxy_error') THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.result_class = 'cancelled' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.result_class = 'incomplete' THEN 1 ELSE 0 END),
          SUM(${ledgerTokenExpr("input_tokens")}), SUM(${ledgerTokenExpr("cache_read_tokens")}),
          SUM(${ledgerTokenExpr("cache_write_tokens")}), SUM(${ledgerTokenExpr("output_tokens")}),
          SUM(${ledgerTokenExpr("reasoning_tokens")}),
          SUM(${LEDGER_TOTAL_TOKENS_EXPR}),
          SUM(CASE WHEN u.usage_quality = 'exact' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.usage_quality = 'estimated' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.usage_quality = 'unavailable' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.pricing_status = 'priced' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.pricing_status <> 'priced' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.audit_eligible = 1 THEN 1 ELSE 0 END),
          SUM(CASE WHEN COALESCE(u.billing_channel, 'pay_as_you_go') IN ('pay_as_you_go', 'unknown')
            THEN ROUND((${LEDGER_VENDOR_COST_EXPR}) * 1000000000) ELSE 0 END),
          SUM(CASE WHEN COALESCE(u.billing_channel, 'pay_as_you_go') IN ('pay_as_you_go', 'unknown')
            THEN ROUND((${LEDGER_ACTUAL_COST_EXPR}) * 1000000000) ELSE 0 END),
          SUM(COALESCE(u.reference_cost_nano, 0)),
          SUM(CASE WHEN u.reference_cost_nano IS NOT NULL THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.reference_cost_nano IS NOT NULL AND u.usage_quality = 'exact' THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.reference_cost_nano IS NOT NULL AND u.usage_quality = 'estimated' THEN 1 ELSE 0 END),
          SUM(COALESCE(u.plan_credit_cost, 0)),
          SUM(COALESCE(u.plan_estimated_cost_nano, 0)),
          /* 部分估算请求数：估算失败（unavailable）或旧口径有消耗行（status 为 NULL 的
             历史账本不回填，前端据此标注「部分估算」而非伪装完整）。 */
          SUM(CASE WHEN u.plan_estimated_status = 'unavailable'
            OR (u.plan_estimated_status IS NULL
              AND COALESCE(u.billing_channel, '') IN ('plan', 'subscription')
              AND (COALESCE(u.plan_credit_cost, 0) > 0 OR COALESCE(u.reference_cost_nano, 0) > 0))
            THEN 1 ELSE 0 END),
          SUM(CASE WHEN u.duration_sample_eligible = 1 THEN COALESCE(u.duration_ms, 0) ELSE 0 END),
          SUM(CASE WHEN u.duration_sample_eligible = 1 THEN 1 ELSE 0 END),
          MIN(CASE WHEN u.duration_sample_eligible = 1 THEN u.duration_ms END),
          MAX(CASE WHEN u.duration_sample_eligible = 1 THEN u.duration_ms END),
          json_object(
            '0_100', SUM(CASE WHEN u.duration_ms >= 0 AND u.duration_ms < 100 THEN 1 ELSE 0 END),
            '100_250', SUM(CASE WHEN u.duration_ms >= 100 AND u.duration_ms < 250 THEN 1 ELSE 0 END),
            '250_500', SUM(CASE WHEN u.duration_ms >= 250 AND u.duration_ms < 500 THEN 1 ELSE 0 END),
            '500_1000', SUM(CASE WHEN u.duration_ms >= 500 AND u.duration_ms < 1000 THEN 1 ELSE 0 END),
            '1000_2000', SUM(CASE WHEN u.duration_ms >= 1000 AND u.duration_ms < 2000 THEN 1 ELSE 0 END),
            '2000_5000', SUM(CASE WHEN u.duration_ms >= 2000 AND u.duration_ms < 5000 THEN 1 ELSE 0 END),
            '5000_10000', SUM(CASE WHEN u.duration_ms >= 5000 AND u.duration_ms < 10000 THEN 1 ELSE 0 END),
            '10000_30000', SUM(CASE WHEN u.duration_ms >= 10000 AND u.duration_ms < 30000 THEN 1 ELSE 0 END),
            '30000_60000', SUM(CASE WHEN u.duration_ms >= 30000 AND u.duration_ms < 60000 THEN 1 ELSE 0 END),
            '60000_plus', SUM(CASE WHEN u.duration_ms >= 60000 THEN 1 ELSE 0 END)
          ),
          SUM(COALESCE((SELECT COUNT(*) FROM tool_calls tc WHERE tc.agent_step_id = u.agent_step_id), 0)),
          MAX(u.created_at), ?, ?
        FROM usage_ledger u
        WHERE u.created_at >= ? AND u.created_at < ?
        GROUP BY
          COALESCE(u.target_id, 'unknown'), COALESCE(u.agent_name, 'unknown'),
          COALESCE(u.vendor, 'unknown'), COALESCE(u.vendor_family, 'unknown'),
          COALESCE(u.billing_channel, 'unknown'), COALESCE(u.model, 'unknown'),
          COALESCE(u.currency, 'unknown'), COALESCE(u.cost_basis, 'unavailable'),
          COALESCE(u.request_kind, 'unknown'), COALESCE(u.result_class, 'unknown'),
          COALESCE(u.usage_quality, 'unavailable'), COALESCE(u.pricing_status, 'not_applicable'),
          COALESCE(u.plan_credit_unit, 'not_applicable'),
          COALESCE(u.plan_credit_formula_version, 'not_applicable')
      `).run(bucketStartUtc, now, PROJECTION_VERSION, bucketStartUtc, end);
      db.prepare(`UPDATE analytics_dirty_buckets SET status = 'completed', completed_at = ?, locked_by = NULL, locked_until = NULL, last_error = NULL WHERE bucket_start_utc = ?`).run(now, bucketStartUtc);
      const candidateRow = db.prepare("SELECT COUNT(*) AS count FROM usage_ledger WHERE created_at >= ? AND created_at < ?").get(bucketStartUtc, end) as {count: number};
      return {processedCount: inserted.changes, candidateCount: Number(candidateRow.count)};
    });
    return transaction();
  };

  const rebuildRecentBuckets = async (now = new Date(), count = 2): Promise<number> => {
    let processed = 0;
    const current = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
    for (let index = 0; index < Math.max(1, Math.min(count, 24)); index += 1) {
      const bucket = new Date(current - index * HOUR_MS).toISOString();
      const result = await rebuildBucket(bucket);
      processed += result.processedCount;
    }
    return processed;
  };

  const markDirtyBucket = (bucketStartUtc: string, reason = "reconcile") => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO analytics_dirty_buckets(bucket_start_utc, reason, first_seen_at, last_seen_at, available_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start_utc) DO UPDATE SET last_seen_at = excluded.last_seen_at, reason = excluded.reason, status = 'pending'`)
      .run(bucketStartUtc, reason, now, now, now);
  };

  const getWatermark = () => {
    const state = db.prepare("SELECT rollup_watermark_at, last_ledger_created_at FROM analytics_worker_state WHERE id = 1").get() as {rollup_watermark_at?: string; last_ledger_created_at?: string} | undefined;
    const stale = db.prepare("SELECT COUNT(*) AS count FROM analytics_dirty_buckets WHERE status <> 'completed'").get() as {count: number};
    return {rollupWatermarkAt: state?.rollup_watermark_at ?? null, lastLedgerCreatedAt: state?.last_ledger_created_at ?? null, staleBuckets: stale.count};
  };

  const upsertBillingWindow = (input: BillingWindowInput): BillingWindowSummary => {
    const now = new Date().toISOString();
    const summary = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN reference_cost_nano IS NOT NULL THEN reference_cost_nano ELSE 0 END), 0) AS reference_cost_nano,
      COALESCE(SUM(CASE WHEN reference_cost_nano IS NOT NULL AND usage_quality = 'exact' THEN COALESCE(derived_total_tokens, 0) ELSE 0 END), 0) AS reference_token_count,
      COALESCE(SUM(CASE WHEN reference_cost_nano IS NOT NULL AND usage_quality = 'estimated' THEN COALESCE(derived_total_tokens, 0) ELSE 0 END), 0) AS estimated_token_count,
      COALESCE(SUM(CASE WHEN pricing_status <> 'priced' THEN 1 ELSE 0 END), 0) AS unpriced_request_count,
      COALESCE(SUM(COALESCE(plan_credit_cost, 0)), 0) AS plan_credit_cost
      FROM usage_ledger WHERE target_id = ? AND created_at >= ? AND created_at < ?`).get(input.targetId, input.windowStart, input.windowEnd) as {reference_cost_nano: number; reference_token_count: number; estimated_token_count: number; unpriced_request_count: number; plan_credit_cost: number};
    const status = input.feeNano === undefined ? "missing_fee"
      : input.completeness !== "complete" ? "incomplete_window"
        : summary.reference_cost_nano <= 0 ? "missing_reference_price" : "available";
    const savings = status === "available" ? summary.reference_cost_nano - input.feeNano! : null;
    const multiple = status === "available" && input.feeNano! > 0 ? summary.reference_cost_nano / input.feeNano! : null;
    const rate = status === "available" && summary.reference_cost_nano > 0 ? 1 - input.feeNano! / summary.reference_cost_nano : null;
    db.prepare(`INSERT INTO billing_value_windows(
      billing_window_id, target_id, billing_channel, vendor_family, window_start, window_end,
      currency, fee_nano, fee_source, fee_confidence, plan_name, reference_cost_nano,
      reference_token_count, estimated_token_count, unpriced_request_count, plan_credit_cost,
      estimated_savings_nano, value_multiple, savings_rate, value_estimation_status,
      completeness, captured_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(billing_window_id) DO UPDATE SET
      fee_nano = excluded.fee_nano, reference_cost_nano = excluded.reference_cost_nano,
      reference_token_count = excluded.reference_token_count, estimated_token_count = excluded.estimated_token_count,
      unpriced_request_count = excluded.unpriced_request_count, plan_credit_cost = excluded.plan_credit_cost,
      estimated_savings_nano = excluded.estimated_savings_nano, value_multiple = excluded.value_multiple,
      savings_rate = excluded.savings_rate, value_estimation_status = excluded.value_estimation_status,
      completeness = excluded.completeness, updated_at = excluded.updated_at`).run(
      input.billingWindowId, input.targetId, input.billingChannel, input.vendorFamily ?? "unknown", input.windowStart,
      input.windowEnd, input.currency ?? null, input.feeNano ?? null, input.feeSource ?? null,
      input.feeConfidence ?? null, input.planName ?? null, summary.reference_cost_nano,
      summary.reference_token_count, summary.estimated_token_count, summary.unpriced_request_count,
      summary.plan_credit_cost, savings, multiple, rate, status, input.completeness ?? "incomplete", now, now,
    );
    return {billingWindowId: input.billingWindowId, referenceCostNano: summary.reference_cost_nano, referenceTokenCount: summary.reference_token_count, estimatedTokenCount: summary.estimated_token_count, unpricedRequestCount: summary.unpriced_request_count, estimatedSavingsNano: savings, valueMultiple: multiple, savingsRate: rate, valueEstimationStatus: status};
  };

  return {rebuildBucket, rebuildRecentBuckets, markDirtyBucket, getWatermark, upsertBillingWindow};
}
