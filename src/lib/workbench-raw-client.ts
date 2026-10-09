import { parseSSEStream, type ParsedSSEStream } from "../sse";
import {
  parseWorkbenchMediaMarker,
  WORKBENCH_RAW_DISPLAY_LIMIT_BYTES,
  WORKBENCH_RAW_MEDIA_LIMIT,
  WORKBENCH_RAW_SCAN_LIMIT_BYTES,
  type WorkbenchRawInspectorBodyEvent,
  type WorkbenchRawInspectorMedia,
  type WorkbenchRawInspectorMetadata,
  type WorkbenchRawInspectorSide,
} from "./workbench-raw-inspector-types";

const NDJSON_LINE_LIMIT_BYTES = 512 * 1024;
const NDJSON_STREAM_LIMIT_BYTES = 64 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
/**
 * 内联 Base64 Data URL（含 payload）。投影层正常情况下会把媒体替换成
 * __DEEPAA_MEDIA_n_sha__ 标记；一旦漏网，正文里就会出现几十 KB 到几 MB 的
 * base64 文本。这里就地脱敏，而不是抛错 —— 抛错会让整个正文不可读（用户反馈
 * 「请求正文读取失败：结构化正文非法包含 Base64 Data URL」）。
 */
const INLINE_DATA_URL = /data:[^;,\s]{1,128};base64,[A-Za-z0-9+/=]{8,}/giu;
const INLINE_DATA_URL_MARKER = "【内联媒体已省略】";
const MEDIA_MARKER_GLOBAL = /__DEEPAA_MEDIA_(\d{1,3})_([a-f0-9]{64})__/giu;
const MEDIA_MARKER_SCAN_MAX_DEPTH = 32;
const MEDIA_MARKER_SCAN_MAX_NODES = 4_096;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type WorkbenchRawBodyContent =
  | { kind: "json"; value: unknown; text: string }
  | ({ kind: "sse"; text: string } & ParsedSSEStream)
  | { kind: "text"; text: string; parseError?: string }
  | { kind: "empty"; text: "" };

export type WorkbenchRawMediaTextSegment =
  | { kind: "text"; value: string }
  | { kind: "media"; ordinal: number; sha256: string };

export type WorkbenchRawBodyLoadResult =
  | {
      status: "ready";
      body: WorkbenchRawBodyContent;
      rawProcessedBytes: number;
      displayBytes: number;
      candidateCount: number;
      processedCount: number;
      diagnosticCodes: string[];
    }
  | {
      status: "display_limited";
      body?: undefined;
      maxDisplayBytes: number;
      processedDisplayBytes: number;
      rawProcessedBytes: number;
      candidateCount: number;
      processedCount: number;
    }
  | {
      status: "raw_limited";
      body?: undefined;
      sizeBytes: number;
      maxRawBytes: number;
    };

export async function fetchWorkbenchRawInspectorMetadata(options: {
  exchangeId: string;
  side: WorkbenchRawInspectorSide;
  signal: AbortSignal;
  fetcher?: Fetcher;
}): Promise<WorkbenchRawInspectorMetadata> {
  throwIfAborted(options.signal);
  const response = await (options.fetcher ?? fetch)(
    `/api/exchanges/${encodeURIComponent(options.exchangeId)}/inspector/${options.side}`,
    { cache: "no-store", signal: options.signal },
  );
  if (!response.ok) throw await responseError(response);
  const parsed = parseInspectorMetadata(
    await response.json(),
    options.exchangeId,
    options.side,
  );
  if (!parsed) throw new Error("Inspector 元数据响应格式无效。");
  return parsed;
}

export async function loadWorkbenchRawBody(options: {
  exchangeId: string;
  side: WorkbenchRawInspectorSide;
  metadata: WorkbenchRawInspectorMetadata;
  signal: AbortSignal;
  fetcher?: Fetcher;
}): Promise<WorkbenchRawBodyLoadResult> {
  throwIfAborted(options.signal);
  if (!options.metadata.body.rawScanAllowed) {
    return {
      status: "raw_limited",
      sizeBytes: options.metadata.body.sizeBytes,
      maxRawBytes: options.metadata.body.rawScanLimitBytes,
    };
  }
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `/api/exchanges/${encodeURIComponent(options.exchangeId)}/inspector/${options.side}/body`,
    { cache: "no-store", signal: options.signal },
  );
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("结构化正文响应缺少流。 ");
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/x-ndjson")) {
    await response.body.cancel();
    throw new Error("结构化正文响应类型无效。");
  }
  return readBodyEvents(response.body, options.metadata, options.signal);
}

export function parseWorkbenchRawBody(
  text: string,
  metadata: WorkbenchRawInspectorMetadata,
): WorkbenchRawBodyContent {
  if (!text) return { kind: "empty", text: "" };
  const displayText = redactInlineDataUrls(text);
  if (metadata.body.isStreaming) {
    return { kind: "sse", text: displayText, ...parseSSEStream(displayText) };
  }
  try {
    return { kind: "json", value: JSON.parse(displayText), text: displayText };
  } catch (error) {
    return {
      kind: "text",
      text: displayText,
      parseError: metadata.body.contentType?.toLowerCase().includes("json")
        ? errorMessage(error, "JSON 解析失败")
        : undefined,
    };
  }
}

/** 把漏网的内联 base64 媒体折叠成定长标记：DOM 里永不出现大段 base64。 */
export function redactInlineDataUrls(text: string): string {
  if (!text.includes(";base64,")) return text;
  return text.replace(INLINE_DATA_URL, INLINE_DATA_URL_MARKER);
}

export function formatWorkbenchRawBodyForCopy(
  body: WorkbenchRawBodyContent,
  media: WorkbenchRawInspectorMedia[],
): string {
  const text = body.kind === "json"
    ? JSON.stringify(body.value, null, 2)
    : body.text;
  return replaceMediaMarkers(text, media);
}

/**
 * 媒体标记可能与普通正文混在同一个字符串中。这里仅拆分服务端生成的完整标记，
 * 不把不完整或伪造文本提升为可点击媒体。
 */
export function splitWorkbenchRawMediaText(
  value: string,
): WorkbenchRawMediaTextSegment[] {
  const segments: WorkbenchRawMediaTextSegment[] = [];
  let offset = 0;
  for (const matched of value.matchAll(MEDIA_MARKER_GLOBAL)) {
    const marker = matched[0];
    const index = matched.index;
    const parsed = parseWorkbenchMediaMarker(marker);
    if (!parsed || index === undefined) continue;
    if (index > offset) {
      segments.push({ kind: "text", value: value.slice(offset, index) });
    }
    segments.push({ kind: "media", ...parsed });
    offset = index + marker.length;
  }
  if (offset < value.length || segments.length === 0) {
    segments.push({ kind: "text", value: value.slice(offset) });
  }
  return segments;
}

/**
 * 判断 SSE data 是否含服务端媒体标记。扫描预算只影响默认展开状态；
 * 用户手动展开后仍会由正文渲染器按原位置解析全部可见字段。
 */
export function valueContainsWorkbenchMediaMarker(value: unknown): boolean {
  let remainingNodes = MEDIA_MARKER_SCAN_MAX_NODES;
  const visited = new WeakSet<object>();

  function visit(current: unknown, depth: number): boolean {
    if (remainingNodes <= 0 || depth > MEDIA_MARKER_SCAN_MAX_DEPTH) return false;
    remainingNodes--;

    if (typeof current === "string") {
      if (!current.includes("__DEEPAA_MEDIA_")) return false;
      if (parseWorkbenchMediaMarker(current)) return true;
      return splitWorkbenchRawMediaText(current).some(segment => segment.kind === "media");
    }
    if (!current || typeof current !== "object" || visited.has(current)) return false;
    visited.add(current);

    const children = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    return children.some(child => visit(child, depth + 1));
  }

  return visit(value, 0);
}

/** ordinal 只能定位候选，只有摘要也一致时才允许生成媒体查看入口。 */
export function findWorkbenchRawMediaDescriptor(
  marker: { ordinal: number; sha256: string },
  media: WorkbenchRawInspectorMedia[],
): WorkbenchRawInspectorMedia | undefined {
  return media.find(item =>
    item.ordinal === marker.ordinal
    && item.sha256.toLowerCase() === marker.sha256.toLowerCase()
  );
}

async function readBodyEvents(
  stream: ReadableStream<Uint8Array>,
  metadata: WorkbenchRawInspectorMetadata,
  signal: AbortSignal,
): Promise<WorkbenchRawBodyLoadResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let lineBuffer = "";
  let networkBytes = 0;
  let displayBytes = 0;
  let completed: Extract<WorkbenchRawInspectorBodyEvent, { type: "complete" }> | undefined;
  const cancelOnAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      networkBytes += next.value.byteLength;
      if (networkBytes > NDJSON_STREAM_LIMIT_BYTES) {
        throw new Error("结构化正文响应超过传输预算。");
      }
      lineBuffer += decoder.decode(next.value, { stream: true });
      if (utf8Bytes(lineBuffer) > NDJSON_LINE_LIMIT_BYTES && !lineBuffer.includes("\n")) {
        throw new Error("结构化正文事件超过单行预算。");
      }
      let newline: number;
      while ((newline = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        const event = parseBodyEvent(line);
        if (event.type === "chunk") {
          if (completed) throw new Error("结构化正文完成后仍返回内容。");
          displayBytes += utf8Bytes(event.value);
          if (displayBytes > metadata.body.displayLimitBytes) {
            throw new Error("结构化正文超过客户端显示预算。");
          }
          chunks.push(event.value);
          continue;
        }
        if (event.type === "limit") {
          await reader.cancel("display-limited").catch(() => undefined);
          return {
            status: "display_limited",
            maxDisplayBytes: event.maxDisplayBytes,
            processedDisplayBytes: event.processedDisplayBytes,
            rawProcessedBytes: event.rawProcessedBytes,
            candidateCount: event.candidateCount,
            processedCount: event.processedCount,
          };
        }
        if (event.type === "error") {
          throw new Error(`${event.code}: ${event.message}`);
        }
        if (completed) throw new Error("结构化正文包含重复完成事件。");
        completed = event;
      }
    }
    lineBuffer += decoder.decode();
    if (lineBuffer.trim()) throw new Error("结构化正文存在不完整 NDJSON 事件。");
    if (!completed) throw new Error("结构化正文缺少完成事件。");
    const text = chunks.join("");
    // 计数校验必须用服务端实际发来的字节数（脱敏会改变长度，故放在脱敏之前）。
    const actualDisplayBytes = utf8Bytes(text);
    if (
      completed.displayBytes !== actualDisplayBytes
      || completed.displayBytes !== displayBytes
      || completed.rawProcessedBytes !== metadata.body.sizeBytes
      || completed.processedCount > completed.candidateCount
    ) {
      throw new Error("结构化正文完成计数与客户端读取不一致。");
    }
    return {
      status: "ready",
      body: parseWorkbenchRawBody(text, metadata),
      rawProcessedBytes: completed.rawProcessedBytes,
      displayBytes: completed.displayBytes,
      candidateCount: completed.candidateCount,
      processedCount: completed.processedCount,
      diagnosticCodes: completed.diagnosticCodes.slice(0, 32),
    };
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

function parseBodyEvent(line: string): WorkbenchRawInspectorBodyEvent {
  if (utf8Bytes(line) > NDJSON_LINE_LIMIT_BYTES) {
    throw new Error("结构化正文事件超过单行预算。");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("结构化正文事件不是有效 JSON。");
  }
  if (!value || typeof value !== "object") {
    throw new Error("结构化正文事件结构无效。");
  }
  const event = value as Record<string, unknown>;
  if (event.type === "chunk" && typeof event.value === "string") {
    return { type: "chunk", value: event.value };
  }
  if (
    event.type === "complete"
    && nonNegativeInteger(event.rawProcessedBytes)
    && nonNegativeInteger(event.displayBytes)
    && nonNegativeInteger(event.candidateCount)
    && nonNegativeInteger(event.processedCount)
    && event.limited === false
    && Array.isArray(event.diagnosticCodes)
  ) {
    return {
      type: "complete",
      rawProcessedBytes: event.rawProcessedBytes,
      displayBytes: event.displayBytes,
      candidateCount: event.candidateCount,
      processedCount: event.processedCount,
      limited: false,
      diagnosticCodes: event.diagnosticCodes
        .filter((item): item is string => typeof item === "string")
        .slice(0, 32),
    };
  }
  if (
    event.type === "limit"
    && event.code === "display_bytes_exceeded"
    && nonNegativeInteger(event.maxDisplayBytes)
    && nonNegativeInteger(event.processedDisplayBytes)
    && nonNegativeInteger(event.rawProcessedBytes)
    && nonNegativeInteger(event.candidateCount)
    && nonNegativeInteger(event.processedCount)
    && event.limited === true
  ) {
    return {
      type: "limit",
      code: "display_bytes_exceeded",
      maxDisplayBytes: event.maxDisplayBytes,
      processedDisplayBytes: event.processedDisplayBytes,
      rawProcessedBytes: event.rawProcessedBytes,
      candidateCount: event.candidateCount,
      processedCount: event.processedCount,
      limited: true,
    };
  }
  if (event.type === "error" && typeof event.code === "string" && typeof event.message === "string") {
    return { type: "error", code: event.code, message: event.message };
  }
  throw new Error("结构化正文事件结构无效。");
}

function parseInspectorMetadata(
  value: unknown,
  exchangeId: string,
  side: WorkbenchRawInspectorSide,
): WorkbenchRawInspectorMetadata | undefined {
  const record = asRecord(value);
  const routing = asRecord(record?.routing);
  const headers = asRecord(record?.headers);
  const headerItems = asRecord(headers?.items);
  const body = asRecord(record?.body);
  const media = asRecord(record?.media);
  if (
    !record
    || record.exchangeId !== exchangeId
    || record.side !== side
    || record.candidateCount !== 1
    || record.processedCount !== 1
    || typeof record.limited !== "boolean"
    || (record.indexVerification !== "current" && record.indexVerification !== "legacy")
    || !routing
    || !safeString(routing.targetId, 1_024)
    || !safeString(routing.targetName, 2_048)
    || !safeString(routing.method, 32)
    || !safeString(routing.path, 2_048)
    || (routing.upstreamUrl !== undefined && !safeString(routing.upstreamUrl, 2_048))
    || (record.credentialInjected !== undefined && typeof record.credentialInjected !== "boolean")
    || (record.credentialFingerprint !== undefined && !safeString(record.credentialFingerprint, 64))
    || !nonNegativeInteger(record.durationMs)
    || !headers
    || !headerItems
    || !boundedCount(headers.candidateCount)
    || !boundedCount(headers.processedCount)
    || typeof headers.limited !== "boolean"
    || !body
    || !nonNegativeInteger(body.sizeBytes)
    || !validSha256(body.sha256)
    || !["none", "inline", "compressed-inline", "external-blob"].includes(String(body.storage))
    || !["available", "empty", "unavailable", "integrity_failed"].includes(String(body.availability))
    || !["verified", "empty", "failed", "unknown"].includes(String(body.verification))
    || (body.contentType !== undefined && !safeString(body.contentType, 512))
    || typeof body.isStreaming !== "boolean"
    || typeof body.rawScanAllowed !== "boolean"
    || body.displayLimitBytes !== WORKBENCH_RAW_DISPLAY_LIMIT_BYTES
    || body.rawScanLimitBytes !== WORKBENCH_RAW_SCAN_LIMIT_BYTES
    || !media
    || !Array.isArray(media.items)
    || media.items.length > WORKBENCH_RAW_MEDIA_LIMIT
    || !boundedCount(media.candidateCount)
    || !boundedCount(media.processedCount)
    || typeof media.limited !== "boolean"
  ) return undefined;
  const projectedHeaders: Record<string, string> = {};
  const headerEntries = Object.entries(headerItems);
  if (
    headerEntries.length > 512
    || headers.processedCount !== headerEntries.length
    || headers.processedCount > headers.candidateCount
  ) return undefined;
  for (const [name, headerValue] of headerEntries) {
    if (!safeString(name, 512) || !safeString(headerValue, 64 * 1024)) return undefined;
    projectedHeaders[name] = headerValue;
  }
  const projectedMedia: WorkbenchRawInspectorMedia[] = [];
  for (const item of media.items) {
    const descriptor = parseMediaDescriptor(item, side);
    if (!descriptor) return undefined;
    projectedMedia.push(descriptor);
  }
  if (
    media.processedCount < projectedMedia.length
    || media.processedCount > media.candidateCount
  ) return undefined;
  const metadata: WorkbenchRawInspectorMetadata = {
    exchangeId,
    side,
    candidateCount: 1,
    processedCount: 1,
    limited: record.limited,
    indexVerification: record.indexVerification,
    routing: {
      targetId: routing.targetId,
      targetName: routing.targetName,
      method: routing.method,
      path: routing.path,
      ...(typeof routing.upstreamUrl === "string" ? {upstreamUrl: routing.upstreamUrl} : {}),
    },
    ...(record.credentialInjected === true ? {credentialInjected: true} : {}),
    ...(typeof record.credentialFingerprint === "string" ? {credentialFingerprint: record.credentialFingerprint} : {}),
    model: safeString(record.model, 1_024) ? record.model : undefined,
    durationMs: record.durationMs,
    headers: {
      items: projectedHeaders,
      candidateCount: headers.candidateCount,
      processedCount: headers.processedCount,
      limited: headers.limited,
    },
    body: {
      sizeBytes: body.sizeBytes,
      sha256: body.sha256.toLowerCase(),
      storage: body.storage as WorkbenchRawInspectorMetadata["body"]["storage"],
      availability: body.availability as WorkbenchRawInspectorMetadata["body"]["availability"],
      verification: body.verification as WorkbenchRawInspectorMetadata["body"]["verification"],
      contentType: body.contentType as string | undefined,
      isStreaming: body.isStreaming,
      rawScanAllowed: body.rawScanAllowed,
      displayLimitBytes: WORKBENCH_RAW_DISPLAY_LIMIT_BYTES,
      rawScanLimitBytes: WORKBENCH_RAW_SCAN_LIMIT_BYTES,
    },
    media: {
      items: projectedMedia,
      candidateCount: media.candidateCount,
      processedCount: media.processedCount,
      limited: media.limited,
    },
  };
  if (side === "response") {
    const http = asRecord(record.http);
    if (!http || !nonNegativeInteger(http.status) || !safeString(http.statusText, 256)) {
      return undefined;
    }
    metadata.http = { status: http.status, statusText: http.statusText };
  }
  return metadata;
}

function parseMediaDescriptor(
  value: unknown,
  side: WorkbenchRawInspectorSide,
): WorkbenchRawInspectorMedia | undefined {
  const item = asRecord(value);
  if (
    !item
    || item.bodySide !== side
    || !nonNegativeInteger(item.ordinal)
    || item.ordinal >= WORKBENCH_RAW_MEDIA_LIMIT
    || !safeString(item.jsonPath, 512)
    || !safeString(item.mediaType, 128)
    || !nonNegativeInteger(item.encodedBytes)
    || !nonNegativeInteger(item.decodedBytes)
    || !validSha256(item.sha256)
    || !["inline", "compressed-inline", "external-blob"].includes(String(item.sourceStorage))
    || typeof item.viewable !== "boolean"
  ) return undefined;
  return {
    bodySide: side,
    ordinal: item.ordinal,
    jsonPath: item.jsonPath,
    mediaType: item.mediaType,
    encodedBytes: item.encodedBytes,
    decodedBytes: item.decodedBytes,
    sha256: item.sha256.toLowerCase(),
    sourceStorage: item.sourceStorage as WorkbenchRawInspectorMedia["sourceStorage"],
    viewable: item.viewable,
  };
}

function replaceMediaMarkers(
  value: string,
  media: WorkbenchRawInspectorMedia[],
): string {
  return value.replace(MEDIA_MARKER_GLOBAL, (marker, ordinalValue: string, sha256: string) => {
    const parsed = parseWorkbenchMediaMarker(marker);
    if (!parsed) return "[媒体占位无效]";
    const descriptor = media.find(item =>
      item.ordinal === Number(ordinalValue)
      && item.sha256.toLowerCase() === sha256.toLowerCase()
    );
    if (!descriptor) return `[媒体 #${parsed.ordinal + 1} · 不可查看]`;
    const label = descriptor.viewable ? "图片" : "媒体";
    return `[${label} #${descriptor.ordinal + 1} · ${descriptor.mediaType} · ${formatSize(descriptor.decodedBytes)}]`;
  });
}

async function responseError(response: Response): Promise<Error> {
  const text = (await response.text()).slice(0, 64 * 1024);
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (typeof parsed.error?.message === "string") {
      return new Error(`${String(parsed.error.code ?? `HTTP ${response.status}`)}: ${parsed.error.message}`);
    }
  } catch {
    // 非 JSON 错误响应只返回状态码，避免把任意正文带入 UI。
  }
  return new Error(`HTTP ${response.status}`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("请求已取消。", "AbortError");
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedCount(value: unknown): value is number {
  return nonNegativeInteger(value) && value <= Number.MAX_SAFE_INTEGER;
}

function safeString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8Bytes(value) <= maxBytes;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}
