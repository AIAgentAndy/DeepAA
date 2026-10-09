import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {openDeepaaDatabase} from "../db/connection";
import {createRollupRepository} from "./rollup-repository";

const DEFAULT_INTERVAL_MS = 2 * 60_000;
const LEASE_MS = 30_000;

export interface AnalyticsRollupWorkerOptions {
  dataDir: string;
  ownerId?: string;
  intervalMs?: number;
  now?: () => Date;
}

export interface AnalyticsRollupWorker {
  acquireLease(): boolean;
  renewLease(): boolean;
  releaseLease(): void;
  runOnce(): Promise<{processedCount: number; staleBuckets: number}>;
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}

type WorkerGlobal = typeof globalThis & {__deepaaAnalyticsWorkers?: Map<string, AnalyticsRollupWorker>};

export function createAnalyticsRollupWorker(options: AnalyticsRollupWorkerOptions): AnalyticsRollupWorker {
  const dataDir = resolve(options.dataDir);
  const ownerId = options.ownerId ?? `analytics-${randomUUID()}`;
  const intervalMs = Math.max(30_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  const db = openDeepaaDatabase({dataDir});
  const repository = createRollupRepository(db);
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let activeRun: Promise<{processedCount: number; staleBuckets: number}> | undefined;

  const acquireLease = () => {
    const current = now();
    const expiresAt = new Date(current.getTime() + LEASE_MS).toISOString();
    const result = db.prepare(`INSERT INTO analytics_worker_lease(id, owner_id, expires_at)
      VALUES(1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at
      WHERE analytics_worker_lease.owner_id = excluded.owner_id OR analytics_worker_lease.expires_at <= ?`)
      .run(ownerId, expiresAt, current.toISOString());
    return result.changes === 1;
  };
  const renewLease = () => {
    const current = now();
    return db.prepare("UPDATE analytics_worker_lease SET expires_at = ? WHERE id = 1 AND owner_id = ? AND expires_at > ?")
      .run(new Date(current.getTime() + LEASE_MS).toISOString(), ownerId, current.toISOString()).changes === 1;
  };
  const releaseLease = () => {
    if (db.open) db.prepare("DELETE FROM analytics_worker_lease WHERE id = 1 AND owner_id = ?").run(ownerId);
  };
  const leaseOwned = () => {
    const row = db.prepare("SELECT owner_id, expires_at FROM analytics_worker_lease WHERE id = 1").get() as {owner_id?: string; expires_at?: string} | undefined;
    return row?.owner_id === ownerId && !!row.expires_at && Date.parse(row.expires_at) > now().getTime();
  };

  const runOnce = async () => {
    if (closed || !db.open) throw new Error("Analytics Rollup Worker 已停止。");
    if (!renewLease() && !acquireLease()) return {processedCount: 0, staleBuckets: repository.getWatermark().staleBuckets};
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const started = now().toISOString();
      db.prepare(`INSERT OR REPLACE INTO analytics_worker_state(id, status, last_started_at, updated_at)
        VALUES(1, 'running', ?, ?)`)
        .run(started, started);
      const run = db.prepare("INSERT INTO analytics_rollup_runs(owner_id, status, started_at) VALUES(?, 'running', ?)").run(ownerId, started);
      try {
        const processedCount = await repository.rebuildRecentBuckets(now(), 2);
        // 最新桶优先重滚：版本升级/口径修复后，用户最关心的近期数据最先收敛；
        // 每轮仍有界（12 桶），旧桶按时间倒序逐轮追平。
        const pending = db.prepare(`SELECT bucket_start_utc FROM analytics_dirty_buckets
          WHERE status <> 'completed' AND available_at <= ? ORDER BY bucket_start_utc DESC LIMIT 12`)
          .all(now().toISOString()) as Array<{bucket_start_utc: string}>;
        let pendingProcessed = 0;
        for (const row of pending) {
          const result = await repository.rebuildBucket(row.bucket_start_utc);
          pendingProcessed += result.processedCount;
        }
        // 小时事实永久保存（2026-09-21 用户确认）：不再按 180 天裁剪
        // analytics_hourly_facts；它由永久 usage_ledger 全量可重建，体量 ~17 行/天。
        // P2-10：rollup_runs 只增不减会线性膨胀，每轮按 id 封顶保留最近 200 条。
        db.prepare(`
          DELETE FROM analytics_rollup_runs
          WHERE id NOT IN (
            SELECT id FROM analytics_rollup_runs ORDER BY id DESC LIMIT 200
          )
        `).run();
        const watermark = repository.getWatermark();
        const latestLedger = db.prepare("SELECT MAX(created_at) AS latest FROM usage_ledger").get() as {latest?: string};
        const finished = now().toISOString();
        if (leaseOwned()) {
          db.prepare(`UPDATE analytics_worker_state SET status = 'idle', last_success_at = ?, rollup_watermark_at = ?, last_ledger_created_at = ?, processed_bucket_count = processed_bucket_count + ?, updated_at = ? WHERE id = 1`)
            .run(finished, watermark.rollupWatermarkAt ?? finished, latestLedger.latest ?? null, processedCount + pendingProcessed, finished);
          db.prepare("UPDATE analytics_rollup_runs SET status = 'succeeded', finished_at = ?, processed_count = ? WHERE id = ? AND owner_id = ?").run(finished, processedCount + pendingProcessed, run.lastInsertRowid, ownerId);
        }
        return {processedCount: processedCount + pendingProcessed, staleBuckets: watermark.staleBuckets};
      } catch (error) {
        const finished = now().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        if (leaseOwned()) {
          db.prepare("UPDATE analytics_worker_state SET status = 'error', last_error_at = ?, last_error = ?, failed_bucket_count = failed_bucket_count + 1, updated_at = ? WHERE id = 1").run(finished, message.slice(0, 2048), finished);
          db.prepare("UPDATE analytics_rollup_runs SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ? AND owner_id = ?").run(finished, message.slice(0, 2048), run.lastInsertRowid, ownerId);
        }
        throw error;
      } finally {
        activeRun = undefined;
      }
    })();
    return activeRun;
  };

  const start = () => {
    if (timer || closed) return;
    void runOnce().catch(error => console.error("[deepaa] Analytics Rollup Worker failed", error));
    timer = setInterval(() => {
      void runOnce().catch(error => console.error("[deepaa] Analytics Rollup Worker failed", error));
    }, intervalMs);
    timer.unref?.();
  };
  const stop = async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (activeRun) await activeRun.catch(() => undefined);
    releaseLease();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await stop();
    if (db.open) db.close();
  };
  return {acquireLease, renewLease, releaseLease, runOnce, start, stop, close};
}

export function startAnalyticsRollupWorker(options: AnalyticsRollupWorkerOptions): AnalyticsRollupWorker {
  const key = resolve(options.dataDir);
  const state = globalThis as WorkerGlobal;
  const workers = state.__deepaaAnalyticsWorkers ?? (state.__deepaaAnalyticsWorkers = new Map());
  const existing = workers.get(key);
  if (existing) return existing;
  const worker = createAnalyticsRollupWorker(options);
  workers.set(key, worker);
  worker.start();
  return worker;
}
