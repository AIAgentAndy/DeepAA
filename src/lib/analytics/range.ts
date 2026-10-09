import type {AnalyticsPreset, AnalyticsRangeResult, AnalyticsGranularity} from "./types";

export const DASHBOARD_PRESETS: readonly AnalyticsPreset[] = [
  "today",
  "24h",
  "this_week",
  "7d",
  "this_month",
  "30d",
];

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
interface ResolveAnalyticsRangeInput {
  preset?: string;
  timezone?: string;
  now?: string | number | Date;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/**
 * 将 Dashboard preset 转换为 UTC 查询窗口。
 * 所有日期边界先按用户时区计算，再转换为 UTC，避免夏令时和月末截断错误。
 */
export function resolveAnalyticsRange(
  input: ResolveAnalyticsRangeInput = {},
): AnalyticsRangeResult {
  const preset = normalizePreset(input.preset);
  const timezone = normalizeTimezone(input.timezone);
  const nowMs = normalizeNow(input.now);
  const now = new Date(nowMs);
  const currentLocal = zonedParts(nowMs, timezone);
  const currentLocalDate = calendarDate(currentLocal);

  let range: {start: number; end: number};
  let granularity: AnalyticsGranularity;

  switch (preset) {
    case "today": {
      const start = localDateTimeToUtc(currentLocalDate, timezone);
      range = {start, end: nowMs};
      granularity = "hour";
      break;
    }
    case "24h": {
      range = {start: nowMs - DAY_MS, end: nowMs};
      granularity = "hour";
      break;
    }
    case "this_week": {
      const start = localDateTimeToUtc(startOfWeek(currentLocalDate), timezone);
      range = {start, end: nowMs};
      granularity = "day";
      break;
    }
    case "7d": {
      range = {start: nowMs - 7 * DAY_MS, end: nowMs};
      granularity = "day";
      break;
    }
    case "this_month": {
      const start = localDateTimeToUtc({
        year: currentLocal.year,
        month: currentLocal.month,
        day: 1,
      }, timezone);
      range = {start, end: nowMs};
      granularity = "day";
      break;
    }
    case "30d": {
      range = {start: nowMs - 30 * DAY_MS, end: nowMs};
      granularity = "day";
      break;
    }
  }

  return {
    preset,
    timezone,
    range: isoWindow(range),
    granularity,
    now: now.toISOString(),
  };
}

function normalizePreset(value: string | undefined): AnalyticsPreset {
  const preset = value || "today";
  if ((DASHBOARD_PRESETS as readonly string[]).includes(preset)) {
    return preset as AnalyticsPreset;
  }
  throw new Error(`不支持的 Dashboard 时间范围：${preset}`);
}

export interface DashboardRangeResult {
  timezone: string;
  /** 查询窗口（含 start，不含 end），ISO UTC。 */
  range: {start: string; end: string};
  granularity: AnalyticsGranularity;
  /** hour 表示小时数，day 表示本地自然日数。 */
  bucketStep: number;
  /** 窗口毫秒长度。 */
  spanMs: number;
  /** 主序列桶数（小时粒度 = 小时数；按天粒度 = 天数）。 */
  bucketCount: number;
}

interface ResolveDashboardRangeInput {
  start?: string;
  end?: string;
  timezone?: string;
  now?: string | number | Date;
}

const WALL_CLOCK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u;

/**
 * 解析仪表盘自定义「开始 / 结束」小时范围。
 * - 边界接受 datetime-local 墙钟时间（按 timezone 解释）或带时区的 ISO 串；
 * - 分钟及以下一律向下取整到小时（最小聚合粒度为小时）；
 * - end 为排他边界：「08-27 00 ~ 08-28 00」即 27 日全天；
 * - 跨度不设上限（小时事实永久保存，2026-09-21 用户确认）；按跨度选择
 *   1h/2h/3h/6h/1d/3d/7d/14d/30d 自适应桶，保证长范围的数据点数有界。
 */
export function resolveDashboardRange(
  input: ResolveDashboardRangeInput = {},
): DashboardRangeResult {
  const timezone = normalizeTimezone(input.timezone);
  const nowMs = normalizeNow(input.now);

  let startMs: number;
  let endMs: number;
  if (input.start === undefined && input.end === undefined) {
    startMs = localDateTimeToUtc(calendarDate(zonedParts(nowMs, timezone)), timezone);
    endMs = startMs + DAY_MS;
  } else {
    if (typeof input.start !== "string" || typeof input.end !== "string") {
      throw new Error("start 与 end 必须同时提供。");
    }
    startMs = parseHourBoundary(input.start, timezone, "start");
    endMs = parseHourBoundary(input.end, timezone, "end");
  }

  const spanMs = endMs - startMs;
  if (spanMs <= 0) throw new Error("结束时间必须晚于开始时间。");

  const {granularity, bucketStep} = dashboardBucketSize(spanMs);
  const unitMs = granularity === "hour" ? HOUR_MS : DAY_MS;
  const bucketCount = Math.ceil(spanMs / (unitMs * bucketStep));

  return {
    timezone,
    range: {start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString()},
    granularity,
    bucketStep,
    spanMs,
    bucketCount,
  };
}

/** 固定候选粒度保证长范围也维持约 13~31 个可读数据点（跨度不设上限）。 */
function dashboardBucketSize(spanMs: number): {granularity: AnalyticsGranularity; bucketStep: number} {
  if (spanMs <= DAY_MS) return {granularity: "hour", bucketStep: 1};
  if (spanMs <= 2 * DAY_MS) return {granularity: "hour", bucketStep: 2};
  if (spanMs <= 3 * DAY_MS) return {granularity: "hour", bucketStep: 3};
  if (spanMs <= 7 * DAY_MS) return {granularity: "hour", bucketStep: 6};
  if (spanMs <= 31 * DAY_MS) return {granularity: "day", bucketStep: 1};
  if (spanMs <= 90 * DAY_MS) return {granularity: "day", bucketStep: 3};
  if (spanMs <= 180 * DAY_MS) return {granularity: "day", bucketStep: 7};
  if (spanMs <= 365 * DAY_MS) return {granularity: "day", bucketStep: 14};
  return {granularity: "day", bucketStep: 30};
}

/** 解析单个边界：墙钟时间按 timezone 解释，带时区偏移的 ISO 直接解析；统一向下取整到小时。 */
function parseHourBoundary(value: string, timezone: string, label: string): number {
  const trimmed = value.trim();
  let ms: number;
  if (WALL_CLOCK_RE.test(trimmed)) {
    const [datePart, timePart] = trimmed.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      throw new Error(`无效的${label === "start" ? "开始" : "结束"}时间：${value}`);
    }
    ms = localDateTimeToUtc({year, month, day, hour, minute: minute ?? 0}, timezone);
  } else {
    ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) throw new Error(`无效的${label === "start" ? "开始" : "结束"}时间：${value}`);
  }
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function normalizeTimezone(value: string | undefined): string {
  const timezone = value || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: timezone}).format();
    return timezone;
  } catch {
    throw new Error(`无效的 IANA 时区：${timezone}`);
  }
}

function normalizeNow(value: string | number | Date | undefined): number {
  const now = value instanceof Date ? value.getTime() : value === undefined ? Date.now() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(now)) throw new Error("now 必须是有效时间。");
  return now;
}

function isoWindow(window: {start: number; end: number}): {start: string; end: string} {
  return {
    start: new Date(window.start).toISOString(),
    end: new Date(window.end).toISOString(),
  };
}

function zonedParts(timestamp: number, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
    .filter(part => part.type !== "literal")
    .map(part => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
    millisecond: new Date(timestamp).getUTCMilliseconds(),
  };
}

function localDateTimeToUtc(parts: Partial<ZonedParts> & Pick<ZonedParts, "year" | "month" | "day">, timezone: string): number {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.millisecond ?? 0,
  );
  let candidate = localAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = Date.UTC(...dateParts(zonedParts(candidate, timezone))) - candidate;
    const next = localAsUtc - offset;
    if (next === candidate) return next;
    candidate = next;
  }
  return candidate;
}

function dateParts(parts: ZonedParts): [number, number, number, number, number, number, number] {
  return [parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond];
}

function calendarDate(parts: ZonedParts): Pick<ZonedParts, "year" | "month" | "day"> {
  return {year: parts.year, month: parts.month, day: parts.day};
}

function startOfWeek(date: Pick<ZonedParts, "year" | "month" | "day">): Pick<ZonedParts, "year" | "month" | "day"> {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(date.year, date.month - 1, date.day - daysFromMonday));
  return {year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate()};
}
