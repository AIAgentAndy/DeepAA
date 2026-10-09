"use client";

import { RefreshCcw, RotateCcw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import {useEffect, useId, useMemo, useRef, useState} from "react";
import { CostHelp } from "@/components/cost-help";
import {ReconciliationPanel} from "@/components/reconciliation-panel";
import type { PricingCatalogPage, PricingVendorList } from "@/lib/pricing";
import {formatCnyMoney} from "@/lib/money-display";
import {useGlobalTimeZone} from "@/lib/timezone-preference";
import {
  actualCostDetailFormula,
  costDetailFormula,
  formatCacheHitRateFormula,
  formatDecimal,
  formatDetailMoney,
  formatInteger,
  formatSummaryMoney,
  formatSummaryTokenAmount,
  formatTokenAmount,
  formatUnitPrice,
  formatVendorMoney,
  multipliedCostDetailFormula,
  planEstimateConversionNote,
  scheduleBadge,
} from "@/lib/token-pricing-display";
import {
  type TokenPricingBreakdown,
  type TokenPricingItem,
  type TokenPricingOption,
  type TokenPricingState,
} from "@/lib/token-pricing";
import {
  topLevelHref,
  tokenPricingHierarchyAfterChange,
  tokenPricingHierarchyAfterResolution,
} from "@/lib/shared-selection";
import { datetimeLocalValueToIso, formatLocalDateTime, isoToDatetimeLocalValue, toDatetimeLocalValue } from "@/lib/local-time";
import { DEFAULT_TIME_ZONE, TIME_ZONE_OPTIONS, timeZoneOffsetMinutes } from "@/lib/timezones";

/**
 * 套餐/订阅行「估算真实成本（套餐成本估算）」的 ？公式（2026-09-23；2026-10-09 B2/B3
 * 客户端化）：积分公式（入账快照冻结）+ 估算换算链两段拼接。换算链由共享
 * planEstimateConversionNote 按「查看者时区 + 份额全链路（行市价 ÷ 周期市价合计，
 * 四项单价 × token 分解）」现算——服务端不下发拼接串（tz 刻意不进查询串，2026-09-17
 * 全站时区统一），与会话追踪 Step 面板同一实现。
 */
function planRealCostFormulaText(item: TokenPricingItem, timeZone?: string): string | undefined {
  const creditFormula = item.planCreditFormulaDetail ?? item.planCreditFormula
    ?? (item.planCreditCost !== undefined
      ? `套餐/订阅通道：积分消耗 ${formatDecimal(item.planCreditCost, 4)} ${item.planCreditUnit ?? ""}，按入账时冻结的换算折算为人民币`
      : undefined);
  const note = item.planEstimateDetail !== undefined
    ? planEstimateConversionNote(
        item.planEstimateDetail,
        item.planRealCost ?? 0,
        item.planEstimatedCurrency,
        {
          timeZone,
          rowMarketCny: item.actualCostCny,
          marketCurrency: item.currency,
          marketComponents: [
            {label: "非缓存输入", unitPrice: item.inputUnitPrice, tokens: item.inputTokens, cost: item.inputCost},
            {label: "缓存读取", unitPrice: item.cacheReadUnitPrice, tokens: item.cacheReadTokens, cost: item.cacheReadCost},
            {label: "缓存写入", unitPrice: item.cacheWriteUnitPrice, tokens: item.cacheCreationTokens, cost: item.cacheCreationCost},
            {label: "输出", unitPrice: item.outputUnitPrice, tokens: item.outputTokens, cost: item.outputCost},
          ],
        },
      )
    : undefined;
  return [
    ...(creditFormula ? [creditFormula] : []),
    ...(note ? [note] : []),
  ].join("\n") || undefined;
}

const PAGE_SIZE_OPTIONS = [10, 50, 100];
const DEFAULT_PAGE_SIZE = 10;

/** 待补估算徽标共用悬浮说明（2026-10-09 徽标收敛，取代旧「（部分估算）+待补额度」）：
 *  只报计数与成因，不否定已估算金额；旧措辞「待补额度」易被误读为额度未同步。 */
const PLAN_ESTIMATE_PENDING_HINT
  = "套餐/订阅请求按额度差分估算（近似），以下行暂无估算金额（均会自动收敛）：①最近一次额度刻度跳动之后的新请求——下一个刻度自动补算；②早于最早额度快照的历史请求——已结算证据充分（≥5 行且市价 ≥￥1）后按比率兜底自动补算；③计费窗口重置的整数刻度零头——按 0.5% 中点自动补算。已估算金额为入账时冻结值，不受后续补算影响。";

interface TokenPricingFilters {
  target: string;
  agent: string;
  session: string;
  thread: string;
  turn: string;
  step: string;
  model: string;
  vendor: string;
  schedule: string;
  start: string;
  end: string;
  tz: string;
  includeAuxiliary: string;
  /** 估算待补筛选（2026-10-09 #5）：""=全部（默认）、"1"=仅待补（徽标跳转落地）。 */
  pending: string;
  /** 仪表盘追溯过滤：计费通道（逗号多值）。 */
  channel: string;
  /** 请求结果多选（逗号分隔 token）；缺省=成功+已取消+补差（站点已计费口径）；"all"=全量。 */
  result: string;
  /** 仪表盘追溯过滤：Token 构成（输入/输出/缓存）。 */
  tokenComponent: string;
  limit: number;
  offset: number;
  cursor: string;
}

interface PricingOptions {
  models: TokenPricingOption[];
  vendors: TokenPricingOption[];
}

export function TokenPricingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  // 全站统一时区（右上角选择器）：组件订阅全局值并同步到过滤器（纯函数保持无 Hook）。
  const globalTz = useGlobalTimeZone();
  const [filters, setFilters] = useState<TokenPricingFilters>(() => ({
    ...filtersFromSearchParams(new URLSearchParams(searchKey), globalTz.value),
    tz: globalTz.value,
  }));
  useEffect(() => {
    setFilters(current => {
      if (current.tz === globalTz.value) return current;
      // 默认「今天 00:00」跟随全局时区：URL 未显式给 start 且当前起点仍是旧时区的
      // 默认值时，按新时区重算（用户显式选择的范围不动）。
      const urlHasStart = Boolean(new URLSearchParams(window.location.search).get("start"));
      const startIsUntouchedDefault = !urlHasStart && current.start === defaultFilters(current.tz).start;
      return {
        ...current,
        tz: globalTz.value,
        ...(startIsUntouchedDefault ? {start: defaultFilters(globalTz.value).start} : {}),
      };
    });
  }, [globalTz.value]);
  const [state, setState] = useState<TokenPricingState | undefined>();
  const [resolvedSelectionQuery, setResolvedSelectionQuery] = useState("");
  const [pricingOptions, setPricingOptions] = useState<PricingOptions>({ models: [], vendors: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  useEffect(() => {
    setFilters(current => {
      // 时区始终取全局值（URL 不携带 tz 参数；全局选择器是唯一入口）。
      const next = {...filtersFromSearchParams(new URLSearchParams(searchKey), globalTz.value), tz: globalTz.value};
      return filtersEqual(current, next) ? current : next;
    });
  }, [searchKey]);

  useEffect(() => {
    let cancelled = false;
    async function loadPricingOptions() {
      try {
        const [vendorsResponse, catalogResponse] = await Promise.all([
          fetch("/api/model-pricing?view=vendors", { cache: "no-store" }),
          fetch("/api/model-pricing?view=catalog&limit=200&offset=0", { cache: "no-store" }),
        ]);
        const vendorsPayload = vendorsResponse.ok ? await vendorsResponse.json() as PricingVendorList : { vendors: [] };
        const catalogPayload = catalogResponse.ok ? await catalogResponse.json() as PricingCatalogPage : { items: [], total: 0, limit: 200, offset: 0, facets: { vendors: [], modes: [] } };
        if (cancelled) return;
        setPricingOptions({
          vendors: uniqueOptions((vendorsPayload.vendors || []).map(value => ({ value, label: value }))),
          models: uniqueOptions((catalogPayload.items || []).map(item => ({ value: item.id, label: `${item.id} · ${item.vendor}`, vendor: item.vendor }))),
        });
      } catch {
        if (!cancelled) setPricingOptions({ models: [], vendors: [] });
      }
    }
    void loadPricingOptions();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      const requestQuery = queryFromFilters(filters);
      try {
        const response = await fetch(`/api/token-pricing?${requestQuery}`, { cache: "no-store" });
        const payload = await response.json() as TokenPricingState | { error?: string };
        if (!response.ok) throw new Error("error" in payload && payload.error ? payload.error : `HTTP ${response.status}`);
        if (!cancelled) {
          setState(payload as TokenPricingState);
          setResolvedSelectionQuery(requestQuery);
        }
      } catch (errorValue) {
        if (!cancelled) setError(errorValue instanceof Error ? errorValue.message : "Token价格数据加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [filters, refreshNonce]);

  useEffect(() => {
    const resolved = state?.resolvedSelection;
    if (!resolved?.session || !resolvedSelectionQuery || resolvedSelectionQuery !== queryFromFilters(filters)) return;
    const nextSelection = tokenPricingHierarchyAfterResolution(filters, resolved);
    if (
      filters.session === nextSelection.session
      && filters.thread === nextSelection.thread
      && filters.turn === nextSelection.turn
      && filters.step === nextSelection.step
    ) return;
    commitFilters({
      ...filters,
      ...nextSelection,
      offset: 0,
      cursor: "",
    });
    setCursorHistory([]);
  }, [state?.resolvedSelection, resolvedSelectionQuery, filters]);

  const facets = state?.facets;
  const allModelOptions = useMemo(() => uniqueOptions([...(pricingOptions.models || []), ...(facets?.models || [])]), [pricingOptions.models, facets?.models]);
  const allVendorOptions = useMemo(() => uniqueOptions([...(pricingOptions.vendors || []), ...(facets?.vendors || [])]), [pricingOptions.vendors, facets?.vendors]);
  const modelOptions = useMemo(
    () => filterModelsByVendor(allModelOptions, filters.vendor, filters.model),
    [allModelOptions, filters.vendor, filters.model],
  );
  const vendorOptions = useMemo(
    () => filterVendorsByModel(allVendorOptions, allModelOptions, filters.model, filters.vendor),
    [allVendorOptions, allModelOptions, filters.model, filters.vendor],
  );
  const totalPages = Math.max(1, Math.ceil((state?.total || 0) / filters.limit));
  const currentPage = Math.floor(filters.offset / filters.limit) + 1;
  const displayStart = state && state.items.length > 0 ? filters.offset + 1 : 0;
  const displayEnd = state && state.items.length > 0 ? Math.min(filters.offset + state.items.length, state.total) : 0;
  const sortWindowLimited = Boolean(state?.limited.sortWindow);
  const scheduleOptions = facets?.schedules || [];
  const hasScheduleDimension = scheduleOptions.length > 0;
  const hasPlanCredit = state?.items.some(item => item.planCreditUnit !== undefined) === true;
  /* 总消费卡 量/套 拆分与估算总额（口径与仪表盘 KPI 一致）。 */
  const summaryPayg = (state?.summary.paygActualCost ?? 0) > 0 || (state?.summary.paygVendorCost ?? 0) > 0;
  const summaryPlan = (state?.summary.planMarketCost ?? 0) > 0 || (state?.summary.planCredits ?? 0) > 0;
  /* 省钱率仅在套餐估算完整（非部分估算且估算值 > 0）时展示，旧口径 0 值不参与。 */
  const savingsRate = state?.summary.planRealCost !== undefined
    && !state.summary.planRealCostUnavailable
    && state.summary.planRealCost > 0
    && (state?.summary.planMarketCost ?? 0) > 0
    ? 1 - state.summary.planRealCost / (state.summary.planMarketCost || 0)
    : undefined;
  const summaryRealTotal = (state?.summary.paygActualCost ?? 0) + (state?.summary.planRealCost ?? 0);
  /* 冻结列布局（2026-09-05 用户确认）：左冻结 ID/供应商/Agent，右冻结 费用/TOKEN/耗时/请求时间；
     中间字段固定最小宽度、容器横向滚动。冻结列轨道必须为固定 px，保证 sticky 偏移稳定。 */
  const rowGridColumns = useMemo(() => {
    const frozenLeft = "150px 160px 64px";
    const middle = "64px minmax(104px,0.8fr) minmax(104px,0.8fr) minmax(104px,0.8fr) minmax(126px,0.8fr) minmax(146px,1fr)";
    const schedule = hasScheduleDimension ? " minmax(84px,0.6fr)" : "";
    const mid2 = " minmax(118px,0.8fr) 76px 86px 52px minmax(146px,1fr)";
    const frozenRight = " 185px 125px 115px 118px";
    return `${frozenLeft} ${middle}${schedule}${mid2}${frozenRight}`;
  }, [hasScheduleDimension]);
  /* 行最小总宽：保证中间字段不被压扁，触发容器横向滚动。 */
  const rowMinWidth = useMemo(() => hasScheduleDimension ? 1699 : 1615, [hasScheduleDimension]);

  function updateFilter<K extends keyof TokenPricingFilters>(key: K, value: TokenPricingFilters[K]) {
    const next = {
      ...filters,
      [key]: value,
      offset: key === "offset" ? Number(value) : 0,
      cursor: key === "offset" || key === "cursor" ? String(value) : "",
    };
    if (key !== "offset" && key !== "cursor") setCursorHistory([]);
    if ((key === "session" || key === "thread" || key === "turn" || key === "step") && typeof value === "string") {
      Object.assign(next, tokenPricingHierarchyAfterChange(next, key, value));
    }
    if ((key === "target" || key === "agent") && typeof value === "string") {
      Object.assign(next, { session: "", thread: "", turn: "", step: "" });
    }
    if (key === "vendor" && typeof value === "string" && value && next.model && !modelMatchesVendor(allModelOptions, next.model, value)) {
      next.model = "";
    }
    if (key === "model" && typeof value === "string" && value && next.vendor && !modelMatchesVendor(allModelOptions, value, next.vendor)) {
      next.vendor = "";
    }
    commitFilters(next);
  }

  function refresh() {
    setRefreshNonce(current => current + 1);
  }

  function reset() {
    setCursorHistory([]);
    commitFilters(defaultFilters(globalTz.value));
  }

  function goToNextPage() {
    if (!state?.nextCursor || loading) return;
    setCursorHistory(history => [...history, filters.cursor]);
    commitFilters({
      ...filters,
      cursor: state.nextCursor,
      offset: filters.offset + filters.limit,
    });
  }

  function goToPreviousPage() {
    if (cursorHistory.length === 0 || loading) return;
    const previousCursor = cursorHistory.at(-1) || "";
    setCursorHistory(history => history.slice(0, -1));
    commitFilters({
      ...filters,
      cursor: previousCursor,
      offset: Math.max(0, filters.offset - filters.limit),
    });
  }

  function commitFilters(next: TokenPricingFilters) {
    setResolvedSelectionQuery("");
    setFilters(next);
    const query = queryFromFilters(next);
    router.replace(`/token-pricing?${query}`, { scroll: false });
  }

  return (
    <section className="token-pricing-page" aria-label="Token价格">
      <div className="token-summary-grid">
        <SummaryBox label="总请求数" value={formatInteger(state?.summary.requestCount)} subLabel="过滤范围内" />
        <SummaryBox
          label="总Token"
          value={formatSummaryTokenAmount(totalTokens(state))}
          subLabel={(
            <>
              非缓存输入 {formatTokenAmount(state?.summary.inputTokens || 0)} · 缓存读取 {formatTokenAmount(state?.summary.cacheReadTokens || 0)} · 缓存写入 {formatTokenAmount(state?.summary.cacheCreationTokens || 0)} · 输出 {formatTokenAmount(state?.summary.outputTokens || 0)}
              <br />
              缓存命中率：<em className="token-hit-rate">{formatCacheHitRateValue(state?.summary.inputTokens || 0, state?.summary.cacheReadTokens || 0)}</em>
            </>
          )}
        />
        <article className="token-summary-box accent" aria-label="总消费">
          <span>总消费</span>
          <strong title="估算总额 = 按量倍率后实付 + 套餐成本估算（人民币口径，按入账时冻结的结算系数折算）">{formatCnyMoney(summaryRealTotal)}</strong>
          <div className="token-cost-split">
            {(summaryPayg || summaryPlan) ? (
              <>
                {summaryPayg ? (
                  <span className="token-cost-row" title="按量通道：倍率前供应商成本 → 倍率后实际成本（人民币口径 = 原币种 × 入账时冻结的结算系数）">
                    <i className="token-cost-badge quantity">量</i>
                    <span>
                      倍率前 <s>{formatCnyMoney(state?.summary.paygVendorCost)}</s>
                      {" → "}倍率后 <strong>{formatCnyMoney(state?.summary.paygActualCost)}</strong>
                    </span>
                  </span>
                ) : null}
                {summaryPlan ? (
                  <span
                    className="token-cost-row"
                    title={state?.summary.planRealCostUnavailable
                      ? "套餐/订阅通道：存在待补估算请求，合计为已估算部分的冻结值（见小字计数）"
                      : "套餐/订阅通道：市价（供应商成本） → 成本估算（月费×消耗比率折算，入账时冻结）"}
                  >
                    <i className="token-cost-badge plan">套</i>
                    <span>
                      市价 <s>{formatCnyMoney(state?.summary.planMarketCost)}</s>
                      {" → "}估算 <strong>{formatCnyMoney(state?.summary.planRealCost)}</strong>
                      {savingsRate !== undefined ? `，省钱率 ${formatPercentage(savingsRate)}` : ""}
                      {state?.summary.planRealCostUnavailable ? (
                        <a
                          className="token-cost-pending"
                          title={`${PLAN_ESTIMATE_PENDING_HINT}（点击筛选查看待补请求）`}
                          href={`/token-pricing?${queryFromFilters({...filters, pending: "1", cursor: "", offset: 0})}`}
                        >
                          {state.summary.planEstimatedPendingCount ?? "?"} 条估算待补
                        </a>
                      ) : null}
                    </span>
                  </span>
                ) : null}
              </>
            ) : (
              <span className="token-cost-row">
              倍率前 <s>{formatVendorMoney(state?.summary.vendorCost, false, "CNY")}</s>
              </span>
            )}
          </div>
        </article>
        <SummaryBox
          label="平均耗时"
          value={state?.summary.averageDurationSeconds === undefined ? "-" : `${formatDecimal(state.summary.averageDurationSeconds, 2)}s`}
          subLabel={(
            <>
              中位数 {state?.summary.medianDurationSeconds === undefined ? "-" : `${formatDecimal(state.summary.medianDurationSeconds, 2)}s`}
              {state && state.summary.durationSampleCount < state.summary.requestCount
                ? ` · 基于 ${formatInteger(state.summary.durationSampleCount)} 条可用耗时`
                : " · 每次请求"}
            </>
          )}
        />
      </div>

      <TokenPricingBreakdownTable
        breakdown={state?.breakdown || []}
        loading={loading}
        limited={state?.limited.breakdown === true}
        buildPendingHref={row => `/token-pricing?${queryFromFilters({
          ...filters,
          pending: "1",
          cursor: "",
          offset: 0,
          ...(row ? {target: row.targetId, model: row.model} : {}),
        })}`}
      />

      <ReconciliationPanel targetId={filters.target} onApplied={() => setRefreshNonce(current => current + 1)} />
      <div className="token-filter-panel">
        <SearchableSelectField label="供应商" value={filters.target} options={facets?.targets || []} onChange={value => updateFilter("target", value)} />
        <SearchableSelectField label="Agent" value={filters.agent} options={facets?.agents || []} onChange={value => updateFilter("agent", value)} />
        <SearchableSelectField label="Session" value={filters.session} options={facets?.sessions || []} onChange={value => updateFilter("session", value)} />
        <SearchableSelectField
          label="Thread"
          value={filters.thread}
          options={facets?.threads || []}
          onChange={value => updateFilter("thread", value)}
          disabled={!filters.session}
          disabledLabel="请先选择 Session"
        />
        <SearchableSelectField
          label="Turn"
          value={filters.turn}
          options={facets?.turns || []}
          onChange={value => updateFilter("turn", value)}
          disabled={!filters.thread}
          disabledLabel="请先选择 Thread"
        />
        <SearchableSelectField
          label="Step"
          value={filters.step}
          options={facets?.steps || []}
          onChange={value => updateFilter("step", value)}
          disabled={!filters.turn}
          disabledLabel="请先选择 Turn"
        />
        <SearchableSelectField label="价格中心供应商" value={filters.vendor} options={vendorOptions} onChange={value => updateFilter("vendor", value)} />
        <SearchableSelectField label="模型" value={filters.model} options={modelOptions} onChange={value => updateFilter("model", value)} />
        {hasScheduleDimension ? (
          <SearchableSelectField label="高峰/闲时" value={filters.schedule} options={scheduleOptions} onChange={value => updateFilter("schedule", value)} />
        ) : null}
        <label className="token-filter-field">
          <span>是否包含辅助请求</span>
          <select value={filters.includeAuxiliary} onChange={event => updateFilter("includeAuxiliary", event.currentTarget.value)}>
            <option value="no">否（默认）</option>
            <option value="yes">是</option>
          </select>
        </label>
        <label className="token-filter-field">
          <span>估算待补</span>
          <select value={filters.pending} onChange={event => updateFilter("pending", event.currentTarget.value)}>
            <option value="">全部（默认）</option>
            <option value="1">仅待补</option>
          </select>
        </label>
        <FilterMultiSelect
          label="请求结果"
          options={RESULT_TOKEN_OPTIONS}
          value={filters.result === "all"
            ? RESULT_TOKEN_OPTIONS.map(option => option.token).join(",")
            : filters.result}
          onChange={next => updateFilter("result", next)}
          emptyLabel="成功+已取消+补差"
        />
        <FilterMultiSelect
          label="计费通道"
          options={CHANNEL_OPTIONS}
          value={filters.channel}
          onChange={next => updateFilter("channel", next)}
          emptyLabel="全部"
        />
        <FilterMultiSelect
          label="Token 构成"
          options={TOKEN_COMPONENT_OPTIONS}
          value={filters.tokenComponent}
          onChange={next => updateFilter("tokenComponent", next)}
          emptyLabel="全部"
        />
        {/* 时区已统一到右上角全局选择器（2026-09-10）：此处不再重复提供入口。 */}
        <div className="token-filter-datetime-range">
          <label className="token-filter-field">
            <span>开始时间</span>
            <input type="datetime-local" step="1" value={filters.start} onChange={event => updateFilter("start", event.currentTarget.value)} />
          </label>
          <label className="token-filter-field">
            <span>结束时间</span>
            <input type="datetime-local" step="1" value={filters.end} onChange={event => updateFilter("end", event.currentTarget.value)} />
          </label>
        </div>
        <div className="token-filter-actions">
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading}>
            <RefreshCcw size={14} />
            <span>刷新</span>
          </button>
          <button type="button" className="secondary-button" onClick={reset} disabled={loading}>
            <RotateCcw size={14} />
            <span>重置</span>
          </button>
        </div>
      </div>

      <div className="token-table-shell">
        <div className="token-table-status">
          <span>显示 {displayStart} 至 {displayEnd} 共 {formatInteger(state?.total)} 条结果</span>
        </div>
        {state && hasLimitWarning(state) ? (
          <div className="token-limit-stack">
            {state.limited.sortWindow ? (
              <div className="token-limit-banner">分页偏移过深，已拒绝构建过大的排序窗口；请缩小时间范围或过滤条件后重试。</div>
            ) : null}
            {state.limited.ledgerScan ? (
              <div className="token-limit-banner">账本扫描达到安全上限，当前汇总和列表只包含已处理候选；请缩小时间范围或增加过滤条件。</div>
            ) : null}
            {state.limited.durationHydration ? (
              <div className="token-limit-banner">部分历史账本缺少请求耗时快照，平均耗时仅基于已安全读取到的记录。</div>
            ) : null}
          </div>
        ) : null}
        <div className="token-pricing-table" role="table" aria-label="Token价格请求明细">
          <div className="token-pricing-row header" role="row" style={{ gridTemplateColumns: rowGridColumns, minWidth: rowMinWidth }}>
            <span className="st-l1">ID</span>
            <span className="st-l2">供应商</span>
            <span className="st-l3">Agent</span>
            <span>计费通道</span>
            <span>Session</span>
            <span>Thread</span>
            <span>Turn</span>
            <span>Step</span>
            <span>模型</span>
            {hasScheduleDimension ? <span>高峰/闲时</span> : null}
            <span>价格中心供应商</span>
            <span>价格倍率</span>
            <span>请求结果</span>
            <span>辅助</span>
            <span>套餐积分</span>
            <span className="st-r1">费用</span>
            <span className="st-r2">TOKEN</span>
            <span className="st-r3">耗时</span>
            <span className="st-r4">请求时间</span>
          </div>
          {loading ? <div className="token-empty">加载中...</div>
            : error ? <div className="token-empty">加载失败：{error}</div>
            : sortWindowLimited ? <div className="token-empty">分页偏移过深，请缩小时间范围或过滤条件后重试。</div>
            : !state || state.items.length === 0 ? <div className="token-empty">无匹配数据</div>
            : state.items.map(item => (
              <div className="token-pricing-row" role="row" key={item.exchangeId} style={{ gridTemplateColumns: rowGridColumns, minWidth: rowMinWidth }}>
                <span className="token-step-cell st-l1">
                  {item.stepId ? (
                    <a
                      className="token-step-link"
                      href={`/export?step=${encodeURIComponent(item.stepId)}`}
                      title={`Step 唯一标识，点击在交互内容页定位：${item.stepId}`}
                    >
                      {item.stepId}
                    </a>
                  ) : item.requestKind === "reconciliation" && item.recon?.kind === "adjustment" && item.recon.linkedStepId ? (
                    // 补差行自身无 Step；展示挂靠的原始请求 Step ID，与原行同 ID 并列出现
                    // 即可一眼配对（纯展示，不改入库与唯一键）。点击新标签打开原始请求明细。
                    (() => {
                      const linkedHref = reconLinkedHref(item.recon);
                      return linkedHref ? (
                        <a
                          className="token-step-link"
                          href={linkedHref}
                          target="_blank"
                          rel="noopener"
                          title={`补差行挂靠的原始请求 Step：${item.recon.linkedStepId}，点击在新标签页打开其明细`}
                        >
                          {item.recon.linkedStepId}
                        </a>
                      ) : (
                        <span title={`补差行挂靠的原始请求 Step：${item.recon.linkedStepId}`}>{item.recon.linkedStepId}</span>
                      );
                    })()
                  ) : <span title="辅助/对账行无 Step">-</span>}
                </span>
                <span className="st-l2" title={item.targetId}>{item.targetId}</span>
                <span className="st-l3" title={item.agentName}>{item.agentName}</span>
                <span title={billingChannelLabel(item.billingChannel)}>{billingChannelLabel(item.billingChannel)}</span>
                <span className="token-id-cell">
                  <span className="token-id-deepaa" title="DeepAA系统生成">{item.sessionId || "-"}</span>
                  <span className="token-id-agent" title={`${item.agentName} 业务 Session`}>{item.externalSessionId || "-"}</span>
                </span>
                <span className="token-id-cell">
                  <span className="token-id-deepaa" title="DeepAA系统生成">{item.threadId || "-"}</span>
                  <span className="token-id-agent" title={`${item.agentName} 业务 Thread`}>{item.externalThreadId || "-"}</span>
                </span>
                <span className="token-id-cell">
                  <span className="token-id-deepaa" title="DeepAA系统生成">{item.turnId || "-"}</span>
                  <span className="token-id-agent" title={`${item.agentName} 业务 Turn`}>{item.externalTurnId || "-"}</span>
                </span>
                <span className="token-id-cell">
                  <span className="token-id-deepaa" title="DeepAA系统生成">{item.stepId || "-"}</span>
                  {/* 原生 Step 键（如 dsh session:step:N，经身份标注/导入合成头物化）；多数 Agent 无该标识仍显示 -。 */}
                  <span className="token-id-agent" title={`${item.agentName} 业务 Step`}>{item.externalStepId || "-"}</span>
                </span>
                <span className="token-model-cell" title={item.model}>
                  <span>{item.model}</span>
                  {item.requestKind === "reconciliation" && item.recon?.kind === "adjustment" ? (
                    <span
                      className="token-badge"
                      title={`对账补差行（${reconConfidenceLabel(item.recon.confidence)}）：${reconUsageCarrier(item)
                        ? "本行为该请求的用量载体——站点实扣 Token 与金额已回填（单价/倍率复制原行冻结快照），作为真实记录参与请求与 Token 统计，原失败行的估算用量让位"
                        : "本行金额=该请求站点实扣与本地计价的差额，只计金额不计请求与 Token"}；结算小时 ${item.recon.hourStartUtc}${reconDiscountNote(item.recon) ?? ""}`}
                    >
                      对账补差{item.recon.linkedStepId ? (
                        (() => {
                          const linkedHref = reconLinkedHref(item.recon);
                          return linkedHref ? (
                            <a
                              className="token-recon-link"
                              href={linkedHref}
                              target="_blank"
                              rel="noopener"
                              title={`挂账于原始请求 ${item.recon.linkedExchangeId}，点击在新标签页打开其 Token 价格明细`}
                            >
                              · 原始记录 ↗
                            </a>
                          ) : (
                            <span
                              className="token-recon-link"
                              title={`挂账于原始请求 ${item.recon.linkedExchangeId}`}
                            >
                              · 原始记录
                            </span>
                          );
                        })()
                      ) : item.recon.linkedExchangeId ? (
                        <span
                          className="token-recon-link"
                          title={`挂账于原始请求 ${item.recon.linkedExchangeId}`}
                        >
                          · 原始记录
                        </span>
                      ) : null}
                    </span>
                  ) : item.requestKind === "reconciliation" ? (
                    <span className="token-badge" title="对账补差行：金额=与站点消费的小时差异（人工确认或小时残差自动补），只计金额不计请求与 Token">
                      对账补差
                    </span>
                  ) : null}
                  {item.recon?.kind === "matched" ? (
                    <span
                      className="token-badge reconciled"
                      title={`已对账（${reconConfidenceLabel(item.recon.confidence)}）：站点实扣 $${(item.recon.siteAmountNano / 1e9).toFixed(6)}，本地计价 $${(item.recon.localAmountNano / 1e9).toFixed(6)}${item.recon.adjustmentNano === 0 ? "，逐分一致" : `，差额 $${(item.recon.adjustmentNano / 1e9).toFixed(6)} 已按上方补差行自动补齐`}${reconDiscountNote(item.recon) ?? ""}`}
                    >
                      {item.recon.adjustmentNano === 0 ? "已对账·一致" : "已对账·已补差"}
                    </span>
                  ) : null}
                  {item.usageSource === "agent_local_import" ? (
                    <span
                      className="token-badge"
                      title="官方直连本地导入：请求未经本网关（享官方客户端权益），用量为 Agent 客户端自报"
                    >
                      官方直连
                    </span>
                  ) : null}
                  {item.usageSource === "tokenizer_estimated" ? (
                    <span
                      className="token-badge estimated"
                      title="供应商未返回用量，Token 与费用为估算；该费用未计入上方实际总消费"
                    >
                      估算
                    </span>
                  ) : null}
                  {item.responseStatus !== undefined && item.responseStatus >= 400 ? (
                    <span
                      className="token-badge failed"
                      title={item.diagnosticCodes && item.diagnosticCodes.length > 0
                        ? `失败 ${item.responseStatus}：${item.diagnosticCodes.join("、")}`
                        : `失败 ${item.responseStatus}`}
                    >
                     失败 {item.responseStatus}
                    </span>
                  ) : null}
                  {item.scheduleLabel ? (
                    <span
                      className="token-badge schedule"
                      title={item.scheduleLabel === "高峰"
                        ? "未命中闲时窗口，按基础价（高峰价）计费"
                        : "命中时段费率窗口，按窗口价计费"}
                    >
                      {scheduleBadge(item.scheduleLabel)}
                    </span>
                  ) : null}
                  {item.serviceTier ? (
                    <span
                      className="token-badge schedule"
                      title={`service_tier=${item.serviceTier}：按服务档位价格集计费`}
                    >
                      fast
                    </span>
                  ) : null}
                  {item.promotionLabel ? (
                    <span
                      className="token-badge schedule"
                      title={`官方通道促销实扣价计费：${item.promotionLabel}`}
                    >
                      {item.promotionLabel}
                    </span>
                  ) : null}
                </span>
                {hasScheduleDimension ? (
                  <span>{item.scheduleLabel ? scheduleBadge(item.scheduleLabel) : "-"}</span>
                ) : null}
                <span title={item.vendor}>{item.vendor}</span>
                  {/* 纯金额更正补差行零 Token、倍率无意义（2026-09-28 置 -）；用量载体行
                      已回填站点真值并复制原行价格快照，正常展示倍率（2026-09-29）。 */}
                <span>{item.requestKind === "reconciliation" && !reconUsageCarrier(item) ? "-" : formatDecimal(item.rateMultiplier, 4)}</span>
                <span>
                  {item.resultClass
                    ? <span className={`token-result-dot ${resultToneClass(item.resultClass)}`} title={`请求结果分类：${item.resultClass}`}>{resultClassLabel(item.resultClass)}</span>
                    : <span className="token-result-dot muted">-</span>}
                </span>
                <span title={isAuxiliaryRequest(item.requestKind) ? "供应商级辅助请求（元数据/计数等非模型调用）" : undefined}>
                  {isAuxiliaryRequest(item.requestKind) ? "是" : "否"}
                </span>
                <span className="token-cell-stack token-credit-cell">
                  {item.planCreditCost === undefined
                    ? "-"
                    : <strong>{`${formatDecimal(item.planCreditCost, 4)} ${item.planCreditUnit ?? ""}`}</strong>}
                  {item.planCreditFormula ? (
                    <>
                      <small>{item.planCreditFormula}</small>
                      <span>
                        <CostHelp
                          formula={item.planCreditFormulaDetail ?? item.planCreditFormula}
                          label="套餐积分计算过程（入账时快照）"
                        />
                      </span>
                    </>
                  ) : null}
                </span>
                <span className="token-cell-stack token-cost-cell st-r1">
                  {!item.hasUsage ? <strong className="usage-missing">无 usage</strong> : null}
                  <small>非缓存输入价-供应商 {formatUnitPrice(item.inputUnitPrice, item.currency)}</small>
                  <small>缓存命中价-供应商 {formatUnitPrice(item.cacheReadUnitPrice, item.currency)}</small>
                  <small>缓存写入价-供应商 {formatUnitPrice(item.cacheWriteUnitPrice, item.currency)}</small>
                  <small>输出价-供应商 {formatUnitPrice(item.outputUnitPrice, item.currency)}</small>
                  <small>价格倍率 {item.requestKind === "reconciliation" && !reconUsageCarrier(item) ? "-" : formatDecimal(item.rateMultiplier, 4)}</small>
                  <strong><span className="token-amount-text" title="原币种口径：Σ 分项 Token × 供应商单价（计算过程见 ?）">供应商成本 {formatVendorMoney(item.vendorCost, true, item.currency)}</span> <CostHelp formula={costDetailFormula(item)} label="供应商成本计算过程" /></strong>
                  {/* 2026-09-29 用户确认：列表可见文案改为「按量倍率成本」；悬浮提示与 ? 浮框公式保持原「按量倍率后成本」表述。 */}
                  <strong><span className="token-amount-text" title="原币种口径：供应商成本 × 价格倍率（计算过程见 ?）">按量倍率成本 {formatDetailMoney(item.actualCost, item.currency)}</span> <CostHelp formula={multipliedCostDetailFormula(item)} label="按量倍率后成本计算过程" /></strong>
                  {item.billingChannel === "plan" || item.billingChannel === "subscription" ? (
                    <strong className="token-plan-real">
                      <span
                        className="token-amount-text"
                        title={item.planRealCost !== undefined
                          ? item.planEstimatedMethod === "quota_delta"
                            ? "套餐/订阅通道：额度差分估算（近似）——按同步快照的额度消耗差分折算周期价值，再按本请求市价份额分摊（入账时冻结）"
                            : "套餐/订阅通道：估算真实成本 = 套餐成本估算（积分换算/月费折算，入账时冻结）"
                          : "套餐/订阅通道：暂无逐请求计费公式或额度/月费快照未同步，估算暂不可用；开启套餐用量同步后将随额度消耗自动估算"}
                      >
                        估算真实成本（套餐成本估算{item.planEstimatedMethod === "quota_delta" ? " · 额度差分估算（近似）" : ""}） {formatDetailMoney(item.planRealCost, "CNY")}
                      </span> <CostHelp formula={planRealCostFormulaText(item, globalTz.iana)} label="估算真实成本（套餐成本估算）计算过程" />
                    </strong>
                  ) : (
                    <strong><span className="token-amount-text" title="人民币口径：原币种成本 × 价格倍率 × 入账时冻结的结算系数（计算过程见 ?）">估算真实成本 {formatDetailMoney(item.actualCostCny ?? item.actualCost, "CNY")}</span> <CostHelp formula={actualCostDetailFormula(item)} label="估算真实成本计算过程" /></strong>
                  )}
                </span>
                <span className="token-cell-stack st-r2">
                  <small>非缓存输入 {formatInteger(item.inputTokens)}</small>
                  <small>缓存读取 {formatInteger(item.cacheReadTokens)}</small>
                  <small>缓存写入 {formatInteger(item.cacheCreationTokens)}</small>
                  <small>输出 {formatInteger(item.outputTokens)}</small>
                </span>
                <span className="token-duration-cell st-r3">
                  <span className="token-duration-bar" aria-hidden="true">
                    <i className={`token-duration-seg ${durationSegmentClass(firstTokenToneClass(item.firstTokenMs))}`} />
                    <i className={`token-duration-seg ${durationSegmentClass(durationToneClass(item.durationSeconds))}`} />
                  </span>
                  <span className="token-cell-stack token-duration-stack">
                    <span title="转发开始到首个上游响应 chunk 的耗时（旧数据无采集，显示 -）">
                      首字 <span className={firstTokenToneClass(item.firstTokenMs)}>{formatFirstTokenMs(item.firstTokenMs)}</span>
                    </span>
                    <span title="请求总耗时">
                      耗时 <span className={durationToneClass(item.durationSeconds)}>{formatDurationText(item.durationSeconds)}</span>
                    </span>
                  </span>
                </span>
                <span className="token-time-cell st-r4" title={item.createdAt}>
                  <span>{formatLocalDateTimeParts(item.createdAt).date}</span>
                  <span>{formatLocalDateTimeParts(item.createdAt).time}</span>
                </span>
              </div>
            ))}
        </div>
      </div>

      <div className="token-pagination">
        <label>
          <span>每页</span>
          <select value={filters.limit} onChange={event => updateFilter("limit", Number(event.currentTarget.value))}>
            {PAGE_SIZE_OPTIONS.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" className="secondary-button" disabled={loading || cursorHistory.length === 0} onClick={goToPreviousPage}>上一页</button>
        <span>{currentPage} / {totalPages}</span>
        <button type="button" className="secondary-button" disabled={loading || !state?.hasMore || !state.nextCursor} onClick={goToNextPage}>下一页</button>
      </div>
    </section>
  );
}

function SearchableSelectField({ label, value, options, onChange, disabled = false, disabledLabel }: {
  label: string;
  value: string;
  options: TokenPricingOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  disabledLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = options.find(option => option.value === value);
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(query));
  }, [options, search]);

  function choose(nextValue: string) {
    onChange(nextValue);
    setSearch("");
    setOpen(false);
  }

  return (
    <div
      className="token-filter-field token-search-field"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <span>{label}</span>
      <button
        type="button"
        className="token-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
      >
        <span title={disabled ? disabledLabel : selected?.label || value || "全部"}>
          {disabled ? disabledLabel : selected?.label || value || "全部"}
        </span>
      </button>
      {open && !disabled ? (
        <div className="token-select-menu" role="listbox" aria-label={label}>
          <input
            aria-label={`${label}搜索`}
            autoFocus
            placeholder="搜索"
            value={search}
            onChange={event => setSearch(event.currentTarget.value)}
          />
          <button type="button" role="option" aria-selected={!value} className={!value ? "active" : ""} onClick={() => choose("")}>全部</button>
          {filteredOptions.map(option => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "active" : ""}
              key={`${option.value}:${option.vendor || option.vendors?.join("|") || ""}`}
              onClick={() => choose(option.value)}
              title={option.label}
            >
              {option.label}
            </button>
          ))}
          {filteredOptions.length === 0 ? <small>无匹配项</small> : null}
        </div>
      ) : null}
    </div>
  );
}

function SummaryBox({ label, value, subLabel, accent = false }: { label: string; value: ReactNode; subLabel: ReactNode; accent?: boolean }) {
  return (
    <article className={`token-summary-box${accent ? " accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{subLabel}</small>
    </article>
  );
}

function TokenPricingBreakdownTable({
  breakdown,
  loading,
  limited,
  buildPendingHref,
}: {
  breakdown: TokenPricingBreakdown[];
  loading: boolean;
  limited: boolean;
  /** 待补徽标跳转构造器（2026-10-09 #5）：入参为行级 target×model 下钻。 */
  buildPendingHref: (row?: {targetId: string; model: string}) => string;
}) {
  const scheduleColumns = breakdown.some(item => item.scheduleLabel !== undefined) ? 1 : 0;
  const planCreditColumns = breakdown.some(item => item.planCreditUnit !== undefined) ? 1 : 0;
  /* 2026-09-29 用户确认：删除与「总消费」恒等的「实际总消费」列（按目标×模型分组时
     每组通道唯一，两列在纯按量/纯套餐组下必然重复），总消费组剩 倍率前 + 总消费 两列。 */
  const colSpan = 13 + scheduleColumns + planCreditColumns;
  return (
    <section className="token-breakdown-shell" aria-label="供应商和模型汇总">
      <header className="token-breakdown-header">
        <strong>供应商 × 模型汇总</strong>
      </header>
      {limited ? <div className="token-limit-banner token-breakdown-limit">汇总组合数量达到安全读取上限，当前表格为受限结果。</div> : null}
      <div className="token-breakdown-scroll">
        <table className="token-breakdown-table">
          {/* 列宽（2026-10-09 用户确认）：table-layout:fixed 下用 colgroup 显式分配——
              缓存写入（基本恒 0）与缓存命中率收窄，总消费列加宽保证 ￥xx.xxxx 单行不换行。 */}
          <colgroup>
            <col />
            <col />
            {scheduleColumns > 0 ? <col /> : null}
            <col />
            <col />
            <col />
            <col className="token-col-cache-write" />
            <col />
            <col />
            <col className="token-col-hit-rate" />
            <col />
            <col className="token-col-cost" />
            <col />
            <col />
            {planCreditColumns > 0 ? <col /> : null}
          </colgroup>
          <thead>
            <tr>
              <th rowSpan={2}>供应商</th>
              <th rowSpan={2}>模型</th>
              {scheduleColumns > 0 ? <th rowSpan={2}>高峰/闲时</th> : null}
              <th rowSpan={2}>总请求数</th>
              <th colSpan={6}>总 Token</th>
              <th colSpan={2}>总消费</th>
              <th rowSpan={2}>总消费 / 总 Token</th>
              <th rowSpan={2}>耗时（平均 / 中位）</th>
              {planCreditColumns > 0 ? <th rowSpan={2}>套餐积分</th> : null}
            </tr>
            <tr>
              <th>非缓存输入</th>
              <th>缓存读取</th>
              <th>缓存写入</th>
              <th>输出</th>
              <th>总 Token</th>
              <th>缓存命中率</th>
              <th>倍率前总消费</th>
              <th>总消费</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colSpan} className="token-breakdown-empty">加载中...</td></tr>
            ) : breakdown.length === 0 ? (
              <tr><td colSpan={colSpan} className="token-breakdown-empty">当前筛选范围暂无可聚合账本</td></tr>
            ) : (
              <>
              {breakdown.map(item => (
              <tr key={`${item.targetId}:${item.model}:${item.scheduleLabel ?? ""}`}>
                <td className="token-breakdown-id" title={item.targetId}>{item.targetId}</td>
                <td className="token-breakdown-id" title={item.model}>{item.model}</td>
                {scheduleColumns > 0 ? (
                  <td className="token-breakdown-number">{item.scheduleLabel ?? "-"}</td>
                ) : null}
                <td className="token-breakdown-number">{formatInteger(item.requestCount)}</td>
                <td className="token-breakdown-number">{formatTokenAmount(item.inputTokens)}</td>
                <td className="token-breakdown-number">{formatTokenAmount(item.cacheReadTokens)}</td>
                <td className="token-breakdown-number">{formatTokenAmount(item.cacheCreationTokens)}</td>
                <td className="token-breakdown-number">{formatTokenAmount(item.outputTokens)}</td>
                <td className="token-breakdown-number">{formatTokenAmount(item.totalTokens)}</td>
                <td className="token-breakdown-number token-breakdown-metric">{formatPercentage(item.cacheHitRate)}</td>
                <td className="token-breakdown-number">{formatVendorMoney(item.vendorCost, false, "CNY")}</td>
                <td className="token-breakdown-number">
                  {item.planRequestCount > 0 ? (
                    <span title="总消费（套餐/订阅）= 套餐成本估算 = 套餐月费 ×（消耗积分 ÷ 窗口总额度）×（窗口天数 ÷ 30），入账时冻结（人民币）">
                      {formatSummaryMoney(item.planRealCost, "CNY")}
                      {item.planEstimatedPendingCount ? (
                        <a
                          className="token-cost-pending"
                          title={`${PLAN_ESTIMATE_PENDING_HINT}（点击筛选查看该组待补请求）`}
                          href={buildPendingHref({targetId: item.targetId, model: item.model})}
                        >{item.planEstimatedPendingCount} 条估算待补</a>
                      ) : null}
                    </span>
                  ) : (
                    <span title="总消费（按量）= 倍率后实付（人民币口径，入账时冻结结算系数）">{formatSummaryMoney(item.actualCost, "CNY")}</span>
                  )}
                </td>
                <td className="token-breakdown-unit-cost token-breakdown-metric">
                  {formatPerMillionTokens(item.planRequestCount > 0 ? item.realCostPerMillionTokens : item.actualCostPerMillionTokens)}
                </td>
                <td className="token-breakdown-number token-breakdown-metric">
                  {item.averageDurationSeconds === undefined ? "-" : `${formatDecimal(item.averageDurationSeconds, 2)}s`}
                  {" / "}
                  {item.medianDurationSeconds === undefined ? "-" : `${formatDecimal(item.medianDurationSeconds, 2)}s`}
                </td>
                {planCreditColumns > 0 ? (
                  <td className="token-breakdown-number">
                    {item.planCreditCost === undefined ? "-" : `${formatDecimal(item.planCreditCost, 4)} ${item.planCreditUnit ?? ""}`}
                  </td>
                ) : null}
              </tr>
            ))}
              <BreakdownTotalRow breakdown={breakdown} scheduleColumns={scheduleColumns} planCreditColumns={planCreditColumns} buildPendingHref={buildPendingHref} />
              </>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 供应商×模型汇总的合计行：金额/Token 各列相加，命中率与单 Token 成本按汇总重算，耗时取各组平均。 */
function BreakdownTotalRow({breakdown, scheduleColumns, planCreditColumns, buildPendingHref}: {
  breakdown: TokenPricingBreakdown[];
  scheduleColumns: number;
  planCreditColumns: number;
  buildPendingHref: (row?: {targetId: string; model: string}) => string;
}) {
  const sum = (pick: (item: TokenPricingBreakdown) => number) => breakdown.reduce((total, item) => total + pick(item), 0);
  const totalInput = sum(item => item.inputTokens);
  const totalCacheRead = sum(item => item.cacheReadTokens);
  const totalCacheWrite = sum(item => item.cacheCreationTokens);
  const totalOutput = sum(item => item.outputTokens);
  const totalTokens = sum(item => item.totalTokens);
  /* 已解析消费合计（2026-09-29 与表体「总消费」同口径）：按量组 = 倍率后实付；
     套餐/订阅组 = 套餐成本估算（入账冻结），不再用市价冒充消费。 */
  const totalConsumption = sum(item => item.planRequestCount > 0 ? (item.planRealCost ?? 0) : item.actualCost);
  const anyPartialEstimate = breakdown.some(item => item.planRequestCount > 0 && item.planRealCostUnavailable);
  const totalPendingEstimate = breakdown.reduce((total, item) => total + (item.planEstimatedPendingCount ?? 0), 0);
  const totalVendor = sum(item => item.vendorCost);
  const totalRequests = sum(item => item.requestCount);
  const hitRate = totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : 0;
  const sampled = breakdown.filter(item => item.durationSampleCount > 0);
  const averageDuration = sampled.length > 0
    ? sampled.reduce((total, item) => total + (item.averageDurationSeconds ?? 0), 0) / sampled.length
    : undefined;
  const medianDuration = sampled.length > 0
    ? sampled.reduce((total, item) => total + (item.medianDurationSeconds ?? 0), 0) / sampled.length
    : undefined;
  const perMillion = totalTokens > 0 ? totalConsumption / totalTokens * 1_000_000 : undefined;
  const totalPlanCredit = sum(item => item.planCreditCost ?? 0);
  return (
    <tr className="token-breakdown-total">
      <td className="token-breakdown-id">汇总</td>
      <td className="token-breakdown-id">汇总</td>
      {scheduleColumns > 0 ? <td className="token-breakdown-number">-</td> : null}
      <td className="token-breakdown-number">{formatInteger(totalRequests)}</td>
      <td className="token-breakdown-number">{formatTokenAmount(totalInput)}</td>
      <td className="token-breakdown-number">{formatTokenAmount(totalCacheRead)}</td>
      <td className="token-breakdown-number">{formatTokenAmount(totalCacheWrite)}</td>
      <td className="token-breakdown-number">{formatTokenAmount(totalOutput)}</td>
      <td className="token-breakdown-number">{formatTokenAmount(totalTokens)}</td>
      <td className="token-breakdown-number token-breakdown-metric">{formatPercentage(hitRate)}</td>
      <td className="token-breakdown-number">{formatVendorMoney(totalVendor, false, "CNY")}</td>
      <td className="token-breakdown-number">
        {formatSummaryMoney(totalConsumption, "CNY")}
        {anyPartialEstimate ? (
          <a
            className="token-cost-pending"
            title={`${PLAN_ESTIMATE_PENDING_HINT}（点击筛选查看待补请求）`}
            href={buildPendingHref()}
          >{totalPendingEstimate} 条估算待补</a>
        ) : null}
      </td>
      <td className="token-breakdown-unit-cost token-breakdown-metric">{formatPerMillionTokens(perMillion)}</td>
      <td className="token-breakdown-number token-breakdown-metric">
        {averageDuration === undefined ? "-" : `${formatDecimal(averageDuration, 2)}s`}
        {" / "}
        {medianDuration === undefined ? "-" : `${formatDecimal(medianDuration, 2)}s`}
      </td>
      {planCreditColumns > 0 ? (
        <td className="token-breakdown-number">
          {totalPlanCredit > 0 ? `${formatDecimal(totalPlanCredit, 4)} ${breakdown.find(item => item.planCreditUnit)?.planCreditUnit ?? ""}` : "-"}
        </td>
      ) : null}
    </tr>
  );
}

/** 成本 ？浮窗已抽取为共享组件（2026-09-23）：会话追踪「价格成本/估算真实成本」
 *  字段与本页明细行共用同一实现与视觉，见 src/components/cost-help.tsx。 */

const CHANNEL_FILTER_VALUES = new Set(["pay_as_you_go", "plan", "subscription"]);
const TOKEN_COMPONENT_FILTER_VALUES = new Set(["input", "output", "cache"]);

function normalizeChannelFilter(value: string | null): string {
  if (!value) return "";
  const valid = value.split(",").map(item => item.trim().toLowerCase()).filter(item => CHANNEL_FILTER_VALUES.has(item));
  return [...new Set(valid)].join(",");
}

/** 结果多选 token 与默认口径（成功+已取消+补差 = 站点已计费口径）。 */
const RESULT_TOKEN_OPTIONS = [
  {token: "success", label: "成功"},
  {token: "failure", label: "失败"},
  {token: "cancelled", label: "已取消"},
  {token: "incomplete", label: "不完整"},
  {token: "reconciled", label: "补差"},
] as const;
const RESULT_TOKEN_VALUES = new Set<string>(RESULT_TOKEN_OPTIONS.map(option => option.token));
const DEFAULT_RESULT_FILTER = "success,cancelled,reconciled";

/** 缺省/非法收敛为默认口径；"all" 为显式全选 token，不加结果过滤。 */
function normalizeResultFilter(value: string | null): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed) return DEFAULT_RESULT_FILTER;
  if (trimmed === "all") return "all";
  const tokens = [...new Set(trimmed.split(",").map(token => token.trim()).filter(token => RESULT_TOKEN_VALUES.has(token)))];
  return tokens.length > 0 ? tokens.join(",") : DEFAULT_RESULT_FILTER;
}

/** Token 构成多选归一化：逗号 token 去重保序；空值表示不过滤。 */
function normalizeTokenComponentFilter(value: string | null): string {
  if (!value) return "";
  const tokens = [...new Set(value
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(item => TOKEN_COMPONENT_FILTER_VALUES.has(item)))];
  return tokens.join(",");
}

function defaultFilters(tzValue: string = DEFAULT_TIME_ZONE): TokenPricingFilters {
  const now = new Date();
  // 默认时间范围起点为「当前全局时区的今天 00:00」（2026-09-17 修复：此前硬编码东八区，
  // 全局时区≠东八区时默认起点会被按新时区错误解释，窗口错位 8 小时）。
  const tzOffset = timeZoneOffsetMinutes(tzValue);
  const startUtc = new Date(Math.floor((now.getTime() + tzOffset * 60_000) / 86_400_000) * 86_400_000 - tzOffset * 60_000);
  return {
    target: "",
    agent: "",
    session: "",
    thread: "",
    turn: "",
    step: "",
    model: "",
    vendor: "",
    schedule: "",
    start: toDatetimeLocalValue(startUtc, tzOffset),
    end: "",
    tz: tzValue,
    includeAuxiliary: "no",
    pending: "",
    channel: "",
    result: DEFAULT_RESULT_FILTER,
    tokenComponent: "",
    limit: DEFAULT_PAGE_SIZE,
    offset: 0,
    cursor: "",
  };
}

/** 通用筛选多选下拉：空值=不过滤（展示 emptyLabel）；提供全选/全不选快捷操作。 */
function FilterMultiSelect({label, options, value, onChange, emptyLabel}: {
  label: string;
  options: ReadonlyArray<{token: string; label: string}>;
  value: string;
  onChange: (next: string) => void;
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);
  const selected = new Set(value ? value.split(",") : []);
  const triggerLabel = selected.size === 0
    ? emptyLabel
    : options.filter(option => selected.has(option.token)).map(option => option.label).join("+") || emptyLabel;
  const commit = (next: Set<string>) => {
    const ordered = options.map(option => option.token).filter(token => next.has(token));
    onChange(ordered.join(","));
  };
  const toggle = (token: string) => {
    const next = new Set(selected);
    if (next.has(token)) next.delete(token);
    else next.add(token);
    commit(next);
  };
  return (
    <div className="token-filter-field token-result-select-field" ref={rootRef}>
      <span id={id}>{label}</span>
      <button
        type="button"
        className={`token-select-trigger${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={id}
        onClick={() => setOpen(current => !current)}
      >
        <span>{triggerLabel}</span>
      </button>
      {open ? (
        <div className="token-result-select-panel" role="listbox" aria-label={`${label}多选`}>
          <div className="token-result-quick-row" role="group" aria-label={`${label}快捷操作`}>
            <button type="button" onClick={() => commit(new Set(options.map(option => option.token)))}>全选</button>
            <button type="button" onClick={() => commit(new Set())}>全不选</button>
          </div>
          {options.map(option => {
            const active = selected.has(option.token);
            return (
              <label key={option.token} className="token-result-option">
                <input type="checkbox" checked={active} onChange={() => toggle(option.token)} />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const CHANNEL_OPTIONS = [
  {token: "pay_as_you_go", label: "按量"},
  {token: "plan", label: "套餐"},
  {token: "subscription", label: "订阅"},
] as const;

const TOKEN_COMPONENT_OPTIONS = [
  {token: "input", label: "非缓存输入"},
  {token: "output", label: "输出"},
  {token: "cache", label: "缓存"},
] as const;

/** 计费通道列展示：旧行无通道时按按量口径展示。 */
function billingChannelLabel(channel: string | undefined): string {
  if (channel === "plan") return "套餐";
  if (channel === "subscription") return "订阅";
  return "按量";
}

/** Token 构成列展示：按各构成是否有用量拼装（非缓存输入/缓存/输出）。 */
function tokenComponentSummary(item: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  hasUsage: boolean;
}): string {
  if (!item.hasUsage) return "-";
  const parts: string[] = [];
  if (item.inputTokens > 0) parts.push("输入");
  if (item.cacheReadTokens > 0 || item.cacheCreationTokens > 0) parts.push("缓存");
  if (item.outputTokens > 0) parts.push("输出");
  return parts.length > 0 ? parts.join("/") : "-";
}

function filtersFromSearchParams(searchParams: URLSearchParams, globalTzValue: string): TokenPricingFilters {
  const defaults = defaultFilters(globalTzValue);
  const hasBusinessContext = Boolean(
    searchParams.get("session") || searchParams.get("thread")
      || searchParams.get("turn") || searchParams.get("step"),
  );
  // 时区一律取全局偏好（调用方传入；URL 不携带 tz 参数，旧链接里的 tz 直接忽略）。
  const tz = TIME_ZONE_OPTIONS.some(option => option.value === globalTzValue) ? globalTzValue : DEFAULT_TIME_ZONE;
  const tzOffset = timeZoneOffsetMinutes(tz);
  return {
    target: searchParams.get("target") || "",
    agent: searchParams.get("agent") || "",
    session: searchParams.get("session") || "",
    thread: searchParams.get("thread") || "",
    turn: searchParams.get("turn") || "",
    step: searchParams.get("step") || "",
    model: searchParams.get("model") || "",
    vendor: searchParams.get("vendor") || "",
    schedule: searchParams.get("schedule") || "",
    start: isoToDatetimeLocalValue(searchParams.get("start"), tzOffset) || (hasBusinessContext ? "" : defaults.start),
    end: isoToDatetimeLocalValue(searchParams.get("end"), tzOffset),
    tz,
    includeAuxiliary: searchParams.get("includeAuxiliary") === "yes" ? "yes" : "no",
    pending: searchParams.get("pending") === "1" ? "1" : "",
    channel: normalizeChannelFilter(searchParams.get("channel")),
    result: normalizeResultFilter(searchParams.get("result")),
    tokenComponent: normalizeTokenComponentFilter(searchParams.get("tokenComponent")),
    limit: normalizePageSize(searchParams.get("limit")),
    offset: clampInteger(Number(searchParams.get("offset") || 0), 0, Number.MAX_SAFE_INTEGER),
    cursor: searchParams.get("cursor") || "",
  };
}

function filtersEqual(left: TokenPricingFilters, right: TokenPricingFilters): boolean {
  return (Object.keys(left) as Array<keyof TokenPricingFilters>).every(key => left[key] === right[key]);
}

function queryFromFilters(filters: TokenPricingFilters): string {
  const params = new URLSearchParams();
  for (const key of ["target", "agent", "session", "thread", "turn", "step", "model", "vendor", "schedule"] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const tzOffset = timeZoneOffsetMinutes(filters.tz);
  if (filters.start) params.set("start", datetimeLocalValueToIso(filters.start, tzOffset));
  if (filters.end) params.set("end", datetimeLocalValueToIso(filters.end, tzOffset));
  // tz 不写入查询串（2026-09-17 全站时区统一）：时间边界已在客户端换算为绝对 UTC，
  // 服务端查询与时区无关；时区仅存于右上角全局偏好。
  if (filters.includeAuxiliary === "yes") params.set("includeAuxiliary", "yes");
  if (filters.pending === "1") params.set("pending", "1");
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.result && filters.result !== DEFAULT_RESULT_FILTER) params.set("result", filters.result);
  if (filters.tokenComponent) params.set("tokenComponent", filters.tokenComponent);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  if (filters.cursor) params.set("cursor", filters.cursor);
  return params.toString();
}

function normalizePageSize(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_PAGE_SIZE;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_PAGE_SIZE;
  for (const allowed of PAGE_SIZE_OPTIONS) {
    if (numericValue <= allowed) return allowed;
  }
  return 100;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function uniqueOptions(options: TokenPricingOption[]): TokenPricingOption[] {
  const byValue = new Map<string, TokenPricingOption>();
  for (const option of options) {
    if (!option.value) continue;
    const existing = byValue.get(option.value);
    if (existing) {
      const vendors = new Set([...(existing.vendors || []), existing.vendor, ...(option.vendors || []), option.vendor].filter((vendor): vendor is string => !!vendor));
      existing.vendors = [...vendors].sort();
      existing.vendor = existing.vendor || option.vendor;
      if (!existing.label.includes(" · ") && option.vendor) existing.label = `${existing.value} · ${option.vendor}`;
      continue;
    }
    byValue.set(option.value, { ...option, vendors: option.vendors || (option.vendor ? [option.vendor] : undefined) });
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function filterModelsByVendor(options: TokenPricingOption[], vendor: string, selectedModel: string): TokenPricingOption[] {
  if (!vendor) return options;
  return options.filter(option => option.value === selectedModel || optionVendors(option).includes(vendor));
}

function filterVendorsByModel(
  vendors: TokenPricingOption[],
  models: TokenPricingOption[],
  model: string,
  selectedVendor: string,
): TokenPricingOption[] {
  if (!model) return vendors;
  const allowed = new Set(models.filter(option => option.value === model).flatMap(optionVendors));
  if (allowed.size === 0) return vendors;
  return vendors.filter(option => option.value === selectedVendor || allowed.has(option.value));
}

function modelMatchesVendor(models: TokenPricingOption[], model: string, vendor: string): boolean {
  const matches = models.filter(option => option.value === model);
  if (matches.length === 0) return true;
  const vendors = matches.flatMap(optionVendors);
  return vendors.length === 0 || vendors.includes(vendor);
}

function optionVendors(option: TokenPricingOption): string[] {
  return [...new Set([...(option.vendors || []), option.vendor].filter((vendor): vendor is string => !!vendor))];
}

function totalTokens(state: TokenPricingState | undefined): number {
  if (!state) return 0;
  return state.summary.inputTokens + state.summary.cacheReadTokens + state.summary.cacheCreationTokens + state.summary.outputTokens;
}

/** 请求结果分类的中文标签；未分类显示 -。 */
function resultClassLabel(resultClass: string): string {
  const labels: Record<string, string> = {
    success: "成功",
    failure: "失败",
    cancelled: "已取消",
    incomplete: "不完整",
    reconciled: "补差",
  };
  return labels[resultClass] || resultClass;
}

/** 请求结果展示色调：成功绿 / 失败红 / 已取消灰 / 不完整橙 / 补差蓝。 */
function resultToneClass(resultClass: string): string {
  const tones: Record<string, string> = {
    success: "tone-success",
    failure: "tone-failure",
    cancelled: "tone-cancelled",
    incomplete: "tone-incomplete",
    reconciled: "tone-reconciled",
  };
  return tones[resultClass] || "muted";
}

/** 首字耗时色调：≤5s 绿色，>5s 橙色；无数据显示中性。 */
function firstTokenToneClass(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  return ms <= 5_000 ? "metric-good" : "metric-slow";
}

/** 请求耗时色调：≤15s 绿色，>15s 橙色；无数据显示中性。 */
function durationToneClass(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "";
  return seconds <= 15 ? "metric-good" : "metric-slow";
}

/** 耗时竖条分段底色：与文字色调同规律（绿/橙，无数据中性灰）。 */
function durationSegmentClass(textTone: string): string {
  if (textTone === "metric-good") return "seg-good";
  if (textTone === "metric-slow") return "seg-slow";
  return "seg-neutral";
}

/** 请求总耗时展示：≥60s 显示分秒（如 2m 13s），否则显示秒。 */
function formatDurationText(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "-";
  if (seconds < 60) return `${formatDecimal(seconds, 2)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rest}s`;
}

/** 请求时间两行展示：日期一行、时刻一行（沿用 formatLocalDateTime 的时区口径）。 */
function formatLocalDateTimeParts(value: string | undefined): {date: string; time: string} {
  const formatted = value ? formatLocalDateTime(value) : "-";
  const separator = formatted.lastIndexOf(" ");
  if (separator <= 0) return {date: formatted, time: ""};
  return {date: formatted.slice(0, separator), time: formatted.slice(separator + 1)};
}

/** 辅助请求判定：model 为主模型调用、reconciliation 为补差行，其余均为辅助。 */
function isAuxiliaryRequest(requestKind: string | undefined): boolean {
  return Boolean(requestKind && requestKind !== "model" && requestKind !== "reconciliation");
}

/**
 * 用量载体补差行（2026-09-29 用户确认）：原行无可信用量（如 502 失败估算行）、
 * 站点真值 token 已回填到本补差行，作为该请求的真实记录参与请求/Token 统计。
 * 纯金额更正行 token 恒为 0，保持「只计金额」语义。
 */
function reconUsageCarrier(item: TokenPricingItem): boolean {
  return item.requestKind === "reconciliation"
    && (item.inputTokens + item.cacheReadTokens
      + item.cacheCreationTokens + item.outputTokens) > 0;
}

/** 对账归属置信度说明：exact=站点请求 ID；high=四类真实 Token 全等；weak=模型+端点+时间唯一。 */
function reconConfidenceLabel(confidence: "exact" | "high" | "weak"): string {
  return {
    exact: "站点请求 ID 精确匹配",
    high: "四类真实 Token 完全一致",
    weak: "模型+端点+完成时间唯一归属（错误/不完整请求）",
  }[confidence];
}

/**
 * 折扣归因文案：只认站点明细明示的折扣声明（site_discount_nano）且该声明
 * 全额解释了差额（discountExplainsDelta，服务端判定）才生成；
 * 纯比率巧合、无声明字段的站点一律返回 undefined，按普通补差展示。
 */
function reconDiscountNote(recon: NonNullable<TokenPricingItem["recon"]>): string | undefined {
  return recon.discountExplainsDelta && recon.siteDiscountNano !== undefined
    ? `；其中 $${(recon.siteDiscountNano / 1e9).toFixed(6)} 为站点明示折扣优惠（本单按该优惠冲减）`
    : undefined;
}

/** 补差行「原始记录」新标签深链：跳到原始请求在 Token 价格页的明细（六元组上下文）。
 * 携带 result=all（2026-09-29 用户确认）：step 已精确定位补差行与原始行，而原始行多为
 * 失败类，若回落默认口径「成功+已取消+补差」会被结果筛选滤掉，导致只见补差不见原行。
 * 页内深链允许携带页面私有参数（与仪表盘 KPI 卡 result=all 同例，不受公共导航闸门约束）。 */
function reconLinkedHref(recon: NonNullable<TokenPricingItem["recon"]>): string | undefined {
  if (!recon.linkedSelection) return undefined;
  const href = topLevelHref("/token-pricing", recon.linkedSelection);
  return `${href}${href.includes("?") ? "&" : "?"}result=all`;
}

/**
 * 是否需要渲染「受限提示条」容器。
 *
 * 注意：`limited.facets`（下拉候选被 100 条安全上限截断）刻意不计入 ——
 * 它不影响本次查询结果的完整性（已选项仍会通过精确查询保留在候选里），
 * 渲染出来只会制造「结果被截断了」的误解（2026-09-18 用户确认下线该文案）。
 * 该字段仍保留在 API 响应里作为可观测信息。
 */
function hasLimitWarning(state: TokenPricingState): boolean {
  return state.limited.sortWindow
    || state.limited.ledgerScan
    || state.limited.durationHydration;
}

/** 缓存命中率仅取百分比（如 96.3%），供汇总卡强调展示。 */
function formatCacheHitRateValue(inputTokens: number, cacheReadTokens: number): string {
  const base = inputTokens + cacheReadTokens;
  if (base <= 0) return "0.0%";
  return `${(cacheReadTokens / base * 100).toFixed(1)}%`;
}

/** 首字时间展示：<1s 显示毫秒，≥1s 显示秒；无采集数据显示 -。 */
function formatFirstTokenMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "-";
  return value < 1000 ? `${formatDecimal(value, 0)}ms` : `${formatDecimal(value / 1000, 2)}s`;
}

function formatPercentage(value: number): string {
  return `${(Number.isFinite(value) ? value * 100 : 0).toFixed(1)}%`;
}

/** 每 1M Token 成本（人民币口径，源自 CNY 汇总列折算）。 */
function formatPerMillionTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const formatted = Number(value.toFixed(6)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
  return `￥${formatted} / 1M Token`;
}
