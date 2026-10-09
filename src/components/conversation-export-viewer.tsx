"use client";

import { AlertTriangle, ChevronRight, Download, ExternalLink, ImageIcon, Maximize2, Minimize2, RefreshCw, RotateCcw, SearchX, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RetentionScopeNotice } from "@/components/retention-scope-notice";
import type {
  ConversationCategory,
  ConversationItem,
  FullExportPreflight,
} from "@/lib/export-conversation";
import {
  buildRawMediaHref,
  ExportContentRequestError,
  groupExportContentExchanges,
  readExportContentError,
  streamExportContentPage,
  streamExportListPage,
  type ExportContentExchange,
  type ExportContentItem,
  type ExportContentPageResult,
  type ExportListRow,
} from "@/lib/export-content-client";
import type { ExportThreadDedupeFailureCode } from "@/lib/export-content-events";
import {
  ALL_CONTENT_CATEGORIES,
  INPUT_CONTENT_CATEGORIES,
  OUTPUT_CONTENT_CATEGORIES,
} from "@/lib/conversation-categories";
import { buildExportConversationQuery, type ExportConversationQueryInput } from "@/lib/export-query";
import {
  buildConversationJsonl,
  buildConversationMarkdown,
  CONVERSATION_CATEGORY_LABELS,
  safeDownloadFilename,
  type ExportDownloadSegment,
} from "@/lib/export-download-format";
import { formatFailoverBadgeText } from "@/lib/failover-display";
import { datetimeLocalValueToIso, formatLocalDateTime, isoToDatetimeLocalValue } from "@/lib/local-time";
import {useGlobalTimeZone} from "@/lib/timezone-preference";
import { MarkdownView } from "@/components/markdown-view";
import { agentDisplayName } from "@/lib/agent-display";

const INPUT_CATS = INPUT_CONTENT_CATEGORIES;
const OUTPUT_CATS = OUTPUT_CONTENT_CATEGORIES;
const ALL_CATS = ALL_CONTENT_CATEGORIES;
const PAGE_SIZE_OPTIONS = [2, 5, 10, 15, 25] as const;
const DEFAULT_EXCHANGE_LIMIT = 5;
const DEFAULT_PAGE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_CONFIRMED_EXCHANGE_BYTES = 128 * 1024 * 1024;
/** 无限加载列表每页步数（2026-09-17 用户确认：25 步/页，底部按钮继续加载）。 */
const LIST_PAGE_SIZE = 25;
/** 左侧时间/右侧摘要合并显示的列表行摘要上限。 */
const LIST_ROW_SUMMARY_MAX_CHARS = 240;
type FullDownloadFormat = "markdown" | "jsonl" | "json";

interface OversizedExchangeState {
  requestQuery: string;
  exchangeId: string;
  requiredBytes: number;
  confirmed: boolean;
  /** 列表多开模式下触发确认的展开视图；确认后按同一视图重新加载。 */
  view?: "new" | "full";
}

/**
 * 列表单条展开状态。2026-09-18 用户确认改回「单开」：
 * 点开新的一条会自动收起并释放上一条已加载的正文（避免同时堆积大量 raw），
 * 同一行同一视图再点即收起。
 */
interface StepExpansion {
  exchangeId: string;
  mode: "new" | "full";
  loading: boolean;
  error: string;
  data?: ExportContentPageResult;
}

const CAT_LABEL = CONVERSATION_CATEGORY_LABELS;

const AUXILIARY_KIND_LABEL: Record<NonNullable<ConversationItem["auxiliaryKind"]>, string> = {
  token_count: "Token 计数",
  auth_error: "鉴权错误",
  health_check: "健康检查",
  metadata: "元数据",
  title_generation: "会话标题生成",
  unknown: "其他辅助请求",
};

const DEDUPE_FAILURE_LABEL: Record<ExportThreadDedupeFailureCode, string> = {
  request_parse_failed: "上一条请求解析失败",
  raw_body_unavailable: "上一条请求正文不可用",
  raw_body_integrity_failed: "上一条请求完整性校验失败",
  baseline_raw_budget_exceeded: "历史请求累计超过 128 MiB 读取上限",
  fingerprint_limited: "上一条请求超过 4,096 项比对上限",
  context_unconfirmed: "已存储的比对证据不足",
};

export interface FilterOption { value: string; label: string; timestamp?: string; session?: string; thread?: string; turn?: string; }
export interface ExportFilterData {
  targets: FilterOption[];
  agents: FilterOption[];
  sessions: FilterOption[];
  threads: FilterOption[];
  turns: FilterOption[];
  steps: FilterOption[];
  limited?: Partial<Record<"targets" | "agents" | "sessions" | "threads" | "turns" | "steps", boolean>>;
}

interface ConversationExportViewerProps {
  mode: "fullPage" | "embedded";
  initialQuery: string;
  filterData?: ExportFilterData;
  onQueryChange?: (query: string, navigation: ExportQueryNavigation) => void;
  /** Harness 页签下钻：按工具名过滤当前 step 范围内已加载条目（客户端过滤）。 */
  toolNameFilter?: string;
  /** 「查看原文 →」的类别下钻（客户端过滤展开详情条目；不进查询串，避免
      scope=step 的列表候选被类别过滤整页滤空，2026-09-21）。 */
  drillCategories?: ConversationCategory[];
  onClearToolNameFilter?: () => void;
  /** 保留窗口天数（服务端读 retention 配置）：筛选区旁展示范围不完整提示。 */
  retentionDays?: number;
}

export type ExportQueryNavigation = "replace" | "push";

/** 泛型下拉多选：支持单项勾选 + 顶部互斥档位（全部/全不选），点击外部收起。 */
function MultiSelectDropdown<T extends string>({ fieldLabel, label, options, selected, onToggle, onSet, exclusiveOptions }: {
  /** 传入后在外部渲染字段标题（与 Session/Thread 等筛选一致），触发按钮内不再重复显示。 */
  fieldLabel?: string;
  label: string;
  options: { value: T; label: string }[];
  selected: Set<T>;
  onToggle: (value: T) => void;
  onSet?: (values: T[]) => void;
  /** 顶部互斥档位（如「全部」「全不选」）；active 为 true 表示当前处于该档位。 */
  exclusiveOptions?: Array<{ label: string; active: boolean; onSelect: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  const count = options.filter(option => selected.has(option.value)).length;
  const activeExclusive = exclusiveOptions?.find(option => option.active);
  const trigger = (
    <>
      {fieldLabel ? null : <span className="msd-label">{label}</span>}
      <span className="msd-count">
        {activeExclusive ? activeExclusive.label : `${count}/${options.length}`}
      </span>
      <span className="msd-caret">{open ? "▲" : "▼"}</span>
    </>
  );
  return (
    <div className={fieldLabel ? "msd msd-field" : "msd"} ref={ref}>
      {fieldLabel ? (
        <label className="sf">
          <span className="sf-label">{fieldLabel}</span>
          <button type="button" className={`msd-trigger ${open ? "open" : ""}`} onClick={() => setOpen(value => !value)}>
            {trigger}
          </button>
        </label>
      ) : (
        <button type="button" className={`msd-trigger ${open ? "open" : ""}`} onClick={() => setOpen(value => !value)}>
          {trigger}
        </button>
      )}
      {open ? (
        <div className="msd-panel">
          {exclusiveOptions ? (
            <div className="msd-exclusive">
              {exclusiveOptions.map(option => (
                <label key={option.label} className={`msd-opt msd-all ${option.active ? "checked" : ""}`}>
                  <input type="checkbox" checked={option.active} onChange={option.onSelect} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="msd-bar">
              <button type="button" className="msd-mini" onClick={() => onSet?.(options.map(option => option.value))}>全选</button>
              <button type="button" className="msd-mini" onClick={() => onSet?.([])}>清空</button>
            </div>
          )}
          {options.map(option => (
            <label key={option.value} className={`msd-opt ${selected.has(option.value) ? "checked" : ""}`}>
              <input type="checkbox" checked={selected.has(option.value)} onChange={() => onToggle(option.value)} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SelectFilter({ label, value, options, onChange, showLocalTime = false, allowAll = true }: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  showLocalTime?: boolean;
  /** 整页模式 Session 不提供「全部」档（页面不接受无 Session 状态，2026-09-17）。 */
  allowAll?: boolean;
}) {
  return (
    <label className="sf">
      <span className="sf-label">{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)}>
        {allowAll ? <option value="">全部</option> : null}
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}{showLocalTime && option.timestamp ? ` · ${formatLocalDateTime(option.timestamp)}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ConversationExportViewer({
  mode,
  initialQuery,
  filterData,
  onQueryChange,
  drillCategories,
  toolNameFilter,
  onClearToolNameFilter,
  retentionDays,
}: ConversationExportViewerProps) {
  // 全站统一时区（右上角选择器）：时间展示与起止时间输入的换算都按它执行
  // （2026-09-17 全站时区统一，不再使用浏览器本地时区）。
  const globalTz = useGlobalTimeZone();
  const tzOffset = globalTz.offsetMinutes;
  const initial = useMemo(() => parseQuery(initialQuery), [initialQuery]);
  const [targetSel, setTargetSel] = useState<Set<string>>(() => new Set(initial.target));
  const [agentSel, setAgentSel] = useState<Set<string>>(() => new Set(initial.agent));
  const [session, setSession] = useState(initial.session);
  const [thread, setThread] = useState(initial.thread);
  const [turn, setTurn] = useState(initial.turn);
  const [step, setStep] = useState(initial.step);
  const [startTime, setStartTime] = useState(initial.start);
  const [endTime, setEndTime] = useState(initial.end);
  const [scope, setScope] = useState<"all" | "upto" | "step">(initial.scope);
  const [side, setSide] = useState<"" | "request" | "response">(initial.side);
  // 输入/输出两侧都「全不选」时无法用单一 side 编码，落为显式空 categories（服务端返回空页）。
  const [bothNone, setBothNone] = useState(initial.categoriesExplicit && (initial.categories?.length ?? 0) === 0);
  const [exchangeLimit, setExchangeLimit] = useState(() => normalizeExchangeLimit(initial.exchangeLimit, mode));
  const [pageMaxBytes, setPageMaxBytes] = useState(initial.pageMaxBytes ?? DEFAULT_PAGE_MAX_BYTES);
  const [selected, setSelected] = useState<Set<ConversationCategory>>(new Set(initial.categories ?? []));
  const [data, setData] = useState<ExportContentPageResult | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pageError, setPageError] = useState("");
  const [oversizedExchange, setOversizedExchange] = useState<OversizedExchangeState>();
  // ── 无限加载列表（mode=fullPage，2026-09-17 用户确认）──────────────────────
  // 列表行只消费 SQLite 物化摘要（零 raw）；展开某一步时才按需读 raw，收起即释放。
  const [rows, setRows] = useState<ExportListRow[]>([]);
  const [listCursor, setListCursor] = useState<string | undefined>();
  const [listHasMore, setListHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [listPage, setListPage] = useState<ExportContentPageResult["page"]>();
  const [autoLoadMore, setAutoLoadMore] = useState(false);
  // ── 单开（2026-09-18 用户确认）：同一时刻只展开一条，点开新的一条自动收起旧的 ──
  // 同一行同一视图再点 = 收起并释放正文；切换行时旧请求会被 abort。
  const [expansion, setExpansion] = useState<StepExpansion>();
  const stepControllerRef = useRef<AbortController | undefined>(undefined);
  /** 用户已确认加载的超大 Exchange（只对该条放宽页预算，绝不顺带放宽其它记录）。 */
  const [confirmedOversizedId, setConfirmedOversizedId] = useState<string>();
  /**
   * 已自动展开过的 step（深链接用）：精确到 step 的链接进来就等价于点了一次
   * 「本步新增」，且同一 step 只自动展开一次 —— 用户手动收起后不再被弹开。
   */
  const autoExpandedStepRef = useRef<string | undefined>(undefined);
  const listSentinelRef = useRef<HTMLDivElement>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [copiedKey, setCopiedKey] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [pendingFullDownloadFormat, setPendingFullDownloadFormat] = useState<FullDownloadFormat>();
  const [fullExportPreflight, setFullExportPreflight] = useState<FullExportPreflight>();
  const [fullExportPreflightError, setFullExportPreflightError] = useState("");
  const [fullExportPreflightLoading, setFullExportPreflightLoading] = useState(false);
  const fullExportPreflightRequestRef = useRef(0);
  const contentRequestRef = useRef<AbortController | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const loadedBaseQueryRef = useRef("");
  const deferredSelected = useDeferredValue(selected);
  const filtering = selected !== deferredSelected;
  // 侧别「全不选」标记：side=request 表示输出全不选，side=response 表示输入全不选。
  const inputNone = side === "response" || bothNone;
  const outputNone = side === "request" || bothNone;
  const embedded = mode === "embedded";
  // 刷新/重置按钮的忙碌态：内嵌视图看整页 loading，列表模式看列表加载。
  const busy = embedded ? loading : listLoading;
  const localHasExplicitRange = !!(session || thread || turn || step);
  const options = filterData || { targets: [], agents: [], sessions: [], threads: [], turns: [], steps: [] };
  const filteredTurnOptions = useMemo(() =>
    options.turns.filter(option => {
      if (session && option.session && option.session !== session) return false;
      if (thread && option.thread && option.thread !== thread) return false;
      return true;
    }),
    [options.turns, session, thread]);
  const filteredStepOptions = useMemo(() =>
    options.steps.filter(option => {
      if (turn && option.turn && option.turn !== turn) return false;
      if (thread && option.thread && option.thread !== thread) return false;
      if (session && option.session && option.session !== session) return false;
      return true;
    }),
    [options.steps, turn, thread, session]);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!pendingFullDownloadFormat) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPendingFullDownloadFormat(undefined);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [pendingFullDownloadFormat]);

  useEffect(() => {
    const next = parseQuery(initialQuery);
    setTargetSel(new Set(next.target));
    setAgentSel(new Set(next.agent));
    setSession(next.session);
    setThread(next.thread);
    setTurn(next.turn);
    setStep(next.step);
    setStartTime(next.start);
    setEndTime(next.end);
    setScope(next.scope);
    setSide(next.side);
    setBothNone(next.categoriesExplicit && (next.categories?.length ?? 0) === 0);
    setExchangeLimit(normalizeExchangeLimit(next.exchangeLimit, mode));
    setPageMaxBytes(next.pageMaxBytes ?? DEFAULT_PAGE_MAX_BYTES);
    setSelected(new Set(next.categories ?? []));
    setPageError("");
    setOversizedExchange(undefined);
  }, [initialQuery, mode]);

  const localRequestQuery = useMemo(() => buildExportConversationQuery({
    target: [...targetSel],
    agent: [...agentSel],
    session,
    thread,
    turn,
    step,
    start: startTime,
    end: endTime,
    scope,
    ...sideSelectionForQuery(side, bothNone, selected),
    exchangeLimit,
    pageMaxBytes,
    direction: "older",
    page: 1,
    // 「查看原文 →」的类别下钻不进查询串：scope=step 的列表候选被类别过滤只会
    // 滤成空页（响应侧无对应类别的 Step），下钻过滤由 expansionListItems 在
    // 展开详情条目层承担（2026-09-21 修复"没有匹配的交互记录"空态）。
  }), [targetSel, agentSel, session, thread, turn, step, startTime, endTime, scope, side, bothNone, selected]);
  const urlRequestQuery = useMemo(() => buildExportConversationQuery({
    target: initial.target,
    agent: initial.agent,
    session: initial.session,
    thread: initial.thread,
    turn: initial.turn,
    step: initial.step,
    start: initial.start,
    end: initial.end,
    scope: initial.scope,
    side: initial.side || undefined,
    cursor: initial.cursor,
    direction: initial.direction,
    page: initial.page,
    categories: initial.categories,
    exchangeLimit: normalizeExchangeLimit(initial.exchangeLimit, mode),
    pageMaxBytes: initial.pageMaxBytes ?? DEFAULT_PAGE_MAX_BYTES,
    includeInherited: initial.includeInherited,
  }), [initial, mode]);
  const requestQuery = embedded ? localRequestQuery : urlRequestQuery;
  // 2026-09-20 用户确认移除「显示继承上下文」checkbox：列表恒为只看新增，单条展开由
  // 「本步新增 / 完整上下文」按钮控制；此处仅保留旧深链兼容（内嵌整页读取的透传值）。
  const requestIncludeInherited = initial.includeInherited;
  /**
   * 列表模式（fullPage）天然支持全局浏览：行摘要零 raw，服务端只要求
   * summaryOnly 模式即可无范围查询；内嵌模式仍要求显式范围（避免误触发大读取）。
   */
  const requestHasExplicitRange = embedded ? localHasExplicitRange : true;
  const pageNumber = embedded ? 1 : initial.page;
  const baseQuery = useMemo(() => {
    const params = new URLSearchParams(requestQuery);
    params.delete("cursor");
    params.delete("direction");
    params.delete("page");
    return params.toString();
  }, [requestQuery]);
  const activeOversizedExchange = oversizedExchange;
  const contentRequestQuery = useMemo(() => {
    if (!activeOversizedExchange?.confirmed) return requestQuery;
    const params = new URLSearchParams(requestQuery);
    params.set("confirmedOversizedExchangeId", activeOversizedExchange.exchangeId);
    return params.toString();
  }, [activeOversizedExchange, requestQuery]);

  /** 列表行分页查询：summaryOnly + 不解析排重基线 + 不下发继承正文。 */
  const buildListQuery = useCallback((cursor: string | undefined, withCount: boolean) => {
    const params = new URLSearchParams(baseQuery);
    params.delete("cursor");
    params.delete("direction");
    params.delete("page");
    params.set("summaryOnly", "1");
    params.set("deferBaseline", "1");
    // 列表默认恒为只看新增（2026-09-20 确认）；「查看原文 →」跳转的 initialQuery
    // 显式携带 includeInherited=true（意图是看这类内容本身——系统提示等条目排重后
    // 全是继承），此时尊重显式取值，否则会整列隐藏成"无匹配数据"（2026-09-21 修复）。
    params.set("includeInherited", initial.includeInherited === true ? "true" : "false");
    params.set("exchangeLimit", String(LIST_PAGE_SIZE));
    if (cursor) params.set("cursor", cursor);
    if (!withCount) params.set("skipCandidateCount", "1");
    return params.toString();
  }, [baseQuery, initial.includeInherited]);

  /** 单条 Exchange 精确读取（展开锚点）：一行一击，不需要任何业务范围。 */
  const buildExchangeQuery = useCallback((
    exchangeId: string,
    view: "new" | "full",
    confirmedOversized: boolean,
  ) => {
    const params = new URLSearchParams();
    params.set("exchange", exchangeId);
    params.set("exchangeLimit", "1");
    params.set("pageMaxBytes", String(DEFAULT_PAGE_MAX_BYTES));
    params.set("includeInherited", view === "full" ? "true" : "false");
    params.set("scope", "all");
    if (confirmedOversized) params.set("confirmedOversizedExchangeId", exchangeId);
    return params.toString();
  }, []);
  const buildExchangeQueryWithConfirmation = useCallback((
    exchangeId: string,
    view: "new" | "full",
  ) => buildExchangeQuery(
    exchangeId,
    view,
    confirmedOversizedId === exchangeId,
  ), [buildExchangeQuery, confirmedOversizedId]);

  /** 收起当前展开并中止按需加载（筛选变化 / 重置 / 手动收起时）。 */
  const clearExpansion = useCallback(() => {
    stepControllerRef.current?.abort();
    stepControllerRef.current = undefined;
    setExpansion(undefined);
  }, []);

  /** 按需加载单个 Exchange 的正文（本步新增 / 完整上下文两种视图；收起即释放）。 */
  const loadStep = useCallback(async (exchangeId: string, view: "new" | "full") => {
    // 单开语义：加载新的一条前先中止上一条的请求，避免并发堆积大正文。
    stepControllerRef.current?.abort();
    const controller = new AbortController();
    stepControllerRef.current = controller;
    setExpansion({exchangeId, mode: view, loading: true, error: ""});
    try {
      const response = await fetch(
        `/api/export/content?${buildExchangeQueryWithConfirmation(exchangeId, view)}`,
        {cache: "no-store", signal: controller.signal},
      );
      if (!response.ok) throw await readExportContentError(response);
      const payload = await streamExportContentPage(response, {
        includeInherited: view === "full",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setExpansion({exchangeId, mode: view, loading: false, error: "", data: payload});
    } catch (errorValue) {
      if (controller.signal.aborted) return;
      if (
        errorValue instanceof ExportContentRequestError
        && errorValue.code === "oversized_visible_exchange"
        && errorValue.exchangeId
        && errorValue.requiredBytes !== undefined
      ) {
        // 单条超过页预算：服务端在任何 Raw I/O 前返回精确字节数，
        // 用户确认后只放宽这一条的预算（其他记录不受影响）。
        setOversizedExchange({
          requestQuery: buildExchangeQueryWithConfirmation(exchangeId, view),
          exchangeId: errorValue.exchangeId,
          requiredBytes: errorValue.requiredBytes,
          confirmed: false,
          view,
        });
        setExpansion({exchangeId, mode: view, loading: false, error: ""});
      } else {
        setExpansion({
          exchangeId,
          mode: view,
          loading: false,
          error: errorValue instanceof Error ? errorValue.message : "该步骤正文加载失败",
        });
      }
    } finally {
      // 仅当当前请求仍是本次发起的 controller 时才清理，避免误删后继请求。
      if (stepControllerRef.current === controller) stepControllerRef.current = undefined;
    }
  }, [buildExchangeQueryWithConfirmation]);

  /**
   * 展开/收起某一步（本步新增 / 完整上下文）。
   * 单开：点开新的一条会自动收起并释放上一条；同一行同一视图再点即收起。
   */
  const expandRow = useCallback((row: ExportListRow, view: "new" | "full") => {
    if (expansion && expansion.exchangeId === row.exchangeId && expansion.mode === view) {
      clearExpansion();
      return;
    }
    void loadStep(row.exchangeId, view);
  }, [expansion, loadStep, clearExpansion]);

  useEffect(() => {
    // 2026-09-21 用户确认：fullPage 与 embedded（会话追踪「交互内容」页签）统一走
    // 「列表行 + 按需展开」链路，整页读取不再有任何调用方（含 embedded）——
    // 它此前会抢占 raw 流并发租约，导致列表/展开请求被 429。
    return;
    contentRequestRef.current?.abort();
    const controller = new AbortController();
    contentRequestRef.current = controller;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const replacingRange = loadedBaseQueryRef.current !== baseQuery;
    setData(undefined);
    setError("");
    setPageError("");
    if (replacingRange) resetFullExportConfirmation();
    if (!requestHasExplicitRange) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/export/content?${contentRequestQuery}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw await readExportContentError(response);
        const payload = await streamExportContentPage(response, {
          includeInherited: requestIncludeInherited,
          signal: controller.signal,
        });
        if (requestGenerationRef.current !== generation || controller.signal.aborted) return;
        setData(payload);
        loadedBaseQueryRef.current = baseQuery;
        setLoading(false);
      } catch (errorValue) {
        if (controller.signal.aborted || requestGenerationRef.current !== generation) return;
        if (
          errorValue instanceof ExportContentRequestError
          && errorValue.code === "oversized_visible_exchange"
          && errorValue.exchangeId
          && errorValue.requiredBytes !== undefined
        ) {
          setOversizedExchange({
            requestQuery,
            exchangeId: errorValue.exchangeId,
            requiredBytes: errorValue.requiredBytes,
            confirmed: activeOversizedExchange?.confirmed ?? false,
          });
          setLoading(false);
          return;
        }
        setOversizedExchange(undefined);
        const message = errorValue instanceof Error ? errorValue.message : "交互内容加载失败";
        if (loadedBaseQueryRef.current === baseQuery) setPageError(message);
        else setError(message);
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [baseQuery, contentRequestQuery, requestQuery, retryNonce, requestHasExplicitRange, requestIncludeInherited]);

  // ── 无限加载列表：首屏/筛选变化重新拉第一页 ────────────────────────────────
  // 2026-09-21：embedded（会话追踪「交互内容」页签）与 fullPage 统一走这条
  // 「列表行 + 按需展开」链路，embedded 不再有独立的整页读取数据源。
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setListCursor(undefined);
    setListHasMore(false);
    setListError("");
    setListPage(undefined);
    clearExpansion();
    if (!baseQuery) {
      setListLoading(false);
      return () => controller.abort();
    }
    setListLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/export/content?${buildListQuery(undefined, true)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw await readExportContentError(response);
        const payload = await streamExportListPage(response, {signal: controller.signal});
        if (controller.signal.aborted) return;
        setRows(payload.rows);
        setListPage(payload.page);
        setListCursor(payload.page.nextCursor);
        setListHasMore(payload.page.hasMore);
      } catch (errorValue) {
        if (controller.signal.aborted) return;
        setListError(errorValue instanceof Error ? errorValue.message : "列表加载失败");
      } finally {
        if (!controller.signal.aborted) setListLoading(false);
      }
    })();
    return () => controller.abort();
  }, [baseQuery, buildListQuery, clearExpansion, embedded, retryNonce]);

  const loadMoreRows = useCallback(async () => {
    if (embedded || listLoading || !listCursor || !listHasMore) return;
    setListLoading(true);
    setListError("");
    try {
      const response = await fetch(`/api/export/content?${buildListQuery(listCursor, false)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw await readExportContentError(response);
      const payload = await streamExportListPage(response);
      setRows(previous => [...previous, ...payload.rows]);
      setListCursor(payload.page.nextCursor);
      setListHasMore(payload.page.hasMore);
    } catch (errorValue) {
      setListError(errorValue instanceof Error ? errorValue.message : "加载更早内容失败");
    } finally {
      setListLoading(false);
    }
  }, [buildListQuery, embedded, listCursor, listHasMore, listLoading]);

  /**
   * 深链接自动展开（2026-09-18 用户确认；2026-09-21 起对 embedded 页签同样生效）：
   * URL 精确到 step 时（如 `/export?...&turn=…&step=astep-…`），进入页面即等价于
   * 点了一次「本步新增」，免去用户再点一次。匹配用行上的内部 `agentStepId`
   * （与 URL 的 step 同一 ID 空间），而不是 exchangeId；同一 step 只自动展开一次。
   */
  useEffect(() => {
    if (!step) return;
    if (autoExpandedStepRef.current === step) return;
    const row = rows.find(item => item.agentStepId === step);
    if (!row) return;
    autoExpandedStepRef.current = step;
    // 默认展开「本步新增」（与一级页深链一致）。唯一例外：「查看原文 →」的类别
    // 下钻（drillCategories，查看的原文内容排重后几乎全是继承）默认展开「完整上下文」，
    // 否则「本步新增」视图会显示为空。
    const defaultView = embedded && (drillCategories?.length ?? 0) > 0 ? "full" : "new";
    void loadStep(row.exchangeId, defaultView);
  }, [embedded, step, rows, loadStep, drillCategories]);

  /** 触底自动加载（默认关，按用户确认以按钮为主）。 */
  useEffect(() => {
    if (embedded || !autoLoadMore) return;
    const node = listSentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMoreRows();
    }, {rootMargin: "240px"});
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoLoadMore, embedded, loadMoreRows]);

  const timeFilteredItems = useMemo(() => {
    const items = data?.items || [];
    if (!startTime && !endTime) return items;
    return items.filter(item => {
      const capturedAt = item.capturedAt;
      if (startTime && capturedAt < startTime) return false;
      if (endTime && capturedAt > endTime) return false;
      return true;
    });
  }, [data, startTime, endTime]);

  const timeFilteredExchanges = useMemo(() => {
    const exchanges = data?.exchanges || [];
    if (!startTime && !endTime) return exchanges;
    return exchanges.filter(exchange => {
      if (startTime && exchange.capturedAt < startTime) return false;
      if (endTime && exchange.capturedAt > endTime) return false;
      return true;
    });
  }, [data, startTime, endTime]);

  const visibleItems = useMemo(() => {
    if (deferredSelected.size === 0) return timeFilteredItems;
    return timeFilteredItems.filter(item => {
      const sideCategories = item.side === "input" ? INPUT_CATS : OUTPUT_CATS;
      const selectedForSide = sideCategories.some(category => deferredSelected.has(category));
      return !selectedForSide || deferredSelected.has(item.category);
    });
  }, [timeFilteredItems, deferredSelected]);

  // Harness 页签下钻：按工具名过滤（含该工具的 tool_use / tool_result 条目）。
  // 嵌入式默认隐藏「继承上下文」，让「这步实际新增了什么」一眼可见（2026-09-11）。
  const [hideInherited, setHideInherited] = useState(true);
  const stepScopedItems = useMemo(() => {
    if (!embedded || !hideInherited) return visibleItems;
    return visibleItems.filter(item => item.stepDiff !== "inherited");
  }, [visibleItems, embedded, hideInherited]);
  const hiddenInheritedCount = visibleItems.length - stepScopedItems.length;
  const toolFilteredItems = useMemo(() => {
    const filter = toolNameFilter?.trim();
    if (!filter) return stepScopedItems;
    return stepScopedItems.filter(item => item.toolName === filter);
  }, [stepScopedItems, toolNameFilter]);

  const groups = useMemo(
    () => groupExportContentExchanges(timeFilteredExchanges, toolFilteredItems),
    [timeFilteredExchanges, toolFilteredItems],
  );

  function updateQuery(
    patch: Partial<ExportConversationQueryInput>,
    navigation: ExportQueryNavigation = "replace",
  ) {
    const next: ExportConversationQueryInput = {
      target: [...targetSel],
      agent: [...agentSel],
      session,
      thread,
      turn,
      step,
      start: startTime,
      end: endTime,
      scope,
      ...sideSelectionForQuery(side, bothNone, selected),
      ...patch,
    };
    const nextQuery = buildExportConversationQuery(next);
    onQueryChange?.(nextQuery, navigation);
  }

  function resetPagination() {
    setPageError("");
    setOversizedExchange(undefined);
  }

  function updateTarget(values: Set<string>) {
    resetPagination();
    setTargetSel(values);
    updateQuery({ target: [...values] });
  }

  function updateAgent(values: Set<string>) {
    resetPagination();
    setAgentSel(values);
    updateQuery({ agent: [...values] });
  }

  function updateScalar(key: "start" | "end" | "scope", value: string) {
    resetPagination();
    if (key === "start") setStartTime(value);
    if (key === "end") setEndTime(value);
    if (key === "scope") setScope(parseScope(value));
    updateQuery({ [key]: key === "scope" ? parseScope(value) : value });
  }

  function updateSession(value: string) {
    resetPagination();
    const nextScope = scope === "step" ? "all" : scope;
    setSession(value);
    setThread("");
    setTurn("");
    setStep("");
    if (nextScope !== scope) setScope(nextScope);
    updateQuery({ session: value, thread: "", turn: "", step: "", scope: nextScope });
  }

  function updateThread(value: string) {
    resetPagination();
    const nextScope = scope === "step" ? "all" : scope;
    setThread(value);
    setTurn("");
    setStep("");
    if (nextScope !== scope) setScope(nextScope);
    updateQuery({ thread: value, turn: "", step: "", scope: nextScope });
  }

  function updateTurn(value: string) {
    resetPagination();
    const nextScope: "all" | "upto" | "step" = scope === "step" ? "all" : scope;
    setTurn(value);
    setStep("");
    if (nextScope !== scope) setScope(nextScope);
    updateQuery({ turn: value, step: "", scope: nextScope });
  }

  function updateStep(value: string) {
    resetPagination();
    const selectedStepOption = options.steps.find(option => option.value === value);
    const nextTurn = selectedStepOption?.turn || turn;
    const nextThread = selectedStepOption?.thread || thread;
    const nextSession = selectedStepOption?.session || session;
    const nextScope: "all" | "upto" | "step" = value ? "step" : scope === "step" ? "all" : scope;
    if (selectedStepOption?.session) setSession(selectedStepOption.session);
    if (selectedStepOption?.thread) setThread(selectedStepOption.thread);
    if (selectedStepOption?.turn) setTurn(selectedStepOption.turn);
    setStep(value);
    if (nextScope !== scope) setScope(nextScope);
    updateQuery({ session: nextSession, thread: nextThread, turn: nextTurn, step: value, scope: nextScope });
  }

  /** 输入/输出侧的统一状态迁移：none 标记 + 该侧具体类别 + 一次性写回查询串。 */
  function applySideSelection(nextInputNone: boolean, nextOutputNone: boolean, mutate: (next: Set<ConversationCategory>) => void) {
    resetPagination();
    const next = new Set(selected);
    mutate(next);
    const nextBothNone = nextInputNone && nextOutputNone;
    const nextSide: "" | "request" | "response" = nextBothNone
      ? ""
      : nextInputNone ? "response" : nextOutputNone ? "request" : "";
    setSide(nextSide);
    setBothNone(nextBothNone);
    setSelected(next);
    // side/categories 两个键必须显式写入补丁（哪怕是 undefined），
    // 否则「全部」档的空补丁盖不住 updateQuery 基础值里残留的旧 side，刷新后又变回全不选。
    const selection = sideSelectionForQuery(nextSide, nextBothNone, next);
    updateQuery({ side: selection.side, categories: selection.categories });
  }

  function setInputExclusive(none: boolean) {
    applySideSelection(none, outputNone, next => {
      for (const category of INPUT_CATS) next.delete(category);
    });
  }

  function setOutputExclusive(none: boolean) {
    applySideSelection(inputNone, none, next => {
      for (const category of OUTPUT_CATS) next.delete(category);
    });
  }

  function toggleCategory(category: ConversationCategory) {
    const isInput = INPUT_CATS.includes(category);
    applySideSelection(
      isInput ? false : inputNone,
      isInput ? outputNone : false,
      next => {
        if (next.has(category)) next.delete(category);
        else next.add(category);
      },
    );
  }

  function confirmOversizedExchange(): void {
    if (!activeOversizedExchange || activeOversizedExchange.requiredBytes > MAX_CONFIRMED_EXCHANGE_BYTES) return;
    if (embedded) {
      setLoading(true);
      setOversizedExchange({ ...activeOversizedExchange, confirmed: true });
      return;
    }
    // 列表模式：只放宽这一条（confirmedOversizedId），按触发时的视图重新加载该条。
    setConfirmedOversizedId(activeOversizedExchange.exchangeId);
    setOversizedExchange(undefined);
    void loadStep(activeOversizedExchange.exchangeId, activeOversizedExchange.view ?? "new");
  }

  function retryCurrentPage() {
    if (busy) return;
    contentRequestRef.current?.abort();
    setData(undefined);
    setError("");
    setPageError("");
    setRetryNonce(value => value + 1);
  }

  /** 清空全部筛选条件，回到默认状态（服务端深链归一化会重新选中最新 Session）。 */
  function resetFilters() {
    if (busy) return;
    resetPagination();
    resetFullExportConfirmation();
    clearExpansion();
    onQueryChange?.("", "replace");
  }

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(""), 1400);
    } catch {
      // 剪贴板不可用时保留静默失败，避免打断用户检查流。
    }
  }

  /**
   * 导出当前展开的单条步骤正文（2026-09-20 用户确认）：客户端序列化已加载的
   * 有界内容，不触发新的 Raw 读取；「本步新增」= 去重视角，「完整上下文」= 截止
   * 该步的完整回放。与完整导出保持同一 Markdown / JSONL 行分条形态。
   */
  function downloadExpansion(
    view: "new" | "full",
    exchangeId: string,
    payload: NonNullable<StepExpansion["data"]>,
    format: "markdown" | "jsonl",
  ) {
    const segments: ExportDownloadSegment[] = groupExportContentExchanges(payload.exchanges, payload.items);
    const source = {
      heading: `${view === "full" ? "完整上下文" : "本步新增"} · ${exchangeId}`,
      segments,
    };
    const content = format === "jsonl"
      ? buildConversationJsonl(source)
      : buildConversationMarkdown(source);
    triggerBrowserDownload(
      content,
      format === "jsonl" ? "application/x-ndjson" : "text/markdown",
      `export-${safeDownloadFilename(exchangeId)}.${format === "jsonl" ? "jsonl" : "md"}`,
    );
  }

  /**
   * embedded 展开详情的条目过滤：只保留能力清单下钻的工具名过滤。
   * 「本步新增 / 完整上下文」的继承取舍由服务端 includeInherited 参数完成
   * （与一级页完全同源），前端不得再叠加继承过滤——否则「完整上下文」
   * 的继承条目会被二次隐藏（2026-09-21 修复）。
   */
  function expansionListItems(items: ExportContentItem[]): ExportContentItem[] {
    let scoped = items;
    // 「查看原文 →」的类别下钻：只显示所选类别的条目（props 传入，不进查询串）。
    const categories = drillCategories;
    if (categories && categories.length > 0) scoped = scoped.filter(item => categories.includes(item.category));
    const filter = toolNameFilter?.trim();
    if (filter) scoped = scoped.filter(item => item.toolName === filter);
    return scoped;
  }

  function triggerBrowserDownload(content: string, mime: string, filename: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function fullDownloadUrl(format: FullDownloadFormat, preflight = false): string {
    const params = new URLSearchParams(baseQuery);
    // 完整导出恒为去重语义（2026-09-20 用户确认）：剥离旧深链可能残留的继承开关。
    params.delete("includeInherited");
    params.set("format", format);
    if (preflight) params.set("preflight", "1");
    return `/api/export/download?${params.toString()}`;
  }

  async function requestFullDownload(format: FullDownloadFormat) {
    // 完整导出走服务端 preflight，不依赖当前已加载的页面数据；
    // 此前 `!data` 守卫曾导致列表模式点按钮静默无反应（2026-09-20 修复）。
    if (rangeRequired) return;
    const requestId = fullExportPreflightRequestRef.current + 1;
    fullExportPreflightRequestRef.current = requestId;
    setFullExportPreflightLoading(true);
    setFullExportPreflightError("");
    setFullExportPreflight(undefined);
    try {
      const response = await fetch(fullDownloadUrl(format, true), { cache: "no-store" });
      const payload = await response.json() as { preflight?: FullExportPreflight; error?: string };
      if (!response.ok || !payload.preflight?.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      if (fullExportPreflightRequestRef.current !== requestId) return;
      setFullExportPreflight(payload.preflight);
      setPendingFullDownloadFormat(format);
    } catch (errorValue) {
      if (fullExportPreflightRequestRef.current !== requestId) return;
      setFullExportPreflightError(`完整导出预检失败：${errorValue instanceof Error ? errorValue.message : "未知错误"}`);
    } finally {
      if (fullExportPreflightRequestRef.current === requestId) {
        setFullExportPreflightLoading(false);
      }
    }
  }

  function resetFullExportConfirmation() {
    fullExportPreflightRequestRef.current += 1;
    setPendingFullDownloadFormat(undefined);
    setFullExportPreflight(undefined);
    setFullExportPreflightError("");
    setFullExportPreflightLoading(false);
  }

  function confirmFullDownload() {
    if (!pendingFullDownloadFormat) return;
    const anchor = document.createElement("a");
    anchor.href = fullDownloadUrl(pendingFullDownloadFormat);
    anchor.click();
    setPendingFullDownloadFormat(undefined);
  }

  const rangeRequired = !requestHasExplicitRange;
  const dedupeIncompleteThreads = data
    ? Object.entries(data.dedupeDetailsByThread)
      .filter(([, detail]) => (
        detail.status === "unavailable" || detail.status === "fingerprint_limited"
      ))
    : [];
  const showUniqueStepBadge = !!step && scope !== "upto";

  /**
   * Exchange 卡片（列表展开与内嵌视图共用）：只负责渲染一个 Exchange 的条目，
   * 正文数据由调用方按需加载（列表模式 = 用户展开时）。
   */
  function renderExchangeCard(
    exchange: ExportContentExchange,
    items: ExportContentItem[],
    groupIndex: number,
    badgeVisible: boolean,
  ) {
    return (
      <div className={`conv ${groupIndex % 2 === 0 ? "step-tone-a" : "step-tone-b"}${exchange.isAuxiliary ? " auxiliary-step" : ""}`} key={exchange.exchangeId}>
        <div className="conv-head">
          <span>{formatLocalDateTime(exchange.capturedAt)}</span>
          {exchange.isAuxiliary ? (
            <>
              <span className="auxiliary-badge">辅助请求</span>
              <span>{AUXILIARY_KIND_LABEL[exchange.auxiliaryKind || "unknown"]}</span>
            </>
          ) : <span>step: {exchange.exchangeId}</span>}
          {exchange.model ? <span>model: {exchange.model}</span> : null}
          {exchange.failover ? (
            <span
              className={`auxiliary-badge failover-badge${(exchange.failover.attempts[exchange.failover.attempts.length - 1]?.outcome) === "served" ? "" : " error"}`}
              title="来自代理捕获记录的模型故障转移元数据（非推断）"
            >
              {formatFailoverBadgeText(exchange.failover)}
            </span>
          ) : null}
          <span>target: {exchange.targetId}</span>
          <span>protocol: {exchange.agentProtocol}</span>
          {exchange.httpStatus !== undefined ? (
            <span className={`exchange-http-status ${exchange.httpStatus >= 400 ? "error" : "success"}`}>
              HTTP {exchange.httpStatus}
            </span>
          ) : null}
          {exchange.durationMs !== undefined ? (
            <span className="exchange-duration">耗时: {formatDuration(exchange.durationMs)}</span>
          ) : null}
          {exchange.contentError ? (
            <span className="exchange-content-error">
              <AlertTriangle size={13} aria-hidden="true" />
              正文读取失败: {exchange.contentError.message}
            </span>
          ) : null}
        </div>
        {!items.some(item => item.side === "input") ? (
          <ExchangeSidePlaceholder
            exchange={exchange}
            side="input"
            sideCategoriesSelected={side !== "response"
              && (deferredSelected.size === 0
                || INPUT_CATS.some(category => deferredSelected.has(category)))}
          />
        ) : null}
        {items.map((item, index) => (
          <ConversationItemView
            key={`${item.side}-${exchange.exchangeId}-${index}`}
            item={item}
            exchangeId={exchange.exchangeId}
            index={index}
            copiedKey={copiedKey}
            copyText={copyText}
            showUniqueStepBadge={badgeVisible}
          />
        ))}
        {!items.some(item => item.side === "output") ? (
          <ExchangeSidePlaceholder
            exchange={exchange}
            side="output"
            sideCategoriesSelected={side !== "request"
              && (deferredSelected.size === 0
                || OUTPUT_CATS.some(category => deferredSelected.has(category)))}
          />
        ) : null}
      </div>
    );
  }
  const fullExportRangeLabel = step
    ? `${scope === "upto" ? "截止" : "当前"} Step · ${step}`
    : turn ? `Turn · ${turn}` : thread ? `Thread · ${thread}` : session ? `Session · ${session}` : "未选择业务范围";

  return (
    <div className={`export-shell ${embedded ? "embedded" : "full"}`}>
      {!embedded ? (
        <div className="exp-filters">
          <MultiSelectDropdown
            fieldLabel="供应商"
            label="供应商"
            options={options.targets}
            selected={targetSel}
            onToggle={value => updateTarget(toggleStringSet(targetSel, value))}
            onSet={values => updateTarget(new Set(values))}
          />
          <MultiSelectDropdown
            fieldLabel="Agent"
            label="Agent"
            options={options.agents}
            selected={agentSel}
            onToggle={value => updateAgent(toggleStringSet(agentSel, value))}
            onSet={values => updateAgent(new Set(values))}
          />
          <SelectFilter label="Session" value={session} options={options.sessions} onChange={updateSession} allowAll={embedded} />
          <SelectFilter label="Thread" value={thread} options={options.threads} onChange={updateThread} />
          <SelectFilter label="Turn" value={turn} options={filteredTurnOptions} onChange={updateTurn} />
          <SelectFilter label="Step" value={step} options={filteredStepOptions} onChange={updateStep} showLocalTime={hydrated} />
          <label className="sf">
            <span className="sf-label">开始时间</span>
            <input type="datetime-local" value={isoToDatetimeLocalValue(startTime, tzOffset).slice(0, 16)} onChange={event => updateScalar("start", event.target.value ? datetimeLocalValueToIso(event.target.value, tzOffset) : "")} />
          </label>
          <label className="sf">
            <span className="sf-label">结束时间</span>
            <input type="datetime-local" value={isoToDatetimeLocalValue(endTime, tzOffset).slice(0, 16)} onChange={event => updateScalar("end", event.target.value ? datetimeLocalValueToIso(event.target.value, tzOffset) : "")} />
          </label>
          <MultiSelectDropdown
            fieldLabel="提示词类别（输入侧）"
            label="提示词类别（输入侧）"
            options={INPUT_CATS.map(category => ({ value: category, label: CAT_LABEL[category] }))}
            selected={selected}
            onToggle={toggleCategory}
            exclusiveOptions={[
              {
                label: "全部",
                active: !inputNone && !INPUT_CATS.some(category => selected.has(category)),
                onSelect: () => setInputExclusive(false),
              },
              {
                label: "全不选",
                active: inputNone,
                onSelect: () => setInputExclusive(true),
              },
            ]}
          />
          <MultiSelectDropdown
            fieldLabel="模型输出（输出侧）"
            label="模型输出（输出侧）"
            options={OUTPUT_CATS.map(category => ({ value: category, label: CAT_LABEL[category] }))}
            selected={selected}
            onToggle={toggleCategory}
            exclusiveOptions={[
              {
                label: "全部",
                active: !outputNone && !OUTPUT_CATS.some(category => selected.has(category)),
                onSelect: () => setOutputExclusive(false),
              },
              {
                label: "全不选",
                active: outputNone,
                onSelect: () => setOutputExclusive(true),
              },
            ]}
          />
          <div className="exp-filter-tools">
            <button type="button" className="btn" disabled={busy} onClick={retryCurrentPage} title="重新加载当前范围内容">
              <RefreshCw size={14} aria-hidden="true" />
              <span>刷新</span>
            </button>
            <button type="button" className="btn" disabled={busy} onClick={resetFilters} title="恢复默认条件（自动选中最新 Session）">
              <RotateCcw size={14} aria-hidden="true" />
              <span>重置</span>
            </button>
          </div>
          <div className="exp-filter-footer">
            <div className="exp-filter-footer-status">
              {retentionDays != null ? <RetentionScopeNotice retentionDays={retentionDays} /> : null}
              {filtering ? <span className="filtering-hint">筛选中...</span> : null}
              {embedded && data?.page
                ? <ExportPageStatus data={data} pageNumber={pageNumber} />
                : null}
            </div>
            <div className="exp-filter-footer-actions">
              <button type="button" className="btn" disabled={rangeRequired || fullExportPreflightLoading} onClick={() => void requestFullDownload("markdown")}>导出完整 Markdown</button>
              <button type="button" className="btn" disabled={rangeRequired || fullExportPreflightLoading} onClick={() => void requestFullDownload("jsonl")}>导出完整 JSONL</button>
            </div>
          </div>
        </div>
      ) : null}

      {embedded ? (
        <div className="exp-actions">
          {/* 完整范围导出只属于一级页；页签内只保留「新窗口打开」，
              本 Step 的「导出 Markdown / JSONL」由展开视图提供（2026-09-21）。 */}
          <div className="exp-actions-group" />
          <a
            className="btn exp-actions-open"
            href={requestQuery ? `/export?${requestQuery}` : "/export"}
            target="_blank"
            rel="noreferrer"
            title="新窗口打开当前 Step 范围的交互内容"
          >
            <ExternalLink size={14} aria-hidden="true" />
            新窗口打开
          </a>
        </div>
      ) : null}
      {fullExportPreflightError ? <div className="exp-limit-banner" role="alert">{fullExportPreflightError}</div> : null}
      {data && !data.page.candidateCountExact ? (
        <div className="exp-limit-banner" role="status">
          当前总数仅包含已确认匹配项；{data.page.filterProjectionMissingCount} 条记录的类别统计尚未生成，
          {data.page.filterProjectionLimitedCount} 条记录的类别统计不完整。
        </div>
      ) : null}
      {data?.contentCompleteness === "partial" && data.page.candidateCountExact ? (
        <div className="exp-limit-banner" role="alert">部分 Exchange 的完整正文当前不可用，其余正文已完整加载。</div>
      ) : null}
      {dedupeIncompleteThreads.length > 0 ? (
        <div className="exp-limit-banner" role="status">
          <strong>{dedupeIncompleteThreads.length} 个 Thread 的上下文继承比对未完成</strong>
          <span>；相关输入保持完整展示，未隐藏无法确认的内容。</span>
          <ul className="exp-dedupe-details">
            {dedupeIncompleteThreads.map(([threadId, detail]) => (
              <li key={threadId}>
                <span>Thread {threadId}</span>
                <span>受影响记录 {detail.affectedExchangeId}</span>
                <span>已尝试 {detail.attemptedBaselineCount} 条候选</span>
                {detail.lastSkippedExchangeId ? (
                  <span>最近跳过 {detail.lastSkippedExchangeId}</span>
                ) : null}
                <span>{detail.failureCode ? DEDUPE_FAILURE_LABEL[detail.failureCode] : "未找到可对比的上一条请求"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pendingFullDownloadFormat ? (
        <div className="settings-modal-backdrop" role="presentation" onClick={() => setPendingFullDownloadFormat(undefined)}>
          <section
            className="export-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-confirm-title"
            onClick={event => event.stopPropagation()}
          >
            <header className="settings-header">
              <div>
                <h2 id="export-confirm-title">完整导出前确认</h2>
                <p>完整导出会逐页处理当前业务范围内的全部匹配请求。</p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPendingFullDownloadFormat(undefined)}
                aria-label="关闭完整导出确认"
                title="关闭"
              >
                <X size={16} />
              </button>
            </header>
            <div className="export-confirm-body">
              <dl className="export-confirm-summary">
                <div><dt>导出范围</dt><dd>{fullExportRangeLabel}</dd></div>
                <div><dt>导出格式</dt><dd>{pendingFullDownloadFormat.toUpperCase()}</dd></div>
                <div><dt>候选请求数</dt><dd>{fullExportPreflight?.candidateExchangeCount ?? 0} 条</dd></div>
                <div><dt>声明正文总量</dt><dd>{formatBytes(fullExportPreflight?.declaredBodyBytes ?? 0)}</dd></div>
                <div><dt>预计分页数</dt><dd>{fullExportPreflight?.pageCount ?? 0} 页</dd></div>
                <div><dt>单页读取预算</dt><dd>{formatBytes(pageMaxBytes)}</dd></div>
              </dl>
              <div className="export-confirm-risk" role="note">
                <AlertTriangle size={18} aria-hidden="true" />
                <span>数据量较大时可能耗时较长并生成较大的下载响应，期间请勿重复触发完整导出。</span>
              </div>
              <p className="export-confirm-alternative">
                内容已按步骤去重：每条内容只出现一次（在其首次出现的步骤），上下文压缩不会丢失早期内容。
              </p>
            </div>
            <footer className="settings-actions export-confirm-actions">
              <button type="button" className="btn" autoFocus onClick={() => setPendingFullDownloadFormat(undefined)}>取消</button>
              <button type="button" className="btn btn-primary" onClick={confirmFullDownload}>
                <Download size={15} aria-hidden="true" />
                <span>确认完整导出</span>
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <div className="exp-body">
          <>
            {activeOversizedExchange ? (
              <OversizedExchangePrompt
                value={activeOversizedExchange}
                onConfirm={confirmOversizedExchange}
              />
            ) : null}
            {/* embedded（会话追踪页签，scope=step 恒为单步）没有列表翻页语义，
                「已加载 N 步 / 触底自动加载」只属于一级页列表。 */}
            {!embedded ? (
              <div className="exp-list-status" role="status">
                <span>
                  已加载 {rows.length} 步
                  {listPage?.candidateCount !== undefined
                    ? ` · 共 ${listPage.candidateCount} 步`
                    : " · 总数未统计"}
                </span>
                <label className="exp-list-autoload">
                  <input
                    type="checkbox"
                    checked={autoLoadMore}
                    onChange={event => setAutoLoadMore(event.currentTarget.checked)}
                  />
                  <span>触底自动加载</span>
                </label>
              </div>
            ) : null}
            {listError ? (
              <div className="exp-limit-banner with-action" role="alert">
                <span>{listError}</span>
                <button type="button" className="btn" disabled={listLoading} onClick={() => void loadMoreRows()}>重试</button>
              </div>
            ) : null}
            {listLoading && rows.length === 0 ? <div className="exp-empty">加载中...</div>
              : rows.length === 0 ? (
                <div className="exp-empty exp-guide" role="note">
                  <SearchX size={26} aria-hidden="true" />
                  <span className="exp-guide-main">当前筛选下没有匹配的交互记录</span>
                  <span className="exp-guide-sub">（调整筛选条件，或点击「重置」恢复默认）</span>
                </div>
              )
              : (
                /* 列表行恢复为卡片式表格式布局（2026-09-18 用户确认）：
                   每行 = 标题行（# / 时间 / Agent 彩色徽标 + 供应商 / 模型 / 状态徽标 / 操作）
                   + 正文两行（输入摘要、输出摘要）；行与行之间用细线分隔，不再各自成卡，
                   左侧 Agent 色带（旧「蓝线」）已整体移除。
                   展开为单开：点开新的一条自动收起并释放上一条，同一行同一视图再点即收起。 */
                <div className="exp-list-table">
                  {rows.map((row, index) => {
                    const isExpanded = expansion?.exchangeId === row.exchangeId;
                    const rowExpansion = isExpanded ? expansion : undefined;
                    const exchangeGroup = rowExpansion?.data
                      ? groupExportContentExchanges(rowExpansion.data.exchanges, rowExpansion.data.items)[0]
                      : undefined;
                    const expansionPayload = rowExpansion?.data;
                    const expansionMode = rowExpansion?.mode;
                    const requestSummaryText = row.requestSummary
                      ? summarizeText(row.requestSummary).slice(0, LIST_ROW_SUMMARY_MAX_CHARS)
                      : row.summaryLimited ? "摘要不可用（索引缺失或受限）" : "无新增输入摘要";
                    const responseSummaryText = row.responseSummary
                      ? summarizeText(row.responseSummary).slice(0, LIST_ROW_SUMMARY_MAX_CHARS)
                      : row.summaryLimited ? "摘要不可用（索引缺失或受限）" : "无输出摘要";
                    return (
                      <section
                        className={`exp-list-row${isExpanded ? " open" : ""}${row.isAuxiliary ? " auxiliary" : ""}`}
                        key={row.exchangeId}
                        data-agent={row.agentName}
                      >
                        <div className="exp-list-head">
                          <span className="exp-list-index">#{index + 1}</span>
                          <span className="exp-list-time">{formatLocalDateTime(row.capturedAt)}</span>
                          <span className="exp-list-agent">
                            <span className="exp-agent-badge"><b>{agentDisplayName(row.agentName)}</b></span>
                            <span className="exp-list-target">{row.targetName}</span>
                          </span>
                          {row.model ? <span className="exp-list-model" title={row.model}>{row.model}</span> : null}
                          <span className="exp-list-chips">
                            {row.isAuxiliary ? (
                              <span className="auxiliary-badge">
                                {AUXILIARY_KIND_LABEL[row.auxiliaryKind || "unknown"]}
                              </span>
                            ) : null}
                            {row.httpStatus !== undefined ? (
                              <span className={`exchange-http-status ${row.httpStatus >= 400 ? "error" : "success"}`}>
                                HTTP {row.httpStatus}
                              </span>
                            ) : null}
                            {row.durationMs !== undefined ? (
                              <span className="exchange-duration">{formatDuration(row.durationMs)}</span>
                            ) : null}
                            {row.degraded ? (
                              <span className="exp-list-degraded" title="本地导入正文不完整（历史数据未修复）">
                                {row.degraded === "skeleton_missing"
                                  ? "系统提示/工具定义缺失"
                                  : row.degraded === "skeleton_borrowed"
                                    ? "骨架来自会话缓存"
                                    : "正文可能不完整"}
                              </span>
                            ) : null}
                            {row.dedupeState === "not_applicable" ? (
                              <span className="exp-list-first" title="本线程首步：没有可对比的上一条请求">
                                首步
                              </span>
                            ) : null}
                            {row.dedupeState === "deferred" ? (
                              <span className="exp-list-uncompared" title="尚未与上一条请求比对：展开该步时会自动完成比对">
                                待比对
                              </span>
                            ) : null}
                            {row.dedupeState === "unconfirmed" ? (
                              <span className="exp-list-unconfirmed" title="无法确认继承内容：展开该步时会重新比对上一条请求">
                                未比对
                              </span>
                            ) : null}
                            {!row.rawAvailable ? (
                              <span className="exp-list-unavailable">正文已清理</span>
                            ) : null}
                          </span>
                          <div className="exp-list-actions">
                            <button
                              type="button"
                              className={`btn${isExpanded && rowExpansion?.mode === "new" ? " btn-primary" : ""}`}
                              disabled={Boolean(isExpanded && rowExpansion?.loading)}
                              onClick={() => expandRow(row, "new")}
                            >
                              {isExpanded && rowExpansion?.mode === "new" ? "收起" : "本步新增"}
                            </button>
                            <button
                              type="button"
                              className={`btn${isExpanded && rowExpansion?.mode === "full" ? " btn-primary" : ""}`}
                              disabled={Boolean(isExpanded && rowExpansion?.loading)}
                              onClick={() => expandRow(row, "full")}
                            >
                              {isExpanded && rowExpansion?.mode === "full" ? "收起" : "完整上下文"}
                            </button>
                          </div>
                        </div>
                        <div className="exp-list-body">
                          <div className="exp-list-summary">
                            <span className="exp-list-summary-side">输入</span>
                            <span
                              className={`exp-list-summary-text${row.requestSummary ? "" : " empty"}`}
                              title={row.requestSummary ? summarizeText(row.requestSummary) : undefined}
                            >
                              {requestSummaryText}
                            </span>
                          </div>
                          <div className="exp-list-summary output">
                            <span className="exp-list-summary-side">输出</span>
                            <span
                              className={`exp-list-summary-text${row.responseSummary ? "" : " empty"}`}
                              title={row.responseSummary ? summarizeText(row.responseSummary) : undefined}
                            >
                              {responseSummaryText}
                            </span>
                          </div>
                        </div>
                        {isExpanded ? (
                          <div className="exp-list-detail">
                            {rowExpansion?.loading ? <div className="exp-empty">正在按需加载该步骤正文...</div> : null}
                            {rowExpansion?.error ? (
                              <div className="exp-limit-banner" role="alert">{rowExpansion.error}</div>
                            ) : null}
                            {rowExpansion?.data && exchangeGroup
                              ? renderExchangeCard(
                                  exchangeGroup.exchange,
                                  expansionListItems(exchangeGroup.items),
                                  0,
                                  rowExpansion.mode === "new" && showUniqueStepBadge,
                                )
                              : null}
                            {expansionPayload && expansionMode && exchangeGroup ? (
                              <div className="exp-detail-export">
                                <button type="button" className="btn" onClick={() => downloadExpansion(expansionMode, row.exchangeId, expansionPayload, "markdown")}>导出 Markdown</button>
                                <button type="button" className="btn" onClick={() => downloadExpansion(expansionMode, row.exchangeId, expansionPayload, "jsonl")}>导出 JSONL</button>
                              </div>
                            ) : null}
                            {rowExpansion?.data?.page.limitedByBytes ? (
                              <div className="exp-limit-banner" role="status">
                                该步骤正文较大，当前展示为受限结果；可单独查看请求或响应全文，或下载。
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              )}
            {!embedded ? (
              <div className="exp-list-more" ref={listSentinelRef}>
                <button
                  type="button"
                  className="btn"
                  disabled={listLoading || !listHasMore}
                  onClick={() => void loadMoreRows()}
                >
                  <ChevronRight size={15} aria-hidden="true" />
                  <span>{listHasMore ? (listLoading ? "加载中..." : "加载更多（更早）") : "已到最早一条"}</span>
                </button>
              </div>
            ) : null}
          </>
      </div>
    </div>
  );
}

function parseQuery(query: string): Required<Pick<ExportConversationQueryInput, "scope">> & {
  target: string[];
  agent: string[];
  session: string;
  thread: string;
  turn: string;
  step: string;
  start: string;
  end: string;
  maxExchanges: number | undefined;
  maxBytes: number | undefined;
  exchangeLimit: number | undefined;
  pageMaxBytes: number | undefined;
  cursor: string | undefined;
  direction: "older" | "newer";
  page: number;
  includeInherited: boolean;
  side: "" | "request" | "response";
  categories: ConversationCategory[] | undefined;
  categoriesExplicit: boolean;
} {
  const params = new URLSearchParams(query);
  const categoriesExplicit = params.has("categories");
  const categories = (params.get("categories") || "")
    .split(",")
    .filter((value): value is ConversationCategory => ALL_CATS.includes(value as ConversationCategory));
  const scope = parseScope(params.get("scope") || "");
  return {
    target: splitList(params.get("target")),
    agent: splitList(params.get("agent")),
    session: params.get("session") || "",
    thread: params.get("thread") || "",
    turn: params.get("turn") || "",
    step: params.get("step") || "",
    start: params.get("start") || "",
    end: params.get("end") || "",
    scope,
    maxExchanges: parsePositiveInteger(params.get("maxExchanges")),
    maxBytes: parsePositiveInteger(params.get("maxBytes")),
    exchangeLimit: parsePositiveInteger(params.get("exchangeLimit")) ?? parsePositiveInteger(params.get("maxExchanges")) ?? DEFAULT_EXCHANGE_LIMIT,
    pageMaxBytes: parsePositiveInteger(params.get("pageMaxBytes")) ?? parsePositiveInteger(params.get("maxBytes")) ?? DEFAULT_PAGE_MAX_BYTES,
    cursor: params.get("cursor") || undefined,
    direction: params.get("direction") === "newer" ? "newer" : "older",
    page: parsePositiveInteger(params.get("page")) ?? 1,
    includeInherited: parseBoolean(params.get("includeInherited")),
    side: params.get("side") === "request"
      ? "request"
      : params.get("side") === "response" ? "response" : "",
    categories: categoriesExplicit ? categories : undefined,
    categoriesExplicit,
  };
}

function parseBoolean(value: string | null): boolean {
  return value === "true" || value === "1";
}

function parseScope(value: string): "all" | "upto" | "step" {
  if (value === "step") return "step";
  if (value === "upto") return "upto";
  return "all";
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} KB`;
  return `${value} B`;
}

function normalizeExchangeLimit(value: number | undefined, mode: ConversationExportViewerProps["mode"]): number {
  if (mode === "embedded") return value ?? DEFAULT_EXCHANGE_LIMIT;
  return PAGE_SIZE_OPTIONS.some(option => option === value) ? value! : DEFAULT_EXCHANGE_LIMIT;
}

function splitList(value: string | null): string[] {
  return value ? value.split(",").map(item => item.trim()).filter(Boolean) : [];
}

function toggleStringSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * 侧别选择 → 查询参数编码（与服务端 side/categories 语义一一对应）：
 * - 双侧全不选：显式空 categories，服务端短路为空页；
 * - 单侧全不选：side=request|response，categories 只携带对侧的具体选择；
 * - 无全不选：缺省=全部；具体选择按原 categories 列表语义，全选坍缩为缺省。
 */
function sideSelectionForQuery(
  side: "" | "request" | "response",
  bothNone: boolean,
  selected: Set<ConversationCategory>,
): Pick<ExportConversationQueryInput, "side" | "categories"> {
  if (bothNone) return { categories: [] };
  if (side === "response") {
    const categories = selectedCategoriesOfSide(selected, OUTPUT_CATS);
    return { side: "response", categories: categories.length > 0 ? categories : undefined };
  }
  if (side === "request") {
    const categories = selectedCategoriesOfSide(selected, INPUT_CATS);
    return { side: "request", categories: categories.length > 0 ? categories : undefined };
  }
  const categories = [...selected];
  if (categories.length === 0 || categories.length === ALL_CATS.length) return {};
  return { categories };
}

function selectedCategoriesOfSide(
  selected: Set<ConversationCategory>,
  sideCategories: readonly ConversationCategory[],
): ConversationCategory[] {
  return sideCategories.filter(category => selected.has(category));
}

function ExchangeSidePlaceholder({
  exchange,
  side,
  sideCategoriesSelected,
}: {
  exchange: ExportContentExchange;
  side: "input" | "output";
  sideCategoriesSelected: boolean;
}) {
  let message: string;
  let stateClass = "empty";
  if (!sideCategoriesSelected) {
    message = side === "input"
      ? "未选择输入类别，本 Step 输入未展示。"
      : "未选择模型输出类别，本 Step 输出未展示。";
    stateClass = "filtered";
  } else if (exchange.contentError) {
    message = `${side === "input" ? "输入" : "输出"}正文读取失败：${exchange.contentError.message}`;
    stateClass = "error";
  } else if (side === "input" && exchange.hiddenInheritedInputCount > 0) {
    message = `${exchange.hiddenInheritedInputCount} 项继承上下文已隐藏，本 Step 无新增输入。`;
    stateClass = "inherited";
  } else if (side === "output" && exchange.httpStatus !== undefined && exchange.httpStatus >= 400) {
    message = `上游请求失败（HTTP ${exchange.httpStatus}），未产生可展示的模型输出。`;
    stateClass = "error";
  } else {
    message = side === "input"
      ? "本 Step 没有可展示的输入。"
      : "本次响应未产生可展示的模型输出。";
  }
  return (
    <div className={`conv-side-placeholder ${side} ${stateClass}`} role="status">
      <span className="conv-side-placeholder-label">{side}</span>
      <span>{message}</span>
    </div>
  );
}

function ConversationItemView({
  item,
  exchangeId,
  index,
  copiedKey,
  copyText,
  showUniqueStepBadge,
}: {
  item: ExportContentItem;
  exchangeId: string;
  index: number;
  copiedKey: string;
  copyText: (text: string, key: string) => Promise<void>;
  showUniqueStepBadge: boolean;
}) {
  const key = `${item.side}-${exchangeId}-${index}`;
  // 所有层级统一默认折叠（点击才展开），包括 step 级「当前 step 新增」条目，
  // 避免深链到 step 时每一条内容都被撑开，与 turn/session 级视图保持一致。
  const [open, setOpen] = useState(false);
  // 全屏查看正文（2026-09-20 用户确认）：正文已在内存中，仅做展示层切换，
  // 不触发任何新的数据请求；Esc 或关闭按钮退出。
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);
  const diffLabel = item.stepDiff === "unconfirmed"
    ? "继承比对未确认"
    : showUniqueStepBadge && item.stepDiff === "unique"
      ? "当前 step 新增"
      : item.stepDiff === "inherited" ? "继承上下文" : "";
  const diffClass = diffLabel ? ` step-${item.stepDiff}` : "";
  const hasText = item.text.trim().length > 0;
  const preview = summarizeText(item.text)
    || (item.mediaDescriptors.length > 0
      ? `${item.mediaDescriptors.length} 张图片`
      : "");
  // 上游存在只含空白字符的独立 message（Codex 实测每轮一条单空格消息）。
  // 它是真实数据，但渲染成内容卡只会制造噪音——折叠为一行「空内容」说明，
  // 不可展开、不占正文体积。
  if (!hasText && item.mediaDescriptors.length === 0) {
    return (
      <div
        className={`conv-side conv-item-empty ${item.side} category-${item.category}${diffClass}`}
        role="note"
      >
        {diffLabel ? <span className={`step-diff-badge ${item.stepDiff}`}>{diffLabel}</span> : null}
        <span className={`role ${item.category}`}>{CAT_LABEL[item.category]}{item.toolName ? ` · ${item.toolName}` : ""}</span>
        <span className={`conv-item-side-badge ${item.side}`}>{item.side}</span>
        <span className="conv-item-empty-note">空内容（上游只发了一个空文本片段）</span>
      </div>
    );
  }
  return (
    <>
    <details
      className={`conv-side conv-item-details ${item.side} category-${item.category}${diffClass}`}
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="conv-item-summary">
        {diffLabel ? <span className={`step-diff-badge ${item.stepDiff}`}>{diffLabel}</span> : null}
        <span className={`role ${item.category}`}>{CAT_LABEL[item.category]}{item.category === "user_injected" ? " · Agent 注入" : ""}{item.toolName ? ` · ${item.toolName}` : ""}</span>
        <span className={`conv-item-side-badge ${item.side}`}>{item.side}</span>
        <span className="conv-item-preview">{preview}</span>
      </summary>
      {open ? <div className="conv-detail-body">
        <div className="role-row">
          <span className="conv-side-label">{item.side}</span>
          {item.text ? (
            <span className="conv-item-actions">
              <button type="button" className="fullscreen-action" onClick={() => setFullscreen(true)}>
                <Maximize2 size={13} aria-hidden="true" />
                全屏查看
              </button>
              <button type="button" className={`copy-btn ${copiedKey === key ? "copied" : ""}`} onClick={() => copyText(item.text, key)}>
                {copiedKey === key ? "已复制" : "复制"}
              </button>
            </span>
          ) : null}
        </div>
        {item.text ? (
          item.category === "assistant" || item.category === "reasoning"
            ? <MarkdownView text={item.text} />
            : <div className="txt">{item.text}</div>
        ) : null}
        {item.mediaDescriptors.length > 0 ? (
          <div className="conv-media-list" aria-label="图片附件">
            {item.mediaDescriptors.map(descriptor => (
              <div
                className="conv-media-item"
                key={`${descriptor.bodySide}-${descriptor.ordinal}-${descriptor.sha256}`}
              >
                <div className="conv-media-meta">
                  <ImageIcon size={16} aria-hidden="true" />
                  <span>{descriptor.mediaType}</span>
                  <span>{formatBytes(descriptor.decodedBytes)}</span>
                  <span>#{descriptor.ordinal + 1}</span>
                </div>
                <a
                  className="conv-media-open"
                  href={buildRawMediaHref(
                    item.exchangeId,
                    descriptor.bodySide,
                    descriptor.ordinal,
                  )}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  查看图片
                </a>
              </div>
            ))}
          </div>
        ) : null}
      </div> : null}
    </details>
    {fullscreen && item.text ? createPortal(
      <div className="fullscreen-section-backdrop" role="dialog" aria-modal="true" aria-label={`${item.side} 正文全屏查看`}>
        <section className="fullscreen-section-shell raw-section fullscreen">
          <div className="fullscreen-section-header">
            <strong>{CAT_LABEL[item.category]}{item.toolName ? ` · ${item.toolName}` : ""} · {item.side}</strong>
            <span className="fullscreen-section-actions">
              <button
                type="button"
                className={`copy-btn fullscreen-copy-btn ${copiedKey === `${key}-fullscreen` ? "copied" : ""}`}
                onClick={() => copyText(item.text, `${key}-fullscreen`)}
                aria-label="复制正文"
              >
                {copiedKey === `${key}-fullscreen` ? "已复制" : "复制"}
              </button>
              <button type="button" className="fullscreen-action restore" onClick={() => setFullscreen(false)}>
                <Minimize2 size={14} aria-hidden="true" />
                退出全屏
              </button>
            </span>
          </div>
          <div className="raw-section-body conv-fullscreen-body">
            {item.category === "assistant" || item.category === "reasoning"
              ? <MarkdownView text={item.text} />
              : <div className="txt">{item.text}</div>}
            {/* 全屏正文收尾标识（2026-09-29 用户确认）：滚动到底后的居中底线文案。 */}
            <div className="conv-fullscreen-footer" aria-hidden="true">~ 我是有底线的 ~</div>
          </div>
        </section>
      </div>,
      document.body,
    ) : null}
    </>
  );
}

function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

function ExportPageStatus({ data, pageNumber }: { data: ExportContentPageResult; pageNumber: number }) {
  const page = data.page;
  const loadedCount = page.visibleProcessedCount;
  if (page.limitedByBytes && loadedCount < page.visibleExchangeLimit) {
    return (
      <div className="exp-limit-banner" role="status">
        本页正文较大，已缩减为 {loadedCount} 条可见记录。
      </div>
    );
  }
  return (
    <div className="exp-page-status" role="status">
      第 {pageNumber} 页 · 当前 {loadedCount} 条 · 比对历史请求 {page.baselineProcessedCount} 条 · {candidateCountLabel(page)} · 当前页完整可读内容 {formatBytes(page.processedRawBytes)}
    </div>
  );
}

function candidateCountLabel(page: ExportContentPageResult["page"]): string {
  // 未请求统计（skipCandidateCount）时不得显示 0，必须如实显示「未统计」。
  if (page.candidateCount === undefined) return "总数未统计";
  return page.candidateCountExact
    ? `共 ${page.candidateCount} 条`
    : `已确认匹配 ${page.candidateCount} 条`;
}

function OversizedExchangePrompt({
  value,
  onConfirm,
}: {
  value: OversizedExchangeState;
  onConfirm: () => void;
}) {
  const exchangeId = encodeURIComponent(value.exchangeId);
  const requestInlineHref = `/api/exchanges/${exchangeId}/raw/request?disposition=inline`;
  const requestDownloadHref = `/api/exchanges/${exchangeId}/raw/request?disposition=attachment`;
  const responseInlineHref = `/api/exchanges/${exchangeId}/raw/response?disposition=inline`;
  const responseDownloadHref = `/api/exchanges/${exchangeId}/raw/response?disposition=attachment`;
  const canLoadInline = value.requiredBytes <= MAX_CONFIRMED_EXCHANGE_BYTES;
  return (
    <section className="exp-oversized-prompt" role="alert" aria-labelledby="oversized-exchange-title">
      <div className="exp-oversized-heading">
        <AlertTriangle size={20} aria-hidden="true" />
        <div>
          <strong id="oversized-exchange-title">当前 Exchange 超过单页读取预算</strong>
          <span>{formatBytes(value.requiredBytes)} · {value.exchangeId}</span>
        </div>
      </div>
      <p>
        {canLoadInline
          ? "确认后只加载该 Exchange，不会提高同页其他记录的预算。"
          : `该记录超过 ${formatBytes(MAX_CONFIRMED_EXCHANGE_BYTES)} 页面硬上限，请改用单侧 Raw 查看或下载。`}
      </p>
      <div className="exp-oversized-actions">
        {canLoadInline ? (
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            仅加载该 Exchange
          </button>
        ) : null}
        <a className="btn" href={requestInlineHref} target="_blank" rel="noreferrer">
          <ExternalLink size={15} aria-hidden="true" />
          查看请求 Raw
        </a>
        <a className="btn" href={responseInlineHref} target="_blank" rel="noreferrer">
          <ExternalLink size={15} aria-hidden="true" />
          查看响应 Raw
        </a>
        <a className="btn" href={requestDownloadHref}>
          <Download size={15} aria-hidden="true" />
          下载请求 Raw
        </a>
        <a className="btn" href={responseDownloadHref}>
          <Download size={15} aria-hidden="true" />
          下载响应 Raw
        </a>
      </div>
    </section>
  );
}
