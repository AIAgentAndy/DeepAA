/**
 * 导入进度状态（agent_local_import_state 表）：per-agent 游标水位、floor 重置与
 * 跳过计数、诊断与运行统计。CAS 语义由单写者调度器（web 侧单飞）保证；
 * Worker 对合成文件的消费进度仍走既有 ingestion_sources，两层游标各管一段。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {LocalImportCursor} from "./types";
import {LOCAL_IMPORT_LOOKBACK_DAYS_MS, SEEN_RETENTION_MARGIN_MS} from "./windows";

export interface LocalImportStateRow {
  agentName: string;
  lastStartedAt?: number;
  lastRecordId?: string;
  /** 历史倒序回补游标（两阶段水位，2026-09-16）。 */
  backfillLastCompletedAt?: number;
  backfillLastRecordId?: string;
  /** 回补完成时刻（非空 = 阶段二已收尾，仅阶段一运行）。 */
  backfillFinishedAt?: string;
  cursorResetCount: number;
  skippedOlderThanWindow: number;
  skippedModelNotProvisioned: number;
  localSchemaVersion?: string;
  consecutiveFailures: number;
  lastError?: string;
  importedCount: number;
  lastSuccessAt?: string;
  lastRunStartedAt?: string;
  lastRunDurationMs?: number;
  lastRunCount?: number;
  updatedAt: string;
}

const COLUMNS = `agent_name, last_started_at, last_record_id,
  backfill_last_completed_at, backfill_last_record_id, backfill_finished_at, cursor_reset_count,
  skipped_older_than_window, skipped_model_not_provisioned, local_schema_version,
  consecutive_failures, last_error, imported_count, last_success_at,
  last_run_started_at, last_run_duration_ms, last_run_count, updated_at`;

export function readImportState(db: DeepaaDatabase, agentId: string): LocalImportStateRow | undefined {
  const row = db.prepare(
    `SELECT ${COLUMNS} FROM agent_local_import_state WHERE agent_name = ?`,
  ).get(agentId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    agentName: row.agent_name as string,
    ...(row.last_started_at !== null && row.last_started_at !== undefined
      ? {lastStartedAt: row.last_started_at as number} : {}),
    ...(row.last_record_id !== null && row.last_record_id !== undefined
      ? {lastRecordId: row.last_record_id as string} : {}),
    ...(row.backfill_last_completed_at !== null && row.backfill_last_completed_at !== undefined
      ? {backfillLastCompletedAt: row.backfill_last_completed_at as number} : {}),
    ...(row.backfill_last_record_id !== null && row.backfill_last_record_id !== undefined
      ? {backfillLastRecordId: row.backfill_last_record_id as string} : {}),
    ...(row.backfill_finished_at !== null && row.backfill_finished_at !== undefined
      ? {backfillFinishedAt: row.backfill_finished_at as string} : {}),
    cursorResetCount: (row.cursor_reset_count as number) ?? 0,
    skippedOlderThanWindow: (row.skipped_older_than_window as number) ?? 0,
    skippedModelNotProvisioned: (row.skipped_model_not_provisioned as number) ?? 0,
    ...(row.local_schema_version ? {localSchemaVersion: row.local_schema_version as string} : {}),
    consecutiveFailures: (row.consecutive_failures as number) ?? 0,
    ...(row.last_error ? {lastError: row.last_error as string} : {}),
    importedCount: (row.imported_count as number) ?? 0,
    ...(row.last_success_at ? {lastSuccessAt: row.last_success_at as string} : {}),
    ...(row.last_run_started_at ? {lastRunStartedAt: row.last_run_started_at as string} : {}),
    ...(row.last_run_duration_ms !== null && row.last_run_duration_ms !== undefined
      ? {lastRunDurationMs: row.last_run_duration_ms as number} : {}),
    ...(row.last_run_count !== null && row.last_run_count !== undefined
      ? {lastRunCount: row.last_run_count as number} : {}),
    updatedAt: row.updated_at as string,
  };
}

export function readCursor(db: DeepaaDatabase, agentId: string): LocalImportCursor {
  const state = readImportState(db, agentId);
  return {
    ...(state?.lastStartedAt !== undefined ? {lastStartedAt: state.lastStartedAt} : {}),
    ...(state?.lastRecordId !== undefined ? {lastId: state.lastRecordId} : {}),
  };
}

export interface ImportStateUpdate {
  agentId: string;
  /** 本批最大 (completed_at, id)；批为空时不推进。 */
  cursor?: LocalImportCursor;
  /**
   * 待导入队列收尾标记（2026-09-16）：true = 30 天窗口内候选全部导入完成；
   * false = 存在待导入候选（标记清除，新行到达自动重新进入回补）。无条件写入。
   */
  pendingSettled?: boolean;
  cursorResetDelta?: number;
  skippedOlderThanWindowDelta?: number;
  skippedModelNotProvisionedDelta?: number;
  localSchemaVersion?: string;
  /** 本轮成败；成功清零连续失败计数，失败自增并记录错误摘要。 */
  outcome: "success" | "failure";
  errorSummary?: string;
  importedCountDelta?: number;
  runDurationMs?: number;
  runCount?: number;
}

export function updateImportState(db: DeepaaDatabase, update: ImportStateUpdate): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_local_import_state(
      agent_name, last_started_at, last_record_id,
      backfill_finished_at,
      cursor_reset_count,
      skipped_older_than_window, skipped_model_not_provisioned, local_schema_version,
      consecutive_failures, last_error, imported_count, last_success_at,
      last_run_started_at, last_run_duration_ms, last_run_count, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name) DO UPDATE SET
      last_started_at = COALESCE(excluded.last_started_at, last_started_at),
      last_record_id = COALESCE(excluded.last_record_id, last_record_id),
      backfill_finished_at = excluded.backfill_finished_at,
      cursor_reset_count = cursor_reset_count + excluded.cursor_reset_count,
      skipped_older_than_window = skipped_older_than_window + excluded.skipped_older_than_window,
      skipped_model_not_provisioned = skipped_model_not_provisioned + excluded.skipped_model_not_provisioned,
      local_schema_version = COALESCE(excluded.local_schema_version, local_schema_version),
      consecutive_failures = CASE
        WHEN excluded.consecutive_failures = 0 THEN 0
        ELSE consecutive_failures + 1
      END,
      last_error = excluded.last_error,
      imported_count = imported_count + excluded.imported_count,
      last_success_at = COALESCE(excluded.last_success_at, last_success_at),
      last_run_started_at = excluded.last_run_started_at,
      last_run_duration_ms = excluded.last_run_duration_ms,
      last_run_count = excluded.last_run_count,
      updated_at = excluded.updated_at`,
  ).run(
    update.agentId,
    update.cursor?.lastStartedAt ?? null,
    update.cursor?.lastId ?? null,
    update.pendingSettled === true ? now : null,
    update.cursorResetDelta ?? 0,
    update.skippedOlderThanWindowDelta ?? 0,
    update.skippedModelNotProvisionedDelta ?? 0,
    update.localSchemaVersion ?? null,
    update.outcome === "success" ? 0 : 1,
    update.outcome === "failure" ? (update.errorSummary ?? "unknown").slice(0, 512) : null,
    update.importedCountDelta ?? 0,
    update.outcome === "success" ? now : null,
    now,
    update.runDurationMs ?? null,
    update.runCount ?? null,
    now,
  );
}

/**
 * seen 表有界清理（2026-10-05 D2，用户确认）：只删 imported_at 早于「回看窗口 +
 * 5 天余量」的行，单次删除 ≤ maxRows（默认 1000）。安全性：completed_at ≤
 * imported_at（导入发生在完成之后），被删行对应候选必然已早于窗口下界、不可能
 * 重新成为候选——幂等反联不受影响。返回实际删除行数（0 = 无过期行）。
 */
export function pruneAgentLocalImportSeen(
  db: DeepaaDatabase,
  options: {nowMs: number; maxRows?: number},
): number {
  const cutoff = new Date(options.nowMs - LOCAL_IMPORT_LOOKBACK_DAYS_MS - SEEN_RETENTION_MARGIN_MS).toISOString();
  const maxRows = options.maxRows ?? 1_000;
  const expired = db.prepare(
    "SELECT exchange_id FROM agent_local_import_seen WHERE imported_at < ? LIMIT ?",
  ).all(cutoff, maxRows) as Array<{exchange_id: string}>;
  if (expired.length === 0) return 0;
  return db.prepare(
    `DELETE FROM agent_local_import_seen WHERE exchange_id IN (${expired.map(() => "?").join(", ")})`,
  ).run(...expired.map(row => row.exchange_id)).changes;
}
