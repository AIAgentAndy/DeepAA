import { fingerprintAgent } from "./fingerprint";
import { classifyProtocol } from "./protocol";
import { normalizeExchange, stableHash } from "./normalizer";
import type { NormalizedExchange } from "./normalizer";
import { refineStreamDiagnostic } from "./stream-diagnostics";
import type { StreamDiagnosticStatus } from "./stream-diagnostics";
import { buildObservedContextSnapshot } from "./context-snapshot";
import type { ObservedContextSnapshot } from "./context-snapshot";
import type { Confidence, EvidencePointer, RawCapturedExchange } from "./types";
import type { CaptureFailover } from "./types";
import type { PricingSnapshot, TokenCostSummary } from "../pricing";
import type { PlanEstimateDetailInput } from "../token-pricing-display";

export type AgentGroupingSource =
  | "agent-session-header"
  | "thread-header"
  | "conversation-field"
  | "tool-link"
  | "message-prefix"
  | "time-window"
  | "manual";

export interface TurnGroupingEvidence {
  kind: AgentGroupingSource | "client-request-header";
  fromExchangeId?: string;
  toExchangeId?: string;
  value?: string;
  explanation: string;
  evidence: EvidencePointer[];
}

export interface AgentSession {
  id: string;
  agentFingerprintId: string;
  source: AgentGroupingSource;
  externalSessionId?: string;
  externalThreadId?: string;
  externalConversationId?: string;
  exchangeIds: string[];
  auxiliaryExchangeIds: string[];
  startTime: string;
  endTime: string;
  modelSet: string[];
  targetSet: string[];
  confidence: Confidence;
  evidence: TurnGroupingEvidence[];
}

export interface AgentTurn {
  id: string;
  agentSessionId: string;
  agentFingerprintId: string;
  source:
    | "agent-session"
    | "thread-header"
    | "conversation-field"
    | "tool-link"
    | "message-prefix"
    | "time-window"
    | "user-prompt"
    | "manual";
  externalSessionId?: string;
  externalThreadId?: string;
  externalConversationId?: string;
  /** 供应商原生 Turn ID：Codex x-codex-turn-metadata.turn_id、OpenCode x-opencode-request。 */
  nativeTurnId?: string;
  exchangeIds: string[];
  auxiliaryExchangeIds: string[];
  startTime: string;
  endTime: string;
  modelSet: string[];
  targetSet: string[];
  confidence: Confidence;
  evidence: TurnGroupingEvidence[];
}

export interface AuxiliaryExchange {
  id: string;
  agentSessionId?: string;
  agentTurnId?: string;
  exchangeId: string;
  kind: "token_count" | "auth_error" | "health_check" | "metadata" | "title_generation" | "unknown";
  timestamp: string;
  summary: string;
  evidence: EvidencePointer[];
}

export interface AgentStep {
  id: string;
  turnId: string;
  agentSessionId: string;
  /** SQLite 工作台按 Session 跨 Turn 展示时，用于恢复 Step 所属 Thread。 */
  agentThreadId?: string;
  exchangeId: string;
  index: number;
  timestamp: string;
  phase:
    | "initial_prompt"
    | "tool_result_followup"
    | "tool_request"
    | "tool_loop"
    | "final_answer"
    | "retry"
    | "error"
    | "incomplete";
  requestAction: "user_prompt" | "tool_result" | "conversation_continue" | "retry_like" | "unknown";
  responseAction: "tool_use" | "final" | "error" | "incomplete" | "unknown";
  inputMessageCount?: number;
  inputItemCount?: number;
  toolSchemaCount: number;
  toolUseNames: string[];
  toolUseIds: string[];
  toolResultIds: string[];
  stopReason?: string;
  streamStatus?: StreamDiagnosticStatus;
  tokenUsage?: NormalizedExchange["response"]["usage"];
  contextSnapshotId: string;
  codexTurnId?: string;
  codexRequestKind?: string;
  codexThreadSource?: string;
  /** 本次请求意图的一句话标签（如“续接工具结果”“新用户输入”“远端状态续接”“重试”“上下文压缩”“首次提问”），供时间线一眼可见 */
  requestIntentLabel?: string;
  /** 本次响应状态的一句话标签（如“已完成”“待工具调用”“流中断”“上游错误”），供时间线一眼可见 */
  responseStatusLabel?: string;
  /** 该步骤相对上一步观察到上下文被裁剪/压缩（消息、工具结果或推理项被移除） */
  contextCompressed?: boolean;
  /** P1 补强：首字耗时（毫秒）、HTTP 状态码、结果分类、压缩证据预览（来自账本/快照，旧数据缺省）。 */
  firstTokenMs?: number;
  httpStatus?: number;
  resultClass?: string;
  compactionPreview?: {kind: string; confidence: string; markerKind?: string; preview: string};
  /** 压缩事件角色（服务端 wire 证据门槛注解）：generation=压缩生成调用；first-after=压缩后首请求。 */
  compactionRole?: "generation" | "first-after";
  /** 本 turn 内的压缩事件序号（1 起；与 compactionRole 成对出现）。 */
  compactionOrdinal?: number;
  /** Step 详情的压缩事件注解（与列表 compactionRole/Ordinal 同源；概览条门控用）。 */
  compactionEvent?: {role: "generation" | "first-after"; ordinal: number};
  /** P1：模型参数白名单值（来自 context snapshot paramsDetail）。 */
  paramsDetail?: Record<string, unknown>;
  /** 模型故障转移元数据：代理记录的「原模型 → 实际模型」；缺省表示按主模型正常服务。 */
  failover?: CaptureFailover;
  /** 观测通道（双链路观测）：gateway=网关捕获（缺省）；agent_local_import=官方直连本地导入。 */
  origin?: string;
  /** 本次请求实际命中的供应商目标（Agent 维度会话后 target 只在 Step 级表达）。 */
  targetId?: string;
  targetName?: string;
  /** 时间线展示用的每步耗时（毫秒，来自 agent_steps.duration_ms；旧数据为 0）。 */
  durationMs?: number;
  /** Agent 侧原生 Step/消息 ID（业务 Step；缺省表示该 Agent 未上报）。 */
  nativeStepId?: string;
  /** 时间线展示用的每步 token（与账本同源；旧数据为 0）。 */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  /** 计费通道（pay_as_you_go / plan / subscription；旧数据缺省视同按量）。 */
  billingChannel?: string;
  /** 套餐积分消耗与单位（如 zcode 积分；仅套餐/订阅通道携带）。 */
  planCreditCost?: number;
  planCreditUnit?: string;
  /** 入账冻结的套餐成本估算（积分换算后的金额；status=estimated 才可信）。 */
  planEstimatedCost?: number;
  planEstimatedCurrency?: string;
  planEstimatedStatus?: string;
  /** 人民币 nano 物化与入账冻结汇率（2026-09-28）：Step 面板「估算真实成本」人民币口径
   *  优先取 nano/1e9（与 Token 价格页同值）；USD 套餐时 planEstimatedCost 是美元原币。 */
  planEstimatedCostNano?: number;
  planEstimatedFx?: number;
  /** 套餐估算折算明细（月费/额度/窗口，入账冻结）；估算真实成本 ？换算链用（2026-09-23）。 */
  planEstimateDetail?: PlanEstimateDetailInput;
  /** 本次请求采用的模型价格快照，用于历史成本审计；不包含 prompt/response 正文。 */
  pricingSnapshot?: PricingSnapshot;
  /** 本次请求的成本摘要，只保存轻量数字字段，供 UI 总览展示。 */
  tokenCost?: TokenCostSummary;
}

interface IndexedExchange {
  raw: RawCapturedExchange;
  normalized: NormalizedExchange;
  isModelCall: boolean;
  isAuxiliary: boolean;
}

interface MutableAgentSession extends AgentSession {
  normalized: NormalizedExchange[];
  rawExchanges: RawCapturedExchange[];
}

export function deriveAgentSessions(exchanges: RawCapturedExchange[]): AgentSession[] {
  return deriveMutableAgentSessions(exchanges).map(({ normalized: _normalized, rawExchanges: _rawExchanges, ...session }) => session);
}

export function deriveAgentTurns(sessions: AgentSession[]): AgentTurn[] {
  return sessions.map(session => agentTurnFromSession(session));
}

export function buildAgentStep(
  turn: AgentTurn,
  raw: RawCapturedExchange,
  normalized: NormalizedExchange,
  index: number,
  requestActionOverride?: AgentStep["requestAction"]
): AgentStep {
  const stepId = `astep-${stableHash({ turnId: turn.id, exchangeId: raw.exchangeId })}`;
  const streamDiagnostic = raw.response.isStreaming ? refineStreamDiagnostic(raw) : undefined;
  const responseAction = responseActionFor(raw, normalized, streamDiagnostic?.status);
  const requestAction = requestActionOverride ?? requestActionFor(normalized);
  const codexTurn = codexTurnMetadata(raw);
  const toolUseNames = normalized.response.toolUses.map(item => item.name).filter(Boolean);
  return {
    id: stepId,
    turnId: turn.id,
    agentSessionId: turn.agentSessionId,
    exchangeId: raw.exchangeId,
    index,
    timestamp: raw.capturedAt,
    phase: phaseFor(raw, normalized, requestAction, responseAction, streamDiagnostic?.status),
    requestAction,
    responseAction,
    // 压缩请求（opencode/dsh 摘要调用等）常无消息负载、动作只能判 unknown；
    // 有压缩证据时意图直接标注为上下文压缩，不再显示「待识别」。
    requestIntentLabel: normalized.compaction
      ? "上下文压缩"
      : requestIntentLabelFor(requestAction, index),
    responseStatusLabel: responseStatusLabelFor(responseAction, raw.response.status, streamDiagnostic?.status, toolUseNames),
    inputMessageCount: normalized.request.messages.length || undefined,
    inputItemCount: normalized.request.inputItems.length || undefined,
    toolSchemaCount: normalized.request.toolSchemas.length,
    toolUseNames,
    toolUseIds: normalized.response.toolUses.map(item => item.id).filter(Boolean),
    toolResultIds: normalized.harnessPayload.providedToolResults.map(item => item.toolUseId).filter(Boolean),
    stopReason: normalized.response.stopReason,
    streamStatus: streamDiagnostic?.status,
    tokenUsage: normalized.response.usage,
    contextSnapshotId: `ctx-${stableHash({ stepId, exchangeId: raw.exchangeId, normalizerVersion: 1 })}`,
    codexTurnId: codexTurn.turnId,
    codexRequestKind: codexTurn.requestKind,
    codexThreadSource: codexTurn.threadSource,
  };
}

export function codexTurnMetadata(
  raw: RawCapturedExchange,
  parsedMetadata?: Readonly<Record<string, unknown>>
): {
  turnId?: string;
  requestKind?: string;
  threadId?: string;
  parentThreadId?: string;
  subagentKind?: string;
  threadSource?: string;
} {
  const metadata = parsedMetadata ?? jsonObject(raw.request.headers["x-codex-turn-metadata"]);
  const body = objectValue(raw.request.parsedBody);
  const result: ReturnType<typeof codexTurnMetadata> = {};
  const turnId = stringValue(metadata.turn_id);
  const requestKind = stringValue(metadata.request_kind);
  const threadId = firstString(
    raw.request.headers.thread_id,
    raw.request.headers["thread-id"],
    raw.request.headers["x-codex-thread-id"],
    metadata.thread_id,
    body.thread_id
  );
  const parentThreadId = firstString(
    raw.request.headers.parent_thread_id,
    raw.request.headers["parent-thread-id"],
    raw.request.headers["x-codex-parent-thread-id"],
    metadata.parent_thread_id,
    body.parent_thread_id
  );
  const subagentKind = firstString(metadata.subagent_kind, body.subagent_kind);
  const threadSource = firstString(metadata.thread_source, body.thread_source);
  if (turnId) result.turnId = turnId;
  if (requestKind) result.requestKind = requestKind;
  if (threadId) result.threadId = threadId;
  if (parentThreadId) result.parentThreadId = parentThreadId;
  if (subagentKind) result.subagentKind = subagentKind;
  if (threadSource) result.threadSource = threadSource;
  return result;
}

/** 通用 Agent Turn 元数据：Codex 优先，OpenCode 回退到 x-opencode-request。 */
export function agentTurnMetadata(
  raw: RawCapturedExchange,
): ReturnType<typeof codexTurnMetadata> {
  const codex = codexTurnMetadata(raw);
  if (codex.turnId) return codex;
  const opencodeRequestId = stringValue(raw.request.headers["x-opencode-request"]);
  if (opencodeRequestId) {
    return {turnId: opencodeRequestId, requestKind: "turn", threadSource: "user"};
  }
  // 官方直连本地导入（双链路观测）：zcode model_usage.turn_id 经合成头透传，
  // 是 zcode 官方 turn 语义（比内容推断可靠——rollout 请求体不保留消息历史）。
  const zcodeTurnId = stringValue(raw.request.headers["x-zcode-turn-id"]);
  if (zcodeTurnId) {
    return {turnId: zcodeTurnId, requestKind: "turn", threadSource: "user"};
  }
  // dsh 本地导入：session v3 的原生 turn 序号经合成头透传（官方直连 provider 无
  // replayState/responseId，身份标注不可用时差分是唯一兜底，此头消陔回退）。
  const dshTurnId = stringValue(raw.request.headers["x-dsh-turn-id"]);
  if (dshTurnId) {
    return {turnId: dshTurnId, requestKind: "turn", threadSource: "user"};
  }
  return {};
}

function jsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface TurnSegment {
  turn: AgentTurn;
  modelCalls: { raw: RawCapturedExchange; normalized: NormalizedExchange; requestAction: AgentStep["requestAction"] }[];
}

/** 同一 session 内按"新一轮用户输入"切分 turn：每个 user_prompt 请求开启新 turn，
 *  其后的 tool_result / conversation_continue / 重试并入该 turn；session 首条 model call 总开新 turn。
 *  这样一个会话内的多次独立任务执行各自成段，避免被一比一压成单个 turn。
 *  辅助请求（非 turn，如 count_tokens）按时间窗归入覆盖它的 turn。 */
function segmentSessionIntoTurns(session: MutableAgentSession): TurnSegment[] {
  const rawById = new Map(session.rawExchanges.map(item => [item.exchangeId, item]));
  const normalizedById = new Map(session.normalized.map(item => [item.exchangeId, item]));
  const segments: TurnSegment[] = [];
  let current: TurnSegment | undefined;
  let currentNativeTurnId: string | undefined;
  let previousNormalized: NormalizedExchange | undefined;

  for (const exchangeId of session.exchangeIds) {
    const raw = rawById.get(exchangeId);
    const normalized = normalizedById.get(exchangeId);
    if (!raw || !normalized) continue;
    const requestAction = requestActionForTurnBoundary(
      normalized,
      raw,
      currentNativeTurnId,
      previousNormalized,
    );
    const nativeTurn = agentTurnMetadata(raw);
    if (!current || isOpenTurnBoundaryRequestAction(requestAction)) {
      const segmentIndex = segments.length;
      const source: AgentTurn["source"] = segmentIndex === 0
        ? (session.source === "agent-session-header" ? "agent-session" : session.source)
        : "user-prompt";
      current = {
        turn: {
          id: `aturn-${stableHash({
            agentSessionId: session.id,
            segmentationSource: "user-prompt",
            segmentIndex,
            segmentStartExchangeId: exchangeId,
          })}`,
          agentSessionId: session.id,
          agentFingerprintId: session.agentFingerprintId,
          source,
          externalSessionId: session.externalSessionId,
          externalThreadId: session.externalThreadId,
          externalConversationId: session.externalConversationId,
          nativeTurnId: nativeTurn.turnId,
          exchangeIds: [],
          auxiliaryExchangeIds: [],
          startTime: raw.capturedAt,
          endTime: raw.completedAt,
          modelSet: [],
          targetSet: [],
          confidence: session.confidence,
          evidence: segmentIndex === 0
            ? [...session.evidence]
            : [{
                kind: "manual",
                explanation: "同一 session 内由新一轮用户输入开启的 turn 段。",
                evidence: [{ exchangeId, side: "request", path: "messages" }],
              }],
        },
        modelCalls: [],
      };
      segments.push(current);
      currentNativeTurnId = undefined;
    }
    current.turn.exchangeIds.push(exchangeId);
    const model = normalized.request.model || normalized.response.model;
    if (model && !current.turn.modelSet.includes(model)) current.turn.modelSet.push(model);
    if (!current.turn.targetSet.includes(raw.routing.targetId)) current.turn.targetSet.push(raw.routing.targetId);
    if (raw.capturedAt < current.turn.startTime) current.turn.startTime = raw.capturedAt;
    if (raw.completedAt > current.turn.endTime) current.turn.endTime = raw.completedAt;
    current.modelCalls.push({ raw, normalized, requestAction });
    if (nativeTurn.turnId) currentNativeTurnId = nativeTurn.turnId;
    previousNormalized = normalized;
  }

  // session 无 model call（仅 auxiliary）时仍保留一个空 turn，维持"每 session 至少一 turn"的业务结构。
  if (segments.length === 0) {
    segments.push({
      turn: {
        id: `aturn-${stableHash({ agentSessionId: session.id, segmentationSource: "agent-session", segmentStartExchangeId: session.auxiliaryExchangeIds[0] || "" })}`,
        agentSessionId: session.id,
        agentFingerprintId: session.agentFingerprintId,
        source: session.source === "agent-session-header" ? "agent-session" : session.source,
        externalSessionId: session.externalSessionId,
        externalThreadId: session.externalThreadId,
        externalConversationId: session.externalConversationId,
        nativeTurnId: undefined,
        exchangeIds: [],
        auxiliaryExchangeIds: [],
        startTime: session.startTime,
        endTime: session.endTime,
        modelSet: [...session.modelSet],
        targetSet: [...session.targetSet],
        confidence: session.confidence,
        evidence: [...session.evidence],
      },
      modelCalls: [],
    });
  }

  // 辅助请求按时间窗归入对应 turn：落在某 turn 起始时间之后、下一 turn 之前的归前一个 turn
  for (const auxiliaryExchangeId of session.auxiliaryExchangeIds) {
    const auxiliaryRaw = rawById.get(auxiliaryExchangeId);
    const auxiliaryTime = auxiliaryRaw?.capturedAt || "";
    let target = segments[0]!;
    for (const segment of segments) {
      if (segment.turn.startTime <= auxiliaryTime) target = segment;
      else break;
    }
    target.turn.auxiliaryExchangeIds.push(auxiliaryExchangeId);
  }

  return segments;
}

export function deriveAgentArtifacts(exchanges: RawCapturedExchange[]): {
  agentSessions: AgentSession[];
  agentTurns: AgentTurn[];
  steps: AgentStep[];
  contextSnapshots: ObservedContextSnapshot[];
  auxiliaryExchanges: AuxiliaryExchange[];
} {
  const mutableSessions = deriveMutableAgentSessions(exchanges);
  const agentSessions = mutableSessions.map(({ normalized: _normalized, rawExchanges: _rawExchanges, ...session }) => session);
  const agentTurns: AgentTurn[] = [];
  const steps: AgentStep[] = [];
  const contextSnapshots: ObservedContextSnapshot[] = [];
  const auxiliaryExchanges: AuxiliaryExchange[] = [];

  for (const session of mutableSessions) {
    const segments = segmentSessionIntoTurns(session);
    for (const segment of segments) {
      agentTurns.push(segment.turn);
      for (const auxiliaryExchangeId of segment.turn.auxiliaryExchangeIds) {
        const raw = session.rawExchanges.find(item => item.exchangeId === auxiliaryExchangeId);
        if (!raw) continue;
        auxiliaryExchanges.push({
          id: `aux-${stableHash({ turnId: segment.turn.id, exchangeId: auxiliaryExchangeId })}`,
          agentSessionId: session.id,
          agentTurnId: segment.turn.id,
          exchangeId: auxiliaryExchangeId,
          kind: auxiliaryKind(raw),
          timestamp: raw.capturedAt,
          summary: auxiliarySummary(raw),
          evidence: [{ exchangeId: auxiliaryExchangeId, side: "routing", path: "upstreamPath" }],
        });
      }
      let stepIndex = 0;
      for (const { raw, normalized, requestAction } of segment.modelCalls) {
        const step = buildAgentStep(segment.turn, raw, normalized, ++stepIndex, requestAction);
        steps.push(step);
        contextSnapshots.push(buildObservedContextSnapshot(normalized, step.id));
      }
    }
  }

  return { agentSessions, agentTurns, steps, contextSnapshots, auxiliaryExchanges };
}

function deriveMutableAgentSessions(exchanges: RawCapturedExchange[]): MutableAgentSession[] {
  const indexed = exchanges
    .map(raw => ({
      raw,
      normalized: normalizeExchange(raw),
      ...classifyProtocol(raw),
    }))
    .sort((a, b) => new Date(a.raw.capturedAt).getTime() - new Date(b.raw.capturedAt).getTime());
  const sessions = new Map<string, MutableAgentSession>();

  for (const item of indexed) {
    const group = groupKeyFor(item);
    if (group.source === "time-window") {
      const linked = findToolLinkedSession([...sessions.values()], item);
      if (linked) {
        upgradeSessionWithToolLink(linked.session, linked.evidence);
        appendToSession(linked.session, item);
        continue;
      }
    }
    const existing = sessions.get(group.key);
    if (existing) {
      const prefixEvidence = messagePrefixEvidence(existing, item);
      if (prefixEvidence) upgradeSessionWithMessagePrefix(existing, prefixEvidence);
      appendToSession(existing, item);
      continue;
    }
    sessions.set(group.key, createSession(item, group));
  }

  return [...sessions.values()];
}

function groupKeyFor(item: IndexedExchange): {
  key: string;
  source: AgentGroupingSource;
  confidence: Confidence;
  externalSessionId?: string;
  externalThreadId?: string;
  externalConversationId?: string;
  evidence: TurnGroupingEvidence[];
} {
  const fingerprint = fingerprintAgent(item.raw);
  const sessionHint = item.normalized.request.sessionHints.find(hint => hint.kind === "agent-session-header");
  const threadHint = item.normalized.request.sessionHints.find(hint => hint.kind === "thread-header");
  const conversationHint = item.normalized.request.sessionHints.find(hint => hint.kind === "conversation-field");
  const previousResponseHint = item.normalized.request.sessionHints.find(hint => hint.kind === "previous-response-id");
  const clientRequestId = item.raw.request.headers["x-client-request-id"];

  if (sessionHint) {
    const evidence: TurnGroupingEvidence[] = [{
      kind: "agent-session-header",
      value: sessionHint.value,
      explanation: "Agent session header provides an exact external session boundary.",
      evidence: sessionHint.evidence,
    }];
    if (threadHint) evidence.push({
      kind: "thread-header",
      value: threadHint.value,
      explanation: "Thread header is preserved as context continuity evidence.",
      evidence: threadHint.evidence,
    });
    if (clientRequestId) evidence.push({
      kind: "client-request-header",
      value: clientRequestId,
      explanation: "Client request id identifies this request within the external agent session.",
      evidence: [{ exchangeId: item.raw.exchangeId, side: "request", path: "headers.x-client-request-id" }],
    });
    return {
      key: `${fingerprint.agentName}:${item.raw.routing.targetId}:agent-session-header:${sessionHint.value}`,
      source: "agent-session-header",
      confidence: "exact",
      externalSessionId: sessionHint.value,
      externalThreadId: threadHint?.value,
      evidence,
    };
  }
  if (threadHint) {
    return {
      key: `${fingerprint.id}:thread-header:${threadHint.value}`,
      source: "thread-header",
      confidence: "high",
      externalThreadId: threadHint.value,
      evidence: [{
        kind: "thread-header",
        value: threadHint.value,
        explanation: "Thread header provides a high-confidence grouping boundary.",
        evidence: threadHint.evidence,
      }],
    };
  }
  if (conversationHint) {
    return {
      key: `${fingerprint.id}:conversation-field:${conversationHint.value}`,
      source: "conversation-field",
      confidence: "high",
      externalConversationId: conversationHint.value,
      evidence: [{
        kind: "conversation-field",
        value: conversationHint.value,
        explanation: "Conversation field provides provider-side continuity evidence.",
        evidence: conversationHint.evidence,
      }],
    };
  }
  if (previousResponseHint) {
    return {
      key: `${fingerprint.id}:conversation-field:${previousResponseHint.value}`,
      source: "conversation-field",
      confidence: "medium",
      externalConversationId: previousResponseHint.value,
      evidence: [{
        kind: "conversation-field",
        value: previousResponseHint.value,
        explanation: "Previous response id links to provider-side context, but it is not a full external session id.",
        evidence: previousResponseHint.evidence,
      }],
    };
  }
  const model = item.normalized.request.model || item.normalized.response.model || "unknown";
  const bucket = timeWindowBucket(item.raw.capturedAt);
  return {
    key: `${fingerprint.id}:time-window:${item.raw.routing.targetId}:${model}:${bucket}`,
    source: "time-window",
    confidence: "low",
    evidence: [{
      kind: "time-window",
      value: model,
      explanation: "No explicit session id was captured; grouped by fingerprint, target and model.",
      evidence: [{ exchangeId: item.raw.exchangeId, side: "routing", path: "targetId" }],
    }],
  };
}

function createSession(
  item: IndexedExchange,
  group: ReturnType<typeof groupKeyFor>
): MutableAgentSession {
  const fingerprint = fingerprintAgent(item.raw);
  const exchangeIds = item.isModelCall ? [item.raw.exchangeId] : [];
  const auxiliaryExchangeIds = item.isAuxiliary ? [item.raw.exchangeId] : [];
  return {
    id: `asess-${stableHash({
      agentFingerprintId: fingerprint.id,
      source: group.source,
      externalSessionId: group.externalSessionId,
      externalThreadId: group.externalThreadId,
      externalConversationId: group.externalConversationId,
      groupKey: group.key,
    })}`,
    agentFingerprintId: fingerprint.id,
    source: group.source,
    externalSessionId: group.externalSessionId,
    externalThreadId: group.externalThreadId,
    externalConversationId: group.externalConversationId,
    exchangeIds,
    auxiliaryExchangeIds,
    startTime: item.raw.capturedAt,
    endTime: item.raw.completedAt,
    modelSet: modelSetFor([item]),
    targetSet: [item.raw.routing.targetId],
    confidence: group.confidence,
    evidence: group.evidence,
    normalized: [item.normalized],
    rawExchanges: [item.raw],
  };
}

function appendToSession(session: MutableAgentSession, item: IndexedExchange): void {
  if (item.isModelCall) session.exchangeIds.push(item.raw.exchangeId);
  if (item.isAuxiliary) session.auxiliaryExchangeIds.push(item.raw.exchangeId);
  session.startTime = minIso(session.startTime, item.raw.capturedAt);
  session.endTime = maxIso(session.endTime, item.raw.completedAt);
  for (const model of modelSetFor([item])) {
    if (!session.modelSet.includes(model)) session.modelSet.push(model);
  }
  if (!session.targetSet.includes(item.raw.routing.targetId)) session.targetSet.push(item.raw.routing.targetId);
  session.normalized.push(item.normalized);
  session.rawExchanges.push(item.raw);
}

function agentTurnFromSession(session: AgentSession): AgentTurn {
  const source = session.source === "agent-session-header" ? "agent-session" : session.source;
  return {
    id: `aturn-${stableHash({
      agentSessionId: session.id,
      segmentationSource: "agent-session",
      segmentStartExchangeId: session.exchangeIds[0] || session.auxiliaryExchangeIds[0],
    })}`,
    agentSessionId: session.id,
    agentFingerprintId: session.agentFingerprintId,
    source,
    externalSessionId: session.externalSessionId,
    externalThreadId: session.externalThreadId,
    externalConversationId: session.externalConversationId,
    exchangeIds: [...session.exchangeIds],
    auxiliaryExchangeIds: [...session.auxiliaryExchangeIds],
    startTime: session.startTime,
    endTime: session.endTime,
    modelSet: [...session.modelSet],
    targetSet: [...session.targetSet],
    confidence: session.confidence,
    evidence: [...session.evidence],
  };
}

function findToolLinkedSession(
  sessions: MutableAgentSession[],
  item: IndexedExchange
): { session: MutableAgentSession; evidence: TurnGroupingEvidence } | undefined {
  const providedIds = item.normalized.harnessPayload.providedToolResults
    .map(result => result.toolUseId)
    .filter(Boolean);
  if (providedIds.length === 0) return undefined;

  const itemFingerprint = fingerprintAgent(item.raw).id;
  const itemModel = item.normalized.request.model || item.normalized.response.model;
  for (const session of sessions) {
    if (session.agentFingerprintId !== itemFingerprint) continue;
    if (!session.targetSet.includes(item.raw.routing.targetId)) continue;
    if (itemModel && session.modelSet.length > 0 && !session.modelSet.includes(itemModel)) continue;

    for (const previous of session.normalized) {
      const toolUse = previous.response.toolUses.find(use => providedIds.includes(use.id));
      if (!toolUse) continue;
      return {
        session,
        evidence: {
          kind: "tool-link",
          fromExchangeId: previous.exchangeId,
          toExchangeId: item.raw.exchangeId,
          value: toolUse.id,
          explanation: "A provided tool result links back to a previous assistant tool use.",
          evidence: [...toolUse.evidence, ...item.normalized.harnessPayload.providedToolResults
            .filter(result => result.toolUseId === toolUse.id)
            .flatMap(result => result.evidence)],
        },
      };
    }
  }
  return undefined;
}

function upgradeSessionWithToolLink(session: MutableAgentSession, evidence: TurnGroupingEvidence): void {
  if (session.source === "time-window" || session.source === "message-prefix") {
    session.source = "tool-link";
    session.confidence = "high";
    session.evidence = [evidence];
    return;
  }
  if (!session.evidence.some(item =>
    item.kind === "tool-link"
      && item.fromExchangeId === evidence.fromExchangeId
      && item.toExchangeId === evidence.toExchangeId
  )) {
    session.evidence.push(evidence);
  }
}

function messagePrefixEvidence(
  session: MutableAgentSession,
  item: IndexedExchange
): TurnGroupingEvidence | undefined {
  const previous = session.normalized.at(-1);
  if (!previous) return undefined;
  const before = previous.harnessPayload.conversationItems.map(conversationItemStableHash);
  const after = item.normalized.harnessPayload.conversationItems.map(conversationItemStableHash);
  if (before.length === 0 || after.length <= before.length) return undefined;
  if (!before.every((hash, index) => hash === after[index])) return undefined;
  return {
    kind: "message-prefix",
    fromExchangeId: previous.exchangeId,
    toExchangeId: item.raw.exchangeId,
    value: `${before.length}->${after.length}`,
    explanation: "Later request preserves the previous normalized conversation prefix and appends new items.",
    evidence: [
      ...previous.harnessPayload.conversationItems.flatMap(item => item.evidence).slice(0, 5),
      ...item.normalized.harnessPayload.conversationItems.flatMap(item => item.evidence).slice(0, 5),
    ],
  };
}

function conversationItemStableHash(item: NormalizedExchange["harnessPayload"]["conversationItems"][number]): string {
  return item.stableHash;
}

function upgradeSessionWithMessagePrefix(session: MutableAgentSession, evidence: TurnGroupingEvidence): void {
  if (session.source === "time-window") {
    session.source = "message-prefix";
    session.confidence = "medium";
    session.evidence = [evidence];
    return;
  }
  if (!session.evidence.some(item =>
    item.kind === "message-prefix"
      && item.fromExchangeId === evidence.fromExchangeId
      && item.toExchangeId === evidence.toExchangeId
  )) {
    session.evidence.push(evidence);
  }
}

function timeWindowBucket(isoTime: string): number {
  const millis = new Date(isoTime).getTime();
  const normalized = Number.isNaN(millis) ? 0 : millis;
  return Math.floor(normalized / (10 * 60 * 1000));
}

export function requestActionFor(normalized: NormalizedExchange): AgentStep["requestAction"] {
  if (normalized.harnessPayload.providedToolResults.length > 0) return "tool_result";
  if (normalized.request.sessionHints.some(hint => hint.kind === "previous-response-id" || hint.kind === "conversation-field")) {
    return "conversation_continue";
  }
  if (normalized.request.messages.length > 0 || normalized.request.inputItems.length > 0) return "user_prompt";
  return "unknown";
}

/** Turn 边界专用请求动作：
 *  Codex 会在同一业务 session 内用 x-codex-turn-metadata.turn_id 标识真实用户轮次。
 *  新用户 turn 的首个模型请求可能重放上一轮 function_call_output，普通 requestActionFor 会优先判为 tool_result。
 *  这里优先使用明确的 Codex user turn id 变化作为 turn 边界信号，避免多次真实用户输入被压进同一个 turn。
 */
export function requestActionForTurnBoundary(
  normalized: NormalizedExchange,
  raw: RawCapturedExchange,
  activeNativeTurnId?: string,
  previousNormalized?: NormalizedExchange,
): AgentStep["requestAction"] {
  const turn = agentTurnMetadata(raw);
  if (turn.turnId && turn.requestKind === "turn" && turn.threadSource === "user") {
    if (!activeNativeTurnId || activeNativeTurnId !== turn.turnId) return "user_prompt";
    const baseAction = requestActionFor(normalized);
    return baseAction === "user_prompt" ? "conversation_continue" : baseAction;
  }
  // 重试折叠（2026-09-18）：与同 Thread 上一请求 occurrence-aware 完全一致的重发
  // 标记 retry_like 并沿用当前 Turn——claude-code/dsh 的 429/502 重试链此前被
  // 逐请求切成新轮（实测 11 次 502 = 11 个 Turn）。原生 Turn 头（codex）变化时
  // 仍是权威新轮信号，因此该检查放在 native 分支之后。
  if (previousNormalized && identicalRetryRequest(normalized, previousNormalized)) {
    return "retry_like";
  }
  const baseAction = requestActionFor(normalized);
  if (fingerprintAgent(raw).agentName === "dsh") {
    const boundary = dshTurnBoundary(normalized, previousNormalized);
    if (boundary.opensNewTurn) return "user_prompt";
    return baseAction === "user_prompt" ? "conversation_continue" : baseAction;
  }
  return baseAction;
}

/**
 * 重试判定：当前请求与上一请求的 conversation items 在排除 control 后构成
 * 完全相同的 occurrence-aware 多重集（全消耗、零新增、非空）。只比较稳定指纹，
 * 不读取完整正文。
 */
function identicalRetryRequest(
  current: NormalizedExchange,
  previous: NormalizedExchange,
): boolean {
  const before = new Map<string, number>();
  for (const item of previous.harnessPayload.conversationItems) {
    if (item.semanticCategory === "control") continue;
    before.set(item.stableHash, (before.get(item.stableHash) ?? 0) + 1);
  }
  if (before.size === 0) return false;
  let currentNonControlCount = 0;
  let unmatchedCurrentItems = 0;
  for (const item of current.harnessPayload.conversationItems) {
    if (item.semanticCategory === "control") continue;
    currentNonControlCount += 1;
    const count = before.get(item.stableHash) ?? 0;
    if (count > 0) {
      if (count === 1) before.delete(item.stableHash);
      else before.set(item.stableHash, count - 1);
    } else {
      // 当前请求里有上一请求没有的条目（如工具循环新增的 tool_use/tool_result）：
      // 不是字面重发。
      unmatchedCurrentItems += 1;
    }
  }
  return currentNonControlCount > 0 && unmatchedCurrentItems === 0 && before.size === 0;
}

/**
 * dsh 默认适配器没有 HTTP turn/step 头：用同 Thread 上一模型请求的
 * occurrence-aware 消息多重集比较推断 Turn。新增无法由既有历史解释的
 * user 消息时开新候选 Turn；只有 tool result / assistant 历史增长时沿用当前 Turn。
 * 比较只使用已归一化的 conversation items（SQLite 路径使用有界 projection），
 * 不读取完整 raw 历史；无法确认时沿用当前 Turn（置信度 medium/low）。
 */
export function dshTurnBoundary(
  current: NormalizedExchange,
  previous: NormalizedExchange | undefined,
): {opensNewTurn: boolean; confidence: Confidence} {
  if (!previous) return {opensNewTurn: true, confidence: "exact"};
  const before = previous.harnessPayload.conversationItems;
  const after = current.harnessPayload.conversationItems;
  const unused = new Map<string, number>();
  for (const item of before) {
    // control（计数器/compaction 标记等 Plumbing）不参与 Turn 差分。
    if (item.semanticCategory === "control") continue;
    unused.set(item.stableHash, (unused.get(item.stableHash) ?? 0) + 1);
  }
  let newUserItems = 0;
  let newNonUserItems = 0;
  for (const item of after) {
    if (item.semanticCategory === "control") continue;
    const count = unused.get(item.stableHash) ?? 0;
    if (count > 0) {
      if (count === 1) unused.delete(item.stableHash);
      else unused.set(item.stableHash, count - 1);
      continue;
    }
    const turnSignal = item.turnSignal
      ?? (item.semanticCategory === "user_real"
        ? "opens_turn"
        : item.semanticCategory === "tool_result"
          ? "continues_turn"
          : "neutral");
    if (turnSignal === "opens_turn") {
      newUserItems += 1;
    } else {
      newNonUserItems += 1;
    }
  }
  if (newUserItems > 0) return {opensNewTurn: true, confidence: "high"};
  if (newNonUserItems > 0) return {opensNewTurn: false, confidence: "high"};
  return {opensNewTurn: false, confidence: "medium"};
}

/** 判断该请求动作是否开启新一轮 turn：新的用户输入（user_prompt）标志一个独立任务执行的起点，
 *  据此把同一 session 内的多次任务执行切分成多个 turn。供完整派生与轻量索引路径共用。 */
export function isOpenTurnBoundaryRequestAction(action: string): boolean {
  return action === "user_prompt";
}

function responseActionFor(
  raw: RawCapturedExchange,
  normalized: NormalizedExchange,
  streamStatus: StreamDiagnosticStatus | undefined
): AgentStep["responseAction"] {
  if (raw.response.status >= 400 || normalized.response.status === "failed") return "error";
  if (streamStatus && streamStatus !== "complete" && streamStatus !== "unknown") return "incomplete";
  if (normalized.response.toolUses.length > 0) return "tool_use";
  if (normalized.response.finalTextBlocks.length > 0 || normalized.response.outputMessages.length > 0) return "final";
  if (normalized.response.status === "completed") return "final";
  return "unknown";
}

function phaseFor(
  raw: RawCapturedExchange,
  normalized: NormalizedExchange,
  requestAction: AgentStep["requestAction"],
  responseAction: AgentStep["responseAction"],
  streamStatus: StreamDiagnosticStatus | undefined
): AgentStep["phase"] {
  if (raw.response.status >= 400 || responseAction === "error") return "error";
  if (responseAction === "incomplete" || (streamStatus && streamStatus !== "complete" && streamStatus !== "unknown")) {
    return "incomplete";
  }
  if (requestAction === "tool_result" && responseAction === "tool_use") return "tool_loop";
  if (requestAction === "tool_result") return "final_answer";
  if (responseAction === "tool_use" || normalized.response.stopReason === "tool_use") return "tool_request";
  if (responseAction === "final") return "final_answer";
  return "initial_prompt";
}

/** 请求意图基础标签（派生期与读路径还原共用，禁止两处各自维护映射）。 */
export function requestIntentLabelFor(requestAction: AgentStep["requestAction"], index: number): string {
  switch (requestAction) {
    case "retry_like": return "重试";
    case "tool_result": return "续接工具结果";
    case "conversation_continue": return "远端状态续接";
    case "user_prompt": return index <= 1 ? "首次提问" : "新用户输入";
    default: return "待识别";
  }
}

function responseStatusLabelFor(
  responseAction: AgentStep["responseAction"],
  httpStatus: number,
  streamStatus: StreamDiagnosticStatus | undefined,
  toolUseNames: string[]
): string {
  switch (responseAction) {
    case "error": return `上游错误 HTTP ${httpStatus}`;
    case "incomplete":
      // stream_truncated 对应服务商主动声明 response.incomplete，与连接级流中断区分
      if (streamStatus === "stream_truncated") return "不完整";
      return streamStatus ? `流中断（${streamStatusLabel(streamStatus)}）` : "流中断";
    case "tool_use": return `待工具调用（${toolUseNames.join("、") || "未知工具"}）`;
    case "final": return "已完成";
    default: return "待识别";
  }
}

function streamStatusLabel(status: StreamDiagnosticStatus): string {
  switch (status) {
    case "terminal_missing": return "缺少结束标记";
    case "upstream_aborted": return "上游中断";
    case "client_aborted": return "客户端中断";
    case "stream_truncated": return "流被截断";
    case "connection_error": return "连接错误";
    case "upstream_error": return "上游错误";
    case "sse_parse_empty": return "SSE 解析为空";
    default: return "未知";
  }
}

function modelSetFor(items: IndexedExchange[]): string[] {
  return [...new Set(items
    .map(item => item.normalized.request.model || item.normalized.response.model)
    .filter((value): value is string => !!value))];
}

function auxiliaryKind(raw: RawCapturedExchange): AuxiliaryExchange["kind"] {
  const classification = classifyProtocol(raw);
  if (classification.endpointKind === "token-count") return "token_count";
  if (classification.endpointKind === "title-generation") return "title_generation";
  if (raw.response.status === 401 || raw.response.status === 403) return "auth_error";
  if (classification.endpointKind === "health-check") return "health_check";
  if (classification.endpointKind === "metadata") return "metadata";
  return "unknown";
}

function auxiliarySummary(raw: RawCapturedExchange): string {
  const kind = auxiliaryKind(raw);
  if (kind === "token_count") return "Token count auxiliary exchange.";
  if (kind === "auth_error") return `Authentication error HTTP ${raw.response.status}.`;
  return `Auxiliary exchange ${raw.routing.upstreamPath}.`;
}

function minIso(left: string, right: string): string {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function maxIso(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}
