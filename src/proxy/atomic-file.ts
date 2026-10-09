import {randomUUID} from "node:crypto";
import {mkdir, open, rename, rm, stat} from "node:fs/promises";
import {dirname} from "node:path";

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
    await rename(temporaryPath, filePath);
    await syncDirectoryBestEffort(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, {force: true}).catch(() => undefined);
  }
}

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
