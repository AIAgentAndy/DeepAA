import {randomUUID} from "node:crypto";
import {mkdir, open, type FileHandle} from "node:fs/promises";
import {join} from "node:path";
import type {RawBodyReference, RawCapturedExchangeV2} from "./raw-v2-contract.js";

const V2_CAPTURE_SESSION_ID_PATTERN = /^capture-v2-\d+-[0-9a-f]{8}-[0-9a-f]{3}$/;
const V2_TAIL_SCAN_BLOCK_BYTES = 64 * 1024;
const MAX_RECORDS_PER_FILE_OPEN = 256;
const MAX_VERIFIED_OFFSET_ENTRIES = 2_048;

export interface CaptureAppendLocation {
  filePath: string;
  byteOffset: number;
  lineLengthBytes: number;
}

interface PendingAppend {
  line: Buffer;
  resolve: (location: CaptureAppendLocation) => void;
  reject: (error: unknown) => void;
}

interface FileAppendQueue {
  directory: string;
  filePath: string;
  pending: PendingAppend[];
  running: boolean;
}

const appendQueues = new Map<string, FileAppendQueue>();
const poisonedOffsets = new Map<string, number>();
const verifiedOffsets = new Map<string, number>();
let openedFileBatches = 0;
let writeOperations = 0;

export function createV2CaptureSessionId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("v2 capture Session ID timestamp must be a non-negative safe integer.");
  }
  return `capture-v2-${now}-${randomUUID().slice(0, 12)}`;
}

export async function appendRawCapturedExchangeV2(
  dataDir: string,
  exchange: RawCapturedExchangeV2,
): Promise<CaptureAppendLocation> {
  assertExchange(exchange);
  const directory = join(dataDir, "captures", "v2");
  const filePath = join(directory, `${exchange.captureSessionId}.jsonl`);
  const line = Buffer.from(`${JSON.stringify(snapshotExchange(exchange))}\n`, "utf8");
  return await enqueueAppend(directory, filePath, line);
}

export function captureWriterRuntimeState(): {
  activeFileQueues: number;
  pendingRecords: number;
  openedFileBatches: number;
  writeOperations: number;
  verifiedOffsetEntries: number;
  maxVerifiedOffsetEntries: number;
} {
  let pendingRecords = 0;
  for (const queue of appendQueues.values()) pendingRecords += queue.pending.length;
  return {
    activeFileQueues: appendQueues.size,
    pendingRecords,
    openedFileBatches,
    writeOperations,
    verifiedOffsetEntries: verifiedOffsets.size,
    maxVerifiedOffsetEntries: MAX_VERIFIED_OFFSET_ENTRIES,
  };
}

function snapshotExchange(exchange: RawCapturedExchangeV2): RawCapturedExchangeV2 {
  return {
    schemaVersion: 2,
    exchangeId: exchange.exchangeId,
    captureSessionId: exchange.captureSessionId,
    sequence: exchange.sequence,
    capturedAt: exchange.capturedAt,
    completedAt: exchange.completedAt,
    durationMs: exchange.durationMs,
    // 首字时间（转发开始 → 首个上游响应 chunk）必须随 raw 落盘，缺失会导致派生链路首字列恒空。
    ...(exchange.firstTokenMs !== undefined ? {firstTokenMs: exchange.firstTokenMs} : {}),
    routing: {
      targetId: exchange.routing.targetId,
      targetName: exchange.routing.targetName,
      targetFormatHint: exchange.routing.targetFormatHint,
      localUrl: exchange.routing.localUrl,
      upstreamUrl: exchange.routing.upstreamUrl,
      localPath: exchange.routing.localPath,
      upstreamPath: exchange.routing.upstreamPath,
      method: exchange.routing.method,
      requestedModel: exchange.routing.requestedModel,
      routeMode: exchange.routing.routeMode,
      // 实际注入的密钥 ID：派生时按它读取密钥价格倍率，缺失会回退默认倍率 1。
      clientCredentialId: exchange.routing.clientCredentialId,
      agent: exchange.routing.agent,
      wireApi: exchange.routing.wireApi,
      // 模型故障转移元数据：会话追踪/交互内容的「原模型 → 实际模型」依赖该字段。
      failover: exchange.routing.failover,
    },
    request: {
      headers: {...exchange.request.headers},
      rawBody: exchange.request.rawBody,
      rawBodyRef: snapshotReference(exchange.request.rawBodyRef),
      bodySizeBytes: exchange.request.bodySizeBytes,
      bodySha256: exchange.request.bodySha256,
    },
    response: {
      status: exchange.response.status,
      statusText: exchange.response.statusText,
      headers: {...exchange.response.headers},
      rawBody: exchange.response.rawBody,
      rawBodyRef: snapshotReference(exchange.response.rawBodyRef),
      bodySizeBytes: exchange.response.bodySizeBytes,
      bodySha256: exchange.response.bodySha256,
      isStreaming: exchange.response.isStreaming,
    },
    bodyStorage: {
      policy: exchange.bodyStorage.policy,
      compression: exchange.bodyStorage.compression,
      externalBlobDir: exchange.bodyStorage.externalBlobDir,
      thresholdBytes: exchange.bodyStorage.thresholdBytes,
    },
    captureDiagnostics: exchange.captureDiagnostics.map(item => ({...item})),
    security: {...exchange.security},
  };
}

function snapshotReference(reference: RawBodyReference | undefined): RawBodyReference | undefined {
  if (!reference) return undefined;
  return {
    storage: reference.storage,
    encoding: reference.encoding,
    sha256: reference.sha256,
    sizeBytes: reference.sizeBytes,
    compressedSizeBytes: reference.compressedSizeBytes,
    inlineBase64: reference.inlineBase64,
    externalPath: reference.externalPath,
  };
}

function assertExchange(exchange: RawCapturedExchangeV2): void {
  if (exchange.schemaVersion !== 2) throw new Error("v2 raw capture writer requires schemaVersion 2.");
  if (!V2_CAPTURE_SESSION_ID_PATTERN.test(exchange.captureSessionId)) {
    throw new Error(`invalid v2 captureSessionId: ${exchange.captureSessionId}`);
  }
}

/**
 * 截断一律经独立 "r+" 句柄执行：Windows 对 append 句柄（"a+"）执行 ftruncate
 * 会报 EPERM（errno -4048），POSIX 行为等价。正常写入仍走 append 句柄保持原子追加。
 */
async function truncateCaptureFile(filePath: string, byteOffset: number): Promise<void> {
  const fix = await open(filePath, "r+");
  try {
    await fix.truncate(byteOffset);
  } finally {
    await fix.close();
  }
}

async function recoverPoisonedOffset(handle: FileHandle, filePath: string): Promise<void> {
  const byteOffset = poisonedOffsets.get(filePath);
  if (byteOffset === undefined) return;
  try {
    await truncateCaptureFile(filePath, byteOffset);
  } catch (error) {
    throw new Error(
      `v2 raw capture recovery to byte offset ${byteOffset} failed: ${error instanceof Error ? error.message : String(error)}`,
      {cause: error},
    );
  }
  poisonedOffsets.delete(filePath);
  rememberVerifiedOffset(filePath, byteOffset);
}

async function verifiedAppendOffset(handle: FileHandle, filePath: string): Promise<number> {
  const verified = verifiedOffsets.get(filePath);
  if (verified !== undefined && (await handle.stat()).size === verified) {
    rememberVerifiedOffset(filePath, verified);
    return verified;
  }
  const repaired = await repairPartialTail(handle, filePath);
  rememberVerifiedOffset(filePath, repaired);
  return repaired;
}

async function repairPartialTail(handle: FileHandle, filePath: string): Promise<number> {
  const fileSize = (await handle.stat()).size;
  let scanEnd = fileSize;
  while (scanEnd > 0) {
    const scanStart = Math.max(0, scanEnd - V2_TAIL_SCAN_BLOCK_BYTES);
    const blockLength = scanEnd - scanStart;
    const block = Buffer.allocUnsafe(blockLength);
    let bytesRead = 0;
    while (bytesRead < blockLength) {
      const result = await handle.read(block, bytesRead, blockLength - bytesRead, scanStart + bytesRead);
      if (result.bytesRead <= 0) throw new Error("v2 raw capture tail scan stopped unexpectedly.");
      bytesRead += result.bytesRead;
    }
    const newline = block.lastIndexOf(0x0a);
    if (newline >= 0) {
      const cleanOffset = scanStart + newline + 1;
      if (cleanOffset !== fileSize) await truncateCaptureFile(filePath, cleanOffset);
      return cleanOffset;
    }
    scanEnd = scanStart;
  }
  if (fileSize > 0) await truncateCaptureFile(filePath, 0);
  return 0;
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    writeOperations += 1;
    const result = await handle.write(buffer, written, buffer.length - written, null);
    if (result.bytesWritten <= 0) {
      throw new Error(`v2 raw capture append stopped after ${written} of ${buffer.length} bytes.`);
    }
    written += result.bytesWritten;
  }
}

function enqueueAppend(directory: string, filePath: string, line: Buffer): Promise<CaptureAppendLocation> {
  let queue = appendQueues.get(filePath);
  if (!queue) {
    queue = {directory, filePath, pending: [], running: false};
    appendQueues.set(filePath, queue);
  }
  const result = new Promise<CaptureAppendLocation>((resolve, reject) => {
    queue!.pending.push({line, resolve, reject});
  });
  if (!queue.running) {
    queue.running = true;
    void drainAppendQueue(queue);
  }
  return result;
}

async function drainAppendQueue(queue: FileAppendQueue): Promise<void> {
  try {
    while (queue.pending.length > 0) {
      const batch = queue.pending.splice(0, MAX_RECORDS_PER_FILE_OPEN);
      await appendBatch(queue, batch);
    }
  } finally {
    queue.running = false;
    if (queue.pending.length > 0) {
      queue.running = true;
      void drainAppendQueue(queue);
    } else if (appendQueues.get(queue.filePath) === queue) {
      appendQueues.delete(queue.filePath);
    }
  }
}

async function appendBatch(queue: FileAppendQueue, batch: PendingAppend[]): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    await mkdir(queue.directory, {recursive: true});
    handle = await open(queue.filePath, "a+");
    openedFileBatches += 1;
    await recoverPoisonedOffset(handle, queue.filePath);
    const batchOffset = await verifiedAppendOffset(handle, queue.filePath);
    const payload = Buffer.concat(batch.map(entry => entry.line));
    try {
      await writeFully(handle, payload);
      rememberVerifiedOffset(queue.filePath, batchOffset + payload.length);
    } catch (error) {
      try {
        await truncateCaptureFile(queue.filePath, batchOffset);
        rememberVerifiedOffset(queue.filePath, batchOffset);
      } catch (rollbackError) {
        poisonedOffsets.set(queue.filePath, batchOffset);
        throw new AggregateError(
          [error, rollbackError],
          `v2 raw capture append failed and rollback to byte offset ${batchOffset} also failed.`,
        );
      }
      throw error;
    }
    await handle.close();
    handle = undefined;
    let byteOffset = batchOffset;
    for (const entry of batch) {
      entry.resolve({filePath: queue.filePath, byteOffset, lineLengthBytes: entry.line.length});
      byteOffset += entry.line.length;
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    for (const entry of batch) entry.reject(error);
  }
}

function rememberVerifiedOffset(filePath: string, byteOffset: number): void {
  verifiedOffsets.delete(filePath);
  verifiedOffsets.set(filePath, byteOffset);
  while (verifiedOffsets.size > MAX_VERIFIED_OFFSET_ENTRIES) {
    const oldest = verifiedOffsets.keys().next().value;
    if (oldest === undefined) return;
    verifiedOffsets.delete(oldest);
  }
}
