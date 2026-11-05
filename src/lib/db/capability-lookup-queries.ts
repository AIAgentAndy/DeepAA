/**
 * P1-4（2026-11-03）：能力双向反查（最小版·仅会话观测身份）。
 *
 * 在能力台账（P1-5 本机扫描）落地前，反查以「Agent + 名字」为身份锚——诚实标注
 * coverage=name-level（同名跨 MCP/插件的歧义待 F2 真实样本与台账后消除，候选不
 * 冒充精确）。全部查询走 v55 索引（idx_tools_name_time / idx_steps_snapshot），
 * keyset 分页；快照表按 agent 过滤后 LIKE 精确匹配（"name":"<name>" 含尾引号，
 * 不误中前缀名，LIKE 字符转义）。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

export interface CapabilityLookupCallRow {
  stepId: string;
  exchangeId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  stepIndex: number;
  agentName: string;
  targetId: string;
  capturedAt: string;
  status: string;
  /** P2-a：与 wire tool_use_id 同源的原生执行侧证据（zcode tool_usage;无则缺省）。 */
  toolUseId?: string;
  execution?: {
    status: string | null;
    approvalStatus: string | null;
    durationMs: number | null;
    timeToFirstOutputMs: number | null;
    exitCode: number | null;
    retryCount: number | null;
    cancelledByUser: boolean;
    errorType: string | null;
  };
}

export interface CapabilityLookupDeclaredRow {
  stepId: string;
  exchangeId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  stepIndex: number;
  capturedAt: string;
  /** 该步调用过此工具的次数（step 级精确计数，idx_tools_step_name_status）。 */
  invokedThisStep: number;
}

export interface CapabilityLookupResult {
  identity: {
    kind: "tool" | "skill";
    name: string;
    agentName: string;
    /** 诚实标注：名字级身份（同名歧义未消除）。 */
    coverage: "name-level";
  };
  totals: {
    declaredStepCount: number;
    invokedStepCount: number;
    invokedCallCount: number;
    lastActivityAt?: string;
  };
  calls: {
    items: CapabilityLookupCallRow[];
    candidateCount: number;
    processedCount: number;
    hasMore: boolean;
    nextCursor?: string;
    limited: boolean;
  };
  declaredIn: {
    items: CapabilityLookupDeclaredRow[];
    candidateCount: number;
    processedCount: number;
    hasMore: boolean;
    limited: boolean;
  };
}

export const CAPABILITY_LOOKUP_PAGE_LIMIT = 20;

export function lookupCapability(
  db: DeepaaDatabase,
  input: {agentName: string; kind: "tool" | "skill"; name: string; cursor?: string},
): CapabilityLookupResult | undefined {
  const {agentName, kind, name} = input;
  if (!agentName || !name) return undefined;
  const limit = CAPABILITY_LOOKUP_PAGE_LIMIT;

  // 调用反查：idx_tools_name_time 覆盖 (tool_name, created_at) keyset（倒序）。
  const callRows = db.prepare(
    `SELECT t.agent_step_id AS step_id, t.exchange_id, t.agent_session_id AS session_id,
            t.agent_thread_id AS thread_id, t.agent_turn_id AS turn_id, t.status,
            t.created_at AS call_created_at, t.tool_use_id,
            se.agent_name, se.target_id, r.captured_at,
            e.status AS exec_status, e.approval_status AS exec_approval,
            e.duration_ms AS exec_duration, e.time_to_first_output_ms AS exec_ttfo,
            e.exit_code AS exec_exit_code, e.retry_count AS exec_retry,
            e.cancelled_by_user AS exec_cancelled, e.error_type AS exec_error_type
     FROM tool_calls t
     JOIN agent_sessions se ON se.id = t.agent_session_id
     JOIN raw_exchange_refs r ON r.exchange_id = t.exchange_id
     LEFT JOIN (
       SELECT tool_call_id, agent_name, status, approval_status, duration_ms,
              time_to_first_output_ms, exit_code, retry_count, cancelled_by_user, error_type,
              ROW_NUMBER() OVER (PARTITION BY tool_call_id ORDER BY synced_at DESC) AS rn
       FROM agent_tool_executions
     ) e ON e.tool_call_id = t.tool_use_id AND e.agent_name = se.agent_name AND e.rn = 1
     WHERE se.agent_name = ? AND t.tool_name = ?
       ${input.cursor ? "AND t.created_at < ?" : ""}
     ORDER BY t.created_at DESC LIMIT ? + 1`,
  ).all(agentName, name, ...(input.cursor ? [input.cursor] : []), limit + 1) as Array<{
    step_id: string; exchange_id: string; session_id: string; thread_id: string;
    turn_id: string; status: string; call_created_at: string; tool_use_id: string | null;
    agent_name: string; target_id: string; captured_at: string;
    exec_status: string | null; exec_approval: string | null; exec_duration: number | null;
    exec_ttfo: number | null; exec_exit_code: number | null; exec_retry: number | null;
    exec_cancelled: number | null; exec_error_type: string | null;
  }>;
  const callsHasMore = callRows.length > limit;
  const callPage = callsHasMore ? callRows.slice(0, limit) : callRows;
  const stepIndexRows = callPage.length > 0
    ? (db.prepare(
        `SELECT id, step_index FROM agent_steps WHERE id IN (${callPage.map(() => "?").join(",")})`,
      ).all(...callPage.map(row => row.step_id)) as Array<{id: string; step_index: number}>)
    : [];
  const stepIndexByStep = new Map(stepIndexRows.map(row => [row.id, row.step_index]));

  // 声明反查：快照按 agent 过滤 + JSON 精确匹配 → 哈希集合 → idx_steps_snapshot。
  const jsonColumn = kind === "tool" ? "tools_json" : "skills_json";
  const hashes = (db.prepare(
    `SELECT snapshot_hash FROM harness_snapshots
     WHERE agent_name = ? AND ${jsonColumn} LIKE ? ESCAPE '\\'`,
  ).all(agentName, `%"name":"${escapeLike(name)}"%`) as Array<{snapshot_hash: string}>)
    .map(row => row.snapshot_hash);
  const placeholders = hashes.map(() => "?").join(",");
  const declaredCount = hashes.length > 0
    ? (db.prepare(
        `SELECT COUNT(*) AS count FROM agent_steps WHERE harness_snapshot_hash IN (${placeholders})`,
      ).get(...hashes) as {count: number}).count
    : 0;
  const declaredRows = hashes.length > 0
    ? (db.prepare(
        `SELECT s.id AS step_id, s.exchange_id, s.agent_session_id AS session_id,
                s.agent_thread_id AS thread_id, s.agent_turn_id AS turn_id,
                s.step_index, r.captured_at
         FROM agent_steps s JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
         WHERE s.harness_snapshot_hash IN (${placeholders})
         ORDER BY r.captured_at DESC LIMIT ?`,
      ).all(...hashes, limit) as Array<{
        step_id: string; exchange_id: string; session_id: string; thread_id: string;
        turn_id: string; step_index: number; captured_at: string;
      }>)
    : [];
  const declaredItems: CapabilityLookupDeclaredRow[] = declaredRows.map(row => ({
    stepId: row.step_id,
    exchangeId: row.exchange_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    stepIndex: row.step_index,
    capturedAt: row.captured_at,
    invokedThisStep: kind === "tool"
      ? (db.prepare(
          `SELECT COUNT(*) AS count FROM tool_calls WHERE agent_step_id = ? AND tool_name = ?`,
        ).get(row.step_id, name) as {count: number}).count
      : 0,
  }));

  // 汇总。
  const totalsRow = db.prepare(
    `SELECT COUNT(*) AS calls, COUNT(DISTINCT t.agent_step_id) AS steps, MAX(t.created_at) AS last_at
     FROM tool_calls t JOIN agent_sessions se ON se.id = t.agent_session_id
     WHERE se.agent_name = ? AND t.tool_name = ?`,
  ).get(agentName, name) as {calls: number; steps: number; last_at: string | null};

  return {
    identity: {kind, name, agentName, coverage: "name-level"},
    totals: {
      declaredStepCount: declaredCount,
      invokedStepCount: totalsRow.steps,
      invokedCallCount: totalsRow.calls,
      ...(totalsRow.last_at ? {lastActivityAt: totalsRow.last_at} : {}),
    },
    calls: {
      items: callPage.map(row => ({
        stepId: row.step_id,
        exchangeId: row.exchange_id,
        sessionId: row.session_id,
        threadId: row.thread_id,
        turnId: row.turn_id,
        stepIndex: stepIndexByStep.get(row.step_id) ?? 0,
        agentName: row.agent_name,
        targetId: row.target_id,
        capturedAt: row.captured_at,
        status: row.status,
        ...(row.tool_use_id ? {toolUseId: row.tool_use_id} : {}),
        ...(row.exec_status !== null || row.exec_duration !== null ? {execution: {
          status: row.exec_status,
          approvalStatus: row.exec_approval,
          durationMs: row.exec_duration,
          timeToFirstOutputMs: row.exec_ttfo,
          exitCode: row.exec_exit_code,
          retryCount: row.exec_retry,
          cancelledByUser: row.exec_cancelled === 1,
          errorType: row.exec_error_type,
        }} : {}),
      })),
      candidateCount: totalsRow.calls,
      processedCount: callPage.length,
      hasMore: callsHasMore,
      ...(callsHasMore && callPage.length > 0 ? {nextCursor: callPage[callPage.length - 1]!.call_created_at} : {}),
      limited: callsHasMore,
    },
    declaredIn: {
      items: declaredItems,
      candidateCount: declaredCount,
      processedCount: declaredItems.length,
      hasMore: declaredCount > declaredItems.length,
      limited: declaredCount > declaredItems.length,
    },
  };
}

/** LIKE 转义（名字含 % 或 _ 时保持精确匹配）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}
