import {ChevronDown, Save, Search} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {deriveProxyTargetPatchFromBaseUrl} from "@/lib/proxy-settings-draft";
import {ProviderCatalogReview} from "@/components/proxy-management/provider-catalog-review";
import {billingChannelLabel, presetFamilyLabel} from "@/lib/preset-family";
import {PROVIDER_PRESETS} from "@/lib/provider-presets";
import type {ProviderCatalogReview as ProviderCatalogReviewData} from "@/lib/provider-catalog/service";
import type {AgentId, ProxyConfig, ProxyTarget} from "@/types";
import styles from "./proxy-management.module.css";

interface ProxyBasicTabProps {
  target: ProxyTarget;
  localProxyBaseUrl: string;
  routeIdLocked: boolean;
  agentConnections: ProxyConfig["agentConnections"];
  busy: boolean;
  /** 其余供应商（含 URL）：新建草稿派生路由 ID 时做全局判重与同 URL 对判定，避免候选链撞名。 */
  existingTargets?: readonly Pick<ProxyTarget, "id" | "openaiUrl" | "anthropicUrl">[];
  onChange: (patch: Partial<ProxyTarget>) => void;
  onSave: () => void;
  onRefreshProviderCatalog: (presetId: string, forceRefresh: boolean) => Promise<void>;
  /** 新建供应商选择预设后的目录候选；放在默认收起的「自定义设置」中供可选调整。 */
  presetReview?: ProviderCatalogReviewData;
  presetReviewBusy: boolean;
  onConfirmPresetReview: (selectedModelIds: string[], replacementDefaultModels: Partial<Record<AgentId, string>>) => Promise<void>;
  onCancelPresetReview: () => void;
  onPresetSelectionChange?: (selectedModelIds: string[]) => void;
}

/**
 * 基础配置：新建草稿默认走「官方预设」接入方式，固定地址由预设自动填充并只读展示，
 * 代理名称、路由 ID 与目录模型放在默认收起的「自定义设置」中；切换到「非官方预设」
 * 时清空已填内容、要求完全重新录入 URL。已保存供应商保持原有布局（预设锁定 + URL 可改）。
 */
export function ProxyBasicTab({target, localProxyBaseUrl, routeIdLocked, agentConnections, busy, existingTargets = [], onChange, onSave, onRefreshProviderCatalog, presetReview, presetReviewBusy, onConfirmPresetReview, onCancelPresetReview, onPresetSelectionChange}: ProxyBasicTabProps) {
  /** 第一个输入的上游 URL 协议；清空后再输入其它协议会重新派生。 */
  const [urlPriority, setUrlPriority] = useState<"openai" | "anthropic" | null>(null);
  /** 用户手动编辑过代理名称后，不再跟随 URL 自动解析。 */
  const [nameTouched, setNameTouched] = useState(false);
  /** 用户手动编辑过路由 ID 后，不再跟随 URL 自动派生。 */
  const [routeTouched, setRouteTouched] = useState(false);
  /** 已选择的官方预设（保持选中显示）：初始按当前上游 URL 反查，重挂载/切换供应商后不丢失。 */
  const [selectedPresetId, setSelectedPresetId] = useState(() => matchPresetForTarget(target)?.id || "");
  /** 新建草稿的接入方式：官方预设或非官方预设；已保存供应商不展示该选择。 */
  const [channelMode, setChannelMode] = useState<"official" | "custom">("official");
  /** 保存基线：已保存供应商进入编辑时，无任何字段变化则「确认修改」置灰。 */
  const baselineRef = useRef<BasicBaseline>(snapshot(target));
  /** 官方预设自定义下拉：展开状态与搜索词。 */
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [presetSearch, setPresetSearch] = useState("");
  const presetPickerRef = useRef<HTMLDivElement>(null);
  const presetSearchRef = useRef<HTMLInputElement>(null);

  // 切换供应商时重置派生状态；草稿的路由 ID 会随派生变化，因此以 createdAt 为身份键。
  useEffect(() => {
    baselineRef.current = snapshot(target);
    setUrlPriority(null);
    setNameTouched(false);
    setRouteTouched(false);
    setPresetPickerOpen(false);
    setPresetSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.createdAt]);

  // 预设下拉打开时支持点击外部/Escape 关闭，并自动聚焦搜索框。
  useEffect(() => {
    if (!presetPickerOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (presetPickerRef.current && !presetPickerRef.current.contains(event.target as Node)) {
        setPresetPickerOpen(false);
        setPresetSearch("");
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPresetPickerOpen(false);
        setPresetSearch("");
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [presetPickerOpen]);

  useEffect(() => {
    if (presetPickerOpen) presetSearchRef.current?.focus();
  }, [presetPickerOpen]);

  /** 已保存供应商只有字段确实变化才允许「确认修改」。 */
  const dirty = !routeIdLocked || hasBaselineChanges(baselineRef.current, target);

  /** 统一提交两个协议 URL 并做名称/路由 ID 派生；priority 为派生来源协议。 */
  function commitUrls(openaiUrl: string, anthropicUrl: string, priority: "openai" | "anthropic" | null) {
    const patch: Partial<ProxyTarget> = {
      openaiUrl: openaiUrl || undefined,
      anthropicUrl: anthropicUrl || undefined,
    };
    const sourceUrl = priority === "openai" ? openaiUrl : priority === "anthropic" ? anthropicUrl : openaiUrl || anthropicUrl;
    // 已保存供应商的路由 ID 锁定，只更新协议地址；草稿按统一候选链自动填充。
    if (sourceUrl && !routeIdLocked) {
      try {
        const derived = deriveProxyTargetPatchFromBaseUrl(
          {...target, openaiUrl, anthropicUrl},
          sourceUrl,
          nameTouched,
          localProxyBaseUrl,
          routeTouched, // 手动编辑过的路由 ID 不再被派生覆盖
          existingTargets,
        );
        patch.id = derived.id;
        if (!nameTouched) patch.name = derived.name;
      } catch { /* URL 尚未合法时不派生，仅更新 URL */ }
    }
    if (target.presetId && selectedPresetId) {
      const preset = PROVIDER_PRESETS.find(item => item.id === selectedPresetId);
      if (preset && (normalizeComparableUrl(openaiUrl) !== normalizeComparableUrl(preset.openaiUrl)
        || normalizeComparableUrl(anthropicUrl) !== normalizeComparableUrl(preset.anthropicUrl))) {
        patch.presetId = undefined;
      }
    }
    setUrlPriority(priority);
    onChange(patch);
  }

  function handleUrlChange(protocol: "openai" | "anthropic", value: string) {
    const openaiUrl = protocol === "openai" ? value : target.openaiUrl || "";
    const anthropicUrl = protocol === "anthropic" ? value : target.anthropicUrl || "";
    // 哪个协议 URL 先输入，就以它作为代理名称/路由 ID 的派生来源。
    let priority = urlPriority;
    if (priority === protocol && !value.trim()) priority = null;
    else if (!priority && value.trim() && !(protocol === "openai" ? target.openaiUrl : target.anthropicUrl)?.trim()) priority = protocol;
    commitUrls(openaiUrl, anthropicUrl, priority);
    const selectedPreset = PROVIDER_PRESETS.find(item => item.id === selectedPresetId);
    if (selectedPreset) {
      const expectedUrl = protocol === "openai" ? selectedPreset.openaiUrl : selectedPreset.anthropicUrl;
      if ((expectedUrl && normalizeComparableUrl(value) !== normalizeComparableUrl(expectedUrl)) || (!expectedUrl && value.trim())) {
        // 改动官方预设地址即切换为自定义供应商，避免服务端按旧预设误合并价格或能力。
        setSelectedPresetId("");
        onCancelPresetReview();
      }
    }
  }

  /** 应用官方预设：按预设全量替换两个协议 URL（新预设未声明的协议置空），并写入供应商标识。 */
  function applyPreset(presetId: string) {
    const preset = PROVIDER_PRESETS.find(item => item.id === presetId);
    if (!preset) return;
    setSelectedPresetId(presetId);
    const openaiUrl = preset.openaiUrl || "";
    const anthropicUrl = preset.anthropicUrl || "";
    commitUrls(openaiUrl, anthropicUrl, preset.openaiUrl ? "openai" : "anthropic");
    onChange({presetId: preset.id, pricing: {...target.pricing, vendor: preset.vendor}});
    // 固定读取 /api/provider-catalog；这里只传预设 ID，不允许 UI 覆盖远端目录地址。
    void onRefreshProviderCatalog(presetId, false);
  }

  /**
   * 新建草稿切换接入方式：官方↔非官方互相切换时清空 URL、预设身份与派生的
   * 名称/路由 ID，要求完全重新填写，避免把官方预设地址误当成自定义地址保存。
   */
  function switchChannelMode(next: "official" | "custom") {
    if (next === channelMode) return;
    setChannelMode(next);
    setPresetPickerOpen(false);
    setPresetSearch("");
    setSelectedPresetId("");
    setUrlPriority(null);
    setNameTouched(false);
    setRouteTouched(false);
    onChange({
      openaiUrl: undefined,
      anthropicUrl: undefined,
      presetId: undefined,
      name: "",
      id: "",
      pricing: {...target.pricing, vendor: undefined},
    });
    onCancelPresetReview();
  }

  function handleNameChange(value: string) {
    setNameTouched(true);
    onChange({name: value});
  }

  function handleRouteIdChange(value: string) {
    setRouteTouched(true);
    onChange({id: value});
  }

  const creating = !routeIdLocked;  const officialMode = creating && channelMode === "official";
  const customMode = creating && channelMode === "custom";
  // 新建草稿且尚未填写任何上游 URL 时，高亮「接入配置」卡片引导从这里开始。
  const urlCardHighlight = customMode && !target.openaiUrl && !target.anthropicUrl;
  const presetStartHint = officialMode && !selectedPresetId;
  // 新建供应商在官方模式未选预设、或非官方模式未填任何 URL 时禁止提交。
  const createDisabled = creating && ((officialMode && !selectedPresetId) || (customMode && !target.openaiUrl && !target.anthropicUrl));
  const presetGroups = groupedPresetOptions(presetSearch);
  const selectedPreset = PROVIDER_PRESETS.find(item => item.id === selectedPresetId);
  // 已保存供应商且已选定官方预设：下拉锁定不可更换，内容框整体置灰以提示不可修改。
  const presetLocked = routeIdLocked && Boolean(selectedPresetId);

  return <div className={styles.tabStack}>
    <section className={`${styles.card} ${urlCardHighlight ? styles.cardUrlHighlight : ""}`}><header className={styles.cardHeader}><div><h3>接入配置 {presetStartHint ? <span className={styles.urlStartBadge}>从这里开始</span> : null}</h3><p>{creating ? (officialMode ? "选择官方预设后自动填充固定地址；供应商名称、路由 ID 与模型可在「自定义设置」中调整。" : "自行录入非官方上游地址；供应商名称与路由 ID 在下方「自定义设置」中。") : "官方预设置顶选择，两个协议 URL 至少填写一种；供应商名称与路由 ID 在下方「自定义设置」中。"}</p></div></header><div className={styles.formStack}>
      {creating ? <div className={styles.channelModeArea}><div className={styles.channelModeTabs} role="tablist" aria-label="接入方式"><button type="button" role="tab" aria-selected={officialMode} className={`${styles.channelModeTab} ${officialMode ? styles.channelModeTabActive : ""}`} onClick={() => switchChannelMode("official")}>官方预设</button><button type="button" role="tab" aria-selected={customMode} className={`${styles.channelModeTab} ${customMode ? styles.channelModeTabActive : ""}`} onClick={() => switchChannelMode("custom")}>非官方预设</button></div><p className={styles.channelModeHint}>{officialMode ? "官方供应商固定地址由预设自动填充，防止填错；直接点击「新建供应商」即可。" : "适用于中转站、自建网关等自定义上游；OpenAI 协议URL 和 Anthropic 协议URL 至少需要填一个。"}</p></div> : null}
      {(officialMode || (!creating && (!routeIdLocked || selectedPresetId))) ? (
        <div className={`${styles.field} ${styles.presetPicker} ${presetLocked ? styles.presetPickerLocked : ""}`} ref={presetPickerRef}>
          <span>{creating ? "官方预设" : "官方预设（可选）"}</span>
          <div className={styles.presetPickerControl}>
            <button
              type="button"
              className={`${styles.presetPickerTrigger} ${presetPickerOpen ? styles.presetPickerTriggerOpen : ""}`}
              disabled={presetLocked}
              aria-haspopup="listbox"
              aria-expanded={presetPickerOpen}
              onClick={() => setPresetPickerOpen(open => !open)}
            >
              <span className={styles.presetPickerValue}>{selectedPreset ? `${selectedPreset.name}（${billingChannelLabel(selectedPreset.billingChannel)}）` : creating ? "请选择官方预设" : "非官方预设 URL 等信息自行录入"}</span>
              <ChevronDown size={15} className={presetPickerOpen ? styles.presetPickerChevronOpen : undefined} />
            </button>
            {presetPickerOpen ? (
              <div className={styles.presetPickerPanel} role="listbox" aria-label="官方预设">
                <label className={styles.presetPickerSearchWrap}>
                  <Search size={15} aria-hidden="true" />
                  <input ref={presetSearchRef} className={styles.presetPickerSearch} value={presetSearch} onChange={event => setPresetSearch(event.currentTarget.value)} placeholder="搜索供应商、套餐或通道" />
                </label>
                <div className={styles.presetPickerGroups}>
                  {presetGroups.length === 0 ? (
                    <p className={styles.presetPickerEmpty}>没有匹配的官方预设。</p>
                  ) : presetGroups.map(({family, items}) => (
                    <div key={family} className={styles.presetPickerGroup}>
                      <h4 className={styles.presetPickerGroupTitle}>{presetFamilyLabel(family)} · {items.length} 个通道</h4>
                      {items.map(item => (
                        <button
                          type="button"
                          key={item.id}
                          role="option"
                          aria-selected={selectedPresetId === item.id}
                          className={`${styles.presetPickerOption} ${selectedPresetId === item.id ? styles.presetPickerOptionActive : ""}`}
                          onClick={() => {
                            applyPreset(item.id);
                            setPresetPickerOpen(false);
                            setPresetSearch("");
                          }}
                        >
                          <span>{item.name}</span>
                          <span className={styles.channelLabel}>{billingChannelLabel(item.billingChannel)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <small>{creating ? (officialMode ? "选择官方预设会自动填充固定地址；保存后预设锁定，不可更换。" : "非官方预设请自行录入 URL、密钥和模型。") : (routeIdLocked && selectedPresetId ? "创建后预设已锁定，不可更换；仍可手动修改上方协议 URL。" : "选择官方预设会自动填充公开 URL；非官方预设请自行录入 URL、密钥和模型。")}</small>
        </div>
      ) : null}
      {customMode || !creating ? <>
        <label className={styles.field}><span>OpenAI 协议（支持 chat/completions、responses）上游 URL <b>*</b></span><input type="url" value={target.openaiUrl || ""} onChange={event => handleUrlChange("openai", event.currentTarget.value)} placeholder="未填写 · 例如 https://api.example.com/v1" /></label>
        <label className={styles.field}><span>Anthropic 协议（支持 v1/messages）上游 URL <b>*</b></span><input type="url" value={target.anthropicUrl || ""} onChange={event => handleUrlChange("anthropic", event.currentTarget.value)} placeholder="未填写 · 例如 https://api.example.com" /></label>
      </> : null}
      {!creating ? (
        <label className={styles.field}>
          <span>网关凭据模式</span>
          <select
            value={target.credentialMode === "passthrough" ? "passthrough" : ""}
            onChange={event => onChange({credentialMode: event.currentTarget.value === "passthrough" ? "passthrough" as const : undefined})}
          >
            <option value="">系统凭据注入（默认）</option>
            <option value="passthrough">登录透传（转发客户端自带凭据）</option>
          </select>
          <small>透传模式下网关不注入、不要求系统密钥，把客户端（如 ZCode 登录态）的 Authorization 原样转发给上游；仅支持声明订阅透传能力的 Agent 协议路径。切换后保存并重新同步 CLI 配置生效。</small>
        </label>
      ) : null}
      <details className={styles.advancedSettings}><summary>自定义设置</summary>
        <div className={styles.formStack}>
          {officialMode && presetReview ? <ProviderCatalogReview review={presetReview} busy={presetReviewBusy} createMode onCancel={onCancelPresetReview} onConfirm={onConfirmPresetReview} onSelectionChange={onPresetSelectionChange} /> : null}
          {officialMode && selectedPreset ? (
            <div className={styles.readonlyUrlBlock}><strong>固定上游地址（由官方预设提供，只读）</strong><dl className={styles.readonlyUrlList}><div><dt>OpenAI 协议</dt><dd><code>{selectedPreset.openaiUrl || "该预设未提供"}</code></dd></div><div><dt>Anthropic 协议</dt><dd><code>{selectedPreset.anthropicUrl || "该预设未提供"}</code></dd></div></dl></div>
          ) : null}
          <div className={styles.formGrid}>
            <label className={styles.field}><span>供应商名称 <b>*</b></span><input value={target.name} onChange={event => handleNameChange(event.currentTarget.value)} placeholder="由上游 URL 自动解析，可手动修改" /><small>自动填充后仍可手动修改。</small></label>
            <label className={styles.field}><span>路由 ID <b>*</b></span><input value={target.id} onChange={event => handleRouteIdChange(event.currentTarget.value)} pattern="[a-z0-9.-]+" readOnly={routeIdLocked} aria-disabled={routeIdLocked} /><small>{routeIdLocked ? "路由 ID 只能新建时填写，创建之后不允许修改。" : "输入上游 URL 后自动填充；仅小写字母、数字、点和连字符，不能含下划线。"}</small></label>
          </div>
        </div>
      </details>
      <div className={styles.basicSaveRow}><button type="button" className={styles.primaryButton} onClick={onSave} disabled={busy || !dirty || createDisabled}><Save size={16} /> {busy ? "保存中…" : routeIdLocked ? "确认修改" : "新建供应商"}</button></div>
    </div></section>

  </div>;
}


/** 基础配置可编辑字段的保存基线；用于「确认修改」无变化时置灰。 */
interface BasicBaseline {
  name: string;
  id: string;
  openaiUrl?: string;
  anthropicUrl?: string;
  vendor?: string;
  presetId?: string;
}

function snapshot(target: ProxyTarget): BasicBaseline {
  return {
    name: target.name,
    id: target.id,
    openaiUrl: target.openaiUrl,
    anthropicUrl: target.anthropicUrl,
    vendor: target.pricing?.vendor,
    presetId: target.presetId,
  };
}

function hasBaselineChanges(baseline: BasicBaseline, target: ProxyTarget): boolean {
  const current = snapshot(target);
  return baseline.name !== current.name
    || baseline.id !== current.id
    || baseline.openaiUrl !== current.openaiUrl
    || baseline.anthropicUrl !== current.anthropicUrl
    || baseline.vendor !== current.vendor
    || baseline.presetId !== current.presetId
}

/** 按当前供应商的协议 URL 反查官方预设：任一所填 URL 与预设精确匹配即视为选中。 */
function matchPresetForTarget(target: ProxyTarget) {
  if (target.presetId) return PROVIDER_PRESETS.find(preset => preset.id === target.presetId);
  return PROVIDER_PRESETS.find(preset =>
    (preset.openaiUrl && normalizeComparableUrl(preset.openaiUrl) === normalizeComparableUrl(target.openaiUrl))
    || (preset.anthropicUrl && normalizeComparableUrl(preset.anthropicUrl) === normalizeComparableUrl(target.anthropicUrl)),
  );
}

function normalizeComparableUrl(value: string | undefined): string {
  if (!value?.trim()) return "";
  try {
    const url = new URL(value.trim());
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim().replace(/\/+$/u, "").toLowerCase();
  }
}

/**
 * 官方预设按供应商族分组并过滤搜索词；搜索匹配预设名、路由 ID 与族标签，
 * 同一供应商族（按量/套餐/订阅通道）聚在一个色块内。
 */
function groupedPresetOptions(search: string): Array<{family: string; items: typeof PROVIDER_PRESETS[number][]}> {
  const needle = search.trim().toLowerCase();
  const groupedPresets = new Map<string, typeof PROVIDER_PRESETS[number][]>();
  for (const item of PROVIDER_PRESETS.filter(preset => preset.ready)) {
    const family = item.vendorFamily || "other";
    if (needle && !`${item.name} ${item.id} ${presetFamilyLabel(family)}`.toLowerCase().includes(needle)) continue;
    const items = groupedPresets.get(family) || [];
    items.push(item);
    groupedPresets.set(family, items);
  }
  return [...groupedPresets.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
    .map(([family, items]) => ({family, items}));
}
