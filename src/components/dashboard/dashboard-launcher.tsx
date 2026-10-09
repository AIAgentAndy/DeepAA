"use client";

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {useRouter} from "next/navigation";
import {CircleDollarSign, Clock3, Plus, RotateCcw, Ticket} from "lucide-react";
import {DevelopmentLaunchDialog} from "@/components/development-launch-dialog";
import {AGENT_CATALOG, agentLabel, boundCompatibleTargetsForAgent} from "@/components/proxy-management/agent-catalog";
import {AGENT_LOGO_EXT} from "@/components/proxy-management/agent-entry-badges";
import {TargetHealthBadge} from "@/components/proxy-management/target-health-badge";
import type {ProxySyncStatus} from "@/components/proxy-management/proxy-management-types";
import type {AgentId, ProxyConfig, ProxyTarget} from "@/types";
import {AGENT_REGISTRY} from "@/lib/agent-registry";
import type {DevelopmentCli} from "@/lib/development-launch/types";
import {formatRelativeLocalTime} from "@/lib/local-time";
import {pickPrimaryPlanQuotaWindow, planQuotaPercent, planQuotaRemainingPercent, planQuotaWindowLabel, usageFallbackLabel} from "@/lib/plan-quota-display";
import {badgeInputFromStatus, resolveTargetBadge} from "@/lib/sync-engine/target-health-badge";
import {PROVIDER_PRESETS, derivePresetCurrency} from "@/lib/provider-presets";
import {asDisplayCurrency, resolveDisplayFxRate} from "@/lib/settlement-fx";
import {formatMoneyWithCnyEquivalent} from "@/lib/money-display";
import {useFxSnapshot} from "@/lib/fx-snapshot-client";
import {shouldStackProviderSync} from "@/lib/dashboard-provider-layout";
import styles from "../dashboard.module.css";

interface LaunchSession {
  target: ProxyTarget;
  cli: DevelopmentCli;
}

/** 状态新鲜度阈值：窗口切换时超过该时长才回源刷新，避免频繁打接口。 */
const STATUS_STALE_MS = 60_000;
const MIN_GAP_PX = 15;
const MAX_GAP_PX = 35;

/* 窗口标签与百分比口径统一来自 @/lib/plan-quota-display（与供应商侧栏共用一份）。 */

function relativeFuture(value: string | null | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "即将";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

/** 管理页同源规则：绑定供应商即视为已接入。 */
function connectedAgentIds(config: ProxyConfig): AgentId[] {
  return AGENT_CATALOG
    .filter(entry => boundCompatibleTargetsForAgent(config, entry.id).length > 0)
    .map(entry => entry.id);
}

/**
 * Agent 启动入口固定展示顺序：注册表顺序（Codex → Claude Code → OpenCode →
 * DeepSeek Harness → ZCode），不按最近使用重排；未知 Agent 兜底最后。
 */
const AGENT_LAUNCH_ORDER = new Map<string, number>(
  AGENT_REGISTRY.map((adapter, index) => [adapter.id, index]),
);

function sortAgentsByFixedOrder(ids: AgentId[]): AgentId[] {
  return [...ids].sort((left, right) =>
    (AGENT_LAUNCH_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (AGENT_LAUNCH_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER));
}

function agentDefaultTarget(config: ProxyConfig, agent: AgentId): ProxyTarget | undefined {
  const candidates = boundCompatibleTargetsForAgent(config, agent);
  if (candidates.length === 0) return undefined;
  const connection = config.agentConnections?.[agent];
  return candidates.find(target => target.id === connection?.defaultTargetId) ?? candidates[0];
}

/** 最近使用优先：有排序键的按时间降序在前，无数据的保持配置顺序垫底。 */
function sortByRecent<T extends {id: string}>(items: T[], recent: Record<string, string>): T[] {
  return [...items].sort((a, b) => (recent[b.id] ?? "").localeCompare(recent[a.id] ?? ""));
}

/**
 * 自适应横排：单行放得下时整体居中、间距在 15-35px 间按剩余空间均分；
 * 放不下时固定 15px 左对齐并允许横向滚动。Agent 行与供应商行共用同一规则。
 */
function AdaptiveRail({children, label}: {children: ReactNode[]; label: string}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{gap: number; centered: boolean}>({gap: MIN_GAP_PX, centered: false});

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const items = Array.from(container.children) as HTMLElement[];
      const naturalWidth = items.reduce((sum, item) => sum + item.offsetWidth, 0);
      const available = container.clientWidth;
      const count = items.length;
      if (count <= 1 || naturalWidth + MIN_GAP_PX * (count - 1) > available) {
        setLayout({gap: MIN_GAP_PX, centered: false});
        return;
      }
      const slack = (available - naturalWidth) / (count - 1);
      setLayout({gap: Math.min(MAX_GAP_PX, Math.max(MIN_GAP_PX, Math.floor(slack))), centered: true});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const item of Array.from(container.children) as HTMLElement[]) observer.observe(item);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={label}
      className={styles.adaptiveRail}
      style={{gap: `${layout.gap}px`, justifyContent: layout.centered ? "center" : "flex-start"}}
    >
      {children}
    </div>
  );
}

interface QuotaItem {
  id: number;
  windowLabel: string;
  used: number | null;
  total: number | null;
  /** 供应商原始剩余值（2026-10-07 余量主口径：仪表盘卡与 zcode 对齐展示「剩 X%」）。 */
  remaining: number | null;
  unit: string | null;
  resetAt: string | null;
}

function quotaBarClass(percent: number | null): string {
  if (percent === null) return styles.quotaBarUnknown;
  if (percent >= 80) return styles.quotaBarCritical;
  if (percent >= 50) return styles.quotaBarWarn;
  return styles.quotaBarOk;
}

/**
 * 仪表盘顶部功能区：已接入 Agent 横排（一键启动）+ 供应商状态栏。
 * 套餐/订阅卡提供用量窗口切换（默认 5 小时），切换时按新鲜度阈值回源刷新；
 * 按量卡展示余额与同步节奏。点击供应商卡进入管理页对应「基础信息」。
 */
export function DashboardLauncher() {
  const router = useRouter();
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ProxySyncStatus>>({});
  const statusFetchedAtRef = useRef<Record<string, number>>({});
  const [recent, setRecent] = useState<{agents: Record<string, string>; targets: Record<string, string>}>({agents: {}, targets: {}});
  const [quotaWindows, setQuotaWindows] = useState<Record<string, string>>({});
  const [launch, setLaunch] = useState<LaunchSession | null>(null);
  const [refreshingTarget, setRefreshingTarget] = useState("");
  const syncNonceRef = useRef("");

  const fetchTargetStatus = useCallback(async (targetId: string): Promise<ProxySyncStatus | undefined> => {
    try {
      const detail = await fetch(`/api/proxy-sync/status?target=${encodeURIComponent(targetId)}`, {cache: "no-store"});
      if (!detail.ok) return undefined;
      const status = await detail.json() as ProxySyncStatus;
      setStatuses(current => ({...current, [targetId]: status}));
      statusFetchedAtRef.current[targetId] = Date.now();
      return status;
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [configResponse, recentResponse] = await Promise.all([
          fetch("/api/proxy-config", {cache: "no-store"}),
          fetch("/api/dashboard/launcher-recent", {cache: "no-store"}),
        ]);
        if (cancelled) return;
        const latest = configResponse.ok ? await configResponse.json() as ProxyConfig : null;
        if (latest) setConfig(latest);
        if (recentResponse.ok) {
          const payload = await recentResponse.json() as {agents?: Record<string, string>; targets?: Record<string, string>};
          setRecent({agents: payload.agents ?? {}, targets: payload.targets ?? {}});
        }
        if (latest) {
          await Promise.allSettled(
            (latest.targets ?? [])
              .filter(target => target.enabled !== false)
              .map(target => fetchTargetStatus(target.id)),
          );
        }
      } catch {
        // 增强入口：读取失败整块静默隐藏，不影响汇总主视图。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchTargetStatus]);

  const agents = useMemo(
    () => (config ? sortAgentsByFixedOrder(connectedAgentIds(config)) : []),
    [config],
  );
  const targets = useMemo(
    () => sortByRecent((config?.targets ?? []).filter(target => target.enabled !== false), recent.targets),
    [config, recent.targets],
  );

  /** 窗口切换：状态超过新鲜度阈值时回源刷新该目标，避免长时间停留在旧快照。 */
  const selectQuotaWindow = useCallback((targetId: string, windowLabel: string) => {
    setQuotaWindows(current => ({...current, [targetId]: windowLabel}));
    if (Date.now() - (statusFetchedAtRef.current[targetId] ?? 0) > STATUS_STALE_MS) {
      void fetchTargetStatus(targetId);
    }
  }, [fetchTargetStatus]);

  /**
   * 手动立即同步：与供应商管理页「立即同步」共用 /api/proxy-sync/run（launch nonce 握手）。
   * 按量走 console 链路、套餐走 plan 链路；完成后重取状态。
   */
  const refreshTargetNow = useCallback(async (target: ProxyTarget) => {
    if (refreshingTarget) return;
    setRefreshingTarget(target.id);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!syncNonceRef.current) {
          const caps = await fetch("/api/development-launch/capabilities", {cache: "no-store"});
          const capBody = await caps.json() as {nonce?: string};
          syncNonceRef.current = capBody.nonce ?? "";
        }
        if (!syncNonceRef.current) return;
        const response = await fetch("/api/proxy-sync/run", {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({
            targetId: target.id,
            ...(target.billingChannel === "plan" || target.billingChannel === "subscription" ? {mode: "plan"} : {}),
            nonce: syncNonceRef.current,
          }),
        });
        const body = await response.json() as {nonce?: string; error?: string};
        if (body.nonce) syncNonceRef.current = body.nonce;
        if (body.error !== "LAUNCH_NONCE_INVALID") break;
        syncNonceRef.current = "";
      }
    } catch {
      // 手动同步失败静默，状态区保留最近成功快照。
    } finally {
      await fetchTargetStatus(target.id);
      setRefreshingTarget("");
    }
  }, [fetchTargetStatus, refreshingTarget]);

  const openLaunch = useCallback((agent: AgentId) => {
    if (!config) return;
    const target = agentDefaultTarget(config, agent);
    if (!target) {
      router.push("/proxy-management");
      return;
    }
    setLaunch({target, cli: agent});
  }, [config, router]);

  /**
   * 切换 codex CLI 形态（2026-10-09，启动弹窗「确认切换并启动」流程）：与管理页
   * 同链路——PUT /api/proxy-config（agentConnectionPatch）落库 → POST /api/config-sync
   * 重写受管配置；均走 launch nonce 握手（与手动同步共用）。成功后回写 config
   * 状态，弹窗据此刷新当前形态展示。版本冲突时重取配置重试一次。
   */
  const setCliForm = useCallback(async (agent: AgentId, gatewayMode: boolean): Promise<void> => {
    let latest = config;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!latest) throw new Error("配置尚未加载，请重试");
      if (!syncNonceRef.current) {
        const caps = await fetch("/api/development-launch/capabilities", {cache: "no-store"});
        const capBody = await caps.json() as {nonce?: string};
        if (!capBody.nonce) throw new Error("操作凭证不可用，请重试");
        syncNonceRef.current = capBody.nonce;
      }
      const response = await fetch("/api/proxy-config", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          agentConnectionPatch: {agent, action: "connect", cliSyncEnabled: gatewayMode},
          expectedRevision: latest.revision,
          nonce: syncNonceRef.current,
        }),
      });
      const body = await response.json() as {nonce?: string; error?: string; message?: string; config?: ProxyConfig};
      syncNonceRef.current = body.nonce || "";
      if (response.status === 409 || body.error === "CONFIG_REVISION_CONFLICT") {
        const fresh = await fetch("/api/proxy-config", {cache: "no-store"});
        if (fresh.ok) {
          latest = await fresh.json() as ProxyConfig;
          setConfig(latest);
        }
        continue;
      }
      if (!response.ok || !body.config) throw new Error(body.message || body.error || "CLI 形态切换失败");
      setConfig(body.config);
      const syncResponse = await fetch("/api/config-sync", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({nonce: syncNonceRef.current}),
      });
      const syncBody = await syncResponse.json() as {nonce?: string; ok?: boolean; error?: string; message?: string; errors?: string[]};
      if (syncBody.nonce) syncNonceRef.current = syncBody.nonce;
      if (!syncResponse.ok || syncBody.ok === false) {
        throw new Error(syncBody.message || syncBody.error || syncBody.errors?.join("；") || "CLI 配置同步失败");
      }
      return;
    }
    throw new Error("配置已被其它页面更新，请重试");
  }, [config]);

  /** 该 Agent 可切换的默认供应商候选（已接入绑定 + 启用），传给启动弹窗。 */
  const targetOptionsFor = useCallback((agent: AgentId): ProxyTarget[] | undefined => {
    if (!config) return undefined;
    const options = boundCompatibleTargetsForAgent(config, agent);
    return options.length > 0 ? options : undefined;
  }, [config]);

  /**
   * 空闲预热：仪表盘加载完成后逐个 Agent 预取 preflight（带 nonce），把服务端缓存焐热，
   * 用户点开「在 {Agent} 中开发」时预检秒回；同一时刻只跑一个，失败静默。
   */
  useEffect(() => {
    if (!config || agents.length === 0) return;
    let cancelled = false;
    const warmConfig = config;
    const warmUp = async () => {
      for (const agent of agents) {
        if (cancelled) return;
        const target = agentDefaultTarget(warmConfig, agent);
        if (!target) continue;
        try {
          const caps = await fetch("/api/development-launch/capabilities", {cache: "no-store"});
          if (!caps.ok || cancelled) continue;
          const capBody = await caps.json() as {nonce?: string};
          if (!capBody.nonce) continue;
          await fetch("/api/development-launch/preflight", {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({cli: agent, targetId: target.id, nonce: capBody.nonce}),
          });
        } catch {
          // 预热失败静默：弹窗打开时会自行重新预检。
        }
      }
    };
    const schedule = () => void warmUp();
    let cancelSchedule: () => void;
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleHandle = window.requestIdleCallback(schedule, {timeout: 4000});
      cancelSchedule = () => window.cancelIdleCallback(idleHandle);
    } else {
      const timeoutHandle = setTimeout(schedule, 1200);
      cancelSchedule = () => clearTimeout(timeoutHandle);
    }
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [config, agents]);

  // 一个供应商都没配置时不隐藏整块：展示「新建供应商」大按钮空态，深链接直达新建步骤。
  // 有供应商但全部停用且无已接入 Agent 时维持原状（整块隐藏，不打扰汇总主视图）。
  const hasNoProviders = (config?.targets?.length ?? 0) === 0;
  if (!config) return null;
  if (!hasNoProviders && agents.length === 0 && targets.length === 0) return null;

  return (
    <section className={styles.launcherStack} aria-label="Agent 启动与供应商状态">
      <div className={styles.heroPanel}>
        {agents.length > 0 ? (
          <div className={styles.launcherRowBlock}>
            <AdaptiveRail label="已接入的 Agent">
              {agents.map(agent => (
                <button
                  key={agent}
                  type="button"
                  className={styles.launchBadge}
                  onClick={() => openLaunch(agent)}
                  title={`一键启动 ${agentLabel(agent)}`}
                >
                  <span className={`${styles.launchBadgeLogo} ${styles[`launchLogo_${agent}`] ?? ""}`}>
                    <img src={`/agent-logos/${agent}.${AGENT_LOGO_EXT[agent] || "png"}`} alt="" />
                  </span>
                  <span className={styles.launchBadgeName}>{agentLabel(agent)}</span>
                  <span className={styles.launchBadgeAction}>启动</span>
                </button>
              ))}
              {agents.length < AGENT_REGISTRY.length ? (
                <button
                  type="button"
                  className={styles.launchGhostBadge}
                  onClick={() => router.push("/proxy-management")}
                  title="到供应商管理页接入更多 Agent"
                >
                  <Plus size={14} aria-hidden="true" /> 接入更多 Agent
                </button>
              ) : null}
            </AdaptiveRail>
          </div>
        ) : null}
        {hasNoProviders ? (
          <div className={styles.launcherEmpty}>
            <span className={styles.launcherEmptyIcon} aria-hidden="true"><Plus size={22} /></span>
            <strong className={styles.launcherEmptyTitle}>还没有供应商</strong>
            <span className={styles.launcherEmptyHint}>接入官方预设或自定义中转站后，即可在这里查看供应商余额与套餐用量，并一键启动各 Agent。</span>
            <button
              type="button"
              className={styles.launcherEmptyCta}
              onClick={() => router.push("/proxy-management?new=1")}
            >
              <Plus size={17} aria-hidden="true" /> 新建供应商
            </button>
          </div>
        ) : targets.length > 0 ? (
          <div className={styles.launcherRowBlock}>
            <div className={styles.providerRailScroll}>
              <AdaptiveRail label="供应商状态">
                {targets.map(target => (
                  <ProviderCard
                    key={target.id}
                    target={target}
                    status={statuses[target.id]}
                    quotaWindow={quotaWindows[target.id]}
                    refreshing={refreshingTarget === target.id}
                    onSelectQuotaWindow={windowLabel => selectQuotaWindow(target.id, windowLabel)}
                    onRefresh={() => void refreshTargetNow(target)}
                  />
                ))}
                <a className={styles.providerGhostCard} href="/proxy-management?new=1" title="新建供应商">
                  <span className={styles.providerGhostCardTitle}><Plus size={15} aria-hidden="true" /> 新建供应商</span>
                  <span className={styles.providerGhostCardHint}>官方预设或自定义中转站</span>
                </a>
              </AdaptiveRail>
            </div>
          </div>
        ) : null}
      </div>
      {launch ? (
        <DevelopmentLaunchDialog
          target={launch.target}
          cli={launch.cli}
          localProxyBaseUrl={config?.localProxyBaseUrl ?? ""}
          targetOptions={targetOptionsFor(launch.cli)}
          onClose={() => setLaunch(null)}
          onOpenPricingCenter={() => {
            setLaunch(null);
            router.push("/token-pricing");
          }}
          cliSyncEnabled={(() => {
            const connection = config?.agentConnections[launch.cli];
            return connection ? connection.cliSyncEnabled !== false : undefined;
          })()}
          onSetCliForm={setCliForm}
        />
      ) : null}
    </section>
  );
}

function ProviderCard({
  target,
  status,
  quotaWindow,
  refreshing,
  onSelectQuotaWindow,
  onRefresh,
}: {
  target: ProxyTarget;
  status: ProxySyncStatus | undefined;
  quotaWindow: string | undefined;
  refreshing: boolean;
  onSelectQuotaWindow: (windowLabel: string) => void;
  onRefresh: () => void;
}) {
  const isPlan = target.billingChannel === "plan" || target.billingChannel === "subscription";
  const balance = status?.balance;
  const account = status?.account ?? null;
  const cardRef = useRef<HTMLAnchorElement>(null);
  const providerContentRef = useRef<HTMLSpanElement>(null);
  const syncColRef = useRef<HTMLSpanElement>(null);
  const syncMeasureRef = useRef<HTMLSpanElement>(null);
  const [stackSync, setStackSync] = useState(false);
  /* 余额「原值（约￥等值）」（2026-09-28；2026-10-06 与入账级联对齐）：供应商卡余额是
     站点快照而非消费 KPI——按余额自身币种解析：官方预设（任意目录币种）非人民币按目录
     fx 快照、自定义中转站按目标 settlementFx，均只作展示不入账。 */
  const fxSnapshot = useFxSnapshot();
  const balanceFxRate = resolveDisplayFxRate({
    amountCurrency: asDisplayCurrency(balance?.currency),
    presetCurrency: derivePresetCurrency(
      target.presetId ? PROVIDER_PRESETS.find(item => item.id === target.presetId) : undefined,
    ),
    settlementFx: target.pricing?.settlementFx,
    fxUsdCny: fxSnapshot?.rate,
  });
  const quotaItems = (status?.plan.quota.items ?? []) as QuotaItem[];
  const windowLabels = useMemo(() => [...new Set(quotaItems.map(item => item.windowLabel))], [quotaItems]);
  const activeWindow = quotaWindow && windowLabels.includes(quotaWindow)
    ? quotaWindow
    : pickPrimaryPlanQuotaWindow(quotaItems)?.windowLabel;
  const activeQuota = quotaItems.find(item => item.windowLabel === activeWindow);
  /* 余量主口径（2026-10-07 用户确认，与 zcode 对齐）：进度条长度与文本展示「剩余」占比，
     颜色仍按「已用」占比判定（剩余越少越红），quotaBarClass 消费 planQuotaPercent。 */
  const percent = planQuotaPercent(activeQuota);
  const remainingPercent = planQuotaRemainingPercent(activeQuota);
  const planSyncAt = status?.plan.config?.lastSyncAt ?? account?.lastSyncAt ?? null;
  const syncLabel = isPlan
    ? (planSyncAt ? formatRelativeLocalTime(planSyncAt) : "")
    : (account?.lastSyncAt ? formatRelativeLocalTime(account.lastSyncAt) : "");
  const quotaResetAt = activeQuota?.resetAt ?? null;

  useLayoutEffect(() => {
    const card = cardRef.current;
    const providerContentElement = providerContentRef.current;
    const syncColumn = syncColRef.current;
    const naturalSyncElement = syncMeasureRef.current;
    if (!card || !providerContentElement || !syncColumn || !naturalSyncElement) return undefined;

    const measure = () => {
      const providerContentRect = providerContentElement.getBoundingClientRect();
      const syncColumnRect = syncColumn.getBoundingClientRect();
      const naturalSyncWidth = naturalSyncElement.getBoundingClientRect().width;
      const normalSyncLeft = syncColumnRect.right - naturalSyncWidth;
      const next = shouldStackProviderSync({
        balanceRight: providerContentRect.right,
        syncLeft: normalSyncLeft,
      });
      setStackSync(current => current === next ? current : next);
    };

    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    observer.observe(providerContentElement);
    observer.observe(syncColumn);
    observer.observe(naturalSyncElement);
    return () => observer.disconnect();
  }, [
    activeWindow,
    balance?.amount,
    balance?.currency,
    balanceFxRate,
    isPlan,
    percent,
    remainingPercent,
    syncLabel,
    windowLabels.length,
  ]);
  /**
   * 唯一健康标识（账号未设置 / 套餐（订阅）未设置 / 同步失败 / 倍率未校验 / 倍率待确认）：
   * 判定与文案复用 @/lib/sync-engine/target-health-badge，与供应商管理侧栏同一份。
   */
  const badge = resolveTargetBadge(badgeInputFromStatus(target, status), target.name);

  return (
    <a
      ref={cardRef}
      className={styles.providerCard}
      href={`/proxy-management?target=${encodeURIComponent(target.id)}`}
      title={`打开 ${target.name} 基础信息`}
    >
      <span className={styles.providerCardHead}>
        <span className={styles.providerCardName}>{target.name}</span>
        {/* 唯一健康标识：红=配置缺口/连续自动同步失败/倍率无从校验；黄=倍率待确认。 */}
        <TargetHealthBadge badge={badge} />
        <span className={`${styles.providerCardBadge} ${target.billingChannel === "subscription" ? styles.providerBadgeSubscription : target.billingChannel === "plan" ? styles.providerBadgePlan : ""}`}>
          {target.billingChannel === "subscription" ? "订阅" : target.billingChannel === "plan" ? "套餐" : "按量"}
        </span>
      </span>
      <span className={styles.providerBodyRow}>
        <span className={styles.providerLeft}>
      {isPlan ? (
        <>
          <span className={styles.providerCenterZone}>
            {windowLabels.length > 0 ? (
              <span ref={providerContentRef} className={styles.providerWindowRow} role="tablist" aria-label="用量窗口">
                {windowLabels.map(label => (
                  <button
                    key={label}
                    type="button"
                    role="tab"
                    aria-selected={label === activeWindow}
                    className={`${styles.providerWindowChip} ${label === activeWindow ? styles.providerWindowChipActive : ""}`}
                    onClick={event => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectQuotaWindow(label);
                    }}
                  >
                    {planQuotaWindowLabel(label)}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
          <span className={styles.providerBottomRow}>
            <span className={styles.providerQuotaBar} role="img" aria-label={`余量 ${remainingPercent === null ? "未知" : `${Math.round(remainingPercent)}%`}`}>
              <span className={`${styles.providerQuotaFill} ${quotaBarClass(percent)}`} style={{width: `${remainingPercent === null ? 0 : Math.max(2, remainingPercent)}%`}} />
            </span>
            <span className={styles.providerQuotaMetaRow}>
              <span className={styles.providerQuotaText}>
                <Ticket size={12} aria-hidden="true" />
                {remainingPercent !== null
                  ? `剩 ${Math.round(remainingPercent)}%`
                  : !status
                    ? "读取中…"
                    : status.plan.config
                      ? usageFallbackLabel("pending")
                      : usageFallbackLabel("plan")}
              </span>
              {quotaResetAt ? (
                <span className={styles.providerSync}><RotateCcw size={11} aria-hidden="true" /> 重置 {relativeFuture(quotaResetAt)}</span>
              ) : null}
            </span>
          </span>
        </>
      ) : (
        <>
          <span className={styles.providerCenterZone}>
            <span ref={providerContentRef} className={styles.providerBalance}>
              <CircleDollarSign size={14} aria-hidden="true" />
              {balance && account
                ? formatMoneyWithCnyEquivalent(balance.amount, balance.currency, balanceFxRate)
                : !status
                  ? "读取中…"
                  : usageFallbackLabel(account ? "balance-unavailable" : "account")}
            </span>
          </span>
          <span className={styles.providerBottomRow}>
            {account?.nextSyncAt ? (
              <span className={styles.providerSync}>下次同步 {relativeFuture(account.nextSyncAt)}</span>
            ) : <span className={styles.providerSync} />}
          </span>
        </>
      )}
        </span>
        <span
          ref={syncColRef}
          className={`${styles.providerSyncCol} ${stackSync ? styles.providerSyncColStacked : ""}`}
        >
          <span ref={syncMeasureRef} className={styles.providerSyncMeasure} aria-hidden="true">
            {syncLabel ? <><Clock3 size={11} aria-hidden="true" /> 同步 {syncLabel}</> : "尚未同步"}
          </span>
          {syncLabel ? (
            <span className={`${styles.providerSync} ${styles.providerSyncStatus}`}>
              <span className={styles.providerSyncPrefix}><Clock3 size={11} aria-hidden="true" /> 同步</span>
              <span className={styles.providerSyncValue}>{syncLabel}</span>
            </span>
          ) : <span className={styles.providerSync}>尚未同步</span>}
          <button
            type="button"
            className={styles.providerRefreshBtn}
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              onRefresh();
            }}
            disabled={refreshing}
            aria-label={`立即同步 ${target.name}`}
            title="立即同步"
          >
            <RotateCcw size={11} className={refreshing ? "spin" : ""} aria-hidden="true" />
          </button>
        </span>
      </span>
    </a>
  );
}
