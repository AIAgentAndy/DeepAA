/**
 * P2-b（2026-11-04）：能力利用率首版（docs/Agent底层Harness剖析与推进方案 §11 最小版）。
 *
 * 口径（§11.1 可解释规则，不做黑箱总分）：
 * - 声明步数（暴露分母）＝窗口内、该 Agent 快照 tools_json 含该工具的不同 step 数
 *   （json_each 展开聚合，快照表小表有界）；
 * - 调用步数/次数＝tool_calls 聚合（idx_tools_name_time 索引族）；
 * - 步级调用覆盖率＝「声明过该工具的步中调用过它的步数」÷ 声明步数（§11.1 红线:
 *   分子必须是同分母子集——审计修订 A,仅调用/其它快照上的调用不计入分子,
 *   覆盖率恒 ≤100%;分母为 0 时 N/A——仅调用工具单列）;
 * - 执行侧（zcode）＝agent_tool_executions 聚合（平均耗时/错误/取消——P2-a 数据）；
 * - 低调用候选＝声明步数 ≥ 阈值且覆盖率 < 阈值（初始 10 步 / 20%，文档 §11.3 待确认值），
 *   仅观察结论，不下价值判断。
 *
 * 诚实性：借补参考清单计入声明分母（导入行无当次声明）——响应带 borrowedStepCount
 * 供 UI 注明；覆盖率是「观察窗口内」结论，绝不说「从未使用」。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

export interface CapabilityUsageRow {
  name: string;
  declaredSteps: number;
  invokedSteps: number;
  invokedCalls: number;
  /** 调用步数/声明步数;分母 0 时 undefined(仅调用工具)。 */
  coverage?: number;
  lastActivityAt?: string;
  /** 执行侧(zcode;其它 Agent 无数据为 undefined)。 */
  avgDurationMs?: number;
  executedCount?: number;
  errorCount?: number;
  cancelledCount?: number;
  /** 低调用候选(观察结论)。 */
  lowUseCandidate: boolean;
}

export interface CapabilityUsageResult {
  agentName: string;
  windowDays: number;
  windowStart: string;
  items: CapabilityUsageRow[];
  /** 窗口内含借补参考清单的 step 数(计入声明分母,UI 须注明)。 */
  borrowedStepCount: number;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  /** 初始阈值(§11.3 待确认产品值,响应透出供 UI 说明)。 */
  thresholds: {minDeclaredSteps: number; maxCoverage: number};
}

export const USAGE_MIN_DECLARED_STEPS = 10;
export const USAGE_MAX_COVERAGE = 0.2;
export const USAGE_MAX_ROWS = 200;

export function capabilityUsageForAgent(
  db: DeepaaDatabase,
  input: {agentName: string; windowDays: number},
): CapabilityUsageResult {
  const {agentName, windowDays} = input;
  const windowStart = new Date(Date.now() - windowDays * 24 * 3_600_000).toISOString();

  // 声明分母:窗口内该 Agent 的 step × 快照工具条目(json_each 展开小表)。
  // 审计修订 A(json_valid 防御):损坏的 tools_json 会使 json_each 抛错放大为整端点
  // 500——过滤无效行(写路径 jsonBounded 恒产合法 JSON,此为防御层)。
  const declaredRows = db.prepare(
    `SELECT json_extract(j.value, '$.name') AS name,
            COUNT(DISTINCT s.id) AS steps
     FROM agent_steps s
     JOIN harness_snapshots h ON h.snapshot_hash = s.harness_snapshot_hash
     JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id, json_each(h.tools_json) j
     WHERE h.agent_name = ? AND r.captured_at >= ? AND json_valid(h.tools_json)
     GROUP BY json_extract(j.value, '$.name')`,
  ).all(agentName, windowStart) as Array<{name: string; steps: number}>;

  // 调用聚合(全窗口;窗口过滤在 JOIN 侧完成)。
  // 调用聚合拆两个口径:总调用步/次数(分母无关,含 observed-only)与
  // 声明内调用步数(分子——仅计「该步快照声明了此工具」的调用,§11.1 子集红线)。
  const callRows = db.prepare(
    `SELECT t.tool_name AS name, COUNT(*) AS calls, COUNT(DISTINCT t.agent_step_id) AS steps,
            MAX(t.created_at) AS last_at
     FROM tool_calls t
     JOIN agent_sessions se ON se.id = t.agent_session_id
     JOIN raw_exchange_refs r ON r.exchange_id = t.exchange_id
     WHERE se.agent_name = ? AND r.captured_at >= ?
     GROUP BY t.tool_name`,
  ).all(agentName, windowStart) as Array<{name: string; calls: number; steps: number; last_at: string}>;
  // 审计(性能路):先在子查询按窗口+agent 收窄 tool_calls(消外层 SCAN t),
  // 再与快照展开做名字相等连接——窗口内行数有界。
  const invokedInDeclaredRows = db.prepare(
    `SELECT json_extract(j.value, '$.name') AS name, COUNT(DISTINCT tc.agent_step_id) AS steps
     FROM (
       SELECT t.agent_step_id, t.tool_name FROM tool_calls t
       JOIN agent_sessions se ON se.id = t.agent_session_id
       JOIN raw_exchange_refs r ON r.exchange_id = t.exchange_id
       WHERE se.agent_name = ? AND r.captured_at >= ?
     ) tc
     JOIN agent_steps s ON s.id = tc.agent_step_id
     JOIN harness_snapshots h ON h.snapshot_hash = s.harness_snapshot_hash, json_each(h.tools_json) j
     WHERE json_valid(h.tools_json)
       AND tc.tool_name = json_extract(j.value, '$.name')
     GROUP BY json_extract(j.value, '$.name')`,
  ).all(agentName, windowStart) as Array<{name: string; steps: number}>;
  const invokedInDeclared = new Map(invokedInDeclaredRows.map(row => [row.name, row.steps]));

  // 执行侧聚合(zcode 原生;其它 Agent 空集)。
  const execRows = new Map(
    (db.prepare(
      `SELECT tool_name AS name, COUNT(*) AS total,
              AVG(duration_ms) AS avg_duration,
              SUM(CASE WHEN status = 'error' OR exit_code NOT IN (0) THEN 1 ELSE 0 END) AS errors,
              SUM(cancelled_by_user) AS cancelled
       FROM agent_tool_executions
       WHERE agent_name = ? AND started_at >= ?
       GROUP BY tool_name`,
    ).all(agentName, Date.now() - windowDays * 24 * 3_600_000) as Array<{
      name: string; total: number; avg_duration: number | null;
      errors: number | null; cancelled: number | null;
    }>).map(row => [row.name, row]),
  );

  // 借补 step 计数(窗口内该 Agent 的借补诊断数,用于诚实标注)。
  const borrowedStepCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM derivation_diagnostics d
     JOIN raw_exchange_refs r ON r.exchange_id = d.exchange_id
     WHERE d.code = 'harness_inventory_borrowed' AND r.agent_name = ? AND r.captured_at >= ?`,
  ).get(agentName, windowStart) as {c: number}).c;

  const byName = new Map<string, CapabilityUsageRow>();
  for (const row of declaredRows) {
    byName.set(row.name, {
      name: row.name,
      declaredSteps: row.steps,
      invokedSteps: 0,
      invokedCalls: 0,
      lowUseCandidate: false,
    });
  }
  for (const row of callRows) {
    const existing = byName.get(row.name);
    if (existing) {
      existing.invokedSteps = invokedInDeclared.get(row.name) ?? 0;
      existing.invokedCalls = row.calls;
      if (row.last_at) existing.lastActivityAt = row.last_at;
    } else {
      byName.set(row.name, {
        name: row.name,
        declaredSteps: 0,
        invokedSteps: row.steps,
        invokedCalls: row.calls,
        ...(row.last_at ? {lastActivityAt: row.last_at} : {}),
        lowUseCandidate: false,
      });
    }
  }
  const items = [...byName.values()].map(row => {
    const exec = execRows.get(row.name);
    const coverage = row.declaredSteps > 0 ? row.invokedSteps / row.declaredSteps : undefined;
    return {
      ...row,
      ...(coverage !== undefined ? {coverage} : {}),
      ...(exec && exec.total > 0 ? {
        avgDurationMs: exec.avg_duration !== null ? Math.round(exec.avg_duration) : undefined,
        executedCount: exec.total,
        errorCount: exec.errors ?? 0,
        cancelledCount: exec.cancelled ?? 0,
      } : {}),
      lowUseCandidate: row.declaredSteps >= USAGE_MIN_DECLARED_STEPS
        && (coverage ?? 1) < USAGE_MAX_COVERAGE,
    };
  });
  // 排序:低调用候选优先(声明多而调用少最值得关注),其余按声明步数降序。
  items.sort((a, b) =>
    (Number(b.lowUseCandidate) - Number(a.lowUseCandidate))
    || (b.declaredSteps - a.declaredSteps)
    || a.name.localeCompare(b.name));
  const limited = items.length > USAGE_MAX_ROWS;
  const page = limited ? items.slice(0, USAGE_MAX_ROWS) : items;

  return {
    agentName,
    windowDays,
    windowStart,
    items: page,
    borrowedStepCount,
    candidateCount: items.length,
    processedCount: page.length,
    limited,
    thresholds: {minDeclaredSteps: USAGE_MIN_DECLARED_STEPS, maxCoverage: USAGE_MAX_COVERAGE},
  };
}
