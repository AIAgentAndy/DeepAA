import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {
  WorkbenchSessionSearchGroup,
  WorkbenchSessionSearchResult,
  WorkbenchSessionSearchSession,
  WorkbenchSessionSearchThread,
  WorkbenchSessionSearchTurn,
} from "../workbench-search-client";
import { parseOptionalWorkbenchRange } from "../workbench-time-range";
import { decodeCursor, encodeCursor } from "./cursors";
import { readDerivationStatus } from "./workbench-queries";

/**
 * 会话树模糊搜索：按 session（外部 ID / 内部 ID）子串匹配，结果按
 * 「供应商 × Agent」分组，每个会话带前 N 个 Thread、每个 Thread 带前 N 个
 * Turn 的有界预览，供左侧树搜索时一次性展开到 Turn 层级。
 *
 * 有界约束：
 * - 会话：keyset 分页（end_time DESC, id DESC），默认 60、上限 100；
 * - Thread：每会话前 THREADS_PER_SESSION 个（窗口函数批读取）；
 * - Turn：每 Thread 前 TURNS_PER_THREAD 个（窗口函数批读取）；
 * - 所有计数（candidateCount / threadCount / turnCount / stepCount）都来自
 *   物化列或一次 COUNT，不在内存里拼装大集合。
 */

const DEFAULT_SESSION_LIMIT = 60;
const MAX_SESSION_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;
const THREADS_PER_SESSION = 10;
const TURNS_PER_THREAD = 20;

interface SessionSearchRow {
  id: string;
  target_id: string;
  target_name: string;
  agent_fingerprint_id: string;
  agent_name: string;
  external_session_id: string | null;
  start_time: string;
  end_time: string;
  request_count: number;
  thread_count: number;
}

interface ThreadSearchRow {
  agent_session_id: string;
  id: string;
  display_name: string;
  is_root: number;
  start_time: string;
  end_time: string;
  turn_count: number;
}

interface TurnSearchRow {
  agent_thread_id: string;
  id: string;
  start_time: string;
  end_time: string;
  step_count: number;
}

export function loadWorkbenchSessionSearch(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): WorkbenchSessionSearchResult {
  const state = readDerivationStatus(db);
  const rawQuery = searchParams.get("q")?.trim() ?? "";
  const query = rawQuery.slice(0, MAX_QUERY_LENGTH);
  const emptyResult: WorkbenchSessionSearchResult = {
    query,
    groups: [],
    candidateCount: 0,
    processedCount: 0,
    limited: false,
    hasMore: false,
    dataVersion: state.dataVersion,
    derivedStatus: state.status,
  };
  if (!query) return emptyResult;

  const limit = boundedLimit(searchParams);
  const cursor = decodeCursor(searchParams.get("cursor"));
  const timeRange = parseOptionalWorkbenchRange(searchParams);
  const match = sessionMatchCondition(query);
  const rangeFilter = timeConditions(timeRange);

  const countConditions = [match.condition, ...rangeFilter.conditions];
  const candidateCount = db.prepare(
    `SELECT COUNT(*) FROM agent_sessions WHERE ${countConditions.join(" AND ")}`,
  ).pluck().get(...match.parameters, ...rangeFilter.parameters) as number;

  const pageConditions = [...countConditions];
  const pageParameters = [...match.parameters, ...rangeFilter.parameters];
  if (cursor) {
    pageConditions.push("(end_time < ? OR (end_time = ? AND id < ?))");
    pageParameters.push(cursor.time, cursor.time, cursor.id);
  }
  const rows = db.prepare(
    `SELECT id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, start_time, end_time, request_count, thread_count
     FROM agent_sessions
     WHERE ${pageConditions.join(" AND ")}
     ORDER BY end_time DESC, id DESC
     LIMIT ?`,
  ).all(...pageParameters, limit + 1) as SessionSearchRow[];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const threadsBySession = loadThreadsForSessions(db, pageRows.map(row => row.id));
  const turnsByThread = loadTurnsForThreads(
    db,
    [...threadsBySession.values()].flatMap(threads => threads.map(thread => thread.id)),
  );

  const groups = new Map<string, WorkbenchSessionSearchGroup>();
  for (const row of pageRows) {
    // Agent 维度会话（2026-09-17）：一 Agent 一组；target 不再参与分组。
    const groupKey = row.agent_fingerprint_id;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        agentFingerprintId: row.agent_fingerprint_id,
        agentName: row.agent_name,
        sessions: [],
      };
      groups.set(groupKey, group);
    }
    group.sessions.push(toSessionSummary(row, threadsBySession.get(row.id) ?? [], turnsByThread));
  }

  const lastRow = pageRows.at(-1);
  return {
    query,
    groups: [...groups.values()],
    candidateCount,
    processedCount: rows.length,
    limited: hasMore,
    hasMore,
    nextCursor: hasMore && lastRow
      ? encodeCursor({ time: lastRow.end_time, id: lastRow.id })
      : undefined,
    dataVersion: state.dataVersion,
    derivedStatus: state.status,
  };
}

/** 子串匹配（大小写不敏感）：外部 ID 与内部 ID 皆可命中；LIKE 通配符转义。 */
function sessionMatchCondition(query: string): { condition: string; parameters: string[] } {
  const escaped = query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .toLowerCase();
  const pattern = `%${escaped}%`;
  return {
    condition:
      "(LOWER(COALESCE(external_session_id, '')) LIKE ? ESCAPE '\\'\n"
      + "       OR LOWER(id) LIKE ? ESCAPE '\\')",
    parameters: [pattern, pattern],
  };
}

function timeConditions(
  timeRange: ReturnType<typeof parseOptionalWorkbenchRange>,
): { conditions: string[]; parameters: string[] } {
  if (!timeRange) return { conditions: [], parameters: [] };
  return {
    conditions: ["end_time >= ?", "start_time < ?"],
    parameters: [timeRange.start, timeRange.end],
  };
}

/** 一次窗口查询批取每个会话最新的 N 个 Thread；总 threadCount / turnCount 用物化列。 */
function loadThreadsForSessions(
  db: DeepaaDatabase,
  sessionIds: string[],
): Map<string, Omit<WorkbenchSessionSearchThread, "turns" | "turnsLimited">[]> {
  const result = new Map<string, Omit<WorkbenchSessionSearchThread, "turns" | "turnsLimited">[]>();
  if (sessionIds.length === 0) return result;
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT agent_session_id, id, display_name, is_root, start_time, end_time, turn_count
     FROM (
       SELECT t.agent_session_id, t.id, t.display_name, t.is_root, t.start_time, t.end_time, t.turn_count,
         ROW_NUMBER() OVER (
           PARTITION BY t.agent_session_id
           ORDER BY t.end_time DESC, t.id DESC
         ) AS rn
       FROM agent_threads t
       WHERE t.agent_session_id IN (${placeholders})
     )
     WHERE rn <= ${THREADS_PER_SESSION}
     ORDER BY agent_session_id, end_time DESC, id DESC`,
  ).all(...sessionIds) as ThreadSearchRow[];
  for (const row of rows) {
    const list = result.get(row.agent_session_id) ?? [];
    list.push({
      id: row.id,
      displayName: row.display_name,
      isRoot: row.is_root === 1,
      startTime: row.start_time,
      endTime: row.end_time,
      turnCount: row.turn_count,
    });
    result.set(row.agent_session_id, list);
  }
  return result;
}

/** 一次窗口查询批取每个 Thread 最新的 N 个 Turn；总 turnCount 用物化列。 */
function loadTurnsForThreads(
  db: DeepaaDatabase,
  threadIds: string[],
): Map<string, { turns: WorkbenchSessionSearchTurn[]; limited: boolean }> {
  const result = new Map<string, { turns: WorkbenchSessionSearchTurn[]; limited: boolean }>();
  if (threadIds.length === 0) return result;
  const placeholders = threadIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT agent_thread_id, id, start_time, end_time, step_count
     FROM (
       SELECT t.agent_thread_id, t.id, t.start_time, t.end_time, t.step_count,
         ROW_NUMBER() OVER (
           PARTITION BY t.agent_thread_id
           ORDER BY t.end_time DESC, t.id DESC
         ) AS rn
       FROM agent_turns t
       WHERE t.agent_thread_id IN (${placeholders})
     )
     WHERE rn <= ${TURNS_PER_THREAD + 1}
     ORDER BY agent_thread_id, end_time DESC, id DESC`,
  ).all(...threadIds) as TurnSearchRow[];
  for (const row of rows) {
    const entry = result.get(row.agent_thread_id) ?? { turns: [], limited: false };
    if (entry.turns.length < TURNS_PER_THREAD) {
      entry.turns.push({
        id: row.id,
        startTime: row.start_time,
        endTime: row.end_time,
        stepCount: row.step_count,
      });
    } else {
      entry.limited = true;
    }
    result.set(row.agent_thread_id, entry);
  }
  return result;
}

function toSessionSummary(
  row: SessionSearchRow,
  threadPreviews: Omit<WorkbenchSessionSearchThread, "turns" | "turnsLimited">[],
  turnsByThread: Map<string, { turns: WorkbenchSessionSearchTurn[]; limited: boolean }>,
): WorkbenchSessionSearchSession {
  const threads: WorkbenchSessionSearchThread[] = threadPreviews.map(thread => {
    const turnEntry = turnsByThread.get(thread.id);
    return {
      ...thread,
      turnsLimited: turnEntry?.limited ?? false,
      turns: turnEntry?.turns ?? [],
    };
  });
  return {
    id: row.id,
    externalSessionId: row.external_session_id ?? undefined,
    startTime: row.start_time,
    endTime: row.end_time,
    requestCount: row.request_count,
    threadCount: row.thread_count,
    threadsLimited: row.thread_count > threads.length,
    threads,
  };
}

function boundedLimit(searchParams: URLSearchParams): number {
  const raw = Number(searchParams.get("limit"));
  if (!Number.isSafeInteger(raw) || raw <= 0) return DEFAULT_SESSION_LIMIT;
  return Math.min(raw, MAX_SESSION_LIMIT);
}
