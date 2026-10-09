/**
 * Context Snapshot 的紧凑存储编解码（2026-09-11 存储瘦身）。
 *
 * 背景：`context_snapshots.summary_json` 平均 141 KB/步，12k 步吃掉 1.7 GB。实测构成：
 * harnessPayload 占 95%，其中 conversationItems 占 70%（每条 15 个字段，含与 `summary`
 * 重复的 stableHash 与长 logicalId 路径）、toolSchemas 占 17%（含 4 个 hash 字段与证据数组）、
 * `conversationItemHashes` 又重复一遍条目哈希（7%）。
 *
 * 本模块只改**存储形态**，不改语义：写入前把 harnessPayload 压成短键结构（数组化 +
 * 单证据路径 + 去掉可推导字段），读取时展开回 `NormalizedHarnessPayload`，所有既有消费方
 * （UI 解析、diff 计算、回填）无需改动。
 *
 * 关键取舍：
 * - stableHash 保留完整 64 位十六进制（diff 正确性依赖它，不做截断）。
 * - logicalId / semanticCategory / provenance / displayPolicy 等在存储侧不落库：
 *   它们是派生期分类信息，diff 与 UI 只消费 kind/role/toolUseId/toolName/summary/哈希。
 * - 证据只保留一条最精确路径（`side|path`，≤96 B），exchangeId 由快照自身提供。
 * - toolSchemas 只留 name/kind/mcpServer/stableHash/tokensEst：定义明细已在内容寻址的
 *   `harness_snapshots` 表中（同清单只存一行），此处重复没有意义。
 */

import type {
  HarnessConversationItem,
  NormalizedContentBlock,
  NormalizedHarnessPayload,
  NormalizedToolResult,
  NormalizedToolSchema,
  NormalizedToolUse,
} from "../harness/normalizer";
import type { EvidencePointer } from "../harness/types";

export interface CompactPromptItem {
  h: string;
  v?: string;
  r?: string;
}
export interface CompactConversationItem {
  h: string;
  k: string;
  r?: string;
  u?: string;
  n?: string;
  p?: string;
}
export interface CompactToolSchema {
  n: string;
  k: "tool" | "mcp";
  m?: string;
  h: string;
  t: number;
}
export interface CompactToolUse {
  i: string;
  n: string;
  y?: string;
}
export interface CompactToolResult {
  u: string;
  e?: boolean;
  y?: string;
}
export interface CompactReasoningItem {
  t: string;
  y?: string;
}

export interface CompactHarnessPayload {
  i: {t: string; c: string};
  sp: CompactPromptItem[];
  dp: CompactPromptItem[];
  ci: CompactConversationItem[];
  ts: CompactToolSchema[];
  ru: CompactToolUse[];
  pr: CompactToolResult[];
  ri: CompactReasoningItem[];
  pa: Record<string, unknown>;
  pf?: string;
  h: string;
}

/** 存储标记：读取侧据此决定是否需要展开（旧数据无此标记，直接当完整结构用）。 */
export const COMPACT_HARNESS_PAYLOAD_KEY = "cx";

const EVIDENCE_PATH_MAX_BYTES = 96;

export function compactHarnessPayload(
  payload: NormalizedHarnessPayload,
  bounded: (value: string, maxBytes: number) => string,
): CompactHarnessPayload {
  return {
    i: {t: payload.intent.type, c: payload.intent.confidence},
    sp: payload.systemPrompts.map(item => compactPromptItem(item, bounded)),
    dp: payload.developerPrompts.map(item => compactPromptItem(item, bounded)),
    ci: payload.conversationItems.map(item => compactConversationItem(item, bounded)),
    ts: payload.toolSchemas.map(item => compactToolSchema(item, bounded)),
    ru: payload.requestedToolUses.map(item => compactToolUse(item, bounded)),
    pr: payload.providedToolResults.map(item => compactToolResult(item, bounded)),
    ri: payload.reasoningItems.map(item => ({
      t: bounded(item.type, 64),
      ...(item.providerType ? {y: bounded(item.providerType, 64)} : {}),
    })),
    pa: payload.params,
    ...(payload.paramsFingerprint ? {pf: payload.paramsFingerprint.stableHash} : {}),
    h: payload.stableHash,
  };
}

export function isCompactHarnessPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.ci)
    && typeof record.h === "string"
    && record.intent === undefined
    && record.conversationItems === undefined;
}

/**
 * 展开为 `NormalizedHarnessPayload`。exchangeId 用于重建证据指针；
 * 丢失的分类字段给出中性缺省值（仅供展示与 diff，不参与身份计算）。
 */
export function expandHarnessPayload(
  compact: CompactHarnessPayload,
  exchangeId: string,
): NormalizedHarnessPayload {
  const evidence = (side: EvidencePointer["side"], path?: string): EvidencePointer[] => [
    {exchangeId, side, path: path || "$"},
  ];
  return {
    intent: {
      type: compact.i.t as NormalizedHarnessPayload["intent"]["type"],
      confidence: compact.i.c as NormalizedHarnessPayload["intent"]["confidence"],
      evidence: evidence("request", "$.intent"),
    },
    systemPrompts: compact.sp.map(item => ({
      textHash: item.h,
      ...(item.v ? {textPreview: item.v} : {}),
      ...(item.r ? {providerRole: item.r} : {}),
      evidence: evidence("request", "$.system"),
    })),
    developerPrompts: compact.dp.map(item => ({
      textHash: item.h,
      ...(item.v ? {textPreview: item.v} : {}),
      ...(item.r ? {providerRole: item.r} : {}),
      evidence: evidence("request", "$.system"),
    })),
    conversationItems: compact.ci.map(item => ({
      kind: item.k,
      semanticCategory: "unknown_input" as HarnessConversationItem["semanticCategory"],
      provenance: "model_input" as HarnessConversationItem["provenance"],
      confidence: "exact" as HarnessConversationItem["confidence"],
      displayPolicy: "conversation" as HarnessConversationItem["displayPolicy"],
      dedupePolicy: "occurrence" as HarnessConversationItem["dedupePolicy"],
      logicalId: item.h,
      providerItemType: item.k,
      ...(item.r ? {role: item.r} : {}),
      ...(item.u ? {toolUseId: item.u} : {}),
      ...(item.n ? {toolName: item.n} : {}),
      summary: `${item.k}${item.r ? `:${item.r}` : ""}`,
      stableHash: item.h,
      evidence: expandEvidence(item.p, exchangeId),
    })),
    toolSchemas: compact.ts.map((item): NormalizedToolSchema => ({
      name: item.n,
      kind: item.k,
      ...(item.m ? {mcpServer: item.m} : {}),
      schemaChars: 0,
      schemaTokensEst: item.t,
      stableHash: item.h,
      evidence: evidence("request", "$.tools"),
    })),
    requestedToolUses: compact.ru.map((item): NormalizedToolUse => ({
      id: item.i,
      name: item.n,
      ...(item.y ? {providerType: item.y} : {}),
      input: undefined,
      evidence: evidence("response", "$.output"),
    })),
    providedToolResults: compact.pr.map((item): NormalizedToolResult => ({
      toolUseId: item.u,
      ...(item.e === undefined ? {} : {isError: item.e}),
      ...(item.y ? {providerType: item.y} : {}),
      evidence: evidence("request", "$.messages"),
    })),
    reasoningItems: compact.ri.map((item): NormalizedContentBlock => ({
      type: item.t,
      ...(item.y ? {providerType: item.y} : {}),
      evidence: evidence("response", "$.output"),
    })),
    params: compact.pa,
    ...(compact.pf
      ? {
        paramsFingerprint: {
          stableHash: compact.pf,
          complete: true,
          candidateItemCount: Object.keys(compact.pa).length,
          processedItemCount: Object.keys(compact.pa).length,
          candidateTextBytes: 0,
          processedTextBytes: 0,
        },
      }
      : {}),
    stableHash: compact.h,
    evidence: evidence("request", "$"),
  };
}

function expandEvidence(compactPath: string | undefined, exchangeId: string): EvidencePointer[] {
  if (!compactPath) return [{exchangeId, side: "request", path: "$"}];
  const separator = compactPath.indexOf("|");
  if (separator <= 0) return [{exchangeId, side: "request", path: compactPath}];
  const side = compactPath.slice(0, separator) as EvidencePointer["side"];
  return [{exchangeId, side, path: compactPath.slice(separator + 1) || "$"}];
}

function compactEvidencePath(
  evidence: EvidencePointer[],
  bounded: (value: string, maxBytes: number) => string,
): string | undefined {
  const first = evidence[0];
  if (!first) return undefined;
  return bounded(`${first.side}|${first.path}`, EVIDENCE_PATH_MAX_BYTES);
}

function compactPromptItem(
  item: NormalizedHarnessPayload["systemPrompts"][number],
  bounded: (value: string, maxBytes: number) => string,
): CompactPromptItem {
  return {
    h: item.textHash,
    ...(item.textPreview ? {v: item.textPreview} : {}),
    ...(item.providerRole ? {r: bounded(item.providerRole, 64)} : {}),
  };
}

function compactConversationItem(
  item: HarnessConversationItem,
  bounded: (value: string, maxBytes: number) => string,
): CompactConversationItem {
  return {
    h: item.stableHash,
    k: bounded(item.kind, 64),
    ...(item.role ? {r: bounded(item.role, 32)} : {}),
    ...(item.toolUseId ? {u: bounded(item.toolUseId, 128)} : {}),
    ...(item.toolName ? {n: bounded(item.toolName, 128)} : {}),
    ...(compactEvidencePath(item.evidence, bounded)
      ? {p: compactEvidencePath(item.evidence, bounded)}
      : {}),
  };
}

function compactToolSchema(
  item: NormalizedToolSchema,
  bounded: (value: string, maxBytes: number) => string,
): CompactToolSchema {
  return {
    n: bounded(item.name, 128),
    k: item.kind,
    ...(item.mcpServer ? {m: bounded(item.mcpServer, 64)} : {}),
    h: item.stableHash,
    t: item.schemaTokensEst,
  };
}

function compactToolUse(
  item: NormalizedToolUse,
  bounded: (value: string, maxBytes: number) => string,
): CompactToolUse {
  return {
    i: bounded(item.id, 128),
    n: bounded(item.name, 128),
    ...(item.providerType ? {y: bounded(item.providerType, 64)} : {}),
  };
}

function compactToolResult(
  item: NormalizedToolResult,
  bounded: (value: string, maxBytes: number) => string,
): CompactToolResult {
  return {
    u: bounded(item.toolUseId, 128),
    ...(item.isError === undefined ? {} : {e: item.isError}),
    ...(item.providerType ? {y: bounded(item.providerType, 64)} : {}),
  };
}

/** 读取侧入口：紧凑结构展开，完整结构原样返回（前向兼容旧数据）。 */
export function maybeExpandHarnessPayload(
  payload: unknown,
  exchangeId: string,
): NormalizedHarnessPayload | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (isCompactHarnessPayload(payload)) {
    return expandHarnessPayload(payload as unknown as CompactHarnessPayload, exchangeId);
  }
  return payload as NormalizedHarnessPayload;
}

/**
 * 归一化存储中的快照对象：展开紧凑 harnessPayload，并按需重建
 * conversationItemHashes（存储侧不再重复落库，可由条目哈希直接推导）。
 */
export function normalizeStoredContextSnapshot<T extends Record<string, unknown>>(
  raw: T,
): T & {harnessPayload?: NormalizedHarnessPayload; conversationItemHashes?: string[]} {
  const exchangeId = typeof raw.exchangeId === "string" ? raw.exchangeId : "";
  const compact = raw[COMPACT_HARNESS_PAYLOAD_KEY];
  const payload = maybeExpandHarnessPayload(compact ?? raw.harnessPayload, exchangeId);
  const storedHashes = Array.isArray(raw.conversationItemHashes)
    ? raw.conversationItemHashes.filter((item): item is string => typeof item === "string")
    : undefined;
  const conversationItemHashes = storedHashes && storedHashes.length > 0
    ? storedHashes
    : payload?.conversationItems.map(item => item.stableHash) ?? [];
  const {[COMPACT_HARNESS_PAYLOAD_KEY]: _compact, ...rest} = raw;
  return {
    ...(rest as T),
    ...(payload ? {harnessPayload: payload} : {}),
    conversationItemHashes,
  };
}
