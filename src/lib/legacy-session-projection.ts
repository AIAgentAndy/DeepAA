import type { CaptureIndexRecord } from "./capture-index";
import type {
  AgentGroupingSource,
  AgentSession,
  TurnGroupingEvidence,
} from "./harness/agent";
import { stableHash } from "./harness/normalizer";
import type { Confidence } from "./harness/types";

/**
 * 仅供旧增量派生器处理调用方已经限制好的索引批次；不得在此模块主动读取旧索引。
 */
export function lightweightAgentSessionFromRecords(
  records: CaptureIndexRecord[],
): AgentSession {
  if (records.length === 0) {
    throw new RangeError("轻量 Session 投影至少需要一条有界索引记录");
  }
  const sorted = [...records].sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt)
      || left.filePath.localeCompare(right.filePath)
      || left.byteOffset - right.byteOffset
  );
  const first = sorted[0]!;
  const source = first.agentGroupingSource || "time-window";
  const agentFingerprintId = first.agentFingerprintId
    || `fp-${first.agentName}-${first.targetFormatHint}-${first.targetId}`;
  const groupKey = first.agentGroupKey || fallbackAgentGroupKey(first);
  return {
    id: `asess-${stableHash({
      agentFingerprintId,
      source,
      externalSessionId: first.externalSessionId,
      externalThreadId: first.externalThreadId,
      externalConversationId: first.externalConversationId,
      groupKey,
    })}`,
    agentFingerprintId,
    source,
    externalSessionId: first.externalSessionId,
    externalThreadId: first.externalThreadId,
    externalConversationId: first.externalConversationId,
    exchangeIds: sorted
      .filter(record => record.isModelCall !== false && record.isAuxiliary !== true)
      .map(record => record.exchangeId),
    auxiliaryExchangeIds: sorted
      .filter(record => record.isAuxiliary === true)
      .map(record => record.exchangeId),
    startTime: first.capturedAt,
    endTime: sorted.at(-1)?.completedAt || sorted.at(-1)?.capturedAt || "",
    modelSet: uniqueSorted(sorted
      .map(record => record.model)
      .filter((value): value is string => Boolean(value))),
    targetSet: uniqueSorted(sorted.map(record => record.targetId)),
    confidence: first.agentGroupingConfidence
      || confidenceForSource(source),
    evidence: lightweightGroupingEvidence(first, source),
  };
}

function confidenceForSource(source: AgentGroupingSource): Confidence {
  if (source === "agent-session-header") return "exact";
  if (
    source === "thread-header"
    || source === "conversation-field"
    || source === "tool-link"
  ) return "high";
  return source === "message-prefix" ? "medium" : "low";
}

function fallbackAgentGroupKey(record: CaptureIndexRecord): string {
  if (record.externalSessionId) {
    return `${record.agentName}:${record.targetId}:session:${record.externalSessionId}`;
  }
  if (record.externalThreadId) {
    return `${record.agentFingerprintId || record.agentName}:thread:${record.externalThreadId}`;
  }
  if (record.externalConversationId) {
    return `${record.agentFingerprintId || record.agentName}:conversation:${record.externalConversationId}`;
  }
  const timestamp = Date.parse(record.capturedAt);
  const bucket = Math.floor((Number.isNaN(timestamp) ? 0 : timestamp) / 600_000);
  return `${record.agentFingerprintId || record.agentName}:window:${record.targetId}:${record.model || "unknown"}:${bucket}`;
}

function lightweightGroupingEvidence(
  record: CaptureIndexRecord,
  source: AgentGroupingSource,
): TurnGroupingEvidence[] {
  return [{
    kind: source,
    value: record.externalSessionId
      || record.externalThreadId
      || record.externalConversationId
      || record.model,
    explanation: "旧增量派生批次中的 Agent Session 分组摘要。",
    evidence: [{
      exchangeId: record.exchangeId,
      side: "request",
      path: source === "agent-session-header"
        ? "headers.session_id"
        : "routing.targetId",
    }],
  }];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}
