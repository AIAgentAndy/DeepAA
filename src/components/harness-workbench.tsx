"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Braces,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  Clock3,
  Copy,
  FileJson,
  GripVertical,
  ImageIcon,
  Layers,
  ListTree,
  Maximize2,
  Minimize2,
  Network,
  RefreshCw,
  Reply,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import type {
  CaptureIndexState,
  CaptureSummary,
  DerivedStatus,
  ExchangeIndexItem,
  UserPromptSummary,
  WorkbenchContextSnapshot,
  WorkbenchStepDiff,
  WorkbenchTreeState,
} from "@/lib/app-state";
import type {
  AgentTurn,
  AgentSession,
  AgentStep,
  AuxiliaryExchange,
  EvidencePointer,
  HarnessLearningInsight,
  StepDiff,
} from "@/lib/harness";
import type { TokenUsageSummary } from "@/lib/harness/stream-response";
import type { ApiAgentStepHarness } from "@/lib/harness/harness-step";
import type { ContextComposition } from "@/lib/harness/context-composition";
import type { ContextDiffRow } from "@/lib/harness/context-diff-view";
import type { ConversationCategory } from "@/lib/export-conversation";
import {
  fetchOptionalStepHarness,
} from "@/lib/workbench-harness-client";
import { buildFailoverTrajectory, formatFailoverBadgeText, formatFailoverChipText } from "@/lib/failover-display";
import { buildExportConversationQuery } from "@/lib/export-query";
import { buildRawMediaHref } from "@/lib/export-content-client";
import { ConversationExportViewer } from "@/components/conversation-export-viewer";
import {
  fetchWorkbenchRawInspectorMetadata,
  findWorkbenchRawMediaDescriptor,
  loadWorkbenchRawBody,
  splitWorkbenchRawMediaText,
  valueContainsWorkbenchMediaMarker,
  type WorkbenchRawBodyLoadResult,
  type WorkbenchRawMediaTextSegment,
} from "@/lib/workbench-raw-client";
import {
  parseWorkbenchMediaMarker,
  type WorkbenchRawInspectorMedia,
  type WorkbenchRawInspectorMetadata,
  type WorkbenchRawInspectorSide,
} from "@/lib/workbench-raw-inspector-types";
import {
  activeTreePathForSelection,
  agentNameFromSessionEvidence,
  defaultCollapsedTreeKeys,
  formatCostValue,
  formatStepToolSummary,
  hasCompleteWorkbenchAggregate,
  hierarchyRefreshPlan,
  overviewEvidencePlan,
  projectionOverviewSideSummary,
  reconcileCollapsedTreeKeys,
  resolveWorkbenchSelection,
  selectedStepAfterTurnStepsPage,
  tokenUsageSummaryFromStep,
  toolCallSummary,
  workbenchAggregateRefreshKey,
} from "@/lib/workbench-display";
import { workbenchSelectionQuery } from "@/lib/shared-selection";
import { formatLocalClock, formatLocalDateTime, formatRelativeLocalTime } from "@/lib/local-time";
import {useGlobalTimeZone} from "@/lib/timezone-preference";
import {
  appendWorkbenchRangeParams,
  defaultWorkbenchRange,
  normalizeWorkbenchRange,
  parseOptionalWorkbenchRange,
  type WorkbenchRange,
} from "@/lib/workbench-time-range";
import {
  parseWorkbenchSessionSearchResult,
  workbenchSessionSearchRequestUrl,
  type WorkbenchSessionSearchGroup,
  type WorkbenchSessionSearchResult,
  type WorkbenchSessionSearchSession,
} from "@/lib/workbench-search-client";
import { SessionsTimeRange } from "@/components/workbench/sessions-time-range";
import { RetentionScopeNotice } from "@/components/retention-scope-notice";
import { CostHelp } from "@/components/cost-help";
// 客户端安全模块：pricing.ts 含 fs/promises（服务端专用），客户端组件禁止值引用。
import { resolveLongContextRates } from "@/lib/pricing-rates";
import {
  actualCostDetailFormula,
  costDetailFormula,
  multipliedCostDetailFormula,
  planEstimateConversionNote,
  type CostFormulaItem,
} from "@/lib/token-pricing-display";
import { pickTurnUserPromptItem } from "@/lib/user-prompt-text";
import {
  mergeWorkbenchTurnStepsPage,
  parseWorkbenchContextSnapshotState,
  parseWorkbenchStepDetailResponse,
  parseWorkbenchStepDiffState,
  parseWorkbenchTurnStepsPage,
  turnStepsPageRequestUrl,
  type WorkbenchTurnIntentStats,
  type WorkbenchTurnStepsPage,
} from "@/lib/workbench-step-pages";
import {
  mergeWorkbenchTreeCaptures,
  mergeWorkbenchTreeSessions,
  parseWorkbenchTreeRefresh,
  WORKBENCH_REFRESH_CAPTURE_LIMIT,
  WORKBENCH_REFRESH_SESSION_LIMIT,
  workbenchDerivedStatus,
} from "@/lib/workbench-tree-refresh";
import {
  formatCacheHitRateFormula,
  formatTokenAmount,
  formatTotalTokenMillions,
} from "@/lib/token-pricing-display";
import {
  retainTurnRuntimeCaches,
  WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY,
  type WorkbenchTurnRuntimeCache,
} from "@/lib/workbench-turn-runtime-cache";
import type { BoundedPage, ScopeType } from "@/lib/db/models";
import type { ExchangeProjectionDetail } from "@/lib/db/exchange-projection-queries";
import type {
  WorkbenchSelectionPath,
  WorkbenchThreadNode,
  WorkbenchTreePage,
  WorkbenchTurnSummary,
} from "@/lib/db/workbench-queries";
import {
  mergeBoundedPage,
  compactHierarchicalId,
  parseThreadPage,
  parseTurnPage,
  retainRecentPages,
  ThreadTree,
  toggleExpandedId,
  type ThreadTreeRuntimeNode,
} from "@/components/workbench/thread-tree";
import { TreeNodeMeta } from "@/components/workbench/tree-node-meta";
import {
  canonicalWorkbenchParams,
  findSelectedAgentGroup,
  parseWorkbenchTreePage,
  refreshWorkbenchTreePage,
  useWorkbenchSelection,
  type WorkbenchClientSelection,
} from "@/components/workbench/use-workbench-selection";

type InspectorTab = "总览" | "请求" | "响应" | "上下文" | "交互内容" | "能力清单";
/** 旧深链参数 → 新页签（2026-09-18「变化」并入「上下文」/「能力清单」后保持向后兼容）。 */
const LEGACY_TAB_PARAMS: Record<string, InspectorTab> = {
  diff: "上下文",
  change: "上下文",
  harness: "能力清单",
};
type CollapsibleColumn = "capture" | "turn" | "timeline";
type ColumnCollapseState = Record<CollapsibleColumn, boolean>;
type ResizableColumn = CollapsibleColumn | "inspector";
type ColumnSizeState = Partial<Record<ResizableColumn, number>>;
type VisibleExchangeScope = "turn" | "capture" | "all";

/** 左栏会话树节点：每个节点携带其覆盖请求的最近时间，用于全树按时间倒序排列 */
type SessionTreeTurn = { turn: AgentTurn; latestTime: string };
type SessionTreeSession = { session: AgentSession; latestTime: string; turns: SessionTreeTurn[] };
type SessionTreeGroup = {
  key: string;
  target: string;
  agentLabel: string;
  latestTime: string;
  sessions: SessionTreeSession[];
};

interface HarnessWorkbenchProps {
  tree: WorkbenchTreePage;
  initialQuery: string;
  /** 首屏时间范围（服务端已按同一规则解析/钳制/兜底），保证 SSR 与客户端一致。 */
  initialRange?: WorkbenchRange;
  /** 保留窗口天数（服务端读 retention 配置）：查询区旁展示范围不完整提示。 */
  retentionDays?: number;
}

interface SqliteWorkbenchVersionState {
  version: string;
  derivedStatus: unknown;
}

interface AgentTurnWorkbenchDetailState {
  derived: {
    agentSessions: AgentSession[];
    agentTurns: AgentTurn[];
    steps: AgentStep[];
    auxiliaryExchanges: AuxiliaryExchange[];
    learningInsights: HarnessLearningInsight[];
  };
  derivedStatus: DerivedStatus;
}

const tabs: InspectorTab[] = ["总览", "请求", "响应", "上下文", "交互内容", "能力清单"];
const turnStepPageSize = 50;

const INSPECTOR_TAB_PARAMS: Partial<Record<InspectorTab, string>> = {
  "上下文": "context",
  "能力清单": "capabilities",
  "交互内容": "interaction",
};

function inspectorTabParam(tab: InspectorTab): string | undefined {
  return INSPECTOR_TAB_PARAMS[tab];
}

function inspectorTabFromParam(value: string | null | undefined): InspectorTab {
  const entry = Object.entries(INSPECTOR_TAB_PARAMS).find(([, param]) => param === value);
  if (entry) return entry[0] as InspectorTab;
  if (value && LEGACY_TAB_PARAMS[value]) return LEGACY_TAB_PARAMS[value];
  return "总览";
}
/** 步骤列表内部滚动的触发阈值：超过这个数量才启用内部上下滚动，否则整体随页面滚动。 */
/** 超过 15 个 Step 就在第二栏内部滚动，避免长 Turn 把整页撑高（2026-09-18 用户确认）。 */
const STEP_LIST_INTERNAL_SCROLL_THRESHOLD = 15;
const defaultColumnSizes: Record<ResizableColumn, number> = {
  capture: 380,
  turn: 210,
  timeline: 320,
  inspector: 600,
};
const minColumnSizes: Record<ResizableColumn, number> = {
  capture: 260,
  turn: 150,
  timeline: 220,
  inspector: 460,
};

/** 将 AgentStep.phase 映射为用户可读的中文标签（2026-09-19 用户反馈：工具请求/工具循环无法区分） */
function phaseLabel(phase: AgentStep["phase"]): string {
  switch (phase) {
    case "initial_prompt": return "初始提问";
    case "tool_result_followup": return "工具结果续接";
    // 工具请求 = 本步模型发起工具调用（首次或上一请求未带工具结果）；
    // 工具循环 = 拿到工具结果后、模型继续推理并再次发起工具调用。
    case "tool_request": return "发起工具调用";
    case "tool_loop": return "继续工具调用";
    case "final_answer": return "最终回答";
    case "retry": return "重试";
    case "error": return "错误";
    case "incomplete": return "不完整";
    default: return phase;
  }
}

/** 时间线节点类型：由请求阶段 + 响应语义推导，决定图标与配色。 */
type TimelineKind = "user" | "model" | "think" | "tool" | "result" | "system" | "error";

function timelineKind(step: AgentStep): TimelineKind {
  if (step.phase === "error" || step.phase === "incomplete" || step.phase === "retry") return "error";
  if (step.phase === "initial_prompt") return "user";
  if (step.phase === "tool_request" || step.phase === "tool_loop") return "tool";
  if (step.phase === "tool_result_followup") return "result";
  if (step.phase === "final_answer") {
    const reasoning = Number((step.tokenUsage as {reasoningTokens?: number} | undefined)?.reasoningTokens) || 0;
    return reasoning > 0 ? "think" : "model";
  }
  return "system";
}

function timelineIcon(step: AgentStep): React.ReactNode {
  switch (timelineKind(step)) {
    // 图标语义对齐请求阶段（2026-09-19 用户反馈：原组合不够形象）：
    // 人=用户提问 / 大脑=模型思考 / 扳手=工具请求·循环 / 回传箭头=工具结果续接 /
    // 星火=模型输出 / 警告=错误中断 / 层叠=系统。
    case "user": return <UserRound />;
    case "think": return <Brain />;
    case "tool": return <Wrench />;
    case "result": return <Reply />;
    case "error": return <AlertTriangle />;
    case "system": return <Layers />;
    default: return <Sparkles />;
  }
}

/** 节点标题 = 请求阶段（用户可读枚举）+ 实际动作（工具名 / 模型名）。 */
function timelineTitle(step: AgentStep): string {
  const kind = timelineKind(step);
  if (kind === "tool") {
    const tool = step.toolUseNames[0];
    return `${phaseLabel(step.phase)}${tool ? ` · ${tool}` : ""}`;
  }
  // 「模型思考」可能不是本 Turn 最后一次响应（后面还会有回答），不能叫最终回答；
  // 只有纯输出的收尾（模型输出）才标注「最终回答」（2026-09-19 用户确认口径）。
  if (kind === "model" || kind === "think") {
    const model = step.pricingSnapshot?.matchedModel;
    return `${kind === "think" ? "模型思考" : "最终回答"}${model ? ` · ${model}` : ""}`;
  }
  if (kind === "error") return `${phaseLabel(step.phase)} · ${stepStatusLabel(step)}`;
  return phaseLabel(step.phase);
}

/** 节点正文：一句话说明这次请求「要干什么 → 结果如何」；
 *  意图可能被合法抑制（stepIntentLabel 返回 undefined），此时只显示状态。 */
function timelineBody(step: AgentStep): string | undefined {
  const intent = stepIntentLabel(step);
  const status = stepStatusLabel(step);
  if (!intent) return status || undefined;
  if (!status || status === intent) return intent;
  return `${intent} → ${status}`;
}

/** 回退到原始动作枚举，兼容未派生标签的缓存数据。
 *  「上下文压缩」标签的还原已在服务端完成（resolveDisplayIntentLabel）：事件步保留
 *  该标签，摘要常驻的后续步还原为派生同款意图标签，客户端不再自行抑制。 */
function stepIntentLabel(step: AgentStep): string {
  return step.requestIntentLabel || step.requestAction;
}
function stepStatusLabel(step: AgentStep): string {
  return step.responseStatusLabel || step.responseAction;
}

/**
 * 第二行元信息是否存在（2026-09-18 用户确认）：直连/状态/耗时/首字固定第一行，
 * 工具数/供应商目标/压缩/重试链/故障转移固定折到第二行，行分配不再随宽度与数据微变洗牌。
 */
function stepHasExtendedMeta(step: AgentStep, retryChainOrdinals: Map<string, number>): boolean {
  return step.toolUseIds.length > 0
    || Boolean(step.targetName)
    || Boolean(step.compactionRole)
    || retryChainOrdinals.has(step.id)
    || Boolean(step.failover);
}

const WORKBENCH_NODE_CACHE_CAPACITY = 8;
const SQLITE_PAGE_LIMIT = 50;
/** 自动下钻跳过空节点（0 Turn 的 Thread / 0 Step 的 Turn）时的有界回看翻页数上限。 */
const AUTO_DRILL_MAX_EXTRA_PAGES = 2;
const SQLITE_VERSION_POLL_MS = 2_000;
const RELATIVE_TIME_REFRESH_MS = 15_000;
const TREE_SEARCH_KEY = "tree-search";
const TREE_SEARCH_SESSION_LIMIT = 60;
const TREE_SEARCH_DEBOUNCE_MS = 300;
/** 会话树分页请求键：错误需在会话树底部可见（此前只写进错误表，无人渲染）。 */
const TREE_MORE_KEY = "tree:more";

/** 工作台浮动通知：信息/错误提示，错误附重试动作；自动消失定时见渲染处 effect。 */
interface WorkbenchNotice {
  kind: "info" | "error";
  message: string;
}

/** SQLite 工作台只持有当前可见路径和有界分页；ScopeSummary 内含“查看本 Thread”动作。 */
export function HarnessWorkbench({ tree, initialQuery, initialRange, retentionDays }: HarnessWorkbenchProps) {
  // 全站统一时区（右上角选择器）：时间展示按其换算；时间范围查询边界同样按它计算
  // （2026-09-17 全站时区统一，不再使用浏览器本地时区）。
  const globalTz = useGlobalTimeZone();
  const router = useRouter();
  const initialPath = useMemo(
    () => initialWorkbenchPath(tree, initialQuery),
    [initialQuery, tree],
  );
  // 时间范围（页面私有参数）：ref 供 URL 改写与树请求共用，state 驱动时间区块 UI。
  const initialWorkbenchRange = useMemo<WorkbenchRange>(() => {
    const fromQuery = parseOptionalWorkbenchRange(new URLSearchParams(initialQuery));
    if (fromQuery) return { start: fromQuery.start, end: fromQuery.end };
    return initialRange ?? defaultWorkbenchRange(new Date(), globalTz.offsetMinutes);
  }, [initialQuery, initialRange, globalTz.offsetMinutes]);
  /* URL 是否显式给过范围/用户是否改过：未touch且全局时区≠服务端缺省东八区时挂载后重算默认「今天」。 */
  const rangeExplicitRef = useRef(Boolean(parseOptionalWorkbenchRange(new URLSearchParams(initialQuery)) || initialRange));
  const rangeOffsetRef = useRef(globalTz.offsetMinutes);
  const rangeParamsRef = useRef<URLSearchParams | null>(null);
  if (rangeParamsRef.current === null) {
    const params = new URLSearchParams();
    appendWorkbenchRangeParams(params, initialWorkbenchRange);
    rangeParamsRef.current = params;
  }
  const [range, setRange] = useState<WorkbenchRange>(initialWorkbenchRange);
  const rangeClampedRef = useRef(false);
  const {
    selection,
    view,
    expandedThreadIds,
    setExpandedThreadIds,
    loading: selectionLoading,
    error: selectionError,
    retry: retrySelection,
    replaceSelection,
    setSelectionInMemory,
    clearSelection,
  } = useWorkbenchSelection({ initialQuery, initialPath, preservedParamsRef: rangeParamsRef });
  const [treePage, setTreePage] = useState(tree);
  const [expandedAgentIds, setExpandedAgentIds] = useState<Set<string>>(
    () => initialExpandedAgentIds(tree, initialPath),
  );
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(
    () => new Set(initialPath?.session ? [initialPath.session] : []),
  );
  const [rootPagesBySession, setRootPagesBySession] = useState<Map<string, BoundedPage<WorkbenchThreadNode>>>(
    () => new Map(),
  );
  const [turnPagesByThread, setTurnPagesByThread] = useState<Map<string, BoundedPage<WorkbenchTurnSummary>>>(
    () => new Map(),
  );
  const [stepPagesByTurn, setStepPagesByTurn] = useState<Map<string, WorkbenchTurnStepsPage>>(
    () => new Map(),
  );
  const [exchangeProjection, setExchangeProjection] = useState<ExchangeProjectionDetail>();
  const [previousExchangeProjection, setPreviousExchangeProjection] = useState<ExchangeProjectionDetail>();
  const [previousModelExchangeId, setPreviousModelExchangeId] = useState<string>();
  const [activeTab, setActiveTab] = useState<InspectorTab>(() =>
    // tab= 深链：外部跳转（交互内容/上下文/能力清单）直达目标页签。从服务端同源
    // 透传的 initialQuery 解析（page.tsx 会把 URL 的 tab 原样带上），保证 SSR 与
    // client 初值一致——此前用 typeof window 读 location 会导致 tab 深链
    // hydration mismatch（2026-09-21 修复）。
    inspectorTabFromParam(new URLSearchParams(initialQuery).get("tab")),
  );
  const [stepHarness, setStepHarness] = useState<ApiAgentStepHarness>();
  const [stepHarnessLoading, setStepHarnessLoading] = useState(false);
  // Harness 页签工具行 → 交互内容的下钻过滤（客户端过滤当前 step 范围条目）。
  const [interactionToolFilter, setInteractionToolFilter] = useState<string>();
  const [interactionCategoryFilter, setInteractionCategoryFilter] = useState<ConversationCategory[] | undefined>(undefined);
  // 「查看原文 →」的下钻过滤只属于触发它的那次交互内容浏览（2026-09-21）：
  // 切换 Step/Turn/Thread/Session 等任何锚点后立即清除，避免旧过滤一直
  // 污染后续打开的交互内容页签。查看原文本身不改变选中，不受此影响。
  useEffect(() => {
    setInteractionCategoryFilter(undefined);
    setInteractionToolFilter(undefined);
  }, [selection?.step, selection?.turn, selection?.thread, selection?.session]);
  const [snapshot, setSnapshot] = useState<WorkbenchContextSnapshot>();
  const [diff, setDiff] = useState<WorkbenchStepDiff>();
  const [selectedStepDetail, setSelectedStepDetail] = useState<AgentStep>();
  const [stepDetailLoading, setStepDetailLoading] = useState(false);
  const [stepDetailError, setStepDetailError] = useState("");
  const [highlightedEvidence, setHighlightedEvidence] = useState<EvidencePointer>();
  const [copied, setCopied] = useState("");
  const [columnCollapseState, setColumnCollapseState] = useState<ColumnCollapseState>({
    capture: false,
    turn: false,
    timeline: false,
  });
  const [columnSizeState, setColumnSizeState] = useState<ColumnSizeState>(defaultColumnSizes);
  const [dataVersion, setDataVersion] = useState(tree.dataVersion);
  // 选中行 → 目标面板的连接箭头几何（相对工作台容器，px）。undefined 表示不绘制。
  const [connectorStyles, setConnectorStyles] = useState<{
    turn?: { top: number; height: number; left: number; width: number };
    step?: { top: number; height: number; left: number; width: number };
  }>({});
  const [relativeNowMs, setRelativeNowMs] = useState(() => Date.now());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set());
  const [requestErrors, setRequestErrors] = useState<Map<string, string>>(() => new Map());
  const [refreshError, setRefreshError] = useState("");
  // 浮动提示（fixed 定位不占布局）：恢复选择的进度 pill 与一次性通知 toast，替代原内嵌状态区避免整页抖动。
  const [restoreProgressVisible, setRestoreProgressVisible] = useState(false);
  const [workbenchNotice, setWorkbenchNotice] = useState<WorkbenchNotice>();
  const backlogNoticeShownRef = useRef(false);
  // 会话树模糊搜索：空 query 表示未在搜索态（渲染常规树）。
  const [treeSearchInput, setTreeSearchInput] = useState("");
  const [treeSearchQuery, setTreeSearchQuery] = useState("");
  const [treeSearchResult, setTreeSearchResult] = useState<WorkbenchSessionSearchResult>();
  const [treeSearchError, setTreeSearchError] = useState("");
  const requestSequences = useRef(new Map<string, number>());
  const requestSequenceCounter = useRef(0);
  const requestControllers = useRef(new Map<string, AbortController>());
  const inFlightKeys = useRef(new Set<string>());
  const threadLoadPromises = useRef(new Map<string, Promise<BoundedPage<WorkbenchThreadNode> | undefined>>());
  const treeFilters = useRef(workbenchTreeFilters(initialQuery));
  const restoredPathKey = useRef("");
  const lastRefreshVersion = useRef(tree.dataVersion);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // 分层手动锁定：1=Session 锁定；2=Thread 锁定；3=Turn 锁定；4=Step 锁定；0=尚未点选。
  // 手动点选某层 => 该层及其全部上层锁定，未锁定的下层由点选后的一次性自动下钻落到最新。
  // （2026-09-29 用户确认）版本轮询不再触发任何自动跟随：锁定深度只约束点选时刻的下钻
  // 层级与 autoSelect*Latest 守卫，后台新数据到达后选中永不改写。
  const manualLockDepthRef = useRef(initialManualLockDepth(initialQuery));
  /**
   * 自动下钻调度：lastDrill 记录最近一次已执行的下钻范围（key=「session|thread」，nonce
   * 为手动点选序号、0 表示挂载/被动触发），effect 靠它去重；drillIntent 是手动点选留下的
   * 意图——keepUrl=true 表示 URL 已写到所点层级，下钻结果只更新内存不改写 URL
   * （2026-09-20 用户确认：点上层节点时链接裁剪下级参数）。drillInFlight 抑制下钻期间的
   * 重入（候选循环会中途更新内存选中，触发 effect 重跑）；释放后自增 drillTick 重跑一次，
   * 处理下钻期间到达的新意图。
   */
  const autoDrillNonceRef = useRef(0);
  const drillIntentRef = useRef<{ key: string; nonce: number; keepUrl: boolean } | undefined>(undefined);
  const lastDrillRef = useRef<{ key: string; nonce: number }>({ key: "", nonce: 0 });
  const drillInFlightRef = useRef(false);
  const [drillTick, setDrillTick] = useState(0);
  /** 自动下钻已确认空数据的范围（key 同上）：把「正在自动选择…」换成诚实空态文案。 */
  const [autoDrillExhausted, setAutoDrillExhausted] = useState("");

  const selectedGroup = useMemo(
    () => findSelectedAgentGroup(treePage, selection),
    [selection, treePage],
  );
  const selectedStepPage = selection?.turn
    ? stepPagesByTurn.get(selection.turn)
    : undefined;
  const selectedSteps = selectedStepPage?.steps || [];
  // 重试链（推断）：当前页内连续 error Step 且间隔 ≤120s，第 2 个起标注链序号。
  const retryChainOrdinals = computeRetryChainOrdinals(selectedSteps);
  const selectedStepSummary = selection?.step
    ? selectedSteps.find(step => step.id === selection.step)
    : undefined;
  const selectedStep = selectedStepDetail?.id === selection?.step
    ? selectedStepDetail
    : selectedStepSummary;
  const selectedSession = selectedGroup?.sessions.find(
    session => session.id === selection?.session,
  );
  const selectedTurn = selection?.thread && selection.turn
    ? turnPagesByThread.get(selection.thread)?.items.find(turn => turn.id === selection.turn)
    : undefined;
  // 当前选中 Thread 的节点（业务 Thread ID 从这里取）；未选中/未加载时缺省。
  const selectedThreadNode = useMemo(
    () => selection?.thread
      ? findThreadOwner(treePage, rootPagesBySession, selection.thread)?.node
      : undefined,
    [selection?.thread, treePage, rootPagesBySession],
  );
  const activeThreadPathIds = useMemo(() => new Set([
    ...(selection?.ancestorThreadIds || []),
    ...(selection?.thread ? [selection.thread] : []),
  ]), [selection?.ancestorThreadIds, selection?.thread]);
  const derivedStatus = workbenchDerivedStatus(treePage.derivedStatus) || "building";
  const scopeType: ScopeType = selection?.step ? "step" : view;
  const scopeId = scopeType === "session"
    ? selection?.session
    : scopeType === "thread"
      ? selection?.thread
      : scopeType === "turn" ? selection?.turn : selection?.step;
  const stepConversationQuery = useMemo(() => selection?.step
    ? buildExportConversationQuery({
        target: selection.target,
        agent: selection.agent,
        session: selection.session,
        thread: selection.thread,
        turn: selection.turn,
        step: selection.step,
        scope: "step",
        exchangeLimit: 2,
        pageMaxBytes: 32 * 1024 * 1024,
        // 「查看原文 →」的类别下钻不进查询串：scope=step 的列表候选被类别过滤
        // 只会滤成空页（如响应侧无 assistant 的 Step），类别过滤由 viewer 的
        // drillCategories prop 在展开详情条目层承担（2026-09-21 修复空态）。
      })
    : "", [
      selection?.target,
      selection?.agent,
      selection?.session,
      selection?.thread,
      selection?.turn,
      selection?.step,
      interactionCategoryFilter,
    ]);
  // tab= 深链直达「上下文」/「能力清单」页签时，选中 Step 后自动补拉数据（正常路径由 selectInspectorTab 触发）。
  // 2026-09-21 修复：此前只补拉了 Harness，「上下文」深链直达会停在"没有 Context Snapshot"空态。
  const harnessTabWanted = activeTab === "能力清单";
  const contextTabWanted = activeTab === "上下文";
  const selectedStepId = selectedStep?.id;
  useEffect(() => {
    if (contextTabWanted && selectedStep) {
      void loadStepWorkbenchDetail(selectedStep, { snapshot: true, diff: true });
    }
    if (!harnessTabWanted || !selectedStep) return;
    if (stepHarness?.stepId === selectedStep.id || stepHarnessLoading) return;
    void loadStepHarness(selectedStep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextTabWanted, harnessTabWanted, selectedStepId]);
  const workbenchColumnClassName = [
    "workbench",
    columnCollapseState.capture ? "capture-collapsed" : "",
    columnCollapseState.timeline ? "timeline-collapsed" : "",
    Object.values(columnCollapseState).some(Boolean) ? "inspector-expanded" : "",
  ].filter(Boolean).join(" ");
  const workbenchStyle = {
    "--capture-column-width": `${columnCollapseState.capture ? 0 : columnSizeState.capture || defaultColumnSizes.capture}px`,
    "--timeline-column-width": `${columnCollapseState.timeline ? 0 : columnSizeState.timeline || defaultColumnSizes.timeline}px`,
    "--inspector-column-width": `${columnSizeState.inspector || defaultColumnSizes.inspector}px`,
  } as React.CSSProperties;
  // 常驻状态条（派生就绪 · 自动更新）已移除：它对用户没有信息量，且每次自动刷新都会
  // 在「进行中 ↔ 就绪」之间跳一次，造成视觉抖动。只有真正的失败才提示，走浮层通知。
  const stepIssueMessage = stepDetailError
    ? `Step 详情加载失败：${stepDetailError}`
    : derivedStatus === "failed"
      ? "会话数据分析失败：请查看服务端日志。"
      : undefined;

  useEffect(() => () => {
    for (const controller of requestControllers.current.values()) controller.abort();
    requestControllers.current.clear();
    inFlightKeys.current.clear();
    threadLoadPromises.current.clear();
  }, []);

  useEffect(() => {
    if (!selection?.session) return;
    const pathKey = [
      selection.session,
      selection.thread,
      selection.turn,
      selection.step,
      ...(selection.ancestorThreadIds || []),
    ].join("|");
    if (restoredPathKey.current === pathKey) return;
    const group = findSelectedAgentGroup(treePage, selection);
    if (group) {
      setExpandedAgentIds(current => addToSet(current, agentGroupKey(group)));
    }
    // 只有恢复 Thread/Turn/Step 深链时自动展开 Session；Session 行点击后的折叠必须保留。
    if (selection.thread) {
      setExpandedSessionIds(current => addToSet(current, selection.session!));
    }
    void restoreSelectionPath(selection).then(restored => {
      if (restored) restoredPathKey.current = pathKey;
    });
  }, [selection, treePage]);

  // 自动下钻（2026-09-20 用户确认）：页面停在 Session/Thread 层级且未显式携带 Turn 深链时，
  // 跳过 0 Turn 的 Thread / 0 Step 的 Turn，自动落到该范围内最新有数据的 Turn/Step。
  // 挂载深链（如交互内容页 ?session= 跳转）与手动点选 Session/Thread 都由这里承接：
  // 成功后按 syncUrl 决定是否写回完整规范路径（手动点选 keepUrl=true 只更新内存，
  // URL 稳定停在所点层级，跳转交互内容时按该范围展示）。
  useEffect(() => {
    if (selectionLoading || !selection?.session) return;
    if (selection.step || view === "turn") return;
    // 显式 turn 深链（lock=3）忠实展示该 Turn（暂无 Step 时显示诚实空态），不擅自改选。
    if (manualLockDepthRef.current >= 3) return;
    // 下钻进行中不重入：候选循环会中途更新内存选中并触发本 effect。
    if (drillInFlightRef.current) return;
    const scopeKey = `${selection.session}|${selection.thread || ""}`;
    const intent = drillIntentRef.current;
    const nonce = intent?.key === scopeKey ? intent.nonce : 0;
    if (lastDrillRef.current.key === scopeKey && lastDrillRef.current.nonce === nonce) return;
    lastDrillRef.current = { key: scopeKey, nonce };
    setAutoDrillExhausted("");
    const syncUrl = !(intent?.keepUrl && intent.key === scopeKey);
    const group = findSelectedAgentGroup(treePage, selection);
    const sessionId = selection.session;
    const drillThreadId = selection.thread;
    drillInFlightRef.current = true;
    void (async () => {
      try {
        const ok = drillThreadId
          ? await autoSelectThreadLatest(drillThreadId, {
              target: selection.target,
              agent: selection.agent,
              session: sessionId,
              thread: drillThreadId,
              ancestorThreadIds: selection.ancestorThreadIds,
            }, { syncUrl })
          : await autoSelectSessionLatest(sessionId, {
              agentName: group?.agentName || selection.agent || "",
            }, { syncUrl });
        if (!ok && !selectionRef.current?.step) setAutoDrillExhausted(scopeKey);
      } finally {
        drillInFlightRef.current = false;
        // 释放抑制后重跑一次：处理下钻期间到达的新点选意图（其 scopeKey 与 lastDrill 不同）。
        setDrillTick(value => value + 1);
      }
    })();
  }, [selection, view, selectionLoading, treePage, drillTick]);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    async function pollVersion() {
      if (stopped || polling) return;
      polling = true;
      try {
        const response = await fetch("/api/workbench-version", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const version = parseSqliteWorkbenchVersion(await response.json());
        if (!version) throw new Error("版本响应格式无效");
        setRefreshError("");
        setDataVersion(version.dataVersion);
      } catch (error) {
        if (!stopped) setRefreshError(errorMessage(error, "实时刷新失败"));
      } finally {
        polling = false;
      }
    }
    const timer = window.setInterval(() => void pollVersion(), SQLITE_VERSION_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    function refreshRelativeNow() {
      if (!stopped && !document.hidden) setRelativeNowMs(Date.now());
    }
    const timer = window.setInterval(refreshRelativeNow, RELATIVE_TIME_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshRelativeNow);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshRelativeNow);
    };
  }, []);

  useEffect(() => {
    if (dataVersion === lastRefreshVersion.current) return;
    // 短时间内多次版本变化合并为一次刷新，减少整页重排与总览闪烁。
    const timer = window.setTimeout(() => {
      lastRefreshVersion.current = dataVersion;
      void (async () => {
        await refreshCurrentTree();
        const current = selectionRef.current;
        if (!current?.session) {
          retrySelection();
          return;
        }
        // 轮询只做静默刷新（2026-09-29 用户确认，取代分层自动跟随）：任何锁定深度都
        // 不改写选中——第一栏照常重排/更新时间，同一 Turn 新增 Step 正常出现在第二栏，
        // 但当前选中的 Step 与第三栏内容（含全屏查看）保持不变。选中只由用户点选与
        // 点选后的一次性自动下钻决定，后台版本变化永不劫持查看焦点。
        if (current?.turn) void loadSteps(current.turn, undefined, true);
        if (current?.step) void loadStepRecord(current.step);
      })();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [dataVersion]);

  useEffect(() => {
    const plan = overviewEvidencePlan({
      active: activeTab === "总览",
      step: selectedStep,
      turnSteps: selectedSteps,
      loadedCurrentExchangeId: exchangeProjection?.exchangeId,
      loadedPreviousExchangeId: previousExchangeProjection?.exchangeId,
      previousModelExchangeId,
    });
    if (plan.current) {
      void loadProjection(plan.current.exchangeId, plan.current.stepId);
    }
    if (plan.previous && selectedStep) {
      void loadPreviousProjection(plan.previous, selectedStep.id);
    }
  }, [
    activeTab,
    selectedStep?.id,
    selectedStep?.exchangeId,
    selectedStep?.turnId,
    selectedStep?.index,
    selectedStepPage,
    exchangeProjection?.exchangeId,
    previousExchangeProjection?.exchangeId,
    previousModelExchangeId,
  ]);

  // 会话树搜索：输入防抖 300ms；清空即退出搜索态并中止在途请求。
  useEffect(() => {
    const query = treeSearchInput.trim();
    if (!query) {
      cancelTreeSearch();
      setTreeSearchQuery("");
      setTreeSearchResult(undefined);
      setTreeSearchError("");
      return undefined;
    }
    const timer = window.setTimeout(() => void runTreeSearch(query), 300);
    return () => window.clearTimeout(timer);
  }, [treeSearchInput]);

  function cancelTreeSearch(): void {
    requestControllers.current.get(TREE_SEARCH_KEY)?.abort();
    inFlightKeys.current.delete(TREE_SEARCH_KEY);
    setLoadingKeys(current => withoutSetValue(current, TREE_SEARCH_KEY));
  }

  async function runTreeSearch(query: string): Promise<void> {
    const request = beginRequest(TREE_SEARCH_KEY, true);
    if (!request) return;
    try {
      const response = await fetch(workbenchSessionSearchRequestUrl(query, {
        limit: TREE_SEARCH_SESSION_LIMIT,
        start: treeFilters.current.get("start") || undefined,
        end: treeFilters.current.get("end") || undefined,
      }), { cache: "no-store", signal: request.controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = parseWorkbenchSessionSearchResult(await response.json(), query);
      if (!result) throw new Error("搜索响应格式无效");
      if (!requestIsCurrent(TREE_SEARCH_KEY, request.sequence)) return;
      setTreeSearchQuery(query);
      setTreeSearchResult(result);
      setTreeSearchError("");
      completeRequest(TREE_SEARCH_KEY, request.sequence);
    } catch (error) {
      if (!request.controller.signal.aborted && requestIsCurrent(TREE_SEARCH_KEY, request.sequence)) {
        setTreeSearchError(errorMessage(error, "会话搜索失败"));
        failRequest(TREE_SEARCH_KEY, request.sequence, error);
      }
    }
  }

  /** 时间范围变化：同步 URL / 树请求参数，并整体重载会话树第一页。 */
  function handleRangeChange(next: WorkbenchRange): void {
    rangeExplicitRef.current = true;
    const normalized = normalizeWorkbenchRange(next.start, next.end);
    if (!normalized) return;
    const nextRange: WorkbenchRange = { start: normalized.start, end: normalized.end };
    setRange(nextRange);
    const preserved = rangeParamsRef.current ?? new URLSearchParams();
    appendWorkbenchRangeParams(preserved, nextRange);
    rangeParamsRef.current = preserved;
    for (const key of ["start", "end"] as const) treeFilters.current.set(key, nextRange[key]);
    const urlParams = canonicalWorkbenchParams(selectionRef.current ?? {}, view);
    appendWorkbenchRangeParams(urlParams, nextRange);
    router.replace(`/sessions?${urlParams}`, { scroll: false });
    void reloadTree();
  }

  /**
   * 重置按钮全量复位（2026-09-23 用户确认）：时间恢复默认「今天」（按全局时区），
   * 选择/展开/下钻缓存/树搜索/页签/证据高亮全部清空，URL 归位为不带任何查询参数的
   * /sessions。rangeExplicitRef 复位 false，保留「时区变化时未自定义范围跟随重算」
   * 的既有行为。
   */
  function handleFullReset(): void {
    const defaultRange = defaultWorkbenchRange(new Date(), globalTz.offsetMinutes);
    setRange(defaultRange);
    rangeExplicitRef.current = false;
    rangeClampedRef.current = false;
    const preserved = new URLSearchParams();
    appendWorkbenchRangeParams(preserved, defaultRange);
    rangeParamsRef.current = preserved;
    for (const key of ["start", "end"] as const) treeFilters.current.set(key, defaultRange[key]);
    manualLockDepthRef.current = 0;
    restoredPathKey.current = "";
    setExpandedAgentIds(new Set());
    setExpandedSessionIds(new Set());
    setRootPagesBySession(new Map());
    setTurnPagesByThread(new Map());
    setStepPagesByTurn(new Map());
    setTreeSearchInput("");
    setTreeSearchQuery("");
    setTreeSearchResult(undefined);
    setTreeSearchError("");
    setActiveTab(inspectorTabFromParam(null));
    setInteractionToolFilter(undefined);
    setInteractionCategoryFilter(undefined);
    setExchangeProjection(undefined);
    setPreviousExchangeProjection(undefined);
    setPreviousModelExchangeId(undefined);
    setSnapshot(undefined);
    setDiff(undefined);
    setSelectedStepDetail(undefined);
    setStepDetailLoading(false);
    setStepDetailError("");
    setStepHarness(undefined);
    setHighlightedEvidence(undefined);
    setConnectorStyles({});
    // 清选择并把默认「今天」范围注入恢复请求：立即按裸加载语义自动跟随最新
    // session → thread → turn → step（与首次打开 /sessions 一致）。
    clearSelection(defaultRange);
    void reloadTree();
  }

  // 全局时区变化时，未自定义范围（仍是默认「今天」）的场景跟随新时区重算日界并刷新；
  // 用户显式选择过的范围是绝对时间，保持不动，仅展示换算。
  const rangeTzOffset = globalTz.offsetMinutes;
  const currentRange = range;
  useEffect(() => {
    if (rangeOffsetRef.current === rangeTzOffset) return;
    const previousOffset = rangeOffsetRef.current;
    rangeOffsetRef.current = rangeTzOffset;
    if (rangeExplicitRef.current) return;
    const previousDefault = defaultWorkbenchRange(new Date(), previousOffset);
    if (currentRange.start !== previousDefault.start || currentRange.end !== previousDefault.end) return;
    handleRangeChange(defaultWorkbenchRange(new Date(), rangeTzOffset));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeTzOffset]);

  function beginRequest(
    key: string,
    supersede = false,
  ): { controller: AbortController; sequence: number } | undefined {
    if (inFlightKeys.current.has(key) && !supersede) return undefined;
    if (supersede) {
      requestControllers.current.get(key)?.abort();
      inFlightKeys.current.delete(key);
    }
    const sequence = ++requestSequenceCounter.current;
    requestSequences.current.set(key, sequence);
    requestControllers.current.get(key)?.abort();
    const controller = new AbortController();
    requestControllers.current.set(key, controller);
    inFlightKeys.current.add(key);
    setLoadingKeys(current => addToSet(current, key));
    setRequestErrors(current => withoutMapKey(current, key));
    return { controller, sequence };
  }

  function requestIsCurrent(key: string, sequence: number): boolean {
    return requestSequences.current.get(key) === sequence;
  }

  function completeRequest(key: string, sequence: number): void {
    if (!requestIsCurrent(key, sequence)) return;
    requestControllers.current.delete(key);
    inFlightKeys.current.delete(key);
    requestSequences.current.delete(key);
    setLoadingKeys(current => withoutSetValue(current, key));
  }

  function failRequest(key: string, sequence: number, error: unknown): void {
    if (!requestIsCurrent(key, sequence)) return;
    setRequestErrors(current => retainRecentPages(
      touchMapValue(current, key, errorMessage(error, "查询失败")),
      undefined,
      32,
    ));
    completeRequest(key, sequence);
  }

  function loadThreads(
    sessionId: string,
    parentThreadId?: string,
    cursor?: string,
    replace = !cursor,
  ): Promise<BoundedPage<WorkbenchThreadNode> | undefined> {
    const key = threadRequestKey(sessionId, parentThreadId);
    const existingRequest = threadLoadPromises.current.get(key);
    if (existingRequest) return existingRequest;
    const requestPromise = loadThreadsRequest(sessionId, parentThreadId, cursor, replace, key);
    threadLoadPromises.current.set(key, requestPromise);
    requestPromise.then(
      () => {
        if (threadLoadPromises.current.get(key) === requestPromise) threadLoadPromises.current.delete(key);
      },
      () => {
        if (threadLoadPromises.current.get(key) === requestPromise) threadLoadPromises.current.delete(key);
      },
    );
    return requestPromise;
  }

  async function loadThreadsRequest(
    sessionId: string,
    parentThreadId?: string,
    cursor?: string,
    replace = !cursor,
    key = threadRequestKey(sessionId, parentThreadId),
  ): Promise<BoundedPage<WorkbenchThreadNode> | undefined> {
    const request = beginRequest(key);
    if (!request) return undefined;
    const params = new URLSearchParams({ limit: String(SQLITE_PAGE_LIMIT) });
    if (parentThreadId) params.set("parent", parentThreadId);
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch(
        `/api/agent-sessions/${encodeURIComponent(sessionId)}/threads?${params}`,
        { cache: "no-store", signal: request.controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseThreadPage(await response.json());
      if (!page) throw new Error("Thread 分页响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return undefined;
      setRootPagesBySession(current => {
        const merged = mergeThreadPageIntoSession(
          current,
          sessionId,
          parentThreadId,
          page,
          replace,
        );
        return retainRecentPages(
          merged,
          selectionRef.current?.session,
          WORKBENCH_NODE_CACHE_CAPACITY,
        );
      });
      completeRequest(key, request.sequence);
      return page;
    } catch (error) {
      if (!request.controller.signal.aborted) failRequest(key, request.sequence, error);
      return undefined;
    }
  }

  async function loadTurns(
    threadId: string,
    cursor?: string,
    replace = !cursor,
  ): Promise<BoundedPage<WorkbenchTurnSummary> | undefined> {
    const key = `turns:${threadId}`;
    const request = beginRequest(key);
    if (!request) return undefined;
    const params = new URLSearchParams({ limit: String(SQLITE_PAGE_LIMIT) });
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch(
        `/api/agent-threads/${encodeURIComponent(threadId)}/turns?${params}`,
        { cache: "no-store", signal: request.controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseTurnPage(await response.json());
      if (!page) throw new Error("Turn 分页响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return undefined;
      setTurnPagesByThread(current => {
        const previous = current.get(threadId);
        const nextPage = replace || !previous ? page : mergeBoundedPage(previous, page);
        const next = touchMapValue(current, threadId, nextPage);
        return retainRecentPages(
          next,
          selectionRef.current?.thread,
          WORKBENCH_NODE_CACHE_CAPACITY,
        );
      });
      completeRequest(key, request.sequence);
      return page;
    } catch (error) {
      if (!request.controller.signal.aborted) failRequest(key, request.sequence, error);
      return undefined;
    }
  }

  async function loadSteps(
    turnId: string,
    cursor?: string,
    replace = !cursor,
  ): Promise<WorkbenchTurnStepsPage | undefined> {
    const key = `steps:${turnId}`;
    const request = beginRequest(key);
    if (!request) return undefined;
    try {
      const response = await fetch(turnStepsPageRequestUrl(turnId, {
        limit: SQLITE_PAGE_LIMIT,
        cursor,
      }), { cache: "no-store", signal: request.controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseWorkbenchTurnStepsPage(await response.json());
      if (!page) throw new Error("Step 分页响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return undefined;
      setStepPagesByTurn(current => {
        const previous = current.get(turnId);
        // 整页替换但内容未变时保持原引用：版本轮询会反复重拉当前 Turn 的
        // Step 列表，引用不变可避免时间线无意义重渲染（防闪烁，同上）。
        const nextPage = replace || !previous
          ? (previous && stableJsonSignature(previous) === stableJsonSignature(page)
            ? previous
            : page)
          : mergeWorkbenchTurnStepsPage(previous, page);
        const next = touchMapValue(current, turnId, nextPage);
        return retainRecentPages(
          next,
          selectionRef.current?.turn,
          WORKBENCH_NODE_CACHE_CAPACITY,
        );
      });
      completeRequest(key, request.sequence);
      return page;
    } catch (error) {
      if (!request.controller.signal.aborted) failRequest(key, request.sequence, error);
      return undefined;
    }
  }

  async function loadStepRecord(stepId: string): Promise<AgentStep | undefined> {
    const key = "step-record:current";
    const request = beginRequest(key, true);
    if (!request) return undefined;
    setStepDetailLoading(true);
    setStepDetailError("");
    try {
      const response = await fetch(`/api/agent-steps/${encodeURIComponent(stepId)}`, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = parseWorkbenchStepDetailResponse(await response.json());
      if (!detail) throw new Error("Step 详情响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return undefined;
      if (selectionRef.current?.step !== stepId) {
        completeRequest(key, request.sequence);
        return undefined;
      }
      // 内容与当前展示一致时保持原引用，避免无意义重渲染造成闪烁。
      setSelectedStepDetail(current => current && stableJsonSignature(current) === stableJsonSignature(detail.step)
        ? current
        : detail.step);
      completeRequest(key, request.sequence);
      setStepDetailLoading(false);
      return detail.step;
    } catch (error) {
      if (!request.controller.signal.aborted && requestIsCurrent(key, request.sequence)) {
        setStepDetailError(errorMessage(error, "Step 详情加载失败"));
        setStepDetailLoading(false);
        failRequest(key, request.sequence, error);
      }
      return undefined;
    }
  }

  async function restoreSelectionPath(path: WorkbenchClientSelection): Promise<boolean> {
    if (!path.session) return false;
    const rootPage = await loadThreads(path.session, undefined, undefined, true);
    if (!rootPage) return false;
    if (!path.thread) return true;
    const hierarchy = [...(path.ancestorThreadIds || []), path.thread];
    for (const parentThreadId of hierarchy) {
      await loadThreads(path.session, parentThreadId, undefined, true);
    }
    if (path.thread) await loadTurns(path.thread, undefined, true);
    if (path.turn) {
      const stepPage = await loadSteps(path.turn, undefined, true);
      // turn 深链未带 step 时自动落到该 Turn 最新 Step（2026-09-21：交互内容页
      // 「会话追踪」动线）；Turn 内确无 Step 时保持诚实空态。仅当用户仍停留在
      // 该 Turn（未被手动改选）时生效，不写 URL（保持深链原貌）。
      if (path.turn === selectionRef.current?.turn && !selectionRef.current?.step) {
        const latest = stepPage?.steps[0];
        if (latest) applyStepSelection(latest, { syncUrl: false });
      }
    }
    if (path.step) {
      await loadStepRecord(path.step);
    }
    return true;
  }

  async function refreshHierarchyPaths(
    paths: Array<WorkbenchClientSelection | undefined>,
  ): Promise<void> {
    const plan = hierarchyRefreshPlan(paths);
    for (const sessionId of plan.sessionIds) {
      await loadThreads(sessionId, undefined, undefined, true);
    }
    for (const childPage of plan.childPages) {
      await loadThreads(
        childPage.sessionId,
        childPage.parentThreadId,
        undefined,
        true,
      );
    }
    for (const threadId of plan.turnThreadIds) {
      await loadTurns(threadId, undefined, true);
    }
  }

  async function refreshCurrentTree(): Promise<void> {
    const key = "tree:refresh";
    const request = beginRequest(key);
    if (!request) return;
    const params = new URLSearchParams(treeFilters.current);
    params.set("limit", String(SQLITE_PAGE_LIMIT));
    const current = selectionRef.current;
    try {
      const response = await fetch(`/api/workbench-tree?${params}`, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseWorkbenchTreePage(await response.json());
      if (!page) throw new Error("会话树响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return;
      // 内容与当前展示一致时保持原引用（与 step 详情同一防闪烁模式）：
      // 版本轮询期间 tree 数据未变的刷新不再触发整棵树重渲染抖动。
      setTreePage(currentPage => {
        const next = refreshWorkbenchTreePage(
          currentPage,
          page,
          current?.session,
        );
        return stableJsonSignature(currentPage) === stableJsonSignature(next)
          ? currentPage
          : next;
      });
      completeRequest(key, request.sequence);
      setRefreshError("");
      await refreshHierarchyPaths([current, page.latestPath]);
    } catch (error) {
      if (!request.controller.signal.aborted) {
        setRefreshError(errorMessage(error, "会话树刷新失败"));
        failRequest(key, request.sequence, error);
      }
    }
  }

  /** 时间范围切换后的整体重载：直接用新的第一页替换当前树（非合并刷新）。 */
  async function reloadTree(): Promise<void> {
    const key = "tree:reload";
    const request = beginRequest(key, true);
    if (!request) return;
    const params = new URLSearchParams(treeFilters.current);
    params.set("limit", String(SQLITE_PAGE_LIMIT));
    try {
      const response = await fetch(`/api/workbench-tree?${params}`, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseWorkbenchTreePage(await response.json());
      if (!page) throw new Error("会话树响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return;
      setTreePage(page);
      completeRequest(key, request.sequence);
      setRefreshError("");
    } catch (error) {
      if (!request.controller.signal.aborted) {
        setRefreshError(errorMessage(error, "会话树刷新失败"));
        failRequest(key, request.sequence, error);
      }
    }
  }

  /**
   * Session 级自动下钻：跳过 0 Turn 的根 Thread（如正在思考中的新会话），从最新分页起
   * 逐个候选下钻到有 Step 的 Turn；Thread 已锁定时不动作。
   * 返回是否成功落到 Step 数据，供自动下钻空态判断使用。
   */
  async function autoSelectSessionLatest(
    sessionId: string,
    group: { agentName: string },
    options: { syncUrl?: boolean } = {},
  ): Promise<boolean> {
    let cursor: string | undefined;
    for (let page = 0; page <= AUTO_DRILL_MAX_EXTRA_PAGES; page += 1) {
      const rootPage = await loadThreads(sessionId, undefined, cursor, !cursor);
      if (manualLockDepthRef.current >= 2 || selectionRef.current?.session !== sessionId) return false;
      const base: WorkbenchClientSelection = {
        agent: group.agentName,
        session: sessionId,
        ancestorThreadIds: [],
      };
      if (rootPage) {
        for (const thread of rootPage.items) {
          if (!thread.turnCount) continue;
          // 写内存选中前同步复查锁深度：手动点选会同步置锁，此处让位可避免覆盖用户刚点选的 Thread。
          if (manualLockDepthRef.current >= 2 || selectionRef.current?.session !== sessionId) return false;
          // session 视图下内存选中不含 thread（selectionAtView 按 view 剥离），先同步写入
          // 内存选中（不写 URL），否则 autoSelectThreadLatest 的「用户已改选其它 Thread」
          // 守卫会因 selection.thread 为空或过期而误判提前返回。
          const threadSelection: WorkbenchClientSelection = { ...base, thread: thread.id };
          setSelectionInMemory(threadSelection, "thread");
          if (await autoSelectThreadLatest(thread.id, base, options)) return true;
        }
      }
      if (!rootPage?.hasMore || !rootPage.nextCursor) break;
      cursor = rootPage.nextCursor;
    }
    // 候选耗尽仍无数据：退回 Session 层级，避免内存选中停留在最后一个空候选 Thread 上。
    if (selectionRef.current?.session === sessionId) {
      setSelectionInMemory({ agent: group.agentName, session: sessionId }, "session");
    }
    return false;
  }

  /**
   * Thread 级自动下钻：跳过 0 Step 的 Turn（如正在思考中的空 Turn），从最新分页起选
   * 第一个有数据的 Turn 及其最新 Step；Turn 已锁定时不动作；选中无变化时不重复写路径。
   * 返回是否成功落到 Step 数据，供 Session 级候选回退与自动下钻空态判断使用。
   */
  async function autoSelectThreadLatest(
    threadId: string,
    base: WorkbenchClientSelection,
    options: { syncUrl?: boolean } = {},
  ): Promise<boolean> {
    const latestTurn = await findLatestTurnWithSteps(threadId);
    if (!latestTurn) return false;
    if (manualLockDepthRef.current >= 3 || selectionRef.current?.thread !== threadId) return false;
    const stepPage = await loadSteps(latestTurn.id, undefined, true);
    if (manualLockDepthRef.current >= 3 || selectionRef.current?.thread !== threadId) return false;
    const latestStep = stepPage?.steps[0];
    const current = selectionRef.current;
    if (current?.turn === latestTurn.id && current?.step === (latestStep?.id || undefined)) return true;
    const nextPath = {
      ...base,
      thread: threadId,
      turn: latestTurn.id,
      step: latestStep?.id,
    };
    if (options.syncUrl === false) {
      setSelectionInMemory(nextPath, "turn");
    } else {
      replaceSelection(nextPath, "turn");
    }
    if (latestStep) void loadStepRecord(latestStep.id);
    return true;
  }

  /** 有界回看找最新有数据的 Turn：按 step_count 物化列过滤，最多再翻 AUTO_DRILL_MAX_EXTRA_PAGES 页。 */
  async function findLatestTurnWithSteps(
    threadId: string,
  ): Promise<WorkbenchTurnSummary | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page <= AUTO_DRILL_MAX_EXTRA_PAGES; page += 1) {
      const turnPage = await loadTurns(threadId, cursor, !cursor);
      if (!turnPage) return undefined;
      const candidate = turnPage.items.find(turn => turn.stepCount > 0);
      if (candidate) return candidate;
      if (!turnPage.hasMore || !turnPage.nextCursor) return undefined;
      cursor = turnPage.nextCursor;
    }
    return undefined;
  }

  /* 版本轮询触发的分层自动跟随（跟随最新 Thread/Turn/Step 的两个入口函数）
     已于 2026-09-29 用户确认整体移除：后台轮询只静默刷新缓存，选中永不自动推进，
     避免「正在查看的 Step / 第三栏内容（含全屏）被新数据拉走」。一次性自动下钻
     （挂载深链与手动点选 Session/Thread 后的 autoSelect*Latest）仍保留。 */

  async function loadProjection(
    exchangeId: string,
    expectedStepId = selectionRef.current?.step,
  ): Promise<void> {
    const key = "projection:current";
    const request = beginRequest(key, true);
    if (!request) return;
    try {
      const response = await fetch(`/api/exchanges/${encodeURIComponent(exchangeId)}`, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = parseExchangeProjectionResponse(await response.json(), exchangeId);
      if (!payload) throw new Error("交互内容响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return;
      if (selectionRef.current?.step !== expectedStepId) {
        completeRequest(key, request.sequence);
        return;
      }
      setExchangeProjection(current => current && stableJsonSignature(current) === stableJsonSignature(payload.projection)
        ? current
        : payload.projection);
      setPreviousModelExchangeId(current => current === payload.previousModelExchangeId
        ? current
        : payload.previousModelExchangeId);
      completeRequest(key, request.sequence);
    } catch (error) {
      if (!request.controller.signal.aborted && requestIsCurrent(key, request.sequence)) {
        failRequest(key, request.sequence, error);
      }
    }
  }

  async function loadPreviousProjection(
    previous: { exchangeId: string },
    expectedStepId = selectionRef.current?.step,
  ): Promise<void> {
    const key = "projection:previous";
    const request = beginRequest(key, true);
    if (!request) return;
    try {
      const projection = await fetchExchangeProjection(
        previous.exchangeId,
        request.controller.signal,
      );
      if (!requestIsCurrent(key, request.sequence)) return;
      if (selectionRef.current?.step !== expectedStepId) {
        completeRequest(key, request.sequence);
        return;
      }
      setPreviousExchangeProjection(current => current && stableJsonSignature(current) === stableJsonSignature(projection)
        ? current
        : projection);
      completeRequest(key, request.sequence);
    } catch (error) {
      if (!request.controller.signal.aborted) failRequest(key, request.sequence, error);
    }
  }

  async function loadStepWorkbenchDetail(
    step: AgentStep | undefined,
    options: { snapshot?: boolean; diff?: boolean },
  ): Promise<void> {
    if (!step) return;
    const needsSnapshot = !!options.snapshot && snapshot?.stepId !== step.id;
    const needsDiff = !!options.diff && diff?.toStepId !== step.id;
    if (!needsSnapshot && !needsDiff) return;
    const key = "step-detail:current";
    const request = beginRequest(key, true);
    if (!request) return;
    setStepDetailLoading(true);
    setStepDetailError("");
    try {
      const snapshotState = needsSnapshot
        ? await fetchOptionalStepContextSnapshot(step.id, step.turnId)
        : undefined;
      const diffState = needsDiff
        ? await fetchOptionalStepDiff(step.id, step.turnId)
        : undefined;
      if (!requestIsCurrent(key, request.sequence)) return;
      if (selectionRef.current?.step !== step.id) {
        completeRequest(key, request.sequence);
        return;
      }
      if (snapshotState) setSnapshot(snapshotState.snapshot);
      if (diffState) setDiff(diffState.diff);
      completeRequest(key, request.sequence);
      setStepDetailLoading(false);
    } catch (error) {
      if (!request.controller.signal.aborted && requestIsCurrent(key, request.sequence)) {
        setStepDetailError(errorMessage(error, "Step 详情加载失败"));
        setStepDetailLoading(false);
        failRequest(key, request.sequence, error);
      }
    }
  }

  function selectInspectorTab(tab: InspectorTab): void {
    setActiveTab(tab);
    syncTabParam(tab);
    // 「查看原文 →」的下钻过滤只属于触发它的那次浏览：离开「交互内容」页签
    // 即清除，之后回到该页签恢复默认「本步新增」（2026-09-21）。
    if (tab !== "交互内容" && (interactionCategoryFilter?.length || interactionToolFilter)) {
      setInteractionCategoryFilter(undefined);
      setInteractionToolFilter(undefined);
    }
    if (tab === "上下文") {
      void loadStepWorkbenchDetail(selectedStep, { snapshot: true, diff: true });
    }
    if (tab === "能力清单") {
      void loadStepWorkbenchDetail(selectedStep, { snapshot: true, diff: true });
      void loadStepHarness(selectedStep);
    }
  }

  /** tab= 深链写回：replaceState 不触发路由刷新，不影响其它查询参数。 */
  function syncTabParam(tab: InspectorTab): void {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      const param = inspectorTabParam(tab);
      if (param) {
        url.searchParams.set("tab", param);
      } else {
        url.searchParams.delete("tab");
      }
      window.history.replaceState(null, "", url.toString());
    } catch {
      // URL 解析失败只丢失深链写回，不影响页签切换。
    }
  }

  async function loadStepHarness(step: AgentStep | undefined): Promise<void> {
    if (!step) return;
    setStepHarnessLoading(true);
    try {
      const harness = await fetchOptionalStepHarness(step.id);
      setStepHarness(harness);
    } catch {
      setStepHarness(undefined);
    } finally {
      setStepHarnessLoading(false);
    }
  }

  function focusEvidencePath(evidence: EvidencePointer): void {
    setHighlightedEvidence(evidence);
    setActiveTab(evidence.side === "response" || evidence.side === "stream" ? "响应" : "请求");
  }

  function copyPromptTemplate(): void {
    void copyText("prompt", {
      model: snapshot?.model,
      systemPrompts: snapshot?.harnessSummary.systemPrompts.map(item => ({
        textHash: item.textHash,
        textPreview: item.textPreview,
        evidenceCount: item.evidenceCount,
      })),
      conversationItemCount: snapshot?.harnessSummary.conversationItemCount,
      paramsHash: snapshot?.paramsHash,
    });
  }

  function copyToolSchemaSummary(): void {
    void copyText("tools", {
      toolSchemaCount: snapshot?.harnessSummary.toolSchemaCount || 0,
      toolSchemaHashes: snapshot?.toolSchemaHashes || [],
      requestedToolUses: snapshot?.harnessSummary.requestedToolUses || [],
    });
  }

  function copyContextSnapshot(): void {
    void copyText("context", snapshot || {});
  }

  function toggleAgent(groupId: string): void {
    setExpandedAgentIds(current => toggleExpandedId(current, groupId));
  }

  function toggleSession(sessionId: string): void {
    const opening = !expandedSessionIds.has(sessionId);
    setExpandedSessionIds(current => toggleExpandedId(current, sessionId));
    if (opening && !rootPagesBySession.has(sessionId)) {
      void loadThreads(sessionId);
    }
  }

  function toggleThread(threadId: string): void {
    const opening = !expandedThreadIds.has(threadId);
    setExpandedThreadIds(current => toggleExpandedId(current, threadId));
    if (!opening) return;
    const owner = findThreadOwner(treePage, rootPagesBySession, threadId);
    if (owner?.node.childCount && !owner.node.childPage) {
      void loadThreads(owner.session.id, threadId);
    }
    if (owner?.node.turnCount && !turnPagesByThread.has(threadId)) {
      void loadTurns(threadId);
    }
  }

  /** 搜索结果里的 Session 点选：锁定 Session 层，主树同步展开并预取路径。 */
  function selectSessionFromSearch(
    group: WorkbenchSessionSearchGroup,
    sessionId: string,
  ): void {
    manualLockDepthRef.current = 1;
    const base: WorkbenchClientSelection = {
      agent: group.agentName,
      session: sessionId,
    };
    replaceSelection(base, "session");
    setExpandedAgentIds(current => addToSet(current, searchGroupKey(group)));
    setExpandedSessionIds(current => addToSet(current, sessionId));
    void restoreSelectionPath(base);
    // URL 已写到 Session 层级；下钻到最新数据由自动下钻 effect 承接（只更新内存）。
    autoDrillNonceRef.current += 1;
    drillIntentRef.current = { key: `${sessionId}|`, nonce: autoDrillNonceRef.current, keepUrl: true };
  }

  /** 搜索结果里的 Thread 点选：锁定 Thread 层，Turn/Step 自动下钻。 */
  function selectThreadFromSearch(
    group: WorkbenchSessionSearchGroup,
    sessionId: string,
    threadId: string,
  ): void {
    manualLockDepthRef.current = 2;
    const base: WorkbenchClientSelection = {
      agent: group.agentName,
      session: sessionId,
      thread: threadId,
      ancestorThreadIds: [],
    };
    replaceSelection(base, "thread");
    setExpandedAgentIds(current => addToSet(current, searchGroupKey(group)));
    setExpandedSessionIds(current => addToSet(current, sessionId));
    setExpandedThreadIds(current => addToSet(current, threadId));
    void restoreSelectionPath(base);
    // URL 只写到 Thread 层级（turn/step 裁剪）；下钻由自动下钻 effect 承接（只更新内存）。
    autoDrillNonceRef.current += 1;
    drillIntentRef.current = {
      key: `${sessionId}|${threadId}`,
      nonce: autoDrillNonceRef.current,
      keepUrl: true,
    };
  }

  /** 搜索结果里的 Turn 点选（主入口）：锁定 Turn 层，右栏加载该 Turn 的 Step 列表。 */
  function selectTurnFromSearch(
    group: WorkbenchSessionSearchGroup,
    sessionId: string,
    threadId: string,
    turnId: string,
  ): void {
    manualLockDepthRef.current = 3;
    const base: WorkbenchClientSelection = {
      agent: group.agentName,
      session: sessionId,
      thread: threadId,
      turn: turnId,
      ancestorThreadIds: [],
    };
    // URL 一次性写到 Turn 层级（不携带 step）；补选的最新 Step 只更新内存，不再二次改写 URL。
    replaceSelection(base, "turn");
    setExpandedAgentIds(current => addToSet(current, searchGroupKey(group)));
    setExpandedSessionIds(current => addToSet(current, sessionId));
    setExpandedThreadIds(current => addToSet(current, threadId));
    void restoreSelectionPath(base);
    void (async () => {
      const stepPage = await loadSteps(turnId, undefined, true);
      if (manualLockDepthRef.current !== 3 || selectionRef.current?.turn !== turnId) return;
      const latestStep = stepPage?.steps[0];
      if (latestStep) {
        setSelectionInMemory({ ...base, step: latestStep.id }, "turn");
        void loadStepRecord(latestStep.id);
      }
    })();
  }

  function selectSession(
    group: WorkbenchTreePage["agents"][number],
    sessionId: string,
  ): void {
    const opening = !expandedSessionIds.has(sessionId);
    const alreadySelected = selectionRef.current?.session === sessionId;
    toggleSession(sessionId);
    if (alreadySelected && !opening) {
      // 再次点击已选且展开的 Session：仅折叠会话树。不重置内存选中（重置却不重新
      // 下钻会让中栏停在「正在自动选择最新 Thread / Turn…」），也不改写 URL。
      return;
    }
    // 点选 Session：URL 只写到 Session 层级（thread/turn/step 裁剪，2026-09-20 用户确认，
    // 便于跳转交互内容时按 Session 范围展示）；下钻到该 Session 最新数据只更新内存。
    replaceSelection({
      agent: group.agentName,
      session: sessionId,
    }, "session");
    manualLockDepthRef.current = 1;
    autoDrillNonceRef.current += 1;
    drillIntentRef.current = { key: `${sessionId}|`, nonce: autoDrillNonceRef.current, keepUrl: true };
  }

  function selectThread(threadId: string): void {
    const owner = findThreadOwner(treePage, rootPagesBySession, threadId);
    if (!owner) return;
    // 手动点选 Thread：Thread 及其上层锁定，Turn/Step 自动下钻并跟随最新。
    manualLockDepthRef.current = 2;
    const base: WorkbenchClientSelection = {
      agent: owner.group.agentName,
      session: owner.session.id,
      thread: threadId,
      ancestorThreadIds: owner.ancestorThreadIds,
    };
    // URL 只写到 Thread 层级（turn/step 裁剪，2026-09-20 用户确认）；下钻只更新内存。
    replaceSelection(base, "thread");
    autoDrillNonceRef.current += 1;
    drillIntentRef.current = {
      key: `${owner.session.id}|${threadId}`,
      nonce: autoDrillNonceRef.current,
      keepUrl: true,
    };
  }

  function selectTurn(turnId: string): void {
    // 手动点选 Turn：Turn 及其上层锁定；点选时刻一次性补选该 Turn 最新 Step，
    // 之后版本轮询只静默刷新，选中不再自动跟随（2026-09-29 用户确认）。
    manualLockDepthRef.current = 3;
    const ownerThreadId = findTurnOwner(turnPagesByThread, turnId);
    if (!ownerThreadId) return;
    const owner = findThreadOwner(treePage, rootPagesBySession, ownerThreadId);
    if (!owner) return;
    const base: WorkbenchClientSelection = {
      agent: owner.group.agentName,
      session: owner.session.id,
      thread: ownerThreadId,
      turn: turnId,
      ancestorThreadIds: owner.ancestorThreadIds,
    };
    // URL 一次性写到 Turn 层级（不携带 step：点上层节点时链接按所点层级裁剪，
    // 2026-09-20 用户确认）；后续补选的最新 Step 只更新内存，不再二次改写 URL。
    replaceSelection(base, "turn");
    void (async () => {
      const stepPage = await loadSteps(turnId, undefined, true);
      if (manualLockDepthRef.current !== 3 || selectionRef.current?.turn !== turnId) return;
      const latestStep = stepPage?.steps[0];
      if (latestStep) {
        setSelectionInMemory({ ...base, step: latestStep.id }, "turn");
        void loadStepRecord(latestStep.id);
      }
    })();
  }

  function selectStep(step: AgentStep): void {
    // 手动点选 Step：全层级锁定，不再自动跟随。
    manualLockDepthRef.current = 4;
    applyStepSelection(step);
  }

  /** 应用 Step 选中（手动点选与 Turn 补选共用）：写选中路径并刷新 Step 相关缓存。 */
  function applyStepSelection(step: AgentStep, options: { syncUrl?: boolean } = {}): void {
    const current = selectionRef.current;
    if (!current?.session) return;
    const agentThreadId = agentThreadIdOf(step) || current.thread;
    if (!agentThreadId) return;
    const owner = findThreadOwner(treePage, rootPagesBySession, agentThreadId);
    const nextStepId = current.step === step.id ? current.step : step.id;
    const nextTurnId = current.turn || step.turnId;
    const nextPath = {
      ...current,
      target: current.target,
      agent: owner?.group.agentName || current.agent,
      session: owner?.session.id || step.agentSessionId || current.session,
      thread: agentThreadId,
      turn: nextTurnId,
      step: nextStepId,
      ancestorThreadIds: owner?.ancestorThreadIds || current.ancestorThreadIds || [],
    };
    // 同一 step 重复点选：跳过 URL 改写与清空，避免触发右栏 layout shift 造成的页面跳动。
    const pathChanged = current.step !== nextStepId || current.turn !== nextTurnId;
    if (pathChanged) {
      if (options.syncUrl === false) {
        setSelectionInMemory(nextPath, "turn");
      } else {
        replaceSelection(nextPath, "turn");
      }
    }
    setExpandedSessionIds(current => addToSet(current, step.agentSessionId));
    setExpandedThreadIds(current => addToSet(current, agentThreadId));
    // 不再强制 setActiveTab("总览")：保留用户当前页签，避免右栏内容高度突变造成页面跳动。
    setExchangeProjection(undefined);
    setPreviousExchangeProjection(undefined);
    setPreviousModelExchangeId(undefined);
    setSnapshot(undefined);
    setDiff(undefined);
    setSelectedStepDetail(undefined);
    setStepHarness(undefined);
    setInteractionToolFilter(undefined);
    setStepDetailError("");
    setHighlightedEvidence(undefined);
    void loadTurns(agentThreadId, undefined, true);
    void loadSteps(step.turnId, undefined, true);
    void loadStepRecord(step.id);
  }

  function retryVisibleState(): void {
    retrySelection();
    setRefreshError("");
    if (selection?.session) void restoreSelectionPath(selection);
  }

  async function copyText(label: string, value: unknown): Promise<void> {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    await navigator.clipboard.writeText(text || "");
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1_200);
  }

  function toggleColumnCollapsed(column: CollapsibleColumn): void {
    setColumnCollapseState(current => ({ ...current, [column]: !current[column] }));
  }

  function startColumnDrag(
    column: CollapsibleColumn,
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startColumnWidth = columnSizeState[column] || defaultColumnSizes[column];
    const startInspectorWidth = columnSizeState.inspector || defaultColumnSizes.inspector;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";

    function onPointerMove(moveEvent: PointerEvent): void {
      const delta = moveEvent.clientX - startX;
      setColumnSizeState(current => ({
        ...current,
        [column]: clampColumnSize(column, startColumnWidth + delta),
        inspector: clampColumnSize("inspector", startInspectorWidth - delta),
      }));
    }

    function onPointerUp(upEvent: PointerEvent): void {
      if (handle.hasPointerCapture(upEvent.pointerId)) {
        handle.releasePointerCapture(upEvent.pointerId);
      }
      delete handle.dataset.dragging;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  // ===== 选中行 → 目标面板连接线（rails 融合视觉）=====
  // 源行：树中选中 Turn（.selected-scope）/ 时间线选中 Step（.active）；
  // 目标：右邻面板左缘。几何相对工作台容器计算，随选择、展开收起、
  // 列宽拖拽、内部滚动与窗口缩放实时重测；源行不在容器可视范围时不绘制。
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const connectorStylesRef = useRef(connectorStyles);
  const measureConnectors = useCallback(() => {
    const container = workbenchRef.current;
    if (!container || typeof window === "undefined") return;
    const apply = (next: typeof connectorStyles) => {
      const prev = connectorStylesRef.current;
      const same = (a: typeof prev.turn, b: typeof next.turn) =>
        a && b
          ? Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5
          : a === b;
      if (same(prev.turn, next.turn) && same(prev.step, next.step)) return;
      connectorStylesRef.current = next;
      setConnectorStyles(next);
    };
    // 窄屏堆叠布局下三栏纵向排列，不绘制横向连接线。
    if (window.matchMedia("(max-width: 1023px)").matches) {
      apply({});
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const measure = (sourceSelector: string, targetSelector: string, collapsed: boolean) => {
      const target = container.querySelector<HTMLElement>(targetSelector);
      // 无论是否绘制色带，先清掉目标栏上一次的汇入带定位，避免残留一条错位的色带。
      // --inflow-h 必须同时归零：第三栏门洞带的高度直接取自它，只挪 y 不清高会在栏外留下白块。
      const clearInflow = () => {
        target?.style.setProperty("--inflow-y", "-300px");
        target?.style.setProperty("--inflow-h", "0px");
        return undefined;
      };
      if (collapsed) return clearInflow();
      const source = container.querySelector<HTMLElement>(sourceSelector);
      if (!source || !target) return clearInflow();
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (sourceRect.height <= 0 || sourceRect.right >= targetRect.left) return clearInflow();
      if (sourceRect.bottom < containerRect.top || sourceRect.top > containerRect.bottom) return clearInflow();
      // 源行若在内层滚动容器（步骤列表等）中滚出可视区，不绘制，避免色带指向面板外。
      const scroller = source.closest<HTMLElement>(".step-list-panel, .tree-body");
      if (scroller) {
        const visibleRect = scroller.getBoundingClientRect();
        if (sourceRect.bottom < visibleRect.top || sourceRect.top > visibleRect.bottom) return clearInflow();
      }
      // 无箭头：选中行的填充色直接平铺延续到右邻栏左缘（跨过 8px 沟槽）。
      // 色带向左回探 10px，把行尾的圆角/内描边盖住（选中行与色带同色，接缝不可见）；
      // 向右只探入目标栏 1px —— 刚好压住目标栏那 1px 边框、停在它的左侧边缘线上，
      // 不多占栏内空间（右邻栏同高度已铺同色汇入带，两端同值即无缝）。
      const overlap = 10;
      // 只探入 1px：刚好压住目标栏那 1px 边框。探入更多会把目标栏左缘的边线
      // 整段盖掉，视觉上就成了"色带压在右栏上"（用户反馈）。
      const penetrate = 1;
      // 目标栏在同一个高度铺同色汇入带：把选中行中心的纵向偏移与行高写过去。
      target.style.setProperty("--inflow-y", `${sourceRect.top + sourceRect.height / 2 - targetRect.top}px`);
      target.style.setProperty("--inflow-h", `${Math.round(sourceRect.height)}px`);
      return {
        top: sourceRect.top - containerRect.top,
        height: sourceRect.height,
        left: sourceRect.right - containerRect.left - overlap,
        width: Math.max(0, targetRect.left - sourceRect.right + overlap + penetrate),
      };
    };
    apply({
      turn: measure(".tree-row.tree-turn.selected-scope", ".timeline-column", columnCollapseState.timeline),
      // 源用选中卡片而不是整行：行本身带 12px 下内边距，会让色带比白块多出一条
      step: measure(".step-row.active .step-card", ".inspector-column", false),
    });
  }, [columnCollapseState.timeline]);

  // ===== 步骤列表滚动窗口：可视区上限 = 15 张卡（2026-09-18 用户确认）=====
  // 仅在内部滚动模式（>15 个 Step）下生效：实测第 15 张卡底部到面板顶部的距离写入
  // --step-list-cap，滚动窗恰好容纳 15 张；未测量时 CSS 回退 74vh。带 0.5px 守卫，
  // 自身改写 max-height 触发 ResizeObserver 重入时不会形成写循环。
  const measureStepListCap = useCallback(() => {
    const container = workbenchRef.current;
    if (!container) return;
    const panel = container.querySelector<HTMLElement>(".step-list-panel");
    if (!panel || !panel.classList.contains("step-list-panel-scrollable")) return;
    const fifteenth = panel.querySelectorAll<HTMLElement>(".step-row")[STEP_LIST_INTERNAL_SCROLL_THRESHOLD - 1];
    if (!fifteenth) return;
    const cap = Math.round(fifteenth.offsetTop + fifteenth.offsetHeight);
    const prev = Number.parseFloat(panel.style.getPropertyValue("--step-list-cap")) || 0;
    if (Math.abs(prev - cap) < 0.5) return;
    panel.style.setProperty("--step-list-cap", `${cap}px`);
  }, []);

  useEffect(() => {
    const container = workbenchRef.current;
    if (!container) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        measureConnectors();
        measureStepListCap();
      });
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    for (const column of container.querySelectorAll<HTMLElement>(
      ".session-tree-column, .timeline-column, .inspector-column, .tree-body, .step-list-panel",
    )) {
      observer.observe(column);
    }
    const onScroll = () => schedule();
    container.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [measureConnectors, measureStepListCap]);

  // 数据刷新 / 展开-收起 / 选择切换等任何渲染后都补测一次（rAF 去抖，几何不变时不 setState）。
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      measureConnectors();
      measureStepListCap();
    });
    return () => cancelAnimationFrame(frame);
  });

  // 恢复选择的浮动进度：延迟出现避免快速恢复时闪烁，完成即消失；fixed 定位不参与布局。
  useEffect(() => {
    if (!selectionLoading) {
      setRestoreProgressVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setRestoreProgressVisible(true), 400);
    return () => window.clearTimeout(timer);
  }, [selectionLoading]);

  // 浮动通知自动消失：错误约 8 秒、信息约 6 秒（与供应商管理页同思路）。
  useEffect(() => {
    if (!workbenchNotice) return;
    const timer = window.setTimeout(
      () => setWorkbenchNotice(undefined),
      workbenchNotice.kind === "error" ? 8_000 : 6_000,
    );
    return () => window.clearTimeout(timer);
  }, [workbenchNotice]);

  // 选择恢复 / 刷新失败 → 错误浮动通知（附重试按钮）。
  const workbenchNoticeMessage = selectionError || refreshError || stepIssueMessage;
  useEffect(() => {
    if (!workbenchNoticeMessage) return;
    setWorkbenchNotice({kind: "error", message: workbenchNoticeMessage});
  }, [workbenchNoticeMessage]);

  // 补投影积压 → 每轮积压只提示一次的信息浮动通知，投影追平后复位。
  useEffect(() => {
    const pending = treePage.backlogPendingCount ?? 0;
    if (pending <= 50) {
      backlogNoticeShownRef.current = false;
      return;
    }
    if (backlogNoticeShownRef.current) return;
    backlogNoticeShownRef.current = true;
    setWorkbenchNotice({
      kind: "info",
      message: `正在处理 ${pending} 条新记录，处理完成后即可在页面看到（新数据优先处理）。`,
    });
  }, [treePage.backlogPendingCount]);

  return (
    <>
      <SessionsTimeRange
        value={range}
        onChange={handleRangeChange}
        onReset={handleFullReset}
        note={retentionDays != null
          ? <RetentionScopeNotice retentionDays={retentionDays} stacked />
          : undefined}
      />
      <section className="workbench-grid-shell sqlite-workbench" aria-label="Harness learning workbench">
      <div className={workbenchColumnClassName} style={workbenchStyle} ref={workbenchRef}>
        <div className="workbench-connectors" aria-hidden="true">
          {connectorStyles.turn ? (
            <div
              className="workbench-connector rail-orange"
              style={{
                top: connectorStyles.turn.top,
                height: connectorStyles.turn.height,
                left: connectorStyles.turn.left,
                width: connectorStyles.turn.width,
              }}
            />
          ) : null}
          {connectorStyles.step ? (
            <div
              className="workbench-connector rail-violet"
              style={{
                top: connectorStyles.step.top,
                height: connectorStyles.step.height,
                left: connectorStyles.step.left,
                width: connectorStyles.step.width,
              }}
            />
          ) : null}
        </div>
        <aside className={`session-tree-column ${columnCollapseState.capture ? "collapsed-panel" : ""}`}>
          <WorkbenchPanelHead
            rail="sky"
            title="洞察 · 会话树"
            sub="范围 · Session / Thread / Turn"
            count={treeSearchQuery ? treeSearchResult?.candidateCount ?? 0 : treePage.candidateCount}
          />
          <div className="tree-search-box">
            <Search size={14} className="tree-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="tree-search-input"
              placeholder="模糊搜索 Session ID，定位供应商与 Agent"
              aria-label="按 Session 模糊搜索会话树"
              value={treeSearchInput}
              onChange={event => setTreeSearchInput(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === "Escape") setTreeSearchInput("");
              }}
            />
            {treeSearchInput ? (
              <button
                type="button"
                className="tree-search-clear"
                aria-label="清空搜索"
                onClick={() => setTreeSearchInput("")}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="list-stack tree-body">
            {treeSearchQuery ? (
              <TreeSearchResults
                query={treeSearchQuery}
                result={treeSearchResult}
                loading={loadingKeys.has(TREE_SEARCH_KEY)}
                error={treeSearchError}
                nowMs={relativeNowMs}
                onSelectSession={selectSessionFromSearch}
                onSelectThread={selectThreadFromSearch}
                onSelectTurn={selectTurnFromSearch}
                onRetry={() => void runTreeSearch(treeSearchQuery)}
              />
            ) : (
              <>
            {treePage.agents.map(group => {
              const groupId = agentGroupKey(group);
              const expanded = expandedAgentIds.has(groupId);
              return (
                <div key={groupId} className="tree-group">
                  <div className="tree-row tree-agent" data-tree-level="agent">
                    <button
                      type="button"
                      className="tree-chevron-button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "折叠" : "展开"} ${group.agentName}`}
                      onClick={event => {
                        event.stopPropagation();
                        toggleAgent(groupId);
                      }}
                    >
                      {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    <button
                      type="button"
                      className="tree-row-main"
                      title={`${group.agentName} · ${group.agentFingerprintId}`}
                      onClick={() => toggleAgent(groupId)}
                    >
                      <span className="tree-dot" aria-hidden="true" />
                      <span className="tree-label">{group.agentName}</span>
                      <TreeNodeMeta
                        countLabel={`${group.sessions.length} session`}
                        endTime={latestSessionEndTime(group.sessions)}
                        nowMs={relativeNowMs}
                      />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="tree-children tree-children-session">
                      {group.sessions.map(session => {
                        const sessionExpanded = expandedSessionIds.has(session.id);
                        const rootPage = rootPagesBySession.get(session.id);
                        const rootKey = threadRequestKey(session.id);
                        return (
                          <div key={session.id} className="tree-session-branch">
                            <div
                              className={`tree-row tree-session${selection?.session === session.id
                                ? scopeType === "session" ? " selected-scope" : " path-ancestor"
                                : ""}`}
                              data-tree-level="session"
                            >
                              <button
                                type="button"
                                className="tree-chevron-button"
                                aria-expanded={sessionExpanded}
                                aria-label={`${sessionExpanded ? "折叠" : "展开"} Session ${session.externalSessionId || session.id}`}
                                onClick={event => {
                                  event.stopPropagation();
                                  toggleSession(session.id);
                                }}
                              >
                                {sessionExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                              </button>
                              <button
                                type="button"
                                className="tree-row-main"
                                title={`内部 Session: ${session.id}${session.externalSessionId ? `\n外部 Session: ${session.externalSessionId}` : ""}`}
                                aria-current={selection?.session === session.id && scopeType === "session" ? "true" : undefined}
                                onClick={() => selectSession(group, session.id)}
                              >
                                <span className="tree-dot" aria-hidden="true" />
                                <span className="tree-label">{compactHierarchicalId(session.externalSessionId || session.id)}</span>
                                <TreeNodeMeta
                                  countLabel={`${session.threadCount} thread`}
                                  endTime={session.endTime}
                                  nowMs={relativeNowMs}
                                />
                              </button>
                            </div>
                            {sessionExpanded ? (
                              <div className="tree-children tree-children-session-threads">
                                {loadingKeys.has(rootKey) && !rootPage ? <p className="tree-inline-status" role="status">正在加载 Thread…</p> : null}
                                {requestErrors.get(rootKey) ? (
                                  <div className="tree-inline-error" role="alert">
                                    <span>{requestErrors.get(rootKey)}</span>
                                    <button type="button" onClick={() => void loadThreads(session.id, undefined, undefined, true)}>重试</button>
                                  </div>
                                ) : null}
                                {rootPage ? (
                                  <ThreadTree
                                    roots={rootPage.items.map(node => decorateThreadNode(
                                      node,
                                      turnPagesByThread,
                                      loadingKeys,
                                      requestErrors,
                                    ))}
                                    expandedIds={expandedThreadIds}
                                    selectedThreadId={selection?.thread}
                                    selectedTurnId={selection?.turn}
                                    activeThreadPathIds={activeThreadPathIds}
                                    selectedScopeType={scopeType}
                                    nowMs={relativeNowMs}
                                    onToggle={toggleThread}
                                    onSelectThread={selectThread}
                                    onSelectTurn={selectTurn}
                                    onLoadMore={threadId => {
                                      const owner = findThreadOwner(treePage, rootPagesBySession, threadId);
                                      const cursor = owner?.node.childPage?.nextCursor;
                                      if (owner && cursor) void loadThreads(owner.session.id, threadId, cursor, false);
                                    }}
                                    onLoadMoreTurns={threadId => {
                                      const cursor = turnPagesByThread.get(threadId)?.nextCursor;
                                      if (cursor) void loadTurns(threadId, cursor, false);
                                    }}
                                    onRetry={(threadId, kind) => {
                                      const owner = findThreadOwner(treePage, rootPagesBySession, threadId);
                                      if (kind === "children" && owner) void loadThreads(owner.session.id, threadId, undefined, true);
                                      if (kind === "turns") void loadTurns(threadId, undefined, true);
                                    }}
                                  />
                                ) : null}
                                {rootPage?.hasMore && rootPage.nextCursor ? (
                                  <button
                                    type="button"
                                    className="tree-load-more"
                                    onClick={() => void loadThreads(session.id, undefined, rootPage.nextCursor, false)}
                                  >
                                    加载更多根 Thread
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {requestErrors.get(TREE_MORE_KEY) ? (
              <div className="tree-inline-error" role="alert">
                <span>{requestErrors.get(TREE_MORE_KEY)}</span>
                <button
                  type="button"
                  onClick={() => {
                    const cursor = treePage.nextCursor;
                    if (cursor) void loadMoreSessions(cursor);
                  }}
                >
                  重试
                </button>
              </div>
            ) : null}
            {treePage.hasMore && treePage.nextCursor ? (
              <button
                type="button"
                className="tree-load-more"
                disabled={loadingKeys.has(TREE_MORE_KEY)}
                onClick={() => void loadMoreSessions(treePage.nextCursor!)}
              >
                {loadingKeys.has(TREE_MORE_KEY) ? "正在加载更多 Session…" : "加载更多 Session"}
              </button>
            ) : null}
            {treePage.agents.length === 0 ? <EmptyState text="暂无会话数据" /> : null}
              </>
            )}
          </div>
        </aside>

        <ColumnResizeHandle
          column="capture"
          collapsed={columnCollapseState.capture}
          label="会话树"
          onToggle={toggleColumnCollapsed}
          onDragStart={startColumnDrag}
        />

        <section className={`timeline-column ${columnCollapseState.timeline ? "collapsed-panel" : ""}`}>
          <WorkbenchPanelHead
            rail="orange"
            title={view === "session" ? "事件 · 请求列表" : "事件 · 时间线"}
            sub="本 Turn 的全部请求阶段"
            count={view === "turn" ? selectedStepPage?.candidateCount || 0 : 0}
          />
          {view === "turn" && selection?.turn ? (
            <>
              <div className="turn-summary">
                <div>
                  <span className="label">供应商</span>
                  {/* 同一 Turn 一般不换「供应商 × 模型」配对，取最新一条 Step 的供应商即可
                      （分页按时间倒序，items[0] 恒在已加载页内）。 */}
                  <strong>{selectedSteps[0]?.targetName || "未知"}</strong>
                </div>
                <div>
                  <span className="label">模型</span>
                  <strong>{selectedSession?.modelSet.join(", ") || "未知"}</strong>
                </div>
                <div>
                  <span className="label">请求总耗时</span>
                  <strong>{turnTotalDurationLabel(selectedSteps, selectedStepPage)}</strong>
                </div>
                {(() => {
                  // 故障转移轨迹（总览顶部一眼可见）：按时间顺序聚合各 Step 的转移链。
                  const failovers = [...selectedSteps].reverse()
                    .map(step => step.failover)
                    .filter((failover): failover is NonNullable<typeof failover> => Boolean(failover));
                  const trajectory = buildFailoverTrajectory(failovers);
                  return trajectory ? (
                    <div className="failover-trajectory">
                      <span className="label">故障转移轨迹</span>
                      <strong>{trajectory.join(" → ")}</strong>
                    </div>
                  ) : null;
                })()}
              </div>
              {selectedStepPage?.userPrompt ? (
                <TurnUserPromptCard prompt={selectedStepPage.userPrompt} />
              ) : null}
              <TurnIntentSequence
                steps={selectedSteps}
                intentStats={selectedStepPage?.intentStats}
                total={selectedStepPage?.candidateCount || selectedSteps.length}
              />
              {loadingKeys.has(`steps:${selection.turn}`) && selectedSteps.length === 0 ? (
                <p className="tree-inline-status" role="status">正在加载 Step…</p>
              ) : null}
              {requestErrors.get(`steps:${selection.turn}`) ? (
                <div className="tree-inline-error" role="alert">
                  <span>{requestErrors.get(`steps:${selection.turn}`)}</span>
                  <button type="button" onClick={() => void loadSteps(selection.turn!, undefined, true)}>重试</button>
                </div>
              ) : null}
              {/* 步骤数 > 15 时启用内部上下滚动（2026-09-18 用户确认）：可视窗口 = 15 张卡，
                  超过才在滚动里面上下拉伸查看；否则整体随页面滚动。 */}
              <div
                className={`step-list-panel${selectedSteps.length > STEP_LIST_INTERNAL_SCROLL_THRESHOLD ? " step-list-panel-scrollable" : ""}`}
              >
                {buildTimelineRows(selectedSteps).map(row => row.kind === "idle" ? (
                  <div
                    key={`idle-after-${row.after}`}
                    className="timeline-idle-divider"
                    title={`两步之间间隔 ${row.minutes} 分钟（同一 Turn 内的空闲等待）`}
                  >
                    ⏸ 空闲 {row.minutes >= 60 ? `${Math.floor(row.minutes / 60)} 小时 ${row.minutes % 60} 分` : `${row.minutes} 分钟`}
                  </div>
                ) : (
                  <button
                    key={row.step.id}
                    type="button"
                    className={`step-row tl-${timelineKind(row.step)}${selection.step === row.step.id ? " active" : ""}`}
                    data-tree-level="step"
                    aria-current={selection.step === row.step.id ? "true" : undefined}
                    title={`步骤 ${row.step.index} · ${phaseLabel(row.step.phase)}`}
                    onClick={() => selectStep(row.step)}
                  >
                    <span className="step-icon" aria-hidden="true">{timelineIcon(row.step)}</span>
                    <span className="step-card">
                      <span className="step-top">
                        <span className="step-index">{row.step.index}</span>
                        <span className="step-title">{timelineTitle(row.step)}</span>
                        <span className="step-time" title={formatLocalDateTime(row.step.timestamp)}>
                          {formatLocalClock(row.step.timestamp)}
                        </span>
                      </span>
                      {timelineBody(row.step) ? (
                        <span className="step-body">{timelineBody(row.step)}</span>
                      ) : null}
                      <span className="step-meta-row">
                        <span className={`chip-mode${row.step.origin === "agent_local_import" ? "" : ""}`}
                          title={row.step.origin === "agent_local_import"
                            ? "官方直连本地导入：请求未经本网关（享官方客户端权益），用量为客户端自报"
                            : "经本地代理网关（127.0.0.1:3211）转发，wire 保真捕获"}>
                          {row.step.origin === "agent_local_import" ? "直连" : "代理"}
                        </span>
                        {row.step.httpStatus !== undefined ? (
                          <span
                            className={`chip-${row.step.httpStatus >= 400 ? "error" : "ok"}`}
                            title={`HTTP ${row.step.httpStatus}`}
                          >
                            {row.step.httpStatus}
                          </span>
                        ) : null}
                        <span className="chip-neutral" title={`请求耗时 ${formatDuration(row.step.durationMs)}`}>
                          {formatDuration(row.step.durationMs)}
                        </span>
                        {row.step.firstTokenMs !== undefined ? (
                          <span className="chip-neutral" title="首字耗时">
                            首字 {formatFirstTokenLatency(row.step.firstTokenMs)}
                          </span>
                        ) : null}
                      </span>
                      {stepHasExtendedMeta(row.step, retryChainOrdinals) ? (
                        <span className="step-meta-row">
                          {row.step.toolUseIds.length > 0 ? (
                            <span className="chip-tool" title={`工具调用 ${row.step.toolUseIds.length} 次`}>
                              {row.step.toolUseIds.length} 工具
                            </span>
                          ) : null}
                          {row.step.targetName ? (
                            <span className="chip-neutral" title={`本次请求所属供应商目标：${row.step.targetName}`}>{row.step.targetName}</span>
                          ) : null}
                          {row.step.compactionRole === "generation" ? (
                            <span
                              className="chip-neutral"
                              title="压缩生成调用：本步响应为压缩摘要，紧随其后上下文被压缩（wire 证据判定）"
                            >
                              发生压缩
                            </span>
                          ) : null}
                          {row.step.compactionRole === "first-after" ? (
                            <span
                              className="chip-neutral"
                              title={`识别到第 ${row.step.compactionOrdinal ?? 1} 次压缩：本步起上下文为压缩后形态`}
                            >
                              压缩后首请求
                            </span>
                          ) : null}
                          {retryChainOrdinals.has(row.step.id) ? (
                            <span className="chip-neutral" title="连续错误 + 短间隔推断的重试链">重试链 {retryChainOrdinals.get(row.step.id)} · 推断</span>
                          ) : null}
                          {row.step.failover ? (
                            <span
                              className="chip-neutral"
                              title={`${formatFailoverBadgeText(row.step.failover)}（代理捕获记录，非推断）`}
                            >
                              {formatFailoverChipText(row.step.failover)}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
                {selectedStepPage?.hasMore && selectedStepPage.nextCursor ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadSteps(selection.turn!, selectedStepPage.nextCursor, false)}
                  >
                    加载更多步骤 {selectedSteps.length}/{selectedStepPage.candidateCount}
                  </button>
                ) : null}
                {selectedStepPage?.limited && !selectedStepPage.hasMore ? (
                  <p className="tree-inline-status" role="status">
                    仅显示前 {selectedSteps.length}/{selectedStepPage.candidateCount} 个 Step
                  </p>
                ) : null}
                {selectedSteps.length === 0 && !loadingKeys.has(`steps:${selection.turn}`) ? (
                  <EmptyState text="该 Turn 暂无 Step" />
                ) : null}
              </div>
            </>
          ) : (
            <EmptyState text={treePage.agents.length === 0
              ? "暂无 Step 数据"
              : view === "session"
                ? rootPagesBySession.get(selection?.session || "")?.items.length
                  ? autoDrillExhausted === `${selection?.session || ""}|`
                    ? "该 Session 暂无 Turn / Step 数据"
                    : "正在自动选择最新 Thread / Turn…"
                  : "该 Session 暂无 Thread / Turn 数据"
              : view === "thread"
                ? autoDrillExhausted === `${selection?.session || ""}|${selection?.thread || ""}`
                  ? "该 Thread 暂无 Step 数据"
                  : "正在自动选择最新 Turn…"
                : "请选择 Thread 或 Turn"} />
          )}
        </section>

        <ColumnResizeHandle
          column="timeline"
          collapsed={columnCollapseState.timeline}
          label="时间线"
          onToggle={toggleColumnCollapsed}
          onDragStart={startColumnDrag}
        />

        <section className="inspector-column">
          <div className="inspector-header">
            <div>
              <span className="label">步骤检查器</span>
              <h2>{selectedStep ? `步骤 ${selectedStep.index}` : "未选择步骤"}</h2>
            </div>
            <div className="copy-actions">
              <IconButton label="复制 prompt 模板" onClick={copyPromptTemplate} active={copied === "prompt"} icon={<Clipboard size={15} />} />
              <IconButton label="复制工具摘要" onClick={copyToolSchemaSummary} active={copied === "tools"} icon={<Network size={15} />} />
              <IconButton label="复制快照 JSON" onClick={copyContextSnapshot} active={copied === "context"} icon={<FileJson size={15} />} />
            </div>
          </div>

          <nav className="tab-strip" aria-label="步骤检查器标签">
            {tabs.map(tab => (
              <button
                key={tab}
                type="button"
                className={tab === activeTab ? "active" : ""}
                onClick={() => selectInspectorTab(tab)}
              >
                {tab}
              </button>
            ))}
          </nav>

          <div className="inspector-body">
            {activeTab !== "总览" && activeTab !== "请求" && activeTab !== "响应" ? (
              <StepConclusionBar
                tab={activeTab}
                step={selectedStep}
                snapshot={snapshot}
                diff={diff}
                harness={stepHarness}
              />
            ) : null}
            {activeTab === "总览" ? <OverviewTab
              step={selectedStep}
              session={selectedSession}
              businessIds={{
                externalThreadId: selectedThreadNode?.externalThreadId,
                nativeTurnId: selectedTurn?.nativeTurnId,
              }}
              projection={exchangeProjection}
              previousProjection={previousExchangeProjection}
            /> : null}
            {activeTab === "上下文" ? <ContextTab
              snapshot={snapshot}
              harness={stepHarness}
              diff={diff}
              step={selectedStep}
              onOpenHarness={selectedStep ? () => selectInspectorTab("能力清单") : undefined}
              onOpenInteraction={(filter) => {
                setInteractionCategoryFilter(filter.categories);
                setInteractionToolFilter(filter.toolName);
                selectInspectorTab("交互内容");
              }}
            /> : null}
            {activeTab === "请求" ? <WorkbenchRawInspectorTab
              key={`${selectedStep?.exchangeId || "empty"}:request`}
              side="request"
              exchangeId={selectedStep?.exchangeId}
              projection={exchangeProjection}
              highlightedEvidence={highlightedEvidence}
            /> : null}
            {activeTab === "响应" ? <WorkbenchRawInspectorTab
              key={`${selectedStep?.exchangeId || "empty"}:response`}
              side="response"
              exchangeId={selectedStep?.exchangeId}
              projection={exchangeProjection}
              highlightedEvidence={highlightedEvidence}
            /> : null}
            {activeTab === "能力清单" ? <HarnessTab
              step={selectedStep}
              harness={stepHarness}
              harnessLoading={stepHarnessLoading}
              protocol={exchangeProjection?.preview.protocol ?? snapshot?.protocol}
              isStreaming={exchangeProjection?.response.isStreaming}
              onInspectTool={(toolName) => {
                setInteractionCategoryFilter(undefined);
                setInteractionToolFilter(toolName);
                selectInspectorTab("交互内容");
              }}
              onOpenContext={() => selectInspectorTab("上下文")}
            /> : null}
            {activeTab === "交互内容" ? (
              selectedStep && stepConversationQuery
                ? <ConversationExportViewer
                  key={`${selectedStep.id}:${(interactionCategoryFilter ?? []).join(",")}`}
                  mode="embedded"
                  initialQuery={stepConversationQuery}
                  drillCategories={interactionCategoryFilter}
                  toolNameFilter={interactionToolFilter}
                  onClearToolNameFilter={() => setInteractionToolFilter(undefined)}
                />
                : <EmptyState text="选择 Step 后查看当前 Step 的交互内容" />
            ) : null}
          </div>
        </section>
      </div>
      </section>
      {restoreProgressVisible ? (
        <div className="workbench-progress-toast" role="status">
          <RefreshCw size={13} className="workbench-progress-toast-icon" aria-hidden="true" />
          正在恢复最近选择…
        </div>
      ) : null}
      {workbenchNotice ? (
        <div
          className={`workbench-toast ${workbenchNotice.kind === "error" ? "error" : ""}`}
          role={workbenchNotice.kind === "error" ? "alert" : "status"}
        >
          <span>{workbenchNotice.message}</span>
          {workbenchNotice.kind === "error" ? (
            <button
              type="button"
              onClick={() => {
                setWorkbenchNotice(undefined);
                retryVisibleState();
              }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  async function loadMoreSessions(cursor: string): Promise<void> {
    const key = TREE_MORE_KEY;
    const request = beginRequest(key);
    if (!request) return;
    const params = new URLSearchParams(treeFilters.current);
    params.set("limit", String(SQLITE_PAGE_LIMIT));
    params.set("cursor", cursor);
    try {
      const response = await fetch(`/api/workbench-tree?${params}`, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseWorkbenchTreePage(await response.json());
      if (!page) throw new Error("会话树分页响应格式无效");
      if (!requestIsCurrent(key, request.sequence)) return;
      setTreePage(current => appendWorkbenchTreePage(current, page));
      completeRequest(key, request.sequence);
    } catch (error) {
      if (!request.controller.signal.aborted) failRequest(key, request.sequence, error);
    }
  }
}

type WorkbenchAgentGroup = WorkbenchTreePage["agents"][number];
type WorkbenchSessionItem = WorkbenchAgentGroup["sessions"][number];

interface ThreadOwner {
  group: WorkbenchAgentGroup;
  session: WorkbenchSessionItem;
  node: WorkbenchThreadNode;
  ancestorThreadIds: string[];
}

function initialWorkbenchPath(
  tree: WorkbenchTreePage,
  initialQuery: string,
): WorkbenchSelectionPath | undefined {
  const params = new URLSearchParams(initialQuery);
  const hasExplicitPath = ["target", "agent", "session", "thread", "turn", "step"]
    .some(key => !!params.get(key)?.trim());
  return hasExplicitPath ? tree.resolvedPath : tree.latestPath;
}

/** 深链显式携带 step 视为锁定到 Step；仅携带 turn 视为锁定到 Turn；否则自动跟随最新。 */
function initialManualLockDepth(initialQuery: string): number {
  const params = new URLSearchParams(initialQuery);
  if (params.get("step")?.trim()) return 4;
  if (params.get("turn")?.trim()) return 3;
  return 0;
}

function workbenchTreeFilters(initialQuery: string): URLSearchParams {
  const filters = new URLSearchParams();
  // 首页深链的 target/agent 只负责恢复和高亮，树请求必须保留所有供应商。
  filters.set("treeScope", "global");
  // 时间范围是页面私有过滤参数，随树请求与翻页一起下发。
  const source = new URLSearchParams(initialQuery);
  for (const key of ["start", "end"] as const) {
    const value = source.get(key)?.trim();
    if (value) filters.set(key, value);
  }
  return filters;
}

function initialExpandedAgentIds(
  tree: WorkbenchTreePage,
  path: WorkbenchClientSelection | undefined,
): Set<string> {
  const group = findSelectedAgentGroup(tree, path);
  return new Set(group ? [agentGroupKey(group)] : []);
}

function agentGroupKey(group: WorkbenchAgentGroup): string {
  return group.agentFingerprintId;
}

function searchGroupKey(group: WorkbenchSessionSearchGroup): string {
  return group.agentFingerprintId;
}

function latestSearchSessionEndTime(sessions: WorkbenchSessionSearchSession[]): string {
  return sessions.reduce<string>(
    (latest, session) => (session.endTime > latest ? session.endTime : latest),
    "",
  );
}

function latestSessionEndTime(sessions: WorkbenchSessionItem[]): string {
  return sessions.reduce(
    (latest, session) => session.endTime > latest ? session.endTime : latest,
    "",
  );
}

function addToSet(current: ReadonlySet<string>, value: string): Set<string> {
  if (current.has(value)) return new Set(current);
  const next = new Set(current);
  next.add(value);
  return next;
}

function withoutSetValue(current: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(current);
  next.delete(value);
  return next;
}

function withoutMapKey<K, V>(current: ReadonlyMap<K, V>, key: K): Map<K, V> {
  const next = new Map(current);
  next.delete(key);
  return next;
}

function touchMapValue<T>(
  current: ReadonlyMap<string, T>,
  key: string,
  value: T,
): Map<string, T> {
  const next = new Map(current);
  next.delete(key);
  next.set(key, value);
  return next;
}

function threadRequestKey(sessionId: string, parentThreadId?: string): string {
  return `threads:${sessionId}:${parentThreadId || "root"}`;
}

function mergeThreadPageIntoSession(
  current: ReadonlyMap<string, BoundedPage<WorkbenchThreadNode>>,
  sessionId: string,
  parentThreadId: string | undefined,
  incoming: BoundedPage<WorkbenchThreadNode>,
  replace: boolean,
): Map<string, BoundedPage<WorkbenchThreadNode>> {
  const next = new Map(current);
  const roots = current.get(sessionId);
  if (!parentThreadId) {
    const merged = replace || !roots ? incoming : mergeBoundedPage(roots, incoming);
    next.set(sessionId, {
      ...merged,
      items: preserveThreadRuntime(roots?.items || [], merged.items),
    });
    return next;
  }
  if (!roots) return next;
  next.set(sessionId, {
    ...roots,
    items: roots.items.map(root => updateThreadNode(root, parentThreadId, node => {
      const previous = node.childPage;
      const page = replace || !previous
        ? incoming
        : mergeBoundedPage(previous, incoming);
      return {
        ...node,
        childPage: page,
        children: preserveThreadRuntime(node.children, page.items),
      };
    })),
  });
  return next;
}

function updateThreadNode(
  node: WorkbenchThreadNode,
  threadId: string,
  update: (current: WorkbenchThreadNode) => WorkbenchThreadNode,
): WorkbenchThreadNode {
  if (node.id === threadId) return update(node);
  let changed = false;
  const children = node.children.map(child => {
    const next = updateThreadNode(child, threadId, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function preserveThreadRuntime(
  previous: WorkbenchThreadNode[],
  incoming: WorkbenchThreadNode[],
): WorkbenchThreadNode[] {
  const previousById = new Map(previous.map(node => [node.id, node]));
  return incoming.map(node => {
    const loaded = previousById.get(node.id);
    if (!loaded) return node;
    return {
      ...node,
      children: loaded.children,
      childPage: loaded.childPage,
    };
  });
}

function decorateThreadNode(
  node: WorkbenchThreadNode,
  turnPages: ReadonlyMap<string, BoundedPage<WorkbenchTurnSummary>>,
  loadingKeys: ReadonlySet<string>,
  requestErrors: ReadonlyMap<string, string>,
): ThreadTreeRuntimeNode {
  const childKey = threadRequestKey(node.agentSessionId, node.id);
  const turnKey = `turns:${node.id}`;
  return {
    ...node,
    children: node.children.map(child => decorateThreadNode(
      child,
      turnPages,
      loadingKeys,
      requestErrors,
    )),
    turnPage: turnPages.get(node.id),
    childrenLoading: loadingKeys.has(childKey),
    turnsLoading: loadingKeys.has(turnKey),
    childrenError: requestErrors.get(childKey),
    turnsError: requestErrors.get(turnKey),
  };
}

function findThreadOwner(
  tree: WorkbenchTreePage,
  pages: ReadonlyMap<string, BoundedPage<WorkbenchThreadNode>>,
  threadId: string,
): ThreadOwner | undefined {
  for (const group of tree.agents) {
    for (const session of group.sessions) {
      const roots = pages.get(session.id)?.items || [];
      for (const root of roots) {
        const found = findThreadPath(root, threadId, []);
        if (found) return { group, session, ...found };
      }
    }
  }
  return undefined;
}

function findThreadPath(
  node: WorkbenchThreadNode,
  threadId: string,
  ancestorThreadIds: string[],
): Pick<ThreadOwner, "node" | "ancestorThreadIds"> | undefined {
  if (node.id === threadId) return { node, ancestorThreadIds };
  for (const child of node.children) {
    const found = findThreadPath(child, threadId, [...ancestorThreadIds, node.id]);
    if (found) return found;
  }
  return undefined;
}

function findTurnOwner(
  pages: ReadonlyMap<string, BoundedPage<WorkbenchTurnSummary>>,
  turnId: string,
): string | undefined {
  for (const [threadId, page] of pages) {
    if (page.items.some(turn => turn.id === turnId)) return threadId;
  }
  return undefined;
}

function appendWorkbenchTreePage(
  current: WorkbenchTreePage,
  incoming: WorkbenchTreePage,
): WorkbenchTreePage {
  const byGroup = new Map(current.agents.map(group => [agentGroupKey(group), group]));
  for (const group of incoming.agents) {
    const previous = byGroup.get(agentGroupKey(group));
    if (!previous) {
      byGroup.set(agentGroupKey(group), group);
      continue;
    }
    const sessions = new Map(previous.sessions.map(session => [session.id, session]));
    for (const session of group.sessions) sessions.set(session.id, session);
    byGroup.set(agentGroupKey(group), { ...group, sessions: [...sessions.values()] });
  }
  return { ...incoming, agents: [...byGroup.values()] };
}

function parseSqliteWorkbenchVersion(value: unknown): { dataVersion: number } | undefined {
  const record = asRecord(value);
  if (!record || !Number.isSafeInteger(record.dataVersion) || (record.dataVersion as number) < 0) {
    return undefined;
  }
  return { dataVersion: record.dataVersion as number };
}

function parseExchangeProjectionResponse(
  value: unknown,
  expectedExchangeId: string,
): { projection: ExchangeProjectionDetail; previousModelExchangeId?: string } | undefined {
  const record = asRecord(value);
  const exchange = asRecord(record?.exchange);
  if (
    !exchange
    || exchange.exchangeId !== expectedExchangeId
    || !asRecord(exchange.routing)
    || !asRecord(exchange.request)
    || !asRecord(exchange.response)
    || !asRecord(exchange.preview)
    || !asRecord(exchange.media)
    || !asRecord(exchange.diagnostics)
    || projectionContainsForbiddenField(exchange)
  ) {
    return undefined;
  }
  return {
    projection: exchange as unknown as ExchangeProjectionDetail,
    previousModelExchangeId: typeof record?.previousModelExchangeId === "string"
      ? record.previousModelExchangeId
      : undefined,
  };
}

function projectionContainsForbiddenField(
  value: unknown,
  depth = 0,
  visited = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") {
    return /data:[^;,\s]{1,128};base64,/i.test(value);
  }
  if (!value || typeof value !== "object") return false;
  if (depth > 64 || visited.has(value)) return depth > 64;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some(item => projectionContainsForbiddenField(item, depth + 1, visited));
  }
  const forbidden = new Set([
    "rawBody",
    "parsedBody",
    "inlineBase64",
    "externalPath",
    "relativePath",
    "byteOffset",
    "lineLengthBytes",
  ]);
  return Object.entries(value).some(([key, item]) =>
    forbidden.has(key) || projectionContainsForbiddenField(item, depth + 1, visited)
  );
}

function stepToolActionLabel(step: AgentStep): string {
  if (step.toolUseNames.length > 0) {
    const names = step.toolUseNames.slice(0, 3).join("、");
    const more = step.toolUseNames.length > 3 ? ` 等 ${step.toolUseNames.length} 种` : "";
    return `工具调用 ${names}${more}`;
  }
  if (step.toolUseIds.length > 0) return `工具调用 ${step.toolUseIds.length} 次`;
  if (step.toolResultIds.length > 0) return `工具结果 ${step.toolResultIds.length} 项`;
  if (step.toolSchemaCount > 0) return `工具 Schema ${step.toolSchemaCount} 项`;
  return "无工具动作";
}

function agentThreadIdOf(step: AgentStep): string | undefined {
  return step.agentThreadId;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function WorkbenchRawInspectorTab({ side, exchangeId, projection, highlightedEvidence }: {
  side: WorkbenchRawInspectorSide;
  exchangeId?: string;
  projection?: ExchangeProjectionDetail;
  highlightedEvidence?: EvidencePointer;
}) {
  const [metadata, setMetadata] = useState<WorkbenchRawInspectorMetadata>();
  const [bodyResult, setBodyResult] = useState<WorkbenchRawBodyLoadResult>();
  const [loading, setLoading] = useState(!!exchangeId);
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const sideLabel = side === "request" ? "请求" : "响应";
  const projectionBody = projection?.[side];

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setMetadata(undefined);
    setBodyResult(undefined);
    setError("");
    setLoading(!!exchangeId);
    if (!exchangeId) {
      return () => controller.abort();
    }
    const selectedExchangeId = exchangeId;

    async function readSide(): Promise<void> {
      try {
        const nextMetadata = await fetchWorkbenchRawInspectorMetadata({
          exchangeId: selectedExchangeId,
          side,
          signal: controller.signal,
        });
        if (!active) return;
        setMetadata(nextMetadata);
        if (nextMetadata.body.availability === "unavailable" || nextMetadata.body.availability === "integrity_failed") {
          setLoading(false);
          return;
        }
        const nextBody = await loadWorkbenchRawBody({
          exchangeId: selectedExchangeId,
          side,
          metadata: nextMetadata,
          signal: controller.signal,
        });
        if (!active) return;
        setBodyResult(nextBody);
      } catch (nextError) {
        if (!active || controller.signal.aborted) return;
        setError(errorMessage(nextError, `${sideLabel}正文读取失败`));
      } finally {
        if (active && !controller.signal.aborted) setLoading(false);
      }
    }

    void readSide();
    return () => {
      active = false;
      controller.abort();
    };
  }, [exchangeId, retryToken, side, sideLabel]);

  const body = bodyResult?.status === "ready" ? bodyResult.body : undefined;
  const media: WorkbenchRawInspectorMedia[] = metadata?.media.items ?? [];
  const sizeBytes = metadata?.body.sizeBytes ?? projectionBody?.sizeBytes ?? 0;
  const highlightedPath = highlightedEvidence?.side === side
    ? highlightedEvidence.path
    : undefined;

  const formattedContent = (
    <>
      <div className="fact-grid raw-stats">
        <Fact label="供应商" value={metadata?.routing.targetName || projection?.routing.targetName || metadata?.routing.targetId || projection?.routing.targetId} />
        <Fact label="方法" value={metadata?.routing.method} />
        <Fact label="上游 URL" value={metadata?.routing.upstreamUrl} />
        <Fact label="本地路径" value={metadata?.routing.path} />
        <Fact label="模型" value={metadata?.model || projection?.model || "未知"} />
        {side === "request" && metadata?.credentialInjected ? (
          <Fact label="注入凭据" value={metadata.credentialFingerprint ? `${metadata.credentialFingerprint}（网关替换客户端占位）` : "已注入系统凭据（客户端占位已替换）"} />
        ) : null}
        <Fact label="原始正文" value={formatSize(sizeBytes)} />
        <Fact label="存储" value={metadata?.body.storage || projectionBody?.storage} />
        <Fact label="校验" value={metadata?.body.verification || projectionBody?.verification} />
        <Fact label="正文 SHA-256" value={metadata?.body.sha256 || projectionBody?.sha256 || "索引未记录"} />
        <Fact label="耗时" value={formatDuration(metadata?.durationMs ?? projection?.durationMs)} />
        {side === "response" ? <Fact label="HTTP 状态" value={metadata?.http ? `${metadata.http.status} ${metadata.http.statusText}` : projection ? String(projection.response.status) : undefined} /> : null}
        {side === "response" ? <Fact label="流式响应" value={metadata?.body.isStreaming || projection?.response.isStreaming ? "是" : "否"} /> : null}
      </div>
      {metadata?.headers.limited ? (
        <div className="projection-state limited" role="status">Headers 已达到展示上限，当前表格是有界结果。</div>
      ) : null}
      <RawSection
        title={`${sideLabel} Headers`}
        info={metadata ? `${metadata.headers.processedCount} / ${metadata.headers.candidateCount} 个字段` : "等待元数据"}
        defaultOpen
        bodyScroll={false}
      >
        {metadata ? <HeaderTable headers={metadata.headers.items} /> : <EmptyState text="正在读取脱敏 Headers" />}
      </RawSection>
      {loading ? <EmptyState text={`正在读取当前${sideLabel}正文`} /> : null}
      {!loading && error ? <EmptyState text={`正文读取失败：${error}`} /> : null}
      {!loading && !error && metadata?.body.availability === "unavailable" ? <EmptyState text="正文当前不可用" /> : null}
      {!loading && !error && metadata?.body.availability === "integrity_failed" ? <EmptyState text="正文完整性校验失败" /> : null}
      {!loading && !error && bodyResult?.status === "raw_limited" ? (
        <div className="projection-state limited" role="status">Raw 声明超过 128 MiB，未打开结构化正文；可查看下方完整 Raw。</div>
      ) : null}
      {!loading && !error && bodyResult?.status === "display_limited" ? (
        <div className="projection-state limited" role="status">非媒体正文超过 8 MiB，已丢弃部分结果；当前没有伪装成完整正文的预览。</div>
      ) : null}
      {body?.kind === "json" ? (
        <RawSection
          title={`格式化${sideLabel}体 JSON`}
          info={bodyResult?.status === "ready" ? formatSize(bodyResult.displayBytes) : "按需读取"}
          defaultOpen
          renderWhenOpen
          largeContent
        >
          <JsonCodeViewer value={body.value} highlightedPath={highlightedPath} mediaContext={{ exchangeId: metadata!.exchangeId, side, media }} />
        </RawSection>
      ) : null}
      {body?.kind === "sse" ? (
        <>
          <RawSection title="SSE 时间线" info={`${body.events.length} 个事件${body.doneMarkerSeen ? " · [DONE]" : ""}`} defaultOpen renderWhenOpen largeContent>
            <SseTimeline events={body.events} mediaContext={{ exchangeId: metadata!.exchangeId, side, media }} />
          </RawSection>
          <RawSection title="SSE Events (JSON)" info={`${body.events.length} 个事件`} defaultOpen={false} renderWhenOpen largeContent>
            <JsonCodeViewer value={body.events} highlightedPath={highlightedPath} mediaContext={{ exchangeId: metadata!.exchangeId, side, media }} />
          </RawSection>
        </>
      ) : null}
      {body?.kind === "text" ? (
        <RawSection
          title={`${sideLabel}正文文本`}
          info={bodyResult?.status === "ready" ? formatSize(bodyResult.displayBytes) : "按需读取"}
          defaultOpen
          renderWhenOpen
          largeContent
        >
          {body.parseError ? <div className="parse-error" role="status">{body.parseError}</div> : null}
          <WorkbenchRawTextViewer text={body.text} mediaContext={{ exchangeId: metadata!.exchangeId, side, media }} />
        </RawSection>
      ) : null}
      {body?.kind === "empty" ? <EmptyState text={`${sideLabel}正文为空`} /> : null}
      {body && body.kind !== "empty" ? (
        <RawSection
          title={`${sideLabel}完整Raw`}
          info={bodyResult?.status === "ready" ? formatSize(bodyResult.displayBytes) : "按需读取"}
          defaultOpen={false}
          renderWhenOpen
          allowFullscreen
          bodyScroll={false}
        >
          <RawTextLineViewer text={body.text} mediaContext={{ exchangeId: metadata!.exchangeId, side, media }} />
        </RawSection>
      ) : null}
    </>
  );

  if (!exchangeId) return <EmptyState text="选择 Step 后查看正文" />;
  return (
    <div className="raw-detail">
      {/* 仅在加载结束且元数据缺失时展示投影提示：加载窗口内 metadata 未到时
          该横幅会先出现又在元数据到达后立刻消失，形成每次点开页签都闪一次
          黄色“报错”的观感（2026-09-20 用户反馈）。 */}
      {!loading && !metadata && projection ? <ProjectionStateNotice projection={projection} side={side} /> : null}
      {error ? (
        <div className="projection-state unavailable" role="alert">
          {sideLabel}正文读取失败：{error}
          <button type="button" className="secondary-button" onClick={() => setRetryToken(value => value + 1)}>
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      ) : null}
      {formattedContent}
    </div>
  );
}


function ProjectionStateNotice({ projection, side }: {
  projection: ExchangeProjectionDetail;
  side: "request" | "response";
}) {
  const body = projection[side];
  if (body.availability === "integrity_failed" || projection.previewState === "integrity_failed") {
    return <div className="projection-state integrity-failed" role="alert">正文完整性校验失败，已禁止将其作为可信完整 Raw 打开。</div>;
  }
  if (body.availability === "unavailable" || body.availability === "missing_declared") {
    return <div className="projection-state unavailable" role="alert">正文当前不可用，请稍后重试。</div>;
  }
  // 原本只藏在可折叠的辅助诊断块里的两条提示，现在直接在正文上方说明：
  // 用户需要知道「下面这段正文是不是完整」，但不需要看预览/诊断的原始 JSON。
  if (projection.previewState === "not_materialized") {
    return <div className="projection-state not-materialized" role="status">历史记录尚未生成正文预览；正文按当前单侧 Raw 的实际读取结果展示。</div>;
  }
  if (projection.previewState === "limited" || body.previewLimited) {
    return <div className="projection-state limited" role="status">SQLite 辅助预览受限，不代表下方格式化正文不完整。</div>;
  }
  return null;
}

/** 三栏面板头：轨道色 + 标题 + 有界候选数徽章。 */
function WorkbenchPanelHead({ rail, title, sub, count }: {
  rail: "sky" | "orange" | "violet";
  title: string;
  /** 轨道职责副标题：范围 / 事件 / 证据，替代原来的 4px 彩色顶轨。 */
  sub?: string;
  count: number;
}) {
  const mark = rail === "sky"
    ? <ListTree size={13} aria-hidden="true" />
    : rail === "orange"
      ? <Workflow size={13} aria-hidden="true" />
      : <ShieldCheck size={13} aria-hidden="true" />;
  return (
    <header className={`workbench-panel-head rail-${rail}`}>
      <span className="rail-mark" aria-hidden="true">{mark}</span>
      <h2>{title}</h2>
      {sub ? <span className="panel-sub">{sub}</span> : null}
      <span className="panel-count-badge" title={`候选 ${count} 项`}>{count}</span>
    </header>
  );
}

/**
 * 连接线箭头路径：左段为与选中行等高的实心色带，向右逐渐收拢为圆润的粗箭头尖端。
 * 约束：尖端抵住右栏边框；收拢段占 connector 宽度的一半左右，圆滑无尖角。
 */
function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

/**
 * 会话树搜索结果：按「供应商 × Agent」分组展示匹配 Session，
 * 每个会话直接展开 Thread（含 Turn 数）与 Turn 列表，点击 Turn 即进入该范围。
 */
function TreeSearchResults({
  query,
  result,
  loading,
  error,
  nowMs,
  onSelectSession,
  onSelectThread,
  onSelectTurn,
  onRetry,
}: {
  query: string;
  result?: WorkbenchSessionSearchResult;
  loading: boolean;
  error: string;
  nowMs: number;
  onSelectSession: (group: WorkbenchSessionSearchGroup, sessionId: string) => void;
  onSelectThread: (group: WorkbenchSessionSearchGroup, sessionId: string, threadId: string) => void;
  onSelectTurn: (group: WorkbenchSessionSearchGroup, sessionId: string, threadId: string, turnId: string) => void;
  onRetry: () => void;
}) {
  if (loading && !result) {
    return <p className="tree-inline-status" role="status">正在搜索 Session…</p>;
  }
  if (error) {
    return (
      <div className="tree-inline-error" role="alert">
        <span>{error}</span>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (!result) return null;
  if (result.groups.length === 0) {
    return <EmptyState text={`没有匹配 “${query}” 的 Session`} />;
  }
  return (
    <div className="tree-search-results" role="list" aria-label="会话搜索结果">
      <p className="tree-search-summary" role="status">
        匹配 {result.candidateCount} 个 Session
        {result.limited ? ` · 仅显示前 ${result.processedCount} 个` : ""}
        {loading ? " · 更新中…" : ""}
      </p>
      {result.groups.map(group => (
        <div key={searchGroupKey(group)} className="tree-group">
          <div className="tree-row tree-agent" data-tree-level="agent">
            <span className="tree-chevron-spacer" aria-hidden="true" />
            <span className="tree-row-main">
              <span className="tree-dot" aria-hidden="true" />
              <span className="tree-label">{group.agentName}</span>
              <TreeNodeMeta
                countLabel={`${group.sessions.length} session`}
                endTime={latestSearchSessionEndTime(group.sessions)}
                nowMs={nowMs}
              />
            </span>
          </div>
          <div className="tree-children tree-children-session">
            {group.sessions.map(session => (
              <div key={session.id} className="tree-session-branch">
                <div className="tree-row tree-session" data-tree-level="session">
                  <span className="tree-chevron-spacer" aria-hidden="true" />
                  <button
                    type="button"
                    className="tree-row-main"
                    title={`内部 Session: ${session.id}${session.externalSessionId ? `\n外部 Session: ${session.externalSessionId}` : ""}`}
                    onClick={() => onSelectSession(group, session.id)}
                  >
                    <span className="tree-dot" aria-hidden="true" />
                    <span className="tree-label">
                      {compactHierarchicalId(session.externalSessionId || session.id)}
                    </span>
                    <TreeNodeMeta
                      countLabel={`${session.threadCount} thread`}
                      endTime={session.endTime}
                      nowMs={nowMs}
                    />
                  </button>
                </div>
                <div className="tree-children tree-children-session-threads">
                  {session.threads.map(thread => (
                    <div key={thread.id} className="tree-search-thread">
                      <button
                        type="button"
                        className={`tree-row tree-thread-search${thread.isRoot ? "" : " child"}`}
                        data-tree-level="thread"
                        onClick={() => onSelectThread(group, session.id, thread.id)}
                      >
                        <span className="tree-dot" aria-hidden="true" />
                        <span className="tree-label">{thread.displayName}</span>
                        <span className="tree-meta">{thread.turnCount} turn</span>
                      </button>
                      {thread.turns.length > 0 ? (
                        <div className="tree-children-turn">
                          {thread.turns.map(turn => (
                            <button
                              key={turn.id}
                              type="button"
                              className="tree-row tree-turn"
                              title={`打开 Turn（${turn.stepCount} step）`}
                              onClick={() => onSelectTurn(group, session.id, thread.id, turn.id)}
                            >
                              <span className="tree-dot" aria-hidden="true" />
                              <span className="tree-label">
                                Turn · {compactHierarchicalId(turn.id)}
                              </span>
                              <span className="tree-meta">
                                {turn.stepCount} step · {formatRelativeLocalTime(turn.endTime, nowMs)}
                              </span>
                            </button>
                          ))}
                          {thread.turnsLimited ? (
                            <span className="tree-inline-status">
                              仅显示最新 {thread.turns.length}/{thread.turnCount} 个 Turn
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {session.threadsLimited ? (
                    <span className="tree-inline-status">
                      仅显示最新 {session.threads.length}/{session.threadCount} 个 Thread
                    </span>
                  ) : null}
                  {session.threads.length === 0 ? (
                    <span className="tree-inline-status">该 Session 暂无 Thread</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function IconButton({ label, icon, onClick, active }: { label: string; icon: React.ReactNode; onClick: () => void; active: boolean }) {
  return (
    <button type="button" className={`icon-button ${active ? "copied" : ""}`} onClick={onClick} title={label} aria-label={label}>
      {icon}
    </button>
  );
}

function ColumnResizeHandle({ column, collapsed, label, onToggle, onDragStart }: {
  column: CollapsibleColumn;
  collapsed: boolean;
  label: string;
  onToggle: (column: CollapsibleColumn) => void;
  onDragStart: (column: CollapsibleColumn, event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`column-resize-handle ${collapsed ? "collapsed" : ""}`}
      data-column-handle={column}
      onPointerDown={event => onDragStart(column, event)}
    >
      <button
        type="button"
        className={`collapse-column-button ${collapsed ? "collapsed" : ""}`}
        aria-label={collapsed ? `展开${label}` : `收起${label}`}
        title={collapsed ? `展开${label}` : `收起${label}`}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => onToggle(column)}
      >
        {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
      </button>
      <span className="resize-grip" aria-hidden="true"><GripVertical size={16} /></span>
    </div>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <EmptyState text="没有 header" />;
  return (
    <div className="headers-wrapper">
      <table className="raw-headers-table">
          <tbody>
            {entries.map(([name, value]) => (
              <tr key={name}>
              <td className="hdr-name">{name}</td>
              <td className="hdr-value">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
    </div>
  );
}

interface WorkbenchMediaRenderContext {
  exchangeId: string;
  side: WorkbenchRawInspectorSide;
  media: WorkbenchRawInspectorMedia[];
}

/**
 * 完整 Raw 查看器（v5）：与「格式化 JSON」同一套深色代码面与工具栏。
 * - 展开全部 / 折叠全部：控制超长行是否完整展开（原始 JSON 常是一整行几万字符）；
 * - 复制全部：复制完整正文（不受折叠影响）；
 * - 全屏：由外层 RawSection 的 allowFullscreen 提供。
 */
/** 完整 Raw 的默认渲染预算（字符）：正文内 2000 字符，点「展开全部」后完整渲染。 */
const RAW_INLINE_PREVIEW_CHARS = 2000;

function RawTextLineViewer({ text, mediaContext }: {
  text: string;
  mediaContext: WorkbenchMediaRenderContext;
}) {
  const [expandAll, setExpandAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const preview = useMemo(
    () => (expandAll || text.length <= RAW_INLINE_PREVIEW_CHARS
      ? text
      : text.slice(0, RAW_INLINE_PREVIEW_CHARS)),
    [expandAll, text],
  );
  const lines = useMemo(() => preview.split(/\r?\n/), [preview]);
  const hiddenChars = text.length - preview.length;
  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时保持静默：正文可手动选中复制。
    }
  }, [text]);
  return (
    <div className="json-code-shell">
      <div className="json-code-toolbar">
        <button type="button" className="json-code-action" onClick={() => setExpandAll(true)}>展开全部</button>
        <button type="button" className="json-code-action" onClick={() => setExpandAll(false)}>折叠全部</button>
        <button type="button" className={`json-code-action${copied ? " copied" : ""}`} onClick={() => void copyAll()}>
          {copied ? "已复制" : "复制全部"}
        </button>
      </div>
      <div className="json-code-viewer raw-text-lines">
        {lines.map((line, index) => (
          <div className="json-code-line" key={index}>
            <span className="json-code-line-number">{index + 1}</span>
            <span className="json-code-gutter"><span className="json-code-fold-placeholder" /></span>
            <span className="json-code-content">
              {line
                ? <WorkbenchRawMediaText segments={splitWorkbenchRawMediaText(line)} mediaContext={mediaContext} />
                : " "}
            </span>
          </div>
        ))}
        {hiddenChars > 0 ? (
          <div className="json-truncation-notice">
            共 {text.length.toLocaleString()} 字符，已省略后续 {hiddenChars.toLocaleString()} 字符…
            <button type="button" className="json-code-action" onClick={() => setExpandAll(true)}>
              显示全部
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkbenchRawTextViewer({ text, mediaContext }: {
  text: string;
  mediaContext: WorkbenchMediaRenderContext;
}) {
  return (
    <pre className="raw-text-viewer workbench-media-text">
      <WorkbenchRawMediaText
        segments={splitWorkbenchRawMediaText(text)}
        mediaContext={mediaContext}
      />
    </pre>
  );
}

function WorkbenchRawMediaText({ segments, mediaContext, jsonString = false, compact = false }: {
  segments: WorkbenchRawMediaTextSegment[];
  mediaContext: WorkbenchMediaRenderContext;
  jsonString?: boolean;
  compact?: boolean;
}) {
  const visibleSegments = compact
    ? compactWorkbenchMediaSegments(segments)
    : segments;
  return visibleSegments.map((segment, index) => segment.kind === "text" ? (
    <Fragment key={`text-${index}`}>
      {jsonString ? escapeJSONTreeString(segment.value) : segment.value}
    </Fragment>
  ) : (
    <WorkbenchRawMediaToken
      key={`media-${segment.ordinal}-${segment.sha256}-${index}`}
      marker={segment}
      mediaContext={mediaContext}
    />
  ));
}

function WorkbenchRawMediaToken({ marker, mediaContext }: {
  marker: Extract<WorkbenchRawMediaTextSegment, { kind: "media" }>;
  mediaContext: WorkbenchMediaRenderContext;
}) {
  const descriptor = findWorkbenchRawMediaDescriptor(marker, mediaContext.media);
  const ordinalLabel = `#${marker.ordinal + 1}`;
  if (!descriptor) {
    return (
      <span className="raw-media-token unavailable" role="img" aria-label={`图片 ${ordinalLabel} 不可查看`} title="缺少匹配的持久化媒体描述符">
        <ImageIcon size={14} aria-hidden="true" />
        <span>图片 {ordinalLabel} · 不可查看</span>
      </span>
    );
  }
  const label = `${descriptor.viewable ? "图片" : "媒体"} ${ordinalLabel} · ${descriptor.mediaType} · ${formatSize(descriptor.decodedBytes)}`;
  if (!descriptor.viewable) {
    return (
      <span className="raw-media-token unavailable" role="img" aria-label={`${label}，不可查看`} title="该媒体类型不在安全图片白名单中">
        <ImageIcon size={14} aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <a
      className="raw-media-token"
      href={buildRawMediaHref(mediaContext.exchangeId, mediaContext.side, descriptor.ordinal)}
      target="_blank"
      rel="noreferrer"
      aria-label={`${label}，在新标签页查看`}
      title="在新标签页查看图片"
    >
      <ImageIcon size={14} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}

function compactWorkbenchMediaSegments(
  segments: WorkbenchRawMediaTextSegment[],
): WorkbenchRawMediaTextSegment[] {
  const textSegments = segments.filter(
    (segment): segment is Extract<WorkbenchRawMediaTextSegment, { kind: "text" }> => segment.kind === "text",
  );
  const totalCharacters = textSegments.reduce((total, segment) => total + segment.value.length, 0);
  if (totalCharacters <= 240) return segments;
  const perSegmentBudget = Math.max(12, Math.floor(240 / Math.max(1, textSegments.length)));
  return segments.map(segment => {
    if (segment.kind === "media" || segment.value.length <= perSegmentBudget) return segment;
    const headLength = Math.ceil(perSegmentBudget / 2);
    const tailLength = Math.floor(perSegmentBudget / 2);
    return {
      kind: "text",
      value: `${segment.value.slice(0, headLength)}... (${segment.value.length} chars) ...${segment.value.slice(-tailLength)}`,
    };
  });
}

/** 全屏查看时会重新挂载一份子内容；查看器据此放宽默认渲染行数。 */
const RawFullscreenContext = createContext(false);

/** 默认渲染预算：正文内 100 行 / 全屏 2000 行（用户确认）。 */
const INLINE_RENDER_LINES = 100;
const FULLSCREEN_RENDER_LINES = 2000;

function useRenderLineLimit(): number {
  return useContext(RawFullscreenContext) ? FULLSCREEN_RENDER_LINES : INLINE_RENDER_LINES;
}

function RawSection({ title, info, defaultOpen = false, renderWhenOpen = false, largeContent = false, allowFullscreen = false, bodyScroll = true, children }: {
  title: string;
  info?: string;
  defaultOpen?: boolean;
  renderWhenOpen?: boolean;
  /** 大内容区块：提供全屏入口。 */
  largeContent?: boolean;
  /** 显式提供全屏入口（原始正文等大内容区块），与 largeContent 等效。 */
  allowFullscreen?: boolean;
  /** false 时区块体不做内部滚动（如 Headers），完整展开交给外层页面滚动。 */
  bodyScroll?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);
  const canFullscreen = largeContent || allowFullscreen;
  const renderedChildren = renderWhenOpen ? (open ? children : null) : children;
  const sectionBody = (
    <div className={`raw-section-body${open ? "" : " collapsed"}${bodyScroll ? "" : " no-scroll"}`}>
      {renderedChildren}
    </div>
  );
  return (
    <>
      <section className={`raw-section${fullscreen ? " fullscreen" : ""}`}>
        <button
          type="button"
          className="raw-section-header"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
        >
          <span className={`section-toggle ${open ? "open" : ""}`}>▶</span>
          <span>{title}</span>
          <span className="section-header-actions">
            {info ? <small>{info}</small> : null}
            {canFullscreen ? (
              <span
                role="button"
                tabIndex={0}
                className="fullscreen-action"
                onClick={event => {
                  event.stopPropagation();
                  setOpen(true);
                  setFullscreen(true);
                }}
                onKeyDown={event => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(true);
                  setFullscreen(true);
                }}
              >
                <Maximize2 size={13} />
                全屏查看
              </span>
            ) : null}
          </span>
        </button>
        {sectionBody}
      </section>
      {fullscreen ? (
        <div className="fullscreen-section-backdrop" role="dialog" aria-modal="true" aria-label={`${title} 全屏查看`}>
          <section className="fullscreen-section-shell raw-section fullscreen">
            <div className="fullscreen-section-header">
              <strong>{title}</strong>
              <button type="button" className="fullscreen-action restore" onClick={() => setFullscreen(false)}>
                <Minimize2 size={14} />
                退出全屏
              </button>
            </div>
            <div className="raw-section-body">
              <RawFullscreenContext.Provider value={true}>{children}</RawFullscreenContext.Provider>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function TokenUsagePanel({ usage, contextWindow }: {
  usage: TokenUsageSummary;
  /** 命中价格条目的上下文窗口（tokens）；随计价快照冻结，旧数据缺省。 */
  contextWindow?: number;
}) {
  const hasUsage = usage.source === "provider_usage";
  const isEstimated = usage.source === "estimated" || usage.source === "tokenizer_estimated" || usage.source === "heuristic_estimated";
  const panelClass = hasUsage ? "" : isEstimated ? "estimated" : "unavailable";
  // 上下文容量占比 = 总 Token / 上下文窗口（2026-09-19 用户确认口径），保留 1 位小数。
  const totalTokens = usage.totalTokens;
  const contextUsageRatio = contextWindow && contextWindow > 0 && totalTokens !== undefined
    ? `${((totalTokens / contextWindow) * 100).toFixed(1)}%`
    : undefined;
  return (
    <section className={`token-usage-panel ${panelClass}`}>
      <header>
        <span>Token 用量</span>
      </header>
      <div className="token-usage-grid">
        <Fact label="非缓存输入" value={formatTokenCount(usage.inputTokens)} />
        <Fact label="缓存读取" value={formatTokenCount(usage.cacheReadTokens)} />
        <Fact label="缓存写入" value={formatTokenCount(usage.cacheCreationTokens)} />
        <Fact label="输出 Token" value={formatTokenCount(usage.outputTokens)} />
        <Fact label="推理 Token" value={formatTokenCount(usage.reasoningTokens)} />
        <Fact label="总 Token" value={formatTokenCount(totalTokens)} />
        <Fact label="缓存命中占比" value={formatCacheHitRatio(usage)} />
        {contextWindow !== undefined ? (
          <Fact
            label="上下文窗口（K）"
            value={formatContextWindowK(contextWindow)}
            title={`模型支持的上下文窗口：${formatTokenCount(contextWindow)} tokens`}
          />
        ) : null}
        {contextUsageRatio ? (
          <Fact
            label="上下文容量占比"
            value={contextUsageRatio}
            title={`总 Token / 上下文窗口（${formatTokenCount(totalTokens)} / ${formatTokenCount(contextWindow)}）`}
          />
        ) : null}
      </div>
    </section>
  );
}

/** 首字耗时展示：无数据显示 -；<1s 毫秒，≥1s 秒。 */
function formatFirstTokenLatency(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

/**
 * 本 Turn 请求总耗时（2026-09-20 用户确认口径，全 Agent 通用）：该 Turn 下
 * 最后一次 Step 的请求结束时间 − 第一次 Step 的请求开始时间（Step 墙钟）。
 * 全部 Step 已加载时按墙钟精确计算，分页未加载完时退化为已加载请求耗时之和。
 * 随版本轮询刷新，本 Turn 仍在产出时读数会持续跟随变化。不到一分钟按秒，
 * 到分钟按「X 分 Y 秒」展示。
 */
function turnTotalDurationLabel(
  steps: AgentStep[],
  page: { candidateCount: number } | undefined,
): string {
  if (steps.length === 0) return "-";
  const fullyLoaded = page ? steps.length >= page.candidateCount : true;
  if (fullyLoaded) {
    const start = Math.min(...steps.map(step => Date.parse(step.timestamp)));
    const end = Math.max(
      ...steps.map(step => Date.parse(step.timestamp) + (step.durationMs ?? 0)),
    );
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return formatTurnWallDuration(end - start);
    }
  }
  return formatTurnWallDuration(
    steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0),
  );
}

function formatTurnWallDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

/** 缓存命中占比 = cache_read / (input + cache_read + cache_write)；三者为 0 时无数据。 */
function formatCacheHitRatio(usage: TokenUsageSummary): string | undefined {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheCreationTokens ?? 0;
  const input = usage.inputTokens ?? 0;
  const total = read + write + input;
  if (total <= 0) return undefined;
  return `${(read / total * 100).toFixed(1)}%`;
}

const RESULT_CLASS_LABELS: Record<string, string> = {
  success: "成功",
  upstream_error: "上游错误",
  client_error: "客户端错误",
  cancelled: "已取消",
  incomplete: "未完成",
  reconciled: "已对账",
  unknown: "未知",
};

function resultClassLabel(step: AgentStep): string | undefined {
  if (!step.resultClass) {
    return step.phase === "error" ? "错误" : undefined;
  }
  return RESULT_CLASS_LABELS[step.resultClass] ?? step.resultClass;
}

function compactionPreviewLabel(preview: NonNullable<AgentStep["compactionPreview"]>): string {
  const source = preview.kind === "purpose_header"
    ? "官方 purpose 头"
    : `续接摘要（${preview.markerKind === "codex_summary" ? "codex 形态" : "claude/zcode 形态"}）`;
  return `${source} · ${preview.preview.slice(0, 80)}`;
}

/** P1：模型参数白名单值展示（reasoning effort / thinking 预算 / max_tokens 等）。 */
function OverviewParamsSection({ params, contextWindow }: {
  params?: Record<string, unknown>;
  /** 命中价格条目的上下文窗口（tokens）；随计价快照冻结，旧数据缺省。 */
  contextWindow?: number;
}) {
  const entries = Object.entries(params ?? {}).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0 && contextWindow === undefined) return null;
  return (
    <section className="overview-params-panel">
      <header>
        <span>模型参数</span>
      </header>
      <div className="fact-grid">
        {contextWindow !== undefined ? (
          <Fact
            label="上下文窗口（K）"
            value={formatContextWindowK(contextWindow)}
            title={`模型支持的上下文窗口：${formatTokenCount(contextWindow)} tokens`}
          />
        ) : null}
        {entries.slice(0, 16).map(([key, value]) => (
          <Fact
            key={key}
            label={paramLabel(key)}
            value={typeof value === "object"
              ? formatParamObject(key, value as Record<string, unknown>)
              : formatParamValue(value)}
            title={key}
          />
        ))}
      </div>
    </section>
  );
}

/** 模型参数键 → 中文标题（白名单见 harness/param-details.ts；未收录键原样展示并悬浮原始键名）。 */
const PARAM_LABELS: Record<string, string> = {
  "max_tokens": "最大输出 Token",
  "max_output_tokens": "最大输出 Token",
  "max_completion_tokens": "最大补全 Token",
  "temperature": "温度",
  "top_p": "Top P",
  "parallel_tool_calls": "并行工具调用",
  "store": "存储",
  "stream": "流式输出",
  "service_tier": "服务层级",
  "prompt_cache_key": "缓存键",
  "previous_response_id": "前序响应 ID",
  "reasoning": "推理力度",
  "thinking": "思考模式",
  "text": "文本输出",
  "output_config": "输出配置",
  "tool_choice": "工具选择",
};

/** 一层对象参数的子键 → 中文。 */
const PARAM_SUB_LABELS: Record<string, string> = {
  "effort": "力度",
  "summary": "摘要",
  "type": "类型",
  "budget_tokens": "预算 Token",
  "verbosity": "详细度",
  "name": "工具名",
  "disable_parallel_tool_use": "禁用并行",
};

function paramLabel(key: string): string {
  return PARAM_LABELS[key] ?? key;
}

function formatParamValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "-";
  } catch {
    return "-";
  }
}

function formatParamObject(key: string, value: Record<string, unknown>): string {
  const parts = Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([subKey, item]) => `${PARAM_SUB_LABELS[subKey] ?? subKey} ${formatParamValue(item)}`);
  return parts.length > 0 ? parts.join(" · ") : formatParamValue(value);
}

/** 上下文窗口按 1024 折算为 K（131072 → 128），不足 1K 原样展示。 */
function formatContextWindowK(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "-";
  if (tokens < 1024) return String(tokens);
  return `${Math.round(tokens / 1024)}K`;
}

function PricingCostPanel({ step }: { step?: AgentStep }) {
  const snapshot = step?.pricingSnapshot;
  const cost = step?.tokenCost;
  const panelClass = cost?.priced ? "" : "unavailable";
  // 公式时刻/份额链按右上角全局时区展示（2026-10-09 B2）。
  const globalTz = useGlobalTimeZone();

  const realCost = estimatedRealCostOf(step, globalTz.iana);
  // ？浮窗公式（2026-09-23）：与 Token 价格页明细共用同一公式函数与浮窗组件；
  // 供应商成本/按量倍率后成本 是原币种分解视图，套餐行的 估算真实成本 走套餐公式。
  const formulaItem = costFormulaItemOfStep(step);
  return (
    <section className={`pricing-cost-panel ${panelClass}`}>
      <header>
        <span>价格成本</span>
      </header>
      <div className="pricing-cost-grid">
        <Fact label="价格条目" value={snapshot?.matchedModel} />
        <Fact label="供应商" value={snapshot?.vendor} />
        <Fact label="匹配方式" value={snapshot ? pricingMatchStrategyLabel(snapshot.matchStrategy) : undefined} />
        <RateFact label="非缓存输入价" base={snapshot?.baseRates?.input} effective={snapshot?.effectiveRates?.input} currency={cost?.currency} />
        <RateFact label="缓存命中价" base={snapshot?.baseRates?.cachedInput} effective={snapshot?.effectiveRates?.cachedInput} currency={cost?.currency} />
        <RateFact label="缓存写入价" base={snapshot?.baseRates?.cacheWrite} effective={snapshot?.effectiveRates?.cacheWrite} currency={cost?.currency} />
        <RateFact label="输出价" base={snapshot?.baseRates?.output} effective={snapshot?.effectiveRates?.output} currency={cost?.currency} />
        <RateFact label="reasoning价" base={snapshot?.baseRates?.reasoning} effective={snapshot?.effectiveRates?.reasoning} currency={cost?.currency} />
        <Fact label="价格倍率" value={snapshot ? `${snapshot.rateMultiplier}x` : undefined} />
        <Fact
          label="供应商成本"
          value={formatCostValue(cost?.officialTotalCost, cost?.currency, 6)}
          tone="money"
          help={formulaItem ? <CostHelp formula={costDetailFormula(formulaItem)} label="供应商成本计算过程" /> : undefined}
        />
        <Fact
          label="按量倍率后成本"
          value={formatCostValue(cost?.totalCost, cost?.currency, 6)}
          tone="money"
          help={formulaItem ? <CostHelp formula={multipliedCostDetailFormula(formulaItem)} label="按量倍率后成本计算过程" /> : undefined}
        />
        <Fact
          label={realCost?.label ?? "估算真实成本"}
          value={realCost?.value}
          tone="money"
          title={realCost?.hint}
          help={realCost?.formula ? <CostHelp formula={realCost.formula} label={`${realCost.label}计算过程`} /> : undefined}
        />
      </div>
      {/* 歧义候选提示：仅有候选时渲染，避免空行撑出额外底部留白（2026-09-19 用户反馈） */}
      {snapshot?.ambiguousCandidates?.length ? (
        <p>{`候选模型歧义：${snapshot.ambiguousCandidates.map(item => `${item.vendor}/${item.id}`).slice(0, 5).join("、")}`}</p>
      ) : null}
    </section>
  );
}

/**
 * 估算真实成本（2026-09-23 用户确认统一口径，全通道共用一个字段）：
 * - 按量通道：按量倍率后成本 × 入账冻结结算系数（人民币）；DeepSeek 等 1:1 结算时
 *   与 供应商成本/按量倍率后成本 三值相等，中转站（如 auto-code ×1/16）三值互异；
 * - 套餐/订阅通道：= 套餐成本估算的值，文案标注「估算真实成本（套餐成本估算）」；
 *   ？浮窗显示套餐积分换算公式（入账快照冻结），绝不冒充按量链公式。
 */
function estimateNoteContextForStep(step: AgentStep, timeZone: string): Parameters<typeof planEstimateConversionNote>[3] {
  /* 份额全链路（2026-10-09 B3）：行市价 = 账本人民币物化（=reference_cost），
     四项分解 = 快照牌价 × token 数（原币种）。 */
  const rowMarketCny = step.tokenCost?.totalCostCny;
  const rates = step.pricingSnapshot?.baseRates;
  const usage = step.tokenUsage;
  if (rowMarketCny === undefined || !rates || !usage) {
    return {timeZone};
  }
  return {
    timeZone,
    rowMarketCny,
    marketCurrency: step.tokenCost?.currency,
    marketComponents: [
      {label: "非缓存输入", unitPrice: rates.input, tokens: usage.inputTokens ?? 0, cost: (usage.inputTokens ?? 0) * (rates.input ?? 0) / 1e6},
      {label: "缓存读取", unitPrice: rates.cachedInput, tokens: usage.cacheReadTokens ?? 0, cost: (usage.cacheReadTokens ?? 0) * (rates.cachedInput ?? 0) / 1e6},
      {label: "缓存写入", unitPrice: rates.cacheWrite, tokens: usage.cacheCreationTokens ?? 0, cost: (usage.cacheCreationTokens ?? 0) * (rates.cacheWrite ?? 0) / 1e6},
      {label: "输出", unitPrice: rates.output, tokens: usage.outputTokens ?? 0, cost: (usage.outputTokens ?? 0) * (rates.output ?? 0) / 1e6},
    ],
  };
}

function estimatedRealCostOf(step?: AgentStep, timeZone?: string): { label: string; value: string; hint?: string; formula?: string } | undefined {
  if (!step) return undefined;
  const channel = step.billingChannel ?? "pay_as_you_go";
  if (channel === "plan" || channel === "subscription") {
    const snapshot = step.pricingSnapshot;
    // ？公式两段拼接（2026-09-23 用户确认）：积分计算公式 + 积分→金额换算链
    // （月费×消耗比率×窗口天数，入账冻结），与 Token 价格页明细完全同源同文。
    const creditFormula = snapshot?.planCreditFormulaDetail ?? snapshot?.planCreditFormula
      ?? (step.planCreditCost !== undefined
        ? `套餐/订阅通道：积分消耗 ${step.planCreditCost} ${step.planCreditUnit ?? ""}，按入账时冻结的换算折算为人民币`
        : undefined);
    /* 人民币口径（2026-09-28 修复，与 Token 价格页同值）：入账 nano 物化优先；
       极旧行缺 nano 时按 原币 × 入账冻结汇率 折算；两者皆缺回退原币值并如实标注币种
       （USD 套餐的 planEstimatedCost 是美元原币，绝不能直接当人民币展示）。 */
    const nanoCny = step.planEstimatedCostNano !== undefined && Number.isFinite(step.planEstimatedCostNano)
      ? step.planEstimatedCostNano / 1e9
      : undefined;
    const fallbackCny = nanoCny === undefined
      && typeof step.planEstimatedCost === "number"
      && Number.isFinite(step.planEstimatedCost)
      && step.planEstimatedFx !== undefined && Number.isFinite(step.planEstimatedFx) && step.planEstimatedFx > 0
        ? step.planEstimatedCost * step.planEstimatedFx
        : undefined;
    const cnyValue = nanoCny ?? fallbackCny;
    const conversion = step.planEstimateDetail && cnyValue !== undefined
      ? planEstimateConversionNote(
          step.planEstimateDetail, cnyValue, step.planEstimatedCurrency,
          timeZone ? estimateNoteContextForStep(step, timeZone) : undefined,
        )
      : undefined;
    const formula = [creditFormula, conversion].filter(Boolean).join("\n") || undefined;
    if (step.planEstimatedStatus === "estimated" && typeof step.planEstimatedCost === "number") {
      if (cnyValue !== undefined) {
        return {
          label: "估算真实成本（套餐成本估算）",
          value: formatCostValue(cnyValue, "CNY", 6),
          hint: `套餐/订阅通道：套餐成本估算的人民币口径（月费币种 ${step.planEstimatedCurrency ?? "CNY"} × 入账冻结汇率物化），与 Token 价格页同值`,
          formula,
        };
      }
      return {
        label: "估算真实成本（套餐成本估算）",
        value: formatCostValue(step.planEstimatedCost, step.planEstimatedCurrency, 6),
        hint: `套餐/订阅通道：入账快照缺少人民币物化值，展示月费原币种数值（${step.planEstimatedCurrency ?? "CNY"}）`,
        formula,
      };
    }
    return {
      label: "估算真实成本（套餐成本估算）",
      value: "估算不可用",
      hint: "套餐/订阅通道：额度或月费快照未同步，成本估算暂不可完整",
      formula,
    };
  }
  // 人民币口径优先（账本物化列 / 原币种 × 冻结结算系数）；极旧行无 fx 信息时回退
  // 原币种值（fx=1 时代数值不变）。
  const totalCny = step.tokenCost?.totalCostCny;
  if (totalCny !== undefined && Number.isFinite(totalCny)) {
    return {
      label: "估算真实成本",
      value: formatCostValue(totalCny, "CNY", 6),
      hint: "按量通道：倍率后实际成本 × 入账时冻结的结算系数（人民币口径），口径同 Token 价格页「估算真实成本」",
      formula: actualCostDetailFormulaSafe(step),
    };
  }
  const total = step.tokenCost?.totalCost;
  if (total === undefined || !Number.isFinite(total)) return undefined;
  return {
    label: "估算真实成本",
    value: formatCostValue(total, step.tokenCost?.currency, 6),
    hint: "按量通道：倍率后的实际成本（极旧行无冻结结算系数，原币种数值），口径同 Token 价格页「估算真实成本」",
    formula: actualCostDetailFormulaSafe(step),
  };
}

/** 按量通道的完整折算链公式；快照缺费率（无法组装公式）时返回 undefined（不渲染 ？）。 */
function actualCostDetailFormulaSafe(step: AgentStep): string | undefined {
  const item = costFormulaItemOfStep(step);
  return item ? actualCostDetailFormula(item) : undefined;
}

/**
 * Step → 成本公式浮窗输入（2026-09-23）：与 Token 价格页明细共用同一组公式函数
 * （token-pricing-display）。单价取快照 baseRates 并按派生同规则复算长上下文档位，
 * 分项 = Token × 单价；倍率/结算系数/人民币金额取账本冻结值，保证浮窗与页面数字自洽。
 */
function costFormulaItemOfStep(step?: AgentStep): CostFormulaItem | undefined {
  const usage = step?.tokenUsage;
  const snapshot = step?.pricingSnapshot;
  const cost = step?.tokenCost;
  if (!usage || !snapshot?.baseRates) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const tier = resolveLongContextRates(snapshot.baseRates, contextTokens);
  const rates = tier?.rates ?? snapshot.baseRates;
  const costOf = (tokens: number, perMillion: number | undefined) =>
    perMillion === undefined ? undefined : (tokens / 1_000_000) * perMillion;
  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    inputUnitPrice: rates.input,
    cacheReadUnitPrice: rates.cachedInput,
    cacheWriteUnitPrice: rates.cacheWrite,
    outputUnitPrice: rates.output,
    inputCost: costOf(inputTokens, rates.input),
    cacheReadCost: costOf(cacheReadTokens, rates.cachedInput),
    cacheCreationCost: costOf(cacheCreationTokens, rates.cacheWrite),
    outputCost: costOf(outputTokens, rates.output),
    vendorCost: cost?.officialTotalCost,
    actualCost: cost?.totalCost,
    rateMultiplier: snapshot.rateMultiplier ?? 1,
    fxRateToCny: cost?.fxRateToCny,
    actualCostCny: cost?.totalCostCny,
    currency: cost?.currency,
    ...(tier ? {longContextTier: tier.match} : {}),
  };
}

function RateFact({ label, base, effective, currency }: { label: string; base?: number; effective?: number; currency?: string }) {
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "￥" : "";
  return (
    <div className="fact rate-fact">
      <span>{label}</span>
      <strong className="rate-stack">
        <span>{symbol}{formatRateValue(base)}（供应商价）</span>
        <span>{symbol}{formatRateValue(effective)}（实际价）</span>
      </strong>
    </div>
  );
}

/** 单次渲染的硬上限（与「展开全部」配合：展开后按实际行数渲染，不再截断）。 */
const MAX_RENDER_LINES = 2000;

function JsonCodeViewer({ value, previousValue, highlightedPath, diffMode, mediaContext }: {
  value: unknown;
  previousValue?: unknown;
  highlightedPath?: string;
  diffMode?: "request";
  mediaContext?: WorkbenchMediaRenderContext;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedStringIds, setExpandedStringIds] = useState<Set<string>>(new Set());
  const [showAllLines, setShowAllLines] = useState(false);
  const [copied, setCopied] = useState(false);
  const renderLineLimit = useRenderLineLimit();
  const allLines = useMemo(() => buildJsonCodeLines(value), [value]);
  const truncated = allLines.length > renderLineLimit && !showAllLines;
  const lines = truncated ? allLines.slice(0, renderLineLimit) : allLines;
  const lineDiff = useMemo(() => {
    if (diffMode !== "request" || previousValue === undefined) return undefined;
    return buildJsonLineDiff(previousValue, lines);
  }, [diffMode, previousValue, lines]);

  async function copyAllContent(): Promise<void> {
    const text = typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
    try {
      await navigator.clipboard.writeText(text || "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  }
  const collapsedLineIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const id of collapsed) {
      const start = lines.findIndex(line => line.foldId === id && line.foldStart);
      const end = lines.findIndex((line, index) => index > start && line.foldId === id && line.foldEnd);
      if (start < 0 || end < 0) continue;
      for (let index = start + 1; index <= end; index++) hidden.add(lines[index]!.id);
    }
    return hidden;
  }, [collapsed, lines]);

  function toggleFold(foldId: string) {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(foldId)) next.delete(foldId);
      else next.add(foldId);
      return next;
    });
  }

  function setAllCollapsed(value: boolean) {
    setCollapsed(value
      ? new Set(lines.filter(line => line.foldStart && line.foldId).map(line => line.foldId!))
      : new Set());
  }

  function toggleStringExpanded(lineId: string) {
    setExpandedStringIds(current => {
      const next = new Set(current);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  return (
    <div className="json-code-shell">
      <div className="json-code-toolbar">
        <button
          type="button"
          className="json-code-action"
          onClick={() => {
            setAllCollapsed(false);
            setShowAllLines(true);
          }}
        >
          展开全部
        </button>
        <button type="button" className="json-code-action" onClick={() => setAllCollapsed(true)}>折叠全部</button>
        <button type="button" className={`json-code-action${copied ? " copied" : ""}`} onClick={() => void copyAllContent()}>
          {copied ? "已复制" : "复制全部"}
        </button>
      </div>
      <div className="json-code-viewer">
        {truncated ? (
          <div className="json-truncation-notice">
            内容超过 {renderLineLimit} 行，已省略后续内容…
            <button type="button" className="json-code-action" onClick={() => setShowAllLines(true)}>显示全部 {allLines.length} 行</button>
          </div>
        ) : null}
        {lines.map((line, index) => (
          <Fragment key={line.id}>
            {lineDiff?.removedBeforeLineId.get(line.id)?.map((removedLine, removedIndex) => (
              <JsonRemovedLine key={`${line.id}-removed-${removedIndex}-${removedLine.id}`} line={removedLine} />
            ))}
            <JsonCodeLine
              line={line}
              lineNumber={index + 1}
              hidden={collapsedLineIds.has(line.id)}
              collapsed={line.foldId ? collapsed.has(line.foldId) : false}
              focused={!!highlightedPath && evidencePathMatches(line.path, highlightedPath)}
              stringExpanded={expandedStringIds.has(line.id)}
              diffStatus={lineDiff?.addedLineIds.has(line.id) ? "added" : undefined}
              mediaContext={mediaContext}
              onToggle={toggleFold}
              onToggleString={toggleStringExpanded}
            />
          </Fragment>
        ))}
        {lineDiff?.trailingRemovedLines.map((removedLine, index) => (
          <JsonRemovedLine key={`trailing-removed-${index}-${removedLine.id}`} line={removedLine} />
        ))}
      </div>
    </div>
  );
}

function JsonCodeLine({ line, lineNumber, hidden, collapsed, focused, stringExpanded, diffStatus, mediaContext, onToggle, onToggleString }: {
  line: JsonLine;
  lineNumber: number;
  hidden: boolean;
  collapsed: boolean;
  focused: boolean;
  stringExpanded: boolean;
  diffStatus?: "added";
  mediaContext?: WorkbenchMediaRenderContext;
  onToggle: (foldId: string) => void;
  onToggleString: (lineId: string) => void;
}) {
  const content = stringExpanded && line.fullStringContent ? line.fullStringContent : line.content;
  const baseClassName = diffStatus === "added" ? "json-code-line added-diff" : "json-code-line";
  return (
    <div
      className={`${baseClassName}${hidden ? " hidden-by-fold" : ""}${collapsed ? " collapsed" : ""}${focused ? " focused-evidence" : ""}${stringExpanded ? " expanded-string" : ""}`}
      data-line={lineNumber}
      data-json-path={line.path}
      data-depth={line.depth}
      data-fold={line.foldId}
      data-fold-start={line.foldStart ? line.foldId : undefined}
      data-fold-end={line.foldEnd ? line.foldId : undefined}
    >
      <span className="json-code-line-number">{lineNumber}</span>
      <span className="json-code-gutter">
        {line.foldStart && line.foldId ? (
          <button type="button" className="json-code-fold" onClick={() => onToggle(line.foldId!)}>
            {collapsed ? "▶" : "▼"}
          </button>
        ) : <span className="json-code-fold-placeholder" />}
      </span>
      <span className="json-code-content" style={{ "--depth": line.depth } as React.CSSProperties}>
        {line.prefix ? <span dangerouslySetInnerHTML={{ __html: line.prefix }} /> : null}
        {line.mediaSegments && mediaContext && !collapsed ? (
          <span className="json-string">
            &quot;<WorkbenchRawMediaText
              segments={line.mediaSegments}
              mediaContext={mediaContext}
              jsonString
              compact={!stringExpanded}
            />&quot;
          </span>
        ) : (
          <span dangerouslySetInnerHTML={{ __html: collapsed && line.collapsedPreview ? line.collapsedPreview : content }} />
        )}
        {(line.fullStringContent && line.truncatedStringContent || line.mediaStringExpandable) && !collapsed ? (
          <button type="button" className="json-string-expand" onClick={() => onToggleString(line.id)}>
            {stringExpanded ? "收起完整内容" : "查看完整内容"}
          </button>
        ) : null}
        {collapsed && line.collapsedChildCount !== undefined ? (
          <span className="json-code-count">{line.collapsedChildCount} {line.collapsedChildKind}</span>
        ) : null}
        {diffStatus === "added" ? <span className="json-diff-badge added">新增</span> : null}
        {displayLineSuffix(line, collapsed) ? <span className="json-code-comma">{displayLineSuffix(line, collapsed)}</span> : null}
      </span>
    </div>
  );
}

function JsonRemovedLine({ line }: { line: JsonLine }) {
  return (
    <div className="json-code-line json-diff-removed-row" data-json-path={line.path} data-depth={line.depth}>
      <span className="json-code-line-number removed-placeholder" aria-label="removed lines do not consume current request line numbers" />
      <span className="json-code-gutter"><span className="json-code-fold-placeholder" /></span>
      <span className="json-code-content" style={{ "--depth": line.depth } as React.CSSProperties}>
        {line.prefix ? <span dangerouslySetInnerHTML={{ __html: line.prefix }} /> : null}
        <span dangerouslySetInnerHTML={{ __html: line.content }} />
        <span className="json-diff-badge removed">上次有，本次无</span>
        {line.suffix ? <span className="json-code-comma">{line.suffix}</span> : null}
      </span>
    </div>
  );
}

function ActionButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`secondary-button ${active ? "copied" : ""}`} onClick={onClick}>
      <Copy size={14} />
      <span>{active ? "已复制" : label}</span>
    </button>
  );
}

/**
 * 上下文分层卡片（2026-09-11）：把「喂了什么」拆成可逐层展开的六层，
 * 每层给出规模（条数与 tokens 估算）与「查看原文 →」跳转到交互内容并按层过滤。
 * 全部数据来自已加载的 SQLite 投影与能力清单，不额外请求、不读 raw。
 */
function ContextLayerCards({
  snapshot,
  harness,
  step,
  calibrated,
  onOpenHarness,
  onOpenInteraction,
}: {
  snapshot: WorkbenchContextSnapshot;
  harness?: ApiAgentStepHarness;
  step?: AgentStep;
  calibrated?: ContextComposition["calibratedTokens"] | ContextComposition["estTokens"];
  onOpenHarness?: () => void;
  onOpenInteraction?: (filter: {categories?: ConversationCategory[]; toolName?: string}) => void;
}) {
  const summary = snapshot.harnessSummary;
  const tools = harness?.inventory.tools ?? [];
  const skills = harness?.inventory.skills ?? [];
  const rules = harness?.inventory.rules ?? [];
  const kindCounts = summary.conversationKindCounts ?? {};
  const toolResultCount = kindCounts.tool_result ?? summary.providedToolResults.length;
  // 部分协议把系统提示以 message(role=system) 注入：归入「系统提示」层，不重复计入对话层。
  const systemMessageCount = kindCounts.system_text ?? 0;
  const promptBlockCount = summary.systemPrompts.length + summary.developerPrompts.length;
  const conversationCount = Math.max(
    (summary.conversationItemCount ?? 0) - toolResultCount - systemMessageCount,
    0,
  );
  const tokens = (value: number | undefined) => (value && value > 0 ? value.toLocaleString() : "—");
  const openFiltered = (filter: {categories?: ConversationCategory[]; toolName?: string}) => {
    onOpenInteraction?.(filter);
  };

  return (
    <div className="context-layers">
      <LayerCard
        title="系统提示"
        meta={`${promptBlockCount} 块`
          + (systemMessageCount > 0 ? ` + ${systemMessageCount} 条消息注入` : "")
          + ` · ${tokens((calibrated?.system ?? 0) + (calibrated?.developer ?? 0))} tokens`}
        empty={promptBlockCount + systemMessageCount === 0}
        emptyText="本步无系统提示记录"
        action={onOpenInteraction
          ? {label: "查看原文 →", onClick: () => openFiltered({categories: ["system", "developer"]})}
          : undefined}
      >
        {[...summary.systemPrompts, ...summary.developerPrompts].slice(0, 12).map((block, index) => (
          <li key={`${block.textHash}-${index}`} className="layer-item">
            <span className="row-kind mono">{block.textHash.slice(0, 8)}</span>
            {block.providerRole ? <span className="row-role">{block.providerRole}</span> : null}
            <span className="row-preview">{(block.textPreview || "（索引态：正文按需读取）").slice(0, 160)}</span>
          </li>
        ))}
      </LayerCard>

      <LayerCard
        title="规则注入"
        meta={`${rules.length} 条 · ${tokens(calibrated?.rules)} tokens`}
        empty={rules.length === 0}
        emptyText={harness?.legacyData ? "升级前数据：无规则记录" : "本步无 AGENTS.md / CLAUDE.md / permissions 注入"}
        action={onOpenInteraction && rules.length > 0
          ? {label: "查看原文 →", onClick: () => openFiltered({categories: ["user_injected"]})}
          : undefined}
      >
        {rules.slice(0, 12).map((rule, index) => (
          <li key={`${rule.kind}-${rule.path ?? index}`} className="layer-item">
            <span className="row-kind">{ruleBadgeLabel(rule.kind)}</span>
            <span className="row-preview">{rule.path || "—"}</span>
            <span className="row-meta mono">{rule.estTokens.toLocaleString()} tok</span>
          </li>
        ))}
      </LayerCard>

      <LayerCard
        title="Skills 注入"
        meta={`${skills.length} 个 · ${tokens(calibrated?.skills)} tokens`}
        empty={skills.length === 0}
        emptyText={harness?.legacyData ? "升级前数据：无 Skills 记录" : "本步无 Skills 注入名单"}
        action={onOpenInteraction && skills.length > 0
          ? {label: "查看原文 →", onClick: () => openFiltered({categories: ["user_injected"]})}
          : undefined}
      >
        {skills.slice(0, 12).map(skill => (
          <li key={`${skill.name}-${skill.sourceRoot ?? ""}`} className="layer-item">
            <span className="row-kind">{skill.name}</span>
            <span className="row-role">{skillSourceLevelLabel(skill.sourceLevel)}</span>
            {skill.pluginName ? <span className="row-role">{skill.pluginName}</span> : null}
            <span className="row-meta mono">{skill.estTokens.toLocaleString()} tok</span>
          </li>
        ))}
      </LayerCard>

      <LayerCard
        title="工具定义"
        meta={`${tools.length} 个 · ${tokens((calibrated?.toolsNonMcp ?? 0) + (calibrated?.mcp ?? 0))} tokens`
          + (step ? ` · 本步使用 ${tools.filter(tool => tool.invoked).length} 个` : "")}
        empty={tools.length === 0}
        emptyText={harness?.legacyData ? "升级前数据：无工具清单" : "本步无工具定义"}
        action={onOpenHarness ? {label: "完整清单 →", onClick: onOpenHarness} : undefined}
      >
        {tools.filter(tool => tool.invoked).slice(0, 8).map(tool => (
          <li key={`invoked-${tool.name}`} className="layer-item">
            <span className="row-status">✓</span>
            <span className="row-kind">{tool.name}</span>
            {tool.mcpServer ? <span className="row-role">MCP · {tool.mcpServer}</span> : null}
            <span className="row-meta mono">本步 {tool.callsThisStep} 次</span>
            {onOpenInteraction ? (
              <button type="button" className="comp-link" onClick={() => openFiltered({toolName: tool.name})}>
                调用记录 →
              </button>
            ) : null}
          </li>
        ))}
        {tools.filter(tool => !tool.invoked).slice(0, 8).map(tool => (
          <li key={`idle-${tool.name}`} className="layer-item muted">
            <span className="row-status">—</span>
            <span className="row-kind">{tool.name}</span>
            <span className="row-meta mono">{tool.defTokensEst.toLocaleString()} tok 定义</span>
          </li>
        ))}
        {tools.length > 16 ? (
          <li className="layer-item muted">
            <span className="row-preview">…另有 {tools.length - 16} 个工具未展开</span>
          </li>
        ) : null}
      </LayerCard>

      <LayerCard
        title="对话上下文"
        meta={`${Math.max(conversationCount, 0)} 条 · ${tokens(calibrated?.conversation)} tokens`
          + (step?.requestAction === "user_prompt" ? " · 本步为新用户输入" : " · 多为历史重放")}
        empty={conversationCount <= 0}
        emptyText="本步无对话消息条目"
        action={onOpenInteraction
          ? {label: "查看原文 →", onClick: () => openFiltered({categories: ["user_real", "user_injected", "assistant"]})}
          : undefined}
      >
        {Object.entries(kindCounts)
          .filter(([kind]) => kind !== "tool_result" && kind !== "system_text")
          .slice(0, 10)
          .map(([kind, count]) => (
            <li key={`kind-${kind}`} className="layer-item">
              <span className="row-kind">{conversationKindLabel(kind)}</span>
              <span className="row-meta mono">{count} 条</span>
            </li>
          ))}
      </LayerCard>

      <LayerCard
        title="工具结果"
        meta={`${toolResultCount} 条 · ${tokens(calibrated?.toolResults)} tokens`
          + (step?.requestAction === "tool_result" ? " · 本步新增（上一步工具返回）" : "")}
        empty={toolResultCount === 0}
        emptyText="本步无工具结果回填"
        action={onOpenInteraction && toolResultCount > 0
          ? {label: "查看原文 →", onClick: () => openFiltered({categories: ["tool_result"]})}
          : undefined}
      >
        {summary.providedToolResults.slice(0, 8).map((result, index) => (
          <li key={`${result.toolUseId}-${index}`} className="layer-item">
            <span className="row-status">{result.isError ? "!" : "✓"}</span>
            <span className="row-kind mono">{result.toolUseId || "（无 id）"}</span>
            {result.providerType ? <span className="row-role">{result.providerType}</span> : null}
          </li>
        ))}
      </LayerCard>
    </div>
  );
}

function LayerCard({
  title,
  meta,
  empty,
  emptyText,
  action,
  children,
}: {
  title: string;
  meta: string;
  empty: boolean;
  emptyText: string;
  action?: {label: string; onClick: () => void};
  children: React.ReactNode;
}) {
  // 2026-09-21 UI 优化：分层卡默认收起——头部 meta 已含条数与 tokens 摘要，
  // 展开由用户按需触发，避免六卡全开把页签挤成一堵墙。
  const [open, setOpen] = useState(false);
  return (
    <section className={`layer-card${empty ? " empty" : ""}`}>
      <header>
        <button type="button" className="layer-card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          {title}
        </button>
        <span className="layer-card-meta">{meta}</span>
        {action ? (
          <button type="button" className="comp-link" onClick={action.onClick}>{action.label}</button>
        ) : null}
      </header>
      {open ? (
        empty
          ? <p className="layer-card-empty">{emptyText}</p>
          : <ul className="context-row-list">{children}</ul>
      ) : null}
    </section>
  );
}

function conversationKindLabel(kind: string): string {
  switch (kind) {
    case "user_text": return "用户消息";
    case "assistant_text": return "助手消息";
    case "reasoning": return "推理";
    case "tool_result": return "工具结果";
    case "tool_use": return "工具调用";
    case "system_text": return "系统";
    case "developer_text": return "开发者";
    default: return kind;
  }
}

/**
 * 每个问题页签顶部的一行结论：先用一句话给出答案，再往下看明细。
 * 数据全部来自已加载的 SQLite 投影，不额外请求、不读 raw。
 * 2026-09-21：改为「标签 + 值」逐行结构化展示，不再压成长句。
 */
function StepConclusionBar({
  tab,
  step,
  snapshot,
  diff,
  harness,
}: {
  tab: InspectorTab;
  step?: AgentStep;
  snapshot?: WorkbenchContextSnapshot;
  diff?: StepDiff;
  harness?: ApiAgentStepHarness;
}) {
  if (!step) return null;
  if (tab === "上下文") {
    const composition = snapshot?.contextComposition;
    const calibrated = composition?.calibratedTokens ?? composition?.estTokens;
    const actual = composition?.calibration?.actualInputTokens;
    const evolutionParts: string[] = [];
    if (diff) {
      const added = diff.addedMessages.length + diff.addedToolResults.length;
      const removed = diff.removedMessages.length + diff.removedToolResults.length;
      if (added > 0) evolutionParts.push(`+${added} 项上下文`);
      if (removed > 0) evolutionParts.push(`−${removed} 项上下文`);
      if (diff.addedAssistantToolUses.length > 0) evolutionParts.push(`+${diff.addedAssistantToolUses.length} 次工具调用`);
      if (diff.changedParamDetails.length > 0) {
        evolutionParts.push(`参数变更 ${diff.changedParamDetails.map(change => change.key).slice(0, 3).join("、")}`);
      }
      if (harness?.compaction) evolutionParts.push(harness.compaction.kind === "detected" ? "检测到上下文压缩" : "疑似上下文压缩");
    }
    return (
      <div className="step-conclusion" role="status">
        <div className="concl-row">
          <span className="concl-label">本步输入</span>
          {calibrated ? (
            <>
              <b className="mono">{formatTokensWan(actual ?? sumCompositionTokens(calibrated))} tokens</b>
              <span className="badge-tag">{actual ? "实际值" : "估算"}</span>
            </>
          ) : (
            <span>升级前数据无构成估算</span>
          )}
        </div>
        {evolutionParts.length > 0 ? (
          <div className="concl-row">
            <span className="concl-label">相比上一步</span>
            <span>{evolutionParts.join(" · ")}</span>
          </div>
        ) : null}
      </div>
    );
  }
  if (tab === "交互内容") {
    const calls = step.toolUseIds.length;
    const results = step.toolResultIds.length;
    const names = step.toolUseNames.slice(0, 3).join("、");
    return (
      <div className="step-conclusion" role="status">
        <div className="concl-row">
          <span className="concl-label">本步工具</span>
          {calls === 0 ? <span>未发生工具调用</span> : (
            <span>调用 <b>{calls}</b> 次（{names}{step.toolUseNames.length > 3 ? " 等" : ""}）· 获得 <b>{results}</b> 条结果</span>
          )}
        </div>
      </div>
    );
  }
  if (tab === "能力清单") {
    const tools = harness?.inventory.tools ?? [];
    if (tools.length === 0) {
      return (
        <div className="step-conclusion" role="status">
          <div className="concl-row">
            <span className="concl-label">本步能力</span>
            <span>{harness?.legacyData ? "升级前数据：无工具清单快照" : "无工具定义记录"}</span>
          </div>
        </div>
      );
    }
    const invoked = tools.filter(tool => tool.invoked).length;
    const skills = harness?.inventory.skills.length ?? 0;
    const rules = harness?.inventory.rules.length ?? 0;
    return (
      <div className="step-conclusion" role="status">
        <div className="concl-row">
          <span className="concl-label">本步可用</span>
          <span>工具 <b>{tools.length}</b> 个 · Skills <b>{skills}</b> 个 · 规则 <b>{rules}</b> 条（随提示词提供）</span>
        </div>
        <div className="concl-row">
          <span className="concl-label">本步使用</span>
          <span>{invoked > 0 ? <>调用工具 <b>{invoked}</b> / {tools.length} 个</> : <>未调用工具（0 / {tools.length}）</>}</span>
        </div>
      </div>
    );
  }
  return null;
}

function sumCompositionTokens(calibrated: {
  system: number; developer: number; toolsNonMcp: number; mcp: number;
  skills: number; rules: number; conversation: number; toolResults: number; other: number;
}): number {
  return calibrated.system + calibrated.developer + calibrated.toolsNonMcp
    + calibrated.mcp + calibrated.skills + calibrated.rules
    + calibrated.conversation + calibrated.toolResults + calibrated.other;
}

/**
 * 本 Turn 用户输入卡片（Turn 栏锚点）：一个 Turn 必然由一次真实用户输入开启，
 * 因此这里展示该输入正文，让下面几十行 Step 有明确的意图锚点。
 *
 * 正文始终直接渲染完整内容（固定高度 + 内部滚动，2026-09-19 用户确认去掉
 * 「预览/点击补全」链路）：预览（Content Preview user_real 条目，≤4 KiB）
 * 先行展示，投影被收敛截断时自动走交互内容的有界读取通道（/api/export/content，
 * scope=step + side=request + categories=user_real + pageMaxBytes 预算）补全，
 * 读取失败或超预算时静默保留已有正文，头部只保留标题与「复制」。
 */
/** 完整读取的单侧原始字节预算：自动触发、限定当前 Turn 首步单侧。 */
const USER_PROMPT_FULL_READ_MAX_BYTES = 8 * 1024 * 1024;

function TurnUserPromptCard({
  prompt,
}: {
  prompt: {
    text: string;
    stepIndex: number;
    stepId: string;
    exchangeId: string;
    timestamp: string;
    truncated: boolean;
    originalBytes?: number;
    source?: string;
  };
}) {
  const [copied, setCopied] = useState(false);
  const [fullText, setFullText] = useState<string>();
  const loadSequenceRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  // 换 Turn / 换输入正文时清掉上一次的完整读取结果：以内容为键而不是对象引用，
  // 避免 Step 自动刷新（同一 prompt 内容、新对象）反复清空已读取的正文。
  const stateKey = `${prompt.stepId}|${prompt.text.length}|${prompt.truncated ? 1 : 0}`;
  const stateKeyRef = useRef(stateKey);
  if (stateKeyRef.current !== stateKey) {
    stateKeyRef.current = stateKey;
    setFullText(undefined);
  }
  const displayedText = fullText ?? prompt.text;
  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(displayedText || "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用（非安全上下文）时保持静默：正文本身可手动选中复制。
    }
  }, [displayedText]);
  // 预览被投影收敛截断时自动补全（仍限定当前 Turn 首步单侧、有字节预算）；
  // 失败/超预算静默保留预览，不打扰阅读。
  useEffect(() => {
    if (!prompt.truncated) return undefined;
    const sequence = ++loadSequenceRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        const query = buildExportConversationQuery({
          step: prompt.stepId,
          scope: "step",
          side: "request",
          categories: ["user_real"],
          exchangeLimit: 1,
          pageMaxBytes: USER_PROMPT_FULL_READ_MAX_BYTES,
        }) + "&deferBaseline=true&skipCandidateCount=true";
        const response = await fetch(`/api/export/content?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (sequence !== loadSequenceRef.current) return;
        if (!response.ok) return;
        // 逐行解析 NDJSON：item_start / text_chunk / item_end 三种事件足够拼出 user_real 正文。
        const items: Array<{text: string; semanticCategory?: string}> = [];
        let current: {text: string; semanticCategory?: string} | undefined;
        const raw = await response.text();
        if (sequence !== loadSequenceRef.current) return;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as {
            type: string;
            value?: string;
            category?: string;
          };
          if (event.type === "item_start") {
            current = {
              text: "",
              ...(event.category ? {semanticCategory: event.category} : {}),
            };
          } else if (event.type === "text_chunk" && current) {
            current.text += event.value ?? "";
          } else if (event.type === "item_end" && current) {
            items.push(current);
            current = undefined;
          }
        }
        const chosen = pickTurnUserPromptItem(items, item => item.text);
        if (sequence !== loadSequenceRef.current) return;
        if (chosen && chosen.text.trim().length > prompt.text.trim().length) {
          setFullText(chosen.text);
        }
      } catch {
        // 读取失败静默保留预览正文。
      }
    })();
    return () => {
      controller.abort();
    };
  }, [stateKey, prompt.truncated, prompt.stepId, prompt.text]);
  useEffect(() => () => abortRef.current?.abort(), []);
  return (
    <section className="turn-user-prompt">
      <header>
        <span>本 Turn 用户输入</span>
        <span className="turn-user-prompt-actions">
          <button type="button" className="comp-link" onClick={() => void copyPrompt()}>
            {copied ? "已复制" : "复制"}
          </button>
        </span>
      </header>
      {/* 正文不再截断成省略号：固定高度 + 内部滚动，长输入可以就地读完 */}
      <p className="turn-user-prompt-text">{displayedText}</p>
    </section>
  );
}

/**
 * 跨 Turn 意图序列时间线（任务10）：四个统计数字是服务端对本 Turn 全部 Step 的
 * 聚合（intentStats），不随下方 Step 分页截断；「已加载 x/y」仅说明列表加载进度。
 */
function TurnIntentSequence({
  steps,
  intentStats,
  total,
}: {
  steps: AgentStep[];
  intentStats?: WorkbenchTurnIntentStats;
  total: number;
}) {
  if (steps.length === 0) return null;
  const partial = steps.length < total;
  const compressions = intentStats?.compressions ?? 0;
  return (
    <section className="turn-intent-sequence" aria-label="意图序列时间线">
      <div className="turn-intent-stats">
        <span><strong>{intentStats?.toolUseSteps ?? 0}</strong> 工具调用</span>
        <span><strong>{intentStats?.retries ?? 0}</strong> 重试</span>
        <span><strong>{intentStats?.interruptions ?? 0}</strong> 错误/中断</span>
        <span><strong>{intentStats?.finals ?? 0}</strong> 完成</span>
        {/* 压缩计数与「已加载 x/y」同行（2026-09-22 用户反馈）：同一 flex 行内
            排在完成之后、已加载之前，窄列换行时靠左、已加载仍右贴；无压缩不显示。 */}
        {compressions > 0 ? (
          <span><strong>{compressions}</strong> 压缩</span>
        ) : null}
        {partial ? (
          <span className="turn-intent-total">已加载 {steps.length}/{total}</span>
        ) : null}
      </div>
    </section>
  );
}

/** 响应为错误（4xx/5xx）且正文较小（≤ 8 KiB）时读取原始错误正文用于总览摘要。 */
function useOverviewErrorBody(projection?: ExchangeProjectionDetail): string | undefined {
  const [errorBody, setErrorBody] = useState<string | undefined>();
  const exchangeId = projection?.exchangeId;
  const status = projection?.response.status;
  const isError = typeof status === "number" && status >= 400;
  const size = projection?.response.sizeBytes ?? 0;
  useEffect(() => {
    setErrorBody(undefined);
    if (!exchangeId || !isError || size <= 0 || size > 8 * 1024) return;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/exchanges/${encodeURIComponent(exchangeId)}/raw/response`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || !active) return;
        const text = await response.text();
        if (active && text.trim()) setErrorBody(text.trim());
      } catch {
        // 错误正文读取失败不阻断总览展示，忽略即可。
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [exchangeId, isError, size]);
  return errorBody;
}

function formatCompactErrorBody(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 800 ? `${compact.slice(0, 800)}…` : compact;
}

function OverviewTab({ step, session, businessIds, exchange, projection, previousProjection }: {
  step?: AgentStep;
  /** 当前 Session 摘要（业务 Session ID 从这里取；不是内部 AgentSession.id）。 */
  session?: { externalSessionId?: string; source?: string };
  /** 当前选中层级能取到的业务 Thread/Turn ID（有业务值才展示对应行）。 */
  businessIds?: { externalThreadId?: string; nativeTurnId?: string };
  exchange?: ExchangeIndexItem;
  projection?: ExchangeProjectionDetail;
  previousProjection?: ExchangeProjectionDetail;
}) {
  const summary = buildProjectionOverviewSummary(projection, previousProjection, exchange);
  const tokenUsage = tokenUsageSummaryFromStep(step);
  // 响应为 4xx/5xx 错误且正文较小时，读取原始错误正文并入摘要，避免“请选择…”式的空态。
  const errorBody = useOverviewErrorBody(projection);
  // 压缩证据条只在事件步显示一次（2026-09-22 用户确认）：详情带 compactionEvent，
  // 回退列表摘要的 compactionRole/Ordinal；非事件步（摘要常驻的后续请求）不显示。
  const compactionEvent = step?.compactionEvent
    ?? (step?.compactionRole
      ? {role: step.compactionRole, ordinal: step.compactionOrdinal ?? 1}
      : undefined);
  return (
    <div className="overview-tab">
      <BasicInfoSection
        step={step}
        projection={projection}
        session={session}
        businessIds={businessIds}
      />
      {step?.compactionPreview && compactionEvent ? (
        <div className="insight-strip">
          <Braces size={14} />
          <span>
            识别到第{compactionEvent.ordinal}次发生压缩，压缩证据 · {compactionPreviewLabel(step.compactionPreview)}
          </span>
        </div>
      ) : null}
      <TokenUsagePanel usage={tokenUsage} contextWindow={step?.pricingSnapshot?.contextWindow} />
      <PricingCostPanel step={step} />
      <OverviewParamsSection params={step?.paramsDetail} contextWindow={step?.pricingSnapshot?.contextWindow} />
      <section className="overview-summary-section">
        <header>
          <span>本次请求新增内容</span>
        </header>
        <div className="overview-summary-content">{summary.requestSummary}</div>
      </section>
      <section className="overview-summary-section response">
        <header>
          <span>主要响应内容</span>
        </header>
        <div className="overview-summary-content response-error-summary">
          {summary.responseSummary}
          {errorBody ? <code>{formatCompactErrorBody(errorBody)}</code> : null}
        </div>
      </section>
    </div>
  );
}

/** 大数 token 万单位显示（对齐 zcode 客户端面板口径）：205061 → 20.5万；小于 1 万原样。 */
function formatTokensWan(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
  return value.toLocaleString();
}

type ContextCompositionBuckets = NonNullable<ContextComposition["calibratedTokens"]>;

/** 上下文构成分桶（按占比降序展示）：全部来自 context_snapshots 的字符估算/校准值。 */
const CONTEXT_VOLUME_SEGMENTS: Array<{
  key: string;
  label: string;
  color: string;
  harness?: boolean;
  pick: (c: ContextCompositionBuckets) => number;
}> = [
  { key: "conversation", label: "对话 / 历史", color: "var(--pine-600)", pick: c => c.conversation },
  { key: "toolResults", label: "工具结果", color: "var(--gold-500)", pick: c => c.toolResults },
  { key: "tools", label: "内置工具定义", color: "var(--info)", harness: true, pick: c => c.toolsNonMcp },
  { key: "mcp", label: "MCP 工具定义", color: "var(--violet)", harness: true, pick: c => c.mcp },
  { key: "skills", label: "Skills 技能", color: "var(--pink)", harness: true, pick: c => c.skills },
  { key: "rules", label: "规则文件", color: "var(--gold-700)", harness: true, pick: c => c.rules },
  { key: "sysdev", label: "系统 / 开发者提示", color: "#46678c", pick: c => c.system + c.developer },
  { key: "other", label: "推理 / 其他", color: "var(--ink-300)", pick: c => c.other },
];

/**
 * 「上下文容量」面板（2026-09-21，对齐 zcode 客户端面板形态）：
 * 标题行右侧为「本步输入 / 模型窗口（占比%）」——窗口来自价格中心快照
 * contextWindow，缺省只显示本步输入；中部一条按构成分桶的堆叠条，
 * 下方逐行「色点 + 中文类别 + tokens + 占比」；底部附本步缓存命中率
 * （cache_read / 输入总量，与 Token 价格页同口径）。
 */
function ContextVolumePanel({ step, composition, onOpenHarness }: {
  step?: AgentStep;
  composition: ContextComposition;
  onOpenHarness?: () => void;
}) {
  const calibrated = composition.calibratedTokens ?? composition.estTokens;
  if (!calibrated) return null;
  const rows = CONTEXT_VOLUME_SEGMENTS
    .map(segment => ({...segment, value: Math.max(segment.pick(calibrated), 0)}))
    .sort((a, b) => b.value - a.value);
  const rowsTotal = rows.reduce((sum, row) => sum + row.value, 0);
  const actual = composition.calibration?.actualInputTokens;
  const displayTotal = actual ?? rowsTotal;
  const contextWindow = step?.pricingSnapshot?.contextWindow;
  const usagePct = contextWindow && contextWindow > 0
    ? `（${Math.min(Math.round(displayTotal * 1000 / contextWindow) / 10, 999)}%）`
    : undefined;
  const pct = (value: number) => {
    if (displayTotal <= 0) return "0%";
    const p = value * 100 / displayTotal;
    return p >= 10 ? `${Math.round(p)}%` : `${Math.round(p * 10) / 10}%`;
  };
  // 「清单 →」只挂在与能力清单对应的四个 Harness 分桶中占比最高的一个，避免满屏链接。
  const harnessLinkKey = rows.find(row => row.harness && row.value > 0)?.key;
  const cacheHit = formatCacheHitRatio(tokenUsageSummaryFromStep(step));
  return (
    <div className="foot-block">
      <div className="dt">
        上下文构成
        <span className="ctx-volume-total">
          <b className="mono">
            {formatTokensWan(displayTotal)}
            {contextWindow && contextWindow > 0 ? ` / ${formatTokensWan(contextWindow)}` : ""}
          </b>
          <span>tokens</span>
          {usagePct ? <span className="ctx-volume-pct">{usagePct}</span> : null}
          <span className="badge-tag">{actual ? "实际值" : "估算"}</span>
        </span>
      </div>
      <div className="ctx-volume">
        <div className="ctx-volume-bar" aria-hidden="true">
          {rows.filter(row => row.value > 0).map(row => (
            <i
              key={row.key}
              style={{
                flexGrow: Math.max(row.value / Math.max(displayTotal, 1), 0.001),
                background: row.color,
              }}
              title={`${row.label} ${row.value.toLocaleString()} tokens`}
            />
          ))}
        </div>
        <div className="ctx-volume-rows">
          {rows.map(row => (
            <div key={row.key} className={`ctx-volume-row${row.value === 0 ? " zero" : ""}`}>
              <span className="dot" style={{ background: row.color }} />
              <span className="lbl">
                {row.label}
                {row.key === harnessLinkKey && onOpenHarness ? (
                  <button type="button" className="comp-link" onClick={onOpenHarness}>清单 →</button>
                ) : null}
              </span>
              <span className="val mono">{row.value.toLocaleString()}</span>
              <span className="pct mono">{pct(row.value)}</span>
            </div>
          ))}
        </div>
        {cacheHit ? (
          <div className="ctx-volume-cache">
            <span>缓存命中（本步）</span>
            <b className="mono">{cacheHit}</b>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ContextTab({ snapshot, harness, diff, step, onOpenHarness, onOpenInteraction }: {
  snapshot?: WorkbenchContextSnapshot;
  harness?: ApiAgentStepHarness;
  diff?: StepDiff;
  step?: AgentStep;
  onOpenHarness?: () => void;
  onOpenInteraction?: (filter: {categories?: ConversationCategory[]; toolName?: string}) => void;
}) {
  const [structureFactsOpen, setStructureFactsOpen] = useState(false);
  if (!snapshot) return <EmptyState text="没有 Context Snapshot" />;
  const composition = snapshot.contextComposition;
  const actual = composition?.calibration?.actualInputTokens;
  return (
    <div className="context-view">
      <div className="snap-card">
        <div className="snap-cell"><span className="label">消息</span><b>{snapshot.messageCount || snapshot.inputItemCount || 0}</b></div>
        {(snapshot.inputItemCount ?? 0) > 0 ? (
          <div className="snap-cell"><span className="label">输入项</span><b>{snapshot.inputItemCount}</b></div>
        ) : null}
        <div className="snap-cell"><span className="label">工具定义</span><b>{snapshot.toolSchemaCount}</b></div>
      </div>

      {composition ? (
        <ContextVolumePanel step={step} composition={composition} onOpenHarness={onOpenHarness} />
      ) : (
        <div className="foot-block">
          <p className="comp-legacy-note">升级前数据：无构成估算。该 Step 建立早于估算上线，只有哈希与计数事实；新产生的 Step 将展示构成分解。</p>
        </div>
      )}

      <ContextLayerCards
        snapshot={snapshot}
        harness={harness}
        step={step}
        calibrated={composition?.calibratedTokens ?? composition?.estTokens}
        onOpenHarness={onOpenHarness}
        onOpenInteraction={onOpenInteraction}
      />

      <ContextEvolutionSection diff={diff} harness={harness} />

      <section className="hgroup">
        <button type="button" className="hgroup-head" onClick={() => setStructureFactsOpen(!structureFactsOpen)}>
          <span aria-hidden="true">{structureFactsOpen ? "▾" : "▸"}</span>
          结构事实（哈希与计数）
        </button>
        {structureFactsOpen ? (
          <div className="hgroup-body">
            <div className="skill-row">
              <span className="sname">systemPromptHashes</span>
              <span className="src src-plain">{snapshot.systemPromptHashes.length} 块</span>
              <span className="kv mono">{snapshot.systemPromptHashes.slice(0, 2).join(" / ") || "—"}</span>
            </div>
            {snapshot.harnessSummary.systemPrompts.length > 0 ? (
              <details className="system-blocks-detail">
                <summary>系统提示块级预览（{snapshot.harnessSummary.systemPrompts.length} 块 · 有界预览）</summary>
                <ul className="context-row-list">
                  {snapshot.harnessSummary.systemPrompts.slice(0, 12).map((block, index) => (
                    <li key={`${block.textHash}-${index}`} className="context-row keep">
                      <span className="row-status">S{index + 1}</span>
                      <span className="row-kind mono">{block.textHash.slice(0, 8)}</span>
                      {block.providerRole ? <span className="row-role">{block.providerRole}</span> : null}
                      <span className="row-preview">{(block.textPreview || "（无预览）").slice(0, 120)}</span>
                    </li>
                  ))}
                </ul>
                <div className="note-strip">块级正文为有界预览；完整原文走「请求」页签的原始 JSON 查看。</div>
              </details>
            ) : null}
            <div className="skill-row">
              <span className="sname">developerPromptHashes</span>
              <span className="src src-plain">{snapshot.developerPromptHashes.length} 块</span>
              <span className="kv mono">{snapshot.developerPromptHashes.slice(0, 2).join(" / ") || "—"}</span>
            </div>
            <div className="skill-row">
              <span className="sname">conversationItemHashes</span>
              <span className="src src-plain">{snapshot.conversationItemHashes.length} 项</span>
              <span className="kv">去重指纹（occurrence-aware）</span>
            </div>
            <div className="skill-row">
              <span className="sname">toolSchemaHashes</span>
              <span className="src src-plain">{snapshot.toolSchemaHashes.length} 个</span>
              <span className="kv">
                <button type="button" className="comp-link" onClick={onOpenHarness}>工具清单 → Harness 页签</button>
              </span>
            </div>
            <div className="skill-row">
              <span className="sname">paramsHash</span>
              <span className="src src-plain">—</span>
              <span className="kv mono">{snapshot.paramsHash}</span>
            </div>
          </div>
        ) : null}
      </section>

      {snapshot.remoteStateReferences.length > 0 ? (
        <div className="note-strip">
          远端状态引用：{snapshot.remoteStateReferences.map(item => `${item.kind} = ${item.value}`).join("，")}
          （完整上下文不可完全观测）。
        </div>
      ) : null}
    </div>
  );
}

/**
 * 上下文演化（2026-09-18「变化」页签并入「上下文」）：压缩事件卡 + 与上一步的
 * 消息/工具结果增删、参数变更与 Token Δ。数据全部来自 SQLite 快照差分，不读 raw。
 */
function ContextEvolutionSection({ diff, harness }: {
  diff?: StepDiff;
  harness?: ApiAgentStepHarness;
}) {
  const compaction = harness?.compaction;
  const detected = compaction?.kind === "detected";
  if (!diff && !compaction) {
    return (
      <div className="foot-block">
        <div className="dt">与上一步的演化</div>
        <p className="comp-legacy-note">缺少对比基线：首个 Step 或快照缺失。</p>
      </div>
    );
  }
  const addedTotal = diff ? diff.addedMessages.length + diff.addedToolResults.length : 0;
  const removedTotal = diff ? diff.removedMessages.length + diff.removedToolResults.length : 0;
  const toolUseNames = diff ? [...new Set(diff.addedAssistantToolUses.map(item => item.name))] : [];
  const tokenDelta = diff?.tokenDelta;
  const noChanges = diff
    && addedTotal === 0 && removedTotal === 0
    && diff.addedAssistantToolUses.length === 0
    && diff.changedParamDetails.length === 0;
  return (
    <>
      {compaction ? (
        <section className={`event-card${detected ? " strong" : ""}`}>
          <div className="et">
            Context 事件 · {detected ? "检测到上下文压缩" : "疑似上下文压缩（无裁剪证据，不过度推断）"}
            {detected ? (
              <span className="event-badge">
                证据：{compaction.messageRemoved} message_removed + {compaction.toolResultRemoved} tool_result_removed
                {compaction.compactionEvidence > 0
                  ? ` + ${compaction.compactionEvidence} 压缩证据（purpose 头/摘要注入）`
                  : ""}
              </span>
            ) : null}
          </div>
          <div className="event-grid">
            <span>Before <b className="mono">{compaction.before.toLocaleString()}</b></span>
            <span>After <b className="mono">{compaction.after.toLocaleString()}</b></span>
            <span>Reduction <b className="mono">−{Math.round(compaction.reductionPct * 1000) / 10}%</b></span>
            {detected ? <span>Trimming 证据 <b className="mono">{compaction.messageRemoved + compaction.toolResultRemoved} 条</b></span> : null}
          </div>
        </section>
      ) : null}

      <div className="foot-block">
        <div className="dt">与上一步的演化</div>
        <div className="evolution-rows">
          {noChanges && !compaction ? (
            <div className="concl-row">
              <span className="concl-label">对比结果</span>
              <span>上下文与参数均无变化</span>
            </div>
          ) : null}
          {addedTotal > 0 || removedTotal > 0 ? (
            <div className="concl-row">
              <span className="concl-label">上下文</span>
              <span>
                {addedTotal > 0 ? (
                  <>新增 <b className="add">+{addedTotal}</b> 条（消息 {diff?.addedMessages.length ?? 0} · 工具结果 {diff?.addedToolResults.length ?? 0}）</>
                ) : null}
                {addedTotal > 0 && removedTotal > 0 ? " · " : null}
                {removedTotal > 0 ? (
                  <>移除 <b className="rem">−{removedTotal}</b> 条（消息 {diff?.removedMessages.length ?? 0} · 工具结果 {diff?.removedToolResults.length ?? 0}）</>
                ) : null}
              </span>
            </div>
          ) : null}
          {diff && diff.addedAssistantToolUses.length > 0 ? (
            <div className="concl-row">
              <span className="concl-label">工具调用</span>
              <span>
                新增 <b className="add">+{diff.addedAssistantToolUses.length}</b> 次
                {toolUseNames.length > 0 ? `（${toolUseNames.slice(0, 4).join(" · ")}${toolUseNames.length > 4 ? " 等" : ""}）` : ""}
              </span>
            </div>
          ) : null}
          {diff && diff.changedParamDetails.length > 0 ? (
            <div className="evolution-params">
              {diff.changedParamDetails.map(change => (
                <Fragment key={`pd-${change.key}`}>
                  <span className="concl-label">参数 {change.key}</span>
                  <span className="mono param-from">{diffParamValue(change.from)}</span>
                  <span className="param-arrow rem" aria-hidden="true">→</span>
                  <span className="mono param-to">{diffParamValue(change.to)}</span>
                </Fragment>
              ))}
            </div>
          ) : null}
          {tokenDelta ? (
            <div className="concl-row">
              <span className="concl-label">Token 变化</span>
              <span>
                输入 <b className="mono">{(tokenDelta.inputTokens > 0 ? "+" : "") + tokenDelta.inputTokens.toLocaleString()}</b>
                {" "}· 输出 <b className="mono">{(tokenDelta.outputTokens > 0 ? "+" : "") + tokenDelta.outputTokens.toLocaleString()}</b>
              </span>
            </div>
          ) : null}
        </div>
        {diff ? <ContextDiffRows diff={diff as WorkbenchStepDiff} /> : null}
      </div>
    </>
  );
}

/** 参数变化里的空值用中文说明，避免出现 ∅ 这类符号（用户反馈看不懂）。 */
function diffParamValue(value: string | undefined): string {
  const text = (value ?? "").trim();
  if (!text || text === "∅" || text === "null" || text === "undefined") return "未设置";
  return text;
}

function shortHashLabel(hash: string): string {
  return hash ? hash.slice(0, 8) : "";
}

/**
 * 重试链推断（仅当前已加载页，客户端纯计算）：同列表内连续 phase=error 且相邻
 * 时间差 ≤120s 的 Step 视为一条重试链；返回第 2 个及之后的链序号。
 * 只标注事实相邻性，不推断上游语义，UI 带「推断」徽标。
 */
/** 同一 Turn 内相邻步骤的空闲标记阈值：≥5 分钟插入「空闲」分隔（2026-09-18）。 */
const TIMELINE_IDLE_GAP_MS = 5 * 60_000;

type TimelineRow =
  | {kind: "step"; step: AgentStep}
  | {kind: "idle"; after: string; minutes: number};

/** 时间线行模型：在长空闲（≥5 分钟）的相邻步骤之间插入事实性空闲分隔，不做语义推断。 */
function buildTimelineRows(steps: AgentStep[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previous: AgentStep | undefined;
  for (const step of steps) {
    if (previous) {
      const gap = Date.parse(step.timestamp) - Date.parse(previous.timestamp);
      if (Number.isFinite(gap) && gap >= TIMELINE_IDLE_GAP_MS) {
        rows.push({kind: "idle", after: previous.id, minutes: Math.round(gap / 60_000)});
      }
    }
    rows.push({kind: "step", step});
    previous = step;
  }
  return rows;
}

function computeRetryChainOrdinals(steps: AgentStep[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  let chainLength = 0;
  let previousErrorAt: number | null = null;
  for (const step of steps) {
    const at = Date.parse(step.timestamp);
    if (step.phase === "error" && Number.isFinite(at)
      && previousErrorAt !== null && at - previousErrorAt <= 120_000) {
      chainLength += 1;
      ordinals.set(step.id, chainLength);
      previousErrorAt = at;
      continue;
    }
    if (step.phase === "error" && Number.isFinite(at)) {
      chainLength = 1;
      previousErrorAt = at;
      continue;
    }
    chainLength = 0;
    previousErrorAt = null;
  }
  return ordinals;
}

/** 行级 Context Diff（contextView，服务端有界投影）：默认展示增删行，完整行折叠。 */
function ContextDiffRows({ diff }: { diff: WorkbenchStepDiff }) {
  const view = diff.contextView;
  if (!view || (view.targetRows.length === 0 && view.removedRows.length === 0)) return null;
  const addedRows = view.targetRows.filter(row => row.status === "added");
  const unchangedCount = view.targetRows.length - addedRows.length;
  const removedRows = view.removedRows;
  const targetTotal = (view as unknown as {targetRowsTotal?: number}).targetRowsTotal ?? view.targetRows.length;
  const removedTotal = (view as unknown as {removedRowsTotal?: number}).removedRowsTotal ?? view.removedRows.length;
  return (
    <div className="context-diff-rows">
      <div className="diff-line">
        逐行对比：新增 <b className="add">{addedRows.length}</b> · 移除 <b className="rem">{removedRows.length}</b>
        {unchangedCount > 0 ? ` · 未变化 ${unchangedCount}` : ""}
        {targetTotal > view.targetRows.length || removedRows.length < removedTotal
          ? `（超出展示上限，已截断：上下文行 ${view.targetRows.length}/${targetTotal} · 移除行 ${view.removedRows.length}/${removedTotal}）`
          : ""}
      </div>
      {addedRows.length > 0 ? (
        <details>
          <summary>新增行（{addedRows.length}）</summary>
          <ul className="context-row-list">
            {addedRows.slice(0, 60).map(row => <ContextDiffRowItem key={row.id} row={row} />)}
          </ul>
        </details>
      ) : null}
      {removedRows.length > 0 ? (
        <details>
          <summary>移除行（{removedRows.length}）</summary>
          <ul className="context-row-list">
            {removedRows.slice(0, 40).map(row => <ContextDiffRowItem key={row.id} row={row} />)}
          </ul>
        </details>
      ) : null}
      <details>
        <summary>完整上下文行（{view.targetRows.length}）</summary>
        <ul className="context-row-list">
          {view.targetRows.slice(0, 120).map(row => <ContextDiffRowItem key={row.id} row={row} />)}
        </ul>
      </details>
    </div>
  );
}

function ContextDiffRowItem({ row }: { row: ContextDiffRow }) {
  const statusLabel = row.status === "added" ? "+" : row.status === "removed" ? "−" : "=";
  const statusClass = row.status === "added" ? "add" : row.status === "removed" ? "rem" : "keep";
  return (
    <li className={`context-row ${statusClass}`}>
      <span className="row-status">{statusLabel}</span>
      <span className="row-kind">{row.kind === "tool_call" ? "工具调用" : row.kind === "tool_result" ? "工具结果" : row.kind === "message" ? "消息" : row.kind}</span>
      {row.role ? <span className="row-role">{row.role}</span> : null}
      <span className="row-title">{row.title}</span>
      {row.preview ? <span className="row-preview">{row.preview.slice(0, 120)}</span> : null}
    </li>
  );
}

/** 协议 wire API 展示名。 */
function protocolLabel(protocol?: string): string {
  switch (protocol) {
    case "openai-responses": return "Responses";
    case "openai-chat-completions": return "Chat Completions";
    case "anthropic-messages": return "Messages";
    default: return protocol || "未知";
  }
}

/** 各 wire API 的请求形状/事件语义说明（协议级静态说明，配合本步实际取值展示）。 */
function protocolSemanticsNote(protocol?: string): string {
  switch (protocol) {
    case "openai-responses":
      return "请求形状 instructions + input[]（item 流），工具出参 custom_tool_call/function_call，SSE 以 response.* 事件流生命周期（created → completed）收尾。";
    case "openai-chat-completions":
      return "请求形状 messages[] 单数组（system 也是一条 message），工具出参 tool_calls + finish_reason，SSE 以 chat.completion.chunk 增量 + finish_reason 收尾。";
    case "anthropic-messages":
      return "请求形状 system + messages[] 双槽位，工具出参 tool_use content block + stop_reason，SSE 以 message_delta 收尾（stop_reason 在 delta 中）。";
    default:
      return "未识别协议：以原始报文为准。";
  }
}

/**
 * 协议能力面板（能力清单页签，2026-09-18）：用本步的具体数据呈现 wire API 差异——
 * 协议名、流式形态、HTTP 状态与停止原因，并附该协议的请求形状/事件语义说明。
 */
function ProtocolCapabilityPanel({ protocol, isStreaming, step }: {
  protocol?: string;
  isStreaming?: boolean;
  step?: AgentStep;
}) {
  const stopReason = step?.stopReason;
  return (
    <div className="foot-block">
      <div className="dt">
        协议能力（本步 wire API）
        <span className="event-badge mono">{protocol ? protocol : "未知"}</span>
      </div>
      <div className="event-grid">
        <span>Wire API <b>{protocolLabel(protocol)}</b></span>
        <span>传输 <b>{isStreaming === undefined ? "—" : isStreaming ? "SSE 流式" : "非流式"}</b></span>
        <span>HTTP <b className="mono">{step?.httpStatus !== undefined ? step.httpStatus : "—"}</b></span>
        <span>停止原因 <b className="mono">{stopReason || "—"}</b></span>
      </div>
      <div className="note-strip">{protocolSemanticsNote(protocol)}</div>
    </div>
  );
}

function HarnessTab({ step, harness, harnessLoading, protocol, isStreaming, onInspectTool, onOpenContext }: {
  step?: AgentStep;
  harness?: ApiAgentStepHarness;
  harnessLoading: boolean;
  /** 协议 wire API（投影 preview.protocol，回退快照 protocol）。 */
  protocol?: string;
  isStreaming?: boolean;
  onInspectTool: (toolName: string) => void;
  onOpenContext: () => void;
}) {
  if (!step) return <EmptyState text="选择 Step 后查看它带了什么 Harness" />;
  if (harnessLoading && !harness) return <EmptyState text="正在加载 Harness 证据…" />;
  if (!harness) return <EmptyState text="没有 Step Harness 记录" />;

  const { snapshot, inventory, harnessTokens } = harness;
  const mcpGroups = groupMcpTools(inventory.tools);
  const plainTools = inventory.tools.filter(tool => tool.kind !== "mcp");
  const invokedCount = inventory.tools.filter(tool => tool.invoked).length;
  const stepInvokedCalls = inventory.tools.reduce((sum, tool) => sum + tool.callsThisStep, 0);
  const changes = harness.changes;
  const addedToolNames = new Set(changes?.toolsAdded ?? []);
  const plainToolsSorted = sortToolsForStep(plainTools, addedToolNames);
  const changesCount = changes
    ? changes.toolsAdded.length + changes.toolsRemoved.length
      + changes.skillsAdded.length + changes.skillsRemoved.length
      + changes.rulesAdded.length + changes.rulesRemoved.length
    : 0;

  return (
    <div className="harness-tab">
      {harness.legacyData ? (
        <div className="derived-status-banner building" role="status">
          升级前数据：有工具清单与调用记录；Skills / Rules / 构成估算 / 项目目录不可得。
        </div>
      ) : null}

      <div className="snap-card">
        <div className="snap-cell"><span className="label">快照版本</span><b className="mono snap-hash">{snapshot?.shortHash || "—"}</b></div>
        {snapshot ? <div className="snap-cell"><span className="label">Thread 内快照</span><b>第 {snapshot.seqInThread} 个</b></div> : null}
        {snapshot ? <div className="snap-cell"><span className="label">首次出现</span><b>Step {snapshot.firstSeenStepIndex}</b></div> : null}
        {snapshot ? <div className="snap-cell"><span className="label">生效范围</span><b>Step {snapshot.coverage.fromStepIndex}–{snapshot.coverage.toStepIndex}</b></div> : null}
        <div className="snap-cell"><span className="label">工具清单</span><b>{inventory.tools.length} 个 · {snapshot ? (snapshot.complete ? "完整" : "受限") : "升级前"}</b></div>
        <div className="snap-cell"><span className="label">Agent</span><b>{snapshot?.agentName || "—"}</b></div>
        {harness.project ? <div className="snap-cell"><span className="label">项目</span><b>{harness.project}</b></div> : null}
      </div>

      <div className="stat-chips">
        <div className="schip">
          <div className="n">{inventory.tools.length} <i className="badge-tag">Tools</i></div>
          <div className="l">本步调用 {stepInvokedCalls}</div>
        </div>
        <div className="schip">
          <div className="n">{mcpGroups.length} <i className="badge-tag">MCP</i></div>
          <div className="l">{mcpGroups.length > 0 ? `服务 ${mcpGroups.map(group => group.server).join(" · ")}` : "无 MCP 服务"}</div>
        </div>
        <div className="schip">
          <div className="n">{inventory.skills.length} <i className="badge-tag warn">注入</i></div>
          <div className="l">Skills</div>
        </div>
        <div className="schip">
          <div className="n">{inventory.rules.length} <i className="badge-tag">Rules</i></div>
          <div className="l">{ruleGroupLabel(inventory.rules)}</div>
        </div>
        {harnessTokens ? (
          <div className="schip">
            <div className="n mono">{harnessTokens.total.toLocaleString()} <i className="badge-tag est">估算{harnessTokens.calibrated ? "·校准" : ""}</i></div>
            <div className="l">Harness Tokens{harnessTokens.shareOfInput !== undefined ? ` / 占 Input ${Math.round(harnessTokens.shareOfInput * 1000) / 10}%` : ""}</div>
          </div>
        ) : null}
      </div>

      <GroupSection title="工具" count={plainTools.length}>
        {plainTools.length > 0 ? (
          <>
            <div className="trow head">
              <span>名称</span>
              <span>来源</span>
              <span className="num">本步 / 本Turn</span>
              <span className="num">Invoked</span>
              <span className="num">定义 tokens <i className="badge-tag est">估</i></span>
              <span className="num">调用记录</span>
            </div>
            {plainToolsSorted.map(tool => (
              <HarnessToolRow
                key={tool.name}
                tool={tool}
                onInspectTool={onInspectTool}
                addedThisStep={addedToolNames.has(tool.name)}
              />
            ))}
          </>
        ) : (
          <p className="comp-legacy-note">本步无内置工具定义。</p>
        )}
      </GroupSection>

      {mcpGroups.map(group => (
        <GroupSection
          key={group.server}
          title={`MCP · ${group.server}`}
          count={group.tools.length}
          defaultOpen={false}
          note={group.tools.every(tool => !tool.invoked) ? `本步 0 次调用 · 定义 ${group.tools.reduce((sum, tool) => sum + tool.defTokensEst, 0).toLocaleString()} tokens（估算）` : undefined}
        >
          <div className="trow head">
            <span>名称</span>
            <span>来源</span>
            <span className="num">本步 / 本Turn</span>
            <span className="num">Invoked</span>
            <span className="num">定义 tokens <i className="badge-tag est">估</i></span>
            <span className="num">调用记录</span>
          </div>
          {sortToolsForStep(group.tools, addedToolNames).map(tool => (
            <HarnessToolRow
              key={tool.name}
              tool={tool}
              onInspectTool={onInspectTool}
              addedThisStep={addedToolNames.has(tool.name)}
            />
          ))}
        </GroupSection>
      ))}

      <GroupSection
        title="Skills"
        count={inventory.skills.length}
        defaultOpen={false}
      >
        {inventory.skills.length > 0 ? inventory.skills.map(skill => (
          <div key={`${skill.name}-${skill.sourceRoot ?? ""}`} className="skill-row">
            <span className="sname">{skill.name}</span>
            <span className={`src src-${skill.sourceLevel}`}>{skillSourceLabel(skill)}</span>
            <span className="kv">
              {skill.sourceRoot || "—"}
              {skill.estTokens > 0 ? <> · {formatTokensShort(skill.estTokens)} tok <i className="badge-tag est">估</i></> : null}
              {skill.pluginName ? ` · 插件 ${skill.pluginName}（推断）` : ""}
            </span>
          </div>
        )) : <p className="comp-legacy-note">本步无 Skills 注入名单。</p>}
      </GroupSection>

      <GroupSection title="Rules / Instructions" count={inventory.rules.length} defaultOpen={false}>
        {inventory.rules.length > 0 ? inventory.rules.map((rule, index) => (
          <div key={`${rule.kind}-${rule.path ?? index}`} className="skill-row">
            <span className="sname">{ruleLabel(rule.kind)}</span>
            <span className={`src src-${ruleSourceLevel(rule.kind)}`}>{ruleBadgeLabel(rule.kind)}</span>
            <span className="kv">
              {rule.path || "—"}
              {rule.estTokens > 0 ? <> · {formatTokensShort(rule.estTokens)} tok <i className="badge-tag est">估</i></> : null}
            </span>
          </div>
        )) : <p className="comp-legacy-note">本步无规则注入。</p>}
      </GroupSection>

      {harnessTokens ? (
        <div className="foot-block">
          <div className="dt">
            Harness Context
            <span className="badge-tag est">估算 · {harnessTokens.calibrated ? `按实际 Input ${(harnessTokens.inputTokens ?? 0).toLocaleString()} 校准` : "未经校准"}</span>
          </div>
          <div className="comp-rows">
            {([
              ["toolsNonMcp", "Tools 定义"],
              ["mcp", "MCP 定义"],
              ["skills", "Skills"],
              ["rules", "Rules"],
            ] as const).map(([key, label]) => {
              const value = harnessTokens.byComponent[key];
              const shareOfHarness = harnessTokens.total > 0 ? Math.round(value * 100 / harnessTokens.total) : 0;
              const shareOfInput = harnessTokens.inputTokens && harnessTokens.inputTokens > 0
                ? Math.round(value * 1000 / harnessTokens.inputTokens) / 10
                : 0;
              return (
                <div key={key} className="comp-row">
                  <span className="comp-label">{label}</span>
                  <span className="comp-bar"><i style={{ width: `${Math.max(2, shareOfHarness)}%` }} /></span>
                  <span className="comp-value mono">{value.toLocaleString()}</span>
                  <span className="comp-pct">{shareOfHarness}% / {shareOfInput}%</span>
                </div>
              );
            })}
            <div className="comp-row total-row">
              <span className="comp-label">Harness 合计</span>
              <span className="comp-bar"><i style={{ width: "100%" }} /></span>
              <span className="comp-value mono">{harnessTokens.total.toLocaleString()}</span>
              <span className="comp-pct">占 Input {harnessTokens.shareOfInput !== undefined ? `${Math.round(harnessTokens.shareOfInput * 1000) / 10}%` : "—"}</span>
            </div>
          </div>
          <div className="note-strip">
            右列 = 占 Harness 比例 / 占全部 Input 比例。完整构成见「上下文」页签 →{" "}
            <button type="button" className="comp-link" onClick={onOpenContext}>去上下文</button>
          </div>
        </div>
      ) : null}

      {changes && changesCount > 0 ? (
        <div className="foot-block">
          <div className="dt">
            快照变化
            {changes.fromSnapshotHash ? <span className="event-badge mono">vs {shortHashLabel(changes.fromSnapshotHash)}</span> : null}
            {changes.fromStepIndex ? <span className="event-badge">Step {changes.fromStepIndex} → {harness.stepIndex}</span> : null}
          </div>
          <div className="harness-diff-lines">
            {changes.toolsAdded.map(name => <span key={`ta-${name}`} className="add">+ tool: {name}</span>)}
            {changes.toolsRemoved.map(name => <span key={`tr-${name}`} className="rem">− tool: {name}</span>)}
            {changes.skillsAdded.map(name => <span key={`sa-${name}`} className="add">+ skill: {name}</span>)}
            {changes.skillsRemoved.map(name => <span key={`sr-${name}`} className="rem">− skill: {name}</span>)}
            {changes.rulesAdded.map(name => <span key={`ra-${name}`} className="add">+ rule: {name}</span>)}
            {changes.rulesRemoved.map(name => <span key={`rr-${name}`} className="rem">− rule: {name}</span>)}
          </div>
        </div>
      ) : null}

      {/* 协议能力（2026-09-21 UI 优化）：传输层事实非清单主叙事，移至页签底部并默认折叠；
          面板本体与数据不变。 */}
      <details className="protocol-fold">
        <summary>
          协议能力 · {protocolLabel(protocol)}
        </summary>
        <ProtocolCapabilityPanel protocol={protocol} isStreaming={isStreaming} step={step} />
      </details>
    </div>
  );
}

type HarnessToolEntry = ApiAgentStepHarness["inventory"]["tools"][number];

/**
 * 工具清单按「调用时间线」的读法排序：本步调用过 → 本步新增 → 其余继承而来，
 * 当前请求用到的工具描重，继承项弱化 —— 一眼看出「这次用了什么、其余从哪来」。
 */
function sortToolsForStep(tools: HarnessToolEntry[], addedNames: Set<string>): HarnessToolEntry[] {
  const rank = (tool: HarnessToolEntry) => (tool.invoked ? 0 : addedNames.has(tool.name) ? 1 : 2);
  return [...tools].sort((a, b) => rank(a) - rank(b)
    || b.callsThisStep - a.callsThisStep
    || a.name.localeCompare(b.name));
}

function HarnessToolRow({ tool, onInspectTool, addedThisStep }: {
  tool: HarnessToolEntry;
  onInspectTool: (toolName: string) => void;
  addedThisStep: boolean;
}) {
  return (
    <div className={`trow${tool.invoked ? " on" : ""}`}>
      <span className={`tname${tool.invoked ? "" : " dim"}`}>{tool.name}</span>
      <span className={`src${addedThisStep ? " src-step" : ""}`}>{addedThisStep ? "本步定义" : "继承"}</span>
      <span className={`num${tool.invoked ? "" : " dim"}`}>
        {tool.invoked ? <b>{tool.callsThisStep}</b> : "0"} / {tool.callsThisTurn}
      </span>
      <span className={`num${tool.invoked ? " yes" : " no"}`}>{tool.invoked ? "✓" : "—"}</span>
      <span className="num mono dim">{tool.defTokensEst > 0 ? tool.defTokensEst.toLocaleString() : "—"}</span>
      <span className="num">
        {tool.invoked ? (
          <button type="button" className="tool-inspect-link" onClick={() => onInspectTool(tool.name)}>
            交互内容 →
          </button>
        ) : <span className="dim">—</span>}
      </span>
    </div>
  );
}

/** demo 样式的可折叠分组：▾ 标题 + 计数 + 右侧事实标注。 */
function GroupSection({ title, count, note, defaultOpen = true, children }: {
  title: string;
  count: number;
  note?: string;
  /** 默认展开状态：工具清单默认展开，MCP / Skills / Rules 默认收起（2026-09-21）。 */
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="hgroup">
      <button type="button" className="hgroup-head" onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {title}
        <small className="cnt">{count}</small>
        {note ? <em className="hgroup-note">{note}</em> : null}
      </button>
      {open ? <div className="hgroup-body">{children}</div> : null}
    </section>
  );
}

function groupMcpTools(tools: ApiAgentStepHarness["inventory"]["tools"]): Array<{
  server: string;
  tools: ApiAgentStepHarness["inventory"]["tools"];
}> {
  const groups = new Map<string, ApiAgentStepHarness["inventory"]["tools"]>();
  for (const tool of tools) {
    if (tool.kind !== "mcp") continue;
    const server = tool.mcpServer || "mcp";
    const bucket = groups.get(server);
    if (bucket) bucket.push(tool);
    else groups.set(server, [tool]);
  }
  return [...groups.entries()].map(([server, groupTools]) => ({ server, tools: groupTools }));
}

function formatTokensShort(value: number): string {
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

function ruleGroupLabel(rules: ApiAgentStepHarness["inventory"]["rules"]): string {
  if (rules.length === 0) return "无规则注入";
  const agentsMd = rules.filter(rule => rule.kind.startsWith("agents_md")).length;
  const claudeMd = rules.filter(rule => rule.kind.startsWith("claude_md")).length;
  const permissions = rules.filter(rule => rule.kind === "permissions").length;
  const parts: string[] = [];
  if (agentsMd > 0) parts.push(`AGENTS.md ×${agentsMd}`);
  if (claudeMd > 0) parts.push(`CLAUDE.md ×${claudeMd}`);
  if (permissions > 0) parts.push("permissions");
  return parts.join(" · ") || `${rules.length} 条`;
}

function skillSourceLabel(skill: ApiAgentStepHarness["inventory"]["skills"][number]): string {
  return skillSourceLevelLabel(skill.sourceLevel);
}

function skillSourceLevelLabel(sourceLevel: "system" | "user" | "plugin" | "project" | "unknown"): string {
  switch (sourceLevel) {
    case "system": return "系统";
    case "user": return "用户";
    case "plugin": return "插件";
    case "project": return "项目";
    default: return "未知";
  }
}

function ruleSourceLevel(kind: ApiAgentStepHarness["inventory"]["rules"][number]["kind"]): string {
  if (kind.endsWith("_project")) return "project";
  if (kind === "permissions") return "system";
  return "user";
}

function ruleBadgeLabel(kind: ApiAgentStepHarness["inventory"]["rules"][number]["kind"]): string {
  switch (kind) {
    case "agents_md_project": return "项目";
    case "agents_md_global": return "全局";
    case "claude_md_project": return "项目";
    case "claude_md_global": return "全局";
    case "permissions": return "系统";
    default: return "注入";
  }
}

function ruleLabel(kind: ApiAgentStepHarness["inventory"]["rules"][number]["kind"]): string {
  switch (kind) {
    case "agents_md_project": return "AGENTS.md（项目级）";
    case "agents_md_global": return "AGENTS.md（全局）";
    case "claude_md_project": return "CLAUDE.md（项目级）";
    case "claude_md_global": return "CLAUDE.md（全局）";
    case "permissions": return "permissions instructions";
    default: return kind;
  }
}
/**
 * 业务 ID 块（2026-09-19 用户确认）：标题「业务ID」，下面逐行列出 Agent 侧上报的
 * 原生 Session / Thread / Turn / Step ID；只展示真实存在的业务值，每行带一键复制。
 * 这些 ID 不是 DeepAA 内部的 AgentSession/Thread/Turn/Step.id。
 */
function BusinessIdsFact({ ids }: { ids: Array<{ label: string; value: string }> }) {
  if (ids.length === 0) return null;
  return (
    <div className="fact fact-wide business-ids">
      <span>业务ID</span>
      <div className="fact-wide-value business-ids-rows">
        {ids.map(item => (
          <BusinessIdRow key={item.label} label={item.label} value={item.value} />
        ))}
      </div>
    </div>
  );
}

function BusinessIdRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时保持静默：值本身可手动选中复制。
    }
  }, [value]);
  return (
    <div className="business-id-row">
      <span className="business-id-key">{label}</span>
      <strong className="mono" title={value}>{value}</strong>
      <button type="button" className="comp-link" onClick={() => void copy()}>
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

/**
 * 总览 · 基本信息：把原来散落的 13 个事实块收敛成一条「这次请求是什么」的答案。
 * 数据全部来自 SQLite 有界投影与随快照冻结的计价字段，不读取任何正文。
 */
function BasicInfoSection({ step, projection, session, businessIds }: {
  step?: AgentStep;
  projection?: ExchangeProjectionDetail;
  session?: { externalSessionId?: string; source?: string };
  /** 当前选中层级能取到的业务 Thread/Turn ID（有业务值才展示对应行）。 */
  businessIds?: { externalThreadId?: string; nativeTurnId?: string };
}) {
  // 公式时刻/份额链按右上角全局时区展示（2026-10-09 B2）。
  const globalTz = useGlobalTimeZone();
  // 请求状态按状态码着色：2xx 绿色成功，4xx/5xx 红色失败；无状态码保持中性。
  const statusTone = step?.httpStatus !== undefined
    ? (step.httpStatus >= 400 ? "bad" as const : "good" as const)
    : undefined;
  const status = step?.httpStatus !== undefined
    ? `${step.httpStatus >= 400 ? "失败" : "成功"} · ${step.httpStatus}`
    : step ? stepStatusLabel(step) : undefined;
  const channel = step
    ? step.origin === "agent_local_import" ? "直连（本地导入）" : "网关代理"
    : undefined;
  const realCost = estimatedRealCostOf(step, globalTz.iana);
  const businessIdRows = [
    ...(session?.externalSessionId?.trim()
      ? [{label: "业务 Session", value: session.externalSessionId.trim()}]
      : []),
    ...(businessIds?.externalThreadId?.trim()
      ? [{label: "业务 Thread", value: businessIds.externalThreadId.trim()}]
      : []),
    ...(businessIds?.nativeTurnId?.trim()
      ? [{label: "业务 Turn", value: businessIds.nativeTurnId.trim()}]
      : []),
    ...(step?.nativeStepId?.trim()
      ? [{label: "业务 Step", value: step.nativeStepId.trim()}]
      : []),
  ];
  return (
    <section className="overview-summary-section basic-info">
      <header>
        <span>基本信息</span>
      </header>
      <div className="overview-summary-content">
        <div className="fact-grid basic-info-grid">
          <Fact label="Agent" value={projection?.agent.name} />
          <Fact label="通道" value={channel} />
          <Fact label="供应商" value={projection?.routing.targetName || step?.targetName || projection?.routing.targetId} />
          <Fact label="模型" value={projection?.model || step?.pricingSnapshot?.matchedModel} />
          <Fact label="请求协议" value={protocolLabel(projection?.preview.protocol)} />
          <Fact label="请求阶段" value={step ? phaseLabel(step.phase) : undefined} />
          <Fact label="请求状态" value={status} tone={statusTone} />
          <Fact label="请求时间" value={step ? formatLocalDateTime(step.timestamp) : undefined} />
          <Fact label="首字耗时" value={formatFirstTokenLatency(step?.firstTokenMs)} />
          <Fact label="总响应耗时" value={formatDuration(step?.durationMs ?? projection?.durationMs)} />
          <Fact label="结果分类" value={step ? resultClassLabel(step) : undefined} />
          <Fact
            label={realCost?.label ?? "估算真实成本"}
            value={realCost?.value}
            tone="money"
            title={realCost?.hint}
            help={realCost?.formula ? <CostHelp formula={realCost.formula} label={`${realCost.label}计算过程`} /> : undefined}
          />
          <BusinessIdsFact ids={businessIdRows} />
        </div>
      </div>
    </section>
  );
}

function Fact({ label, value, tone, title, help }: {
  label: string;
  value?: string;
  /** money = 金额（全站唯一允许出现黄铜的位置）；good/bad = 请求成功/失败状态色。 */
  tone?: "money" | "good" | "bad";
  /** 悬浮补充说明（如估算口径），不改变展示值；只挂在金额文本上——hover ？时
   *  原生 title 与米黄计算过程浮窗不叠加（2026-09-23）。 */
  title?: string;
  /** 金额右侧的 ？计算过程浮窗（CostHelp），与 Token 价格页明细共用同一实现；
   *  携带 ？ 时金额与 ？ 同行展示（不换行，？ 前间距由基类统一）。 */
  help?: ReactNode;
}) {
  const toneClass = tone === "money"
    ? " money"
    : tone === "good"
      ? " tone-good"
      : tone === "bad"
        ? " tone-bad"
        : "";
  return (
    <div className={`fact${toneClass}`}>
      <span>{label}</span>
      <strong className={help ? "fact-amount-help" : undefined}>
        <span className="fact-amount" title={title}>{value || "-"}</span>
        {help}
      </strong>
    </div>
  );
}

function OverviewToolResults({ toolResultIds }: { toolResultIds: string[] }) {
  const [open, setOpen] = useState(false);
  if (toolResultIds.length === 0) return <Fact label="工具结果" value="无" />;
  // 保留组件：4.6 能力清单与交互内容下钻仍使用同一份展开语义。
  // 统一用“数量 + 展开”结构，避免工具结果从 0 到 N 时卡片结构切换造成高度跳动。
  return (
    <div className="fact overview-tool-results">
      <span>工具结果</span>
      <strong>{toolResultIds.length} 个</strong>
      <button type="button" aria-label="展开或收起工具结果" onClick={() => setOpen(current => !current)}>
        {open ? "收起" : "展开"}
      </button>
      {!open ? <small>默认折叠，仅显示数量</small> : null}
      {open ? (
        <div className="overview-tool-results-list">
          {toolResultIds.map(id => <code key={id}>{id}</code>)}
        </div>
      ) : null}
    </div>
  );
}

function InspectorSection({ title, icon, defaultOpen = false, largeContent = false, children }: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  largeContent?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [fullscreenSectionId, setFullscreenSectionId] = useState("");
  const fullscreen = !!fullscreenSectionId;
  return (
    <>
      <section className="inspector-section">
        <button
          type="button"
          className="inspector-section-header"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
        >
          <span className={`section-toggle ${open ? "open" : ""}`}>▶</span>
          {icon}
          <span>{title}</span>
          {largeContent ? (
            <span
              role="button"
              tabIndex={0}
              className="fullscreen-action"
              onClick={event => {
                event.stopPropagation();
                setOpen(true);
                setFullscreenSectionId(title);
              }}
              onKeyDown={event => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                setOpen(true);
                setFullscreenSectionId(title);
              }}
            >
              <Maximize2 size={13} />
              全屏查看
            </span>
          ) : null}
        </button>
        <div className={`inspector-section-body json-panel${open ? "" : " collapsed"}`}>{open ? children : null}</div>
      </section>
      {fullscreen ? (
        <div className="fullscreen-section-backdrop" role="dialog" aria-modal="true" aria-label={`${title} 全屏查看`}>
          <section className="fullscreen-section-shell inspector-section fullscreen">
            <div className="fullscreen-section-header">
              <strong>{title}</strong>
              <button type="button" className="fullscreen-action restore" onClick={() => setFullscreenSectionId("")}>
                <Minimize2 size={14} />
                退出全屏
              </button>
            </div>
            <div className="inspector-section-body json-panel">{children}</div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function redactedRequest(exchange?: ExchangeIndexItem) {
  if (!exchange) return {};
  return {
    exchangeId: exchange.exchangeId,
    captureSessionId: exchange.captureSessionId,
    routing: exchange.routing,
    request: exchange.request,
    note: "完整 raw request 请通过 /api/exchanges/:exchangeId 下钻读取；首屏默认只携带脱敏索引。",
  };
}

interface JsonLine {
  id: string;
  depth: number;
  path: string;
  prefix?: string;
  content: string;
  truncatedStringContent?: string;
  fullStringContent?: string;
  mediaSegments?: WorkbenchRawMediaTextSegment[];
  mediaStringExpandable?: boolean;
  suffix?: string;
  collapsedPreview?: string;
  collapsedChildCount?: number;
  collapsedChildKind?: string;
  collapsedSuffix?: string;
  foldId?: string;
  foldStart?: boolean;
  foldEnd?: boolean;
}

interface JsonLineDiff {
  addedLineIds: Set<string>;
  removedBeforeLineId: Map<string, JsonLine[]>;
  trailingRemovedLines: JsonLine[];
}

function captureDisplayTitle(capture: CaptureSummary): string {
  const target = capture.targetSet.slice(0, 2).join(", ") || "未知供应商";
  const model = capture.modelSet[0] || "未知模型";
  return `${target} · ${model}`;
}

function turnDisplayTitle(turn: AgentTurn, session: AgentSession | undefined): string {
  const externalSessionId = session?.externalSessionId || turn.externalSessionId;
  const externalThreadId = session?.externalThreadId || turn.externalThreadId;
  const label = externalSessionId || externalThreadId;
  if (label) return `${agentDisplayName(turn.agentFingerprintId || session?.agentFingerprintId)} · ${compactSessionId(label)}`;
  return turn.id.slice(0, 26);
}

function agentDisplayName(fingerprintId: string | undefined): string {
  if (!fingerprintId) return "未知 Agent";
  if (fingerprintId.includes("claude-code")) return "Claude Code";
  if (fingerprintId.includes("codex")) return "Codex";
  if (fingerprintId.includes("opencode")) return "OpenCode";
  if (fingerprintId.includes("dsh")) return "DeepSeek Harness";
  if (fingerprintId.includes("zcode")) return "ZCode";
  if (fingerprintId.includes("anthropic-sdk")) return "Anthropic SDK";
  if (fingerprintId.includes("openai-sdk")) return "OpenAI SDK";
  if (fingerprintId.includes("curl")) return "curl";
  return fingerprintId.replace(/^fp-/, "");
}

/** 会话归属置信度含义：说明该 session 如何从抓包请求中归并而出，exact 表示会话标识直接取自请求头/字段，最可靠 */
function sessionConfidenceHint(confidence: AgentSession["confidence"]): string {
  switch (confidence) {
    case "exact": return "会话归属置信度·exact：会话标识直接取自请求头/字段，归属最可靠";
    case "high": return "会话归属置信度·high：依据强证据（工具链/会话字段）归并，较可靠";
    case "medium": return "会话归属置信度·medium：仅依据部分证据推断，可能存在误差";
    case "low": return "会话归属置信度·low：仅依据时间窗等弱证据归并，仅供参考";
    default: return "会话归属置信度";
  }
}

function compactSessionId(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 18)}...${value.slice(-6)}`;
}

function latestTurnExchangeTime(turn: AgentTurn, exchanges: ExchangeIndexItem[]): string | undefined {
  const evidenceIds = new Set([...turn.exchangeIds, ...turn.auxiliaryExchangeIds]);
  return exchanges
    .filter(item => evidenceIds.has(item.exchangeId))
    .map(item => item.completedAt || item.capturedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function latestStepForTurn(steps: AgentStep[], turnId: string | undefined): AgentStep | undefined {
  if (!turnId) return undefined;
  return steps
    .filter(item => item.turnId === turnId)
    .sort((a, b) => b.index - a.index)[0];
}

function workbenchSessionOptions(sessions: AgentSession[], exchanges: ExchangeIndexItem[]) {
  return sessions.map(sessionItem => ({
    id: sessionItem.id,
    targetSet: sessionItem.targetSet,
    agentName: agentNameForSession(sessionItem, exchanges),
  }));
}

type RuntimeAgentTurn = AgentTurn & { stepCount?: number; auxiliaryRequestCount?: number };

function runtimeTurnStepCount(turn: AgentTurn | undefined): number {
  return turn ? (turn as RuntimeAgentTurn).stepCount ?? turn.exchangeIds.length : 0;
}

function runtimeTurnAuxiliaryCount(turn: AgentTurn | undefined): number {
  return turn ? (turn as RuntimeAgentTurn).auxiliaryRequestCount ?? turn.auxiliaryExchangeIds.length : 0;
}

function agentNameForSession(sessionItem: AgentSession, exchanges: ExchangeIndexItem[]): string | undefined {
  return agentNameFromSessionEvidence(
    sessionItem.exchangeIds,
    sessionItem.auxiliaryExchangeIds,
    exchanges,
  );
}

function turnDetailSignature(turn: AgentTurn, stepCandidateCount: number): string {
  return [
    turn.id,
    stepCandidateCount,
    runtimeTurnStepCount(turn),
    runtimeTurnAuxiliaryCount(turn),
    turn.exchangeIds.at(-1) || "",
    turn.auxiliaryExchangeIds.at(-1) || "",
    turn.endTime,
  ].join("|");
}

function countTurnStepCandidates(turn: AgentTurn, exchanges: ExchangeIndexItem[]): number {
  const exchangeIds = new Set(turn.exchangeIds);
  return Math.max(runtimeTurnStepCount(turn), exchanges.filter(item => exchangeIds.has(item.exchangeId)).length);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of items) merged.set(item.id, item);
  return [...merged.values()];
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return uniqueById([...current, ...incoming]);
}

function mergeByTurnId<T extends { turnId: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map(item => [item.turnId, item]));
  for (const item of incoming) merged.set(item.turnId, item);
  return [...merged.values()];
}

/** Session 分页按新到旧返回；反转后逐个 touch，确保最新 Turn 最终位于 MRU。 */
function runtimeAccessedTurnIds(steps: AgentStep[]): string[] {
  return [...new Set([...steps].reverse().map(item => item.turnId))];
}

function runtimeCacheProtectedTurnIds(
  selectedTurnId: string,
  selectedStepId: string,
  candidateSteps: AgentStep[],
  additionalTurnIds: readonly string[] = [],
): string[] {
  const selectedStepTurnId = candidateSteps.find(item => item.id === selectedStepId)?.turnId;
  return [...new Set([
    selectedTurnId,
    selectedStepTurnId || "",
    ...additionalTurnIds,
  ].filter(Boolean))];
}

function clampColumnSize(column: ResizableColumn, value: number): number {
  const max = column === "inspector" ? 1400 : 520;
  return Math.max(minColumnSizes[column], Math.min(max, Math.round(value)));
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * SSE 事件时间线组件：按序号展示每个事件的类型标签和摘要，支持折叠展开查看完整 data。
 */
function SseTimeline({ events, mediaContext }: {
  events: Array<{ index: number; event: string; data: unknown; rawData: string }>;
  mediaContext?: WorkbenchMediaRenderContext;
}) {
  const renderLimit = useRenderLineLimit();
  const [showAllEvents, setShowAllEvents] = useState(false);
  const visibleEvents = showAllEvents ? events : events.slice(0, renderLimit);
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(
    () => new Set(
      events
        .filter(event => valueContainsWorkbenchMediaMarker(event.data))
        .map(event => event.index),
    ),
  );
  return (
    <div className="sse-timeline">
      {!showAllEvents && events.length > renderLimit ? (
        <div className="json-truncation-notice">
          共 {events.length} 个事件，已省略后续内容…
          <button type="button" className="json-code-action" onClick={() => setShowAllEvents(true)}>
            显示全部 {events.length} 个事件
          </button>
        </div>
      ) : null}
      {visibleEvents.map(event => {
        const expanded = expandedIndices.has(event.index);
        const summary = sseEventSummary(event.data);
        return (
          <div key={event.index} className={`sse-timeline-row${expanded ? " expanded" : ""}`}>
            <button
              type="button"
              className="sse-timeline-header"
              onClick={() => setExpandedIndices(current => {
                const next = new Set(current);
                if (next.has(event.index)) next.delete(event.index);
                else next.add(event.index);
                return next;
              })}
            >
              <span className="sse-index">#{event.index + 1}</span>
              <span className={`sse-event-tag ${sseEventCategory(event.event)}`}>{sseEventLabel(event)}</span>
              <span className="sse-summary">{summary}</span>
            </button>
            {expanded ? (
              <div className="sse-timeline-detail">
                <JsonCodeViewer value={event.data ?? event.rawData} mediaContext={mediaContext} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * SSE 事件显示名：优先用 `event:` 行；OpenAI Chat Completions 的 chunk 既没有
 * `event:` 行、data 里也没有 `type` 字段，旧逻辑会一律显示 unknown（用户反馈），
 * 这里按 chunk 的数据结构推导出可读的语义名。
 */
function sseEventLabel(event: { event: string; data: unknown }): string {
  if (event.event && event.event !== "unknown" && event.event !== "message") return event.event;
  const data = event.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.type === "string" && record.type) return record.type;
    const choice = sseFirstChoice(record);
    const delta = choice?.delta && typeof choice.delta === "object"
      ? choice.delta as Record<string, unknown>
      : undefined;
    if (delta) {
      if (delta.tool_calls !== undefined) return "tool_calls.delta";
      if (typeof delta.reasoning_content === "string" || typeof delta.reasoning === "string") return "reasoning.delta";
      if (typeof delta.content === "string") return "content.delta";
      if (typeof delta.role === "string") return "role";
    }
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) return `finish: ${choice.finish_reason}`;
    if (record.usage && typeof record.usage === "object") return "usage";
    if (typeof record.object === "string" && record.object) return record.object;
    if (typeof record.id === "string") return "chunk";
  }
  return event.event || "message";
}

function sseFirstChoice(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : undefined;
}

function sseEventSummary(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data.slice(0, 80);
  if (typeof data !== "object") return String(data).slice(0, 80);
  const record = data as Record<string, unknown>;
  // OpenAI Chat Completions / Responses 的增量 chunk：把真正有信息量的部分摘要出来
  const choice = sseFirstChoice(record);
  if (choice) {
    const delta = choice.delta && typeof choice.delta === "object"
      ? choice.delta as Record<string, unknown>
      : undefined;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) return delta.content.slice(0, 80);
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        return `推理：${delta.reasoning_content.slice(0, 72)}`;
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        const call = delta.tool_calls[0] as Record<string, unknown> | undefined;
        const fn = call?.function && typeof call.function === "object"
          ? call.function as Record<string, unknown>
          : undefined;
        const name = typeof fn?.name === "string" ? fn.name : "";
        return name ? `工具调用：${name}` : "工具调用参数增量";
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      return `结束原因：${choice.finish_reason}`;
    }
  }
  if (typeof record.text === "string") return record.text.slice(0, 80);
  if (typeof record.delta === "string") return record.delta.slice(0, 80);
  if (record.response && typeof record.response === "object") {
    const resp = record.response as Record<string, unknown>;
    if (typeof resp.status === "string") return `status: ${resp.status}`;
    if (typeof resp.id === "string") return `id: ${resp.id}`;
  }
  if (typeof record.type === "string") return record.type;
  if (record.usage && typeof record.usage === "object") return "usage 统计";
  return "";
}

function sseEventCategory(event: string): string {
  if (event.includes("created") || event.includes("start")) return "cat-start";
  if (event.includes("completed") || event.includes("stop") || event === "done") return "cat-end";
  if (event.includes("delta")) return "cat-delta";
  if (event.includes("error") || event.includes("failed")) return "cat-error";
  if (event.includes("tool")) return "cat-tool";
  return "cat-default";
}

async function fetchExchangeProjection(
  exchangeId: string,
  signal?: AbortSignal,
): Promise<ExchangeProjectionDetail | undefined> {
  const response = await fetch(`/api/exchanges/${encodeURIComponent(exchangeId)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseExchangeProjectionResponse(await response.json(), exchangeId)?.projection;
}

async function fetchOptionalStepContextSnapshot(stepId: string, turnId?: string) {
  const query = turnId ? `?turnId=${encodeURIComponent(turnId)}` : "";
  const response = await fetch(`/api/agent-steps/${encodeURIComponent(stepId)}/context-snapshot${query}`, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseWorkbenchContextSnapshotState(await response.json());
}

async function fetchOptionalStepDiff(stepId: string, turnId?: string) {
  const query = turnId ? `?turnId=${encodeURIComponent(turnId)}` : "";
  const response = await fetch(`/api/agent-steps/${encodeURIComponent(stepId)}/diff${query}`, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseWorkbenchStepDiffState(await response.json());
}

function findPreviousExchangeId(exchangeId: string, exchanges: ExchangeIndexItem[]): string | undefined {
  const chronological = [...exchanges].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const index = chronological.findIndex(item => item.exchangeId === exchangeId);
  if (index <= 0) return undefined;
  return chronological[index - 1]?.exchangeId;
}

function buildProjectionOverviewSummary(
  current: ExchangeProjectionDetail | undefined,
  previous: ExchangeProjectionDetail | undefined,
  fallback: ExchangeIndexItem | undefined
): { requestSummary: string; requestSource: string; responseSummary: string; responseSource: string } {
  void fallback;
  const requestSummary = projectionOverviewSideSummary(current, previous, "request");
  const responseSummary = projectionOverviewSideSummary(current, undefined, "response");
  return {
    requestSummary: requestSummary || projectionRequestSummary(current),
    requestSource: requestSummary
      ? previous ? "SQLite Content Preview · 已排除上一 Step 上下文" : "SQLite Content Preview"
      : current ? "Exchange 投影" : "索引摘要",
    responseSummary: responseSummary || projectionResponseSummary(current),
    responseSource: responseSummary
      ? "SQLite Content Preview"
      : current ? "Exchange 投影" : "索引摘要",
  };
}

function fallbackRequestSummary(fallback: ExchangeIndexItem | undefined): string {
  return fallback
    ? `${fallback.routing.method} ${fallback.routing.localPath} · 模型 ${fallback.request.model || "未知"} · 请求体 ${formatSize(fallback.request.bodySizeBytes)}`
    : "";
}

function fallbackResponseSummary(fallback: ExchangeIndexItem | undefined): string {
  return fallback
    ? `${fallback.response.status} ${fallback.response.statusText} · ${fallback.response.isStreaming ? "SSE" : "非流式"} · ${formatSize(fallback.response.bodySizeBytes)}`
    : "";
}

function projectionRequestSummary(current: ExchangeProjectionDetail | undefined): string {
  if (!current) return "请选择一条请求证据查看请求摘要。";
  const method = "POST";
  const path = current.routing?.targetName ? `${current.routing.targetName}` : "代理网关";
  return `HTTP ${method} ${path} · 模型 ${current.model || "未知"} · 请求体 ${formatSize(current.request.sizeBytes)}`;
}

function projectionResponseSummary(current: ExchangeProjectionDetail | undefined): string {
  if (!current) return "请选择一条请求证据查看响应摘要。";
  const status = current.response.status;
  const isError = status >= 400;
  const streaming = current.response.isStreaming ? "SSE" : "非流式";
  const size = formatSize(current.response.sizeBytes);
  if (isError) {
    return `HTTP ${status} 上游错误 · ${streaming} · 响应体 ${size}${statusTextHint(status)}`;
  }
  return `HTTP ${status} · ${streaming} · 响应体 ${size}`;
}

function statusTextHint(status: number): string {
  if (status === 502) return "（Bad Gateway：上游网关/供应商错误）";
  if (status === 503) return "（Service Unavailable：上游暂不可用）";
  if (status === 504) return "（Gateway Timeout：上游超时）";
  if (status === 429) return "（Rate Limited：请求频率限制）";
  if (status === 401) return "（Unauthorized：鉴权失败）";
  if (status === 403) return "（Forbidden：权限不足）";
  if (status === 500) return "（Internal Server Error：上游服务错误）";
  return "";
}

function extractPrimaryUserInput(value: unknown): string | undefined {
  const body = asRecord(value);
  if (!body) return undefined;
  if (typeof body.input === "string") return compactText(body.input, 1600);

  const input = Array.isArray(body.input) ? body.input : undefined;
  const responsesUserMessage = findLastMessageText(input, "user");
  if (responsesUserMessage) return responsesUserMessage;

  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  const chatUserMessage = findLastMessageText(messages, "user");
  if (chatUserMessage) return chatUserMessage;

  const prompt = stringValue(body.prompt);
  return prompt ? compactText(prompt, 1600) : undefined;
}

function extractPrimaryResponseText(value: unknown): string | undefined {
  const body = asRecord(value);
  if (!body) return typeof value === "string" ? compactText(value, 1600) : undefined;

  const outputText = stringValue(body.output_text);
  if (outputText) return compactText(outputText, 1600);

  const output = Array.isArray(body.output) ? body.output : undefined;
  const responsesText = collectOpenAIResponsesOutputText(output);
  if (responsesText) return responsesText;

  const choices = Array.isArray(body.choices) ? body.choices : undefined;
  const chatText = collectChatCompletionText(choices);
  if (chatText) return chatText;

  const content = Array.isArray(body.content) ? body.content : undefined;
  const anthropicText = contentText(content, ["text", "output_text"]);
  if (anthropicText) return anthropicText;

  const message = asRecord(body.message);
  const messageText = message ? contentText(message.content, ["text", "output_text"]) || stringValue(message.content) : undefined;
  return messageText ? compactText(messageText, 1600) : undefined;
}

function summarizeRequestUnits(value: unknown): Array<{ signature: string; text: string }> {
  const body = asRecord(value);
  if (!body) return value === undefined ? [] : [{ signature: stableJsonSignature(value), text: summarizeUnknownBody(value) }];
  const units: Array<{ signature: string; text: string }> = [];

  const input = Array.isArray(body.input) ? body.input : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  const conversation = input || messages || [];
  conversation.forEach((item, index) => {
    units.push({
      signature: stableJsonSignature(item),
      text: `消息 ${index + 1}: ${summarizeMessageLike(item)}`,
    });
  });

  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  tools?.forEach((tool, index) => {
    units.push({
      signature: stableJsonSignature(tool),
      text: `工具 Schema ${index + 1}: ${summarizeToolLike(tool)}`,
    });
  });

  const params = Object.fromEntries(Object.entries(body).filter(([key]) => !["input", "messages", "tools"].includes(key)));
  if (Object.keys(params).length > 0) {
    units.push({
      signature: stableJsonSignature(params),
      text: `请求参数: ${compactText(JSON.stringify(params, null, 2), 520)}`,
    });
  }
  return units;
}

function summarizeResponseUnits(value: unknown): string[] {
  const body = asRecord(value);
  if (!body) return value === undefined ? [] : [summarizeUnknownBody(value)];

  const output = Array.isArray(body.output) ? body.output : undefined;
  const content = Array.isArray(body.content) ? body.content : undefined;
  const choices = Array.isArray(body.choices) ? body.choices : undefined;
  const candidates = output || content || choices || [];
  const parts = candidates.map((item, index) => `响应 ${index + 1}: ${summarizeMessageLike(item)}`);

  if (typeof body.output_text === "string") parts.unshift(`文本: ${compactText(body.output_text, 1200)}`);
  if (typeof body.text === "string") parts.unshift(`文本: ${compactText(body.text, 1200)}`);
  if (typeof body.stop_reason === "string") parts.push(`停止原因: ${body.stop_reason}`);
  if (typeof body.finish_reason === "string") parts.push(`结束原因: ${body.finish_reason}`);
  if (body.usage) parts.push(`Token 用量: ${compactText(JSON.stringify(body.usage), 360)}`);

  return parts.filter(Boolean);
}

function findLastMessageText(items: unknown[] | undefined, role: string): string | undefined {
  if (!items) return undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = asRecord(items[index]);
    if (!item || item.role !== role) continue;
    const text = contentText(item.content, ["input_text", "text", "output_text"]) || stringValue(item.content);
    if (text) return compactText(text, 1600);
  }
  return undefined;
}

function collectOpenAIResponsesOutputText(output: unknown[] | undefined): string | undefined {
  if (!output) return undefined;
  const texts = output.flatMap(item => {
    const record = asRecord(item);
    if (!record) return [];
    if (record.type === "message") return contentText(record.content, ["output_text", "text"]);
    if (record.type === "reasoning") return contentText(record.summary, ["summary_text", "text"]);
    return stringValue(record.text);
  }).filter((value): value is string => !!value);
  return texts.length > 0 ? compactText(texts.join("\n\n"), 1600) : undefined;
}

function collectChatCompletionText(choices: unknown[] | undefined): string | undefined {
  if (!choices) return undefined;
  for (const choice of choices) {
    const message = asRecord(asRecord(choice)?.message);
    const content = contentText(message?.content, ["text", "output_text"]) || stringValue(message?.content);
    if (content) return compactText(content, 1600);
  }
  return undefined;
}

function contentText(value: unknown, textTypes: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const texts = value.map(item => {
    if (typeof item === "string") return item;
    const record = asRecord(item);
    if (!record) return "";
    const type = stringValue(record.type);
    if (type && !textTypes.includes(type)) return "";
    return stringValue(record.text)
      || stringValue(record.content)
      || stringValue(record.output)
      || stringValue(record.summary_text)
      || "";
  }).filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function summarizeMessageLike(value: unknown): string {
  if (typeof value === "string") return compactText(value, 1200);
  const record = asRecord(value);
  if (!record) return summarizeUnknownBody(value);

  const role = typeof record.role === "string" ? `${record.role} · ` : "";
  if (typeof record.text === "string") return `${role}${compactText(record.text, 1200)}`;
  if (typeof record.content === "string") return `${role}${compactText(record.content, 1200)}`;
  if (Array.isArray(record.content)) {
    return `${role}${record.content.map(summarizeContentBlock).filter(Boolean).join("\n")}`;
  }
  if (Array.isArray(record.output)) {
    return `${role}${record.output.map(summarizeContentBlock).filter(Boolean).join("\n")}`;
  }
  if (record.message) return `${role}${summarizeMessageLike(record.message)}`;
  if (record.delta) return `${role}${summarizeMessageLike(record.delta)}`;
  if (record.function_call) return `${role}${summarizeToolLike(record.function_call)}`;
  if (Array.isArray(record.tool_calls)) return `${role}${record.tool_calls.map(summarizeToolLike).join("\n")}`;
  return `${role}${compactText(JSON.stringify(record, null, 2), 1200)}`;
}

function summarizeContentBlock(value: unknown): string {
  if (typeof value === "string") return compactText(value, 1000);
  const record = asRecord(value);
  if (!record) return summarizeUnknownBody(value);
  const type = typeof record.type === "string" ? record.type : "content";
  if (typeof record.text === "string") return `${type}: ${compactText(record.text, 1000)}`;
  if (typeof record.thinking === "string") return `${type}: ${compactText(record.thinking, 1000)}`;
  if (typeof record.name === "string") return `${type}: ${record.name} ${compactText(JSON.stringify(record.input ?? record.arguments ?? {}), 600)}`;
  if (record.tool_use_id || record.tool_call_id) return `${type}: ${compactText(JSON.stringify(record.content ?? record.output ?? record, null, 2), 800)}`;
  return `${type}: ${compactText(JSON.stringify(record, null, 2), 800)}`;
}

function summarizeToolLike(value: unknown): string {
  const record = asRecord(value);
  if (!record) return summarizeUnknownBody(value);
  const fn = asRecord(record.function);
  const name = stringValue(record.name) || stringValue(fn?.name) || stringValue(record.id) || "unknown";
  const payload = record.input ?? record.arguments ?? fn?.arguments ?? record.parameters ?? {};
  return `${name}: ${compactText(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), 720)}`;
}

function summarizeUnknownBody(value: unknown): string {
  return typeof value === "string" ? compactText(value, 1200) : compactText(JSON.stringify(value, null, 2), 1200);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stableJsonSignature(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compactText(value: string | undefined, maxLength: number): string {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized || "-";
  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}

function formatTokenCount(value: number | undefined): string {
  return value === undefined ? "-" : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatRateValue(value: number | undefined): string {
  if (value === undefined) return "-";
  return `${formatCompactNumber(value)}/百万 token`;
}

function formatCompactNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function pricingMatchStrategyLabel(value: string): string {
  const labels: Record<string, string> = {
    target_override: "供应商覆盖价",
    // 目标级「支持模型 → 价格中心条目」映射精确命中（2026-09-19 用户反馈：原文不可读）。
    target_model_entry: "目标价格条目",
    official_preset_vendor_exact: "官方预设目录精确",
    official_preset_vendor_normalized_exact: "官方预设目录规范化精确",
    target_model_vendor_exact: "目标供应商精确",
    target_model_vendor_normalized_exact: "目标供应商规范化精确",
    target_vendor_exact: "供应商精确",
    target_vendor_normalized_exact: "供应商规范化精确",
    global_exact: "全局精确",
    global_exact_vendor_resolved: "全局精确（供应商消歧）",
    global_normalized_exact: "全局规范化精确",
    contains: "最长包含兜底",
    ambiguous: "模型歧义",
    unmatched: "未匹配",
    unverified: "价格待确认",
    usage_unavailable: "usage 不可用",
  };
  return labels[value] || value;
}

function unpricedReasonLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const labels: Record<string, string> = {
    model_unmatched: "模型未匹配",
    model_ambiguous: "模型歧义",
    price_unverified: "价格待确认",
    usage_unavailable: "usage 不可用",
    pricing_stale: "价格过期",
  };
  return labels[value] || value;
}

function buildJsonLineDiff(previousValue: unknown, currentLines: JsonLine[]): JsonLineDiff {
  const previousLines = buildJsonCodeLines(previousValue);
  const currentIndexesBySignature = new Map<string, number[]>();
  currentLines.forEach((line, index) => {
    const signature = jsonLineSignature(line);
    currentIndexesBySignature.set(signature, [...(currentIndexesBySignature.get(signature) || []), index]);
  });
  const signatureCursors = new Map<string, number>();
  const matchedCurrentIndexes = new Set<number>();
  const removedBeforeLineId = new Map<string, JsonLine[]>();
  const pendingRemoved: JsonLine[] = [];
  let searchStart = 0;

  for (const previousLine of previousLines) {
    const previousSignature = jsonLineSignature(previousLine);
    const currentIndexes = currentIndexesBySignature.get(previousSignature) || [];
    let cursor = signatureCursors.get(previousSignature) || 0;
    while (
      cursor < currentIndexes.length
        && (currentIndexes[cursor]! < searchStart || matchedCurrentIndexes.has(currentIndexes[cursor]!))
    ) {
      cursor++;
    }
    const matchedIndex = currentIndexes[cursor] ?? -1;
    signatureCursors.set(previousSignature, cursor + 1);

    if (matchedIndex >= 0) {
      if (pendingRemoved.length > 0) {
        const targetLineId = currentLines[matchedIndex]!.id;
        removedBeforeLineId.set(targetLineId, [
          ...(removedBeforeLineId.get(targetLineId) || []),
          ...pendingRemoved.splice(0),
        ]);
      }
      matchedCurrentIndexes.add(matchedIndex);
      searchStart = matchedIndex + 1;
    } else {
      pendingRemoved.push(previousLine);
    }
  }

  const addedLineIds = new Set(currentLines
    .map((line, index) => matchedCurrentIndexes.has(index) ? undefined : line.id)
    .filter((id): id is string => typeof id === "string"));

  return {
    addedLineIds,
    removedBeforeLineId,
    trailingRemovedLines: pendingRemoved,
  };
}

function jsonLineSignature(line: JsonLine): string {
  return [
    line.depth,
    line.prefix || "",
    line.content,
    line.foldStart ? "fold-start" : "",
    line.foldEnd ? "fold-end" : "",
  ].join("|");
}

function buildJsonCodeLines(value: unknown): JsonLine[] {
  const lines: JsonLine[] = [];
  let sequence = 0;
  let foldSequence = 0;

  function nextId() {
    sequence++;
    return `json-line-${sequence}`;
  }

  function nextFoldId() {
    foldSequence++;
    return `json-fold-${foldSequence}`;
  }

  function push(line: Omit<JsonLine, "id">) {
    lines.push({ id: nextId(), ...line });
  }

  function renderValue(item: unknown, depth: number, prefix = "", suffix = "", isLast = true, path = "$") {
    if (Array.isArray(item)) {
      renderArray(item, depth, prefix, suffix, isLast, path);
      return;
    }
    if (item && typeof item === "object") {
      renderObject(item as Record<string, unknown>, depth, prefix, suffix, isLast, path);
      return;
    }
    push({ depth, path, prefix, ...renderPrimitive(item), suffix: suffix || (isLast ? "" : ",") });
  }

  function renderArray(items: unknown[], depth: number, prefix: string, suffix: string, isLast: boolean, path: string) {
    if (items.length === 0) {
      push({ depth, path, prefix, content: "[]", suffix: suffix || (isLast ? "" : ",") });
      return;
    }
    const foldId = nextFoldId();
    const closeSuffix = suffix || (isLast ? "" : ",");
    push({
      depth,
      path,
      prefix,
      content: "[",
      collapsedPreview: buildCollapsedPreview("[", "]"),
      collapsedChildCount: items.length,
      collapsedChildKind: "项",
      collapsedSuffix: closeSuffix,
      foldId,
      foldStart: true,
    });
    items.forEach((item, index) => renderValue(item, depth + 1, "", "", index === items.length - 1, `${path}[${index}]`));
    push({ depth, path, content: "]", suffix: closeSuffix, foldId, foldEnd: true });
  }

  function renderObject(item: Record<string, unknown>, depth: number, prefix: string, suffix: string, isLast: boolean, path: string) {
    const entries = Object.entries(item);
    if (entries.length === 0) {
      push({ depth, path, prefix, content: "{}", suffix: suffix || (isLast ? "" : ",") });
      return;
    }
    const foldId = nextFoldId();
    const closeSuffix = suffix || (isLast ? "" : ",");
    push({
      depth,
      path,
      prefix,
      content: "{",
      collapsedPreview: buildCollapsedPreview("{", "}"),
      collapsedChildCount: entries.length,
      collapsedChildKind: "字段",
      collapsedSuffix: closeSuffix,
      foldId,
      foldStart: true,
    });
    entries.forEach(([key, child], index) => {
      renderValue(
        child,
        depth + 1,
        `<span class="json-key">"${escapeHtml(key)}"</span><span class="json-code-punctuation">: </span>`,
        "",
        index === entries.length - 1,
        `${path}.${key}`
      );
    });
    push({ depth, path, content: "}", suffix: closeSuffix, foldId, foldEnd: true });
  }

  renderValue(value ?? {}, 0, "", "", true, "$");
  return lines;
}

function displayLineSuffix(line: JsonLine, collapsed: boolean): string | undefined {
  return collapsed && line.collapsedSuffix !== undefined ? line.collapsedSuffix : line.suffix;
}

function buildCollapsedPreview(open: "{" | "[", close: "}" | "]"): string {
  return `<span class="json-code-collapsed-preview">${open}<span class="json-code-ellipsis">...</span>${close}</span>`;
}

function renderPrimitive(value: unknown): Pick<
  JsonLine,
  "content" | "truncatedStringContent" | "fullStringContent" | "mediaSegments" | "mediaStringExpandable"
> {
  if (value === null) return { content: '<span class="json-null">null</span>' };
  if (value === undefined) return { content: '<span class="json-null">undefined</span>' };
  if (typeof value === "string") {
    const exactMedia = parseWorkbenchMediaMarker(value);
    const mediaSegments = exactMedia
      ? [{ kind: "media" as const, ...exactMedia }]
      : splitWorkbenchRawMediaText(value);
    if (mediaSegments.some(segment => segment.kind === "media")) {
      return {
        content: '<span class="json-string">"[媒体]"</span>',
        mediaSegments,
        mediaStringExpandable: mediaSegments.some(segment =>
          segment.kind === "text" && segment.value.length > 240
        ),
      };
    }
    const truncatedStringContent = `<span class="json-string" title="${escapeHtml(value)}">${escapeHtml(formatJSONTreeString(value, 240))}</span>`;
    const fullStringContent = `<span class="json-string" title="${escapeHtml(value)}">${escapeHtml(formatJSONTreeString(value, Number.POSITIVE_INFINITY))}</span>`;
    return {
      content: truncatedStringContent,
      truncatedStringContent,
      fullStringContent: stringNeedsJsonTreeExpansion(value, 240) ? fullStringContent : undefined,
    };
  }
  if (typeof value === "number") return { content: `<span class="json-number">${value}</span>` };
  if (typeof value === "boolean") return { content: `<span class="json-boolean">${value}</span>` };
  return { content: `<span>${escapeHtml(String(value))}</span>` };
}

function formatJSONTreeString(value: string, maxLength = 180): string {
  const escaped = escapeJSONTreeString(value);
  const display = escaped.length > maxLength
    ? `${escaped.slice(0, maxLength)}... (${value.length} chars)`
    : escaped;
  return `"${display}"`;
}

function stringNeedsJsonTreeExpansion(value: string, maxLength: number): boolean {
  return escapeJSONTreeString(value).length > maxLength;
}

function escapeJSONTreeString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function captureFilterParams(filterState: { q: string; target: string; model: string; status: string; diagnostic: string }): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filterState)) {
    if (value.trim()) params.set(key, value.trim());
  }
  return params;
}

function evidencePathMatches(linePath: string, highlightedPath: string): boolean {
  if (highlightedPath === "$") return linePath === "$";
  const normalized = highlightedPath.startsWith("$") ? highlightedPath : `$.${highlightedPath}`;
  return linePath === normalized || linePath.startsWith(`${normalized}.`) || linePath.startsWith(`${normalized}[`);
}
