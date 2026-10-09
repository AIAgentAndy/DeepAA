/**
 * 官方目录更新通知历史（2026-09-10 用户决策）：SQLite 单一存储 + 列表化查询。
 *
 * 写入端：每次目录同步（启动 / 每小时 / 价格中心手动触发）把「有变化的模型 Diff」
 * 落一行 `catalog_update_notifications`；只增不改、按 200 版有界裁剪。
 * 读取端：右上角通知栏按「版本号 / 是否已阅」筛选 + 分页（10/30/50/100）查询，
 * 展开单版本时按 revision 精确读取完整 Diff。
 *
 * 与价格中心 JSON 解耦：逐字段 Diff 文本不写入 model-pricing.json（8 MiB 上限）。
 */
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {PricingCatalogNotificationItem, PricingCatalogUpdateNotification} from "@/lib/pricing";

/** 变更来源（2026-09-10 用户决策）：官方预设 / 人工覆盖 / LiteLLM 自动导入。 */
export type CatalogChangeSource = "official_preset" | "manual_override" | "litellm_auto";

export const CATALOG_CHANGE_SOURCE_LABELS: Record<CatalogChangeSource, string> = {
  official_preset: "官方预设",
  manual_override: "人工覆盖",
  litellm_auto: "LiteLLM",
};

/** 列表行（有界投影，不含完整 Diff）。 */
export interface CatalogNotificationRow {
  /** 变更来源（缺省 official_preset，兼容 v25 存量行）。 */
  source?: CatalogChangeSource;
  catalogRevision: string;
  publishedAt: string;
  createdAt: string;
  ackedAt?: string;
  effectiveFrom?: string;
  summary?: string;
  itemCount: number;
  inUseCount: number;
}

export interface CatalogNotificationPage {
  rows: CatalogNotificationRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  unreadCount: number;
  /** 全部版本号（筛选下拉值域；有界）。 */
  revisions: Array<{value: string; label: string}>;
}

/** 有界保留版本数（超出裁剪最老已阅；未阅不裁剪）。 */
export const MAX_CATALOG_NOTIFICATIONS = 200;
const MAX_ITEMS_PER_NOTIFICATION = 500;
const MAX_ITEM_CHANGES = 64;
const MAX_SUMMARY_LENGTH = 160;

/**
 * 写入/更新一条通知（同版本幂等覆盖，内容感知）：
 * items 无实质变化 → 保持已阅（重复生成不打扰）；有实质变化 → 重置未阅并刷新生成时刻
 * （2026-09-21 用户决策「无论任何修改走通知是合理的」——已阅的是旧内容，新内容必须重新点亮）。
 */
export function recordCatalogNotification(
  db: DeepaaDatabase,
  notification: PricingCatalogUpdateNotification,
  source: CatalogChangeSource = "official_preset",
): void {
  const items = boundItems(notification.items);
  const inUseCount = items.filter(item => item.inUse === true).length;
  db.prepare(`
    INSERT INTO catalog_update_notifications(
      catalog_revision, published_at, created_at, acked_at, effective_from,
      summary, item_count, in_use_count, source, items_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(catalog_revision) DO UPDATE SET
      published_at = excluded.published_at,
      created_at = CASE
        WHEN catalog_update_notifications.items_json IS NOT excluded.items_json
        THEN excluded.created_at
        ELSE catalog_update_notifications.created_at
      END,
      acked_at = CASE
        WHEN catalog_update_notifications.items_json IS NOT excluded.items_json
        THEN NULL
        ELSE catalog_update_notifications.acked_at
      END,
      summary = excluded.summary,
      item_count = excluded.item_count,
      in_use_count = excluded.in_use_count,
      source = excluded.source,
      items_json = excluded.items_json
  `).run(
    notification.catalogRevision,
    notification.publishedAt,
    notification.createdAt,
    notification.ackedAt ?? null,
    notification.effectiveFrom ?? null,
    summarizeNotification(items, source),
    items.length,
    inUseCount,
    source,
    JSON.stringify(items),
  );
  pruneCatalogNotifications(db);
}

/** 单条通知摘要：人工/LiteLLM 加来源前缀；官方优先展示公告文案。 */
function summarizeNotification(items: PricingCatalogNotificationItem[], source: CatalogChangeSource): string {
  const announced = items.find(item => item.changeNote)?.changeNote;
  const prefix = source === "official_preset" ? "" : `【${CATALOG_CHANGE_SOURCE_LABELS[source]}】`;
  const fallback = source === "official_preset"
    ? `${items.length} 个模型变更`
    : `${items.map(item => item.modelId).slice(0, 3).join("、")}${items.length > 3 ? ` 等 ${items.length} 个模型` : ""}价格变更`;
  const base = `${prefix}${announced ?? fallback}`;
  return base.length > MAX_SUMMARY_LENGTH ? `${base.slice(0, MAX_SUMMARY_LENGTH)}…` : base;
}

function boundItems(items: PricingCatalogNotificationItem[]): PricingCatalogNotificationItem[] {
  return items.slice(0, MAX_ITEMS_PER_NOTIFICATION).map(item => ({
    vendor: item.vendor.slice(0, 128),
    providerName: item.providerName.slice(0, 256),
    modelId: item.modelId.slice(0, 256),
    changes: item.changes.slice(0, MAX_ITEM_CHANGES),
    ...(item.effectiveFrom ? {effectiveFrom: item.effectiveFrom} : {}),
    ...(item.changeNote ? {changeNote: item.changeNote.slice(0, 2048)} : {}),
    ...(item.rateTimeline ? {rateTimeline: item.rateTimeline.slice(0, 8)} : {}),
    ...(item.inUse === true ? {inUse: true} : {}),
  }));
}

/** 有界裁剪：优先保留未阅；已阅按时间裁剪到上限（未阅超出上限时不裁剪）。 */
export function pruneCatalogNotifications(db: DeepaaDatabase): void {
  const unread = (db.prepare("SELECT COUNT(*) AS count FROM catalog_update_notifications WHERE acked_at IS NULL").get() as {count: number}).count;
  const budget = Math.max(0, MAX_CATALOG_NOTIFICATIONS - unread);
  db.prepare(`
    DELETE FROM catalog_update_notifications WHERE catalog_revision IN (
      SELECT catalog_revision FROM catalog_update_notifications
      WHERE acked_at IS NOT NULL
      ORDER BY published_at DESC, catalog_revision DESC
      LIMIT -1 OFFSET ?
    )
  `).run(budget);
}

export interface CatalogNotificationQuery {
  /** 版本号筛选（空 = 不过滤）。 */
  revisions?: string[];
  /** 已阅状态筛选：unread/read（空数组 = 不过滤）。 */
  acked?: Array<"unread" | "read">;
  /** 变更来源筛选（空数组 = 不过滤）。 */
  sources?: CatalogChangeSource[];
  page?: number;
  pageSize?: number;
}

/** 列表查询（有界分页 + 筛选 + 总数；版本号下拉值域有界返回）。 */
export function queryCatalogNotifications(
  db: DeepaaDatabase,
  query: CatalogNotificationQuery = {},
): CatalogNotificationPage {
  const pageSize = clampPageSize(query.pageSize);
  const where: string[] = [];
  const params: unknown[] = [];
  const revisions = (query.revisions ?? []).filter(value => value.trim().length > 0).slice(0, 200);
  if (revisions.length > 0) {
    where.push(`catalog_revision IN (${revisions.map(() => "?").join(",")})`);
    params.push(...revisions);
  }
  const acked = (query.acked ?? []).filter(value => value === "unread" || value === "read");
  if (acked.length === 1) {
    where.push(acked[0] === "unread" ? "acked_at IS NULL" : "acked_at IS NOT NULL");
  }
  const sources = (query.sources ?? []).filter(value =>
    value === "official_preset" || value === "manual_override" || value === "litellm_auto");
  if (sources.length > 0) {
    where.push(`source IN (${sources.map(() => "?").join(",")})`);
    params.push(...sources);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM catalog_update_notifications${whereSql}`).get(...params) as {count: number}).count;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(query.page ?? 1)), pageCount);
  const rows = db.prepare(`
    SELECT catalog_revision AS catalogRevision, published_at AS publishedAt, created_at AS createdAt,
           acked_at AS ackedAt, effective_from AS effectiveFrom, summary, source,
           item_count AS itemCount, in_use_count AS inUseCount
    FROM catalog_update_notifications${whereSql}
    ORDER BY published_at DESC, catalog_revision DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize) as CatalogNotificationRow[];
  const unreadCount = (db.prepare("SELECT COUNT(*) AS count FROM catalog_update_notifications WHERE acked_at IS NULL").get() as {count: number}).count;
  const revisionsRaw = db.prepare(`
    SELECT catalog_revision AS value, published_at AS publishedAt
    FROM catalog_update_notifications ORDER BY published_at DESC, catalog_revision DESC LIMIT 200
  `).all() as Array<{value: string; publishedAt: string}>;
  return {
    rows: rows.map(row => ({...row, ...(row.ackedAt ? {} : {ackedAt: undefined})})),
    total,
    page,
    pageSize,
    pageCount,
    unreadCount,
    revisions: revisionsRaw.map(item => ({value: item.value, label: item.value})),
  };
}

/** 单个版本完整通知（展开明细；不存在返回 undefined）。 */
export function loadCatalogNotification(
  db: DeepaaDatabase,
  catalogRevision: string,
): PricingCatalogUpdateNotification | undefined {
  const row = db.prepare(`
    SELECT catalog_revision AS catalogRevision, published_at AS publishedAt, created_at AS createdAt,
           acked_at AS ackedAt, effective_from AS effectiveFrom, items_json AS itemsJson
    FROM catalog_update_notifications WHERE catalog_revision = ?
  `).get(catalogRevision) as
    | {catalogRevision: string; publishedAt: string; createdAt: string; ackedAt: string | null; effectiveFrom: string | null; itemsJson: string}
    | undefined;
  if (!row) return undefined;
  let items: PricingCatalogNotificationItem[] = [];
  try {
    items = JSON.parse(row.itemsJson) as PricingCatalogNotificationItem[];
  } catch {
    items = [];
  }
  return {
    catalogRevision: row.catalogRevision,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    ...(row.ackedAt ? {ackedAt: row.ackedAt} : {}),
    ...(row.effectiveFrom ? {effectiveFrom: row.effectiveFrom} : {}),
    items,
  };
}

/** 未阅数量（右上角角标；无 SQLite 时调用方回退 0）。 */
export function countUnackedCatalogNotifications(db: DeepaaDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM catalog_update_notifications WHERE acked_at IS NULL").get() as {count: number}).count;
}

/** 标记已阅（逐条或全部未阅；已阅幂等，不覆盖原已阅时间）。 */
export function ackCatalogNotifications(
  db: DeepaaDatabase,
  input: {revisions?: string[]; all?: boolean},
  ackedAt: string,
): number {
  if (input.all === true) {
    return db.prepare("UPDATE catalog_update_notifications SET acked_at = ? WHERE acked_at IS NULL").run(ackedAt).changes;
  }
  const revisions = (input.revisions ?? []).filter(value => value.trim().length > 0).slice(0, 100);
  if (revisions.length === 0) return 0;
  return db.prepare(`
    UPDATE catalog_update_notifications SET acked_at = ?
    WHERE acked_at IS NULL AND catalog_revision IN (${revisions.map(() => "?").join(",")})
  `).run(ackedAt, ...revisions).changes;
}

/**
 * 迁移入口（一次性）：把旧版存在 model-pricing.json 的 notifications 导入 SQLite。
 * 幂等（同版本已存在则跳过），供价格中心 JSON 字段退役后的存量续承。
 */
export function importLegacyCatalogNotifications(
  db: DeepaaDatabase,
  notifications: PricingCatalogUpdateNotification[] | undefined,
): number {
  if (!notifications?.length) return 0;
  const existing = db.prepare("SELECT COUNT(*) AS count FROM catalog_update_notifications").get() as {count: number};
  if (existing.count > 0) return 0;
  for (const notification of notifications) {
    recordCatalogNotification(db, notification);
  }
  return notifications.length;
}

function clampPageSize(value: number | undefined): number {
  const allowed = [10, 30, 50, 100];
  const candidate = value ?? 10;
  return allowed.includes(candidate) ? candidate : 10;
}

/** 人工覆盖 / LiteLLM 自动导入的变更记录器（2026-09-10 用户决策）。 */

/** 生成人工覆盖版本号：`manual-YYYY.MM.DD.HHmmss`（与官方 catalogRevision 前缀区分）。 */
export function manualChangeRevision(at: Date = new Date()): string {
  return `manual-${revisionStamp(at)}`;
}

/** 生成 LiteLLM 导入版本号：`litellm-YYYY.MM.DD.HHmmss`。 */
export function litellmChangeRevision(at: Date = new Date()): string {
  return `litellm-${revisionStamp(at)}`;
}

function revisionStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}.${pad(at.getMonth() + 1)}.${pad(at.getDate())}`
    + `.${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

export interface PriceChangeEntry {
  vendor: string;
  providerName?: string;
  modelId: string;
  /** 逐字段变更（before → after）。 */
  changes: PricingCatalogNotificationItem["changes"];
  inUse?: boolean;
  changeNote?: string;
}

/**
 * 记录一次非官方来源的价格变更（人工覆盖 / LiteLLM 自动导入）。
 * 只作流水记录：不参与官方目录映射、不影响目标计价优先级与账本。
 * 无有效变更（changes 全空）时返回 undefined，不落库。
 */
export function recordPriceChange(
  db: DeepaaDatabase,
  input: {
    source: Exclude<CatalogChangeSource, "official_preset">;
    revision: string;
    changedAt: Date;
    entries: PriceChangeEntry[];
  },
): PricingCatalogUpdateNotification | undefined {
  const entries = input.entries.filter(entry => entry.changes.length > 0);
  if (entries.length === 0) return undefined;
  const notification: PricingCatalogUpdateNotification = {
    catalogRevision: input.revision,
    publishedAt: input.changedAt.toISOString(),
    createdAt: input.changedAt.toISOString(),
    items: entries.slice(0, MAX_ITEMS_PER_NOTIFICATION).map(entry => ({
      vendor: entry.vendor,
      providerName: entry.providerName ?? entry.vendor,
      modelId: entry.modelId,
      changes: entry.changes.slice(0, MAX_ITEM_CHANGES),
      ...(entry.changeNote ? {changeNote: entry.changeNote.slice(0, 2048)} : {}),
      ...(entry.inUse === true ? {inUse: true} : {}),
    })),
  };
  recordCatalogNotification(db, notification, input.source);
  return notification;
}
