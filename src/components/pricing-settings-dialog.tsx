"use client";

import { DatabaseZap, Plus, RefreshCcw, Save, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {ModelPriceEntry, PaygPromotion, PricingCatalogPage, PricingEntrySourceCategory, ServiceTierPricing} from "@/lib/pricing";
import { formatVersionDateTime } from "@/lib/format-datetime";
import {peakWindowText, scheduleHolidayText, schedulePricingText} from "@/lib/token-pricing-display";
import {RateTimelineList} from "@/components/rate-timeline-list";
import {CollapsibleSection} from "@/components/collapsible-section";
import {confirmDialog} from "@/components/confirm-dialog";
// 复合键纯函数在无 Node 依赖的模块里：客户端组件运行时导入不能经由 @/lib/pricing（含 fs 等 Node 内建）。
import {pricingModelEntryKey} from "@/lib/pricing-model-entry";
import {useGlobalTimeZone} from "@/lib/timezone-preference";
import {MultiSelectFilter, type MultiSelectFilterOption} from "@/components/multi-select-filter";
import {
  emptyPriceDrafts,
  isDecimalDraft,
  priceDraftsFromModel,
  priceDraftsToPricing,
  type PriceDrafts,
  type PriceField,
} from "@/lib/pricing-drafts";

const CATALOG_LIMIT = 50;
const OPEN_PRICING_SETTINGS_EVENT = "deepaa:open-pricing-settings";

/** 来源类别筛选候选项（固定顺序）；「待确认」仅在内置占位条目存在时由渲染层追加。 */
const SOURCE_CATEGORY_OPTIONS: Array<{value: PricingEntrySourceCategory; label: string}> = [
  {value: "litellm", label: "LiteLLM"},
  {value: "catalog", label: "DeepAA官方预设"},
  {value: "manual", label: "人工维护"},
  {value: "pending", label: "待确认（内置）"},
];

export function PricingSettingsDialog({hideTrigger = false}: {hideTrigger?: boolean}) {
  // 时段窗口按全站查看者时区展示（2026-09-30；缺省东八区）。
  const viewerTimeZone = useGlobalTimeZone();
  const [open, setOpen] = useState(false);
  // 「模型」筛选为条目级（供应商 + 模型成对）复合键；同名模型跨供应商各自成项、互不排重。
  const [filterModelKeys, setFilterModelKeys] = useState<string[]>([]);
  const [filterVendors, setFilterVendors] = useState<string[]>([]);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [catalog, setCatalog] = useState<PricingCatalogPage | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelPriceEntry | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<PriceDrafts>(() => emptyPriceDrafts());
  const [isCreatingModel, setIsCreatingModel] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** 左侧「模型价格目录」收起为窄栏（仅模型 + 供应商两列），右侧编辑器同步加宽。 */
  const [listCollapsed, setListCollapsed] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadCatalog({offset: 0});
  }, [open]);

  useEffect(() => {
    function handleOpenPricingSettings() {
      setOpen(true);
    }
    window.addEventListener(OPEN_PRICING_SETTINGS_EVENT, handleOpenPricingSettings);
    return () => window.removeEventListener(OPEN_PRICING_SETTINGS_EVENT, handleOpenPricingSettings);
  }, []);

  async function loadCatalog(options: {
    offset?: number;
    /** 保存后定位用的临时过滤词；筛选统一走 modelEntries/vendors/categories。 */
    search?: string;
    modelEntries?: string[];
    vendors?: string[];
    categories?: string[];
  } = {}) {
    const modelKeys = options.modelEntries ?? filterModelKeys;
    const vendors = options.vendors ?? filterVendors;
    const categories = options.categories ?? filterCategories;
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams();
      params.set("view", "catalog");
      params.set("limit", String(CATALOG_LIMIT));
      params.set("offset", String(options.offset ?? 0));
      if (options.search?.trim()) params.set("search", options.search.trim());
      for (const key of modelKeys) params.append("modelEntry", key);
      for (const vendor of vendors) params.append("vendor", vendor);
      for (const category of categories) params.append("category", category);
      const response = await fetch(`/api/model-pricing?${params.toString()}`, { cache: "no-store" });
      const data = await response.json() as PricingCatalogPage | { error?: string };
      if (!response.ok) throw new Error("error" in data && data.error ? data.error : `HTTP ${response.status}`);
      const page = data as PricingCatalogPage;
      setCatalog(page);
      setOffset(options.offset ?? 0);
      if (!isCreatingModel && selectedModel) {
        const next = page.items.find(item => item.id === selectedModel.id) || selectedModel;
        setSelectedModel(next);
        setPriceDrafts(priceDraftsFromModel(next));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "模型价格目录加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function importLiteLLM() {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/model-pricing/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json() as {
        ok?: boolean;
        modelCount?: number;
        source?: "remote" | "local" | "snapshot";
        remoteUpdated?: boolean;
        warning?: string;
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      // 提示必须在目录重载之后设置：loadCatalog 会清空 message（避免批次内被覆盖为空）。
      const text = body.source === "remote"
        ? (body.remoteUpdated
          ? `LiteLLM 导入完成：${body.modelCount || 0} 个可计价模型，已更新本地目录。`
          : `LiteLLM 暂无模型数据更新：本地价格目录已与上游最新版保持同步（${body.modelCount || 0} 个可计价模型）。`)
        : `${body.source === "snapshot" ? "网络暂不可用，已使用随版本快照" : "网络暂不可用，继续使用本地价格目录"}：${body.warning || ""}`;
      await loadCatalog({offset: 0});
      setMessage(text);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入 LiteLLM 失败");
    } finally {
      setLoading(false);
    }
  }

  async function importOfficialCatalog() {
    setLoading(true);
    setMessage("");
    try {
      // 与「官方价格目录更新」确认流同一套本地变更安全机制：先取一次性 nonce 再触发同步。
      const nonceResponse = await fetch("/api/provider-catalog/pricing-updates", { cache: "no-store" });
      const nonceBody = await nonceResponse.json() as { nonce?: string };
      const response = await fetch("/api/provider-catalog/catalog-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: nonceBody.nonce }),
      });
      const body = await response.json() as {
        ok?: boolean;
        skippedByVersion?: boolean;
        insertedCount?: number;
        silentUpdatedCount?: number;
        confirmCount?: number;
        publishedAt?: string;
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const version = body.publishedAt ? `（目录版本 ${formatVersionDateTime(body.publishedAt)}）` : "";
      const confirmHint = body.confirmCount && body.confirmCount > 0
        ? `另有 ${body.confirmCount} 条使用中模型的官方预设调整待确认（右上角【官方价格目录更新】）。`
        : "";
      const text = body.skippedByVersion
        ? `DeepAA 官方预设暂无模型数据更新：本地已是最新目录版本${version}。${confirmHint}`
        : (body.insertedCount || body.silentUpdatedCount
          ? `DeepAA 官方预设导入完成：新增 ${body.insertedCount || 0} 条，静默更新 ${body.silentUpdatedCount || 0} 条${version}。${confirmHint}`
          : `DeepAA 官方预设暂无模型数据更新${version}。${confirmHint}`);
      await loadCatalog({offset: 0});
      setMessage(text);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入 DeepAA 官方预设失败");
    } finally {
      setLoading(false);
    }
  }

  function updateSelectedModel(patch: Partial<ModelPriceEntry>) {
    if (!selectedModel) return;
    const next = { ...selectedModel, ...patch };
    setSelectedModel(next);
    setCatalog(current => current
      ? { ...current, items: current.items.map(model => model.id === next.id ? next : model) }
      : current);
  }

  function startCreateModel() {
    const now = new Date().toISOString();
    const model: ModelPriceEntry = {
      id: "",
      vendor: "",
      runtimeModelId: "",
      match: "",
      patterns: [],
      mode: "",
      pricing: { input: 0, output: 0 },
      currency: "USD",
      confidence: "user_override",
      sourceCheckedAt: now,
    };
    setIsCreatingModel(true);
    setMessage("");
    setSelectedModel(model);
    setPriceDrafts(priceDraftsFromModel(model));
  }

  function updateSelectedPricing(field: PriceField | "longContextThreshold" | "longContextInput" | "longContextOutput" | "fastMultiplier", value: string) {
    if (!selectedModel) return;
    if (!isDecimalDraft(value)) return;
    setPriceDrafts(current => ({ ...current, [field]: value }));
  }

  /** 促销时间窗/名称/Agent 限定为文本草稿（非数字），单独更新。 */
  function updatePromotionDraft(field: "promoFrom" | "promoTo" | "promoLabel" | "promoAgents", value: string) {
    setPriceDrafts(current => ({ ...current, [field]: value }));
  }

  function commitPriceDrafts(model: ModelPriceEntry): ModelPriceEntry | undefined {
    const result = priceDraftsToPricing(priceDrafts, model.priceSchedules);
    if (!result) return undefined;
    return {
      ...model,
      pricing: result.pricing,
      ...(result.priceSchedules ? {priceSchedules: result.priceSchedules} : {}),
      // fast 档与促销草稿全清 = 移除配置（显式 undefined 覆盖旧值）。
      serviceTierPricing: result.serviceTierPricing,
      promotions: result.promotions,
      confidence: "user_override",
      sourceCheckedAt: new Date().toISOString(),
    };
  }

  /**
   * 是否有未保存修改（2026-09-10 用户确认）：草稿与「当前模型重建的草稿」逐字段比较，
   * 无差异时「保存模型价格」置灰；新建模型恒可保存。
   */
  const priceDraftsDirty = (() => {
    if (isCreatingModel) return true;
    if (!selectedModel) return false;
    const baseline = priceDraftsFromModel(selectedModel);
    return (Object.keys(baseline) as Array<keyof typeof baseline>)
      .some(key => baseline[key] !== priceDrafts[key]);
  })();

  async function saveModelPricing() {
    if (!selectedModel) return;
    const modelId = runtimeModelIdOf(selectedModel).trim();
    const vendor = selectedModel.vendor.trim();
    if (!modelId || !vendor) {
      setMessage("模型 ID 和供应商不能为空。");
      return;
    }
    const modelWithPricing = commitPriceDrafts(selectedModel);
    if (!modelWithPricing) {
      setMessage("价格字段请输入有效数字。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const modelToSave: ModelPriceEntry = {
        ...modelWithPricing,
        id: isCreatingModel ? "" : modelWithPricing.id,
        vendor,
        runtimeModelId: modelId,
        match: modelId,
        patterns: [modelId, ...(modelWithPricing.patterns || []).filter(item => item !== modelId)],
        mode: modelWithPricing.mode?.trim() || undefined,
        currency: modelWithPricing.currency || "USD",
        confidence: "user_override",
        sourceCheckedAt: new Date().toISOString(),
      };
      const response = await fetch("/api/model-pricing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelToSave }),
      });
      const body = await response.json() as { ok?: boolean; model?: ModelPriceEntry; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (body.model) {
        setSelectedModel(body.model);
        setPriceDrafts(priceDraftsFromModel(body.model));
      }
      setIsCreatingModel(false);
      // 提示在目录重载之后设置：loadCatalog 会清空 message。
      const savedKey = pricingModelEntryKey(body.model?.vendor || selectedModel.vendor, modelId);
      setFilterModelKeys([savedKey]);
      await loadCatalog({offset: 0, modelEntries: [savedKey]});
      setMessage("保存模型价格完成，后续新请求会使用新价格快照。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存模型价格失败");
    } finally {
      setSaving(false);
    }
  }

  async function restoreSelectedModel() {
    if (!selectedModel || isCreatingModel) return;
    const restoreInfo = catalog?.restoreAvailability?.[selectedModel.id];
    const targetWarning = restoreInfo?.targetOverrides?.length ? (
      <div className="pricing-restore-confirm-warning">
        <strong>存在供应商目标级手工覆盖</strong>
        <span>
          {restoreInfo.targetOverrides.map((item, index) => (
            <span key={`${item.targetId}:${item.targetModelId}`}>
              {index > 0 ? "、" : ""}
              <a href={`/proxy-management?target=${encodeURIComponent(item.targetId)}`}>{item.targetName || item.targetId}</a>
              （{item.targetId}）
            </span>
          ))}
          。本次全局恢复不会清除这些目标的覆盖；如需同步恢复，请先到对应供应商单独取消。
        </span>
      </div>
    ) : null;
    const restoreMessage = restoreInfo?.source === "official"
      ? "将恢复到官方预设值域状态。"
      : "将恢复到当前条目默认的 LiteLLM 值域状态。";
    const targetHint = restoreInfo?.targetOverrides?.length
      ? `存在供应商目标级手工覆盖：${restoreInfo.targetOverrides.map(item => `${item.targetName || item.targetId}（${item.targetId}）`).join("、")}。本次操作不会同步取消这些目标的覆盖；如需同步恢复，请先到对应供应商单独取消。`
      : "";
    const confirmed = await confirmDialog({
      title: "取消手工覆盖",
      message: (
        <div>
          <div>{restoreMessage}</div>
          {targetWarning}
        </div>
      ),
      fallbackMessage: `${restoreMessage}${targetHint}`,
    });
    if (!confirmed) return;
    setRestoring(true);
    setMessage("");
    try {
      const response = await fetch("/api/model-pricing/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vendor: selectedModel.vendor, runtimeModelId: runtimeModelIdOf(selectedModel) }),
      });
      const body = await response.json() as {
        ok?: boolean;
        model?: ModelPriceEntry;
        error?: string;
        message?: string;
        source?: "official" | "litellm";
        sourceState?: "current_official" | "historical_official" | "litellm_baseline" | "litellm_snapshot";
        sourceRevision?: string;
        sourceHash?: string;
        sourceCapturedAt?: string;
        targetOverrides?: Array<{targetId: string; targetName: string; targetModelId: string}>;
      };
      if (!response.ok || !body.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
      if (body.model) {
        setSelectedModel(body.model);
        setPriceDrafts(priceDraftsFromModel(body.model));
      }
      await loadCatalog({offset: 0});
      const overrideHint = body.targetOverrides?.length
        ? `；以下目标仍保留目标级覆盖：${body.targetOverrides.map(item => `${item.targetName}（${item.targetId}）`).join("、")}。如需同步恢复，请先到供应商管理的密钥与模型中取消对应目标级覆盖`
        : "";
      setMessage(`已取消手工覆盖，恢复${body.source === "official" ? "官方价格" : "LiteLLM 价格"}，目标映射保持不变${overrideHint}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复官方默认失败");
    } finally {
      setRestoring(false);
    }
  }

  const vendorOptions: MultiSelectFilterOption[] = (catalog?.facets.vendors || [])
    .map(vendor => ({value: vendor, label: vendor}));
  // 「模型 - 供应商」条目候选：同名模型跨供应商不排重，标签整体唯一，筛选按条目精确命中。
  const modelOptions: MultiSelectFilterOption[] = (catalog?.facets.modelEntries || [])
    .map(entry => ({
      value: pricingModelEntryKey(entry.vendor, entry.model),
      label: `${entry.model} - ${entry.vendor}`,
    }));
  const categoryCounts = catalog?.facets.categoryCounts;
  const categoryOptions: MultiSelectFilterOption[] = SOURCE_CATEGORY_OPTIONS
    .filter(option => option.value !== "pending" || (categoryCounts?.pending || 0) > 0)
    .map(option => ({
      value: option.value,
      label: categoryCounts ? `${option.label}（${categoryCounts[option.value] || 0}）` : option.label,
    }));
  const hasFilters = filterModelKeys.length > 0 || filterVendors.length > 0 || filterCategories.length > 0;
  const litellmSyncedAt = catalog?.litellmSync?.syncedAt
    || (catalog?.catalogSource?.type === "litellm" ? catalog?.catalogSource?.fetchedAt : undefined);
  // 版本条语义（2026-09-07 用户确认）：强调「已与上游最新版保持同步」，避免被误读为上次请求时间。
  // DeepAA 官方预设：本地目录缓存触达过上游（remote/file-cache）且其版本不比本地已同步版本新
  // → 已同步上游最新版；无法触达上游（bundled/无缓存）→ 维持目录版本展示。
  const upstream = catalog?.upstreamCatalog;
  const lastSyncedVersion = catalog?.catalogSync?.lastSyncedPublishedAt;
  const officialSyncedWithUpstream = Boolean(
    upstream?.seenUpstream && upstream.publishedAt && lastSyncedVersion
      && upstream.publishedAt <= lastSyncedVersion);
  const officialLabel = officialSyncedWithUpstream ? "DeepAA 官方预设已同步上游最新版" : "DeepAA 官方预设目录版本";
  const officialVersionText = formatVersionDateTime(
    officialSyncedWithUpstream ? upstream?.publishedAt : lastSyncedVersion) || "未同步";
  const officialSyncedAtText = catalog?.catalogSync?.syncedAt
    ? formatVersionDateTime(catalog.catalogSync.syncedAt) : undefined;
  const officialTip = officialSyncedWithUpstream
    ? `已与 DeepAA 官方上游最新目录保持同步（该版本发布于 ${formatVersionDateTime(upstream?.publishedAt)}）${officialSyncedAtText ? `，本地同步完成于 ${officialSyncedAtText}` : ""}；人工修改与 LiteLLM 兜底价不受影响`
    : `已同步的 DeepAA 官方预设目录版本发布时间${officialSyncedAtText ? `；本地最近一次同步完成于 ${officialSyncedAtText}` : ""}${upstream && !upstream.seenUpstream ? "；当前从未成功访问上游目录，暂无法确认是否为最新版" : ""}`;
  const litellmSyncTip = "最近一次成功导入 LiteLLM 官方价格表的时间；本地已与该时点的上游最新版保持同步，人工修改与官方预设价不受影响";
  const selectedRestoreInfo = selectedModel
    ? catalog?.restoreAvailability?.[selectedModel.id]
    : undefined;
  const selectedTargetOverrideHint = selectedRestoreInfo?.targetOverrides?.length
    ? `存在供应商目标级手工覆盖：${selectedRestoreInfo.targetOverrides.map(item => `${item.targetName}（${item.targetId}）`).join("、")}；本次全局恢复不会清除这些目标的覆盖。如需同步恢复，请先到供应商管理的密钥与模型中取消对应目标级覆盖。`
    : undefined;

  return (
    <>
      {/* 2026-09-16 用户确认：价格中心入口收敛到「管理」下拉；hideTrigger 时不渲染按钮。
          此前用 hidden 属性隐藏，但 .settings-button 的 display:grid 会覆盖 [hidden]，导致按钮仍然可见。 */}
      {hideTrigger ? null : (
        <button
          type="button"
          className="settings-button pricing-settings-button"
          onClick={() => setOpen(true)}
          aria-label="价格中心"
          title="价格中心"
        >
          <Settings size={16} />
        </button>
      )}
      {open ? (
        // Portal 到 body：脱离顶栏（.topbar）的白色文字继承，浅色模式下文字保持可见。
        createPortal(
        <div className="settings-modal-backdrop pricing-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section
            className="settings-dialog pricing-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pricing-settings-title"
            onClick={event => event.stopPropagation()}
          >
            <header className="settings-header">
              <div>
                <h2 id="pricing-settings-title">模型价格中心</h2>
                <p>
                  模型价格按四级优先级解析（低 → 高）：LiteLLM 兜底价 → DeepAA 官方预设价 → 全局人工维护价 →
                  供应商目标计费覆盖。应用启动后自动同步 LiteLLM 与 DeepAA 官方预设：官方目录新增模型自动并入，
                  使用中模型的官方预设调整在右上角【官方价格目录更新】经人工确认后才会并入；
                  任何人工维护过的价格（含基于官方或 LiteLLM 价格修改的）都不会被自动导入覆盖，已入账历史费用永不重算。
                </p>
              </div>
              {/* 操作结果提示（2026-09-10 用户确认）：移至弹窗右上角、与标题同一水平线，
                  金黄色醒目显示；保存 / 导入 DeepAA 官方预设 / 导入 LiteLLM 共用。 */}
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="关闭价格中心">
                <X size={16} />
              </button>
            </header>

            <div className="pricing-toolbar">
              <button type="button" className="secondary-button" onClick={importOfficialCatalog} disabled={loading}
                title="拉取最新 DeepAA 官方预设目录并按四原则并入价格中心（新增自动、使用中变更需确认）">
                <DatabaseZap size={14} />
                <span>导入 DeepAA 官方预设</span>
              </button>
              <button type="button" className="secondary-button" onClick={importLiteLLM} disabled={loading}>
                <RefreshCcw size={14} />
                <span>导入 LiteLLM</span>
              </button>
              <button type="button" className="secondary-button" onClick={startCreateModel} disabled={loading || saving}>
                <Plus size={14} />
                <span>新增模型</span>
              </button>
              {/* 操作结果提示（2026-09-10 用户确认）：与三个操作按钮同一行，在右侧空白区居中；
                  保存模型价格 / 导入 DeepAA 官方预设 / 导入 LiteLLM 共用。 */}
              <div className="pricing-toolbar-message">
                {message ? (
                  <div className="pricing-header-message" role="status" title={message}>{message}</div>
                ) : null}
              </div>
            </div>

            <section className="pricing-source-strip">
              <span title={litellmSyncTip}>LiteLLM 已同步上游最新版</span>
              <strong title={litellmSyncTip}>{formatVersionDateTime(litellmSyncedAt) || "未导入"}</strong>
              <span title={officialTip}>{officialLabel}</span>
              <strong title={officialTip}>{officialVersionText}</strong>
              <span>模型数量</span>
              <strong>{catalog?.total ?? 0}</strong>
            </section>

            <div className={`pricing-content-grid${listCollapsed ? " list-collapsed" : ""}`}>
              <section className="pricing-table-panel">
                <div className="pricing-panel-title">
                  <strong>模型价格目录</strong>
                  <span>{loading ? "加载中..." : `第 ${offset + 1}-${Math.min(offset + CATALOG_LIMIT, catalog?.total || 0)} 条 / 共 ${catalog?.total || 0} 条`}</span>
                </div>
                <div className="pricing-filters">
                  <MultiSelectFilter
                    label="模型"
                    options={modelOptions}
                    selected={filterModelKeys}
                    onChange={next => { setFilterModelKeys(next); void loadCatalog({offset: 0, modelEntries: next}); }}
                    searchPlaceholder="搜索模型或供应商…"
                    triggerMinWidth={280}
                  />
                  <MultiSelectFilter
                    label="供应商"
                    options={vendorOptions}
                    selected={filterVendors}
                    onChange={next => { setFilterVendors(next); void loadCatalog({offset: 0, vendors: next}); }}
                    searchPlaceholder="搜索供应商…"
                  />
                  <MultiSelectFilter
                    label="来源类别"
                    options={categoryOptions}
                    selected={filterCategories}
                    onChange={next => { setFilterCategories(next); void loadCatalog({offset: 0, categories: next}); }}
                    searchPlaceholder="搜索来源…"
                  />
                  {hasFilters ? (
                    <button type="button" className="msf-clear"
                      onClick={() => {
                        setFilterModelKeys([]);
                        setFilterVendors([]);
                        setFilterCategories([]);
                        void loadCatalog({offset: 0, modelEntries: [], vendors: [], categories: []});
                      }}>
                      清空筛选
                    </button>
                  ) : null}
                </div>
                <div className="pricing-table" role="table" aria-label="模型价格目录">
                  <div className="pricing-table-row header" role="row">
                    <span>模型</span>
                    <span>供应商</span>
                    {/* 折叠时隐藏的列（收起后仅保留模型 + 供应商）。 */}
                    <span className="pricing-col-hide">模式</span>
                    <span className="pricing-col-hide">非缓存输入</span>
                    <span className="pricing-col-hide">缓存命中</span>
                    <span className="pricing-col-hide">缓存写入</span>
                    <span className="pricing-col-hide">输出价格</span>
                  </div>
                  {(catalog?.items || []).map(item => (
                    <button
                      type="button"
                      key={item.id}
                      className={`pricing-table-row${selectedModel?.id === item.id ? " active" : ""}`}
                      onClick={() => { setIsCreatingModel(false); setSelectedModel(item); setPriceDrafts(priceDraftsFromModel(item)); }}
                    >
                      <span>
                        {runtimeModelIdOf(item)}
                        {item.rateTimeline?.length && item.rateTimeline.length > 1 ? <em title="存在多段价格（含待生效调价）">（分时调价 {item.rateTimeline.length} 段）</em> : null}
                        {!item.rateTimeline?.length && item.priceSchedules?.length ? <em>（峰谷）</em> : null}
                        {item.serviceTierPricing?.fastMultiplier !== undefined ? <em title={`Fast ${item.serviceTierPricing.fastMultiplier}× 标准价`}>（fast）</em> : null}
                        {item.promotions?.length ? <em>（促销）</em> : null}
                        {item.inputModalities?.includes("image") ? <em title="支持图片输入（随官方目录下发）">（视觉）</em> : null}
                        {item.inputModalities?.includes("audio") ? <em title="支持语音输入（随官方目录下发）">（语音）</em> : null}
                        {item.pricing?.longContext ? <small className="pricing-peak-valley">长上下文&gt;{Math.round(item.pricing.longContext.thresholdTokens / 1000)}K 输入×{item.pricing.longContext.inputMultiplier}/输出×{item.pricing.longContext.outputMultiplier}</small> : null}
                        {schedulePricingText(item.pricing, item.priceSchedules, {currency: item.currency}) ? <small className="pricing-peak-valley">{schedulePricingText(item.pricing, item.priceSchedules, {currency: item.currency})}</small> : null}
                      </span>
                      <span><em className={`pricing-confidence ${confidenceBadge(item.confidence).className}`}>{confidenceBadge(item.confidence).label}</em>{item.vendor}</span>
                      <span className="pricing-col-hide">{item.mode || "-"}</span>
                      <span className="pricing-col-hide">{formatPrice(item.pricing?.input, item.currency)}</span>
                      <span className="pricing-col-hide">{formatPrice(item.pricing?.cachedInput, item.currency)}</span>
                      <span className="pricing-col-hide">{formatPrice(item.pricing?.cacheWrite, item.currency)}</span>
                      <span>{formatPrice(item.pricing?.output, item.currency)}</span>
                    </button>
                  ))}
                </div>
                <div className="pricing-pagination">
                  <button type="button" className="secondary-button" disabled={offset === 0 || loading} onClick={() => loadCatalog({offset: Math.max(0, offset - CATALOG_LIMIT)})}>上一页</button>
                  <button type="button" className="secondary-button" disabled={loading || offset + CATALOG_LIMIT >= (catalog?.total || 0)} onClick={() => loadCatalog({offset: offset + CATALOG_LIMIT})}>下一页</button>
                </div>
              </section>

              {/* 左右栏折叠：收起左侧目录到「模型 + 供应商」两列，编辑器同步加宽。 */}
              <button
                type="button"
                className="pricing-column-toggle"
                onClick={() => setListCollapsed(value => !value)}
                title={listCollapsed ? "展开模型价格目录" : "收起模型价格目录（仅保留模型与供应商）"}
                aria-label={listCollapsed ? "展开模型价格目录" : "收起模型价格目录"}
              >
                {listCollapsed ? "›" : "‹"}
              </button>

              <section className="pricing-editor-panel">
                <div className="pricing-panel-title">
                  <strong>{isCreatingModel ? "新增模型价格" : "模型价格编辑"}</strong>
                  <span>单位：官方原始数值 / 百万 token</span>
                </div>
                {selectedModel ? (
                  <div className="pricing-editor-form">
                      <CollapsibleSection title="基础信息" storageKey="basic">
                        <div className="editor-module-grid">
                      <label>
                        <span>模型 ID</span>
                        <input value={runtimeModelIdOf(selectedModel)} readOnly={!isCreatingModel} onChange={event => updateSelectedModel({ runtimeModelId: event.currentTarget.value })} />
                      </label>
                      <label>
                        <span>供应商</span>
                        <input value={selectedModel.vendor} readOnly={!isCreatingModel} onChange={event => updateSelectedModel({ vendor: event.currentTarget.value })} />
                      </label>
                      <label>
                        <span>模式</span>
                        <input value={selectedModel.mode || ""} onChange={event => updateSelectedModel({ mode: event.currentTarget.value })} />
                      </label>
                        </div>
                      </CollapsibleSection>
                      {modelCapabilitiesText(selectedModel) ? (
                        <div className="pricing-editor-meta">
                          <span>模型能力</span>
                          <code>{modelCapabilitiesText(selectedModel)}</code>
                        </div>
                      ) : null}
                      <div className="pricing-editor-meta">
                        <span>来源信息</span>
                        <code>
                          当前置信度：{confidenceBadge(selectedModel.confidence).label}
                          {selectedModel.catalogRevision ? ` · 官方目录 ${selectedModel.catalogRevision}` : ""}
                        </code>
                      </div>
                      {selectedRestoreInfo ? (
                        <div className="pricing-editor-meta">
                          <span>可恢复来源</span>
                          <code>
                            {restoreSourceStateText(selectedRestoreInfo.sourceState)}
                            {selectedRestoreInfo.sourceRevision ? ` · revision ${selectedRestoreInfo.sourceRevision}` : ""}
                            {selectedRestoreInfo.sourceCapturedAt ? ` · 时间 ${formatVersionDateTime(selectedRestoreInfo.sourceCapturedAt)}` : ""}
                          </code>
                        </div>
                      ) : null}
                      {selectedTargetOverrideHint ? (
                        <div className="pricing-editor-meta pricing-restore-warning" role="note">
                          <span>目标级覆盖提醒</span>
                          <code>{selectedTargetOverrideHint}</code>
                        </div>
                      ) : null}
                      <CollapsibleSection
                        title={selectedModel.priceSchedules?.length ? "高峰价格" : "计费价格"}
                        subtitle={selectedModel.priceSchedules?.length ? "基础价即高峰档（非缓存输入 / 缓存命中 / 缓存写入 / 输出 / reasoning）" : undefined}
                        storageKey="base"
                      >
                        <div className="editor-module-grid">
                      <label>
                        <span>非缓存输入</span>
                        <input inputMode="decimal" value={priceDrafts.input} onChange={event => updateSelectedPricing("input", event.currentTarget.value)} />
                      </label>
                      <label>
                        <span>缓存命中</span>
                        <input inputMode="decimal" value={priceDrafts.cachedInput} onChange={event => updateSelectedPricing("cachedInput", event.currentTarget.value)} />
                      </label>
                      <label>
                        <span>缓存写入</span>
                        <input inputMode="decimal" value={priceDrafts.cacheWrite} onChange={event => updateSelectedPricing("cacheWrite", event.currentTarget.value)} />
                      </label>
                      <label>
                        <span>输出价格</span>
                        <input inputMode="decimal" value={priceDrafts.output} onChange={event => updateSelectedPricing("output", event.currentTarget.value)} />
                      </label>
                      <label>
                        <span>reasoning 价格</span>
                        <input inputMode="decimal" value={priceDrafts.reasoning} onChange={event => updateSelectedPricing("reasoning", event.currentTarget.value)} />
                      </label>
                        </div>
                      </CollapsibleSection>
                    {selectedModel.priceSchedules?.length ? (
                      <>
                        <CollapsibleSection
                          title="闲时价格（Off-Peak）"
                          subtitle={peakWindowText(selectedModel.priceSchedules, viewerTimeZone.iana) ?? undefined}
                          storageKey="offPeak"
                        >
                          <div className="editor-module-grid">
                            <label>
                              <span>非缓存输入</span>
                              <input inputMode="decimal" value={priceDrafts.offPeakInput} onChange={event => updateSelectedPricing("offPeakInput", event.currentTarget.value)} />
                            </label>
                            <label>
                              <span>缓存命中</span>
                              <input inputMode="decimal" value={priceDrafts.offPeakCachedInput} onChange={event => updateSelectedPricing("offPeakCachedInput", event.currentTarget.value)} />
                            </label>
                            <label>
                              <span>缓存写入</span>
                              <input inputMode="decimal" value={priceDrafts.offPeakCacheWrite} onChange={event => updateSelectedPricing("offPeakCacheWrite", event.currentTarget.value)} />
                            </label>
                            <label>
                              <span>输出价格</span>
                              <input inputMode="decimal" value={priceDrafts.offPeakOutput} onChange={event => updateSelectedPricing("offPeakOutput", event.currentTarget.value)} />
                            </label>
                          </div>
                        </CollapsibleSection>
                      </>
                    ) : null}
                      <CollapsibleSection title="长上下文档位" subtitle="一般为空；不同上下文计价单位不同才需要填写" defaultOpen={false} storageKey="longContext">
                        <div className="editor-module-grid">
                      <label>
                        <span>触发阈值（token，如 272000）</span>
                        <input inputMode="decimal" value={priceDrafts.longContextThreshold} onChange={event => updateSelectedPricing("longContextThreshold", event.currentTarget.value)} placeholder="如 272000，留空无" />
                      </label>
                      <label>
                        <span>输入倍率（如 2）</span>
                        <input inputMode="decimal" value={priceDrafts.longContextInput} onChange={event => updateSelectedPricing("longContextInput", event.currentTarget.value)} placeholder="如 2" />
                      </label>
                      <label>
                        <span>输出倍率（如 1.5）</span>
                        <input inputMode="decimal" value={priceDrafts.longContextOutput} onChange={event => updateSelectedPricing("longContextOutput", event.currentTarget.value)} placeholder="如 1.5" />
                      </label>
                        </div>
                      </CollapsibleSection>
                      <CollapsibleSection title="fast 档倍率" subtitle="service_tier=fast/priority 时按倍率计价（如 2 = 2×标准价，作用于实际命中价）；留空=未配置" defaultOpen={false} storageKey="fastTier">
                        <div className="editor-module-grid">
                      <label>
                        <span>fast 倍率（如 2）</span>
                        <input inputMode="decimal" value={priceDrafts.fastMultiplier} onChange={event => updateSelectedPricing("fastMultiplier", event.currentTarget.value)} placeholder="如 2，留空无" />
                      </label>
                        </div>
                      </CollapsibleSection>
                      <CollapsibleSection title="按量促销实扣价" subtitle="仅官方通道生效；价格全清=移除促销" defaultOpen={false} storageKey="promotion">
                        <div className="editor-module-grid">
                      <label>
                        <span>非缓存输入</span>
                        <input inputMode="decimal" value={priceDrafts.promoInput} onChange={event => updateSelectedPricing("promoInput", event.currentTarget.value)} placeholder="如 4" />
                      </label>
                      <label>
                        <span>缓存命中</span>
                        <input inputMode="decimal" value={priceDrafts.promoCachedInput} onChange={event => updateSelectedPricing("promoCachedInput", event.currentTarget.value)} placeholder="如 0.4" />
                      </label>
                      <label>
                        <span>缓存写入</span>
                        <input inputMode="decimal" value={priceDrafts.promoCacheWrite} onChange={event => updateSelectedPricing("promoCacheWrite", event.currentTarget.value)} placeholder="如 5" />
                      </label>
                      <label>
                        <span>输出价格</span>
                        <input inputMode="decimal" value={priceDrafts.promoOutput} onChange={event => updateSelectedPricing("promoOutput", event.currentTarget.value)} placeholder="如 20" />
                      </label>
                      <label>
                        <span>促销起始（必填，YYYY-MM-DD）</span>
                        <input value={priceDrafts.promoFrom} onChange={event => updatePromotionDraft("promoFrom", event.currentTarget.value)} placeholder="如 2026-07-01" />
                      </label>
                      <label>
                        <span>促销截止（可空=无限期）</span>
                        <input value={priceDrafts.promoTo} onChange={event => updatePromotionDraft("promoTo", event.currentTarget.value)} placeholder="留空=官方未公布截止" />
                      </label>
                      <label>
                        <span>促销名称（账本/列表展示）</span>
                        <input value={priceDrafts.promoLabel} onChange={event => updatePromotionDraft("promoLabel", event.currentTarget.value)} placeholder="如 官方限时 2/3 价" />
                      </label>
                      <label>
                        <span>限定 Agent（逗号分隔，如 zcode；留空=不限）</span>
                        <input value={priceDrafts.promoAgents} onChange={event => updatePromotionDraft("promoAgents", event.currentTarget.value)} placeholder="如 zcode" />
                      </label>
                        </div>
                      </CollapsibleSection>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={saveModelPricing}
                      disabled={saving || !priceDraftsDirty}
                      title={priceDraftsDirty ? undefined : "内容未变化，无需保存"}
                    >
                      <Save size={14} />
                      <span>保存模型价格</span>
                    </button>
                    {!isCreatingModel && selectedModel?.confidence === "user_override"
                      && selectedRestoreInfo ? (
                      <button type="button" className="secondary-button" onClick={() => void restoreSelectedModel()} disabled={restoring} title={selectedTargetOverrideHint || "按官方优先、LiteLLM 兜底取消当前全局手工覆盖"}>
                        <span>恢复{selectedRestoreInfo.source === "official" ? "官方预设" : "LiteLLM"}</span>
                      </button>
                    ) : null}
                    {/* 价格时间线（终极方案）：官方调价按时间区间展示——当前生效置顶、
                        待生效紧随（含公告文案）、历史折叠；无时间线条目回退峰谷价格行。 */}
                    {selectedModel.rateTimeline?.length ? (
                      <div className="pricing-editor-meta">
                        <span>价格时间线</span>
                        <div><RateTimelineList timeline={selectedModel.rateTimeline} /></div>
                      </div>
                    ) : schedulePricingText(selectedModel.pricing, selectedModel.priceSchedules, {currency: selectedModel.currency}) ? (
                      <div className="pricing-editor-meta">
                        <span>峰谷价格</span>
                        <code>{schedulePricingText(selectedModel.pricing, selectedModel.priceSchedules, {currency: selectedModel.currency})}</code>
                      </div>
                    ) : null}
                    {selectedModel.priceSchedules?.length ? (
                      <div className="pricing-editor-meta">
                        <span>时段费率</span>
                        <code>{peakWindowText(selectedModel.priceSchedules, viewerTimeZone.iana)}</code>
                      </div>
                    ) : null}
                    {scheduleHolidayText(selectedModel.priceSchedules) ? (
                      <div className="pricing-editor-meta">
                        <span>节假日</span>
                        <code>{scheduleHolidayText(selectedModel.priceSchedules)}</code>
                      </div>
                    ) : null}
                    {fastPricingText(selectedModel.serviceTierPricing) ? (
                      <div className="pricing-editor-meta">
                        <span>fast 档倍率</span>
                        <code>{fastPricingText(selectedModel.serviceTierPricing)}</code>
                      </div>
                    ) : null}
                    {selectedModel.promotions?.length ? (
                      <div className="pricing-editor-meta">
                        <span>按量促销</span>
                        <code>{selectedModel.promotions.map(promotionText).join("；")}</code>
                      </div>
                    ) : null}
                    {selectedModel.planCreditRules ? (
                      <div className="pricing-editor-meta">
                        <span>套餐积分规则</span>
                        <code>
                          {selectedModel.planCreditRules.formula}
                          {selectedModel.planCreditRules.notes ? `：${selectedModel.planCreditRules.notes}` : ""}
                        </code>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="pricing-empty">请选择左侧模型后编辑。供应商倍率在“供应商管理”里配置。</p>
                )}
              </section>
            </div>

            {/* 操作结果提示已移至弹窗右上角（金黄色）。 */}
          </section>
        </div>,
        document.body,
        )
      ) : null}
    </>
  );
}

/** 价格展示（D1，2026-09-28 用户确认）：补币种符号但不加人民币括号；未知币种不加符号。 */
function formatPrice(value: number | undefined, currency?: string): string {
  if (value === undefined) return "-";
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "￥" : "";
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}/M`;
}

function modelCapabilitiesText(model: ModelPriceEntry): string {
  return [
    model.inputModalities?.length ? `输入模态：${model.inputModalities.join(" / ")}` : undefined,
    model.contextWindow ? `上下文窗口：${model.contextWindow.toLocaleString()} token` : undefined,
    model.maxOutput ? `最大输出：${model.maxOutput.toLocaleString()} token` : undefined,
    model.supportedWireApis?.length ? `协议：${model.supportedWireApis.join(" / ")}` : undefined,
  ].filter((item): item is string => Boolean(item)).join(" · ");
}

/** fast 档价格摘要（详情面板展示）；未配置返回 null。 */
function fastPricingText(tier: ServiceTierPricing | undefined): string | null {
  const multiplier = tier?.fastMultiplier;
  if (multiplier === undefined) return null;
  return `Fast ${multiplier}×（作用于实际命中标准价）`;
}

/** 按量促销摘要（详情面板展示）：名称、时间窗（to 空=不限）、agent 限定与实扣价。 */
function promotionText(promotion: PaygPromotion): string {
  const window = `${promotion.from.slice(0, 10)}~${promotion.to ? promotion.to.slice(0, 10) : "不限"}`;
  const agents = promotion.agents?.length ? `（限 ${promotion.agents.join("/")}）` : "";
  if (promotion.priceOverride) {
    const prices = [
      `输入 ${promotion.priceOverride.input ?? "-"}`,
      `输出 ${promotion.priceOverride.output ?? "-"}`,
      promotion.priceOverride.cachedInput === undefined ? "" : `缓存 ${promotion.priceOverride.cachedInput}`,
      promotion.priceOverride.cacheWrite === undefined ? "" : `缓存写 ${promotion.priceOverride.cacheWrite}`,
    ].filter(Boolean).join(" · ");
    return `${promotion.label ?? "促销"} ${window}${agents}：${prices}`;
  }
  return `${promotion.label ?? "促销"} ${window}${agents}：整单 ×${promotion.multiplier}`;
}

function runtimeModelIdOf(model: ModelPriceEntry): string {
  return model.runtimeModelId || model.match || model.patterns[0] || model.id;
}

function confidenceBadge(confidence: ModelPriceEntry["confidence"] | undefined): {label: string; className: string} {
  switch (confidence) {
    case "official":
    case "provider_docs":
      return {label: "官方", className: "pricing-confidence-official"};
    case "third_party":
      return {label: "LiteLLM", className: "pricing-confidence-litellm"};
    case "user_override":
      return {label: "手工覆盖", className: "pricing-confidence-override"};
    case "unverified":
      return {label: "待确认", className: "pricing-confidence-unverified"};
    default:
      return {label: "未知", className: "pricing-confidence-unknown"};
  }
}

function restoreSourceStateText(
  state: "current_official" | "historical_official" | "litellm_baseline" | "litellm_snapshot",
): string {
  switch (state) {
    case "current_official":
      return "当前官方推荐底稿";
    case "historical_official":
      return "历史官方底稿";
    case "litellm_baseline":
      return "LiteLLM 底稿";
    case "litellm_snapshot":
      return "LiteLLM 随版本快照";
  }
}
