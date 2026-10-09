import {createHash} from "node:crypto";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {createRollupRepository} from "../../analytics/rollup-repository";

interface OriginalAttribution {
  target_id: string;
  agent_session_id: string | null;
  agent_thread_id: string | null;
  agent_turn_id: string | null;
  agent_fingerprint_id: string;
  agent_name: string;
  model: string;
  vendor: string;
  vendor_family: string | null;
  currency: string;
  fx_rate_to_cny: number | null;
  target_name: string | null;
  pricing_snapshot_json: string | null;
  rate_multiplier: number | null;
}

/** 站点逐条用量证据：仅「用量载体」补差行携带（调用方判定原行无可信用量）。 */
export interface ReconciliationUsageEvidence {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

function usageTokenValue(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** 仅用于账本事务内部；保持现有 reconciliation://synthetic 外键链，不读 raw。 */
export function insertReconciliationAdjustment(
  db: DeepaaDatabase,
  input: {
    targetId: string;
    provider: "sub2api" | "newapi";
    source: "matched" | "manual" | "residual";
    uniqueKey: string;
    localExchangeId?: string;
    amountNano: number;
    occurredAt: string;
    hourStartUtc: string;
    /**
     * 人民币物化系数：matched 补差复制原请求的冻结 fx，人工/残差补差用目标当前
     * settlementFx（缺省 1）。金额对账只比 USD；fx 只保证目标维度人民币合计自洽。
     */
    fxRateToCny?: number;
    /**
     * 用量载体（2026-09-29 用户确认）：原行无可信用量（失败/取消且估算类，本地金额 0）
     * 且站点明细提供 token 时，补差行写入站点四类 token/时长并复制原行价格快照，
     * 作为该请求的真实记录参与请求/Token 统计；纯金额更正行不携带、维持零 Token。
     */
    usage?: ReconciliationUsageEvidence;
  },
): string {
  if (!Number.isSafeInteger(input.amountNano) || input.amountNano === 0) {
    throw new Error("INVALID_RECONCILIATION_AMOUNT");
  }
  const attribution = input.localExchangeId
    ? db.prepare(
      `SELECT u.target_id,u.agent_session_id,u.agent_thread_id,u.agent_turn_id,
         u.agent_fingerprint_id,u.agent_name,u.model,u.vendor,u.vendor_family,u.currency,
         u.fx_rate_to_cny,u.pricing_snapshot_json,u.rate_multiplier,
         r.target_name
       FROM usage_ledger u JOIN raw_exchange_refs r ON r.exchange_id=u.exchange_id
       WHERE u.exchange_id=? AND u.target_id=?`,
    ).get(input.localExchangeId, input.targetId) as OriginalAttribution | undefined
    : undefined;
  if (input.localExchangeId && !attribution) throw new Error("RECONCILIATION_LOCAL_NOT_FOUND");
  const fx = input.fxRateToCny ?? attribution?.fx_rate_to_cny ?? 1;
  // 残差补差不挂靠具体请求，模型列用独立标签与逐条归属/人工补差区分展示。
  const modelLabel = input.source === "residual"
    ? "(对账补差·小时残差)" : "(对账补差)";
  const hash = createHash("sha256").update(
    `${input.targetId}\0${input.provider}\0${input.source}\0${input.uniqueKey}`,
  ).digest("hex").slice(0, 40);
  const exchangeId = `recon:${input.source}:${hash}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path,file_id,generation,byte_offset,scan_offset,file_size,
      processed_count,status,updated_at
    ) VALUES('reconciliation://synthetic','reconciliation-synthetic',0,0,0,0,0,'ready',?)
    ON CONFLICT(relative_path) DO NOTHING`,
  ).run(now);
  const source = db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path='reconciliation://synthetic'",
  ).get() as {id: number};
  db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id,capture_session_id,source_id,byte_offset,line_length_bytes,
      captured_at,completed_at,target_id,target_name,agent_name,
      agent_fingerprint_id,model,wire_api,status,is_streaming,
      request_body_bytes,response_body_bytes,diagnostic_codes_json
    ) VALUES(?,'reconciliation',?,0,1,?,?,?,?,?,?,?,NULL,0,0,0,0,'["reconciliation"]')`,
  ).run(
    exchangeId, source.id, input.occurredAt, input.occurredAt,
    input.targetId, attribution?.target_name ?? input.targetId,
    attribution?.agent_name ?? "unknown",
    attribution?.agent_fingerprint_id ?? "reconciliation",
    attribution?.model ?? modelLabel,
  );
  const amount = input.amountNano / 1e9;
  const amountCny = amount * fx;
  const usage = input.usage;
  const tokens = usage
    ? {
      input: usageTokenValue(usage.inputTokens),
      cacheRead: usageTokenValue(usage.cacheReadTokens),
      cacheWrite: usageTokenValue(usage.cacheWriteTokens),
      output: usageTokenValue(usage.outputTokens),
    }
    : {input: 0, cacheRead: 0, cacheWrite: 0, output: 0};
  const durationMs = usage ? usageTokenValue(usage.durationMs) : 0;
  const totalTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  // 载体行复用原请求的冻结价格快照（同一请求同一时刻的目录价与倍率），
  // 使单价列/倍率列可展示且「单价 × 站点 token × 倍率 ≈ 站点金额」自洽；
  // 原行快照缺失或不可解析时退回最小元数据，不虚构费率。
  let snapshotBase: Record<string, unknown> = {};
  if (usage && attribution?.pricing_snapshot_json) {
    try {
      const parsed = JSON.parse(attribution.pricing_snapshot_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        snapshotBase = parsed as Record<string, unknown>;
      }
    } catch {
      // 原行快照不可解析：保持最小元数据，页面单价列显示 -。
    }
  }
  const snapshotJson = JSON.stringify({
    ...snapshotBase,
    reconciliation: true, source: input.source, provider: input.provider,
    localExchangeId: input.localExchangeId ?? null, hourStartUtc: input.hourStartUtc,
    ...(usage ? {usageCarrier: true} : {}),
  });
  db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id,agent_session_id,agent_thread_id,agent_turn_id,
      target_id,agent_fingerprint_id,agent_name,model,vendor,
      billing_channel,vendor_family,rate_multiplier,
      input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,
      reasoning_tokens,total_tokens,derived_total_tokens,currency,vendor_cost,actual_cost,
      vendor_cost_cny,actual_cost_cny,fx_rate_to_cny,duration_ms,
      usage_source,usage_confidence,pricing_snapshot_json,
      request_kind,result_class,usage_quality,pricing_status,
      audit_eligible,total_tokens_basis,cost_basis,
      vendor_cost_nano,actual_cost_nano,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'pay_as_you_go',?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,'reconciliation','exact',?,'reconciliation','reconciled','exact','priced',0,'derived','reconciliation',?,?,?)`,
  ).run(
    exchangeId, attribution?.agent_session_id ?? null,
    attribution?.agent_thread_id ?? null, attribution?.agent_turn_id ?? null,
    input.targetId, attribution?.agent_fingerprint_id ?? "reconciliation",
    attribution?.agent_name ?? "unknown", attribution?.model ?? modelLabel,
    attribution?.vendor ?? "reconciliation", attribution?.vendor_family ?? null,
    usage ? attribution?.rate_multiplier ?? 1 : 1,
    tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output,
    totalTokens, totalTokens,
    attribution?.currency ?? "USD", amount, amount, amountCny, amountCny, fx, durationMs,
    snapshotJson,
    Math.round(amountCny * 1e9), Math.round(amountCny * 1e9), input.occurredAt,
  );
  const bucketStart = new Date(
    Math.floor(Date.parse(input.occurredAt) / 3_600_000) * 3_600_000,
  ).toISOString();
  createRollupRepository(db).markDirtyBucket(bucketStart, "reconciliation");
  return exchangeId;
}
