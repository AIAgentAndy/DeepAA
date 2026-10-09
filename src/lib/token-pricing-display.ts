import type {LongContextMatchInfo, TemporalPriceSchedule} from "@/lib/pricing";
import {formatPriceWithCnyEquivalent} from "@/lib/money-display";

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** 高峰/闲时徽标文案；无时段维度时返回 null（页面不渲染）。 */
export function scheduleBadge(label: string | undefined): string | null {
  return label ? label : null;
}

/** 以周内分钟表示的时段区间（day 0=周一；end 可等于 1440，不跨天）。 */
interface WeekInterval {
  day: number;
  start: number;
  end: number;
}

/**
 * IANA 时区在参考时刻的 UTC 偏移（分钟）；解析失败（非法时区/运行时不支持）返回
 * undefined，调用方按「不转换」处理（宁可展示目录原值也不虚构）。
 */
function timeZoneOffsetMinutes(timeZone: string, at: Date = new Date()): number | undefined {
  try {
    const part = new Intl.DateTimeFormat("en-US", {timeZone, timeZoneName: "longOffset"})
      .formatToParts(at)
      .find(item => item.type === "timeZoneName")?.value;
    const match = part ? /^GMT([+-])(\d{2}):(\d{2})$/u.exec(part) : undefined;
    if (!match) return part === "GMT" ? 0 : undefined;
    const magnitude = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -magnitude : magnitude;
  } catch {
    return undefined;
  }
}

/**
 * 展示时区转换（2026-09-30 用户确认）：目录时段窗口按各 schedule 自带时区维护
 * （官方原文口径，如 DeepSeek UTC），展示时换算到查看者时区（全站右上角偏好，
 * 缺省东八区）。偏移相同的 schedule 原样保留；解析不出偏移不转换。
 * 跨周界/跨午夜区间被拆分为不跨天的周内区间，供既有逐日合并/取补集渲染复用。
 */
function scheduleWindowsToIntervals(
  schedules: TemporalPriceSchedule[],
  targetTimeZone?: string,
): WeekInterval[] {
  const intervals: WeekInterval[] = [];
  const targetOffset = targetTimeZone ? timeZoneOffsetMinutes(targetTimeZone) : undefined;
  for (const schedule of schedules) {
    const scheduleTimeZone = schedule.timezone || "Asia/Shanghai";
    const delta = targetTimeZone && targetOffset !== undefined
      ? targetOffset - (timeZoneOffsetMinutes(scheduleTimeZone) ?? targetOffset)
      : 0;
    for (const window of schedule.windows) {
      const days = window.days?.length ? window.days : [0, 1, 2, 3, 4, 5, 6];
      const start = parseClockMinutes(window.start);
      const end = parseClockMinutes(window.end);
      for (const day of days) {
        if (delta === 0) {
          intervals.push({day, start, end: Math.max(start, end)});
          continue;
        }
        let cursor = ((day * MINUTES_PER_DAY + start + delta) % MINUTES_PER_WEEK + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
        let remaining = Math.max(0, end - start);
        while (remaining > 0) {
          const dayBoundary = Math.floor(cursor / MINUTES_PER_DAY) * MINUTES_PER_DAY + MINUTES_PER_DAY;
          const take = Math.min(remaining, dayBoundary - cursor);
          intervals.push({day: Math.floor(cursor / MINUTES_PER_DAY) % 7, start: cursor % MINUTES_PER_DAY, end: cursor % MINUTES_PER_DAY + take});
          cursor = (cursor + take) % MINUTES_PER_WEEK;
          remaining -= take;
        }
      }
    }
  }
  return intervals;
}

/** 时段规则生效窗口摘要；无 priceSchedules 时返回 null（页面不渲染）。 */
export function scheduleWindowText(
  schedules: TemporalPriceSchedule[] | undefined,
  targetTimeZone?: string,
): string | null {
  if (!schedules?.length) return null;
  const first = schedules[0];
  const intervals = mergeDayIntervals(scheduleWindowsToIntervals([first], targetTimeZone));
  const groups = groupIntervalsByDaySignature(intervals);
  const text = groups
    .map(group => `${dayRangeText(group.days)} ${group.intervals
      .map(([start, end]) => `${clockText(start)}-${clockText(end)}`)
      .join("、")}`)
    .join("；");
  return text ? `${first.label}：${text}` : null;
}

/**
 * 峰谷价格摘要：base 为高峰原始价，schedule.rates 为闲时窗口价；无时段维度时返回 null。
 * options.currency/cnyRate（2026-09-28）：提供时每个价格标注币种符号，rate 有效且非
 * CNY 时附括号人民币等值（价格中心弹窗等场景只传 currency 即只标符号不加括号）。
 */
export function schedulePricingText(
  base: {input?: number; output?: number; cachedInput?: number} | undefined,
  schedules: TemporalPriceSchedule[] | undefined,
  options?: {currency?: string; cnyRate?: number},
): string | null {
  const schedule = schedules?.[0];
  const offPeak = schedule?.rates;
  if (!base || !offPeak) return null;
  const money = (value: number | undefined) =>
    formatPriceWithCnyEquivalent(value, options?.currency, options?.cnyRate);
  return [
    `高峰 输入 ${money(base.input)} · 输出 ${money(base.output)}`,
    base.cachedInput === undefined ? "" : `缓存 ${money(base.cachedInput)}`,
    `${schedule.label} 输入 ${money(offPeak.input)} · 输出 ${money(offPeak.output)}`,
    offPeak.cachedInput === undefined ? "" : `缓存 ${money(offPeak.cachedInput)}`,
  ].filter(Boolean).join(" · ");
}

/** 单个费率字段的高峰/闲时展示；无时段维度或字段缺失时返回 null。 */
export function scheduleFieldPriceText(
  base: {input?: number; output?: number; cachedInput?: number} | undefined,
  schedules: TemporalPriceSchedule[] | undefined,
  field: "input" | "cachedInput" | "output",
): string | null {
  if (!base || !schedules?.length) return null;
  const offPeak = schedules[0]?.rates;
  const peak = base[field];
  if (peak === undefined || !offPeak) return null;
  const off = offPeak[field];
  return off === undefined ? `${peak}` : `高峰 ${peak} / 闲时 ${off}`;
}

/**
 * 高峰时段摘要：由闲时窗口取补集计算；无时段维度时返回 null。
 * targetTimeZone（2026-09-30）：传入时窗口先换算到查看者时区再取补集渲染。
 */
export function peakWindowText(
  schedules: TemporalPriceSchedule[] | undefined,
  targetTimeZone?: string,
): string | null {
  if (!schedules?.length) return null;
  const offPeakByDay: Record<number, Array<[number, number]>> = {};
  for (const interval of scheduleWindowsToIntervals(schedules, targetTimeZone)) {
    (offPeakByDay[interval.day] ||= []).push([interval.start, interval.end]);
  }
  const peakMerged = [0, 1, 2, 3, 4, 5, 6]
    .map(day => ({day, intervals: complementIntervals(mergeIntervals(offPeakByDay[day] || []))}))
    .filter(group => group.intervals.length > 0);
  const parts = groupIntervalsByDaySignature(peakMerged)
    .map(group => `${dayRangeText(group.days)} ${group.intervals
      .map(([start, end]) => `${clockText(start)}-${clockText(end)}`)
      .join("、")}`);
  if (parts.length === 0) return "全天闲时";
  const hasHolidays = schedules.some(schedule => schedule.holidays?.length);
  return `高峰：${parts.join("；")}；其余时间为闲时${hasHolidays ? "（含节假日）" : ""}`;
}

/** 逐日合并重叠/相邻区间（含换算后同日多段）。 */
function mergeDayIntervals(intervals: WeekInterval[]): Array<{day: number; intervals: Array<[number, number]>}> {
  const byDay: Record<number, Array<[number, number]>> = {};
  for (const interval of intervals) {
    (byDay[interval.day] ||= []).push([interval.start, interval.end]);
  }
  return Object.keys(byDay)
    .map(Number)
    .sort((left, right) => left - right)
    .map(day => ({day, intervals: mergeIntervals(byDay[day] || [])}));
}

/** 同日区间签名一致的日期合并展示（如「周一至周五 08:30-16:30」）。 */
function groupIntervalsByDaySignature(
  merged: Array<{day: number; intervals: Array<[number, number]>}>,
): Array<{days: number[]; intervals: Array<[number, number]>}> {
  const groups = new Map<string, {days: number[]; intervals: Array<[number, number]>}>();
  for (const item of merged) {
    const key = JSON.stringify(item.intervals);
    const group = groups.get(key) || {days: [], intervals: item.intervals};
    group.days.push(item.day);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 节假日摘要：按闲时计费的日期清单；未配置时返回 null。 */
export function scheduleHolidayText(schedules: TemporalPriceSchedule[] | undefined): string | null {
  const holidays = [...new Set((schedules || []).flatMap(schedule => schedule.holidays || []))].sort();
  if (holidays.length === 0) return null;
  const shown = holidays.slice(0, 5).map(date => date.slice(5));
  return `节假日（按闲时计费）：${shown.join("、")}${holidays.length > 5 ? ` 等 ${holidays.length} 天` : ""}`;
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1]) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}

function complementIntervals(merged: Array<[number, number]>): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) result.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < MINUTES_PER_DAY) result.push([cursor, MINUTES_PER_DAY]);
  return result;
}

function parseClockMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (!match) throw new Error(`非法时间窗口时刻: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function clockText(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 连续星期合并为“周一至周五”，非连续用“/”分隔（0=周一 ... 6=周日）。 */
function dayRangeText(days: number[]): string {
  const sorted = [...days].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    parts.push(start === previous
      ? WEEKDAY_LABELS[start]
      : `${WEEKDAY_LABELS[start]}至${WEEKDAY_LABELS[previous]}`);
    if (current !== undefined) {
      start = current;
      previous = current;
    }
  }
  return parts.join("/");
}

export function formatTotalTokenMillions(value: number): string {
  return `${(safeNumber(value) / 1_000_000).toFixed(2)}M`;
}

/** 首页聚合条与 Token 价格页统一使用 K/M：未达到 1M 时始终保留 K 单位。 */
export function formatSummaryTokenAmount(value: number): string {
  const numericValue = safeNumber(value);
  if (numericValue < 1_000_000) return `${(numericValue / 1_000).toFixed(2)}K`;
  return `${(numericValue / 1_000_000).toFixed(2)}M`;
}

export function formatTokenAmount(value: number): string {
  const numericValue = safeNumber(value);
  if (numericValue >= 1_000_000) return `${(numericValue / 1_000_000).toFixed(2)}M`;
  if (numericValue >= 1_000) return `${(numericValue / 1_000).toFixed(2)}K`;
  return Math.round(numericValue).toLocaleString();
}

export function formatCacheHitRateFormula(inputTokens: number, cacheReadTokens: number): string {
  const denominator = safeNumber(inputTokens) + safeNumber(cacheReadTokens);
  const rate = denominator > 0 ? safeNumber(cacheReadTokens) / denominator : 0;
  return `${formatTokenAmount(cacheReadTokens)}/${formatTokenAmount(denominator)} ${(rate * 100).toFixed(1)}%`;
}

/** 币种符号（2026-09-28）：USD → $、CNY → ￥、未知/缺省 → 空串（不猜测币种）。 */
function currencySymbol(currency?: string): string {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "￥";
  return "";
}

/** 金额格式化（2026-09-28 起支持币种符号）：人民币终值传 "CNY"，原币中间项传行币种。 */
export function formatSummaryMoney(value: number | undefined, currency?: string): string {
  return value === undefined ? "-" : `${currencySymbol(currency)}${safeNumber(value).toFixed(4)}`;
}

export function formatDetailMoney(value: number | undefined, currency?: string): string {
  return value === undefined ? "-" : `${currencySymbol(currency)}${safeNumber(value).toFixed(6)}`;
}

/** 供应商成本专用：目录无官方价时为 0，展示为 “-” 而不是 $0，避免误导为真 0 元。 */
export function formatVendorMoney(value: number | undefined, detail = false, currency?: string): string {
  if (value === undefined || value === 0) return "-";
  return detail ? formatDetailMoney(value, currency) : formatSummaryMoney(value, currency);
}

export function formatInteger(value: number | undefined): string {
  return Math.round(value || 0).toLocaleString();
}

export function formatDecimal(value: number, digits: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function formatUnitPrice(value: number | undefined, currency?: string): string {
  return value === undefined ? "-" : `${currencySymbol(currency)}${value.toLocaleString(undefined, { maximumFractionDigits: 8 })}/M`;
}

/** 成本公式浮窗的行输入：TokenPricingItem 的结构子集，避免展示模块反向依赖查询模块。 */
export interface CostFormulaItem {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  inputUnitPrice?: number;
  cacheReadUnitPrice?: number;
  cacheWriteUnitPrice?: number;
  outputUnitPrice?: number;
  inputCost?: number;
  cacheReadCost?: number;
  cacheCreationCost?: number;
  outputCost?: number;
  vendorCost?: number;
  actualCost?: number;
  rateMultiplier: number;
  /** 入账冻结的结算系数（原币种 → 人民币）；非 1 时公式追加折算行。 */
  fxRateToCny?: number;
  /** 人民币口径金额（明细行展示值）；公式末行给出与页面一致的合计。 */
  vendorCostCny?: number;
  actualCostCny?: number;
  /** 原币种（USD/CNY 等）；折算行标注牌价币种。 */
  currency?: string;
  /** 命中的长上下文档位；由映射层按派生同规则复算后携带。 */
  longContextTier?: LongContextMatchInfo;
}

/** 长上下文档位标注行：说明单价已整单换档，解释分项之和与账本金额自洽。 */
function longContextTierLine(tier: LongContextMatchInfo): string {
  return `长上下文档位：上下文 ${formatInteger(tier.contextTokens)} > ${formatInteger(tier.thresholdTokens)} tokens，输入侧 ×${formatDecimal(tier.inputMultiplier, 4)}、输出 ×${formatDecimal(tier.outputMultiplier, 4)}`;
}

/** 成本构成逐项（中文标注 + 真实 token 数 + 单价 + 分项金额），供 ？浮窗按行展示。 */
export function costComponentLines(item: CostFormulaItem): string[] {
  return [
    ...(item.longContextTier ? [longContextTierLine(item.longContextTier)] : []),
    `非缓存输入 ${formatInteger(item.inputTokens)} × ${formatUnitPrice(item.inputUnitPrice)} = ${formatDetailMoney(item.inputCost)}`,
    `缓存读取 ${formatInteger(item.cacheReadTokens)} × ${formatUnitPrice(item.cacheReadUnitPrice)} = ${formatDetailMoney(item.cacheReadCost)}`,
    `缓存写入 ${formatInteger(item.cacheCreationTokens)} × ${formatUnitPrice(item.cacheWriteUnitPrice)} = ${formatDetailMoney(item.cacheCreationCost)}`,
    `输出 ${formatInteger(item.outputTokens)} × ${formatUnitPrice(item.outputUnitPrice)} = ${formatDetailMoney(item.outputCost)}`,
  ];
}

/** 折算行：结算系数非 1（如 1:16、7.1）时说明原币种 → 人民币；1:1 结算不追加噪音行。 */
function fxConversionLines(item: CostFormulaItem, cnyValue: number | undefined): string[] {
  if (item.fxRateToCny === undefined || item.fxRateToCny === 1) return [];
  const currencyLabel = item.currency === "CNY" ? "牌价" : `${item.currency ?? "USD"} 牌价`;
  return [
    `× 结算系数 ${formatDecimal(item.fxRateToCny, 8)}（入账时冻结，${currencyLabel} → 人民币）`,
    `人民币合计 ${formatDetailMoney(cnyValue)}`,
  ];
}

/**
 * 供应商成本 = 原币种分项合计（2026-09-23 用户确认：明细行的 供应商成本/按量倍率后成本
 * 为原币种分解视图，不做结算折算；人民币结论统一看 估算真实成本）。
 */
export function costDetailFormula(item: CostFormulaItem): string {
  return [...costComponentLines(item), `供应商成本合计 ${formatVendorMoney(item.vendorCost, true)}`].join("\n");
}

export function actualCostDetailFormula(item: CostFormulaItem): string {
  return [
    ...costComponentLines(item),
    `× 价格倍率 ${formatDecimal(item.rateMultiplier, 4)}`,
    `估算真实成本 ${formatDetailMoney(item.actualCost)}`,
    ...fxConversionLines(item, item.actualCostCny),
  ].join("\n");
}

/**
 * 按量倍率后成本（原币种、未乘结算系数）的计算过程；供会话追踪「价格成本」面板的
 * 分解字段复用（估算真实成本的完整折算链见 actualCostDetailFormula）。
 */
export function multipliedCostDetailFormula(item: CostFormulaItem): string {
  return [
    ...costComponentLines(item),
    `× 价格倍率 ${formatDecimal(item.rateMultiplier, 4)}`,
    `按量倍率后成本 ${formatDetailMoney(item.actualCost)}`,
  ].join("\n");
}

/** 套餐估算折算明细（入账冻结的 plan_estimate_detail_json 投影）。 */
export interface PlanEstimateDetailInput {
  monthlyFee?: number;
  consumed?: number;
  consumedBasis?: string;
  quotaTotal?: number;
  windowDays?: number;
  windowLabel?: string;
  fxUsdCny?: number;
  /** quota_delta（额度差分回填，v49）依据字段。 */
  usedFrom?: number;
  usedTo?: number;
  total?: number;
  deltaUsed?: number;
  periodFrom?: string;
  periodTo?: string;
  shareOfMarketCost?: number;
  currency?: string;
  /** ratio_fallback（2026-10-09 A1）依据字段：历史窗口行按已结算比率兜底。 */
  fallbackRatio?: number;
  evidenceRows?: number;
  evidenceMarketCny?: number;
  evidenceEstimateCny?: number;
  /** reset_residual（2026-10-09 A2）依据字段：闭窗残差中点。 */
  midpointPercent?: number;
  /** market_share 逐步公式依据（2026-09-30）：市价消耗（USD）、请求模型、档位与档位月度额度。 */
  consumedUsd?: number;
  modelId?: string;
  planTier?: string;
  monthlyLimitUsd?: number;
  /** quota_delta 差分段内参与分摊的请求数（结算时冻结）。 */
  requestCount?: number;
}

/**
 * detail 白名单共享解析器（2026-10-09 B4，事故教训：三份白名单漂移）：
 * 接受 JSON 字符串（账本列/查询投影）或已解析对象（workbench 客户端响应），
 * 字段非法即整体缺省。此前 token-pricing.ts / workbench-queries.ts /
 * workbench-step-pages.ts 各持一份白名单，quota_delta 字段在第三份被剥掉导致
 * 会话追踪公式浮窗永不渲染——三处必须且只能共用本实现。
 */
export function parsePlanEstimateDetailRecord(value: unknown): PlanEstimateDetailInput | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (!value || value.length > 4096) return undefined;
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const pickNumber = (key: string): number | undefined =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
  const pickString = (key: string): string | undefined =>
    typeof record[key] === "string" && record[key] ? record[key] as string : undefined;
  const detail: PlanEstimateDetailInput = {
    ...(pickNumber("monthlyFee") !== undefined ? {monthlyFee: pickNumber("monthlyFee")} : {}),
    ...(pickNumber("consumed") !== undefined ? {consumed: pickNumber("consumed")} : {}),
    ...(pickString("consumedBasis") !== undefined ? {consumedBasis: pickString("consumedBasis")} : {}),
    ...(pickNumber("quotaTotal") !== undefined ? {quotaTotal: pickNumber("quotaTotal")} : {}),
    ...(pickNumber("windowDays") !== undefined ? {windowDays: pickNumber("windowDays")} : {}),
    ...(pickString("windowLabel") !== undefined ? {windowLabel: pickString("windowLabel")} : {}),
    ...(pickNumber("fxUsdCny") !== undefined ? {fxUsdCny: pickNumber("fxUsdCny")} : {}),
    ...(pickNumber("consumedUsd") !== undefined ? {consumedUsd: pickNumber("consumedUsd")} : {}),
    ...(pickString("modelId") !== undefined ? {modelId: pickString("modelId")} : {}),
    ...(pickString("planTier") !== undefined ? {planTier: pickString("planTier")} : {}),
    ...(pickNumber("monthlyLimitUsd") !== undefined ? {monthlyLimitUsd: pickNumber("monthlyLimitUsd")} : {}),
    ...(pickNumber("usedFrom") !== undefined ? {usedFrom: pickNumber("usedFrom")} : {}),
    ...(pickNumber("usedTo") !== undefined ? {usedTo: pickNumber("usedTo")} : {}),
    ...(pickNumber("total") !== undefined ? {total: pickNumber("total")} : {}),
    ...(pickNumber("deltaUsed") !== undefined ? {deltaUsed: pickNumber("deltaUsed")} : {}),
    ...(pickString("periodFrom") !== undefined ? {periodFrom: pickString("periodFrom")} : {}),
    ...(pickString("periodTo") !== undefined ? {periodTo: pickString("periodTo")} : {}),
    ...(pickNumber("shareOfMarketCost") !== undefined ? {shareOfMarketCost: pickNumber("shareOfMarketCost")} : {}),
    ...(pickString("currency") !== undefined ? {currency: pickString("currency")} : {}),
    ...(pickNumber("fallbackRatio") !== undefined ? {fallbackRatio: pickNumber("fallbackRatio")} : {}),
    ...(pickNumber("evidenceRows") !== undefined ? {evidenceRows: pickNumber("evidenceRows")} : {}),
    ...(pickNumber("evidenceMarketCny") !== undefined ? {evidenceMarketCny: pickNumber("evidenceMarketCny")} : {}),
    ...(pickNumber("evidenceEstimateCny") !== undefined ? {evidenceEstimateCny: pickNumber("evidenceEstimateCny")} : {}),
    ...(pickNumber("midpointPercent") !== undefined ? {midpointPercent: pickNumber("midpointPercent")} : {}),
    ...(pickNumber("requestCount") !== undefined ? {requestCount: pickNumber("requestCount")} : {}),
  };
  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** note 组装上下文（2026-10-09 B2/B3）：查看者时区 + 本行市价与四项单价分解。 */
export interface PlanEstimateNoteContext {
  /** IANA 时区（右上角全局偏好）；缺省按 UTC 展示。 */
  timeZone?: string;
  /** 本行市价（人民币）——与份额反推周期市价合计。 */
  rowMarketCny?: number;
  /** 本行市价原币种（标 $/￥）。 */
  marketCurrency?: string;
  /** 市价四项分解（原币种）：单价 × token 数。 */
  marketComponents?: ReadonlyArray<{label: string; unitPrice?: number; tokens: number; cost?: number}>;
}

/** 时刻 → 查看者时区展示（纯函数，服务端/客户端同实现）：缺省/非法回退 UTC。 */
export function zonedMinuteText(iso: string | undefined, timeZone?: string): string {
  if (!iso) return "?";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const zone = timeZone && timeZone.trim() ? timeZone.trim() : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "shortOffset",
    }).formatToParts(new Date(ms));
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find(part => part.type === type)?.value ?? "";
    // ICU 版本差异：零偏移在旧版输出 "GMT"（省略 +0）、新版输出 "UTC+0"/"GMT+0"，统一归一为 "UTC"。
    const offset = (get("timeZoneName") || "UTC")
      .replace(/^GMT/, "UTC")
      .replace(/^UTC[+-]0+(?::00)?$/, "UTC");
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${offset}`;
  } catch {
    return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/**
 * 套餐「积分 → 金额」换算链（2026-09-23 共享；2026-09-28 统一人民币口径）：
 * 月费 × 消耗比率 × 窗口天数折算，全部取入账冻结值。estimatedCost 入参两个消费端
 * （Token 价格页与会话追踪 Step 面板）统一传**人民币终值**（= plan_estimated_cost_nano/1e9，
 * 或极旧行 原币 × 入账冻结汇率），末行金额据此标注人民币；月费行仍如实标注原币种与入账汇率。
 * 关键字段缺失时返回 undefined（消费端跳过该段，不虚构）。
 */
export function planEstimateConversionNote(
  detail: PlanEstimateDetailInput,
  estimatedCost: number,
  currency?: string,
  context?: PlanEstimateNoteContext,
): string | undefined {
  /* 比率兜底（2026-10-09 A1）：早于最早额度快照的历史行，按该目标已结算行的
     估算÷市价 比率一次性补算。守卫只看本分支自需字段。 */
  if (detail.consumedBasis === "ratio_fallback") {
    if (detail.fallbackRatio === undefined || detail.monthlyFee === undefined) return undefined;
    if (context?.rowMarketCny === undefined) return undefined;
    const evidence = detail.evidenceRows !== undefined
      ? `（依据：该目标已结算 ${detail.evidenceRows} 条请求，市价合计 ￥${formatNoteMoney(detail.evidenceMarketCny ?? 0)} → 估算合计 ￥${formatNoteMoney(detail.evidenceEstimateCny ?? 0)}）`
      : "";
    return [
      `历史窗口 · 比率兜底（近似）：本请求早于最早的额度快照，无法差分归属${evidence}`,
      `兜底比率 = 已结算估算合计 ÷ 已结算市价合计 = ${formatNoteMoney(detail.fallbackRatio)}`,
      `本请求市价 ￥${formatNoteMoney(context.rowMarketCny)} × 比率 ${formatNoteMoney(detail.fallbackRatio)}`,
      `≈ 估算真实成本（比率兜底估算） ￥${formatNoteMoney(estimatedCost)}（人民币，入账时冻结）`,
    ].join("\n");
  }
  /* reset 残差中点（2026-10-09 A2）：闭窗最后一段的消耗在整数刻度下 ∈ [0, 1%)，
     取中点估算，误差每周有界（±0.5%×窗口价值）。 */
  if (detail.consumedBasis === "reset_residual") {
    if (detail.monthlyFee === undefined || detail.windowDays === undefined || detail.total === undefined) return undefined;
    const feeCurrencyLabel = (detail.currency ?? "CNY") === "USD"
      ? ` USD（入账汇率 ${detail.fxUsdCny ?? "-"}）`
      : " CNY";
    const fx = (detail.currency ?? "CNY") === "USD" ? (detail.fxUsdCny ?? 1) : 1;
    const midpoint = detail.midpointPercent ?? 0.5;
    const residualValueCny = detail.monthlyFee * fx * (detail.windowDays / 30) * (midpoint / 100);
    const share = detail.shareOfMarketCost ?? 0;
    return [
      `窗口重置残差 · 中点估算（近似）：周期 ${zonedMinuteText(detail.periodFrom, context?.timeZone)} → ${zonedMinuteText(detail.periodTo, context?.timeZone)}`,
      `窗口 ${planWindowLabel(detail.windowLabel)}关闭时额度消耗 ${detail.usedTo ?? "-"}%，整数刻度下最后一段消耗 ∈ [${detail.usedTo ?? 0}%, ${(detail.usedTo ?? 0) + 1}%)，取中点 ${midpoint}% 估算`,
      `残差价值 ≈ 月费 ${formatNoteMoney(detail.monthlyFee)}${feeCurrencyLabel} × ${detail.windowDays}/30 天 × ${midpoint}/${detail.total} = ￥${formatNoteMoney(residualValueCny)}（时间份额假设，非官方公式）`,
      `本请求按市价份额分摊：占周期内 ${share < 0.0001 ? "<0.01" : formatNoteMoney(share * 100)}% → ￥${formatNoteMoney(residualValueCny * share)}`,
      `≈ 估算真实成本（窗口重置残差估算） ￥${formatNoteMoney(estimatedCost)}（人民币，入账时冻结）`,
    ].join("\n");
  }
  /* 额度差分估算（2026-09-29 二期；2026-10-09 解锁渲染 + 份额全链路展开）：
     按入账冻结的差分依据还原估算链，始终标注时间份额假设与「近似」语义，
     不冒充官方公式。差分 detail 本就没有 consumed/quotaTotal 键，守卫按本分支
     自需字段判断。 */
  if (detail.consumedBasis === "quota_delta") {
    if (
      detail.monthlyFee === undefined
      || detail.windowDays === undefined
      || detail.deltaUsed === undefined
      || detail.total === undefined
    ) return undefined;
    const feeCurrencyLabel = (detail.currency ?? "CNY") === "USD"
      ? ` USD（入账汇率 ${detail.fxUsdCny ?? "-"}）`
      : " CNY";
    const fx = (detail.currency ?? "CNY") === "USD" ? (detail.fxUsdCny ?? 1) : 1;
    const periodValueCny = detail.monthlyFee * fx * (detail.windowDays / 30) * (detail.deltaUsed / (detail.total > 0 ? detail.total : 100));
    const share = detail.shareOfMarketCost ?? 0;
    const sharePercent = share < 0.0001 ? "<0.01" : formatNoteMoney(share * 100);
    const lines = [
      `额度差分估算（近似）：周期 ${zonedMinuteText(detail.periodFrom, context?.timeZone)} → ${zonedMinuteText(detail.periodTo, context?.timeZone)}`,
      `窗口 ${planWindowLabel(detail.windowLabel)}额度消耗 ${detail.usedFrom ?? "-"}% → ${detail.usedTo ?? "-"}%（Δ ${detail.deltaUsed} ÷ 总额度 ${detail.total}）`,
      `周期价值 ≈ 月费 ${formatNoteMoney(detail.monthlyFee)}${feeCurrencyLabel} × ${detail.windowDays}/30 天 × 消耗比例 = ￥${formatNoteMoney(periodValueCny)}（时间份额假设，非官方公式）`,
    ];
    /* 份额全链路（2026-10-09 B3）：周期市价合计由「本行市价 ÷ 冻结份额」精确反推
       （份额为全精度冻结），四项分解列单价 × token 数。缺上下文时回退单行占比。 */
    const rowMarket = context?.rowMarketCny;
    if (rowMarket !== undefined && Number.isFinite(rowMarket) && rowMarket > 0 && share > 0) {
      const periodMarketCny = rowMarket / share;
      const requestLabel = detail.requestCount !== undefined ? `${detail.requestCount} 条请求` : "全部请求";
      lines.push(`周期内共 ${requestLabel} · 市价合计 ￥${formatNoteMoney(periodMarketCny)}`);
      const components = (context?.marketComponents ?? [])
        .filter(component => component.tokens > 0 || (component.cost ?? 0) > 0);
      if (components.length > 0) {
        const currencySymbol = context?.marketCurrency === "CNY" ? "￥" : context?.marketCurrency === "USD" ? "$" : "";
        const componentText = components.map(component => {
          const price = component.unitPrice !== undefined
            ? `${currencySymbol}${formatNoteMoney(component.unitPrice)}/M × ${component.tokens.toLocaleString()} tok`
            : "单价缺失";
          return `  ${component.label} ${currencySymbol}${formatNoteMoney(component.cost ?? 0)} = ${price}`;
        }).join("\n");
        lines.push(`本请求市价 ￥${formatNoteMoney(rowMarket)}（原币种分解，见下行）：\n${componentText}`);
      } else {
        lines.push(`本请求市价 ￥${formatNoteMoney(rowMarket)}`);
      }
      lines.push(`份额 = ￥${formatNoteMoney(rowMarket)} ÷ ￥${formatNoteMoney(periodMarketCny)} = ${sharePercent}% → ￥${formatNoteMoney(periodValueCny)} × ${sharePercent}% = ￥${formatNoteMoney(periodValueCny * share)}`);
    } else {
      lines.push(`本请求按市价份额分摊：占周期内 ${sharePercent}% → ￥${formatNoteMoney(periodValueCny * share)}`);
    }
    lines.push(`≈ 估算真实成本（额度差分估算） ￥${formatNoteMoney(estimatedCost)}（人民币，入账时冻结）`);
    return lines.join("\n");
  }
  if (
    detail.consumed === undefined
    || detail.quotaTotal === undefined
    || detail.monthlyFee === undefined
  ) return undefined;
  /* 量纲守卫（2026-09-29 一期）：市价回退被拦截的行（market_blocked）没有合法折算链，
     不生成折算文案、不冒充公式，只提示不可估算原因与后续差分估算的入口。 */
  if (detail.consumedBasis === "market_blocked") {
    return [
      "订阅/套餐额度制暂无逐请求计费公式：市价消耗与额度刻度（percent/积分/AFP）量纲不一致，不折算估算。",
      "开启套餐用量自动同步并积累额度消耗后，将按额度差分自动估算。",
    ].join("\n");
  }
  const consumedLabel = detail.consumedBasis === "credits" ? "消耗积分" : "消耗市价（美元额度口径，OpenCode Go）";
  const feeCurrencyLabel = (currency ?? "CNY") === "USD"
    ? ` USD（入账汇率 ${detail.fxUsdCny ?? "-"}）`
    : " CNY";
  /* market_share 逐步公式（2026-09-30 用户确认）：每行把「人民币数值 = 美元原值 ×
     入账汇率」的换算过程写全，分母与月费都标注来源（模型×档位月度额度 / 档位月费）。
     四件套齐备才走逐步行；旧行缺字段回退下方通用两行。 */
  if (
    detail.consumedBasis === "market_cny"
    && detail.consumedUsd !== undefined
    && detail.modelId !== undefined
    && detail.planTier !== undefined
    && detail.monthlyLimitUsd !== undefined
    && detail.fxUsdCny !== undefined
  ) {
    const fx = detail.fxUsdCny;
    return [
      `本请求${consumedLabel} ￥${formatNoteMoney(detail.consumed)} = $${formatNoteMoney(detail.consumedUsd)} ×（入账汇率 ${formatNoteMoney(fx)}）`,
      `÷ 窗口总额度 ￥${formatNoteMoney(detail.quotaTotal)}（${detail.windowLabel ?? `${detail.windowDays ?? "?"} 天`}）= 模型 ${detail.modelId} 对应月度额度 $${formatNoteMoney(detail.monthlyLimitUsd)} ×（入账汇率 ${formatNoteMoney(fx)}）`,
      `× 套餐月费 ￥${formatNoteMoney((detail.monthlyFee ?? 0) * fx)} = ${planTierDisplayName(detail.planTier)}月费 $${formatNoteMoney(detail.monthlyFee ?? 0)} ×（入账汇率 ${formatNoteMoney(fx)}）`,
      `× 窗口天数 ${detail.windowDays ?? "?"}/30`,
      `≈ 估算真实成本（套餐成本估算） ￥${formatNoteMoney(estimatedCost)}（人民币，入账时冻结）`,
    ].join("\n");
  }
  return [
    `本请求${consumedLabel} ${formatNoteMoney(detail.consumed)}`,
    `÷ 窗口总额度 ${formatNoteMoney(detail.quotaTotal)}（${detail.windowLabel ?? `${detail.windowDays ?? "?"} 天`}）`,
    `× 套餐月费 ${formatNoteMoney(detail.monthlyFee)}${feeCurrencyLabel}`,
    `× 窗口天数 ${detail.windowDays ?? "?"}/30`,
    `≈ 估算真实成本（套餐成本估算） ￥${formatNoteMoney(estimatedCost)}（人民币，入账时冻结）`,
  ].join("\n");
}

/** 档位 ID → 展示名（"go" → "Go 档位"、"go-plus" → "Go Plus 档位"）。 */
function planTierDisplayName(planTier: string): string {
  const name = planTier
    .split("-")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${name} 档位`;
}

function formatNoteMoney(value: number): string {
  return value.toLocaleString(undefined, {maximumFractionDigits: 6});
}

/** 锚窗展示名：monthly/30d → 月窗、weekly 系 → 周窗、5h → 5 小时窗。 */
function planWindowLabel(windowLabel: string | undefined): string {
  switch (windowLabel) {
    case "monthly":
    case "30d":
      return "月窗 ";
    case "weekly":
      return "周窗 ";
    case "weekly_opus":
      return "Opus 周窗 ";
    case "weekly_sonnet":
      return "Sonnet 周窗 ";
    case "5h":
      return "5 小时窗 ";
    default:
      return windowLabel ? `${windowLabel} ` : "";
  }
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
