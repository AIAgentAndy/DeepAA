import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {
  ConversationCategory,
  ExportFilters,
} from "../export-conversation";
import {
  INPUT_CONTENT_CATEGORY_SET,
  OUTPUT_CONTENT_CATEGORY_SET,
} from "../conversation-categories";

const DEFAULT_LIMIT = 5;
const HARD_LIMIT = 100;
const DEFAULT_FACET_LIMIT = 50;
export interface ExportFacetOption {
  value: string;
  label: string;
  timestamp?: string;
  session?: string;
  thread?: string;
  turn?: string;
}

export interface ExportFilterData {
  targets: ExportFacetOption[];
  agents: ExportFacetOption[];
  sessions: ExportFacetOption[];
  threads: ExportFacetOption[];
  turns: ExportFacetOption[];
  steps: ExportFacetOption[];
  limited: Record<"targets" | "agents" | "sessions" | "threads" | "turns" | "steps", boolean>;
}

export interface ExportFilterSelection {
  target?: string | string[];
  agent?: string | string[];
  session?: string;
  thread?: string;
  turn?: string;
  step?: string;
}

export interface ExportExchangeRef {
  exchangeId: string;
  captureSessionId: string;
  sourceId: number;
  sourceRelativePath: string;
  byteOffset: number;
  lineLengthBytes: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  previewSizeBytes: number;
  previewState: "complete" | "limited" | "unavailable" | "not_materialized";
  capturedAt: string;
  targetId: string;
  targetName: string;
  agentName: string;
  agentSessionId: string;
  agentThreadId: string;
  agentTurnId?: string;
  agentStepId?: string;
  isAuxiliary: boolean;
  isModelCall: boolean;
  /** 原始行来源（gateway / agent_local_import），用于降级判定与 UI 标注。 */
  origin: string;
  /** 原始行 capture diagnostics（导入降级标记等）。 */
  captureDiagnosticCodes: string[];
  /** HTTP 状态（列表行展示用；与投影 detail 同源）。 */
  httpStatus?: number;
  /** 完成时刻（列表行耗时 = completedAt - capturedAt）。 */
  completedAt?: string;
  /** 正文可用状态：purged 表示已被保留策略清理。 */
  rawState: "active" | "purged";
  /** 目标请求模型（列表行展示用）。 */
  model?: string;
}

export interface ExportExchangeRefPage {
  refs: ExportExchangeRef[];
  /** 未请求统计（skipCandidateCount）时为 undefined，UI 必须显示「未统计」而非 0。 */
  candidateCount: number | undefined;
  candidateCountExact: boolean;
  filterProjectionMissingCount: number;
  filterProjectionLimitedCount: number;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  hasMore: boolean;
}

interface ExportRefRow {
  exchange_id: string;
  capture_session_id: string;
  source_id: number;
  relative_path: string;
  byte_offset: number;
  line_length_bytes: number;
  request_body_bytes: number;
  response_body_bytes: number;
  preview_size_bytes: number | null;
  preview_state: "complete" | "limited" | "unavailable" | null;
  captured_at: string;
  target_id: string;
  target_name: string;
  agent_name: string;
  agent_session_id: string;
  agent_thread_id: string;
  agent_turn_id: string | null;
  agent_step_id: string | null;
  is_auxiliary: number;
  origin: string | null;
  diagnostic_codes_json: string | null;
  status: number | null;
  completed_at: string | null;
  raw_state: string | null;
  model: string | null;
}

export interface ExportRangeEstimate {
  candidateExchangeCount: number;
  declaredBodyBytes: number;
  maxDeclaredBodyBytes: number;
}

export interface ExportBodyBudgetViolation {
  exchangeId: string;
  declaredBodyBytes: number;
}

interface StepScopeRow {
  step_id: string;
  exchange_id: string;
  captured_at: string;
  agent_session_id: string;
}

interface CursorPayload {
  v: 2;
  capturedAt: string;
  exchangeId: string;
}

interface FacetRow {
  value: string;
  label_value?: string | null;
  timestamp?: string | null;
  session_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  item_count?: number | null;
}

/**
 * 首屏 facets 只加载当前层级的前 50 项；精确已选项不在第一页时替换末项补入。
 */
export function loadExportFilterData(
  db: DeepaaDatabase,
  selection: ExportFilterSelection,
  limit = DEFAULT_FACET_LIMIT,
): ExportFilterData {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), DEFAULT_FACET_LIMIT);
  const targetValues = normalizeList(selection.target);
  const agentValues = normalizeList(selection.agent);

  const targets = loadFacet(
    db,
    `SELECT target_id AS value, MAX(target_name) AS label_value,
       MAX(end_time) AS timestamp
     FROM agent_sessions
     GROUP BY target_id
     ORDER BY timestamp DESC, value ASC`,
    [],
    boundedLimit,
    targetValues,
    "SELECT target_id AS value, target_name AS label_value FROM agent_sessions WHERE target_id = ? LIMIT 1",
    targetFacetOption,
  );

  const agentWhere: string[] = [];
  const agentParams: unknown[] = [];
  addFacetListCondition(agentWhere, agentParams, "target_id", targetValues);
  const agents = loadFacet(
    db,
    `SELECT agent_name AS value, agent_name AS label_value,
       MAX(end_time) AS timestamp
     FROM agent_sessions
     ${whereSql(agentWhere)}
     GROUP BY agent_name
     ORDER BY timestamp DESC, value ASC`,
    agentParams,
    boundedLimit,
    agentValues,
    "SELECT agent_name AS value, agent_name AS label_value FROM agent_sessions WHERE agent_name = ? LIMIT 1",
    simpleFacetOption,
  );

  const sessionWhere: string[] = [];
  const sessionParams: unknown[] = [];
  addFacetListCondition(sessionWhere, sessionParams, "target_id", targetValues);
  addFacetListCondition(sessionWhere, sessionParams, "agent_name", agentValues);
  const sessions = loadFacet(
    db,
    `SELECT id AS value, COALESCE(external_session_id, id) AS label_value,
       end_time AS timestamp, request_count AS item_count
     FROM agent_sessions
     ${whereSql(sessionWhere)}
     ORDER BY end_time DESC, id DESC`,
    sessionParams,
    boundedLimit,
    selection.session ? [selection.session] : [],
    `SELECT id AS value, COALESCE(external_session_id, id) AS label_value,
       end_time AS timestamp, request_count AS item_count
     FROM agent_sessions WHERE id = ? LIMIT 1`,
    sessionFacetOption,
  );

  const threads = selection.session
    ? loadFacet(
        db,
        `SELECT id AS value, display_name AS label_value, end_time AS timestamp,
           agent_session_id AS session_id, request_count AS item_count
         FROM agent_threads
         WHERE agent_session_id = ?
         ORDER BY end_time DESC, id DESC`,
        [selection.session],
        boundedLimit,
        selection.thread ? [selection.thread] : [],
        `SELECT id AS value, display_name AS label_value, end_time AS timestamp,
           agent_session_id AS session_id, request_count AS item_count
         FROM agent_threads WHERE id = ? LIMIT 1`,
        threadFacetOption,
      )
    : emptyFacet();

  const turns = selection.thread
    ? loadFacet(
        db,
        `SELECT id AS value, id AS label_value, end_time AS timestamp,
           agent_session_id AS session_id, agent_thread_id AS thread_id,
           step_count AS item_count
         FROM agent_turns
         WHERE agent_thread_id = ?
         ORDER BY end_time DESC, id DESC`,
        [selection.thread],
        boundedLimit,
        selection.turn ? [selection.turn] : [],
        `SELECT id AS value, id AS label_value, end_time AS timestamp,
           agent_session_id AS session_id, agent_thread_id AS thread_id,
           step_count AS item_count
         FROM agent_turns WHERE id = ? LIMIT 1`,
        turnFacetOption,
      )
    : emptyFacet();

  const steps = selection.turn
    ? loadFacet(
        db,
        `SELECT id AS value, id AS label_value,
           timestamp, agent_session_id AS session_id,
           agent_thread_id AS thread_id, agent_turn_id AS turn_id
         FROM agent_steps
         WHERE agent_turn_id = ?
         ORDER BY step_index DESC, id DESC`,
        [selection.turn],
        boundedLimit,
        selection.step ? [selection.step] : [],
        `SELECT id AS value, id AS label_value,
           timestamp, agent_session_id AS session_id,
           agent_thread_id AS thread_id, agent_turn_id AS turn_id
         FROM agent_steps WHERE id = ? LIMIT 1`,
        stepFacetOption,
      )
    : emptyFacet();

  return {
    targets: targets.items,
    agents: agents.items,
    sessions: sessions.items,
    threads: threads.items,
    turns: turns.items,
    steps: steps.items,
    limited: {
      targets: targets.limited,
      agents: agents.limited,
      sessions: sessions.limited,
      threads: threads.limited,
      turns: turns.limited,
      steps: steps.limited,
    },
  };
}

/**
 * 只从 SQLite 选择当前页原始引用。所有业务范围、时间和游标条件都在 raw/blob 读取前完成。
 */
export function selectExportExchangeRefs(
  db: DeepaaDatabase,
  filters: ExportFilters,
): ExportExchangeRefPage {
  const limit = normalizeLimit(filters.exchangeLimit ?? filters.maxExchanges);
  const cursor = decodeExportCursor(filters.cursor);
  const direction = filters.direction === "newer" ? "newer" : "older";
  const stepScope = filters.step
    ? resolveStepScope(db, filters.step)
    : undefined;
  const model = buildOwnedExchangeQuery(filters, stepScope, cursor);
  // 候选总数是 COUNT 全量扫描：列表滚动的后续页不再重复统计（首屏由调用方请求）。
  let candidateCount: number | undefined;
  if (filters.skipCandidateCount !== true) {
    const countModel = buildOwnedExchangeQuery(filters, stepScope);
    candidateCount = db.prepare(
      `SELECT COUNT(*) FROM (${countModel.sql}) candidates`,
    ).pluck().get(...countModel.params) as number;
  }
  const rows = db.prepare(
    `${model.sql}
     ORDER BY captured_at ${direction === "newer" ? "ASC" : "DESC"},
       exchange_id ${direction === "newer" ? "ASC" : "DESC"}
     LIMIT ?`,
  ).all(...model.params, limit + 1) as ExportRefRow[];
  const completeness = filters.skipCandidateCount === true
    ? {missingCount: 0, limitedCount: 0}
    : contentFilterCompleteness(db, filters, stepScope);
  const selectedRows = rows.slice(0, limit);
  if (direction === "newer") selectedRows.reverse();
  const hasDirectionalMore = rows.length > limit;
  const hasMoreOlder = direction === "older"
    ? hasDirectionalMore
    : cursor !== undefined;
  const hasMoreNewer = direction === "newer"
    ? hasDirectionalMore
    : cursor !== undefined;

  return {
    refs: selectedRows.map(mapExportRef),
    candidateCount,
    candidateCountExact: completeness.missingCount === 0
      && completeness.limitedCount === 0,
    filterProjectionMissingCount: completeness.missingCount,
    filterProjectionLimitedCount: completeness.limitedCount,
    hasMoreOlder,
    hasMoreNewer,
    hasMore: hasMoreOlder,
  };
}

function contentFilterCompleteness(
  db: DeepaaDatabase,
  filters: ExportFilters,
  stepScope: StepScopeRow | undefined,
): { missingCount: number; limitedCount: number } {
  // scope=step 已跳过类别候选过滤（见 addContentCategoryCondition），
  // 完整性统计同步早退，避免出现误导的「总数仅包含已确认匹配项」横幅。
  if (filters.step && filters.scope === "step") {
    return { missingCount: 0, limitedCount: 0 };
  }
  if (filters.categories.length === 0) {
    return { missingCount: 0, limitedCount: 0 };
  }
  const categories = [...new Set(filters.categories)];
  const limitedParams: unknown[] = [];
  // 指定方向时只在那一侧用全部选中类别检查完整性；否则按输入/输出侧分别检查。
  const requestCategories = filters.side === "response"
    ? []
    : filters.side === "request"
      ? categories
      : categories.filter(category => INPUT_CONTENT_CATEGORY_SET.has(category));
  const responseCategories = filters.side === "request"
    ? []
    : filters.side === "response"
      ? categories
      : categories.filter(category => OUTPUT_CONTENT_CATEGORY_SET.has(category));
  const limitedForSide = (
    side: "request" | "response",
    sideCategories: ConversationCategory[],
  ): string | undefined => {
    if (sideCategories.length === 0) return undefined;
    limitedParams.push(side, ...sideCategories);
    return `(status.${side}_filter_state = 'limited' AND EXISTS(
      SELECT 1 FROM exchange_content_category_stats selected_stats
      WHERE selected_stats.exchange_id = candidates.exchange_id
        AND selected_stats.body_side = ?
        AND selected_stats.category IN (${sideCategories.map(() => "?").join(", ")})
    ))`;
  };
  const limitedConditions = [
    limitedForSide("request", requestCategories),
    limitedForSide("response", responseCategories),
  ].filter((condition): condition is string => condition !== undefined);
  const scopeModel = buildOwnedExchangeQuery(
    filters,
    stepScope,
    undefined,
    { skipContentCategoryFilter: true },
  );
  const row = db.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN NOT EXISTS(
        SELECT 1 FROM exchange_content_filter_status status
        WHERE status.exchange_id = candidates.exchange_id
      ) THEN 1 ELSE 0 END), 0) AS missing_count,
      COALESCE(SUM(CASE WHEN EXISTS(
        SELECT 1 FROM exchange_content_filter_status status
        WHERE status.exchange_id = candidates.exchange_id
          AND (${limitedConditions.join(" OR ")})
      ) THEN 1 ELSE 0 END), 0) AS limited_count
    FROM (${scopeModel.sql}) candidates`,
  ).get(
    ...limitedParams,
    ...scopeModel.params,
  ) as { missing_count: number; limited_count: number };
  return { missingCount: row.missing_count, limitedCount: row.limited_count };
}

/** 完整下载预检只聚合 SQLite 声明元数据，不读取 preview JSON、JSONL 或 blob。 */
export function estimateExportRange(
  db: DeepaaDatabase,
  filters: ExportFilters,
): ExportRangeEstimate {
  const stepScope = filters.step ? resolveStepScope(db, filters.step) : undefined;
  const model = buildOwnedExchangeQuery(filters, stepScope);
  const row = db.prepare(
    `SELECT COUNT(*) AS candidate_count,
       COALESCE(SUM(request_body_bytes + response_body_bytes), 0) AS declared_body_bytes,
       COALESCE(MAX(request_body_bytes + response_body_bytes), 0) AS max_declared_body_bytes
     FROM (${model.sql}) candidates`,
  ).get(...model.params) as {
    candidate_count: number;
    declared_body_bytes: number;
    max_declared_body_bytes: number;
  };
  return {
    candidateExchangeCount: row.candidate_count,
    declaredBodyBytes: row.declared_body_bytes,
    maxDeclaredBodyBytes: row.max_declared_body_bytes,
  };
}

/** 仅在聚合预检发现超限时定位一条阻断记录，仍然不读取 preview JSON 或 Raw。 */
export function findExportBodyBudgetViolation(
  db: DeepaaDatabase,
  filters: ExportFilters,
  maxBytes: number,
): ExportBodyBudgetViolation | undefined {
  const stepScope = filters.step ? resolveStepScope(db, filters.step) : undefined;
  const model = buildOwnedExchangeQuery(filters, stepScope);
  const row = db.prepare(
    `SELECT exchange_id,
       request_body_bytes + response_body_bytes AS declared_body_bytes
     FROM (${model.sql}) candidates
     WHERE request_body_bytes + response_body_bytes > ?
     ORDER BY declared_body_bytes DESC, captured_at DESC, exchange_id DESC
     LIMIT 1`,
  ).get(...model.params, maxBytes) as {
    exchange_id: string;
    declared_body_bytes: number;
  } | undefined;
  return row ? {
    exchangeId: row.exchange_id,
    declaredBodyBytes: row.declared_body_bytes,
  } : undefined;
}

/** 当前页最早模型请求的前一条模型调用，用于分页上下文去重。 */
export function selectPreviousExportModelRef(
  db: DeepaaDatabase,
  filters: ExportFilters,
  before: ExportExchangeRef,
): ExportExchangeRef | undefined {
  const baselineFilters = filters.step && filters.scope !== "upto"
    ? {
        ...filters,
        session: before.agentSessionId,
        thread: undefined,
        turn: undefined,
        step: undefined,
        scope: "all" as const,
      }
    : filters;
  const stepScope = baselineFilters.step
    ? resolveStepScope(db, baselineFilters.step)
    : undefined;
  const branch = buildBranch(
    baselineFilters,
    stepScope,
    {
      v: 2,
      capturedAt: before.capturedAt,
      exchangeId: before.exchangeId,
    },
    "step",
  );
  const row = db.prepare(
    `${branch.sql}
     ORDER BY captured_at DESC, exchange_id DESC
     LIMIT 1`,
  ).get(...branch.params) as ExportRefRow | undefined;
  return row ? mapExportRef(row) : undefined;
}

/**
 * 查找同一实际 Thread 中位于指定模型调用之前的上一条模型调用。
 * 当前页面的 Turn、Step、时间筛选只决定可见项，不得截断上下文基线。
 */
export function selectPreviousExportModelRefForThread(
  db: DeepaaDatabase,
  before: ExportExchangeRef,
): ExportExchangeRef | undefined {
  const row = db.prepare(
    `SELECT
      r.exchange_id AS exchange_id,
      r.capture_session_id AS capture_session_id,
      r.source_id AS source_id,
      src.relative_path AS relative_path,
      r.byte_offset AS byte_offset,
      r.line_length_bytes AS line_length_bytes,
      r.request_body_bytes AS request_body_bytes,
      r.response_body_bytes AS response_body_bytes,
      p.size_bytes AS preview_size_bytes,
      p.preview_state AS preview_state,
      r.captured_at AS captured_at,
      r.target_id AS target_id,
      r.target_name AS target_name,
      r.agent_name AS agent_name,
      st.agent_session_id AS agent_session_id,
      st.agent_thread_id AS agent_thread_id,
      st.agent_turn_id AS agent_turn_id,
      st.id AS agent_step_id,
      0 AS is_auxiliary
    FROM agent_steps st
    JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
    JOIN ingestion_sources src ON src.id = r.source_id
    LEFT JOIN exchange_content_previews p ON p.exchange_id = r.exchange_id
    WHERE st.agent_session_id = ?
      AND st.agent_thread_id = ?
      AND (r.captured_at < ? OR (r.captured_at = ? AND r.exchange_id < ?))
    ORDER BY r.captured_at DESC, r.exchange_id DESC
    LIMIT 1`,
  ).get(
    before.agentSessionId,
    before.agentThreadId,
    before.capturedAt,
    before.capturedAt,
    before.exchangeId,
  ) as ExportRefRow | undefined;
  return row ? mapExportRef(row) : undefined;
}

export interface ExportStepContext {
  sessionId: string;
  threadId: string;
  turnId: string;
  targetId: string;
  agentName: string;
}

/**
 * Step 深链接的上级路径恢复：按 SQLite 唯一索引把 step（内部 id 或旧 exchangeId）
 * 一次性解析为 session/thread/turn/target/agent，供 /export 深链接自动回填筛选条件。
 * 解析结果即该 step 自身的从属链，天然满足深链接从属关系校验。
 */
export function resolveExportStepContext(
  db: DeepaaDatabase,
  stepIdOrExchangeId: string,
): ExportStepContext | undefined {
  return db.prepare(
    `SELECT st.agent_session_id AS "sessionId",
       st.agent_thread_id AS "threadId",
       st.agent_turn_id AS "turnId",
       r.target_id AS "targetId",
       r.agent_name AS "agentName"
     FROM agent_steps st
     JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
     WHERE st.id = ? OR st.exchange_id = ?
     ORDER BY CASE WHEN st.id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  ).get(
    stepIdOrExchangeId,
    stepIdOrExchangeId,
    stepIdOrExchangeId,
  ) as ExportStepContext | undefined;
}

/** Thread 深链接的上级恢复：沿外键解析所属 session。 */
export function resolveExportThreadContext(
  db: DeepaaDatabase,
  threadId: string,
): {sessionId: string} | undefined {
  return db.prepare(
    `SELECT agent_session_id AS "sessionId" FROM agent_threads WHERE id = ? LIMIT 1`,
  ).get(threadId) as {sessionId: string} | undefined;
}

/** Turn 深链接的上级恢复：沿外键解析所属 thread 与 session。 */
export function resolveExportTurnContext(
  db: DeepaaDatabase,
  turnId: string,
): {sessionId: string; threadId: string} | undefined {
  return db.prepare(
    `SELECT agent_session_id AS "sessionId", agent_thread_id AS "threadId"
     FROM agent_turns WHERE id = ? LIMIT 1`,
  ).get(turnId) as {sessionId: string; threadId: string} | undefined;
}

/** 当前 target/agent 过滤下最新的 session（深链接缺省自动选中，2026-09-17 用户确认）。 */
export function loadLatestExportSession(
  db: DeepaaDatabase,
  targets: string[],
  agents: string[],
): string | undefined {
  const where: string[] = [];
  const params: unknown[] = [];
  if (targets.length > 0) {
    where.push(`target_id IN (${targets.map(() => "?").join(",")})`);
    params.push(...targets);
  }
  if (agents.length > 0) {
    where.push(`agent_name IN (${agents.map(() => "?").join(",")})`);
    params.push(...agents);
  }
  const row = db.prepare(
    `SELECT id FROM agent_sessions
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY end_time DESC, id DESC LIMIT 1`,
  ).get(...params) as {id: string} | undefined;
  return row?.id;
}

export interface ExportDeepLinkQuery {
  targets: string[];
  agents: string[];
  session?: string;
  thread?: string;
  turn?: string;
  step?: string;
}

/**
 * /export 深链接归一化（2026-09-17 用户确认：页面不接受「无 Session」状态）：
 * - step 深链接：沿 SQLite 唯一索引解析从属链，回填缺失的 session/thread/turn
 *   （显式给出的上级与解析结果冲突时整链不回填），并补缺失的 target/agent；
 * - turn/thread 深链接：沿外键回填缺失父级（同样带一致性校验）；
 * - 四个范围参数全空：自动选中当前 target/agent 过滤下最新的 session；
 *   库中无 session 时不跳转、按空态渲染。
 * 返回需要补充的参数（非空才跳转）；无需跳转返回 undefined。
 */
export function resolveExportDeepLinkRedirect(
  db: DeepaaDatabase,
  query: ExportDeepLinkQuery,
): Record<string, string> | undefined {
  const additions: Record<string, string> = {};
  if (query.step && (!query.session || !query.thread || !query.turn)) {
    const context = resolveExportStepContext(db, query.step);
    if (context) {
      const sessionOk = !query.session || query.session === context.sessionId;
      const threadOk = !query.thread || query.thread === context.threadId;
      const turnOk = !query.turn || query.turn === context.turnId;
      if (sessionOk && threadOk && turnOk) {
        if (!query.session) additions.session = context.sessionId;
        if (!query.thread) additions.thread = context.threadId;
        if (!query.turn) additions.turn = context.turnId;
        if (query.targets.length === 0) additions.target = context.targetId;
        if (query.agents.length === 0) additions.agent = context.agentName;
      }
    }
  } else if (query.turn && (!query.thread || !query.session)) {
    const context = resolveExportTurnContext(db, query.turn);
    if (context) {
      const threadOk = !query.thread || query.thread === context.threadId;
      const sessionOk = !query.session || query.session === context.sessionId;
      if (threadOk && sessionOk) {
        if (!query.thread) additions.thread = context.threadId;
        if (!query.session) additions.session = context.sessionId;
      }
    }
  } else if (query.thread && !query.session) {
    const context = resolveExportThreadContext(db, query.thread);
    if (context) additions.session = context.sessionId;
  } else if (!query.session && !query.thread && !query.turn && !query.step) {
    const latest = loadLatestExportSession(db, query.targets, query.agents);
    if (latest) additions.session = latest;
  }
  return Object.keys(additions).length > 0 ? additions : undefined;
}

export function encodeExportCursor(ref: ExportExchangeRef): string {
  const payload: CursorPayload = {
    v: 2,
    capturedAt: ref.capturedAt,
    exchangeId: ref.exchangeId,
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

export function decodeExportCursor(
  value: string | undefined,
): CursorPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf-8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.v !== 2
      || typeof parsed.capturedAt !== "string"
      || typeof parsed.exchangeId !== "string"
      || !parsed.capturedAt
      || !parsed.exchangeId
    ) {
      return undefined;
    }
    return {
      v: 2,
      capturedAt: parsed.capturedAt,
      exchangeId: parsed.exchangeId,
    };
  } catch {
    return undefined;
  }
}

function buildOwnedExchangeQuery(
  filters: ExportFilters,
  stepScope: StepScopeRow | undefined,
  cursor?: CursorPayload,
  options: { skipContentCategoryFilter?: boolean } = {},
): { sql: string; params: unknown[] } {
  const stepBranch = buildBranch(filters, stepScope, cursor, "step", options);
  const auxiliaryBranch = buildBranch(filters, stepScope, cursor, "auxiliary", options);
  return {
    sql: `${stepBranch.sql}\nUNION ALL\n${auxiliaryBranch.sql}`,
    params: [...stepBranch.params, ...auxiliaryBranch.params],
  };
}

function buildBranch(
  filters: ExportFilters,
  stepScope: StepScopeRow | undefined,
  cursor: CursorPayload | undefined,
  kind: "step" | "auxiliary",
  options: { skipContentCategoryFilter?: boolean } = {},
): { sql: string; params: unknown[] } {
  const ownerTable = kind === "step" ? "agent_steps" : "auxiliary_requests";
  const ownerAlias = kind === "step" ? "st" : "aux";
  const where: string[] = [];
  const params: unknown[] = [];
  addListCondition(where, params, "r.target_id", filters.target);
  addListCondition(where, params, "r.agent_name", filters.agent);
  addScalarCondition(where, params, `${ownerAlias}.agent_session_id`, filters.session);
  addScalarCondition(where, params, `${ownerAlias}.agent_turn_id`, filters.turn);
  if (filters.thread) {
    where.push(
      `EXISTS (
        SELECT 1 FROM thread_closure tc
        WHERE tc.ancestor_thread_id = ?
          AND tc.descendant_thread_id = ${ownerAlias}.agent_thread_id
      )`,
    );
    params.push(filters.thread);
  }
  if (filters.start) {
    where.push("r.captured_at >= ?");
    params.push(filters.start);
  }
  if (filters.end) {
    where.push("r.captured_at <= ?");
    params.push(filters.end);
  }
  if (filters.exchangeId) {
    where.push("r.exchange_id = ?");
    params.push(filters.exchangeId);
  }
  if (filters.step && filters.scope !== "upto") {
    if (!stepScope || kind === "auxiliary") {
      where.push("1 = 0");
    } else {
      where.push(`${ownerAlias}.id = ? AND r.exchange_id = ?`);
      params.push(stepScope.step_id, stepScope.exchange_id);
    }
  }
  if (filters.step && filters.scope === "upto") {
    if (!stepScope) {
      where.push("1 = 0");
    } else {
      where.push(`r.captured_at <= ? AND ${ownerAlias}.agent_session_id = ?`);
      params.push(stepScope.captured_at, stepScope.agent_session_id);
    }
  }
  if (!options.skipContentCategoryFilter) {
    addContentCategoryCondition(where, params, filters);
  }
  if (cursor) {
    const operator = filters.direction === "newer" ? ">" : "<";
    where.push(
      `(r.captured_at ${operator} ? OR (r.captured_at = ? AND r.exchange_id ${operator} ?))`,
    );
    params.push(cursor.capturedAt, cursor.capturedAt, cursor.exchangeId);
  }

  return {
    sql: `SELECT
      r.exchange_id AS exchange_id,
      r.capture_session_id AS capture_session_id,
      r.source_id AS source_id,
      src.relative_path AS relative_path,
      r.byte_offset AS byte_offset,
      r.line_length_bytes AS line_length_bytes,
      r.request_body_bytes AS request_body_bytes,
      r.response_body_bytes AS response_body_bytes,
      p.size_bytes AS preview_size_bytes,
      p.preview_state AS preview_state,
      r.captured_at AS captured_at,
      r.target_id AS target_id,
      r.target_name AS target_name,
      r.agent_name AS agent_name,
      ${ownerAlias}.agent_session_id AS agent_session_id,
      ${ownerAlias}.agent_thread_id AS agent_thread_id,
      ${ownerAlias}.agent_turn_id AS agent_turn_id,
      ${kind === "step" ? `${ownerAlias}.id` : "NULL"} AS agent_step_id,
      ${kind === "auxiliary" ? "1" : "0"} AS is_auxiliary,
      r.origin AS origin,
      r.diagnostic_codes_json AS diagnostic_codes_json,
      r.status AS status,
      r.completed_at AS completed_at,
      r.raw_state AS raw_state,
      r.model AS model
    FROM ${ownerTable} ${ownerAlias}
    JOIN raw_exchange_refs r ON r.exchange_id = ${ownerAlias}.exchange_id
    JOIN ingestion_sources src ON src.id = r.source_id
    LEFT JOIN exchange_content_previews p ON p.exchange_id = r.exchange_id
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
    params,
  };
}

/** 类别与排重可见性必须在 COUNT、keyset 和 Raw 规划之前统一收敛。
 *  未指定方向时，输入侧与输出侧各自独立为硬条件，跨侧 AND：两侧都选了类别时，
 *  Step 必须同时在请求侧和响应侧有新增内容；只选了一侧则只要求该侧。
 *  指定方向（side）时，维持只在那一侧用全部选中类别检查的既有行为。 */
function addContentCategoryCondition(
  where: string[],
  params: unknown[],
  filters: ExportFilters,
): void {
  // scope=step 是显式定位唯一 Step：类别候选过滤在这里没有收益，只会把
  // 「响应侧无对应类别」的 Step（如 tool_use 型响应遇到含 assistant 的多选）
  // 整页滤成空。类别过滤由展开详情的前端过滤承担（2026-09-21）。
  if (filters.step && filters.scope === "step") {
    try { require("fs").appendFileSync("/tmp/dbg-export.log", `[dbg] step-scope skip applied, cats=${JSON.stringify(filters.categories)}\n`); } catch {}
    return;
  }
  try { require("fs").appendFileSync("/tmp/dbg-export.log", `[dbg] category filter active, scope=${filters.scope} step=${filters.step ?? "-"} cats=${JSON.stringify(filters.categories)}\n`); } catch {}
  const categories = [...new Set(filters.categories)];
  if (categories.length === 0) {
    if (filters.categoriesExplicit) where.push("1 = 0");
    return;
  }
  const includeInherited = filters.includeInherited === true;
  const countPredicate = includeInherited
    ? "category_stats.total_count > 0"
    : "category_stats.unique_count + category_stats.unconfirmed_count > 0";

  if (filters.side === "request" || filters.side === "response") {
    where.push(buildSideCategoryExists(filters.side, categories, countPredicate, params));
    return;
  }

  const requestCategories = categories.filter(category =>
    INPUT_CONTENT_CATEGORY_SET.has(category));
  const responseCategories = categories.filter(category =>
    OUTPUT_CONTENT_CATEGORY_SET.has(category));
  // tool_result / control 同时登记在输入与输出两侧：若参与跨侧 AND，
  // "只看工具结果"会因响应侧通常没有 tool_result 统计行而恒空
  // （2026-09-21 修复「查看原文 →」跳转后空白）。双侧共有类别单独按
  // "任一侧命中"判定；跨侧 AND 只对单侧独有类别生效。
  const sharedCategories = requestCategories.filter(category =>
    OUTPUT_CONTENT_CATEGORY_SET.has(category));
  const requestOnly = requestCategories.filter(category =>
    !OUTPUT_CONTENT_CATEGORY_SET.has(category));
  const responseOnly = responseCategories.filter(category =>
    !INPUT_CONTENT_CATEGORY_SET.has(category));
  const conditions: string[] = [];
  if (requestOnly.length > 0) {
    conditions.push(buildSideCategoryExists("request", requestOnly, countPredicate, params));
  }
  if (responseOnly.length > 0) {
    conditions.push(buildSideCategoryExists("response", responseOnly, countPredicate, params));
  }
  if (sharedCategories.length > 0) {
    conditions.push(
      `(${buildSideCategoryExists("request", sharedCategories, countPredicate, params)
      } OR ${buildSideCategoryExists("response", sharedCategories, countPredicate, params)})`);
  }
  if (conditions.length > 0) {
    where.push(`(${conditions.join(" AND ")})`);
  }
}

/** 构造单侧类别 EXISTS 条件，参数按 body_side、类别列表顺序追加。 */
function buildSideCategoryExists(
  side: "request" | "response",
  sideCategories: ConversationCategory[],
  countPredicate: string,
  params: unknown[],
): string {
  params.push(side, ...sideCategories);
  const filterStateColumn = side === "request"
    ? "filter_status.request_filter_state"
    : "filter_status.response_filter_state";
  return `EXISTS (
    SELECT 1
    FROM exchange_content_category_stats category_stats
    JOIN exchange_content_filter_status filter_status
      ON filter_status.exchange_id = category_stats.exchange_id
    WHERE category_stats.exchange_id = r.exchange_id
      AND category_stats.body_side = ?
      AND category_stats.category IN (${sideCategories.map(() => "?").join(", ")})
      AND ${filterStateColumn} = 'complete'
      AND ${countPredicate}
  )`;
}

function resolveStepScope(
  db: DeepaaDatabase,
  stepIdOrExchangeId: string,
): StepScopeRow | undefined {
  return db.prepare(
    `SELECT st.id AS step_id, st.exchange_id, r.captured_at,
       st.agent_session_id
     FROM raw_exchange_refs r
     JOIN agent_steps st ON st.exchange_id = r.exchange_id
     WHERE st.id = ? OR st.exchange_id = ?
     ORDER BY CASE WHEN st.id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  ).get(
    stepIdOrExchangeId,
    stepIdOrExchangeId,
    stepIdOrExchangeId,
  ) as StepScopeRow | undefined;
}

function addScalarCondition(
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  const normalized = value?.trim();
  if (!normalized) return;
  where.push(`${column} = ?`);
  params.push(normalized);
}

function addListCondition(
  where: string[],
  params: unknown[],
  column: string,
  value: string | string[] | undefined,
): void {
  const normalized = (Array.isArray(value) ? value : value?.split(",") ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (normalized.length === 0) return;
  where.push(`${column} IN (${normalized.map(() => "?").join(", ")})`);
  params.push(...normalized);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value), HARD_LIMIT);
}

function mapExportRef(row: ExportRefRow): ExportExchangeRef {
  return {
    exchangeId: row.exchange_id,
    captureSessionId: row.capture_session_id,
    sourceId: row.source_id,
    sourceRelativePath: row.relative_path,
    byteOffset: row.byte_offset,
    lineLengthBytes: row.line_length_bytes,
    requestBodyBytes: row.request_body_bytes,
    responseBodyBytes: row.response_body_bytes,
    previewSizeBytes: safePreviewSize(row.preview_size_bytes),
    previewState: row.preview_state ?? "not_materialized",
    capturedAt: row.captured_at,
    targetId: row.target_id,
    targetName: row.target_name,
    agentName: row.agent_name,
    agentSessionId: row.agent_session_id,
    agentThreadId: row.agent_thread_id,
    agentTurnId: row.agent_turn_id ?? undefined,
    agentStepId: row.agent_step_id ?? undefined,
    isAuxiliary: row.is_auxiliary === 1,
    isModelCall: row.is_auxiliary !== 1,
    origin: row.origin ?? "gateway",
    captureDiagnosticCodes: parseDiagnosticCodes(row.diagnostic_codes_json),
    httpStatus: row.status ?? undefined,
    completedAt: row.completed_at ?? undefined,
    rawState: row.raw_state === "purged" ? "purged" : "active",
    ...(row.model !== null ? {model: row.model} : {}),
  };
}

/** 原始行 diagnostics 只用于降级判定，解析失败按空数组处理（不放大错误）。 */
function parseDiagnosticCodes(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((code): code is string => typeof code === "string").slice(0, 32);
  } catch {
    return [];
  }
}

function safePreviewSize(value: number | null): number {
  return value !== null && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

interface FacetResult {
  items: ExportFacetOption[];
  limited: boolean;
}

function loadFacet(
  db: DeepaaDatabase,
  sql: string,
  params: unknown[],
  limit: number,
  selectedValues: string[],
  exactSql: string,
  mapRow: (row: FacetRow) => ExportFacetOption,
): FacetResult {
  const rows = db.prepare(`${sql}\nLIMIT ?`).all(...params, limit + 1) as FacetRow[];
  const pageRows = rows.slice(0, limit);
  const selectedRows = selectedValues
    .filter((value) => !pageRows.some((row) => row.value === value))
    .map((value) => db.prepare(exactSql).get(value) as FacetRow | undefined)
    .filter((row): row is FacetRow => row !== undefined);
  const selectedSet = new Set(selectedRows.map((row) => row.value));
  const retained = pageRows.filter((row) => !selectedSet.has(row.value));
  const merged = [
    ...retained.slice(0, Math.max(0, limit - selectedRows.length)),
    ...selectedRows.slice(0, limit),
  ];
  return {
    items: merged.map(mapRow),
    limited: rows.length > limit,
  };
}

function emptyFacet(): FacetResult {
  return { items: [], limited: false };
}

function normalizeList(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value?.split(",") ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
}

function addFacetListCondition(
  where: string[],
  params: unknown[],
  column: string,
  values: string[],
): void {
  if (values.length === 0) return;
  where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

function whereSql(where: string[]): string {
  return where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
}

function targetFacetOption(row: FacetRow): ExportFacetOption {
  return {
    value: row.value,
    label: row.label_value || row.value,
  };
}

function simpleFacetOption(row: FacetRow): ExportFacetOption {
  return { value: row.value, label: row.label_value || row.value };
}

function sessionFacetOption(row: FacetRow): ExportFacetOption {
  return {
    value: row.value,
    label: `${row.label_value || shortId(row.value)} · ${shortId(row.value)} · ${row.item_count ?? 0} 请求`,
    timestamp: row.timestamp ?? undefined,
    session: row.value,
  };
}

function threadFacetOption(row: FacetRow): ExportFacetOption {
  return {
    value: row.value,
    label: `${row.label_value || "Thread"} · ${shortId(row.value)} · ${row.item_count ?? 0} 请求`,
    timestamp: row.timestamp ?? undefined,
    session: row.session_id ?? undefined,
    thread: row.value,
  };
}

function turnFacetOption(row: FacetRow): ExportFacetOption {
  return {
    value: row.value,
    label: `${shortId(row.value)} · ${row.item_count ?? 0} Step`,
    timestamp: row.timestamp ?? undefined,
    session: row.session_id ?? undefined,
    thread: row.thread_id ?? undefined,
    turn: row.value,
  };
}

function stepFacetOption(row: FacetRow): ExportFacetOption {
  return {
    value: row.value,
    label: shortId(row.value),
    timestamp: row.timestamp ?? undefined,
    session: row.session_id ?? undefined,
    thread: row.thread_id ?? undefined,
    turn: row.turn_id ?? undefined,
  };
}

function shortId(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
