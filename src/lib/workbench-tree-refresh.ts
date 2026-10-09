import type { CaptureSummary, DerivedStatus } from "./app-state";
import type { AgentSession } from "./harness";

type WorkbenchWorkerStatus = "idle" | "running" | "paused_disk" | "failed";

interface WorkbenchTreeSessionSummary {
  id: string;
  externalSessionId?: string;
  startTime: string;
  endTime: string;
  modelSet: string[];
  modelSetLimited: boolean;
  requestCount: number;
  threadCount: number;
}

interface WorkbenchTreeAgentSummary {
  targetId: string;
  targetName: string;
  agentFingerprintId: string;
  agentName: string;
  sessions: WorkbenchTreeSessionSummary[];
}

interface WorkbenchTreeSummaryPayload {
  agents: WorkbenchTreeAgentSummary[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  dataVersion: number;
  derivedStatus: WorkbenchWorkerStatus;
}

export interface WorkbenchTreeRefresh {
  captures: CaptureSummary[];
  agentSessions: AgentSession[];
  derivedStatus: DerivedStatus;
}

export interface WorkbenchTreeRetentionOptions {
  protectedIds: ReadonlySet<string>;
  maxItems: number;
}

export const WORKBENCH_REFRESH_CAPTURE_LIMIT = 51;
export const WORKBENCH_REFRESH_SESSION_LIMIT = 52;

/**
 * SQLite Worker 状态映射到旧工作台的三态展示。idle 表示当前没有待处理工作，
 * paused_disk 属于不可继续派生的异常态，不能误显示为派生完成。
 */
export function workbenchDerivedStatus(value: unknown): DerivedStatus | undefined {
  switch (value) {
    case "idle": return "ready";
    case "running": return "building";
    case "paused_disk":
    case "failed": return "failed";
    default: return undefined;
  }
}

/** 严格校验服务端轻量 DTO，结构异常时让调用方保留现有 UI 状态。 */
export function parseWorkbenchTreeRefresh(
  payload: unknown,
): WorkbenchTreeRefresh | undefined {
  if (!isWorkbenchTreeSummaryPayload(payload)) return undefined;
  const derivedStatus = workbenchDerivedStatus(payload.derivedStatus);
  if (!derivedStatus) return undefined;

  const captures: CaptureSummary[] = [];
  const agentSessions: AgentSession[] = [];
  for (const agent of payload.agents) {
    const captureId = `tree:${agent.targetId}:${agent.agentFingerprintId}`;
    const modelSet = uniqueStrings(
      agent.sessions.flatMap(session => session.modelSet),
    );
    captures.push({
      id: captureId,
      fileName: "轻量会话树",
      filePath: "",
      exchangeCount: agent.sessions.reduce(
        (total, session) => total + session.requestCount,
        0,
      ),
      startTime: earliestTime(agent.sessions.map(session => session.startTime)),
      endTime: latestTime(agent.sessions.map(session => session.endTime)),
      modelSet,
      targetSet: [agent.targetId],
      agentTurnCount: 0,
      fileSize: 0,
    });
    for (const session of agent.sessions) {
      agentSessions.push({
        id: session.id,
        agentFingerprintId: agent.agentFingerprintId,
        source: "manual",
        externalSessionId: session.externalSessionId,
        exchangeIds: [],
        auxiliaryExchangeIds: [],
        startTime: session.startTime,
        endTime: session.endTime,
        modelSet: session.modelSet,
        targetSet: [agent.targetId],
        confidence: "low",
        evidence: [],
      });
    }
  }
  return { captures, agentSessions, derivedStatus };
}

/** 当前页摘要排在前面，仅在硬上限内保留受保护的页外分组。 */
export function mergeWorkbenchTreeCaptures(
  current: CaptureSummary[],
  refresh: CaptureSummary[],
  options: WorkbenchTreeRetentionOptions,
): CaptureSummary[] {
  const currentById = new Map(current.map(item => [item.id, item]));
  const merged = refresh.map(item => ({
    ...item,
    agentTurnCount: currentById.get(item.id)?.agentTurnCount
      ?? item.agentTurnCount,
  }));
  return appendProtectedItems(merged, current, options);
}

/**
 * 只覆盖新 DTO 能保证正确的 Session 摘要；请求 ID、证据和 Thread 详情仍由
 * 已加载状态持有，不能因轻量轮询而清空。
 */
export function mergeWorkbenchTreeSessions(
  current: AgentSession[],
  refresh: AgentSession[],
  options: WorkbenchTreeRetentionOptions,
): AgentSession[] {
  const currentById = new Map(current.map(item => [item.id, item]));
  const merged = refresh.map(item => {
    const loaded = currentById.get(item.id);
    if (!loaded) return item;
    return {
      ...loaded,
      agentFingerprintId: item.agentFingerprintId,
      externalSessionId: item.externalSessionId,
      startTime: item.startTime,
      endTime: item.endTime,
      modelSet: item.modelSet,
      targetSet: item.targetSet,
    };
  });
  return appendProtectedItems(merged, current, options);
}

function appendProtectedItems<T extends { id: string }>(
  refresh: T[],
  current: T[],
  options: WorkbenchTreeRetentionOptions,
): T[] {
  const maxItems = Number.isSafeInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : 1;
  const result = refresh.slice(0, maxItems);
  const seen = new Set(result.map(item => item.id));
  for (const item of current) {
    if (result.length >= maxItems) break;
    if (!options.protectedIds.has(item.id) || seen.has(item.id)) continue;
    result.push(item);
    seen.add(item.id);
  }
  return result;
}

function isWorkbenchTreeSummaryPayload(
  value: unknown,
): value is WorkbenchTreeSummaryPayload {
  const record = objectRecord(value);
  return !!record
    && Array.isArray(record.agents)
    && record.agents.every(isWorkbenchTreeAgentSummary)
    && isNonNegativeInteger(record.candidateCount)
    && isNonNegativeInteger(record.processedCount)
    && typeof record.limited === "boolean"
    && typeof record.hasMore === "boolean"
    && optionalString(record.nextCursor)
    && isNonNegativeInteger(record.dataVersion)
    && isWorkerStatus(record.derivedStatus)
    && optionalSelectionPath(record.latestPath)
    && optionalSelectionPath(record.resolvedPath);
}

function isWorkbenchTreeAgentSummary(
  value: unknown,
): value is WorkbenchTreeAgentSummary {
  const record = objectRecord(value);
  return !!record
    && isNonEmptyString(record.targetId)
    && isNonEmptyString(record.targetName)
    && isNonEmptyString(record.agentFingerprintId)
    && isNonEmptyString(record.agentName)
    && Array.isArray(record.sessions)
    && record.sessions.every(isWorkbenchTreeSessionSummary);
}

function isWorkbenchTreeSessionSummary(
  value: unknown,
): value is WorkbenchTreeSessionSummary {
  const record = objectRecord(value);
  return !!record
    && isNonEmptyString(record.id)
    && optionalString(record.externalSessionId)
    && isNonEmptyString(record.startTime)
    && isNonEmptyString(record.endTime)
    && isStringArray(record.modelSet)
    && typeof record.modelSetLimited === "boolean"
    && isNonNegativeInteger(record.requestCount)
    && isNonNegativeInteger(record.threadCount);
}

function optionalSelectionPath(value: unknown): boolean {
  if (value === undefined) return true;
  const record = objectRecord(value);
  return !!record
    && isNonEmptyString(record.target)
    && isNonEmptyString(record.agent)
    && isNonEmptyString(record.session)
    && isNonEmptyString(record.thread)
    && optionalString(record.turn)
    && optionalString(record.step)
    && isStringArray(record.ancestorThreadIds);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isWorkerStatus(value: unknown): value is WorkbenchWorkerStatus {
  return value === "idle"
    || value === "running"
    || value === "paused_disk"
    || value === "failed";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function earliestTime(values: string[]): string | undefined {
  return values.reduce<string | undefined>(
    (earliest, value) => !earliest || value < earliest ? value : earliest,
    undefined,
  );
}

function latestTime(values: string[]): string | undefined {
  return values.reduce<string | undefined>(
    (latest, value) => !latest || value > latest ? value : latest,
    undefined,
  );
}
