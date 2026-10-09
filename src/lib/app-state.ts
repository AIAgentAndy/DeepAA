/**
 * API 共享 DTO 与纯转换。
 *
 * 数据读取统一位于 lib/db 查询层；本模块不得读取 raw、旧索引或派生目录。
 */
import type {
  AgentSession,
  AgentStep,
  AgentTurn,
  AuxiliaryExchange,
} from "./harness/agent";
import type {
  HarnessDerivedDataset,
  HarnessLearningInsight,
} from "./harness/derived";
import type {
  ObservedContextSnapshot,
  StepDiff,
} from "./harness/context-snapshot";
import type { StepContextDiffView } from "./harness/context-diff-view";
import type { EvidencePointer, RawCapturedExchange } from "./harness/types";

export type DerivedStatus = "building" | "ready" | "failed";

export interface CaptureSummary {
  id: string;
  captureSessionId?: string;
  fileName: string;
  filePath: string;
  exchangeCount: number;
  startTime?: string;
  endTime?: string;
  modelSet: string[];
  targetSet: string[];
  agentTurnCount: number;
  fileSize: number;
}

export interface ExchangeIndexItem {
  exchangeId: string;
  captureSessionId: string;
  captureGroupId?: string;
  agentName: string;
  capturedAt: string;
  completedAt: string;
  routing: RawCapturedExchange["routing"];
  request: {
    bodySizeBytes: number;
    bodySha256: string;
    model?: string;
  };
  response: {
    status: number;
    statusText: string;
    isStreaming: boolean;
    bodySizeBytes: number;
    bodySha256: string;
  };
  diagnosticCodes: string[];
}

export interface WorkbenchTreeTurn {
  turnId: string;
  source: AgentTurn["source"];
  confidence: AgentTurn["confidence"];
  startTime: string;
  endTime: string;
  modelSet: string[];
  stepCount: number;
  auxiliaryRequestCount: number;
  latestExchangeId?: string;
  selectedExchangeId?: string;
}

export interface WorkbenchTreeSession {
  sessionId: string;
  source: AgentSession["source"];
  confidence: AgentSession["confidence"];
  externalSessionId?: string;
  externalThreadId?: string;
  startTime: string;
  endTime: string;
  modelSet: string[];
  targetSet: string[];
  exchangeCount: number;
  turnCount: number;
  turns: WorkbenchTreeTurn[];
}

export interface WorkbenchTreeAgent {
  targetId: string;
  targetName: string;
  agentFingerprintId: string;
  agentName: string;
  sessions: WorkbenchTreeSession[];
}

export interface WorkbenchTreeState {
  agents: WorkbenchTreeAgent[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  derivedStatus: DerivedStatus;
}

export interface HarnessWorkbenchDerivedDataset extends Omit<
  HarnessDerivedDataset,
  "contextSnapshots" | "stepDiffs"
> {
  contextSnapshots: WorkbenchContextSnapshot[];
  stepDiffs: WorkbenchStepDiff[];
  learningInsights: HarnessLearningInsight[];
}

export interface WorkbenchContextSnapshot extends Omit<
  ObservedContextSnapshot,
  "harnessPayload"
> {
  /** SQLite artifact 受限时保留可观测状态，页面不得把摘要伪装成完整上下文。 */
  artifactLimited?: boolean;
  /** true = 条目/字节超预算被真实丢弃（需告警）；仅字段级预览时为 false。 */
  artifactTruncated?: boolean;
  artifactCompleteness?: Record<string, unknown>;
  harnessSummary: {
    intent: ObservedContextSnapshot["harnessPayload"]["intent"];
    systemPrompts: Array<{
      textHash: string;
      textPreview?: string;
      providerRole?: string;
      evidenceCount: number;
    }>;
    developerPrompts: Array<{
      textHash: string;
      textPreview?: string;
      providerRole?: string;
      evidenceCount: number;
    }>;
    userPrompts: UserPromptSummary[];
    userPromptObservability: "complete" | "partial";
    conversationItemCount: number;
    /** 按 kind 聚合的对话条目计数（分层卡片用；不保留全量条目）。 */
    conversationKindCounts?: Record<string, number>;
    /** 有界条目样本（≤24 条），仅用于分层卡片展示。 */
    conversationItemSamples?: Array<{
      kind: string;
      role?: string;
      toolName?: string;
      toolUseId?: string;
      summary?: string;
    }>;
    toolSchemaCount: number;
    requestedToolUses: Array<{
      id: string;
      name: string;
      providerType?: string;
      input: unknown;
      evidenceCount: number;
    }>;
    providedToolResults: Array<{
      toolUseId: string;
      isError?: boolean;
      providerType?: string;
      content: unknown;
      evidenceCount: number;
    }>;
    reasoningItemCount: number;
    params: Record<string, unknown>;
    stableHash: string;
    evidenceCount: number;
  };
}

export interface UserPromptSummary {
  index: number;
  text: string;
  textHash: string;
  sourceExchangeId: string;
  sourceStepId?: string;
  capturedAt?: string;
  role: "user";
  evidence: EvidencePointer[];
}

export type WorkbenchStepDiff = StepDiff & {
  contextView?: StepContextDiffView;
  artifactLimited?: boolean;
  /** true = 差异项被真实丢弃（需告警）；仅索引态时为 false。 */
  artifactTruncated?: boolean;
  artifactCompleteness?: Record<string, unknown>;
};

export interface AgentTurnStepsState {
  steps: AgentStep[];
  total: number;
  limit: number;
  offset: number;
  processedCount: number;
  limited: boolean;
  candidateCount: number;
  hasMore: boolean;
  nextCursor?: string;
  derivedStatus: DerivedStatus;
}

export interface AgentSessionStepsState extends AgentTurnStepsState {}

export interface StepContextSnapshotState {
  snapshot: WorkbenchContextSnapshot;
  derivedStatus: DerivedStatus;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

export interface StepDiffState {
  diff: WorkbenchStepDiff;
  derivedStatus: DerivedStatus;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

export interface CaptureIndexState {
  items: ExchangeIndexItem[];
  total: number;
  limit: number;
  offset: number;
  facets: {
    targets: string[];
    models: string[];
    statuses: number[];
    diagnostics: string[];
  };
}

export interface HarnessWorkbenchState {
  captures: CaptureSummary[];
  exchangeIndex: ExchangeIndexItem[];
  derived: HarnessWorkbenchDerivedDataset;
  derivedStatus: DerivedStatus;
}

export interface WorkbenchRefreshState {
  captures: CaptureSummary[];
  exchangeIndex: ExchangeIndexItem[];
  derived: {
    agentSessions: AgentSession[];
    agentTurns: AgentTurn[];
    steps: AgentStep[];
    contextSnapshots: WorkbenchContextSnapshot[];
    stepDiffs: WorkbenchStepDiff[];
    auxiliaryExchanges: AuxiliaryExchange[];
    learningInsights: HarnessLearningInsight[];
  };
  derivedStatus: DerivedStatus;
}

export function validateRawCapture(exchange: RawCapturedExchange) {
  return {
    exchangeId: exchange.exchangeId,
    hasRequestHeaders: Object.keys(exchange.request.headers).length > 0,
    hasRequestRawBody: typeof exchange.request.rawBody === "string"
      || Boolean(exchange.request.rawBodyRef),
    hasParsedRequestBody: exchange.request.parsedBody !== undefined,
    hasResponseHeaders: Object.keys(exchange.response.headers).length > 0,
    hasResponseRawBody: typeof exchange.response.rawBody === "string"
      || Boolean(exchange.response.rawBodyRef),
    hasParsedResponseBody: exchange.response.parsedBody !== undefined,
    hasSseRawBody: exchange.response.isStreaming
      && (typeof exchange.response.rawBody === "string"
        || Boolean(exchange.response.rawBodyRef)),
    hasParsedSseEvents: (exchange.stream?.events.length || 0) > 0,
    requestBodyParseError: exchange.request.parseError?.message,
    responseBodyParseError: exchange.response.parseError?.message,
    evidence: [
      { exchangeId: exchange.exchangeId, side: "request" as const, path: "$.request" },
      { exchangeId: exchange.exchangeId, side: "response" as const, path: "$.response" },
    ],
  };
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return Response.json(data, { status, headers });
}

export function notFound(message = "Not found"): Response {
  return jsonResponse({ error: message }, 404);
}

export function paginate<T>(
  items: T[],
  searchParams: URLSearchParams,
): { items: T[]; total: number; limit: number; offset: number } {
  const requestedLimit = Number(searchParams.get("limit") || 100);
  const requestedOffset = Number(searchParams.get("offset") || 0);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 100))
    : 100;
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}

export function sanitizeExchangeForApi(
  exchange: RawCapturedExchange,
): RawCapturedExchange {
  return {
    ...exchange,
    request: {
      ...exchange.request,
      headers: redactHeaders(exchange.request.headers),
    },
    response: {
      ...exchange.response,
      headers: redactHeaders(exchange.response.headers),
    },
  };
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    isSensitiveHeader(key) ? maskHeaderValue(value) : value,
  ]));
}

function isSensitiveHeader(headerName: string): boolean {
  return [
    "authorization",
    "api-key",
    "x-api-key",
    "openai-api-key",
    "anthropic-api-key",
    "cookie",
    "set-cookie",
    "proxy-authorization",
  ].includes(headerName.toLowerCase());
}

function maskHeaderValue(value: string): string {
  const bearer = value.match(/^(Bearer\s+)(.+)$/i);
  if (bearer) return `${bearer[1]}${maskSecret(bearer[2] || "")}`;
  return maskSecret(value);
}

function maskSecret(secret: string): string {
  if (secret.length <= 12) return "***";
  return `${secret.slice(0, 6)}${"*".repeat(secret.length - 12)}${secret.slice(-6)}`;
}
