import type { ExchangeMediaDescriptor } from "./db/models";

export type WorkbenchRawInspectorSide = "request" | "response";

export const WORKBENCH_RAW_DISPLAY_LIMIT_BYTES = 8 * 1024 * 1024;
export const WORKBENCH_RAW_SCAN_LIMIT_BYTES = 128 * 1024 * 1024;
export const WORKBENCH_RAW_MEDIA_LIMIT = 256;

const SAFE_IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
]);

export interface WorkbenchRawInspectorMedia extends ExchangeMediaDescriptor {
  viewable: boolean;
}

export interface WorkbenchRawInspectorMetadata {
  exchangeId: string;
  side: WorkbenchRawInspectorSide;
  candidateCount: 1;
  processedCount: 1;
  limited: boolean;
  indexVerification: "current" | "legacy";
  routing: {
    targetId: string;
    targetName: string;
    method: string;
    path: string;
    /** 真实发往的上游完整 URL（含协议路径）；旧记录或异常记录可缺省。 */
    upstreamUrl?: string;
  };
  model?: string;
  durationMs: number;
  /** 请求侧注入标记：routing.clientCredentialId 存在即网关已替换客户端凭据。 */
  credentialInjected?: boolean;
  /** 注入凭据指纹（前4+****+后4，来自凭据元数据；元数据不可读时缺省）。 */
  credentialFingerprint?: string;
  headers: {
    items: Record<string, string>;
    candidateCount: number;
    processedCount: number;
    limited: boolean;
  };
  body: {
    sizeBytes: number;
    sha256: string;
    storage: "none" | "inline" | "compressed-inline" | "external-blob";
    availability: "available" | "empty" | "unavailable" | "integrity_failed";
    verification: "verified" | "empty" | "failed" | "unknown";
    contentType?: string;
    isStreaming: boolean;
    rawScanAllowed: boolean;
    displayLimitBytes: number;
    rawScanLimitBytes: number;
  };
  http?: {
    status: number;
    statusText: string;
  };
  media: {
    items: WorkbenchRawInspectorMedia[];
    candidateCount: number;
    processedCount: number;
    limited: boolean;
  };
}

export type WorkbenchRawInspectorBodyEvent =
  | { type: "chunk"; value: string }
  | {
      type: "complete";
      rawProcessedBytes: number;
      displayBytes: number;
      candidateCount: number;
      processedCount: number;
      limited: false;
      diagnosticCodes: string[];
    }
  | {
      type: "limit";
      code: "display_bytes_exceeded";
      maxDisplayBytes: number;
      processedDisplayBytes: number;
      rawProcessedBytes: number;
      candidateCount: number;
      processedCount: number;
      limited: true;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

const WORKBENCH_MEDIA_MARKER = /^__DEEPAA_MEDIA_(\d{1,3})_([a-f0-9]{64})__$/u;

export function workbenchMediaMarker(ordinal: number, sha256: string): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= WORKBENCH_RAW_MEDIA_LIMIT) {
    throw new RangeError("媒体 ordinal 无效。");
  }
  if (!/^[a-f0-9]{64}$/iu.test(sha256)) {
    throw new TypeError("媒体 SHA-256 无效。");
  }
  return `__DEEPAA_MEDIA_${ordinal}_${sha256.toLowerCase()}__`;
}

export function parseWorkbenchMediaMarker(
  value: string,
): { ordinal: number; sha256: string } | undefined {
  const matched = WORKBENCH_MEDIA_MARKER.exec(value);
  if (!matched) return undefined;
  const ordinal = Number(matched[1]);
  return Number.isSafeInteger(ordinal) && ordinal < WORKBENCH_RAW_MEDIA_LIMIT
    ? { ordinal, sha256: matched[2]! }
    : undefined;
}

export function isWorkbenchInspectorViewableImage(mediaType: string): boolean {
  return SAFE_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
}
