import type { ProxyFormat, WireApi } from "../../types";

export type Confidence = "exact" | "high" | "medium" | "low";

/**
 * 观测通道来源（双链路观测，2026-09-15）：gateway = 网关 raw 捕获（缺省语义，
 * 旧数据与代理写入均不落该字段）；agent_local_import = Agent 官方客户端直连流量的
 * 本地数据导入（合成捕获）。消费端按缺省 gateway 解释。
 */
export type CaptureOrigin = "gateway" | "agent_local_import";

export interface EvidencePointer {
  exchangeId: string;
  side: "request" | "response" | "stream" | "routing" | "diagnostic";
  path: string;
  note?: string;
}

export interface RawCapturedExchange {
  schemaVersion: 1 | 2;
  exchangeId: string;
  captureSessionId: string;
  sequence: number;
  capturedAt: string;
  completedAt: string;
  durationMs: number;
  /** 首字时间：代理开始转发该请求到首个上游响应 chunk 到达的毫秒数；无响应体或旧数据缺省。 */
  firstTokenMs?: number;
  routing: CaptureRouting;
  request: CapturedRequest;
  response: CapturedResponse;
  stream?: CapturedStream;
  bodyStorage: RawBodyStorageMetadata;
  captureDiagnostics: CaptureDiagnostic[];
  security: CaptureSecurityMetadata;
}

/** v2 落盘边界只允许可追溯的 raw/blob 字段，不暴露运行时解析副本。 */
export interface RawCapturedExchangeV2 extends Omit<
  RawCapturedExchange,
  "schemaVersion" | "request" | "response" | "stream"
> {
  schemaVersion: 2;
  request: RawCapturedRequestV2;
  response: RawCapturedResponseV2;
  stream?: never;
}

/** 故障转移单次上游尝试的结局（按尝试顺序排列，含最终服务的尝试）。 */
export interface CaptureFailoverAttempt {
  targetId: string;
  model: string;
  outcome: "error" | "served";
  /** 失败原因简述：如 "HTTP 502"、"ECONNRESET"、"HEADER_TIMEOUT"。 */
  detail?: string;
}

/**
 * 模型故障转移元数据（与 src/proxy/raw-v2-contract.ts 的 CaptureFailover 同构）：
 * 请求发生过「跳过主模型/恢复探测」时随捕获落盘，供 Step 投影与会话追踪/交互内容展示。
 */
export interface CaptureFailover {
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
  /** 最终尝试序号（1 起）；末位 attempt 的 outcome 标识最终是否成功服务。 */
  retryCount: number;
}

export interface CaptureRouting {
  targetId: string;
  targetName: string;
  targetFormatHint: ProxyFormat;
  localUrl: string;
  upstreamUrl: string;
  localPath: string;
  upstreamPath: string;
  method: string;
  /** 客户端原始带前缀模型 ID；网关路由时记录，便于审计。 */
  requestedModel?: string;
  /** 路由方式：model 表示按模型前缀网关路由；local_import 表示官方直连本地导入的合成捕获。 */
  routeMode?: "model" | "local_import";
  /**
   * 观测通道来源；缺省 = gateway。合成捕获（routeMode=local_import）必须显式携带
   * agent_local_import，供账本 usage 来源标注与官方客户端活动（Campaign origins）判定。
   */
  origin?: CaptureOrigin;
  /**
   * Agent 客户端自报的请求分类（如 zcode 的 main_turn/subagent/session_title/compact），
   * 仅随合成捕获落盘作观测元数据；请求分类派生仍走通用协议链路，两条通道口径一致。
   */
  clientQuerySource?: string;
  /** 网关注入的客户端凭据 ID（脱敏元数据，不含密钥内容），用于成本倍率追溯。 */
  clientCredentialId?: string;
  /** 请求来源 Agent（由 /{agent}/v1 路径解析），用于按 Agent 过滤与统计。 */
  agent?: string;
  /** 请求路径命中的真实 wire API；协议分类与能力判断以此为准。 */
  wireApi?: WireApi;
  /** 故障转移元数据；routing 的 targetId 等字段在转移发生时记录实际服务目标。 */
  failover?: CaptureFailover;
}

export interface CapturedRequest {
  headers: Record<string, string>;
  rawBody?: string;
  parsedBody?: unknown;
  parseError?: CaptureParseError;
  bodySizeBytes: number;
  bodySha256: string;
  rawBodyRef?: RawBodyReference;
  /** 计费参数：请求体携带的 service_tier（priority/flex/fast）；旧记录缺省。 */
  serviceTier?: string;
}

export interface RawCapturedRequestV2 {
  headers: Record<string, string>;
  rawBody?: string;
  bodySizeBytes: number;
  bodySha256: string;
  rawBodyRef?: RawBodyReference;
  /** 计费参数：请求体携带的 service_tier（priority/flex/fast）；缺省表示未携带。 */
  serviceTier?: "priority" | "flex" | "fast";
}

export interface CapturedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawBody?: string;
  parsedBody?: unknown;
  parseError?: CaptureParseError;
  bodySizeBytes: number;
  bodySha256: string;
  isStreaming: boolean;
  rawBodyRef?: RawBodyReference;
}

export interface RawCapturedResponseV2 {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawBody?: string;
  bodySizeBytes: number;
  bodySha256: string;
  isStreaming: boolean;
  rawBodyRef?: RawBodyReference;
}

export interface CapturedStream {
  events: CapturedSseEvent[];
  parseErrors: CaptureParseError[];
  doneMarkerSeen?: boolean;
  rawBodyStorage: RawBodyReference["storage"];
  /** Worker 对完整 SSE 扫描得到的固定大小摘要；events 仅是有界诊断样本。 */
  lifecycleSummary?: StreamLifecycleSummary;
}

export type StreamProviderStatus =
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled";

export interface StreamLifecycleSummary {
  eventCount: number;
  lastEventType?: string;
  terminalEventSeen: boolean;
  terminalEventType?: string;
  providerStatus?: StreamProviderStatus;
  doneMarkerSeen: boolean;
  parseErrorCount: number;
  sampleLimited: boolean;
}

export interface CapturedSseEvent {
  index: number;
  event: string;
  data: unknown;
  rawData: string;
  parseError?: CaptureParseError;
}

export interface CaptureParseError {
  message: string;
  offset?: number;
  rawPreview?: string;
}

/**
 * capture diagnostic 代码的唯一真相（2026-09-17）：类型与 v2 原始行校验必须同源，
 * 否则新增诊断会被 raw-source-reader 的校验拒绝，整行无法登记（实测踩过）。
 */
export const CAPTURE_DIAGNOSTIC_CODES = [
  "request_json_parse_failed",
  "response_json_parse_failed",
  "sse_parse_empty",
  "sse_event_parse_failed",
  "upstream_error",
  "client_aborted",
  "upstream_aborted",
  "connection_reset",
  "connection_error",
  "proxy_error",
  "missing_raw_body",
  /**
   * 本地导入链路的正文完整性诊断：请求骨架缺失/借用、assistant 正文与用量不一致。
   * 前端与排重基线据此如实降级，绝不假装完整。
   */
  "request_skeleton_missing",
  "request_skeleton_borrowed",
  "assistant_parts_incomplete",
] as const;

export type CaptureDiagnosticCode = typeof CAPTURE_DIAGNOSTIC_CODES[number];

export interface CaptureDiagnostic {
  code: CaptureDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface RawBodyStorageMetadata {
  policy: "inline" | "compressed-inline" | "external-blob";
  compression?: "gzip";
  externalBlobDir?: string;
  thresholdBytes?: number;
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

export interface CaptureSecurityMetadata {
  containsSensitiveHeaders: boolean;
  headerRedactionAppliedInApi: boolean;
  rawBodiesStoredLocally: boolean;
}

export type StreamConnectionStatus =
  | "open_completed"
  | "client_aborted"
  | "upstream_aborted"
  | "connection_reset"
  | "connection_error"
  | "proxy_stream_error"
  | "unknown";

export interface RawBodyPolicy {
  inlineThresholdBytes: number;
  compressedInlineThresholdBytes: number;
}

export const DEFAULT_RAW_BODY_POLICY: RawBodyPolicy = {
  inlineThresholdBytes: 256 * 1024,
  compressedInlineThresholdBytes: 2 * 1024 * 1024,
};
