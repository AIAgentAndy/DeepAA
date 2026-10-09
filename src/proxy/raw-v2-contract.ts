import type { WireApi } from "@/types";

export type ProxyCaptureFormat = "openai" | "anthropic";

/** 故障转移单次上游尝试的结局（按尝试顺序排列，含最终服务的尝试）。 */
export interface CaptureFailoverAttempt {
  targetId: string;
  model: string;
  outcome: "error" | "served";
  /** 失败原因简述：如 "HTTP 502"、"ECONNRESET"、"UPSTREAM_RESPONSE_HEADER_TIMEOUT"。 */
  detail?: string;
}

/**
 * 模型故障转移元数据：本次请求发生过「跳过主模型/恢复探测」时随捕获落盘，
 * 供派生投影与会话追踪/交互内容展示「原模型 → 实际模型」。
 * 未发生故障转移的请求不携带该字段。
 */
export interface CaptureFailover {
  /** consecutive_failures=连续失败转移；compaction=压缩时机切回探测；probe=时间兜底探测。 */
  trigger: "consecutive_failures" | "compaction" | "probe";
  fromTargetId: string;
  /** 主模型供应商显示名（旧数据缺省，展示回退路由 ID）。 */
  fromTargetName?: string;
  fromModel: string;
  toTargetId: string;
  /** 实际服务供应商显示名（旧数据缺省，展示回退路由 ID）。 */
  toTargetName?: string;
  toModel: string;
  attempts: CaptureFailoverAttempt[];
  /** 第几次尝试成功服务（1 起）。 */
  retryCount: number;
}

export interface CaptureRouting {
  targetId: string;
  targetName: string;
  targetFormatHint: ProxyCaptureFormat;
  localUrl: string;
  upstreamUrl: string;
  localPath: string;
  upstreamPath: string;
  method: string;
  /** 客户端原始带前缀模型 ID；网关路由时记录，便于审计。 */
  requestedModel?: string;
  /** 路由方式：model 表示按模型前缀网关路由；local_import 仅由官方直连本地导入的合成捕获使用。 */
  routeMode?: "model" | "local_import";
  /** 观测通道来源；代理写入侧不落该字段（消费端缺省 = gateway）。 */
  origin?: "gateway" | "agent_local_import";
  /** Agent 客户端自报请求分类（仅合成捕获携带）；代理写入侧不落该字段。 */
  clientQuerySource?: string;
  /** 网关注入的客户端凭据 ID（脱敏元数据，不含密钥内容），用于成本倍率追溯。 */
  clientCredentialId?: string;
  /** 请求来源 Agent（由 /{agent}/v1 路径解析），用于按 Agent 过滤与统计。 */
  agent?: string;
  /** 请求路径命中的真实 wire API；协议分类与能力判断以此为准。 */
  wireApi?: WireApi;
  /** 故障转移元数据；routing 的 targetId/model 等字段在转移发生时记录实际服务目标与模型。 */
  failover?: CaptureFailover;
}

export interface RawBodyReference {
  storage: "inline" | "compressed-inline" | "external-blob";
  encoding: "identity" | "gzip";
  sha256: string;
  sizeBytes: number;
  compressedSizeBytes?: number;
  inlineBase64?: string;
  externalPath?: string;
}

export interface CollectedRawBody {
  rawBody?: string;
  rawBodyRef?: RawBodyReference;
  bodySizeBytes: number;
  bodySha256: string;
  missing: boolean;
}

export type CaptureDiagnosticCode =
  | "request_json_parse_failed"
  | "response_json_parse_failed"
  | "sse_parse_empty"
  | "sse_event_parse_failed"
  | "upstream_error"
  | "client_aborted"
  | "upstream_aborted"
  | "connection_reset"
  | "connection_error"
  | "proxy_error"
  | "missing_raw_body";

export interface CaptureDiagnostic {
  code: CaptureDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface RawCapturedExchangeV2 {
  schemaVersion: 2;
  exchangeId: string;
  captureSessionId: string;
  sequence: number;
  capturedAt: string;
  completedAt: string;
  durationMs: number;
  /** 首字时间：代理开始转发该请求到首个上游响应 chunk 到达的毫秒数；无响应体缺省。 */
  firstTokenMs?: number;
  routing: CaptureRouting;
  request: {
    headers: Record<string, string>;
    rawBody?: string;
    rawBodyRef?: RawBodyReference;
    bodySizeBytes: number;
    bodySha256: string;
    /** 计费参数：请求体携带的 service_tier（priority/flex/fast）；缺省表示未携带。 */
    serviceTier?: "priority" | "flex" | "fast";
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    rawBody?: string;
    rawBodyRef?: RawBodyReference;
    bodySizeBytes: number;
    bodySha256: string;
    isStreaming: boolean;
  };
  bodyStorage: {
    policy: "inline" | "compressed-inline" | "external-blob";
    compression?: "gzip";
    externalBlobDir?: string;
    thresholdBytes?: number;
  };
  captureDiagnostics: CaptureDiagnostic[];
  security: {
    containsSensitiveHeaders: boolean;
    headerRedactionAppliedInApi: boolean;
    rawBodiesStoredLocally: boolean;
  };
}

export type StreamConnectionStatus =
  | "open_completed"
  | "client_aborted"
  | "upstream_aborted"
  | "connection_reset"
  | "connection_error"
  | "proxy_stream_error"
  | "unknown";
