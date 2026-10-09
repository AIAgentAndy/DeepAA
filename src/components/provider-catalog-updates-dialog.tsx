"use client";

import {Bell, CheckCheck, ChevronDown, ChevronRight, RefreshCcw} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {formatVersionDateTime} from "@/lib/format-datetime";
import {RateTimelineList} from "@/components/rate-timeline-list";
import {MultiSelectFilter} from "@/components/multi-select-filter";
import {confirmDialog} from "@/components/confirm-dialog";
import type {DisplayRateSegment} from "@/lib/rate-timeline-display";

interface CatalogFieldChange {
  field: string;
  label: string;
  before?: string;
  after: string;
  kind: "changed" | "added" | "removed";
}

interface CatalogNotificationItem {
  vendor: string;
  providerName: string;
  modelId: string;
  changes: CatalogFieldChange[];
  effectiveFrom?: string;
  changeNote?: string;
  rateTimeline?: DisplayRateSegment[];
  inUse?: boolean;
}

/** 列表行（有界投影，不含完整 Diff；展开时按版本号懒加载）。 */
interface CatalogNotificationRow {
  catalogRevision: string;
  publishedAt: string;
  createdAt: string;
  ackedAt?: string;
  effectiveFrom?: string;
  summary?: string;
  itemCount: number;
  inUseCount: number;
}

interface PricingUpdatesPayload {
  nonce?: string;
  rows: CatalogNotificationRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  unreadCount: number;
  revisions: Array<{value: string; label: string}>;
  hasUpdates: boolean;
  /** 维护测试模式（DEEPAA_CATALOG_PATH 生效）：版本号加「测试」标注，避免误认线上版本。 */
  maintenanceOverride?: boolean;
}

const PAGE_SIZE_OPTIONS = [10, 30, 50, 100] as const;

/**
 * 官方目录更新通知栏（2026-09-10 用户决策：列表化）。
 * 列：版本号 / 版本时间 / 摘要 / 是否已阅 / 已阅时间 / 操作；行内「展开」查看该版本完整
 * Diff、「已阅」标记整版本（不支持子项）。筛选：版本号多选 + 已阅状态多选（有未阅时
 * 默认只筛未阅）。分页：10/30/50/100，显示当前页与总条数。
 * 目录变化已在同步时自动生效（手工价永不覆盖），此处只承载知情。
 */
export function ProviderCatalogUpdatesDialog() {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<PricingUpdatesPayload | undefined>();
  const [loading, setLoading] = useState(false);
  const [acking, setAcking] = useState(false);
  const [error, setError] = useState("");
  const [pageSize, setPageSize] = useState<number>(10);
  const [revisions, setRevisions] = useState<string[]>([]);
  const [ackedFilter, setAckedFilter] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  /** 展开的行：版本号 → 完整通知（懒加载）。 */
  const [expanded, setExpanded] = useState<Record<string, CatalogNotificationRow & {items: CatalogNotificationItem[]}>>({});
  /** 勾选的版本号（批量已阅用；跨页保留，仅当前页可见勾选）。 */
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** 用户是否手动改过筛选（未改时按「有未阅 → 默认只看未阅」初始化）。 */
  const filterTouchedRef = useRef(false);
  const stateRef = useRef({pageSize, revisions, ackedFilter, sourceFilter});
  stateRef.current = {pageSize, revisions, ackedFilter, sourceFilter};

  const load = useCallback(async (override: {
    page?: number;
    pageSize?: number;
    revisions?: string[];
    acked?: string[];
    sources?: string[];
  } = {}) => {
    setLoading(true);
    setError("");
    try {
      const current = stateRef.current;
      const params = new URLSearchParams();
      params.set("page", String(override.page ?? 1));
      params.set("pageSize", String(override.pageSize ?? current.pageSize));
      const nextRevisions = override.revisions ?? current.revisions;
      const nextAcked = override.acked ?? current.ackedFilter;
      if (nextRevisions.length > 0) params.set("revisions", nextRevisions.join(","));
      if (nextAcked.length > 0) params.set("acked", nextAcked.join(","));
      const nextSources = override.sources ?? current.sourceFilter;
      if (nextSources.length > 0) params.set("sources", nextSources.join(","));
      const response = await fetch(`/api/provider-catalog/pricing-updates?${params.toString()}`, {cache: "no-store"});
      const body = await response.json() as PricingUpdatesPayload;
      setPayload(body);
      return body;
    } catch {
      setError("目录更新通知加载失败");
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时首次加载：有未阅且用户未改过筛选 → 默认只看未阅。
  const openAndLoad = useCallback(async () => {
    setOpen(true);
    setExpanded({});
    const body = await load({
      page: 1,
      acked: filterTouchedRef.current ? stateRef.current.ackedFilter : [],
      sources: filterTouchedRef.current ? stateRef.current.sourceFilter : [],
    });
    if (!filterTouchedRef.current && body && body.unreadCount > 0) {
      setAckedFilter(["unread"]);
      await load({page: 1, acked: ["unread"]});
    }
  }, [load]);

  // 页面加载时静默探测一次角标状态。
  useEffect(() => {
    if (!open && !payload) void load({page: 1});
  }, [open, payload, load]);

  // 后端每小时自动同步；通知角标不能只在首次加载时读取。
  // 页面聚焦立即刷新，后台以 2 分钟有界轮询保持未读数新鲜。
  useEffect(() => {
    const refresh = () => void load({page: 1});
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(() => {
      if (!open) refresh();
    }, 2 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [load, open]);

  /** 本页全部行（表头全选/全不选用）。 */
  const pageRows = payload?.rows ?? [];

  /** 勾选批量已阅：二次确认后执行（2026-09-10 用户确认的交互）。 */
  async function acknowledgeChecked(): Promise<void> {
    if (checked.size === 0) return;
    const confirmed = await confirmDialog({
      title: "标记已阅",
      message: `将把勾选的 ${checked.size} 个版本标记为已阅（仅归档通知状态，不影响价格与计费）。`,
    });
    if (!confirmed) return;
    await acknowledge([...checked]);
  }

  /**
   * 现取一次性 nonce（2026-09-10 修复）：nonce 是单次消费的，长驻弹窗复用旧值会
   * 报 LAUNCH_NONCE_INVALID；因此每次变更前都取一枚新的，不与列表加载共用。
   */
  async function fetchFreshNonce(): Promise<string> {
    const response = await fetch("/api/provider-catalog/pricing-updates?nonceOnly=1", {cache: "no-store"});
    const body = await response.json() as {nonce?: string};
    return body.nonce || "";
  }

  /** 标记已阅（整版本；支持多个版本批量；幂等，不改变计费）。 */
  async function acknowledge(revisions?: string[]): Promise<void> {
    if (acking) return;
    setAcking(true);
    setError("");
    const payloadBody = revisions && revisions.length > 0 ? {revisions} : {all: true};
    try {
      const nonce = await fetchFreshNonce();
      const response = await fetch("/api/provider-catalog/pricing-updates/dismiss", {
        method: "POST",
        headers: {"content-type": "application/json", "sec-fetch-site": "same-origin"},
        body: JSON.stringify({nonce, ...payloadBody}),
      });
      const body = await response.json() as {ok?: boolean; error?: string; nonce?: string};
      if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
      setChecked(new Set());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "标记已阅失败");
    } finally {
      setAcking(false);
    }
  }

  /** 展开明细：按版本号懒加载完整 Diff（不重复请求）。 */
  async function toggleExpand(revision: string): Promise<void> {
    if (expanded[revision]) {
      setExpanded(current => {
        const next = {...current};
        delete next[revision];
        return next;
      });
      return;
    }
    const row = payload?.rows.find(item => item.catalogRevision === revision);
    if (!row) return;
    try {
      const response = await fetch(
        `/api/provider-catalog/pricing-updates?detail=${encodeURIComponent(revision)}`,
        {cache: "no-store"},
      );
      const body = await response.json() as {notification?: {items: CatalogNotificationItem[]} | null};
      setExpanded(current => ({...current, [revision]: {...row, items: body.notification?.items ?? []}}));
    } catch {
      setError("展开明细失败");
    }
  }

  const badgeCount = payload?.unreadCount ?? 0;

  return (
    <>
      <button
        type="button"
        className="catalog-updates-trigger"
        title="官方目录更新通知（变化已自动生效，此处查看变更明细与历史）"
        aria-label={`官方目录更新通知${badgeCount > 0 ? `，${badgeCount} 个版本未阅` : "，当前无未阅更新"}`}
        onClick={() => void openAndLoad()}
      >
        <Bell size={16} />
        {badgeCount > 0 ? <span className="catalog-updates-badge">{badgeCount > 99 ? "99+" : badgeCount}</span> : null}
      </button>
      {/* Portal 到 body：脱离顶栏 DOM，杜绝 .topbar 白色文字继承（2026-09-07）。 */}
      {open ? createPortal(
        <div className="catalog-updates-backdrop" role="presentation" onMouseDown={event => {if (event.currentTarget === event.target) setOpen(false);}}>
          <section className="catalog-updates-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-updates-title">
            <header className="catalog-updates-header">
              <div>
                <h2 id="catalog-updates-title">模型价格变动通知</h2>
                <p>官方预设变化已在同步时自动生效（手工价永不覆盖）；人工覆盖与 LiteLLM 导入同样留下变更流水，便于回溯。</p>
              </div>
              <button type="button" className="catalog-updates-close" onClick={() => setOpen(false)} aria-label="关闭">✕</button>
            </header>
            <div className="catalog-updates-body">
              <div className="catalog-updates-toolbar">
                <MultiSelectFilter
                  label="版本号"
                  options={payload?.revisions ?? []}
                  selected={revisions}
                  onChange={next => {
                    filterTouchedRef.current = true;
                    setRevisions(next);
                    void load({page: 1, revisions: next});
                  }}
                  searchPlaceholder="搜索版本号"
                  triggerMinWidth={160}
                />
                <MultiSelectFilter
                  label="变更来源"
                  options={[
                    {value: "official_preset", label: "官方预设"},
                    {value: "manual_override", label: "人工覆盖"},
                    {value: "litellm_auto", label: "LiteLLM"},
                  ]}
                  selected={sourceFilter}
                  onChange={next => {
                    filterTouchedRef.current = true;
                    setSourceFilter(next);
                    void load({page: 1, sources: next});
                  }}
                  triggerMinWidth={150}
                />
                <MultiSelectFilter
                  label="是否已阅"
                  options={[{value: "unread", label: "未阅"}, {value: "read", label: "已阅"}]}
                  selected={ackedFilter}
                  onChange={next => {
                    filterTouchedRef.current = true;
                    setAckedFilter(next);
                    void load({page: 1, acked: next});
                  }}
                  triggerMinWidth={140}
                />
                <button
                  type="button"
                  className="catalog-updates-secondary"
                  onClick={() => {
                    filterTouchedRef.current = true;
                    setRevisions([]);
                    setAckedFilter([]);
                    setSourceFilter([]);
                    void load({page: 1, revisions: [], acked: [], sources: []});
                  }}
                  disabled={loading}
                >
                  清空筛选
                </button>
                <span className="catalog-updates-toolbar-count">
                  共 {payload?.total ?? 0} 个版本{payload && payload.unreadCount > 0 ? `，${payload.unreadCount} 个未阅` : ""}
                </span>
                {/* 批量已阅（2026-09-10 用户确认）：只保留一个按钮，点击后二次确认再执行。 */}
                <button
                  type="button"
                  className="catalog-updates-secondary"
                  onClick={() => void acknowledgeChecked()}
                  disabled={acking || loading || checked.size === 0}
                  title="把勾选的版本标记为已阅（可多选）"
                >
                  <CheckCheck size={14} /> {acking ? "处理中…" : `选中已阅（${checked.size}）`}
                </button>
                <button type="button" className="catalog-updates-secondary" onClick={() => void load()} disabled={loading}>
                  <RefreshCcw size={14} /> 刷新
                </button>
              </div>

              {loading ? <p className="catalog-updates-empty">加载中…</p> : null}
              {!loading && error ? <p className="catalog-updates-error" role="alert">{error}</p> : null}
              {!loading && (payload?.rows.length ?? 0) === 0 ? (
                <p className="catalog-updates-empty">没有符合条件的目录更新通知。</p>
              ) : null}

              {!loading && (payload?.rows.length ?? 0) > 0 ? (
                <div className="catalog-notification-table" role="table" aria-label="官方目录更新通知列表">
                  <div className="catalog-notification-row header" role="row">
                    <span className="catalog-notification-check">
                      {/* 点击全勾，再点全不勾（2026-09-10 用户确认）。 */}
                      <input
                        type="checkbox"
                        checked={pageRows.length > 0 && pageRows.every(row => checked.has(row.catalogRevision))}
                        onChange={event => setChecked(event.currentTarget.checked
                          ? new Set(pageRows.map(row => row.catalogRevision))
                          : new Set())}
                        aria-label="全选 / 全不选本页版本"
                      />
                    </span>
                    <span>版本号</span>
                    <span>版本时间</span>
                    <span>摘要信息</span>
                    <span>是否已阅</span>
                    <span>已阅时间</span>
                    <span>操作</span>
                  </div>
                  {(payload?.rows ?? []).map(row => {
                    const detail = expanded[row.catalogRevision];
                    return (
                      <div key={row.catalogRevision} className="catalog-notification-entry">
                        <div className="catalog-notification-row" role="row">
                          <span className="catalog-notification-check">
                            <input
                              type="checkbox"
                              checked={checked.has(row.catalogRevision)}
                              onChange={event => {
                                const next = new Set(checked);
                                if (event.currentTarget.checked) next.add(row.catalogRevision);
                                else next.delete(row.catalogRevision);
                                setChecked(next);
                              }}
                              aria-label={`勾选版本 ${row.catalogRevision}`}
                            />
                          </span>
                          <span className="catalog-notification-revision">
                            {row.catalogRevision}
                            {payload?.maintenanceOverride
                              ? <em className="catalog-updates-tag changed" title="维护测试模式：该版本来自本地草稿目录，未联网">测试</em>
                              : null}
                          </span>
                          <span>{formatVersionDateTime(row.publishedAt)}</span>
                          <span className="catalog-notification-summary">{row.summary || `${row.itemCount} 个模型变更`}</span>
                          <span>
                            {row.ackedAt
                              ? <em className="catalog-updates-tag added">已阅</em>
                              : <em className="catalog-updates-tag changed">未阅</em>}
                          </span>
                          <span>{row.ackedAt ? formatVersionDateTime(row.ackedAt) : "—"}</span>
                          <span className="catalog-notification-actions">
                            <button type="button" className="catalog-updates-secondary" onClick={() => void toggleExpand(row.catalogRevision)}>
                              {detail ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              {detail ? "收起" : "展开"}
                            </button>
                            {!row.ackedAt ? (
                              <button
                                type="button"
                                className="catalog-updates-secondary"
                                onClick={() => void acknowledge([row.catalogRevision])}
                                disabled={acking}
                                title="把本版本整条标记为已阅"
                              >
                                已阅
                              </button>
                            ) : null}
                          </span>
                        </div>
                        {detail ? <NotificationDetail notification={detail} /> : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* 分页：10/30/50/100，显示当前页与总条数。 */}
              {!loading && (payload?.total ?? 0) > 0 ? (
                <div className="catalog-updates-pagination">
                  <label>
                    <span>每页</span>
                    <select
                      value={pageSize}
                      onChange={event => {
                        const next = Number(event.currentTarget.value);
                        setPageSize(next);
                        void load({page: 1, pageSize: next});
                      }}
                    >
                      {PAGE_SIZE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                    </select>
                    <span>条</span>
                  </label>
                  <button
                    type="button"
                    className="catalog-updates-secondary"
                    disabled={loading || (payload?.page ?? 1) <= 1}
                    onClick={() => void load({page: Math.max(1, (payload?.page ?? 1) - 1)})}
                  >
                    上一页
                  </button>
                  <span>第 {payload?.page ?? 1} / {payload?.pageCount ?? 1} 页 · 共 {payload?.total ?? 0} 条</span>
                  <button
                    type="button"
                    className="catalog-updates-secondary"
                    disabled={loading || (payload?.page ?? 1) >= (payload?.pageCount ?? 1)}
                    onClick={() => void load({page: (payload?.page ?? 1) + 1})}
                  >
                    下一页
                  </button>
                </div>
              ) : null}
            </div>
            {/* footer 文案已移除（2026-09-10 用户确认）。 */}
          </section></div>, document.body) : null}
    </>
  );
}

/** 单版本完整 Diff（展开区）：按供应商分组，公告文案 + 时间线 + 逐字段 Diff。 */
function NotificationDetail({notification}: {notification: CatalogNotificationRow & {items: CatalogNotificationItem[]}}) {
  const byProvider = new Map<string, {providerName: string; items: CatalogNotificationItem[]}>();
  for (const item of notification.items) {
    const group = byProvider.get(item.vendor) ?? {providerName: item.providerName, items: []};
    group.items.push(item);
    byProvider.set(item.vendor, group);
  }
  return (
    <div className="catalog-notification-detail">
      {notification.effectiveFrom ? (
        <p className="catalog-notification-detail-meta">本批最早官方生效时刻：{formatVersionDateTime(notification.effectiveFrom)}</p>
      ) : null}
      {[...byProvider.entries()].map(([vendor, group]) => (
        <div key={vendor} className="catalog-updates-provider-group">
          {/* 名称与供应商标识之间必须有分隔，否则会粘成「OpenRouteropenrouter」看着像重复。 */}
          <h3>
            <span>{group.providerName}</span>
            {group.providerName.toLowerCase() === vendor.toLowerCase() ? null : <small>· {vendor}</small>}
          </h3>
          {group.items.map(item => (
            <div key={`${item.vendor}/${item.modelId}`} className="catalog-updates-model">
              <div className="catalog-updates-model-head">
                <strong>{item.modelId}</strong>
                {item.inUse ? <span className="catalog-updates-tag changed">使用中</span> : null}
                {item.effectiveFrom ? <span className="catalog-updates-tag added">{formatVersionDateTime(item.effectiveFrom)} 生效</span> : null}
              </div>
              {item.changeNote ? <p className="catalog-updates-announce">{item.changeNote}</p> : null}
              <RateTimelineList timeline={item.rateTimeline} compact />
              <div className="catalog-updates-fields">
                <span className="catalog-updates-col-head">字段</span>
                <span className="catalog-updates-col-head">变更前</span>
                <span className="catalog-updates-col-head">官方最新</span>
                {item.changes.map(change => (
                  <div key={change.field} className="catalog-updates-field-row">
                    <span>{change.label}</span>
                    <span className={change.kind === "changed" ? "before" : "muted"}>{change.before ?? "（无）"}</span>
                    <span className={change.kind === "added" ? "added" : "after"}>{change.after}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
