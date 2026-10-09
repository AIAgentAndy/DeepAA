import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { openDeepaaDatabase } from "../db/connection";
import { executeRawPurge } from "./raw-purge";

/**
 * 存储自动清理调度器（2026-09-21 用户确认）。
 *
 * - 每天一次：本地时间 00:00 后的第一个空闲 tick 执行，当日已执行不重复；
 * - 窗口调整触发：保存保留窗口后立即请求一次「空闲即清」——即使当日例行已执行
 *   也会再次触发（用户从大窗口改小通常就是想清理一波，但保存动作本身零清理、
 *   绝不立刻猛删）；
 * - 空闲判定：派生队列无 pending/running 任务（retry_wait 是退避等待，不阻塞清理；
 *   purge 自身对活跃 job 文件也有整文件级跳过保护）；
 * - 清理复用 executeRawPurge（整文件粒度、500 文件/轮上限、逐文件短事务、墓碑、
 *   blob 引用复查 GC、incremental_vacuum），与存储管理弹窗手动清理同一闭环；
 * - 每次运行结果落盘 config/auto-purge-state.json（只保留最近一条，有界），
 *   由 /api/storage 与存储管理弹窗展示「最近一次自动清理」。
 */

const DEFAULT_TICK_MS = 10 * 60_000;
/** 每日例行清理在本地该小时之后才开始尝试（空闲即清，不强制精确时刻）。 */
const DAILY_START_HOUR = 0;

export type AutoPurgeTrigger = "daily" | "retention-change";

export interface AutoPurgeRunRecord {
  trigger: AutoPurgeTrigger;
  startedAt: string;
  finishedAt: string;
  purgedFileCount: number;
  purgedBytes: number;
  deletedBlobFiles: number;
  deletedDerivedArtifactFiles: number;
  deletedOrphanBlobFiles?: number;
  deletedOrphanArtifactFiles?: number;
  vacuumedPages: number;
  skippedCount: number;
  errorCount: number;
}

interface AutoPurgeStateFile {
  version: 1;
  lastRun?: AutoPurgeRunRecord;
  lastDailyRunDate?: string;
}

export function autoPurgeStatePath(dataDir: string): string {
  return join(dataDir, "config", "auto-purge-state.json");
}

export function readAutoPurgeState(dataDir: string): AutoPurgeStateFile | undefined {
  try {
    const file = autoPurgeStatePath(dataDir);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as AutoPurgeStateFile;
    if (parsed?.version !== 1) return undefined;
    return parsed;
  } catch {
    // 状态文件损坏按未执行处理；下次运行会原子覆盖。
    return undefined;
  }
}

function writeAutoPurgeState(dataDir: string, state: AutoPurgeStateFile): void {
  const file = autoPurgeStatePath(dataDir);
  mkdirSync(join(dataDir, "config"), {recursive: true});
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/**
 * 判定本 tick 是否需要清理、以何种触发执行。
 * - 请求标记（窗口调整）优先，任何时刻执行，当日已例行过也会再次触发；
 * - 例行只在本地 00:00 后、且当日尚未执行过时触发。
 */
export function resolveAutoPurgeTrigger(input: {
  lastDailyRunDate?: string;
  requested: boolean;
  now: Date;
}): AutoPurgeTrigger | null {
  if (input.requested) return "retention-change";
  const today = localDateString(input.now);
  if (input.lastDailyRunDate === today) return null;
  if (input.now.getHours() < DAILY_START_HOUR) return null;
  return "daily";
}

/** 空闲 = 派生队列没有待处理/进行中的任务。 */
export function isDerivationIdle(db: DeepaaDatabase): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM derivation_jobs WHERE job_status IN ('pending', 'running')`,
  ).get() as {count: number};
  return row.count === 0;
}

/** 执行一次自动清理并把结果落盘；调用方负责空闲判定与请求标记消费。 */
export async function runAutoPurgeOnce(
  db: DeepaaDatabase,
  dataDir: string,
  trigger: AutoPurgeTrigger,
): Promise<AutoPurgeRunRecord> {
  const startedAt = new Date().toISOString();
  const result = await executeRawPurge(db, dataDir);
  const finishedAt = new Date().toISOString();
  const record: AutoPurgeRunRecord = {
    trigger,
    startedAt,
    finishedAt,
    purgedFileCount: result.purgedFiles.length,
    purgedBytes: result.purgedFiles.reduce((sum, file) => sum + file.fileBytes, 0),
    deletedBlobFiles: result.deletedBlobFiles,
    deletedDerivedArtifactFiles: result.deletedDerivedArtifactFiles,
    deletedOrphanBlobFiles: result.deletedOrphanBlobFiles,
    deletedOrphanArtifactFiles: result.deletedOrphanArtifactFiles,
    vacuumedPages: result.vacuumedPages,
    skippedCount: result.skippedCount,
    errorCount: result.errors.length,
  };
  // 任何一次完成的尝试（含零清理）都记为当日已例行，避免同日重复扫描。
  writeAutoPurgeState(dataDir, {
    version: 1,
    lastRun: record,
    lastDailyRunDate: localDateString(new Date(finishedAt)),
  });
  return record;
}

function localDateString(now: Date): string {
  // sv-SE locale 输出 YYYY-MM-DD（与代理 capture 会话的本地日期格式一致）。
  return now.toLocaleDateString("sv-SE");
}

type PurgeRequestGlobal = typeof globalThis & {__deepaaPurgeRequests?: Set<string>};

/**
 * 请求一次「空闲即清」（保留窗口保存后调用）。跨模块实例共享 globalThis，
 * 调度器未启动时标记保留，启动后首个空闲 tick 消费。
 */
export function requestIdlePurgeSoon(dataDir: string): void {
  const key = resolve(dataDir);
  const globalState = globalThis as PurgeRequestGlobal;
  const requests =
    globalState.__deepaaPurgeRequests ?? (globalState.__deepaaPurgeRequests = new Set<string>());
  requests.add(key);
}

function consumePurgeRequest(key: string, consumed: boolean): void {
  if (!consumed) return;
  const globalState = globalThis as PurgeRequestGlobal;
  globalState.__deepaaPurgeRequests?.delete(key);
}

export interface AutoPurgeScheduler {
  runTick(): Promise<void>;
  stop(): void;
}

export interface AutoPurgeSchedulerOptions {
  dataDir: string;
  tickMs?: number;
}

type SchedulerGlobal = typeof globalThis & {
  __deepaaPurgeSchedulers?: Map<string, AutoPurgeSchedulerHandle>;
};

interface AutoPurgeSchedulerHandle extends AutoPurgeScheduler {
  db: DeepaaDatabase;
}

export function startAutoPurgeScheduler(options: AutoPurgeSchedulerOptions): AutoPurgeScheduler {
  const key = resolve(options.dataDir);
  const globalState = globalThis as SchedulerGlobal;
  const schedulers =
    globalState.__deepaaPurgeSchedulers ?? (globalState.__deepaaPurgeSchedulers = new Map());
  const existing = schedulers.get(key);
  if (existing) return existing;

  const tickMs = Math.max(60_000, options.tickMs ?? DEFAULT_TICK_MS);
  const db = openDeepaaDatabase({dataDir: options.dataDir});
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const runTick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const state = readAutoPurgeState(options.dataDir);
      const requested = (globalThis as PurgeRequestGlobal).__deepaaPurgeRequests?.has(key) === true;
      const trigger = resolveAutoPurgeTrigger({
        lastDailyRunDate: state?.lastDailyRunDate,
        requested,
        now: new Date(),
      });
      if (!trigger) return;
      // 不空闲时保留请求标记与例行判定，下个 tick 重试。
      if (!isDerivationIdle(db)) return;
      const record = await runAutoPurgeOnce(db, options.dataDir, trigger);
      consumePurgeRequest(key, true);
      console.info(
        `[deepaa] storage auto purge (${trigger}): purged ${record.purgedFileCount} files`
        + ` (${Math.round(record.purgedBytes / 1024)} KiB), skipped ${record.skippedCount},`
        + ` errors ${record.errorCount}`,
      );
    } catch (error) {
      // 失败不消费请求标记（若为窗口调整触发），下个 tick 重试；例行次日自然重试。
      console.error("[deepaa] storage auto purge failed", error);
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void runTick(), tickMs);
  timer.unref?.();
  // 启动即检查一次：机器白天才开机时也能在首个空闲 tick 完成当日例行清理。
  void runTick();

  const handle: AutoPurgeSchedulerHandle = {
    db,
    runTick,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      schedulers.delete(key);
      if (db.open) db.close();
    },
  };
  schedulers.set(key, handle);
  return handle;
}
