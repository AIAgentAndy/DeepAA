import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {sqliteErrorCodeName} from "@/lib/db/sqlite-driver";
import { statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  deepaaDatabasePath,
  openDeepaaDatabase,
} from "../db/connection";
import { createExchangeProcessor } from "./exchange-processor";
import {
  claimNextDerivationJob,
  deferDerivationJob,
  markDerivationJobPermanentError,
  markDerivationJobRetry,
  releaseWorkerClaims,
  resetStaleDerivationJobs,
  touchDerivationJobLock,
} from "./job-repository";
import {DSH_IDENTITY_DEFER_DELAY_MS} from "../agent-local-source/identity-links";
import { registerRawRecordAndAdvance } from "./registrar";
import { reconcileProjectionWindow } from "./retention-sweep";
import { computeRetentionCutoff, readRetentionConfig } from "../retention";
import {
  runHarnessSnapshotBackfill,
} from "./harness-backfill";
import {
  advanceSourceCursor,
  discoverV2Sources,
  readSourceBatch,
  readRegisteredSourceRecord,
  type SourceBatch,
  type SourceCursorAdvance,
  type SourceLineEntry,
  type V2SourceDiscoveryContinuation,
} from "./raw-source-reader";
import { assertWorkerLease } from "./worker-lease";
import { CURRENT_PROJECTION_VERSION } from "./projection-version";

const DEFAULT_BATCH_RECORDS = 25;
const DEFAULT_BATCH_BYTES = 16 * 1024 * 1024;
const DEFAULT_LINE_BYTES = 8 * 1024 * 1024;
/**
 * Worker 租约 TTL。
 *
 * 2026-09-18 由 15 s 提升到 60 s：单条 Exchange 的同步派生（大 SSE 响应解压 +
 * 投影 + 多处写库）本身可能占用主线程十几秒，而续租与任务心跳都跑在同一个事件
 * 循环上——只要有一次同步块超过 TTL，租约就会在任务进行中被判过期。TTL 提到
 * 60 s 后，正常长任务不再自伤；真正的多进程互斥语义不受影响（租约仍由单行
 * `worker_lease` + 到期时间裁决）。兜底见 releaseWorkerClaims。
 */
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RENEW_MS = 5_000;
const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_MAX_ERROR_BACKOFF_MS = 30_000;
const DEFAULT_DISK_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
/** 任务处理心跳间隔：处理中定期刷新 locked_at，证明任务未被卡死。 */
const DEFAULT_JOB_LOCK_HEARTBEAT_MS = 10_000;
/** 运行锁超时：locked_at 早于该阈值且无心跳更新的 running 任务视为僵尸锁。 */
const DEFAULT_STALE_JOB_LOCK_MS = 5 * 60_000;
/** 僵尸锁重置后的重试延迟，避免同一批立即重试造成抖动。 */
const DEFAULT_STALE_JOB_RESET_DELAY_MS = 30_000;
const DISCOVERY_ENTRIES_PER_BATCH = 25;
const MAX_WORKER_ERROR_BYTES = 2_048;
// v5（2026-09-13）：context snapshot 投影新增 failover 字段（模型故障转移元数据）。
// v6（2026-09-17）：六场景修复——辅助标题签名、指纹类型归一 + 空白折叠、control
// 排除出排重基线、有界消失容忍、unconfirmed epoch 持续化。版本号只标记当前派生
// 版本：新登记行直接按当前版本派生，存量行保持原样（不做自动重投影，2026-09-17
// 用户确认：未上线阶段历史数据不做全量重算，未来如需处理走针对性一次性脚本）。
/** Harness 回填延迟启动：让派生主链路先跑，空闲事件循环里再补历史。 */
const HARNESS_BACKFILL_START_DELAY_MS = 15_000;

interface SourceRow {
  id: number;
  relative_path: string;
  file_id: string;
  generation: number;
  byte_offset: number;
  scan_offset: number;
  file_size: number;
  status: "ready" | "reset";
}

export interface CreateIngestionWorkerOptions {
  dataDir: string;
  ownerId?: string;
  diskReserveBytes?: number;
  staleJobLockMs?: number;
  jobLockHeartbeatMs?: number;
  staleJobResetDelayMs?: number;
  availableDiskBytes?: () => Promise<number>;
  jobTransitionLogger?: (event: DerivationJobTransitionEvent) => void;
  /**
   * 派生批次完成回调（2026-10-09 额度差分估算 F3 双触发之一）：仅在批次实际
   * 派生了 ≥1 条记录时触发，供 Web 侧节流复跑估算回填（闭合派生落库晚于
   * 同步钩子的竞争窗口）。best-effort：异常只吞不阻断 worker 循环。
   */
  batchCompleteListener?: (result: IngestionBatchResult) => void;
}

export interface DerivationJobTransitionEvent {
  event: "derivation-job-transition";
  ingestionRecordId: number;
  exchangeId: string;
  sourceId: number;
  byteOffset: number;
  attempt: number;
  status: "retry_wait" | "permanent_error";
  errorCode: string;
}

export interface IngestionBatchResult {
  leaseAcquired: boolean;
  pausedDisk: boolean;
  processedCount: number;
  discoveredCount: number;
  limited: boolean;
}

export interface IngestionWorker {
  refreshPricingConfig(): Promise<void>;
  acquireLease(): boolean;
  renewLease(): boolean;
  releaseLease(): void;
  runOneBatch(): Promise<IngestionBatchResult>;
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}

type IngestionWorkerGlobal = typeof globalThis & {
  __deepaaIngestionWorkers?: Map<string, IngestionWorker>;
};

/**
 * 创建 SQLite 单写者。异步水合在事务外完成，每个完整 raw 行使用一个固定同步事务提交。
 */
export function createIngestionWorker(
  options: CreateIngestionWorkerOptions,
): IngestionWorker {
  const dataDir = resolve(options.dataDir);
  const ownerId = normalizeOwnerId(options.ownerId);
  const diskReserveBytes = normalizeDiskReserve(options.diskReserveBytes);
  const staleJobLockMs = options.staleJobLockMs ?? DEFAULT_STALE_JOB_LOCK_MS;
  const jobLockHeartbeatMs = options.jobLockHeartbeatMs ?? DEFAULT_JOB_LOCK_HEARTBEAT_MS;
  const staleJobResetDelayMs = options.staleJobResetDelayMs ?? DEFAULT_STALE_JOB_RESET_DELAY_MS;
  const availableDiskBytes = options.availableDiskBytes
    ?? (() => readAvailableDiskBytes(deepaaDatabasePath(dataDir)));
  const jobTransitionLogger = options.jobTransitionLogger
    ?? logDerivationJobTransition;
  const db = openDeepaaDatabase({ dataDir });
  const processor = createExchangeProcessor({ db, dataDir });
  let discoveryContinuation: V2SourceDiscoveryContinuation | undefined;
  let running = false;
  let closed = false;
  let stopping = false;
  let loopTimer: ReturnType<typeof setTimeout> | undefined;
  let errorBackoffMs = DEFAULT_IDLE_POLL_MS;
  let lastSourceId: number | undefined;
  let lastJobId: number | undefined;
  let activeBatch: Promise<IngestionBatchResult> | undefined;
  let stopPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const acquireLease = (): boolean => db.transaction(() => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresAt = new Date(now + DEFAULT_LEASE_MS).toISOString();
    const result = db.prepare(
      `INSERT INTO worker_lease(id, owner_id, expires_at)
       VALUES(1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_id = excluded.owner_id,
         expires_at = excluded.expires_at
       WHERE worker_lease.owner_id = excluded.owner_id
         OR worker_lease.expires_at <= ?`,
    ).run(ownerId, expiresAt, nowIso);
    if (result.changes === 1) {
      // 观察者纪元重置（2026-09-29 用户确认）：水位是"按本观察者的发现语义，
      // 目录已到尾"的历史断言。租约换主意味着观察者变更（进程重启、发版、睡眠唤醒
      // 自抢、目录被外部替换），新观察者不得无偿继承前任的断言——尤其跨版本时发现
      // 语义可能演进。新纪元的首轮完整发现本来就必须执行，水位在其完成时自然恢复，
      // 因此重置成本约为零。
      db.prepare("UPDATE schema_meta SET last_source_scan_completed_at=NULL WHERE id=1").run();
    }
    return result.changes === 1;
  })();

  const renewLease = (): boolean => {
    const now = Date.now();
    const result = db.prepare(
      `UPDATE worker_lease SET expires_at = ?
       WHERE id = 1 AND owner_id = ? AND expires_at > ?`,
    ).run(
      new Date(now + DEFAULT_LEASE_MS).toISOString(),
      ownerId,
      new Date(now).toISOString(),
    );
    return result.changes === 1;
  };

  const releaseLease = (): void => {
    if (!db.open) return;
    db.prepare("DELETE FROM worker_lease WHERE id = 1 AND owner_id = ?")
      .run(ownerId);
  };

  const executeOneBatch = async (): Promise<IngestionBatchResult> => {
    if (closed || !db.open) {
      throw new Error("SQLite ingestion Worker 已停止。");
    }
    if (!renewLease() && !acquireLease()) {
      return emptyBatchResult(false);
    }

    let renewTimer: ReturnType<typeof setInterval> | undefined;
    try {
      renewTimer = setInterval(() => {
        try {
          renewLease();
        } catch {
          // 下一条原子提交会再次校验租约，失败时不会推进 source。
        }
      }, DEFAULT_RENEW_MS);
      renewTimer.unref?.();

      const availableBytes = await availableDiskBytes();
      assertLease(db, ownerId);
      if (availableBytes < diskReserveBytes) {
        setWorkerStatus(db, ownerId, "paused_disk");
        return {
          ...emptyBatchResult(true),
          pausedDisk: true,
        };
      }
      setWorkerStatus(db, ownerId, "running");
      // 对账可用性水位按租约纪元单调（2026-09-29 用户确认，取代"批次开头清空"）：
      // "截至 T 全部源扫到尾"是历史事实，文件只追加，一旦成立不会因之后的事件变假；
      // Worker 现势健康由消费端校验租约与 worker_status（异常批次置 failed、磁盘暂停
      // 置 paused_disk，均被拒收），无需以销毁事实的方式表达。此前每批开头清空使水位
      // 在时间轴上退化为窄脉冲，对账两轮稳定在持续流量下变成运气采样（2026-09-29
      // catapi 实测补差延迟 75 分钟）。
      // 批次开头清理僵尸运行锁：worker 崩溃或卡死停止心跳后，
      // 残留 running 任务不得永久阻塞同 source 派生队列。
      const nowIso = new Date().toISOString();
      const staleLockBefore = new Date(Date.now() - staleJobLockMs).toISOString();
      resetStaleDerivationJobs(db, {
        staleLockBefore,
        now: nowIso,
        retryDelayMs: staleJobResetDelayMs,
      });
      // P2-10：诊断遥测 90 天保留，避免 derivation_diagnostics 只增不减。
      db.prepare(
        `DELETE FROM derivation_diagnostics WHERE created_at < datetime(?, '-90 days')`,
      ).run(nowIso);
      // 每个批次只检查一次配置文件；价格变更不会影响代理转发，只刷新派生写入使用的配置。
      await processor.refreshPricingConfig();
      // 每批读取一次保留配置（小 JSON，读取失败安全回退默认 15 天）；窗口调整后由
      // 有界单向扫描做出窗撤销（调大窗口不补投影，2026-09-21 用户确认），
      // 登记阶段用同一截止时刻过滤。
      const retentionCutoff = computeRetentionCutoff(
        readRetentionConfig(dataDir).rawRetentionDays,
      );
      reconcileProjectionWindow(db, {
        cutoff: retentionCutoff,
        projectionVersion: CURRENT_PROJECTION_VERSION,
      });

      let discovery;
      try {
        discovery = discoveryContinuation
          ? await discoveryContinuation.next({
            maxEntries: DISCOVERY_ENTRIES_PER_BATCH,
            leaseOwnerId: ownerId,
          })
          : await discoverV2Sources(db, dataDir, {
            maxEntries: DISCOVERY_ENTRIES_PER_BATCH,
            leaseOwnerId: ownerId,
          });
      } catch (error) {
        // continuation 在读取错误时会自行关闭，不能让后续批次复用已关闭游标。
        discoveryContinuation = undefined;
        throw error;
      }
      discoveryContinuation = discovery.continuation;
      assertLease(db, ownerId);

      let registeredCount = 0;
      let sourceLimited = false;
      let source = nextSource(db, lastSourceId);
      if (source) {
        lastSourceId = source.id;
        if (source.status === "reset") {
          commitSourceReset(db, source, ownerId);
          source = { ...source, status: "ready" };
        }
        if (source.scan_offset < source.file_size) {
          const batch = await readSourceBatch(
            db,
            join(dataDir, source.relative_path),
            {
              maxRecords: DEFAULT_BATCH_RECORDS,
              maxBytes: DEFAULT_BATCH_BYTES,
              maxLineBytes: DEFAULT_LINE_BYTES,
            },
          );
          registeredCount = registerSourceBatch(db, batch, ownerId, retentionCutoff);
          sourceLimited = batch.limited;
        }
      }
      const processedCount = await processPendingJobs(
        db,
        dataDir,
        processor,
        ownerId,
        lastJobId,
        jobTransitionLogger,
        jobLockHeartbeatMs,
      );
      if (processedCount.lastJobId !== undefined) {
        lastJobId = processedCount.lastJobId;
      }
      assertLease(db, ownerId);
      // 对账可用性水位（单调前进）：目录发现与所有已知 source 均已扫描到尾后才提交，
      // 只前进不清空；未完成 discovery continuation 或仍有待登记字节的批次不提交，
      // 保留上一次完整轮的事实时刻。清空只发生在租约换主（观察者纪元重置）。
      if (!discoveryContinuation && !sourceLimited && !nextSource(db, undefined)) {
        db.prepare(
          `UPDATE schema_meta SET last_source_scan_completed_at=?
           WHERE id=1 AND EXISTS(
             SELECT 1 FROM worker_lease WHERE id=1 AND owner_id=? AND expires_at>?
           )`,
        ).run(new Date().toISOString(), ownerId, new Date().toISOString());
      }
      setWorkerStatus(
        db,
        ownerId,
        registeredCount > 0 || processedCount.count > 0 ? "running" : "idle",
      );
      await yieldToEventLoop();
      return {
        leaseAcquired: true,
        pausedDisk: false,
        processedCount: processedCount.count,
        discoveredCount: discovery.discoveredCount,
        limited: discovery.limited || sourceLimited,
      };
    } catch (error) {
      try {
        setWorkerStatus(db, ownerId, "failed", errorMessage(error));
      } catch {
        // 保留原始异常；SQLite 自身失败时不能由状态记录掩盖根因。
      }
      throw error;
    } finally {
      if (renewTimer) clearInterval(renewTimer);
    }
  };

  const runOneBatch = (): Promise<IngestionBatchResult> => {
    if (closed || !db.open) {
      return Promise.reject(new Error("SQLite ingestion Worker 已停止。"));
    }
    if (stopping) {
      return Promise.reject(new Error("SQLite ingestion Worker 正在停止。"));
    }
    if (activeBatch) return activeBatch;

    const batch = executeOneBatch();
    activeBatch = batch;
    const clearActiveBatch = (): void => {
      if (activeBatch === batch) activeBatch = undefined;
    };
    void batch.then(clearActiveBatch, clearActiveBatch);
    return batch;
  };

  const scheduleLoop = (delayMs: number): void => {
    if (closed || stopping || !running) return;
    loopTimer = setTimeout(() => {
      void loop();
    }, delayMs);
    loopTimer.unref?.();
  };

  const loop = async (): Promise<void> => {
    if (closed || stopping || !running) return;
    try {
      const result = await runOneBatch();
      errorBackoffMs = DEFAULT_IDLE_POLL_MS;
      if (result.processedCount > 0) {
        try {
          options.batchCompleteListener?.(result);
        } catch {
          // 监听器异常不阻断 worker 循环（best-effort 钩子）。
        }
      }
      scheduleLoop(result.processedCount > 0 ? 0 : DEFAULT_IDLE_POLL_MS);
    } catch (error) {
      // 批次崩溃兜底（2026-09-18）：先把我方领了但没做完的任务交还队列，再记诊断。
      // 顺序不能反：诊断是尽力而为，释放锁才是防止整文件队头阻塞的关键动作。
      const errorCode = ingestionErrorCode(error);
      const errorText = errorMessage(error);
      let releasedClaims = 0;
      try {
        releasedClaims = releaseWorkerClaims(db, ownerId, {
          errorCode,
          errorMessage: errorText,
        });
      } catch {
        // 释放失败不能掩盖原始异常；下一条批次仍会走僵尸锁重置兜底。
      }
      try {
        recordBatchFailureDiagnostic(db, {
          code: errorCode,
          message: errorText,
          releasedClaims,
        });
      } catch {
        // 诊断写入失败同样不掩盖原始异常。
      }
      if (!closed && !stopping) {
        // 2026-09-18：此前只记 errorCode，租约丢失被塌缩成 derivation_failed 且
        // 无任何细节。现在带上真实错误文本与释放的任务数，日志即可自证原因。
        console.error("[deepaa] SQLite ingestion batch failed", {
          event: "ingestion-batch-failed",
          errorCode,
          errorMessage: errorText,
          releasedClaims,
        });
      }
      scheduleLoop(errorBackoffMs);
      errorBackoffMs = Math.min(
        errorBackoffMs * 2,
        DEFAULT_MAX_ERROR_BACKOFF_MS,
      );
    }
  };

  const start = (): void => {
    if (running || stopping || closed) return;
    running = true;
    scheduleHarnessBackfill();
    void loop();
  };

  /**
   * Harness Tier A 历史回填（2026-09-11 用户确认 D4）：worker 启动后延迟一次性执行，
   * 只读 SQLite 分批推进（rowid 游标持久化，幂等可重入），绝不读 raw、绝不触碰账本；
   * 失败只降级为本次不回填，不影响派生主链路。
   */
  function scheduleHarnessBackfill(): void {
    const timer = setTimeout(() => {
      if (closed || stopping || !db.open) return;
      try {
        let result = runHarnessSnapshotBackfill(db, { maxBatches: 4 });
        while (!result.finished && !closed && !stopping && db.open) {
          result = runHarnessSnapshotBackfill(db, { maxBatches: 4 });
        }
      } catch {
        // 回填失败不阻塞派生；下次 worker 启动会按持久化游标继续。
      }
    }, HARNESS_BACKFILL_START_DELAY_MS);
    timer.unref?.();
  }

  const takeDiscoveryContinuation = ():
    V2SourceDiscoveryContinuation | undefined => {
    const continuation = discoveryContinuation;
    discoveryContinuation = undefined;
    return continuation;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    running = false;
    stopping = true;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = undefined;
    const continuation = takeDiscoveryContinuation();
    const batch = activeBatch;
    stopPromise = (async () => {
      try {
        await continuation?.close().catch(() => undefined);
        await batch?.catch(() => undefined);
        const trailingContinuation = takeDiscoveryContinuation();
        if (trailingContinuation && trailingContinuation !== continuation) {
          await trailingContinuation.close().catch(() => undefined);
        }
        releaseLease();
      } finally {
        stopping = false;
        stopPromise = undefined;
      }
    })();
    return stopPromise;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      await stop();
      if (db.open) db.close();
    })();
    return closePromise;
  };

  return {
    refreshPricingConfig: () => processor.refreshPricingConfig(),
    acquireLease,
    renewLease,
    releaseLease,
    runOneBatch,
    start,
    stop,
    close,
  };
}

/** Next instrumentation 使用的进程级幂等启动入口。 */
export function startIngestionWorker(
  options: CreateIngestionWorkerOptions,
): () => Promise<void> {
  const globalState = globalThis as IngestionWorkerGlobal;
  const workers = globalState.__deepaaIngestionWorkers
    ?? (globalState.__deepaaIngestionWorkers = new Map());
  const key = resolve(options.dataDir);
  let worker = workers.get(key);
  if (!worker) {
    worker = createIngestionWorker(options);
    workers.set(key, worker);
    worker.start();
  }
  return async () => {
    const current = workers.get(key);
    if (!current) return;
    await current.close();
    if (workers.get(key) === current) workers.delete(key);
  };
}

function registerSourceBatch(
  db: DeepaaDatabase,
  batch: SourceBatch,
  ownerId: string,
  retentionCutoff?: string,
): number {
  let expectedByteOffset = batch.startOffset;
  let expectedScanOffset = batch.startScanOffset;
  let expectedFileSize = batch.sourceFileSize;
  let processedCount = 0;

  for (const entry of batch.entries) {
    if (entry.byteOffset !== expectedByteOffset) {
      throw new Error(
        `source 行顺序不连续：${batch.relativePath} 的 ${entry.byteOffset} 不等于 ${expectedByteOffset}`,
      );
    }
    const lineEnd = entry.byteOffset + entry.lineLengthBytes;
    const cursor: SourceCursorAdvance = {
      sourceId: batch.sourceId,
      relativePath: batch.relativePath,
      fileId: batch.fileId,
      generation: batch.sourceGeneration,
      expectedFileSize,
      nextFileSize: batch.fileSize,
      expectedByteOffset,
      expectedScanOffset,
      nextByteOffset: lineEnd,
      nextScanOffset: lineEnd,
      processedCount: 1,
    };

    if (entry.kind === "record") {
      registerRawRecordAndAdvance(db, {
        sourceId: batch.sourceId,
        sourceRelativePath: batch.relativePath,
        sourceFileId: batch.fileId,
        sourceGeneration: batch.sourceGeneration,
        record: entry,
        cursor,
        leaseOwnerId: ownerId,
        projectionVersion: CURRENT_PROJECTION_VERSION,
        retentionCutoff,
      });
    } else {
      commitRejectedLine(db, entry, cursor, ownerId);
    }
    processedCount += 1;
    expectedByteOffset = lineEnd;
    expectedScanOffset = lineEnd;
    expectedFileSize = batch.fileSize;
  }

  if (batch.endScanOffset > expectedScanOffset) {
    commitScanProgress(db, {
      sourceId: batch.sourceId,
      relativePath: batch.relativePath,
      fileId: batch.fileId,
      generation: batch.sourceGeneration,
      expectedFileSize,
      nextFileSize: batch.fileSize,
      expectedByteOffset,
      expectedScanOffset,
      nextByteOffset: expectedByteOffset,
      nextScanOffset: batch.endScanOffset,
      processedCount: 0,
    }, ownerId);
  }
  return processedCount;
}

async function processPendingJobs(
  db: DeepaaDatabase,
  dataDir: string,
  processor: ReturnType<typeof createExchangeProcessor>,
  ownerId: string,
  afterJobId: number | undefined,
  jobTransitionLogger: (event: DerivationJobTransitionEvent) => void,
  jobLockHeartbeatMs: number,
): Promise<{ count: number; lastJobId?: number }> {
  let count = 0;
  let lastJobId = afterJobId;
  // P2-11 积压自适应：待处理任务大量堆积时提高本批处理量，加速重启后的补投影；
  // 正常水位回落到默认批，保持事务粒度与事件循环让出节奏。
  const backlog = db.prepare(
    `SELECT COUNT(*) FROM derivation_jobs WHERE job_status IN ('pending', 'retry_wait')`,
  ).pluck().get() as number;
  const maxJobs = backlog > 500 ? 100 : DEFAULT_BATCH_RECORDS;
  while (count < maxJobs) {
    const claim = claimNextDerivationJob(db, {
      ownerId,
      afterIngestionRecordId: lastJobId,
    });
    if (!claim) break;
    lastJobId = claim.ingestionRecordId;
    // 任务心跳：处理期间定期刷新 locked_at，防止长任务被僵尸锁清理误判；
    // worker 崩溃或卡死停止心跳后，locked_at 会过期并被重置重试。
    const heartbeat = setInterval(() => {
      try {
        touchDerivationJobLock(db, claim, new Date().toISOString());
      } catch {
        // 心跳失败不中断派生；最终状态提交仍会校验租约与锁归属。
      }
    }, jobLockHeartbeatMs);
    heartbeat.unref?.();
    try {
      const record = await readRegisteredSourceRecord(db, dataDir, claim);
      const result = await processor.processDerivationJob({
        ingestionRecordId: claim.ingestionRecordId,
        sourceId: claim.sourceId,
        sourceRelativePath: claim.sourceRelativePath,
        byteOffset: claim.byteOffset,
        lineLengthBytes: claim.lineLengthBytes,
        exchange: record.exchange,
      }, claim);
      if (result.identityWait) {
        // dsh 身份等待顺延（2026-09-22）：交还队列等扫描节拍，到点由空闲轮询重新
        // 领取。不计数、不打迁移日志（那属于错误管道）、不消耗 attempt。顺延粒度
        // 取结果携带值（实时竞态 2s / 扫描就绪等待 5s）。
        deferDerivationJob(db, claim, {
          delayMs: result.identityWaitDeferMs ?? DSH_IDENTITY_DEFER_DELAY_MS,
        });
      } else {
        count += 1;
      }
    } catch (error) {
      const code = ingestionErrorCode(error);
      let status: DerivationJobTransitionEvent["status"];
      if (isPermanentDerivationError(code)) {
        markDerivationJobPermanentError(db, claim, {
          errorCode: code,
          errorMessage: errorMessage(error),
        });
        status = "permanent_error";
      } else {
        status = markDerivationJobRetry(db, claim, {
          errorCode: code,
          errorMessage: errorMessage(error),
        }).status;
      }
      jobTransitionLogger({
        event: "derivation-job-transition",
        ingestionRecordId: claim.ingestionRecordId,
        exchangeId: claim.exchangeId,
        sourceId: claim.sourceId,
        byteOffset: claim.byteOffset,
        attempt: claim.attemptCount,
        status,
        errorCode: code,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  return { count, lastJobId };
}

function ingestionErrorCode(error: unknown): string {
  // node:sqlite 错误（2026-10-08 驱动切换）：code 恒为 'ERR_SQLITE_ERROR'，
  // 先按数字 errcode 转回 better-sqlite3 风格码名（SQLITE_CONSTRAINT_TRIGGER 等）。
  const sqliteName = sqliteErrorCodeName(error);
  if (sqliteName) return sqliteName;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  if (error instanceof Error && error.message.startsWith("raw_index_mismatch:")) {
    return "raw_index_mismatch";
  }
  return "derivation_failed";
}

function isPermanentDerivationError(code: string): boolean {
  return code === "raw_index_mismatch"
    || code === "raw_body_integrity_failed"
    || code === "unsafe_raw_reference"
    || code === "unsafe_raw_body_reference";
}

function commitRejectedLine(
  db: DeepaaDatabase,
  entry: Exclude<SourceLineEntry, { kind: "record" }>,
  cursor: SourceCursorAdvance,
  ownerId: string,
): void {
  db.transaction(() => {
    assertLease(db, ownerId);
    const code = entry.kind === "oversized"
      ? "raw_line_oversized"
      : `raw_line_${entry.reason}`;
    const message = entry.kind === "oversized"
      ? "raw source 行超过 8 MiB 上限，已跳过。"
      : `raw source 行无法处理：${entry.reason}。`;
    const detailsJson = JSON.stringify({
      sourceRelativePath: entry.relativePath,
      byteOffset: entry.byteOffset,
      lineLengthBytes: entry.lineLengthBytes,
      ...(entry.kind === "invalid" ? { reason: entry.reason } : {}),
    });
    db.prepare(
      `INSERT INTO derivation_diagnostics(
        source_id, code, severity, message, details_json, created_at
      ) SELECT ?, ?, 'warning', ?, ?, ?
      WHERE NOT EXISTS(
        SELECT 1 FROM derivation_diagnostics
        WHERE source_id = ? AND code = ? AND details_json = ?
      )`,
    ).run(
      cursor.sourceId,
      code,
      message,
      detailsJson,
      new Date().toISOString(),
      cursor.sourceId,
      code,
      detailsJson,
    );
    advanceSourceCursor(db, cursor);
    incrementDataVersion(db);
  })();
}

function commitScanProgress(
  db: DeepaaDatabase,
  cursor: SourceCursorAdvance,
  ownerId: string,
): void {
  db.transaction(() => {
    assertLease(db, ownerId);
    advanceSourceCursor(db, cursor);
  })();
}

function commitSourceReset(
  db: DeepaaDatabase,
  source: SourceRow,
  ownerId: string,
): void {
  db.transaction(() => {
    assertLease(db, ownerId);
    const detailsJson = JSON.stringify({
      sourceRelativePath: source.relative_path,
      fileId: source.file_id,
      generation: source.generation,
    });
    db.prepare(
      `INSERT INTO derivation_diagnostics(
        source_id, code, severity, message, details_json, created_at
      ) SELECT ?, 'source_reset', 'warning', ?, ?, ?
      WHERE NOT EXISTS(
        SELECT 1 FROM derivation_diagnostics
        WHERE source_id = ? AND code = 'source_reset' AND details_json = ?
      )`,
    ).run(
      source.id,
      `raw source ${source.relative_path} 已轮转或截短，已从新 generation 重新摄取。`,
      detailsJson,
      new Date().toISOString(),
      source.id,
      detailsJson,
    );
    const result = db.prepare(
      `UPDATE ingestion_sources
       SET status = 'ready', error = NULL, updated_at = ?
       WHERE id = ? AND file_id = ? AND generation = ? AND status = 'reset'`,
    ).run(
      new Date().toISOString(),
      source.id,
      source.file_id,
      source.generation,
    );
    if (result.changes !== 1) {
      throw new Error(`source reset 提交冲突：${source.relative_path}`);
    }
    incrementDataVersion(db);
  })();
}

function nextSource(
  db: DeepaaDatabase,
  lastSourceId: number | undefined,
): SourceRow | undefined {
  const fields = `id, relative_path, file_id, generation, byte_offset,
    scan_offset, file_size, status`;
  const pending = `status = 'reset'
    OR (status = 'ready' AND scan_offset < file_size)`;
  if (lastSourceId === undefined) {
    return db.prepare(
      `SELECT ${fields} FROM ingestion_sources
       WHERE ${pending}
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    ).get() as SourceRow | undefined;
  }
  return db.prepare(
    `SELECT ${fields} FROM ingestion_sources
     WHERE ${pending}
     ORDER BY CASE WHEN id < ? THEN 0 ELSE 1 END, id DESC
     LIMIT 1`,
  ).get(lastSourceId) as SourceRow | undefined;
}

function assertLease(db: DeepaaDatabase, ownerId: string): void {
  // 统一走 worker-lease 契约：丢失时抛 WorkerLeaseLostError（code=worker_lease_lost），
  // 批次日志不再把它塌缩成无上下文的 derivation_failed。
  assertWorkerLease(db, ownerId);
}

/**
 * 批次级失败诊断（2026-09-18）。
 *
 * `setWorkerStatus(..., "failed", message)` 自带租约校验，恰恰在"租约丢失"这种最需要
 * 记录的场景写不进去（实测 `schema_meta.worker_error` 长期为空）。诊断表没有租约约束，
 * 是这类失败唯一可靠的落点；同一 (code, message) 每小时最多写一条，避免 1–30 s 的
 * 重试把表撑大（另有 90 天保留清理）。
 */
function recordBatchFailureDiagnostic(
  db: DeepaaDatabase,
  input: {code: string; message: string; releasedClaims: number},
): void {
  const now = new Date().toISOString();
  const since = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString();
  const code = input.code.slice(0, 256);
  const message = input.message.slice(0, MAX_WORKER_ERROR_BYTES);
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, ingestion_record_id, projection_version,
      code, severity, message, details_json, created_at
    )
    SELECT NULL, NULL, NULL, NULL, ?, 'error', ?, ?, ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE code = ? AND message = ? AND created_at >= ?
    )`,
  ).run(
    code,
    message,
    JSON.stringify({event: "ingestion-batch-failed", releasedClaims: input.releasedClaims}),
    now,
    code,
    message,
    since,
  );
}

function incrementDataVersion(db: DeepaaDatabase): void {
  const result = db.prepare(
    `UPDATE schema_meta
     SET data_version = data_version + 1,
       worker_status = 'running', worker_error = NULL
     WHERE id = 1`,
  ).run();
  if (result.changes !== 1) {
    throw new Error("无法递增 SQLite data_version。");
  }
}

function setWorkerStatus(
  db: DeepaaDatabase,
  ownerId: string,
  status: "idle" | "running" | "paused_disk" | "failed",
  error?: string,
): void {
  db.prepare(
    `UPDATE schema_meta SET worker_status = ?, worker_error = ?
     WHERE id = 1 AND EXISTS(
       SELECT 1 FROM worker_lease
       WHERE worker_lease.id = 1
         AND worker_lease.owner_id = ?
         AND worker_lease.expires_at > ?
     )`,
  ).run(status, error ?? null, ownerId, new Date().toISOString());
}

async function readAvailableDiskBytes(path: string): Promise<number> {
  const info = await statfs(path);
  const value = BigInt(info.bavail) * BigInt(info.bsize);
  return value > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(value);
}

function normalizeDiskReserve(value: number | undefined): number {
  const configured = value ?? envDiskReserve();
  if (!Number.isSafeInteger(configured) || configured < 0) {
    throw new Error("diskReserveBytes 必须是非负安全整数。");
  }
  return configured;
}

function envDiskReserve(): number {
  const raw = process.env.DEEPAA_DERIVATION_DISK_RESERVE_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DISK_RESERVE_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      "DEEPAA_DERIVATION_DISK_RESERVE_BYTES 必须是非负安全整数。",
    );
  }
  return parsed;
}

function normalizeOwnerId(value: string | undefined): string {
  const ownerId = value?.trim()
    || `worker-${process.pid}-${crypto.randomUUID()}`;
  if (Buffer.byteLength(ownerId) > 256) {
    throw new Error("ownerId 不能超过 256 bytes。");
  }
  return ownerId;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (Buffer.byteLength(message) <= MAX_WORKER_ERROR_BYTES) return message;
  return Buffer.from(message).subarray(0, MAX_WORKER_ERROR_BYTES).toString("utf8");
}

function logDerivationJobTransition(event: DerivationJobTransitionEvent): void {
  console.warn(`[deepaa] ${JSON.stringify(event)}`);
}

function emptyBatchResult(leaseAcquired: boolean): IngestionBatchResult {
  return {
    leaseAcquired,
    pausedDisk: false,
    processedCount: 0,
    discoveredCount: 0,
    limited: false,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolveYield => setImmediate(resolveYield));
}
