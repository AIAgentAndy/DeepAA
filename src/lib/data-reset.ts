import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  deepaaDatabasePath,
  openDeepaaDatabase,
} from "./db/connection";
import { SCHEMA_VERSION } from "./db/schema";

const RESET_LOCK_FILE = ".data-reset.lock";
const RESET_BACKUP_DIR = "reset-backups";
const PROXY_CONFIG_MAX_BYTES = 1024 * 1024;
const RESET_TARGETS = [
  { relativePath: "deepaa.sqlite", kind: "file" },
  { relativePath: "deepaa.sqlite-wal", kind: "file" },
  { relativePath: "deepaa.sqlite-shm", kind: "file" },
  // 报告口径使用平台稳定的正斜杠；join() 在 Windows 上会自行归一化。
  { relativePath: "captures/v2", kind: "directory" },
  { relativePath: "blobs", kind: "directory" },
] as const;

const REQUIRED_SCHEMA_COLUMNS = {
  exchange_content_filter_status: [
    "request_context_mode",
    "request_comparison_kind",
    "request_context_epoch",
    "effective_context_boundary_id",
    "produced_context_boundary_id",
  ],
  exchange_request_fingerprints: [
    "body_side",
    "provider_lineage_key",
  ],
  exchange_content_category_stats: [
    "body_side",
  ],
} as const;

export interface DataResetResult {
  dataDir: string;
  backupDir: string;
  archivedPaths: string[];
  schemaVersion: number;
}

export interface ResetDeepaaDataOptions {
  dataDir: string;
  now?: () => Date;
  initializeDatabase?: (dataDir: string) => number | Promise<number>;
  assertResetAvailable?: (
    dataDir: string,
    now: Date,
  ) => void | Promise<void>;
}

interface ResetTarget {
  relativePath: string;
  sourcePath: string;
  backupPath: string;
}

/**
 * 未上线阶段的显式运行数据重置。
 * 只移动固定派生/raw/blob 目标，配置文件始终留在原数据根。
 */
export async function resetDeepaaData(
  options: ResetDeepaaDataOptions,
): Promise<DataResetResult> {
  const dataDir = normalizedDataDir(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  const lockPath = join(dataDir, RESET_LOCK_FILE);
  const lock = await open(lockPath, "wx").catch(error => {
    throw new Error(
      `数据重置锁已存在，请确认没有其他重置进程：${lockPath}`,
      { cause: error },
    );
  });
  try {
    await lock.writeFile(JSON.stringify({
      pid: process.pid,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
    }));
    const now = options.now?.() ?? new Date();
    await (options.assertResetAvailable ?? assertWorkerInactive)(dataDir, now);
    await validateResetTargetBoundaries(dataDir);
    const backupDir = join(
      dataDir,
      RESET_BACKUP_DIR,
      backupDirectoryName(now),
    );
    const targets = await existingResetTargets(dataDir, backupDir);
    await mkdir(backupDir, { recursive: true });
    const moved: ResetTarget[] = [];
    try {
      for (const target of targets) {
        await mkdir(dirname(target.backupPath), { recursive: true });
        await rename(target.sourcePath, target.backupPath);
        moved.push(target);
      }
      await Promise.all([
        mkdir(join(dataDir, "captures", "v2"), { recursive: true }),
        mkdir(join(dataDir, "blobs"), { recursive: true }),
      ]);
      const schemaVersion = await (
        options.initializeDatabase ?? initializeAndVerifyDatabase
      )(dataDir);
      return {
        dataDir,
        backupDir,
        archivedPaths: moved.map(target => target.relativePath),
        schemaVersion,
      };
    } catch (error) {
      await rollbackReset(dataDir, backupDir, moved);
      throw error;
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

/** 脚本入口在移动任何文件前检查本地代理监听端口。 */
export async function assertConfiguredProxyStopped(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const endpoint = await configuredProxyEndpoint(dataDir, env);
  if (!endpoint) return;
  if (await isTcpPortOpen(endpoint.hostname, endpoint.port)) {
    throw new Error(
      `检测到代理仍在监听 ${endpoint.hostname}:${endpoint.port}，请先停止 pnpm proxy。`,
    );
  }
}

function normalizedDataDir(value: string): string {
  if (!value.trim() || !isAbsolute(value)) {
    throw new Error("data:reset 只接受绝对 DEEPAA_DATA_DIR。");
  }
  return resolve(value);
}

async function assertWorkerInactive(
  dataDir: string,
  now: Date,
): Promise<void> {
  const path = deepaaDatabasePath(dataDir);
  if (!await pathExists(path)) return;
  const db = new DeepaaDatabase(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const hasLeaseTable = db.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = 'worker_lease'`,
    ).get() !== undefined;
    if (!hasLeaseTable) return;
    const lease = db.prepare(
      `SELECT owner_id, expires_at FROM worker_lease
       WHERE id = 1 AND expires_at > ?`,
    ).get(now.toISOString()) as {
      owner_id: string;
      expires_at: string;
    } | undefined;
    if (lease) {
      throw new Error(
        `SQLite Worker 仍有有效租约（${lease.owner_id}，至 ${lease.expires_at}），请先停止 pnpm web。`,
      );
    }
  } finally {
    db.close();
  }
}

async function validateResetTargetBoundaries(dataDir: string): Promise<void> {
  const capturesPath = join(dataDir, "captures");
  await assertActualComponentIfPresent(capturesPath, "directory");
  for (const target of RESET_TARGETS) {
    await assertActualComponentIfPresent(
      join(dataDir, target.relativePath),
      target.kind,
    );
  }
}

async function assertActualComponentIfPresent(
  path: string,
  kind: "file" | "directory",
): Promise<void> {
  const info = await lstat(path).catch(error => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink()) {
    throw new Error(`数据重置目标不能是符号链接：${path}`);
  }
  if (
    (kind === "file" && !info.isFile())
    || (kind === "directory" && !info.isDirectory())
  ) {
    throw new Error(`数据重置目标不是预期的实际${kind === "file" ? "文件" : "目录"}：${path}`);
  }
}

async function existingResetTargets(
  dataDir: string,
  backupDir: string,
): Promise<ResetTarget[]> {
  const targets: ResetTarget[] = [];
  for (const target of RESET_TARGETS) {
    const sourcePath = join(dataDir, target.relativePath);
    if (!await pathExists(sourcePath)) continue;
    assertChildPath(dataDir, sourcePath);
    targets.push({
      relativePath: target.relativePath,
      sourcePath,
      backupPath: join(backupDir, target.relativePath),
    });
  }
  return targets;
}

async function rollbackReset(
  dataDir: string,
  backupDir: string,
  moved: ResetTarget[],
): Promise<void> {
  const rollbackErrors: unknown[] = [];
  for (const target of RESET_TARGETS) {
    const path = join(dataDir, target.relativePath);
    try {
      assertChildPath(dataDir, path);
      await rm(path, { recursive: target.kind === "directory", force: true });
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  for (const target of [...moved].reverse()) {
    try {
      await mkdir(dirname(target.sourcePath), { recursive: true });
      await rename(target.backupPath, target.sourcePath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  await rm(backupDir, { recursive: true, force: true }).catch(error => {
    rollbackErrors.push(error);
  });
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      rollbackErrors,
      "数据重置失败，且活动数据回滚未完整完成。",
    );
  }
}

function initializeAndVerifyDatabase(dataDir: string): number {
  const db = openDeepaaDatabase({ dataDir });
  try {
    const schemaVersion = db.pragma("user_version", { simple: true }) as number;
    if (schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `重建后的 SQLite 版本为 ${schemaVersion}，预期 ${SCHEMA_VERSION}。`,
      );
    }
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
      const existing = new Set(
        (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
          .map(column => column.name),
      );
      for (const column of columns) {
        if (!existing.has(column)) {
          throw new Error(`重建后的 SQLite 缺少 ${table}.${column}。`);
        }
      }
    }
    return schemaVersion;
  } finally {
    db.close();
  }
}

async function configuredProxyEndpoint(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ hostname: string; port: number } | undefined> {
  const envPort = parsePort(env.PROXY_PORT);
  if (envPort !== undefined) {
    return { hostname: env.PROXY_HOST?.trim() || "127.0.0.1", port: envPort };
  }
  const configPath = join(dataDir, "proxy-config.json");
  const info = await stat(configPath).catch(error => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (!info) return { hostname: "127.0.0.1", port: 3211 };
  if (!info.isFile() || info.size > PROXY_CONFIG_MAX_BYTES) {
    throw new Error("proxy-config.json 不是普通文件或超过 1 MiB。");
  }
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    localProxyBaseUrl?: unknown;
  };
  if (typeof config.localProxyBaseUrl !== "string") {
    return { hostname: "127.0.0.1", port: 3211 };
  }
  const url = new URL(config.localProxyBaseUrl);
  const port = parsePort(url.port || (url.protocol === "https:" ? "443" : "80"));
  return port === undefined ? undefined : { hostname: url.hostname, port };
}

async function isTcpPortOpen(hostname: string, port: number): Promise<boolean> {
  return await new Promise(resolvePromise => {
    const socket = createConnection({ host: hostname, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : undefined;
}

function backupDirectoryName(now: Date): string {
  const timestamp = now.toISOString().replaceAll(/[-:.]/gu, "");
  return `${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function assertChildPath(dataDir: string, path: string): void {
  const child = relative(dataDir, resolve(path));
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`拒绝重置数据根之外的路径：${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    error => {
      if (isMissingPathError(error)) return false;
      throw error;
    },
  );
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
