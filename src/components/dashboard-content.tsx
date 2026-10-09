"use client";

import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {useRouter} from "next/navigation";
import {ChevronDown, ChevronUp, CircleDollarSign, Coins, Send, Ticket} from "lucide-react";
import type {DashboardQueryResult} from "@/lib/db/analytics-queries";
import {AGENT_REGISTRY, agentLabel} from "@/lib/agent-registry";
import {DEFAULT_TIME_ZONE, timeZoneIana, timeZoneOffsetMinutes} from "@/lib/timezones";
import {useGlobalTimeZone} from "@/lib/timezone-preference";
import {Donut, LineChart, Sparkline, StackedBarChart, XLabels, type ChartSeries} from "./dashboard/charts";
import {formatTokenAxis} from "./dashboard/chart-scale";
import {HourPicker} from "./dashboard/hour-picker";
import {
  DASHBOARD_MODULE_LABELS,
  DEFAULT_DASHBOARD_MODULE_ORDER,
  moveDashboardModule,
  readDashboardModuleOrder,
  writeDashboardModuleOrder,
  type DashboardModuleId,
} from "@/lib/dashboard-module-order";
import {
  fmtCredit,
  fmtDuration,
  fmtInt,
  fmtMoney,
  fmtMoneyRaw,
  fmtPercent,
  fmtTokens,
  pad,
  shortDayKey,
  weekdayLabel,
} from "./dashboard/format";
import styles from "./dashboard.module.css";

type MetricKey = "token" | "requests" | "cost";

/* ==================== v4.2 青绿色商务系图表配色（与 globals.css 令牌同源） ==================== */
/* 品牌主色：松绿 pine-700 #007B74；金色只承担套餐/市价语义。SVG 属性用字面值保持兼容。 */
const COLOR_MAIN = "#007b74";
const COLOR_MARKET = "#b8a56f";
const COLOR_RED = "#944137";
/* Token 构成语义配色：输入松绿、输出灰紫（violet）、缓存岩蓝（info，体量最大价值最低，弱化视觉权重） */
const COLOR_INPUT = "#007b74";
const COLOR_OUTPUT = "#6e56cf";
const COLOR_CACHE = "#4d7185";
/* 图表类目序列：绿系为主，金/岩蓝/灰紫点缀（v4.2 序列 + 扩展至 8 色） */
const CATEGORY_PALETTE = ["#007b74", "#4d7185", "#b8a56f", "#2b998f", "#6e56cf", "#21815b", "#8fc3ba", "#c66ca8"];
/* 模型多序列趋势沿用类目序列 */
const MODEL_PALETTE = CATEGORY_PALETTE;
/* 三列分析色彩身份：模型 = 松绿深度阶，供应商 = 岩蓝深度阶，Agent = 品牌识别色 */
const MODEL_RAMP = ["#007b74", "#2b998f", "#64b6ad", "#8fc3bf", "#b3dcd6"];
const VENDOR_RAMP = ["#4d7185", "#68808a", "#8da8b8", "#b5c6ce"];
const AGENT_BRAND_COLORS: Record<string, string> = {
  codex: "#007b74",
  claude: "#b56a3c",
  claude_code: "#b56a3c",
  opencode: "#46678c",
  dsh: "#8f7b49",
  zcode: "#4d7185",
};
const AGENT_COLOR_FALLBACK = "#788984";

function agentBrandColor(agent: string): string {
  return AGENT_BRAND_COLORS[agent] ?? AGENT_COLOR_FALLBACK;
}

/* 三列分析指标：Token / 消费 / 请求（区块右上角共用选择） */
type AnalysisMetricKey = "token" | "cost" | "requests";
/* 成本排行榜维度：模型 × 供应商（默认）/ 模型 / 供应商 */
type LeaderboardDimKey = "modelVendor" | "model" | "vendor";
/* KPI 卡维度：总（默认）/ 量（按量）/ 套（套餐/订阅），三卡各自独立切换 */
type KpiDimKey = "total" | "payg" | "plan";
const KPI_DIM_OPTIONS: Array<{key: KpiDimKey; label: string}> = [
  {key: "total", label: "总"},
  {key: "payg", label: "量"},
  {key: "plan", label: "套"},
];
function kpiDimSuffix(dim: KpiDimKey): string {
  if (dim === "payg") return " · 量";
  if (dim === "plan") return " · 套";
  return "";
}

function analysisMetricValue(row: {totalTokens: number; costNano: number; requestCount: number}, metricKey: AnalysisMetricKey): number {
  if (metricKey === "cost") return row.costNano;
  if (metricKey === "requests") return row.requestCount;
  return row.totalTokens;
}

function analysisMetricFmt(value: number, metricKey: AnalysisMetricKey): string {
  if (metricKey === "cost") return fmtMoney(value);
  if (metricKey === "requests") return fmtInt(value);
  return fmtTokens(value);
}

interface AnalysisRow {
  name: string;
  color: string;
  href: string;
  legacy?: boolean;
  totalTokens: number;
  costNano: number;
  requestCount: number;
  /** 待补估算请求数（2026-10-09 徽标收敛）：小字「N 条估算待补」的数据源。 */
  costPendingCount?: number;
}

/** 待补估算徽标共用悬浮说明（2026-10-09 徽标收敛，与 Token 价格页同口径）。 */
const PLAN_ESTIMATE_PENDING_HINT
  = "套餐/订阅请求按额度差分估算（近似），以下行暂无估算金额（均会自动收敛）：①最近一次额度刻度跳动之后的新请求——下一个刻度自动补算；②早于最早额度快照的历史请求——已结算证据充分（≥5 行且市价 ≥￥1）后按比率兜底自动补算；③计费窗口重置的整数刻度零头——按 0.5% 中点自动补算。已估算金额为入账时冻结值，不受后续补算影响。";

const PRESETS: Array<{key: string; label: string}> = [
  {key: "today", label: "今天"},
  {key: "yesterday", label: "昨天"},
  {key: "24h", label: "近 24 小时"},
  {key: "7d", label: "近 7 天"},
  {key: "30d", label: "近 30 天"},
];

/* 按所选时区把 UTC 小时桶 ISO 转成本地日期/小时文本；天粒度 key 已是本地日键。 */
const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();
function zonedHourParts(iso: string, timeZone: string): {date: string; hour: string; minute: string} {
  let formatter = zonedFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false});
    zonedFormatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return {
    date: `${get("month")}-${get("day")}`,
    hour: get("hour") === "24" ? "00" : get("hour"),
    minute: get("minute"),
  };
}

/** 按全局时区偏移取「第 dayShift 天的 00:00」绝对时刻（2026-09-17 全站时区统一）。 */
function zonedStartOfDay(nowMs: number, offsetMinutes: number, dayShift = 0): Date {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + dayShift) - offsetMinutes * 60_000);
}

/** 绝对时刻 → 该时区墙钟的小时级输入串（YYYY-MM-DDTHH:00）。 */
function zonedHourInputValue(date: Date, offsetMinutes: number): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:00`;
}

/** 默认范围 = 全局时区的「今天 00:00 → 明天 00:00」。 */
function defaultRange(offsetMinutes: number): {start: string; end: string} {
  const now = Date.now();
  return {
    start: zonedHourInputValue(zonedStartOfDay(now, offsetMinutes), offsetMinutes),
    end: zonedHourInputValue(zonedStartOfDay(now, offsetMinutes, 1), offsetMinutes),
  };
}

function parseInitialRange(initialQuery: string): {start: string; end: string; tz: string} {
  const params = new URLSearchParams(initialQuery);
  const start = params.get("start");
  const end = params.get("end");
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;
  if (start && end && iso.test(start) && iso.test(end) && Date.parse(end) > Date.parse(start)) {
    // tz URL 参数已废弃（2026-09-17 全站时区统一受右上角偏好控制）：旧链接里的 tz 直接忽略。
    return {start, end, tz: DEFAULT_TIME_ZONE};
  }
  return {...defaultRange(timeZoneOffsetMinutes(DEFAULT_TIME_ZONE)), tz: DEFAULT_TIME_ZONE};
}

function presetRange(key: string, offsetMinutes: number): {start: string; end: string} | undefined {
  const now = Date.now();
  const todayStart = zonedStartOfDay(now, offsetMinutes);
  const tomorrow = zonedHourInputValue(zonedStartOfDay(now, offsetMinutes, 1), offsetMinutes);
  if (key === "today") return {start: zonedHourInputValue(todayStart, offsetMinutes), end: tomorrow};
  if (key === "yesterday") {
    return {
      start: zonedHourInputValue(zonedStartOfDay(now, offsetMinutes, -1), offsetMinutes),
      end: zonedHourInputValue(todayStart, offsetMinutes),
    };
  }
  if (key === "24h") {
    const end = new Date(Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000);
    return {start: zonedHourInputValue(new Date(end.getTime() - 24 * 3_600_000), offsetMinutes), end: zonedHourInputValue(end, offsetMinutes)};
  }
  if (key === "7d") return {start: zonedHourInputValue(zonedStartOfDay(now, offsetMinutes, -6), offsetMinutes), end: tomorrow};
  if (key === "30d") return {start: zonedHourInputValue(zonedStartOfDay(now, offsetMinutes, -29), offsetMinutes), end: tomorrow};
  return undefined;
}

/** 桶键 -> 展示标签：小时桶 "HH"，日桶 "MM-DD"。 */
function bucketAxisLabel(key: string, granularity: "hour" | "day", timeZone: string, previousKey?: string): string {
  if (granularity === "day") return shortDayKey(key);
  const current = zonedHourParts(key, timeZoneIana(timeZone));
  const previousDate = previousKey ? zonedHourParts(previousKey, timeZoneIana(timeZone)).date : current.date;
  return current.date !== previousDate ? `${current.date}\n${current.hour || "00"}` : current.hour || key;
}

function bucketTooltipTitle(key: string, granularity: "hour" | "day", timeZone: string): string {
  if (granularity === "day") return key.slice(5, 10);
  const parts = zonedHourParts(key, timeZoneIana(timeZone));
  return `${parts.date} ${parts.hour || "00"}:00`;
}

/** Agent 分析固定展示顺序：注册表顺序（Codex → Claude Code → OpenCode → DeepSeek Harness → ZCode）。 */
const AGENT_DISPLAY_ORDER = new Map<string, number>(
  AGENT_REGISTRY.map((adapter, index) => [adapter.id, index]),
);

/** 未在注册表中的 agent（如 unknown）兜底排到最后，彼此之间按 Token 降序保持稳定。 */
function sortAgentsByDisplayOrder(agents: DashboardQueryResult["agents"]): DashboardQueryResult["agents"] {
  return [...agents].sort((left, right) => {
    const leftOrder = AGENT_DISPLAY_ORDER.get(left.agent) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = AGENT_DISPLAY_ORDER.get(right.agent) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return right.totalTokens - left.totalTokens;
  });
}

/** 仪表盘指标 → Token 价格明细承接页链接：时间范围为基底，可叠加维度过滤。 */
function tpHref(range: {start: string; end: string} | undefined, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (range) {
    params.set("start", range.start);
    params.set("end", range.end);
  }
  // 仪表盘汇总统计覆盖全部结果类别，默认承接「全部」；成功链接以空串显式清除（默认仅成功）。
  params.set("result", "all");
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) params.set(key, value);
    else if (key === "result") params.delete("result");
  }
  const query = params.toString();
  return query ? `/token-pricing?${query}` : "/token-pricing";
}

/** 热力格链接：本地日 + 本地小时 → 该小时 [start, end) 明细。 */
function heatmapCellHref(date: string, hour: number, timeZone: string): string {
  // 把选择时区的墙钟时间先按 UTC 解析，再减去该时区偏移，得到明细页需要的绝对 UTC 边界。
  const localWallClockMs = Date.parse(`${date}T${pad(hour)}:00:00.000Z`);
  const start = new Date(localWallClockMs - timeZoneOffsetMinutes(timeZone) * 60_000);
  if (Number.isNaN(start.getTime())) return "/token-pricing";
  return `/token-pricing?start=${start.toISOString()}&end=${new Date(start.getTime() + 3_600_000).toISOString()}&result=all`;
}

/* KPI 三卡的口径悬浮说明（2026-09-16 用户确认）：模型请求口径 + facts 物化延迟。 */
const KPI_SCOPE_TOOLTIP = "口径：模型请求（不含 unknown 模型的辅助/探测请求），与 Token 价格页默认口径一致；仪表盘为定期汇总，存在分钟级延迟，最新数据以 Token 价格页为准。";
/* 金额卡消费口径（2026-09-17 用户确认）：成功+已取消+补差，与 Token 价格页默认结果筛选一致。 */
const CONSUMPTION_RESULT_PARAM = "success,cancelled,reconciled";
const COST_SCOPE_TOOLTIP = "口径：成功+已取消+补差的消费（失败请求不计费），与 Token 价格页默认一致。";

function splitValue(formatted: string): {main: string; unit: string} {
  const match = formatted.match(/^([\d.,]+)(.*)$/u);
  if (!match) return {main: formatted, unit: ""};
  return {main: match[1], unit: match[2]};
}

interface LeaderboardRow {
  key: string;
  label: string;
  href: string;
  color: string;
  totalTokens: number;
  requestCount: number;
  realCostNano: number | null;
  costPerMillionNano: number | null;
  planEstimatedPending: boolean;
}

/**
 * 排序控制条的实际高度（px）：与 `dashboard.module.css` 的 `.reorderControls`
 * 保持同步 —— 边框 2 + 内边距 8 + 两个 56px 按钮 + 2px 间隔 = 124。
 * 用于把控制条夹紧在视口内并垂直居中到目标模块。
 */
const REORDER_CONTROL_HEIGHT = 124;

export function DashboardContent({initialQuery}: {initialQuery?: string}) {
  const router = useRouter();
  const initial = useMemo(() => parseInitialRange(initialQuery ?? ""), [initialQuery]);
  const [startInput, setStartInput] = useState(initial.start);
  const [endInput, setEndInput] = useState(initial.end);
  // 全站统一时区（右上角选择器）：查询边界一律按该偏好换算，URL 不再携带 tz 参数。
  const globalTz = useGlobalTimeZone();
  const [tz, setTz] = useState(initial.tz);
  /* 用户是否手动改过范围（预设/边界输入）：未改过时跟随全局时区重算默认「今天」。 */
  const rangeTouchedRef = useRef(false);
  useEffect(() => {
    if (globalTz.value === tz) return;
    setTz(globalTz.value);
    // SSR/首帧默认按东八区生成；挂载后拿到真实偏好且用户未自定义范围时，重算默认「今天」。
    if (!rangeTouchedRef.current) {
      const next = defaultRange(timeZoneOffsetMinutes(globalTz.value));
      setStartInput(next.start);
      setEndInput(next.end);
    }
  }, [globalTz.value, tz]);
  const [activePreset, setActivePreset] = useState<string>("today");
  const [metric, setMetric] = useState<MetricKey>("token");
  const [analysisMetric, setAnalysisMetric] = useState<AnalysisMetricKey>("token");
  const [lbDim, setLbDim] = useState<LeaderboardDimKey>("modelVendor");
  /* KPI 三卡各自的 总/量/套 维度切换，默认总维度。 */
  const [reqDim, setReqDim] = useState<KpiDimKey>("total");
  const [tokenDim, setTokenDim] = useState<KpiDimKey>("total");
  const [costDim, setCostDim] = useState<KpiDimKey>("total");
  /* Token 构成柱的视图模式：绝对量 / 占比归一化（缓存占绝对主导时仍能看清三色构成）。 */
  const [disabledModels, setDisabledModels] = useState<ReadonlySet<string>>(new Set());
  const [data, setData] = useState<DashboardQueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [reloadNonce, setReloadNonce] = useState(0);
  const firstFetch = useRef(true);

  // ── 模块排序（2026-09-18 用户确认）────────────────────────────────────────
  // 每个模块支持上移/下移，结果写入 localStorage；时间筛选条不参与排序，
  // 它同时是排序的最上边界：控制条被夹在它下方，绝不覆盖到时间选择器之上。
  const [moduleOrder, setModuleOrder] = useState<DashboardModuleId[]>([...DEFAULT_DASHBOARD_MODULE_ORDER]);
  const [reorderTarget, setReorderTarget] = useState<{id: DashboardModuleId; top: number; right: number} | null>(null);
  const moduleHostRefs = useRef(new Map<DashboardModuleId, HTMLElement>());
  const reorderHideTimerRef = useRef<number | undefined>(undefined);
  /** 指针是否停在排序控制条上：停在上面时不参与收起计时，避免控制条在光标下消失。 */
  const reorderControlHoveredRef = useRef(false);
  const filtersRef = useRef<HTMLElement | null>(null);
  const reorderVisible = reorderTarget !== null;

  useEffect(() => {
    // SSR/首帧按默认顺序渲染，挂载后再应用本地顺序，避免 hydration 不一致。
    setModuleOrder(readDashboardModuleOrder());
  }, []);

  useEffect(() => () => window.clearTimeout(reorderHideTimerRef.current), []);

  // 滚动/改窗口尺寸后固定定位的控制条会脱离模块，直接收起等待重新悬停。
  useEffect(() => {
    if (!reorderVisible) return;
    const hide = () => setReorderTarget(null);
    window.addEventListener("scroll", hide, {passive: true});
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
    };
  }, [reorderVisible]);

  /**
   * 把排序控制条锚定到目标模块（仅由模块本体的悬停触发；2026-09-18 用户确认
   * 撤掉了「右侧带状区也触发」的方案 —— 那样太扎眼）：
   * - 横向：落在模块右侧的正文留白里（即「该模块右侧、近浏览器右边缘」）；
   *   视口与正文等宽、留白不足时退回贴浏览器右边缘的浮层（悬停才出现，不挡阅读）。
   * - 纵向：对齐模块上部（长模块不会把控制条推到屏幕外），
   *   并夹紧在「时间筛选条底部之下、视口之内」——最上不超过时间选择器。
   */
  function anchorReorderControls(id: DashboardModuleId): void {
    const host = moduleHostRefs.current.get(id);
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const filterBottom = filtersRef.current?.getBoundingClientRect().bottom ?? 0;
    const minTop = filterBottom + 8;
    const maxTop = Math.max(minTop, window.innerHeight - REORDER_CONTROL_HEIGHT - 12);
    const anchorTop = rect.top + Math.min(rect.height / 2, 150) - REORDER_CONTROL_HEIGHT / 2;
    const container = filtersRef.current?.parentElement ?? null;
    const containerRight = container?.getBoundingClientRect().right ?? window.innerWidth;
    // 控制条宽约 36px：留白足够时贴容器外缘 8px，不足时贴浏览器右边缘。
    const gutter = window.innerWidth - containerRight;
    const right = gutter >= 44 ? gutter - 44 : 8;
    const top = Math.min(Math.max(anchorTop, minTop), maxTop);
    // 同一模块重复进入时不制造无意义的重渲染。
    setReorderTarget(current => (
      current && current.id === id && current.top === top && current.right === right
        ? current
        : {id, top, right}
    ));
  }

  /** 鼠标离开模块/控制条后延迟收起，给用户「移到按钮上」的容错时间。 */
  function scheduleReorderHide(): void {
    window.clearTimeout(reorderHideTimerRef.current);
    reorderHideTimerRef.current = window.setTimeout(() => setReorderTarget(null), 180);
  }

  /** 与相邻「可见」模块交换：无数据的条件模块不渲染，交换必须跳过它。 */
  function moveModule(id: DashboardModuleId, delta: number): void {
    const rendered = moduleOrder.filter(moduleId => Boolean(dashboardModules[moduleId]));
    const next = moveDashboardModule(moduleOrder, rendered, id, delta);
    if (next.every((value, index) => value === moduleOrder[index])) return;
    setModuleOrder(next);
    writeDashboardModuleOrder(next);
    // 布局更新后重新贴合被移动的模块，避免控制条停在旧位置。
    window.requestAnimationFrame(() => anchorReorderControls(id));
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    if (!firstFetch.current) setRefreshing(true);
    firstFetch.current = false;
    const params = new URLSearchParams({start: startInput, end: endInput});
    // 后端聚合只接受 IANA 时区：UTC±N 下拉值映射为等价固定偏移 IANA 区。
    params.set("timezone", timeZoneIana(tz));
    fetch(`/api/analytics/dashboard?${params.toString()}`, {signal: controller.signal})
      .then(async response => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "仪表盘数据加载失败");
        }
        return response.json() as Promise<DashboardQueryResult>;
      })
      .then(result => {
        setData(result);
        // tz 不再写入 URL（2026-09-17 全站时区统一受右上角偏好控制）。
        router.replace(`/dashboard?start=${encodeURIComponent(startInput)}&end=${encodeURIComponent(endInput)}`, {scroll: false});
      })
      .catch(caught => {
        if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : "加载失败");
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
    return () => controller.abort();
  }, [startInput, endInput, tz, reloadNonce, router]);

  const applyPreset = useCallback((key: string) => {
    const range = presetRange(key, timeZoneOffsetMinutes(tz));
    if (!range) return;
    rangeTouchedRef.current = true;
    setActivePreset(key);
    setStartInput(range.start);
    setEndInput(range.end);
  }, [tz]);

  const onBoundaryChange = useCallback((which: "start" | "end", value: string) => {
    rangeTouchedRef.current = true;
    setActivePreset("");
    /* 小时粒度：分钟强制对齐 00 */
    const normalized = value.length >= 16 ? `${value.slice(0, 13)}:00` : value;
    if (which === "start") setStartInput(normalized);
    else setEndInput(normalized);
  }, []);

  const toggleModel = useCallback((name: string) => {
    setDisabledModels(previous => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const summary = data?.summary;
  const range = data?.range;
  const baseHref = tpHref(range);
  // 仅成功 = token-pricing 默认口径，链接不带 result 参数；其余指标链接继承 result=all。
  const successHref = tpHref(range, {result: ""});
  const failureHref = tpHref(range, {result: "failure"});
  const inputHref = tpHref(range, {tokenComponent: "input"});
  const outputHref = tpHref(range, {tokenComponent: "output"});
  const cacheHref = tpHref(range, {tokenComponent: "cache"});
  const paygHref = tpHref(range, {channel: "pay_as_you_go"});
  const marketHref = tpHref(range, {channel: "plan,subscription"});
  /* 金额卡消费口径（2026-09-17）：成功+已取消+补差，与 Token 价格页默认结果筛选一致。 */
  const costBaseHref = tpHref(range, {result: CONSUMPTION_RESULT_PARAM});
  const costPaygHref = tpHref(range, {channel: "pay_as_you_go", result: CONSUMPTION_RESULT_PARAM});
  const costMarketHref = tpHref(range, {channel: "plan,subscription", result: CONSUMPTION_RESULT_PARAM});
  /* 量/套 维度的成功/失败与 Token 构成明细链接。 */
  const paygSuccessHref = tpHref(range, {channel: "pay_as_you_go", result: ""});
  const paygFailureHref = tpHref(range, {channel: "pay_as_you_go", result: "failure"});
  const planSuccessHref = tpHref(range, {channel: "plan,subscription", result: ""});
  const planFailureHref = tpHref(range, {channel: "plan,subscription", result: "failure"});
  const paygInputHref = tpHref(range, {tokenComponent: "input", channel: "pay_as_you_go"});
  const paygOutputHref = tpHref(range, {tokenComponent: "output", channel: "pay_as_you_go"});
  const paygCacheHref = tpHref(range, {tokenComponent: "cache", channel: "pay_as_you_go"});
  const planInputHref = tpHref(range, {tokenComponent: "input", channel: "plan,subscription"});
  const planOutputHref = tpHref(range, {tokenComponent: "output", channel: "plan,subscription"});
  const planCacheHref = tpHref(range, {tokenComponent: "cache", channel: "plan,subscription"});
  const requests = summary?.requestCount ?? 0;
  const totalTokens = summary?.totalTokens ?? 0;
  const granularity = data?.range.granularity ?? "hour";
  const buckets = data?.trend.buckets ?? [];
  const bucketCount = buckets.length;

  const hourValues = useMemo(() => buckets.map(bucket => bucket.requestCount), [buckets]);
  const tokenValues = useMemo(() => buckets.map(bucket => bucket.totalTokens), [buckets]);
  const paygValues = useMemo(() => buckets.map(bucket => bucket.actualCostNano / 1e9), [buckets]);
  const marketValues = useMemo(() => buckets.map(bucket => bucket.marketCostNano / 1e9), [buckets]);
  /* KPI 量/套 维度趋势线：按通道拆分的请求数与 Token。 */
  const paygHourValues = useMemo(() => buckets.map(bucket => Math.max(0, bucket.requestCount - bucket.planRequestCount)), [buckets]);
  const planHourValues = useMemo(() => buckets.map(bucket => bucket.planRequestCount), [buckets]);
  const paygTokenValues = useMemo(() => buckets.map(bucket => Math.max(0, bucket.totalTokens - bucket.planTokens)), [buckets]);
  const planTokenValues = useMemo(() => buckets.map(bucket => bucket.planTokens), [buckets]);
  const agents = useMemo(() => sortAgentsByDisplayOrder(data?.agents ?? []), [data?.agents]);

  /* KPI 量/套拆分与估算成本口径。 */
  const planRequests = summary?.planRequestCount ?? 0;
  const paygRequests = Math.max(0, requests - planRequests);
  /* 被模型口径排除的辅助请求量（unknown 模型行），仅在 KPI 副文案作附注。 */
  const auxiliaryCount = summary?.auxiliaryRequestCount ?? 0;
  const planTokens = summary?.planTokens ?? 0;
  const paygTokens = Math.max(0, totalTokens - planTokens);
  const planRealCost = summary?.planRealCostNano ?? null;
  /* 2026-09-15：金额一律为人民币统一口径（入账时冻结汇率折算），多原始币种可直接加总。 */
  const totalRealCost = (summary?.paygActualCostNano ?? 0) + (planRealCost ?? 0);
  /* 原始币种附注：存在多种原始币种时说明折算口径，而不是隐藏金额。
     2026-09-16 用户确认：以悬浮提示（title）展示，不再内联进明细行（避免溢出）。 */
  const sourceCurrencyNote = summary?.hasMultipleSourceCurrencies
    ? `原始币种 ${summary.sourceCurrencies.map(item => item.currency).join("/")}，已按入账时汇率折算为人民币`
    : "";
  /* 套餐金额在“总 / 套”两个视图复用同一视觉口径，避免文案与划线规则漂移。
     待补估算改短徽标 + title 悬浮说明（与排行榜 progressValueNote 同款）：
     长文案内联曾是总金额卡右缘被裁剪的直接推手（2026-10-06 修复；
     2026-10-09 徽标收敛：计数取代「部分估算」）。 */
  const planCostFlow = <>
    <span>市价 <s className={`${styles.costStrike} ${styles.planMarketCostStrike}`}><a className={styles.subtitleLink} href={costMarketHref} title={COST_SCOPE_TOOLTIP}>{fmtMoney(summary?.marketCostNano ?? null)}</a></s></span>
    <span>估算 <strong>{fmtMoney(planRealCost)}</strong></span>
  </>;
  /* 待补徽标（2026-10-09 #6 用户确认）：放数值行右侧（大金额右侧空白区），
     基线对齐 + nowrap——零撑高；不再内联副文案（曾把 量/套 行挤成三行撑高卡体）。 */
  const costPendingBadge = summary?.planRealCostUnavailable ? (
    <a
      className={`${styles.planPartialNote} ${styles.planPartialNoteFloat}`}
      title={`${PLAN_ESTIMATE_PENDING_HINT}（点击筛选查看待补请求）`}
      href={tpHref(range, {pending: "1"})}
    >{summary.planEstimatedPendingCount} 条估算待补</a>
  ) : null;
  /* 总金额趋势线：按量实付 + 套餐成本估算（入账冻结）按积分占比折算到桶；额度未同步时退化为市价等价趋势。 */
  const realCostValues = useMemo(() => {
    const rangeCredits = buckets.reduce((acc, bucket) => acc + bucket.planCreditCost, 0);
    return buckets.map(bucket => {
      const payg = bucket.actualCostNano / 1e9;
      if (planRealCost !== null && rangeCredits > 0) {
        return payg + (planRealCost * (bucket.planCreditCost / rangeCredits)) / 1e9;
      }
      return payg + bucket.marketCostNano / 1e9;
    });
  }, [buckets, planRealCost]);
  /* 套维度金额趋势线：套餐成本估算（入账冻结）按积分占比折算到桶；不可估时退化为市价趋势。 */
  const planRealValues = useMemo(() => {
    const rangeCredits = buckets.reduce((acc, bucket) => acc + bucket.planCreditCost, 0);
    if (planRealCost !== null && rangeCredits > 0) {
      return buckets.map(bucket => (planRealCost * (bucket.planCreditCost / rangeCredits)) / 1e9);
    }
    return marketValues;
  }, [buckets, planRealCost, marketValues]);

  /* Token 成本排行榜：按维度聚合后排序，条形按每百万成本归一化。 */
  const lbRows = useMemo<LeaderboardRow[]>(() => {
    const raw = data?.costLeaderboard.rows ?? [];
    const groups = new Map<string, LeaderboardRow>();
    const add = (key: string, label: string, href: string, row: typeof raw[number]) => {
      const existing = groups.get(key);
      if (existing) {
        existing.totalTokens += row.totalTokens;
        existing.requestCount += row.requestCount;
        existing.planEstimatedPending = existing.planEstimatedPending || row.planEstimatedPending;
        existing.realCostNano = existing.realCostNano === null || row.realCostNano === null ? null : existing.realCostNano + row.realCostNano;
        if (existing.realCostNano !== null && existing.totalTokens > 0) {
          existing.costPerMillionNano = Math.round((existing.realCostNano / existing.totalTokens) * 1e6);
        } else {
          existing.costPerMillionNano = null;
        }
        return;
      }
      groups.set(key, {
        key,
        label,
        href,
        color: CATEGORY_PALETTE[groups.size % CATEGORY_PALETTE.length],
        totalTokens: row.totalTokens,
        requestCount: row.requestCount,
        realCostNano: row.realCostNano,
        costPerMillionNano: row.costPerMillionNano,
        planEstimatedPending: row.planEstimatedPending,
      });
    };
    for (const row of raw) {
      if (lbDim === "modelVendor") {
        const label = `${row.model} × ${row.targetName}`;
        const href = tpHref(range, {model: row.model, ...(row.targetId !== "unknown" ? {target: row.targetId} : {}), result: CONSUMPTION_RESULT_PARAM});
        add(`${row.targetId}|${row.model}`, label, href, row);
      } else if (lbDim === "model") {
        add(`m|${row.model}`, row.model, tpHref(range, {model: row.model, result: CONSUMPTION_RESULT_PARAM}), row);
      } else {
        add(`v|${row.targetId}`, row.targetName, tpHref(range, {...(row.targetId !== "unknown" ? {target: row.targetId} : {}), result: CONSUMPTION_RESULT_PARAM}), row);
      }
    }
    const rows = [...groups.values()];
    rows.sort((left, right) => {
      if (left.costPerMillionNano !== null && right.costPerMillionNano !== null && left.costPerMillionNano !== right.costPerMillionNano) {
        return right.costPerMillionNano - left.costPerMillionNano;
      }
      if (left.costPerMillionNano === null && right.costPerMillionNano !== null) return 1;
      if (right.costPerMillionNano === null && left.costPerMillionNano !== null) return -1;
      return right.totalTokens - left.totalTokens;
    });
    return rows;
  }, [data?.costLeaderboard.rows, lbDim, range]);

  const lbMax = lbRows.reduce((max, row) => Math.max(max, row.costPerMillionNano ?? 0), 0);
  const lbDonutData = useMemo(
    () => lbRows
      .filter(row => row.realCostNano !== null && row.realCostNano > 0)
      .map(row => ({name: row.label, value: row.realCostNano as number, color: row.color})),
    [lbRows],
  );
  const lbTotals = useMemo(() => {
    let real = 0;
    let tokens = 0;
    for (const row of lbRows) {
      if (row.realCostNano !== null) real += row.realCostNano;
      tokens += row.totalTokens;
    }
    return {real, tokens};
  }, [lbRows]);
  const lbHasPending = lbRows.some(row => row.costPerMillionNano === null);

  /* 三列分析数据：模型 / 供应商 / Agent（按所选指标取值与排序）。
     消费列口径（2026-09-29 用户确认）：估算真实成本 = 按量倍率后实付 + 套餐成本估算
     （入账冻结），套餐/订阅不再按市价展示，与 KPI 金额卡/成本排行榜对齐。 */
  const analysisModels = useMemo<AnalysisRow[]>(() => {
    const items = data?.models.items ?? [];
    return items.map(item => ({
      name: item.model,
      color: item.model.startsWith("其他") ? "#c3cfca" : MODEL_RAMP[items.indexOf(item) % MODEL_RAMP.length],
      href: item.model.startsWith("其他") ? baseHref : tpHref(range, {model: item.model}),
      totalTokens: item.totalTokens,
      costNano: item.totalCostNano,
      requestCount: item.requestCount,
      costPendingCount: item.planEstimatedPending,
    }));
  }, [data?.models.items, range, baseHref]);

  const analysisVendors = useMemo<AnalysisRow[]>(() => {
    const vendors = data?.vendors ?? [];
    return vendors.map(vendor => {
      const detailHref = vendor.targetId
        ? tpHref(range, {target: vendor.targetId})
        : tpHref(range, {vendor: vendor.vendorFamily});
      return {
        name: vendor.name,
        color: VENDOR_RAMP[vendors.indexOf(vendor) % VENDOR_RAMP.length],
        href: detailHref,
        legacy: vendor.legacy,
        totalTokens: vendor.totalTokens,
        costNano: vendor.actualCostNano + vendor.planEstimatedNano,
        requestCount: vendor.requestCount,
        costPendingCount: vendor.planEstimatedPending,
      };
    });
  }, [data?.vendors, range]);

  const analysisAgents = useMemo<AnalysisRow[]>(() => {
    return agents.map(agent => ({
      name: agentLabel(agent.agent),
      color: agentBrandColor(agent.agent),
      href: tpHref(range, {agent: agent.agent}),
      totalTokens: agent.totalTokens,
      costNano: agent.actualCostNano + agent.planEstimatedNano,
      requestCount: agent.requestCount,
      costPendingCount: agent.planEstimatedPending,
    }));
  }, [agents, range]);

  const models = data?.models.items ?? [];
  const visibleModels = models.filter(model => !disabledModels.has(model.model));
  const updatedLabel = data?.freshness.asOf
    ? (() => {
      const parts = zonedHourParts(data.freshness.asOf, timeZoneIana(tz));
      return `${parts.hour}:${parts.minute}`;
    })()
    : "--:--";

  const metricConfig = useMemo(() => {
    if (metric === "token") {
      return {
        chart: (
          <StackedBarChart
            segments={[
              {name: "输入", color: COLOR_INPUT, values: buckets.map(bucket => bucket.inputTokens)},
              {name: "输出", color: COLOR_OUTPUT, values: buckets.map(bucket => bucket.outputTokens)},
              {name: "缓存", color: COLOR_CACHE, values: buckets.map(bucket => bucket.cacheTokens)},
            ]}
            fmt={fmtTokens}
            axisFmt={formatTokenAxis}
            height={236}
            titleAt={index => bucketTooltipTitle(buckets[index]?.start ?? "", granularity, tz)}
          />
        ),
        legend: [
          {name: "输入", color: COLOR_INPUT, value: summary?.inputTokens ?? 0},
          {name: "输出", color: COLOR_OUTPUT, value: summary?.outputTokens ?? 0},
          {name: "缓存", color: COLOR_CACHE, value: summary?.cacheTokens ?? 0},
        ],
        legendFmt: fmtTokens,
        donutData: [
          {name: "输入", value: summary?.inputTokens ?? 0, color: COLOR_INPUT},
          {name: "输出", value: summary?.outputTokens ?? 0, color: COLOR_OUTPUT},
          {name: "缓存", value: summary?.cacheTokens ?? 0, color: COLOR_CACHE},
        ],
        donutCenter: {value: fmtTokens(totalTokens), label: "Token 总量"},
        donutFmt: fmtTokens,
      };
    }
    if (metric === "requests") {
      return {
        chart: (
          <LineChart
            segments={[{name: "本周期请求", color: COLOR_MAIN, values: hourValues, area: true}]}
            fmt={fmtInt}
            integerTicks
            height={236}
            titleAt={index => bucketTooltipTitle(buckets[index]?.start ?? "", granularity, tz)}
          />
        ),
        legend: [{name: "本周期请求", color: COLOR_MAIN, value: requests}],
        legendFmt: fmtInt,
        donutData: [
          {name: "成功", value: summary?.successCount ?? 0, color: COLOR_MAIN},
          {name: "失败", value: summary?.failureCount ?? 0, color: COLOR_RED},
        ],
        donutCenter: {value: fmtInt(requests), label: "请求总数"},
        donutFmt: fmtInt,
      };
    }
    /* 消费页签（2026-09-29 用户确认）：套餐/订阅不再展示市价线，改展示套餐成本估算
       （入账冻结）；额度/月费未同步导致估算不可用时退化为市价等价线并标注「估算待补」。 */
    const planEstimateAvailable = (summary?.planRealCostNano ?? 0) > 0;
    const planCostValues = buckets.map(bucket =>
      (planEstimateAvailable ? bucket.planEstimatedNano : bucket.marketCostNano) / 1e9);
    const planCostName = planEstimateAvailable ? "套餐消费（估算）" : "套餐消费（估算待补）";
    const planCostTotalNano = planEstimateAvailable
      ? (summary?.planRealCostNano ?? 0)
      : (summary?.marketCostNano ?? 0);
    return {
      chart: (
        <LineChart
          segments={[
            {name: "按量消费", color: COLOR_MAIN, values: paygValues, area: true},
            {name: planCostName, color: COLOR_MARKET, values: planCostValues},
          ]}
          fmt={value => value.toFixed(2)}
          height={236}
          titleAt={index => bucketTooltipTitle(buckets[index]?.start ?? "", granularity, tz)}
        />
      ),
      legend: [
        {name: "按量消费", color: COLOR_MAIN, value: (summary?.paygActualCostNano ?? 0) / 1e9},
        {name: planCostName, color: COLOR_MARKET, value: planCostTotalNano / 1e9},
      ],
      legendFmt: (value: number) => fmtMoneyRaw(value),
      donutData: [
        {name: "按量消费", value: summary?.paygActualCostNano ?? 0, color: COLOR_MAIN},
        {name: planCostName, value: planCostTotalNano, color: COLOR_MARKET},
      ],
      donutCenter: {value: fmtMoney(((summary?.paygActualCostNano ?? 0) + planCostTotalNano) as number), label: "消费合计（估算总额）"},
      donutFmt: (value: number) => fmtMoney(value),
    };
  }, [metric, buckets, granularity, data, summary, hourValues, paygValues, marketValues, requests, totalTokens, tz]);

  /* 图例/构成行 → 明细承接链接：按当前页签与名称映射维度过滤。 */
  function legendHref(name: string): string {
    if (metric === "token") {
      if (name === "输入") return inputHref;
      if (name === "输出") return outputHref;
      if (name === "缓存") return cacheHref;
      return baseHref;
    }
    if (metric === "cost") {
      if (name === "按量消费") return costPaygHref;
      if (name.startsWith("套餐消费")) return costMarketHref;
      return costBaseHref;
    }
    if (name === "失败") return failureHref;
    if (name === "成功") return successHref;
    return baseHref;
  }

  /* 三列分析行渲染：名称 + 序号 + 数值 + 彩条 + 副行。
     每列内按所选指标降序排列（“其他 N 个”聚合行固定置底），条长即占比，顺序即排名。 */
  function renderAnalysisRows(rows: AnalysisRow[]) {
    if (rows.length === 0) return <div className={styles.empty}>当前范围暂无消耗</div>;
    const ordered = [...rows].sort((left, right) => {
      const leftOther = left.name.startsWith("其他") ? 1 : 0;
      const rightOther = right.name.startsWith("其他") ? 1 : 0;
      if (leftOther !== rightOther) return leftOther - rightOther;
      return analysisMetricValue(right, analysisMetric) - analysisMetricValue(left, analysisMetric);
    });
    const max = ordered.reduce((acc, row) => Math.max(acc, analysisMetricValue(row, analysisMetric)), 0);
    return ordered.map((row, index) => {
      const value = analysisMetricValue(row, analysisMetric);
      const width = max > 0 ? Math.max(2, (value / max) * 100) : 2;
      return (
        <a key={row.name} className={styles.progressItemLink} href={row.href} title="查看对应请求明细">
          <div className={styles.progressItem}>
            <div className={styles.progressHeader}>
              <div className={styles.progressLabel}>
                <span className={styles.progressDot} style={{background: row.color}} />
                <span className={styles.progressLabelName}>{row.name}{row.legacy ? "（旧数据）" : ""}</span>
                <span className={styles.dimHeading} style={{margin: 0, fontSize: 10}}>#{index + 1}</span>
              </div>
              <span className={styles.progressValue}>
                {analysisMetricFmt(value, analysisMetric)}
                {analysisMetric === "cost" && row.costPendingCount ? (
                  <a
                    className={styles.progressValueNote}
                    title={`${PLAN_ESTIMATE_PENDING_HINT}（点击筛选查看待补请求）`}
                    href={`${row.href}${row.href.includes("?") ? "&" : "?"}pending=1`}
                  >{row.costPendingCount} 条估算待补</a>
                ) : null}
              </span>
            </div>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{width: `${width}%`, background: `linear-gradient(90deg, ${row.color}, ${row.color}dd)`}} />
            </div>
            <div className={styles.progressSubtitle}>
              {analysisMetric === "token"
                ? <>{fmtInt(row.requestCount)} 请求 · 消费 {fmtMoney(row.costNano)}</>
                : analysisMetric === "cost"
                  ? <>{fmtTokens(row.totalTokens)} Token · {fmtInt(row.requestCount)} 请求</>
                  : <>{fmtTokens(row.totalTokens)} Token · 消费 {fmtMoney(row.costNano)}</>}
            </div>
          </div>
        </a>
      );
    });
  }

  /**
   * 模块节点表：key 为可排序模块 id，值为该模块的原始 JSX（内部逻辑零改动）。
   * 时间筛选条不在表内 —— 它是页面固定首块，排序的最上边界（2026-09-18 用户确认）。
   */
  const dashboardModules: Record<DashboardModuleId, ReactNode> = {
    overview: (
      <>
        {/* KPI 三卡：总请求 / 总 Token / 总金额（每卡右上角 总/量/套 三维度切换） */}
        <section className={styles.section} aria-label="范围总览">
          <div className={styles.kpiGrid}>
            {/* 总请求：三维度各有 总数/成功/失败/成功率/趋势线 */}
            <article className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span className={styles.kpiIcon}>
                  <svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
                </span>
                <span className={styles.kpiLabel}>总请求{kpiDimSuffix(reqDim)}</span>
                <span className={styles.kpiDimTabs} role="tablist" aria-label="请求维度">
                  {KPI_DIM_OPTIONS.map(option => (
                    <button
                      key={option.key}
                      type="button"
                      role="tab"
                      aria-selected={reqDim === option.key}
                      className={`${styles.kpiDimTab} ${reqDim === option.key ? styles.kpiDimTabActive : ""}`}
                      onClick={() => setReqDim(option.key)}
                    >{option.label}</button>
                  ))}
                </span>
              </div>
              {(() => {
                if (reqDim === "payg") {
                  return (
                    <>
                      <div className={styles.kpiValue}><a className={styles.kpiValueLink} href={paygHref} title="查看按量通道请求明细">{fmtInt(paygRequests)}<small> 请求</small></a></div>
                      <div className={styles.kpiSubtitle}>
                        成功率 {fmtPercent(summary?.paygSuccessRate ?? null)} ·
                        成功 <a className={styles.subtitleLink} href={paygSuccessHref}>{fmtInt(summary?.paygSuccessCount ?? 0)}</a> ·
                        失败 <a className={styles.subtitleLink} href={paygFailureHref}>{fmtInt(summary?.paygFailureCount ?? 0)}</a>
                      </div>
                      <Sparkline values={paygHourValues} color={COLOR_MAIN} />
                    </>
                  );
                }
                if (reqDim === "plan") {
                  return (
                    <>
                      <div className={styles.kpiValue}><a className={styles.kpiValueLink} href={marketHref} title="查看套餐/订阅通道请求明细">{fmtInt(planRequests)}<small> 请求</small></a></div>
                      <div className={styles.kpiSubtitle}>
                        成功率 {fmtPercent(summary?.planSuccessRate ?? null)} ·
                        成功 <a className={styles.subtitleLink} href={planSuccessHref}>{fmtInt(summary?.planSuccessCount ?? 0)}</a> ·
                        失败 <a className={styles.subtitleLink} href={planFailureHref}>{fmtInt(summary?.planFailureCount ?? 0)}</a>
                      </div>
                      <Sparkline values={planHourValues} color={COLOR_MAIN} />
                    </>
                  );
                }
                return (
                  <>
                    <div className={styles.kpiValue}><a className={styles.kpiValueLink} href={baseHref} title={`查看时间范围内全部请求明细。${KPI_SCOPE_TOOLTIP}`}>{fmtInt(requests)}<small> 请求</small></a></div>
                    <div className={styles.kpiSubtitle}>
                      成功率 {fmtPercent(summary?.successRate ?? null)} ·
                      成功 <a className={styles.subtitleLink} href={successHref}>{fmtInt(summary?.successCount ?? 0)}</a> ·
                      失败 <a className={styles.subtitleLink} href={failureHref}>{fmtInt(summary?.failureCount ?? 0)}</a>
                      {auxiliaryCount > 0 ? <span title={KPI_SCOPE_TOOLTIP}> · 另含辅助请求 {fmtInt(auxiliaryCount)} 条未计入</span> : null}
                    </div>
                    <Sparkline values={hourValues} color={COLOR_MAIN} />
                  </>
                );
              })()}
            </article>

            {/* 总 Token：三维度各有 总数/输入/输出/缓存/缓存率/趋势线 */}
            <article className={styles.kpiCard}>
              <div className={styles.kpiHeader}>
                <span className={styles.kpiIcon}>
                  <svg viewBox="0 0 24 24"><path d="M12 3l8 5-8 4.5L4 8l8-5z" /><path d="M4 12l8 4.5 8-4.5" /><path d="M4 16l8 4.5 8-4.5" /></svg>
                </span>
                <span className={styles.kpiLabel}>总 Token{kpiDimSuffix(tokenDim)}</span>
                <span className={styles.kpiDimTabs} role="tablist" aria-label="Token 维度">
                  {KPI_DIM_OPTIONS.map(option => (
                    <button
                      key={option.key}
                      type="button"
                      role="tab"
                      aria-selected={tokenDim === option.key}
                      className={`${styles.kpiDimTab} ${tokenDim === option.key ? styles.kpiDimTabActive : ""}`}
                      onClick={() => setTokenDim(option.key)}
                    >{option.label}</button>
                  ))}
                </span>
              </div>
              {(() => {
                const view = tokenDim === "payg"
                  ? {
                    tokens: paygTokens,
                    input: summary?.paygInputTokens ?? 0,
                    output: summary?.paygOutputTokens ?? 0,
                    cache: summary?.paygCacheTokens ?? 0,
                    inputHref: paygInputHref,
                    outputHref: paygOutputHref,
                    cacheHref: paygCacheHref,
                    spark: paygTokenValues,
                  }
                  : tokenDim === "plan"
                    ? {
                      tokens: planTokens,
                      input: summary?.planInputTokens ?? 0,
                      output: summary?.planOutputTokens ?? 0,
                      cache: summary?.planCacheTokens ?? 0,
                      inputHref: planInputHref,
                      outputHref: planOutputHref,
                      cacheHref: planCacheHref,
                      spark: planTokenValues,
                    }
                    : {
                      tokens: totalTokens,
                      input: summary?.inputTokens ?? 0,
                      output: summary?.outputTokens ?? 0,
                      cache: summary?.cacheTokens ?? 0,
                      inputHref,
                      outputHref,
                      cacheHref,
                      spark: tokenValues,
                    };
                const cacheRate = view.tokens > 0 ? view.cache / view.tokens : null;
                return (
                  <>
                    <div className={styles.kpiValue}><a className={styles.kpiValueLink} href={baseHref} title={`查看时间范围内全部 Token 明细。${KPI_SCOPE_TOOLTIP}`}>
                      {splitValue(fmtTokens(view.tokens)).main}
                      <small>{splitValue(fmtTokens(view.tokens)).unit || " Token"}</small>
                    </a></div>
                    <div className={styles.kpiSubtitle}>
                      输入 <a className={styles.subtitleLink} href={view.inputHref}>{fmtTokens(view.input)}</a> ·
                      输出 <a className={styles.subtitleLink} href={view.outputHref}>{fmtTokens(view.output)}</a> ·
                      缓存 <a className={styles.subtitleLink} href={view.cacheHref}>{fmtTokens(view.cache)}</a> ·
                      缓存率 {fmtPercent(cacheRate)}
                    </div>
                    <Sparkline values={view.spark} color={COLOR_MAIN} />
                  </>
                );
              })()}
            </article>

            {/* 总金额：总维度含量/套两行明细；量/套维度只展示对应通道口径。
                原始币种折算说明以悬浮提示展示（2026-09-16 用户确认）。 */}
            <article className={`${styles.kpiCard} ${styles.kpiCardGold}`} title={sourceCurrencyNote || undefined}>
              <div className={styles.kpiHeader}>
                <span className={styles.kpiIcon}>
                  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M15.5 9c-.6-1-1.9-1.7-3.5-1.7-2 0-3.6.9-3.6 2.2s1.4 1.9 3.6 2.2c2.2.3 3.6 1 3.6 2.2s-1.6 2.2-3.6 2.2c-1.6 0-3-.7-3.5-1.7" /><path d="M12 6v1.5M12 16.5V18" /></svg>
                </span>
                <span className={styles.kpiLabel}>总金额{kpiDimSuffix(costDim)}</span>
                <span className={styles.kpiDimTabs} role="tablist" aria-label="金额维度">
                  {KPI_DIM_OPTIONS.map(option => (
                    <button
                      key={option.key}
                      type="button"
                      role="tab"
                      aria-selected={costDim === option.key}
                      className={`${styles.kpiDimTab} ${costDim === option.key ? styles.kpiDimTabActive : ""}`}
                      onClick={() => setCostDim(option.key)}
                    >{option.label}</button>
                  ))}
                </span>
              </div>
              {(() => {
                if (costDim === "payg") {
                  return (
                    <>
                      <div className={styles.kpiValue}>
                        <a className={styles.kpiValueLink} href={costPaygHref} title={`按量通道：倍率后实付金额（人民币，入账时冻结汇率折算）。${COST_SCOPE_TOOLTIP}`}>
                          {fmtMoney(summary?.paygActualCostNano ?? null)}
                        </a>
                        {costPendingBadge}
                      </div>
                      <div className={styles.kpiSubtitle}>
                        <>量 · 倍率前 <s className={styles.costStrike}>{fmtMoney(summary?.paygCostNano ?? null)}</s> → 倍率后 <a className={styles.subtitleLink} href={costPaygHref} title={COST_SCOPE_TOOLTIP}>{fmtMoney(summary?.paygActualCostNano ?? null)}</a></>
                      </div>
                      <Sparkline values={paygValues} color={COLOR_MARKET} />
                    </>
                  );
                }
                if (costDim === "plan") {
                  return (
                    <>
                      <div className={styles.kpiValue}>
                        <a className={styles.kpiValueLink} href={costMarketHref} title={`套餐/订阅：月费×消耗比率折算的成本估算（入账时冻结）。${COST_SCOPE_TOOLTIP}`}>
                          {fmtMoney(planRealCost)}
                        </a>
                        {costPendingBadge}
                      </div>
                      <div className={`${styles.kpiSubtitle} ${styles.planCostFlowRow}`}>
                        {planCostFlow}
                      </div>
                      <Sparkline values={planRealValues} color={COLOR_MARKET} />
                    </>
                  );
                }
                return (
                  <>
                    <div className={styles.kpiValue}>
                      <a className={styles.kpiValueLink} href={costBaseHref} title={`估算总额 = 按量倍率后实付 + 套餐成本估算（人民币，入账时冻结汇率）。${COST_SCOPE_TOOLTIP}`}>
                        {fmtMoney(totalRealCost)}
                      </a>
                      {costPendingBadge}
                    </div>
                    <div className={`${styles.kpiChannelStack} ${styles.kpiChannelStackInline}`} aria-label="按量与套餐金额明细">
                      <div className={`${styles.kpiChannel} ${styles.kpiChannelPayg}`}>
                        <span className={`${styles.kpiChannelTag} ${styles.kpiChannelTagPayg}`}>量</span>
                        <>
                          <span>倍率前 <s className={styles.costStrike}>{fmtMoney(summary?.paygCostNano ?? null)}</s></span>
                          <span>倍率后 <a className={styles.subtitleLink} href={costPaygHref} title={COST_SCOPE_TOOLTIP}>{fmtMoney(summary?.paygActualCostNano ?? null)}</a></span>
                        </>
                      </div>
                      <div className={`${styles.kpiChannel} ${styles.kpiChannelPlan}`}>
                        <span className={`${styles.kpiChannelTag} ${styles.kpiChannelTagPlan}`}>套</span>
                        {planCostFlow}
                      </div>
                    </div>
                    <Sparkline values={realCostValues} color={COLOR_MARKET} />
                  </>
                );
              })()}
            </article>
          </div>
        </section>

      </>
    ),
    leaderboard: (
      <>
        {/* Token 成本排行榜：每百万 Token 估算成本 */}
        <section className={styles.section} aria-label="Token 成本排行榜">
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}>
                <h2>Token 成本排行榜</h2>
                <p>每百万 Token 估算成本 =（按量倍率后实付 + 套餐成本估算）÷ Token × 1M</p>
              </div>
              <div className={styles.panelTabs} role="tablist" aria-label="排行维度">
                <button type="button" className={`${styles.panelTab} ${lbDim === "modelVendor" ? styles.panelTabActive : ""}`} onClick={() => setLbDim("modelVendor")}>模型 × 供应商</button>
                <button type="button" className={`${styles.panelTab} ${lbDim === "model" ? styles.panelTabActive : ""}`} onClick={() => setLbDim("model")}>模型</button>
                <button type="button" className={`${styles.panelTab} ${lbDim === "vendor" ? styles.panelTabActive : ""}`} onClick={() => setLbDim("vendor")}>供应商</button>
              </div>
            </div>
            <div className={styles.panelBody}>
              <div className={styles.lbLayout}>
                <div className={styles.lbBars}>
                  {lbRows.map((row, index) => (
                    <a key={row.key} className={styles.progressItemLink} href={row.href} title="查看对应请求明细">
                      <div className={styles.progressItem}>
                        <div className={styles.progressHeader}>
                          <div className={styles.progressLabel}>
                            <span className={styles.progressDot} style={{background: row.color}} />
                            <span className={styles.progressLabelName}>{row.label}</span>
                            <span className={styles.dimHeading} style={{margin: 0, fontSize: 10}}>#{index + 1}</span>
                          </div>
                          <span className={styles.progressValue}>
                            {row.costPerMillionNano !== null
                              ? <>{fmtMoney(row.costPerMillionNano)}<small style={{marginLeft: 3, fontSize: 10}}> /M</small></>
                              : <a className={styles.lbBarPending} title={`${PLAN_ESTIMATE_PENDING_HINT}（点击筛选查看该目标待补请求）`} href={`${row.href}${row.href.includes("?") ? "&" : "?"}pending=1`}>估算待补</a>}
                          </span>
                        </div>
                        <div className={styles.progressBar}>
                          <div
                            className={styles.progressFill}
                            style={{
                              width: `${row.costPerMillionNano !== null && lbMax > 0 ? Math.max(2, (row.costPerMillionNano / lbMax) * 100) : 2}%`,
                              background: `linear-gradient(90deg, ${row.color}, ${row.color}dd)`,
                            }}
                          />
                        </div>
                        <div className={styles.progressSubtitle}>
                          {fmtTokens(row.totalTokens)} Token · {fmtInt(row.requestCount)} 请求 ·
                          估算成本 {row.planEstimatedPending
                            ? <>{fmtMoney(row.realCostNano)}（<a className={styles.progressValueNote} title={`${PLAN_ESTIMATE_PENDING_HINT}（点击筛选查看该目标待补请求）`} href={`${row.href}${row.href.includes("?") ? "&" : "?"}pending=1`}>估算待补</a>）</>
                            : fmtMoney(row.realCostNano)}
                        </div>
                      </div>
                    </a>
                  ))}
                  {lbRows.length === 0 ? <div className={styles.empty}>当前范围暂无可排行的消耗</div> : null}
                </div>
                <aside className={styles.lbDonutSide}>
                  <h3 className={styles.sideTitle}>估算成本占比</h3>
                  <div className={styles.donutWrap}>
                    <Donut
                      data={lbDonutData}
                      centerValue={lbTotals.tokens > 0 && lbTotals.real > 0 ? `${fmtMoney(Math.round((lbTotals.real / lbTotals.tokens) * 1e6))}/M` : "—"}
                      centerLabel="加权平均"
                      fmt={fmtMoney}
                      valueAt={datum => {
                        const row = lbRows.find(item => item.label === datum.name);
                        return row?.costPerMillionNano !== null && row?.costPerMillionNano !== undefined
                          ? `${fmtMoney(row.costPerMillionNano)}/M`
                          : "估算待补";
                      }}
                    />
                  </div>
                  <p className={styles.lbNote}>
                    环形占比 = 估算成本占比；标注金额 = 每百万 Token 估算成本。
                    {lbHasPending ? " 部分套餐请求暂无估算金额（多为等待下一个额度刻度或同步开启前的历史行）。" : ""}
                    {data?.summary.hasMultipleSourceCurrencies ? ` 范围含原始币种 ${data.summary.sourceCurrencies.map(item => item.currency).join("/")}，金额已按入账时汇率折算为人民币。` : ""}
                  </p>
                </aside>
              </div>
              {data?.costLeaderboard.limited ? (
                <p className={styles.panelMeta}>排行榜仅展示 Top {data.costLeaderboard.rows.length} · 候选 {data.costLeaderboard.candidateCount} 组 · 已处理 {data.costLeaderboard.processedCount} 组。</p>
              ) : null}
            </div>
          </div>
        </section>

      </>
    ),
    analysis: (
      <>
        {/* 模型 / 供应商 / Agent 分析：三列 + 模型 Token 趋势 */}
        <section className={styles.section} aria-label="模型 供应商 Agent 分析">
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}>
                <h2>模型 / 供应商 / Agent 分析</h2>
                <p>按右上指标展示用量排行 · 条长为该维度内最大值占比 · 模型趋势随排行联动</p>
              </div>
              <div className={styles.panelTabs} role="tablist" aria-label="分析指标">
                <button type="button" className={`${styles.panelTab} ${analysisMetric === "token" ? styles.panelTabActive : ""}`} onClick={() => setAnalysisMetric("token")}>Token</button>
                <button type="button" className={`${styles.panelTab} ${analysisMetric === "cost" ? styles.panelTabActive : ""}`} onClick={() => setAnalysisMetric("cost")}>消费</button>
                <button type="button" className={`${styles.panelTab} ${analysisMetric === "requests" ? styles.panelTabActive : ""}`} onClick={() => setAnalysisMetric("requests")}>请求</button>
              </div>
            </div>
            <div className={styles.panelBody}>
              <div className={styles.analysisGrid}>
                <div className={styles.analysisCol}>
                  <h3 className={styles.analysisColHeading}><i style={{background: MODEL_RAMP[0]}} />模型</h3>
                  {renderAnalysisRows(analysisModels)}
                </div>
                <div className={styles.analysisCol}>
                  <h3 className={styles.analysisColHeading}><i style={{background: VENDOR_RAMP[0]}} />供应商</h3>
                  {renderAnalysisRows(analysisVendors)}
                </div>
                <div className={`${styles.analysisCol} ${styles.analysisColAgent}`}>
                  <h3 className={styles.analysisColHeading}><i style={{background: AGENT_COLOR_FALLBACK}} />Agent</h3>
                  {renderAnalysisRows(analysisAgents)}
                </div>
              </div>

              <div className={styles.analysisTrendBlock}>
                <h3 className={styles.dimHeading}>模型 Token 趋势（点击图例切换序列）</h3>
                <div className={styles.seriesLegend}>
                  {models.map((model, index) => {
                    const color = MODEL_PALETTE[index % MODEL_PALETTE.length];
                    const active = !disabledModels.has(model.model);
                    return (
                      <button
                        key={model.model}
                        type="button"
                        className={`${styles.seriesChip} ${active ? styles.seriesChipActive : styles.seriesChipInactive}`}
                        onClick={() => toggleModel(model.model)}
                      >
                        <span className={styles.legendDotCircle} style={{background: color}} />
                        {model.model}
                      </button>
                    );
                  })}
                </div>
                <LineChart
                  segments={visibleModels.map((model): ChartSeries => ({
                    name: model.model,
                    color: MODEL_PALETTE[Math.max(0, models.indexOf(model)) % MODEL_PALETTE.length],
                    values: model.series,
                  }))}
                  fmt={fmtTokens}
                  axisFmt={formatTokenAxis}
                  titleAt={index => bucketTooltipTitle(buckets[index]?.start ?? "", granularity, tz)}
                />
                <XLabels
                  count={bucketCount}
                  showAll={granularity === "hour"}
                  labelAt={index => bucketAxisLabel(buckets[index]?.start ?? "", granularity, tz, buckets[index - 1]?.start)}
                />
              </div>
            </div>
          </div>
        </section>

      </>
    ),
    trend: (
      <>
        {/* 消耗趋势与构成 */}
        <section className={styles.section} aria-label="消耗趋势与构成">
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}>
                <h2>消耗趋势与构成</h2>
              </div>
              <div className={styles.panelTabs} role="tablist">
                <button type="button" className={`${styles.panelTab} ${metric === "token" ? styles.panelTabActive : ""}`} onClick={() => setMetric("token")}>Token</button>
                <button type="button" className={`${styles.panelTab} ${metric === "requests" ? styles.panelTabActive : ""}`} onClick={() => setMetric("requests")}>请求</button>
                <button type="button" className={`${styles.panelTab} ${metric === "cost" ? styles.panelTabActive : ""}`} onClick={() => setMetric("cost")}>消费</button>
              </div>
            </div>
            <div className={`${styles.panelBody} ${styles.panelBodyTight}`}>
              <div className={styles.trendBody}>
                <div className={styles.trendMain}>
                  {metricConfig.chart}
                  <XLabels
                    count={bucketCount}
                    showAll={granularity === "hour"}
                    labelAt={index => bucketAxisLabel(buckets[index]?.start ?? "", granularity, tz, buckets[index - 1]?.start)}
                  />
                  <div className={styles.chartLegend}>
                    {metricConfig.legend.map(item => (
                      <a key={item.name} className={styles.legendLink} href={legendHref(item.name)} title="查看对应请求明细">
                        <span className={styles.legendItem}>
                          <span className={metric === "token" ? styles.legendDotSquare : styles.legendDotCircle} style={{background: item.color}} />
                          {item.name}
                          <span className={styles.legendValue}>{metricConfig.legendFmt(item.value)}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
                <aside className={styles.trendSide}>
                  <h3 className={styles.sideTitle}>构成占比</h3>
                  <div className={styles.donutWrap}>
                    <Donut
                      data={metricConfig.donutData}
                      centerValue={metricConfig.donutCenter.value}
                      centerLabel={metricConfig.donutCenter.label}
                      fmt={metricConfig.donutFmt}
                      hrefFor={name => legendHref(name)}
                    />
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </section>

      </>
    ),
    plans: (
      <>
        {/* 套餐 / 订阅供应商消耗 */}
        {data && data.plans.length > 0 ? (
          <section className={styles.section} aria-label="套餐与订阅供应商消耗">
            <div className={`${styles.panelHeader} ${styles.panelBareHeader}`}>
              <div className={styles.panelTitle}>
                <h2>套餐 / 订阅供应商消耗</h2>
                <p>套餐内实际使用情况：请求、Token、市价等价、真实消耗（月费×积分比率）与套餐积分</p>
              </div>
            </div>
            <div className={styles.grid3}>
              {data.plans.map(plan => {
                const planHref = tpHref(range, {target: plan.targetId, channel: plan.channel});
                return (
                <article key={plan.targetId} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <a className={styles.cardLink} style={{minWidth: 0}} href={planHref} title="查看该套餐通道请求明细">
                      <div className={styles.cardTitle}>{plan.name}</div>
                      <div className={styles.cardTarget}>{plan.models.length > 0 ? plan.models.join(" / ") : plan.targetId}</div>
                    </a>
                    <span className={`${styles.cardBadge} ${plan.channel === "subscription" ? styles.cardBadgeSubscription : ""}`}>{plan.channel}</span>
                  </div>
                  <div className={styles.planMetricGrid}>
                    <a className={styles.planMetric} href={planHref} title="查看该通道请求明细">
                      <span className={`${styles.planMetricIcon} ${styles.planMetricIconRequest}`}><Send size={15} /></span>
                      <span className={styles.planMetricBody}>
                        <span className={styles.planMetricValue}>{fmtInt(plan.requestCount)}</span>
                        <span className={styles.planMetricLabel}>请求</span>
                      </span>
                    </a>
                    <a className={styles.planMetric} href={planHref} title="查看该通道 Token 明细">
                      <span className={`${styles.planMetricIcon} ${styles.planMetricIconTokens}`}><Coins size={15} /></span>
                      <span className={styles.planMetricBody}>
                        <span className={styles.planMetricValue}>{fmtTokens(plan.totalTokens)}</span>
                        <span className={styles.planMetricLabel}>Token</span>
                      </span>
                    </a>
                    <a className={styles.planMetric} href={planHref} title="市价等价与实际真实消耗（月费×积分比率）">
                      <span className={`${styles.planMetricIcon} ${styles.planMetricIconMarket}`}><CircleDollarSign size={15} /></span>
                      <span className={styles.planMetricBody}>
                        <span className={styles.planMetricValue}>
                          {plan.planRealCostNano !== null ? fmtMoney(plan.planRealCostNano) : fmtMoney(plan.marketCostNano)}
                        </span>
                        <span className={styles.planMetricLabel}>
                          {plan.planRealCostNano !== null
                            ? <>市价 {fmtMoney(plan.marketCostNano)} · 省钱率 {fmtPercent(plan.marketCostNano > 0 ? 1 - plan.planRealCostNano / plan.marketCostNano : null)}</>
                            : "市价等价 · 真实待补"}
                        </span>
                      </span>
                    </a>
                    <a className={styles.planMetric} href={planHref} title="查看该通道套餐积分明细">
                      <span className={`${styles.planMetricIcon} ${styles.planMetricIconCredit}`}><Ticket size={15} /></span>
                      <span className={styles.planMetricBody}>
                        <span className={styles.planMetricValue}>{fmtCredit(plan.creditCost, plan.creditUnit)}</span>
                        <span className={styles.planMetricLabel}>套餐积分</span>
                      </span>
                    </a>
                  </div>
                </article>
                );
              })}
            </div>
          </section>
        ) : null}

      </>
    ),
    heatmap: (
      <>
        {/* 周期强度热力图 */}
        <section className={styles.section} aria-label="周期强度热力图">
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}>
                <h2>周期强度热力图</h2>
                <p>最近 7 天 × 24 小时的 Token 消耗强度分布</p>
              </div>
              <span className={styles.panelMeta}>{data?.freshness.staleBuckets ? `${data.freshness.staleBuckets} 个小时桶待汇总` : undefined}</span>
            </div>
            <div className={styles.heatmap}>
              <HeatmapGrid days={data?.heatmap.days ?? []} cellHref={(date, hour) => heatmapCellHref(date, hour, tz)} />
              <div className={styles.heatmapLegend}>
                <span>少</span>
                <i className={styles.heatmapLegendCell} style={{background: "var(--surface-3)"}} />
                <i className={styles.heatmapLegendCell} style={{background: "var(--pine-100)"}} />
                <i className={styles.heatmapLegendCell} style={{background: "var(--pine-300)"}} />
                <i className={styles.heatmapLegendCell} style={{background: "var(--pine-500)"}} />
                <i className={styles.heatmapLegendCell} style={{background: "var(--pine-700)"}} />
                <span>多</span>
              </div>
            </div>
          </div>
        </section>
      </>
    ),
  };

  /** 当前真正渲染出来的模块顺序（条件模块无数据时不出现在列表里）。 */
  const renderedModuleOrder = moduleOrder.filter(moduleId => Boolean(dashboardModules[moduleId]));

  return (
    <div className={styles.shell}>
      <div className={styles.container}>
        {error ? (
          <div className={styles.stateCard} role="alert">
            ⚠ {error}
            <button type="button" onClick={() => setReloadNonce(value => value + 1)}>重试</button>
          </div>
        ) : null}
        {loading && !data ? (
          <div className={styles.stateCard}>
            <span className={styles.spinIcon}>⟳</span> 正在读取小时事实…
          </div>
        ) : null}

        {/* 筛选条 */}
        <section ref={filtersRef} className={styles.section} aria-label="时间范围筛选">
          <div className={styles.filters}>
            <span className={styles.filterLabel}>开始</span>
            <HourPicker value={startInput} ariaLabel="开始时间（含，小时对齐）" onChange={next => onBoundaryChange("start", next)} />
            <span className={styles.filterLabel}>结束</span>
            <HourPicker value={endInput} ariaLabel="结束时间（排他边界）" onChange={next => onBoundaryChange("end", next)} />
            {/* 时区已统一到右上角全局选择器（2026-09-10）：此处不再重复提供入口。 */}
            <span className={styles.filterDivider} />
            {PRESETS.map(preset => (
              <button
                key={preset.key}
                type="button"
                className={`${styles.filterChip} ${activePreset === preset.key ? styles.filterChipActive : ""}`}
                onClick={() => applyPreset(preset.key)}
              >
                {preset.label}
              </button>
            ))}
            <span className={styles.filterSpacer} />
            <span className={styles.filterUpdated}>数据更新于 <strong>{updatedLabel}</strong></span>
            <button
              type="button"
              className={`${styles.btnPrimary} ${refreshing ? styles.spinning : ""}`}
              onClick={() => setReloadNonce(value => value + 1)}
            >
              <svg viewBox="0 0 24 24">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 21h5v-5" />
              </svg>
              刷新数据
            </button>
          </div>
        </section>

        {/* 模块排序控制条：悬停某个模块时出现在浏览器右边缘（贴近右边界），
            垂直对齐该模块，且最上不超过时间选择器；上/下箭头与相邻可见模块交换。 */}
        {reorderTarget ? (
          <div
            className={styles.reorderControls}
            style={{top: reorderTarget.top, right: reorderTarget.right}}
            role="group"
            aria-label={`调整「${DASHBOARD_MODULE_LABELS[reorderTarget.id]}」模块顺序`}
            onMouseEnter={() => {
              reorderControlHoveredRef.current = true;
              window.clearTimeout(reorderHideTimerRef.current);
            }}
            onMouseLeave={() => {
              reorderControlHoveredRef.current = false;
              scheduleReorderHide();
            }}
          >
            <button
              type="button"
              className={styles.reorderButton}
              disabled={renderedModuleOrder.indexOf(reorderTarget.id) <= 0}
              onClick={() => moveModule(reorderTarget.id, -1)}
              aria-label={`上移「${DASHBOARD_MODULE_LABELS[reorderTarget.id]}」`}
              title={`上移「${DASHBOARD_MODULE_LABELS[reorderTarget.id]}」`}
            >
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.reorderButton}
              disabled={renderedModuleOrder.indexOf(reorderTarget.id) >= renderedModuleOrder.length - 1}
              onClick={() => moveModule(reorderTarget.id, 1)}
              aria-label={`下移「${DASHBOARD_MODULE_LABELS[reorderTarget.id]}」`}
              title={`下移「${DASHBOARD_MODULE_LABELS[reorderTarget.id]}」`}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {renderedModuleOrder.map(moduleId => {
          const moduleNode = dashboardModules[moduleId];
          if (!moduleNode) return null;
          return (
            <div
              key={moduleId}
              className={styles.moduleHost}
              ref={node => {
                if (node) moduleHostRefs.current.set(moduleId, node);
                else moduleHostRefs.current.delete(moduleId);
              }}
              onMouseEnter={() => {
                window.clearTimeout(reorderHideTimerRef.current);
                anchorReorderControls(moduleId);
              }}
              onMouseLeave={scheduleReorderHide}
            >
              {moduleNode}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ==================== 热力图网格 ==================== */

function HeatmapGrid({days, cellHref}: {days: DashboardQueryResult["heatmap"]["days"]; cellHref: (date: string, hour: number) => string}) {
  const levels = useMemo(() => {
    const values = days.flatMap(day => day.values).filter(value => value > 0).sort((a, b) => a - b);
    const pick = (fraction: number) => values.length > 0 ? values[Math.min(values.length - 1, Math.floor(values.length * fraction))] : 0;
    return {q25: pick(0.25), q50: pick(0.5), q75: pick(0.78)};
  }, [days]);
  return (
    <div className={styles.heatmapGrid} role="img" aria-label="最近 7 天逐小时 Token 强度">
      <div className={`${styles.heatmapRow} ${styles.heatmapHourHeader}`} aria-hidden="true">
        <div className={styles.heatmapLabel} />
        {Array.from({length: 24}, (_, hour) => <span key={hour}>{pad(hour)}</span>)}
      </div>
      {days.map(day => (
        <div key={day.date} className={styles.heatmapRow}>
          <div className={styles.heatmapLabel}>{shortDayKey(day.date)} 周{weekdayLabel(day.weekday)}</div>
          {day.values.map((value, hour) => {
            const level = value <= 0 ? 0 : value <= levels.q25 ? 1 : value <= levels.q50 ? 2 : value <= levels.q75 ? 3 : 4;
            return (
              <a
                key={hour}
                className={`${styles.heatmapCell} ${level > 0 ? cellLevelClass(level) : ""}`}
                href={cellHref(day.date, hour)}
                title={`${shortDayKey(day.date)} ${pad(hour)}:00 · ${fmtTokens(value)} Token · 点击查看该小时请求明细`}
              />
            );
          })}
        </div>
      ))}
      {days.length === 0 ? <div className={styles.empty}>暂无热力数据</div> : null}
    </div>
  );
}

function cellLevelClass(level: number): string {
  if (level === 1) return styles.heatmapCellLevel1;
  if (level === 2) return styles.heatmapCellLevel2;
  if (level === 3) return styles.heatmapCellLevel3;
  return styles.heatmapCellLevel4;
}
