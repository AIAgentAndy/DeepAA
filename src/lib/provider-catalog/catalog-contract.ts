/**
 * 目录 v2 元信息契约（设计 4.1）：schemaVersion / catalogRevision / publishedAt(RFC 3339 带
 * 时区) / 公共日历 calendars 的校验入口与版本闸门比较。不承载业务计费判断。
 */
import {PROVIDER_CATALOG_SCHEMA_VERSION, type ProviderCatalog, type ProviderCatalogCalendar} from "./types";

/** catalogRevision 固定宽度、可字典序比较：YYYY.MM.DD.NN。 */
const CATALOG_REVISION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d{2}$/u;

/** publishedAt 正式格式：RFC 3339 且必须带时区（Z 或 ±HH:MM）。 */
const RFC3339_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function isValidCatalogRevision(value: unknown): value is string {
  return typeof value === "string" && CATALOG_REVISION_PATTERN.test(value);
}

export function isValidRfc3339WithZone(value: unknown): value is string {
  if (typeof value !== "string" || !RFC3339_WITH_ZONE_PATTERN.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * 比较两个目录版本的发布时间。必须解析为时间戳，不能直接比较 RFC3339
 * 字符串，否则 `Z` 与 `+08:00` 表达同一时刻时会产生错误顺序。
 */
export function compareCatalogPublishedAt(
  left: Pick<ProviderCatalog, "publishedAt">,
  right: Pick<ProviderCatalog, "publishedAt">,
): -1 | 0 | 1 {
  const leftAt = Date.parse(left.publishedAt);
  const rightAt = Date.parse(right.publishedAt);
  if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) return 0;
  return leftAt === rightAt ? 0 : leftAt > rightAt ? 1 : -1;
}

/**
 * 版本闸门：目录 revision 与 publishedAt 必须同时严格递增。
 *
 * 不能使用“发布时间优先、同刻再比 revision”的 tuple 语义：
 * 同 revision 但发布时间更新仍可能携带旧内容，必须整体跳过。
 */
export function catalogVersionNotNewer(
  marker: {lastSyncedPublishedAt?: string; lastSyncedCatalogRevision?: string} | undefined,
  catalog: Pick<ProviderCatalog, "publishedAt" | "catalogRevision">,
): boolean {
  if (
    !marker?.lastSyncedPublishedAt
    || !isValidRfc3339WithZone(marker.lastSyncedPublishedAt)
    || !isValidCatalogRevision(marker.lastSyncedCatalogRevision)
  ) {
    return false;
  }
  const publishedAtOrder = compareCatalogPublishedAt(
    catalog,
    {publishedAt: marker.lastSyncedPublishedAt},
  );
  const revisionIsNewer = catalog.catalogRevision > marker.lastSyncedCatalogRevision;
  return publishedAtOrder <= 0 || !revisionIsNewer;
}

/**
 * 公共日历深校验（设计 5.2 规则 14 前置）：时区可用、coverage 有限、日期 YYYY-MM-DD 且有效。
 * 返回错误消息数组；空数组=通过。
 */
export function validateCatalogCalendars(
  calendars: Record<string, ProviderCatalogCalendar>,
): string[] {
  const errors: string[] = [];
  for (const [key, calendar] of Object.entries(calendars)) {
    try {
      new Intl.DateTimeFormat("en-US", {timeZone: calendar.timezone});
    } catch {
      errors.push(`calendars.${key}.timezone 不是可用的 IANA 时区: ${calendar.timezone}`);
      continue;
    }
    if (!Array.isArray(calendar.dates) || calendar.dates.length === 0) {
      errors.push(`calendars.${key}.dates 必须是非空日期数组`);
      continue;
    }
    const seen = new Set<string>();
    for (const date of calendar.dates) {
      if (seen.has(date)) continue;
      seen.add(date);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !isValidCalendarDate(date)) {
        errors.push(`calendars.${key}.dates 含非法日期: ${date}`);
      }
    }
  }
  return errors;
}

function isValidCalendarDate(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day!));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month! - 1 && probe.getUTCDate() === day;
}

/** schemaVersion 闸门：不支持版本由调用方隔离整份目录（5.2 规则 1）。 */
export function isSupportedSchemaVersion(value: unknown): value is typeof PROVIDER_CATALOG_SCHEMA_VERSION {
  return value === PROVIDER_CATALOG_SCHEMA_VERSION;
}
