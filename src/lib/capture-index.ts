import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, open, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, join, relative, sep } from "path";
import { fingerprintAgent } from "./harness/fingerprint";
import { classifyProtocol } from "./harness/protocol";
import { normalizeExchange } from "./harness/normalizer";
import type { NormalizedExchange } from "./harness/normalizer";
import type { AgentGroupingSource, AgentStep } from "./harness/agent";
import { requestActionFor } from "./harness/agent";
import type { Confidence } from "./harness/types";
import type { RawCapturedExchange } from "./harness/types";

export interface CaptureRecordRef {
  filePath: string;
  byteOffset: number;
  lineLengthBytes: number;
}

export interface CaptureIndexRecord extends CaptureRecordRef {
  schemaVersion: 1;
  exchangeId: string;
  captureSessionId: string;
  capturedAt: string;
  completedAt: string;
  targetId: string;
  targetName: string;
  targetFormatHint: RawCapturedExchange["routing"]["targetFormatHint"];
  localUrl: string;
  upstreamUrl: string;
  localPath: string;
  upstreamPath: string;
  method: string;
  endpointKind?: string;
  isModelCall?: boolean;
  isAuxiliary?: boolean;
  /** 该请求的意图动作，用于在同一 session 内按"新一轮用户输入"切分 turn；旧索引缺该字段时会被增量富化补齐 */
  requestAction?: AgentStep["requestAction"];
  agentName: string;
  agentFingerprintId?: string;
  agentProtocol?: string;
  agentGroupingSource?: AgentGroupingSource;
  agentGroupingConfidence?: Confidence;
  externalSessionId?: string;
  externalThreadId?: string;
  externalConversationId?: string;
  agentGroupKey?: string;
  captureDate: string;
  model?: string;
  status: number;
  statusText: string;
  isStreaming: boolean;
  requestBodySizeBytes: number;
  responseBodySizeBytes: number;
  requestBodySha256: string;
  responseBodySha256: string;
  diagnosticCodes: string[];
}

export interface CaptureIndexGroupSummary {
  id: string;
  captureSessionId?: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  exchangeCount: number;
  startTime?: string;
  endTime?: string;
  modelSet: string[];
  targetSet: string[];
}

const INDEX_FILE = join("indexes", "exchanges.jsonl");
const DEFAULT_INDEX_BATCH_RECORDS = 200;
const MAX_INDEX_BATCH_RECORDS = 10_000;
const DEFAULT_INDEX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_BATCH_BYTES = 64 * 1024 * 1024;
const INDEX_READ_BLOCK_BYTES = 64 * 1024;

export interface CaptureIndexBatchOptions {
  startOffset?: number;
  maxRecords?: number;
  maxBytes?: number;
  expectedFileId?: string;
}

export interface CaptureIndexBatch {
  records: CaptureIndexRecord[];
  recordEndOffsets: number[];
  startOffset: number;
  endOffset: number;
  processedCount: number;
  scannedLineCount: number;
  fileSize: number;
  fileId: string;
  mtimeMs: number;
  hasMore: boolean;
  limited: boolean;
  partialTail: boolean;
  resetRequired: boolean;
  resetReason?: "cursor_out_of_range" | "cursor_not_at_line_boundary" | "index_file_replaced";
}

/** 索引文件绝对路径，供其它模块按 mtime 判断状态是否变化 */
export function captureIndexPath(dataDir: string): string {
  return join(dataDir, INDEX_FILE);
}

/** 提取可安全写入服务端 L2 物化行的单条 raw capture 定位引用。 */
export function captureRecordRef(record: CaptureRecordRef): CaptureRecordRef {
  return {
    filePath: record.filePath,
    byteOffset: record.byteOffset,
    lineLengthBytes: record.lineLengthBytes,
  };
}

/**
 * 从 L1 JSONL 的字节游标读取一个有界批次。预算耗尽时不会解析下一条完整记录，
 * `endOffset` 永远停在最后一条已检查完整行之后，供 checkpoint 精确续做。
 */
export async function readCaptureIndexBatch(
  dataDir: string,
  options: CaptureIndexBatchOptions = {},
): Promise<CaptureIndexBatch> {
  const indexPath = captureIndexPath(dataDir);
  const fileStat = await stat(indexPath).catch(() => undefined);
  const requestedStartOffset = clampInteger(options.startOffset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  if (!fileStat) {
    return emptyCaptureIndexBatch(requestedStartOffset);
  }
  const fileId = captureIndexFileId(fileStat.dev, fileStat.ino, fileStat.birthtimeMs);
  const resetReason = options.expectedFileId && options.expectedFileId !== fileId
    ? "index_file_replaced"
    : requestedStartOffset > fileStat.size
      ? "cursor_out_of_range"
      : undefined;
  if (resetReason) {
    return {
      ...emptyCaptureIndexBatch(requestedStartOffset),
      fileSize: fileStat.size,
      fileId,
      mtimeMs: fileStat.mtimeMs,
      hasMore: fileStat.size > 0,
      resetRequired: true,
      resetReason,
    };
  }

  const handle = await open(indexPath, "r");
  let startOffset = requestedStartOffset;
  try {
    if (startOffset > 0 && startOffset < fileStat.size) {
      const boundary = Buffer.alloc(2);
      await handle.read(boundary, 0, 2, startOffset - 1);
      const previousByte = boundary[0];
      const currentByte = boundary[1];
      if (currentByte === 0x0a && previousByte !== 0x0a) {
        startOffset += 1;
      } else if (previousByte !== 0x0a) {
        return {
          ...emptyCaptureIndexBatch(startOffset),
          fileSize: fileStat.size,
          fileId,
          mtimeMs: fileStat.mtimeMs,
          hasMore: true,
          resetRequired: true,
          resetReason: "cursor_not_at_line_boundary",
        };
      }
    }

    const maxRecords = clampInteger(
      options.maxRecords ?? DEFAULT_INDEX_BATCH_RECORDS,
      1,
      MAX_INDEX_BATCH_RECORDS,
    );
    const maxBytes = clampInteger(
      options.maxBytes ?? DEFAULT_INDEX_BATCH_BYTES,
      1,
      MAX_INDEX_BATCH_BYTES,
    );
    const records: CaptureIndexRecord[] = [];
    const recordEndOffsets: number[] = [];
    let position = startOffset;
    let committedOffset = startOffset;
    let pending = Buffer.alloc(0);
    let pendingStartOffset = startOffset;
    let bytesReadWithinBudget = 0;
    let scannedLineCount = 0;
    let stoppedByRecordLimit = false;

    while (
      position < fileStat.size
      && bytesReadWithinBudget < maxBytes
      && records.length < maxRecords
    ) {
      const readSize = Math.min(
        INDEX_READ_BLOCK_BYTES,
        fileStat.size - position,
        maxBytes - bytesReadWithinBudget,
      );
      if (readSize <= 0) break;
      const chunk = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(chunk, 0, readSize, position);
      if (bytesRead <= 0) break;
      const combined = pending.length > 0
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      while (lineStart < combined.length) {
        const newlineIndex = combined.indexOf(0x0a, lineStart);
        if (newlineIndex < 0) break;
        scannedLineCount += 1;
        const rawLine = combined.subarray(lineStart, newlineIndex);
        const line = rawLine.length > 0 && rawLine.at(-1) === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1).toString("utf-8")
          : rawLine.toString("utf-8");
        const lineEndOffset = pendingStartOffset + newlineIndex + 1;
        const record = safeParseCaptureIndexRecord(line);
        committedOffset = lineEndOffset;
        if (record) {
          records.push(record);
          recordEndOffsets.push(lineEndOffset);
          if (records.length >= maxRecords) {
            stoppedByRecordLimit = true;
            lineStart = newlineIndex + 1;
            break;
          }
        }
        lineStart = newlineIndex + 1;
      }
      position += bytesRead;
      bytesReadWithinBudget += bytesRead;
      if (stoppedByRecordLimit) break;
      pending = combined.subarray(lineStart);
      pendingStartOffset += lineStart;
    }

    const partialTail = pending.length > 0 && position >= fileStat.size;
    const hasMore = committedOffset < fileStat.size;
    const limited = hasMore && (
      stoppedByRecordLimit
      || bytesReadWithinBudget >= maxBytes
      || records.length >= maxRecords
    );
    return {
      records,
      recordEndOffsets,
      startOffset,
      endOffset: committedOffset,
      processedCount: records.length,
      scannedLineCount,
      fileSize: fileStat.size,
      fileId,
      mtimeMs: fileStat.mtimeMs,
      hasMore,
      limited,
      partialTail,
      resetRequired: false,
    };
  } finally {
    await handle.close();
  }
}

/** 旧 checkpoint 迁移：按有界批次流式跳过记录，不构造全量索引数组。 */
export async function resolveCaptureIndexByteOffset(
  dataDir: string,
  recordCount: number,
): Promise<{ byteOffset: number; recordCount: number; fileId: string; fileSize: number; limited: boolean }> {
  const targetCount = clampInteger(recordCount, 0, Number.MAX_SAFE_INTEGER);
  let byteOffset = 0;
  let processed = 0;
  let fileId = "";
  let fileSize = 0;
  while (processed < targetCount) {
    const batch = await readCaptureIndexBatch(dataDir, {
      startOffset: byteOffset,
      maxRecords: Math.min(1_000, targetCount - processed),
      maxBytes: 8 * 1024 * 1024,
      expectedFileId: fileId || undefined,
    });
    if (batch.resetRequired || batch.processedCount === 0) {
      return { byteOffset, recordCount: processed, fileId: batch.fileId, fileSize: batch.fileSize, limited: true };
    }
    byteOffset = batch.endOffset;
    processed += batch.processedCount;
    fileId = batch.fileId;
    fileSize = batch.fileSize;
  }
  return { byteOffset, recordCount: processed, fileId, fileSize, limited: processed < targetCount };
}

export interface CaptureIndexStreamResult {
  processedCount: number;
  endOffset: number;
  fileSize: number;
  limited: boolean;
  resetRequired: boolean;
  resetReason?: string;
}

export interface CaptureIndexTailBatch {
  records: CaptureIndexRecord[];
  processedCount: number;
  scannedLineCount: number;
  scannedBytes: number;
  fileSize: number;
  limited: boolean;
}

/** 从 L1 索引尾部读取最新轻量记录，供派生重建期间构造有界首页覆盖层。 */
export async function readCaptureIndexTailBatch(
  dataDir: string,
  options: { maxRecords?: number; maxBytes?: number } = {},
): Promise<CaptureIndexTailBatch> {
  const filePath = captureIndexPath(dataDir);
  const fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat || fileStat.size === 0) {
    return { records: [], processedCount: 0, scannedLineCount: 0, scannedBytes: 0, fileSize: 0, limited: false };
  }
  const maxRecords = clampInteger(options.maxRecords ?? 200, 1, 500);
  const maxBytes = clampInteger(options.maxBytes ?? 4 * 1024 * 1024, 1, 16 * 1024 * 1024);
  const handle = await open(filePath, "r");
  const newestFirst: CaptureIndexRecord[] = [];
  let position = fileStat.size;
  let suffix = Buffer.alloc(0);
  let scannedBytes = 0;
  let scannedLineCount = 0;
  try {
    while (position > 0 && scannedBytes < maxBytes && newestFirst.length < maxRecords) {
      const readSize = Math.min(INDEX_READ_BLOCK_BYTES, position, maxBytes - scannedBytes);
      if (readSize <= 0) break;
      position -= readSize;
      const chunk = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(chunk, 0, readSize, position);
      scannedBytes += bytesRead;
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), suffix]);
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0 && newestFirst.length < maxRecords; index--) {
        if (combined[index] !== 0x0a) continue;
        const rawLine = combined.subarray(index + 1, lineEnd);
        lineEnd = index;
        if (!rawLine.toString("utf-8").trim()) continue;
        scannedLineCount += 1;
        const record = safeParseCaptureIndexRecord(rawLine.toString("utf-8"));
        if (record) newestFirst.push(record);
      }
      suffix = combined.subarray(0, lineEnd);
    }
    if (position === 0 && suffix.toString("utf-8").trim() && newestFirst.length < maxRecords) {
      scannedLineCount += 1;
      const record = safeParseCaptureIndexRecord(suffix.toString("utf-8"));
      if (record) newestFirst.push(record);
    }
  } finally {
    await handle.close();
  }
  return {
    records: newestFirst.reverse(),
    processedCount: newestFirst.length,
    scannedLineCount,
    scannedBytes,
    fileSize: fileStat.size,
    limited: position > 0 || newestFirst.length >= maxRecords,
  };
}

/**
 * 以固定小批次遍历 L1 轻量索引。调用方处理完一条后即可释放引用，
 * 适合启动时折叠摘要，避免构造与历史记录数等长的数组。
 */
export async function forEachCaptureIndexRecord(
  dataDir: string,
  onRecord: (record: CaptureIndexRecord) => void | Promise<void>,
): Promise<CaptureIndexStreamResult> {
  let endOffset = 0;
  let processedCount = 0;
  let fileSize = 0;
  let fileId: string | undefined;
  while (true) {
    const batch = await readCaptureIndexBatch(dataDir, {
      startOffset: endOffset,
      maxRecords: 500,
      maxBytes: 4 * 1024 * 1024,
      expectedFileId: fileId,
    });
    fileSize = batch.fileSize;
    if (batch.resetRequired) {
      return {
        processedCount,
        endOffset,
        fileSize,
        limited: true,
        resetRequired: true,
        resetReason: batch.resetReason,
      };
    }
    for (const record of batch.records) {
      await onRecord(record);
      processedCount += 1;
    }
    const madeProgress = batch.endOffset > endOffset;
    endOffset = batch.endOffset;
    fileId = batch.fileId || fileId;
    if (!batch.hasMore) {
      return { processedCount, endOffset, fileSize, limited: false, resetRequired: false };
    }
    if (!madeProgress || batch.partialTail) {
      return { processedCount, endOffset, fileSize, limited: true, resetRequired: false };
    }
  }
}

function emptyCaptureIndexBatch(startOffset: number): CaptureIndexBatch {
  return {
    records: [],
    recordEndOffsets: [],
    startOffset,
    endOffset: startOffset,
    processedCount: 0,
    scannedLineCount: 0,
    fileSize: 0,
    fileId: "",
    mtimeMs: 0,
    hasMore: false,
    limited: false,
    partialTail: false,
    resetRequired: false,
  };
}

function captureIndexFileId(device: number, inode: number, birthtimeMs: number): string {
  return `${device}:${inode}:${birthtimeMs}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function captureArchivePath(dataDir: string, exchange: RawCapturedExchange): string {
  return join(captureArchiveDir(dataDir, exchange), `${exchange.captureSessionId}.001.jsonl`);
}

/** 抓包归档目录：captures/{targetId}/{agentName}/{date}/，业务维度（供应商+Agent）归档 */
export function captureArchiveDir(dataDir: string, exchange: RawCapturedExchange): string {
  const targetId = safePathPart(exchange.routing.targetId || "default");
  const agentName = safePathPart(fingerprintAgent(exchange).agentName || "unknown");
  const date = captureDateFromTimestamp(exchange.capturedAt);
  return join(dataDir, "captures", targetId, agentName, date);
}

/** 单个抓包文件滚动阈值：超过则切下一个序号文件，控制单文件体积 */
const CAPTURE_ROLL_THRESHOLD_BYTES = 64 * 1024 * 1024;

/**
 * 解析当前 captureSession 应写入的滚动文件：从序号 001 起递增，
 * 找到"不存在"或"未超阈值"的文件，追加到其尾部。
 */
async function resolveRollingCaptureFile(
  dir: string,
  captureSessionId: string,
): Promise<{ filePath: string; byteOffset: number }> {
  let seq = 1;
  while (true) {
    const filePath = join(dir, `${captureSessionId}.${String(seq).padStart(3, "0")}.jsonl`);
    let size = 0;
    try {
      size = (await stat(filePath)).size;
    } catch {
      size = 0;
    }
    if (size === 0 || size < CAPTURE_ROLL_THRESHOLD_BYTES) {
      return { filePath, byteOffset: size };
    }
    seq++;
  }
}

export async function appendRawCapturedExchange(
  dataDir: string,
  exchange: RawCapturedExchange
): Promise<{ filePath: string; byteOffset: number; lineLengthBytes: number }> {
  const dir = captureArchiveDir(dataDir, exchange);
  await mkdir(dir, { recursive: true });
  const { filePath, byteOffset } = await resolveRollingCaptureFile(dir, exchange.captureSessionId);
  const line = `${JSON.stringify(exchange)}\n`;
  const handle = await open(filePath, "a");
  try {
    await handle.write(line, undefined, "utf-8");
  } finally {
    await handle.close();
  }
  const lineLengthBytes = Buffer.byteLength(line);
  await appendExchangeIndexEntry(dataDir, exchange, filePath, byteOffset, lineLengthBytes);
  return { filePath, byteOffset, lineLengthBytes };
}

export async function appendExchangeIndexEntry(
  dataDir: string,
  exchange: RawCapturedExchange,
  filePath: string,
  byteOffset: number,
  lineLengthBytes: number
): Promise<CaptureIndexRecord> {
  const record = buildCaptureIndexRecord(dataDir, exchange, filePath, byteOffset, lineLengthBytes);
  const indexPath = join(dataDir, INDEX_FILE);
  await mkdir(dirname(indexPath), { recursive: true });
  const handle = await open(indexPath, "a");
  try {
    await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf-8");
  } finally {
    await handle.close();
  }
  return record;
}

export async function readCaptureIndexRecords(dataDir: string): Promise<CaptureIndexRecord[]> {
  return dedupeCaptureIndexRecords(await readRawCaptureIndexRecords(dataDir)).records;
}

/**
 * 逐行扫描现有轻量索引，并且只保留调用方关心的记录。
 * 此只读入口不会富化旧记录、重写索引或回退扫描 raw capture，适用于分页导出等大数据路径。
 */
export async function readFilteredCaptureIndexRecords(
  dataDir: string,
  shouldInclude: (record: CaptureIndexRecord) => boolean,
): Promise<CaptureIndexRecord[]> {
  const indexPath = captureIndexPath(dataDir);
  if (!await stat(indexPath).then(() => true).catch(() => false)) return [];

  const order: string[] = [];
  const byExchangeId = new Map<string, CaptureIndexRecord>();
  const stream = createReadStream(indexPath, { encoding: "utf-8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record = safeParseCaptureIndexRecord(line);
      if (!record || !shouldInclude(record)) continue;
      const current = byExchangeId.get(record.exchangeId);
      if (!current) {
        order.push(record.exchangeId);
        byExchangeId.set(record.exchangeId, record);
      } else if (shouldPreferIndexRecord(record, current)) {
        byExchangeId.set(record.exchangeId, record);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return order
    .map(exchangeId => byExchangeId.get(exchangeId))
    .filter((record): record is CaptureIndexRecord => !!record);
}

// 索引文件解析结果按 mtime+size 缓存：轮询场景下避免每 2.5s 重复 parse 10MB 索引文件。
// 新抓包必然通过 appendRawCapturedExchange 追加索引，因此 mtime 是可靠的失效信号；
// 返回的数组为只读引用，调用方均以展开/复制方式消费，共享引用是安全的。
let rawIndexRecordsCache: { dataDir: string; mtimeMs: number; size: number; records: CaptureIndexRecord[] } | undefined;

async function readRawCaptureIndexRecords(dataDir: string): Promise<CaptureIndexRecord[]> {
  const indexPath = join(dataDir, INDEX_FILE);
  const indexStat = await stat(indexPath).catch(() => undefined);
  if (!indexStat) {
    rawIndexRecordsCache = undefined;
    return [];
  }
  if (
    rawIndexRecordsCache
    && rawIndexRecordsCache.dataDir === dataDir
    && rawIndexRecordsCache.mtimeMs === indexStat.mtimeMs
    && rawIndexRecordsCache.size === indexStat.size
  ) {
    return rawIndexRecordsCache.records;
  }
  const content = await readFile(indexPath, "utf-8");
  const records = content
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as CaptureIndexRecord)
    .filter(record => record.schemaVersion === 1);
  rawIndexRecordsCache = { dataDir, mtimeMs: indexStat.mtimeMs, size: indexStat.size, records };
  return records;
}

export async function ensureCaptureIndexRecords(dataDir: string): Promise<CaptureIndexRecord[]> {
  const rawExisting = await readRawCaptureIndexRecords(dataDir);
  const dedupedExisting = dedupeCaptureIndexRecords(rawExisting);
  const enrichedExisting = await enrichLegacyCaptureIndexRecords(dataDir, dedupedExisting.records);
  const existing = enrichedExisting.records;
  const files = await listCaptureJsonlFiles(join(dataDir, "captures"));
  if (files.length === 0) {
    if (dedupedExisting.changed || enrichedExisting.changed) await rewriteCaptureIndexRecords(dataDir, existing);
    return existing;
  }

  const knownExchangeIds = new Set(existing.map(record => record.exchangeId));
  const indexedFileEnds = new Map<string, number>();
  // 文件读取边界必须基于原始索引，避免去重后反复扫描已经索引过的历史重复行。
  for (const record of rawExisting) {
    const endOffset = record.byteOffset + record.lineLengthBytes;
    indexedFileEnds.set(record.filePath, Math.max(indexedFileEnds.get(record.filePath) || 0, endOffset));
  }

  const discovered: CaptureIndexRecord[] = [];
  for (const filePath of files) {
    const relativePath = recordFilePathFromAbsolute(dataDir, filePath);
    const startOffset = indexedFileEnds.get(relativePath) || 0;
    const fileRecords = await indexCaptureFile(dataDir, filePath, startOffset);
    for (const record of fileRecords) {
      if (knownExchangeIds.has(record.exchangeId)) continue;
      knownExchangeIds.add(record.exchangeId);
      discovered.push(record);
    }
  }
  const merged = dedupeCaptureIndexRecords([...existing, ...discovered]);
  const records = merged.records;
  if (existing.length > 0 && discovered.length === 0) {
    if (dedupedExisting.changed || enrichedExisting.changed || merged.changed) await rewriteCaptureIndexRecords(dataDir, records);
    return records;
  }
  if (records.length === 0) return [];

  const indexPath = join(dataDir, INDEX_FILE);
  await mkdir(dirname(indexPath), { recursive: true });
  if (dedupedExisting.changed || enrichedExisting.changed || merged.changed || existing.length === 0) {
    await rewriteCaptureIndexRecords(dataDir, records);
  } else {
    const handle = await open(indexPath, "a");
    try {
      for (const record of discovered) {
        await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf-8");
      }
    } finally {
      await handle.close();
    }
  }
  return records;
}

async function enrichLegacyCaptureIndexRecords(
  dataDir: string,
  records: CaptureIndexRecord[]
): Promise<{ records: CaptureIndexRecord[]; changed: boolean }> {
  let changed = false;
  const enriched: CaptureIndexRecord[] = [];
  for (const record of records) {
    if (!needsLightweightAgentFields(record)) {
      enriched.push(record);
      continue;
    }
    let exchange: RawCapturedExchange | undefined;
    try {
      exchange = await readExchangeAtIndex(dataDir, record);
    } catch {
      // 原始抓包文件可能已归档/丢失，富化失败时保留原记录；
      // 仅缺少 requestAction 等新字段，轻量 turn 切分会回退为单 turn，不影响可用性。
      exchange = undefined;
    }
    if (!exchange) {
      enriched.push(record);
      continue;
    }
    enriched.push(buildCaptureIndexRecord(
      dataDir,
      exchange,
      join(dataDir, record.filePath),
      record.byteOffset,
      record.lineLengthBytes
    ));
    changed = true;
  }
  return { records: enriched, changed };
}

function needsLightweightAgentFields(record: CaptureIndexRecord): boolean {
  return !record.agentFingerprintId
    || !record.agentGroupKey
    || !record.agentGroupingSource
    || record.isModelCall === undefined
    || record.isAuxiliary === undefined
    || record.requestAction === undefined;
}

export async function readExchangeAtIndex(dataDir: string, record: CaptureRecordRef): Promise<RawCapturedExchange | undefined> {
  const filePath = join(dataDir, record.filePath);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(record.lineLengthBytes);
    await handle.read(buffer, 0, record.lineLengthBytes, record.byteOffset);
    const line = buffer.toString("utf-8").trim();
    if (!line) return undefined;
    const parsed = JSON.parse(line) as RawCapturedExchange;
    return parsed.schemaVersion === 1 ? parsed : undefined;
  } finally {
    await handle.close();
  }
}

export function summarizeIndexGroups(records: CaptureIndexRecord[]): CaptureIndexGroupSummary[] {
  const groups = new Map<string, CaptureIndexRecord[]>();
  for (const record of records) {
    const key = `${record.targetId}/${record.agentName}/${record.captureDate}/${record.captureSessionId}`;
    groups.set(key, [...(groups.get(key) || []), record]);
  }
  return [...groups.entries()].map(([id, items]) => {
    const sorted = [...items].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return {
      id,
      captureSessionId: sorted[0]?.captureSessionId,
      fileName: `${sorted[0]?.captureSessionId || id}.jsonl`,
      filePath: sorted[0]?.filePath || "",
      fileSize: sorted.reduce((sum, item) => sum + item.lineLengthBytes, 0),
      exchangeCount: sorted.length,
      startTime: sorted[0]?.capturedAt,
      endTime: sorted.at(-1)?.completedAt,
      modelSet: uniqueSorted(sorted.map(item => item.model).filter((value): value is string => !!value)),
      targetSet: uniqueSorted(sorted.map(item => item.targetName || item.targetId)),
    };
  });
}

export function recordFilePathFromAbsolute(dataDir: string, filePath: string): string {
  return relative(dataDir, filePath).split(sep).join("/");
}

async function listCaptureJsonlFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
      }
    } catch {
      return;
    }
  }
  await walk(rootDir);
  return files.sort((a, b) => a.localeCompare(b));
}

async function indexCaptureFile(dataDir: string, filePath: string, startOffset = 0): Promise<CaptureIndexRecord[]> {
  const records: CaptureIndexRecord[] = [];
  const stream = createReadStream(filePath, { encoding: "utf-8", start: startOffset });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let byteOffset = startOffset;
  for await (const line of lines) {
    const lineLengthBytes = Buffer.byteLength(`${line}\n`);
    if (line.trim()) {
      const exchange = safeParseRawCapturedExchange(line);
      if (exchange) {
        records.push(buildCaptureIndexRecord(dataDir, exchange, filePath, byteOffset, lineLengthBytes));
      }
    }
    byteOffset += lineLengthBytes;
  }
  return records;
}

function safeParseRawCapturedExchange(line: string): RawCapturedExchange | undefined {
  try {
    const parsed = JSON.parse(line) as RawCapturedExchange;
    return parsed.schemaVersion === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeParseCaptureIndexRecord(line: string): CaptureIndexRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line) as CaptureIndexRecord;
    return parsed.schemaVersion === 1 && typeof parsed.exchangeId === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildCaptureIndexRecord(
  dataDir: string,
  exchange: RawCapturedExchange,
  filePath: string,
  byteOffset: number,
  lineLengthBytes: number
): CaptureIndexRecord {
  const fingerprint = fingerprintAgent(exchange);
  // normalizeExchange 开销大（解析全部消息/工具/会话项），代理路径每次抓包都会调用；
  // 只调用一次，复用给 lightweightAgentGroup 和 requestActionFor，避免双倍内存峰值。
  const normalized = normalizeExchange(exchange);
  const agentGroup = lightweightAgentGroup(exchange, normalized);
  const classification = classifyProtocol(exchange);
  const requestAction = requestActionFor(normalized);
  return {
    schemaVersion: 1,
    exchangeId: exchange.exchangeId,
    captureSessionId: exchange.captureSessionId,
    filePath: recordFilePathFromAbsolute(dataDir, filePath),
    byteOffset,
    lineLengthBytes,
    capturedAt: exchange.capturedAt,
    completedAt: exchange.completedAt,
    targetId: exchange.routing.targetId,
    targetName: exchange.routing.targetName,
    targetFormatHint: exchange.routing.targetFormatHint,
    localUrl: exchange.routing.localUrl,
    upstreamUrl: exchange.routing.upstreamUrl,
    localPath: exchange.routing.localPath,
    upstreamPath: exchange.routing.upstreamPath,
    method: exchange.routing.method,
    endpointKind: classification.endpointKind,
    isModelCall: classification.isModelCall,
    isAuxiliary: classification.isAuxiliary,
    requestAction,
    agentName: fingerprint.agentName,
    agentFingerprintId: fingerprint.id,
    agentProtocol: fingerprint.protocol,
    agentGroupingSource: agentGroup.source,
    agentGroupingConfidence: agentGroup.confidence,
    externalSessionId: agentGroup.externalSessionId,
    externalThreadId: agentGroup.externalThreadId,
    externalConversationId: agentGroup.externalConversationId,
    agentGroupKey: agentGroup.groupKey,
    captureDate: captureDateFromTimestamp(exchange.capturedAt),
    model: modelFromRawExchange(exchange),
    status: exchange.response.status,
    statusText: exchange.response.statusText,
    isStreaming: exchange.response.isStreaming,
    requestBodySizeBytes: exchange.request.bodySizeBytes,
    responseBodySizeBytes: exchange.response.bodySizeBytes,
    requestBodySha256: exchange.request.bodySha256,
    responseBodySha256: exchange.response.bodySha256,
    diagnosticCodes: exchange.captureDiagnostics.map(item => item.code),
  };
}

function lightweightAgentGroup(
  exchange: RawCapturedExchange,
  preNormalized?: NormalizedExchange
): {
  source: AgentGroupingSource;
  confidence: Confidence;
  externalSessionId?: string;
  externalThreadId?: string;
  externalConversationId?: string;
  groupKey: string;
} {
  const fingerprint = fingerprintAgent(exchange);
  const normalized = preNormalized ?? normalizeExchange(exchange);
  const sessionHint = normalized.request.sessionHints.find(hint => hint.kind === "agent-session-header");
  const threadHint = normalized.request.sessionHints.find(hint => hint.kind === "thread-header");
  const conversationHint = normalized.request.sessionHints.find(hint => hint.kind === "conversation-field");
  const previousResponseHint = normalized.request.sessionHints.find(hint => hint.kind === "previous-response-id");

  if (sessionHint) {
    return {
      source: "agent-session-header",
      confidence: "exact",
      externalSessionId: sessionHint.value,
      externalThreadId: threadHint?.value,
      groupKey: `${fingerprint.agentName}:${exchange.routing.targetId}:agent-session-header:${sessionHint.value}`,
    };
  }
  if (threadHint) {
    return {
      source: "thread-header",
      confidence: "high",
      externalThreadId: threadHint.value,
      groupKey: `${fingerprint.id}:thread-header:${threadHint.value}`,
    };
  }
  if (conversationHint) {
    return {
      source: "conversation-field",
      confidence: "high",
      externalConversationId: conversationHint.value,
      groupKey: `${fingerprint.id}:conversation-field:${conversationHint.value}`,
    };
  }
  if (previousResponseHint) {
    return {
      source: "conversation-field",
      confidence: "medium",
      externalConversationId: previousResponseHint.value,
      groupKey: `${fingerprint.id}:conversation-field:${previousResponseHint.value}`,
    };
  }
  const model = normalized.request.model || normalized.response.model || "unknown";
  return {
    source: "time-window",
    confidence: "low",
    groupKey: `${fingerprint.id}:time-window:${exchange.routing.targetId}:${model}:${timeWindowBucket(exchange.capturedAt)}`,
  };
}

function dedupeCaptureIndexRecords(records: CaptureIndexRecord[]): { records: CaptureIndexRecord[]; changed: boolean } {
  const order: string[] = [];
  const byExchangeId = new Map<string, CaptureIndexRecord>();
  let changed = false;
  for (const record of records) {
    const existing = byExchangeId.get(record.exchangeId);
    if (!existing) {
      byExchangeId.set(record.exchangeId, record);
      order.push(record.exchangeId);
      continue;
    }
    changed = true;
    if (shouldPreferIndexRecord(record, existing)) {
      byExchangeId.set(record.exchangeId, record);
    }
  }
  return {
    records: order.map(exchangeId => byExchangeId.get(exchangeId)).filter((value): value is CaptureIndexRecord => !!value),
    changed,
  };
}

function shouldPreferIndexRecord(candidate: CaptureIndexRecord, current: CaptureIndexRecord): boolean {
  const candidateCompletedAt = Date.parse(candidate.completedAt);
  const currentCompletedAt = Date.parse(current.completedAt);
  if (!Number.isNaN(candidateCompletedAt) && !Number.isNaN(currentCompletedAt) && candidateCompletedAt !== currentCompletedAt) {
    return candidateCompletedAt > currentCompletedAt;
  }
  const candidateDepth = candidate.filePath.split("/").length;
  const currentDepth = current.filePath.split("/").length;
  if (candidateDepth !== currentDepth) return candidateDepth > currentDepth;
  return `${candidate.filePath}:${candidate.byteOffset}` > `${current.filePath}:${current.byteOffset}`;
}

function timeWindowBucket(isoTime: string): number {
  const millis = new Date(isoTime).getTime();
  const normalized = Number.isNaN(millis) ? 0 : millis;
  return Math.floor(normalized / (10 * 60 * 1000));
}

async function rewriteCaptureIndexRecords(dataDir: string, records: CaptureIndexRecord[]): Promise<void> {
  const indexPath = join(dataDir, INDEX_FILE);
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, records.map(record => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""), "utf-8");
}

function modelFromRawExchange(exchange: RawCapturedExchange): string | undefined {
  const body = exchange.request.parsedBody;
  return body && typeof body === "object" && "model" in body && typeof body.model === "string"
    ? body.model
    : undefined;
}

function captureDateFromTimestamp(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString("sv-SE");
  return date.toLocaleDateString("sv-SE");
}

function safePathPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
