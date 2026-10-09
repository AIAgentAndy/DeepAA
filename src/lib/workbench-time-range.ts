/**
 * 会话追踪页时间范围（页面私有参数，不属于六级公共业务路径）：
 * - start / end 均为 UTC ISO 字符串；start 含边界、end 排他。
 * - 会话命中语义：session 与 [start, end) 存在重叠（end_time >= start 且 start_time < end）。
 * - 跨度不设上限（2026-09-21 用户确认）：统一受存储管理的保留窗口约束，
 *   超窗数据可能不完整（查询区旁有提示），页面不再做 1 个月钳制。
 * - 输入/展示的 "YYYY-MM-DDTHH:mm" 墙钟串与 UTC 的互转全部按「右上角全局时区」偏移
 *   换算（2026-09-17 全站时区统一，不再使用浏览器本地时区）；offsetMinutes 由调用方
 *   从 useGlobalTimeZone() 注入，服务端缺省东八区。
 */

export const WORKBENCH_RANGE_PARAM_KEYS = ["start", "end"] as const;

/** 默认展示范围：「今天」（全局时区当日 00:00 → 明日 00:00，2026-09-17 用户确认）。 */
export const WORKBENCH_DEFAULT_RANGE_DAYS = 1;

export interface WorkbenchRange {
  start: string;
  end: string;
}

export interface WorkbenchRangePreset {
  key: "today" | "yesterday" | "24h" | "3d" | "7d" | "15d";
  label: string;
}

export const WORKBENCH_RANGE_PRESETS: WorkbenchRangePreset[] = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "24h", label: "近 24 小时" },
  { key: "3d", label: "近 3 天" },
  { key: "7d", label: "近 7 天" },
  { key: "15d", label: "近 15 天" },
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 按时区偏移取「第 dayShift 天的 00:00」绝对时刻。
 * 先把当前时刻平移到该时区的墙钟，再以 UTC 日界取零点，最后平移回绝对时间。
 */
function startOfZonedDay(nowMs: number, offsetMinutes: number, dayShift = 0): Date {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + dayShift) - offsetMinutes * 60_000);
}

/**
 * 会话页时间选择器使用的 "YYYY-MM-DDTHH:mm"（或带 ":ss"）墙钟串 → UTC ISO。
 * 墙钟按 offsetMinutes 解释（全局时区）；非法输入返回 undefined。
 */
export function datetimeLocalToIso(value: string, offsetMinutes = 480): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second ?? 0),
  ) - offsetMinutes * 60_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** UTC ISO → 指定时区的 "YYYY-MM-DDTHH:mm:ss" 墙钟串；非法输入返回 undefined。 */
export function isoToDatetimeLocal(iso: string, offsetMinutes = 480): string | undefined {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const shifted = new Date(parsed.getTime() + offsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/** 默认范围：「今天」（全局时区当日 00:00 → 明日 00:00）。 */
export function defaultWorkbenchRange(
  now = new Date(),
  offsetMinutes = 480,
): WorkbenchRange {
  const start = startOfZonedDay(now.getTime(), offsetMinutes);
  const end = startOfZonedDay(now.getTime(), offsetMinutes, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** 预设档位 → 当前范围；天级档位按全局时区自然日对齐，近 24 小时按分钟对齐。 */
export function workbenchRangeForPreset(
  key: WorkbenchRangePreset["key"],
  now = new Date(),
  offsetMinutes = 480,
): WorkbenchRange {
  const todayStart = startOfZonedDay(now.getTime(), offsetMinutes);
  const tomorrowStart = startOfZonedDay(now.getTime(), offsetMinutes, 1);
  switch (key) {
    case "today":
      return { start: todayStart.toISOString(), end: tomorrowStart.toISOString() };
    case "yesterday":
      return {
        start: startOfZonedDay(now.getTime(), offsetMinutes, -1).toISOString(),
        end: todayStart.toISOString(),
      };
    case "24h": {
      // 分秒级粒度：以当前分钟为锚，[now - 24h, now 整分钟 + 1min)。
      const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
      const minuteStart = Date.UTC(
        shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
        shifted.getUTCHours(), shifted.getUTCMinutes(),
      ) - offsetMinutes * 60_000;
      return {
        start: new Date(minuteStart - 24 * 60 * 60 * 1000).toISOString(),
        end: new Date(minuteStart + 60 * 1000).toISOString(),
      };
    }
    case "3d":
    case "7d":
    case "15d": {
      const days = key === "3d" ? 3 : key === "7d" ? 7 : 15;
      return {
        start: new Date(todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000).toISOString(),
        end: tomorrowStart.toISOString(),
      };
    }
  }
}

/**
 * 规范化用户选择：非法输入（解析失败或 end <= start）回退 undefined；
 * 跨度不设上限（2026-09-21 用户确认，统一受保留窗口约束）。
 */
export function normalizeWorkbenchRange(
  start: string | undefined,
  end: string | undefined,
): WorkbenchRange | undefined {
  const startDate = start ? new Date(start) : undefined;
  const endDate = end ? new Date(end) : undefined;
  if (!startDate || Number.isNaN(startDate.getTime())) return undefined;
  if (!endDate || Number.isNaN(endDate.getTime())) return undefined;
  if (endDate.getTime() <= startDate.getTime()) return undefined;
  return { start: startDate.toISOString(), end: endDate.toISOString() };
}

/** 判断当前 range 是否恰好等于某个预设（用于高亮预设 chip）。 */
export function matchWorkbenchRangePreset(
  range: WorkbenchRange,
  now = new Date(),
  offsetMinutes = 480,
): WorkbenchRangePreset["key"] | undefined {
  for (const preset of WORKBENCH_RANGE_PRESETS) {
    const candidate = workbenchRangeForPreset(preset.key, now, offsetMinutes);
    if (candidate.start === range.start && candidate.end === range.end) return preset.key;
  }
  return undefined;
}

/**
 * 从 URL/请求参数里解析可选时间范围：缺参或非法时返回 undefined（不过滤）。
 * 服务端查询与客户端恢复共用，保证语义一致。
 */
export function parseOptionalWorkbenchRange(
  params: URLSearchParams,
): WorkbenchRange | undefined {
  const start = params.get("start")?.trim() || undefined;
  const end = params.get("end")?.trim() || undefined;
  if (!start && !end) return undefined;
  return normalizeWorkbenchRange(start, end);
}

/**
 * 页面首屏参数：URL 显式携带 start/end 时校验；
 * 缺省时回退「今天」默认档，保证 SSR 首屏与客户端默认一致。
 * 服务端无 localStorage，offsetMinutes 缺省东八区；客户端挂载后按全局偏好校正。
 */
export function resolveWorkbenchRangeParams(
  values: Record<string, string | string[] | undefined>,
  now = new Date(),
  offsetMinutes = 480,
): WorkbenchRange {
  const start = typeof values.start === "string" ? values.start.trim() : "";
  const end = typeof values.end === "string" ? values.end.trim() : "";
  const normalized = (start || end) ? normalizeWorkbenchRange(start || undefined, end || undefined) : undefined;
  return normalized
    ? { start: normalized.start, end: normalized.end }
    : defaultWorkbenchRange(now, offsetMinutes);
}

/** 把范围写进 URLSearchParams（已规范化）。 */
export function appendWorkbenchRangeParams(
  params: URLSearchParams,
  range: WorkbenchRange,
): void {
  params.set("start", range.start);
  params.set("end", range.end);
}
