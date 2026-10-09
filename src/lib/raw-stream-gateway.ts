import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { Readable } from "node:stream";
import {
  loadExchangeProjectionDetail,
  type ExchangeProjectionDetail,
} from "./db/exchange-projection-queries";
import {
  openRawBodyStream,
  RawBodyStreamError,
  type RawBodyStreamResult,
} from "./harness/raw-body-stream";
import {
  locateRawExchange,
  RawLocatorError,
  type RawIndexVerification,
} from "./harness/raw-locator";
import {
  classifyRawReadGate,
  rawReadGateMessage,
} from "./ingestion/raw-read-gate";
import {
  acquireExplicitRawLease,
  getExplicitRawLeaseMetrics,
  resetExplicitRawLeasesForTests,
} from "./explicit-raw-lease";
import {
  isLoopbackHostname,
  isSameLocalEntrypoint,
} from "./local-endpoints";

export type RawBodySide = "request" | "response";
export type RawDisposition = "inline" | "attachment";

export class RawStreamGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RawStreamGatewayError";
  }
}

export interface RawStreamGatewayMetrics {
  active: number;
  completed: number;
  cancelled: number;
  interrupted: number;
  busy: number;
}

const metrics: RawStreamGatewayMetrics = {
  active: 0,
  completed: 0,
  cancelled: 0,
  interrupted: 0,
  busy: 0,
};

export function getRawStreamGatewayMetrics(): RawStreamGatewayMetrics {
  return {
    ...metrics,
    active: getExplicitRawLeaseMetrics().active,
  };
}

export function resetRawStreamGatewayForTests(): void {
  resetExplicitRawLeasesForTests();
  metrics.active = 0;
  metrics.completed = 0;
  metrics.cancelled = 0;
  metrics.interrupted = 0;
  metrics.busy = 0;
}

export function assertRawStreamRequest(request: Request): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw localOriginError();
  }
  if (!isLoopbackHostname(url.hostname)) throw localOriginError();
  const host = request.headers.get("host");
  if (host) {
    let hostUrl: URL;
    try {
      hostUrl = new URL(`${url.protocol}//${host}`);
    } catch {
      throw localOriginError();
    }
    if (!isLoopbackHostname(hostUrl.hostname) || !isSameLocalEntrypoint(hostUrl, url)) throw localOriginError();
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw localOriginError();
    }
    if (
      parsedOrigin.origin !== origin
      || parsedOrigin.protocol !== url.protocol
      || !isLoopbackHostname(parsedOrigin.hostname)
      || !isSameLocalEntrypoint(parsedOrigin, url)
    ) throw localOriginError();
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw localOriginError();
  }
}

export function assertNoRawRange(request: Request): void {
  if (request.headers.has("range")) {
    throw new RawStreamGatewayError(
      "raw_range_not_supported",
      416,
      "完整 Raw 流不支持 Range 请求。",
    );
  }
}

export function loadRawStreamMetadata(
  db: DeepaaDatabase,
  exchangeId: string,
): Record<string, unknown> | undefined {
  const detail = loadExchangeProjectionDetail(db, exchangeId);
  if (!detail) return undefined;
  return {
    exchangeId: detail.exchangeId,
    indexVerification: detail.indexVerification,
    previewState: detail.previewState,
    projectionVersion: detail.projectionVersion,
    jobStatus: detail.jobStatus,
    projectionCompleteness: detail.projectionCompleteness,
    request: rawSideMetadata(detail.request),
    response: rawSideMetadata(detail.response),
  };
}

export async function openRawStreamResponse(options: {
  db: DeepaaDatabase;
  dataDir: string;
  exchangeId: string;
  side: RawBodySide;
  disposition: RawDisposition;
}): Promise<Response> {
  const lease = acquireLease();
  if (!lease) {
    throw new RawStreamGatewayError(
      "raw_stream_busy",
      429,
      "完整 Raw 流并发已达上限，请稍后重试。",
    );
  }
  try {
    // raw 读取门禁：已清理/超窗的 Exchange 在读取任何 raw 字节前显式拒绝（410）。
    const gate = classifyRawReadGate(options.db, options.dataDir, options.exchangeId);
    if (gate && gate.state !== "active") {
      throw new RawStreamGatewayError(
        gate.state === "purged" ? "raw_purged" : "raw_expired",
        410,
        rawReadGateMessage(gate),
      );
    }
    const located = await locateRawExchange(
      options.db,
      options.dataDir,
      options.exchangeId,
    );
    if (!located) {
      lease.abandon();
      throw new RawStreamGatewayError("raw_not_found", 404, "Exchange 不存在。");
    }
    const source = located.exchange[options.side];
    const opened = await openRawBodyStream(options.dataDir, source, {
      purpose: "raw",
      label: options.side,
    });
    const detail = loadExchangeProjectionDetail(options.db, options.exchangeId);
    const body = bridgeRawBody(opened, lease);
    return new Response(body, {
      status: 200,
      headers: rawStreamHeaders({
        exchangeId: options.exchangeId,
        side: options.side,
        disposition: options.disposition,
        opened,
        indexVerification: located.indexVerification,
        lastVerification: lastVerification(detail, options.side),
      }),
    });
  } catch (error) {
    lease.abandon();
    if (error instanceof RawStreamGatewayError) throw error;
    if (error instanceof RawLocatorError) {
      throw new RawStreamGatewayError(
        "unsafe_raw_reference",
        409,
        "Raw 索引或原始记录无法安全定位。",
      );
    }
    if (error instanceof RawBodyStreamError) {
      throw gatewayErrorFromBody(error);
    }
    throw new RawStreamGatewayError(
      "raw_body_unavailable",
      503,
      "完整 Raw 正文暂时不可用。",
    );
  }
}

export function rawStreamGatewayErrorResponse(error: unknown): Response {
  const normalized = error instanceof RawStreamGatewayError
    ? error
    : new RawStreamGatewayError(
        "raw_stream_failed",
        500,
        "完整 Raw 流处理失败。",
      );
  const headers = errorHeaders();
  if (normalized.status === 429) headers.set("Retry-After", "1");
  return Response.json({
    error: { code: normalized.code, message: normalized.message },
  }, { status: normalized.status, headers });
}

function rawSideMetadata(body: ExchangeProjectionDetail["request"]): Record<string, unknown> {
  return {
    availability: body.availability,
    sizeBytes: body.sizeBytes,
    sha256: body.sha256,
    storage: body.storage,
    verification: body.verification,
    previewLimited: body.previewLimited,
  };
}

function rawStreamHeaders(options: {
  exchangeId: string;
  side: RawBodySide;
  disposition: RawDisposition;
  opened: RawBodyStreamResult;
  indexVerification: RawIndexVerification;
  lastVerification: string;
}): Headers {
  const headers = errorHeaders();
  // sandbox="" iframe 使用 opaque origin；inline 若保持 same-origin CORP，浏览器会拦截已通过服务端门禁的正文。
  if (options.disposition === "inline") {
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
  headers.set(
    "Content-Type",
    options.disposition === "inline"
      ? "text/plain; charset=utf-8"
      : "application/octet-stream",
  );
  headers.set(
    "Content-Disposition",
    options.disposition === "inline"
      ? "inline"
      : `attachment; filename="${safeFilename(options.exchangeId, options.side)}"`,
  );
  headers.set("X-DeepAA-Expected-Size", String(options.opened.expectedSizeBytes));
  headers.set("X-DeepAA-Expected-SHA256", options.opened.expectedSha256);
  headers.set("X-DeepAA-Last-Verification", options.lastVerification);
  headers.set("X-DeepAA-Index-Verification", options.indexVerification);
  return headers;
}

function errorHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}

function bridgeRawBody(
  opened: RawBodyStreamResult,
  lease: RawStreamLease,
): ReadableStream<Uint8Array> {
  const iterator = opened.stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (!next.done) {
          controller.enqueue(Buffer.from(next.value as Uint8Array));
          return;
        }
        const verification = await opened.verification;
        if (verification.status !== "verified") {
          throw new RawBodyStreamError(
            verification.status === "failed"
              ? verification.errorCode
              : "raw_body_integrity_failed",
            "Raw 正文流未完成完整性校验。",
          );
        }
        lease.finish("completed");
        controller.close();
      } catch (error) {
        destroyReadable(opened.stream, error);
        lease.finish("interrupted");
        controller.error(error);
      }
    },
    async cancel(reason) {
      destroyReadable(opened.stream, reason);
      await iterator.return?.().catch(() => undefined);
      lease.finish("cancelled");
    },
  });
}

interface RawStreamLease {
  finish: (outcome: "completed" | "cancelled" | "interrupted") => void;
  abandon: () => void;
}

function acquireLease(): RawStreamLease | undefined {
  const sharedLease = acquireExplicitRawLease();
  if (!sharedLease) {
    metrics.busy += 1;
    return undefined;
  }
  let released = false;
  const release = () => {
    if (released) return false;
    released = true;
    sharedLease.release();
    return true;
  };
  return {
    finish: outcome => {
      if (!release()) return;
      metrics[outcome] += 1;
    },
    abandon: () => {
      release();
    },
  };
}

function lastVerification(
  detail: ExchangeProjectionDetail | undefined,
  side: RawBodySide,
): string {
  if (!detail) return "unknown";
  return detail[side].verification;
}

function safeFilename(exchangeId: string, side: RawBodySide): string {
  const safeId = exchangeId.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 120) || "exchange";
  return `${safeId}-${side}.raw.txt`;
}

function gatewayErrorFromBody(error: RawBodyStreamError): RawStreamGatewayError {
  const status = error.code === "raw_body_unavailable" ? 404 : 409;
  const message = error.code === "raw_body_integrity_failed"
    ? "完整 Raw 正文未通过完整性校验。"
    : error.code === "unsafe_raw_reference"
      ? "Raw 正文引用不安全。"
      : "完整 Raw 正文不可用。";
  return new RawStreamGatewayError(error.code, status, message);
}

function localOriginError(): RawStreamGatewayError {
  return new RawStreamGatewayError(
    "raw_local_origin_required",
    403,
    "仅允许从当前本地页面或本机客户端访问完整 Raw。",
  );
}

function destroyReadable(stream: Readable, reason: unknown): void {
  stream.destroy(reason instanceof Error ? reason : undefined);
}
