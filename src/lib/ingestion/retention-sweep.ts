import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

/**
 * 保留窗口的单向出窗撤销扫描（2026-09-21 用户确认：调整窗口不补投影）。
 *
 * 登记时的窗口判定一次性落库（projection_state）；Worker 每批执行本扫描只做
 * 「出窗撤销」：active 且重新出窗、job 仍处 pending/retry_wait 的记录删除 job 并
 * 置 archived；running 不打断（本轮完成后下批会收敛），succeeded 不回滚
 * （已进 SQLite 的投影永不撤销）。
 *
 * 窗口调大时**不会**重新激活 archived 记录——保留窗口只对之后新产生（含晚发现）
 * 的数据生效（用户 2026-09-21 确认），历史 archived 记录随整文件清理回收。
 *
 * 每批最多 limit 条（命中 idx_ingestion_records_projection_state），绝不全量扫描。
 */

export interface ProjectionWindowSweepResult {
  archived: number;
}

export interface ProjectionWindowSweepOptions {
  cutoff: string;
  projectionVersion: number;
  limit?: number;
}

const DEFAULT_SWEEP_LIMIT = 25;

export function reconcileProjectionWindow(
  db: DeepaaDatabase,
  options: ProjectionWindowSweepOptions,
): ProjectionWindowSweepResult {
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;

  const archive = db.transaction((): number => {
    // 只撤 job 仍处可撤销状态的记录；succeeded/running/permanent_error 一律不动。
    const rows = db.prepare(
      `SELECT r.id FROM ingestion_records r
       JOIN derivation_jobs j
         ON j.ingestion_record_id = r.id
        AND j.projection_version = ?
       WHERE r.projection_state = 'active'
         AND r.captured_at < ?
         AND j.job_status IN ('pending', 'retry_wait')
       ORDER BY r.captured_at ASC
       LIMIT ?`,
    ).all(options.projectionVersion, options.cutoff, limit) as Array<{id: number}>;
    for (const row of rows) {
      // 归档待派生记录时同步清理对账 sidecar；否则小时对账会把已撤销
      // 的任务永久视为“本地仍未收敛”。
      db.prepare(
        `DELETE FROM relay_pending_ingestions
         WHERE exchange_id IN (
           SELECT exchange_id FROM ingestion_records WHERE id = ?
         )`,
      ).run(row.id);
      db.prepare(
        `DELETE FROM derivation_jobs
         WHERE ingestion_record_id = ?
           AND projection_version = ?
           AND job_status IN ('pending', 'retry_wait')`,
      ).run(row.id, options.projectionVersion);
      db.prepare(
        `UPDATE ingestion_records
         SET projection_state = 'archived'
         WHERE id = ? AND projection_state = 'active'`,
      ).run(row.id);
    }
    return rows.length;
  });

  return { archived: archive() };
}
