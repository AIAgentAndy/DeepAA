/**
 * P2-a（2026-11-04）：zcode 原生执行证据采集。
 *
 * 源：`~/.zcode/cli/db/db.sqlite` 的 `tool_usage`（实测 2026-11-04：21,906 行；
 * 含真实耗时/首字/退出码/审批/重试/取消/错误——wire 层不可见的执行侧事实，
 * docs/Agent底层Harness剖析与推进方案 §7.5 重点利用项）。
 *
 * 红线：
 * - 源库只读（readonly 打开 + query_only + busy_timeout，zcode 适配器同款防御），
 *   绝不写/checkpoint；
 * - rowid 游标增量（源 id 含 session 前缀非单调，rowid 随插入单调）；水位存
 *   `agent_tool_execution_state` 单行表（agent 主键）；
 * - 单批 ≤500 行（有界 + limit+1 哨兵）；主键幂等（INSERT OR IGNORE）；
 * - 只追加执行事实，不改 tool_calls、不合成计费、不参与账本；
 * - `tool_call_id` 与 wire `tool_use_id` 同源（确定性 join 键，查询侧关联）。
 */

import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {homedir} from "node:os";
import {join} from "node:path";

export const TOOL_EXECUTION_BATCH_LIMIT = 500;

interface ZcodeToolUsageRow {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  status: string | null;
  approval_status: string | null;
  side_effect_scope: string | null;
  read_only: number | null;
  destructive: number | null;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  time_to_first_output_ms: number | null;
  exit_code: number | null;
  output_bytes: number | null;
  retry_count: number | null;
  cancelled_by_user: number | null;
  error_type: string | null;
  error_message: string | null;
  rowid: number;
}

export interface ToolExecutionSyncResult {
  processedCount: number;
  hasMore: boolean;
  limited: boolean;
}

function openSourceReadonly(cliDir: string): DeepaaDatabase | undefined {
  try {
    const db = new DeepaaDatabase(join(cliDir, "db", "db.sqlite"), {readonly: true, timeout: 5_000});
    db.pragma("busy_timeout = 5000");
    db.pragma("query_only = ON");
    return db;
  } catch {
    return undefined;
  }
}

function readWatermark(db: DeepaaDatabase, agent: string): number {
  const row = db.prepare(
    "SELECT last_rowid FROM agent_tool_execution_state WHERE agent = ?",
  ).get(agent) as {last_rowid: number} | undefined;
  return row?.last_rowid ?? 0;
}

/** 增量同步一批 zcode tool_usage → agent_tool_executions（有界、幂等、游标续跑）。 */
export function syncZcodeToolExecutions(
  db: DeepaaDatabase,
  options?: {cliDir?: string; limit?: number},
): ToolExecutionSyncResult {
  const cliDir = options?.cliDir
    ?? process.env.ZCODE_CLI_DIR
    ?? join(homedir(), ".zcode", "cli");
  const limit = Math.max(1, Math.min(options?.limit ?? TOOL_EXECUTION_BATCH_LIMIT, TOOL_EXECUTION_BATCH_LIMIT));
  const source = openSourceReadonly(cliDir);
  if (!source) return {processedCount: 0, hasMore: false, limited: false};
  try {
    const lastRowid = readWatermark(db, "zcode");
    const rows = source.prepare(
      `SELECT rowid, id, session_id, turn_id, tool_call_id, tool_name, status, approval_status,
              side_effect_scope, read_only, destructive, started_at, completed_at,
              duration_ms, time_to_first_output_ms, exit_code, output_bytes,
              retry_count, cancelled_by_user, error_type, error_message
       FROM tool_usage WHERE rowid > ? ORDER BY rowid LIMIT ? + 1`,
    ).all(lastRowid, limit) as ZcodeToolUsageRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    if (page.length === 0) return {processedCount: 0, hasMore: false, limited: false};

    const insert = db.prepare(
      `INSERT OR IGNORE INTO agent_tool_executions(
        id, agent_name, session_id, turn_id, tool_call_id, tool_name, status,
        approval_status, side_effect_scope, read_only, destructive, started_at,
        completed_at, duration_ms, time_to_first_output_ms, exit_code, output_bytes,
        retry_count, cancelled_by_user, error_type, error_message, synced_at
      ) VALUES(?, 'zcode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const maxRowid = page[page.length - 1]!.rowid;
    db.transaction(() => {
      for (const row of page) {
        insert.run(
          row.id, row.session_id, row.turn_id, row.tool_call_id, row.tool_name, row.status,
          row.approval_status, row.side_effect_scope, row.read_only, row.destructive,
          row.started_at, row.completed_at, row.duration_ms, row.time_to_first_output_ms,
          row.exit_code, row.output_bytes, row.retry_count, row.cancelled_by_user,
          row.error_type,
          row.error_message ? row.error_message.slice(0, 200) : null,
          now,
        );
      }
      db.prepare(
        `INSERT INTO agent_tool_execution_state(agent, last_rowid, updated_at)
         VALUES('zcode', ?, ?)
         ON CONFLICT(agent) DO UPDATE SET last_rowid = excluded.last_rowid, updated_at = excluded.updated_at`,
      ).run(maxRowid, now);
    })();
    return {processedCount: page.length, hasMore, limited: hasMore};
  } finally {
    source.close();
  }
}

export interface ToolExecutionEvidence {
  status: string | null;
  approvalStatus: string | null;
  durationMs: number | null;
  timeToFirstOutputMs: number | null;
  exitCode: number | null;
  retryCount: number | null;
  cancelledByUser: boolean;
  errorType: string | null;
}

/** 查询侧：按 tool_call_id（与 wire tool_use_id 同源）取执行侧证据。 */
export function findToolExecutionByCallId(
  db: DeepaaDatabase,
  toolCallId: string,
): ToolExecutionEvidence | undefined {
  const row = db.prepare(
    `SELECT status, approval_status AS approvalStatus, duration_ms AS durationMs,
            time_to_first_output_ms AS timeToFirstOutputMs, exit_code AS exitCode,
            retry_count AS retryCount, cancelled_by_user AS cancelledByUser,
            error_type AS errorType
     FROM agent_tool_executions WHERE tool_call_id = ? LIMIT 1`,
  ).get(toolCallId) as (Omit<ToolExecutionEvidence, "cancelledByUser"> & {cancelledByUser: number}) | undefined;
  if (!row) return undefined;
  return {...row, cancelledByUser: row.cancelledByUser === 1};
}
