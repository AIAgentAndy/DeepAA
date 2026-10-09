/**
 * 针对性一次性修复（2026-09-18 用户批准的批次 3 存量重挂）：
 *
 * 背景：2026-09-17 19:30 的指纹/会话身份统一（commit 5b32795，Agent 维度会话：
 * 指纹只含客户端身份、会话哈希不掺 targetId）之前派生的存量行仍带着旧版
 * 「fp-<agent>-<protocol>-<target>」复合指纹与 target 作用域会话哈希，导致同一
 * 业务会话在会话树里分裂成多个 Session（含只剩 1 步、计数互相矛盾的幽灵节点）。
 *
 * 行为：把「指纹 ≠ fp-<agent_name> 规范形态」的 donor 会话下的全部模型交换按当前
 * 派生代码定向重放——先删该交换的派生行（账本/步骤/线程/会话/预览/指纹），再按
 * 登记 locator 原样重读 raw v2 行并走与 Worker 完全相同的派生入口。派生链路自身
 * 会重建会话层级、scope_aggregates 并标记 analytics 脏桶；donor 侧的空壳、辅助行
 * 与聚合残留由本模块清理。账本按 loadPricingConfigAt(capturedAt) 取价格版本，与
 * 原始入账一致，不重算价格。
 *
 * 安全线：默认 dry-run（只报告）；execute 模式逐交换独立事务、失败逐行记录不中断；
 * 绝不触碰 ingestion_sources 游标、raw JSONL 原文与 pricing 配置。执行须在
 * web/Worker 空闲时段（SQLite 单写者约定）。
 */
import { openDeepaaDatabase } from "../db/connection.js";
import { createExchangeProcessor } from "./exchange-processor.js";
import { readRegisteredSourceRecord } from "./raw-source-reader.js";
import type { RawCapturedExchangeV2 } from "../harness/types.js";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

export interface LegacyDonorSession {
  id: string;
  agentName: string;
  fingerprintId: string;
  requestCount: number;
  startTime: string;
}

export interface LegacyRepairPlan {
  donors: LegacyDonorSession[];
  affectedExchangeCount: number;
}

export interface LegacyRepairResult {
  rederived: number;
  mergedBack: number;
  skipped: Array<{exchangeId: string; reason: string}>;
  remainingDonors: LegacyDonorSession[];
}

const LEGACY_DONOR_SESSIONS_SQL = `
  SELECT id, agent_name AS agentName, agent_fingerprint_id AS fingerprintId,
    request_count AS requestCount, start_time AS startTime
  FROM agent_sessions
  WHERE agent_fingerprint_id != 'fp-' || agent_name
  ORDER BY agent_name, start_time`;

export function analyzeLegacyIdentityDonorSessions(db: DeepaaDatabase): LegacyRepairPlan {
  const donors = db.prepare(LEGACY_DONOR_SESSIONS_SQL).all() as LegacyDonorSession[];
  let affectedExchangeCount = 0;
  if (donors.length > 0) {
    const placeholders = donors.map(() => "?").join(",");
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM agent_steps
       WHERE agent_session_id IN (${placeholders})`,
    ).get(...donors.map(donor => donor.id)) as {n: number};
    affectedExchangeCount = row.n;
  }
  return {donors, affectedExchangeCount};
}

export async function reprojectLegacyIdentitySessions(
  dataDir: string,
  options: {db?: DeepaaDatabase} = {},
): Promise<LegacyRepairResult> {
  const db = options.db ?? openDeepaaDatabase({dataDir});
  const shouldClose = options.db === undefined;
  try {
    const {donors} = analyzeLegacyIdentityDonorSessions(db);
    const skipped: Array<{exchangeId: string; reason: string}> = [];
    if (donors.length === 0) {
      return {rederived: 0, mergedBack: 0, skipped, remainingDonors: []};
    }
    const donorIds = donors.map(donor => donor.id);
    const placeholders = donorIds.map(() => "?").join(",");
    const affected = db.prepare(
      `SELECT st.exchange_id AS exchange_id
       FROM agent_steps st
       WHERE st.agent_session_id IN (${placeholders})
       ORDER BY st.timestamp, st.exchange_id`,
    ).all(...donorIds) as Array<{exchange_id: string}>;

    // node:sqlite 单条 prepare 只允许一条语句：逐表预编译，重放前在同一事务内执行。
    const deleteUsageLedger = db.prepare("DELETE FROM usage_ledger WHERE exchange_id = ?");
    const deleteRelayLocalUsageEvent = db.prepare(
      "DELETE FROM relay_local_usage_events WHERE exchange_id = ?",
    );
    const deleteAuxiliary = db.prepare("DELETE FROM auxiliary_requests WHERE exchange_id = ?");
    const deleteToolCalls = db.prepare("DELETE FROM tool_calls WHERE exchange_id = ?");
    const deleteStepDiffs = db.prepare(
      "DELETE FROM step_diffs WHERE agent_step_id IN (SELECT id FROM agent_steps WHERE exchange_id = ?)",
    );
    const deleteContextSnapshots = db.prepare(
      "DELETE FROM context_snapshots WHERE agent_step_id IN (SELECT id FROM agent_steps WHERE exchange_id = ?)",
    );
    const deleteLearningInsight = db.prepare(
      "DELETE FROM learning_insights WHERE agent_turn_id IN (SELECT agent_turn_id FROM agent_steps WHERE exchange_id = ?)",
    );
    const deleteStep = db.prepare("DELETE FROM agent_steps WHERE exchange_id = ?");
    const deleteFilterStatus = db.prepare("DELETE FROM exchange_content_filter_status WHERE exchange_id = ?");
    const deleteCategoryStats = db.prepare("DELETE FROM exchange_content_category_stats WHERE exchange_id = ?");
    const deleteFingerprints = db.prepare("DELETE FROM exchange_request_fingerprints WHERE exchange_id = ?");
    const deleteRawRef = db.prepare("DELETE FROM raw_exchange_refs WHERE exchange_id = ?");
    const deleteEmptiedTurns = db.prepare(
      `DELETE FROM agent_turns WHERE agent_session_id IN (SELECT id FROM agent_sessions WHERE agent_fingerprint_id != 'fp-' || agent_name)
       AND NOT EXISTS (SELECT 1 FROM agent_steps st WHERE st.agent_turn_id = agent_turns.id)`,
    );
    const deleteEmptiedThreads = db.prepare(
      `DELETE FROM agent_threads WHERE agent_session_id IN (SELECT id FROM agent_sessions WHERE agent_fingerprint_id != 'fp-' || agent_name)
       AND NOT EXISTS (SELECT 1 FROM agent_steps st WHERE st.agent_thread_id = agent_threads.id)`,
    );
    const registeredFor = db.prepare(
      `SELECT ir.id, ir.source_id AS sourceId, s.relative_path AS relativePath,
         ir.source_generation AS sourceGeneration, ir.source_file_id AS sourceFileId,
         ir.byte_offset AS byteOffset, ir.line_length_bytes AS lineLengthBytes,
         ir.line_sha256 AS lineSha256
       FROM ingestion_records ir
       JOIN ingestion_sources s ON s.id = ir.source_id
       WHERE ir.exchange_id = ?`,
    );

    const processor = createExchangeProcessor({db, dataDir});
    let rederived = 0;
    let mergedBack = 0;
    const touchedSessionIds = new Set<string>();

    for (const row of affected) {
      const exchangeId = row.exchange_id;
      try {
        const registered = registeredFor.get(exchangeId) as
          | {id: number; sourceId: number; relativePath: string; sourceGeneration: number; sourceFileId: string; byteOffset: number; lineLengthBytes: number; lineSha256: string}
          | undefined;
        if (!registered) {
          skipped.push({exchangeId, reason: "无登记行，无法安全重读"});
          continue;
        }
        const record = await readRegisteredSourceRecord(db, dataDir, {
          exchangeId,
          sourceId: registered.sourceId,
          sourceRelativePath: registered.relativePath,
          sourceGeneration: registered.sourceGeneration,
          sourceFileId: registered.sourceFileId,
          byteOffset: registered.byteOffset,
          lineLengthBytes: registered.lineLengthBytes,
          lineSha256: registered.lineSha256,
        });
        const exchange = record.exchange as RawCapturedExchangeV2;
        if (exchange.exchangeId !== exchangeId || exchange.schemaVersion !== 2) {
          skipped.push({exchangeId, reason: "raw 行身份校验失败"});
          continue;
        }

        db.transaction(() => {
          // relay_local_usage_events 外键指向 usage_ledger；旧身份重投影
          // 会先删账本再重建，必须先撤销小型对账索引，避免外键阻断修复。
          deleteRelayLocalUsageEvent.run(exchangeId);
          deleteUsageLedger.run(exchangeId);
          deleteAuxiliary.run(exchangeId);
          deleteToolCalls.run(exchangeId);
          deleteStepDiffs.run(exchangeId);
          deleteContextSnapshots.run(exchangeId);
          deleteLearningInsight.run(exchangeId);
          deleteStep.run(exchangeId);
          deleteFilterStatus.run(exchangeId);
          deleteCategoryStats.run(exchangeId);
          deleteFingerprints.run(exchangeId);
          deleteRawRef.run(exchangeId);
          deleteEmptiedTurns.run();
          deleteEmptiedThreads.run();
        })();

        const result = await processor.processExchangeRecord({
          ingestionRecordId: registered.id,
          sourceId: registered.sourceId,
          sourceRelativePath: registered.relativePath,
          byteOffset: registered.byteOffset,
          lineLengthBytes: registered.lineLengthBytes,
          exchange,
        });
        if (result.duplicate) {
          skipped.push({exchangeId, reason: "重放被判重复"});
          continue;
        }
        rederived += 1;
        if (result.sessionId) {
          mergedBack += 1;
          touchedSessionIds.add(result.sessionId);
        }
      } catch (error) {
        skipped.push({exchangeId, reason: `重放异常: ${error instanceof Error ? error.message : String(error)}`});
      }
    }

    const deleteDonorScopeAggregates = db.prepare(
      `DELETE FROM scope_aggregates WHERE
        (scope_type = 'session' AND scope_id IN (SELECT id FROM agent_sessions WHERE agent_fingerprint_id != 'fp-' || agent_name))
        OR (scope_type = 'thread' AND scope_id IN (SELECT id FROM agent_threads WHERE agent_session_id IN (SELECT id FROM agent_sessions WHERE agent_fingerprint_id != 'fp-' || agent_name)))
        OR (scope_type = 'turn' AND scope_id IN (SELECT id FROM agent_turns WHERE agent_session_id IN (SELECT id FROM agent_sessions WHERE agent_fingerprint_id != 'fp-' || agent_name)))`,
    );
    const deleteDonorSessions = db.prepare(
      `DELETE FROM agent_sessions
       WHERE agent_fingerprint_id != 'fp-' || agent_name
         AND NOT EXISTS (SELECT 1 FROM agent_steps st WHERE st.agent_session_id = agent_sessions.id)
         AND NOT EXISTS (SELECT 1 FROM auxiliary_requests a WHERE a.agent_session_id = agent_sessions.id)`,
    );
    db.transaction(() => {
      deleteDonorScopeAggregates.run();
      deleteDonorSessions.run();
    })();

    // 聚合回滚（计数 reconcile）：会话/线程/Turn 的计数是派生期累加值，重放会
    // 在接收会话上再次累加；按实际行数重算，杜绝「1399 请求 vs 1 步」式矛盾。
    const reconcileSession = db.prepare(
      `UPDATE agent_sessions SET
         request_count = (SELECT COUNT(*) FROM agent_steps WHERE agent_session_id = agent_sessions.id)
           + (SELECT COUNT(*) FROM auxiliary_requests WHERE agent_session_id = agent_sessions.id),
         thread_count = (SELECT COUNT(*) FROM agent_threads WHERE agent_session_id = agent_sessions.id)
       WHERE id = ?`,
    );
    const reconcileThreads = db.prepare(
      `UPDATE agent_threads SET
         request_count = (SELECT COUNT(*) FROM agent_steps WHERE agent_thread_id = agent_threads.id)
           + (SELECT COUNT(*) FROM auxiliary_requests WHERE agent_thread_id = agent_threads.id),
         turn_count = (SELECT COUNT(*) FROM agent_turns WHERE agent_thread_id = agent_threads.id)
       WHERE agent_session_id = ?`,
    );
    const reconcileTurns = db.prepare(
      `UPDATE agent_turns SET
         step_count = (SELECT COUNT(*) FROM agent_steps WHERE agent_turn_id = agent_turns.id)
       WHERE agent_session_id = ?`,
    );
    db.transaction(() => {
      for (const sessionId of touchedSessionIds) {
        reconcileSession.run(sessionId);
        reconcileThreads.run(sessionId);
        reconcileTurns.run(sessionId);
      }
    })();

    const remainingDonors = db.prepare(LEGACY_DONOR_SESSIONS_SQL).all() as LegacyDonorSession[];
    return {rederived, mergedBack, skipped, remainingDonors};
  } finally {
    if (shouldClose) db.close();
  }
}
