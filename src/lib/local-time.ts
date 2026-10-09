type DateInput = string | number | Date | undefined | null;

/**
 * 全站统一时区（2026-09-10 用户决策）：会话追踪与交互内容的时间展示
 * 同样按右上角全局时区换算，未设置时回退东八区（与仪表盘/Token 价格一致）。
 * 这里直接读 localStorage，保持本模块为纯工具函数；调用方组件通过
 * `useGlobalTimeZone()` 订阅变更以获得重渲染。
 */
const GLOBAL_TZ_STORAGE_KEY = "deepaa.timezone";
const TZ_OFFSET_BY_VALUE: Record<string, number> = {
  "UTC-8": -480, "UTC-6": -360, "UTC-5": -300, "UTC+0": 0, "UTC+1": 60,
  "UTC+3": 180, "UTC+4": 240, "UTC+7": 420, "UTC+8": 480, "UTC+9": 540, "UTC+10": 600,
};

function globalOffsetMinutes(): number {
  if (typeof window === "undefined") return 480;
  try {
    const stored = window.localStorage.getItem(GLOBAL_TZ_STORAGE_KEY);
    if (stored && stored in TZ_OFFSET_BY_VALUE) return TZ_OFFSET_BY_VALUE[stored]!;
  } catch {
    /* 读取失败回退东八区。 */
  }
  return 480;
}

/** 按全局时区偏移换算为墙钟字段（用于自定义格式化）。 */
function shifted(date: Date, offsetMinutes: number): Date {
  return new Date(date.getTime() + offsetMinutes * 60_000);
}

function parseDate(value: DateInput): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 按全局时区展示到分钟（未设置时东八区），避免把 UTC 字段误认为本地时间。 */
export function formatLocalMinute(value: DateInput): string {
  const date = parseDate(value);
  if (!date) return "-";
  const local = shifted(date, globalOffsetMinutes());
  return `${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
}

/** 按全局时区展示完整秒级时间（未设置时东八区），供表格和导出信息使用。 */
export function formatLocalDateTime(value: DateInput): string {
  const date = parseDate(value);
  if (!date) return typeof value === "string" && value ? value : "-";
  const local = shifted(date, globalOffsetMinutes());
  return `${local.getUTCFullYear()}/${pad2(local.getUTCMonth() + 1)}/${pad2(local.getUTCDate())}`
    + ` ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
}

/** 按全局时区展示到秒的时刻（HH:MM:SS），供时间线节点的右侧时间戳使用。 */
export function formatLocalClock(value: DateInput): string {
  const date = parseDate(value);
  if (!date) return "-";
  const local = shifted(date, globalOffsetMinutes());
  return `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
}

export function formatRelativeLocalTime(value: DateInput, nowMs = Date.now()): string {
  const date = parseDate(value);
  if (!date) return "-";
  const diffMins = Math.max(0, Math.floor((nowMs - date.getTime()) / 60_000));
  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins} 分钟前`;
  return formatLocalMinute(date);
}

/** 按指定 UTC 偏移（分钟）把绝对时间转成该时区的本地时间展示串；不传则用浏览器时区。 */
export function toDatetimeLocalValue(date: Date, offsetMinutes?: number): string {
  if (offsetMinutes === undefined) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
}

/** 将 ISO/URL 时间参数转成 datetime-local 需要的本地时间字符串。 */
export function isoToDatetimeLocalValue(value: string | null | undefined, offsetMinutes?: number): string {
  const raw = value?.trim();
  if (!raw) return "";
  const date = parseDate(raw);
  if (date) return toDatetimeLocalValue(date, offsetMinutes);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(raw) ? raw.slice(0, 19) : "";
}

/** 将 datetime-local 的本地时间输入转成 ISO，保持 API 查询参数语义为绝对时间。 */
export function datetimeLocalValueToIso(value: string, offsetMinutes?: number): string {
  if (offsetMinutes === undefined) {
    const date = parseDate(value);
    return date ? date.toISOString() : value;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/u.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second ?? 0),
  ) - offsetMinutes * 60_000);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
