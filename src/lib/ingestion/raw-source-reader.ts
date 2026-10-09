import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { createHash } from "node:crypto";
import { constants, type Dir } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, resolve } from "node:path";
import { CAPTURE_DIAGNOSTIC_CODES } from "../harness/types";
import type {
  CaptureDiagnostic,
  CaptureSecurityMetadata,
  RawBodyReference,
  RawBodyStorageMetadata,
  RawCapturedExchangeV2,
} from "../harness/types";
import { WorkerLeaseLostError } from "./worker-lease";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_BATCH_RECORDS = 10_000;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_LINE_BYTES = 64 * 1024 * 1024;
const MAX_INVALID_LINE_DETAILS = 100;
const DEFAULT_DISCOVERY_MAX_ENTRIES = 500;
const MAX_DISCOVERY_ENTRIES = 10_000;

export interface DiscoverV2SourcesOptions {
  maxEntries?: number;
  leaseOwnerId?: string;
}

export interface V2SourceDiscoveryBatch {
  discoveredCount: number;
  processedCount: number;
  limited: boolean;
  continuation?: V2SourceDiscoveryContinuation;
}

export interface V2SourceDiscoveryContinuation {
  next: (options?: DiscoverV2SourcesOptions) => Promise<V2SourceDiscoveryBatch>;
  close: () => Promise<void>;
}

export interface ReadSourceBatchOptions {
  maxRecords: number;
  maxBytes: number;
  maxLineBytes: number;
}

export interface SourceRecord {
  exchange: RawCapturedExchangeV2;
  byteOffset: number;
  lineLengthBytes: number;
  lineSha256: string;
}

export interface OversizedSourceLine {
  sourceId: number;
  relativePath: string;
  byteOffset: number;
  lineLengthBytes: number;
}

export type InvalidSourceLineReason =
  | "empty_line"
  | "invalid_utf8"
  | "invalid_json"
  | "unsupported_schema"
  | "not_raw_only"
  | "invalid_v2_record";

export interface InvalidSourceLine {
  sourceId: number;
  relativePath: string;
  byteOffset: number;
  lineLengthBytes: number;
  reason: InvalidSourceLineReason;
}

export type SourceLineEntry =
  | ({ kind: "record" } & SourceRecord)
  | ({ kind: "oversized" } & OversizedSourceLine)
  | ({ kind: "invalid" } & InvalidSourceLine);

/** 单行事务提交所需的完整 CAS 状态，避免 Worker 根据当前数据库状态猜测游标。 */
export interface SourceCursorAdvance {
  sourceId: number;
  relativePath: string;
  fileId: string;
  generation: number;
  expectedFileSize: number;
  nextFileSize: number;
  expectedByteOffset: number;
  expectedScanOffset: number;
  nextByteOffset: number;
  nextScanOffset: number;
  processedCount: number;
}

export interface SourceBatch {
  sourceId: number;
  relativePath: string;
  fileId: string;
  sourceGeneration: number;
  sourceFileSize: number;
  fileSize: number;
  startOffset: number;
  endOffset: number;
  startScanOffset: number;
  endScanOffset: number;
  records: SourceRecord[];
  oversizedLines: OversizedSourceLine[];
  invalidLines: InvalidSourceLine[];
  entries: SourceLineEntry[];
  processedCount: number;
  bytesRead: number;
  hasPartialTail: boolean;
  limited: boolean;
  maxBufferedLineBytes: number;
}

export interface RegisteredSourceRecordLocator {
  exchangeId: string;
  sourceId: number;
  sourceGeneration: number;
  sourceFileId: string;
  sourceRelativePath: string;
  byteOffset: number;
  lineLengthBytes: number;
  lineSha256: string;
}

export interface LegacySourceRecordLocator extends Omit<
  RegisteredSourceRecordLocator,
  "lineSha256"
> {}

interface IngestionSourceRow {
  id: number;
  relative_path: string;
  file_id: string;
  generation: number;
  file_size: number;
  byte_offset: number;
  scan_offset: number;
  status: string;
}

interface SourceDirectoryBinding {
  dataDir: string;
  capturesDir: string;
  captureDir: string;
}

interface SourcePathBinding extends SourceDirectoryBinding {
  expectedPath: string;
}

interface SourceDirectoryBoundary {
  dataDirId: string;
  capturesDirId: string;
  captureDirId: string;
  realDataDir: string;
  realCapturesDir: string;
  realCaptureDir: string;
}

interface ValidatedDiscoveryCandidate {
  relativePath: string;
  fileId: string;
  fileSize: number;
}

/**
 * 单次只处理有界数量的目录项。调用方应继续消费 continuation，或在放弃时显式关闭。
 */
export async function discoverV2Sources(
  db: DeepaaDatabase,
  dataDir: string,
  options: DiscoverV2SourcesOptions = {},
): Promise<V2SourceDiscoveryBatch> {
  const maxEntries = discoveryMaxEntries(options);
  const leaseOwnerId = discoveryLeaseOwner(options.leaseOwnerId);
  const binding = expectedDiscoveryBinding(db, dataDir);
  let boundary: SourceDirectoryBoundary;
  try {
    boundary = await validateSourceDirectoryBoundary(binding);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyDiscoveryBatch();
    }
    throw error;
  }
  const directory = await opendir(binding.captureDir);
  const cursor = new V2SourceDiscoveryCursor(
    db,
    binding,
    boundary,
    directory,
    leaseOwnerId,
  );
  return cursor.next({ maxEntries });
}

class V2SourceDiscoveryCursor implements V2SourceDiscoveryContinuation {
  private closed = false;

  constructor(
    private readonly db: DeepaaDatabase,
    private readonly binding: SourceDirectoryBinding,
    private readonly boundary: SourceDirectoryBoundary,
    private readonly directory: Dir,
    private readonly leaseOwnerId?: string,
  ) {}

  async next(
    options: DiscoverV2SourcesOptions = {},
  ): Promise<V2SourceDiscoveryBatch> {
    if (this.closed) {
      throw new Error("v2 raw source 发现 continuation 已关闭");
    }

    try {
      const maxEntries = discoveryMaxEntries(options);
      const requestedOwnerId = discoveryLeaseOwner(options.leaseOwnerId);
      if (requestedOwnerId && requestedOwnerId !== this.leaseOwnerId) {
        throw new Error("v2 raw source 发现 continuation 的租约持有者不一致");
      }
      const currentBoundary = await validateSourceDirectoryBoundary(this.binding);
      if (!sameSourceDirectoryBoundary(this.boundary, currentBoundary)) {
        throw new Error("v2 raw source 发现目录边界在分页期间发生变化");
      }
      return await this.readBatch(maxEntries);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.directory.close();
  }

  private async readBatch(maxEntries: number): Promise<V2SourceDiscoveryBatch> {
    const upsert = this.db.prepare(`
      INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
      SELECT ?, ?, ?, ?
      WHERE ? IS NULL OR EXISTS(
        SELECT 1 FROM worker_lease
        WHERE id = 1 AND owner_id = ? AND expires_at > ?
      )
      ON CONFLICT(relative_path) DO UPDATE SET
        byte_offset = CASE
          WHEN ingestion_sources.file_id <> excluded.file_id
            OR excluded.file_size < ingestion_sources.scan_offset THEN 0
          ELSE ingestion_sources.byte_offset
        END,
        scan_offset = CASE
          WHEN ingestion_sources.file_id <> excluded.file_id
            OR excluded.file_size < ingestion_sources.scan_offset THEN 0
          ELSE ingestion_sources.scan_offset
        END,
        file_id = excluded.file_id,
        file_size = excluded.file_size,
        generation = CASE
          WHEN ingestion_sources.file_id <> excluded.file_id
            OR excluded.file_size < ingestion_sources.scan_offset
            THEN ingestion_sources.generation + 1
          ELSE ingestion_sources.generation
        END,
        status = CASE
          WHEN ingestion_sources.file_id <> excluded.file_id
            OR excluded.file_size < ingestion_sources.scan_offset THEN 'reset'
          ELSE ingestion_sources.status
        END,
        last_captured_at = CASE
          WHEN ingestion_sources.file_id <> excluded.file_id
            OR excluded.file_size < ingestion_sources.scan_offset THEN NULL
          ELSE ingestion_sources.last_captured_at
        END,
        updated_at = excluded.updated_at
    `);
    const updatedAt = new Date().toISOString();
    let discoveredCount = 0;
    let processedCount = 0;

    while (processedCount < maxEntries) {
      const entry = await this.directory.read();
      if (entry === null) {
        await this.close();
        return { discoveredCount, processedCount, limited: false };
      }
      processedCount += 1;
      if (!entry.isFile() || extname(entry.name) !== ".jsonl") {
        continue;
      }
      const candidate = await validateDiscoveryCandidate(
        this.binding,
        this.boundary,
        entry.name,
      );
      const result = upsert.run(
        candidate.relativePath,
        candidate.fileId,
        candidate.fileSize,
        updatedAt,
        this.leaseOwnerId ?? null,
        this.leaseOwnerId ?? null,
        new Date().toISOString(),
      );
      if (this.leaseOwnerId && result.changes !== 1) {
        throw new WorkerLeaseLostError(this.leaseOwnerId);
      }
      discoveredCount += 1;
    }

    return {
      discoveredCount,
      processedCount,
      limited: true,
      continuation: this,
    };
  }
}

/**
 * Dirent 只用于候选枚举；最终 metadata 必须来自经过路径与目录双重重验的打开句柄。
 */
async function validateDiscoveryCandidate(
  directoryBinding: SourceDirectoryBinding,
  discoveryBoundary: SourceDirectoryBoundary,
  fileName: string,
): Promise<ValidatedDiscoveryCandidate> {
  const relativePath = posix.join("captures", "v2", fileName);
  const binding: SourcePathBinding = {
    ...directoryBinding,
    expectedPath: join(directoryBinding.captureDir, fileName),
  };
  const boundaryBeforeOpen = await validateSourceDirectoryBoundary(binding);
  if (!sameSourceDirectoryBoundary(discoveryBoundary, boundaryBeforeOpen)) {
    throw new Error(`v2 raw source 发现目录边界在候选打开前发生变化：${relativePath}`);
  }
  await validateSourceFilePath(binding, boundaryBeforeOpen, relativePath);

  const handle = await open(
    binding.expectedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`v2 raw source 发现候选不是普通文件：${relativePath}`);
    }
    const boundaryAfterOpen = await validateSourceDirectoryBoundary(binding);
    if (
      !sameSourceDirectoryBoundary(boundaryBeforeOpen, boundaryAfterOpen)
      || !sameSourceDirectoryBoundary(discoveryBoundary, boundaryAfterOpen)
    ) {
      throw new Error(`v2 raw source 发现目录边界在候选打开期间发生变化：${relativePath}`);
    }
    const pathFileId = await validateSourceFilePath(
      binding,
      boundaryAfterOpen,
      relativePath,
    );
    assertSafeFileSize(info.size, binding.expectedPath);
    const handleFileId = sourceFileId(info.dev, info.ino);
    if (pathFileId !== handleFileId) {
      throw new Error(`v2 raw source 发现候选在打开期间被替换：${relativePath}`);
    }
    return {
      relativePath,
      fileId: handleFileId,
      fileSize: info.size,
    };
  } finally {
    await handle.close();
  }
}

function discoveryMaxEntries(options: DiscoverV2SourcesOptions): number {
  const maxEntries = options.maxEntries ?? DEFAULT_DISCOVERY_MAX_ENTRIES;
  assertBoundedInteger("maxEntries", maxEntries, MAX_DISCOVERY_ENTRIES);
  return maxEntries;
}

function discoveryLeaseOwner(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ownerId = value.trim();
  if (!ownerId || Buffer.byteLength(ownerId) > 256) {
    throw new Error("leaseOwnerId 必须是 1..256 bytes 的非空字符串");
  }
  return ownerId;
}

function emptyDiscoveryBatch(): V2SourceDiscoveryBatch {
  return { discoveredCount: 0, processedCount: 0, limited: false };
}

/**
 * 从已提交字节游标开始逐块读取。只有完整换行记录会进入批次的 endOffset，
 * 因此事务失败、预算中止或文件半尾都可以从稳定边界重试。
 */
export async function readSourceBatch(
  db: DeepaaDatabase,
  filePath: string,
  options: ReadSourceBatchOptions,
): Promise<SourceBatch> {
  validateReadOptions(options);
  const absolutePath = resolve(filePath);
  const relativePath = sourceRelativePath(absolutePath);
  const source = db
    .prepare(
      `SELECT id, relative_path, file_id, generation, file_size, byte_offset,
        scan_offset, status
      FROM ingestion_sources
      WHERE relative_path = ?`,
    )
    .get(relativePath) as IngestionSourceRow | undefined;
  if (!source) {
    throw new Error(`尚未发现 v2 raw source：${relativePath}`);
  }
  const binding = expectedSourceBinding(db, source.relative_path);
  if (!isAbsolute(filePath) || filePath !== binding.expectedPath) {
    throw new Error(
      `v2 raw source 必须匹配数据库 dataDir 内的规范路径：${binding.expectedPath}`,
    );
  }
  if (source.status !== "ready") {
    throw new Error(
      `v2 raw source ${source.relative_path} 的 ${source.status} 状态必须由 Worker 先消费并恢复 ready`,
    );
  }

  const boundaryBeforeOpen = await validateSourceDirectoryBoundary(binding);
  await validateSourceFilePath(binding, boundaryBeforeOpen, relativePath);

  const handle = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`v2 raw source 不是普通文件：${relativePath}`);
    }
    const boundaryAfterOpen = await validateSourceDirectoryBoundary(binding);
    if (!sameSourceDirectoryBoundary(boundaryBeforeOpen, boundaryAfterOpen)) {
      throw new Error(`v2 raw source 目录边界在打开期间发生变化：${relativePath}`);
    }
    const pathFileId = await validateSourceFilePath(
      binding,
      boundaryAfterOpen,
      relativePath,
    );
    assertSafeFileSize(info.size, absolutePath);
    const currentFileId = sourceFileId(info.dev, info.ino);
    if (pathFileId !== currentFileId) {
      throw new Error(`v2 raw source 在打开期间被替换：${relativePath}`);
    }
    if (
      currentFileId !== source.file_id
      || info.size < source.scan_offset
      || source.scan_offset < source.byte_offset
    ) {
      throw new Error(`v2 raw source 已轮转或截短，请先重新发现：${relativePath}`);
    }

    return await readSourceHandle(
      handle,
      source,
      info.size,
      options,
    );
  } finally {
    await handle.close();
  }
}

/**
 * 派生任务只按登记账本的精确范围重读一行 envelope；不依赖 source 当前游标，
 * 也不允许通过扫描文件寻找 exchangeId。
 */
export async function readRegisteredSourceRecord(
  db: DeepaaDatabase,
  dataDir: string,
  locator: RegisteredSourceRecordLocator,
): Promise<SourceRecord> {
  if (
    !Number.isSafeInteger(locator.byteOffset)
    || locator.byteOffset < 0
    || !Number.isSafeInteger(locator.lineLengthBytes)
    || locator.lineLengthBytes < 1
    || locator.lineLengthBytes > 8 * 1024 * 1024
  ) {
    throw new Error("raw_index_mismatch: 登记行范围无效。");
  }
  const source = db.prepare(
    `SELECT id, relative_path, file_id, generation, file_size, byte_offset,
      scan_offset, status
     FROM ingestion_sources WHERE id = ?`,
  ).get(locator.sourceId) as IngestionSourceRow | undefined;
  if (!source || source.relative_path !== locator.sourceRelativePath) {
    throw new Error("raw_index_mismatch: source 身份或 generation 已变化。");
  }
  // source 行在登记后可能因文件轮转、跨重启设备号变化而推进 generation/file_id；
  // 此时行内容身份改由登记的 lineSha256 在精确读取时兜底验证，哈希不匹配仍会拒绝，
  // 未提供行哈希的身份漂移不允许回退读取。
  if (
    (source.file_id !== locator.sourceFileId
      || source.generation !== locator.sourceGeneration)
    && !locator.lineSha256
  ) {
    throw new Error("raw_index_mismatch: source 身份或 generation 已变化。");
  }
  return readExactSourceRecord(db, dataDir, source, locator, locator.lineSha256);
}

/**
 * 历史 raw_exchange_refs 没有登记行 SHA；仍只允许用当前 source 身份和精确 range
 * 读取一行，并复核 exchangeId 与完整 v2 结构，不允许扫描回退。
 */
export async function readLegacySourceRecord(
  db: DeepaaDatabase,
  dataDir: string,
  locator: LegacySourceRecordLocator,
): Promise<SourceRecord> {
  if (
    !Number.isSafeInteger(locator.byteOffset)
    || locator.byteOffset < 0
    || !Number.isSafeInteger(locator.lineLengthBytes)
    || locator.lineLengthBytes < 1
    || locator.lineLengthBytes > 8 * 1024 * 1024
  ) {
    throw new Error("raw_index_mismatch: 历史行范围无效。");
  }
  const source = db.prepare(
    `SELECT id, relative_path, file_id, generation, file_size, byte_offset,
      scan_offset, status
     FROM ingestion_sources WHERE id = ?`,
  ).get(locator.sourceId) as IngestionSourceRow | undefined;
  if (
    !source
    || source.relative_path !== locator.sourceRelativePath
    || source.file_id !== locator.sourceFileId
    || source.generation !== locator.sourceGeneration
  ) {
    throw new Error("raw_index_mismatch: 历史 source 身份或 generation 已变化。");
  }
  return readExactSourceRecord(db, dataDir, source, locator);
}

async function readExactSourceRecord(
  db: DeepaaDatabase,
  dataDir: string,
  source: IngestionSourceRow,
  locator: LegacySourceRecordLocator,
  expectedLineSha256?: string,
): Promise<SourceRecord> {
  const binding = expectedSourceBinding(db, source.relative_path);
  if (resolve(dataDir) !== binding.dataDir) {
    throw new Error("raw_index_mismatch: dataDir 与数据库目录不一致。");
  }
  const boundaryBeforeOpen = await validateSourceDirectoryBoundary(binding);
  await validateSourceFilePath(binding, boundaryBeforeOpen, source.relative_path);
  const handle = await open(
    binding.expectedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    const rangeEnd = locator.byteOffset + locator.lineLengthBytes;
    // 磁盘身份只对当前 source 行校验；登记身份的漂移由 expectedLineSha256
    // 与 exchangeId 复核兜底（legacy 路径两者本就相等）。
    if (
      !info.isFile()
      || sourceFileId(info.dev, info.ino) !== source.file_id
      || !Number.isSafeInteger(rangeEnd)
      || rangeEnd > info.size
    ) {
      throw new Error("raw_index_mismatch: source 文件身份或范围不匹配。");
    }
    const line = Buffer.allocUnsafe(locator.lineLengthBytes);
    let readBytes = 0;
    while (readBytes < line.length) {
      const result = await handle.read(
        line,
        readBytes,
        line.length - readBytes,
        locator.byteOffset + readBytes,
      );
      if (result.bytesRead === 0) break;
      readBytes += result.bytesRead;
    }
    const after = await handle.stat();
    const boundaryAfterRead = await validateSourceDirectoryBoundary(binding);
    if (
      readBytes !== line.length
      || sourceFileId(after.dev, after.ino) !== source.file_id
      || !sameSourceDirectoryBoundary(boundaryBeforeOpen, boundaryAfterRead)
    ) {
      throw new Error("raw_index_mismatch: source 在精确读取期间发生变化。");
    }
    const lineSha256 = createHash("sha256").update(line).digest("hex");
    if (expectedLineSha256 !== undefined && lineSha256 !== expectedLineSha256) {
      throw new Error("raw_index_mismatch: JSONL 行 SHA-256 不匹配。");
    }
    const parsed = parseCompleteLine(line);
    if (!parsed.exchange || parsed.exchange.exchangeId !== locator.exchangeId) {
      throw new Error("raw_index_mismatch: JSONL 行 exchangeId 不匹配。");
    }
    return {
      exchange: parsed.exchange,
      byteOffset: locator.byteOffset,
      lineLengthBytes: locator.lineLengthBytes,
      lineSha256,
    };
  } finally {
    await handle.close();
  }
}

/** 调用方完成整批派生事务后再提交游标；旧批次无法覆盖已经推进的 offset。 */
export function commitSourceCursor(
  db: DeepaaDatabase,
  batch: SourceBatch,
): void {
  advanceSourceCursor(db, {
    sourceId: batch.sourceId,
    relativePath: batch.relativePath,
    fileId: batch.fileId,
    generation: batch.sourceGeneration,
    expectedFileSize: batch.sourceFileSize,
    nextFileSize: batch.fileSize,
    expectedByteOffset: batch.startOffset,
    expectedScanOffset: batch.startScanOffset,
    nextByteOffset: batch.endOffset,
    nextScanOffset: batch.endScanOffset,
    processedCount: batch.processedCount,
  });
}

/**
 * CAS 推进一段已提交的 source 范围。调用方负责把它放在派生写入所在的同一事务内。
 */
export function advanceSourceCursor(
  db: DeepaaDatabase,
  advance: SourceCursorAdvance,
): void {
  const result = db
    .prepare(
      `UPDATE ingestion_sources
      SET byte_offset = ?,
        scan_offset = ?,
        file_size = ?,
        processed_count = processed_count + ?,
        status = 'ready',
        error = NULL,
        updated_at = ?
      WHERE id = ?
        AND file_id = ?
        AND generation = ?
        AND file_size = ?
        AND byte_offset = ?
        AND scan_offset = ?
        AND status = 'ready'`,
    )
    .run(
      advance.nextByteOffset,
      advance.nextScanOffset,
      advance.nextFileSize,
      advance.processedCount,
      new Date().toISOString(),
      advance.sourceId,
      advance.fileId,
      advance.generation,
      advance.expectedFileSize,
      advance.expectedByteOffset,
      advance.expectedScanOffset,
    );
  if (result.changes !== 1) {
    throw new Error(
      `source 游标提交冲突：${advance.relativePath} 的起始 offset ${advance.expectedByteOffset} 已失效`,
    );
  }
}

async function readSourceHandle(
  handle: Awaited<ReturnType<typeof open>>,
  source: IngestionSourceRow,
  fileSize: number,
  options: ReadSourceBatchOptions,
): Promise<SourceBatch> {
  const records: SourceRecord[] = [];
  const oversizedLines: OversizedSourceLine[] = [];
  const invalidLines: InvalidSourceLine[] = [];
  const entries: SourceLineEntry[] = [];
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const startOffset = source.byte_offset;
  const startScanOffset = source.scan_offset;
  let readPosition = startScanOffset;
  let scanOffset = startScanOffset;
  let endOffset = startOffset;
  let lineStartOffset = startOffset;
  let lineChunks: Buffer[] = [];
  let bufferedLineBytes = 0;
  let currentLineBytes = startScanOffset - startOffset;
  let maxBufferedLineBytes = 0;
  let processedCount = 0;
  let bytesRead = 0;
  let skippingOversizedLine = startScanOffset > startOffset;
  let stopped = false;
  let limited = false;

  while (!stopped && readPosition < fileSize) {
    let requestedBytes = Math.min(READ_CHUNK_BYTES, fileSize - readPosition);
    if (skippingOversizedLine) {
      const remainingSkipBudget = options.maxBytes - (scanOffset - startScanOffset);
      if (remainingSkipBudget <= 0) {
        limited = scanOffset < fileSize;
        break;
      }
      requestedBytes = Math.min(requestedBytes, remainingSkipBudget);
    }
    const result = await handle.read(chunk, 0, requestedBytes, readPosition);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
    readPosition += result.bytesRead;
    let chunkOffset = 0;

    while (!stopped && chunkOffset < result.bytesRead) {
      if (skippingOversizedLine) {
        const newlineOffset = chunk.indexOf(0x0a, chunkOffset);
        const segmentEnd = newlineOffset >= 0 && newlineOffset < result.bytesRead
          ? newlineOffset + 1
          : result.bytesRead;
        const segmentBytes = segmentEnd - chunkOffset;
        currentLineBytes += segmentBytes;
        scanOffset += segmentBytes;
        chunkOffset = segmentEnd;

        if (newlineOffset >= 0 && newlineOffset < result.bytesRead) {
          const oversizedLine: OversizedSourceLine = {
            sourceId: source.id,
            relativePath: source.relative_path,
            byteOffset: lineStartOffset,
            lineLengthBytes: currentLineBytes,
          };
          oversizedLines.push(oversizedLine);
          entries.push({ kind: "oversized", ...oversizedLine });
          processedCount += 1;
          endOffset = scanOffset;
          lineStartOffset = scanOffset;
          currentLineBytes = 0;
          skippingOversizedLine = false;
          if (
            processedCount >= options.maxRecords
            || scanOffset - startOffset >= options.maxBytes
          ) {
            limited = scanOffset < fileSize;
            stopped = true;
          }
        } else if (scanOffset - startScanOffset >= options.maxBytes) {
          limited = scanOffset < fileSize;
          stopped = true;
        }
        continue;
      }

      if (
        currentLineBytes === 0
        && scanOffset - startOffset >= options.maxBytes
      ) {
        limited = scanOffset < fileSize;
        stopped = true;
        break;
      }
      const newlineOffset = chunk.indexOf(0x0a, chunkOffset);
      const hasNewline = newlineOffset >= 0 && newlineOffset < result.bytesRead;
      const segmentEnd = hasNewline ? newlineOffset + 1 : result.bytesRead;
      const segmentBytes = segmentEnd - chunkOffset;
      currentLineBytes += segmentBytes;
      scanOffset += segmentBytes;

      if (bufferedLineBytes + segmentBytes > options.maxLineBytes) {
        lineChunks = [];
        bufferedLineBytes = 0;
        skippingOversizedLine = true;
      } else if (segmentBytes > 0) {
        lineChunks.push(Buffer.from(chunk.subarray(chunkOffset, segmentEnd)));
        bufferedLineBytes += segmentBytes;
        maxBufferedLineBytes = Math.max(maxBufferedLineBytes, bufferedLineBytes);
      }
      chunkOffset = segmentEnd;

      if (skippingOversizedLine) {
        if (hasNewline) {
          const oversizedLine: OversizedSourceLine = {
            sourceId: source.id,
            relativePath: source.relative_path,
            byteOffset: lineStartOffset,
            lineLengthBytes: currentLineBytes,
          };
          oversizedLines.push(oversizedLine);
          entries.push({ kind: "oversized", ...oversizedLine });
          processedCount += 1;
          endOffset = scanOffset;
          lineStartOffset = scanOffset;
          currentLineBytes = 0;
          skippingOversizedLine = false;
          if (
            processedCount >= options.maxRecords
            || scanOffset - startOffset >= options.maxBytes
          ) {
            limited = scanOffset < fileSize;
            stopped = true;
          }
        } else if (scanOffset - startScanOffset >= options.maxBytes) {
          limited = scanOffset < fileSize;
          stopped = true;
        }
        continue;
      }

      if (hasNewline) {
        const line = Buffer.concat(lineChunks, bufferedLineBytes);
        const parsed = parseCompleteLine(line);
        if (parsed.exchange) {
          const record: SourceRecord = {
            exchange: parsed.exchange,
            byteOffset: lineStartOffset,
            lineLengthBytes: currentLineBytes,
            lineSha256: createHash("sha256").update(line).digest("hex"),
          };
          records.push(record);
          entries.push({ kind: "record", ...record });
        } else {
          const invalidLine: InvalidSourceLine = {
            sourceId: source.id,
            relativePath: source.relative_path,
            byteOffset: lineStartOffset,
            lineLengthBytes: currentLineBytes,
            reason: parsed.reason,
          };
          entries.push({ kind: "invalid", ...invalidLine });
          if (invalidLines.length < MAX_INVALID_LINE_DETAILS) {
            invalidLines.push(invalidLine);
          }
        }
        processedCount += 1;
        endOffset = scanOffset;
        lineStartOffset = scanOffset;
        lineChunks = [];
        bufferedLineBytes = 0;
        currentLineBytes = 0;

        if (
          processedCount >= options.maxRecords
          || scanOffset - startOffset >= options.maxBytes
        ) {
          limited = scanOffset < fileSize;
          stopped = true;
        }
      }
    }
  }

  const reachedSnapshotEnd = readPosition >= fileSize && scanOffset >= fileSize;
  const hasPartialTail = reachedSnapshotEnd
    && (skippingOversizedLine || currentLineBytes > 0);
  const endScanOffset = skippingOversizedLine ? scanOffset : endOffset;

  return {
    sourceId: source.id,
    relativePath: source.relative_path,
    fileId: source.file_id,
    sourceGeneration: source.generation,
    sourceFileSize: source.file_size,
    fileSize,
    startOffset,
    endOffset,
    startScanOffset,
    endScanOffset,
    records,
    oversizedLines,
    invalidLines,
    entries,
    processedCount,
    bytesRead,
    hasPartialTail,
    limited,
    maxBufferedLineBytes,
  };
}

function parseCompleteLine(
  line: Buffer,
): { exchange: RawCapturedExchangeV2; reason?: never }
  | { exchange?: never; reason: InvalidSourceLineReason } {
  let contentEnd = line.length - 1;
  if (contentEnd > 0 && line[contentEnd - 1] === 0x0d) {
    contentEnd -= 1;
  }
  if (contentEnd === 0) {
    return { reason: "empty_line" };
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      line.subarray(0, contentEnd),
    );
  } catch {
    return { reason: "invalid_utf8" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "invalid_json" };
  }
  if (!isObject(value) || value.schemaVersion !== 2) {
    return { reason: "unsupported_schema" };
  }
  if (
    Object.hasOwn(value, "stream")
    || hasParsedFields(value.request)
    || hasParsedFields(value.response)
  ) {
    return { reason: "not_raw_only" };
  }
  if (!isRawCapturedExchangeV2(value)) {
    return { reason: "invalid_v2_record" };
  }
  return { exchange: value };
}

function isRawCapturedExchangeV2(value: unknown): value is RawCapturedExchangeV2 {
  return isObject(value)
    && value.schemaVersion === 2
    && typeof value.exchangeId === "string"
    && typeof value.captureSessionId === "string"
    && isNonNegativeSafeInteger(value.sequence)
    && typeof value.capturedAt === "string"
    && typeof value.completedAt === "string"
    && isNonNegativeSafeInteger(value.durationMs)
    && (value.firstTokenMs === undefined || isNonNegativeSafeInteger(value.firstTokenMs))
    && isObject(value.routing)
    && typeof value.routing.targetId === "string"
    && typeof value.routing.targetName === "string"
    && (value.routing.targetFormatHint === "anthropic"
      || value.routing.targetFormatHint === "openai")
    && typeof value.routing.localUrl === "string"
    && typeof value.routing.upstreamUrl === "string"
    && typeof value.routing.localPath === "string"
    && typeof value.routing.upstreamPath === "string"
    && typeof value.routing.method === "string"
    && (value.routing.agent === undefined
      || (typeof value.routing.agent === "string"
        && value.routing.agent.trim().length > 0
        && value.routing.agent.length <= 32))
    && (value.routing.wireApi === undefined
      || value.routing.wireApi === "responses"
      || value.routing.wireApi === "chat_completions"
      || value.routing.wireApi === "messages")
    && (value.routing.requestedModel === undefined
      || (typeof value.routing.requestedModel === "string"
        && value.routing.requestedModel.trim().length > 0
        && value.routing.requestedModel.length <= 256))
    && (value.routing.routeMode === undefined
      || value.routing.routeMode === "model"
      || value.routing.routeMode === "local_import")
    && (value.routing.origin === undefined
      || value.routing.origin === "gateway"
      || value.routing.origin === "agent_local_import")
    && (value.routing.clientQuerySource === undefined
      || (typeof value.routing.clientQuerySource === "string"
        && value.routing.clientQuerySource.length > 0
        && value.routing.clientQuerySource.length <= 64))
    && (value.routing.clientCredentialId === undefined
      || (typeof value.routing.clientCredentialId === "string"
        && value.routing.clientCredentialId.length > 0
        && value.routing.clientCredentialId.length <= 128))
    && (value.routing.failover === undefined || isRoutingFailoverMetadata(value.routing.failover))
    && isRawRequest(value.request)
    && isRawResponse(value.response)
    && isRawBodyStorageMetadata(value.bodyStorage)
    && Array.isArray(value.captureDiagnostics)
    && value.captureDiagnostics.every(isCaptureDiagnostic)
    && isCaptureSecurityMetadata(value.security);
}

function isRawRequest(value: unknown): boolean {
  return isObject(value)
    && isStringRecord(value.headers)
    && isNonNegativeSafeInteger(value.bodySizeBytes)
    && typeof value.bodySha256 === "string"
    && (value.rawBody === undefined || typeof value.rawBody === "string")
    && (value.rawBodyRef === undefined || isRawBodyReference(value.rawBodyRef));
}

function isRawResponse(value: unknown): boolean {
  return isRawRequest(value)
    && isObject(value)
    && isNonNegativeSafeInteger(value.status)
    && typeof value.statusText === "string"
    && typeof value.isStreaming === "boolean";
}

function isRawBodyStorageMetadata(
  value: unknown,
): value is RawBodyStorageMetadata {
  return isObject(value)
    && (value.policy === "inline"
      || value.policy === "compressed-inline"
      || value.policy === "external-blob")
    && (value.compression === undefined || value.compression === "gzip")
    && (value.externalBlobDir === undefined
      || typeof value.externalBlobDir === "string")
    && (value.thresholdBytes === undefined
      || isNonNegativeSafeInteger(value.thresholdBytes));
}

function isCaptureDiagnostic(value: unknown): value is CaptureDiagnostic {
  return isObject(value)
    && typeof value.code === "string"
    && (CAPTURE_DIAGNOSTIC_CODES as readonly string[]).includes(value.code)
    && (value.severity === "info"
      || value.severity === "warning"
      || value.severity === "error")
    && typeof value.message === "string";
}

function isCaptureSecurityMetadata(
  value: unknown,
): value is CaptureSecurityMetadata {
  return isObject(value)
    && typeof value.containsSensitiveHeaders === "boolean"
    && typeof value.headerRedactionAppliedInApi === "boolean"
    && typeof value.rawBodiesStoredLocally === "boolean";
}

/** 模型故障转移元数据（可选字段；有界：attempts ≤ 8 项，文本字段限长）。 */
function isRoutingFailoverMetadata(value: unknown): boolean {
  return isObject(value)
    && (value.trigger === "consecutive_failures"
      || value.trigger === "compaction"
      || value.trigger === "probe")
    && typeof value.fromTargetId === "string"
    && (value.fromTargetName === undefined
      || (typeof value.fromTargetName === "string" && value.fromTargetName.length <= 128))
    && typeof value.fromModel === "string"
    && typeof value.toTargetId === "string"
    && (value.toTargetName === undefined
      || (typeof value.toTargetName === "string" && value.toTargetName.length <= 128))
    && typeof value.toModel === "string"
    && isNonNegativeSafeInteger(value.retryCount)
    && Array.isArray(value.attempts)
    && value.attempts.length > 0
    && value.attempts.length <= 8
    && value.attempts.every((attempt: unknown) => isObject(attempt)
      && typeof attempt.targetId === "string"
      && typeof attempt.model === "string"
      && (attempt.outcome === "error" || attempt.outcome === "served")
      && (attempt.detail === undefined || (typeof attempt.detail === "string" && attempt.detail.length <= 128)));
}

function isRawBodyReference(value: unknown): value is RawBodyReference {
  return isObject(value)
    && (value.storage === "inline"
      || value.storage === "compressed-inline"
      || value.storage === "external-blob")
    && (value.encoding === "identity" || value.encoding === "gzip")
    && typeof value.sha256 === "string"
    && isNonNegativeSafeInteger(value.sizeBytes)
    && (value.compressedSizeBytes === undefined
      || isNonNegativeSafeInteger(value.compressedSizeBytes))
    && (value.inlineBase64 === undefined || typeof value.inlineBase64 === "string")
    && (value.externalPath === undefined || typeof value.externalPath === "string");
}

function hasParsedFields(value: unknown): boolean {
  return isObject(value)
    && (Object.hasOwn(value, "parsedBody") || Object.hasOwn(value, "parseError"));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateReadOptions(options: ReadSourceBatchOptions): void {
  assertBoundedInteger("maxRecords", options.maxRecords, MAX_BATCH_RECORDS);
  assertBoundedInteger("maxBytes", options.maxBytes, MAX_BATCH_BYTES);
  assertBoundedInteger("maxLineBytes", options.maxLineBytes, MAX_SOURCE_LINE_BYTES);
}

function assertBoundedInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} 必须是 1 到 ${maximum} 的有限范围整数。`);
  }
}

function sourceRelativePath(absolutePath: string): string {
  const fileName = basename(absolutePath);
  const v2Dir = dirname(absolutePath);
  if (
    extname(fileName) !== ".jsonl"
    || basename(v2Dir) !== "v2"
    || basename(dirname(v2Dir)) !== "captures"
  ) {
    throw new Error(`raw source 路径必须是 captures/v2 的直接 .jsonl 文件：${absolutePath}`);
  }
  return posix.join("captures", "v2", fileName);
}

/** 数据库文件所在目录是 source 路径的唯一根，不能由调用者提供外部同名别名。 */
function expectedSourceBinding(
  db: DeepaaDatabase,
  relativePath: string,
): SourcePathBinding {
  const directoryBinding = expectedSourceDirectoryBinding(db);
  const expectedPath = resolve(directoryBinding.dataDir, relativePath);
  if (
    dirname(expectedPath) !== directoryBinding.captureDir
    || relativePath !== posix.join("captures", "v2", basename(expectedPath))
    || extname(expectedPath) !== ".jsonl"
  ) {
    throw new Error(`数据库中的 raw source 路径不规范：${relativePath}`);
  }
  return { ...directoryBinding, expectedPath };
}

function expectedDiscoveryBinding(
  db: DeepaaDatabase,
  dataDir: string,
): SourceDirectoryBinding {
  const binding = expectedSourceDirectoryBinding(db);
  if (resolve(dataDir) !== binding.dataDir) {
    throw new Error(`v2 raw source 发现根目录必须匹配数据库 dataDir：${binding.dataDir}`);
  }
  return binding;
}

function expectedSourceDirectoryBinding(
  db: DeepaaDatabase,
): SourceDirectoryBinding {
  const dataDir = dirname(resolve(db.name));
  const capturesDir = join(dataDir, "captures");
  return {
    dataDir,
    capturesDir,
    captureDir: join(capturesDir, "v2"),
  };
}

/**
 * Node 没有 openat；因此在文件打开前后都重验目录类型、真实父子关系和 identity。
 * 配置 dataDir 可以是受信任的符号链接，其目标以及其余路径组件发生替换时仍会在读取前失败。
 */
async function validateSourceDirectoryBoundary(
  binding: SourceDirectoryBinding,
): Promise<SourceDirectoryBoundary> {
  const [dataInfo, capturesInfo, captureInfo] = await Promise.all([
    lstat(binding.dataDir),
    lstat(binding.capturesDir),
    lstat(binding.captureDir),
  ]);
  if (!dataInfo.isDirectory() && !dataInfo.isSymbolicLink()) {
    throw new Error(`v2 raw source dataDir 路径组件不是实际目录：${binding.dataDir}`);
  }
  if (!capturesInfo.isDirectory()) {
    throw new Error(`v2 raw source captures 路径组件不是实际目录：${binding.capturesDir}`);
  }
  if (!captureInfo.isDirectory()) {
    throw new Error(`v2 raw source v2 路径组件不是实际目录：${binding.captureDir}`);
  }

  const [realDataDir, realCapturesDir, realCaptureDir] = await Promise.all([
    realpath(binding.dataDir),
    realpath(binding.capturesDir),
    realpath(binding.captureDir),
  ]);
  const realDataInfo = await lstat(realDataDir);
  if (!realDataInfo.isDirectory()) {
    throw new Error(`v2 raw source dataDir 目标不是实际目录：${binding.dataDir}`);
  }
  if (
    realCapturesDir !== join(realDataDir, "captures")
    || realCaptureDir !== join(realCapturesDir, "v2")
  ) {
    throw new Error(`v2 raw source 真实目录边界不匹配数据库 dataDir：${binding.captureDir}`);
  }

  return {
    dataDirId: sourceFileId(realDataInfo.dev, realDataInfo.ino),
    capturesDirId: sourceFileId(capturesInfo.dev, capturesInfo.ino),
    captureDirId: sourceFileId(captureInfo.dev, captureInfo.ino),
    realDataDir,
    realCapturesDir,
    realCaptureDir,
  };
}

async function validateSourceFilePath(
  binding: SourcePathBinding,
  boundary: SourceDirectoryBoundary,
  relativePath: string,
): Promise<string> {
  const info = await lstat(binding.expectedPath);
  if (!info.isFile()) {
    throw new Error(`v2 raw source 不是普通文件或已替换为符号链接：${relativePath}`);
  }
  const realSourcePath = await realpath(binding.expectedPath);
  if (realSourcePath !== join(boundary.realCaptureDir, basename(binding.expectedPath))) {
    throw new Error(`v2 raw source 文件越出真实目录边界：${relativePath}`);
  }
  return sourceFileId(info.dev, info.ino);
}

function sameSourceDirectoryBoundary(
  before: SourceDirectoryBoundary,
  after: SourceDirectoryBoundary,
): boolean {
  return before.dataDirId === after.dataDirId
    && before.capturesDirId === after.capturesDirId
    && before.captureDirId === after.captureDirId
    && before.realDataDir === after.realDataDir
    && before.realCapturesDir === after.realCapturesDir
    && before.realCaptureDir === after.realCaptureDir;
}

export function sourceFileId(device: number, inode: number): string {
  return `${device}:${inode}`;
}

function assertSafeFileSize(size: number, filePath: string): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`v2 raw source 文件大小超出安全整数范围：${filePath}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
