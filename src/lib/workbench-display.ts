import type { NormalizedUsage } from "./harness/normalizer";
import type { TokenUsageSummary } from "./harness/stream-response";
import {
  conversationContentKindsFor,
  conversationFingerprintKey,
  isMediaOnlyConversationPreview,
  ALL_CONVERSATION_SEMANTIC_CATEGORIES,
  type ConversationContentKind,
  type ConversationDisplayPolicy,
  type ConversationProvenance,
  type ConversationSemanticCategory,
} from "./conversation-semantics";

export interface TreeCollapseGroup {
  key: string;
  sessions: Array<{
    session: { id: string };
    turns: Array<{ turn: { id: string } }>;
  }>;
}

export interface ActiveTreePath {
  groupKey: string;
  sessionId: string;
  turnId?: string;
  expandedKeys: Set<string>;
}

export interface WorkbenchUrlSelection {
  target?: string;
  agent?: string;
  session?: string;
  turn?: string;
  step?: string;
}

export interface ResolvedWorkbenchSelection {
  sessionId: string;
  turnId?: string;
  exchangeId?: string;
}

export interface CompleteWorkbenchAggregate {
  requestCount: number;
  stepRequestCount: number;
  auxiliaryRequestCount: number;
  durationTotalMs: number;
  durationSampleCount: number;
  toolCallCount: number;
  toolCallsByName: Record<string, number>;
}

/**
 * 完整 Session 可能包含未加载的历史请求；从当前轻量 evidence 中查找任意已知请求，
 * 避免仅因首条历史请求不在内存中就丢失 Agent URL 参数。
 */
export function agentNameFromSessionEvidence(
  exchangeIds: string[],
  auxiliaryExchangeIds: string[],
  exchanges: Array<{ exchangeId: string; agentName: string }>,
): string | undefined {
  const sessionExchangeIds = new Set([...exchangeIds, ...auxiliaryExchangeIds]);
  return exchanges.find(item => sessionExchangeIds.has(item.exchangeId))?.agentName;
}

export function hasCompleteWorkbenchAggregate(value: unknown): value is CompleteWorkbenchAggregate {
  if (!value || typeof value !== "object") return false;
  const aggregate = value as Record<string, unknown>;
  const numericFields = [
    "requestCount",
    "stepRequestCount",
    "auxiliaryRequestCount",
    "durationTotalMs",
    "durationSampleCount",
    "toolCallCount",
  ];
  return numericFields.every(field => typeof aggregate[field] === "number" && Number.isFinite(aggregate[field]))
    && Boolean(aggregate.toolCallsByName)
    && typeof aggregate.toolCallsByName === "object"
    && !Array.isArray(aggregate.toolCallsByName);
}

export function toolCallSummary(toolCallsByName: Record<string, number>, limit = 4): string {
  const entries = Object.entries(toolCallsByName)
    .filter(([name, count]) => Boolean(name) && Number.isFinite(count) && count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (entries.length === 0) return "无工具调用";
  const visible = entries.slice(0, limit).map(([name, count]) => `${name} ×${count}`);
  const remaining = entries.length - visible.length;
  return [...visible, remaining > 0 ? `另 ${remaining} 种` : undefined]
    .filter((item): item is string => !!item)
    .join(" · ");
}

/** URL 恢复按 Step -> Turn -> Session 降级，父级参数冲突时以更具体的有效对象为准。 */
export function resolveWorkbenchSelection(
  selection: WorkbenchUrlSelection,
  sessions: Array<{ id: string; targetSet?: string[]; agentName?: string }>,
  turns: Array<{ id: string; agentSessionId: string; exchangeIds: string[] }>,
): ResolvedWorkbenchSelection | undefined {
  if (selection.step) {
    const owner = turns.find(turn => turn.exchangeIds.includes(selection.step!));
    if (owner) return { sessionId: owner.agentSessionId, turnId: owner.id, exchangeId: selection.step };
  }
  if (selection.turn) {
    const owner = turns.find(turn => turn.id === selection.turn);
    if (owner) return { sessionId: owner.agentSessionId, turnId: owner.id };
  }
  if (selection.session && sessions.some(session => session.id === selection.session)) {
    return { sessionId: selection.session };
  }
  if (selection.target || selection.agent) {
    const session = sessions.find(item => (
      (!selection.target || item.targetSet?.includes(selection.target))
      && (!selection.agent || item.agentName === selection.agent)
    ));
    if (session) {
      return {
        sessionId: session.id,
        turnId: turns.find(turn => turn.agentSessionId === session.id)?.id,
      };
    }
  }
  return undefined;
}

export function defaultCollapsedTreeKeys(groups: TreeCollapseGroup[]): Set<string> {
  const collapsed = new Set<string>();
  const latestGroup = groups[0];
  const latestSessionId = latestGroup?.sessions[0]?.session.id;
  for (const group of groups) {
    if (group.key !== latestGroup?.key) collapsed.add(group.key);
    for (const item of group.sessions) {
      if (item.session.id !== latestSessionId) collapsed.add(item.session.id);
    }
  }
  return collapsed;
}

export function reconcileCollapsedTreeKeys(input: {
  groups: TreeCollapseGroup[];
  currentCollapsed: Set<string>;
  touchedKeys: Set<string>;
  forcedExpandedKeys?: Set<string>;
}): Set<string> {
  const knownKeys = treeCollapseKeys(input.groups);
  const defaults = input.forcedExpandedKeys && input.forcedExpandedKeys.size > 0
    ? knownKeys
    : defaultCollapsedTreeKeys(input.groups);
  const next = new Set<string>();
  for (const key of knownKeys) {
    if (input.touchedKeys.has(key)) {
      if (input.currentCollapsed.has(key)) next.add(key);
      continue;
    }
    if (input.forcedExpandedKeys?.has(key)) continue;
    if (defaults.has(key)) next.add(key);
  }
  return next;
}

export function formatStepToolSummary(step: {
  toolUseNames: string[];
  toolUseIds: string[];
  toolResultIds?: string[];
  toolSchemaCount: number;
  requestIntentLabel?: string;
}): string {
  const callCount = step.toolUseIds.length > 0 ? step.toolUseIds.length : step.toolUseNames.length;
  const callsByName = new Map<string, number>();
  for (const name of step.toolUseNames.filter(Boolean)) {
    callsByName.set(name, (callsByName.get(name) || 0) + 1);
  }
  const parts: string[] = [];
  if (callCount > 0) {
    const namedCalls = [...callsByName.entries()].map(([name, count]) => `${name} ×${count}`);
    parts.push(`调用 ${namedCalls.length > 0 ? namedCalls.join("、") : `工具 ×${callCount}`}`);
  }
  const resultCount = step.toolResultIds?.length ?? 0;
  if (resultCount > 0) parts.push(`回填 ${resultCount} 个工具结果`);
  if (parts.length === 0) parts.push("无工具动作");
  if (step.toolSchemaCount > 0) parts.push(`本请求携带 ${step.toolSchemaCount} 个工具定义`);
  if (step.requestIntentLabel === "远端状态续接" && step.toolSchemaCount === 0) {
    parts.push("沿用远端工具上下文");
  }
  return parts.join(" · ");
}

/** 聚合刷新键必须包含范围版本，避免同一 Session/Turn 新增请求后继续复用旧结果。 */
export function workbenchAggregateRefreshKey(input: {
  level: "session" | "turn";
  sessionId?: string;
  turnId?: string;
  scopeVersion: string;
}): string {
  const scopeId = input.level === "session" ? input.sessionId : input.turnId;
  return `${input.level}:${scopeId || ""}:${input.scopeVersion}`;
}

export function activeTreePathForSelection(
  groups: TreeCollapseGroup[],
  selection: { selectedTurnId?: string; selectedSessionId?: string },
): ActiveTreePath | undefined {
  if (selection.selectedTurnId) {
    for (const group of groups) {
      for (const item of group.sessions) {
        if (item.turns.some(turnItem => turnItem.turn.id === selection.selectedTurnId)) {
          return activeTreePath(group.key, item.session.id, selection.selectedTurnId);
        }
      }
    }
  }

  if (selection.selectedSessionId) {
    for (const group of groups) {
      for (const item of group.sessions) {
        if (item.session.id === selection.selectedSessionId) {
          return activeTreePath(group.key, item.session.id);
        }
      }
    }
  }

  return undefined;
}

function activeTreePath(groupKey: string, sessionId: string, turnId?: string): ActiveTreePath {
  return {
    groupKey,
    sessionId,
    turnId,
    expandedKeys: new Set([groupKey, sessionId]),
  };
}

function treeCollapseKeys(groups: TreeCollapseGroup[]): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    keys.add(group.key);
    for (const item of group.sessions) keys.add(item.session.id);
  }
  return keys;
}

export function tokenUsageSummaryFromStep(step: { tokenUsage?: NormalizedUsage } | undefined): TokenUsageSummary {
  const usage = step?.tokenUsage;
  if (!usage) return unavailableTokenUsage("当前步骤没有可展示的 usage 元数据。");
  if (usage.source === "unavailable") return unavailableTokenUsage("服务商未返回可用 usage。");
  const estimated = usage.source === "estimated";
  return {
    inputTokens: usage.inputTokens,
    totalInputTokens: usage.totalInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    source: estimated ? "tokenizer_estimated" : "provider_usage",
    usageConfidence: estimated ? "medium" : "exact",
    sourceLabel: estimated ? "tokenizer 估算" : "服务商 usage",
    note: estimated
      ? "来自步骤派生元数据的 tokenizer 估算值，仅供参考。"
      : "来自步骤派生元数据中的服务商 usage；无需等待 raw evidence 加载即可展示。",
  };
}

export type OverviewTokenUsageSource = "raw" | "step" | "unavailable";

export interface OverviewEvidenceStep {
  id: string;
  exchangeId: string;
  turnId: string;
  index: number;
}

export interface OverviewEvidenceRequest {
  stepId?: string;
  exchangeId: string;
}

export interface ProjectionOverviewItem {
  side: "request" | "response";
  semanticType?: "call_output";
  role?: string;
  itemType: string;
  jsonPath: string;
  textPreview?: string;
  textSha256: string;
  toolName?: string;
  toolUseId?: string;
  mediaDescriptorOrdinals?: number[];
  semanticCategory?: ConversationSemanticCategory;
  provenance?: ConversationProvenance;
  displayPolicy?: ConversationDisplayPolicy;
  contentKinds?: ConversationContentKind[];
  conversationCategory?: ConversationSemanticCategory;
}

export interface ProjectionOverview {
  previewState: "complete" | "limited" | "unavailable" | "not_materialized" | "integrity_failed";
  preview: {
    protocol?: string;
    items: ProjectionOverviewItem[];
    overviewCandidates?: ProjectionOverviewItem[];
  };
}

const OVERVIEW_CATEGORY_PRIORITY = {
  request: [
    "user_real",
    "user_injected",
    "tool_result",
    "developer",
    "system",
    "control",
    "unknown_input",
  ],
  response: [
    "refusal",
    "assistant",
    "tool_use",
    "tool_result",
    "reasoning",
    "control",
    "unknown_output",
  ],
} as const;

/**
 * 首页只消费 SQLite 有界 Preview。Request 按结构化多重集与上一模型请求做差集；
 * Response 不排重，只把连续 SSE 文本片段合并为逻辑项。两侧最终都只选择最接近
 * 真实用户输入或模型回复的一个代表项，同类别存在多项时选择最后一项。
 */
export function projectionOverviewSideSummary(
  current: ProjectionOverview | undefined,
  previous: ProjectionOverview | undefined,
  side: "request" | "response",
): string | undefined {
  if (!current) return undefined;
  const currentItems = overviewItems(current.preview);
  const previousItems = previous ? overviewItems(previous.preview) : [];
  const previousCounts = side === "request"
    ? previewFingerprintCounts(previousItems, previous?.preview.protocol)
    : new Map<string, number>();
  const segments: Array<{
    category: string;
    key: string;
    label: string;
    text: string;
    mediaOnly: boolean;
    toolUseId?: string;
  }> = [];

  for (const item of currentItems) {
    if (item.side !== side || !item.textPreview?.trim()) continue;
    const category = overviewPreviewCategory(item, current.preview.protocol);
    if (!category) continue;
    if (side === "request") {
      const fingerprint = overviewPreviewFingerprint(item, category);
      const count = previousCounts.get(fingerprint) ?? 0;
      if (count > 0) {
        previousCounts.set(fingerprint, count - 1);
        continue;
      }
    }
    const label = overviewCategoryLabel(category, item.toolName);
    const key = `${category}:${item.toolName ?? ""}:${item.toolUseId ?? ""}`;
    const rawText = item.textPreview ?? "";
    const text = rawText.trim();
    const mediaOnly = isMediaOnlyConversationPreview(
      item.textPreview,
      item.mediaDescriptorOrdinals,
    );
    const prior = segments.at(-1);
    if (side === "response" && prior?.key === key) {
      // 同一逻辑项（同 toolUseId 的流式片段 或 delta 片段）必须直接拼接，
      // 且保留片段内部空白（' r' 等前导空格），否则 custom_tool_call / reasoning
      // 等碎片会被 \n 断开成逐字一行，或丢失代码内空格。
      const sameStream = !!item.toolUseId || !!prior.toolUseId || isDeltaPreviewType(item.itemType);
      if (sameStream) prior.text += rawText;
      else if (prior.text !== text) prior.text += `\n${text}`;
      prior.mediaOnly = prior.mediaOnly && mediaOnly;
      continue;
    }
    segments.push({ category, key, label, text, mediaOnly, toolUseId: item.toolUseId });
  }

  for (const category of OVERVIEW_CATEGORY_PRIORITY[side]) {
    for (const mediaOnly of [false, true]) {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment?.category !== category || segment.mediaOnly !== mediaOnly) continue;
        return compactOverviewText(`[${segment.label}]\n${segment.text}`, 1_600);
      }
    }
  }
  if (current.previewState === "not_materialized") return "历史记录尚未生成正文预览。";
  if (current.previewState === "integrity_failed") return "正文完整性校验失败。";
  if (current.previewState === "unavailable") return "正文预览当前不可用。";
  return undefined;
}

function previewFingerprintCounts(
  items: ProjectionOverviewItem[],
  protocol?: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.side !== "request") continue;
    const category = overviewPreviewCategory(item, protocol);
    if (!category) continue;
    const key = overviewPreviewFingerprint(item, category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function overviewPreviewFingerprint(item: ProjectionOverviewItem, category: string): string {
  if (!isConversationSemanticCategory(category) || !item.provenance) return "";
  return conversationFingerprintKey({
    category,
    side: "input",
    provenance: item.provenance,
    providerItemType: item.itemType,
    textSha256: item.textSha256,
    contentKinds: item.contentKinds
      ?? conversationContentKindsFor(
        item.itemType,
        (item.mediaDescriptorOrdinals?.length ?? 0) > 0,
      ),
    toolName: item.toolName,
    toolUseId: item.toolUseId,
  });
}

function overviewPreviewCategory(
  item: ProjectionOverviewItem,
  protocol?: string,
): string | undefined {
  void protocol;
  return item.conversationCategory
    ?? (item.displayPolicy === "conversation"
      ? item.semanticCategory
      : undefined);
}

function overviewItems(preview: ProjectionOverview["preview"]): ProjectionOverviewItem[] {
  const items = preview.items.map(item => ({ ...item }));
  for (const candidate of preview.overviewCandidates ?? []) {
    const index = items.findIndex(item =>
      item.side === candidate.side
      && item.textSha256 === candidate.textSha256
      && item.jsonPath === candidate.jsonPath
      && item.toolName === candidate.toolName
      && item.toolUseId === candidate.toolUseId);
    if (index >= 0) items[index] = { ...items[index], ...candidate };
    else items.push({ ...candidate });
  }
  return items;
}

function isDeltaPreviewType(itemType: string): boolean {
  const type = itemType.toLowerCase();
  if (type === "delta" || type.endsWith(".delta") || type.endsWith("_delta")) return true;
  // 流式分片在 Content Preview 里的 itemType 往往没有 delta 后缀：
  // OpenAI Chat Completions 的 delta.content 落成 "content"、Anthropic 的
  // thinking/text 落成 "thinking" / "text"。它们属于同一条消息的连续片段，
  // 必须直接拼接 —— 否则每个分片之间插入换行，概览会变成「一两个字一行」
  // （2026-09-18 用户反馈：主要响应内容像没换行一样，完全没法读）。
  return type === "content" || type === "text" || type === "thinking" || type === "reasoning";
}

function overviewCategoryLabel(category: string, toolName: string | undefined): string {
  if (category === "system") return "系统";
  if (category === "developer") return "开发者";
  if (category === "user_real") return "真实输入";
  if (category === "user_injected") return "Agent 注入";
  if (category === "tool_result") return "工具结果";
  if (category === "assistant") return "Assistant";
  if (category === "tool_use") return toolName ? `工具调用: ${toolName}` : "工具调用";
  if (category === "reasoning") return "思考";
  if (category === "refusal") return "拒绝";
  if (category === "control") return "控制";
  if (category === "unknown_input") return "未识别输入";
  return "未识别输出";
}

function isConversationSemanticCategory(
  value: string,
): value is ConversationSemanticCategory {
  return ALL_CONVERSATION_SEMANTIC_CATEGORIES.some(category =>
    category === value);
}

function compactOverviewText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}…`;
}

export interface HierarchyRefreshPath {
  session?: string;
  thread?: string;
  ancestorThreadIds?: string[];
}

export interface HierarchyRefreshPlan {
  sessionIds: string[];
  childPages: Array<{ sessionId: string; parentThreadId: string }>;
  turnThreadIds: string[];
}

/**
 * 数据版本刷新最多跟进当前路径和最新请求路径；只规划轻量层级页，绝不扩展到 Step/raw。
 */
export function hierarchyRefreshPlan(
  paths: Array<HierarchyRefreshPath | undefined>,
): HierarchyRefreshPlan {
  const sessionIds: string[] = [];
  const childPages: HierarchyRefreshPlan["childPages"] = [];
  const turnThreadIds: string[] = [];
  const seenSessions = new Set<string>();
  const seenChildPages = new Set<string>();
  const seenTurnThreads = new Set<string>();

  for (const path of paths.slice(0, 2)) {
    if (!path?.session) continue;
    if (!seenSessions.has(path.session)) {
      seenSessions.add(path.session);
      sessionIds.push(path.session);
    }
    const hierarchy = [...(path.ancestorThreadIds || []), path.thread]
      .filter((threadId): threadId is string => !!threadId);
    for (const parentThreadId of hierarchy) {
      const key = `${path.session}\0${parentThreadId}`;
      if (seenChildPages.has(key)) continue;
      seenChildPages.add(key);
      childPages.push({ sessionId: path.session, parentThreadId });
    }
    if (path.thread && !seenTurnThreads.has(path.thread)) {
      seenTurnThreads.add(path.thread);
      turnThreadIds.push(path.thread);
    }
  }
  return { sessionIds, childPages, turnThreadIds };
}

/**
 * 总览只读取当前 Step 与 SQLite 认定的同 Thread 上一模型请求。API 基线尚未返回时，
 * 才使用同 Turn 已加载步骤兜底；返回值同时承担去重职责。
 */
export function overviewEvidencePlan(input: {
  active: boolean;
  step?: OverviewEvidenceStep;
  turnSteps: OverviewEvidenceStep[];
  loadedCurrentExchangeId?: string;
  loadedPreviousExchangeId?: string;
  previousModelExchangeId?: string;
}): { current?: OverviewEvidenceRequest; previous?: OverviewEvidenceRequest } {
  if (!input.active || !input.step) return {};
  const current = input.loadedCurrentExchangeId === input.step.exchangeId
    ? undefined
    : { stepId: input.step.id, exchangeId: input.step.exchangeId };
  const previousStep = input.turnSteps
    .filter(step => step.turnId === input.step!.turnId && step.index < input.step!.index)
    .sort((left, right) => right.index - left.index)[0];
  const previousExchangeId = input.previousModelExchangeId ?? previousStep?.exchangeId;
  const previous = !previousExchangeId || input.loadedPreviousExchangeId === previousExchangeId
    ? undefined
    : input.previousModelExchangeId
      ? { exchangeId: previousExchangeId }
      : { stepId: previousStep?.id, exchangeId: previousExchangeId };
  return { current, previous };
}

/**
 * 总览页自动刷新时 rawExchange 可能仍是上一条请求；只有 exchangeId 对齐时才允许使用 raw usage。
 */
export function selectOverviewTokenUsageSource(input: {
  activeExchangeId?: string;
  rawExchangeId?: string;
  hasStepUsage: boolean;
}): OverviewTokenUsageSource {
  if (input.activeExchangeId && input.rawExchangeId === input.activeExchangeId) return "raw";
  if (input.hasStepUsage) return "step";
  return "unavailable";
}

function unavailableTokenUsage(note: string): TokenUsageSummary {
  return {
    source: "unavailable",
    usageConfidence: "unavailable",
    sourceLabel: "usage 不可用",
    note,
  };
}

/** 成本数值展示（2026-09-28 起带币种符号）：USD/CNY 加 $/￥ 前缀，
 *  未知币种（如未计价行的 'unknown'）保持纯数值、不猜测币种。 */
export function formatCostValue(value: number | undefined, currency = "USD", fractionDigits?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const digits = fractionDigits ?? (Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 8 : 4);
  const text = value.toFixed(digits);
  if (currency === "USD") return `$${text}`;
  if (currency === "CNY") return `￥${text}`;
  return text;
}

export function selectedStepAfterTurnStepsPage(input: {
  replace: boolean;
  currentStepId?: string;
  currentExchangeId?: string;
  previousLatestStepId?: string;
  nextSteps: Array<{ id: string; exchangeId: string }>;
}): { stepId: string; exchangeId: string } {
  const latestStep = input.nextSteps[0];
  const currentStep = input.currentStepId
    ? input.nextSteps.find(item => item.id === input.currentStepId)
    : undefined;
  if (!latestStep) return { stepId: input.currentStepId || "", exchangeId: input.currentExchangeId || "" };
  if (!input.replace && input.currentStepId) {
    return { stepId: input.currentStepId, exchangeId: input.currentExchangeId || currentStep?.exchangeId || "" };
  }
  const shouldSelectLatest = !input.currentStepId
    || input.currentStepId === input.previousLatestStepId
    || !currentStep;
  const selected = shouldSelectLatest ? latestStep : currentStep;
  return {
    stepId: selected?.id || "",
    exchangeId: selected?.exchangeId || input.currentExchangeId || "",
  };
}
