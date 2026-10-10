/**
 * 仪表盘 URL 时间参数编解码（2026-10-10 与会话追踪页统一）：
 * - URL start/end 统一写 UTC ISO 绝对时刻（与 workbench-time-range / token-pricing
 *   一致），链接不再依赖查看者的时区偏好，任何时区打开都是同一段数据窗口；
 * - 读路径双格式兼容：旧墙钟书签（YYYY-MM-DDTHH:mm）继续可用，按东八区缺省
 *   解释（timezones.ts「非法或缺省一律回退东八区」原则）；
 * - 组件内部状态仍是当前时区的墙钟串（HourPicker 依赖），墙钟 ↔ 绝对时刻的
 *   边界换算集中在本模块；
 * - 小时粒度：绝对时刻一律先向下取整到小时（UTC 时钟取整），与服务端
 *   resolveDashboardRange 的 parseHourBoundary 取整语义保持一致，保证读写往返不漂移。
 */

const HOUR_MS = 60 * 60 * 1_000;

/** 组件内部墙钟串格式（datetime-local 小时粒度，分钟可为任意值的历史输入）。 */
const WALL_HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;
/** 带时区标记的绝对 ISO（Z 或 ±HH:MM 偏移），兼容 toISOString 输出与会话页链接。 */
const ABSOLUTE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/u;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** 绝对时刻 → 指定时区墙钟的小时串（YYYY-MM-DDTHH:00，分钟截断）。 */
export function instantToWallHour(value: Date | number, offsetMinutes: number): string {
  const ms = typeof value === "number" ? value : value.getTime();
  const shifted = new Date(ms + offsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:00`;
}

/** 墙钟串（按 offsetMinutes 解释）→ 绝对时刻 ms；非法输入返回 NaN。 */
export function wallHourToInstant(wall: string, offsetMinutes: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute] = match;
  // 与服务端 parseHourBoundary 同样的字段范围校验：越界视为非法而不是静默滚动。
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31
    || Number(hour) > 23 || Number(minute) > 59) {
    return Number.NaN;
  }
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
    - offsetMinutes * 60_000;
}

/** 同一绝对时刻的墙钟串在新旧时区间重排：切时区窗口不平移（2026-10-10 行为统一）。 */
export function rebaseWallClockHour(wall: string, fromOffsetMinutes: number, toOffsetMinutes: number): string {
  const ms = wallHourToInstant(wall, fromOffsetMinutes);
  return Number.isFinite(ms) ? instantToWallHour(ms, toOffsetMinutes) : wall;
}

export interface DashboardRangeQuery {
  /** 当前时区墙钟串（YYYY-MM-DDTHH:mm）；explicit=false 时为空串。 */
  start: string;
  end: string;
  /** URL 是否显式携带了有效范围（UTC ISO 或旧墙钟格式）。 */
  explicit: boolean;
}

/**
 * 解析 /dashboard 的 start/end URL 参数（双格式兼容）：
 * - UTC ISO（含 ±HH:MM 偏移写法）：绝对时刻先取整到小时，再换算成 offsetMinutes
 *   时区的墙钟串；
 * - 旧墙钟书签：按 offsetMinutes 解释（页面首帧为东八区缺省），字符串原样保留。
 * 两端格式必须一致且 end > start，否则视为未携带（explicit=false，由调用方兜底默认）。
 */
export function parseDashboardRangeQuery(query: string, offsetMinutes = 480): DashboardRangeQuery {
  const params = new URLSearchParams(query);
  const start = params.get("start")?.trim();
  const end = params.get("end")?.trim();
  if (start && end) {
    if (ABSOLUTE_ISO_RE.test(start) && ABSOLUTE_ISO_RE.test(end)) {
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        return {
          start: instantToWallHour(floorHour(startMs), offsetMinutes),
          end: instantToWallHour(floorHour(endMs), offsetMinutes),
          explicit: true,
        };
      }
    } else if (WALL_HOUR_RE.test(start) && WALL_HOUR_RE.test(end)) {
      const startMs = wallHourToInstant(start, offsetMinutes);
      const endMs = wallHourToInstant(end, offsetMinutes);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        return {start, end, explicit: true};
      }
    }
  }
  return {start: "", end: "", explicit: false};
}

/** 墙钟范围 → UTC ISO URL 参数（先取整到小时，保证读写往返一致）；非法输入返回 undefined。 */
export function dashboardWallRangeToIso(start: string, end: string, offsetMinutes: number): {start: string; end: string} | undefined {
  const startMs = wallHourToInstant(start, offsetMinutes);
  const endMs = wallHourToInstant(end, offsetMinutes);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return undefined;
  return {
    start: new Date(floorHour(startMs)).toISOString(),
    end: new Date(floorHour(endMs)).toISOString(),
  };
}
