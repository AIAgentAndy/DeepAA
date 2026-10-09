import { mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { resolveDeepaaDataDir } from "../data-paths";
import {DeepaaDatabase} from "./sqlite-driver";
import {
  assertDeepaaSchemaCompatible,
  migrateDeepaaDatabase,
} from "./schema";

export interface OpenDatabaseOptions {
  dataDir: string;
  readonly?: boolean;
}

type DeepaaDatabaseGlobal = typeof globalThis & {
  __deepaaDatabases?: Map<string, DeepaaDatabase>;
};

/** 返回指定数据目录中的派生数据库文件。 */
export function deepaaDatabasePath(dataDir: string): string {
  return join(/* turbopackIgnore: true */ dataDir, "deepaa.sqlite");
}

/**
 * 打开独立连接。测试必须使用此工厂并显式关闭，避免共享真实数据库状态。
 */
export function openDeepaaDatabase(
  options: OpenDatabaseOptions,
): DeepaaDatabase {
  if (options.readonly !== true) {
    mkdirSync(options.dataDir, { recursive: true });
  }
  const db = new DeepaaDatabase(
    /* turbopackIgnore: true */ deepaaDatabasePath(options.dataDir),
    {
      readonly: options.readonly === true,
      fileMustExist: options.readonly === true,
    },
  );

  try {
    assertDeepaaSchemaCompatible(db);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("cache_size = -16384");
    if (options.readonly !== true) {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("wal_autocheckpoint = 1000");
      ensureIncrementalAutoVacuum(db);
      migrateDeepaaDatabase(db);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * 上线前一次性定版（2026-09-14 用户确认）：启用 auto_vacuum=INCREMENTAL，
 * 让未来「一键清除历史 raw」后的 SQLite 空间可以渐进回收，避免全库 VACUUM
 * 的独占锁与双倍临时空间。auto_vacuum 变更必须紧跟一次 VACUUM 才生效；
 * VACUUM 不能在事务内执行，因此放在 migrateDeepaaDatabase 之前独立执行。
 * 失败不阻断打开（下次可写打开时幂等重试）。
 *
 * WAL 自愈：WAL 模式下 VACUUM 会把重建的整库写入 WAL 且高水位不回落（实测
 * 残留可达 216 MiB）；已启用 auto_vacuum 的存量库重启时不再走 VACUUM 路径，
 * 因此在每次可写打开时检查 WAL 体积，超过阈值即 TRUNCATE 一次性归零。
 */
const WAL_TRUNCATE_THRESHOLD_BYTES = 64 * 1024 * 1024;

function ensureIncrementalAutoVacuum(db: DeepaaDatabase): void {
  const mode = db.pragma("auto_vacuum", { simple: true }) as number;
  if (mode === 2 /* INCREMENTAL */) {
    truncateOversizedWal(db);
    return;
  }
  try {
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
    // 重建后立即截断，避免磁盘上残留一次性翻倍的 -wal 文件。
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    console.error("[deepaa] enable incremental auto_vacuum failed (will retry on next open)", error);
  }
}

/** WAL 高水位自愈：仅在体积超阈值时尝试 TRUNCATE（读者持锁时失败不影响正确性）。 */
function truncateOversizedWal(db: DeepaaDatabase): void {
  try {
    const walPath = `${db.name}-wal`;
    if (statSync(walPath).size <= WAL_TRUNCATE_THRESHOLD_BYTES) return;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // 静默失败：下次打开或清理时再次尝试。
  }
}

/**
 * 获取生产共享连接。规范化路径用于避免相对路径和热更新创建重复写连接。
 */
export function getDeepaaDatabase(
  dataDir = resolveDeepaaDataDir(),
): DeepaaDatabase {
  const globalState = globalThis as DeepaaDatabaseGlobal;
  const databases =
    globalState.__deepaaDatabases ??
    (globalState.__deepaaDatabases = new Map());
  const normalizedPath = resolve(deepaaDatabasePath(dataDir));
  const existing = databases.get(normalizedPath);
  if (existing?.open) {
    return existing;
  }

  const db = openDeepaaDatabase({ dataDir: resolve(dataDir) });
  databases.set(normalizedPath, db);
  return db;
}
