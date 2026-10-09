import { randomUUID } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  storeRawBody,
  readRawBodyText as readStoredRawBodyText,
  sha256Hex,
  type ReadRawBodyTextOptions,
} from "./raw-body";
import { parseSSEStream } from "../../sse";
import type {
  CaptureDiagnostic,
  CaptureParseError,
  CaptureRouting,
  CapturedRequest,
  CapturedResponse,
  RawBodyPolicy,
  RawBodyReference,
  RawCapturedExchange,
  RawCapturedExchangeV2,
  RawCapturedRequestV2,
  RawCapturedResponseV2,
  StreamConnectionStatus,
} from "./types";
import { DEFAULT_RAW_BODY_POLICY } from "./types";

/** 同一 v2 文件的追加临界区必须串行，确保返回的 byteOffset 与实际写入范围一致。 */
const v2AppendQueues = new Map<string, Promise<void>>();
/** 记录回滚失败前的安全边界；恢复成功前，同一文件不得继续追加。 */
const v2PoisonedOffsets = new Map<string, number>();
const V2_CAPTURE_SESSION_ID_PATTERN = /^capture-v2-\d+-[0-9a-f]{8}-[0-9a-f]{3}$/;
const DEFAULT_HYDRATE_MAX_BYTES = 8 * 1024 * 1024;
const V2_TAIL_SCAN_BLOCK_BYTES = 64 * 1024;

interface BuildRawCapturedExchangeInput {
  dataDir: string;
  captureSessionId: string;
  sequence: number;
  capturedAt: string;
  completedAt: string;
  routing: CaptureRouting;
  request: {
    headers: Record<string, string>;
    rawBody: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    rawBody: string;
    isStreaming: boolean;
  };
  rawBodyPolicy?: Partial<RawBodyPolicy>;
  connectionStatus?: StreamConnectionStatus;
}

export function createCaptureSessionId(date = new Date(), batch = 1): string {
  const day = date.toISOString().slice(0, 10);
  return `capture-${day}-${String(batch).padStart(3, "0")}`;
}

export function createV2CaptureSessionId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("v2 capture Session ID timestamp must be a non-negative safe integer.");
  }
  return `capture-v2-${now}-${randomUUID().slice(0, 12)}`;
}

export async function buildRawCapturedExchange(
  input: BuildRawCapturedExchangeInput
): Promise<RawCapturedExchange> {
  const policy = {
    ...DEFAULT_RAW_BODY_POLICY,
    ...input.rawBodyPolicy,
  };
  const exchangeId = `${input.captureSessionId}:ex-${input.sequence}`;
  const diagnostics: CaptureDiagnostic[] = [];
  const request = await buildCapturedRequest(input.dataDir, input.request, policy, "request", diagnostics);
  const response = await buildCapturedResponse(input.dataDir, input.response, policy, diagnostics);
  const stream = input.response.isStreaming
    ? buildCapturedStream(response, input.response.rawBody, diagnostics)
    : undefined;
  appendStatusDiagnostics(input.response.status, input.connectionStatus, diagnostics);

  return {
    schemaVersion: 1,
    exchangeId,
    captureSessionId: input.captureSessionId,
    sequence: input.sequence,
    capturedAt: input.capturedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.capturedAt)),
    routing: input.routing,
    request,
    response,
    stream,
    bodyStorage: {
      policy: "inline",
      compression: "gzip",
      externalBlobDir: "blobs",
      thresholdBytes: policy.inlineThresholdBytes,
    },
    captureDiagnostics: diagnostics,
    security: {
      containsSensitiveHeaders: containsSensitiveHeaders(input.request.headers)
        || containsSensitiveHeaders(input.response.headers),
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

/** v2 原始证据只保存 raw/blob，不在代理进程生成可由原文重建的解析副本。 */
export async function buildRawCapturedExchangeV2(
  input: BuildRawCapturedExchangeInput
): Promise<RawCapturedExchangeV2> {
  const policy = {
    ...DEFAULT_RAW_BODY_POLICY,
    ...input.rawBodyPolicy,
  };
  const exchangeId = `${input.captureSessionId}:ex-${input.sequence}`;
  const diagnostics: CaptureDiagnostic[] = [];
  const request = await buildCapturedRequestV2(input.dataDir, input.request, policy);
  const response = await buildCapturedResponseV2(input.dataDir, input.response, policy);
  appendStatusDiagnostics(input.response.status, input.connectionStatus, diagnostics);

  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: input.captureSessionId,
    sequence: input.sequence,
    capturedAt: input.capturedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.capturedAt)),
    routing: input.routing,
    request,
    response,
    bodyStorage: {
      policy: "inline",
      compression: "gzip",
      externalBlobDir: "blobs",
      thresholdBytes: policy.inlineThresholdBytes,
    },
    captureDiagnostics: diagnostics,
    security: {
      containsSensitiveHeaders: containsSensitiveHeaders(input.request.headers)
        || containsSensitiveHeaders(input.response.headers),
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

/** 仅供 Worker 或单条详情读取使用；返回的解析结果不得再次写回代理原始 Store。 */
export async function hydrateRawCapturedExchange(
  dataDir: string,
  exchange: RawCapturedExchange,
  options: { maxBytes?: number } = {}
): Promise<RawCapturedExchange> {
  const maxBytes = options.maxBytes ?? DEFAULT_HYDRATE_MAX_BYTES;
  const requestText = await readRawBodyText(dataDir, exchange.request, {
    maxBytes,
    label: "request",
  });
  const responseText = await readRawBodyText(dataDir, exchange.response, {
    maxBytes,
    label: "response",
  });
  return {
    ...exchange,
    request: { ...exchange.request, parsedBody: parseJsonBody(requestText).value },
    response: {
      ...exchange.response,
      parsedBody: exchange.response.isStreaming ? undefined : parseJsonBody(responseText).value,
    },
    stream: exchange.response.isStreaming
      ? buildCapturedStream(exchange.response, responseText, [])
      : undefined,
  };
}

/** v2 代理持久化只做纯追加，不生成或更新旧版抓包索引。 */
export async function appendRawCapturedExchangeV2(
  dataDir: string,
  exchange: RawCapturedExchangeV2
): Promise<{ filePath: string; byteOffset: number; lineLengthBytes: number }> {
  assertUnhydratedV2Exchange(exchange);
  assertValidV2CaptureSessionId(exchange.captureSessionId);
  const dir = join(dataDir, "captures", "v2");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${exchange.captureSessionId}.jsonl`);
  const line = Buffer.from(`${JSON.stringify(buildRawCapturedExchangeV2Snapshot(exchange))}\n`, "utf-8");
  return withV2AppendLock(filePath, async () => {
    const handle = await open(filePath, "a+");
    try {
      await recoverV2PoisonedOffset(handle, filePath);
      const byteOffset = await repairV2PartialTail(handle);
      try {
        await writeBufferFully(handle, line);
        return { filePath, byteOffset, lineLengthBytes: line.length };
      } catch (error) {
        try {
          await handle.truncate(byteOffset);
        } catch (rollbackError) {
          v2PoisonedOffsets.set(filePath, byteOffset);
          throw new AggregateError(
            [error, rollbackError],
            `v2 raw capture append failed and rollback to byte offset ${byteOffset} also failed.`,
          );
        }
        throw error;
      }
    } finally {
      await handle.close();
    }
  });
}

export async function readRawBodyText(
  dataDir: string,
  source: { rawBody?: string; rawBodyRef?: CapturedRequest["rawBodyRef"] },
  options?: ReadRawBodyTextOptions
): Promise<string> {
  return readStoredRawBodyText(dataDir, source, options);
}
async function buildCapturedRequest(
  dataDir: string,
  source: { headers: Record<string, string>; rawBody: string },
  policy: RawBodyPolicy,
  side: "request" | "response",
  diagnostics: CaptureDiagnostic[]
): Promise<CapturedRequest> {
  const stored = await storeRawBody(dataDir, source.rawBody, policy);
  const parseResult = parseJsonBody(source.rawBody);
  if (parseResult.parseError) {
    diagnostics.push({
      code: `${side}_json_parse_failed`,
      severity: "warning",
      message: parseResult.parseError.message,
    });
  }
  return {
    headers: lowerCaseHeaders(source.headers),
    rawBody: stored.inline,
    rawBodyRef: stored.reference,
    parsedBody: parseResult.value,
    parseError: parseResult.parseError,
    bodySizeBytes: Buffer.byteLength(source.rawBody),
    bodySha256: await sha256Hex(source.rawBody),
  };
}

async function buildCapturedRequestV2(
  dataDir: string,
  source: { headers: Record<string, string>; rawBody: string },
  policy: RawBodyPolicy
): Promise<RawCapturedRequestV2> {
  const stored = await storeRawBody(dataDir, source.rawBody, policy);
  return {
    headers: lowerCaseHeaders(source.headers),
    rawBody: stored.inline,
    rawBodyRef: stored.reference,
    bodySizeBytes: Buffer.byteLength(source.rawBody),
    bodySha256: stored.reference.sha256,
  };
}

async function buildCapturedResponse(
  dataDir: string,
  source: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    rawBody: string;
    isStreaming: boolean;
  },
  policy: RawBodyPolicy,
  diagnostics: CaptureDiagnostic[]
): Promise<CapturedResponse> {
  const stored = await storeRawBody(dataDir, source.rawBody, policy);
  const parseResult = source.isStreaming ? {} : parseJsonBody(source.rawBody);
  if (parseResult.parseError) {
    diagnostics.push({
      code: "response_json_parse_failed",
      severity: "warning",
      message: parseResult.parseError.message,
    });
  }
  return {
    status: source.status,
    statusText: source.statusText,
    headers: lowerCaseHeaders(source.headers),
    rawBody: stored.inline,
    rawBodyRef: stored.reference,
    parsedBody: parseResult.value,
    parseError: parseResult.parseError,
    bodySizeBytes: Buffer.byteLength(source.rawBody),
    bodySha256: await sha256Hex(source.rawBody),
    isStreaming: source.isStreaming,
  };
}

async function buildCapturedResponseV2(
  dataDir: string,
  source: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    rawBody: string;
    isStreaming: boolean;
  },
  policy: RawBodyPolicy
): Promise<RawCapturedResponseV2> {
  const stored = await storeRawBody(dataDir, source.rawBody, policy);
  return {
    status: source.status,
    statusText: source.statusText,
    headers: lowerCaseHeaders(source.headers),
    rawBody: stored.inline,
    rawBodyRef: stored.reference,
    bodySizeBytes: Buffer.byteLength(source.rawBody),
    bodySha256: stored.reference.sha256,
    isStreaming: source.isStreaming,
  };
}

function buildCapturedStream(
  response: CapturedResponse,
  rawBody: string,
  diagnostics: CaptureDiagnostic[]
) {
  const parsed = parseSSEStream(rawBody);
  if (rawBody.trim() && parsed.events.length === 0) {
    diagnostics.push({
      code: "sse_parse_empty",
      severity: "warning",
      message: "SSE raw body is non-empty but no events were parsed.",
    });
  }
  for (const parseError of parsed.parseErrors) {
    diagnostics.push({
      code: "sse_event_parse_failed",
      severity: "warning",
      message: parseError.message,
    });
  }
  return {
    events: parsed.events,
    parseErrors: parsed.parseErrors,
    doneMarkerSeen: parsed.doneMarkerSeen,
    rawBodyStorage: response.rawBodyRef?.storage || "inline",
  };
}

function appendStatusDiagnostics(
  status: number,
  connectionStatus: StreamConnectionStatus | undefined,
  diagnostics: CaptureDiagnostic[]
): void {
  if (status >= 400 && status !== 499) {
    diagnostics.push({
      code: "upstream_error",
      severity: "error",
      message: `HTTP ${status} response captured.`,
    });
  }
  if (!connectionStatus || connectionStatus === "open_completed" || connectionStatus === "unknown") return;
  const code = connectionStatus === "proxy_stream_error" ? "proxy_error" : connectionStatus;
  diagnostics.push({
    code,
    severity: connectionStatus === "client_aborted" ? "warning" : "error",
    message: `Stream connection ended with ${connectionStatus}.`,
  });
}

function parseJsonBody(rawBody: string): { value?: unknown; parseError?: CaptureParseError } {
  if (!rawBody.trim()) return { value: undefined };
  try {
    return { value: JSON.parse(rawBody) };
  } catch (error) {
    return {
      parseError: {
        message: error instanceof Error ? error.message : "JSON parse failed",
        rawPreview: rawBody.slice(0, 160),
      },
    };
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function containsSensitiveHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(key =>
    ["authorization", "api-key", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]
      .includes(key.toLowerCase())
  );
}

function assertValidV2CaptureSessionId(value: string): void {
  if (!V2_CAPTURE_SESSION_ID_PATTERN.test(value)) {
    throw new Error(`invalid v2 captureSessionId: ${value}`);
  }
}

function assertUnhydratedV2Exchange(exchange: RawCapturedExchangeV2): void {
  const untrusted = exchange as RawCapturedExchange;
  if (untrusted.schemaVersion !== 2) {
    throw new Error("v2 raw capture writer requires schemaVersion 2.");
  }
  if (
    untrusted.request.parsedBody !== undefined
    || untrusted.request.parseError !== undefined
    || untrusted.response.parsedBody !== undefined
    || untrusted.response.parseError !== undefined
    || untrusted.stream !== undefined
  ) {
    throw new Error("v2 raw capture writer requires unhydrated raw evidence.");
  }
}

function buildRawCapturedExchangeV2Snapshot(
  exchange: RawCapturedExchangeV2
): RawCapturedExchangeV2 {
  return {
    schemaVersion: 2,
    exchangeId: exchange.exchangeId,
    captureSessionId: exchange.captureSessionId,
    sequence: exchange.sequence,
    capturedAt: exchange.capturedAt,
    completedAt: exchange.completedAt,
    durationMs: exchange.durationMs,
    routing: {
      targetId: exchange.routing.targetId,
      targetName: exchange.routing.targetName,
      targetFormatHint: exchange.routing.targetFormatHint,
      localUrl: exchange.routing.localUrl,
      upstreamUrl: exchange.routing.upstreamUrl,
      localPath: exchange.routing.localPath,
      upstreamPath: exchange.routing.upstreamPath,
      method: exchange.routing.method,
      // 实际注入的密钥 ID：派生时按它读取密钥价格倍率，缺失会回退默认倍率 1。
      clientCredentialId: exchange.routing.clientCredentialId,
      // 模型故障转移元数据：派生投影与会话追踪/交互内容展示「原模型 → 实际模型」依赖该字段。
      failover: exchange.routing.failover,
    },
    request: {
      headers: { ...exchange.request.headers },
      rawBody: exchange.request.rawBody,
      rawBodyRef: snapshotRawBodyReference(exchange.request.rawBodyRef),
      bodySizeBytes: exchange.request.bodySizeBytes,
      bodySha256: exchange.request.bodySha256,
    },
    response: {
      status: exchange.response.status,
      statusText: exchange.response.statusText,
      headers: { ...exchange.response.headers },
      rawBody: exchange.response.rawBody,
      rawBodyRef: snapshotRawBodyReference(exchange.response.rawBodyRef),
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
    captureDiagnostics: exchange.captureDiagnostics.map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
    security: {
      containsSensitiveHeaders: exchange.security.containsSensitiveHeaders,
      headerRedactionAppliedInApi: exchange.security.headerRedactionAppliedInApi,
      rawBodiesStoredLocally: exchange.security.rawBodiesStoredLocally,
    },
  };
}

function snapshotRawBodyReference(
  reference: RawBodyReference | undefined
): RawBodyReference | undefined {
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

async function recoverV2PoisonedOffset(handle: FileHandle, filePath: string): Promise<void> {
  const byteOffset = v2PoisonedOffsets.get(filePath);
  if (byteOffset === undefined) return;
  try {
    await handle.truncate(byteOffset);
  } catch (error) {
    throw new Error(
      `v2 raw capture recovery to byte offset ${byteOffset} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  v2PoisonedOffsets.delete(filePath);
}

/**
 * 进程重启后 poisoned map 会丢失，因此每次追加前都以固定小块倒序寻找最后一个完整换行。
 * 只截断末尾半行，不把可能很大的 capture 文件整体读入内存。
 */
async function repairV2PartialTail(handle: FileHandle): Promise<number> {
  const fileSize = (await handle.stat()).size;
  let scanEnd = fileSize;
  while (scanEnd > 0) {
    const scanStart = Math.max(0, scanEnd - V2_TAIL_SCAN_BLOCK_BYTES);
    const blockLength = scanEnd - scanStart;
    const block = Buffer.allocUnsafe(blockLength);
    let bytesRead = 0;
    while (bytesRead < blockLength) {
      const result = await handle.read(
        block,
        bytesRead,
        blockLength - bytesRead,
        scanStart + bytesRead,
      );
      if (result.bytesRead <= 0) {
        throw new Error(`v2 raw capture tail scan stopped at byte offset ${scanStart + bytesRead}.`);
      }
      bytesRead += result.bytesRead;
    }
    const lastNewline = block.lastIndexOf(0x0a);
    if (lastNewline >= 0) {
      const cleanOffset = scanStart + lastNewline + 1;
      if (cleanOffset !== fileSize) await handle.truncate(cleanOffset);
      return cleanOffset;
    }
    scanEnd = scanStart;
  }
  if (fileSize > 0) await handle.truncate(0);
  return 0;
}

async function writeBufferFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, null);
    if (result.bytesWritten <= 0) {
      throw new Error(`v2 raw capture append stopped after ${written} of ${buffer.length} bytes.`);
    }
    written += result.bytesWritten;
  }
}

async function withV2AppendLock<T>(filePath: string, append: () => Promise<T>): Promise<T> {
  const previous = v2AppendQueues.get(filePath) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  v2AppendQueues.set(filePath, current);
  await previous;
  try {
    return await append();
  } finally {
    release();
    if (v2AppendQueues.get(filePath) === current) {
      v2AppendQueues.delete(filePath);
    }
  }
}
