import { createHash } from "node:crypto";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { Readable } from "node:stream";
import { loadExchangeProjectionDetail } from "./db/exchange-projection-queries";
import { acquireExplicitRawLease } from "./explicit-raw-lease";
import {
  iterateConversationBodyEvents,
  type ConversationBodyEvent,
} from "./export-conversation";
import {
  openRawBodyStream,
  RawBodyStreamError,
  type RawBodyStreamResult,
} from "./harness/raw-body-stream";
import { locateRawExchange, RawLocatorError } from "./harness/raw-locator";
import type { RawCapturedExchange } from "./harness/types";
import {
  classifyRawReadGate,
  rawReadGateMessage,
} from "./ingestion/raw-read-gate";
import type { ProjectionBodySide } from "./ingestion/projection-types";
import { RawStreamGatewayError } from "./raw-stream-gateway";
import { isWorkbenchInspectorViewableImage } from "./workbench-raw-inspector-types";

interface MediaDescriptorRow {
  exchange_id: string;
  body_side: ProjectionBodySide;
  ordinal: number;
  json_path: string;
  media_type: string;
  encoded_bytes: number;
  decoded_bytes: number;
  sha256: string;
  raw_body_sha256: string;
  source_storage: "inline" | "compressed-inline" | "external-blob";
}

export class RawMediaGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RawMediaGatewayError";
  }
}

/**
 * 媒体读取只能由 SQLite 的唯一描述符定位一张图片，再读取对应 Exchange 的单侧 Raw。
 * API 不接受 jsonPath、文件路径或 hash 作为客户端定位条件。
 */
export async function openRawMediaResponse(options: {
  db: DeepaaDatabase;
  dataDir: string;
  exchangeId: string;
  side: ProjectionBodySide;
  ordinal: number;
}): Promise<Response> {
  const descriptor = loadMediaDescriptor(
    options.db,
    options.exchangeId,
    options.side,
    options.ordinal,
  );
  if (!descriptor) {
    throw new RawMediaGatewayError(
      "raw_media_not_found",
      404,
      "图片媒体描述符不存在。",
    );
  }
  // raw 读取门禁：已清理/超窗的 Exchange 在读取任何 raw 字节前显式拒绝（410）。
  const gate = classifyRawReadGate(options.db, options.dataDir, options.exchangeId);
  if (gate && gate.state !== "active") {
    throw new RawMediaGatewayError(
      gate.state === "purged" ? "raw_purged" : "raw_expired",
      410,
      rawReadGateMessage(gate),
    );
  }
  if (!isWorkbenchInspectorViewableImage(descriptor.media_type)) {
    throw new RawMediaGatewayError(
      "raw_media_type_not_supported",
      415,
      "该媒体类型不支持直接查看。",
    );
  }
  const lease = acquireExplicitRawLease();
  if (!lease) {
    throw new RawMediaGatewayError(
      "raw_stream_busy",
      429,
      "完整 Raw 流并发已达上限，请稍后重试。",
    );
  }

  try {
    const located = await locateRawExchange(
      options.db,
      options.dataDir,
      options.exchangeId,
    );
    if (!located) {
      throw new RawMediaGatewayError("raw_not_found", 404, "Exchange 不存在。");
    }
    const source = located.exchange[options.side];
    assertDescriptorSource(descriptor, source);
    const opened = await openRawBodyStream(options.dataDir, source, {
      purpose: "raw",
      label: options.side,
    });
    const projection = loadExchangeProjectionDetail(options.db, options.exchangeId);
    const events = iterateConversationBodyEvents({
      stream: opened.stream,
      format: options.side === "response" && located.exchange.response.isStreaming
        ? "sse"
        : "json",
      exchangeId: options.exchangeId,
      side: options.side,
      rawBodySha256: source.bodySha256,
      sourceStorage: rawSourceStorage(source),
      protocol: projection?.preview.protocol ?? "unknown",
      previewItems: projection?.preview.items,
      decodedMediaOrdinal: options.ordinal,
    });
    return new Response(
      bridgeMediaBody(events, opened, descriptor, lease.release),
      {
        status: 200,
        headers: mediaHeaders(descriptor),
      },
    );
  } catch (error) {
    lease.release();
    if (error instanceof RawMediaGatewayError) throw error;
    if (error instanceof RawLocatorError) {
      throw new RawMediaGatewayError(
        "unsafe_raw_reference",
        409,
        "Raw 索引或原始记录无法安全定位。",
      );
    }
    if (error instanceof RawBodyStreamError) {
      throw mediaErrorFromBody(error);
    }
    throw new RawMediaGatewayError(
      "raw_media_unavailable",
      503,
      "图片媒体暂时不可用。",
    );
  }
}

export function rawMediaGatewayErrorResponse(error: unknown): Response {
  const normalized = error instanceof RawMediaGatewayError
    ? error
    : error instanceof RawStreamGatewayError
      ? new RawMediaGatewayError(error.code, error.status, error.message)
    : new RawMediaGatewayError(
        "raw_media_failed",
        500,
        "图片媒体处理失败。",
      );
  const headers = baseHeaders();
  if (normalized.status === 429) headers.set("Retry-After", "1");
  return Response.json({
    error: { code: normalized.code, message: normalized.message },
  }, { status: normalized.status, headers });
}

function loadMediaDescriptor(
  db: DeepaaDatabase,
  exchangeId: string,
  side: ProjectionBodySide,
  ordinal: number,
): MediaDescriptorRow | undefined {
  return db.prepare(
    `SELECT exchange_id, body_side, ordinal, json_path, media_type,
      encoded_bytes, decoded_bytes, sha256, raw_body_sha256, source_storage
     FROM exchange_media_descriptors
     WHERE exchange_id = ? AND body_side = ? AND ordinal = ?
     LIMIT 1`,
  ).get(exchangeId, side, ordinal) as MediaDescriptorRow | undefined;
}

function assertDescriptorSource(
  descriptor: MediaDescriptorRow,
  source: RawCapturedExchange["request"] | RawCapturedExchange["response"],
): void {
  if (
    descriptor.raw_body_sha256.toLowerCase() !== source.bodySha256.toLowerCase()
    || descriptor.source_storage !== rawSourceStorage(source)
  ) {
    throw new RawMediaGatewayError(
      "raw_media_source_mismatch",
      409,
      "图片描述符与当前 Raw 正文身份不一致。",
    );
  }
}

function bridgeMediaBody(
  events: AsyncIterable<ConversationBodyEvent>,
  opened: RawBodyStreamResult,
  descriptor: MediaDescriptorRow,
  release: () => void,
): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  const hash = createHash("sha256");
  let decodedBytes = 0;
  let descriptorSeen = false;
  let released = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    release();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            const verification = await opened.verification;
            if (verification.status !== "verified") {
              throw new RawMediaGatewayError(
                "raw_body_integrity_failed",
                409,
                "Raw 正文未通过完整性校验。",
              );
            }
            if (!descriptorSeen || decodedBytes !== descriptor.decoded_bytes) {
              throw mediaIntegrityError();
            }
            const digest = hash.digest("hex");
            if (digest !== descriptor.sha256.toLowerCase()) {
              throw mediaIntegrityError();
            }
            finish();
            controller.close();
            return;
          }
          const event = next.value;
          if (event.type === "media_descriptor" && event.ordinal === descriptor.ordinal) {
            assertMediaDescriptorEvent(event, descriptor);
            descriptorSeen = true;
            continue;
          }
          if (event.type !== "media_bytes" || event.ordinal !== descriptor.ordinal) {
            continue;
          }
          const chunk = Buffer.from(event.value);
          decodedBytes += chunk.length;
          if (
            event.mediaType !== descriptor.media_type
            || decodedBytes > descriptor.decoded_bytes
          ) {
            throw mediaIntegrityError();
          }
          hash.update(chunk);
          controller.enqueue(chunk);
          return;
        }
      } catch (error) {
        destroyReadable(opened.stream, error);
        await iterator.return?.().catch(() => undefined);
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      destroyReadable(opened.stream, reason);
      await iterator.return?.().catch(() => undefined);
      finish();
    },
  });
}

function assertMediaDescriptorEvent(
  event: Extract<ConversationBodyEvent, { type: "media_descriptor" }>,
  descriptor: MediaDescriptorRow,
): void {
  if (
    event.side !== descriptor.body_side
    || event.jsonPath !== descriptor.json_path
    || event.mediaType !== descriptor.media_type
    || event.encodedBytes !== descriptor.encoded_bytes
    || event.decodedBytes !== descriptor.decoded_bytes
    || event.sha256.toLowerCase() !== descriptor.sha256.toLowerCase()
    || event.sourceStorage !== descriptor.source_storage
  ) {
    throw mediaIntegrityError();
  }
}

function mediaHeaders(descriptor: MediaDescriptorRow): Headers {
  const headers = baseHeaders();
  headers.set("Content-Type", descriptor.media_type);
  headers.set("Content-Length", String(descriptor.decoded_bytes));
  headers.set("Content-Disposition", "inline");
  headers.set("X-DeepAA-Media-SHA256", descriptor.sha256);
  return headers;
}

function baseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}

function rawSourceStorage(
  source: RawCapturedExchange["request"] | RawCapturedExchange["response"],
): "inline" | "compressed-inline" | "external-blob" {
  return source.rawBodyRef?.storage ?? "inline";
}

function mediaIntegrityError(): RawMediaGatewayError {
  return new RawMediaGatewayError(
    "raw_media_integrity_failed",
    409,
    "图片媒体未通过完整性校验。",
  );
}

function mediaErrorFromBody(error: RawBodyStreamError): RawMediaGatewayError {
  return new RawMediaGatewayError(
    error.code,
    error.code === "raw_body_unavailable" ? 404 : 409,
    error.code === "raw_body_integrity_failed"
      ? "Raw 正文未通过完整性校验。"
      : error.code === "unsafe_raw_reference"
        ? "Raw 正文引用不安全。"
        : "Raw 正文不可用。",
  );
}

function destroyReadable(stream: Readable, reason: unknown): void {
  stream.destroy(reason instanceof Error ? reason : undefined);
}
