/**
 * 仪表盘与 Token 价格页共用的时区值域：固定偏移（无夏令时），默认东八区。
 * 仪表盘聚合链路（resolveDashboardRange 的 Intl 校验与本地日分桶）只接受
 * IANA 时区，因此每项附带等价 IANA 值：用 Etc/GMT 固定偏移区表达同一语义。
 * 注意 Etc/GMT 的符号方向与日常写法相反：UTC+8 → Etc/GMT-8。
 */
export interface TimeZoneOption {
  /** 下拉与 URL 参数取值：UTC±N 格式。 */
  value: string;
  label: string;
  /** 相对 UTC 的偏移分钟数（东八区 = 480），用于墙钟时间 ↔ 绝对时间换算。 */
  offsetMinutes: number;
  /** 仪表盘聚合使用的等价 IANA 时区（固定偏移，无夏令时）。 */
  iana: string;
}

export const TIME_ZONE_OPTIONS: TimeZoneOption[] = [
  {value: "UTC-8", label: "UTC-8（洛杉矶）", offsetMinutes: -480, iana: "Etc/GMT+8"},
  {value: "UTC-6", label: "UTC-6（芝加哥）", offsetMinutes: -360, iana: "Etc/GMT+6"},
  {value: "UTC-5", label: "UTC-5（纽约）", offsetMinutes: -300, iana: "Etc/GMT+5"},
  {value: "UTC+0", label: "UTC+0（伦敦）", offsetMinutes: 0, iana: "UTC"},
  {value: "UTC+1", label: "UTC+1（柏林）", offsetMinutes: 60, iana: "Etc/GMT-1"},
  {value: "UTC+3", label: "UTC+3（莫斯科）", offsetMinutes: 180, iana: "Etc/GMT-3"},
  {value: "UTC+4", label: "UTC+4（迪拜）", offsetMinutes: 240, iana: "Etc/GMT-4"},
  {value: "UTC+7", label: "UTC+7（曼谷）", offsetMinutes: 420, iana: "Etc/GMT-7"},
  {value: "UTC+8", label: "UTC+8（上海）", offsetMinutes: 480, iana: "Etc/GMT-8"},
  {value: "UTC+9", label: "UTC+9（东京）", offsetMinutes: 540, iana: "Etc/GMT-9"},
  {value: "UTC+10", label: "UTC+10（悉尼）", offsetMinutes: 600, iana: "Etc/GMT-10"},
];

export const DEFAULT_TIME_ZONE = "UTC+8";

export function isSupportedTimeZone(value: string): boolean {
  return TIME_ZONE_OPTIONS.some(option => option.value === value);
}

/** 非法或缺省时区一律回退东八区，与历史行为一致。 */
export function timeZoneOffsetMinutes(value: string): number {
  return TIME_ZONE_OPTIONS.find(option => option.value === value)?.offsetMinutes ?? 480;
}

export function timeZoneIana(value: string): string {
  return TIME_ZONE_OPTIONS.find(option => option.value === value)?.iana ?? "Etc/GMT-8";
}
