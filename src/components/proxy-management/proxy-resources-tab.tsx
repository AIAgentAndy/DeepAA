import {KeyRound, Plus, RefreshCw, Trash2} from "lucide-react";
import {Fragment, useEffect, useRef, useState} from "react";
import {SearchableSelect} from "@/components/searchable-select";
import {confirmDialog} from "@/components/confirm-dialog";
import {ProxyFallbackDialog} from "./proxy-fallback-dialog";
import {agentLabel, AGENT_CATALOG, agentCompatibleModelsForTarget, buildAgentDropPatch, protocolAgentsForTarget, resolveTargetAgentCapability, servedAgentsForTarget} from "@/components/proxy-management/agent-catalog";
import {AgentScopePicker} from "@/components/agent-scope-picker";
import {SecretRevealChip} from "./secret-reveal";
import {nextCredentialLabel} from "@/lib/proxy-management-domain";
import {formatFallbackEntryLabel} from "@/lib/failover-display";
import {formatCredentialFingerprint} from "@/components/proxy-management/credential-format";
import {resolveTargetModelPriceEntry, resolveTargetModelWireApis} from "@/lib/proxy-management-domain";
import {credentialOAuthStatus} from "@/lib/oauth/codex-status";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {isOfficialPresetTarget} from "./proxy-onboarding-wizard";
import {activeDisplayPromotion, overlayDisplayRates, promotionWindowLabel} from "@/lib/promotion-display";
import {ModelDiscoveryTable} from "./model-discovery-table";
import {ProviderCatalogReview} from "./provider-catalog-review";
import {usePricingCatalogPicker} from "./use-pricing-catalog-picker";
import {ZcodeLocalImportHint} from "./zcode-local-import-hint";
import type {ProviderCatalogReview as ProviderCatalogReviewData} from "@/lib/provider-catalog/service";
import type {ModelPriceEntry} from "@/lib/pricing";
import {formatOriginalPrice} from "@/lib/money-display";
import {schedulePricingText, scheduleWindowText} from "@/lib/token-pricing-display";
import {useGlobalTimeZone} from "@/lib/timezone-preference";
import {RateTimelineList} from "@/components/rate-timeline-list";
import type {CredentialItem, ModelDiscoverResponse} from "./proxy-management-types";
import {agentScopeIncludes, KNOWN_AGENT_IDS, type AgentId, type ProxyConfig, type ProxyTarget, type ProxyTargetModelPricingOverride, type ProxyTargetPricingRates, type TemporalPriceSchedule} from "@/types";
import styles from "./proxy-management.module.css";

interface AgentScopeOption {id: AgentId; label: string; color?: "codex" | "claude" | "opencode" | "dsh" | "zcode";}

interface ProxyResourcesTabProps {
  target: ProxyTarget;
  config: ProxyConfig;
  credentials: CredentialItem[];
  pricingModels: ModelPriceEntry[];
  /** 当前已接入的 Agent：模型/密钥的「Agent 适用」选项随接入情况联动展示。 */
  connectedAgents: AgentId[];
  busy: boolean;
  /** 即时保存供应商补丁（模型、适用、计费覆盖等直接落库，无需再点整体保存）。 */
  onSaveTargetPatch: (patch: Partial<ProxyTarget>, successMessage?: string) => Promise<void>;
  /** 模型自动发现：只读探测 /models，不直接写 Agent 可见模型。 */
  onDiscoverModels: (credentialId?: string) => Promise<ModelDiscoverResponse>;
  onConfirmDiscoveredModels: (credentialId: string, selectedModelIds: string[]) => Promise<ModelDiscoverResponse>;
  /** 官方预设刷新最新目录，与当前 Agent 可见模型做差异确认。 */
  onRefreshProviderCatalog: (presetId: string, forceRefresh: boolean) => Promise<void>;
  providerCatalogLoading: boolean;
  providerCatalogReview?: ProviderCatalogReviewData;
  onConfirmProviderCatalogReview: (selectedModelIds: string[], replacementDefaultModels: Partial<Record<AgentId, string>>) => Promise<void>;
  onCancelProviderCatalogReview: () => void;
  onOpenPricingCenter: () => void;
  onCreateCredential: (input: {label: string; secret: string; rateMultiplier: number; agentScope?: string[]}) => Promise<string | undefined>;
  onUpdateCredential: (input: {credentialId: string; label?: string; rateMultiplier?: number; agentScope?: string[] | null; secret?: string}) => Promise<void>;
  onDeleteCredential: (credentialId: string) => Promise<void>;
  /** 支持度级联等场景直接更新某条密钥的适用 Agent（服务端同步落库）。 */
  onUpdateCredentialScope: (credentialId: string, agents: string[]) => Promise<void>;
  /** 级联取消接入：供应商失去对某些 Agent 的支持后，自动解除这些 Agent 与当前供应商的绑定。 */
  onUnbindAgents: (agents: AgentId[]) => Promise<void>;
  /** 全局价格修改：写入价格中心唯一条目（vendor + 模型），对所有未单独定价的供应商生效。 */
  onSaveGlobalPrice: (runtimeModelId: string, vendor: string, pricing: ProxyTargetPricingRates, priceSchedules?: unknown[]) => Promise<void>;
  onRemoveGlobalPrice: (runtimeModelId: string, vendor: string) => Promise<void>;
  onSaveTargetPrice: (targetModelId: string, pricing: ProxyTargetPricingRates, priceSchedules?: unknown[], currency?: "CNY" | "USD") => Promise<void>;
  onRemoveTargetPrice: (targetModelId: string) => Promise<void>;
}

export function ProxyResourcesTab(props: ProxyResourcesTabProps) {
  const {target, config, credentials, pricingModels, busy, onSaveTargetPatch} = props;
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [discoveryCredentialId, setDiscoveryCredentialId] = useState("");
  const [discoveryResult, setDiscoveryResult] = useState<ModelDiscoverResponse>();
  const [selectedDiscoveredModels, setSelectedDiscoveredModels] = useState<string[]>([]);
  // 价格中心选择默认按当前供应商过滤（2026-10-07 用户确认）：官方预设/显式 vendor 可解析时
  // 默认只显示该供应商条目，避免 cn 区人民币与 global 区美元的同名模型误选；可手动取消。
  const [pricingVendorOnly, setPricingVendorOnly] = useState(true);
  const [expandedModel, setExpandedModel] = useState<string>();
  const [fallbackModel, setFallbackModel] = useState<string>();
  const [credentialForm, setCredentialForm] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState({label: "", secret: "", rate: "1", scope: [] as AgentId[]});
  const [credentialError, setCredentialError] = useState("");
  const targetCredentials = credentials.filter(item => item.targetId === target.id);
  const officialPreset = isOfficialPresetTarget(target);
  const presetId = target.presetId || resolveOfficialPresetForTarget(target)?.id || "";
  // 适用选项必须与「供应商实际接入/支持的 Agent」联动：
  // 只有当前供应商真正能服务的 Agent（启用绑定 + 协议 + 适用模型 + 适用密钥）才允许出现在
  // 模型与密钥的「适用 Agent」下拉中；失去支持的 Agent 由级联逻辑同步从适用与默认链移除。
  const servedSet = new Set(servedAgentsForTarget(target, credentials));
  const boundProtocolAgentIds = AGENT_CATALOG
    .filter(entry => {
      const connection = config.agentConnections[entry.id];
      return connection?.enabled !== false
        && (connection?.boundTargetIds?.includes(target.id) || connection?.defaultTargetId === target.id)
        && resolveTargetAgentCapability(target, entry.id).supported;
    })
    .map(entry => entry.id);
  // 模型适用选项：只允许供应商真正支持的 Agent（协议 + wire 兼容模型 + 适用密钥）。
  const scopeOptions: AgentScopeOption[] = boundProtocolAgentIds
    .filter(id => servedSet.has(id))
    .map(id => ({id: id as AgentId, label: agentLabel(id as AgentId), color: agentScopeColor(id as AgentId)}));
  // 密钥适用选项：在模型适用选项基础上，额外允许「模型已适用但尚无密钥」的 Agent，
  // 保证首个密钥仍能勾选到供应商已准备好模型的 Agent（向导完成时按接入结果收紧）。
  const modelClaimedAgentIds = AGENT_CATALOG
    .filter(entry => agentCompatibleModelsForTarget(target, entry.id).length > 0)
    .map(entry => entry.id);
  const credentialScopeOptions: AgentScopeOption[] = boundProtocolAgentIds
    .filter(id => servedSet.has(id) || modelClaimedAgentIds.includes(id))
    .map(id => ({id: id as AgentId, label: agentLabel(id as AgentId), color: agentScopeColor(id as AgentId)}));
  /** 新建密钥默认勾选当前供应商支持的全部 Agent；用户可手动调整后提交，显式记录勾选结果。 */
  function openCredentialForm() {
    setCredentialForm(value => !value);
    setCredentialDraft({label: nextCredentialLabel(target.name, targetCredentials.map(item => item.label)), secret: "", rate: "1", scope: credentialScopeOptions.map(option => option.id)});
  }
  // 供应商过滤值：官方预设 vendor 优先（cn 区键与 global 区同名模型靠它区分），其次目标显式 vendor。
  const pricingVendorFilter = resolveOfficialPresetForTarget(target)?.vendor ?? target.pricing?.vendor ?? "";
  // 选择器专用取数（2026-10-07 修复：服务端 vendor/search 查询 + 100/页分页）：不复用共享
  // pricingModels——那份是 limit=200 的全量截断列表，客户端再按 vendor 过滤会把排在
  // 200 名开外的供应商条目（如 opencode-go）全部滤空，误导性显示「暂无条目」。
  const pricingPicker = usePricingCatalogPicker({
    vendor: pricingVendorOnly && pricingVendorFilter ? pricingVendorFilter : undefined,
    supportedModels: target.supportedModels,
    modelVendors: target.pricing?.modelVendors,
  });

  // 自定义供应商探测模型时默认选中一条密钥：优先 Agent 默认密钥，否则第一条供应商密钥。
  useEffect(() => {
    if (discoveryCredentialId || targetCredentials.length === 0) return;
    const preferred = AGENT_CATALOG
      .map(agent => target.development?.defaultCredentials?.[agent.id])
      .find((id): id is string => Boolean(id) && targetCredentials.some(item => item.id === id))
      || targetCredentials[0]?.id;
    if (preferred) setDiscoveryCredentialId(preferred);
  }, [discoveryCredentialId, targetCredentials, target.development]);

  async function runDiscovery() {
    if (discovering) return;
    if (!discoveryCredentialId) {
      setDiscoverError("请先选择一条已保存的供应商密钥，再探测模型。");
      return;
    }
    setDiscovering(true);
    setDiscoverError("");
    try {
      const result = await props.onDiscoverModels(discoveryCredentialId);
      setDiscoveryResult(result);
      // 默认不勾选任何模型（2026-10-07 用户确认，与向导口径一致）：由用户显式勾选要加入的
      // 模型；已在白名单的模型在表格中强制勾选置灰展示（不可取消），本密钥未返回的既有
      // 模型由服务端在确认时自动保留，不会互相覆盖。
      setSelectedDiscoveredModels([]);

    } catch (error) {
      setDiscoverError(error instanceof Error ? error.message : "模型发现失败");
    } finally {
      setDiscovering(false);
    }
  }

  async function confirmDiscovery() {
    if (!discoveryCredentialId || selectedDiscoveredModels.length === 0) return;
    setDiscovering(true);
    setDiscoverError("");
    try {
      const result = await props.onConfirmDiscoveredModels(discoveryCredentialId, selectedDiscoveredModels);
      setDiscoveryResult(result);
      // 确认成功后自动收起探测列表，回到收起前状态（2026-09-04 用户确认）。
      collapseDiscovery();
    } catch (error) {
      setDiscoverError(error instanceof Error ? error.message : "确认模型失败");
    } finally {
      setDiscovering(false);
    }
  }

  function toggleAllDiscoveredModels(checked: boolean) {
    // 全选仅作用 matched（removed 行固定保留，不参与勾选）
    const selectable = (discoveryResult?.matched || []).map(item => item.modelId);
    setSelectedDiscoveredModels(checked ? selectable : []);
  }

  /** 收起探测结果：清空勾选与结果，回到点击「探测上游模型」之前的状态。 */
  function collapseDiscovery() {
    setSelectedDiscoveredModels([]);
    setDiscoveryResult(undefined);
  }

  function toggleDiscoveredModel(modelId: string, checked: boolean) {
    setSelectedDiscoveredModels(current => checked
      ? [...new Set([...current, modelId])]
      : current.filter(id => id !== modelId));
  }

  function addModel(entry: ModelPriceEntry) {
    const runtimeModelId = entry.runtimeModelId || entry.match || entry.patterns[0] || entry.id;
    if (!runtimeModelId || target.supportedModels.includes(runtimeModelId)) return;
    // 快速添加与向导同规则：默认适用 = 该供应商协议可达的 Agent（缺省会拒绝全部 Agent）。
    const nextScopes = {...target.supportedModelScopes};
    nextScopes[runtimeModelId] = protocolAgentsForTarget(target);
    void onSaveTargetPatch({
      supportedModels: [...target.supportedModels, runtimeModelId],
      supportedModelScopes: nextScopes,
      pricing: {
        ...target.pricing,
        modelVendors: {
          ...target.pricing?.modelVendors,
          [runtimeModelId]: {vendor: entry.vendor || entry.litellmProvider, priceEntryId: entry.id},
        },
      },
      }, `已添加模型 ${runtimeModelId}`).catch(() => undefined);
  }

  function removeModel(modelId: string) {
    void confirmDialog({title: "移除模型", danger: true, message: `确认从当前供应商移除模型「${modelId}」？将同时清理该模型的 Agent 适用、价格映射与计费覆盖，把引用它的默认模型自动清除，并从所有供应商的故障转移模型链中移除对该模型的引用。`}).then(confirmed => {
      if (!confirmed) return;
      const modelVendors = {...target.pricing?.modelVendors};
      const modelOverrides = target.pricing?.modelOverrides?.filter(item => item.targetModelId !== modelId);
      delete modelVendors[modelId];
      const scopes = {...target.supportedModelScopes};
      delete scopes[modelId];
      const defaultModels = {...target.development?.defaultModels};
      for (const agent of KNOWN_AGENT_IDS) if (defaultModels[agent] === modelId) delete defaultModels[agent];
      void onSaveTargetPatch({
        supportedModels: target.supportedModels.filter(item => item !== modelId),
        supportedModelScopes: Object.keys(scopes).length ? scopes : undefined,
        pricing: {...target.pricing, modelVendors, modelOverrides},
        development: {...target.development, defaultModels},
      }, `已移除模型 ${modelId}`).catch(() => undefined);
    });
  }

  /** 保存某主模型的有序备份链；空链 = 删除该键（不启用故障转移）。 */
  async function saveModelFallbacks(modelId: string, fallbacks: string[]) {
    const next = {...(target.supportedModelFallbacks || {})};
    if (fallbacks.length > 0) next[modelId] = fallbacks;
    else delete next[modelId];
    await onSaveTargetPatch(
      {supportedModelFallbacks: Object.keys(next).length > 0 ? next : undefined},
      fallbacks.length > 0
        ? `已保存 ${modelId} 的故障转移模型（优先级 ${fallbacks.length} 级）`
        : `已清空 ${modelId} 的故障转移模型，该模型不再启用故障转移`,
    );
  }

  /**
   * 适用变更后的「供应商支持度」级联：变更后供应商不再能服务的 Agent（没有适用模型或适用密钥），
   * 从全部模型适用、密钥适用与 Agent 级默认链中联动取消，并自动解除该 Agent 与当前供应商的
   * 接入（含 CLI 受管配置清理），保证「接入 = 链路完整」的闭环。
   * base* 为变更前状态，next* 为变更后状态。
   */
  async function cascadeSupportChange(
    baseTarget: ProxyTarget,
    baseCredentials: CredentialItem[],
    nextTarget: ProxyTarget,
    nextCredentials: CredentialItem[],
  ): Promise<void> {
    const before = new Set(servedAgentsForTarget(baseTarget, baseCredentials));
    const after = new Set(servedAgentsForTarget(nextTarget, nextCredentials));
    const dropped: AgentId[] = AGENT_CATALOG
      .filter(entry => before.has(entry.id) && !after.has(entry.id))
      .map(entry => entry.id);
    if (dropped.length === 0) return;
    const patch = buildAgentDropPatch(nextTarget, dropped);
    if (patch) {
      await onSaveTargetPatch(patch, `已联动取消不再支持的 Agent 适用与默认链：${dropped.map(agentLabel).join("、")}`);
    }
    // 其余密钥的适用同步清理：只处理当前供应商的密钥——级联不支持跨供应商影响，
    // 且页面层 updateCredential 以当前选中供应商提交，跨供应商密钥会报「密钥不存在或不属于当前供应商」。
    for (const credential of nextCredentials) {
      if (credential.targetId !== nextTarget.id) continue;
      const kept = (credential.agentScope || []).filter(id => !dropped.includes(id as AgentId));
      if (kept.length === (credential.agentScope || []).length) continue;
      await props.onUpdateCredentialScope(credential.id, kept);
    }
    // 级联取消接入：失去支持的 Agent 若仍绑定当前供应商，自动解除绑定（默认供应商引用先清理），
    // CLI 受管配置随绑定变化由页面统一同步，避免残留「链路不完整」的接入状态。
    if (dropped.length > 0 && props.onUnbindAgents) {
      await props.onUnbindAgents(dropped);
    }
  }

  return <div className={styles.tabStack}>
    <ZcodeLocalImportHint presetId={presetId} agents={boundProtocolAgentIds} variant="tab" />
    <section className={styles.card}>
      {officialPreset ? <>
        <header className={styles.cardHeader}><div><h3>预设目录模型</h3></div>{presetId ? <button type="button" className={styles.secondaryButton} disabled={busy || props.providerCatalogLoading} onClick={() => void props.onRefreshProviderCatalog(presetId, true)}><RefreshCw size={16} /> {props.providerCatalogLoading ? "加载中…" : "刷新预设模型"}</button> : null}</header>
        {props.providerCatalogReview ? <div className={styles.formStack}><ProviderCatalogReview review={props.providerCatalogReview} busy={busy || props.providerCatalogLoading} createMode={false} onCancel={props.onCancelProviderCatalogReview} onConfirm={props.onConfirmProviderCatalogReview} /></div> : null}
      </> : <>
      <header className={styles.cardHeader}><div><h3>模型探测</h3><p>先选择供应商密钥，再请求上游 /models。探测只生成新旧差异；只有价格中心唯一匹配且经用户确认的模型才能加入 Agent 可见模型。</p></div></header>
      <div className={styles.addRow}><label className={styles.field}><span>模型发现密钥</span><select value={discoveryCredentialId} onChange={event => setDiscoveryCredentialId(event.currentTarget.value)}><option value="">请选择供应商密钥</option>{targetCredentials.map(item => <option key={item.id} value={item.id}>{item.label} · {formatCredentialFingerprint(item.fingerprintSuffix)}</option>)}</select></label><button type="button" className={styles.secondaryButton} onClick={() => void runDiscovery()} disabled={discovering || busy || !discoveryCredentialId}><RefreshCw size={16} /> {discovering ? "探测中…" : "探测上游模型"}</button></div>
      {discoverError ? <p className={styles.errorText} role="alert">{discoverError}</p> : null}
      {discoveryResult ? <div className={styles.formStack}>
        <ModelDiscoveryTable result={discoveryResult} selectedModelIds={selectedDiscoveredModels} onToggle={toggleDiscoveredModel} onToggleAll={toggleAllDiscoveredModels} />
        {((discoveryResult.matched?.length || 0) + (discoveryResult.removed?.length || 0)) > 0 ? <div className={styles.addRow}><button type="button" className={styles.secondaryButton} onClick={collapseDiscovery}>收起模型探测列表</button><button type="button" className={styles.primaryButton} onClick={() => void confirmDiscovery()} disabled={discovering || busy || selectedDiscoveredModels.length === 0}>确认所选模型</button></div> : null}
      </div> : null}
      </>}
      <div className={styles.addRow}><label className={`${styles.field} ${styles.modelPicker}`}><span>手动从价格中心添加模型{pricingVendorFilter ? <label className={styles.pricingVendorToggle} title={`默认只显示当前供应商（${pricingVendorFilter}）的价格中心条目，避免误选其它供应商（如美元区同名模型）；取消后显示全部供应商。`}><input type="checkbox" checked={pricingVendorOnly} onChange={event => setPricingVendorOnly(event.currentTarget.checked)} />仅显示 {pricingVendorFilter}</label> : null}</span><SearchableSelect value="" options={pricingPicker.options} filterOptions={false} searchValue={pricingPicker.search} onSearchChange={pricingPicker.setSearch} onChange={value => {const entry = pricingPicker.findEntryById(value); if (entry) addModel(entry);}} placeholder={pricingPicker.loading ? "模型加载中..." : "搜索价格中心模型添加"} searchPlaceholder="搜索模型 ID，如 gpt-5.6-sol、deepseek-v4-flash" loading={pricingPicker.loading || pricingPicker.loadingMore} belowSearch={pricingPicker.familyVendor ? <label className="searchable-select-accessory" title={`默认只展示 ${pricingPicker.familyVendor} 供应商的匹配条目；取消勾选后显示其它供应商的同名模型。`}><input type="checkbox" checked={pricingPicker.familyOnly} onChange={event => pricingPicker.setFamilyOnly(event.currentTarget.checked)} />仅显示 {pricingPicker.familyVendor}</label> : undefined} resultMessage={pricingPicker.total > 0 ? `共 ${pricingPicker.total} 条${pricingVendorOnly && pricingVendorFilter ? `（${pricingVendorFilter}）` : ""}，已加入 ${pricingPicker.addedCount} 条` : undefined} footerAction={pricingPicker.hasMore ? {label: `加载更多（${pricingPicker.entries.length}/${pricingPicker.total}）`, onClick: pricingPicker.loadMore, disabled: pricingPicker.loadingMore} : undefined} /></label></div>
      <p className={styles.modelHint}>搜索不到？先到 <button type="button" className={styles.linkButton} onClick={props.onOpenPricingCenter}>价格中心</button> 添加模型，再回到这里选择。</p>
      {target.supportedModels.length === 0 ? <p className={styles.emptyCompact}>尚未添加支持的模型。</p> : <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>模型</th><th>Agent 适用</th><th>供应商（价格中心）</th><th>基础价格 /M</th><th>计费覆盖</th><th>故障转移</th><th>操作</th></tr></thead><tbody>{target.supportedModels.map(modelId => {
        const mapping = target.pricing?.modelVendors?.[modelId];
        const entry = resolveTargetModelPriceEntry(pricingModels, modelId, mapping);
        const override = target.pricing?.modelOverrides?.find(item => item.targetModelId === modelId);
        const defaultAgents = KNOWN_AGENT_IDS.filter(agent =>
          target.development?.defaultModels?.[agent] === modelId
          && servedSet.has(agent)
          && agentScopeIncludes(target.supportedModelScopes?.[modelId], agent));
        const globalManual = entry?.confidence === "user_override";
        return <Fragment key={modelId}>
          <ModelRow target={target} config={config} modelId={modelId} entry={entry} override={override} scopeOptions={scopeOptions} defaultAgents={defaultAgents} targetCredentials={targetCredentials} fallbacks={target.supportedModelFallbacks?.[modelId] ?? []} onEditFallbacks={() => setFallbackModel(modelId)} onCascadeSupport={cascadeSupportChange} expanded={expandedModel === modelId} onToggle={() => setExpandedModel(current => current === modelId ? undefined : modelId)} onCollapse={() => setExpandedModel(undefined)} onSavePatch={onSaveTargetPatch} onRemove={() => removeModel(modelId)} onSaveGlobalPrice={props.onSaveGlobalPrice} onRemoveGlobalPrice={props.onRemoveGlobalPrice} onSaveTargetPrice={props.onSaveTargetPrice} onRemoveTargetPrice={props.onRemoveTargetPrice} />
        </Fragment>;
      })}</tbody></table></div>}
      {fallbackModel ? <ProxyFallbackDialog target={target} config={config} modelId={fallbackModel} busy={busy} onSave={fallbacks => saveModelFallbacks(fallbackModel, fallbacks)} onClose={() => setFallbackModel(undefined)} /> : null}
    </section>
    <section className={styles.card}>
      <header className={styles.cardHeader}><div><h3><KeyRound size={17} /> 密钥</h3><p>真实密钥只写入系统凭据库；页面展示密钥指纹（前 4 + 后 4）、价格倍率和 Agent 适用，标有「默认」的密钥是当前供应商在对应 Agent 下使用的密钥。</p></div><button type="button" className={styles.primaryButton} onClick={openCredentialForm}><Plus size={16} /> 新增密钥</button></header>
      {credentialForm ? <form className={styles.credentialFormRow} onSubmit={event => {event.preventDefault(); setCredentialError(""); void props.onCreateCredential({label: credentialDraft.label, secret: credentialDraft.secret, rateMultiplier: Number(credentialDraft.rate) || 1, agentScope: credentialDraft.scope}).then(() => {setCredentialForm(false); setCredentialDraft({label: "", secret: "", rate: "1", scope: []});}).catch(error => setCredentialError(error instanceof Error ? error.message : "保存密钥失败"));}}>
        <label className={styles.credentialField}><span>密钥名称</span><input required value={credentialDraft.label} onChange={event => setCredentialDraft({...credentialDraft, label: event.currentTarget.value})} /></label>
        <label className={`${styles.credentialField} ${styles.credentialFieldWide}`}><span>密钥内容</span><input required type="password" autoComplete="off" value={credentialDraft.secret} onChange={event => setCredentialDraft({...credentialDraft, secret: event.currentTarget.value})} /></label>
        <label className={styles.credentialRateField}><span>倍率</span><input inputMode="decimal" value={credentialDraft.rate} onChange={event => setCredentialDraft({...credentialDraft, rate: event.currentTarget.value})} /></label>
        <AgentScopePicker value={credentialDraft.scope} options={credentialScopeOptions} onConfirm={scope => setCredentialDraft({...credentialDraft, scope})} />
        <button type="submit" className={styles.primaryButton}>保存到系统凭据库</button>
        {credentialError ? <p className={styles.errorText} role="alert">{credentialError}</p> : null}
      </form> : null}
      {targetCredentials.length === 0 ? <p className={styles.emptyCompact}>该供应商还没有系统密钥。</p> : <div className={styles.credentialList}>{targetCredentials.map(item => {
        const defaultAgents = KNOWN_AGENT_IDS.filter(agent =>
          target.development?.defaultCredentials?.[agent] === item.id
          && servedSet.has(agent)
          && agentScopeIncludes(item.agentScope, agent));
        return <CredentialRow key={item.id} item={item} target={target} config={config} credentials={credentials} targetCredentials={targetCredentials} scopeOptions={credentialScopeOptions} defaultAgents={defaultAgents} onUpdate={props.onUpdateCredential} onSaveTargetPatch={onSaveTargetPatch} onDelete={props.onDeleteCredential} onCascadeSupport={cascadeSupportChange} />;
      })}</div>}
    </section>
  </div>;
}

function ModelRow({target, config, modelId, entry, override, scopeOptions, defaultAgents, targetCredentials, fallbacks, onEditFallbacks, onCascadeSupport, expanded, onToggle, onCollapse, onSavePatch, onRemove, onSaveGlobalPrice, onRemoveGlobalPrice, onSaveTargetPrice, onRemoveTargetPrice}: {target: ProxyTarget; config: ProxyConfig; modelId: string; entry?: ModelPriceEntry; override?: ProxyTargetModelPricingOverride; scopeOptions: AgentScopeOption[]; defaultAgents: AgentId[]; targetCredentials: CredentialItem[]; fallbacks: string[]; onEditFallbacks: () => void; onCascadeSupport: (baseTarget: ProxyTarget, baseCredentials: CredentialItem[], nextTarget: ProxyTarget, nextCredentials: CredentialItem[]) => Promise<void>; expanded: boolean; onToggle: () => void; onCollapse: () => void; onSavePatch: (patch: Partial<ProxyTarget>, successMessage?: string) => Promise<void>; onRemove: () => void; onSaveGlobalPrice: (modelId: string, vendor: string, pricing: ProxyTargetPricingRates, priceSchedules?: unknown[]) => Promise<void>; onRemoveGlobalPrice: (modelId: string, vendor: string) => Promise<void>; onSaveTargetPrice: (targetModelId: string, pricing: ProxyTargetPricingRates, priceSchedules?: unknown[], currency?: "CNY" | "USD") => Promise<void>; onRemoveTargetPrice: (targetModelId: string) => Promise<void>}) {
  const scope = target.supportedModelScopes?.[modelId] || [];
  /* 币种展示（2026-10-08 用户确认，取代 2026-09-28 括号等值口径）：基础价格列仅按
     条目实际生效币种原样展示（标注 $/￥），不附人民币等值——逐请求与汇总换算由
     仪表盘 / Token 价格页承担。 */
  // 时段窗口按全站查看者时区展示（2026-09-30；缺省东八区）。
  const viewerTimeZone = useGlobalTimeZone().iana;
  const entryCurrency = entry?.currency === "CNY" || entry?.currency === "USD" ? entry.currency : undefined;
  // 模型适用选项只保留「与该模型 wire API 兼容」的已接入 Agent（如 gpt 系列对 dsh 不开放）。
  const modelScopeOptions = scopeOptions.filter(option => agentCompatibleModelsForTarget(target, option.id).includes(modelId));
  // 展示值与选项对齐：供应商已不再支持的 Agent 不在选项里，编辑时自然被剥离，不再隐藏残留。
  const modelScopeOptionsIds = new Set(modelScopeOptions.map(option => option.id));
  const visibleScope = scope.filter(id => modelScopeOptionsIds.has(id));
  // 模型级 wire API 能力（目标声明 → 预设继承 → URL+模型家族推断）：在模型 ID 后展示，
  // 让用户理解「只有部分 Agent 可用」源于协议限制而非配置遗漏。
  const modelWireApis = resolveTargetModelWireApis(target, modelId);
  // 覆盖价展示（原位置在下方，前移供编辑器种子使用）：target 级单独定价优先；
  // 价格中心条目为 user_override（全局手动修改）也视为覆盖，划掉被覆盖前的原始价格。
  const globalOverride = entry?.confidence === "user_override" && entry.previousPricing ? entry : undefined;
  const hasGlobalManualOverride = entry?.confidence === "user_override";
  const displayOverride = override ?? globalOverride;
  const displayOriginal = override ? entry?.pricing : globalOverride?.previousPricing;
  // 生效促销徽标 + 价格列促销价（2026-10-09 F7 用户确认）：官方目录编译的 payg 促销
  // 只对官方通道实扣生效（中转站按牌价），故仅官方预设目标显示；手工覆盖价优先于促销，
  // 覆盖存在时不再叠显促销（与入账端 override 路径不套促销一致）。
  const activePromotion = !displayOverride && isOfficialPresetTarget(target)
    ? activeDisplayPromotion(entry, new Date(), servedAgentsForTarget(target, targetCredentials).map(String))
    : undefined;
  const promoBadge = activePromotion ? (
    <span
      className={styles.peakValleyBadge}
      title={`官方通道促销实扣价生效中：${activePromotion.label ?? "限时促销"}（${promotionWindowLabel(activePromotion)}）；中转站目标仍按牌价计费`}
    >促销</span>
  ) : null;

  // 编辑器种子（2026-10-09 B1 用户确认）：无手工覆盖且促销生效时填入促销价，
  // 与收起态展示一致；保存即写手工覆盖（促销价会被固化，见编辑器内提示）。
  const seedRates = displayOverride?.pricing
    ?? (activePromotion?.priceOverride && entry?.pricing
      ? overlayDisplayRates(entry.pricing, activePromotion.priceOverride)
      : entry?.pricing);
  const [rates, setRates] = useState(() => rateDraft(seedRates));
  const [offPeakRates, setOffPeakRates] = useState<RateDraft | undefined>(() => offPeakRateDraft(entry, override));
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  /* 未改动守卫（2026-09-05 用户确认）：草稿与初始值完全一致时保存置灰，
     避免展开后未做任何修改点保存也生成一条「无实际变化」的计费覆盖。 */
  const initialRates = useRef(rates);
  const initialOffPeak = useRef(offPeakRates);
  const overrideDirty = JSON.stringify(rates) !== JSON.stringify(initialRates.current)
    || JSON.stringify(offPeakRates ?? null) !== JSON.stringify(initialOffPeak.current ?? null);
  /* 价格条目异步就绪晚于编辑器挂载时，首次展开草稿为空（2026-09-06 用户反馈）：
     展开期间只要用户未改动过，就按最新条目重灌草稿；用户已编辑则绝不覆盖。 */
  useEffect(() => {
    if (!expanded) return;
    const untouched = JSON.stringify(rates) === JSON.stringify(initialRates.current)
      && JSON.stringify(offPeakRates ?? null) === JSON.stringify(initialOffPeak.current ?? null);
    if (!untouched) return;
    const seeded = rateDraft(displayOverride?.pricing
      ?? (activePromotion?.priceOverride && entry?.pricing
        ? overlayDisplayRates(entry.pricing, activePromotion.priceOverride)
        : entry?.pricing));
    const seededOff = offPeakRateDraft(entry, override);
    if (JSON.stringify(seeded) === JSON.stringify(initialRates.current)
      && JSON.stringify(seededOff ?? null) === JSON.stringify(initialOffPeak.current ?? null)) return;
    setRates(seeded);
    setOffPeakRates(seededOff);
    initialRates.current = seeded;
    initialOffPeak.current = seededOff;
  }, [expanded, entry, override, displayOverride, activePromotion]);
  // 价格修改范围：默认写入价格中心唯一条目（vendor+模型）全局生效；
  // 「仅当前供应商」写入 target 级覆盖，应对中转站单独调价的场景。
  // 已存在单独定价的模型再次编辑时默认保持「仅当前供应商」——说明该供应商此前针对
  // 自己单独改过价，避免误把其它供应商的单独定价也纳入本次全局修改。
  const [pricingScope, setPricingScope] = useState<"global" | "target">(override ? "target" : "global");
  const pricingScopeRef = useRef<"global" | "target">(override ? "target" : "global");
  useEffect(() => {
    pricingScopeRef.current = pricingScope;
  }, [pricingScope]);
  // 价格中心条目供应商/运行时 ID：全局修改按此定位唯一条目；无条目时全局不可用。
  const pricingEntryVendor = entry?.vendor || entry?.litellmProvider || target.pricing?.modelVendors?.[modelId]?.vendor || "";
  const pricingEntryRuntimeId = entry?.runtimeModelId || entry?.match || entry?.patterns?.[0] || modelId;
  const canSaveGlobal = Boolean(entry && pricingEntryVendor);
  const basePrice = entry?.pricing
    ? schedulePricingText(entry.pricing, entry.priceSchedules, {currency: entryCurrency}) || formatRates(entry.pricing, entryCurrency)
    : "—";
  /**
   * React 可能延迟执行函数式状态更新；事件回调返回后 currentTarget 会被清空。
   * 因此先在 onChange 调用点同步取出字符串，再把纯值传入状态更新函数。
   */
  function updateRate(field: keyof RateDraft, value: string) {
    setRates(current => ({...current, [field]: value}));
  }
  function updateOffPeakRate(field: keyof RateDraft, value: string) {
    setOffPeakRates(current => current ? {...current, [field]: value} : current);
  }
  async function saveOverride() {
    const pricing = parseRates(rates);
    if (saving) return;
    if (!pricing) {
      setSaveError("请检查计费价格：基础非缓存输入和输出必须为数字；长上下文档位需同时填写阈值、输入倍率、输出倍率，或全部留空。");
      return;
    }
    const activePricingScope = pricingScopeRef.current;
    const schedules = entry?.priceSchedules?.length
      ? buildOverrideSchedules(entry.priceSchedules, offPeakRates)
      : undefined;
    if (entry?.priceSchedules?.length && !schedules) {
      setSaveError("请同时填写闲时非缓存输入和闲时输出；缓存输入可以留空。");
      return;
    }
    setSaveError("");
    setSaving(true);
    try {
      // 全局修改：写入价格中心唯一条目（user_override），所有未单独定价的供应商生效。
      if (activePricingScope === "global") {
        if (!canSaveGlobal) throw new Error("当前模型没有价格中心条目，无法全局修改；请先在价格中心添加或映射该模型。");
        await onSaveGlobalPrice(pricingEntryRuntimeId, pricingEntryVendor, pricing, schedules ?? undefined);
        onCollapse();
        return;
      }
      // 选择“仅当前供应商”即明确要求生成目标级覆盖，即使价格数值与全局相同；
      // 如需删除已有目标级覆盖，使用编辑区上方的“取消当前供应商手工覆盖”按钮。
      await onSaveTargetPrice(modelId, pricing, schedules ?? undefined, entryCurrency);
      onCollapse();
    } catch (error) {
      // 页面级 notice 可能被当前滚动位置遮住；编辑器必须就地展示失败原因，
      // 避免接口失败时用户只看到按钮恢复、误以为点击没有触发。
      setSaveError(error instanceof Error ? error.message : "计费价格保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }
  async function saveScope(rawNextScope: AgentId[]) {
    // 与展示选项对齐：供应商已不再支持的 Agent 不保留在适用中（联动取消）。
    const nextScope = rawNextScope.filter(id => modelScopeOptionsIds.has(id));
    const currentScope = target.supportedModelScopes?.[modelId];
    const nextScopes = {...target.supportedModelScopes};
    // 显式记录勾选结果：空数组（未选择任何 Agent）也如实落库，不删除为隐式状态。
    nextScopes[modelId] = nextScope;
    const patch: Partial<ProxyTarget> = {supportedModelScopes: Object.keys(nextScopes).length > 0 ? nextScopes : undefined};
    // 二次确认：去掉某 Agent 的适用，且该模型是该 Agent 的默认模型时，需确认并自动切换默认模型。
    const removedAgents = modelScopeOptions
      .filter(option => currentScope?.includes(option.id) === true && !nextScope.includes(option.id))
      .map(option => option.id);
    const nextDefaults = {...target.development?.defaultModels};
    for (const agent of removedAgents) {
      // 当前供应商不是该 Agent 的默认代理时，模型/密钥必不可能是默认，无需确认。
      if (config.agentConnections[agent]?.defaultTargetId !== target.id) continue;
      if (target.development?.defaultModels?.[agent] !== modelId) continue;
      // 规则：同代理下，非当前模型且最近添加且适用该 Agent 的模型。
      const fallback = [...target.supportedModels].reverse().find(item =>
        item !== modelId && nextScopes[item]?.includes(agent) === true);
      const confirmed = await confirmDialog({title: "调整模型适用", message: fallback
        ? `当前模型「${modelId}」是 ${agentLabel(agent)} 的默认模型，如果去掉该 Agent 适用，则默认模型将自动更新为「${fallback}」。确认继续？`
        : `当前模型「${modelId}」是 ${agentLabel(agent)} 的默认模型，去掉该 Agent 适用后 ${agentLabel(agent)} 将没有可用模型、无法使用当前代理，会变为待配置状态。确认继续？`});
      if (!confirmed) return;
      if (fallback) nextDefaults[agent] = fallback;
      else delete nextDefaults[agent];
    }
    if (Object.keys(nextDefaults).length !== Object.keys(target.development?.defaultModels || {}).length
      || Object.entries(nextDefaults).some(([k, v]) => (target.development?.defaultModels || {})[k as AgentId] !== v)) {
      patch.development = {...target.development, defaultModels: nextDefaults};
    }
    try {
      await onSavePatch(patch, `已更新 ${modelId} 的适用`);
      // 支持度级联：供应商不再服务的 Agent 从其余模型/密钥适用与默认链中联动取消。
      const nextTarget = {...target, supportedModelScopes: Object.keys(nextScopes).length > 0 ? nextScopes : undefined, ...(patch.development ? {development: patch.development} : {})};
      await onCascadeSupport(target, targetCredentials, nextTarget, targetCredentials);
    } catch { /* 错误已由页面 notice 展示 */ }
  }
  const peakValleyBadge = entry?.priceSchedules?.length ? <span className={styles.peakValleyBadge}>峰谷</span> : null;

  // 分时调价徽标（终极方案）：价格时间线多段时提示存在待生效/历史价格。
  const timelineBadge = (entry?.rateTimeline?.length ?? 0) > 1
    ? <span className={styles.peakValleyBadge} title="存在多段价格（含待生效调价）">分时调价 {entry!.rateTimeline!.length} 段</span>
    : null;
  // 无峰谷费率的模型只展示普通计费价格，避免“高峰价格”字样误导用户。
  const hasPeakValley = Boolean(entry?.priceSchedules?.length);
  const baseRateTitle = hasPeakValley
    ? "高峰价格（非缓存输入 / 缓存输入 / 输出）"
    : "计费价格（非缓存输入 / 缓存输入 / 输出）";
  function baseRateAria(field: "input" | "cachedInput" | "output"): string {
    const label = field === "input" ? "非缓存输入" : field === "cachedInput" ? "缓存输入" : "输出";
    return hasPeakValley ? `高峰 ${label}` : label;
  }
  // 峰谷模型基础价格列分两行：高峰一行、闲时一行，样式与字段顺序完全一致。
  const offPeakSchedule = entry?.priceSchedules?.[0];
  const cancelOverrideButton = pricingScope === "global" && hasGlobalManualOverride
    ? <button
        type="button"
        className={styles.secondaryButton}
        onClick={() => void onRemoveGlobalPrice(pricingEntryRuntimeId, pricingEntryVendor)}
        disabled={saving}
      >
        取消全局手工覆盖
      </button>
    : pricingScope === "target" && override
      ? <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void onRemoveTargetPrice(modelId)}
          disabled={saving}
        >
          取消当前供应商手工覆盖
        </button>
      : null;
  return <><tr><td><strong>{modelId}</strong>{modelWireApis.length > 0 ? <small className={styles.modelWireApiHint}>（供应商支持协议：{wireApiProtocolLabel(modelWireApis)}）</small> : null}{peakValleyBadge}{promoBadge}{timelineBadge}{defaultAgents.length > 0 ? <span className={styles.defaultBadge}>{defaultAgents.map(agentLabel).join("、")} 默认</span> : null}{override ? <span className={styles.targetOverrideBadge}>当前供应商手工覆盖</span> : globalOverride ? <span className={styles.targetOverrideBadge}>全局手工覆盖</span> : null}</td><td>{modelScopeOptions.length === 0 ? <span className={styles.scopeEmpty}>无兼容的已接入 Agent</span> : <AgentScopePicker value={visibleScope} options={modelScopeOptions} compact onConfirm={saveScope} />}</td><td>{entry?.vendor || entry?.litellmProvider || target.pricing?.modelVendors?.[modelId]?.vendor || "—"}</td><td>{hasPeakValley ? <div className={styles.peakValleyStack}><span className={displayOverride ? styles.struck : ""}>高峰 {formatRates(displayOriginal ?? entry?.pricing, entryCurrency)}</span>{offPeakSchedule ? <span className={displayOverride ? styles.struck : ""}>闲时 {formatRates(offPeakSchedule.rates, entryCurrency)}</span> : null}</div> : <span className={displayOverride || activePromotion ? styles.struck : ""}>{displayOriginal ? formatRates(displayOriginal, entryCurrency) : basePrice}</span>}{displayOverride ? <small className={styles.overridePrice}>{override ? formatOverrideRates(override, entryCurrency) : formatRates(displayOverride.pricing, entryCurrency)}</small> : activePromotion?.priceOverride && entry?.pricing ? <small className={styles.overridePrice} title={`官方通道促销实扣价（${activePromotion.label ?? "限时促销"}，${promotionWindowLabel(activePromotion)}）；中转站目标按牌价计费`}>促销 {formatRates(overlayDisplayRates(entry.pricing, activePromotion.priceOverride), entryCurrency)}（{promotionWindowLabel(activePromotion)}）</small> : null}</td><td><button type="button" className={styles.textButton} onClick={onToggle}>{displayOverride ? "编辑定价" : "计费覆盖"}</button></td><td>{fallbacks.length === 0 ? <button type="button" className={styles.linkButton} onClick={onEditFallbacks}>+ 设置故障转移模型</button> : <span className={styles.fallbackChips}>{(() => {
        const targetNames = new Map(config.targets.map(owner => [owner.id, owner.name || owner.id]));
        return fallbacks.map((gatewayModelId, index) => (
          <span key={gatewayModelId} className={styles.fallbackChip} title={`优先级 ${index + 1} · ${gatewayModelId}`}>
            {index + 1}. {formatFallbackEntryLabel(gatewayModelId, targetNames)}
          </span>
        ));
      })()}<button type="button" className={styles.textButton} onClick={onEditFallbacks}>编辑</button></span>}</td><td><button type="button" className={styles.iconButtonSmall} onClick={onRemove} aria-label={`移除 ${modelId}`}><Trash2 size={15} /></button></td></tr>{expanded ? <tr><td colSpan={7}><div className={styles.formStack}><div className={styles.overrideScopeRow}><label className={styles.overrideScopeSelect}><span>修改范围</span><select value={pricingScope} disabled={pricingScope === "global" && !canSaveGlobal} onChange={event => {const next = event.currentTarget.value as "global" | "target"; pricingScopeRef.current = next; setPricingScope(next);}}><option value="global">应用于价格中心（{pricingEntryVendor || "?"} + {modelId}）匹配的全部供应商（默认）</option><option value="target">仅应用于当前供应商</option></select></label><small className={styles.overrideScopeHint}>{pricingScope === "global" ? "写入价格中心唯一条目，所有使用该供应商+模型的供应商生效；当前供应商自身的单独定价统一到全局新值，其它供应商的单独定价保留。" : "写入当前供应商单独定价（应对中转站单独调价差异）；其它供应商仍使用价格中心价格。"}</small></div><div className={styles.overrideEditor}><span>{baseRateTitle}{entryCurrency === "USD" ? "（$ USD）" : entryCurrency === "CNY" ? "（￥ CNY）" : ""}</span><label className={styles.overrideRateField}><span>非缓存输入</span><input aria-label={baseRateAria("input")} inputMode="decimal" value={rates.input} onChange={event => updateRate("input", event.currentTarget.value)} /></label><label className={styles.overrideRateField}><span>缓存输入</span><input aria-label={baseRateAria("cachedInput")} inputMode="decimal" value={rates.cachedInput} onChange={event => updateRate("cachedInput", event.currentTarget.value)} /></label><label className={styles.overrideRateField}><span>输出</span><input aria-label={baseRateAria("output")} inputMode="decimal" value={rates.output} onChange={event => updateRate("output", event.currentTarget.value)} /></label>{activePromotion?.priceOverride && !displayOverride ? <small className={styles.overrideScopeHint}>已填入官方促销价（{activePromotion.label ?? "限时促销"}，{promotionWindowLabel(activePromotion)}）；保存将固化为手工覆盖，促销结束后不会自动回调牌价。</small> : null}</div>{entry?.priceSchedules?.length ? <div className={styles.overrideEditor}><span>闲时价格（非缓存输入 / 缓存输入 / 输出）</span><label className={styles.overrideRateField}><span>闲时 非缓存输入</span><input aria-label="闲时 非缓存输入" inputMode="decimal" value={offPeakRates?.input ?? ""} onChange={event => updateOffPeakRate("input", event.currentTarget.value)} /></label><label className={styles.overrideRateField}><span>闲时 缓存输入</span><input aria-label="闲时 缓存输入" inputMode="decimal" value={offPeakRates?.cachedInput ?? ""} onChange={event => updateOffPeakRate("cachedInput", event.currentTarget.value)} /></label><label className={styles.overrideRateField}><span>闲时 输出</span><input aria-label="闲时 输出" inputMode="decimal" value={offPeakRates?.output ?? ""} onChange={event => updateOffPeakRate("output", event.currentTarget.value)} /></label></div> : null}<div className={styles.overrideEditor}><span>长上下文档位（一般为空，不同上下文计价单位不同才需要填写）</span><label className={styles.overrideRateField}><span>阈值（token）</span><input aria-label="长上下文阈值" inputMode="decimal" value={rates.longContextThreshold} onChange={event => updateRate("longContextThreshold", event.currentTarget.value)} placeholder="如 272000，留空无" /></label><label className={styles.overrideRateField}><span>输入倍率</span><input aria-label="长上下文输入倍率" inputMode="decimal" value={rates.longContextInput} onChange={event => updateRate("longContextInput", event.currentTarget.value)} placeholder="如 2" /></label><label className={styles.overrideRateField}><span>输出倍率</span><input aria-label="长上下文输出倍率" inputMode="decimal" value={rates.longContextOutput} onChange={event => updateRate("longContextOutput", event.currentTarget.value)} placeholder="如 1.5" /></label></div>{entry?.priceSchedules?.length && scheduleWindowText(entry.priceSchedules, viewerTimeZone) ? <p className={styles.modelHint}>时段窗口：{scheduleWindowText(entry.priceSchedules, viewerTimeZone)}</p> : null}{saveError ? <p className={styles.errorText} role="alert">{saveError}</p> : null}{cancelOverrideButton}<button type="button" className={styles.primaryButton} onClick={() => void saveOverride()} disabled={saving || !overrideDirty} title={overrideDirty ? undefined : "内容未变化，无需保存"}>{saving ? "保存中…" : pricingScope === "global" ? "保存（全局）" : "保存（仅当前供应商）"}</button></div></td></tr> : null}</>;
}

function CredentialRow({item, target, config, credentials, targetCredentials, scopeOptions, defaultAgents, onUpdate, onSaveTargetPatch, onDelete, onCascadeSupport}: {item: CredentialItem; target: ProxyTarget; config: ProxyConfig; credentials: CredentialItem[]; targetCredentials: CredentialItem[]; scopeOptions: AgentScopeOption[]; defaultAgents: AgentId[]; onUpdate: ProxyResourcesTabProps["onUpdateCredential"]; onSaveTargetPatch: (patch: Partial<ProxyTarget>, successMessage?: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onCascadeSupport: (baseTarget: ProxyTarget, baseCredentials: CredentialItem[], nextTarget: ProxyTarget, nextCredentials: CredentialItem[]) => Promise<void>}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(item.label);
  const [rate, setRate] = useState(String(item.rateMultiplier ?? 1));
  const [scope, setScope] = useState<AgentId[]>((item.agentScope || []) as AgentId[]);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const oauthStatus = item.kind === "oauth" ? credentialOAuthStatus(item) : undefined;
  const oauthStatusMessage = oauthStatus && "message" in oauthStatus ? oauthStatus.message : "";
  const oauthExpired = oauthStatus?.state === "expired";
  // 展示值与选项对齐：供应商已不再支持的 Agent 不保留在适用中（联动取消）。
  const scopeOptionIds = new Set(scopeOptions.map(option => option.id));
  const visibleScope = scope.filter(id => scopeOptionIds.has(id));
  /**
   * 适用 Agent 修改单独受控：点下拉框「确认修改」即立刻保存适用（只提交适用，不携带
   * 名称/内容/倍率，避免与「保存修改」互相干扰）；默认密钥跟随取消与模型适用级联同步执行。
   */
  async function commitScope(rawNextScope: AgentId[]) {
    const nextScope = rawNextScope.filter(id => scopeOptionIds.has(id));
    const current = item.agentScope || [];
    const removedAgents = scopeOptions
      .filter(option => current.includes(option.id) && !nextScope.includes(option.id))
      .map(option => option.id);
    // 预测支持度变化：取消适用后该 Agent 在当前供应商不再有任何适用密钥时，
    // 将触发完整级联（取消接入 + 模型适用/默认链清理 + CLI 配置同步），必须提前告知用户。
    const afterCredentials = credentials.map(credential => credential.id === item.id
      ? {...credential, agentScope: nextScope}
      : credential);
    const beforeServed = new Set(servedAgentsForTarget(target, credentials));
    const afterServed = new Set(servedAgentsForTarget(target, afterCredentials));
    const droppedAgents = removedAgents.filter(agent => beforeServed.has(agent) && !afterServed.has(agent));
    // 级联检测：默认密钥切换与「取消接入」级联分别确认，两者都命中时合并为一条完整级联提示。
    for (const agent of removedAgents) {
      const willDrop = droppedAgents.includes(agent);
      const isDefaultCredential = target.development?.defaultCredentials?.[agent] === item.id;
      if (willDrop) {
        const onlyCredential = targetCredentials.length === 1;
        const confirmed = await confirmDialog({title: "调整密钥适用", message: `当前密钥「${item.label}」${onlyCredential ? "是当前供应商唯一的密钥，" : ""}取消 ${agentLabel(agent)} 适用后，该 Agent 在当前供应商将没有可用密钥，当前供应商将自动取消该 Agent 的接入，并联动取消全部模型对该 Agent 的适用与默认链；该 Agent 的 CLI 配置将移除当前供应商的关联模型。确认执行吗？`});
        if (!confirmed) return;
        continue;
      }
      if (isDefaultCredential) {
        const confirmed = await confirmDialog({title: "调整密钥适用", message: `当前密钥「${item.label}」是 ${agentLabel(agent)} 的默认密钥，如果勾掉该 Agent 适用，则 ${agentLabel(agent)} 的默认密钥会自动切换为其他适用密钥（无则取消），确认执行吗？`});
        if (!confirmed) return;
      }
    }
    setError("");
    try {
      // 立即独立保存适用变更（不等待「保存修改」）。
      await onUpdate({credentialId: item.id, agentScope: nextScope});
      setScope(nextScope);
      // 支持度级联：供应商不再服务的 Agent 从模型适用与默认链中联动取消，并自动取消接入。
      const nextCredentials = credentials.map(credential => credential.id === item.id
        ? {...credential, agentScope: nextScope}
        : credential);
      await onCascadeSupport(target, credentials, target, nextCredentials);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存适用失败");
    }
  }
  async function saveAll() {
    setError("");
    try {
      // 名称/内容/倍率由「保存修改」单独提交；适用已在下拉「确认修改」时即时保存。
      await onUpdate({credentialId: item.id, label, rateMultiplier: Number(rate) || 1, ...(secret ? {secret} : {})});
      setSecret("");
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存密钥失败");
    }
  }
  return <article className={styles.credentialRow}><div><strong>{item.label}{item.kind === "oauth" ? <span className={styles.oauthBadge}>OAuth</span> : <span className={styles.apiKeyBadge}>API Key</span>}{defaultAgents.length > 0 ? <span className={styles.defaultBadge}>{defaultAgents.map(agentLabel).join("、")} 默认</span> : null}</strong><span>密钥指纹 {formatCredentialFingerprint(item.fingerprintSuffix)}<SecretRevealChip kind="credential" targetId={target.id} credentialId={item.id} masked={formatCredentialFingerprint(item.fingerprintSuffix)} showMasked={false} label={`复制 ${item.label} 明文`} /></span><small>价格倍率 {item.rateMultiplier ?? 1} · 适用 {formatAgentScope(visibleScope)}</small>{item.kind === "oauth" && oauthStatusMessage ? <small className={oauthExpired ? styles.oauthExpired : styles.oauthHint}>{oauthStatusMessage}</small> : null}</div><div className={styles.inlineActions}><button type="button" className={styles.textButton} onClick={() => setEditing(value => !value)}>编辑</button><button type="button" className={styles.iconButtonSmall} onClick={() => void onDelete(item.id)} aria-label={`删除 ${item.label}`}><Trash2 size={15} /></button></div>{editing ? <div className={styles.credentialEditor}><input aria-label="密钥名称" value={label} onChange={event => setLabel(event.currentTarget.value)} /><input aria-label="替换密钥，可留空" type="password" value={secret} onChange={event => setSecret(event.currentTarget.value)} placeholder="替换密钥，可留空" /><input aria-label="价格倍率" inputMode="decimal" className={styles.credentialRateInput} value={rate} onChange={event => setRate(event.currentTarget.value)} /><AgentScopePicker value={visibleScope} options={scopeOptions} onConfirm={scope => void commitScope(scope)} /><button type="button" className={styles.primaryButton} onClick={() => void saveAll()}>保存修改</button>{error ? <p className={styles.errorText} role="alert">{error}</p> : null}</div> : null}</article>;
}

/** 适用展示：显式列出勾选的 Agent；未选择任何 Agent 时如实标注。 */
function formatAgentScope(scope?: string[]): string {
  if (scope?.length) return scope.map(id => agentLabel(id as AgentId)).join("、");
  return "未选择任何 Agent";
}

/** wire API 协议展示标签：与网关/模型目录的协议命名保持一致。 */
function wireApiProtocolLabel(wireApis: string[]): string {
  const labels: Record<string, string> = {
    responses: "Responses",
    chat_completions: "Chat Completions",
    messages: "Messages",
  };
  return wireApis.map(api => labels[api] || api).join(" / ");
}

/** 适用选项配色与全局 Agent 注册表一致，便于按颜色区分各 Agent。 */
function agentScopeColor(id: AgentId): "codex" | "claude" | "opencode" | "dsh" | "zcode" {
  return id === "codex" ? "codex" : id === "claude" ? "claude" : id === "opencode" ? "opencode" : id === "zcode" ? "zcode" : "dsh";
}
function rateDraft(pricing?: ProxyTargetPricingRates) {return {
  input: pricing?.input === undefined ? "" : String(pricing.input),
  cachedInput: pricing?.cachedInput === undefined ? "" : String(pricing.cachedInput),
  output: pricing?.output === undefined ? "" : String(pricing.output),
  longContextThreshold: pricing?.longContext ? String(pricing.longContext.thresholdTokens) : "",
  longContextInput: pricing?.longContext ? String(pricing.longContext.inputMultiplier) : "",
  longContextOutput: pricing?.longContext ? String(pricing.longContext.outputMultiplier) : "",
};}
type RateDraft = ReturnType<typeof rateDraft>;
/** 峰谷模型计费覆盖默认带入价格中心的闲时费率；已有覆盖则带覆盖值。 */
function offPeakRateDraft(entry?: ModelPriceEntry, override?: ProxyTargetModelPricingOverride): RateDraft | undefined {
  const schedule = override?.priceSchedules?.[0] ?? entry?.priceSchedules?.[0];
  return schedule ? rateDraft(schedule.rates) : undefined;
}
/** 把编辑后的闲时费率写回价格中心的时段窗口定义；无窗口或费率不完整时返回 undefined。 */
function buildOverrideSchedules(schedules: TemporalPriceSchedule[], offPeakRates: RateDraft | undefined): TemporalPriceSchedule[] | undefined {
  const rates = offPeakRates ? parseRates(offPeakRates) : undefined;
  if (!rates) return undefined;
  return schedules.map(schedule => ({...schedule, rates}));
}
function parseRates(value: ReturnType<typeof rateDraft>): ProxyTargetPricingRates | undefined {
  const input = Number(value.input);
  const output = Number(value.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const cachedInput = value.cachedInput.trim() ? Number(value.cachedInput) : undefined;
  // 长上下文档位：三格全填且为有限正数才生效；部分填写视为非法输入。
  const t = value.longContextThreshold.trim() ? Number(value.longContextThreshold) : undefined;
  const im = value.longContextInput.trim() ? Number(value.longContextInput) : undefined;
  const om = value.longContextOutput.trim() ? Number(value.longContextOutput) : undefined;
  const hasAny = t !== undefined || im !== undefined || om !== undefined;
  if (hasAny && (t === undefined || im === undefined || om === undefined)) return undefined;
  if (hasAny && (t! <= 0 || im! <= 0 || om! <= 0)) return undefined;
  return {
    input, output,
    ...(Number.isFinite(cachedInput) ? {cachedInput} : {}),
    ...(hasAny ? {longContext: {thresholdTokens: t!, inputMultiplier: im!, outputMultiplier: om!}} : {}),
  };
}
/** 价格展示（2026-10-08 用户确认）：仅按原币种标注 $/￥ 展示，不附人民币等值。 */
function formatRates(pricing?: {input: number; output: number; cachedInput?: number; longContext?: {thresholdTokens: number; inputMultiplier: number; outputMultiplier: number}}, currency?: string) {
  if (!pricing) return "—";
  const money = (value: number | undefined) => formatOriginalPrice(value, currency);
  return `非缓存输入 ${money(pricing.input)} · 缓存输入 ${pricing.cachedInput === undefined ? "—" : money(pricing.cachedInput)} · 输出 ${money(pricing.output)}${pricing.longContext ? ` · 长上下文>${(pricing.longContext.thresholdTokens / 1000).toFixed(0)}K 输入×${pricing.longContext.inputMultiplier}/输出×${pricing.longContext.outputMultiplier}` : ""}`;
}
/** 覆盖展示：带峰谷时展示高峰/闲时两组价格，否则保持固定覆盖文案；币种跟随条目实际生效币种。 */
function formatOverrideRates(override: ProxyTargetModelPricingOverride, currency?: string): string {
  return override.priceSchedules?.length
    ? schedulePricingText(override.pricing, override.priceSchedules, {currency}) || formatRates(override.pricing, currency)
    : formatRates(override.pricing, currency);
}
