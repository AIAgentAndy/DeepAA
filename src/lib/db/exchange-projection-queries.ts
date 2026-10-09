import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { decodeCursor, encodeCursor } from "./cursors";
import type {
  DerivationJobStatus,
  ExchangeBodyProjection,
  ExchangeContentPreview,
  ExchangeMediaDescriptor,
  ProjectionCompleteness,
  ProjectionPreviewState,
  RawBodyAvailability,
  RawBodyStorage,
  RawBodyVerification,
} from "./models";
import type {
  ExchangeContentPreviewItem,
  ExchangeOverviewCandidate,
  LimitedDimension,
} from "../ingestion/projection-types";
import type { StreamLifecycleSummary } from "../harness/types";
import { parseStepFailover, type CaptureFailover } from "../failover-display";
import {
  ALL_CONVERSATION_SEMANTIC_CATEGORIES,
  type ConversationConfidence,
  type ConversationDedupePolicy,
  type ConversationDisplayPolicy,
  type ConversationProvenance,
  type ConversationSemanticCategory,
} from "../conversation-semantics";
import { boundedUtf8, CONTENT_PREVIEW_MAX_BYTES } from "../ingestion/content-preview";

const DEFAULT_CAPTURE_PAGE_LIMIT = 20;
const MAX_CAPTURE_PAGE_LIMIT = 20;
const MAX_MEDIA_DESCRIPTORS = 512;
const MAX_DIAGNOSTICS = 64;
const MAX_PREVIEW_ITEMS = 256;
const MAX_PREVIEW_ITEM_TEXT_BYTES = 8 * 1024;
const PREVIEW_CONVERSATION_CATEGORIES = new Set<ConversationSemanticCategory>(
  ALL_CONVERSATION_SEMANTIC_CATEGORIES,
);

const LIMITED_DIMENSIONS = new Set<LimitedDimension>([
  "request_text",
  "request_media",
  "response_text",
  "response_media",
  "stream_events",
  "content_preview",
  "context_snapshot",
  "step_diff",
  "learning_insight",
  "dependency_gap",
]);

export interface BoundedProjectionItems<T> {
  items: T[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

export interface ExchangeProjectionDiagnostic {
  code: string;
  severity: string;
  message: string;
  createdAt: string;
}

export interface ExchangeProjectionDetail {
  exchangeId: string;
  captureSessionId: string;
  capturedAt: string;
  completedAt: string;
  durationMs: number;
  routing: {
    targetId: string;
    targetName: string;
  };
  agent: {
    name: string;
    fingerprintId: string;
  };
  model?: string;
  /** 模型故障转移元数据（来自 context snapshot 摘要的有界摘取；旧数据缺省）。 */
  failover?: CaptureFailover;
  request: ExchangeBodyProjection;
  response: ExchangeBodyProjection & {
    status: number;
    isStreaming: boolean;
  };
  indexVerification: "current" | "legacy";
  previewState: ProjectionPreviewState;
  projectionVersion?: number;
  jobStatus?: DerivationJobStatus;
  projectionCompleteness?: ProjectionCompleteness;
  preview: ExchangeContentPreview;
  media: BoundedProjectionItems<ExchangeMediaDescriptor>;
  diagnostics: BoundedProjectionItems<ExchangeProjectionDiagnostic>;
  step?: {
    id: string;
    sessionId: string;
    threadId: string;
    turnId: string;
    index: number;
    phase: string;
  };
  usage?: {
    model: string;
    vendor: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    vendorCost: number;
    actualCost: number;
  };
}

export interface ExchangeProjectionPage {
  exchanges: ExchangeProjectionDetail[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  limit: number;
  dataVersion: number;
  derivedStatus: string;
}

interface ProjectionRow {
  exchange_id: string;
  capture_session_id: string;
  captured_at: string;
  completed_at: string;
  target_id: string;
  target_name: string;
  agent_name: string;
  agent_fingerprint_id: string;
  model: string | null;
  status: number;
  is_streaming: 0 | 1;
  legacy_request_body_bytes: number;
  legacy_response_body_bytes: number;
  ingestion_record_id: number | null;
  request_body_bytes: number | null;
  response_body_bytes: number | null;
  request_body_sha256: string | null;
  response_body_sha256: string | null;
  request_body_storage: RawBodyStorage | null;
  response_body_storage: RawBodyStorage | null;
  request_body_state: RawBodyAvailability | null;
  response_body_state: RawBodyAvailability | null;
  projection_version: number | null;
  job_status: DerivationJobStatus | null;
  projection_completeness: ProjectionCompleteness | null;
  request_verification: RawBodyVerification | null;
  response_verification: RawBodyVerification | null;
  last_error_code: string | null;
  preview_version: number | null;
  preview_state: "complete" | "limited" | "unavailable" | null;
  preview_json: string | null;
  preview_size_bytes: number | null;
  candidate_item_count: number | null;
  processed_item_count: number | null;
  candidate_text_bytes: number | null;
  processed_text_bytes: number | null;
  candidate_count_exact: 0 | 1 | null;
  preview_limited: 0 | 1 | null;
  preview_truncated: 0 | 1 | null;
  limited_dimensions_json: string | null;
  failover_json: string | null;
  step_id: string | null;
  agent_session_id: string | null;
  agent_thread_id: string | null;
  agent_turn_id: string | null;
  step_index: number | null;
  phase: string | null;
  usage_model: string | null;
  vendor: string | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  vendor_cost: number | null;
  actual_cost: number | null;
  duration_ms: number | null;
}

interface PreviewEnvelope {
  protocol?: string;
  endpointKind?: string;
  conversationItems?: unknown;
  overviewCandidates?: unknown;
  streamLifecycle?: unknown;
  diagnosticCodes?: unknown;
}

export function loadExchangeProjectionDetail(
  db: DeepaaDatabase,
  exchangeId: string,
): ExchangeProjectionDetail | undefined {
  const row = loadProjectionRow(db, exchangeId);
  if (!row) return undefined;
  return projectionFromRow(db, row);
}

/** Capture 列表先按 keyset 和 limit + 1 定位，再逐主键读取有界 SQLite 投影。 */
export function loadCaptureExchangeProjectionPage(
  db: DeepaaDatabase,
  captureSessionId: string,
  searchParams = new URLSearchParams(),
): ExchangeProjectionPage {
  const limit = captureLimit(searchParams.get("limit"));
  const cursor = decodeCursor(searchParams.get("cursor"));
  const cursorWhere = cursor
    ? "AND (captured_at < ? OR (captured_at = ? AND exchange_id < ?))"
    : "";
  const cursorParams = cursor ? [cursor.time, cursor.time, cursor.id] : [];
  const rows = db.prepare(
    `SELECT exchange_id, captured_at
     FROM raw_exchange_refs
     WHERE capture_session_id = ? ${cursorWhere}
     ORDER BY captured_at DESC, exchange_id DESC
     LIMIT ?`,
  ).all(captureSessionId, ...cursorParams, limit + 1) as Array<{
    exchange_id: string;
    captured_at: string;
  }>;
  const candidateCount = db.prepare(
    "SELECT COUNT(*) FROM raw_exchange_refs WHERE capture_session_id = ?",
  ).pluck().get(captureSessionId) as number;
  const pageRows = rows.slice(0, limit);
  const exchanges = pageRows.flatMap((item) => {
    const projection = loadExchangeProjectionDetail(db, item.exchange_id);
    return projection ? [projection] : [];
  });
  const state = db.prepare(
    "SELECT worker_status, data_version FROM schema_meta WHERE id = 1",
  ).get() as { worker_status: string; data_version: number } | undefined;
  const last = pageRows.at(-1);
  return {
    exchanges,
    candidateCount,
    processedCount: rows.length,
    limited: rows.length > limit,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit && last
      ? encodeCursor({ time: last.captured_at, id: last.exchange_id })
      : undefined,
    limit,
    dataVersion: state?.data_version ?? 0,
    derivedStatus: state?.worker_status ?? "failed",
  };
}

export function normalizedProjection(detail: ExchangeProjectionDetail) {
  return {
    exchangeId: detail.exchangeId,
    projectionVersion: detail.projectionVersion,
    protocol: detail.preview.protocol,
    endpointKind: detail.preview.endpointKind,
    previewState: detail.previewState,
    projectionCompleteness: detail.projectionCompleteness,
    preview: detail.preview,
    media: detail.media,
  };
}

export function protocolProjection(detail: ExchangeProjectionDetail) {
  const endpointKind = detail.preview.endpointKind;
  return {
    exchangeId: detail.exchangeId,
    protocol: detail.preview.protocol ?? "unknown",
    endpointKind: endpointKind ?? "unknown",
    isModelCall: endpointKind === "model-call",
    isAuxiliary: endpointKind !== undefined && endpointKind !== "model-call",
    projectionCompleteness: detail.projectionCompleteness,
  };
}

export function validationProjection(detail: ExchangeProjectionDetail) {
  return {
    exchangeId: detail.exchangeId,
    indexVerification: detail.indexVerification,
    previewState: detail.previewState,
    jobStatus: detail.jobStatus,
    projectionCompleteness: detail.projectionCompleteness,
    request: detail.request,
    response: {
      availability: detail.response.availability,
      sizeBytes: detail.response.sizeBytes,
      sha256: detail.response.sha256,
      storage: detail.response.storage,
      verification: detail.response.verification,
      previewLimited: detail.response.previewLimited,
    },
    diagnostics: detail.diagnostics,
  };
}

function loadProjectionRow(
  db: DeepaaDatabase,
  exchangeId: string,
): ProjectionRow | undefined {
  return db.prepare(
    `SELECT r.exchange_id, r.capture_session_id, r.captured_at, r.completed_at,
      r.target_id, r.target_name, r.agent_name, r.agent_fingerprint_id,
      r.model, r.status, r.is_streaming,
      r.request_body_bytes AS legacy_request_body_bytes,
      r.response_body_bytes AS legacy_response_body_bytes,
      ir.id AS ingestion_record_id, ir.request_body_bytes, ir.response_body_bytes,
      ir.request_body_sha256, ir.response_body_sha256,
      ir.request_body_storage, ir.response_body_storage,
      ir.request_body_state, ir.response_body_state,
      j.projection_version, j.job_status, j.projection_completeness,
      j.request_verification, j.response_verification, j.last_error_code,
      p.projection_version AS preview_version, p.preview_state, p.preview_json,
      p.size_bytes AS preview_size_bytes, p.candidate_item_count,
      p.processed_item_count, p.candidate_text_bytes,
      p.processed_text_bytes, p.candidate_count_exact,
      p.limited AS preview_limited, p.truncated AS preview_truncated,
      p.limited_dimensions_json,
      COALESCE(
        s.failover_json,
        json_extract((SELECT summary_json FROM context_snapshots WHERE agent_step_id = s.id), '$.failover'),
        json_extract((SELECT summary_json FROM context_snapshots WHERE agent_step_id = s.id), '$.snapshot.failover')
      ) AS failover_json,
      s.id AS step_id, s.agent_session_id, s.agent_thread_id, s.agent_turn_id,
      s.step_index, s.phase, u.model AS usage_model, u.vendor,
      u.input_tokens, u.cache_read_tokens, u.cache_write_tokens,
      u.output_tokens, u.vendor_cost, u.actual_cost, u.duration_ms
     FROM raw_exchange_refs r
     LEFT JOIN ingestion_records ir ON ir.exchange_id = r.exchange_id
     LEFT JOIN derivation_jobs j ON j.ingestion_record_id = ir.id
       AND j.projection_version = (
         SELECT MAX(latest_job.projection_version)
         FROM derivation_jobs latest_job
         WHERE latest_job.ingestion_record_id = ir.id
       )
     LEFT JOIN exchange_content_previews p ON p.exchange_id = r.exchange_id
     LEFT JOIN agent_steps s ON s.exchange_id = r.exchange_id
     LEFT JOIN usage_ledger u ON u.exchange_id = r.exchange_id
     WHERE r.exchange_id = ? LIMIT 1`,
  ).get(exchangeId) as ProjectionRow | undefined;
}

/** 解析 json_extract 摘取的 failover JSON 文本；NULL 或异常结构返回 undefined。 */
function parseFailoverJson(value: string | null): CaptureFailover | undefined {
  if (!value) return undefined;
  try {
    return parseStepFailover(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function projectionFromRow(
  db: DeepaaDatabase,
  row: ProjectionRow,
): ExchangeProjectionDetail {  const preview = parsePreview(row);
  const limitedDimensions = new Set(preview.limitedDimensions);
  const current = row.ingestion_record_id !== null;
  const request = bodyProjection(row, "request", current, limitedDimensions);
  const response = bodyProjection(row, "response", current, limitedDimensions);
  return {
    exchangeId: row.exchange_id,
    captureSessionId: row.capture_session_id,
    capturedAt: row.captured_at,
    completedAt: row.completed_at,
    durationMs: safeNonNegative(row.duration_ms) ?? timestampDuration(
      row.captured_at,
      row.completed_at,
    ),
    routing: { targetId: row.target_id, targetName: row.target_name },
    agent: { name: row.agent_name, fingerprintId: row.agent_fingerprint_id },
    model: row.usage_model ?? row.model ?? undefined,
    failover: parseFailoverJson(row.failover_json),
    request,
    response: {
      ...response,
      status: row.status,
      isStreaming: row.is_streaming === 1,
    },
    indexVerification: current ? "current" : "legacy",
    previewState: preview.state,
    projectionVersion: row.projection_version ?? row.preview_version ?? undefined,
    jobStatus: row.job_status ?? undefined,
    projectionCompleteness: row.projection_completeness ?? undefined,
    preview,
    media: loadMedia(db, row.exchange_id),
    diagnostics: loadDiagnostics(db, row.exchange_id),
    step: row.step_id && row.agent_session_id && row.agent_thread_id
      && row.agent_turn_id && row.step_index !== null && row.phase
      ? {
          id: row.step_id,
          sessionId: row.agent_session_id,
          threadId: row.agent_thread_id,
          turnId: row.agent_turn_id,
          index: row.step_index,
          phase: row.phase,
        }
      : undefined,
    usage: row.usage_model && row.vendor
      ? {
          model: row.usage_model,
          vendor: row.vendor,
          inputTokens: safeNonNegative(row.input_tokens) ?? 0,
          cacheReadTokens: safeNonNegative(row.cache_read_tokens) ?? 0,
          cacheWriteTokens: safeNonNegative(row.cache_write_tokens) ?? 0,
          outputTokens: safeNonNegative(row.output_tokens) ?? 0,
          vendorCost: safeFinite(row.vendor_cost) ?? 0,
          actualCost: safeFinite(row.actual_cost) ?? 0,
        }
      : undefined,
  };
}

function bodyProjection(
  row: ProjectionRow,
  side: "request" | "response",
  current: boolean,
  limitedDimensions: Set<LimitedDimension>,
): ExchangeBodyProjection {
  const legacyBytes = side === "request"
    ? row.legacy_request_body_bytes
    : row.legacy_response_body_bytes;
  if (!current) {
    const sizeBytes = safeNonNegative(legacyBytes) ?? 0;
    return {
      availability: sizeBytes === 0 ? "empty" : "available",
      sizeBytes,
      storage: "unknown",
      verification: "legacy",
      previewLimited: true,
    };
  }
  const size = side === "request" ? row.request_body_bytes : row.response_body_bytes;
  const state = side === "request" ? row.request_body_state : row.response_body_state;
  const sha256 = side === "request" ? row.request_body_sha256 : row.response_body_sha256;
  const storage = side === "request"
    ? row.request_body_storage
    : row.response_body_storage;
  const verification = side === "request"
    ? row.request_verification
    : row.response_verification;
  const sideLimited = side === "request"
    ? limitedDimensions.has("request_text") || limitedDimensions.has("request_media")
    : limitedDimensions.has("response_text") || limitedDimensions.has("response_media");
  return {
    availability: verification === "failed"
      ? "integrity_failed"
      : row.job_status === "permanent_error"
        ? "unavailable"
        : state ?? "unavailable",
    sizeBytes: safeNonNegative(size) ?? 0,
    sha256: validSha256(sha256) ? sha256 : undefined,
    storage: storage ?? "unknown",
    verification: verification ?? "pending",
    previewLimited: sideLimited,
  };
}

function parsePreview(row: ProjectionRow): ExchangeContentPreview {
  const fallbackState = previewFallbackState(row);
  const empty = (state: ProjectionPreviewState): ExchangeContentPreview => ({
    state,
    projectionVersion: row.preview_version ?? row.projection_version ?? undefined,
    items: [],
    overviewCandidates: [],
    streamLifecycle: undefined,
    diagnosticCodes: [],
    itemCandidateCount: 0,
    itemProcessedCount: 0,
    itemCandidateCountExact: false,
    candidateTextBytes: 0,
    processedTextBytes: 0,
    limited: state !== "complete",
    truncated: state === "limited",
    limitedDimensions: [],
  });
  if (
    row.preview_json === null
    || row.preview_size_bytes === null
    || !Number.isSafeInteger(row.preview_size_bytes)
    || row.preview_size_bytes < 0
    || row.preview_size_bytes > CONTENT_PREVIEW_MAX_BYTES
    || Buffer.byteLength(row.preview_json) !== row.preview_size_bytes
  ) return empty(fallbackState);
  try {
    const parsed = JSON.parse(row.preview_json) as unknown;
    if (!isRecord(parsed)) return empty("unavailable");
    const envelope = parsed as PreviewEnvelope;
    const items = Array.isArray(envelope.conversationItems)
      ? envelope.conversationItems.slice(0, MAX_PREVIEW_ITEMS)
        .flatMap(item => sanitizePreviewItem(item))
      : [];
    const overviewCandidates = Array.isArray(envelope.overviewCandidates)
      ? envelope.overviewCandidates.slice(0, PREVIEW_CONVERSATION_CATEGORIES.size)
        .flatMap(item => sanitizeOverviewCandidate(item))
      : [];
    const limitedDimensions = safeLimitedDimensions(row.limited_dimensions_json);
    return {
      state: row.preview_state ?? fallbackState,
      projectionVersion: row.preview_version ?? row.projection_version ?? undefined,
      protocol: safeOptionalText(envelope.protocol, 128),
      endpointKind: safeOptionalText(envelope.endpointKind, 128),
      items,
      overviewCandidates,
      streamLifecycle: sanitizeStreamLifecycle(envelope.streamLifecycle),
      diagnosticCodes: safeStringArray(envelope.diagnosticCodes, 64, 128),
      itemCandidateCount: safeNonNegative(row.candidate_item_count) ?? 0,
      itemProcessedCount: safeNonNegative(row.processed_item_count) ?? items.length,
      itemCandidateCountExact: row.candidate_count_exact === 1,
      candidateTextBytes: safeNonNegative(row.candidate_text_bytes) ?? 0,
      processedTextBytes: safeNonNegative(row.processed_text_bytes) ?? 0,
      limited: row.preview_limited === 1,
      truncated: row.preview_truncated === 1,
      limitedDimensions,
    };
  } catch {
    return empty("unavailable");
  }
}

function sanitizeOverviewCandidate(value: unknown): ExchangeOverviewCandidate[] {
  if (!isRecord(value)) return [];
  const conversationCategory = PREVIEW_CONVERSATION_CATEGORIES.has(
    value.conversationCategory as ConversationSemanticCategory,
  )
    ? value.conversationCategory as ConversationSemanticCategory
    : undefined;
  if (!conversationCategory) return [];
  return sanitizePreviewItem(value).map(item => ({
    ...item,
    conversationCategory,
  }));
}

function sanitizeStreamLifecycle(value: unknown): StreamLifecycleSummary | undefined {
  if (!isRecord(value)) return undefined;
  const eventCount = safeNonNegative(value.eventCount);
  const parseErrorCount = safeNonNegative(value.parseErrorCount);
  if (
    eventCount === undefined
    || parseErrorCount === undefined
    || typeof value.terminalEventSeen !== "boolean"
    || typeof value.doneMarkerSeen !== "boolean"
    || typeof value.sampleLimited !== "boolean"
  ) return undefined;
  const providerStatus = value.providerStatus === "completed"
    || value.providerStatus === "failed"
    || value.providerStatus === "incomplete"
    || value.providerStatus === "cancelled"
    ? value.providerStatus
    : undefined;
  return {
    eventCount,
    lastEventType: safeOptionalText(value.lastEventType, 128),
    terminalEventSeen: value.terminalEventSeen,
    terminalEventType: safeOptionalText(value.terminalEventType, 128),
    providerStatus,
    doneMarkerSeen: value.doneMarkerSeen,
    parseErrorCount,
    sampleLimited: value.sampleLimited,
  };
}

function previewFallbackState(row: ProjectionRow): ProjectionPreviewState {
  if (row.ingestion_record_id === null) return "not_materialized";
  if (row.request_verification === "failed" || row.response_verification === "failed") {
    return "integrity_failed";
  }
  return "unavailable";
}

function sanitizePreviewItem(value: unknown): ExchangeContentPreviewItem[] {
  if (!isRecord(value)) return [];
  const side = value.side === "request" || value.side === "response"
    ? value.side
    : undefined;
  const category = safeOptionalText(value.category, 128);
  const semanticType = value.semanticType === "call_output"
    ? value.semanticType
    : undefined;
  const itemType = safeOptionalText(value.itemType, 128);
  const jsonPath = safeOptionalText(value.jsonPath, 512);
  const textSha256 = validSha256(value.textSha256) ? value.textSha256 : undefined;
  if (!side || !category || !itemType || !jsonPath || !textSha256) return [];
  const originalTextBytes = safeNonNegative(value.originalTextBytes) ?? 0;
  const rawPreview = safeOptionalText(value.textPreview, MAX_PREVIEW_ITEM_TEXT_BYTES);
  const textPreview = rawPreview === undefined ? undefined : redactDataUrls(rawPreview);
  const previewTextBytes = Math.min(
    safeNonNegative(value.previewTextBytes) ?? Buffer.byteLength(textPreview ?? ""),
    originalTextBytes,
  );
  const mediaDescriptorOrdinals = Array.isArray(value.mediaDescriptorOrdinals)
    ? value.mediaDescriptorOrdinals.filter((item): item is number =>
      Number.isSafeInteger(item) && item >= 0 && item < 256
    ).slice(0, 256)
    : [];
  const hasSemanticCategory = PREVIEW_CONVERSATION_CATEGORIES.has(
    value.semanticCategory as ConversationSemanticCategory,
  );
  const semanticCategory = hasSemanticCategory
    ? value.semanticCategory as ConversationSemanticCategory
    : side === "request" ? "unknown_input" : "unknown_output";
  const provenance = hasSemanticCategory
    ? safeProvenance(value.provenance) ?? defaultProvenance(semanticCategory)
    : "unknown";
  const confidence = safeConfidence(value.confidence)
    ?? (hasSemanticCategory
      ? provenance === "protocol_user" ? "protocol_role" : "structural"
      : "uncertain");
  const displayPolicy = safeDisplayPolicy(value.displayPolicy) ?? "conversation";
  const dedupePolicy = safeDedupePolicy(value.dedupePolicy)
    ?? (side === "response" ? "none" : "occurrence");
  return [{
    side,
    category,
    semanticType,
    role: safeOptionalText(value.role, 128),
    itemType,
    ancestorTypes: safeStringArray(value.ancestorTypes, 16, 128),
    jsonPath,
    semanticCategory,
    provenance,
    confidence,
    displayPolicy,
    dedupePolicy,
    logicalId: safeOptionalText(value.logicalId, 1_024)
      ?? `unconfirmed:${side}:${jsonPath}`,
    providerItemId: safeOptionalText(value.providerItemId, 256),
    providerLineageKey: safeOptionalText(value.providerLineageKey, 1_024),
    toolName: safeOptionalText(value.toolName, 128),
    toolUseId: safeOptionalText(value.toolUseId, 256),
    textPreview,
    textSha256,
    originalTextBytes,
    previewTextBytes,
    truncated: value.truncated === true,
    mediaDescriptorOrdinals,
  }];
}

function defaultProvenance(
  category: ConversationSemanticCategory,
): ConversationProvenance {
  if (category === "system" || category === "developer") return "protocol_system";
  if (category === "user_real") return "protocol_user";
  if (category === "user_injected") return "agent_injected";
  if (category === "control") return "agent_control";
  if (category === "tool_result") return "tool_runtime";
  if (
    category === "assistant"
    || category === "tool_use"
    || category === "reasoning"
    || category === "refusal"
  ) {
    return "model_output";
  }
  return "unknown";
}

function safeProvenance(value: unknown): ConversationProvenance | undefined {
  return typeof value === "string" && CONVERSATION_PROVENANCE.has(
    value as ConversationProvenance,
  )
    ? value as ConversationProvenance
    : undefined;
}

function safeConfidence(value: unknown): ConversationConfidence | undefined {
  return typeof value === "string" && CONVERSATION_CONFIDENCE.has(
    value as ConversationConfidence,
  )
    ? value as ConversationConfidence
    : undefined;
}

function safeDisplayPolicy(
  value: unknown,
): ConversationDisplayPolicy | undefined {
  return typeof value === "string" && CONVERSATION_DISPLAY_POLICIES.has(
    value as ConversationDisplayPolicy,
  )
    ? value as ConversationDisplayPolicy
    : undefined;
}

function safeDedupePolicy(
  value: unknown,
): ConversationDedupePolicy | undefined {
  return typeof value === "string" && CONVERSATION_DEDUPE_POLICIES.has(
    value as ConversationDedupePolicy,
  )
    ? value as ConversationDedupePolicy
    : undefined;
}

const CONVERSATION_PROVENANCE = new Set<ConversationProvenance>([
  "physical_user",
  "protocol_user",
  "agent_injected",
  "agent_control",
  "model_output",
  "protocol_system",
  "tool_runtime",
  "provider_tool",
  "provider_control",
  "unknown",
]);

const CONVERSATION_CONFIDENCE = new Set<ConversationConfidence>([
  "exact",
  "structural",
  "protocol_role",
  "uncertain",
]);

const CONVERSATION_DISPLAY_POLICIES = new Set<ConversationDisplayPolicy>([
  "conversation",
  "history_replay",
  "diagnostic_only",
]);

const CONVERSATION_DEDUPE_POLICIES = new Set<ConversationDedupePolicy>([
  "occurrence",
  "history_replay",
  "none",
]);

function loadMedia(
  db: DeepaaDatabase,
  exchangeId: string,
): BoundedProjectionItems<ExchangeMediaDescriptor> {
  const rows = db.prepare(
    `SELECT body_side, ordinal, json_path, media_type, encoded_bytes,
      decoded_bytes, sha256, source_storage
     FROM exchange_media_descriptors
     WHERE exchange_id = ? ORDER BY body_side, ordinal
     LIMIT ?`,
  ).all(exchangeId, MAX_MEDIA_DESCRIPTORS + 1) as Array<{
    body_side: "request" | "response";
    ordinal: number;
    json_path: string;
    media_type: string;
    encoded_bytes: number;
    decoded_bytes: number;
    sha256: string;
    source_storage: Exclude<RawBodyStorage, "none">;
  }>;
  const candidateCount = db.prepare(
    "SELECT COUNT(*) FROM exchange_media_descriptors WHERE exchange_id = ?",
  ).pluck().get(exchangeId) as number;
  return {
    items: rows.slice(0, MAX_MEDIA_DESCRIPTORS).map(row => ({
      bodySide: row.body_side,
      ordinal: row.ordinal,
      jsonPath: row.json_path,
      mediaType: row.media_type,
      encodedBytes: row.encoded_bytes,
      decodedBytes: row.decoded_bytes,
      sha256: row.sha256,
      sourceStorage: row.source_storage,
    })),
    candidateCount,
    processedCount: rows.length,
    limited: rows.length > MAX_MEDIA_DESCRIPTORS,
  };
}

function loadDiagnostics(
  db: DeepaaDatabase,
  exchangeId: string,
): BoundedProjectionItems<ExchangeProjectionDiagnostic> {
  const rows = db.prepare(
    `SELECT code, severity, message, created_at
     FROM derivation_diagnostics WHERE exchange_id = ?
     ORDER BY id DESC LIMIT ?`,
  ).all(exchangeId, MAX_DIAGNOSTICS + 1) as Array<{
    code: string;
    severity: string;
    message: string;
    created_at: string;
  }>;
  const candidateCount = db.prepare(
    "SELECT COUNT(*) FROM derivation_diagnostics WHERE exchange_id = ?",
  ).pluck().get(exchangeId) as number;
  return {
    items: rows.slice(0, MAX_DIAGNOSTICS).map(row => ({
      code: boundedUtf8(row.code, 256),
      severity: boundedUtf8(row.severity, 64),
      message: boundedUtf8(row.message, 2_048),
      createdAt: row.created_at,
    })),
    candidateCount,
    processedCount: rows.length,
    limited: rows.length > MAX_DIAGNOSTICS,
  };
}

function safeLimitedDimensions(value: string | null): LimitedDimension[] {
  if (!value || Buffer.byteLength(value) > 4_096) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is LimitedDimension =>
        typeof item === "string" && LIMITED_DIMENSIONS.has(item as LimitedDimension)
      ).slice(0, 32)
      : [];
  } catch {
    return [];
  }
}

function safeStringArray(
  value: unknown,
  maxItems: number,
  maxBytes: number,
): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
      .slice(0, maxItems).map(item => boundedUtf8(item, maxBytes))
    : [];
}

function safeOptionalText(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" ? boundedUtf8(value, maxBytes) : undefined;
}

function safeNonNegative(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function safeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function timestampDuration(start: string, end: string): number {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function captureLimit(value: string | null): number {
  const parsed = Number(value ?? DEFAULT_CAPTURE_PAGE_LIMIT);
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(parsed, MAX_CAPTURE_PAGE_LIMIT))
    : DEFAULT_CAPTURE_PAGE_LIMIT;
}

function redactDataUrls(value: string): string {
  return value.replace(
    /data:[^;,\s]{1,128};base64,[a-z0-9+/=_-]+/gi,
    "[media]",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
