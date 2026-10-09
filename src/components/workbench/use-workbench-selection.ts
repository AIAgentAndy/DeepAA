"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import type {
  WorkbenchSelectionPath,
  WorkbenchTreePage,
} from "@/lib/db/workbench-queries";

const BUSINESS_KEYS = ["target", "agent", "session", "thread", "turn", "step"] as const;
/** 页面私有参数：业务跳转不传播，但本页 URL 改写时必须原样保留（时间范围）。 */
const PRESERVED_KEYS = ["start", "end"] as const;
const WORKER_STATES = new Set(["idle", "running", "paused_disk", "failed"]);

export type WorkbenchView = "session" | "thread" | "turn";

export interface WorkbenchClientSelection {
  target?: string;
  agent?: string;
  session?: string;
  thread?: string;
  turn?: string;
  step?: string;
  ancestorThreadIds?: string[];
}

export interface WorkbenchSelectionResponse {
  latestPath?: WorkbenchSelectionPath;
  resolvedPath?: WorkbenchSelectionPath;
  dataVersion: number;
  derivedStatus: "idle" | "running" | "paused_disk" | "failed";
}

interface UseWorkbenchSelectionOptions {
  initialQuery: string;
  initialPath?: WorkbenchSelectionPath;
  /** 本页私有参数（start/end）的当前值来源：业务 URL 改写时原样带回。 */
  preservedParamsRef?: RefObject<URLSearchParams | null>;
}

/** 只写六级公共路径和当前页 view，选中上级时主动清理所有下级参数。 */
export function canonicalWorkbenchParams(
  selection: WorkbenchClientSelection,
  view: WorkbenchView,
): URLSearchParams {
  const params = new URLSearchParams();
  setParam(params, "target", selection.target);
  setParam(params, "agent", selection.agent);
  setParam(params, "session", selection.session);
  if (view === "thread" || view === "turn") {
    if (selection.thread) params.set("thread", selection.thread);
  }
  if (view === "turn") {
    setParam(params, "turn", selection.turn);
    setParam(params, "step", selection.step);
  }
  params.set("view", view);
  return params;
}

export function chooseSelectionPath(
  payload: WorkbenchSelectionResponse,
  hasExplicitBusinessPath: boolean,
): WorkbenchSelectionPath | undefined {
  return hasExplicitBusinessPath ? payload.resolvedPath : payload.latestPath;
}

/**
 * 当前选中业务路径所属的 Agent 组。Agent 维度会话（2026-09-17）后组只按 Agent
 * 分组，Session 可跨供应商（target 降级为 Step 级过滤条件），因此树上点选构建的
 * selection 不携带 target——这里绝不能把 target 作为前置条件，否则点选后
 * selectedSession 全部失配（业务 Session 显示"-"、会话来源退回"内部派生"）。
 */
export function findSelectedAgentGroup(
  tree: WorkbenchTreePage,
  selection: WorkbenchClientSelection | undefined,
): WorkbenchTreePage["agents"][number] | undefined {
  if (!selection?.agent) return undefined;
  return tree.agents.find(group => group.agentName === selection.agent);
}

export type SelectionRestoreOutcome =
  | { kind: "empty" }
  | { kind: "path"; path: WorkbenchSelectionPath };

/** 缺少派生路径是正常空数据状态；只有请求或响应异常才进入错误态。 */
export function resolveSelectionRestoreOutcome(
  payload: WorkbenchSelectionResponse,
  hasExplicitBusinessPath: boolean,
): SelectionRestoreOutcome {
  const path = chooseSelectionPath(payload, hasExplicitBusinessPath);
  return path ? { kind: "path", path } : { kind: "empty" };
}

export function parseWorkbenchSelectionResponse(
  value: unknown,
): WorkbenchSelectionResponse | undefined {
  const record = objectRecord(value);
  if (
    !record
    || !optionalSelectionPath(record.latestPath)
    || !optionalSelectionPath(record.resolvedPath)
    || !nonNegativeInteger(record.dataVersion)
    || typeof record.derivedStatus !== "string"
    || !WORKER_STATES.has(record.derivedStatus)
  ) {
    return undefined;
  }
  return {
    latestPath: record.latestPath as WorkbenchSelectionPath | undefined,
    resolvedPath: record.resolvedPath as WorkbenchSelectionPath | undefined,
    dataVersion: record.dataVersion,
    derivedStatus: record.derivedStatus as WorkbenchSelectionResponse["derivedStatus"],
  };
}

export function parseWorkbenchTreePage(value: unknown): WorkbenchTreePage | undefined {
  const record = objectRecord(value);
  if (
    !record
    || !Array.isArray(record.agents)
    || !record.agents.every(isWorkbenchAgent)
    || !optionalSelectionPath(record.latestPath)
    || !optionalSelectionPath(record.resolvedPath)
    || !nonNegativeInteger(record.candidateCount)
    || !nonNegativeInteger(record.processedCount)
    || typeof record.limited !== "boolean"
    || typeof record.hasMore !== "boolean"
    || !optionalString(record.nextCursor)
    || !nonNegativeInteger(record.dataVersion)
    || typeof record.derivedStatus !== "string"
    || !WORKER_STATES.has(record.derivedStatus)
    || (record.backlogPendingCount !== undefined
      && !nonNegativeInteger(record.backlogPendingCount))
  ) {
    return undefined;
  }
  return record as unknown as WorkbenchTreePage;
}

/** 自动刷新只保留服务端最新页和当前选择，避免页面驻留期间 Session 状态持续增长。 */
export function refreshWorkbenchTreePage(
  current: WorkbenchTreePage,
  incoming: WorkbenchTreePage,
  protectedSessionId: string | undefined,
  capacity = 51,
): WorkbenchTreePage {
  const boundedCapacity = Math.max(1, Math.floor(capacity));
  const entries = incoming.agents.flatMap(group => (
    group.sessions.map(session => ({ group, session }))
  )).slice(0, boundedCapacity);
  if (
    protectedSessionId
    && !entries.some(entry => entry.session.id === protectedSessionId)
  ) {
    const protectedEntry = current.agents.flatMap(group => (
      group.sessions.map(session => ({ group, session }))
    )).find(entry => entry.session.id === protectedSessionId);
    if (protectedEntry) {
      if (entries.length >= boundedCapacity) entries.pop();
      entries.push(protectedEntry);
    }
  }

  const groups = new Map<string, WorkbenchTreePage["agents"][number]>();
  for (const { group, session } of entries) {
    // Agent 维度会话（2026-09-17）：一 Agent 一组。
    const key = group.agentFingerprintId;
    const existing = groups.get(key);
    groups.set(key, existing
      ? { ...existing, sessions: [...existing.sessions, session] }
      : { ...group, sessions: [session] });
  }
  return { ...incoming, agents: [...groups.values()] };
}

export function useWorkbenchSelection({
  initialQuery,
  initialPath,
  preservedParamsRef,
}: UseWorkbenchSelectionOptions) {
  const router = useRouter();
  const initialParams = useRef(new URLSearchParams(initialQuery));
  const explicitBusinessPath = useRef(hasBusinessPath(initialParams.current));
  const initialResolvedView = useRef(resolvedWorkbenchView(
    initialParams.current,
    initialPath,
  ));
  const [selection, setSelection] = useState<WorkbenchClientSelection | undefined>(
    () => selectionAtView(initialPath, initialResolvedView.current),
  );
  const [view, setView] = useState<WorkbenchView>(initialResolvedView.current);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(
    () => expandedPath(selectionAtView(initialPath, initialResolvedView.current)),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const requestSequence = useRef(0);

  /** 业务参数 + 本页私有参数（时间范围）合并成完整 URL 查询。 */
  const urlWithPreservedParams = useCallback((selectionPath: WorkbenchClientSelection, nextView: WorkbenchView) => {
    const params = canonicalWorkbenchParams(selectionPath, nextView);
    const preserved = preservedParamsRef?.current;
    if (preserved) {
      for (const key of PRESERVED_KEYS) {
        const value = preserved.get(key)?.trim();
        if (value) params.set(key, value);
      }
    }
    return params;
  }, [preservedParamsRef]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const requestParams = publicBusinessParams(initialParams.current);
    const query = requestParams.toString();
    setLoading(true);
    setError("");
    void fetch(`/api/workbench-selection${query ? `?${query}` : ""}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = parseWorkbenchSelectionResponse(await response.json());
      if (!payload) throw new Error("服务端返回了无效的选择路径");
      const outcome = resolveSelectionRestoreOutcome(payload, explicitBusinessPath.current);
      if (sequence !== requestSequence.current) return;
      if (outcome.kind === "empty") {
        setSelection(undefined);
        setView("session");
        setExpandedThreadIds(new Set());
        setLoading(false);
        setError("");
        const emptyParams = urlWithPreservedParams({}, "session");
        router.replace(emptyParams.toString()
          ? `/sessions?${emptyParams}`
          : "/sessions", { scroll: false });
        return;
      }
      const path = outcome.path;
      const nextView = resolvedWorkbenchView(initialParams.current, path);
      const nextSelection = selectionAtView(path, nextView);
      if (!nextSelection) throw new Error("规范选择路径为空");
      setSelection(nextSelection);
      setView(nextView);
      setExpandedThreadIds(expandedPath(nextSelection));
      router.replace(`/sessions?${urlWithPreservedParams(nextSelection, nextView)}`, { scroll: false });
      setLoading(false);
    }).catch(cause => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setLoading(false);
      setError(cause instanceof Error ? cause.message : "选择路径恢复失败");
    });
    return () => controller.abort();
  }, [retryNonce, router, urlWithPreservedParams]);

  const replaceSelection = useCallback((
    nextSelection: WorkbenchClientSelection,
    nextView: WorkbenchView,
  ) => {
    requestSequence.current += 1;
    setSelection(selectionAtView(nextSelection, nextView));
    setView(nextView);
    setLoading(false);
    setError("");
    if (nextSelection.thread) {
      const threadId = nextSelection.thread;
      setExpandedThreadIds(current => {
        const next = new Set(current);
        for (const id of nextSelection.ancestorThreadIds || []) next.add(id);
        // 选中 Thread 本身也要展开，保证自动选中的 Turn 列表可见。
        next.add(threadId);
        return next;
      });
    }
    router.replace(
      `/sessions?${urlWithPreservedParams(nextSelection, nextView)}`,
      { scroll: false },
    );
  }, [router, urlWithPreservedParams]);

  /**
   * 仅在内存中更新选中状态，不改写 URL 也不触发 router.replace。
   * 用于「点选 Turn 后等待 step 落地」等场景：先让 UI 立即响应点击，
   * 待 step 拿到再由 replaceSelection 一次性写 URL，避免一次点击触发两次路由更新造成的页面跳动。
   */
  const setSelectionInMemory = useCallback((
    nextSelection: WorkbenchClientSelection,
    nextView: WorkbenchView,
  ) => {
    requestSequence.current += 1;
    setSelection(selectionAtView(nextSelection, nextView));
    setView(nextView);
    setLoading(false);
    setError("");
    if (nextSelection.thread) {
      const threadId = nextSelection.thread;
      setExpandedThreadIds(current => {
        const next = new Set(current);
        for (const id of nextSelection.ancestorThreadIds || []) next.add(id);
        next.add(threadId);
        return next;
      });
    }
  }, []);

  /**
   * 全量重置（「重置」按钮，2026-09-23 用户确认语义）：清空选择与展开态，URL 归位为
   * 不带任何查询参数的 /sessions，并**立即按「裸加载」语义重新恢复**——清掉挂载时
   * 固化的六级业务深链参数（否则数据刷新触发的 retry 会把旧深链原样写回），让恢复
   * 请求回落 latestPath：页面马上自动跟随最新的 session → thread → turn → step，
   * 与首次打开 /sessions 的行为完全一致（URL 随选中规范写回业务参数 + start/end）。
   * 时间范围的复位由调用方完成并通过 range 注入，保证恢复请求与树请求同源。
   */
  const clearSelection = useCallback((range?: {start: string; end: string}) => {
    for (const key of BUSINESS_KEYS) initialParams.current.delete(key);
    if (range) {
      initialParams.current.set("start", range.start);
      initialParams.current.set("end", range.end);
    }
    // 无显式业务路径 => 恢复请求选择 latestPath（范围内最新会话），而非 resolvedPath。
    explicitBusinessPath.current = false;
    requestSequence.current += 1;
    setSelection(undefined);
    setView("session");
    setExpandedThreadIds(new Set());
    setLoading(false);
    setError("");
    router.replace("/sessions", { scroll: false });
    // 立即重跑恢复 effect：清参后的 initialParams 生效（ref 同步可变，effect 运行时读取）。
    setRetryNonce(value => value + 1);
  }, [router]);

  return {
    selection,
    view,
    expandedThreadIds,
    setExpandedThreadIds,
    loading,
    error,
    retry: () => setRetryNonce(value => value + 1),
    replaceSelection,
    setSelectionInMemory,
    clearSelection,
  };
}

function expandedPath(path: WorkbenchClientSelection | undefined): Set<string> {
  if (!path?.thread) return new Set();
  return new Set([...(path.ancestorThreadIds || []), path.thread]);
}

export function selectionAtView(
  selection: WorkbenchClientSelection | undefined,
  view: WorkbenchView,
): WorkbenchClientSelection | undefined {
  if (!selection) return undefined;
  const base = {
    target: selection.target,
    agent: selection.agent,
    session: selection.session,
  };
  if (view === "session") return base;
  const thread = {
    ...base,
    thread: selection.thread,
    ancestorThreadIds: selection.ancestorThreadIds,
  };
  if (view === "thread") return thread;
  return {
    ...thread,
    turn: selection.turn,
    step: selection.step,
  };
}

export function resolvedWorkbenchView(
  params: URLSearchParams,
  path: WorkbenchClientSelection | undefined,
): WorkbenchView {
  const requested = params.get("view");
  if (requested === "session" || requested === "thread" || requested === "turn") {
    return requested;
  }
  if (params.has("turn") || params.has("step")) return "turn";
  if (params.has("thread")) return "thread";
  if (params.has("session")) return "session";
  if (path?.turn) return "turn";
  if (path?.thread) return "thread";
  return "session";
}

function hasBusinessPath(params: URLSearchParams): boolean {
  return BUSINESS_KEYS.some(key => !!params.get(key)?.trim());
}

function publicBusinessParams(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const key of BUSINESS_KEYS) {
    const value = params.get(key)?.trim();
    if (value) result.set(key, value);
  }
  // 时间范围参与「范围内最新会话」的自动选择：恢复选择请求必须与树请求同源。
  for (const key of PRESERVED_KEYS) {
    const value = params.get(key)?.trim();
    if (value) result.set(key, value);
  }
  return result;
}

function optionalSelectionPath(value: unknown): boolean {
  if (value === undefined) return true;
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.target)
    && nonEmptyString(record.agent)
    && nonEmptyString(record.session)
    && nonEmptyString(record.thread)
    && optionalString(record.turn)
    && optionalString(record.step)
    && Array.isArray(record.ancestorThreadIds)
    && record.ancestorThreadIds.every(nonEmptyString);
}

/**
 * Agent 维度分组（2026-09-17 起）：一个 Agent 一组，target 已不在分组里
 * （Session 的 target 降级为 Step 级过滤条件）。校验字段必须与
 * `WorkbenchTreePage["agents"][number]` 保持一致，契约由
 * tests/sqlite-workbench-queries.test.ts 的往返用例锁定。
 */
function isWorkbenchAgent(value: unknown): boolean {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.agentFingerprintId)
    && nonEmptyString(record.agentName)
    && Array.isArray(record.sessions)
    && record.sessions.every(isWorkbenchSession);
}

function isWorkbenchSession(value: unknown): boolean {
  const record = objectRecord(value);
  return !!record
    && nonEmptyString(record.id)
    && optionalString(record.externalSessionId)
    && nonEmptyString(record.startTime)
    && nonEmptyString(record.endTime)
    && Array.isArray(record.modelSet)
    && record.modelSet.every(item => typeof item === "string")
    && typeof record.modelSetLimited === "boolean"
    && nonNegativeInteger(record.requestCount)
    && nonNegativeInteger(record.threadCount);
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

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function setParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value?.trim()) params.set(key, value);
}
