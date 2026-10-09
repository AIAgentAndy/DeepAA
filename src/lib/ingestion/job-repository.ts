import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {
  ProjectionCompleteness,
  RawBodyVerification,
} from "../db/models";
import { assertWorkerLease } from "./worker-lease";

const MAX_ATTEMPTS = 6;
const MAX_ERROR_BYTES = 2_048;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export interface DerivationJobClaim {
  ingestionRecordId: number;
  projectionVersion: number;
  exchangeId: string;
  sourceId: number;
  sourceGeneration: number;
  sourceFileId: string;
  sourceRelativePath: string;
  byteOffset: number;
  lineLengthBytes: number;
  lineSha256: string;
  attemptCount: number;
  ownerId: string;
}

export interface ClaimDerivationJobOptions {
  ownerId: string;
  now?: string;
  afterIngestionRecordId?: number;
}

export interface MarkDerivationJobRetryOptions {
  errorCode: string;
  errorMessage: string;
  now?: string;
}

export interface DeferDerivationJobOptions {
  /** 顺延时长（毫秒）：对齐身份标注扫描节拍（dsh 为 2s）。 */
  delayMs: number;
  now?: string;
}

export interface MarkDerivationJobSucceededOptions {
  completeness: Exclude<ProjectionCompleteness, "unavailable">;
  limitedDimensions: string[];
  requestVerification: RawBodyVerification;
  responseVerification: RawBodyVerification;
  now?: string;
  onCommit?: () => void;
}

export interface MarkDerivationJobPermanentErrorOptions {
  errorCode: string;
  errorMessage: string;
  requestVerification?: RawBodyVerification;
  responseVerification?: RawBodyVerification;
  now?: string;
}

export interface ResetStaleDerivationJobsOptions {
  /** locked_at 早于该时刻的 running 任务视为僵尸锁。 */
  staleLockBefore: string;
  now: string;
  /** 重置后的重试延迟；避免立即重试造成抖动，测试可传 0。 */
  retryDelayMs?: number;
}

interface ClaimRow {
  ingestion_record_id: number;
  projection_version: number;
  exchange_id: string;
  source_id: number;
  source_generation: number;
  source_file_id: string;
  relative_path: string;
  byte_offset: number;
  line_length_bytes: number;
  line_sha256: string;
  attempt_count: number;
}

export function claimNextDerivationJob(
  db: DeepaaDatabase,
  options: ClaimDerivationJobOptions,
): DerivationJobClaim | undefined {
  const now = options.now ?? new Date().toISOString();
  return db.transaction(() => {
    assertLease(db, options.ownerId, now);
    const row = selectClaimCandidate(
      db,
      now,
      options.afterIngestionRecordId,
    );
    if (!row) return undefined;
    const result = db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'running', attempt_count = attempt_count + 1,
         locked_by = ?, locked_at = ?, updated_at = ?,
         last_error_code = NULL, last_error_message = NULL
       WHERE ingestion_record_id = ? AND projection_version = ?
         AND job_status IN ('pending', 'retry_wait')
         AND available_at <= ?`,
    ).run(
      options.ownerId,
      now,
      now,
      row.ingestion_record_id,
      row.projection_version,
      now,
    );
    if (result.changes !== 1) return undefined;
    return mapClaim(row, options.ownerId);
  })();
}

/**
 * 重置运行锁超时的派生任务。
 *
 * worker 在领取任务后把 job 置为 running 并写 locked_at；如果 worker 崩溃、
 * 事件循环卡死或心跳停止，该 running 任务会永久残留，并因 selectClaimCandidate
 * 的“同 source 前面不能有未完成任务”约束阻塞整个 source 的派生队列。
 * 本函数把 locked_at 早于阈值的 running 任务重置为 retry_wait 并清锁，
 * 让队列可恢复；任务仍会按 available_at 延迟后重试（attempt 计数保留）。
 */
export function resetStaleDerivationJobs(
  db: DeepaaDatabase,
  options: ResetStaleDerivationJobsOptions,
): number {
  const retryDelayMs = options.retryDelayMs ?? 30_000;
  const availableAt = new Date(Date.parse(options.now) + retryDelayMs).toISOString();
  const result = db.prepare(
    `UPDATE derivation_jobs
     SET job_status = 'retry_wait', projection_completeness = NULL,
       locked_by = NULL, locked_at = NULL, available_at = ?,
       last_error_code = 'stale_job_lock',
       last_error_message = '运行锁超时，已重置为可重试',
       updated_at = ?, completed_at = NULL
     WHERE job_status = 'running' AND locked_at IS NOT NULL AND locked_at < ?`,
  ).run(availableAt, options.now, options.staleLockBefore);
  return result.changes;
}

/**
 * 任务处理心跳：worker 处理长任务期间定期刷新 locked_at，
 * 证明任务仍在被处理，避免被 resetStaleDerivationJobs 误判为僵尸锁。
 */
export function touchDerivationJobLock(
  db: DeepaaDatabase,
  claim: DerivationJobClaim,
  now: string,
): void {
  db.prepare(
    `UPDATE derivation_jobs
     SET locked_at = ?, updated_at = ?
     WHERE ingestion_record_id = ? AND projection_version = ?
       AND job_status = 'running' AND locked_by = ?`,
  ).run(now, now, claim.ingestionRecordId, claim.projectionVersion, claim.ownerId);
}

export function markDerivationJobRetry(
  db: DeepaaDatabase,
  claim: DerivationJobClaim,
  options: MarkDerivationJobRetryOptions,
): { status: "retry_wait" | "permanent_error"; availableAt: string } {
  const now = options.now ?? new Date().toISOString();
  const exhausted = claim.attemptCount >= MAX_ATTEMPTS;
  const delay = exhausted
    ? 0
    : RETRY_DELAYS_MS[Math.min(claim.attemptCount - 1, RETRY_DELAYS_MS.length - 1)]!;
  const availableAt = new Date(Date.parse(now) + delay).toISOString();
  db.transaction(() => {
    // 2026-09-18：这里**刻意不校验租约**。失败回写的唯一职责是把本次尝试的结果
    // 落库；行级条件（job_status='running' + locked_by=ownerId + attempt_count 匹配）
    // 已经是充分的所有权证明——其他 worker 无法领取仍处于 running 且锁未超时的任务。
    // 此前带租约校验会在"主线程被长任务占满 → 租约过期"时让回写自己抛错，任务
    // 永久停在 running（僵尸锁），并按 claim 的"同 source 前序未完成"约束锁死整个
    // 文件后续记录（实测 174 条积压）。校验放在本函数只会掩盖真实失败原因。
    const result = db.prepare(
      `UPDATE derivation_jobs
       SET job_status = ?, projection_completeness = ?, available_at = ?,
         locked_by = NULL, locked_at = NULL, last_error_code = ?,
         last_error_message = ?, updated_at = ?, completed_at = ?
       WHERE ingestion_record_id = ? AND projection_version = ?
         AND job_status = 'running' AND locked_by = ?
         AND attempt_count = ?`,
    ).run(
      exhausted ? "permanent_error" : "retry_wait",
      exhausted ? "unavailable" : null,
      availableAt,
      boundedUtf8(options.errorCode, 256),
      boundedUtf8(options.errorMessage, MAX_ERROR_BYTES),
      now,
      exhausted ? now : null,
      claim.ingestionRecordId,
      claim.projectionVersion,
      claim.ownerId,
      claim.attemptCount,
    );
    if (result.changes !== 1) throw new Error("派生任务重试提交冲突。");
  })();
  return {
    status: exhausted ? "permanent_error" : "retry_wait",
    availableAt,
  };
}

/**
 * dsh 身份等待顺延（2026-09-22）：把「标注未到」的领取原样交还队列——回 pending、
 * available_at 顺延、清锁，**不写任何错误码**。与 markDerivationJobRetry 的关键
 * 差异：`attempt_count` 减回领取时的 +1——顺延不是失败，不得消耗错误重试预算
 * （否则 2s 顺延节奏会很快把 attempt 推过 MAX_ATTEMPTS，让后续真实错误直接
 * permanent_error）。有界性由 prepareRecord 的 90s 年龄窗口保证：超窗按现状
 * 派生并写 dsh_identity_missing 诊断，不会无限顺延。
 * 与其它终态/重试回写一致：只认行级所有权（running + locked_by + attempt_count
 * 匹配），不校验租约。
 */
export function deferDerivationJob(
  db: DeepaaDatabase,
  claim: DerivationJobClaim,
  options: DeferDerivationJobOptions,
): void {
  const now = options.now ?? new Date().toISOString();
  const availableAt = new Date(Date.parse(now) + options.delayMs).toISOString();
  db.transaction(() => {
    const result = db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'pending', attempt_count = attempt_count - 1,
         available_at = ?, locked_by = NULL, locked_at = NULL,
         last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE ingestion_record_id = ? AND projection_version = ?
         AND job_status = 'running' AND locked_by = ?
         AND attempt_count = ?`,
    ).run(
      availableAt,
      now,
      claim.ingestionRecordId,
      claim.projectionVersion,
      claim.ownerId,
      claim.attemptCount,
    );
    if (result.changes !== 1) throw new Error("派生任务顺延提交冲突。");
  })();
}

export function markDerivationJobSucceeded(
  db: DeepaaDatabase,
  claim: DerivationJobClaim,
  options: MarkDerivationJobSucceededOptions,
): void {
  const now = options.now ?? new Date().toISOString();
  const dimensions = [...new Set(options.limitedDimensions)].slice(0, 32);
  db.transaction(() => {
    assertLease(db, claim.ownerId, now);
    const result = db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'succeeded', projection_completeness = ?,
         limited_dimensions_json = ?, request_verification = ?,
         response_verification = ?, locked_by = NULL, locked_at = NULL,
         updated_at = ?, completed_at = ?
       WHERE ingestion_record_id = ? AND projection_version = ?
         AND job_status = 'running' AND locked_by = ?
         AND attempt_count = ?`,
    ).run(
      options.completeness,
      JSON.stringify(dimensions.map(value => boundedUtf8(value, 128))),
      options.requestVerification,
      options.responseVerification,
      now,
      now,
      claim.ingestionRecordId,
      claim.projectionVersion,
      claim.ownerId,
      claim.attemptCount,
    );
    if (result.changes !== 1) throw new Error("派生任务成功提交冲突。");
    options.onCommit?.();
  })();
}

export function markDerivationJobPermanentError(
  db: DeepaaDatabase,
  claim: DerivationJobClaim,
  options: MarkDerivationJobPermanentErrorOptions,
): void {
  const now = options.now ?? new Date().toISOString();
  db.transaction(() => {
    // 与 markDerivationJobRetry 同理：终态回写只认行级所有权，不校验租约——
    // 否则租约过期会让失败任务既不重试也不终结，永久卡住同文件后续记录。
    const result = db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'permanent_error', projection_completeness = 'unavailable',
         locked_by = NULL, locked_at = NULL, last_error_code = ?,
         last_error_message = ?, request_verification = ?,
         response_verification = ?, updated_at = ?, completed_at = ?
       WHERE ingestion_record_id = ? AND projection_version = ?
         AND job_status = 'running' AND locked_by = ?
         AND attempt_count = ?`,
    ).run(
      boundedUtf8(options.errorCode, 256),
      boundedUtf8(options.errorMessage, MAX_ERROR_BYTES),
      options.requestVerification ?? "failed",
      options.responseVerification ?? "failed",
      now,
      now,
      claim.ingestionRecordId,
      claim.projectionVersion,
      claim.ownerId,
      claim.attemptCount,
    );
    if (result.changes !== 1) throw new Error("派生任务永久失败提交冲突。");
  })();
}

/**
 * 批次崩溃兜底：释放本 worker 名下所有仍处于 `running` 的派生任务（2026-09-18）。
 *
 * 为什么需要：一次批次在领取任务后、提交终态前抛错（例如主线程被长任务占满导致
 * 租约过期、或提交事务本身失败）时，任务会以 `running` + 冻结锁的形式残留。由于
 * `selectClaimCandidate` 的「同 source 前序未完成不得领取」约束，这一条残留会把
 * **整个文件**的后续记录锁死，直到 `resetStaleDerivationJobs` 满 5 分钟才放行
 * （2026-09-18 实测：2 条残留记录积压 174→300 条待处理）。
 *
 * 本函数**刻意不校验租约**：批次已经失败，此时唯一正确的动作是把"我领了但没做完"
 * 的任务交还队列。`locked_by = ownerId` 保证不会碰别的 worker 的任务；若租约已被
 * 他人接管并重新领取了同名任务，`locked_by` 已变，本函数自然跳过。
 */
export function releaseWorkerClaims(
  db: DeepaaDatabase,
  ownerId: string,
  options: {errorCode: string; errorMessage: string; now?: string},
): number {
  const now = options.now ?? new Date().toISOString();
  const availableAt = new Date(Date.parse(now) + RETRY_DELAYS_MS[0]!).toISOString();
  const result = db.prepare(
    `UPDATE derivation_jobs
     SET job_status = CASE WHEN attempt_count >= ? THEN 'permanent_error' ELSE 'retry_wait' END,
       projection_completeness = CASE WHEN attempt_count >= ? THEN 'unavailable' ELSE NULL END,
       available_at = ?,
       locked_by = NULL,
       locked_at = NULL,
       last_error_code = ?,
       last_error_message = ?,
       request_verification = CASE WHEN attempt_count >= ? THEN 'failed' ELSE request_verification END,
       response_verification = CASE WHEN attempt_count >= ? THEN 'failed' ELSE response_verification END,
       updated_at = ?,
       completed_at = CASE WHEN attempt_count >= ? THEN ? ELSE NULL END
     WHERE job_status = 'running' AND locked_by = ?`,
  ).run(
    MAX_ATTEMPTS,
    MAX_ATTEMPTS,
    availableAt,
    boundedUtf8(options.errorCode, 256),
    boundedUtf8(options.errorMessage, MAX_ERROR_BYTES),
    MAX_ATTEMPTS,
    MAX_ATTEMPTS,
    now,
    MAX_ATTEMPTS,
    now,
    ownerId,
  );
  return result.changes;
}

function selectClaimCandidate(
  db: DeepaaDatabase,
  now: string,
  afterId: number | undefined,
): ClaimRow | undefined {
  const fields = `j.ingestion_record_id, j.projection_version,
    r.exchange_id, r.source_id, r.source_generation, r.source_file_id,
    s.relative_path, r.byte_offset, r.line_length_bytes, r.line_sha256,
    j.attempt_count`;
  // 文件级最新优先、文件内正序（决策 D4）：source 按 last_captured_at 倒序（新近
  // 文件先派生，重启补投影时用户最关心的当前会话最先可见），source 内仍严格
  // generation/byte_offset 升序——thread 拼接、occurrence 去重与 step diff 的
  // 正确性依赖同文件前序先派生。批内分页（afterId）只影响本批去重，不影响跨批顺序。
  const ordering = afterId === undefined
    ? "s.last_captured_at DESC, s.id DESC, r.source_generation, r.byte_offset"
    : "CASE WHEN j.ingestion_record_id > ? THEN 0 ELSE 1 END, j.ingestion_record_id";
  const params = afterId === undefined ? [now] : [now, afterId];
  return db.prepare(
    `SELECT ${fields}
     FROM derivation_jobs j
     JOIN ingestion_records r ON r.id = j.ingestion_record_id
     JOIN ingestion_sources s ON s.id = r.source_id
     WHERE j.job_status IN ('pending', 'retry_wait')
       AND j.available_at <= ?
       AND NOT EXISTS(
         SELECT 1
         FROM ingestion_records earlier
         JOIN derivation_jobs earlier_job
           ON earlier_job.ingestion_record_id = earlier.id
          AND earlier_job.projection_version = j.projection_version
         WHERE earlier.source_id = r.source_id
           AND earlier.source_generation = r.source_generation
           AND earlier.byte_offset < r.byte_offset
           AND earlier_job.job_status IN ('pending', 'running', 'retry_wait')
       )
     ORDER BY ${ordering}
     LIMIT 1`,
  ).get(...params) as ClaimRow | undefined;
}

function mapClaim(row: ClaimRow, ownerId: string): DerivationJobClaim {
  return {
    ingestionRecordId: row.ingestion_record_id,
    projectionVersion: row.projection_version,
    exchangeId: row.exchange_id,
    sourceId: row.source_id,
    sourceGeneration: row.source_generation,
    sourceFileId: row.source_file_id,
    sourceRelativePath: row.relative_path,
    byteOffset: row.byte_offset,
    lineLengthBytes: row.line_length_bytes,
    lineSha256: row.line_sha256,
    attemptCount: row.attempt_count + 1,
    ownerId,
  };
}

function assertLease(
  db: DeepaaDatabase,
  ownerId: string,
  now: string,
): void {
  assertWorkerLease(db, ownerId, now);
}

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
