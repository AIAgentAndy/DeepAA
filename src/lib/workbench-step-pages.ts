import type {
  DerivedStatus,
  StepContextSnapshotState,
  StepDiffState,
  WorkbenchContextSnapshot,
  WorkbenchStepDiff,
} from "./app-state";
import {parsePlanEstimateDetailRecord} from "./token-pricing-display";
import type { AgentStep, HarnessLearningInsight } from "./harness";
import { parseStepFailover } from "./failover-display";
import { workbenchDerivedStatus } from "./workbench-tree-refresh";

const MAX_RUNTIME_TOOL_IDS = 500;
const MAX_RUNTIME_ARTIFACT_ITEMS = 500;
export const MAX_WORKBENCH_RUNTIME_STEPS = 500;
const STEP_PHASES = new Set<AgentStep["phase"]>([
  "initial_prompt",
  "tool_result_followup",
  "tool_request",
  "tool_loop",
  "final_answer",
  "retry",
  "error",
  "incomplete",
]);
const STEP_REQUEST_ACTIONS = new Set<AgentStep["requestAction"]>([
  "user_prompt",
  "tool_result",
  "conversation_continue",
  "retry_like",
  "unknown",
]);
const STEP_RESPONSE_ACTIONS = new Set<AgentStep["responseAction"]>([
  "tool_use",
  "final",
  "error",
  "incomplete",
  "unknown",
]);

interface WorkbenchStepItem {
  id: string;
  exchangeId: string;
  agentSessionId: string;
  agentThreadId: string;
  agentTurnId: string;
  nativeStepId?: string;
  stepIndex: number;
  timestamp: string;
  phase: string;
  requestIntentLabel?: string;
  responseStatusLabel?: string;
  responseAction?: string;
  toolSchemaCount: number;
  toolUseNames: string[];
  toolUseNamesLimited: boolean;
  toolUseCount: number;
  toolResultCount: number;
  failover?: unknown;
  origin?: string;
  targetId?: string;
  targetName?: string;
  /** 压缩事件注解（服务端 wire 证据门槛；无证据的裁剪边界不携带）。 */
  compactionRole?: "generation" | "first-after";
  compactionOrdinal?: number;
  /** v5 时间线：每步耗时 / 首字 / 状态码 / 结果分类 / token（SQLite 投影列）。 */
  durationMs?: number;
  firstTokenMs?: number;
  httpStatus?: number;
  resultClass?: string;
  stopReason?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
}

interface WorkbenchTurnStepsPayload {
  items: WorkbenchStepItem[];
  userPrompt?: {
    text: string;
    stepIndex: number;
    stepId: string;
    exchangeId: string;
    timestamp: string;
    truncated: boolean;
    originalBytes?: number;
    source: string;
  };
  /** 服务端按本 Turn 全部 Step 聚合的意图统计（与分页 items 无关的全量值）。 */
  intentStats: WorkbenchTurnIntentStats;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  dataVersion: number;
  derivedStatus: unknown;
}

/** Turn 意图序列全量统计：来自服务端聚合，不随前端已加载分页截断。 */
export interface WorkbenchTurnIntentStats {
  toolUseSteps: number;
  retries: number;
  interruptions: number;
  finals: number;
  /** 有 wire 证据的压缩事件数（服务端已把压缩生成调用从 finals 剔除）。 */
  compressions: number;
}

export interface WorkbenchTurnStepsPage {
  steps: AgentStep[];
  userPrompt?: {
    text: string;
    stepIndex: number;
    stepId: string;
    exchangeId: string;
    timestamp: string;
    truncated: boolean;
    originalBytes?: number;
    source?: string;
  };
  intentStats: WorkbenchTurnIntentStats;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  derivedStatus: DerivedStatus;
}

export interface WorkbenchStepSelection {
  sessionId: string;
  turnId: string;
  stepId: string;
  derivedStatus: DerivedStatus;
}

export interface WorkbenchStepDetail {
  step: AgentStep;
  learningInsight?: HarnessLearningInsight;
}

/** 将详情 API 的单行账本投影到既有检查器对象，避免 UI 再猜价格字段。 */
export function parseWorkbenchStepDetailResponse(
  value: unknown,
): WorkbenchStepDetail | undefined {
  const wrapper = objectRecord(value);
  const record = objectRecord(wrapper?.step);
  if (!record || !isWorkbenchStepDetail(record)) return undefined;
  const pricingSnapshot = record.pricingSnapshot === undefined
    ? undefined
    : objectRecord(record.pricingSnapshot);
  if (record.pricingSnapshot !== undefined && !pricingSnapshot) return undefined;
  const insight = record.learningInsight === undefined
    ? undefined
    : parseLearningInsight(record.learningInsight, record.agentTurnId, record.agentSessionId);
  if (record.learningInsight !== undefined && !insight) return undefined;
  const inputTokens = record.inputTokens as number;
  const cacheReadTokens = record.cacheReadTokens as number;
  const cacheWriteTokens = record.cacheWriteTokens as number;
  const outputTokens = record.outputTokens as number;
  const vendorCost = record.vendorCost as number;
  const actualCost = record.actualCost as number;
  // 人民币口径（2026-09-23）：账本物化列优先；缺失时按 原币种 × 入账冻结结算系数 折算
  // （与写入路径同式）；两者皆无（无账本/极旧行）保持 undefined，消费端回退原币种值。
  const fxRateToCny = typeof record.fxRateToCny === "number" && Number.isFinite(record.fxRateToCny) && record.fxRateToCny > 0
    ? record.fxRateToCny
    : undefined;
  const actualCostCny =
    typeof record.actualCostCny === "number" && Number.isFinite(record.actualCostCny)
      ? record.actualCostCny
      : fxRateToCny !== undefined && Number.isFinite(actualCost) && actualCost > 0
        ? actualCost * fxRateToCny
        : undefined;
  const runtimeStep: AgentStep = {
    id: record.id as string,
    turnId: record.agentTurnId as string,
    agentSessionId: record.agentSessionId as string,
    agentThreadId: record.agentThreadId as string,
    exchangeId: record.exchangeId as string,
    nativeStepId: optionalString(record.nativeStepId) ? record.nativeStepId as string : undefined,
    index: record.stepIndex as number,
    timestamp: record.timestamp as string,
    phase: record.phase as AgentStep["phase"],
    requestAction: record.requestAction as AgentStep["requestAction"],
    responseAction: record.responseAction as AgentStep["responseAction"],
    toolSchemaCount: record.toolSchemaCount as number,
    toolUseNames: record.toolUseNames as string[],
    toolUseIds: placeholderIds("tool-use", record.toolUseCount as number),
    toolResultIds: placeholderIds("tool-result", record.toolResultCount as number),
    contextSnapshotId: `stored-${record.id as string}`,
    requestIntentLabel: record.requestIntentLabel as string | undefined,
    responseStatusLabel: record.responseStatusLabel as string | undefined,
    contextCompressed: record.contextCompressed as boolean,
    // v5：步骤列表直接带上耗时/首字/token，时间线节点无需再逐条拉详情
    durationMs: optionalNonNegativeNumber(record.durationMs) ? record.durationMs as number : undefined,
    inputTokens: nonNegativeInteger(record.inputTokens) ? record.inputTokens as number : 0,
    cacheReadTokens: nonNegativeInteger(record.cacheReadTokens) ? record.cacheReadTokens as number : 0,
    cacheWriteTokens: nonNegativeInteger(record.cacheWriteTokens) ? record.cacheWriteTokens as number : 0,
    outputTokens: nonNegativeInteger(record.outputTokens) ? record.outputTokens as number : 0,
    stopReason: optionalString(record.stopReason) ? record.stopReason as string : undefined,
    firstTokenMs: optionalNonNegativeNumber(record.firstTokenMs)
      ? record.firstTokenMs as number
      : undefined,
    httpStatus: optionalNonNegativeInteger(record.httpStatus) ? record.httpStatus as number : undefined,
    resultClass: optionalString(record.resultClass) ? record.resultClass as string : undefined,
    compactionPreview: parseCompactionPreview(record.compaction),
    compactionEvent: parseCompactionEvent(record.compactionEvent),
    paramsDetail: objectRecord(record.paramsDetail),
    failover: parseStepFailover(record.failover),
    origin: record.origin === "agent_local_import" ? "agent_local_import" : "gateway",
    targetId: typeof record.targetId === "string" ? record.targetId : undefined,
    targetName: typeof record.targetName === "string" ? record.targetName : undefined,
    billingChannel: typeof record.billingChannel === "string" ? record.billingChannel : undefined,
    planCreditCost: typeof record.planCreditCost === "number" ? record.planCreditCost : undefined,
    planCreditUnit: typeof record.planCreditUnit === "string" ? record.planCreditUnit : undefined,
    planEstimatedCost: typeof record.planEstimatedCost === "number" ? record.planEstimatedCost : undefined,
    planEstimatedCurrency: typeof record.planEstimatedCurrency === "string" ? record.planEstimatedCurrency : undefined,
    planEstimatedStatus: typeof record.planEstimatedStatus === "string" ? record.planEstimatedStatus : undefined,
    // 人民币 nano 物化与入账冻结汇率（2026-09-28）：供 Step 面板人民币口径优先取值。
    planEstimatedCostNano: typeof record.planEstimatedCostNano === "number" && Number.isFinite(record.planEstimatedCostNano)
      ? record.planEstimatedCostNano
      : undefined,
    planEstimatedFx: typeof record.planEstimatedFx === "number" && Number.isFinite(record.planEstimatedFx) && record.planEstimatedFx > 0
      ? record.planEstimatedFx
      : undefined,
    planEstimateDetail: parsePlanEstimateDetailRecord(record.planEstimateDetail),
    tokenUsage: {
      inputTokens,
      totalInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
      cacheReadTokens,
      cacheCreationTokens: cacheWriteTokens,
      outputTokens,
      totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
      source: usageSourceForRuntime(record.usageSource),
    },
    ...(pricingSnapshot
      ? { pricingSnapshot: pricingSnapshot as unknown as NonNullable<AgentStep["pricingSnapshot"]> }
      : {}),
    tokenCost: {
      priced: pricingSnapshot?.priced === true,
      // 币种（2026-09-28）：账本行原币种优先（未计价行可能是 'unknown'，不作展示币种），
      // 缺失时回退价格快照币种，再缺省 USD。
      currency: record.currency === "USD" || record.currency === "CNY"
        ? record.currency
        : pricingSnapshot?.currency === "USD" || pricingSnapshot?.currency === "CNY"
          ? pricingSnapshot.currency
          : "USD",
      totalCost: actualCost,
      officialTotalCost: vendorCost,
      ...(actualCostCny !== undefined ? {totalCostCny: actualCostCny} : {}),
      ...(fxRateToCny !== undefined ? {fxRateToCny} : {}),
      ...(typeof pricingSnapshot?.unpricedReason === "string"
        ? { unpricedReason: pricingSnapshot.unpricedReason as NonNullable<AgentStep["tokenCost"]>["unpricedReason"] }
        : {}),
    },
  };
  return { step: runtimeStep, learningInsight: insight };
}

function parseCompactionPreview(
  value: unknown,
): AgentStep["compactionPreview"] {
  const record = objectRecord(value);
  if (!record || !nonEmptyString(record.kind) || !nonEmptyString(record.preview)) return undefined;
  return {
    kind: record.kind as string,
    confidence: nonEmptyString(record.confidence) ? record.confidence as string : "high",
    ...(nonEmptyString(record.markerKind) ? {markerKind: record.markerKind as string} : {}),
    preview: record.preview as string,
  };
}

/** 详情压缩事件注解：role 必须是已知枚举，ordinal 为正整数；非法整体忽略。 */
function parseCompactionEvent(
  value: unknown,
): AgentStep["compactionEvent"] {
  const record = objectRecord(value);
  if (
    !record
    || (record.role !== "generation" && record.role !== "first-after")
    || !nonNegativeInteger(record.ordinal)
    || record.ordinal < 1
  ) return undefined;
  return {role: record.role, ordinal: record.ordinal};
}

/** 列表页 item 的压缩角色：与 parseCompactionEvent 同口径（ordinal 允许随 role 成对缺省）。 */
function parseCompactionRole(
  value: unknown,
): AgentStep["compactionRole"] {
  return value === "generation" || value === "first-after" ? value : undefined;
}

function isWorkbenchStepDetail(record: Record<string, unknown>): boolean {
  return nonEmptyString(record.id)
    && nonEmptyString(record.exchangeId)
    && nonEmptyString(record.agentSessionId)
    && nonEmptyString(record.agentThreadId)
    && nonEmptyString(record.agentTurnId)
    && nonNegativeInteger(record.stepIndex)
    && nonEmptyString(record.timestamp)
    && typeof record.phase === "string"
    && STEP_PHASES.has(record.phase as AgentStep["phase"])
    && typeof record.requestAction === "string"
    && STEP_REQUEST_ACTIONS.has(record.requestAction as AgentStep["requestAction"])
    && typeof record.responseAction === "string"
    && STEP_RESPONSE_ACTIONS.has(record.responseAction as AgentStep["responseAction"])
    && optionalString(record.requestIntentLabel)
    && optionalString(record.responseStatusLabel)
    && nonNegativeInteger(record.toolSchemaCount)
    && stringArray(record.toolUseNames)
    && nonNegativeInteger(record.toolUseCount)
    && nonNegativeInteger(record.toolResultCount)
    && typeof record.contextCompressed === "boolean"
    && optionalString(record.model)
    && optionalString(record.vendor)
    && optionalNonNegativeNumber(record.rateMultiplier)
    && nonNegativeInteger(record.inputTokens)
    && nonNegativeInteger(record.cacheReadTokens)
    && nonNegativeInteger(record.cacheWriteTokens)
    && nonNegativeInteger(record.outputTokens)
    && nonNegativeNumber(record.vendorCost)
    && nonNegativeNumber(record.actualCost)
    && nonNegativeInteger(record.durationMs)
    && optionalString(record.usageSource)
    && optionalString(record.usageConfidence)
    && optionalString(record.targetId)
    && optionalString(record.targetName);
}

function parseLearningInsight(
  value: unknown,
  expectedTurnId: unknown,
  expectedSessionId: unknown,
): HarnessLearningInsight | undefined {
  const record = objectRecord(value);
  if (
    !record
    || record.turnId !== expectedTurnId
    || record.agentSessionId !== expectedSessionId
    || !nonEmptyString(record.summary)
    || !nonEmptyString(record.harnessPattern)
    || !nonEmptyString(record.confidence)
    || !Array.isArray(record.observations)
    || !nonEmptyString(record.copyableTemplate)
    || !Array.isArray(record.evidence)
  ) return undefined;
  return record as unknown as HarnessLearningInsight;
}

function usageSourceForRuntime(
  value: unknown,
): "exact" | "estimated" | "unavailable" {
  if (value === "unavailable" || value === undefined) return "unavailable";
  return typeof value === "string" && value.includes("estimated")
    ? "estimated"
    : "exact";
}

/** 将 SQLite Step 摘要投影为现有时间线需要的有界运行时对象。 */
export function parseWorkbenchTurnStepsPage(
  payload: unknown,
): WorkbenchTurnStepsPage | undefined {
  if (!isWorkbenchTurnStepsPayload(payload)) return undefined;
  const derivedStatus = workbenchDerivedStatus(payload.derivedStatus);
  if (!derivedStatus) return undefined;
  return {
    userPrompt: payload.userPrompt,
    steps: payload.items.map(item => ({
      id: item.id,
      turnId: item.agentTurnId,
      agentSessionId: item.agentSessionId,
      agentThreadId: item.agentThreadId,
      exchangeId: item.exchangeId,
      nativeStepId: item.nativeStepId,
      index: item.stepIndex,
      timestamp: item.timestamp,
      phase: STEP_PHASES.has(item.phase as AgentStep["phase"])
        ? item.phase as AgentStep["phase"]
        : "incomplete",
      requestAction: "unknown",
      // 优先真实响应动作（意图序列「完成」统计的依据）；旧数据缺省时按工具调用数推断。
      responseAction: STEP_RESPONSE_ACTIONS.has(item.responseAction as AgentStep["responseAction"])
        ? item.responseAction as AgentStep["responseAction"]
        : item.toolUseCount > 0 ? "tool_use" : "unknown",
      toolSchemaCount: item.toolSchemaCount,
      toolUseNames: item.toolUseNames,
      toolUseIds: placeholderIds("tool-use", item.toolUseCount),
      toolResultIds: placeholderIds("tool-result", item.toolResultCount),
      contextSnapshotId: `stored-${item.id}`,
      requestIntentLabel: item.requestIntentLabel,
      responseStatusLabel: item.responseStatusLabel,
      failover: parseStepFailover(item.failover),
      origin: item.origin === "agent_local_import" ? "agent_local_import" : "gateway",
      targetId: item.targetId,
      targetName: item.targetName,
      compactionRole: parseCompactionRole(item.compactionRole),
      compactionOrdinal: item.compactionRole !== undefined && nonNegativeInteger(item.compactionOrdinal)
        ? item.compactionOrdinal
        : undefined,
      durationMs: item.durationMs,
      firstTokenMs: item.firstTokenMs,
      httpStatus: item.httpStatus,
      resultClass: item.resultClass,
      stopReason: item.stopReason,
      inputTokens: item.inputTokens,
      cacheReadTokens: item.cacheReadTokens,
      cacheWriteTokens: item.cacheWriteTokens,
      outputTokens: item.outputTokens,
    })),
    candidateCount: payload.candidateCount,
    processedCount: payload.processedCount,
    limited: payload.limited,
    hasMore: payload.hasMore,
    nextCursor: payload.nextCursor,
    intentStats: payload.intentStats,
    derivedStatus,
  };
}

export function turnStepsPageRequestUrl(
  turnId: string,
  options: { limit: number; cursor?: string },
): string {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.cursor) params.set("cursor", options.cursor);
  return `/api/agent-turns/${encodeURIComponent(turnId)}/steps?${params}`;
}

/** SQLite artifact 是可截断的 JSON；完整性不足时必须在进入旧检查器组件前降级。 */
export function parseWorkbenchContextSnapshotState(
  value: unknown,
): StepContextSnapshotState | undefined {
  const record = objectRecord(value);
  const snapshot = objectRecord(record?.snapshot);
  const derivedStatus = workbenchDerivedStatus(record?.derivedStatus);
  const projected = snapshot ? projectContextSnapshot(snapshot) : undefined;
  if (
    !record
    || !snapshot
    || !derivedStatus
    || !projected
    || !isCompleteContextSnapshot(projected as unknown as Record<string, unknown>)
    || !nonNegativeInteger(record.candidateCount)
    || !nonNegativeInteger(record.processedCount)
    || typeof record.limited !== "boolean"
  ) {
    return undefined;
  }
  return {
    snapshot: {
      ...projected,
      artifactLimited: record.limited || record.truncated === true,
      artifactTruncated: artifactTruncatedOf(objectRecord(record.completeness), record.truncated === true),
      artifactCompleteness: objectRecord(record.completeness),
    },
    derivedStatus,
    candidateCount: record.candidateCount,
    processedCount: record.processedCount,
    limited: record.limited,
  };
}

/** Diff 组件依赖多组数组；半截 artifact 不允许以完整 Diff 类型进入渲染层。 */
export function parseWorkbenchStepDiffState(
  value: unknown,
): StepDiffState | undefined {
  const record = objectRecord(value);
  const diff = objectRecord(record?.diff);
  const derivedStatus = workbenchDerivedStatus(record?.derivedStatus);
  if (
    !record
    || !diff
    || !derivedStatus
    || !isCompleteStepDiff(diff)
    || !nonNegativeInteger(record.candidateCount)
    || !nonNegativeInteger(record.processedCount)
    || typeof record.limited !== "boolean"
  ) {
    return undefined;
  }
  return {
    diff: {
      ...diff as unknown as WorkbenchStepDiff,
      changedParamDetails: Array.isArray(
        (diff as Record<string, unknown>).changedParamDetails
      )
        ? (diff as Record<string, unknown>).changedParamDetails as WorkbenchStepDiff["changedParamDetails"]
        : [],
      artifactLimited: record.limited || record.truncated === true,
      artifactTruncated: artifactTruncatedOf(objectRecord(record.completeness), record.truncated === true),
      artifactCompleteness: objectRecord(record.completeness),
    },
    derivedStatus,
    candidateCount: record.candidateCount,
    processedCount: record.processedCount,
    limited: record.limited,
  };
}

/** 显式分页仍设置 500 条前端硬上限，避免用户连续加载把单个 Turn 全量驻留内存。 */
export function mergeWorkbenchTurnStepsPage(
  current: WorkbenchTurnStepsPage,
  incoming: WorkbenchTurnStepsPage,
): WorkbenchTurnStepsPage {
  const byId = new Map(current.steps.map(step => [step.id, step]));
  for (const step of incoming.steps) byId.set(step.id, step);
  const allSteps = [...byId.values()];
  const reachedRuntimeLimit = allSteps.length > MAX_WORKBENCH_RUNTIME_STEPS
    || (allSteps.length >= MAX_WORKBENCH_RUNTIME_STEPS && incoming.hasMore);
  return {
    ...incoming,
    steps: allSteps.slice(0, MAX_WORKBENCH_RUNTIME_STEPS),
    processedCount: current.processedCount + incoming.processedCount,
    limited: incoming.limited || reachedRuntimeLimit,
    hasMore: reachedRuntimeLimit ? false : incoming.hasMore,
    nextCursor: reachedRuntimeLimit ? undefined : incoming.nextCursor,
  };
}

/** 深链中的 step 始终是内部 AgentStep.id，由服务端精确校验其 Turn 从属关系。 */
export function parseWorkbenchStepSelection(
  payload: unknown,
  expectedTurnId: string,
  expectedStepId: string,
): WorkbenchStepSelection | undefined {
  const record = objectRecord(payload);
  const path = objectRecord(record?.resolvedPath);
  const derivedStatus = workbenchDerivedStatus(record?.derivedStatus);
  if (
    !path
    || !derivedStatus
    || path.turn !== expectedTurnId
    || path.step !== expectedStepId
    || !nonEmptyString(path.session)
  ) {
    return undefined;
  }
  return {
    sessionId: path.session,
    turnId: expectedTurnId,
    stepId: expectedStepId,
    derivedStatus,
  };
}

function isWorkbenchTurnStepsPayload(
  payload: unknown,
): payload is WorkbenchTurnStepsPayload {
  const record = objectRecord(payload);
  return !!record
    && Array.isArray(record.items)
    && optionalUserPrompt(record.userPrompt)
    && record.items.every(isWorkbenchStepItem)
    && isTurnIntentStats(record.intentStats)
    && nonNegativeInteger(record.candidateCount)
    && nonNegativeInteger(record.processedCount)
    && typeof record.limited === "boolean"
    && typeof record.hasMore === "boolean"
    && optionalString(record.nextCursor)
    && nonNegativeInteger(record.dataVersion)
    && workbenchDerivedStatus(record.derivedStatus) !== undefined;
}

function isTurnIntentStats(value: unknown): value is WorkbenchTurnIntentStats {
  const record = objectRecord(value);
  return !!record
    && nonNegativeInteger(record.toolUseSteps)
    && nonNegativeInteger(record.retries)
    && nonNegativeInteger(record.interruptions)
    && nonNegativeInteger(record.finals)
    && nonNegativeInteger(record.compressions);
}

function optionalUserPrompt(value: unknown): boolean {
  if (value === undefined) return true;
  const record = objectRecord(value);
  return !!record
    && typeof record.text === "string"
    && nonNegativeInteger(record.stepIndex)
    && nonEmptyString(record.stepId)
    && nonEmptyString(record.exchangeId)
    && nonEmptyString(record.timestamp)
    && typeof record.truncated === "boolean"
    && optionalString(record.source);
}

function isWorkbenchStepItem(value: unknown): value is WorkbenchStepItem {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.id)
    && nonEmptyString(record.exchangeId)
    && nonEmptyString(record.agentSessionId)
    && nonEmptyString(record.agentThreadId)
    && nonEmptyString(record.agentTurnId)
    && optionalString(record.nativeStepId)
    && nonNegativeInteger(record.stepIndex)
    && nonEmptyString(record.timestamp)
    && nonEmptyString(record.phase)
    && optionalString(record.responseAction)
    && optionalString(record.requestIntentLabel)
    && optionalString(record.responseStatusLabel)
    && nonNegativeInteger(record.toolSchemaCount)
    && stringArray(record.toolUseNames)
    && typeof record.toolUseNamesLimited === "boolean"
    && nonNegativeInteger(record.toolUseCount)
    && nonNegativeInteger(record.toolResultCount)
    && optionalString(record.targetId)
    && optionalString(record.targetName)
    && (record.compactionRole === undefined
      || record.compactionRole === "generation"
      || record.compactionRole === "first-after")
    && (record.compactionOrdinal === undefined
      || (nonNegativeInteger(record.compactionOrdinal) && record.compactionOrdinal >= 1));
}

/** 将受限 SQLite harnessPayload 投影成旧检查器所需的轻量摘要，不重建原始正文。 */
function projectContextSnapshot(
  record: Record<string, unknown>,
): WorkbenchContextSnapshot | undefined {
  const payload = objectRecord(record.harnessPayload);
  const intent = objectRecord(payload?.intent);
  const params = objectRecord(payload?.params);
  const systemPrompts = projectPromptItems(payload?.systemPrompts);
  const developerPrompts = projectPromptItems(payload?.developerPrompts);
  const requestedToolUses = projectToolUses(payload?.requestedToolUses);
  const providedToolResults = projectToolResults(payload?.providedToolResults);
  const conversationBreakdown = summarizeConversationItems(payload?.conversationItems);
  if (
    !nonEmptyString(record.id)
    || !nonEmptyString(record.stepId)
    || !nonEmptyString(record.exchangeId)
    || !nonEmptyString(record.protocol)
    || !optionalString(record.model)
    || !stringArray(record.systemPromptHashes)
    || !stringArray(record.developerPromptHashes)
    || !stringArray(record.conversationItemHashes)
    || !stringArray(record.toolSchemaHashes)
    || !nonEmptyString(record.paramsHash)
    || !nonNegativeInteger(record.toolSchemaCount)
    || !nonEmptyString(record.totalStableHash)
    || !boundedObjectArray(record.remoteStateReferences)
    || !boundedObjectArray(record.evidence)
    || !payload
    || !intent
    || !nonEmptyString(intent.type)
    || !nonEmptyString(intent.confidence)
    || !boundedObjectArray(intent.evidence)
    || !systemPrompts
    || !developerPrompts
    || !boundedHarnessItems(payload.conversationItems, ["stableHash", "evidence"])
    || !boundedHarnessItems(payload.toolSchemas, ["name", "stableHash", "evidence"])
    || !requestedToolUses
    || !providedToolResults
    || !boundedHarnessItems(payload.reasoningItems, ["type", "evidence"])
    || !params
    || !nonEmptyString(payload.stableHash)
    || !boundedObjectArray(payload.evidence)
  ) return undefined;
  const { harnessPayload: _harnessPayload, ...base } = record;
  return {
    ...base,
    harnessSummary: {
      intent: intent as unknown as WorkbenchContextSnapshot["harnessSummary"]["intent"],
      systemPrompts,
      developerPrompts,
      userPrompts: [],
      userPromptObservability: "partial",
      conversationItemCount: (payload.conversationItems as unknown[]).length,
      conversationKindCounts: conversationBreakdown.counts,
      conversationItemSamples: conversationBreakdown.samples,
      toolSchemaCount: (payload.toolSchemas as unknown[]).length,
      requestedToolUses,
      providedToolResults,
      reasoningItemCount: (payload.reasoningItems as unknown[]).length,
      params,
      stableHash: payload.stableHash,
      evidenceCount: (payload.evidence as unknown[]).length,
    },
  } as unknown as WorkbenchContextSnapshot;
}

/** 对话条目分层卡片所需的有界聚合：按 kind 计数 + 前 24 条样本（不保留全量条目）。 */
function summarizeConversationItems(
  value: unknown,
): {counts: Record<string, number>; samples: Array<{kind: string; role?: string; toolName?: string; toolUseId?: string; summary?: string}>} {
  const counts: Record<string, number> = {};
  const samples: Array<{kind: string; role?: string; toolName?: string; toolUseId?: string; summary?: string}> = [];
  if (!Array.isArray(value)) return {counts, samples};
  const maxSamples = 24;
  for (const entry of value) {
    const item = objectRecord(entry);
    if (!item) continue;
    const rawKind = typeof item.kind === "string" ? item.kind : "";
    if (!rawKind) continue;
    const kind = normalizeConversationKind(rawKind);
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (samples.length < maxSamples) {
      samples.push({
        kind,
        ...(typeof item.role === "string" ? {role: item.role} : {}),
        ...(typeof item.toolName === "string" ? {toolName: item.toolName} : {}),
        ...(typeof item.toolUseId === "string" ? {toolUseId: item.toolUseId} : {}),
        ...(typeof item.summary === "string" ? {summary: item.summary} : {}),
      });
    }
  }
  return {counts, samples};
}

/** 归一化 kind：把协议级细分（如 *_call_output / 各类 text 变体）合并到分层卡片口径。 */
function normalizeConversationKind(kind: string): string {
  if (kind.includes("tool_result") || kind.endsWith("_call_output") || kind.includes("tool_output")) {
    return "tool_result";
  }
  if (kind.includes("tool_use") || kind.endsWith("_call") || kind.includes("tool_call")) {
    return "tool_use";
  }
  if (kind.includes("reason")) return "reasoning";
  if (kind.includes("thinking")) return "reasoning";
  return kind;
}

function projectPromptItems(
  value: unknown,
): WorkbenchContextSnapshot["harnessSummary"]["systemPrompts"] | undefined {
  if (!boundedObjectArray(value)) return undefined;
  const result = [];
  for (const itemValue of value) {
    const item = objectRecord(itemValue);
    if (!item || !nonEmptyString(item.textHash) || !boundedObjectArray(item.evidence)) {
      return undefined;
    }
    result.push({
      textHash: item.textHash,
      ...(optionalString(item.textPreview) && item.textPreview !== undefined
        ? { textPreview: item.textPreview as string }
        : {}),
      ...(optionalString(item.providerRole) && item.providerRole !== undefined
        ? { providerRole: item.providerRole as string }
        : {}),
      evidenceCount: (item.evidence as unknown[]).length,
    });
  }
  return result;
}

function projectToolUses(
  value: unknown,
): WorkbenchContextSnapshot["harnessSummary"]["requestedToolUses"] | undefined {
  if (!boundedObjectArray(value)) return undefined;
  const result = [];
  for (const itemValue of value) {
    const item = objectRecord(itemValue);
    if (
      !item
      || !nonEmptyString(item.id)
      || !nonEmptyString(item.name)
      || !boundedObjectArray(item.evidence)
    ) return undefined;
    result.push({
      id: item.id,
      name: item.name,
      ...(optionalString(item.providerType) && item.providerType !== undefined
        ? { providerType: item.providerType as string }
        : {}),
      input: item.input,
      evidenceCount: (item.evidence as unknown[]).length,
    });
  }
  return result;
}

function projectToolResults(
  value: unknown,
): WorkbenchContextSnapshot["harnessSummary"]["providedToolResults"] | undefined {
  if (!boundedObjectArray(value)) return undefined;
  const result = [];
  for (const itemValue of value) {
    const item = objectRecord(itemValue);
    if (
      !item
      || !nonEmptyString(item.toolUseId)
      || (item.isError !== undefined && typeof item.isError !== "boolean")
      || !boundedObjectArray(item.evidence)
    ) return undefined;
    result.push({
      toolUseId: item.toolUseId,
      ...(typeof item.isError === "boolean" ? { isError: item.isError } : {}),
      ...(optionalString(item.providerType) && item.providerType !== undefined
        ? { providerType: item.providerType as string }
        : {}),
      content: item.content,
      evidenceCount: (item.evidence as unknown[]).length,
    });
  }
  return result;
}

function boundedHarnessItems(
  value: unknown,
  required: readonly string[],
): boolean {
  if (!boundedObjectArray(value)) return false;
  return value.every(itemValue => {
    const item = objectRecord(itemValue);
    return !!item && required.every(key => (
      key === "evidence" ? boundedObjectArray(item[key]) : nonEmptyString(item[key])
    ));
  });
}

/**
 * 三态判定（2026-09-11）：只有「条目被真实丢弃」或「信封级硬截断（无内容）」才升级为告警；
 * 字段级预览截断（按设计）只显示中性的索引态说明，避免常亮告警导致信号失效。
 */
function artifactTruncatedOf(
  completeness: Record<string, unknown> | undefined,
  envelopeTruncated: boolean,
): boolean {
  if (completeness?.itemsDropped === true) return true;
  return envelopeTruncated
    && typeof completeness?.processedItemCount === "number"
    && completeness.processedItemCount === 0;
}

function boundedObjectArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
    && value.length <= MAX_RUNTIME_ARTIFACT_ITEMS
    && value.every(item => item !== null && typeof item === "object" && !Array.isArray(item));
}

function isCompleteContextSnapshot(record: Record<string, unknown>): boolean {
  const summary = objectRecord(record.harnessSummary);
  return nonEmptyString(record.id)
    && nonEmptyString(record.stepId)
    && nonEmptyString(record.exchangeId)
    && nonEmptyString(record.protocol)
    && optionalString(record.model)
    && stringArray(record.systemPromptHashes)
    && stringArray(record.developerPromptHashes)
    && stringArray(record.conversationItemHashes)
    && stringArray(record.toolSchemaHashes)
    && nonEmptyString(record.paramsHash)
    && nonNegativeInteger(record.toolSchemaCount)
    && nonEmptyString(record.totalStableHash)
    && Array.isArray(record.remoteStateReferences)
    && Array.isArray(record.evidence)
    && !!summary
    && !!objectRecord(summary.intent)
    && Array.isArray(summary.systemPrompts)
    && Array.isArray(summary.developerPrompts)
    && Array.isArray(summary.userPrompts)
    && (summary.userPromptObservability === "complete" || summary.userPromptObservability === "partial")
    && nonNegativeInteger(summary.conversationItemCount)
    && nonNegativeInteger(summary.toolSchemaCount)
    && Array.isArray(summary.requestedToolUses)
    && Array.isArray(summary.providedToolResults)
    && nonNegativeInteger(summary.reasoningItemCount)
    && !!objectRecord(summary.params)
    && nonEmptyString(summary.stableHash)
    && nonNegativeInteger(summary.evidenceCount);
}

function isCompleteStepDiff(record: Record<string, unknown>): boolean {
  const changedTools = objectRecord(record.changedTools);
  const contextView = record.contextView === undefined
    ? undefined
    : objectRecord(record.contextView);
  return nonEmptyString(record.id)
    && optionalString(record.fromStepId)
    && nonEmptyString(record.toStepId)
    && optionalString(record.fromSnapshotId)
    && nonEmptyString(record.toSnapshotId)
    && Array.isArray(record.addedMessages)
    && Array.isArray(record.removedMessages)
    && Array.isArray(record.addedToolResults)
    && Array.isArray(record.removedToolResults)
    && Array.isArray(record.addedAssistantToolUses)
    && Array.isArray(record.removedAssistantToolUses)
    && Array.isArray(record.changedSystem)
    && Array.isArray(record.changedParams)
    && Array.isArray(record.contextTrimming)
    && stringArray(record.summary)
    && Array.isArray(record.evidence)
    && !!changedTools
    && stringArray(changedTools.added)
    && stringArray(changedTools.removed)
    && Array.isArray(changedTools.changed)
    && nonNegativeInteger(changedTools.beforeCount)
    && nonNegativeInteger(changedTools.afterCount)
    && (record.contextView === undefined
      || (!!contextView
        && Array.isArray(contextView.targetRows)
        && Array.isArray(contextView.removedRows)));
}

function placeholderIds(prefix: string, count: number): string[] {
  const boundedCount = Math.min(count, MAX_RUNTIME_TOOL_IDS);
  return Array.from({ length: boundedCount }, (_, index) => `${prefix}-${index}`);
}

/** 套餐估算折算明细透传（类型收敛；非法字段剔除，空对象缺省）。 */
function objectRecord(value: unknown): Record<string, unknown> | undefined {  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || nonNegativeNumber(value);
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value);
}
