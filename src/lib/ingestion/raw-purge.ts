import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { statSync } from "node:fs";
import { lstat, opendir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { computeRetentionCutoff, readRetentionConfig } from "../retention";
import {
  derivedArtifactPath,
  DERIVED_ARTIFACT_DIR_NAME,
  purgedDerivedArtifactPlaceholder,
} from "./derived-artifact-store";
import { sourceFileId } from "./raw-source-reader";

/**
 * 删除文件并对 Windows 瞬时文件锁做短重试。
 * Windows 上刚写入/刚关闭的文件可能被 Defender、搜索索引器短暂锁定（EPERM/EBUSY），
 * 立即删除会失败；静默短退避后重试可消化该竞态（CI 实测）。POSIX 上首次即成功。
 */
async function rmWithTransientLockRetry(
  path: string,
  options: {force?: boolean} = {},
): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(path, options);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY") && attempt < maxAttempts) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50 * attempt));
        continue;
      }
      throw error;
    }
  }
}

/**
 * 一键清除超过保留窗口的 raw（docs/上线前架构升级改造.md P1-7，决策 D1/D3/D5）。
 *
 * 粒度 = 整文件：capture 文件内全部 exchange 的 captured_at 均早于窗口才可清理；
 * 跨窗混合、仍有未终态 job、file_id 与磁盘不一致、mtime 在 24h 安全期内的文件一律
 * 跳过并在预览中给出原因。绝不触碰运行中代理正在写的活跃文件。
 *
 * 不变量（用户 2026-09-14 确认）：
 * - agent_steps / usage_ledger / tool_calls / scope_aggregates / session/thread/turn
 *   层级**永不删除**——raw 清理只影响 raw 与其直接派生（预览/指纹/媒体/诊断）；
 * - raw_exchange_refs 保留为墓碑（raw_state='purged'），step/账本外键永不失效；
 * - context_snapshots / step_diffs 行保留为墓碑，外置 artifact_hash 清空供 GC 回收。
 *
 * 每个文件一个短事务、可中断可重入；物理删除与 blob GC 在事务外完成；收尾执行
 * incremental_vacuum 渐进回收 SQLite 空间（依赖 v30 的 auto_vacuum=INCREMENTAL）。
 */

/** 活跃文件安全期：mtime 在该窗口内的 capture 文件视为代理可能仍在写，跳过。 */
const ACTIVE_FILE_GRACE_MS = 24 * 60 * 60 * 1000;
/** 预览候选与跳过项的有界上限。 */
const MAX_PURGE_CANDIDATES = 500;
/** 目录体量统计的条目上限（大数据保护：有界扫描 + truncated 标记）。 */
const MAX_STAT_ENTRIES = 100_000;

export interface PurgeCandidate {
  sourceId: number;
  relativePath: string;
  fileBytes: number;
  exchangeCount: number;
  earliestCapturedAt: string;
  latestCapturedAt: string;
}

export type PurgeSkipReason =
  | "non_capture_source"
  | "status_not_ready"
  | "active_jobs"
  | "no_records"
  | "mixed_window"
  | "recently_modified"
  | "file_identity_mismatch"
  | "stat_failed";

export interface PurgeSkip {
  relativePath: string;
  reason: PurgeSkipReason;
}

export interface PurgePreview {
  retentionDays: number;
  cutoff: string;
  candidates: PurgeCandidate[];
  skipped: PurgeSkip[];
  reclaimableBytes: {
    captureFiles: number;
    externalBlobs: number;
    derivedArtifacts: number;
    total: number;
  };
  /** 孤儿正文/派生物（无引用且超活跃安全期）可额外回收的量。 */
  orphanReclaim: {
    blobFileCount: number;
    artifactFileCount: number;
    bytes: number;
    limited: boolean;
  };
  limited: boolean;
}

export interface PurgeExecutionResult {
  purgedFiles: Array<{relativePath: string; fileBytes: number; exchangeCount: number}>;
  deletedBlobFiles: number;
  deletedDerivedArtifactFiles: number;
  /** 孤儿清扫（无任何 SQLite 引用且超过活跃安全期）额外删除的文件数。 */
  deletedOrphanBlobFiles: number;
  deletedOrphanArtifactFiles: number;
  vacuumedPages: number;
  /** 预览阶段被跳过的文件数（跨窗混合 / 活跃中 / 身份不一致等）。 */
  skippedCount: number;
  errors: Array<{relativePath: string; message: string}>;
}

interface SourceCandidateRow {
  id: number;
  relative_path: string;
  file_id: string;
  file_size: number;
  status: string;
  byte_offset: number;
  scan_offset: number;
  exchange_count: number;
  earliest_captured_at: string | null;
  latest_captured_at: string | null;
  latest_record_captured_at: string | null;
  active_jobs: number;
}

export async function previewRawPurge(
  db: DeepaaDatabase,
  dataDir: string,
): Promise<PurgePreview> {
  const retentionDays = readRetentionConfig(dataDir).rawRetentionDays;
  const cutoff = computeRetentionCutoff(retentionDays);
  const rows = db.prepare(
    `SELECT s.id, s.relative_path, s.file_id, s.file_size, s.status,
       s.byte_offset, s.scan_offset,
       (SELECT COUNT(*) FROM raw_exchange_refs r WHERE r.source_id = s.id) AS exchange_count,
       (SELECT MIN(r.captured_at) FROM raw_exchange_refs r WHERE r.source_id = s.id) AS earliest_captured_at,
       (SELECT MAX(r.captured_at) FROM raw_exchange_refs r WHERE r.source_id = s.id) AS latest_captured_at,
       (SELECT MAX(ir.captured_at) FROM ingestion_records ir WHERE ir.source_id = s.id) AS latest_record_captured_at,
       (SELECT COUNT(*) FROM derivation_jobs j
         JOIN ingestion_records ir ON ir.id = j.ingestion_record_id
        WHERE ir.source_id = s.id
          AND j.job_status IN ('pending', 'running', 'retry_wait')) AS active_jobs
     FROM ingestion_sources s
     WHERE s.status <> 'purged'
     ORDER BY (SELECT MAX(r.captured_at) FROM raw_exchange_refs r WHERE r.source_id = s.id) ASC
     LIMIT ?`,
  ).all(MAX_PURGE_CANDIDATES + 1) as SourceCandidateRow[];
  const limited = rows.length > MAX_PURGE_CANDIDATES;
  if (limited) rows.length = MAX_PURGE_CANDIDATES;

  const candidates: PurgeCandidate[] = [];
  const skipped: PurgeSkip[] = [];
  for (const row of rows) {
    const evaluated = evaluateCandidate(db, dataDir, cutoff, row);
    if (evaluated.kind === "candidate") {
      candidates.push(evaluated.candidate);
    } else {
      skipped.push({relativePath: row.relative_path, reason: evaluated.reason});
    }
  }

  // 可回收字节估算：capture 文件精确求和；external blob 与外置派生物按
  // 「仅被候选 source 引用且无其它引用」统计实际文件大小（缺失按 0）。
  let externalBlobBytes = 0;
  let derivedArtifactBytes = 0;
  if (candidates.length > 0) {
    const sourceIds = candidates.map(candidate => candidate.sourceId);
    const placeholders = sourceIds.map(() => "?").join(",");
    const blobHashes = db.prepare(
      `SELECT ir.request_body_sha256 AS hash FROM ingestion_records ir
       WHERE ir.source_id IN (${placeholders}) AND ir.request_body_storage = 'external-blob'
       UNION
       SELECT ir.response_body_sha256 AS hash FROM ingestion_records ir
       WHERE ir.source_id IN (${placeholders}) AND ir.response_body_storage = 'external-blob'`,
    ).all(...sourceIds, ...sourceIds) as Array<{hash: string}>;
    for (const {hash} of blobHashes) {
      if (!blobReferencedElsewhere(db, hash, sourceIds)) {
        externalBlobBytes += await fileSizeOf(
          join(dataDir, "blobs", hash.slice(0, 2), `${hash}.body.gz`),
        );
      }
    }
    const artifactHashes = db.prepare(
      `SELECT cs.artifact_hash AS hash FROM context_snapshots cs
       JOIN agent_steps st ON st.id = cs.agent_step_id
       JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
       WHERE r.source_id IN (${placeholders}) AND cs.artifact_hash IS NOT NULL
       UNION
       SELECT sd.artifact_hash AS hash FROM step_diffs sd
       JOIN agent_steps st ON st.id = sd.agent_step_id
       JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
       WHERE r.source_id IN (${placeholders}) AND sd.artifact_hash IS NOT NULL`,
    ).all(...sourceIds, ...sourceIds) as Array<{hash: string}>;
    for (const {hash} of artifactHashes) {
      if (!artifactReferencedElsewhere(db, hash, sourceIds)) {
        derivedArtifactBytes += await fileSizeOf(derivedArtifactPath(dataDir, hash));
      }
    }
  }

  const captureFiles = candidates.reduce((sum, item) => sum + item.fileBytes, 0);
  const orphanReclaim = await previewOrphanSweep(db, dataDir);
  return {
    retentionDays,
    cutoff,
    candidates,
    skipped,
    reclaimableBytes: {
      captureFiles,
      externalBlobs: externalBlobBytes,
      derivedArtifacts: derivedArtifactBytes,
      total: captureFiles + externalBlobBytes + derivedArtifactBytes,
    },
    orphanReclaim,
    limited,
  };
}

export async function executeRawPurge(
  db: DeepaaDatabase,
  dataDir: string,
): Promise<PurgeExecutionResult> {
  const preview = await previewRawPurge(db, dataDir);
  const result: PurgeExecutionResult = {
    purgedFiles: [],
    deletedBlobFiles: 0,
    deletedDerivedArtifactFiles: 0,
    deletedOrphanBlobFiles: 0,
    deletedOrphanArtifactFiles: 0,
    vacuumedPages: 0,
    skippedCount: preview.skipped.length,
    errors: [],
  };
  const gcBlobHashes = new Set<string>();
  const gcArtifactHashes = new Set<string>();

  for (const candidate of preview.candidates) {
    try {
      const collected = purgeOneSource(db, dataDir, candidate.sourceId);
      for (const hash of collected.externalBlobHashes) gcBlobHashes.add(hash);
      for (const hash of collected.artifactHashes) gcArtifactHashes.add(hash);
      await rmWithTransientLockRetry(join(dataDir, candidate.relativePath), {force: true});
      result.purgedFiles.push({
        relativePath: candidate.relativePath,
        fileBytes: candidate.fileBytes,
        exchangeCount: candidate.exchangeCount,
      });
    } catch (error) {
      result.errors.push({
        relativePath: candidate.relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  result.deletedBlobFiles = await gcExternalBlobs(db, dataDir, gcBlobHashes);
  result.deletedDerivedArtifactFiles = await gcDerivedArtifacts(
    db,
    dataDir,
    gcArtifactHashes,
  );
  // 孤儿清扫（无引用外部件兜底回收）：与按 source 的 GC 互补，覆盖写入/登记
  // 竞态、历史 bug 残留与 dedup 副本产生的孤儿（2026-09-21 用户确认）。
  const orphanSweep = await sweepOrphanExternalArtifacts(db, dataDir);
  result.deletedOrphanBlobFiles = orphanSweep.deletedBlobFiles;
  result.deletedOrphanArtifactFiles = orphanSweep.deletedArtifactFiles;
  try {
    const before = db.pragma("freelist_count", {simple: true}) as number;
    db.exec("PRAGMA incremental_vacuum");
    // 大量删除会产生大体量 WAL，TRUNCATE 截断归还磁盘（读者持锁时失败不影响正确性）。
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const after = db.pragma("freelist_count", {simple: true}) as number;
    result.vacuumedPages = Math.max(0, before - after);
  } catch {
    // 空间回收失败不影响数据正确性；下次清理会再次尝试。
  }
  return result;
}

function evaluateCandidate(
  db: DeepaaDatabase,
  dataDir: string,
  cutoff: string,
  row: SourceCandidateRow,
): {kind: "candidate"; candidate: PurgeCandidate} | {kind: "skip"; reason: PurgeSkipReason} {
  if (row.status !== "ready") return {kind: "skip", reason: "status_not_ready"};
  // 非捕获文件数据源（如对账补差的 reconciliation://synthetic 合成行）：无对应
  // 磁盘文件，账本锚点永久保留，一律不参与清理。
  if (!row.relative_path.startsWith("captures/v2/")) {
    return {kind: "skip", reason: "non_capture_source"};
  }
  if (row.active_jobs > 0) return {kind: "skip", reason: "active_jobs"};
  if (row.exchange_count === 0) {
    // 零派生引用：扫描已完毕（双游标到文件尾）且登记全部超窗/为空的文件可整文件
    // 清理——典型是本地导入重复副本（全部行被 exchangeId 幂等去重拒绝、零登记）
    // 或全部行超窗 archived 的文件；尚未扫描完成的仍跳过。
    const fullyScanned = row.byte_offset >= row.file_size && row.scan_offset >= row.file_size;
    const noInWindowRecords = row.latest_record_captured_at === null
      || row.latest_record_captured_at < cutoff;
    if (!fullyScanned || !noInWindowRecords) {
      return {kind: "skip", reason: "no_records"};
    }
    // 落到下方文件身份/活跃期检查后成为零登记候选。
  } else if (row.latest_captured_at !== null && row.latest_captured_at >= cutoff) {
    return {kind: "skip", reason: "mixed_window"};
  }
  const expectedPath = resolve(dataDir, row.relative_path);
  // lexical 防御：relative_path 必须仍在 captures/v2 下。
  const captureRoot = resolve(dataDir, "captures", "v2");
  if (!expectedPath.startsWith(captureRoot + "/") && expectedPath !== captureRoot) {
    return {kind: "skip", reason: "file_identity_mismatch"};
  }
  let info;
  try {
    info = statSyncSafe(expectedPath);
  } catch {
    return {kind: "skip", reason: "stat_failed"};
  }
  if (!info) return {kind: "skip", reason: "stat_failed"};
  if (sourceFileId(info.dev, info.ino) !== row.file_id) {
    return {kind: "skip", reason: "file_identity_mismatch"};
  }
  if (Date.now() - info.mtimeMs < ACTIVE_FILE_GRACE_MS) {
    return {kind: "skip", reason: "recently_modified"};
  }
  // 零登记候选额外要求磁盘大小与登记时一致：判定删除不依赖 refs，必须排除
  // 「发现后文件又增长、DB file_size 过期」的竞态。
  if (row.exchange_count === 0 && info.size !== row.file_size) {
    return {kind: "skip", reason: "file_identity_mismatch"};
  }
  const capturedFallback = row.latest_captured_at ?? row.latest_record_captured_at ?? "";
  return {
    kind: "candidate",
    candidate: {
      sourceId: row.id,
      relativePath: row.relative_path,
      fileBytes: row.file_size,
      exchangeCount: row.exchange_count,
      earliestCapturedAt: row.earliest_captured_at ?? capturedFallback,
      latestCapturedAt: capturedFallback,
    },
  };
}

interface PurgedSourceArtifacts {
  externalBlobHashes: string[];
  artifactHashes: string[];
}

/** 单 source 清理：一个短事务完成全部 SQLite 变更；物理删除由调用方在事务外执行。 */
function purgeOneSource(
  db: DeepaaDatabase,
  dataDir: string,
  sourceId: number,
): PurgedSourceArtifacts {
  return db.transaction((): PurgedSourceArtifacts => {
    const externalBlobHashes = (
      db.prepare(
        `SELECT request_body_sha256 AS hash FROM ingestion_records
         WHERE source_id = ? AND request_body_storage = 'external-blob'
         UNION
         SELECT response_body_sha256 AS hash FROM ingestion_records
         WHERE source_id = ? AND response_body_storage = 'external-blob'`,
      ).all(sourceId, sourceId) as Array<{hash: string}>
    ).map(row => row.hash);
    const artifactHashes = (
      db.prepare(
        `SELECT cs.artifact_hash AS hash FROM context_snapshots cs
         JOIN agent_steps st ON st.id = cs.agent_step_id
         JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
         WHERE r.source_id = ? AND cs.artifact_hash IS NOT NULL
         UNION
         SELECT sd.artifact_hash AS hash FROM step_diffs sd
         JOIN agent_steps st ON st.id = sd.agent_step_id
         JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
         WHERE r.source_id = ? AND sd.artifact_hash IS NOT NULL`,
      ).all(sourceId, sourceId) as Array<{hash: string}>
    ).map(row => row.hash);

    // 1) raw 墓碑：step/账本外键永不失效；断开 ingestion_record 引用。
    db.prepare(
      `UPDATE raw_exchange_refs
       SET raw_state = 'purged', ingestion_record_id = NULL
       WHERE source_id = ? AND raw_state = 'active'`,
    ).run(sourceId);

    // 2) raw 直接派生删除（这些表的 CASCADE 依赖 raw 行删除，这里显式删）。
    for (const table of [
      "exchange_content_previews",
      "exchange_content_filter_status",
      "exchange_request_fingerprints",
      "exchange_content_category_stats",
      "exchange_media_descriptors",
    ]) {
      db.prepare(
        `DELETE FROM ${table} WHERE exchange_id IN (
           SELECT exchange_id FROM raw_exchange_refs WHERE source_id = ?)`,
      ).run(sourceId);
    }

    // 3) 派生物墓碑：行保留、正文清空、artifact_hash 清空供 GC。
    for (const [table, column] of [
      ["context_snapshots", "summary_json"],
      ["step_diffs", "diff_json"],
    ] as const) {
      db.prepare(
        `UPDATE ${table}
         SET ${column} = ?, artifact_storage = 'inline',
           artifact_hash = NULL, artifact_size = NULL
         WHERE agent_step_id IN (
           SELECT st.id FROM agent_steps st
           JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
           WHERE r.source_id = ?)`,
      ).run(purgedDerivedArtifactPlaceholder(0), sourceId);
    }

    // 4) 操作性遥测与登记（jobs 随 records 级联删除）。
    db.prepare("DELETE FROM derivation_diagnostics WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM ingestion_records WHERE source_id = ?").run(sourceId);

    // 5) source 行保留为墓碑（raw_exchange_refs.source_id 外键仍指向它），
    //    worker 的 nextSource 按 status 过滤，'purged' 永不入选。
    db.prepare(
      `UPDATE ingestion_sources
       SET status = 'purged', byte_offset = 0, scan_offset = 0, updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), sourceId);

    return {externalBlobHashes, artifactHashes};
  })();
}

function blobReferencedElsewhere(
  db: DeepaaDatabase,
  hash: string,
  purgedSourceIds: number[],
): boolean {
  const placeholders = purgedSourceIds.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT 1 AS hit FROM ingestion_records
     WHERE (request_body_sha256 = ? OR response_body_sha256 = ?)
       AND source_id NOT IN (${placeholders})
     UNION ALL
     SELECT 1 AS hit FROM exchange_media_descriptors WHERE raw_body_sha256 = ?
     LIMIT 1`,
  ).get(hash, hash, ...purgedSourceIds, hash);
  return row !== undefined;
}

function artifactReferencedElsewhere(
  db: DeepaaDatabase,
  hash: string,
  purgedSourceIds: number[],
): boolean {
  const placeholders = purgedSourceIds.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT 1 AS hit FROM context_snapshots cs
     JOIN agent_steps st ON st.id = cs.agent_step_id
     JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
     WHERE cs.artifact_hash = ? AND r.source_id NOT IN (${placeholders})
     UNION ALL
     SELECT 1 AS hit FROM step_diffs sd
     JOIN agent_steps st ON st.id = sd.agent_step_id
     JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
     WHERE sd.artifact_hash = ? AND r.source_id NOT IN (${placeholders})
     LIMIT 1`,
  ).get(hash, ...purgedSourceIds, hash, ...purgedSourceIds);
  return row !== undefined;
}

async function gcExternalBlobs(
  db: DeepaaDatabase,
  dataDir: string,
  hashes: Set<string>,
): Promise<number> {
  let deleted = 0;
  for (const hash of hashes) {
    // GC 前再次确认引用计数（并发清理/共享内容）。
    const row = db.prepare(
      `SELECT 1 AS hit FROM ingestion_records
       WHERE request_body_sha256 = ? OR response_body_sha256 = ?
       UNION ALL
       SELECT 1 AS hit FROM exchange_media_descriptors WHERE raw_body_sha256 = ?
       LIMIT 1`,
    ).get(hash, hash, hash);
    if (row) continue;
    const blobPath = join(dataDir, "blobs", hash.slice(0, 2), `${hash}.body.gz`);
    try {
      await rmWithTransientLockRetry(blobPath, {force: true});
      deleted += 1;
    } catch {
      // 单个 blob 删除失败不阻塞；下次清理重试。
    }
  }
  return deleted;
}

async function gcDerivedArtifacts(
  db: DeepaaDatabase,
  dataDir: string,
  hashes: Set<string>,
): Promise<number> {
  let deleted = 0;
  for (const hash of hashes) {
    const row = db.prepare(
      `SELECT 1 AS hit FROM context_snapshots WHERE artifact_hash = ?
       UNION ALL
       SELECT 1 AS hit FROM step_diffs WHERE artifact_hash = ?
       LIMIT 1`,
    ).get(hash, hash);
    if (row) continue;
    try {
      await rmWithTransientLockRetry(derivedArtifactPath(dataDir, hash), {force: true});
      deleted += 1;
    } catch {
      // 同上：失败不阻塞。
    }
  }
  return deleted;
}

/** 孤儿扫描的单目录条目（哈希 + mtime，用于引用比对与活跃安全期判定）。 */
interface ExternalArtifactEntry {
  hash: string;
  path: string;
  mtimeMs: number;
  bytes: number;
}

/** 引用比对批大小（大数据保护：IN 子句有界，绝不整表加载）。 */
const REFERENCE_LOOKUP_BATCH = 400;

/**
 * 孤儿外部件（blob / 派生物）清扫（2026-09-21 用户确认）：目录里存在、但 SQLite
 * 无任何引用（登记哈希 / 媒体描述符 / 派生物哈希）、且 mtime 超过活跃安全期的
 * 文件即孤儿——典型来源是写入侧与登记侧的竞态、历史 bug 的双重存储残留与
 * dedup 副本。正常引用链的文件绝不触碰；扫描有界，超限诚实返回 limited。
 */
async function collectExternalArtifactEntries(
  root: string,
  suffix: string,
  entries: Array<ExternalArtifactEntry>,
  budget: {scanned: number; limited: boolean},
): Promise<void> {
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return;
  }
  try {
    for (;;) {
      if (budget.scanned >= MAX_STAT_ENTRIES) {
        budget.limited = true;
        return;
      }
      const entry = await directory.read();
      if (entry === null) break;
      if (entry.isDirectory()) {
        await collectExternalArtifactEntries(join(root, entry.name), suffix, entries, budget);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        budget.scanned += 1;
        const full = join(root, entry.name);
        try {
          const info = await lstat(full);
          entries.push({
            hash: entry.name.slice(0, -suffix.length),
            path: full,
            mtimeMs: info.mtimeMs,
            bytes: info.size,
          });
        } catch {
          // 竞态删除的文件按不存在处理。
        }
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

/** 分批比对哈希引用，返回「仍被引用」的哈希集合。paramRepeat = SQL 中占位符组数。 */
async function collectReferencedHashes(
  db: DeepaaDatabase,
  hashes: string[],
  buildSql: (placeholders: string) => string,
  paramRepeat: number,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (let index = 0; index < hashes.length; index += REFERENCE_LOOKUP_BATCH) {
    const slice = hashes.slice(index, index + REFERENCE_LOOKUP_BATCH);
    const placeholders = slice.map(() => "?").join(",");
    const params: string[] = [];
    for (let repeat = 0; repeat < paramRepeat; repeat += 1) params.push(...slice);
    const rows = db.prepare(buildSql(placeholders)).all(...params) as Array<{h: string}>;
    for (const row of rows) referenced.add(row.h);
  }
  return referenced;
}

function blobReferenceSql(placeholders: string): string {
  return `SELECT request_body_sha256 AS h FROM ingestion_records
     WHERE request_body_sha256 IN (${placeholders})
   UNION ALL
   SELECT response_body_sha256 AS h FROM ingestion_records
     WHERE response_body_sha256 IN (${placeholders})
   UNION ALL
   SELECT raw_body_sha256 AS h FROM exchange_media_descriptors
     WHERE raw_body_sha256 IN (${placeholders})`;
}

function artifactReferenceSql(placeholders: string): string {
  return `SELECT artifact_hash AS h FROM context_snapshots WHERE artifact_hash IN (${placeholders})
   UNION ALL
   SELECT artifact_hash AS h FROM step_diffs WHERE artifact_hash IN (${placeholders})`;
}

interface ExternalArtifactScan {
  blobs: ExternalArtifactEntry[];
  artifacts: ExternalArtifactEntry[];
  limited: boolean;
}

async function scanExternalArtifacts(dataDir: string): Promise<ExternalArtifactScan> {
  const budget = {scanned: 0, limited: false};
  const blobs: ExternalArtifactEntry[] = [];
  const artifacts: ExternalArtifactEntry[] = [];
  await collectExternalArtifactEntries(join(dataDir, "blobs"), ".body.gz", blobs, budget);
  await collectExternalArtifactEntries(
    join(dataDir, DERIVED_ARTIFACT_DIR_NAME),
    ".json.gz",
    artifacts,
    budget,
  );
  return {blobs, artifacts, limited: budget.limited};
}

function isBeyondActiveGrace(entry: ExternalArtifactEntry, nowMs: number): boolean {
  return nowMs - entry.mtimeMs >= ACTIVE_FILE_GRACE_MS;
}

/** 孤儿预览：不删除，只统计可额外回收的文件数与字节（同样应用活跃安全期）。 */
export async function previewOrphanSweep(
  db: DeepaaDatabase,
  dataDir: string,
  nowMs: number = Date.now(),
): Promise<PurgePreview["orphanReclaim"]> {
  const scan = await scanExternalArtifacts(dataDir);
  if (scan.limited) {
    return {blobFileCount: 0, artifactFileCount: 0, bytes: 0, limited: true};
  }
  const referencedBlobs = await collectReferencedHashes(
    db,
    scan.blobs.map(entry => entry.hash),
    blobReferenceSql,
    3,
  );
  const referencedArtifacts = await collectReferencedHashes(
    db,
    scan.artifacts.map(entry => entry.hash),
    artifactReferenceSql,
    2,
  );
  let blobCount = 0;
  let artifactCount = 0;
  let bytes = 0;
  for (const entry of scan.blobs) {
    if (referencedBlobs.has(entry.hash) || !isBeyondActiveGrace(entry, nowMs)) continue;
    blobCount += 1;
    bytes += entry.bytes;
  }
  for (const entry of scan.artifacts) {
    if (referencedArtifacts.has(entry.hash) || !isBeyondActiveGrace(entry, nowMs)) continue;
    artifactCount += 1;
    bytes += entry.bytes;
  }
  return {blobFileCount: blobCount, artifactFileCount: artifactCount, bytes, limited: false};
}

/** 孤儿执行：删除无引用且超活跃安全期的外部件；单文件失败不阻塞。 */
export async function sweepOrphanExternalArtifacts(
  db: DeepaaDatabase,
  dataDir: string,
  nowMs: number = Date.now(),
): Promise<{deletedBlobFiles: number; deletedArtifactFiles: number; limited: boolean}> {
  const scan = await scanExternalArtifacts(dataDir);
  if (scan.limited) {
    return {deletedBlobFiles: 0, deletedArtifactFiles: 0, limited: true};
  }
  const referencedBlobs = await collectReferencedHashes(
    db,
    scan.blobs.map(entry => entry.hash),
    blobReferenceSql,
    3,
  );
  const referencedArtifacts = await collectReferencedHashes(
    db,
    scan.artifacts.map(entry => entry.hash),
    artifactReferenceSql,
    2,
  );
  let deletedBlobs = 0;
  let deletedArtifacts = 0;
  for (const entry of scan.blobs) {
    if (referencedBlobs.has(entry.hash) || !isBeyondActiveGrace(entry, nowMs)) continue;
    try {
      await rmWithTransientLockRetry(entry.path, {force: true});
      deletedBlobs += 1;
    } catch {
      // 单个失败下轮重试。
    }
  }
  for (const entry of scan.artifacts) {
    if (referencedArtifacts.has(entry.hash) || !isBeyondActiveGrace(entry, nowMs)) continue;
    try {
      await rmWithTransientLockRetry(entry.path, {force: true});
      deletedArtifacts += 1;
    } catch {
      // 同上。
    }
  }
  return {deletedBlobFiles: deletedBlobs, deletedArtifactFiles: deletedArtifacts, limited: false};
}

function statSyncSafe(path: string): {dev: number; ino: number; mtimeMs: number; size: number} | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    return {dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size};
  } catch {
    return undefined;
  }
}

async function fileSizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

export interface StorageBucketStats {
  bytes: number;
  fileCount: number;
  truncated: boolean;
}

export interface StorageStats {
  captures: StorageBucketStats;
  blobs: StorageBucketStats;
  derivedBlobs: StorageBucketStats;
  sqlite: StorageBucketStats;
  config: StorageBucketStats;
}

/** 各目录体量的有界统计（大数据保护：条目上限 + truncated 标记）。 */
export async function collectStorageStats(dataDir: string): Promise<StorageStats> {
  const [captures, blobs, derivedBlobs, config] = await Promise.all([
    walkDirectoryStats(join(dataDir, "captures")),
    walkDirectoryStats(join(dataDir, "blobs")),
    walkDirectoryStats(join(dataDir, DERIVED_ARTIFACT_DIR_NAME)),
    walkDirectoryStats(join(dataDir, "config")),
  ]);
  const sqlite = await sqliteStats(dataDir);
  return {captures, blobs, derivedBlobs, sqlite, config};
}

async function walkDirectoryStats(root: string): Promise<StorageBucketStats> {
  const stats: StorageBucketStats = {bytes: 0, fileCount: 0, truncated: false};
  try {
    await walk(root, stats, 0);
  } catch {
    // 目录不存在按空统计。
  }
  return stats;
}

async function walk(
  dir: string,
  stats: StorageBucketStats,
  depth: number,
): Promise<void> {
  if (depth > 4) {
    stats.truncated = true;
    return;
  }
  const directory = await opendir(dir);
  for (;;) {
    if (stats.fileCount >= MAX_STAT_ENTRIES) {
      stats.truncated = true;
      await directory.close();
      return;
    }
    const entry = await directory.read();
    if (entry === null) break;
    if (entry.isDirectory()) {
      await walk(join(dir, entry.name), stats, depth + 1);
    } else if (entry.isFile()) {
      try {
        const info = await lstat(join(dir, entry.name));
        stats.bytes += info.size;
        stats.fileCount += 1;
      } catch {
        // 竞态删除的文件按不存在处理。
      }
    }
  }
  await directory.close();
}

async function sqliteStats(dataDir: string): Promise<StorageBucketStats> {
  const stats: StorageBucketStats = {bytes: 0, fileCount: 0, truncated: false};
  for (const suffix of ["deepaa.sqlite", "deepaa.sqlite-wal", "deepaa.sqlite-shm"]) {
    try {
      const info = await lstat(join(dataDir, suffix));
      stats.bytes += info.size;
      stats.fileCount += 1;
    } catch {
      // WAL/SHM 可能不存在。
    }
  }
  return stats;
}
