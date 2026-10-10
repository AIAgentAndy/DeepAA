"use client";

import {Bot, Menu, Plus} from "lucide-react";
import {type KeyboardEvent, useEffect, useMemo, useRef, useState} from "react";
import {confirmDialog} from "@/components/confirm-dialog";
import {DevelopmentLaunchDialog} from "@/components/development-launch-dialog";
import {agentLabel as registryAgentLabel} from "@/lib/agent-registry";
import {AgentEntryBadges} from "@/components/proxy-management/agent-entry-badges";
import {AGENT_CATALOG, boundCompatibleTargetsForAgent, connectedAgents} from "@/components/proxy-management/agent-catalog";
import {ConnectAgentDialog} from "@/components/proxy-management/connect-agent-dialog";
import {ProxyOnboardingWizard, type OnboardingStep} from "@/components/proxy-management/proxy-onboarding-wizard";
import type {ModelDiscoverResponse} from "@/components/proxy-management/proxy-management-types";
import {ProxyAgentTab} from "@/components/proxy-management/proxy-agent-tab";
import {ProxyBasicTab} from "@/components/proxy-management/proxy-basic-tab";
import type {
  CliSyncStatus,
  CredentialItem,
  Notice,
  ProxySyncStatus,
  SyncOutcomePayload,
} from "@/components/proxy-management/proxy-management-types";
import styles from "@/components/proxy-management/proxy-management.module.css";
import {ProxyOverviewTab} from "@/components/proxy-management/proxy-overview-tab";
import {ProxyResourcesTab} from "@/components/proxy-management/proxy-resources-tab";
import {ProxyTargetSidebar} from "@/components/proxy-management/proxy-target-sidebar";
import type {ModelPriceEntry, PricingCatalogPage} from "@/lib/pricing";
import {providerCatalogHasChanges} from "@/lib/provider-catalog/review";
import type {ProviderCatalogReview as ProviderCatalogReviewData} from "@/lib/provider-catalog/service";
import {PROVIDER_PRESETS, derivePresetCurrency} from "@/lib/provider-presets";
import type {PlanProviderType, SyncProviderType} from "@/lib/sync-engine/types";
import type {SyncOverviewPayload, SyncOverviewTargetSummary} from "@/lib/sync-engine/overview-types";
import {resolveDerivedRouteId, routeIdFromUpstreamUrl} from "@/lib/proxy-url";
import {firstSidebarTargetId, proxyManagementTargetHref, resolveProxyOnboardingStartStep, resolveTargetModelPriceEntry, selectFallbackTarget} from "@/lib/proxy-management-domain";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {inferTargetChannelMetadata} from "@/lib/target-channel-metadata";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import type {AgentId, AgentModelAliases, ProxyConfig, ProxyTarget, ProxyTargetPricingRates} from "@/types";

const PRICING_CATALOG_LIMIT = 200;
const PRICING_SEARCH_DEBOUNCE_MS = 250;
const OPEN_PRICING_SETTINGS_EVENT = "deepaa:open-pricing-settings";

/** 首帧后低优先级任务调度：requestIdleCallback 缺省时退化为短超时。
 *  服务端所有 API 共用单进程事件循环，非关键请求（侧栏概览、价格目录、
 *  非选中供应商凭据）与首帧关键请求（status / config-sync）同时发出时互相
 *  排队；idle 派发让基础信息页签先拿到数据再补齐增强信息。 */
function scheduleIdle(task: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => task(), {timeout: 1500});
    return;
  }
  window.setTimeout(task, 300);
}

const TABS = [
  {id: "info", label: "基础信息"},
  {id: "resources", label: "密钥与模型"},
  {id: "agent", label: "Agent 接入"},
] as const;

type TabId = typeof TABS[number]["id"];

interface ProxyManagementPageProps {
  initialConfig: ProxyConfig;
}

interface ProxyConfigMutationResponse {
  config?: ProxyConfig;
  error?: string;
  message?: string;
  saved?: boolean;
  applied?: boolean;
}

interface NonceEnvelope {
  nonce?: string;
  error?: string;
  message?: string;
}

/**
 * 代理管理 V3 页面只负责编排：配置事务、nonce、副作用状态和选中上下文集中在此，
 * 各页签组件只维护局部表单，避免再次形成难以维护的超大单组件。
 */
export function ProxyManagementPage({initialConfig}: ProxyManagementPageProps) {
  const [config, setConfig] = useState(initialConfig);
  const [persistedConfig, setPersistedConfig] = useState(initialConfig);
  // 服务端确认值同步进 ref：向导等长流程中多个串行 API 调用不会因闭包陈旧
  // 而带上过期 revision / nonce（否则会出现 CONFIG_REVISION_CONFLICT / LAUNCH_NONCE_INVALID）。
  const persistedConfigRef = useRef(initialConfig);
  const mutationNonceRef = useRef("");
  /** 价格目录是否完成过首次加载（成功或失败）：逐模型补拉与初始 idle 派发的门控。 */
  const [pricingCatalogBootstrapped, setPricingCatalogBootstrapped] = useState(false);
  // 写操作串行队列：配置保存与 CLI 同步共用单次 nonce，并发请求会导致
  // 后到者 LAUNCH_NONCE_INVALID（非必现的「操作凭证已失效」），这里强制逐个执行。
  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [selectedTargetId, setSelectedTargetId] = useState(initialConfig.targets[0]?.id || "");
  const [draftCreatedAt, setDraftCreatedAt] = useState<string>();
  const [activeTab, setActiveTab] = useState<TabId>("info");
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [connectDialog, setConnectDialog] = useState<{initialAgent?: AgentId; currentTargetId?: string} | null>(null);
  /** 分步引导状态：step 为当前步骤；agent 存在时表示“为指定 Agent 接入当前供应商”，步骤就绪度按该 Agent 判定。 */
  const [onboardingStep, setOnboardingStep] = useState<{
    step: OnboardingStep;
    agent?: AgentId;
    /** 新建供应商必须录入本次首个密钥；恢复已有供应商时允许按已加载凭据自动越过该步骤。 */
    requireCredentialEntry?: boolean;
  } | null>(null);
  const [developmentTarget, setDevelopmentTarget] = useState<{target: ProxyTarget; cli: AgentId} | null>(null);
  const [credentialsByTarget, setCredentialsByTarget] = useState<Record<string, CredentialItem[]>>({});
  const [pricingModels, setPricingModels] = useState<ModelPriceEntry[]>([]);
  const [pricingSearch, setPricingSearch] = useState("");
  const [pricingModelLoading, setPricingModelLoading] = useState(false);
  const [providerCatalogReview, setProviderCatalogReview] = useState<ProviderCatalogReviewData>();
  const [providerCatalogLoading, setProviderCatalogLoading] = useState(false);
  /** 预设新建草稿的当前模型选择；未加载目录时保持 undefined，让服务端按「目录首位推荐模型」默认处理。 */
  const [presetSelectedModelIds, setPresetSelectedModelIds] = useState<string[] | undefined>();
  const [syncStatusByTarget, setSyncStatusByTarget] = useState<Record<string, ProxySyncStatus>>({});
  /**
   * 全量供应商同步概览（侧栏列表消费）：只读有界接口，每目标仅返回
   * 余额 / 主套餐窗口 / 倍率黄标计数，与「当前选中供应商」的完整 status 分离。
   */
  const [syncOverviewByTarget, setSyncOverviewByTarget] = useState<Record<string, SyncOverviewTargetSummary>>({});
  /** 已完成首次同步状态加载的供应商：区分「未加载」与「未配置」，未加载前总览页
   *  不得渲染「未配置」表单与引导文案（避免每次进入都闪烁，2026-09-16 用户确认）。 */
  const [syncStatusReadyTargets, setSyncStatusReadyTargets] = useState<ReadonlySet<string>>(new Set());
  const [cliSyncStatus, setCliSyncStatus] = useState<CliSyncStatus>();
  const [mutationNonce, setMutationNonce] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  /** 新建完成后的概览引导高亮：脉冲高亮「账号信息」或「套餐用量」卡片；lead 存在时卡片底部
   *  附加专属提示文案（仅订阅通道），标准引导文案已内嵌到对应表单底部。 */
  const [overviewHighlight, setOverviewHighlight] = useState<{kind: "account" | "plan"; lead?: string; emphasis?: string} | null>(null);

  // 草稿按 createdAt 身份解析：新建草稿的路由 ID 可能与已有供应商撞名（URL 派生），
  // 仅按 id 匹配会把草稿误解析成旧供应商，导致表单落到已保存供应商的更新分支。
  const selectedTarget = draftCreatedAt
    ? config.targets.find(target => target.createdAt === draftCreatedAt)
    : config.targets.find(target => target.id === selectedTargetId);
  // 以 createdAt 身份匹配持久化供应商：新草稿的路由 ID 可能恰好与已有供应商相同
  // （如 URL 派生撞名），仅按 id 匹配会把草稿误判为已保存供应商导致走更新分支。
  const selectedTargetPersisted = Boolean(selectedTarget && persistedConfig.targets.some(target =>
    target.id === selectedTarget.id && target.createdAt === selectedTarget.createdAt));
  const connectedAgentsList = useMemo(() => connectedAgents(config), [config]);
  const allCredentials = useMemo(() => {
    const seen = new Set<string>();
    return Object.values(credentialsByTarget).flat().filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [credentialsByTarget]);
  // 启用代理供应商需要供应商本身具备完整路由条件：协议 URL、支持的模型、系统密钥。
  // 缺少任一项时禁止勾选，并在开关下说明补齐路径，保证状态自洽。
  const targetCredentials = allCredentials.filter(item => item.targetId === selectedTarget?.id);
  const selectedPreset = selectedTarget ? resolveOfficialPresetForTarget(selectedTarget) : undefined;
  const selectedChannelBadge = (() => {
    if (!selectedTarget) return null;
    const channel = selectedTarget.billingChannel || inferTargetChannelMetadata(selectedTarget).billingChannel;
    return channel === "plan" ? "套餐通道" : channel === "subscription" ? "订阅通道" : "按量通道";
  })();
  const targetCanEnable = Boolean(selectedTarget
    && (selectedTarget.openaiUrl || selectedTarget.anthropicUrl)
    && selectedTarget.supportedModels.length > 0
    && selectedTarget.supportedModels.every(modelId => {
      const mapping = selectedTarget.pricing?.modelVendors?.[modelId];
      const mappedEntry = mapping?.priceEntryId
        ? pricingModels.find(entry => entry.id === mapping.priceEntryId)
        : undefined;
      const runtimeEntry = selectedPreset
        ? pricingModels.find(entry => entry.vendor.trim().toLowerCase() === selectedPreset.pricingProviderId.toLowerCase()
          && runtimeModelIdOf(entry).trim().toLowerCase() === modelId.trim().toLowerCase())
        : undefined;
      return Boolean(mapping?.vendor && mapping.priceEntryId && mappedEntry)
        || Boolean(selectedPreset && runtimeEntry?.pricing
          && Number.isFinite(runtimeEntry.pricing.input)
          && Number.isFinite(runtimeEntry.pricing.output));
    })
    && targetCredentials.length > 0);
  const enableBlockers = useMemo(() => {
    if (!selectedTarget) return [];
    const blockers: string[] = [];
    if (!selectedTarget.openaiUrl && !selectedTarget.anthropicUrl) blockers.push("填写至少一个协议上游 URL");
    if (selectedTarget.supportedModels.length === 0) blockers.push("在「密钥与模型」添加支持的模型");
    else if (selectedTarget.supportedModels.some(modelId => {
      const mapping = selectedTarget.pricing?.modelVendors?.[modelId];
      const mappedEntry = mapping?.priceEntryId ? pricingModels.find(entry => entry.id === mapping.priceEntryId) : undefined;
      const runtimeEntry = selectedPreset
        ? pricingModels.find(entry => entry.vendor.trim().toLowerCase() === selectedPreset.pricingProviderId.toLowerCase()
          && runtimeModelIdOf(entry).trim().toLowerCase() === modelId.trim().toLowerCase())
        : undefined;
      return (!mapping?.vendor || !mapping.priceEntryId || !mappedEntry)
        && !(selectedPreset && runtimeEntry?.pricing
          && Number.isFinite(runtimeEntry.pricing.input)
          && Number.isFinite(runtimeEntry.pricing.output));
    })) blockers.push("为全部 Agent 可见模型建立唯一价格中心映射");
    if (allCredentials.filter(item => item.targetId === selectedTarget.id).length === 0) blockers.push("在「密钥与模型」新增系统密钥");
    return blockers;
  }, [selectedTarget, selectedPreset, pricingModels, allCredentials]);

  /** 固定流程中的第一个未完成步骤由领域规则统一解析，避免页面入口之间产生不同判断。 */
  function firstMissingOnboardingStep(target: ProxyTarget, agent?: AgentId): OnboardingStep | null {
    return resolveProxyOnboardingStartStep({target, config, credentials: allCredentials, agent});
  }

  /** 打开分步引导：从“为指定 Agent 接入当前供应商”或全局流程的第一个未完成步骤开始。 */
  function openOnboardingWizard(agent?: AgentId) {
    if (!selectedTarget) return;
    const first = firstMissingOnboardingStep(selectedTarget, agent);
    if (first) setOnboardingStep({step: first, ...(agent ? {agent} : {})});
  }

  /** 模型自动发现：只读探测 /models，不直接修改 Agent 可见模型。 */
  async function discoverTargetModels(credentialId?: string): Promise<ModelDiscoverResponse> {
    if (!selectedTarget || !selectedTargetPersisted) throw new Error("请先保存供应商");
    const body = await nonceMutation("/api/proxy-sync/discover-models", "POST", {targetId: selectedTarget.id, ...(credentialId ? {credentialId} : {})});
    return body as unknown as ModelDiscoverResponse;
  }

  /** 模型确认是独立写命令；服务端会重新探测并校验价格映射后再保存。 */
  async function confirmTargetModels(credentialId: string, selectedModelIds: string[]): Promise<ModelDiscoverResponse> {
    if (!selectedTarget || !selectedTargetPersisted) throw new Error("请先保存供应商");
    const body = await nonceMutation("/api/proxy-sync/discover-models", "POST", {
      action: "confirm",
      targetId: selectedTarget.id,
      credentialId,
      selectedModelIds,
    });
    await reloadProxyConfig(true);
    return body as unknown as ModelDiscoverResponse;
  }

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlTargetId = urlParams.get("target");
    if (urlTargetId && initialConfig.targets.some(target => target.id === urlTargetId)) {
      setSelectedTargetId(urlTargetId);
    } else if (urlTargetId) {
      // 链接中的供应商已不存在（配置被重建或清理）：提示回退，避免用户以为在看旧供应商。
      // 回退到侧栏第一个供应商，而不是配置数组首项（两者排序规则不同）。
      const fallbackTargetId = firstSidebarTargetId(initialConfig.targets) || "";
      setSelectedTargetId(fallbackTargetId);
      syncSelectedTargetUrl(fallbackTargetId);
      const fallbackName = initialConfig.targets.find(target => target.id === fallbackTargetId)?.name || fallbackTargetId || "空配置";
      setNotice({kind: "error", message: `链接中的供应商「${urlTargetId}」在当前配置中不存在，已切换到「${fallbackName}」。`});
    }
    // 仪表盘空态深链接：?new=1 直接进入新建供应商草稿，与点击页头「新建供应商」完全同效；
    // 进入后立即从地址栏移除标记，避免刷新页面重复创建草稿。带 target 深链接时以 target 为准。
    if (!urlTargetId && urlParams.get("new") === "1") {
      addTarget();
      urlParams.delete("new");
      const rest = urlParams.toString();
      window.history.replaceState({}, "", `/proxy-management${rest ? `?${rest}` : ""}`);
    }
    // 初始请求带有效初始供应商；startup 只有 nonce 也足够（POST 端自动重签）。
    const initialTargetId = urlTargetId && initialConfig.targets.some(target => target.id === urlTargetId)
      ? urlTargetId
      : (initialConfig.targets[0]?.id || "");
    void loadCliSyncStatus(initialTargetId);
    // 加载所有代理供应商的凭据：左侧「各 Agent 默认入口」是独立列表，
    // 其“Agent 是否有供应商支持”的判定需要全量凭据，不能随选中供应商联动。
    // 批量接口一次拉齐（供应商 + 各 Agent 默认供应商去重），替代逐目标 N 次请求；
    // 非首帧关键路径，idle 派发让 status / config-sync 先行。
    scheduleIdle(() => void loadCredentialsBatch([...new Set([
      ...initialConfig.targets.map(target => target.id),
      ...Object.values(initialConfig.agentConnections)
        .map(connection => connection?.defaultTargetId)
        .filter((id): id is string => Boolean(id)),
    ])]));
    // 初始配置固定来自服务端；后续变更由显式 API 操作驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 侧栏概览：供应商列表需要余额 / 套餐窗口用量 / 倍率黄标，
   * 但完整 status 只对「当前选中供应商」读取。这里按目标 id 集合
   * 一次性拉有界概览，配置增删改后自动重取。
   */
  const overviewTargetKey = config.targets.map(target => target.id).join(",");
  useEffect(() => {
    // 侧栏徽标是增强信息且服务端有短 TTL 缓存：idle 派发，不与首帧关键请求抢事件循环。
    scheduleIdle(() => void loadSyncOverview(overviewTargetKey ? overviewTargetKey.split(",") : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviewTargetKey]);

  // 提示浮窗自动消失：成功提示约 3.6 秒、错误提示约 6 秒后自动关闭。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === "error" ? 6000 : 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** 新建完成后按供应商类型计算概览引导：脉冲高亮「账号信息」或「套餐用量」卡片。
   *  标准引导文案已内嵌到对应表单底部（未完成保存前常驻），这里仅订阅通道保留专属提示文案。 */
  function buildOverviewHighlight(target: ProxyTarget): {kind: "account" | "plan"; lead?: string; emphasis?: string} | null {
    const preset = resolveOfficialPresetForTarget(target);
    if (!preset) return {kind: "account"};
    if (target.billingChannel === "plan" || target.billingChannel === "subscription") {
      if (target.billingChannel === "subscription") {
        return {kind: "plan", lead: "订阅通道：套餐用量由本机官方 CLI 登录只读读取，请在官方 CLI 登录后保存「套餐用量」配置"};
      }
      return {kind: "plan"};
    }
    return {kind: "account"};
  }

  // 价格中心搜索防抖：搜索词变化后延迟请求服务端，避免每次击键都发请求；
  // 初始空搜索词在挂载后 idle 派发加载价格中心前 200 条，供「添加支持的模型」选择——
  // 它不在基础信息首帧关键路径上，不与 status / config-sync 抢服务端事件循环。
  useEffect(() => {
    if (!pricingSearch && !pricingCatalogBootstrapped) {
      scheduleIdle(() => void loadPricingCatalog(pricingSearch));
      return;
    }
    const timer = window.setTimeout(() => {
      void loadPricingCatalog(pricingSearch);
    }, PRICING_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingSearch]);

  useEffect(() => {
    if (!selectedTargetId || !selectedTargetPersisted) return;
    void loadCredentials(selectedTargetId);
    void loadSyncStatus(selectedTargetId);
    // 当前供应商切换后重拉受管文件 manifest；正文与供应商贡献在用户展开文件时按需计算。
    void loadCliSyncStatus(selectedTargetId);
    // persisted 标记只用于避免对未保存草稿发请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTargetId, selectedTargetPersisted]);

  useEffect(() => {
    if (!selectedTarget || !selectedTargetPersisted) return;
    // 首次价格目录加载完成前不逐模型补拉：目录本体大概率已覆盖这些条目，
    // 空列表时触发只会与目录加载重复请求并抢占首帧事件循环。
    if (!pricingCatalogBootstrapped) return;
    const missingPriceQueries = selectedTarget.supportedModels
      .map(modelId => {
        const mapping = selectedTarget.pricing?.modelVendors?.[modelId];
        const mapped = mapping?.priceEntryId ? pricingModels.find(entry => entry.id === mapping.priceEntryId) : undefined;
        return mapped ? undefined : modelId;
      })
      .filter((modelId): modelId is string => Boolean(modelId))
      .slice(0, 50);
    if (missingPriceQueries.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const modelId of missingPriceQueries) {
        const mapping = selectedTarget.pricing?.modelVendors?.[modelId];
        // 优先按供应商映射的 priceEntryId 精确补拉权威条目，避免同名模型跨供应商误取；
        // 旧供应商无 priceEntryId 时按模型名搜索，再由领域规则按供应商锁定命中。
        const search = mapping?.priceEntryId || modelId;
        const params = new URLSearchParams({view: "catalog", search, limit: "20", offset: "0"});
        const response = await fetch(`/api/model-pricing?${params}`, {cache: "no-store"});
        if (!response.ok) continue;
        const page = await response.json() as PricingCatalogPage;
        const hit = resolveTargetModelPriceEntry(page.items, modelId, mapping);
        if (hit && !cancelled) {
          setPricingModels(current => current.some(item => item.id === hit.id) ? current : [...current, hit]);
        }
      }
    })().catch(() => undefined);
    return () => {cancelled = true;};
  }, [pricingModels, pricingCatalogBootstrapped, selectedTarget, selectedTargetPersisted]);

  function selectTarget(targetId: string, createdAt?: string) {
    // 草稿与已保存供应商可能路由 ID 撞名：按 createdAt 区分身份。
    // 点击草稿时恢复草稿编辑态，点击其它已保存供应商时退出草稿编辑。
    const clicked = createdAt
      ? config.targets.find(target => target.id === targetId && target.createdAt === createdAt)
      : undefined;
    const clickedIsDraft = Boolean(clicked && !persistedConfig.targets.some(target =>
      target.id === clicked.id && target.createdAt === clicked.createdAt));
    setDraftCreatedAt(clickedIsDraft ? createdAt : undefined);
    setSelectedTargetId(targetId);
    setSidebarOpen(false);
    setNotice(null);
    setProviderCatalogReview(undefined);
    setPresetSelectedModelIds(undefined);
    syncSelectedTargetUrl(targetId);
  }

  /** 所有供应商切换入口共用同一 URL 写回，避免页面状态和刷新后的深链接分叉。 */
  function syncSelectedTargetUrl(targetId: string) {
    window.history.replaceState({}, "", proxyManagementTargetHref(window.location.href, targetId));
  }

  function addTarget() {
    if (draftCreatedAt) {
      const existingDraft = config.targets.find(target => target.createdAt === draftCreatedAt);
      if (existingDraft) selectTarget(existingDraft.id, existingDraft.createdAt);
      setNotice({kind: "error", message: "请先保存或删除当前新增草稿，再创建另一个供应商。"});
      return;
    }
    const timestamp = new Date().toISOString();
    const draft: ProxyTarget = {
      // 路由 ID 新建时保持空：BaseURL 必填，输入后自动派生填充，不生成随机占位。
      id: "",
      name: "",
      enabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      supportedModels: [],
      pricing: {},
    };
    setDraftCreatedAt(timestamp);
    setConfig(current => ({...current, targets: [...current.targets, draft]}));
    setSelectedTargetId(draft.id);
    setActiveTab("info");
    setSidebarOpen(false);
    // 不弹提示：直接切到「基础信息」页签，由上游请求 URL 卡片的高亮引导填写。
  }

  function updateSelectedTarget(patch: Partial<ProxyTarget>) {
    if (!selectedTarget) return;
    const previousId = selectedTarget.id;
    setConfig(current => ({
      ...current,
      targets: current.targets.map(target => target.createdAt === selectedTarget.createdAt
        ? {...target, ...patch}
        : target),
    }));
    if (patch.id && patch.id !== previousId) setSelectedTargetId(patch.id);
  }

  async function saveSelectedTarget(): Promise<void> {
    if (!selectedTarget) return;
    let normalized: ProxyTarget;
    try {
      normalized = normalizeTargetDraft(
        selectedTarget,
        persistedConfig.targets
          .filter(target => target.createdAt !== selectedTarget.createdAt),
      );
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "供应商配置无效")});
      return;
    }
    setBusy(true);
    setNotice(null);
    const isDraft = !selectedTargetPersisted;
    try {
      // 路由 ID 撞名防护：新建供应商的路由 ID 与已有供应商相同时拒绝保存，
      // 避免配置中出现两个同 ID 供应商（网关按 ID 前缀路由，无法消歧）。
      if (isDraft && persistedConfig.targets.some(target => target.id === normalized.id)) {
        throw new Error("DUPLICATE_TARGET_ID");
      }
      const preset = isDraft
        ? PROVIDER_PRESETS.find(item => item.id === normalized.presetId && item.ready)
          || resolveOfficialPresetForTarget(normalized)
        : undefined;
      let saved: {config: ProxyConfig; applied?: boolean};
      let onboardingTarget = normalized;
      if (preset) {
        const body = await nonceMutation("/api/provider-catalog/apply", "POST", {
          action: "create",
          presetId: preset.id,
          target: {
            id: normalized.id,
            name: normalized.name,
            openaiUrl: normalized.openaiUrl,
            anthropicUrl: normalized.anthropicUrl,
            // 预设创建只允许空 pricing 占位：vendor 等由服务端按预设落库，
            // 草稿里的 pricing.vendor（applyPreset 写入）不能随请求提交。
            pricing: {},
            createdAt: normalized.createdAt,
            updatedAt: normalized.updatedAt,
          },
          ...(presetSelectedModelIds === undefined ? {} : {selectedModelIds: presetSelectedModelIds}),
          expectedRevision: persistedConfigRef.current.revision,
        }) as {config?: ProxyConfig; target?: ProxyTarget};
        if (!body.config || !body.target) throw new Error("供应商预设创建响应不完整");
        applyServerConfig(body.config, false);
        onboardingTarget = body.target;
        saved = {config: body.config};
        await loadPricingCatalog(pricingSearch);
      } else {
        saved = await mutateProxyConfig({
          targetPatch: isDraft
            ? {target: normalized}
            : {id: selectedTarget.id, target: normalized},
        }, {preserveDraft: false});
      }
      setDraftCreatedAt(undefined);
      setSelectedTargetId(normalized.id);
      syncSelectedTargetUrl(normalized.id);
      if (isDraft) {
        setProviderCatalogReview(undefined);
        setPresetSelectedModelIds(undefined);
        // 新建提交后直接进入分步引导向导：官方预设已具备模型，先补密钥；自定义供应商继续发现模型。
        // 不再弹「已保存」浮窗，向导本身就是引导；CLI 同步失败也不打断。
        setActiveTab("info");
        const first = resolveProxyOnboardingStartStep({
          target: onboardingTarget,
          config: saved.config,
          credentials: allCredentials,
          isNewTarget: true,
        });
        setOnboardingStep(first ? {step: first, requireCredentialEntry: true} : null);
        await syncCliConfiguration(false).catch(() => undefined);
      } else {
        const syncMessage = await syncCliConfiguration(false).catch(error => `；CLI 同步失败：${errorMessage(error, "未知错误")}`);
        setNotice({
          kind: "success",
          message: `供应商已保存${saved.applied === false ? "；代理进程仍在应用新 revision" : ""}${syncMessage || ""}`,
        });
      }
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "保存供应商失败")});
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedTarget(): Promise<void> {
    if (!selectedTarget) return;
    if (!selectedTargetPersisted) {
      const confirmed = await confirmDialog({title: "删除未保存草稿", danger: true, message: `确认删除未保存的供应商「${selectedTarget.name || selectedTarget.id}」？`});
      if (!confirmed) return;
      setConfig(current => ({...current, targets: current.targets.filter(target => target.createdAt !== selectedTarget.createdAt)}));
      setDraftCreatedAt(undefined);
      const fallbackTargetId = firstSidebarTargetId(persistedConfig.targets, search) || "";
      setSelectedTargetId(fallbackTargetId);
      syncSelectedTargetUrl(fallbackTargetId);
      setNotice({kind: "success", message: "未保存草稿已删除。"});
      return;
    }
    if (selectedTarget.enabled) {
      setNotice({kind: "error", message: "删除前必须先停用供应商。停用会同步清理各 Agent 的受管模型目录。"});
      return;
    }
    const defaultAgents = AGENT_CATALOG.filter(entry => config.agentConnections[entry.id]?.defaultTargetId === selectedTarget.id);
    if (defaultAgents.length > 0) {
      setNotice({kind: "error", message: `该供应商仍是 ${defaultAgents.map(entry => entry.label).join("、")} 的默认供应商，请先调整默认链。`});
      return;
    }
    const confirmed = await confirmDialog({title: "删除供应商", danger: true, message: `确认删除已停用的供应商「${selectedTarget.name || selectedTarget.id}」？供应商配置删除后将继续清理系统密钥、控制台账号和套餐快照。`});
    if (!confirmed) return;
    setBusy(true);
    try {
      // 服务端先原子校验“已停用 + 无默认引用”并删除供应商配置；校验失败时绝不提前破坏凭据。
      const saved = await mutateProxyConfig({targetDelete: {id: selectedTarget.id}}, {preserveDraft: true});
      const purgeFailures: string[] = [];
      try {
        const purgeResult = await nonceMutation("/api/development-launch/credentials/purge", "POST", {targetId: selectedTarget.id});
        if (Array.isArray(purgeResult.failed) && purgeResult.failed.length > 0) {
          purgeFailures.push(`系统密钥清理失败（${purgeResult.failed.length} 条）`);
        }
      } catch {
        purgeFailures.push("系统密钥清理失败");
      }
      try {
        await nonceMutation("/api/proxy-sync/console-account", "DELETE", {targetId: selectedTarget.id});
      } catch {
        purgeFailures.push("控制台账号清理失败");
      }
      try {
        await nonceMutation("/api/proxy-sync/plan-config", "DELETE", {
          targetId: selectedTarget.id,
          expectedRevision: saved.config.revision,
        });
      } catch {
        purgeFailures.push("套餐同步配置清理失败");
      }
      setCredentialsByTarget(current => {
        const next = {...current};
        delete next[selectedTarget.id];
        return next;
      });
      setSyncStatusByTarget(current => {
        const next = {...current};
        delete next[selectedTarget.id];
        return next;
      });
      setSyncStatusReadyTargets(current => {
        const next = new Set(current);
        next.delete(selectedTarget.id);
        return next;
      });
      const fallbackTargetId = firstSidebarTargetId(saved.config.targets, search) || "";
      setSelectedTargetId(fallbackTargetId);
      syncSelectedTargetUrl(fallbackTargetId);
      const syncFailure = await syncCliConfiguration(false).catch(error => errorMessage(error, "CLI 同步失败"));
      setNotice({kind: syncFailure || purgeFailures.length > 0 ? "error" : "success", message: `供应商「${selectedTarget.name || selectedTarget.id}」已删除。${purgeFailures.length > 0 ? `${purgeFailures.join("、")}，请稍后在系统凭据库/控制台手动检查。` : ""}${syncFailure ? ` CLI 同步失败：${syncFailure}` : ""}`});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "删除供应商失败")});
    } finally {
      setBusy(false);
    }
  }

  async function saveAgentConnection(input: {
    agent: AgentId;
    boundTargetIds?: string[];
    defaultTargetId?: string;
    defaultModelId?: string;
    defaultCredentialId?: string;
    cliSyncEnabled: boolean;
    clearDefaultTarget?: boolean;
  }, options: {silent?: boolean} = {}): Promise<void> {
    setBusy(true);
    try {
      const {clearDefaultTarget, ...connectionPatch} = input;
      await mutateProxyConfig({
        agentConnectionPatch: {
          ...connectionPatch,
          ...(clearDefaultTarget ? {defaultTargetId: ""} : {}),
          action: "connect",
        },
      }, {preserveDraft: true});
      await syncCliConfiguration(false);
      if (!options.silent) setNotice({kind: "success", message: `${agentLabel(input.agent)} 默认入口已保存。`});
    } catch (error) {
      const message = errorMessage(error, "Agent 接入失败");
      setNotice({kind: "error", message});
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnectAgent(agent: AgentId): Promise<void> {
    const confirmed = await confirmDialog({title: "断开 Agent", danger: true, message: `断开 ${agentLabel(agent)} 后会清理 DeepAA 受管 CLI 配置，但不会删除共享供应商、模型或密钥。确认继续？`});
    if (!confirmed) return;
    setBusy(true);
    try {
      await mutateProxyConfig({agentConnectionPatch: {agent, action: "disconnect"}}, {preserveDraft: true});
      await syncCliConfiguration(false);
      setNotice({kind: "success", message: `${agentLabel(agent)} 已断开，受管 CLI 配置已清理。`});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "断开 Agent 失败")});
    } finally {
      setBusy(false);
    }
  }

  async function unbindAgentTarget(agent: AgentId, targetId: string): Promise<void> {
    const confirmed = await confirmDialog({title: "解除供应商绑定", danger: true, message: `确认解除「${agentLabel(agent)}」与当前供应商的绑定？这不会删除供应商、模型或密钥；如果当前供应商是默认供应商，请先切换默认链。`});
    if (!confirmed) return;
    setBusy(true);
    try {
      await mutateProxyConfig({agentConnectionPatch: {agent, action: "unbind", targetId}}, {preserveDraft: true});
      await syncCliConfiguration(false);
      setNotice({kind: "success", message: `${agentLabel(agent)} 已解除当前供应商绑定。`});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "解除供应商绑定失败")});
    } finally {
      setBusy(false);
    }
  }

  /** 级联取消接入（无二次确认，适用变更确认框已说明完整级联后果）：
   * 供应商失去对某些 Agent 的支持后，自动解除这些 Agent 与当前供应商的绑定；
   * 默认供应商引用指向当前供应商时先清空（服务端 unbind 拒绝默认目标），
   * 最后更新本地受管配置，让该 Agent 的配置文件移除当前供应商的关联模型。 */
  async function unbindDroppedAgents(agents: AgentId[]): Promise<void> {
    if (!selectedTarget) return;
    const targetId = selectedTarget.id;
    let unboundLabels: string[] = [];
    for (const agent of agents) {
      const connection = config.agentConnections[agent];
      if (!connection || connection.enabled === false) continue;
      const bound = connection.boundTargetIds?.includes(targetId) || connection.defaultTargetId === targetId;
      if (!bound) continue;
      try {
        if (connection.defaultTargetId === targetId) {
          await mutateProxyConfig({
            agentConnectionPatch: {agent, action: "connect", defaultTargetId: "", cliSyncEnabled: connection.cliSyncEnabled},
          }, {preserveDraft: true});
        }
        await mutateProxyConfig({agentConnectionPatch: {agent, action: "unbind", targetId}}, {preserveDraft: true});
        unboundLabels.push(agentLabel(agent));
      } catch (error) {
        setNotice({kind: "error", message: `自动取消 ${agentLabel(agent)} 接入失败：${errorMessage(error, "未知错误")}`});
      }
    }
    if (unboundLabels.length > 0) {
      await syncCliConfiguration(false).catch(() => undefined);
      setNotice({kind: "success", message: `已自动取消 ${unboundLabels.join("、")} 在当前供应商的接入。`});
    }
  }

  async function updateClaudeAliases(_agent: "claude", aliases: AgentModelAliases): Promise<void> {
    const connection = config.agentConnections.claude;
    if (!connection) return;
    setBusy(true);
    try {
      await mutateProxyConfig({
        agentConnectionPatch: {
          agent: "claude",
          action: "connect",
          cliSyncEnabled: connection.cliSyncEnabled,
          modelAliases: aliases,
        },
      }, {preserveDraft: true});
      await syncCliConfiguration(false);
      setNotice({kind: "success", message: "Claude Code 全局模型别名已更新。"});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "保存 Claude Code 别名失败")});
    } finally {
      setBusy(false);
    }
  }

  async function patchSelectedTarget(patch: Partial<ProxyTarget>, successMessage?: string): Promise<void> {
    if (!selectedTarget || !selectedTargetPersisted) {
      updateSelectedTarget(patch);
      setNotice({kind: "error", message: "请先保存此供应商，再执行即时设置。"});
      return;
    }
    setBusy(true);
    try {
      await mutateProxyConfig({targetPatch: {id: selectedTarget.id, target: patch}}, {preserveDraft: true});
      await syncCliConfiguration(false);
      if (successMessage) setNotice({kind: "success", message: successMessage});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "保存供应商设置失败")});
      throw error;
    } finally {
      setBusy(false);
    }
  }

  /** 头部启用开关：启用需先满足协议 URL、模型、密钥前置条件；停用需二次确认并处理默认代理切换。 */
  async function toggleTargetEnabled(): Promise<void> {
    if (!selectedTarget || !selectedTargetPersisted) return;
    if (!selectedTarget.enabled && !targetCanEnable) {
      setNotice({kind: "error", message: `启用前需补齐：${enableBlockers.join("；")}。`});
      return;
    }
    const next = !selectedTarget.enabled;
    if (!next) {
      // 停用前二次确认：说明影响，并按规则提示每个受影响 Agent 的默认代理去向。
      const usingAgents = AGENT_CATALOG.filter(entry => config.agentConnections[entry.id]?.defaultTargetId === selectedTarget.id);
      const impacts = usingAgents.map(entry => {
        // 只允许从该 Agent 已绑定且完整 ready 的供应商中选择回退，不得落到半配置供应商。
        const connection = config.agentConnections[entry.id];
        const fallback = selectFallbackTarget(
          [...config.targets].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
          entry.id,
          selectedTarget.id,
          connection?.boundTargetIds || [],
          new Set(allCredentials.map(item => item.id)),
        );
        return {entry, fallback};
      });
      const message = [
        `确认停用供应商「${selectedTarget.name || selectedTarget.id}」？`,
        "停用后所有 Agent 将无法使用该供应商。",
        ...impacts.map(({entry, fallback}) => fallback
          ? `- ${entry.label}：当前默认供应商，停用后将自动切换为「${fallback.name}」。`
          : `- ${entry.label}：当前默认供应商，且无其他可用供应商，将变为待配置状态，无法使用！`),
        "确认停用？",
      ].join("\n");
      const confirmed = await confirmDialog({title: "停用供应商", danger: true, message});
      if (!confirmed) return;
      let disabledSaved = false;
      try {
        await patchSelectedTarget({enabled: false}, "供应商已停用。");
        disabledSaved = true;
      } catch {
        // 停用配置没有保存成功时，禁止继续修改默认链，避免 UI 提示与真实状态分叉。
      }
      if (!disabledSaved) return;
      // 受影响 Agent 的默认代理按提示规则自动切换（无可用代理则清除为待配置）。
      for (const {entry, fallback} of impacts) {
        await saveAgentConnection({
          agent: entry.id,
          ...(fallback ? {defaultTargetId: fallback.id} : {clearDefaultTarget: true}),
          cliSyncEnabled: true,
        }).catch(error => setNotice({kind: "error", message: `${entry.label} 默认供应商切换失败：${errorMessage(error, "未知错误")}`}));
      }
      return;
    }
    await patchSelectedTarget({enabled: true}, "供应商已启用。").catch(() => undefined);
  }

  async function setAgentDefaultTarget(agent: AgentId): Promise<void> {
    if (!selectedTarget) return;
    const defaultModelId = selectedTarget.development?.defaultModels?.[agent];
    const defaultCredentialId = selectedTarget.development?.defaultCredentials?.[agent];
    const connection = config.agentConnections[agent];
    if (!connection) return;
    setBusy(true);
    try {
      await mutateProxyConfig({
        agentConnectionPatch: {
          agent,
          action: "connect",
          defaultTargetId: selectedTarget.id,
          ...(defaultModelId ? {defaultModelId} : {}),
          ...(defaultCredentialId ? {defaultCredentialId} : {}),
          cliSyncEnabled: connection.cliSyncEnabled,
        },
      }, {preserveDraft: true});
      await syncCliConfiguration(false);
      setNotice({kind: "success", message: `${selectedTarget.name} 已设为 ${agentLabel(agent)} 默认供应商。`});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "设置默认供应商失败")});
    } finally {
      setBusy(false);
    }
  }

  /**
   * CLI 形态切换内核（无确认弹窗）：agentConnectionPatch 落库 + CLI 受管配置同步。
   * 供两处消费：Agent 接入页「CLI 形态」区块（自带确认弹窗）与开发启动弹窗的
   * 「确认切换为 X 模式并启动」按钮（按钮即确认，2026-10-09 用户确认）。
   */
  async function performCliFormSwitch(agent: AgentId, gatewayMode: boolean): Promise<void> {
    const connection = config.agentConnections[agent];
    if (!connection) throw new Error("该 Agent 尚未接入");
    await mutateProxyConfig({
      agentConnectionPatch: {agent, action: "connect", cliSyncEnabled: gatewayMode},
    }, {preserveDraft: true});
    await syncCliConfiguration(false);
  }

  /** 切换「CLI 形态」（2026-10-09 用户确认）：网关模式写受管配置；官方模式清空受管层还原官方登录原生使用。 */
  async function setAgentCliForm(agent: AgentId, gatewayMode: boolean): Promise<void> {
    const label = agentLabel(agent);
    const confirmed = await confirmDialog({
      title: gatewayMode ? `切换 ${label} 为网关模式` : `切换 ${label} 为官方模式`,
      message: gatewayMode
        ? `将把 ${label} 的 CLI 配置重新指向本地网关（模型目录为网关模型）。已打开的 ${label} 客户端需重启后生效。`
        : `将清空 ${label} 的受管网关配置，还原为官方登录原生使用（${OFFICIAL_MODE_HINTS[agent] ?? "使用官方登录与官方端点"}）。已打开的 ${label} 客户端需重启后生效。`,
    });
    if (!confirmed) return;
    const connection = config.agentConnections[agent];
    if (!connection) return;
    setBusy(true);
    try {
      await performCliFormSwitch(agent, gatewayMode);
      setNotice({
        kind: "success",
        message: gatewayMode
          ? `${label} 已切换为网关模式：受管配置已写入，重启 ${label} 客户端后生效。`
          : `${label} 已切换为官方模式：受管配置已清空，重启 ${label} 客户端后生效。`,
      });
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "切换 CLI 形态失败")});
    } finally {
      setBusy(false);
    }
  }

  /** 管理页与仪表盘共用：返回当前 Agent 可切换的已启用、已绑定且协议可用供应商。 */
  function developmentTargetsForAgent(agent: AgentId): ProxyTarget[] {
    return boundCompatibleTargetsForAgent(config, agent);
  }

  async function setTargetDefaultModel(agent: AgentId, modelId: string): Promise<void> {
    if (!selectedTarget) return;
    await patchSelectedTarget({
      development: {
        ...selectedTarget.development,
        defaultModels: {...selectedTarget.development?.defaultModels, [agent]: modelId},
      },
    }, `已设置当前供应商的 ${agentLabel(agent)} 默认模型。`);
  }

  async function setTargetDefaultCredential(agent: AgentId, credentialId: string): Promise<void> {
    if (!selectedTarget) return;
    await patchSelectedTarget({
      development: {
        ...selectedTarget.development,
        defaultCredentials: {...selectedTarget.development?.defaultCredentials, [agent]: credentialId},
      },
    }, `已设置当前供应商的 ${agentLabel(agent)} 默认密钥。`);
  }

  async function toggleCliExclusion(agent: AgentId, excluded: boolean): Promise<void> {
    if (!selectedTarget) return;
    const exclusions = new Set(selectedTarget.cliSyncExclusions || []);
    if (excluded) exclusions.add(agent); else exclusions.delete(agent);
    await patchSelectedTarget({cliSyncExclusions: exclusions.size > 0 ? [...exclusions] : undefined}, excluded
      ? `当前供应商已从 ${agentLabel(agent)} CLI 目录排除。`
      : `当前供应商已纳入 ${agentLabel(agent)} CLI 目录。`);
  }

  async function createCredential(input: {label: string; secret: string; rateMultiplier: number; agentScope?: string[]}): Promise<string | undefined> {
    if (!selectedTarget || !selectedTargetPersisted) throw new Error("请先保存供应商，再新增密钥");
    setBusy(true);
    try {
      const body = await nonceMutation("/api/development-launch/credentials", "POST", {targetId: selectedTarget.id, ...input}) as {credential?: {id?: string}};
      await loadCredentials(selectedTarget.id);
      // 凭据服务会在首个密钥创建后补齐供应商默认密钥；立即刷新配置，让向导下一步拿到最新默认链。
      await reloadProxyConfig(true);
      setNotice({kind: "success", message: "密钥已保存到系统凭据库。"});
      return body.credential?.id;
    } catch (error) {
      const message = errorMessage(error, "新增密钥失败");
      setNotice({kind: "error", message});
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function updateCredential(input: {credentialId: string; label?: string; rateMultiplier?: number; agentScope?: string[] | null; secret?: string}): Promise<void> {
    if (!selectedTarget) return;
    setBusy(true);
    try {
      await nonceMutation("/api/development-launch/credentials", "PUT", {targetId: selectedTarget.id, ...input});
      await Promise.all([loadCredentials(selectedTarget.id), reloadProxyConfig(true)]);
      setNotice({kind: "success", message: "密钥名称、适用和价格倍率已更新。"});
    } catch (error) {
      const message = errorMessage(error, "更新密钥失败");
      setNotice({kind: "error", message});
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCredential(credentialId: string): Promise<void> {
    if (!selectedTarget) return;
    if (!await confirmDialog({title: "删除密钥", danger: true, message: "确认从系统凭据库删除这条密钥？\n每个供应商必须至少保留一条密钥。"})) return;
    setBusy(true);
    try {
      await nonceMutation(`/api/development-launch/credentials/${encodeURIComponent(credentialId)}`, "DELETE", {targetId: selectedTarget.id});
      await Promise.all([loadCredentials(selectedTarget.id), reloadProxyConfig(true)]);
      setNotice({kind: "success", message: "密钥已删除；如删除的是默认密钥，服务端已提升剩余密钥。"});
    } catch (error) {
      const message = errorMessage(error, "删除密钥失败");
      setNotice({kind: "error", message});
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function saveConsoleAccount(input: {providerType: SyncProviderType; consoleBaseUrl: string; username: string; password: string; syncIntervalMinutes?: number}): Promise<void> {
    if (!selectedTarget || !selectedTargetPersisted) throw new Error("请先保存供应商，再配置控制台同步");
    // 已有账号的保存属于修改场景：文案用「再次同步」而非「首次同步」。
    const syncLabel = Boolean(syncStatusByTarget[selectedTarget.id]?.account) ? "再次同步" : "首次同步";
    setBusy(true);
    try {
      const body = await nonceMutation("/api/proxy-sync/console-account", "POST", {targetId: selectedTarget.id, ...input});
      await loadSyncStatus(selectedTarget.id);
      // 保存后服务端立即执行同步；失败立刻提醒（保存本身已生效，不回滚）。
      assertImmediateSyncOk(body.sync as SyncOutcomePayload | undefined, syncLabel, "账号信息");
      setNotice({kind: "success", message: `控制台账号已保存，${syncLabel}已完成；计费数据同步不会影响代理可用性。`});
    } catch (error) {
      const message = errorMessage(error, "保存控制台账号失败");
      setNotice({kind: "error", message});
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function runConsoleSync(): Promise<void> {
    if (!selectedTarget) return;
    setBusy(true);
    try {
      const body = await nonceMutation("/api/proxy-sync/run", "POST", {targetId: selectedTarget.id}) as {result?: {rateSyncWarnings?: string[]}};
      await loadSyncStatus(selectedTarget.id);
      await loadSyncOverview(config.targets.map(target => target.id));
      // 倍率未能确认时只做黄标提醒（2026-09-18 用户决策）：系统不再改动任何关联，
      // 密钥/模型/Agent 绑定一律保持不变，因此提示必须明确「什么都没改」。
      const warnings = body.result?.rateSyncWarnings ?? [];
      setNotice({kind: warnings.length > 0 ? "warning" : "success",
        message: warnings.length > 0
          ? `余额同步已完成；${warnings.join("；")}。`
          : "余额和价格倍率同步已完成。"});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "控制台同步失败")});
    } finally {
      setBusy(false);
    }
  }

  async function savePlanSyncConfig(input: {
    providerType: PlanProviderType;
    credentialId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    planMonthlyFee?: number;
    planTier?: string;
    syncIntervalMinutes?: number;
  }): Promise<void> {
    if (!selectedTarget || !selectedTargetPersisted) throw new Error("请先保存供应商，再配置套餐同步");
    // 已有套餐配置的保存属于修改场景：文案用「再次同步」而非「首次同步」。
    const syncLabel = Boolean(syncStatusByTarget[selectedTarget.id]?.plan.config) ? "再次同步" : "首次同步";
    setBusy(true);
    try {
      const body = await nonceMutation("/api/proxy-sync/plan-config", "POST", {
        targetId: selectedTarget.id,
        providerType: input.providerType,
        credentialId: input.credentialId,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        planTier: input.planTier,
        syncIntervalMinutes: input.syncIntervalMinutes,
        expectedRevision: persistedConfigRef.current.revision,
      });
      if (input.planMonthlyFee !== selectedTarget.pricing?.planMonthlyFee) {
        /* 月费币种随手工录入一并落盘（2026-09-28）：显式 settlementCurrency 优先，
           缺失时按预设目录币种补写（无 UI 选择器，币种始终跟随官方预设目录），
           消除「只写数字不写币种」导致派生端误按 CNY 处理美元月费的缺口。 */
        const feeCurrency = selectedTarget.pricing?.settlementCurrency
          ?? derivePresetCurrency(resolveOfficialPresetForTarget(selectedTarget));
        await mutateProxyConfig({
          targetPatch: {
            id: selectedTarget.id,
            target: {
              pricing: {
                ...selectedTarget.pricing,
                planMonthlyFee: input.planMonthlyFee,
                ...(feeCurrency ? {settlementCurrency: feeCurrency} : {}),
              },
            },
          },
        }, {preserveDraft: true});
      }
      await loadSyncStatus(selectedTarget.id);
      // 保存后服务端立即执行首次同步；订阅适配器鉴权失败引导重新登录官方 CLI，
      // 其余鉴权失败提示检查填写的套餐信息（适配器与同步密钥）。
      const subscription = input.providerType === "openai-subscription" || input.providerType === "anthropic-subscription";
      const sync = body.sync as SyncOutcomePayload | undefined;
      if (sync && !sync.ok) {
        const reminder = sync.authRequired
          ? (subscription ? "请在官方 CLI 重新登录后重试。" : "请检查填写的套餐信息是否正确。")
          : "";
        throw new Error(`${syncLabel}失败：${sync.message || "未知错误"}。${reminder}`);
      }
      setNotice({kind: "success", message: `套餐同步配置已保存，${syncLabel}已完成；真实凭据仅保存在系统凭据库。`});
    } catch (error) {
      const message = errorMessage(error, "保存套餐同步失败");
      setNotice({kind: "error", message});
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function runPlanSync(): Promise<void> {
    if (!selectedTarget) return;
    setBusy(true);
    try {
      await nonceMutation("/api/proxy-sync/run", "POST", {targetId: selectedTarget.id, mode: "plan"});
      await loadSyncStatus(selectedTarget.id);
      await loadSyncOverview(config.targets.map(target => target.id));
      setNotice({kind: "success", message: "套餐时间窗用量同步已完成。"});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "套餐同步失败；已保留最近成功用量")});
    } finally {
      setBusy(false);
    }
  }

  async function removeConsoleAccount(): Promise<void> {
    if (!selectedTarget) return;
    if (!await confirmDialog({title: "删除控制台账号", danger: true, message: "确认删除该供应商的控制台账号配置？账号、同步记录与计费快照将一并物理删除。"})) return;
    setBusy(true);
    try {
      await nonceMutation("/api/proxy-sync/console-account", "DELETE", {targetId: selectedTarget.id});
      await loadSyncStatus(selectedTarget.id);
      setNotice({kind: "success", message: "控制台账号配置已删除。"});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "删除控制台账号失败")});
    } finally {
      setBusy(false);
    }
  }

  async function loadCredentials(targetId: string): Promise<CredentialItem[]> {
    if (!targetId || !persistedConfig.targets.some(target => target.id === targetId)) return [];
    const response = await fetch(`/api/development-launch/credentials?targetId=${encodeURIComponent(targetId)}`, {cache: "no-store"});
    if (!response.ok) return [];
    const body = await response.json() as {items?: CredentialItem[]};
    const items = body.items || [];
    setCredentialsByTarget(current => ({...current, [targetId]: items}));
    return items;
  }

  /** 批量加载多供应商凭据（首屏一次请求替代逐目标 N 次）。失败静默：
   *  单目标路径在选中供应商切换时仍会补拉，这里不弹提示不打断主流程。 */
  async function loadCredentialsBatch(targetIds: readonly string[]): Promise<void> {
    const ids = [...new Set(targetIds.filter(Boolean))];
    if (ids.length === 0) return;
    try {
      const response = await fetch(`/api/development-launch/credentials?targets=${encodeURIComponent(ids.join(","))}`, {cache: "no-store"});
      if (!response.ok) return;
      const body = await response.json() as {itemsByTarget?: Record<string, CredentialItem[]>};
      if (!body.itemsByTarget) return;
      setCredentialsByTarget(current => ({...current, ...body.itemsByTarget}));
    } catch {
      // 网络层失败静默：选中目标的重拉链路兜底。
    }
  }

  async function loadSyncStatus(targetId: string): Promise<void> {
    try {
      const response = await fetch(`/api/proxy-sync/status?target=${encodeURIComponent(targetId)}`, {cache: "no-store"});
      if (!response.ok) return;
      const body = await response.json() as ProxySyncStatus;
      setSyncStatusByTarget(current => ({...current, [targetId]: body}));
    } finally {
      // 无论成功失败都标记「已加载」：请求失败时按未配置渲染表单，而不是永久占位。
      setSyncStatusReadyTargets(current => current.has(targetId) ? current : new Set([...current, targetId]));
    }
  }

  /**
   * 侧栏用的一次性概览读取：只发一个请求，服务端对每个目标各读一行有界小表。
   * 失败静默（列表退化为只显示账号类型徽标），绝不清空已有快照。
   */
  async function loadSyncOverview(targetIds: readonly string[]): Promise<void> {
    const ids = [...new Set(targetIds.filter(Boolean))];
    if (ids.length === 0) return;
    try {
      const response = await fetch(
        `/api/proxy-sync/overview?targets=${encodeURIComponent(ids.join(","))}`,
        {cache: "no-store"},
      );
      if (!response.ok) return;
      const body = await response.json() as SyncOverviewPayload;
      setSyncOverviewByTarget(Object.fromEntries(body.targets.map(item => [item.targetId, item])));
    } catch {
      // 概览是增强信息，读取失败不打断供应商管理主流程。
    }
  }

  async function loadPricingCatalog(search = ""): Promise<void> {
    setPricingModelLoading(true);
    try {
      const params = new URLSearchParams({
        view: "catalog",
        limit: String(PRICING_CATALOG_LIMIT),
        offset: "0",
        ...(search.trim() ? {search: search.trim()} : {}),
      });
      const response = await fetch(`/api/model-pricing?${params}`, {cache: "no-store"});
      if (!response.ok) return;
      const page = await response.json() as PricingCatalogPage;
      setPricingModels(page.items);
    } finally {
      setPricingCatalogBootstrapped(true);
      setPricingModelLoading(false);
    }
  }

  /** 全局价格修改：按 vendor + 模型写入价格中心唯一条目（user_override）。
   * 选择「全部」的供应商自身统一到全局新值（清除其单独定价）；
   * 其他供应商选过「仅当前供应商」的单独定价保留（不被全局覆盖）。
   * 保存后刷新价格中心数据。 */
  async function saveGlobalModelPrice(
    runtimeModelId: string,
    vendor: string,
    pricing: ProxyTargetPricingRates,
    priceSchedules?: unknown[],
  ): Promise<void> {
    const response = await fetch("/api/model-pricing", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: {vendor, runtimeModelId, pricing, ...(priceSchedules ? {priceSchedules} : {})}}),
    });
    const body = await response.json() as {ok?: boolean; error?: string; message?: string};
    if (!response.ok || !body.ok) throw new Error(body.message || body.error || "价格中心保存失败");
    await loadPricingCatalog(pricingSearch);
    setNotice({kind: "success", message: `已更新价格中心 ${vendor} + ${runtimeModelId}；已有供应商目标级覆盖保持不变。`});
  }

  async function removeGlobalModelPriceOverride(runtimeModelId: string, vendor: string): Promise<void> {
    try {
      const response = await fetch("/api/model-pricing/restore", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({vendor, runtimeModelId}),
      });
      const body = await response.json() as {
        ok?: boolean;
        error?: string;
        message?: string;
        source?: "official" | "litellm";
        targetOverrides?: Array<{targetId: string; targetName: string}>;
      };
      if (!response.ok || !body.ok) throw new Error(body.message || body.error || "取消全局手工覆盖失败");
      await loadPricingCatalog(pricingSearch);
      const hint = body.targetOverrides?.length
        ? `；目标级覆盖仍保留：${body.targetOverrides.map(item => `${item.targetName}（${item.targetId}）`).join("、")}`
        : "";
      setNotice({kind: "success", message: `已取消全局手工覆盖，恢复${body.source === "official" ? "官方价格" : "LiteLLM 价格"}${hint}`});
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "取消全局手工覆盖失败")});
    }
  }

  async function saveTargetModelPriceOverride(
    targetModelId: string,
    pricing: ProxyTargetPricingRates,
    priceSchedules?: unknown[],
    currency?: "CNY" | "USD",
  ): Promise<void> {
    if (!selectedTarget) throw new Error("TARGET_NOT_FOUND");
    await mutateProxyConfig({
      targetPricingOverride: {
        action: "upsert",
        targetId: selectedTarget.id,
        targetModelId,
        pricing,
        ...(priceSchedules ? {priceSchedules} : {}),
        // 覆盖价币种随条目继承（2026-09-28）：CNY 条目的目标级覆盖不再被回退成 USD。
        ...(currency ? {currency} : {}),
      },
    }, {preserveDraft: true});
    setNotice({kind: "success", message: `已保存 ${targetModelId} 的目标级手工覆盖（仅当前供应商）。`});
  }

  async function removeTargetModelPriceOverride(targetModelId: string): Promise<void> {
    if (!selectedTarget) throw new Error("TARGET_NOT_FOUND");
    await mutateProxyConfig({
      targetPricingOverride: {
        action: "remove",
        targetId: selectedTarget.id,
        targetModelId,
      },
    }, {preserveDraft: true});
    setNotice({kind: "success", message: `已取消当前供应商 ${targetModelId} 的目标级手工覆盖。`});
  }

  /** 选择预设或手工刷新时只加载候选；GET 返回的 nonce 供后续确认单次消费。 */
  async function loadProviderCatalogReview(presetId: string, forceRefresh: boolean): Promise<void> {
    if (!selectedTarget || !presetId) return;
    // 切换预设或刷新失败时不能沿用上一预设的模型 ID；保持 undefined 让服务端按目录首位推荐模型默认。
    if (!selectedTargetPersisted) setPresetSelectedModelIds(undefined);
    setProviderCatalogLoading(true);
    try {
      const params = new URLSearchParams({preset: presetId});
      if (selectedTargetPersisted) params.set("target", selectedTarget.id);
      if (forceRefresh) params.set("refresh", "1");
      const response = await fetch(`/api/provider-catalog?${params}`, {cache: "no-store"});
      const body = await response.json() as ProviderCatalogReviewData & NonceEnvelope;
      if (!response.ok) throw new Error(body.message || body.error || "供应商目录读取失败");
      if (body.nonce) {
        setMutationNonce(body.nonce);
        mutationNonceRef.current = body.nonce;
      }
      // 新建供应商只保存当前草稿选择；点击“新建供应商”时服务端会重新读取目录。
      if (!selectedTargetPersisted) {
        if (!body.models || body.models.length === 0) {
          setNotice({kind: "error", message: "预设目录暂无可自动进入 Agent 可见模型的条目，请稍后刷新或使用模型发现。"});
          return;
        }
        // 默认只勾选目录首位推荐模型（2026-10-07 用户确认，取代默认全选）：
        // 目录首位维护约定 = 官方主推模型；用户可在此加选其余模型。
        setPresetSelectedModelIds(body.models.slice(0, 1).map(model => model.id));
        setProviderCatalogReview(body);
        return;
      }
      if (providerCatalogHasChanges(body.diff)) {
        setProviderCatalogReview(body);
      } else {
        setProviderCatalogReview(undefined);
        setNotice({kind: "success", message: "供应商目录与当前 Agent 可见模型无差异，无需更新。"});
      }
    } catch (error) {
      setNotice({kind: "error", message: errorMessage(error, "供应商目录读取失败")});
    } finally {
      setProviderCatalogLoading(false);
    }
  }

  /** 「仅更新此模型」单模型接入入口已随 2026-10-07 刷新面板「只加不减」表格化改造移除
   * （mode single 服务端能力保留，UI 统一为勾选 + 批量「添加所选模型」）。 */

  async function confirmProviderCatalogReview(
    addedModelIds: string[],
    replacementDefaultModels: Partial<Record<AgentId, string>>,
  ): Promise<void> {
    if (!selectedTarget || !providerCatalogReview) return;
    if (!selectedTargetPersisted) return;
    /* 只加不减语义（2026-10-07 用户确认）：面板只上报「本次勾选新增的模型」，白名单全集
       必须由目标真相源（selectedTarget.supportedModels）拼接——diff 展示有 MAX 截断预算，
       组件侧拼全集一旦截断就会把未展示模型当成「取消勾选」被服务端移除。 */
    const selectedModelIds = [...new Set([...selectedTarget.supportedModels, ...addedModelIds])];
    await applyProviderCatalogSelectionToTarget(
      selectedTarget.id,
      providerCatalogReview.presetId,
      selectedModelIds,
      replacementDefaultModels,
      persistedConfigRef.current.revision,
    );
    setProviderCatalogReview(undefined);
    setNotice({kind: "success", message: addedModelIds.length > 0
      ? `已添加 ${addedModelIds.length} 个模型，Agent 可见模型共 ${selectedModelIds.length} 个。`
      : `供应商目录已确认，Agent 可见模型保持 ${selectedModelIds.length} 个。`});
  }

  function handlePresetSelectionChange(selectedModelIds: string[]): void {
    setPresetSelectedModelIds(current => current && current.length === selectedModelIds.length && current.every((id, index) => id === selectedModelIds[index])
      ? current
      : [...selectedModelIds]);
  }

  async function applyProviderCatalogSelectionToTarget(
    targetId: string,
    presetId: string,
    selectedModelIds: string[],
    replacementDefaultModels: Partial<Record<AgentId, string>>,
    expectedRevision: number,
    preserveDraft = true,
  ): Promise<ProxyTarget> {
    setBusy(true);
    try {
      const body = await nonceMutation("/api/provider-catalog/apply", "POST", {
        targetId,
        presetId,
        selectedModelIds,
        replacementDefaultModels,
        expectedRevision,
      }) as {config?: ProxyConfig; target?: ProxyTarget};
      if (!body.config || !body.target) throw new Error("供应商目录应用响应不完整");
      applyServerConfig(body.config, preserveDraft);
      await loadPricingCatalog(pricingSearch);
      await syncCliConfiguration(false).catch(() => undefined);
      return body.target;
    } finally {
      setBusy(false);
    }
  }

  async function loadCliSyncStatus(targetId?: string): Promise<CliSyncStatus> {
    // targetId 只用于保持页面请求上下文；首屏响应不含正文，供应商贡献由单文件预览接口计算。
    const query = targetId ? `?targetId=${encodeURIComponent(targetId)}` : "";
    const response = await fetch(`/api/config-sync${query}`, {cache: "no-store"});
    const body = await response.json() as CliSyncStatus & NonceEnvelope;
    if (!response.ok) throw new Error(body.message || body.error || "CLI 同步状态读取失败");
    if (body.nonce) {
      setMutationNonce(body.nonce);
      mutationNonceRef.current = body.nonce;
    }
    setCliSyncStatus(body);
    return body;
  }

  async function syncCliConfiguration(showNotice = true): Promise<string> {
    return enqueueMutation(async () => {
      const {response, body} = await nonceRequest("/api/config-sync", "POST", {});
    const typed = body as CliSyncStatus & NonceEnvelope & {ok?: boolean; errors?: string[]};
    if (!response.ok || typed.ok === false) {
      if (!typed.nonce) {
        setMutationNonce("");
        mutationNonceRef.current = "";
      }
      throw new Error(typed.message || typed.error || typed.errors?.join("；") || "CLI 同步失败");
    }
    setCliSyncStatus(current => ({...current, ...typed, lastMessage: "最近一次 CLI 同步成功"}));
    if (showNotice) setNotice({kind: "success", message: "Codex / Claude Code 受管配置已同步。"});
    return "";
    });
  }

  /**
   * 用当前 nonce 发起写请求；命中 LAUNCH_NONCE_INVALID（nonce 过期、服务端重启等）时
   * 自动重新签发并原样重试一次，避免偶发「操作凭证已失效，请重试」打断用户流程。
   */
  async function nonceRequest(path: string, method: "POST" | "PUT" | "DELETE", payload: Record<string, unknown>): Promise<{response: Response; body: Record<string, unknown> & NonceEnvelope}> {
    let response: Response;
    let body: Record<string, unknown> & NonceEnvelope;
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = mutationNonceRef.current || (await loadCliSyncStatus()).nonce;
      response = await fetch(path, {
        method,
        headers: {"content-type": "application/json"},
        body: JSON.stringify({...payload, nonce}),
      });
      // 空响应体防御（2026-10-09 Windows 实测事故）：服务端未捕获错误会返回空 500，
      // 直接 response.json() 只会抛费解的「Unexpected end of JSON input」——
      // 转成带状态码与日志路径的可行动提示。
      const rawBody = await response.text();
      if (!rawBody) {
        throw new Error(`服务端返回空响应（HTTP ${response.status}）。请查看 ~/.deepaa/logs/web.err.log 中的报错详情后重试`);
      }
      try {
        body = JSON.parse(rawBody) as Record<string, unknown> & NonceEnvelope;
      } catch {
        throw new Error(`服务端响应异常（HTTP ${response.status}）：${rawBody.slice(0, 200)}`);
      }
      if (body.nonce) {
        setMutationNonce(body.nonce);
        mutationNonceRef.current = body.nonce;
      }
      if (response.ok || body.error !== "LAUNCH_NONCE_INVALID") return {response, body};
      // nonce 已失效：清空并重新签发，下一次循环原样重试。
      setMutationNonce("");
      mutationNonceRef.current = "";
    }
    return {response: response!, body: body!};
  }

  async function nonceMutation(path: string, method: "POST" | "PUT" | "DELETE", payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return enqueueMutation(async () => {
      const {response, body} = await nonceRequest(path, method, payload);
    if (!response.ok) {
      if (!body.nonce) {
        setMutationNonce("");
        mutationNonceRef.current = "";
      }
      throw new Error(body.message || body.error || `HTTP ${response.status}`);
    }
    return body;
    });
  }

  async function mutateProxyConfig(
    payload: Record<string, unknown>,
    options: {preserveDraft: boolean},
  ): Promise<{config: ProxyConfig; applied?: boolean}> {
    return enqueueMutation(async () => {
      const {response, body: rawBody} = await nonceRequest("/api/proxy-config", "PUT", {
        ...payload,
        expectedRevision: persistedConfigRef.current.revision,
      });
      const body = rawBody as ProxyConfigMutationResponse;
      if (response.status === 409 || body.error === "CONFIG_REVISION_CONFLICT") {
        await reloadProxyConfig(options.preserveDraft);
        throw new Error("配置已被其它页面更新，已刷新到最新版本，请重新确认本次修改。 ");
      }
      if (!response.ok || !body.config) throw new Error(body.message || errorMessageFromCode(body.error) || body.error || `HTTP ${response.status}`);
      applyServerConfig(body.config, options.preserveDraft);
      return {config: body.config, applied: body.applied};
    });
  }

  async function reloadProxyConfig(preserveDraft: boolean): Promise<ProxyConfig> {
    const response = await fetch("/api/proxy-config", {cache: "no-store"});
    if (!response.ok) throw new Error("配置刷新失败");
    const latest = await response.json() as ProxyConfig;
    applyServerConfig(latest, preserveDraft);
    return latest;
  }

  function applyServerConfig(latest: ProxyConfig, preserveDraft: boolean) {
    setPersistedConfig(latest);
    persistedConfigRef.current = latest;
    setConfig(current => {
      if (!preserveDraft || !draftCreatedAt) return latest;
      const draft = current.targets.find(target => target.createdAt === draftCreatedAt);
      return draft ? {...latest, targets: [...latest.targets, draft]} : latest;
    });
  }

  function openConnectDialog(agent?: AgentId, currentTargetId?: string) {
    setConnectDialog({initialAgent: agent, currentTargetId});
    // 有供应商上下文时加载该供应商的密钥；否则加载该 Agent 现有默认供应商的密钥。
    const targetId = currentTargetId || (agent ? config.agentConnections[agent]?.defaultTargetId : undefined);
    if (targetId) void loadCredentials(targetId);
  }

  function openPricingCenter() {
    window.dispatchEvent(new CustomEvent(OPEN_PRICING_SETTINGS_EVENT));
  }

  /** 支持标准左右方向键在页签间循环移动，并同步焦点与选中状态。 */
  /** 把写操作放入串行队列：同一时刻只执行一个 nonce/revision 敏感请求。 */
  function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const queued = mutationQueueRef.current.then(task, task);
    mutationQueueRef.current = queued.catch(() => undefined);
    return queued;
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tabId: TabId) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const currentIndex = TABS.findIndex(tab => tab.id === tabId);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + offset + TABS.length) % TABS.length;
    const nextTab = TABS[nextIndex]!;
    setActiveTab(nextTab.id);
    document.getElementById(`proxy-tab-${nextTab.id}`)?.focus();
  }

  /** 基础配置表单：仅新建草稿使用，在聚焦外壳中直接展示；已保存供应商在「基础信息」页签中展示合并视图。 */
  const basicTabElement = selectedTarget ? (
    <ProxyBasicTab
      key={selectedTarget.createdAt}
      target={selectedTarget}
      localProxyBaseUrl={config.localProxyBaseUrl}
      routeIdLocked={selectedTargetPersisted}
      agentConnections={config.agentConnections}
      busy={busy}
      existingTargets={persistedConfig.targets
        .filter(item => item.createdAt !== selectedTarget.createdAt)}
      onChange={updateSelectedTarget}
      onSave={() => void saveSelectedTarget()}
      onRefreshProviderCatalog={loadProviderCatalogReview}
      presetReview={!selectedTargetPersisted ? providerCatalogReview : undefined}
      presetReviewBusy={busy || providerCatalogLoading}
      onConfirmPresetReview={confirmProviderCatalogReview}
      onCancelPresetReview={() => {
        setProviderCatalogReview(undefined);
        setPresetSelectedModelIds(undefined);
      }}
      onPresetSelectionChange={handlePresetSelectionChange}
    />
  ) : null;

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderTitle}>
          <h1>供应商管理</h1>
          <p>支持各大官方预设供应商及各大三方自定义中转站。</p>
        </div>
        <AgentEntryBadges config={config} onSelect={agent => {
          const options = developmentTargetsForAgent(agent);
          const target = options.find(item => item.id === config.agentConnections[agent]?.defaultTargetId) ?? options[0];
          if (!target) {
            setNotice({kind: "error", message: `${registryAgentLabel(agent)} 尚未配置可用的默认供应商。`});
            return;
          }
          setDevelopmentTarget({target, cli: agent});
          // 预取平台能力：打开默认入口弹窗即触发服务端 capabilities 计算并填热其短缓存，
          // 用户随后点击「在 XX 中开发」时弹窗打开即命中缓存秒渲染；预取失败静默。
          void fetch("/api/development-launch/capabilities", {cache: "no-store"}).catch(() => undefined);
        }} />
        <div className={styles.inlineActions}>
          <button type="button" className={styles.sidebarToggle} onClick={() => setSidebarOpen(true)}><Menu size={16} /> Agent 与供应商</button>
          <button type="button" className={styles.primaryButton} onClick={addTarget}><Plus size={16} /> 新建供应商</button>
        </div>
      </div>

      {notice ? <div className={`${styles.noticeToast} ${notice.kind === "error" ? styles.noticeToastError : styles.noticeToastSuccess}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "warning" ? `⚠️ ${notice.message}` : notice.message}</div> : null}

      <div className={styles.layout}>
        {sidebarOpen ? <button type="button" className={styles.mobileBackdrop} aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /> : null}
        <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`}>
          <ProxyTargetSidebar
            targets={config.targets}
            credentials={allCredentials}
            selectedTargetId={selectedTargetId}
            draftCreatedAt={draftCreatedAt}
            search={search}
            overviewByTarget={syncOverviewByTarget}
            onSearchChange={setSearch}
            onSelect={selectTarget}
            onAdd={addTarget}
          />
        </aside>

        <section className={styles.content}>
          {!selectedTarget ? (
            <div className={styles.emptyWorkspace}>
              <Bot size={34} aria-hidden="true" />
              <strong>还没有任何供应商</strong>
              <button type="button" className={styles.primaryButton} onClick={addTarget}><Plus size={16} /> 新建供应商</button>
            </div>
          ) : !selectedTargetPersisted ? (
            <section className={styles.newTargetShell} aria-label="新建供应商">
              <header className={styles.newTargetShellHeader}>
                <div>
                  <h2>新建供应商</h2>
                  <p>选择官方预设自动填充接入地址，或录入非官方上游；保存后进入密钥与模型引导。</p>
                </div>
                <button type="button" className={styles.secondaryButton} onClick={() => void deleteSelectedTarget()}>取消</button>
              </header>
              {basicTabElement}
            </section>
          ) : (
            <>
              <header className={styles.targetHeader}>
                <div>
                  <h2>{selectedTarget.name || "未命名供应商"}{selectedChannelBadge ? <span className={styles.channelBadge}>{selectedChannelBadge}</span> : null}</h2>
                  <p>路由 ID：<code>{selectedTarget.id || "（输入上游 URL 后自动生成）"}</code>{selectedTargetPersisted ? null : <em className={styles.draftTag}>未保存</em>}</p>
                </div>
                <div className={styles.enableControl} title={selectedTarget.enabled ? "点击停用" : !targetCanEnable ? `启用前需补齐：${enableBlockers.join("；")}` : "点击启用"}>
                  <button type="button" className={`${styles.enableSwitch} ${selectedTarget.enabled ? styles.enableSwitchOn : ""}`} disabled={!selectedTargetPersisted || busy} onClick={() => void toggleTargetEnabled()} aria-pressed={selectedTarget.enabled} aria-label={selectedTarget.enabled ? "停用供应商" : "启用供应商"}>
                    <span className={styles.enableKnob} />
                  </button>
                  <span className={selectedTarget.enabled ? styles.enableLabelOn : styles.enableLabelOff}>{selectedTarget.enabled ? "已启用" : "未启用"}</span>
                </div>
              </header>
              <nav className={styles.tabs} aria-label="供应商详情" role="tablist">
                {TABS.map(tab => <button key={tab.id} id={`proxy-tab-${tab.id}`} type="button" role="tab" className={`${styles.tabButton} ${activeTab === tab.id ? styles.tabButtonActive : ""}`} aria-selected={activeTab === tab.id} aria-controls="proxy-tab-panel" tabIndex={activeTab === tab.id ? 0 : -1} onKeyDown={event => handleTabKeyDown(event, tab.id)} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
              </nav>
              <div id="proxy-tab-panel" className={styles.tabPanel} role="tabpanel" aria-labelledby={`proxy-tab-${activeTab}`}>
                {activeTab === "info" ? (selectedTargetPersisted
                  ? <ProxyOverviewTab key={selectedTarget.createdAt} config={config} target={selectedTarget} credentials={allCredentials} syncStatus={syncStatusByTarget[selectedTarget.id]} syncStatusReady={syncStatusReadyTargets.has(selectedTarget.id)} busy={busy} highlight={overviewHighlight} onStartOnboarding={() => {const first = firstMissingOnboardingStep(selectedTarget); if (first) setOnboardingStep({step: first});}} onRunSync={runConsoleSync} onSaveAccount={saveConsoleAccount} onSavePlanConfig={savePlanSyncConfig} onRunPlanSync={runPlanSync} onDeleteTarget={() => void deleteSelectedTarget()} onChangeSelectedTarget={updateSelectedTarget} onSaveTargetPatch={patchSelectedTarget} />
                  : basicTabElement) : null}
                {activeTab === "resources" ? <ProxyResourcesTab key={selectedTarget.createdAt} target={selectedTarget} config={config} credentials={allCredentials} onDiscoverModels={discoverTargetModels} onConfirmDiscoveredModels={confirmTargetModels} onRefreshProviderCatalog={loadProviderCatalogReview} providerCatalogLoading={providerCatalogLoading} providerCatalogReview={selectedTargetPersisted ? providerCatalogReview : undefined} onConfirmProviderCatalogReview={confirmProviderCatalogReview} onCancelProviderCatalogReview={() => setProviderCatalogReview(undefined)} pricingModels={pricingModels} connectedAgents={connectedAgentsList} busy={busy} onSaveTargetPatch={patchSelectedTarget} onOpenPricingCenter={openPricingCenter} onCreateCredential={createCredential} onUpdateCredential={updateCredential} onDeleteCredential={deleteCredential} onUpdateCredentialScope={async (credentialId, agents) => { await updateCredential({credentialId, agentScope: agents}); }} onUnbindAgents={agents => unbindDroppedAgents(agents)} onSaveGlobalPrice={saveGlobalModelPrice} onRemoveGlobalPrice={removeGlobalModelPriceOverride} onSaveTargetPrice={saveTargetModelPriceOverride} onRemoveTargetPrice={removeTargetModelPriceOverride} /> : null}
                {activeTab === "agent" ? <ProxyAgentTab key={selectedTarget.createdAt} config={config} target={selectedTarget} credentials={allCredentials} targetPersisted={selectedTargetPersisted} cliStatus={cliSyncStatus} onConnectAgent={agent => openOnboardingWizard(agent)} onUnbindAgent={agent => void unbindAgentTarget(agent, selectedTarget.id)} onSetDefault={setAgentDefaultTarget} onSetModel={setTargetDefaultModel} onSetCredential={setTargetDefaultCredential} onLaunch={agent => setDevelopmentTarget({target: selectedTarget, cli: agent})} onUpdateAliases={(_agent, aliases) => updateClaudeAliases("claude", aliases)} onSetCliForm={setAgentCliForm} /> : null}
              </div>
            </>
          )}
        </section>
      </div>

      {connectDialog ? <ConnectAgentDialog config={config} credentials={allCredentials} initialAgent={connectDialog.initialAgent} currentTargetId={connectDialog.currentTargetId} onTargetChange={targetId => void loadCredentials(targetId)} onClose={() => setConnectDialog(null)} onSave={saveAgentConnection} /> : null}
      {developmentTarget ? <DevelopmentLaunchDialog target={developmentTarget.target} cli={developmentTarget.cli} targetOptions={developmentTargetsForAgent(developmentTarget.cli)} localProxyBaseUrl={resolveGatewayBaseUrl(config.localProxyBaseUrl)} onClose={() => {setDevelopmentTarget(null); void reloadProxyConfig(true);}} onOpenPricingCenter={openPricingCenter} cliSyncEnabled={config.agentConnections[developmentTarget.cli]?.cliSyncEnabled !== false} onSetCliForm={performCliFormSwitch} /> : null}
      {onboardingStep && selectedTarget ? <ProxyOnboardingWizard
        target={selectedTarget}
        config={config}
        credentials={allCredentials}
        pricingModels={pricingModels}

        busy={busy}
        initialStep={onboardingStep.step}
        initialAgents={onboardingStep.agent ? [onboardingStep.agent] : undefined}
        requireCredentialEntry={onboardingStep.requireCredentialEntry === true}

        onDiscoverModels={discoverTargetModels}
        onConfirmDiscoveredModels={confirmTargetModels}
        onSaveTargetPatch={patchSelectedTarget}
        onCreateCredential={createCredential}
        // 向导只提交接入绑定；首次默认供应商由服务端统一补齐，已有默认供应商保持不变。
        onConnectAgent={agent => saveAgentConnection({
          agent,
          boundTargetIds: [selectedTarget.id],
          cliSyncEnabled: true,
        }, {silent: true})}
        onSyncCli={() => syncCliConfiguration(false).then(() => undefined)}
        onUpdateCredentialScope={async (credentialId, agents) => {
          await updateCredential({credentialId, agentScope: agents});
        }}
        onClose={() => setOnboardingStep(null)}
        onDone={message => {
          setOnboardingStep(null);
          setNotice({kind: "success", message});
          void reloadProxyConfig(true);
          if (selectedTarget) setOverviewHighlight(buildOverviewHighlight(selectedTarget));
        }}
      /> : null}
    </div>
  );
}

function normalizeTargetDraft(target: ProxyTarget, otherTargets: readonly ProxyTarget[] = []): ProxyTarget {
  const name = target.name.trim();
  if (!name) throw new Error("供应商名称必填");
  const openaiUrl = normalizeOptionalUrl(target.openaiUrl, "OpenAI 上游 URL");
  const anthropicUrl = normalizeOptionalUrl(target.anthropicUrl, "Anthropic 上游 URL");
  if (!openaiUrl && !anthropicUrl) throw new Error("OpenAI 或 Anthropic 协议上游 URL 至少填写一个");
  // 路由 ID 新建时为空：按统一候选链（主域优先五层链）自动派生全局唯一候选；
  // 同 URL 对与候选用尽分别抛不同错误码，引导手动填写区分词或修改路由 ID。
  let id = target.id.trim();
  if (!id) {
    const resolution = resolveDerivedRouteId(openaiUrl, anthropicUrl || undefined, otherTargets);
    if (resolution.status === "resolved") id = resolution.id!;
    else if (resolution.status === "conflict") {
      throw new Error(resolution.reason === "identical_upstream_urls"
        ? "ROUTE_ID_IDENTICAL_UPSTREAM_CONFLICT"
        : "ROUTE_ID_DERIVATION_CONFLICT");
    }
    else id = routeIdFromUpstreamUrl(openaiUrl || anthropicUrl!);
  }
  if (!/^[a-z0-9.-]+$/.test(id) || id.includes("_")) throw new Error("路由 ID 只能包含小写字母、数字、点和连字符，不能含下划线");
  return {
    ...target,
    id,
    name,
    ...(openaiUrl ? {openaiUrl} : {openaiUrl: undefined}),
    ...(anthropicUrl ? {anthropicUrl} : {anthropicUrl: undefined}),
  };
}

function normalizeOptionalUrl(value: string | undefined, label: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.toString().replace(/\/+$/u, "");
  } catch {
    throw new Error(`${label} 必须是有效的 http/https 地址`);
  }
}

/** 官方模式确认文案声明表（扩展面守卫：禁止 agent 名条件分派；与 agent-catalog 的 CLI_FORM_COPY 同语义）。 */
const OFFICIAL_MODE_HINTS: Partial<Record<AgentId, string>> = {
  codex: "桌面 App 同样可用，用量经本机数据直连导入自动捕获",
  claude: "使用官方登录与官方端点",
};

function agentLabel(agent: AgentId): string {
  return registryAgentLabel(agent);
}

/**
 * 保存后立即同步失败时抛错提醒：鉴权类失败（密钥/账号不对）附加
 * 「请检查填写的信息」提示；通用失败只透出原始错误。
 */
function assertImmediateSyncOk(sync: SyncOutcomePayload | undefined, syncLabel: string, subject: "账号信息"): void {
  if (!sync || sync.ok) return;
  const reminder = sync.authRequired ? `请检查填写的${subject}是否正确。` : "";
  throw new Error(`${syncLabel}失败：${sync.message || "未知错误"}。${reminder}`);
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  const messages: Record<string, string> = {
    CREDENTIAL_LAST_REQUIRED: "每个供应商至少需要保留一个系统密钥，不能删除最后一条。",
    CONFIG_REVISION_CONFLICT: "配置已被其它页面更新，请刷新后重试。",
    DEFAULT_TARGET_NOT_FOUND: "默认供应商不存在，请刷新页面后重新选择。",
    TARGET_DISABLED: "默认供应商尚未启用。",
    PROTOCOL_URL_REQUIRED: "默认供应商缺少该 Agent 所需的上游 URL。",
    DEFAULT_MODEL_NOT_SUPPORTED: "默认模型不在当前供应商的支持列表中。",
    DEFAULT_CREDENTIAL_NOT_FOUND: "默认密钥不存在或不属于当前供应商。",
    DUPLICATE_TARGET_ID: "路由 ID 已被其它供应商使用，请在基础信息的自定义设置中查看路由 ID。",
    DUPLICATE_TARGET_URL: "该上游 URL 已由其它供应商接管，请使用已有供应商或修改 URL。",
    ROUTE_ID_DERIVATION_CONFLICT: "自动生成的路由 ID 已被其它供应商占用，请在基础信息的自定义设置中手动修改路由 ID。",
    ROUTE_ID_IDENTICAL_UPSTREAM_CONFLICT: "与已有供应商的上游 URL 完全相同，无法自动生成可区分的路由 ID，请在基础信息的自定义设置中手动填写（例如追加 -plan 等区分词）。",
    INVALID_TARGET_ID: "路由 ID 只能包含小写字母、数字、点和连字符，不能含下划线。",
    PRESET_WIRE_API_UNSUPPORTED: "当前官方预设的 OpenAI 接口不支持 Codex Responses，请改用 Claude Code；供应商开放 Responses 后只需更新预设能力即可放开。",
    MODEL_SELECTION_REQUIRED: "请至少保留一个可计价模型。",
    MODEL_PRICE_MAPPING_REQUIRED: "所选模型缺少价格中心映射，不能加入 Agent 可见模型。",
    MODEL_PRICE_ENTRY_NOT_FOUND: "所选模型引用的价格中心条目已不存在，请重新选择价格映射。",
    MODEL_PRICE_VENDOR_MISMATCH: "所选模型的价格中心供应商与供应商映射不一致，请重新选择。",
    MODEL_PRICE_RUNTIME_MISMATCH: "所选价格中心条目的模型 ID 与 Agent 可见模型不一致，请重新选择。",
    MODEL_PRICE_MISSING: "所选价格中心条目缺少有效输入或输出价格，请先补齐价格。",
    PRICING_ENTRY_ID_CONFLICT: "价格中心存在重复条目 ID，请先修复价格中心后再继续。",
    PRICING_VENDOR_MODEL_CONFLICT: "价格中心存在同一供应商与模型的冲突价格，请先修复价格中心后再继续。",
    PRICE_CENTER_INVALID: "价格中心数据无效，请先修复价格中心后再继续。",
    PRICE_CENTER_ENTRY_CONFLICT: "价格中心条目存在冲突，请先修复价格中心后再继续。",
  };
  const code = error.message.split(":", 1)[0];
  return messages[code] || error.message || fallback;
}

function errorMessageFromCode(code: string | undefined): string | undefined {
  return code ? errorMessage(new Error(code), "") : undefined;
}

function runtimeModelIdOf(entry: {runtimeModelId?: string; match?: string; patterns: string[]; id: string}): string {
  return entry.runtimeModelId || entry.match || entry.patterns[0] || entry.id;
}
