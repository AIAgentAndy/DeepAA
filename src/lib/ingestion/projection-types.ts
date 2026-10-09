import type { RawBodyStorage } from "../db/models";
import type { StreamLifecycleSummary } from "../harness/types";
import type {
  AgentKind,
  ConversationConfidence,
  ConversationDedupePolicy,
  ConversationDisplayPolicy,
  ConversationProvenance,
  ConversationSemanticCategory,
  ConversationTurnSignal,
  RequestContextMode,
} from "../conversation-semantics";

export type ProjectionBodySide = "request" | "response";

/** 文本叶子节点之外必须保留的父级协议语义。 */
export type PreviewSemanticType = "call_output";

export type LimitedDimension =
  | "request_text"
  | "request_media"
  | "response_text"
  | "response_media"
  | "stream_events"
  | "content_preview"
  | "context_snapshot"
  | "step_diff"
  | "learning_insight"
  | "dependency_gap";

export interface ExchangeMediaDescriptorDraft {
  exchangeId: string;
  bodySide: ProjectionBodySide;
  ordinal: number;
  jsonPath: string;
  mediaType: string;
  encodedBytes: number;
  decodedBytes: number;
  sha256: string;
  rawBodySha256: string;
  sourceStorage: Exclude<RawBodyStorage, "none">;
}

export interface ExchangeContentPreviewItem {
  side: ProjectionBodySide;
  /** 原始投影粗粒度类型，仅用于诊断，不作为会话类别。 */
  category: string;
  semanticType?: PreviewSemanticType;
  role?: string;
  itemType: string;
  ancestorTypes: string[];
  jsonPath: string;
  semanticCategory: ConversationSemanticCategory;
  provenance: ConversationProvenance;
  confidence: ConversationConfidence;
  displayPolicy: ConversationDisplayPolicy;
  dedupePolicy: ConversationDedupePolicy;
  logicalId: string;
  providerItemId?: string;
  providerLineageKey?: string;
  toolName?: string;
  toolUseId?: string;
  textPreview?: string;
  textSha256: string;
  originalTextBytes: number;
  previewTextBytes: number;
  truncated: boolean;
  mediaDescriptorOrdinals: number[];
  mediaSha256?: string[];
}

export interface ExchangeOverviewCandidate extends ExchangeContentPreviewItem {
  conversationCategory: ConversationSemanticCategory;
}

/** 仅在 Worker 短事务前存活的轻量筛选指纹，不进入 preview_json。 */
export interface ExchangeContentFilterItem {
  side: ProjectionBodySide;
  category: ConversationSemanticCategory;
  fingerprint: string;
  providerLineageKey?: string;
  mediaSha256?: string[];
  turnSignal?: ConversationTurnSignal;
}

export interface ExchangeContentPreviewDraft {
  exchangeId: string;
  projectionVersion: number;
  protocol?: string;
  agentKind?: AgentKind;
  endpointKind?: string;
  items: ExchangeContentPreviewItem[];
  historyReplaySamples: ExchangeContentPreviewItem[];
  historyReplayCount: number;
  overviewCandidates: ExchangeOverviewCandidate[];
  filterItems: ExchangeContentFilterItem[];
  filterItemCandidateCount: number;
  filterItemCandidateCountExact: boolean;
  filterItemCandidateCountBySide: Record<ProjectionBodySide, number>;
  filterItemCandidateCountExactBySide: Record<ProjectionBodySide, boolean>;
  streamLifecycle?: StreamLifecycleSummary;
  requestContextMode?: RequestContextMode;
  contextBoundaryCandidates: ContextBoundaryCandidate[];
  diagnosticCodes: string[];
  itemCandidateCount: number;
  itemProcessedCount: number;
  itemCandidateCountExact: boolean;
  candidateTextBytes: number;
  processedTextBytes: number;
  limited: boolean;
  truncated: boolean;
  limitedDimensions: LimitedDimension[];
  previewJson: string;
  sizeBytes: number;
}

export interface ContextBoundaryCandidate {
  bodySide: ProjectionBodySide;
  logicalId: string;
  providerItemId?: string;
  occurrenceOrdinal: number;
  encryptedContentSha256?: string;
  effectivePhase: "before_request" | "after_exchange";
  evidencePath: string;
}

export interface ProjectedBodyResult {
  body: unknown;
  streamEvents?: Array<{ event: string; data: unknown }>;
  streamLifecycle?: StreamLifecycleSummary;
  preview: ExchangeContentPreviewDraft;
  mediaDescriptors: ExchangeMediaDescriptorDraft[];
  eventTypes: string[];
  diagnosticCodes: string[];
  limitedDimensions: LimitedDimension[];
  candidateCountExact: boolean;
}

export interface ProjectedExchangeInput {
  requestBody: unknown;
  responseBody: unknown;
  streamEvents?: Array<{ event: string; data: unknown }>;
  preview: ExchangeContentPreviewDraft;
  mediaDescriptors: ExchangeMediaDescriptorDraft[];
  limitedDimensions: LimitedDimension[];
  diagnosticCodes: string[];
}
