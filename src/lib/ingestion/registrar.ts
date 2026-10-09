import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { RawBodyAvailability, RawBodyStorage } from "../db/models";
import type { RawCapturedExchangeV2 } from "../harness/types";
import { isBeyondRetentionWindow } from "../retention";
import {
  advanceSourceCursor,
  type SourceCursorAdvance,
  type SourceRecord,
} from "./raw-source-reader";
import { assertWorkerLease } from "./worker-lease";

export interface RegisterRawRecordInput {
  sourceId: number;
  sourceRelativePath: string;
  sourceFileId: string;
  sourceGeneration: number;
  record: SourceRecord;
  cursor: SourceCursorAdvance;
  leaseOwnerId: string;
  projectionVersion: number;
  /** 保留窗口截止时刻；captured_at 早于该值的行登记为 archived 且不创建派生 job。 */
  retentionCutoff?: string;
  now?: string;
}

export interface RegisterRawRecordResult {
  ingestionRecordId: number;
  taskCreated: boolean;
  duplicateExchange: boolean;
  archived: boolean;
}

interface RegisteredLocatorRow {
  id: number;
  source_id: number;
  source_generation: number;
  byte_offset: number;
}

/**
 * 登记记录、创建当前派生任务和推进 source 游标必须共享一个同步事务。
 * 事务成功后业务派生可以独立失败或恢复，而不会丢失已经发现的 Raw 行。
 */
export function registerRawRecordAndAdvance(
  db: DeepaaDatabase,
  input: RegisterRawRecordInput,
): RegisterRawRecordResult {
  assertInput(input);
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    assertLease(db, input.leaseOwnerId, now);
    const exchange = input.record.exchange;
    const request = bodyRegistration(exchange, "request");
    const response = bodyRegistration(exchange, "response");
    // 30 天投影窗口（决策 D1）：超窗行只登记哈希与定位（很便宜），标记 archived、
    // 不创建派生 job——登记无界、投影有界，NOT EXISTS 头部阻塞只看存在的 job，
    // 因此跳过不产生连锁阻塞。
    const archived = input.retentionCutoff !== undefined
      && isBeyondRetentionWindow(exchange.capturedAt, input.retentionCutoff);
    const inserted = db.prepare(
      `INSERT INTO ingestion_records(
        exchange_id, source_id, source_generation, source_file_id,
        byte_offset, line_length_bytes, line_sha256, schema_version,
        captured_at, completed_at, request_body_bytes, response_body_bytes,
        request_body_sha256, response_body_sha256,
        request_body_storage, response_body_storage,
        request_body_state, response_body_state, registered_at, projection_state
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange_id) DO NOTHING`,
    ).run(
      exchange.exchangeId,
      input.sourceId,
      input.sourceGeneration,
      input.sourceFileId,
      input.record.byteOffset,
      input.record.lineLengthBytes,
      input.record.lineSha256,
      exchange.schemaVersion,
      exchange.capturedAt,
      exchange.completedAt,
      exchange.request.bodySizeBytes,
      exchange.response.bodySizeBytes,
      exchange.request.bodySha256,
      exchange.response.bodySha256,
      request.storage,
      response.storage,
      request.state,
      response.state,
      now,
      archived ? "archived" : "active",
    );
    const locator = db.prepare(
      `SELECT id, source_id, source_generation, byte_offset
       FROM ingestion_records WHERE exchange_id = ?`,
    ).get(exchange.exchangeId) as RegisteredLocatorRow | undefined;
    if (!locator) {
      throw new Error(`Raw 登记提交后无法定位 Exchange ${exchange.exchangeId}。`);
    }
    const duplicateExchange = inserted.changes === 0;
    if (duplicateExchange && !sameLocator(locator, input)) {
      writeDuplicateDiagnostic(db, input, exchange, now);
    }
    // source 数据新近度：驱动派生「文件级最新优先」排序（决策 D4）。
    db.prepare(
      `UPDATE ingestion_sources
       SET last_captured_at = CASE
         WHEN last_captured_at IS NULL OR last_captured_at < ? THEN ?
         ELSE last_captured_at
       END
       WHERE id = ?`,
    ).run(exchange.capturedAt, exchange.capturedAt, input.sourceId);
    const task = archived
      ? undefined
      : db.prepare(
        `INSERT INTO derivation_jobs(
          ingestion_record_id, projection_version, job_status, attempt_count,
          available_at, request_verification, response_verification,
          created_at, updated_at
        ) VALUES(?, ?, 'pending', 0, ?, 'pending', 'pending', ?, ?)
        ON CONFLICT(ingestion_record_id, projection_version) DO NOTHING`,
      ).run(locator.id, input.projectionVersion, now, now, now);
    // 新建按量中转站请求在 Registrar 阶段即写最小完成时间标记。
    // raw_exchange_refs 直到派生成功才出现，不能用它判断待派生请求是否缺席；
    // 与 source 游标、job 创建同事务，失败时一起回滚。
    if (!archived && inserted.changes === 1
      && exchange.routing.origin !== "agent_local_import"
      && db.prepare(
        `SELECT 1 FROM console_accounts WHERE target_id=?
         AND provider_type IN ('relay','sub2api','newapi') LIMIT 1`,
      ).get(exchange.routing.targetId)) {
      db.prepare(
        `INSERT INTO relay_pending_ingestions(exchange_id,target_id,completed_at)
         VALUES(?,?,?) ON CONFLICT(exchange_id) DO NOTHING`,
      ).run(exchange.exchangeId, exchange.routing.targetId, exchange.completedAt);
    }
    advanceSourceCursor(db, input.cursor);
    return {
      ingestionRecordId: locator.id,
      taskCreated: task?.changes === 1,
      duplicateExchange,
      archived,
    };
  })();
}

function bodyRegistration(
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
): { storage: RawBodyStorage; state: RawBodyAvailability } {
  const body = exchange[side];
  if (body.bodySizeBytes === 0) {
    return { storage: body.rawBodyRef?.storage ?? "none", state: "empty" };
  }
  const storage = body.rawBodyRef?.storage
    ?? (typeof body.rawBody === "string" ? "inline" : "none");
  if (storage !== "none") return { storage, state: "available" };
  const missingDeclared = exchange.captureDiagnostics.some(
    diagnostic => diagnostic.code === "missing_raw_body",
  );
  if (!missingDeclared) {
    throw new Error(`${side} 声明了非空正文但没有 Raw 内容或 missing_raw_body 诊断。`);
  }
  return { storage, state: "missing_declared" };
}

function sameLocator(
  row: RegisteredLocatorRow,
  input: RegisterRawRecordInput,
): boolean {
  return row.source_id === input.sourceId
    && row.source_generation === input.sourceGeneration
    && row.byte_offset === input.record.byteOffset;
}

function writeDuplicateDiagnostic(
  db: DeepaaDatabase,
  input: RegisterRawRecordInput,
  exchange: RawCapturedExchangeV2,
  now: string,
): void {
  const detailsJson = JSON.stringify({
    sourceId: input.sourceId,
    sourceGeneration: input.sourceGeneration,
    byteOffset: input.record.byteOffset,
    lineLengthBytes: input.record.lineLengthBytes,
  });
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, code, severity, message, details_json, created_at
    ) SELECT ?, ?, 'duplicate_exchange_id', 'warning', ?, ?, ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE exchange_id = ? AND source_id = ?
        AND code = 'duplicate_exchange_id' AND details_json = ?
    )`,
  ).run(
    exchange.exchangeId,
    input.sourceId,
    "相同 exchangeId 已在另一 Raw 位置登记，本行已明确拒绝。",
    detailsJson,
    now,
    exchange.exchangeId,
    input.sourceId,
    detailsJson,
  );
}

function assertInput(input: RegisterRawRecordInput): void {
  if (
    input.cursor.sourceId !== input.sourceId
    || input.cursor.relativePath !== input.sourceRelativePath
    || input.cursor.fileId !== input.sourceFileId
    || input.cursor.generation !== input.sourceGeneration
    || input.cursor.expectedByteOffset !== input.record.byteOffset
    || input.cursor.nextByteOffset
      !== input.record.byteOffset + input.record.lineLengthBytes
  ) {
    throw new Error("Raw 登记位置与 source 游标不一致。");
  }
  if (!Number.isSafeInteger(input.projectionVersion) || input.projectionVersion < 1) {
    throw new Error("projectionVersion 必须是正安全整数。");
  }
}

function assertLease(
  db: DeepaaDatabase,
  ownerId: string,
  now: string,
): void {
  assertWorkerLease(db, ownerId, now);
}
