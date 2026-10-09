import type { ProtocolKind } from "./protocol";
import type {
  HarnessConversationItem,
  NormalizedExchange,
  NormalizedHarnessPayload,
} from "./normalizer";
import { stableHash } from "./normalizer";
import { resolveParamsFingerprint } from "./params-fingerprint";
import { diffParamDetails, projectParamDetails, type ParamDetailChange, type ParamDetails } from "./param-details";
import type { CompactionEvidence } from "./compaction-evidence";
import { contextCompositionFor, type ContextComposition } from "./context-composition";
import type { CaptureFailover, EvidencePointer } from "./types";

export interface RemoteStateReference {
  kind: "previous_response_id" | "conversation" | "thread_id";
  value: string;
  observability: "remote_context_not_fully_observable";
  evidence: EvidencePointer[];
}

export interface ObservedContextSnapshot {
  id: string;
  stepId: string;
  exchangeId: string;
  protocol: ProtocolKind;
  model?: string;
  systemPromptHashes: string[];
  developerPromptHashes: string[];
  conversationItemHashes: string[];
  toolSchemaHashes: string[];
  paramsHash: string;
  inputTokenEstimate?: number;
  inputTokenActual?: number;
  outputTokenActual?: number;
  totalTokenActual?: number;
  messageCount?: number;
  inputItemCount?: number;
  toolSchemaCount: number;
  totalStableHash: string;
  harnessPayload: NormalizedHarnessPayload;
  /**
   * 上下文构成估算（一期 D2：估算 + 实际用量校准）。
   * 仅展示参考，不参与任何 identity hash；旧数据无此字段（升级前数据）。
   */
  contextComposition?: ContextComposition;
  /**
   * 模型参数白名单值投影（P1）：reasoning effort / thinking 预算 / max_tokens 等
   * 可查询值；仅展示参考，不参与 paramsHash 身份；旧数据无此字段。
   */
  paramsDetail?: ParamDetails;
  /**
   * 压缩证据（P1 校准）：dsh purpose 头 / 压缩续接摘要标记；缺省表示无证据。
   */
  compaction?: CompactionEvidence;
  /**
   * 模型故障转移元数据：代理记录的「原模型 → 实际模型」转移链；缺省表示按主模型正常服务。
   */
  failover?: CaptureFailover;
  remoteStateReferences: RemoteStateReference[];
  evidence: EvidencePointer[];
}

export interface MessageDiffItem {
  role: string;
  stableHash: string;
  summary: string;
  evidence: EvidencePointer[];
}

export interface ToolResultDiffItem {
  toolUseId: string;
  stableHash: string;
  summary: string;
  evidence: EvidencePointer[];
}

export interface ToolUseDiffItem {
  id: string;
  name: string;
  stableHash: string;
  evidence: EvidencePointer[];
}

export interface FieldDiff {
  path: string;
  beforeHash?: string;
  afterHash?: string;
  summary: string;
  evidence: EvidencePointer[];
}

export interface ToolSchemaDiff {
  added: string[];
  removed: string[];
  changed: FieldDiff[];
  beforeCount: number;
  afterCount: number;
}

export interface ContextTrimmingDiff {
  kind:
    | "message_removed"
    | "tool_result_removed"
    | "reasoning_removed"
    | "system_changed"
    | "remote_state_reference"
    | "compaction_summary_injected"
    | "compaction_purpose_header"
    | "unknown";
  stableHash?: string;
  summary: string;
  confidence: "exact" | "high" | "medium" | "low";
  evidence: EvidencePointer[];
}

export interface StepDiff {
  id: string;
  fromStepId?: string;
  toStepId: string;
  fromSnapshotId?: string;
  toSnapshotId: string;
  addedMessages: MessageDiffItem[];
  removedMessages: MessageDiffItem[];
  addedToolResults: ToolResultDiffItem[];
  removedToolResults: ToolResultDiffItem[];
  addedAssistantToolUses: ToolUseDiffItem[];
  removedAssistantToolUses: ToolUseDiffItem[];
  changedSystem: FieldDiff[];
  changedTools: ToolSchemaDiff;
  changedParams: FieldDiff[];
  /** 白名单参数的值级变化（P1）；旧 diff 无此字段。 */
  changedParamDetails: ParamDetailChange[];
  contextTrimming: ContextTrimmingDiff[];
  tokenDelta?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  summary: string[];
  evidence: EvidencePointer[];
}

export function buildObservedContextSnapshot(
  normalized: NormalizedExchange,
  stepId: string
): ObservedContextSnapshot {
  const systemPromptHashes = normalized.harnessPayload.systemPrompts.map(item => item.textHash);
  const developerPromptHashes = normalized.harnessPayload.developerPrompts.map(item => item.textHash);
  const conversationItemHashes = normalized.harnessPayload.conversationItems.map(item => item.stableHash);
  const toolSchemaHashes = normalized.harnessPayload.toolSchemas.map(item => item.stableHash);
  const paramsFingerprint = resolveParamsFingerprint(
    normalized.harnessPayload.params,
    normalized.harnessPayload.paramsFingerprint,
  );
  const paramsHash = paramsFingerprint.stableHash;
  const harnessPayload = normalized.harnessPayload.paramsFingerprint
    ? normalized.harnessPayload
    : { ...normalized.harnessPayload, paramsFingerprint };
  const remoteStateReferences = remoteStateReferencesFrom(normalized);
  const totalStableHash = stableHash({
    protocol: normalized.protocol,
    model: normalized.request.model,
    systemPromptHashes,
    developerPromptHashes,
    conversationItemHashes,
    toolSchemaHashes,
    paramsHash,
    remoteStateReferences: remoteStateReferences.map(item => `${item.kind}:${item.value}`),
  });

  return {
    id: `ctx-${stableHash({ stepId, exchangeId: normalized.exchangeId, normalizerVersion: 1 })}`,
    stepId,
    exchangeId: normalized.exchangeId,
    protocol: normalized.protocol,
    model: normalized.request.model,
    systemPromptHashes,
    developerPromptHashes,
    conversationItemHashes,
    toolSchemaHashes,
    paramsHash,
    inputTokenActual: normalized.response.usage?.inputTokens,
    outputTokenActual: normalized.response.usage?.outputTokens,
    totalTokenActual: normalized.response.usage?.totalTokens,
    messageCount: normalized.request.messages.length || undefined,
    inputItemCount: normalized.request.inputItems.length || undefined,
    toolSchemaCount: normalized.request.toolSchemas.length,
    totalStableHash,
    harnessPayload,
    contextComposition: contextCompositionFor(normalized, normalized.harnessEvidence),
    paramsDetail: projectParamDetails(normalized.harnessPayload.params),
    compaction: normalized.compaction,
    remoteStateReferences,
    evidence: normalized.harnessPayload.evidence,
  };
}

export function diffContextSnapshots(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot
): StepDiff {
  const addedMessages = diffConversationItems(from, to, "added")
    .filter(item => item.kind !== "tool_result")
    .map(messageDiffItem);
  const removedMessages = diffConversationItems(from, to, "removed")
    .filter(item => item.kind !== "tool_result")
    .map(messageDiffItem);
  const addedToolResults = diffToolResults(from, to, "added");
  const removedToolResults = diffToolResults(from, to, "removed");
  const addedAssistantToolUses = diffToolUses(from, to, "added");
  const removedAssistantToolUses = diffToolUses(from, to, "removed");
  const changedSystem = changedSystemDiff(from, to);
  const changedTools = changedToolSchemaDiff(from, to);
  const changedParams = changedParamsDiff(from, to);
  const contextTrimming = [
    ...removedMessages.map(item => contextTrim("message_removed", item.stableHash, item.summary, item.evidence, "high")),
    ...removedToolResults.map(item => contextTrim("tool_result_removed", item.stableHash, item.summary, item.evidence, "high")),
    ...to.remoteStateReferences.map(ref => contextTrim(
      "remote_state_reference",
      undefined,
      `${ref.kind} references remote provider state ${ref.value}.`,
      ref.evidence,
      "exact"
    )),
    ...(to.compaction
      ? [contextTrim(
          to.compaction.kind === "purpose_header"
            ? "compaction_purpose_header"
            : "compaction_summary_injected",
          undefined,
          to.compaction.kind === "purpose_header"
            ? `压缩请求（官方 purpose 头：${to.compaction.preview}）。`
            : `压缩续接摘要注入（${to.compaction.markerKind ?? "summary"}）：${to.compaction.preview}`,
          to.evidence,
          to.compaction.confidence,
        )]
      : []),
  ];
  const summary = [
    addedMessages.length ? `新增 ${addedMessages.length} 个 conversation item。` : "",
    removedMessages.length ? `移除 ${removedMessages.length} 个 conversation item。` : "",
    addedToolResults.length ? `新增 ${addedToolResults.length} 个 tool result。` : "",
    removedToolResults.length ? `移除 ${removedToolResults.length} 个 tool result。` : "",
    to.remoteStateReferences.length ? "本 step 使用远端上下文引用，完整上下文不可完全观测。" : "",
  ].filter(Boolean);

  return {
    id: `diff-${stableHash({
      fromSnapshotId: from?.id,
      toSnapshotId: to.id,
      normalizerVersion: 1,
    })}`,
    fromStepId: from?.stepId,
    toStepId: to.stepId,
    fromSnapshotId: from?.id,
    toSnapshotId: to.id,
    addedMessages,
    removedMessages,
    addedToolResults,
    removedToolResults,
    addedAssistantToolUses,
    removedAssistantToolUses,
    changedSystem,
    changedTools,
    changedParams,
    changedParamDetails: diffParamDetails(from?.paramsDetail, to.paramsDetail),
    contextTrimming,
    tokenDelta: tokenDelta(from, to),
    summary,
    evidence: [...(from?.evidence || []), ...to.evidence, ...to.remoteStateReferences.flatMap(item => item.evidence)],
  };
}

function remoteStateReferencesFrom(normalized: NormalizedExchange): RemoteStateReference[] {
  return normalized.request.sessionHints
    .filter(hint => hint.kind === "previous-response-id" || hint.kind === "conversation-field")
    .map(hint => ({
      kind: hint.kind === "previous-response-id"
        ? "previous_response_id"
        : "conversation",
      value: hint.value,
      observability: "remote_context_not_fully_observable",
      evidence: hint.evidence,
    }));
}

function diffConversationItems(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot,
  direction: "added" | "removed"
): HarnessConversationItem[] {
  const before = from?.harnessPayload.conversationItems || [];
  const after = to.harnessPayload.conversationItems;
  const referenceCounts = occurrenceCountsByStableHash(direction === "added" ? before : after);
  const source = direction === "added" ? after : before;
  return source.filter(item => {
    const remaining = referenceCounts.get(item.stableHash) ?? 0;
    if (remaining <= 0) return true;
    referenceCounts.set(item.stableHash, remaining - 1);
    return false;
  });
}

function occurrenceCountsByStableHash(items: HarnessConversationItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.stableHash, (counts.get(item.stableHash) ?? 0) + 1);
  }
  return counts;
}

function diffToolResults(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot,
  direction: "added" | "removed"
): ToolResultDiffItem[] {
  const items = diffConversationItems(from, to, direction).filter(item => item.kind === "tool_result");
  return items.map(item => ({
    toolUseId: item.toolUseId || "",
    stableHash: item.stableHash,
    summary: item.toolUseId ? `Tool result for ${item.toolUseId}` : "Tool result",
    evidence: item.evidence,
  }));
}

function diffToolUses(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot,
  direction: "added" | "removed"
): ToolUseDiffItem[] {
  const before = from?.harnessPayload.requestedToolUses || [];
  const after = to.harnessPayload.requestedToolUses;
  const reference = new Set((direction === "added" ? before : after).map(item => item.id));
  const source = direction === "added" ? after : before;
  return source.filter(item => !reference.has(item.id)).map(item => ({
    id: item.id,
    name: item.name,
    stableHash: stableHash({ id: item.id, name: item.name, input: item.input }),
    evidence: item.evidence,
  }));
}

function messageDiffItem(item: HarnessConversationItem): MessageDiffItem {
  return {
    role: item.role || "unknown",
    stableHash: item.stableHash,
    summary: `${item.kind}${item.role ? ` (${item.role})` : ""}`,
    evidence: item.evidence,
  };
}

function changedSystemDiff(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot
): FieldDiff[] {
  const beforeHash = stableHash(from?.systemPromptHashes || []);
  const afterHash = stableHash(to.systemPromptHashes);
  if (!from || beforeHash === afterHash) return [];
  return [{
    path: "systemPromptHashes",
    beforeHash,
    afterHash,
    summary: "System prompts changed.",
    evidence: to.evidence,
  }];
}

function changedToolSchemaDiff(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot
): ToolSchemaDiff {
  const before = from?.harnessPayload.toolSchemas || [];
  const after = to.harnessPayload.toolSchemas;
  const beforeNames = new Set(before.map(item => item.name));
  const afterNames = new Set(after.map(item => item.name));
  return {
    added: after.filter(item => !beforeNames.has(item.name)).map(item => item.name),
    removed: before.filter(item => !afterNames.has(item.name)).map(item => item.name),
    changed: [],
    beforeCount: before.length,
    afterCount: after.length,
  };
}

function changedParamsDiff(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot
): FieldDiff[] {
  if (!from || from.paramsHash === to.paramsHash) return [];
  return [{
    path: "params",
    beforeHash: from.paramsHash,
    afterHash: to.paramsHash,
    summary: "Request params changed.",
    evidence: to.evidence,
  }];
}

function contextTrim(
  kind: ContextTrimmingDiff["kind"],
  stableHashValue: string | undefined,
  summary: string,
  evidence: EvidencePointer[],
  confidence: ContextTrimmingDiff["confidence"]
): ContextTrimmingDiff {
  return {
    kind,
    stableHash: stableHashValue,
    summary,
    confidence,
    evidence,
  };
}

function tokenDelta(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot
): StepDiff["tokenDelta"] {
  const beforeInput = from?.inputTokenActual;
  const afterInput = to.inputTokenActual;
  if (beforeInput === undefined || afterInput === undefined) return undefined;
  const beforeOutput = from?.outputTokenActual ?? 0;
  const afterOutput = to.outputTokenActual ?? 0;
  const beforeTotal = from?.totalTokenActual ?? beforeInput + beforeOutput;
  const afterTotal = to.totalTokenActual ?? afterInput + afterOutput;
  return {
    inputTokens: afterInput - beforeInput,
    outputTokens: afterOutput - beforeOutput,
    totalTokens: afterTotal - beforeTotal,
  };
}
