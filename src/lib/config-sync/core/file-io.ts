import {chmod, lstat, mkdir, readdir, unlink, writeFile} from "node:fs/promises";
import {basename, dirname, join} from "node:path";
import {atomicWriteFile, readFileBounded} from "@/proxy/atomic-file";

/** 单文件字节预算：所有受管 CLI 配置文件共用 1 MiB 上限。 */
export const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_BACKUPS = 10;

/** 读取可选文件原文；不存在返回 undefined，超过预算或非常规文件直接抛错。 */
export async function readOptionalBounded(
  path: string,
  maxBytes = MAX_CONFIG_BYTES,
): Promise<string | undefined> {
  try {
    return (await readFileBounded(path, maxBytes)).toString("utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** 拒绝符号链接与非常规文件；不存在返回 false，其它异常原样上抛。 */
export async function safeRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CONFIG_PATH_INVALID");
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * 备份配置文件到其同级 deepaa 目录，命名 <原名>_bk_YYYYMMDD_HHMMSS。
 * 保留最近 10 份，超出后自动滚动删除最旧备份（文件名字典序即时间序）。
 */
export async function backupFile(path: string): Promise<void> {
  let content: Buffer;
  try {
    content = await readFileBounded(path, MAX_CONFIG_BYTES);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const backupDir = join(dirname(path), "deepaa");
  await mkdir(backupDir, {recursive: true});
  const name = basename(path).replace(/[^a-z0-9._-]/gu, "_");
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  await writeFile(join(backupDir, `${name}_bk_${stamp}`), content, {mode: 0o600});
  const backups = (await readdir(backupDir))
    .filter(file => file.startsWith(`${name}_bk_`))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
    await unlink(join(backupDir, stale)).catch(() => undefined);
  }
}

/**
 * 导入接管前的一次性原始快照。它与滚动备份分开保存，文件名固定为
 * `<filename>_bk_no_deepaa`，用于用户随时恢复接管前的 CLI 配置。
 */
export async function ensurePreDeepaaBackup(path: string): Promise<string | undefined> {
  const source = await safeRegularFile(path);
  if (!source) return undefined;
  const backupPath = `${path}_bk_no_deepaa`;
  try {
    const existing = await lstat(backupPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("CONFIG_IMPORT_BACKUP_INVALID");
    await chmod(backupPath, 0o600).catch(() => undefined);
    return backupPath;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const content = await readFileBounded(path, MAX_CONFIG_BYTES);
  try {
    await writeFile(backupPath, content, {mode: 0o600, flag: "wx"});
  } catch (error) {
    if (!isAlreadyExists(error)) throw new Error("CONFIG_IMPORT_BACKUP_FAILED", {cause: error as Error});
  }
  await chmod(backupPath, 0o600).catch(() => undefined);
  return backupPath;
}

/** 原子写入并确保父目录存在；权限统一 0600（Windows 忽略 mode）。 */
export async function writeConfigFileAtomic(path: string, content: string): Promise<void> {
  await atomicWriteFile(path, content);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as {code?: unknown}).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
