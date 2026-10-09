import type { EvidencePointer } from "./types";
import type { ObservedContextSnapshot, StepDiff } from "./context-snapshot";
import { stableHash } from "./normalizer";
import type { NormalizedToolUse } from "./normalizer";

export type ContextDiffRowStatus = "unchanged" | "added" | "removed" | "changed";
export type ContextDiffRowKind = "message" | "tool_call" | "tool_result" | "reasoning" | "system" | "param";

export interface ContextDiffRow {
  id: string;
  index: number;
  status: ContextDiffRowStatus;
  kind: ContextDiffRowKind;
  role?: string;
  title: string;
  subtitle?: string;
  preview: string;
  toolUseId?: string;
  toolName?: string;
  stableHash: string;
  evidence: EvidencePointer[];
}

export interface StepContextDiffView {
  fromStepId?: string;
  toStepId: string;
  targetRows: ContextDiffRow[];
  removedRows: ContextDiffRow[];
  changeSummary: {
    addedMessages: number;
    removedMessages: number;
    addedToolResults: number;
    removedToolResults: number;
    addedToolUses: number;
    removedToolUses: number;
    changedParams: number;
    changedTools: number;
  };
  tokenDelta?: StepDiff["tokenDelta"];
}

/**
 * 行级 Context Diff 视图（按需构建，2026-09-11 存储瘦身）。
 *
 * 视图完全可由「上一步 + 当前步」两个快照推导，因此不再落库到 step_diffs；
 * API 读取 diff 时现算，避免每步多存 ~60 KB。`diff` 参数只用于取变化计数与
 * token Δ，允许传入部分字段（存储侧的历史 diff 记录）。
 */
export function buildStepContextDiffView(
  from: ObservedContextSnapshot | undefined,
  to: ObservedContextSnapshot,
  diff?: Partial<StepDiff>
): StepContextDiffView {
  const beforeRows = buildContextRows(from).map(row => ({ ...row, status: "unchanged" as const }));
  const afterRows = buildContextRows(to).map(row => ({ ...row, status: "unchanged" as const }));

  return {
    fromStepId: from?.stepId,
    toStepId: to.stepId,
    targetRows: rowsWithTargetStatus(beforeRows, afterRows),
    removedRows: removedRowsByOccurrence(beforeRows, afterRows),
    changeSummary: {
      addedMessages: diff?.addedMessages?.length ?? 0,
      removedMessages: diff?.removedMessages?.length ?? 0,
      addedToolResults: diff?.addedToolResults?.length ?? 0,
      removedToolResults: diff?.removedToolResults?.length ?? 0,
      addedToolUses: diff?.addedAssistantToolUses?.length ?? 0,
      removedToolUses: diff?.removedAssistantToolUses?.length ?? 0,
      changedParams: diff?.changedParams?.length ?? 0,
      changedTools: (diff?.changedTools?.added.length ?? 0)
        + (diff?.changedTools?.removed.length ?? 0)
        + (diff?.changedTools?.changed.length ?? 0),
    },
    tokenDelta: diff?.tokenDelta,
  };
}

function buildContextRows(snapshot: ObservedContextSnapshot | undefined): ContextDiffRow[] {
  if (!snapshot) return [];
  const rows: ContextDiffRow[] = [];
  const occurrenceByHash = new Map<string, number>();
  const nextRowId = (stableHashValue: string) => {
    const occurrence = occurrenceByHash.get(stableHashValue) ?? 0;
    occurrenceByHash.set(stableHashValue, occurrence + 1);
    return `${snapshot.stepId}:${stableHashValue}:${occurrence}`;
  };
  for (const item of snapshot.harnessPayload.conversationItems) {
    rows.push({
      id: nextRowId(item.stableHash),
      index: rows.length,
      status: "unchanged",
      kind: rowKindForConversationItem(item.kind),
      role: item.role,
      title: rowTitleForConversationItem(item),
      subtitle: rowSubtitleForConversationItem(item),
      preview: item.summary || rowPreviewForEvidence(item.evidence),
      toolUseId: item.toolUseId,
      toolName: item.toolName,
      stableHash: item.stableHash,
      evidence: item.evidence,
    });
  }
  for (const toolUse of snapshot.harnessPayload.requestedToolUses) {
    const stableHashValue = toolUseStableHash(toolUse);
    if (rows.some(row => row.stableHash === stableHashValue)) continue;
    rows.push({
      id: nextRowId(stableHashValue),
      index: rows.length,
      status: "unchanged",
      kind: "tool_call",
      title: `工具调用 ${toolUse.name || "unknown"}`,
      subtitle: toolUse.id,
      preview: compactPreview(toolUse.input),
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      stableHash: stableHashValue,
      evidence: toolUse.evidence,
    });
  }
  return rows.map((row, index) => ({ ...row, index }));
}

function rowsWithTargetStatus(
  beforeRows: ContextDiffRow[],
  afterRows: ContextDiffRow[]
): ContextDiffRow[] {
  const unmatchedBefore = occurrenceCounts(beforeRows);
  return afterRows.map(row => {
    const remaining = unmatchedBefore.get(row.stableHash) ?? 0;
    if (remaining <= 0) return { ...row, status: "added" };
    unmatchedBefore.set(row.stableHash, remaining - 1);
    return row;
  });
}

function removedRowsByOccurrence(
  beforeRows: ContextDiffRow[],
  afterRows: ContextDiffRow[]
): ContextDiffRow[] {
  const unmatchedAfter = occurrenceCounts(afterRows);
  return beforeRows.flatMap(row => {
    const remaining = unmatchedAfter.get(row.stableHash) ?? 0;
    if (remaining > 0) {
      unmatchedAfter.set(row.stableHash, remaining - 1);
      return [];
    }
    return [{ ...row, status: "removed" as const }];
  });
}

function occurrenceCounts(rows: ContextDiffRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.stableHash, (counts.get(row.stableHash) ?? 0) + 1);
  }
  return counts;
}

function rowKindForConversationItem(kind: string): ContextDiffRowKind {
  if (kind === "tool_result") return "tool_result";
  if (kind === "tool_use") return "tool_call";
  return "message";
}

function rowTitleForConversationItem(item: ObservedContextSnapshot["harnessPayload"]["conversationItems"][number]): string {
  if (item.kind === "tool_result") return `工具结果 ${item.toolUseId || "unknown"}`;
  if (item.kind === "tool_use") return `工具调用 ${item.toolName || "unknown"}`;
  if (item.role) return `${roleLabel(item.role)} 消息`;
  return item.kind;
}

function rowSubtitleForConversationItem(item: ObservedContextSnapshot["harnessPayload"]["conversationItems"][number]): string | undefined {
  if (item.toolUseId && item.toolName) return `${item.toolUseId} · ${item.toolName}`;
  return item.toolUseId || item.toolName;
}

function roleLabel(role: string): string {
  if (role === "assistant") return "Assistant";
  if (role === "user") return "User";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  return role;
}

function rowPreviewForEvidence(evidence: EvidencePointer[]): string {
  const first = evidence[0];
  if (!first) return "无证据路径";
  return `${first.side}:${first.path}`;
}

function toolUseStableHash(item: NormalizedToolUse): string {
  return stableHash({ id: item.id, name: item.name, input: item.input });
}

function compactPreview(value: unknown): string {
  if (value === undefined || value === null || value === "") return "无参数";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}
