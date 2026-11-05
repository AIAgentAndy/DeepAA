/**
 * OOM 修复 C-2（2026-11-05）：codex rollout 解析前沿与记录索引的 SQLite 持久化。
 *
 * 动机：解析态（offset/records/usage/timing）此前 100% 在进程内存（caches Map），
 * 重启后 readPendingBatch 从 offset 0 重扫全部活跃文件——96-124MB 文件冷解析
 * ~32 秒，且追平后首批 readExchangeDetail 的全量 items 重建是生产 OOM 的触发链。
 *
 * 职责（单一）：
 * - persist：扫描轮末把每个 cache 的前沿 + 新增记录批量 upsert（短命连接、
 *   幂等 ON CONFLICT；随 seen 同款有界语义——records 由调用方窗口裁剪）。
 * - restore：进程内存 miss 时按 fileKey 恢复 offset/records/recordDetails/
 *   itemCount/sessionId（sessionMeta 从文件头有界重读 ≤64KiB，只找 session_meta 行）。
 * 签名守卫与 ingestion_sources 同构：文件 mtime/size 变化不影响恢复正确性
 * （append-only 续析），size < offset（截短/轮转）由调用方走既有重置路径。
 */

import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {openDeepaaDatabase} from "@/lib/db/connection";

/** 恢复出来的扫描态（喂回 RolloutFileCache 的最小字段）。 */
export interface RestoredRolloutState {
  offset: number;
  itemCount: number;
  sessionId?: string;
  /** [record] 供回填 cache.records / recordDetails 的持久行。 */
  records: Array<{
    id: string;
    sessionId: string;
    turnId?: string;
    providerId: string;
    modelId: string;
    startedAt: number;
    completedAt?: number;
    firstTokenMs?: number;
    durationMs?: number;
    usage: unknown;
    contextEnd: number;
    itemCount: number;
    outputIndices: number[];
    anchorOffset: number;
    capturedAt: string;
  }>;
  /** session_meta 头部有界重读(缺失 undefined;审计 R8 补齐附属字段)。 */
  baseInstructions?: string;
  modelProvider?: string;
  cliVersion?: string;
  source?: string;
  threadSource?: string;
}

export function openRolloutStateDb(dataDir: string): DeepaaDatabase | undefined {
  try {
    return openDeepaaDatabase({dataDir});
  } catch {
    return undefined;
  }
}

import {openSync, readSync, fstatSync, closeSync} from "node:fs";

function readSessionMetaHead(path: string, maxBytes = 64 * 1024): Pick<RestoredRolloutState, "baseInstructions" | "modelProvider" | "cliVersion" | "source" | "threadSource"> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    // session_meta 是首条数据行;在头部窗口内按行找(不整段 JSON.parse)。
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          type?: string;
          payload?: {base_instructions?: string; model_provider?: string};
        };
        if (parsed.type === "session_meta" && parsed.payload) {
          const payload = parsed.payload as Record<string, unknown>;
          return {
            ...(typeof payload.base_instructions === "string"
              ? {baseInstructions: payload.base_instructions}
              : {}),
            ...(typeof payload.model_provider === "string"
              ? {modelProvider: payload.model_provider}
              : {}),
            ...(typeof payload.cli_version === "string" ? {cliVersion: payload.cli_version} : {}),
            ...(typeof payload.source === "string" ? {source: payload.source} : {}),
            ...(typeof payload.thread_source === "string" ? {threadSource: payload.thread_source} : {}),
          };
        }
      } catch {
        // 半行/坏行跳过。
      }
    }
    return {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 关闭失败忽略。 */ }
    }
  }
}

/** 按 fileKey 恢复扫描态;无持久前沿返回 undefined。 */
export function restoreRolloutState(
  db: DeepaaDatabase,
  fileKey: string,
  path: string,
): RestoredRolloutState | undefined {
  const frontier = db.prepare(
    `SELECT offset, item_count, session_id FROM agent_local_import_rollout_files
     WHERE agent = 'codex' AND file_key = ? LIMIT 1`,
  ).get(fileKey) as {offset: number; item_count: number; session_id: string | null} | undefined;
  if (!frontier || frontier.offset <= 0) return undefined;
  const recordRows = db.prepare(
    `SELECT record_id, session_id, turn_id, provider_id, model_id, started_at, completed_at,
            first_token_ms, duration_ms, usage_json, context_end, item_count,
            output_indices_json, anchor_offset, captured_at
     FROM agent_local_import_records
     WHERE agent = 'codex' AND record_id LIKE ? ESCAPE '\\'
     ORDER BY captured_at, record_id LIMIT 10000`,
  ).all(`${fileKey.replace(/[%_\\]/g, m => `\\${m}`)}:%`) as Array<{
    record_id: string; session_id: string | null; turn_id: string | null;
    provider_id: string | null; model_id: string | null; started_at: number | null;
    completed_at: number | null; first_token_ms: number | null; duration_ms: number | null;
    usage_json: string; context_end: number; item_count: number;
    output_indices_json: string; anchor_offset: number; captured_at: string;
  }>;
  const meta = readSessionMetaHead(path);
  return {
    offset: frontier.offset,
    itemCount: frontier.item_count,
    ...(frontier.session_id ? {sessionId: frontier.session_id} : {}),
    records: recordRows.map(row => ({
      id: row.record_id,
      sessionId: row.session_id ?? "",
      ...(row.turn_id ? {turnId: row.turn_id} : {}),
      providerId: row.provider_id ?? "",
      modelId: row.model_id ?? "",
      startedAt: row.started_at ?? 0,
      completedAt: row.completed_at ?? row.started_at ?? 0,
      ...(row.first_token_ms !== null && row.first_token_ms !== undefined ? {firstTokenMs: row.first_token_ms} : {}),
      ...(row.duration_ms !== null && row.duration_ms !== undefined ? {durationMs: row.duration_ms} : {}),
      usage: safeParse<Record<string, number | undefined>>(row.usage_json, {}),
      contextEnd: row.context_end,
      itemCount: row.item_count,
      outputIndices: safeParse<number[]>(row.output_indices_json, []),
      anchorOffset: row.anchor_offset,
      capturedAt: row.captured_at,
    })),
    ...meta,
  };
}

/** 扫描轮末持久化单文件前沿 + 该文件全部记录(幂等 upsert,单事务)。 */
export function persistRolloutFrontier(db: DeepaaDatabase, input: {
  fileKey: string;
  path: string;
  mtimeMs: number;
  size: number;
  offset: number;
  itemCount: number;
  sessionId?: string;
  lastActivityMs: number;
  records: ReadonlyArray<{
    id: string;
    sessionId: string;
    turnId?: string;
    providerId: string;
    modelId: string;
    startedAt: number;
    completedAt?: number;
    firstTokenMs?: number;
    durationMs?: number;
    usage: unknown;
    contextEnd: number;
    itemCount: number;
    outputIndices: readonly number[];
    anchorOffset: number;
    capturedAt: string;
  }>;
}): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_local_import_rollout_files(
        agent, file_key, path, mtime_ms, size_bytes, offset, item_count, session_id, last_activity_ms, updated_at
      ) VALUES('codex', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, file_key) DO UPDATE SET
        path = excluded.path, mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes,
        offset = excluded.offset, item_count = excluded.item_count, session_id = excluded.session_id,
        last_activity_ms = excluded.last_activity_ms, updated_at = excluded.updated_at`,
    ).run(input.fileKey, input.path, input.mtimeMs, input.size, input.offset, input.itemCount,
      input.sessionId ?? null, input.lastActivityMs, now);
    const insertRecord = db.prepare(
      `INSERT INTO agent_local_import_records(
        agent, record_id, session_id, turn_id, provider_id, model_id, started_at, completed_at,
        first_token_ms, duration_ms, usage_json, context_end, item_count, output_indices_json,
        anchor_offset, captured_at
      ) VALUES('codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, record_id) DO UPDATE SET
        session_id = excluded.session_id, turn_id = excluded.turn_id, provider_id = excluded.provider_id,
        model_id = excluded.model_id, started_at = excluded.started_at, completed_at = excluded.completed_at,
        first_token_ms = excluded.first_token_ms, duration_ms = excluded.duration_ms,
        usage_json = excluded.usage_json, context_end = excluded.context_end,
        item_count = excluded.item_count, output_indices_json = excluded.output_indices_json,
        anchor_offset = excluded.anchor_offset`,
    );
    for (const record of input.records) {
      insertRecord.run(
        record.id, record.sessionId, record.turnId ?? null, record.providerId, record.modelId,
        record.startedAt, record.completedAt ?? null, record.firstTokenMs ?? null, record.durationMs ?? null,
        JSON.stringify(record.usage), record.contextEnd, record.itemCount,
        JSON.stringify(record.outputIndices.slice(0, 5000)), record.anchorOffset, record.capturedAt,
      );
    }
  })();
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
