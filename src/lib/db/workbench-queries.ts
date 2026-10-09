import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  readRawBodyText,
  UnsafeRawBodyReferenceError,
} from "../harness/raw-body";
import { hydrateRawCapturedExchange } from "../harness/raw-capture";
import { normalizeStoredContextSnapshot } from "../ingestion/harness-payload-compact";
import { resolveDerivedArtifactJson } from "../ingestion/derived-artifact-store";
import {parsePlanEstimateDetailRecord, type PlanEstimateDetailInput} from "../token-pricing-display";
import { parseStepFailover, type CaptureFailover } from "../failover-display";
import {
  looksLikeInjectedEnvelope,
  pickTurnUserPromptItem,
} from "../user-prompt-text";
import {
  buildStepContextDiffView,
  type ContextDiffRow,
} from "../harness/context-diff-view";
import type { ObservedContextSnapshot, StepDiff } from "../harness/context-snapshot";
import type {
  RawCapturedExchange,
  RawCapturedExchangeV2,
} from "../harness/types";
import type { BoundedPage, DerivationStatus, ScopeType } from "./models";
import type { HarnessLearningInsight } from "../harness/derived";
import { requestIntentLabelFor, type AgentStep } from "../harness/agent";
import { parseOptionalWorkbenchRange, type WorkbenchRange } from "../workbench-time-range";
import type {
  PricingMatchStrategy,
  PricingRates,
  PricingSnapshot,
} from "../pricing";
import type { LongContextPricingTier, SparsePricingRates } from "../../types";
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from "./cursors";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_ANCESTOR_DEPTH = 32;
const MAX_SESSION_MODELS = 32;
const MAX_SESSION_MODEL_CHARS = 256;
const RAW_EXCHANGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_GROUPS = 100;
const MAX_API_PAGE_LIMIT = 100;
/** Turn 用户输入在列表栏展示的字符上限（超出由 UI 折叠）。 */
const USER_PROMPT_PREVIEW_LIMIT = 2000;
const MAX_STORED_ARTIFACT_BYTES = 256 * 1024;
const PRICING_MATCH_STRATEGIES = new Set<PricingMatchStrategy>([
  "target_override",
  "target_model_entry",
  "official_preset_vendor_exact",
  "official_preset_vendor_normalized_exact",
  "target_model_vendor_exact",
  "target_model_vendor_normalized_exact",
  "target_vendor_exact",
  "target_vendor_normalized_exact",
  "global_exact",
  "global_exact_vendor_resolved",
  "global_normalized_exact",
  "contains",
  "ambiguous",
  "unmatched",
  "unverified",
  "usage_unavailable",
]);

// 历史异常 JSON 在 SQLite 内归一为空数组，避免把原始大字段或半段 JSON 拉入 JS。
const SAFE_SESSION_MODEL_SET_SQL = `CASE
  WHEN json_valid(agent_sessions.model_set_json) THEN CASE
    WHEN json_type(agent_sessions.model_set_json) = 'array'
      THEN agent_sessions.model_set_json
    ELSE '[]'
  END
  ELSE '[]'
END`;
const SESSION_MODEL_SET_PROJECTION_SQL = `
  COALESCE((
    SELECT json_group_array(model_value) FROM (
      SELECT substr(CAST(model.value AS TEXT), 1, ${MAX_SESSION_MODEL_CHARS})
        AS model_value
      FROM json_each(${SAFE_SESSION_MODEL_SET_SQL}) AS model
      WHERE model.type = 'text'
      ORDER BY CAST(model.key AS INTEGER)
      LIMIT ${MAX_SESSION_MODELS}
    )
  ), '[]') AS model_set_json,
  (
    SELECT COUNT(*) FROM json_each(${SAFE_SESSION_MODEL_SET_SQL}) AS model_count
    WHERE model_count.type = 'text'
  ) AS model_set_string_count,
  EXISTS(
    SELECT 1 FROM json_each(${SAFE_SESSION_MODEL_SET_SQL}) AS long_model
    WHERE long_model.type = 'text'
      AND length(CAST(long_model.value AS TEXT)) > ${MAX_SESSION_MODEL_CHARS}
    LIMIT 1
  ) AS model_set_value_limited`;

export class UnsafeRawReferenceError extends Error {
  readonly code = "unsafe_raw_reference";

  constructor(cause?: unknown) {
    super("原始 Exchange 引用无效或超出安全读取边界。", { cause });
    this.name = "UnsafeRawReferenceError";
  }
}

export class RawBodyExceedsPreviewBudgetError extends Error {
  readonly code = "raw_body_exceeds_preview_budget";

  constructor(cause?: unknown) {
    super("原始正文超过普通详情的预览读取预算。", { cause });
    this.name = "RawBodyExceedsPreviewBudgetError";
  }
}

export interface LoadExchangeDetailOptions {
  rawBodyReader?: typeof readRawBodyText;
}

export interface WorkbenchSelectionPath {
  target: string;
  agent: string;
  session: string;
  thread: string;
  turn?: string;
  step?: string;
  ancestorThreadIds: string[];
}

export interface WorkbenchSessionSummary {
  id: string;
  externalSessionId?: string;
  startTime: string;
  endTime: string;
  modelSet: string[];
  modelSetLimited: boolean;
  requestCount: number;
  threadCount: number;
}

export interface WorkbenchThreadNode {
  id: string;
  agentSessionId: string;
  parentAgentThreadId?: string;
  externalThreadId?: string;
  externalAgentId?: string;
  displayName: string;
  isRoot: boolean;
  isPlaceholder: boolean;
  startTime: string;
  endTime: string;
  requestCount: number;
  turnCount: number;
  childCount: number;
  children: WorkbenchThreadNode[];
  childPage?: BoundedPage<WorkbenchThreadNode>;
}

export interface WorkbenchTurnSummary {
  id: string;
  agentSessionId: string;
  agentThreadId: string;
  /** Agent 侧原生 Turn ID（业务 Turn；缺省表示该 Agent 未上报）。 */
  nativeTurnId?: string;
  startTime: string;
  endTime: string;
  stepCount: number;
  auxiliaryRequestCount: number;
}

export interface WorkbenchStepSummary {
  id: string;
  exchangeId: string;
  agentSessionId: string;
  agentThreadId: string;
  agentTurnId: string;
  /** Agent 侧原生 Step/消息 ID（业务 Step；缺省表示该 Agent 未上报）。 */
  nativeStepId?: string;
  stepIndex: number;
  timestamp: string;
  phase: string;
  requestIntentLabel?: string;
  responseStatusLabel?: string;
  /** 真实响应动作（final/tool_use/…），意图序列「完成」统计的依据。 */
  responseAction?: string;
  toolSchemaCount: number;
  toolUseNames: string[];
  toolUseNamesLimited: boolean;
  toolUseCount: number;
  toolResultCount: number;
  /** 模型故障转移元数据（context snapshot 摘要的有界摘取；旧数据缺省）。 */
  failover?: CaptureFailover;
  /** 观测通道：gateway=经代理（缺省）；agent_local_import=官方直连。 */
  origin?: string;
  /** 压缩事件角色（wire 证据门槛；无证据的裁剪边界不产生注解）。 */
  compactionRole?: TurnCompactionAnnotation["role"];
  /** 本 turn 内的压缩事件序号（1 起；与 compactionRole 成对出现）。 */
  compactionOrdinal?: number;
}

/** Turn 栏锚点：本 Turn 的用户真实输入（取自 turn 首步 preview 的 user_real 条目）。 */
export interface TurnUserPrompt {
  text: string;
  stepIndex: number;
  /** 首步内部 AgentStep.id：完整读取（显式点击）定点首步请求的唯一锚点。 */
  stepId: string;
  /** 首步 exchange：与 stepId 同源，供诊断/跳转交互内容页复用。 */
  exchangeId: string;
  timestamp: string;
  /** 预览本身是否被截断（投影条目事实：previewTextBytes < originalTextBytes）。 */
  truncated: boolean;
  /** 截断时给出原始正文字节数，供 UI 说明「仅显示前 N B / 原文 M B」。 */
  originalBytes?: number;
  /** user_prompt = 已识别为人类输入；first_user_message = 仅能取到首条 user 消息（可能含注入）。 */
  source: "user_prompt" | "first_user_message";
}

/** Turn 意图序列全量统计：按本 Turn 全部 Step 在服务端聚合，不随前端分页截断。 */
export interface TurnIntentStats {
  /** response_action='tool_use' 的请求数（一次响应内多个并行工具仍记 1）。 */
  toolUseSteps: number;
  retries: number;
  interruptions: number;
  finals: number;
  /** 有 wire 证据的压缩事件数（纯裁剪边界不计，见 loadTurnCompactionEvents）。 */
  compressions: number;
}

/**
 * Turn 压缩事件注解（读路径推导，wire 证据门槛，2026-09-22 用户确认方案）：
 * - generation：该步是压缩生成调用——dsh purpose 头请求自身，或紧邻摘要标记
 *   边界的前一步 final（其响应即压缩摘要，不是面向用户的回合完成）；
 * - first-after：该步是压缩后首个请求（请求携带摘要标记，同 turn 前一步无压缩标志）。
 * ordinal 为本 turn 内的事件序号（1 起）。
 */
export interface TurnCompactionAnnotation {
  role: "generation" | "first-after";
  ordinal: number;
}

export interface WorkbenchTurnStepsPage extends BoundedPage<WorkbenchStepSummary> {
  userPrompt?: TurnUserPrompt;
  intentStats: TurnIntentStats;
}

export interface WorkbenchTreePage {
  agents: Array<{
    agentFingerprintId: string;
    agentName: string;
    sessions: WorkbenchSessionSummary[];
  }>;
  latestPath?: WorkbenchSelectionPath;
  resolvedPath?: WorkbenchSelectionPath;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
  dataVersion: number;
  derivedStatus: DerivationStatus["status"];
  /** 待处理派生任务数（pending + retry_wait）；积压时供页面顶部横幅提示。 */
  backlogPendingCount: number;
}

export interface ScopeToolSummary {
  name: string;
  status: string;
  count: number;
}

export interface ScopeSummary {
  scopeType: ScopeType;
  scopeId: string;
  requestCount: number;
  stepRequestCount: number;
  auxiliaryRequestCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitRate?: number;
  vendorCost: number;
  actualCost: number;
  durationTotalMs: number;
  durationSampleCount: number;
  averageDurationMs?: number;
  toolCallCount: number;
  tools: ScopeToolSummary[];
  toolsCandidateCount: number;
  toolsProcessedCount: number;
  toolsLimited: boolean;
  dataVersion: number;
}

interface SessionRow {
  id: string;
  target_id: string;
  target_name: string;
  agent_fingerprint_id: string;
  agent_name: string;
  external_session_id: string | null;
  start_time: string;
  end_time: string;
  model_set_json: string;
  model_set_string_count: number;
  model_set_value_limited: 0 | 1;
  request_count: number;
  thread_count: number;
}

interface SelectionRow {
  target_id: string;
  agent_name: string;
  session_id: string;
  thread_id: string;
  turn_id: string | null;
  step_id: string | null;
}

interface AggregateRow {
  step_request_count: number;
  auxiliary_request_count: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  vendor_cost: number;
  actual_cost: number;
  duration_total_ms: number;
  duration_sample_count: number;
  tool_call_count: number;
}

interface RawExchangeRefRow {
  exchange_id: string;
  source_id: number;
  relative_path: string;
  file_id: string;
  byte_offset: number;
  line_length_bytes: number;
}

export interface WorkbenchQueryOptions {
  limit?: number;
  /** 首页深链需要全供应商树；公共 URL 的 target 仍只用于路径校验。 */
  includeAllTargets?: boolean;
}

export interface ApiOffsetPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  dataVersion: number;
  derivedStatus: DerivationStatus["status"];
}

export interface ApiAgentSession {
  id: string;
  targetId: string;
  targetName: string;
  agentFingerprintId: string;
  agentName: string;
  externalSessionId?: string;
  externalConversationId?: string;
  source: string;
  confidence: string;
  startTime: string;
  endTime: string;
  modelSet: string[];
  requestCount: number;
  threadCount: number;
  /** 会话内步级 target 分布（故障转移/对冲会跨 target；只取前 4 个 + 其余计数）。 */
  targetDistribution?: Array<{targetId: string; targetName: string; stepCount: number}>;
  targetDistributionTruncated?: boolean;
}

export interface ApiAgentGroup {
  id: string;
  agentFingerprintId: string;
  agentName: string;
  sessionCount: number;
  requestCount: number;
  startTime: string;
  endTime: string;
}

export interface ApiAgentTurn {
  id: string;
  agentSessionId: string;
  agentThreadId: string;
  nativeTurnId?: string;
  source: string;
  confidence: string;
  status: string;
  segmentIndex: number;
  startExchangeId: string;
  startTime: string;
  endTime: string;
  modelSet: string[];
  stepCount: number;
  auxiliaryRequestCount: number;
}

export interface ApiAgentStep {
  id: string;
  exchangeId: string;
  agentSessionId: string;
  agentThreadId: string;
  agentTurnId: string;
  /** Agent 侧原生 Step/消息 ID（业务 Step；缺省表示该 Agent 未上报）。 */
  nativeStepId?: string;
  stepIndex: number;
  timestamp: string;
  phase: string;
  requestAction: string;
  responseAction: string;
  requestIntentLabel?: string;
  responseStatusLabel?: string;
  toolSchemaCount: number;
  toolUseNames: string[];
  toolUseCount: number;
  toolResultCount: number;
  contextCompressed: boolean;
  /** 模型故障转移元数据（来自 context snapshot 摘要的有界摘取；旧数据缺省）。 */
  failover?: CaptureFailover;
  /** 观测通道：gateway=网关捕获（缺省）；agent_local_import=官方直连本地导入。 */
  origin: string;
  /** 本次请求实际命中的供应商目标（Agent 维度会话后 target 只在 Step 级表达）。 */
  targetId?: string;
  targetName?: string;
}

export interface StoredStepPricingSnapshot extends PricingSnapshot {
  priced?: boolean;
  currency?: string;
  unpricedReason?: string;
}

/** 单 Step 检查器详情只关联一行账本和当前 Turn 的一条已存洞察。 */
export interface ApiAgentStepDetail extends ApiAgentStep {
  model?: string;
  vendor?: string;
  rateMultiplier?: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  vendorCost: number;
  actualCost: number;
  /** 人民币物化金额与冻结结算系数（2026-09-23）：总览「估算真实成本」人民币口径用。 */
  actualCostCny?: number;
  fxRateToCny?: number;
  currency?: string;
  durationMs: number;
  usageSource?: string;
  usageConfidence?: string;
  pricingSnapshot?: StoredStepPricingSnapshot;
  learningInsight?: HarnessLearningInsight & Record<string, unknown>;
  /** 计费通道（pay_as_you_go / plan / subscription；旧数据缺省视同按量）。 */
  billingChannel?: string;
  /** 套餐积分消耗与单位（如 zcode 积分；仅套餐/订阅通道携带）。 */
  planCreditCost?: number;
  planCreditUnit?: string;
  /** 入账冻结的套餐成本估算（积分换算后的金额；status=estimated 才可信）。 */
  planEstimatedCost?: number;
  planEstimatedCurrency?: string;
  planEstimatedStatus?: string;
  /** 人民币 nano 物化与入账冻结汇率（2026-09-28）：Step 面板「估算真实成本」
   *  人民币口径与 Token 价格页同值；USD 套餐时与 planEstimatedCost 差一个汇率。 */
  planEstimatedCostNano?: number;
  planEstimatedFx?: number;
  /** 套餐估算折算明细（月费/额度/窗口，入账冻结 JSON 解析）；估算真实成本 ？换算链用。 */
  planEstimateDetail?: PlanEstimateDetailInput;
  /** P1 补强：协议原始停止原因 / 首字耗时 / 结果分类 / HTTP 状态（旧数据缺省）。 */
  stopReason?: string;
  firstTokenMs?: number;
  resultClass?: string;
  httpStatus?: number;
  /** P1：模型参数白名单值（来自 context snapshot 的 paramsDetail）。 */
  paramsDetail?: Record<string, unknown>;
  /** P1：压缩证据（来自 context snapshot 的 compaction）。 */
  compaction?: {kind: string; confidence: string; markerKind?: string; preview: string};
  /** 压缩事件注解（与 steps 页同源计算；深链旧步时概览条也正确）。 */
  compactionEvent?: TurnCompactionAnnotation;
  /** 模型故障转移元数据（来自 context snapshot 的 failover）。 */
  failover?: CaptureFailover;
}

export interface ApiCaptureSummary {
  captureSessionId: string;
  exchangeCount: number;
  startTime: string;
  endTime: string;
  targetSet: string[];
  modelSet: string[];
  fileSize: number;
}

export interface ApiAuxiliaryRequest {
  id: string;
  exchangeId: string;
  agentSessionId: string;
  agentThreadId: string;
  agentTurnId?: string;
  kind: string;
  timestamp: string;
  durationMs: number;
}

export interface ApiCaptureExchangeRef {
  exchangeId: string;
  capturedAt: string;
}

export interface StoredStepArtifact {
  value: Record<string, unknown>;
  sizeBytes: number;
  truncated: boolean;
  completeness?: Record<string, unknown>;
}

/** 兼容查询也必须在 SQL 中先过滤和分页，不能把全表读入 JS 后再 slice。 */
export function loadApiAgents(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): ApiOffsetPage<ApiAgentGroup> {
  const filters = apiFilters(searchParams, [
    ["agent", "agent_name"],
  ]);
  const page = apiPageParameters(searchParams);
  // Agent 维度会话（2026-09-17）：第一栏按 Agent 分组，一 Agent 一组；target 不再
  // 参与分组（仅作为 Session 列表内的 Step 级过滤条件），agent_fingerprint_id 自
  // v6 派生起恒为 fp-<agentName>。
  const rows = db.prepare(
    `SELECT MIN(target_name) AS target_name,
      agent_fingerprint_id, agent_name, COUNT(*) AS session_count,
      SUM(request_count) AS request_count, MIN(start_time) AS start_time,
      MAX(end_time) AS end_time
     FROM agent_sessions ${filters.where}
     GROUP BY agent_fingerprint_id, agent_name
     ORDER BY end_time DESC, agent_name
     LIMIT ? OFFSET ?`,
  ).all(...filters.parameters, page.limit, page.offset) as Array<{
    target_name: string;
    agent_fingerprint_id: string;
    agent_name: string;
    session_count: number;
    request_count: number;
    start_time: string;
    end_time: string;
  }>;
  const candidateCount = db.prepare(
    `SELECT COUNT(*) FROM (
      SELECT 1 FROM agent_sessions ${filters.where}
      GROUP BY agent_fingerprint_id, agent_name
    )`,
  ).pluck().get(...filters.parameters) as number;
  return apiOffsetPage(db, rows.map(row => ({
    id: row.agent_name,
    agentFingerprintId: row.agent_fingerprint_id,
    agentName: row.agent_name,
    sessionCount: row.session_count,
    requestCount: row.request_count,
    startTime: row.start_time,
    endTime: row.end_time,
  })), candidateCount, page);
}

export function loadApiAgentSessions(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): ApiOffsetPage<ApiAgentSession> {
  const filters = apiFilters(searchParams, [
    ["agent", "agent_name"],
    ["session", "id"],
  ]);
  // Agent 维度会话（2026-09-17）：target 不再是 Session 属性，降级为 Step 级过滤
  // 条件——Session 内任一 Step 的 raw exchange 命中该 target 即视为匹配（走
  // idx_steps_session_time + raw 主键，不展开全量）。无任何模型 Step 的空壳
  // Session（如仅含辅助标题调用的会话）不进入列表。
  const targetId = normalizedParam(searchParams, "target");
  if (targetId) {
    filters.where = `${filters.where || "WHERE 1=1"} AND EXISTS (
      SELECT 1 FROM agent_steps ts
      JOIN raw_exchange_refs tr ON tr.exchange_id = ts.exchange_id
      WHERE ts.agent_session_id = agent_sessions.id AND tr.target_id = ?)`;
    filters.parameters.push(targetId);
  }
  filters.where = `${filters.where || "WHERE 1=1"} AND EXISTS (
    SELECT 1 FROM agent_steps st WHERE st.agent_session_id = agent_sessions.id)`;
  const page = apiPageParameters(searchParams);
  const rows = db.prepare(
    `SELECT id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, external_conversation_id, source, confidence,
      start_time, end_time, model_set_json, request_count, thread_count
     FROM agent_sessions ${filters.where}
     ORDER BY end_time DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...filters.parameters, page.limit, page.offset) as Array<{
    id: string;
    target_id: string;
    target_name: string;
    agent_fingerprint_id: string;
    agent_name: string;
    external_session_id: string | null;
    external_conversation_id: string | null;
    source: string;
    confidence: string;
    start_time: string;
    end_time: string;
    model_set_json: string;
    request_count: number;
    thread_count: number;
  }>;
  const candidateCount = apiCount(db, "agent_sessions", filters);
  const items: ApiAgentSession[] = rows.map(row => ({
    id: row.id,
    targetId: row.target_id,
    targetName: row.target_name,
    agentFingerprintId: row.agent_fingerprint_id,
    agentName: row.agent_name,
    externalSessionId: row.external_session_id ?? undefined,
    externalConversationId: row.external_conversation_id ?? undefined,
    source: row.source,
    confidence: row.confidence,
    startTime: row.start_time,
    endTime: row.end_time,
    modelSet: safeBoundedStringArray(row.model_set_json, MAX_SESSION_MODELS),
    requestCount: row.request_count,
    threadCount: row.thread_count,
  }));
  // 会话级 target 分布（P1-7）：列表页每会话一条有界子查询（命中
  // idx_steps_session_time，仅取 target 计数），跨 target 故障转移会话可见。
  const distributionFor = db.prepare(
    `SELECT r.target_id AS targetId, MAX(r.target_name) AS targetName, COUNT(*) AS stepCount
     FROM agent_steps st
     JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
     WHERE st.agent_session_id = ?
     GROUP BY r.target_id
     ORDER BY stepCount DESC
     LIMIT 5`,
  );
  for (const item of items) {
    const rowsForSession = distributionFor.all(item.id) as Array<{targetId: string; targetName: string; stepCount: number}>;
    if (rowsForSession.length > 1) {
      const truncated = rowsForSession.length > 4;
      item.targetDistribution = rowsForSession.slice(0, 4).map(row => ({
        targetId: row.targetId,
        targetName: row.targetName,
        stepCount: row.stepCount,
      }));
      item.targetDistributionTruncated = truncated;
    }
  }
  return apiOffsetPage(db, items, candidateCount, page);
}

export function loadApiAgentTurns(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): ApiOffsetPage<ApiAgentTurn> {
  const filters = apiFilters(searchParams, [
    ["session", "agent_session_id"],
    ["thread", "agent_thread_id"],
    ["turn", "id"],
  ]);
  const page = apiPageParameters(searchParams);
  const rows = db.prepare(
    `SELECT id, agent_session_id, agent_thread_id, native_turn_id, source,
      confidence, status, segment_index, start_exchange_id, start_time,
      end_time, model_set_json, step_count, auxiliary_request_count
     FROM agent_turns ${filters.where}
     ORDER BY end_time DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...filters.parameters, page.limit, page.offset) as Array<{
    id: string;
    agent_session_id: string;
    agent_thread_id: string;
    native_turn_id: string | null;
    source: string;
    confidence: string;
    status: string;
    segment_index: number;
    start_exchange_id: string;
    start_time: string;
    end_time: string;
    model_set_json: string;
    step_count: number;
    auxiliary_request_count: number;
  }>;
  const candidateCount = apiCount(db, "agent_turns", filters);
  return apiOffsetPage(db, rows.map(row => ({
    id: row.id,
    agentSessionId: row.agent_session_id,
    agentThreadId: row.agent_thread_id,
    nativeTurnId: row.native_turn_id ?? undefined,
    source: row.source,
    confidence: row.confidence,
    status: row.status,
    segmentIndex: row.segment_index,
    startExchangeId: row.start_exchange_id,
    startTime: row.start_time,
    endTime: row.end_time,
    modelSet: safeBoundedStringArray(row.model_set_json, MAX_SESSION_MODELS),
    stepCount: row.step_count,
    auxiliaryRequestCount: row.auxiliary_request_count,
  })), candidateCount, page);
}

export function loadApiAgentSteps(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): ApiOffsetPage<ApiAgentStep> {
  const filters = apiFilters(searchParams, [
    ["session", "s.agent_session_id"],
    ["thread", "s.agent_thread_id"],
    ["turn", "s.agent_turn_id"],
    ["stepId", "s.id"],
  ]);
  // 观测通道筛选（双链路观测）：join raw_exchange_refs 后按 origin 精确过滤；
  // 计数查询带同一 join，保证 candidateCount 与列表口径一致。
  const originValues = (searchParams.getAll("origin")
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(value => value === "gateway" || value === "agent_local_import"));
  const uniqueOrigins = [...new Set(originValues)];
  if (uniqueOrigins.length > 0 && uniqueOrigins.length < 2) {
    filters.where = filters.where || "WHERE 1=1";
    filters.where += ` AND r.origin = ?`;
    filters.parameters.push(uniqueOrigins[0]!);
  } else if (uniqueOrigins.length >= 2) {
    filters.where = filters.where || "WHERE 1=1";
    filters.where += ` AND r.origin IN (${uniqueOrigins.map(() => "?").join(", ")})`;
    filters.parameters.push(...uniqueOrigins);
  }
  const page = apiPageParameters(searchParams);
  const rows = db.prepare(
    `SELECT s.id, s.exchange_id, s.agent_session_id, s.agent_thread_id,
      s.agent_turn_id, s.step_index, s.timestamp, s.phase,
      s.request_action, s.response_action, s.request_intent_label,
      s.response_status_label, s.tool_schema_count, s.context_compressed,
      COALESCE((
        SELECT json_group_array(tool_name) FROM (
          SELECT tool_name FROM tool_calls
          WHERE agent_step_id = s.id
          GROUP BY tool_name ORDER BY MIN(created_at), tool_name
          LIMIT ${MAX_TOOL_GROUPS}
        )
      ), '[]') AS tool_names_json,
      (SELECT COUNT(*) FROM tool_calls WHERE agent_step_id = s.id)
        AS tool_use_count,
      (SELECT COUNT(*) FROM tool_calls
       WHERE agent_step_id = s.id AND status = 'completed') AS tool_result_count,
      COALESCE(
        s.failover_json,
        json_extract((SELECT summary_json FROM context_snapshots WHERE agent_step_id = s.id), '$.failover'),
        json_extract((SELECT summary_json FROM context_snapshots WHERE agent_step_id = s.id), '$.snapshot.failover')
      ) AS failover_json,
      r.origin AS origin,
      r.target_id AS target_id,
      r.target_name AS target_name
     FROM agent_steps s
     LEFT JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
     ${filters.where}
     ORDER BY s.timestamp DESC, s.exchange_id DESC LIMIT ? OFFSET ?`,
  ).all(...filters.parameters, page.limit, page.offset) as Array<{
    id: string;
    exchange_id: string;
    agent_session_id: string;
    agent_thread_id: string;
    agent_turn_id: string;
    step_index: number;
    timestamp: string;
    phase: string;
    request_action: string;
    response_action: string;
    request_intent_label: string | null;
    response_status_label: string | null;
    tool_schema_count: number;
    context_compressed: 0 | 1;
    tool_names_json: string;
    tool_use_count: number;
    tool_result_count: number;
    failover_json: string | null;
    origin: string | null;
    target_id: string | null;
    target_name: string | null;
  }>;
  const countWhere = filters.where.replaceAll("s.", "");
  const candidateCount = db.prepare(
    `SELECT COUNT(*) FROM agent_steps
     LEFT JOIN raw_exchange_refs r ON r.exchange_id = agent_steps.exchange_id
     ${countWhere}`,
  ).pluck().get(...filters.parameters) as number;
  return apiOffsetPage(db, rows.map(row => ({
    id: row.id,
    exchangeId: row.exchange_id,
    agentSessionId: row.agent_session_id,
    agentThreadId: row.agent_thread_id,
    agentTurnId: row.agent_turn_id,
    stepIndex: row.step_index,
    timestamp: row.timestamp,
    phase: row.phase,
    requestAction: row.request_action,
    responseAction: row.response_action,
    requestIntentLabel: row.request_intent_label ?? undefined,
    responseStatusLabel: row.response_status_label ?? undefined,
    toolSchemaCount: row.tool_schema_count,
    toolUseNames: safeBoundedStringArray(row.tool_names_json, MAX_TOOL_GROUPS),
    toolUseCount: row.tool_use_count,
    toolResultCount: row.tool_result_count,
    contextCompressed: row.context_compressed === 1,
    failover: parseFailoverJson(row.failover_json),
    origin: row.origin ?? "gateway",
    targetId: row.target_id ?? undefined,
    targetName: row.target_name ?? undefined,
  })), candidateCount, page);
}

export function loadApiAgentStepDetail(
  db: DeepaaDatabase,
  stepId: string,
  dataDir?: string,
): ApiAgentStepDetail | undefined {
  const row = db.prepare(
    `SELECT s.id, s.exchange_id, s.agent_session_id, s.agent_thread_id,
      s.agent_turn_id, s.native_step_id, s.step_index, s.timestamp, s.phase,
      s.request_action, s.response_action, s.request_intent_label,
      s.response_status_label, s.tool_schema_count, s.context_compressed,
      COALESCE((
        SELECT json_group_array(tool_name) FROM (
          SELECT tool_name FROM tool_calls
          WHERE agent_step_id = s.id
          GROUP BY tool_name ORDER BY MIN(created_at), tool_name
          LIMIT ${MAX_TOOL_GROUPS}
        )
      ), '[]') AS tool_names_json,
      (SELECT COUNT(*) FROM tool_calls WHERE agent_step_id = s.id)
        AS tool_use_count,
      (SELECT COUNT(*) FROM tool_calls
       WHERE agent_step_id = s.id AND status = 'completed') AS tool_result_count,
      u.model, u.vendor, u.rate_multiplier,
      COALESCE(u.input_tokens, s.input_tokens) AS input_tokens,
      COALESCE(u.cache_read_tokens, s.cache_read_tokens) AS cache_read_tokens,
      COALESCE(u.cache_write_tokens, s.cache_write_tokens) AS cache_write_tokens,
      COALESCE(u.output_tokens, s.output_tokens) AS output_tokens,
      COALESCE(u.vendor_cost, s.vendor_cost) AS vendor_cost,
      COALESCE(u.actual_cost, s.actual_cost) AS actual_cost,
      u.actual_cost_cny AS actual_cost_cny,
      u.fx_rate_to_cny AS fx_rate_to_cny,
      u.currency AS currency,
      COALESCE(u.duration_ms, s.duration_ms) AS duration_ms,
      u.usage_source, u.usage_confidence, u.pricing_snapshot_json,
      u.billing_channel, u.plan_credit_cost, u.plan_credit_unit,
      u.plan_estimated_cost, u.plan_estimated_currency, u.plan_estimated_status,
      u.plan_estimated_cost_nano, u.plan_estimated_fx,
      u.plan_estimate_detail_json,
      s.stop_reason, u.first_token_ms, u.result_class, r.status AS http_status,
      r.origin AS origin, r.target_id AS target_id, r.target_name AS target_name
     FROM agent_steps s
     LEFT JOIN usage_ledger u ON u.agent_step_id = s.id
     LEFT JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
     WHERE s.id = ? LIMIT 1`,
  ).get(stepId) as ApiAgentStepDetailRow | undefined;
  if (!row) return undefined;
  const snapshotEvidence = loadStepSnapshotEvidence(db, row.id, dataDir);
  const compactionEvent = loadTurnCompactionEvents(db, row.agent_turn_id, dataDir)
    .annotations.get(row.id);
  return {
    id: row.id,
    exchangeId: row.exchange_id,
    agentSessionId: row.agent_session_id,
    agentThreadId: row.agent_thread_id,
    agentTurnId: row.agent_turn_id,
    nativeStepId: row.native_step_id ?? undefined,
    stepIndex: row.step_index,
    timestamp: row.timestamp,
    phase: row.phase,
    requestAction: row.request_action,
    responseAction: row.response_action,
    requestIntentLabel: resolveDisplayIntentLabel(
      row.request_action,
      row.request_intent_label,
      row.step_index,
      compactionEvent !== undefined,
    ) ?? undefined,
    responseStatusLabel: row.response_status_label ?? undefined,
    toolSchemaCount: row.tool_schema_count,
    toolUseNames: safeBoundedStringArray(row.tool_names_json, MAX_TOOL_GROUPS),
    toolUseCount: row.tool_use_count,
    toolResultCount: row.tool_result_count,
    contextCompressed: row.context_compressed === 1,
    model: row.model ?? undefined,
    vendor: row.vendor ?? undefined,
    rateMultiplier: row.rate_multiplier ?? undefined,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    vendorCost: row.vendor_cost,
    actualCost: row.actual_cost,
    ...(row.actual_cost_cny !== null && row.actual_cost_cny !== undefined
      ? {actualCostCny: row.actual_cost_cny}
      : {}),
    ...(row.fx_rate_to_cny !== null && row.fx_rate_to_cny !== undefined
      ? {fxRateToCny: row.fx_rate_to_cny}
      : {}),
    ...(row.currency ? {currency: row.currency} : {}),
    durationMs: row.duration_ms,
    usageSource: row.usage_source ?? undefined,
    usageConfidence: row.usage_confidence ?? undefined,
    pricingSnapshot: parseStoredPricingSnapshot(row.pricing_snapshot_json),
    learningInsight: loadStoredLearningInsight(db, row.agent_turn_id),
    stopReason: row.stop_reason ?? undefined,
    firstTokenMs: row.first_token_ms ?? undefined,
    resultClass: row.result_class ?? undefined,
    httpStatus: row.http_status ?? undefined,
    origin: row.origin ?? "gateway",
    targetId: row.target_id ?? undefined,
    targetName: row.target_name ?? undefined,
    billingChannel: row.billing_channel ?? undefined,
    planCreditCost: row.plan_credit_cost ?? undefined,
    planCreditUnit: row.plan_credit_unit ?? undefined,
    planEstimatedCost: row.plan_estimated_cost ?? undefined,
    planEstimatedCurrency: row.plan_estimated_currency ?? undefined,
    planEstimatedStatus: row.plan_estimated_status ?? undefined,
    planEstimatedCostNano: row.plan_estimated_cost_nano ?? undefined,
    planEstimatedFx: row.plan_estimated_fx ?? undefined,
    planEstimateDetail: parsePlanEstimateDetailRecord(row.plan_estimate_detail_json),
    paramsDetail: snapshotEvidence?.paramsDetail,
    compaction: snapshotEvidence?.compaction,
    compactionEvent,
    failover: snapshotEvidence?.failover,
  };
}

interface ApiAgentStepDetailRow {
  id: string;
  exchange_id: string;
  agent_session_id: string;
  agent_thread_id: string;
  agent_turn_id: string;
  native_step_id: string | null;
  step_index: number;
  timestamp: string;
  phase: string;
  request_action: string;
  response_action: string;
  request_intent_label: string | null;
  response_status_label: string | null;
  tool_schema_count: number;
  context_compressed: 0 | 1;
  tool_names_json: string;
  tool_use_count: number;
  tool_result_count: number;
  model: string | null;
  vendor: string | null;
  rate_multiplier: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  vendor_cost: number;
  actual_cost: number;
  actual_cost_cny: number | null;
  fx_rate_to_cny: number | null;
  currency: string | null;
  duration_ms: number;
  usage_source: string | null;
  usage_confidence: string | null;
  pricing_snapshot_json: string | null;
  billing_channel: string | null;
  plan_credit_cost: number | null;
  plan_credit_unit: string | null;
  plan_estimated_cost: number | null;
  plan_estimated_currency: string | null;
  plan_estimated_status: string | null;
  plan_estimated_cost_nano: number | null;
  plan_estimated_fx: number | null;
  plan_estimate_detail_json: string | null;
  stop_reason: string | null;
  origin: string | null;
  target_id: string | null;
  target_name: string | null;
  first_token_ms: number | null;
  result_class: string | null;
  http_status: number | null;
}

/**
 * 从 context snapshot artifact 有界提取 step 详情所需的 paramsDetail / compaction / failover。
 * 只做主键单行读取与浅层字段摘取，不重建完整快照投影。
 */
function loadStepSnapshotEvidence(
  db: DeepaaDatabase,
  stepId: string,
  dataDir?: string,
): {
  paramsDetail?: Record<string, unknown>;
  compaction?: ApiAgentStepDetail["compaction"];
  failover?: CaptureFailover;
} | undefined {
  const summaryRow = db.prepare(
    `SELECT summary_json, artifact_storage, artifact_hash
     FROM context_snapshots WHERE agent_step_id = ? LIMIT 1`,
  ).get(stepId) as
    | {summary_json: string; artifact_storage: string | null; artifact_hash: string | null}
    | undefined;
  const summaryJson = summaryRow
    ? resolveDerivedArtifactJson(dataDir, {
      artifact_storage: summaryRow.artifact_storage,
      artifact_hash: summaryRow.artifact_hash,
      inline_json: summaryRow.summary_json,
    }) ?? undefined
    : undefined;
  if (!summaryJson) return undefined;
  try {
    const parsed = JSON.parse(summaryJson) as {
      paramsDetail?: Record<string, unknown>;
      compaction?: {kind: string; confidence: string; markerKind?: string; preview: string};
      failover?: unknown;
      snapshot?: {
        paramsDetail?: Record<string, unknown>;
        compaction?: ApiAgentStepDetail["compaction"];
        failover?: unknown;
      };
    };
    const paramsDetail = parsed.paramsDetail ?? parsed.snapshot?.paramsDetail;
    const compaction = parsed.compaction ?? parsed.snapshot?.compaction;
    const failover = parseStepFailover(parsed.failover ?? parsed.snapshot?.failover);
    if (!paramsDetail && !compaction && !failover) return undefined;
    return {
      ...(paramsDetail ? {paramsDetail} : {}),
      ...(compaction ? {compaction} : {}),
      ...(failover ? {failover} : {}),
    };
  } catch {
    return undefined;
  }
}

/** 解析 json_extract 摘取的 failover JSON 文本；NULL 或异常结构返回 undefined。 */
function parseFailoverJson(value: string | null): CaptureFailover | undefined {
  if (!value) return undefined;
  try {
    return parseStepFailover(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function loadApiCaptures(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): ApiOffsetPage<ApiCaptureSummary> {
  const filters = apiFilters(searchParams, [
    ["target", "target_id"],
    ["agent", "agent_name"],
  ]);
  const page = apiPageParameters(searchParams);
  const rows = db.prepare(
    `SELECT capture_session_id, COUNT(*) AS exchange_count,
      MIN(captured_at) AS start_time, MAX(completed_at) AS end_time,
      MIN(target_id) AS target_id, SUM(line_length_bytes) AS file_size,
      COALESCE((
        SELECT json_group_array(model) FROM (
          SELECT model FROM raw_exchange_refs model_ref
          WHERE model_ref.capture_session_id = raw_exchange_refs.capture_session_id
            AND model IS NOT NULL
          GROUP BY model ORDER BY model LIMIT ${MAX_SESSION_MODELS}
        )
      ), '[]') AS model_set_json
     FROM raw_exchange_refs ${filters.where}
     GROUP BY capture_session_id
     ORDER BY end_time DESC, capture_session_id DESC LIMIT ? OFFSET ?`,
  ).all(...filters.parameters, page.limit, page.offset) as Array<{
    capture_session_id: string;
    exchange_count: number;
    start_time: string;
    end_time: string;
    target_id: string;
    file_size: number;
    model_set_json: string;
  }>;
  const candidateCount = db.prepare(
    `SELECT COUNT(DISTINCT capture_session_id)
     FROM raw_exchange_refs ${filters.where}`,
  ).pluck().get(...filters.parameters) as number;
  return apiOffsetPage(db, rows.map(row => ({
    captureSessionId: row.capture_session_id,
    exchangeCount: row.exchange_count,
    startTime: row.start_time,
    endTime: row.end_time,
    targetSet: [row.target_id],
    modelSet: safeBoundedStringArray(row.model_set_json, MAX_SESSION_MODELS),
    fileSize: row.file_size,
  })), candidateCount, page);
}

export function loadApiAuxiliaryRequests(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): ApiOffsetPage<ApiAuxiliaryRequest> {
  const filters = apiFilters(searchParams, [
    ["session", "agent_session_id"],
    ["thread", "agent_thread_id"],
    ["turn", "agent_turn_id"],
  ]);
  const page = apiPageParameters(searchParams);
  const rows = db.prepare(
    `SELECT id, exchange_id, agent_session_id, agent_thread_id,
      agent_turn_id, kind, timestamp, duration_ms
     FROM auxiliary_requests ${filters.where}
     ORDER BY timestamp DESC, exchange_id DESC LIMIT ? OFFSET ?`,
  ).all(...filters.parameters, page.limit, page.offset) as Array<{
    id: string;
    exchange_id: string;
    agent_session_id: string;
    agent_thread_id: string;
    agent_turn_id: string | null;
    kind: string;
    timestamp: string;
    duration_ms: number;
  }>;
  const candidateCount = apiCount(db, "auxiliary_requests", filters);
  return apiOffsetPage(db, rows.map(row => ({
    id: row.id,
    exchangeId: row.exchange_id,
    agentSessionId: row.agent_session_id,
    agentThreadId: row.agent_thread_id,
    agentTurnId: row.agent_turn_id ?? undefined,
    kind: row.kind,
    timestamp: row.timestamp,
    durationMs: row.duration_ms,
  })), candidateCount, page);
}

export function loadApiCaptureExchangeRefs(
  db: DeepaaDatabase,
  captureSessionId: string,
  searchParams = new URLSearchParams(),
): ApiOffsetPage<ApiCaptureExchangeRef> {
  const page = apiPageParameters(searchParams);
  const rows = db.prepare(
    `SELECT exchange_id, captured_at FROM raw_exchange_refs
     WHERE capture_session_id = ?
     ORDER BY captured_at DESC, exchange_id DESC LIMIT ? OFFSET ?`,
  ).all(captureSessionId, page.limit, page.offset) as Array<{
    exchange_id: string;
    captured_at: string;
  }>;
  const candidateCount = db.prepare(
    `SELECT COUNT(*) FROM raw_exchange_refs WHERE capture_session_id = ?`,
  ).pluck().get(captureSessionId) as number;
  return apiOffsetPage(db, rows.map(row => ({
    exchangeId: row.exchange_id,
    capturedAt: row.captured_at,
  })), candidateCount, page);
}

export function resolveApiAgentStepId(
  db: DeepaaDatabase,
  stepIdOrExchangeId: string,
  turnId?: string,
): string | undefined {
  const turnCondition = turnId ? "AND agent_turn_id = ?" : "";
  const parameters = turnId
    ? [stepIdOrExchangeId, stepIdOrExchangeId, turnId]
    : [stepIdOrExchangeId, stepIdOrExchangeId];
  return db.prepare(
    `SELECT id FROM agent_steps
     WHERE (id = ? OR exchange_id = ?) ${turnCondition}
     LIMIT 1`,
  ).pluck().get(...parameters) as string | undefined;
}

export function loadStoredStepArtifact(
  db: DeepaaDatabase,
  stepId: string,
  kind: "context" | "diff",
  dataDir?: string,
): StoredStepArtifact | undefined {
  const table = kind === "context" ? "context_snapshots" : "step_diffs";
  const column = kind === "context" ? "summary_json" : "diff_json";
  const row = db.prepare(
    `SELECT ${column} AS artifact_json, size_bytes,
       artifact_storage, artifact_hash
     FROM ${table} WHERE agent_step_id = ? LIMIT 1`,
  ).get(stepId) as {
    artifact_json: string;
    size_bytes: number;
    artifact_storage: string | null;
    artifact_hash: string | null;
  } | undefined;
  if (
    !row
    || !Number.isSafeInteger(row.size_bytes)
    || row.size_bytes < 0
    || row.size_bytes > MAX_STORED_ARTIFACT_BYTES
  ) return undefined;
  // 外置派生物：从内容寻址 gz 文件读取原文（有界）；文件缺失时降级为不可用。
  const artifactJson = row.artifact_storage === "external"
    ? resolveDerivedArtifactJson(dataDir, {
      artifact_storage: row.artifact_storage,
      artifact_hash: row.artifact_hash,
      inline_json: row.artifact_json,
    })
    : row.artifact_json;
  if (
    !artifactJson
    || Buffer.byteLength(artifactJson) > MAX_STORED_ARTIFACT_BYTES
  ) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifactJson) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const envelope = parsed as Record<string, unknown>;
  const value = kind === "context"
    && envelope.snapshot
    && typeof envelope.snapshot === "object"
    && !Array.isArray(envelope.snapshot)
    // 紧凑 harnessPayload 在读取层展开，客户端线格式保持不变。
    ? normalizeStoredContextSnapshot(envelope.snapshot as Record<string, unknown>)
    : envelope;
  return {
    value: kind === "diff"
      ? attachOnDemandContextView(db, stepId, value, dataDir)
      : value,
    sizeBytes: row.size_bytes,
    truncated: envelope.truncated === true,
    completeness: envelope.completeness
      && typeof envelope.completeness === "object"
      && !Array.isArray(envelope.completeness)
      ? envelope.completeness as Record<string, unknown>
      : undefined,
  };
}

/** 行级 Context Diff 视图行数上限（按需计算，不落库）。 */
const CONTEXT_VIEW_TARGET_ROW_LIMIT = 120;
const CONTEXT_VIEW_REMOVED_ROW_LIMIT = 60;
const CONTEXT_VIEW_PREVIEW_MAX_CHARS = 120;

/**
 * 行级 Context Diff 视图按需计算（2026-09-11 存储瘦身）：视图可由上一步与当前步
 * 两个快照推导，落库会让 step_diffs 每步多出数十 KB，因此在读取时才构建。
 * 只做主键/唯一索引单行读取，行数与预览长度均有界。
 */
function attachOnDemandContextView(
  db: DeepaaDatabase,
  stepId: string,
  diffValue: Record<string, unknown>,
  dataDir?: string,
): Record<string, unknown> {
  if (diffValue.contextView !== undefined) return diffValue;
  const step = db.prepare(
    `SELECT agent_thread_id AS threadId, agent_turn_id AS turnId, step_index AS stepIndex
     FROM agent_steps WHERE id = ? LIMIT 1`,
  ).get(stepId) as {threadId: string; turnId: string; stepIndex: number} | undefined;
  if (!step) return diffValue;
  const readSnapshot = (targetStepId: string) => {
    const row = db.prepare(
      `SELECT summary_json, artifact_storage, artifact_hash
       FROM context_snapshots WHERE agent_step_id = ? LIMIT 1`,
    ).get(targetStepId) as
      | {summary_json: string; artifact_storage: string | null; artifact_hash: string | null}
      | undefined;
    if (!row) return undefined;
    const json = resolveDerivedArtifactJson(dataDir, {
      artifact_storage: row.artifact_storage,
      artifact_hash: row.artifact_hash,
      inline_json: row.summary_json,
    });
    if (!json) return undefined;
    try {
      const parsed = JSON.parse(json) as {snapshot?: Record<string, unknown>};
      if (!parsed.snapshot || typeof parsed.snapshot !== "object") return undefined;
      return normalizeStoredContextSnapshot(parsed.snapshot) as unknown as ObservedContextSnapshot;
    } catch {
      return undefined;
    }
  };
  const previousStepId = db.prepare(
    `SELECT id FROM agent_steps
     WHERE agent_thread_id = ? AND agent_turn_id = ? AND step_index < ?
     ORDER BY step_index DESC, id DESC LIMIT 1`,
  ).pluck().get(step.threadId, step.turnId, step.stepIndex) as string | undefined;
  const current = readSnapshot(stepId);
  if (!current) return diffValue;
  const previous = previousStepId ? readSnapshot(previousStepId) : undefined;
  try {
    const view = buildStepContextDiffView(
      previous,
      current,
      diffValue as unknown as StepDiff,
    );
    return {
      ...diffValue,
      contextView: {
        ...view,
        targetRows: view.targetRows.slice(0, CONTEXT_VIEW_TARGET_ROW_LIMIT).map(
          boundContextDiffRow,
        ),
        removedRows: view.removedRows.slice(0, CONTEXT_VIEW_REMOVED_ROW_LIMIT).map(
          boundContextDiffRow,
        ),
        targetRowsTotal: view.targetRows.length,
        removedRowsTotal: view.removedRows.length,
      },
    };
  } catch {
    return diffValue;
  }
}

function boundContextDiffRow(row: ContextDiffRow): ContextDiffRow {
  return {
    ...row,
    preview: row.preview.length > CONTEXT_VIEW_PREVIEW_MAX_CHARS
      ? `${row.preview.slice(0, CONTEXT_VIEW_PREVIEW_MAX_CHARS - 1)}…`
      : row.preview,
    evidence: row.evidence.slice(0, 2),
  };
}

export function loadWorkbenchTree(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
  options: WorkbenchQueryOptions = {},
): WorkbenchTreePage {
  const state = readDerivationStatus(db);
  const limit = pageLimit(searchParams, options.limit);
  const cursor = decodeCursor(searchParams.get("cursor"));
  const target = normalizedParam(searchParams, "target");
  const agent = normalizedParam(searchParams, "agent");
  // 时间范围是页面私有过滤参数：与 target/agent 不同，不受 includeAllTargets 影响，
  // 且只约束候选列表；深链解析与精确 Session 附加不受影响（选中会话始终可见）。
  const timeRange = parseOptionalWorkbenchRange(searchParams);
  const filterConditions: string[] = [];
  const filterParameters: unknown[] = [];
  if (target) {
    // Agent 维度会话（2026-09-17）：target 降级为 Step 级过滤条件——Session 内任一
    // Step 的 raw exchange 命中该 target 即视为匹配（idx_steps_session_time + 主键）。
    filterConditions.push(`EXISTS (
      SELECT 1 FROM agent_steps ts
      JOIN raw_exchange_refs tr ON tr.exchange_id = ts.exchange_id
      WHERE ts.agent_session_id = agent_sessions.id AND tr.target_id = ?)`);
    filterParameters.push(target);
  }
  if (agent) {
    filterConditions.push("agent_name = ?");
    filterParameters.push(agent);
  }
  const conditions = options.includeAllTargets ? [] : [...filterConditions];
  const parameters = options.includeAllTargets ? [] : [...filterParameters];
  if (timeRange) {
    conditions.push("end_time >= ?");
    parameters.push(timeRange.start);
    conditions.push("start_time < ?");
    parameters.push(timeRange.end);
  }
  // 空壳 Session（无任何模型 Step，如仅含辅助标题调用的会话）不进入候选列表。
  conditions.push(
    `EXISTS(
       SELECT 1 FROM agent_steps visible_step
       WHERE visible_step.agent_session_id = agent_sessions.id
       LIMIT 1
     )`,
  );
  const candidateCount = countSessions(db, conditions, parameters);
  if (cursor) {
    conditions.push("(end_time < ? OR (end_time = ? AND id < ?))");
    parameters.push(cursor.time, cursor.time, cursor.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, start_time, end_time,
      ${SESSION_MODEL_SET_PROJECTION_SQL},
      request_count, thread_count
     FROM agent_sessions ${where}
     ORDER BY end_time DESC, id DESC
     LIMIT ?`,
  ).all(...parameters, limit + 1) as SessionRow[];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const resolvedPath = resolveWorkbenchSelection(db, searchParams);

  if (
    !cursor
    && resolvedPath
    && !pageRows.some(row => row.id === resolvedPath.session)
  ) {
    const exact = sessionById(db, resolvedPath.session);
    if (exact && matchesAgentFilter(exact, target, agent)) pageRows.push(exact);
  }

  const agents = groupSessions(pageRows);
  const lastPageRow = rows[Math.min(limit, rows.length) - 1];
  return {
    agents,
    latestPath: resolveWorkbenchSelection(
      db,
      new URLSearchParams([
        ...(target ? [["target", target]] as Array<[string, string]> : []),
        ...(agent ? [["agent", agent]] as Array<[string, string]> : []),
      ]),
    ),
    resolvedPath,
    candidateCount,
    processedCount: rows.length,
    limited: hasMore,
    hasMore,
    nextCursor: hasMore && lastPageRow
      ? encodeCursor({ time: lastPageRow.end_time, id: lastPageRow.id })
      : undefined,
    dataVersion: state.dataVersion,
    derivedStatus: state.status,
    backlogPendingCount: countBacklogPendingJobs(db),
  };
}

export function resolveWorkbenchSelection(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): WorkbenchSelectionPath | undefined {
  const requestedStep = normalizedParam(searchParams, "step");
  const requestedTurn = normalizedParam(searchParams, "turn");
  const requestedThread = normalizedParam(searchParams, "thread");
  const requestedSession = normalizedParam(searchParams, "session");
  const target = normalizedParam(searchParams, "target");
  const agent = normalizedParam(searchParams, "agent");
  // 无显式业务路径时自动跟随「范围内最新会话」；显式深链不受时间范围约束。
  const timeRange = parseOptionalWorkbenchRange(searchParams);
  const hasExplicitHierarchy = !!(
    requestedStep || requestedTurn || requestedThread || requestedSession
  );

  let row: SelectionRow | undefined;
  if (requestedStep) row = selectionByStep(db, requestedStep);
  else if (requestedTurn) row = selectionByTurn(db, requestedTurn);
  else if (requestedThread) row = selectionByThread(db, requestedThread);
  else if (requestedSession) {
    row = selectionBySession(db, requestedSession, true);
  } else {
    row = latestSelectionSession(db, target, agent, timeRange);
  }
  if (!row) return undefined;
  if (
    (target && row.target_id !== target)
    || (agent && row.agent_name !== agent)
    || (requestedSession && row.session_id !== requestedSession)
    || (requestedThread && row.thread_id !== requestedThread)
    || (requestedTurn && row.turn_id !== requestedTurn)
  ) {
    return undefined;
  }

  if (!row.thread_id) {
    const thread = latestThreadForSession(db, row.session_id, hasExplicitHierarchy);
    if (!thread) return undefined;
    row = { ...row, thread_id: thread };
  }
  if (!hasExplicitHierarchy) {
    if (!row.turn_id) {
      const turn = latestTurnForThread(db, row.thread_id);
      if (turn) row = { ...row, turn_id: turn };
    }
    if (row.turn_id && !row.step_id) {
      const step = latestStepForTurn(db, row.turn_id);
      if (step) row = { ...row, step_id: step };
    }
  }

  return {
    target: row.target_id,
    agent: row.agent_name,
    session: row.session_id,
    thread: row.thread_id,
    turn: row.turn_id ?? undefined,
    step: row.step_id ?? undefined,
    ancestorThreadIds: ancestorThreadIds(db, row.thread_id),
  };
}

/**
 * 深链规范化按最具体的内部 ID 逐级回退。这样有效 Step 可以修正陈旧上级，
 * 无效 Step 也只会被清掉并退回有效 Turn，不会让整条选择失效。
 */
export function resolveCanonicalWorkbenchSelection(
  db: DeepaaDatabase,
  searchParams = new URLSearchParams(),
): WorkbenchSelectionPath | undefined {
  for (const key of ["step", "turn", "thread", "session"] as const) {
    const value = normalizedParam(searchParams, key);
    if (!value) continue;
    const path = resolveWorkbenchSelection(
      db,
      new URLSearchParams([[key, value]]),
    );
    if (path) return path;
  }
  const broadParams = new URLSearchParams();
  for (const key of ["target", "agent"] as const) {
    const value = normalizedParam(searchParams, key);
    if (value) broadParams.set(key, value);
  }
  return resolveWorkbenchSelection(db, broadParams);
}

export function loadSessionThreads(
  db: DeepaaDatabase,
  agentSessionId: string,
  searchParams = new URLSearchParams(),
): BoundedPage<WorkbenchThreadNode> | undefined {
  if (!hasRow(db, "agent_sessions", agentSessionId)) return undefined;
  const state = readDerivationStatus(db);
  const limit = pageLimit(searchParams);
  const parent = normalizedParam(searchParams, "parent");
  const cursor = decodeCursor(searchParams.get("cursor"));
  const parentCondition = parent
    ? "parent_agent_thread_id = ?"
    : "parent_agent_thread_id IS NULL";
  const baseParameters: unknown[] = [agentSessionId];
  if (parent) baseParameters.push(parent);
  const candidateCount = db.prepare(
    `SELECT COUNT(*) FROM agent_threads
     WHERE agent_session_id = ? AND ${parentCondition}`,
  ).pluck().get(...baseParameters) as number;
  const cursorSql = cursor
    ? "AND (end_time < ? OR (end_time = ? AND id < ?))"
    : "";
  const cursorParameters = cursor
    ? [cursor.time, cursor.time, cursor.id]
    : [];
  const rows = db.prepare(
    `SELECT t.id, t.agent_session_id, t.parent_agent_thread_id,
      t.external_thread_id, t.external_agent_id, t.display_name, t.is_root,
      t.is_placeholder, t.start_time, t.end_time, t.request_count,
      t.turn_count,
      (SELECT COUNT(*) FROM agent_threads child
       WHERE child.agent_session_id = t.agent_session_id
         AND child.parent_agent_thread_id = t.id) AS child_count
     FROM agent_threads t
     WHERE t.agent_session_id = ? AND t.${parentCondition} ${cursorSql}
     ORDER BY t.end_time DESC, t.id DESC LIMIT ?`,
  ).all(
    ...baseParameters,
    ...cursorParameters,
    limit + 1,
  ) as ThreadRow[];
  return boundedPage(
    rows,
    limit,
    candidateCount,
    state.dataVersion,
    state.status,
    row => threadNode(row),
    row => ({ time: row.end_time, id: row.id }),
  );
}

interface ThreadRow {
  id: string;
  agent_session_id: string;
  parent_agent_thread_id: string | null;
  external_thread_id: string | null;
  external_agent_id: string | null;
  display_name: string;
  is_root: number;
  is_placeholder: number;
  start_time: string;
  end_time: string;
  request_count: number;
  turn_count: number;
  child_count: number;
}

export function loadThreadTurns(
  db: DeepaaDatabase,
  threadId: string,
  searchParams = new URLSearchParams(),
): BoundedPage<WorkbenchTurnSummary> | undefined {
  if (!hasRow(db, "agent_threads", threadId)) return undefined;
  const state = readDerivationStatus(db);
  const limit = pageLimit(searchParams);
  const cursor = decodeCursor(searchParams.get("cursor"));
  const candidateCount = db.prepare(
    "SELECT COUNT(*) FROM agent_turns WHERE agent_thread_id = ?",
  ).pluck().get(threadId) as number;
  const rows = db.prepare(
    `SELECT id, agent_session_id, agent_thread_id, native_turn_id, start_time, end_time,
      step_count, auxiliary_request_count
     FROM agent_turns
     WHERE agent_thread_id = ?
       ${cursor ? "AND (end_time < ? OR (end_time = ? AND id < ?))" : ""}
     ORDER BY end_time DESC, id DESC LIMIT ?`,
  ).all(
    threadId,
    ...(cursor ? [cursor.time, cursor.time, cursor.id] : []),
    limit + 1,
  ) as TurnRow[];
  return boundedPage(
    rows,
    limit,
    candidateCount,
    state.dataVersion,
    state.status,
    row => ({
      id: row.id,
      agentSessionId: row.agent_session_id,
      agentThreadId: row.agent_thread_id,
      nativeTurnId: row.native_turn_id ?? undefined,
      startTime: row.start_time,
      endTime: row.end_time,
      stepCount: row.step_count,
      auxiliaryRequestCount: row.auxiliary_request_count,
    }),
    row => ({ time: row.end_time, id: row.id }),
  );
}

interface TurnRow {
  id: string;
  agent_session_id: string;
  agent_thread_id: string;
  native_turn_id: string | null;
  start_time: string;
  end_time: string;
  step_count: number;
  auxiliary_request_count: number;
}

/**
 * `conversation_continue` 的两类续写语义区分（2026-09-11）：
 * previous_response_id/conversation 续接 = 真·远端状态续接；
 * anthropic 全量历史重放 = 历史重放续写。避免整列 Step 行标签千篇一律。
 */
function refinedRequestIntentLabel(
  requestAction: string | null,
  storedLabel: string | null,
  contextMode: string | null,
): string | undefined {
  if (requestAction !== "conversation_continue") return storedLabel ?? undefined;
  if (contextMode === "stateful_delta") return "远端状态续接";
  if (contextMode === "full_replay") return "历史重放续写";
  return storedLabel ?? undefined;
}

/**
 * 「上下文压缩」标签的读路径还原（2026-09-22）：派生期只要请求携带压缩证据就把
 * 原始意图标签覆盖为「上下文压缩」（buildAgentStep），摘要常驻的后续请求全部中招。
 * 展示语义：只在压缩事件步（带注解）保留该标签；其余步按派生同款
 * requestIntentLabelFor 从 request_action 重算本来会有的意图标签。
 */
function resolveDisplayIntentLabel(
  requestAction: string | null,
  storedLabel: string | null,
  stepIndex: number,
  hasCompactionAnnotation: boolean,
): string | null {
  if (storedLabel !== "上下文压缩" || hasCompactionAnnotation) return storedLabel;
  return requestIntentLabelFor(
    (requestAction ?? "unknown") as AgentStep["requestAction"],
    stepIndex,
  );
}

/**
 * Turn 意图序列统计的服务端口径（与时间线第二栏四个数字同语义）：
 * - 「重试」按存储 request_intent_label='重试' 计。refinedRequestIntentLabel 只在
 *   request_action='conversation_continue' 时改写标签，而重试行的 request_action
 *   恒为 'retry_like'，不会被掩盖，故与客户端精化后展示严格等价；
 * - 「工具调用」是 tool_use 收尾的请求数，不是 tool_calls 条目数，不得与
 *   scope_aggregates.tool_call_count 混用。
 * 走 agent_turn_id 索引区间聚合，只输出 4 个标量。
 */
function loadTurnIntentStats(
  db: DeepaaDatabase,
  turnId: string,
): Omit<TurnIntentStats, "compressions"> {
  const row = db.prepare(
    `SELECT
       COUNT(*) FILTER (WHERE response_action = 'tool_use') AS tool_use_steps,
       COUNT(*) FILTER (WHERE request_intent_label = '重试') AS retries,
       COUNT(*) FILTER (WHERE response_action IN ('error', 'incomplete')) AS interruptions,
       COUNT(*) FILTER (WHERE response_action = 'final') AS finals
     FROM agent_steps
     WHERE agent_turn_id = ?`,
  ).get(turnId) as {
    tool_use_steps: number;
    retries: number;
    interruptions: number;
    finals: number;
  };
  return {
    toolUseSteps: row.tool_use_steps,
    retries: row.retries,
    interruptions: row.interruptions,
    finals: row.finals,
  };
}

interface TurnCompactionEvents {
  /** stepId → 注解（仅 wire 证据边界产生）。 */
  annotations: Map<string, TurnCompactionAnnotation>;
  /** 有证据的压缩事件数。 */
  compressions: number;
  /** 需要从「完成」剔除的压缩生成调用 step id（全部为 response_action='final' 的步）。 */
  generationFinalIds: Set<string>;
}

/**
 * Turn 压缩事件（读路径，wire 证据门槛）：
 * - 边界 = turn 中段 context_compressed 0→1 转变（LAG 前一步为 0；turn 首步即
 *   压缩是上一 turn 的历史状态，不算本 turn 事件）；
 * - 边界步必须有 snapshot 压缩证据（purpose 头 / 续接摘要标记）才生成注解与计数：
 *   纯裁剪边界（claude-code error 后本地裁剪、dsh/zcode 大多数形态）无法精准
 *   区分压缩生成调用，按 2026-09-22 用户确认不识别不计数，其它 Agent 展示零变化；
 * - purpose 头（dsh 形态）：边界步自身即压缩请求（generation）；摘要标记：边界步
 *   为 first-after，其紧邻前一步为 final 时该步是压缩生成调用（generation，从
 *   「完成」剔除——final 后同 turn 继续且上下文缩小本身即非正常完成）。
 * 边界数每 turn 通常 ≤2，snapshot 读取为主键单行，成本有界。
 */
function loadTurnCompactionEvents(
  db: DeepaaDatabase,
  turnId: string,
  dataDir?: string,
): TurnCompactionEvents {
  const boundaries = db.prepare(
    `SELECT step_index, id, response_action FROM (
       SELECT step_index, id, response_action, context_compressed AS comp,
         LAG(context_compressed) OVER (ORDER BY step_index) AS prev_comp
       FROM agent_steps WHERE agent_turn_id = ?
     ) WHERE comp = 1 AND prev_comp = 0 ORDER BY step_index`,
  ).all(turnId) as Array<{
    step_index: number;
    id: string;
    response_action: string;
  }>;
  const annotations = new Map<string, TurnCompactionAnnotation>();
  const generationFinalIds = new Set<string>();
  let compressions = 0;
  for (const boundary of boundaries) {
    const evidence = loadStepSnapshotEvidence(db, boundary.id, dataDir)?.compaction;
    if (!evidence) continue;
    compressions += 1;
    if (evidence.kind === "purpose_header") {
      annotations.set(boundary.id, {role: "generation", ordinal: compressions});
      if (boundary.response_action === "final") generationFinalIds.add(boundary.id);
      continue;
    }
    annotations.set(boundary.id, {role: "first-after", ordinal: compressions});
    const previous = db.prepare(
      "SELECT id, response_action FROM agent_steps WHERE agent_turn_id = ? AND step_index = ?",
    ).get(turnId, boundary.step_index - 1) as
      | {id: string; response_action: string}
      | undefined;
    if (previous?.response_action === "final") {
      annotations.set(previous.id, {role: "generation", ordinal: compressions});
      generationFinalIds.add(previous.id);
    }
  }
  return {annotations, compressions, generationFinalIds};
}

/**
 * 本 Turn 的用户真实输入（Turn 栏锚点）：取该 Turn 首步请求的 user_real 条目正文。
 * Preview 已保证 user_real 不被驱逐，因此正常无需回读 raw；命中上限即可。
 */
function loadTurnUserPrompt(
  db: DeepaaDatabase,
  turnId: string,
): TurnUserPrompt | undefined {
  const row = db.prepare(
    `SELECT s.id AS step_id, s.exchange_id, s.step_index, s.timestamp, p.preview_json
     FROM agent_steps s
     JOIN exchange_content_previews p ON p.exchange_id = s.exchange_id
     WHERE s.agent_turn_id = ?
     ORDER BY s.step_index ASC, s.id ASC LIMIT 1`,
  ).get(turnId) as {
    step_id: string;
    exchange_id: string;
    step_index: number;
    timestamp: string;
    preview_json: string;
  } | undefined;
  if (!row) return undefined;
  try {
    const preview = JSON.parse(row.preview_json) as {
      conversationItems?: Array<{
        semanticCategory?: string;
        textPreview?: string;
        truncated?: boolean;
        originalTextBytes?: number;
      }>;
    };
    const candidates = (preview.conversationItems ?? []).filter(
      item => item.semanticCategory === "user_real",
    );
    // 注入信封识别与「最后一条人类输入优先」规则由共享纯函数提供，
    // 与客户端完整读取端（交互内容 NDJSON 流解析）保持同一选取语义。
    const chosen = pickTurnUserPromptItem(candidates, item => item.textPreview);
    if (!chosen?.textPreview) return undefined;
    // 截断判定必须用投影条目自己的事实（previewTextBytes < originalTextBytes），
    // 旧实现用 textPreview.length >= 2000 判断，而单条正文上限只有 512 B，永远为假。
    const originalBytes = Number.isFinite(chosen.originalTextBytes) ? chosen.originalTextBytes : undefined;
    return {
      text: chosen.textPreview,
      stepIndex: row.step_index,
      stepId: row.step_id,
      exchangeId: row.exchange_id,
      timestamp: row.timestamp,
      truncated: chosen.truncated === true
        || chosen.textPreview.length >= USER_PROMPT_PREVIEW_LIMIT,
      originalBytes,
      source: looksLikeInjectedEnvelope(chosen.textPreview)
        ? "first_user_message"
        : "user_prompt",
    };
  } catch {
    return undefined;
  }
}

export function loadTurnSteps(
  db: DeepaaDatabase,
  turnId: string,
  searchParams = new URLSearchParams(),
  dataDir?: string,
): WorkbenchTurnStepsPage | undefined {
  if (!hasRow(db, "agent_turns", turnId)) return undefined;
  const state = readDerivationStatus(db);
  const limit = pageLimit(searchParams);
  const cursor = decodeCursor(searchParams.get("cursor"));
  const cursorIndex = cursor ? strictCursorInteger(cursor.time) : undefined;
  const candidateCount = db.prepare(
    "SELECT COUNT(*) FROM agent_steps WHERE agent_turn_id = ?",
  ).pluck().get(turnId) as number;
  const baseIntentStats = loadTurnIntentStats(db, turnId);
  const compaction = loadTurnCompactionEvents(db, turnId, dataDir);
  const intentStats: TurnIntentStats = {
    ...baseIntentStats,
    compressions: compaction.compressions,
    // 压缩生成调用（有证据边界的紧邻 final）不是面向用户的回合完成，从「完成」剔除。
    finals: baseIntentStats.finals - compaction.generationFinalIds.size,
  };
  const rows = db.prepare(
    `SELECT s.id, s.exchange_id, s.agent_session_id, s.agent_thread_id, s.agent_turn_id,
      s.native_step_id, s.step_index, s.timestamp, s.phase, s.request_intent_label,
      s.response_status_label, s.tool_schema_count, s.request_action, s.response_action,
      COALESCE(u.duration_ms, s.duration_ms) AS duration_ms, s.stop_reason AS stop_reason,
      s.input_tokens AS input_tokens, s.cache_read_tokens AS cache_read_tokens,
      s.cache_write_tokens AS cache_write_tokens, s.output_tokens AS output_tokens,
      u.first_token_ms AS first_token_ms, u.result_class AS result_class,
      f.request_context_mode AS context_mode,
      r.target_id AS target_id, r.target_name AS target_name,
      r.origin AS origin, r.status AS http_status,
      COALESCE(
        json_extract((SELECT summary_json FROM context_snapshots WHERE agent_step_id = s.id), '$.failover'),
        json_extract((SELECT summary_json FROM context_snapshots WHERE agent_step_id = s.id), '$.snapshot.failover')
      ) AS failover_json
     FROM agent_steps s
     LEFT JOIN usage_ledger u ON u.agent_step_id = s.id
     LEFT JOIN exchange_content_filter_status f ON f.exchange_id = s.exchange_id
     LEFT JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
     WHERE s.agent_turn_id = ?
       ${cursor ? "AND (s.step_index < ? OR (s.step_index = ? AND s.id < ?))" : ""}
     ORDER BY s.step_index DESC, s.id DESC LIMIT ?`,
  ).all(
    turnId,
    ...(cursor ? [cursorIndex, cursorIndex, cursor.id] : []),
    limit + 1,
  ) as StepRow[];
  const pageRows = rows.slice(0, limit);
  const tools = toolsForSteps(db, turnId, pageRows.map(row => row.id));
  const userPrompt = loadTurnUserPrompt(db, turnId);
  const hasMore = rows.length > limit;
  const last = pageRows.at(-1);
  return {
    userPrompt,
    intentStats,
    items: pageRows.map(row => {
      const stepTools = tools.get(row.id);
      return {
        id: row.id,
        exchangeId: row.exchange_id,
        agentSessionId: row.agent_session_id,
        agentThreadId: row.agent_thread_id,
        agentTurnId: row.agent_turn_id,
        nativeStepId: row.native_step_id ?? undefined,
        stepIndex: row.step_index,
        timestamp: row.timestamp,
        phase: row.phase,
        requestIntentLabel: refinedRequestIntentLabel(
          row.request_action,
          resolveDisplayIntentLabel(
            row.request_action,
            row.request_intent_label,
            row.step_index,
            compaction.annotations.has(row.id),
          ),
          row.context_mode,
        ),
        // 「完成」等意图序列统计依赖真实响应动作，不再由客户端猜测。
        responseAction: row.response_action ?? undefined,
        responseStatusLabel: row.response_status_label ?? undefined,
        toolSchemaCount: row.tool_schema_count,
        toolUseNames: stepTools?.names ?? [],
        toolUseNamesLimited: stepTools?.limited ?? false,
        toolUseCount: stepTools?.callCount ?? 0,
        toolResultCount: stepTools?.resultCount ?? 0,
        failover: parseFailoverJson(row.failover_json),
        targetId: row.target_id ?? undefined,
        targetName: row.target_name ?? undefined,
        origin: row.origin ?? "gateway",
        compactionRole: compaction.annotations.get(row.id)?.role,
        compactionOrdinal: compaction.annotations.get(row.id)?.ordinal,
        // 时间线节点元信息（v5）：耗时 / 首字 / 状态码 / 停止原因 / token。
        durationMs: row.duration_ms ?? 0,
        firstTokenMs: row.first_token_ms ?? undefined,
        httpStatus: row.http_status ?? undefined,
        resultClass: row.result_class ?? undefined,
        stopReason: row.stop_reason ?? undefined,
        inputTokens: Number(row.input_tokens) || 0,
        cacheReadTokens: Number(row.cache_read_tokens) || 0,
        cacheWriteTokens: Number(row.cache_write_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
      };
    }),
    candidateCount,
    processedCount: rows.length,
    limited: hasMore,
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor({ time: String(last.step_index), id: last.id })
      : undefined,
    dataVersion: state.dataVersion,
    derivedStatus: state.status,
  };
}

interface StepRow {
  id: string;
  exchange_id: string;
  agent_session_id: string;
  agent_thread_id: string;
  agent_turn_id: string;
  native_step_id: string | null;
  step_index: number;
  timestamp: string;
  phase: string;
  request_action: string | null;
  response_action: string | null;
  request_intent_label: string | null;
  response_status_label: string | null;
  target_id: string | null;
  target_name: string | null;
  origin: string | null;
  tool_schema_count: number;
  context_mode: string | null;
  failover_json: string | null;
  duration_ms: number | null;
  stop_reason: string | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  first_token_ms: number | null;
  result_class: string | null;
  http_status: number | null;
}

export function loadScopeSummary(
  db: DeepaaDatabase,
  scopeType: ScopeType,
  scopeId: string,
): ScopeSummary | undefined {
  if (!scopeExists(db, scopeType, scopeId)) return undefined;
  const aggregate = scopeType === "thread"
    ? threadAggregate(db, scopeId)
    : scopeType === "step"
      ? stepAggregate(db, scopeId)
      : directAggregate(db, scopeType, scopeId);
  const state = readDerivationStatus(db);
  const toolPage = scopeTools(db, scopeType, scopeId);
  const inputBase = aggregate.input_tokens + aggregate.cache_read_tokens;
  const requestCount = aggregate.step_request_count
    + aggregate.auxiliary_request_count;
  return {
    scopeType,
    scopeId,
    requestCount,
    stepRequestCount: aggregate.step_request_count,
    auxiliaryRequestCount: aggregate.auxiliary_request_count,
    inputTokens: aggregate.input_tokens,
    cacheReadTokens: aggregate.cache_read_tokens,
    cacheWriteTokens: aggregate.cache_write_tokens,
    outputTokens: aggregate.output_tokens,
    totalTokens: aggregate.input_tokens + aggregate.cache_read_tokens
      + aggregate.cache_write_tokens + aggregate.output_tokens,
    cacheHitRate: inputBase > 0
      ? aggregate.cache_read_tokens / inputBase
      : undefined,
    vendorCost: aggregate.vendor_cost,
    actualCost: aggregate.actual_cost,
    durationTotalMs: aggregate.duration_total_ms,
    durationSampleCount: aggregate.duration_sample_count,
    averageDurationMs: aggregate.duration_sample_count > 0
      ? aggregate.duration_total_ms / aggregate.duration_sample_count
      : undefined,
    toolCallCount: aggregate.tool_call_count,
    tools: toolPage.items,
    toolsCandidateCount: toolPage.candidateCount,
    toolsProcessedCount: toolPage.processedCount,
    toolsLimited: toolPage.limited,
    dataVersion: state.dataVersion,
  };
}

/**
 * 单条详情必须先由 SQLite 主键定位 source 范围，再读取 raw/blob；禁止回退扫描 capture 文件。
 */
export async function loadExchangeDetail(
  db: DeepaaDatabase,
  dataDir: string,
  exchangeId: string,
  options: LoadExchangeDetailOptions = {},
): Promise<RawCapturedExchange | undefined> {
  const ref = db.prepare(
    `SELECT r.exchange_id, r.source_id, s.relative_path, s.file_id,
      r.byte_offset, r.line_length_bytes
     FROM raw_exchange_refs r
     JOIN ingestion_sources s ON s.id = r.source_id
     WHERE r.exchange_id = ?
     LIMIT 1`,
  ).get(exchangeId) as RawExchangeRefRow | undefined;
  if (!ref) return undefined;
  const rawBodyReader = options.rawBodyReader || readRawBodyText;

  try {
    assertRawReferenceRange(ref);
    const line = await readRawReferenceLine(db, dataDir, ref);
    const exchange = parseRawExchangeLine(line, exchangeId);
    const requestText = await rawBodyReader(dataDir, exchange.request, {
      maxBytes: RAW_EXCHANGE_MAX_BYTES,
      label: "request",
    });
    const responseText = await rawBodyReader(dataDir, exchange.response, {
      maxBytes: RAW_EXCHANGE_MAX_BYTES,
      label: "response",
    });
    return hydrateRawCapturedExchange(dataDir, {
      ...exchange,
      request: { ...exchange.request, rawBody: requestText },
      response: { ...exchange.response, rawBody: responseText },
    }, { maxBytes: RAW_EXCHANGE_MAX_BYTES });
  } catch (error) {
    if (
      error instanceof UnsafeRawBodyReferenceError
      && /exceeds \d+-byte hydration budget/.test(error.message)
    ) {
      throw new RawBodyExceedsPreviewBudgetError(error);
    }
    if (
      !(error instanceof UnsafeRawReferenceError)
      && !(error instanceof UnsafeRawBodyReferenceError)
    ) {
      throw error;
    }
    writeUnsafeRawReferenceDiagnostic(db, ref);
    if (error instanceof UnsafeRawReferenceError) throw error;
    throw new UnsafeRawReferenceError(error);
  }
}

export function readDerivationStatus(
  db: DeepaaDatabase,
): DerivationStatus {
  const row = db.prepare(
    `SELECT worker_status, worker_error, data_version
     FROM schema_meta WHERE id = 1`,
  ).get() as {
    worker_status: DerivationStatus["status"];
    worker_error: string | null;
    data_version: number;
  } | undefined;
  return {
    status: row?.worker_status ?? "failed",
    dataVersion: row?.data_version ?? 0,
    error: row?.worker_error ?? undefined,
  };
}

/** 待处理派生任务数（pending + retry_wait，命中 claim 索引的有界 COUNT）。 */
function countBacklogPendingJobs(db: DeepaaDatabase): number {
  return db.prepare(
    `SELECT COUNT(*) FROM derivation_jobs
     WHERE job_status IN ('pending', 'retry_wait')`,
  ).pluck().get() as number;
}

export interface DerivationOverview extends DerivationStatus {
  registeredCount: number;
  /** 30 天投影窗口标记为 archived 的登记数（可观测字段，P0-4）。 */
  archivedCount: number;
  jobCounts: {
    pending: number;
    running: number;
    retryWait: number;
    succeeded: number;
    permanentError: number;
  };
  completenessCounts: {
    complete: number;
    limited: number;
    unavailable: number;
  };
  previewCounts: {
    complete: number;
    limited: number;
    unavailable: number;
    notMaterialized: number;
  };
  oldestPendingAt?: string;
  backlogAgeMs: number;
  lastRegisteredAt?: string;
  lastDerivedAt?: string;
  recentError?: {
    code: string;
    message: string;
    occurredAt: string;
  };
}

interface DerivationJobOverviewRow {
  pending_count: number;
  running_count: number;
  retry_wait_count: number;
  succeeded_count: number;
  permanent_error_count: number;
  complete_count: number;
  limited_count: number;
  unavailable_count: number;
  oldest_pending_at: string | null;
  last_derived_at: string | null;
}

/**
 * 低频状态页使用的完整派生概览。查询只聚合 SQLite 账本和有界错误摘要，
 * 不打开 JSONL、blob 或 preview_json。
 */
export function readDerivationOverview(
  db: DeepaaDatabase,
  now = new Date().toISOString(),
): DerivationOverview {
  const state = readDerivationStatus(db);
  const registration = db.prepare(
    `SELECT COUNT(*) AS registered_count,
       MAX(registered_at) AS last_registered_at
     FROM ingestion_records`,
  ).get() as {
    registered_count: number;
    last_registered_at: string | null;
  };
  const jobs = db.prepare(
    `SELECT
       COALESCE(SUM(job_status = 'pending'), 0) AS pending_count,
       COALESCE(SUM(job_status = 'running'), 0) AS running_count,
       COALESCE(SUM(job_status = 'retry_wait'), 0) AS retry_wait_count,
       COALESCE(SUM(job_status = 'succeeded'), 0) AS succeeded_count,
       COALESCE(SUM(job_status = 'permanent_error'), 0) AS permanent_error_count,
       COALESCE(SUM(projection_completeness = 'complete'), 0) AS complete_count,
       COALESCE(SUM(projection_completeness = 'limited'), 0) AS limited_count,
       COALESCE(SUM(projection_completeness = 'unavailable'), 0) AS unavailable_count,
       MIN(CASE WHEN job_status IN ('pending', 'running', 'retry_wait')
         THEN created_at END) AS oldest_pending_at,
       MAX(CASE WHEN job_status = 'succeeded'
         THEN completed_at END) AS last_derived_at
     FROM derivation_jobs`,
  ).get() as DerivationJobOverviewRow;
  const previews = db.prepare(
    `SELECT COUNT(*) AS materialized_count,
       COALESCE(SUM(preview_state = 'complete'), 0) AS complete_count,
       COALESCE(SUM(preview_state = 'limited'), 0) AS limited_count,
       COALESCE(SUM(preview_state = 'unavailable'), 0) AS unavailable_count
     FROM exchange_content_previews`,
  ).get() as {
    materialized_count: number;
    complete_count: number;
    limited_count: number;
    unavailable_count: number;
  };
  const derivedExchangeCount = db.prepare(
    "SELECT COUNT(*) FROM raw_exchange_refs",
  ).pluck().get() as number;
  const archivedCount = db.prepare(
    `SELECT COUNT(*) FROM ingestion_records WHERE projection_state = 'archived'`,
  ).pluck().get() as number;
  const recentError = db.prepare(
    `SELECT last_error_code AS code, last_error_message AS message,
       updated_at AS occurred_at
     FROM derivation_jobs
     WHERE last_error_code IS NOT NULL
     ORDER BY updated_at DESC, ingestion_record_id DESC
     LIMIT 1`,
  ).get() as {
    code: string;
    message: string | null;
    occurred_at: string;
  } | undefined;
  return {
    ...state,
    registeredCount: nonNegativeCount(registration.registered_count),
    archivedCount: nonNegativeCount(archivedCount),
    jobCounts: {
      pending: nonNegativeCount(jobs.pending_count),
      running: nonNegativeCount(jobs.running_count),
      retryWait: nonNegativeCount(jobs.retry_wait_count),
      succeeded: nonNegativeCount(jobs.succeeded_count),
      permanentError: nonNegativeCount(jobs.permanent_error_count),
    },
    completenessCounts: {
      complete: nonNegativeCount(jobs.complete_count),
      limited: nonNegativeCount(jobs.limited_count),
      unavailable: nonNegativeCount(jobs.unavailable_count),
    },
    previewCounts: {
      complete: nonNegativeCount(previews.complete_count),
      limited: nonNegativeCount(previews.limited_count),
      unavailable: nonNegativeCount(previews.unavailable_count),
      notMaterialized: Math.max(
        0,
        nonNegativeCount(derivedExchangeCount)
          - nonNegativeCount(previews.materialized_count),
      ),
    },
    oldestPendingAt: jobs.oldest_pending_at ?? undefined,
    backlogAgeMs: backlogAgeMs(jobs.oldest_pending_at, now),
    lastRegisteredAt: registration.last_registered_at ?? undefined,
    lastDerivedAt: jobs.last_derived_at ?? undefined,
    recentError: recentError ? {
      code: recentError.code,
      message: recentError.message ?? "",
      occurredAt: recentError.occurred_at,
    } : undefined,
  };
}

function nonNegativeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function backlogAgeMs(oldestPendingAt: string | null, now: string): number {
  if (!oldestPendingAt) return 0;
  const oldestMs = Date.parse(oldestPendingAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(oldestMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, nowMs - oldestMs);
}

function assertRawReferenceRange(ref: RawExchangeRefRow): void {
  if (
    !Number.isSafeInteger(ref.byte_offset)
    || ref.byte_offset < 0
    || !Number.isSafeInteger(ref.line_length_bytes)
    || ref.line_length_bytes < 1
    || ref.line_length_bytes > RAW_EXCHANGE_MAX_BYTES
    || !Number.isSafeInteger(ref.byte_offset + ref.line_length_bytes)
  ) {
    throw new UnsafeRawReferenceError();
  }
}

async function readRawReferenceLine(
  db: DeepaaDatabase,
  dataDir: string,
  ref: RawExchangeRefRow,
): Promise<Buffer> {
  const databaseDataDir = dirname(resolve(db.name));
  const configuredDataDir = resolve(dataDir);
  if (databaseDataDir !== configuredDataDir) {
    throw new UnsafeRawReferenceError();
  }
  const expectedRelativePath = posix.join(
    "captures",
    "v2",
    posix.basename(ref.relative_path),
  );
  if (
    ref.relative_path !== expectedRelativePath
    || extname(ref.relative_path) !== ".jsonl"
    || isAbsolute(ref.relative_path)
    || ref.relative_path.includes("\\")
  ) {
    throw new UnsafeRawReferenceError();
  }

  const capturesDir = join(configuredDataDir, "captures");
  const captureV2Dir = join(capturesDir, "v2");
  const sourcePath = resolve(configuredDataDir, ref.relative_path);
  if (dirname(sourcePath) !== captureV2Dir) {
    throw new UnsafeRawReferenceError();
  }
  const [dataInfo, capturesInfo, v2Info, sourceInfo] = await Promise.all([
    lstat(configuredDataDir),
    lstat(capturesDir),
    lstat(captureV2Dir),
    lstat(sourcePath),
  ]);
  if (
    (!dataInfo.isDirectory() && !dataInfo.isSymbolicLink())
    || !capturesInfo.isDirectory()
    || !v2Info.isDirectory()
    || !sourceInfo.isFile()
  ) {
    throw new UnsafeRawReferenceError();
  }
  const [realDataDir, realCapturesDir, realV2Dir, realSourcePath] =
    await Promise.all([
      realpath(configuredDataDir),
      realpath(capturesDir),
      realpath(captureV2Dir),
      realpath(sourcePath),
    ]);
  if (
    realCapturesDir !== join(realDataDir, "captures")
    || realV2Dir !== join(realCapturesDir, "v2")
    || realSourcePath !== join(realV2Dir, basename(sourcePath))
    || !isStrictDescendant(realV2Dir, realSourcePath)
  ) {
    throw new UnsafeRawReferenceError();
  }

  const handle = await open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const handleInfo = await handle.stat();
    const currentSourceInfo = await lstat(sourcePath);
    const currentRealSourcePath = await realpath(sourcePath);
    if (
      !handleInfo.isFile()
      || !Number.isSafeInteger(handleInfo.size)
      || handleInfo.size < 0
      || !currentSourceInfo.isFile()
      || currentRealSourcePath !== realSourcePath
      || handleInfo.dev !== currentSourceInfo.dev
      || handleInfo.ino !== currentSourceInfo.ino
      || `${handleInfo.dev}:${handleInfo.ino}` !== ref.file_id
      || ref.byte_offset + ref.line_length_bytes > handleInfo.size
    ) {
      throw new UnsafeRawReferenceError();
    }
    const buffer = Buffer.alloc(ref.line_length_bytes);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        ref.byte_offset + bytesRead,
      );
      if (result.bytesRead === 0) throw new UnsafeRawReferenceError();
      bytesRead += result.bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function parseRawExchangeLine(
  line: Buffer,
  expectedExchangeId: string,
): RawCapturedExchangeV2 {
  let contentEnd = line.length;
  if (contentEnd > 0 && line[contentEnd - 1] === 0x0a) contentEnd -= 1;
  if (contentEnd > 0 && line[contentEnd - 1] === 0x0d) contentEnd -= 1;
  if (contentEnd === 0) throw new UnsafeRawReferenceError();
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      line.subarray(0, contentEnd),
    );
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new UnsafeRawReferenceError(error);
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== 2
    || (parsed as { exchangeId?: unknown }).exchangeId !== expectedExchangeId
  ) {
    throw new UnsafeRawReferenceError();
  }
  return parsed as RawCapturedExchangeV2;
}

function writeUnsafeRawReferenceDiagnostic(
  db: DeepaaDatabase,
  ref: RawExchangeRefRow,
): void {
  try {
    db.prepare(
      `INSERT INTO derivation_diagnostics(
        exchange_id, source_id, code, severity, message, details_json, created_at
      )
      SELECT ?, ?, 'unsafe_raw_exchange_ref', 'error', ?, ?, ?
      WHERE NOT EXISTS(
        SELECT 1 FROM derivation_diagnostics
        WHERE code = 'unsafe_raw_exchange_ref'
          AND exchange_id = ? AND source_id = ?
      )`,
    ).run(
      ref.exchange_id,
      ref.source_id,
      "拒绝读取越出 captures/v2、超过预算或已经损坏的 raw Exchange 引用。",
      JSON.stringify({
        relativePath: ref.relative_path.slice(0, 512),
        byteOffset: ref.byte_offset,
        lineLengthBytes: ref.line_length_bytes,
      }),
      new Date().toISOString(),
      ref.exchange_id,
      ref.source_id,
    );
  } catch {
    // 原始安全错误优先返回；诊断写入失败不能掩盖根因。
  }
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

interface ApiFilterSet {
  where: string;
  parameters: string[];
}

function apiFilters(
  searchParams: URLSearchParams,
  mappings: ReadonlyArray<readonly [parameter: string, column: string]>,
): ApiFilterSet {
  const conditions: string[] = [];
  const parameters: string[] = [];
  for (const [parameter, column] of mappings) {
    const value = normalizedParam(searchParams, parameter);
    if (!value) continue;
    conditions.push(`${column} = ?`);
    parameters.push(value);
  }
  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    parameters,
  };
}

function apiPageParameters(searchParams: URLSearchParams): {
  limit: number;
  offset: number;
} {
  const requestedLimit = Number(searchParams.get("limit") || DEFAULT_PAGE_LIMIT);
  const requestedOffset = Number(searchParams.get("offset") || 0);
  return {
    limit: Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, MAX_API_PAGE_LIMIT))
      : DEFAULT_PAGE_LIMIT,
    offset: Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
      ? requestedOffset
      : 0,
  };
}

function apiCount(
  db: DeepaaDatabase,
  table: string,
  filters: ApiFilterSet,
): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table} ${filters.where}`)
    .pluck().get(...filters.parameters) as number;
}

function apiOffsetPage<T>(
  db: DeepaaDatabase,
  items: T[],
  candidateCount: number,
  page: { limit: number; offset: number },
): ApiOffsetPage<T> {
  const state = readDerivationStatus(db);
  const hasMore = page.offset + items.length < candidateCount;
  return {
    items,
    total: candidateCount,
    limit: page.limit,
    offset: page.offset,
    candidateCount,
    processedCount: items.length,
    limited: hasMore,
    hasMore,
    dataVersion: state.dataVersion,
    derivedStatus: state.status,
  };
}

function safeBoundedStringArray(value: string, limit: number): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .slice(0, limit)
      .map(item => item.slice(0, MAX_SESSION_MODEL_CHARS));
  } catch {
    return [];
  }
}

function countSessions(
  db: DeepaaDatabase,
  conditions: string[],
  parameters: unknown[],
): number {
  const where = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  return db.prepare(`SELECT COUNT(*) FROM agent_sessions ${where}`)
    .pluck().get(...parameters) as number;
}

function sessionById(
  db: DeepaaDatabase,
  sessionId: string,
): SessionRow | undefined {
  return db.prepare(
    `SELECT id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, start_time, end_time,
      ${SESSION_MODEL_SET_PROJECTION_SQL},
      request_count, thread_count
     FROM agent_sessions
     WHERE id = ?
       AND (source <> 'capture-session' OR EXISTS(
         SELECT 1 FROM agent_steps visible_step
         WHERE visible_step.agent_session_id = agent_sessions.id
         LIMIT 1
       ))`,
  ).get(sessionId) as SessionRow | undefined;
}

function matchesAgentFilter(
  row: SessionRow,
  _target: string | undefined,
  agent: string | undefined,
): boolean {
  // target 已不是 Session 属性（Step 级过滤条件），深链精确附加只校验 Agent 维度。
  return !agent || row.agent_name === agent;
}

function groupSessions(
  rows: SessionRow[],
): WorkbenchTreePage["agents"] {
  const groups = new Map<string, WorkbenchTreePage["agents"][number]>();
  for (const row of rows) {
    // Agent 维度会话（2026-09-17）：一 Agent 一组；target 不再参与分组。
    const key = row.agent_fingerprint_id;
    let group = groups.get(key);
    if (!group) {
      group = {
        agentFingerprintId: row.agent_fingerprint_id,
        agentName: row.agent_name,
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(sessionSummary(row));
  }
  return [...groups.values()];
}

function sessionSummary(row: SessionRow): WorkbenchSessionSummary {
  return {
    id: row.id,
    externalSessionId: row.external_session_id ?? undefined,
    startTime: row.start_time,
    endTime: row.end_time,
    modelSet: safeStringArray(row.model_set_json),
    modelSetLimited: row.model_set_string_count > MAX_SESSION_MODELS
      || row.model_set_value_limited === 1,
    requestCount: row.request_count,
    threadCount: row.thread_count,
  };
}

function safeStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
        .slice(0, MAX_SESSION_MODELS)
      : [];
  } catch {
    return [];
  }
}

function parseStoredPricingSnapshot(
  value: string | null,
): StoredStepPricingSnapshot | undefined {
  if (!value || Buffer.byteLength(value) > MAX_STORED_ARTIFACT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  const record = objectRecord(parsed);
  if (
    !record
    || (record.unit !== "per_million_tokens" && record.unit !== "USD_per_million_tokens")
    || typeof record.matchStrategy !== "string"
    || !PRICING_MATCH_STRATEGIES.has(record.matchStrategy as PricingMatchStrategy)
    || !nonNegativeFiniteNumber(record.rateMultiplier)
  ) return undefined;
  const baseRates = parsePricingRates(record.baseRates);
  const effectiveRates = parsePricingRates(record.effectiveRates);
  if ((record.baseRates !== undefined && !baseRates)
    || (record.effectiveRates !== undefined && !effectiveRates)) return undefined;
  const ambiguousCandidates = Array.isArray(record.ambiguousCandidates)
    && record.ambiguousCandidates.length <= 32
    && record.ambiguousCandidates.every(candidate => {
      const item = objectRecord(candidate);
      return !!item && nonEmptyText(item.id) && nonEmptyText(item.vendor);
    })
    ? record.ambiguousCandidates as Array<{ id: string; vendor: string }>
    : undefined;
  if (record.ambiguousCandidates !== undefined && !ambiguousCandidates) return undefined;
  return {
    unit: "per_million_tokens" as const,
    matchStrategy: record.matchStrategy as PricingMatchStrategy,
    rateMultiplier: record.rateMultiplier,
    ...(nonEmptyText(record.matchedModel) ? { matchedModel: record.matchedModel } : {}),
    ...(nonEmptyText(record.vendor) ? { vendor: record.vendor } : {}),
    ...(nonEmptyText(record.priceEntryId) ? { priceEntryId: record.priceEntryId } : {}),
    // 命中条目的上下文窗口随快照冻结（「模型参数」模块的上下文窗口（K）字段）。
    ...(nonNegativeFiniteNumber(record.contextWindow)
      ? { contextWindow: record.contextWindow as number }
      : {}),
    ...(nonEmptyText(record.overrideId) ? { overrideId: record.overrideId } : {}),
    ...(nonEmptyText(record.sourceUrl) ? { sourceUrl: record.sourceUrl } : {}),
    ...(nonEmptyText(record.confidence)
      ? { confidence: record.confidence as PricingSnapshot["confidence"] }
      : {}),
    ...(baseRates ? { baseRates } : {}),
    ...(effectiveRates ? { effectiveRates } : {}),
    ...(ambiguousCandidates ? { ambiguousCandidates } : {}),
    ...(typeof record.priced === "boolean" ? { priced: record.priced } : {}),
    ...(nonEmptyText(record.currency) ? { currency: record.currency } : {}),
    ...(nonEmptyText(record.unpricedReason) ? { unpricedReason: record.unpricedReason } : {}),
    // 套餐积分换算公式（2026-09-23）：会话追踪「估算真实成本（套餐成本估算）」？浮窗用。
    ...(nonEmptyText(record.planCreditFormula) ? { planCreditFormula: record.planCreditFormula } : {}),
    ...(nonEmptyText(record.planCreditFormulaDetail)
      ? { planCreditFormulaDetail: record.planCreditFormulaDetail }
      : {}),
  };
}

/** 套餐估算折算明细（有界解析，关键字段非法即整体缺省；？换算链用，2026-09-23）。 */
function parsePricingRates(value: unknown): PricingRates | undefined {  if (value === undefined) return undefined;
  const record = objectRecord(value);
  if (
    !record
    || !nonNegativeFiniteNumber(record.input)
    || !nonNegativeFiniteNumber(record.output)
    || !optionalNonNegativeFiniteNumber(record.cachedInput)
    || !optionalNonNegativeFiniteNumber(record.cacheWrite)
    || !optionalNonNegativeFiniteNumber(record.cacheWrite5m)
    || !optionalNonNegativeFiniteNumber(record.cacheWrite1h)
    || !optionalNonNegativeFiniteNumber(record.reasoning)
  ) return undefined;
  const longContext = parseLongContextTier(record.longContext);
  return {
    input: record.input,
    output: record.output,
    ...(record.cachedInput !== undefined
      ? { cachedInput: record.cachedInput as number }
      : {}),
    ...(record.cacheWrite !== undefined
      ? { cacheWrite: record.cacheWrite as number }
      : {}),
    ...(record.cacheWrite5m !== undefined
      ? { cacheWrite5m: record.cacheWrite5m as number }
      : {}),
    ...(record.cacheWrite1h !== undefined
      ? { cacheWrite1h: record.cacheWrite1h as number }
      : {}),
    ...(record.reasoning !== undefined
      ? { reasoning: record.reasoning as number }
      : {}),
    ...(longContext ? { longContext } : {}),
  };
}

/**
 * 长上下文阶梯有界解析（2026-09-24 修复）：此前白名单剥除 baseRates.longContext，
 * 会话追踪 ？浮窗按派生同规则复算档位（resolveLongContextRates）永远不命中，
 * 公式漏乘输入侧 ×2/输出侧 ×1.5 且不显示「长上下文档位」行，与 Token 价格页不一致。
 * 阶梯字段非法时只丢弃阶梯本身，不影响其余费率与快照整体可用性。
 */
function parseLongContextTier(value: unknown): LongContextPricingTier | undefined {
  const record = objectRecord(value);
  if (
    !record
    || !nonNegativeFiniteNumber(record.thresholdTokens)
    || !positiveFiniteNumber(record.inputMultiplier)
    || !positiveFiniteNumber(record.outputMultiplier)
  ) return undefined;
  const rates = objectRecord(record.rates);
  const absoluteRates: SparsePricingRates = {
    ...(nonNegativeFiniteNumber(rates?.input) ? { input: rates.input as number } : {}),
    ...(nonNegativeFiniteNumber(rates?.output) ? { output: rates.output as number } : {}),
    ...(nonNegativeFiniteNumber(rates?.cachedInput) ? { cachedInput: rates.cachedInput as number } : {}),
    ...(nonNegativeFiniteNumber(rates?.cacheWrite) ? { cacheWrite: rates.cacheWrite as number } : {}),
    ...(nonNegativeFiniteNumber(rates?.cacheWrite5m) ? { cacheWrite5m: rates.cacheWrite5m as number } : {}),
    ...(nonNegativeFiniteNumber(rates?.cacheWrite1h) ? { cacheWrite1h: rates.cacheWrite1h as number } : {}),
  };
  return {
    thresholdTokens: record.thresholdTokens,
    inputMultiplier: record.inputMultiplier,
    outputMultiplier: record.outputMultiplier,
    ...(Object.keys(absoluteRates).length > 0 ? { rates: absoluteRates } : {}),
  };
}

function positiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function loadStoredLearningInsight(
  db: DeepaaDatabase,
  turnId: string,
): ApiAgentStepDetail["learningInsight"] {
  const row = db.prepare(
    `SELECT insight_json, size_bytes FROM learning_insights
     WHERE agent_turn_id = ? LIMIT 1`,
  ).get(turnId) as { insight_json: string; size_bytes: number } | undefined;
  if (
    !row
    || !Number.isSafeInteger(row.size_bytes)
    || row.size_bytes < 0
    || row.size_bytes > MAX_STORED_ARTIFACT_BYTES
    || Buffer.byteLength(row.insight_json) > MAX_STORED_ARTIFACT_BYTES
  ) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.insight_json) as unknown;
  } catch {
    return undefined;
  }
  const record = objectRecord(parsed);
  if (
    !record
    || record.turnId !== turnId
    || !nonEmptyText(record.agentSessionId)
    || !nonEmptyText(record.summary)
    || !nonEmptyText(record.harnessPattern)
    || !nonEmptyText(record.confidence)
    || !Array.isArray(record.observations)
    || !nonEmptyText(record.copyableTemplate)
    || !Array.isArray(record.evidence)
  ) return undefined;
  return record as unknown as ApiAgentStepDetail["learningInsight"];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || nonNegativeFiniteNumber(value);
}

function selectionByStep(
  db: DeepaaDatabase,
  stepIdOrExchangeId: string,
): SelectionRow | undefined {
  return db.prepare(
    `SELECT s.target_id, s.agent_name, st.agent_session_id AS session_id,
      st.agent_thread_id AS thread_id, st.agent_turn_id AS turn_id,
      st.id AS step_id
     FROM agent_steps st
     JOIN agent_sessions s ON s.id = st.agent_session_id
     WHERE st.id = ? OR st.exchange_id = ?
     ORDER BY CASE WHEN st.id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  ).get(
    stepIdOrExchangeId,
    stepIdOrExchangeId,
    stepIdOrExchangeId,
  ) as SelectionRow | undefined;
}

function selectionByTurn(
  db: DeepaaDatabase,
  turnId: string,
): SelectionRow | undefined {
  return db.prepare(
    `SELECT s.target_id, s.agent_name, t.agent_session_id AS session_id,
      t.agent_thread_id AS thread_id, t.id AS turn_id, NULL AS step_id
     FROM agent_turns t
     JOIN agent_sessions s ON s.id = t.agent_session_id
     WHERE t.id = ?`,
  ).get(turnId) as SelectionRow | undefined;
}

function selectionByThread(
  db: DeepaaDatabase,
  threadId: string,
): SelectionRow | undefined {
  return db.prepare(
    `SELECT s.target_id, s.agent_name, t.agent_session_id AS session_id,
      t.id AS thread_id, NULL AS turn_id, NULL AS step_id
     FROM agent_threads t
     JOIN agent_sessions s ON s.id = t.agent_session_id
     WHERE t.id = ?`,
  ).get(threadId) as SelectionRow | undefined;
}

function selectionBySession(
  db: DeepaaDatabase,
  sessionId: string,
  rootOnly: boolean,
): SelectionRow | undefined {
  const session = db.prepare(
    `SELECT target_id, agent_name, id AS session_id
     FROM agent_sessions WHERE id = ?`,
  ).get(sessionId) as {
    target_id: string;
    agent_name: string;
    session_id: string;
  } | undefined;
  if (!session) return undefined;
  const threadId = latestThreadForSession(db, sessionId, rootOnly);
  if (!threadId) return undefined;
  return {
    ...session,
    thread_id: threadId,
    turn_id: null,
    step_id: null,
  };
}

function latestSelectionSession(
  db: DeepaaDatabase,
  target: string | undefined,
  agent: string | undefined,
  timeRange?: WorkbenchRange,
): SelectionRow | undefined {
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (target) {
    conditions.push("target_id = ?");
    parameters.push(target);
  }
  if (agent) {
    conditions.push("agent_name = ?");
    parameters.push(agent);
  }
  if (timeRange) {
    conditions.push("end_time >= ?");
    parameters.push(timeRange.start);
    conditions.push("start_time < ?");
    parameters.push(timeRange.end);
  }
  conditions.push(
    `(source <> 'capture-session' OR EXISTS(
       SELECT 1 FROM agent_steps visible_step
       WHERE visible_step.agent_session_id = agent_sessions.id
       LIMIT 1
     ))`,
  );
  // 「范围内最新会话」必须至少有一条模型 Step（与树空壳过滤同源判定）：
  // 正在思考中的新会话（0 Turn/0 Step）不得抢占自动选中，否则页面会一直停在
  // 「正在自动选择最新 Turn…」而看不到上一个有数据的 Step（2026-09-20 用户确认）。
  // 有 Step 而暂无账本行的会话仍可入选，下方回退链会用 agent_turns/agent_steps 补全路径。
  conditions.push(
    `EXISTS(
       SELECT 1 FROM agent_steps latest_path_step
       WHERE latest_path_step.agent_session_id = agent_sessions.id
       LIMIT 1
     )`,
  );
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const session = db.prepare(
    `SELECT target_id, agent_name, id AS session_id
     FROM agent_sessions ${where}
     ORDER BY end_time DESC, id DESC LIMIT 1`,
  ).get(...parameters) as {
    target_id: string;
    agent_name: string;
    session_id: string;
  } | undefined;
  if (!session) return undefined;
  const latestStep = db.prepare(
    `SELECT st.agent_thread_id AS thread_id,
      st.agent_turn_id AS turn_id, st.id AS step_id
     FROM usage_ledger ledger
     JOIN agent_steps st ON st.id = ledger.agent_step_id
     WHERE ledger.agent_session_id = ? AND ledger.agent_step_id IS NOT NULL
     ORDER BY ledger.created_at DESC, ledger.exchange_id DESC
     LIMIT 1`,
  ).get(session.session_id) as Pick<
    SelectionRow,
    "thread_id" | "turn_id" | "step_id"
  > | undefined;
  if (latestStep) return { ...session, ...latestStep };

  const threadId = latestThreadForSession(db, session.session_id, true);
  if (!threadId) return undefined;
  return {
    ...session,
    thread_id: threadId,
    turn_id: null,
    step_id: null,
  };
}

function latestThreadForSession(
  db: DeepaaDatabase,
  sessionId: string,
  rootOnly: boolean,
): string | undefined {
  return db.prepare(
    `SELECT id FROM agent_threads
     WHERE agent_session_id = ? ${rootOnly ? "AND is_root = 1" : ""}
     ORDER BY ${rootOnly ? "id" : "end_time DESC, id DESC"} LIMIT 1`,
  ).pluck().get(sessionId) as string | undefined;
}

function latestTurnForThread(
  db: DeepaaDatabase,
  threadId: string,
): string | undefined {
  // 自动路径只落在有 Step 的 Turn 上：最新 Turn 尚无 Step（思考中）时回看更早的 Turn，
  // 避免自动选中停在「该 Turn 暂无 Step」的空 Turn（仅用于 !hasExplicitHierarchy 分支）。
  return db.prepare(
    `SELECT id FROM agent_turns
     WHERE agent_thread_id = ? AND step_count > 0
     ORDER BY end_time DESC, id DESC LIMIT 1`,
  ).pluck().get(threadId) as string | undefined;
}

function latestStepForTurn(
  db: DeepaaDatabase,
  turnId: string,
): string | undefined {
  return db.prepare(
    `SELECT id FROM agent_steps WHERE agent_turn_id = ?
     ORDER BY step_index DESC, id DESC LIMIT 1`,
  ).pluck().get(turnId) as string | undefined;
}

function ancestorThreadIds(
  db: DeepaaDatabase,
  threadId: string,
): string[] {
  return db.prepare(
    `SELECT ancestor_thread_id FROM thread_closure
     WHERE descendant_thread_id = ? AND depth BETWEEN 1 AND ?
     ORDER BY depth DESC LIMIT ?`,
  ).pluck().all(
    threadId,
    MAX_ANCESTOR_DEPTH,
    MAX_ANCESTOR_DEPTH,
  ) as string[];
}

function threadNode(row: ThreadRow): WorkbenchThreadNode {
  return {
    id: row.id,
    agentSessionId: row.agent_session_id,
    parentAgentThreadId: row.parent_agent_thread_id ?? undefined,
    externalThreadId: row.external_thread_id ?? undefined,
    externalAgentId: row.external_agent_id ?? undefined,
    displayName: row.display_name,
    isRoot: row.is_root === 1,
    isPlaceholder: row.is_placeholder === 1,
    startTime: row.start_time,
    endTime: row.end_time,
    requestCount: row.request_count,
    turnCount: row.turn_count,
    childCount: row.child_count,
    children: [],
  };
}

function toolsForSteps(
  db: DeepaaDatabase,
  turnId: string,
  stepIds: string[],
): Map<string, StepToolSummary> {
  const result = new Map<string, StepToolSummary>();
  if (stepIds.length === 0) return result;
  const placeholders = stepIds.map(() => "?").join(",");
  const rows = db.prepare(
    `WITH grouped AS (
       SELECT agent_step_id, tool_name, status, COUNT(*) AS call_count
       FROM tool_calls
       WHERE agent_turn_id = ? AND agent_step_id IN (${placeholders})
       GROUP BY agent_step_id, tool_name, status
     ), ranked AS (
       SELECT agent_step_id, tool_name, status, call_count,
         ROW_NUMBER() OVER (
           PARTITION BY agent_step_id
           ORDER BY call_count DESC, tool_name, status
         ) AS group_rank,
         COUNT(*) OVER (PARTITION BY agent_step_id) AS group_count,
         SUM(call_count) OVER (PARTITION BY agent_step_id) AS total_count,
         SUM(CASE WHEN status = 'completed' THEN call_count ELSE 0 END)
           OVER (PARTITION BY agent_step_id) AS result_count
       FROM grouped
     )
     SELECT agent_step_id, tool_name, group_rank, group_count,
       total_count, result_count
     FROM ranked
     WHERE group_rank <= ?
     ORDER BY agent_step_id, group_rank
     LIMIT ?`,
  ).all(
    turnId,
    ...stepIds,
    MAX_TOOL_GROUPS + 1,
    stepIds.length * (MAX_TOOL_GROUPS + 1),
  ) as Array<{
    agent_step_id: string;
    tool_name: string;
    group_rank: number;
    group_count: number;
    total_count: number;
    result_count: number;
  }>;
  for (const row of rows) {
    const summary = result.get(row.agent_step_id) ?? {
      names: [],
      callCount: row.total_count,
      resultCount: row.result_count,
      limited: row.group_count > MAX_TOOL_GROUPS,
    };
    if (
      row.group_rank <= MAX_TOOL_GROUPS
      && !summary.names.includes(row.tool_name)
    ) {
      summary.names.push(row.tool_name);
    }
    result.set(row.agent_step_id, summary);
  }
  return result;
}

interface StepToolSummary {
  names: string[];
  callCount: number;
  resultCount: number;
  limited: boolean;
}

function directAggregate(
  db: DeepaaDatabase,
  scopeType: Exclude<ScopeType, "thread" | "step">,
  scopeId: string,
): AggregateRow {
  return (db.prepare(
    `SELECT step_request_count, auxiliary_request_count, input_tokens,
      cache_read_tokens, cache_write_tokens, output_tokens, vendor_cost,
      actual_cost, duration_total_ms, duration_sample_count, tool_call_count
     FROM scope_aggregates WHERE scope_type = ? AND scope_id = ?`,
  ).get(scopeType, scopeId) as AggregateRow | undefined) ?? emptyAggregate();
}

function stepAggregate(
  db: DeepaaDatabase,
  stepId: string,
): AggregateRow {
  return db.prepare(
    `SELECT 1 AS step_request_count, 0 AS auxiliary_request_count,
      COALESCE(u.input_tokens, s.input_tokens) AS input_tokens,
      COALESCE(u.cache_read_tokens, s.cache_read_tokens) AS cache_read_tokens,
      COALESCE(u.cache_write_tokens, s.cache_write_tokens) AS cache_write_tokens,
      COALESCE(u.output_tokens, s.output_tokens) AS output_tokens,
      COALESCE(u.vendor_cost, s.vendor_cost) AS vendor_cost,
      COALESCE(u.actual_cost, s.actual_cost) AS actual_cost,
      CASE WHEN COALESCE(u.duration_ms, s.duration_ms) > 0
        THEN COALESCE(u.duration_ms, s.duration_ms) ELSE 0 END AS duration_total_ms,
      CASE WHEN COALESCE(u.duration_ms, s.duration_ms) > 0 THEN 1 ELSE 0 END
        AS duration_sample_count,
      (SELECT COUNT(*) FROM tool_calls tc WHERE tc.agent_step_id = s.id)
        AS tool_call_count
     FROM agent_steps s
     LEFT JOIN usage_ledger u ON u.agent_step_id = s.id
     WHERE s.id = ? LIMIT 1`,
  ).get(stepId) as AggregateRow;
}

function threadAggregate(
  db: DeepaaDatabase,
  threadId: string,
): AggregateRow {
  return db.prepare(
    `SELECT
      COALESCE(SUM(a.step_request_count), 0) AS step_request_count,
      COALESCE(SUM(a.auxiliary_request_count), 0) AS auxiliary_request_count,
      COALESCE(SUM(a.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(a.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(a.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(a.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(a.vendor_cost), 0) AS vendor_cost,
      COALESCE(SUM(a.actual_cost), 0) AS actual_cost,
      COALESCE(SUM(a.duration_total_ms), 0) AS duration_total_ms,
      COALESCE(SUM(a.duration_sample_count), 0) AS duration_sample_count,
      COALESCE(SUM(a.tool_call_count), 0) AS tool_call_count
     FROM thread_closure c
     LEFT JOIN scope_aggregates a
       ON a.scope_type = 'thread' AND a.scope_id = c.descendant_thread_id
     WHERE c.ancestor_thread_id = ?`,
  ).get(threadId) as AggregateRow;
}

function emptyAggregate(): AggregateRow {
  return {
    step_request_count: 0,
    auxiliary_request_count: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    vendor_cost: 0,
    actual_cost: 0,
    duration_total_ms: 0,
    duration_sample_count: 0,
    tool_call_count: 0,
  };
}

function scopeTools(
  db: DeepaaDatabase,
  scopeType: ScopeType,
  scopeId: string,
): {
  items: ScopeToolSummary[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
} {
  let sql: string;
  if (scopeType === "thread") {
    sql = `WITH grouped AS (
        SELECT tc.tool_name, tc.status, COUNT(*) AS count
        FROM thread_closure c
        JOIN tool_calls tc ON tc.agent_thread_id = c.descendant_thread_id
        WHERE c.ancestor_thread_id = ?
        GROUP BY tc.tool_name, tc.status
      )
      SELECT tool_name, status, count, COUNT(*) OVER() AS candidate_count
      FROM grouped
      ORDER BY count DESC, tool_name, status
      LIMIT ?`;
  } else if (scopeType === "step") {
    sql = `WITH grouped AS (
        SELECT tool_name, status, COUNT(*) AS count FROM tool_calls
        WHERE agent_step_id = ? GROUP BY tool_name, status
      )
      SELECT tool_name, status, count, COUNT(*) OVER() AS candidate_count
      FROM grouped
      ORDER BY count DESC, tool_name, status
      LIMIT ?`;
  } else {
    const column = scopeType === "session" ? "agent_session_id" : "agent_turn_id";
    sql = `WITH grouped AS (
        SELECT tool_name, status, COUNT(*) AS count FROM tool_calls
        WHERE ${column} = ? GROUP BY tool_name, status
      )
      SELECT tool_name, status, count, COUNT(*) OVER() AS candidate_count
      FROM grouped
      ORDER BY count DESC, tool_name, status
      LIMIT ?`;
  }
  const rows = db.prepare(sql).all(
    scopeId,
    MAX_TOOL_GROUPS + 1,
  ) as Array<{
    tool_name: string;
    status: string;
    count: number;
    candidate_count: number;
  }>;
  const candidateCount = rows[0]?.candidate_count ?? 0;
  return {
    items: rows.slice(0, MAX_TOOL_GROUPS).map(row => ({
      name: row.tool_name,
      status: row.status,
      count: row.count,
    })),
    candidateCount,
    processedCount: rows.length,
    limited: candidateCount > MAX_TOOL_GROUPS,
  };
}

function scopeExists(
  db: DeepaaDatabase,
  scopeType: ScopeType,
  scopeId: string,
): boolean {
  const table = scopeType === "session"
    ? "agent_sessions"
    : scopeType === "thread"
      ? "agent_threads"
      : scopeType === "turn" ? "agent_turns" : "agent_steps";
  return hasRow(db, table, scopeId);
}

function hasRow(
  db: DeepaaDatabase,
  table: "agent_sessions" | "agent_threads" | "agent_turns" | "agent_steps",
  id: string,
): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
}

function boundedPage<Row, Item>(
  rows: Row[],
  limit: number,
  candidateCount: number,
  dataVersion: number,
  derivedStatus: DerivationStatus["status"],
  project: (row: Row) => Item,
  cursorOf: (row: Row) => { time: string; id: string },
): BoundedPage<Item> {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(project),
    candidateCount,
    processedCount: rows.length,
    limited: hasMore,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : undefined,
    dataVersion,
    derivedStatus,
  };
}

function normalizedParam(
  params: URLSearchParams,
  key: string,
): string | undefined {
  const value = params.get(key)?.trim();
  return value || undefined;
}

function pageLimit(
  params: URLSearchParams,
  override?: number,
): number {
  const raw = override ?? Number(params.get("limit") || DEFAULT_PAGE_LIMIT);
  if (!Number.isSafeInteger(raw) || raw < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(raw, MAX_PAGE_LIMIT);
}

function strictCursorInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidCursorError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidCursorError();
  return parsed;
}
