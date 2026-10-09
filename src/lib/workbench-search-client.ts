/**
 * 会话树模糊搜索（客户端安全）：类型、响应解析与请求构造。
 * 服务端实现在 src/lib/db/workbench-search.ts，两端共用同一组形状约束，
 * 解析严格校验有界分页字段，防止把无界结果灌进会话树。
 */

export interface WorkbenchSessionSearchTurn {
  id: string;
  startTime: string;
  endTime: string;
  stepCount: number;
}

export interface WorkbenchSessionSearchThread {
  id: string;
  displayName: string;
  isRoot: boolean;
  startTime: string;
  endTime: string;
  turnCount: number;
  turnsLimited: boolean;
  turns: WorkbenchSessionSearchTurn[];
}

export interface WorkbenchSessionSearchSession {
  id: string;
  externalSessionId?: string;
  startTime: string;
  endTime: string;
  requestCount: number;
  threadCount: number;
  threadsLimited: boolean;
  threads: WorkbenchSessionSearchThread[];
}

export interface WorkbenchSessionSearchGroup {
  agentFingerprintId: string;
  agentName: string;
  sessions: WorkbenchSessionSearchSession[];
}

export interface WorkbenchSessionSearchResult {
  query: string;
  groups: WorkbenchSessionSearchGroup[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  dataVersion: number;
  derivedStatus: "idle" | "running" | "paused_disk" | "failed";
}

const WORKER_STATES = new Set(["idle", "running", "paused_disk", "failed"]);

/** 搜索请求 URL 构造：q 必填；start/end 为可选时间范围；cursor 翻页。 */
export function workbenchSessionSearchRequestUrl(
  query: string,
  options: { limit?: number; cursor?: string; start?: string; end?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set("q", query);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.start) params.set("start", options.start);
  if (options.end) params.set("end", options.end);
  return `/api/workbench-search?${params}`;
}

export function parseWorkbenchSessionSearchResult(
  value: unknown,
  expectedQuery: string,
): WorkbenchSessionSearchResult | undefined {
  const record = objectRecord(value);
  if (
    !record
    || record.query !== expectedQuery
    || !Array.isArray(record.groups)
    || !record.groups.every(isGroup)
    || !nonNegativeInteger(record.candidateCount)
    || !nonNegativeInteger(record.processedCount)
    || typeof record.limited !== "boolean"
    || typeof record.hasMore !== "boolean"
    || !optionalString(record.nextCursor)
    || !nonNegativeInteger(record.dataVersion)
    || typeof record.derivedStatus !== "string"
    || !WORKER_STATES.has(record.derivedStatus)
  ) {
    return undefined;
  }
  return record as unknown as WorkbenchSessionSearchResult;
}

function isGroup(value: unknown): value is WorkbenchSessionSearchGroup {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.agentFingerprintId)
    && nonEmptyString(record.agentName)
    && Array.isArray(record.sessions)
    && record.sessions.every(isSession);
}

function isSession(value: unknown): value is WorkbenchSessionSearchSession {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.id)
    && optionalString(record.externalSessionId)
    && nonEmptyString(record.startTime)
    && nonEmptyString(record.endTime)
    && nonNegativeInteger(record.requestCount)
    && nonNegativeInteger(record.threadCount)
    && typeof record.threadsLimited === "boolean"
    && Array.isArray(record.threads)
    && record.threads.every(isThread);
}

function isThread(value: unknown): value is WorkbenchSessionSearchThread {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.id)
    && nonEmptyString(record.displayName)
    && typeof record.isRoot === "boolean"
    && nonEmptyString(record.startTime)
    && nonEmptyString(record.endTime)
    && nonNegativeInteger(record.turnCount)
    && typeof record.turnsLimited === "boolean"
    && Array.isArray(record.turns)
    && record.turns.every(isTurn);
}

function isTurn(value: unknown): value is WorkbenchSessionSearchTurn {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.id)
    && nonEmptyString(record.startTime)
    && nonEmptyString(record.endTime)
    && nonNegativeInteger(record.stepCount);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || nonEmptyString(value);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
