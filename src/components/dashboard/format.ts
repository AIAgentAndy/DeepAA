/** 仪表盘共用数字/时间格式化（与定稿 demo 的展示口径一致）。 */
import {formatMoneyValue} from "@/lib/money-display";

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function fmtInt(value: number): string {
  return new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 0}).format(Number.isFinite(value) ? value : 0);
}

export function fmtTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (value >= 1e7) return `${(value / 1e8).toFixed(2)} 亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return fmtInt(value);
}

/** 金额展示（2026-09-28 用户决策）：仪表盘金额均为人民币统一口径（nano 物化），带 ￥ 前缀。 */
export function fmtMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `￥${formatMoneyValue(value / 1e9, 2)}`;
}

/** 已折算金额（非 nano）的人民币展示；当前唯一消费方为趋势图例（同为人民币口径）。 */
export function fmtMoneyRaw(value: number): string {
  return `￥${formatMoneyValue(value, 2)}`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function fmtPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}

export function fmtCredit(value: number, unit: string | null): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const formatted = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 2}).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

/** 本地时间 -> datetime-local 输入值（分钟对齐到 00，匹配小时粒度）。 */
export function toHourInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
}

export function shiftLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 0, 0, 0, 0);
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function weekdayLabel(weekday: number): string {
  return WEEKDAYS[weekday] ?? "";
}

/** "2026-08-27" -> "08-27" */
export function shortDayKey(key: string): string {
  const parts = key.split("-");
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : key;
}
