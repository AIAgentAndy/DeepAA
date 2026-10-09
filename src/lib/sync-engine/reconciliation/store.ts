import {createHash} from "node:crypto";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {LocalUsageRecord} from "./matching";
import type {UsageMatch} from "./matching";
import {insertReconciliationAdjustment} from "./ledger";
const HOUR_MS = 3_600_000;
// 小时关闭后留 5 分钟供两端异步收敛（2026-09-26 用户确认：站点计费秒级落库，
// 实测 10 分钟已 100% 稳定；真正防错账的是两轮稳定观测，延时只防抖）。
const CLOSE_DELAY_MS = HOUR_MS + 5 * 60_000;
const RETRY_INTERVAL_MS = 5 * 60_000;
const MIN_OBSERVATION_GAP_MS = 60_000;
// 站点连续失败按目标退避（catapi 实测：incomplete × 5 分钟重试 = 每分钟多次登录，
// 会把自己打进站点限流形成自锁）；任何一次成功立即清零。
const SITE_BACKOFF_SCHEDULE_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
const DUE_LIMIT = 8;
const LOCAL_RECORD_LIMIT = 1000;
/**
 * 水位新鲜度上限（2026-09-29 用户确认，30 分钟）：水位是"截至 T 已扫到尾"的单调
 * 历史事实，正常 Worker 约 2 秒完成一轮、合法大规模回填的整轮也在分钟级。唯一会让
 * 水位长期滞后的场景是批次异步 hang 死但续租器仍在续租——接受该水位对"小时结束早于
 * T"的小时仍属正确，但把"Worker 卡死"诚实表现为 incomplete 比无限信任更稳妥；
 * 上限取得极宽，健康路径零影响。
 */
const SCAN_WATERMARK_MAX_AGE_MS = 30 * 60_000;
/**
 * 小时残差自动补上限（USD nano，2026-09-28 用户确认）：$10。正常错误风暴残差是
 * 几美分到几美元；持续更大的残差更像密钥外泄或站点异常，应被人看见而非自动平账。
 */
export const RESIDUAL_AUTO_APPLY_MAX_NANO = 10_000_000_000;

export interface HourRow {
  targetId: string;
  hourStartUtc: string;
  providerType: "sub2api" | "newapi";
  consoleAccountId: string;
  consoleIdentityHash: string | null;
  status: "pending" | "incomplete" | "balanced" | "needs_review" | "applied" | "ignored";
  siteAmountNano: number | null;
  siteEvidenceHash: string | null;
  /** 完整观测时的轻量复查键；已定稿小时键未变即跳过明细重拉。 */
  siteLightCheck: string | null;
  localAmountNano: number | null;
  appliedAmountNano: number;
  manualRevision: number;
  residualRevision: number;
  residualAppliedNano: number;
  residualNano: number | null;
  siteSource: string | null;
  siteCandidateCount: number;
  siteProcessedCount: number;
  siteLimited: boolean;
  siteDetailsComplete: boolean;
  localCandidateCount: number;
  localProcessedCount: number;
  localLimited: boolean;
  matchedCount: number;
  unmatchedSiteCount: number;
  stableCount: number;
  lastSiteObservedAt: string | null;
  lastCheckedAt: string | null;
  reason: string | null;
  ignoredReason: string | null;
}

export interface HourObservation {
  targetId: string;
  hourStartUtc: string;
  siteAmountNano: number | null;
  localAmountNano: number | null;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  detailsComplete: boolean;
  localComplete: boolean;
  localCandidateCount: number;
  localProcessedCount: number;
  matchedCount: number;
  unmatchedSiteCount: number;
  source: string;
  siteEvidenceHash?: string;
  siteLightCheck?: string;
  observedAt: string;
  reason?: string;
}

export interface LocalHourSnapshot {
  amountNano: number | null;
  records: LocalUsageRecord[];
  complete: boolean;
  limited: boolean;
  candidateCount: number;
  processedCount: number;
}

interface SqlHourRow {
  target_id: string;
  hour_start_utc: string;
  provider_type: "sub2api" | "newapi";
  console_account_id: string;
  console_identity_hash: string | null;
  status: HourRow["status"];
  site_amount_nano: number | null;
  site_evidence_hash: string | null;
  site_light_check: string | null;
  local_amount_nano: number | null;
  applied_amount_nano: number;
  manual_revision: number;
  residual_revision: number;
  residual_applied_nano: number;
  residual_nano: number | null;
  site_source: string | null;
  site_candidate_count: number;
  site_processed_count: number;
  site_limited: number;
  site_details_complete: number;
  local_candidate_count: number;
  local_processed_count: number;
  local_limited: number;
  matched_count: number;
  unmatched_site_count: number;
  stable_count: number;
  last_site_observed_at: string | null;
  last_checked_at: string | null;
  reason: string | null;
  ignored_reason: string | null;
}

function rowToHour(row: SqlHourRow): HourRow {
  return {
    targetId: row.target_id, hourStartUtc: row.hour_start_utc,
    providerType: row.provider_type, consoleAccountId: row.console_account_id,
    consoleIdentityHash: row.console_identity_hash,
    status: row.status, siteAmountNano: row.site_amount_nano,
    siteEvidenceHash: row.site_evidence_hash,
    siteLightCheck: row.site_light_check,
    localAmountNano: row.local_amount_nano, appliedAmountNano: row.applied_amount_nano,
    manualRevision: row.manual_revision, residualRevision: row.residual_revision,
    residualAppliedNano: row.residual_applied_nano,
    residualNano: row.residual_nano, siteSource: row.site_source,
    siteCandidateCount: row.site_candidate_count, siteProcessedCount: row.site_processed_count,
    siteLimited: row.site_limited === 1, siteDetailsComplete: row.site_details_complete === 1,
    localCandidateCount: row.local_candidate_count, localProcessedCount: row.local_processed_count,
    localLimited: row.local_limited === 1, matchedCount: row.matched_count,
    unmatchedSiteCount: row.unmatched_site_count, stableCount: row.stable_count,
    lastSiteObservedAt: row.last_site_observed_at, lastCheckedAt: row.last_checked_at,
    reason: row.reason, ignoredReason: row.ignored_reason,
  };
}

function hourMillis(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis % HOUR_MS !== 0
    || new Date(millis).toISOString() !== value) {
    throw new Error("INVALID_RECONCILIATION_HOUR");
  }
  return millis;
}

/** 账号 ID 在修改控制台地址/用户名时仍会复用，小时归属必须冻结实际站点身份。 */
function consoleIdentityHash(db: DeepaaDatabase, targetId: string, accountId: string,
  provider: "sub2api" | "newapi"): string | null {
  const account = db.prepare(
    "SELECT console_base_url AS base,username FROM console_accounts WHERE target_id=? AND id=?",
  ).get(targetId, accountId) as {base: string; username: string} | undefined;
  if (!account) return null;
  return createHash("sha256").update(
    `${provider}\0${account.base.replace(/\/+$/u, "")}\0${account.username}`,
  ).digest("hex");
}

/**
 * 用量载体判定（2026-09-29 用户确认）：原行无可信用量（失败/取消且估算类，
 * loadLocalHour 的金额 CASE 已折为 0）且站点明细提供任一类 token 时，
 * matched 补差行升级为该请求的真实记录——写入站点 token/时长并复制原行价格快照，
 * 参与请求/Token 统计；原行的估算 token 在聚合端排他（ledger-cost-exprs 共享表达式）。
 * 纯金额更正（原行为成功行、真实用量已计）不升级，维持零 Token。
 */
function siteUsageEvidence(
  match: UsageMatch,
): {inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  outputTokens?: number; durationMs?: number} | undefined {
  if (match.local.actualCostNano !== 0) return undefined;
  const site = match.site;
  if (site.inputTokens === undefined && site.cacheReadTokens === undefined
    && site.cacheWriteTokens === undefined && site.outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(site.inputTokens !== undefined ? {inputTokens: site.inputTokens} : {}),
    ...(site.cacheReadTokens !== undefined ? {cacheReadTokens: site.cacheReadTokens} : {}),
    ...(site.cacheWriteTokens !== undefined ? {cacheWriteTokens: site.cacheWriteTokens} : {}),
    ...(site.outputTokens !== undefined ? {outputTokens: site.outputTokens} : {}),
    ...(site.durationMs !== undefined ? {durationMs: site.durationMs} : {}),
  };
}

/** 低频小时状态存储；旧五分钟表仅作历史记录。 */
export class ReconciliationStore {
  constructor(private readonly db: DeepaaDatabase) {}

  currentConsoleIdentityHash(
    targetId: string, accountId: string, provider: "sub2api" | "newapi",
  ): string | null {
    return consoleIdentityHash(this.db, targetId, accountId, provider);
  }

  seedHour(
    targetId: string, accountId: string, provider: "sub2api" | "newapi", hourStartUtc: string,
  ): void {
    hourMillis(hourStartUtc);
    const now = new Date().toISOString();
    const identity = this.currentConsoleIdentityHash(targetId, accountId, provider);
    this.db.prepare(
      `INSERT INTO relay_reconciliation_hours(
        target_id, hour_start_utc, provider_type, console_account_id,
        console_identity_hash, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_id, hour_start_utc) DO NOTHING`,
    ).run(targetId, hourStartUtc, provider, accountId, identity, now, now);
  }

  getHour(targetId: string, hourStartUtc: string): HourRow | undefined {
    const row = this.db.prepare(
      `SELECT * FROM relay_reconciliation_hours WHERE target_id = ? AND hour_start_utc = ?`,
    ).get(targetId, hourStartUtc) as SqlHourRow | undefined;
    return row ? rowToHour(row) : undefined;
  }

  /** 小时表按时间+目标 keyset 翻页；只返回待人工复核的小时（2026-09-28 用户确认：
   * 面板静默化——有待确认记录才显示，其余状态零出现）。 */
  listHours(options: {
    targetId?: string;
    limit?: number;
    cursor?: string;
  } = {}): {
    items: HourRow[];
    candidateCount: number;
    processedCount: number;
    limited: boolean;
    nextCursor?: string;
  } {
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20) || 20));
    let cursor: {hour: string; target: string} | undefined;
    if (options.cursor) {
      try {
        if (options.cursor.length > 512) throw new Error();
        const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        const row = parsed as Record<string, unknown>;
        if (typeof row.hour !== "string" || typeof row.target !== "string"
          || row.target.length > 128) throw new Error();
        hourMillis(row.hour);
        cursor = {hour: row.hour, target: row.target};
      } catch {
        throw new Error("RECONCILIATION_CURSOR_INVALID");
      }
    }
    const where: string[] = ["status = 'needs_review'"];
    const params: unknown[] = [];
    if (options.targetId) {
      where.push("target_id = ?");
      params.push(options.targetId);
    }
    const filters = `WHERE ${where.join(" AND ")}`;
    const candidateCount = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM relay_reconciliation_hours ${filters}`,
    ).get(...params) as {n: number}).n;
    if (cursor) {
      where.push("(hour_start_utc < ? OR (hour_start_utc = ? AND target_id < ?))");
      params.push(cursor.hour, cursor.hour, cursor.target);
    }
    const rows = this.db.prepare(
      `SELECT * FROM relay_reconciliation_hours
       WHERE ${where.join(" AND ")}
       ORDER BY hour_start_utc DESC,target_id DESC LIMIT ?`,
    ).all(...params, limit + 1) as SqlHourRow[];
    const limited = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToHour);
    const last = items.at(-1);
    return {
      items, candidateCount, processedCount: rows.length, limited,
      ...(limited && last ? {nextCursor: Buffer.from(JSON.stringify({
        hour: last.hourStartUtc, target: last.targetId,
      })).toString("base64url")} : {}),
    };
  }

  /**
   * 先从小时完成时间覆盖索引拿 LIMIT+1 个 ID，再逐条主键取账本字段。
   * 超预算时没有读取任何账本行，也绝不返回「已取部分」金额。
   */
  loadLocalHour(targetId: string, hourStartUtc: string): LocalHourSnapshot {
    const start = hourMillis(hourStartUtc);
    const end = start + HOUR_MS;
    const refs = this.db.prepare(
      `SELECT exchange_id, completed_at, provider_request_id, endpoint
       FROM relay_local_usage_events
       WHERE target_id = ? AND completed_at >= ? AND completed_at < ?
       ORDER BY completed_at, exchange_id LIMIT ?`,
    ).all(
      targetId,
      new Date(start - 30_000).toISOString(),
      new Date(end + 30_000).toISOString(),
      LOCAL_RECORD_LIMIT + 1,
    ) as Array<{
      exchange_id: string; completed_at: string;
      provider_request_id: string | null; endpoint: string | null;
    }>;
    if (refs.length > LOCAL_RECORD_LIMIT) {
      return {amountNano: null, records: [], complete: false, limited: true,
        candidateCount: refs.length, processedCount: refs.length};
    }
    const read = this.db.prepare(
      `SELECT u.target_id, u.model, u.created_at, u.currency,
         u.input_tokens, u.cache_read_tokens, u.cache_write_tokens, u.output_tokens,
         u.result_class, u.usage_source, u.usage_quality, u.request_kind, u.billing_channel,
         ROUND(CASE
           WHEN u.result_class IN ('success','cancelled')
             AND u.usage_source NOT IN ('tokenizer_estimated','heuristic_estimated','estimated','unavailable')
             AND NOT (u.usage_quality = 'estimated'
               AND u.usage_source NOT IN ('provider_usage','provider_count_tokens','reconstructed_stream_usage'))
             AND NOT (u.usage_quality = 'unavailable' AND u.usage_source = 'unavailable')
           THEN u.actual_cost ELSE 0 END * 1000000000) AS actual_nano
       FROM usage_ledger u WHERE u.exchange_id = ?`,
    );
    const records: LocalUsageRecord[] = [];
    let amountNano = 0;
    for (const ref of refs) {
      const row = read.get(ref.exchange_id) as {
        target_id: string; model: string; created_at: string; currency: string;
        input_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
        output_tokens: number; result_class: string; usage_source: string;
        request_kind: string; billing_channel: string | null; actual_nano: number;
      } | undefined;
      if (!row || row.target_id !== targetId) {
        return {amountNano: null, records: [], complete: false, limited: true,
          candidateCount: refs.length, processedCount: records.length + 1};
      }
      if (row.request_kind === "reconciliation"
        || (row.billing_channel !== null && row.billing_channel !== "pay_as_you_go")) continue;
      const actualCostNano = row.actual_nano;
      // 对账两边比较的都是倍率后 USD（token×单价×倍率）；settlementFx 只负责
      // 人民币展示换算，与对账无关（2026-09-26 用户澄清），故只校验原始币种。
      if (!Number.isSafeInteger(actualCostNano)
        || (actualCostNano !== 0 && row.currency !== "USD")) {
        return {amountNano: null, records: [], complete: false, limited: true,
          candidateCount: refs.length, processedCount: records.length + 1};
      }
      const millis = Date.parse(ref.completed_at);
      if (millis >= start && millis < end) amountNano += actualCostNano;
      if (!Number.isSafeInteger(amountNano)) {
        return {amountNano: null, records: [], complete: false, limited: true,
          candidateCount: refs.length, processedCount: records.length + 1};
      }
      records.push({
        exchangeId: ref.exchange_id, targetId, model: row.model,
        ...(ref.provider_request_id ? {requestId: ref.provider_request_id} : {}),
        ...(ref.endpoint ? {endpoint: ref.endpoint} : {}),
        capturedAt: row.created_at, completedAt: ref.completed_at,
        inputTokens: row.input_tokens, cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens, outputTokens: row.output_tokens,
        actualCostNano, resultClass: row.result_class, usageSource: row.usage_source,
      });
    }
    return {amountNano, records, complete: true, limited: false,
      candidateCount: refs.length, processedCount: refs.length};
  }

  /**
   * 已证明的一对一请求采用站点记账小时，仅调整对账投影的归桶；
   * 该搬移不产生金钱补差，也不改变 usage_ledger.created_at。
   */
  comparableLocalHour(
    targetId: string, hourStartUtc: string,
    local: LocalHourSnapshot, currentMatches: readonly UsageMatch[],
  ): number | null {
    if (!local.complete || local.amountNano === null) return null;
    const start = hourMillis(hourStartUtc);
    const end = start + HOUR_MS;
    let amount = local.amountNano;
    const byLocalId = this.db.prepare(
      "SELECT hour_start_utc FROM relay_reconciliation_matches WHERE exchange_id=?",
    );
    for (const record of local.records) {
      const completed = Date.parse(record.completedAt);
      if (completed < start || completed >= end) continue;
      const matched = byLocalId.get(record.exchangeId) as {hour_start_utc: string} | undefined;
      if (matched && matched.hour_start_utc !== hourStartUtc) amount -= record.actualCostNano;
    }
    const existing = this.db.prepare(
      `SELECT m.exchange_id,m.local_amount_nano,e.completed_at
       FROM relay_reconciliation_matches m
       JOIN relay_local_usage_events e ON e.exchange_id=m.exchange_id
       WHERE m.target_id=? AND m.hour_start_utc=? LIMIT ?`,
    ).all(targetId, hourStartUtc, LOCAL_RECORD_LIMIT + 1) as Array<{
      exchange_id: string; local_amount_nano: number; completed_at: string;
    }>;
    if (existing.length > LOCAL_RECORD_LIMIT) return null;
    const known = new Set(existing.map(row => row.exchange_id));
    for (const row of existing) {
      const completed = Date.parse(row.completed_at);
      if (completed < start || completed >= end) amount += row.local_amount_nano;
    }
    for (const match of currentMatches) {
      if (known.has(match.local.exchangeId)) continue;
      const completed = Date.parse(match.local.completedAt);
      if (completed < start || completed >= end) amount += match.local.actualCostNano;
    }
    return Number.isSafeInteger(amount) ? amount : null;
  }

  /**
   * 活动驱动发现（2026-09-28 用户确认）：返回「since 之后有本地完成时刻事件、
   * 但还没有小时行」的整小时（有界近 48 小时窗口）。空小时零记录零站点流量。
   */
  missingActivityHours(targetId: string, sinceIso: string, limit = 60): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT substr(e.completed_at, 1, 13) AS bucket
       FROM relay_local_usage_events e
       WHERE e.target_id = ? AND e.completed_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM relay_reconciliation_hours h
           WHERE h.target_id = e.target_id
             AND h.hour_start_utc = substr(e.completed_at, 1, 13) || ':00:00.000Z')
       ORDER BY bucket ASC LIMIT ?`,
    ).all(targetId, sinceIso, Math.max(1, Math.min(60, limit))) as Array<{bucket: string}>;
    return rows.map(row => `${row.bucket}:00:00.000Z`);
  }

  /** 轻量复查命中（站点数据未变）时只推进检查时刻，不产生新观测。 */
  touchHourChecked(targetId: string, hourStartUtc: string, observedAt: string,
    reason?: string,
  ): void {
    hourMillis(hourStartUtc);
    this.db.prepare(
      `UPDATE relay_reconciliation_hours
       SET last_checked_at=?,updated_at=?
         ${reason !== undefined ? ",reason=?" : ""}
       WHERE target_id=? AND hour_start_utc=?`,
    ).run(...(reason !== undefined
      ? [observedAt, observedAt, reason.slice(0, 256), targetId, hourStartUtc]
      : [observedAt, observedAt, targetId, hourStartUtc]));
  }

  /** 查 Registrar 的目标+完成时刻 sidecar；无最大请求时长假设，也不扫描历史任务。 */
  hasPendingDerivation(targetId: string, hourStartUtc: string): boolean {
    const start = hourMillis(hourStartUtc);
    const scan = this.db.prepare(
      `SELECT s.worker_status AS status,s.last_source_scan_completed_at AS scanAt,
         lease.expires_at AS leaseUntil
       FROM schema_meta s LEFT JOIN worker_lease lease ON lease.id=1
       WHERE s.id=1`,
    ).get() as {
      status: string; scanAt: string | null; leaseUntil: string | null;
    } | undefined;
    // 只有活跃 Worker 已经在小时结束之后完整发现来源并推进 source，才可相信
    // “没有待派生 job”；未发现的新文件不能由 raw_exchange_refs/已登记行反证。
    // 水位按租约纪元单调（2026-09-29）：不再因批次进行中而清空，只校验
    // 租约有效、worker 状态健康、水位晚于小时结束且距今不超过新鲜度上限。
    if (!scan || !["idle", "running"].includes(scan.status)
      || !scan.leaseUntil || Date.parse(scan.leaseUntil) <= Date.now()
      || !scan.scanAt || Date.parse(scan.scanAt) < start + HOUR_MS
      || Date.now() - Date.parse(scan.scanAt) > SCAN_WATERMARK_MAX_AGE_MS) return true;
    return Boolean(this.db.prepare(
      `SELECT 1 FROM relay_pending_ingestions
       WHERE target_id=? AND completed_at>=? AND completed_at<? LIMIT 1`,
    ).get(targetId, new Date(start - 60_000).toISOString(),
      new Date(start + HOUR_MS + 60_000).toISOString()));
  }

  hasMatchedLocal(exchangeId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM relay_reconciliation_matches WHERE exchange_id=? LIMIT 1",
    ).get(exchangeId));
  }

  hasMatchedPair(targetId: string, provider: "sub2api" | "newapi",
    siteLogId: string, exchangeId: string): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM relay_reconciliation_matches
       WHERE target_id=? AND provider_type=? AND site_log_id=? AND exchange_id=? LIMIT 1`,
    ).get(targetId, provider, siteLogId, exchangeId));
  }

  /** 一轮最多八个；最近 48 小时的已定稿小时每小时复查迟到记录。退避中的目标整组跳过。 */
  dueHours(nowIso: string, limit = DUE_LIMIT): HourRow[] {
    const now = Date.parse(nowIso);
    if (!Number.isFinite(now)) return [];
    const cutoff = new Date(now - CLOSE_DELAY_MS).toISOString();
    const retryBefore = new Date(now - RETRY_INTERVAL_MS).toISOString();
    const bounded = Math.max(1, Math.min(DUE_LIMIT, Math.trunc(limit) || DUE_LIMIT));
    const notBackingOff = `NOT EXISTS(
      SELECT 1 FROM relay_site_backoff b
      WHERE b.target_id = relay_reconciliation_hours.target_id
        AND b.retry_after IS NOT NULL AND b.retry_after > ?)`;
    const pending = this.db.prepare(
      `SELECT * FROM relay_reconciliation_hours
       WHERE status IN ('pending', 'incomplete') AND hour_start_utc <= ?
         AND (last_checked_at IS NULL OR last_checked_at <= ?)
         AND ${notBackingOff}
       ORDER BY last_checked_at ASC, hour_start_utc ASC LIMIT ?`,
    ).all(cutoff, retryBefore, nowIso, bounded) as SqlHourRow[];
    if (pending.length >= bounded) return pending.map(rowToHour);
    const settled = this.db.prepare(
      `SELECT * FROM relay_reconciliation_hours
       WHERE status IN ('balanced','needs_review','applied','ignored')
         AND hour_start_utc >= ? AND hour_start_utc <= ?
         AND last_checked_at <= ?
         AND ${notBackingOff}
       ORDER BY hour_start_utc ASC LIMIT ?`,
    ).all(new Date(now - 48 * HOUR_MS).toISOString(), cutoff,
      new Date(now - HOUR_MS).toISOString(), nowIso, bounded - pending.length) as SqlHourRow[];
    return [...pending, ...settled].map(rowToHour);
  }

  /**
   * 站点取数结果记账：失败按目标指数退避（5→15→30→60 分钟封顶），
   * 成功一次即清零。登录失败与明细不完整同样计入，防止重试风暴自锁。
   */
  recordSiteOutcome(targetId: string, ok: boolean, reason: string, nowIso: string): void {
    if (ok) {
      this.db.prepare("DELETE FROM relay_site_backoff WHERE target_id=?").run(targetId);
      return;
    }
    const now = Date.parse(nowIso);
    if (!Number.isFinite(now)) return;
    const before = this.db.prepare(
      "SELECT fail_count FROM relay_site_backoff WHERE target_id=?",
    ).get(targetId) as {fail_count: number} | undefined;
    const count = (before?.fail_count ?? 0) + 1;
    const delay = SITE_BACKOFF_SCHEDULE_MS[
      Math.min(count, SITE_BACKOFF_SCHEDULE_MS.length) - 1];
    this.db.prepare(
      `INSERT INTO relay_site_backoff(
        target_id,fail_count,retry_after,last_error,updated_at
      ) VALUES(?,?,?,?,?)
      ON CONFLICT(target_id) DO UPDATE SET fail_count=excluded.fail_count,
        retry_after=excluded.retry_after,last_error=excluded.last_error,
        updated_at=excluded.updated_at`,
    ).run(targetId, count, new Date(now + delay).toISOString(),
      reason.slice(0, 256), nowIso);
  }

  siteBackoff(targetId: string): {failCount: number; retryAfter: string | null; lastError: string | null} | undefined {
    const row = this.db.prepare(
      "SELECT fail_count AS failCount,retry_after AS retryAfter,last_error AS lastError FROM relay_site_backoff WHERE target_id=?",
    ).get(targetId) as {failCount: number; retryAfter: string | null; lastError: string | null} | undefined;
    return row;
  }

  /**
   * 两次间隔至少一分钟的完整站点观测且本地投影已收敛，才给出可确认金额。
   * 不完整永远保留原因和候选量，不把部分响应显示为零消费。
   */
  observeHour(input: HourObservation): HourRow {
    const before = this.getHour(input.targetId, input.hourStartUtc);
    if (!before) throw new Error("RECONCILIATION_HOUR_NOT_FOUND");
    const siteTotalComplete = !input.limited
      || input.source === "newapi_stat" || input.source === "sub2api_trend";
    const complete = input.siteAmountNano !== null && siteTotalComplete && input.localComplete
      && input.localAmountNano !== null;
    const evidenceHash = input.siteEvidenceHash ?? JSON.stringify([
      input.source, input.siteAmountNano, input.candidateCount, input.processedCount,
    ]);
    const prevTime = before.lastSiteObservedAt ? Date.parse(before.lastSiteObservedAt) : NaN;
    const stableCount = !complete ? 0
      : before.siteAmountNano !== input.siteAmountNano
        || before.siteCandidateCount !== input.candidateCount
        || before.siteSource !== input.source
        || before.siteEvidenceHash !== evidenceHash
        ? 1
        : Date.parse(input.observedAt) - prevTime >= MIN_OBSERVATION_GAP_MS
          ? Math.min(2, before.stableCount + 1) : before.stableCount;
    const residual = complete
      ? input.siteAmountNano! - input.localAmountNano! - before.appliedAmountNano
      : null;
    const ignoredAndComparable = before.status === "ignored"
      && (input.siteAmountNano === null || input.siteAmountNano === before.siteAmountNano);
    const status: HourRow["status"] = ignoredAndComparable ? "ignored"
      : !complete ? "incomplete"
      : stableCount < 2 ? "pending"
        : residual !== null && residual === 0
            ? before.appliedAmountNano !== 0 ? "applied" : "balanced"
            : "needs_review";
    const ignoredReason = status === "ignored" ? before.ignoredReason : null;
    this.db.prepare(
      `UPDATE relay_reconciliation_hours SET
         status = ?, site_amount_nano = ?, site_evidence_hash = ?, site_light_check = ?,
         local_amount_nano = ?, residual_nano = ?,
         site_source = ?, site_candidate_count = ?, site_processed_count = ?,
         site_limited = ?, site_details_complete = ?,
         local_candidate_count = ?, local_processed_count = ?, local_limited = ?,
         matched_count = ?, unmatched_site_count = ?, stable_count = ?,
         last_site_observed_at = ?, last_checked_at = ?, reason = ?, ignored_reason = ?,
         updated_at = ?
       WHERE target_id = ? AND hour_start_utc = ?`,
    ).run(
      status, input.siteAmountNano, evidenceHash, input.siteLightCheck ?? null,
      input.localAmountNano, residual,
      input.source, input.candidateCount, input.processedCount,
      Number(input.limited), Number(input.detailsComplete),
      input.localCandidateCount, input.localProcessedCount, Number(!input.localComplete),
      input.matchedCount, input.unmatchedSiteCount, stableCount,
      complete ? input.observedAt : before.lastSiteObservedAt,
      input.observedAt, input.reason ?? null, ignoredReason, input.observedAt,
      input.targetId, input.hourStartUtc,
    );
    return this.getHour(input.targetId, input.hourStartUtc)!;
  }

  /**
   * 记录站点复核异常。已定稿状态不能因为临时网络/账号错误被降级，
   * 否则人工忽略或已经入账的事实会在下一轮静默消失。
   */
  recordObservationFailure(
    targetId: string,
    hourStartUtc: string,
    reason: string,
    observedAt: string,
  ): HourRow {
    const before = this.getHour(targetId, hourStartUtc);
    if (!before) throw new Error("RECONCILIATION_HOUR_NOT_FOUND");
    if (["ignored", "balanced", "applied"].includes(before.status)) {
      this.db.prepare(
        `UPDATE relay_reconciliation_hours
         SET last_checked_at=?,reason=?,updated_at=?
         WHERE target_id=? AND hour_start_utc=?`,
      ).run(observedAt, reason, observedAt, targetId, hourStartUtc);
      return this.getHour(targetId, hourStartUtc)!;
    }
    return this.observeHour({
      targetId, hourStartUtc,
      siteAmountNano: null, localAmountNano: null,
      candidateCount: 0, processedCount: 0, limited: false,
      detailsComplete: false, localComplete: false,
      localCandidateCount: 0, localProcessedCount: 0,
      matchedCount: 0, unmatchedSiteCount: 0,
      source: `${before.providerType}_usage`,
      observedAt, reason,
    });
  }

  /** 匹配事实和补差在同一事务提交；同一站点 ID 不能换本地归属或覆盖旧金额。 */
  applyMatches(targetId: string, hourStartUtc: string, matches: readonly UsageMatch[]): number {
    hourMillis(hourStartUtc);
    if (matches.length > LOCAL_RECORD_LIMIT) throw new Error("RECONCILIATION_MATCH_LIMITED");
    return this.db.transaction(() => {
      const hour = this.getHour(targetId, hourStartUtc);
      if (!hour || hour.stableCount < 2 || !hour.siteDetailsComplete
        || hour.siteLimited || hour.localLimited
        || !["needs_review", "balanced", "applied"].includes(hour.status)) {
        throw new Error("RECONCILIATION_HOUR_NOT_VERIFIED");
      }
      const seenSite = new Set<string>();
      const seenLocal = new Set<string>();
      let inserted = 0;
      let applied = hour.appliedAmountNano;
      for (const match of matches) {
        const {site, local} = match;
        if (local.targetId !== targetId
          || Date.parse(site.completedAt) < Date.parse(hourStartUtc)
          || Date.parse(site.completedAt) >= Date.parse(hourStartUtc) + HOUR_MS
          || !Number.isSafeInteger(match.deltaNano)
          || site.amountNano - local.actualCostNano !== match.deltaNano
          || (site.siteDiscountNano !== undefined && !Number.isSafeInteger(site.siteDiscountNano))
          || seenSite.has(site.siteLogId) || seenLocal.has(local.exchangeId)) {
          throw new Error("RECONCILIATION_MATCH_INVALID");
        }
        seenSite.add(site.siteLogId);
        seenLocal.add(local.exchangeId);
        const existing = this.db.prepare(
          `SELECT exchange_id,hour_start_utc,site_amount_nano,local_amount_nano,revision
           FROM relay_reconciliation_matches WHERE target_id=? AND provider_type=? AND site_log_id=?`,
        ).get(targetId, hour.providerType, site.siteLogId) as {
          exchange_id: string; hour_start_utc: string;
          site_amount_nano: number; local_amount_nano: number; revision: number;
        } | undefined;
        if (existing) {
          if (existing.exchange_id !== local.exchangeId
            || existing.hour_start_utc !== hourStartUtc
            || existing.local_amount_nano !== local.actualCostNano) {
            throw new Error("RECONCILIATION_MATCH_CHANGED");
          }
          const change = site.amountNano - existing.site_amount_nano;
          if (change !== 0) {
            insertReconciliationAdjustment(this.db, {
              targetId, provider: hour.providerType, source: "matched",
              uniqueKey: `${site.siteLogId}:revision:${existing.revision + 1}`,
              localExchangeId: local.exchangeId,
              amountNano: change, occurredAt: site.completedAt, hourStartUtc,
            });
            this.db.prepare(
              `UPDATE relay_reconciliation_matches
               SET site_amount_nano=?,adjustment_nano=?,site_discount_nano=?,revision=revision+1
               WHERE target_id=? AND provider_type=? AND site_log_id=?`,
            ).run(site.amountNano, match.deltaNano, site.siteDiscountNano ?? null,
              targetId, hour.providerType, site.siteLogId);
            applied += change;
            inserted++;
          }
          continue;
        }
        // 小时残差已经由人工补过；新发现的归属只能留作复核，不能叠加第二笔自动价差。
        // 此前已登记的逐条匹配仍能按站点改价追加正负更正。
        if (hour.manualRevision > 0) {
          throw new Error("RECONCILIATION_MANUAL_MATCH_REQUIRES_REVIEW");
        }
        const usage = siteUsageEvidence(match);
        const adjustmentExchangeId = match.deltaNano !== 0
          ? insertReconciliationAdjustment(this.db, {
            targetId, provider: hour.providerType, source: "matched",
            uniqueKey: site.siteLogId, localExchangeId: local.exchangeId,
            amountNano: match.deltaNano, occurredAt: site.completedAt, hourStartUtc,
            usage,
          }) : null;
        this.db.prepare(
          `INSERT INTO relay_reconciliation_matches(
            target_id,hour_start_utc,provider_type,site_log_id,exchange_id,
            confidence,site_amount_nano,local_amount_nano,adjustment_nano,
            adjustment_exchange_id,site_discount_nano,created_at,
            usage_carrier,site_input_tokens,site_cache_read_tokens,
            site_cache_write_tokens,site_output_tokens,site_duration_ms
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(targetId, hourStartUtc, hour.providerType, site.siteLogId,
          local.exchangeId, match.confidence, site.amountNano, local.actualCostNano,
          match.deltaNano, adjustmentExchangeId, site.siteDiscountNano ?? null,
          new Date().toISOString(),
          usage !== undefined && adjustmentExchangeId !== null ? 1 : 0,
          site.inputTokens ?? null, site.cacheReadTokens ?? null,
          site.cacheWriteTokens ?? null, site.outputTokens ?? null,
          site.durationMs ?? null);
        const localHourStart = new Date(
          Math.floor(Date.parse(local.completedAt) / HOUR_MS) * HOUR_MS,
        ).toISOString();
        if (localHourStart !== hourStartUtc) {
          this.db.prepare(
            `UPDATE relay_reconciliation_hours SET
               status=CASE WHEN status IN ('applied','ignored') THEN 'incomplete' ELSE 'pending' END,
               stable_count=0,last_checked_at=NULL,
               reason='跨小时请求已归属站点结算小时，需重新复核本小时',
               updated_at=?
             WHERE target_id=? AND hour_start_utc=?`,
          ).run(new Date().toISOString(), targetId, localHourStart);
        }
        applied += match.deltaNano;
        inserted++;
      }
      const residual = hour.siteAmountNano! - hour.localAmountNano! - applied;
      this.db.prepare(
        `UPDATE relay_reconciliation_hours SET applied_amount_nano=?,residual_nano=?,
           status=?,updated_at=? WHERE target_id=? AND hour_start_utc=?`,
      ).run(applied, residual,
        residual === 0
          ? applied === 0 ? "balanced" : "applied" : "needs_review",
        new Date().toISOString(), targetId, hourStartUtc);
      return inserted;
    })();
  }

  /**
   * 小时残差自动补（2026-09-28 用户确认，取代「小时未解释残差不自动补」）：
   * 两轮稳定、站点逐条明细完整且未截断、密钥 scope 已验证（调用方判定）、本地无缺口、
   * 残差为正且满足恒等式 `残差 = 未匹配站点行金额之和 − 已残差补偿额`（本地未匹配行
   * 金额为零）时，把小时残差自动落为 `recon:residual:` 补差行。已补偿过的站点行在
   * 重开后的新一轮匹配里仍是 unmatched，故必须扣除 residual_applied_nano。
   * 负残差、人工补过、超过上限的一律留人工。
   * 事务内重新核对本地快照与待派生状态，防判定与落账之间的竞态。
   */
  applyResidual(targetId: string, hourStartUtc: string, input: {
    expectedResidualNano: number;
    unmatchedSiteSumNano: number;
    fxRateToCny?: number;
  }): number {
    hourMillis(hourStartUtc);
    return this.db.transaction(() => {
      const hour = this.getHour(targetId, hourStartUtc);
      if (!hour || hour.status !== "needs_review" || hour.stableCount < 2
        || !hour.siteDetailsComplete || hour.siteLimited || hour.localLimited
        || hour.manualRevision > 0
        || hour.residualNano === null || hour.residualNano <= 0
        || !Number.isSafeInteger(input.unmatchedSiteSumNano)
        || hour.residualNano !== input.expectedResidualNano
        || hour.residualNano !== input.unmatchedSiteSumNano - hour.residualAppliedNano
        || hour.residualNano > RESIDUAL_AUTO_APPLY_MAX_NANO) {
        throw new Error("RECONCILIATION_RESIDUAL_NOT_ELIGIBLE");
      }
      const currentLocal = this.loadLocalHour(targetId, hourStartUtc);
      const comparable = this.comparableLocalHour(targetId, hourStartUtc, currentLocal, []);
      if (!currentLocal.complete || comparable !== hour.localAmountNano
        || this.hasPendingDerivation(targetId, hourStartUtc)) {
        throw new Error("RECONCILIATION_SNAPSHOT_CHANGED");
      }
      insertReconciliationAdjustment(this.db, {
        targetId, provider: hour.providerType, source: "residual",
        uniqueKey: `${hourStartUtc}:residual:${hour.residualRevision + 1}`,
        amountNano: hour.residualNano,
        occurredAt: hourStartUtc, hourStartUtc,
        fxRateToCny: input.fxRateToCny ?? 1,
      });
      this.db.prepare(
        `UPDATE relay_reconciliation_hours SET status='applied',
           applied_amount_nano=applied_amount_nano+?,residual_nano=0,
           residual_revision=residual_revision+1,
           residual_applied_nano=residual_applied_nano+?,updated_at=?
         WHERE target_id=? AND hour_start_utc=?`,
      ).run(hour.residualNano, hour.residualNano,
        new Date().toISOString(), targetId, hourStartUtc);
      return hour.residualNano;
    })();
  }

  /** 人工确认写当前剩余净额；调用方须在同一次请求中重新读取站点并校验快照。 */
  applyManual(
    targetId: string, hourStartUtc: string,
    expectedResidualNano: number, expectedLastCheckedAt: string,
    fxRateToCny = 1,
  ): number {
    hourMillis(hourStartUtc);
    return this.db.transaction(() => {
      const hour = this.getHour(targetId, hourStartUtc);
      if (hour?.siteLimited && hour.siteSource === "sub2api_trend") {
        throw new Error("RECONCILIATION_SOURCE_INCOMPLETE");
      }
      if (!hour || hour.status !== "needs_review" || hour.stableCount < 2
        || hour.siteAmountNano === null || hour.localAmountNano === null
        || hour.siteLimited
          && hour.siteSource !== "newapi_stat"
        || hour.localLimited || hour.residualNano === null
        || hour.residualNano === 0) {
        throw new Error("RECONCILIATION_HOUR_NOT_PENDING");
      }
      if (hour.residualNano !== expectedResidualNano
        || hour.lastCheckedAt !== expectedLastCheckedAt) {
        throw new Error("RECONCILIATION_SNAPSHOT_CHANGED");
      }
      const currentLocal = this.loadLocalHour(targetId, hourStartUtc);
      const comparable = this.comparableLocalHour(targetId, hourStartUtc, currentLocal, []);
      if (!currentLocal.complete || comparable !== hour.localAmountNano
        || this.hasPendingDerivation(targetId, hourStartUtc)) {
        throw new Error("RECONCILIATION_SNAPSHOT_CHANGED");
      }
      insertReconciliationAdjustment(this.db, {
        targetId, provider: hour.providerType, source: "manual",
        uniqueKey: `${hourStartUtc}:revision:${hour.manualRevision + 1}`,
        amountNano: hour.residualNano,
        occurredAt: hourStartUtc, hourStartUtc,
        fxRateToCny,
      });
      this.db.prepare(
        `UPDATE relay_reconciliation_hours SET status='applied',
          applied_amount_nano=applied_amount_nano+?,manual_revision=manual_revision+1,
          residual_nano=0,
          updated_at=? WHERE target_id=? AND hour_start_utc=?`,
      ).run(hour.residualNano, new Date().toISOString(), targetId, hourStartUtc);
      return hour.residualNano!;
    })();
  }

  /** 忽略只变更审核状态，不写补差；站点金额变化时下次复核会重新打开。 */
  ignoreHour(targetId: string, hourStartUtc: string, reason: string): void {
    hourMillis(hourStartUtc);
    const normalized = reason.trim();
    if (normalized.length < 4 || normalized.length > 512) throw new Error("RECONCILIATION_REASON_INVALID");
    const result = this.db.prepare(
      `UPDATE relay_reconciliation_hours SET status='ignored',ignored_reason=?,
         updated_at=? WHERE target_id=? AND hour_start_utc=? AND status='needs_review'`,
    ).run(normalized, new Date().toISOString(), targetId, hourStartUtc);
    if (result.changes !== 1) throw new Error("RECONCILIATION_HOUR_NOT_PENDING");
  }
}
