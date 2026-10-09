import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { Readable } from "node:stream";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactHeaders } from "./app-state";
import { acquireExplicitRawLease } from "./explicit-raw-lease";
import {
  openRawBodyStream,
  RawBodyStreamError,
  type RawBodyStreamResult,
} from "./harness/raw-body-stream";
import { boundedUtf8 } from "./ingestion/content-preview";
import {
  locateRawExchange,
  RawLocatorError,
} from "./harness/raw-locator";
import type { RawCapturedExchangeV2 } from "./harness/types";
import { DataUrlProjector } from "./ingestion/data-url-projector";
import {
  classifyRawReadGate,
  rawReadGateMessage,
} from "./ingestion/raw-read-gate";
import { RawStreamGatewayError } from "./raw-stream-gateway";
import {
  isWorkbenchInspectorViewableImage,
  workbenchMediaMarker,
  WORKBENCH_RAW_DISPLAY_LIMIT_BYTES,
  WORKBENCH_RAW_MEDIA_LIMIT,
  WORKBENCH_RAW_SCAN_LIMIT_BYTES,
  type WorkbenchRawInspectorMedia,
  type WorkbenchRawInspectorBodyEvent,
  type WorkbenchRawInspectorMetadata,
  type WorkbenchRawInspectorSide,
} from "./workbench-raw-inspector-types";

const HEADER_FIELD_LIMIT = 512;
const HEADER_NAME_LIMIT_BYTES = 512;
const HEADER_VALUE_LIMIT_BYTES = 64 * 1024;
const HEADER_TOTAL_LIMIT_BYTES = 512 * 1024;
const CREDENTIAL_METADATA_LIMIT_BYTES = 1024 * 1024;
/** 网关注入模式下会被替换的客户端凭据头（展示层按上游实际值标注）。 */
const INJECTED_CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"]);

/**
 * 有界读取凭据元数据取注入凭据指纹（展示用前4+****+后4）：
 * 只读、≤1 MiB、防符号链接；任何失败静默返回 undefined（退化为通用注入标注）。
 */
async function lookupCredentialFingerprint(
  dataDir: string,
  credentialId: string,
): Promise<string | undefined> {
  const path = join(dataDir, "config", "development-credentials.json");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CREDENTIAL_METADATA_LIMIT_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      credentials?: Array<{id?: string; fingerprintSuffix?: string}>;
    };
    const matched = (parsed.credentials ?? []).find(item => item?.id === credentialId);
    return typeof matched?.fingerprintSuffix === "string" && matched.fingerprintSuffix
      ? boundedUtf8(matched.fingerprintSuffix, 64)
      : undefined;
  } catch {
    return undefined;
  }
}

interface InspectorRow {
  target_id: string;
  target_name: string;
  model: string | null;
  request_body_state: string | null;
  response_body_state: string | null;
  request_verification: string | null;
  response_verification: string | null;
}

interface MediaRow {
  body_side: WorkbenchRawInspectorSide;
  ordinal: number;
  json_path: string;
  media_type: string;
  encoded_bytes: number;
  decoded_bytes: number;
  sha256: string;
  source_storage: "inline" | "compressed-inline" | "external-blob";
}

export class WorkbenchRawInspectorError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, number>,
  ) {
    super(message);
    this.name = "WorkbenchRawInspectorError";
  }
}

/** raw 读取门禁：purged/expired 抛出 410 结构化错误，由各入口的错误响应通道返回。 */
function assertRawReadGateAllowed(
  db: DeepaaDatabase,
  dataDir: string,
  exchangeId: string,
): void {
  const gate = classifyRawReadGate(db, dataDir, exchangeId);
  if (gate && gate.state !== "active") {
    throw new WorkbenchRawInspectorError(
      gate.state === "purged" ? "raw_purged" : "raw_expired",
      410,
      rawReadGateMessage(gate),
      {retentionDays: gate.retentionDays},
    );
  }
}

/**
 * 当前单侧正文先经过服务端媒体过滤，再以 NDJSON 固定片段返回。Raw 声明大小
 * 在打开 blob 前受 128 MiB 硬限制，浏览器不会接触 Base64 编码。
 */
export async function openWorkbenchRawInspectorBodyResponse(options: {
  db: DeepaaDatabase;
  dataDir: string;
  exchangeId: string;
  side: WorkbenchRawInspectorSide;
}): Promise<Response> {
  let release: (() => void) | undefined;
  try {
    // raw 读取门禁：已清理/超窗的 Exchange 在读取任何 raw 字节前显式拒绝（410）。
    assertRawReadGateAllowed(options.db, options.dataDir, options.exchangeId);
    const located = await locateRawExchange(
      options.db,
      options.dataDir,
      options.exchangeId,
    );
    if (!located) {
      throw new WorkbenchRawInspectorError(
        "raw_inspector_not_found",
        404,
        "Exchange 不存在。",
      );
    }
    const source = located.exchange[options.side];
    if (source.bodySizeBytes > WORKBENCH_RAW_SCAN_LIMIT_BYTES) {
      throw new WorkbenchRawInspectorError(
        "raw_scan_bytes_exceeded",
        413,
        "正文超过结构化查看的 Raw 扫描上限。",
        {
          sizeBytes: source.bodySizeBytes,
          maxBytes: WORKBENCH_RAW_SCAN_LIMIT_BYTES,
        },
      );
    }
    const storage = rawStorage(source);
    if (storage === "none") {
      throw new WorkbenchRawInspectorError(
        "raw_body_unavailable",
        404,
        "当前单侧 Raw 正文不可用。",
      );
    }
    const lease = acquireExplicitRawLease();
    if (!lease) {
      throw new WorkbenchRawInspectorError(
        "raw_stream_busy",
        429,
        "完整 Raw 流并发已达上限，请稍后重试。",
      );
    }
    release = lease.release;
    const opened = await openRawBodyStream(options.dataDir, source, {
      purpose: "projection",
      label: options.side,
      maxDecodedBytes: WORKBENCH_RAW_SCAN_LIMIT_BYTES,
    });
    const body = bridgeInspectorBody(
      iterateInspectorBodyEvents({
        opened,
        exchangeId: options.exchangeId,
        side: options.side,
        rawBodySha256: source.bodySha256,
        sourceStorage: storage,
      }),
      opened,
      release,
    );
    release = undefined;
    return new Response(body, {
      status: 200,
      headers: workbenchRawInspectorHeaders("application/x-ndjson; charset=utf-8"),
    });
  } catch (error) {
    release?.();
    return workbenchRawInspectorErrorResponse(normalizeInspectorError(error));
  }
}

/**
 * 元数据入口只按 SQLite 唯一索引读取一条 Raw envelope。正文存储引用只用于
 * 服务端身份判断，永远不进入返回 DTO。
 */
export async function loadWorkbenchRawInspectorMetadata(
  db: DeepaaDatabase,
  dataDir: string,
  exchangeId: string,
  side: WorkbenchRawInspectorSide,
): Promise<WorkbenchRawInspectorMetadata> {
  try {
    // raw 读取门禁：已清理/超窗的 Exchange 显式返回 410 状态与稳定错误码。
    assertRawReadGateAllowed(db, dataDir, exchangeId);
    const located = await locateRawExchange(db, dataDir, exchangeId);
    if (!located) {
      throw new WorkbenchRawInspectorError(
        "raw_inspector_not_found",
        404,
        "Exchange 不存在。",
      );
    }
    const row = loadInspectorRow(db, exchangeId);
    if (!row) {
      throw new WorkbenchRawInspectorError(
        "raw_inspector_not_found",
        404,
        "Exchange 不存在。",
      );
    }
    const exchange = located.exchange;
    const source = exchange[side];
    const headers = projectHeaders(source.headers);
    const media = loadSideMedia(db, exchangeId, side);
    const sizeBytes = source.bodySizeBytes;
    const rawScanAllowed = sizeBytes <= WORKBENCH_RAW_SCAN_LIMIT_BYTES;
    const availability = bodyAvailability(row, exchange, side);
    const verification = bodyVerification(row, side, availability);
    // 上游真实视角标注：注入模式下凭据头在网关侧被替换为系统凭据，捕获里的客户端
    // 占位符不是发往上游的值——展示层改标注入指纹，避免把中间占位物误读为上游事实。
    const clientCredentialId = exchange.routing.clientCredentialId;
    const credentialInjected = side === "request" && typeof clientCredentialId === "string" && Boolean(clientCredentialId);
    const credentialFingerprint = credentialInjected && clientCredentialId
      ? await lookupCredentialFingerprint(dataDir, clientCredentialId)
      : undefined;
    if (credentialInjected) {
      const injectedDisplay = credentialFingerprint
        ? `已注入系统凭据 ${credentialFingerprint}`
        : "已注入系统凭据（客户端占位已替换）";
      for (const name of Object.keys(headers.items)) {
        if (INJECTED_CREDENTIAL_HEADERS.has(name.toLowerCase())) {
          headers.items[name] = injectedDisplay;
        }
      }
    }
    const metadata: WorkbenchRawInspectorMetadata = {
      exchangeId,
      side,
      candidateCount: 1,
      processedCount: 1,
      limited: headers.limited || media.limited || !rawScanAllowed,
      indexVerification: located.indexVerification,
      routing: {
        targetId: row.target_id,
        targetName: row.target_name,
        method: boundedUtf8(exchange.routing.method, 32),
        path: boundedUtf8(exchange.routing.localPath, 2_048),
        ...(typeof exchange.routing.upstreamUrl === "string" && exchange.routing.upstreamUrl
          ? {upstreamUrl: boundedUtf8(exchange.routing.upstreamUrl, 2_048)}
          : {}),
      },
      ...(credentialInjected ? {credentialInjected: true} : {}),
      ...(credentialFingerprint ? {credentialFingerprint} : {}),
      model: row.model ?? undefined,
      durationMs: exchange.durationMs,
      headers,
      body: {
        sizeBytes,
        sha256: source.bodySha256,
        storage: rawStorage(source),
        availability,
        verification,
        contentType: contentType(source.headers),
        isStreaming: side === "response" && exchange.response.isStreaming,
        rawScanAllowed,
        displayLimitBytes: WORKBENCH_RAW_DISPLAY_LIMIT_BYTES,
        rawScanLimitBytes: WORKBENCH_RAW_SCAN_LIMIT_BYTES,
      },
      media,
    };
    if (side === "response") {
      metadata.http = {
        status: exchange.response.status,
        statusText: boundedUtf8(exchange.response.statusText, 256),
      };
    }
    return metadata;
  } catch (error) {
    if (error instanceof WorkbenchRawInspectorError) throw error;
    if (error instanceof RawLocatorError) {
      throw new WorkbenchRawInspectorError(
        "unsafe_raw_reference",
        409,
        "Raw 索引或原始记录无法安全定位。",
      );
    }
    throw error;
  }
}

export function workbenchRawInspectorErrorResponse(error: unknown): Response {
  const normalized = error instanceof WorkbenchRawInspectorError
    ? error
    : error instanceof RawStreamGatewayError
      ? new WorkbenchRawInspectorError(error.code, error.status, error.message)
    : new WorkbenchRawInspectorError(
        "raw_inspector_failed",
        500,
        "请求/响应检查器处理失败。",
      );
  return Response.json({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  }, {
    status: normalized.status,
    headers: workbenchRawInspectorHeaders("application/json; charset=utf-8"),
  });
}

async function* iterateInspectorBodyEvents(options: {
  opened: RawBodyStreamResult;
  exchangeId: string;
  side: WorkbenchRawInspectorSide;
  rawBodySha256: string;
  sourceStorage: "inline" | "compressed-inline" | "external-blob";
}): AsyncGenerator<WorkbenchRawInspectorBodyEvent> {
  const decoder = new StringDecoder("utf8");
  const pendingText: string[] = [];
  const diagnosticCodes = new Set<string>();
  let pendingMarker: string | undefined;
  let rawProcessedBytes = 0;
  let displayBytes = 0;
  let processedCount = 0;
  const projector = new DataUrlProjector({
    exchangeId: options.exchangeId,
    bodySide: options.side,
    jsonPath: "$",
    rawBodySha256: options.rawBodySha256,
    sourceStorage: options.sourceStorage,
    ordinal: 0,
    maxDescriptors: WORKBENCH_RAW_MEDIA_LIMIT,
    onText: value => {
      if (!value) return;
      const projected = value === "[media]" && pendingMarker
        ? pendingMarker
        : value;
      pendingMarker = undefined;
      pendingText.push(projected);
    },
    onDescriptor: descriptor => {
      processedCount += 1;
      pendingMarker = workbenchMediaMarker(descriptor.ordinal, descriptor.sha256);
    },
    onDiagnostic: code => {
      if (diagnosticCodes.size < 32) diagnosticCodes.add(code);
    },
  });

  const flush = function* (): Generator<WorkbenchRawInspectorBodyEvent, boolean> {
    while (pendingText.length > 0) {
      const value = pendingText.shift()!;
      const bytes = Buffer.byteLength(value);
      if (displayBytes + bytes > WORKBENCH_RAW_DISPLAY_LIMIT_BYTES) {
        yield {
          type: "limit",
          code: "display_bytes_exceeded",
          maxDisplayBytes: WORKBENCH_RAW_DISPLAY_LIMIT_BYTES,
          processedDisplayBytes: displayBytes,
          rawProcessedBytes,
          candidateCount: processedCount,
          processedCount,
          limited: true,
        };
        return false;
      }
      displayBytes += bytes;
      yield { type: "chunk", value };
    }
    return true;
  };

  for await (const rawChunk of options.opened.stream) {
    const chunk = Buffer.from(rawChunk as Uint8Array);
    rawProcessedBytes += chunk.length;
    projector.push(decoder.write(chunk));
    const flushed = yield* flush();
    if (!flushed) return;
  }
  projector.push(decoder.end());
  const projection = projector.finish();
  const flushed = yield* flush();
  if (!flushed) return;
  const verification = await options.opened.verification;
  if (verification.status !== "verified") {
    yield {
      type: "error",
      code: verification.status === "failed"
        ? verification.errorCode
        : "raw_body_integrity_failed",
      message: "Raw 正文未完成完整性校验。",
    };
    return;
  }
  yield {
    type: "complete",
    rawProcessedBytes,
    displayBytes,
    candidateCount: projection.candidateCount,
    processedCount: projection.processedCount,
    limited: false,
    diagnosticCodes: [...diagnosticCodes],
  };
}

function bridgeInspectorBody(
  events: AsyncIterable<WorkbenchRawInspectorBodyEvent>,
  opened: RawBodyStreamResult,
  release: () => void,
): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let released = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        const normalized = normalizeInspectorError(error);
        destroyReadable(opened.stream, error);
        await iterator.return?.().catch(() => undefined);
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "error",
          code: normalized.code,
          message: normalized.message,
        } satisfies WorkbenchRawInspectorBodyEvent)}\n`));
        finish();
        controller.close();
      }
    },
    async cancel(reason) {
      destroyReadable(opened.stream, reason);
      await iterator.return?.().catch(() => undefined);
      finish();
    },
  });
}

function normalizeInspectorError(error: unknown): WorkbenchRawInspectorError {
  if (error instanceof WorkbenchRawInspectorError) return error;
  if (error instanceof RawStreamGatewayError) {
    return new WorkbenchRawInspectorError(error.code, error.status, error.message);
  }
  if (error instanceof RawLocatorError) {
    return new WorkbenchRawInspectorError(
      "unsafe_raw_reference",
      409,
      "Raw 索引或原始记录无法安全定位。",
    );
  }
  if (error instanceof RawBodyStreamError) {
    return new WorkbenchRawInspectorError(
      error.code,
      error.code === "raw_body_unavailable" ? 404 : 409,
      error.code === "raw_body_integrity_failed"
        ? "Raw 正文未通过完整性校验。"
        : "Raw 正文不可用。",
    );
  }
  return new WorkbenchRawInspectorError(
    "raw_inspector_failed",
    500,
    "请求/响应检查器处理失败。",
  );
}

function destroyReadable(stream: Readable, reason: unknown): void {
  stream.destroy(reason instanceof Error ? reason : undefined);
}

export function workbenchRawInspectorHeaders(contentType: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}

function loadInspectorRow(
  db: DeepaaDatabase,
  exchangeId: string,
): InspectorRow | undefined {
  return db.prepare(
    `SELECT r.target_id, r.target_name, r.model,
      ir.request_body_state, ir.response_body_state,
      j.request_verification, j.response_verification
     FROM raw_exchange_refs r
     LEFT JOIN ingestion_records ir ON ir.id = r.ingestion_record_id
     LEFT JOIN derivation_jobs j ON j.ingestion_record_id = ir.id
     WHERE r.exchange_id = ? LIMIT 1`,
  ).get(exchangeId) as InspectorRow | undefined;
}

function loadSideMedia(
  db: DeepaaDatabase,
  exchangeId: string,
  side: WorkbenchRawInspectorSide,
): WorkbenchRawInspectorMetadata["media"] {
  const rows = db.prepare(
    `SELECT body_side, ordinal, json_path, media_type, encoded_bytes,
      decoded_bytes, sha256, source_storage
     FROM exchange_media_descriptors
     WHERE exchange_id = ? AND body_side = ?
     ORDER BY ordinal LIMIT ?`,
  ).all(exchangeId, side, WORKBENCH_RAW_MEDIA_LIMIT + 1) as MediaRow[];
  const candidateCount = db.prepare(
    `SELECT COUNT(*) FROM exchange_media_descriptors
     WHERE exchange_id = ? AND body_side = ?`,
  ).pluck().get(exchangeId, side) as number;
  const items: WorkbenchRawInspectorMedia[] = rows
    .slice(0, WORKBENCH_RAW_MEDIA_LIMIT)
    .map(row => ({
      bodySide: row.body_side,
      ordinal: row.ordinal,
      jsonPath: row.json_path,
      mediaType: row.media_type,
      encodedBytes: row.encoded_bytes,
      decodedBytes: row.decoded_bytes,
      sha256: row.sha256,
      sourceStorage: row.source_storage,
      viewable: isWorkbenchInspectorViewableImage(row.media_type),
    }));
  return {
    items,
    candidateCount,
    processedCount: rows.length,
    limited: rows.length > WORKBENCH_RAW_MEDIA_LIMIT,
  };
}

function projectHeaders(
  rawHeaders: Record<string, string>,
): WorkbenchRawInspectorMetadata["headers"] {
  const entries = Object.entries(redactHeaders(rawHeaders));
  const items: Record<string, string> = {};
  let processedBytes = 0;
  let processedCount = 0;
  let limited = false;
  for (const [rawName, rawValue] of entries) {
    if (processedCount >= HEADER_FIELD_LIMIT) {
      limited = true;
      break;
    }
    const name = boundedUtf8(rawName, HEADER_NAME_LIMIT_BYTES);
    const value = boundedUtf8(rawValue, HEADER_VALUE_LIMIT_BYTES);
    const bytes = Buffer.byteLength(name) + Buffer.byteLength(value);
    if (processedBytes + bytes > HEADER_TOTAL_LIMIT_BYTES) {
      limited = true;
      break;
    }
    if (name !== rawName || value !== rawValue) limited = true;
    items[name] = value;
    processedBytes += bytes;
    processedCount += 1;
  }
  return {
    items,
    candidateCount: entries.length,
    processedCount,
    limited: limited || processedCount < entries.length,
  };
}

function rawStorage(
  source: RawCapturedExchangeV2["request"] | RawCapturedExchangeV2["response"],
): WorkbenchRawInspectorMetadata["body"]["storage"] {
  return source.rawBodyRef?.storage
    ?? (typeof source.rawBody === "string" ? "inline" : "none");
}

function bodyAvailability(
  row: InspectorRow,
  exchange: RawCapturedExchangeV2,
  side: WorkbenchRawInspectorSide,
): WorkbenchRawInspectorMetadata["body"]["availability"] {
  const source = exchange[side];
  if (source.bodySizeBytes === 0) return "empty";
  const registered = side === "request" ? row.request_body_state : row.response_body_state;
  if (registered === "integrity_failed") return "integrity_failed";
  if (registered === "unavailable" || registered === "missing_declared") return "unavailable";
  return rawStorage(source) === "none" ? "unavailable" : "available";
}

function bodyVerification(
  row: InspectorRow,
  side: WorkbenchRawInspectorSide,
  availability: WorkbenchRawInspectorMetadata["body"]["availability"],
): WorkbenchRawInspectorMetadata["body"]["verification"] {
  if (availability === "empty") return "empty";
  if (availability === "integrity_failed") return "failed";
  const value = side === "request" ? row.request_verification : row.response_verification;
  return value === "verified" || value === "empty" || value === "failed"
    ? value
    : "unknown";
}

function contentType(headers: Record<string, string>): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  return entry ? boundedUtf8(entry[1], 512) : undefined;
}
