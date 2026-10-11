import {randomUUID} from "node:crypto";
import {mkdir, open, rename, rm, stat} from "node:fs/promises";
import {dirname} from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_BASE_DELAY_MS = 30;
/** Windows 目标文件被 AV/索引器/并发读取短暂占用时的瞬态错误码；其余错误
 * （ENOENT 路径问题等）重试无意义，原样上抛。 */
const RENAME_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** 原子替换小型控制文件，避免其他进程观察到半写 JSON。 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, {recursive: true});
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithTransientLockRetry(temporaryPath, filePath);
    await syncDirectoryBestEffort(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, {force: true}).catch(() => undefined);
  }
}

/**
 * Windows 短暂占用重试：目标文件（如 proxy-routing-status.json——开发启动
 * 闸门的数据源）被杀毒/索引器瞬态锁住时 rename 报 EPERM（2026-10-11 日志
 * 两次实证），指数退避重试消除瞬态失败；重试耗尽仍失败则原样上抛。
 */
async function renameWithTransientLockRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRY_ATTEMPTS || !isTransientLockRenameError(error)) throw error;
      await delay(RENAME_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

function isTransientLockRenameError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && RENAME_RETRYABLE_CODES.has(String((error as {code?: unknown}).code));
}

/** 导出仅供测试断言错误码映射；运行时行为由 renameWithTransientLockRetry 封装。 */
export {isTransientLockRenameError};

/** 读取前后都执行字节上限保护，文件并发增长也不会导致无界分配。 */
export async function readFileBounded(filePath: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Control path is not a regular file: ${filePath}`);
  if (info.size > maxBytes) {
    throw new Error(`Control file exceeds ${maxBytes} bytes: ${filePath}`);
  }
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new Error(`Control file exceeds ${maxBytes} bytes: ${filePath}`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows 和部分文件系统不支持目录 fsync；文件 rename 仍保持原子可见性。
  }
}
