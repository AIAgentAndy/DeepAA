import type {
  Confidence,
  RawCapturedExchangeV2,
} from "../harness/types";
import type {
  ExchangeContentPreviewItem,
  ExchangeOverviewCandidate,
  LimitedDimension,
} from "../ingestion/projection-types";
import type { StreamLifecycleSummary } from "../harness/types";

export type ScopeType = "session" | "thread" | "turn" | "step";

export type DerivationJobStatus =
  | "pending"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "permanent_error";

export type ProjectionCompleteness = "complete" | "limited" | "unavailable";

export type RawBodyVerification =
  | "pending"
  | "verified"
  | "empty"
  | "not_verified_budget"
  | "missing_declared"
  | "failed";

export type RawBodyAvailability = "available" | "empty" | "missing_declared";

export type RawBodyStorage =
  | "inline"
  | "compressed-inline"
  | "external-blob"
  | "none";

export type ProjectionPreviewState =
  | "complete"
  | "limited"
  | "unavailable"
  | "integrity_failed"
  | "not_materialized";

export type ProjectionIndexVerification = "current" | "legacy";

export type ProjectionBodyStorage = RawBodyStorage | "unknown";

export type ProjectionBodyAvailability =
  | RawBodyAvailability
  | "unavailable"
  | "integrity_failed";

export type ProjectionBodyVerification = RawBodyVerification | "legacy";

export interface ExchangeBodyProjection {
  availability: ProjectionBodyAvailability;
  sizeBytes: number;
  sha256?: string;
  storage: ProjectionBodyStorage;
  verification: ProjectionBodyVerification;
  previewLimited: boolean;
}

export interface ExchangeContentPreview {
  state: ProjectionPreviewState;
  projectionVersion?: number;
  protocol?: string;
  endpointKind?: string;
  items: ExchangeContentPreviewItem[];
  overviewCandidates: ExchangeOverviewCandidate[];
  streamLifecycle?: StreamLifecycleSummary;
  diagnosticCodes: string[];
  itemCandidateCount: number;
  itemProcessedCount: number;
  itemCandidateCountExact: boolean;
  candidateTextBytes: number;
  processedTextBytes: number;
  limited: boolean;
  truncated: boolean;
  limitedDimensions: LimitedDimension[];
}

export interface ExchangeMediaDescriptor {
  bodySide: "request" | "response";
  ordinal: number;
  jsonPath: string;
  mediaType: string;
  encodedBytes: number;
  decodedBytes: number;
  sha256: string;
  sourceStorage: Exclude<RawBodyStorage, "none">;
}

export type AgentSessionIdentitySource =
  | "session-header"
  | "session-metadata"
  | "session-body"
  | "conversation-id"
  | "provider-grouping"
  | "capture-session";

export interface ThreadIdentityDiagnostic {
  code: string;
  message: string;
}

/** 单条原始交换解析出的稳定业务路径；Session 身份刻意不包含任何 Thread 字段。 */
export interface ResolvedAgentPath {
  targetId: string;
  targetName: string;
  agentFingerprintId: string;
  agentName: string;
  agentSessionId: string;
  agentThreadId: string;
  rootAgentThreadId: string;
  parentAgentThreadId?: string;
  externalSessionId?: string;
  externalConversationId?: string;
  externalThreadId?: string;
  externalAgentId?: string;
  externalParentThreadId?: string;
  externalParentAgentId?: string;
  sessionSource: AgentSessionIdentitySource;
  threadSource: string;
  confidence: Confidence;
  isRootThread: boolean;
  displayName: string;
  diagnostics: ThreadIdentityDiagnostic[];
}

/** 大集合查询必须同时返回读取预算和截断状态，不能把有界结果伪装成全集。 */
export interface BoundedPage<T> {
  items: T[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  dataVersion: number;
  derivedStatus: DerivationStatus["status"];
}

export interface DerivationStatus {
  status: "idle" | "running" | "paused_disk" | "failed";
  dataVersion: number;
  error?: string;
}

/** Worker 提交给单条事务派生器的完整原始位置，任何字段都不能由 processor 猜测。 */
export interface ProcessExchangeInput {
  ingestionRecordId?: number;
  sourceId: number;
  sourceRelativePath: string;
  byteOffset: number;
  lineLengthBytes: number;
  exchange: RawCapturedExchangeV2;
}

export interface ProcessExchangeResult {
  exchangeId: string;
  duplicate: boolean;
  /**
   * dsh 网关行身份标注未到（仅持久派生任务路径）：未提交任何派生结果，由
   * worker 调度层顺延后重新领取（零错误码、零 attempt 消耗）。
   */
  identityWait?: true;
  /** 身份等待的顺延粒度（毫秒）：实时竞态 2s / 扫描就绪等待 5s；缺省用 worker 常量。 */
  identityWaitDeferMs?: number;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  stepId?: string;
}
