/**
 * 双链路观测历史数据重置（2026-09-16 用户确认「重置重导」）：
 * 删除 origin=agent_local_import 的全部派生数据与合成 raw 源，重置导入游标，
 * 让修复后的口径（token 转换 / 原生 turn 边界 / 工具名映射）全量重新导入。
 *
 * 前提：web 服务已停止（调度器与 Worker 不在运行）；3211 代理不受影响（不同进程树）。
 * 保留：网关链路全部数据；混合 scope（与网关共用的 Session/Thread/Turn）的层级行；
 * 受影响 scope 的聚合重放（剩余网关步贡献）+ 小时桶标记 dirty 由 rollup 重算。
 * 幂等：重复执行零新增删除。
 */
import {DatabaseSync} from "node:sqlite";
import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// better-sqlite3 → node:sqlite 最小兼容层（2026-10-08 切换）：仅覆盖本脚本用到的
// pragma / transaction / pluck 三个差异点，语义与 src/lib/db/sqlite-driver.ts 一致。
class CompatStmt {
  constructor(raw) { this.raw = raw; this.plucking = false; }
  pluck(on = true) { this.plucking = on; return this; }
  pluckRow(row) { return this.plucking ? Object.values(row ?? {})[0] : row; }
  get(...args) { return this.pluckRow(this.raw.get(...args)); }
  all(...args) {
    const rows = this.raw.all(...args);
    return this.plucking ? rows.map(row => this.pluckRow(row)) : rows;
  }
  run(...args) { return this.raw.run(...args); }
}
class CompatDatabase {
  constructor(path) { this.raw = new DatabaseSync(path); }
  pragma(source, options) {
    if (source.includes("=")) { this.raw.exec(`PRAGMA ${source}`); return undefined; }
    const rows = this.raw.prepare(`PRAGMA ${source}`).all();
    if (rows.length === 0) return undefined;
    return options?.simple ? Object.values(rows[0])[0] : rows;
  }
  prepare(sql) { return new CompatStmt(this.raw.prepare(sql)); }
  transaction(fn) {
    return (...args) => {
      this.raw.exec("BEGIN");
      let result;
      try { result = fn(...args); } catch (error) { this.raw.exec("ROLLBACK"); throw error; }
      this.raw.exec("COMMIT");
      return result;
    };
  }
  close() { this.raw.close(); }
}

const dataDir = process.env.DEEPAA_DATA_DIR && process.env.DEEPAA_RESET_BACKUP
  ? process.env.DEEPAA_DATA_DIR
  : join(homedir(), ".deepaa");
const dbPath = join(dataDir, "deepaa.sqlite");
const db = new CompatDatabase(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 10000");

const now = new Date().toISOString();
const report = {};

function count(sql) {
  return db.prepare(sql).pluck().get();
}

// ---------- 0. 前置检查 ----------
const importedExchanges = db.prepare(
  "SELECT exchange_id FROM raw_exchange_refs WHERE origin = 'agent_local_import'",
).all().map(row => row.exchange_id);
report.importedExchanges = importedExchanges.length;
if (importedExchanges.length === 0) {
  console.log(JSON.stringify({ skipped: "无导入数据需要重置" }));
  process.exit(0);
}

// ---------- 1. 备份 ----------
const backupDir = join(dataDir, "backup");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const suffix of ["", "-wal", "-shm"]) {
  const src = dbPath + suffix;
  if (existsSync(src)) {
    copyFileSync(src, join(backupDir, `deepaa.sqlite.pre-local-import-reset-${stamp}${suffix}`));
  }
}
report.backup = `backup/deepaa.sqlite.pre-local-import-reset-${stamp}*`;

// ---------- 2. 受影响 scope（先算，删完就没依据了） ----------
const affectedSessions = db.prepare(
  `SELECT DISTINCT s.agent_session_id FROM agent_steps s
   JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
   WHERE r.origin = 'agent_local_import'`,
).all().map(row => row.agent_session_id);
const affectedThreads = db.prepare(
  `SELECT DISTINCT s.agent_thread_id FROM agent_steps s
   JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
   WHERE r.origin = 'agent_local_import'`,
).all().map(row => row.agent_thread_id);
const affectedTurns = db.prepare(
  `SELECT DISTINCT s.agent_turn_id FROM agent_steps s
   JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
   WHERE r.origin = 'agent_local_import'`,
).all().map(row => row.agent_turn_id);
report.affectedScopes = { sessions: affectedSessions.length, threads: affectedThreads.length, turns: affectedTurns.length };

const ledgerWindow = db.prepare(
  `SELECT MIN(created_at) AS min, MAX(created_at) AS max FROM usage_ledger
   WHERE exchange_id LIKE 'import-zcode-%'`,
).get();

// ---------- 3. 逐组删除（单事务，幂等） ----------
const reset = db.transaction(() => {
  db.prepare("DROP TABLE IF EXISTS temp.imp_exchanges").run();
  db.prepare("DROP TABLE IF EXISTS temp.imp_steps").run();
  db.prepare(
    `CREATE TEMP TABLE imp_exchanges AS
     SELECT exchange_id FROM raw_exchange_refs WHERE origin = 'agent_local_import'`,
  ).run();
  db.prepare(
    `CREATE TEMP TABLE imp_steps AS
     SELECT s.id FROM agent_steps s
     JOIN temp.imp_exchanges e ON e.exchange_id = s.exchange_id`,
  ).run();

  // 3.1 步级子表（无级联的先删；子查询避开参数上限）
  report.deleted = {};
  report.deleted.contextSnapshots = db.prepare(
    `DELETE FROM context_snapshots WHERE agent_step_id IN (SELECT id FROM temp.imp_steps)`,
  ).run().changes;
  report.deleted.stepDiffs = db.prepare(
    `DELETE FROM step_diffs WHERE agent_step_id IN (SELECT id FROM temp.imp_steps)`,
  ).run().changes;
  report.deleted.toolCalls = db.prepare(
    `DELETE FROM tool_calls WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges)`,
  ).run().changes;
  report.deleted.usageLedger = db.prepare(
    `DELETE FROM usage_ledger WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges)`,
  ).run().changes;
  report.deleted.auxiliaryRequests = db.prepare(
    `DELETE FROM auxiliary_requests WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges)`,
  ).run().changes;
  report.deleted.agentSteps = db.prepare(
    `DELETE FROM agent_steps WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges)`,
  ).run().changes;

  // 3.2 raw 引用（级联清 previews/media/fingerprints/filter_status/category_stats）
  const blocking = db.prepare(
    `SELECT tbl, n FROM (
       SELECT 'agent_steps' AS tbl, count(*) AS n FROM agent_steps WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges)
     UNION ALL SELECT 'tool_calls', count(*) FROM tool_calls WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges)
     UNION ALL SELECT 'usage_ledger', count(*) FROM usage_ledger WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges)
     UNION ALL SELECT 'auxiliary_requests', count(*) FROM auxiliary_requests WHERE exchange_id IN (SELECT exchange_id FROM temp.imp_exchanges))
     WHERE n > 0`).all();
  if (blocking.length > 0) {
    throw new Error(`导入 exchange 仍有子行未清理: ${JSON.stringify(blocking)}`);
  }
  report.deleted.rawExchangeRefs = db.prepare(
    `DELETE FROM raw_exchange_refs WHERE origin = 'agent_local_import'`,
  ).run().changes;

  // 3.3 诊断与登记层（按导入源）
  report.deleted.derivationDiagnostics = db.prepare(
    `DELETE FROM derivation_diagnostics WHERE exchange_id LIKE 'import-zcode-%'`,
  ).run().changes;
  report.deleted.derivationJobs = db.prepare(
    `DELETE FROM derivation_jobs WHERE ingestion_record_id IN (
       SELECT id FROM ingestion_records WHERE source_id IN (
         SELECT id FROM ingestion_sources WHERE relative_path LIKE 'captures/v2/import-%'))`,
  ).run().changes;
  report.deleted.ingestionRecords = db.prepare(
    `DELETE FROM ingestion_records WHERE source_id IN (
       SELECT id FROM ingestion_sources WHERE relative_path LIKE 'captures/v2/import-%')`,
  ).run().changes;
  report.deleted.ingestionSources = db.prepare(
    `DELETE FROM ingestion_sources WHERE relative_path LIKE 'captures/v2/import-%'`,
  ).run().changes;

  // 3.4 纯导入 turn（删完步后零剩余步的受影响 turn）；混合 turn 保留（网关步还在）
  report.deleted.turns = db.prepare(
    `DELETE FROM agent_turns WHERE id IN (
       SELECT id FROM agent_turns
       WHERE id IN (${affectedTurns.map(() => "?").join(",")})
         AND NOT EXISTS (SELECT 1 FROM agent_steps WHERE agent_turn_id = agent_turns.id)
         AND NOT EXISTS (SELECT 1 FROM auxiliary_requests WHERE agent_turn_id = agent_turns.id))`,
  ).run(...affectedTurns).changes;

  // 3.5 受影响 scope 聚合清零
  report.deleted.scopeAggregates =
    db.prepare(`DELETE FROM scope_aggregates WHERE scope_type='session' AND scope_id IN (${affectedSessions.map(() => "?").join(",")})`).run(...affectedSessions).changes
    + db.prepare(`DELETE FROM scope_aggregates WHERE scope_type='thread' AND scope_id IN (${affectedThreads.map(() => "?").join(",")})`).run(...affectedThreads).changes
    + db.prepare(`DELETE FROM scope_aggregates WHERE scope_type='turn' AND scope_id IN (${affectedTurns.map(() => "?").join(",")})`).run(...affectedTurns).changes;

  // 3.6 剩余（网关）步对受影响 scope 的贡献重放（镜像写入语义；导入贡献由重导派生重新累加）
  const replayTurn = db.prepare(
    `INSERT INTO scope_aggregates(
       scope_type, scope_id, step_request_count, auxiliary_request_count,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
       vendor_cost, actual_cost, duration_total_ms, duration_sample_count,
       tool_call_count, updated_at)
     SELECT 'turn', s.agent_turn_id,
       count(DISTINCT s.id),
       (SELECT count(*) FROM auxiliary_requests a WHERE a.agent_turn_id = s.agent_turn_id),
       COALESCE(sum(s.input_tokens), 0), COALESCE(sum(s.cache_read_tokens), 0),
       COALESCE(sum(s.cache_write_tokens), 0), COALESCE(sum(s.output_tokens), 0),
       COALESCE(sum(s.vendor_cost), 0), COALESCE(sum(s.actual_cost), 0),
       COALESCE(sum(CASE WHEN u.result_class = 'success' THEN s.duration_ms ELSE 0 END), 0),
       count(DISTINCT CASE WHEN u.result_class = 'success' THEN s.id END),
       (SELECT count(*) FROM tool_calls c WHERE c.agent_turn_id = s.agent_turn_id),
       max(s.timestamp)
     FROM agent_steps s
     LEFT JOIN usage_ledger u ON u.exchange_id = s.exchange_id
     WHERE s.agent_turn_id = ?
     GROUP BY s.agent_turn_id`);
  const replayThread = db.prepare(
    `INSERT INTO scope_aggregates(
       scope_type, scope_id, step_request_count, auxiliary_request_count,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
       vendor_cost, actual_cost, duration_total_ms, duration_sample_count,
       tool_call_count, updated_at)
     SELECT 'thread', s.agent_thread_id,
       count(DISTINCT s.id),
       (SELECT count(*) FROM auxiliary_requests a WHERE a.agent_thread_id = s.agent_thread_id),
       COALESCE(sum(s.input_tokens), 0), COALESCE(sum(s.cache_read_tokens), 0),
       COALESCE(sum(s.cache_write_tokens), 0), COALESCE(sum(s.output_tokens), 0),
       COALESCE(sum(s.vendor_cost), 0), COALESCE(sum(s.actual_cost), 0),
       COALESCE(sum(CASE WHEN u.result_class = 'success' THEN s.duration_ms ELSE 0 END), 0),
       count(DISTINCT CASE WHEN u.result_class = 'success' THEN s.id END),
       (SELECT count(*) FROM tool_calls c WHERE c.agent_thread_id = s.agent_thread_id),
       max(s.timestamp)
     FROM agent_steps s
     LEFT JOIN usage_ledger u ON u.exchange_id = s.exchange_id
     WHERE s.agent_thread_id = ?
     GROUP BY s.agent_thread_id`);
  const replaySession = db.prepare(
    `INSERT INTO scope_aggregates(
       scope_type, scope_id, step_request_count, auxiliary_request_count,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
       vendor_cost, actual_cost, duration_total_ms, duration_sample_count,
       tool_call_count, updated_at)
     SELECT 'session', s.agent_session_id,
       count(DISTINCT s.id),
       (SELECT count(*) FROM auxiliary_requests a WHERE a.agent_session_id = s.agent_session_id),
       COALESCE(sum(s.input_tokens), 0), COALESCE(sum(s.cache_read_tokens), 0),
       COALESCE(sum(s.cache_write_tokens), 0), COALESCE(sum(s.output_tokens), 0),
       COALESCE(sum(s.vendor_cost), 0), COALESCE(sum(s.actual_cost), 0),
       COALESCE(sum(CASE WHEN u.result_class = 'success' THEN s.duration_ms ELSE 0 END), 0),
       count(DISTINCT CASE WHEN u.result_class = 'success' THEN s.id END),
       (SELECT count(*) FROM tool_calls c WHERE c.agent_session_id = s.agent_session_id),
       max(s.timestamp)
     FROM agent_steps s
     LEFT JOIN usage_ledger u ON u.exchange_id = s.exchange_id
     WHERE s.agent_session_id = ?
     GROUP BY s.agent_session_id`);
  report.replayedScopes = { turns: 0, threads: 0, sessions: 0 };
  for (const id of affectedTurns) report.replayedScopes.turns += replayTurn.run(id).changes;
  for (const id of affectedThreads) report.replayedScopes.threads += replayThread.run(id).changes;
  for (const id of affectedSessions) report.replayedScopes.sessions += replaySession.run(id).changes;

  // 3.7 小时桶标记 dirty（rollup 按 ledger 重算该桶 facts）
  if (ledgerWindow.min && ledgerWindow.max) {
    const minMs = Date.parse(ledgerWindow.min);
    const maxMs = Date.parse(ledgerWindow.max);
    const HOUR = 3_600_000;
    const start = Math.floor((minMs - HOUR) / HOUR) * HOUR;
    const end = Math.floor((maxMs + HOUR) / HOUR) * HOUR;
    const markDirty = db.prepare(
      `INSERT INTO analytics_dirty_buckets(
         bucket_start_utc, reason, first_seen_at, last_seen_at, status, attempt_count, available_at)
       VALUES(?, 'local_import_reset', ?, ?, 'pending', 0, ?)
       ON CONFLICT(bucket_start_utc) DO UPDATE SET
         status = CASE WHEN analytics_dirty_buckets.status = 'completed' THEN 'pending' ELSE analytics_dirty_buckets.status END,
         last_seen_at = excluded.last_seen_at`);
    let buckets = 0;
    for (let ts = start; ts <= end; ts += HOUR) {
      buckets += markDirty.run(new Date(ts).toISOString(), now, now, now).changes;
    }
    report.dirtyBuckets = buckets;
  }

  // 3.8 导入游标重置（修复后调度器从 30 天 floor 全量重导）
  report.deleted.importState = db.prepare(
    "DELETE FROM agent_local_import_state WHERE agent_name = 'zcode'",
  ).run().changes;
  report.deleted.importSeen = db.prepare("DELETE FROM agent_local_import_seen").run().changes;
});

reset();

// ---------- 4. 物理删除合成 raw 文件 ----------
const capturesDir = join(dataDir, "captures", "v2");
report.deletedImportFiles = 0;
if (existsSync(capturesDir)) {
  for (const name of readdirSync(capturesDir)) {
    if (name.startsWith("import-") && name.endsWith(".jsonl")) {
      const full = join(capturesDir, name);
      const size = statSync(full).size;
      rmSync(full);
      report.deletedImportFiles += 1;
    }
  }
}

// ---------- 5. 收尾校验 ----------
report.after = {
  rawRefs: count("SELECT count(*) FROM raw_exchange_refs WHERE origin='agent_local_import'"),
  ledger: count("SELECT count(*) FROM usage_ledger WHERE exchange_id LIKE 'import-zcode-%'"),
  steps: count("SELECT count(*) FROM agent_steps WHERE exchange_id LIKE 'import-zcode-%'"),
  importSources: count("SELECT count(*) FROM ingestion_sources WHERE relative_path LIKE 'captures/v2/import-%'"),
  importState: count("SELECT count(*) FROM agent_local_import_state"),
};
const integrity = db.pragma("quick_check", { simple: true });
report.integrity = integrity;
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
console.log(JSON.stringify(report, null, 1));
