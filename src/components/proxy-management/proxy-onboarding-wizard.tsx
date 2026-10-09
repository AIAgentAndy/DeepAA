"use client";

import {Check, RefreshCw, X} from "lucide-react";
import {useEffect, useMemo, useRef, useState} from "react";
import {SearchableSelect} from "@/components/searchable-select";
import {AGENT_CATALOG, agentLabel, isAgentConnected, protocolAgentsForTarget, resolveTargetAgentCapability, targetSupportsAgent, wireApiCompatibleModelsForTarget} from "@/components/proxy-management/agent-catalog";
import {availableWireApisForAgent, resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {subscriptionWizardNotice} from "@/lib/subscription-display";
import {agentBindings} from "@/lib/agent-registry";
import {nextCredentialLabel} from "@/lib/proxy-management-domain";
import {ModelDiscoveryTable} from "./model-discovery-table";
import {usePricingCatalogPicker} from "./use-pricing-catalog-picker";
import {ZcodeLocalImportHint} from "./zcode-local-import-hint";
import type {ModelPriceEntry} from "@/lib/pricing";
import type {CredentialItem, ModelDiscoverResponse} from "./proxy-management-types";
import type {AgentId, ProxyConfig, ProxyTarget} from "@/types";
import {agentScopeIncludes} from "@/types";
import styles from "./proxy-management.module.css";

export type OnboardingStep = "credentials" | "discover" | "agent";

export const ONBOARDING_STEPS: ReadonlyArray<{id: OnboardingStep; label: string}> = [
  {id: "credentials", label: "API密钥"},
  {id: "discover", label: "模型发现与确认"},
  {id: "agent", label: "接入 Agent 并完成配置"},
];

export function isOfficialPresetTarget(target: Pick<ProxyTarget, "presetId" | "openaiUrl" | "anthropicUrl">): boolean {
  return Boolean(target.presetId || resolveOfficialPresetForTarget(target));
}

export function onboardingStepsForTarget(target: Pick<ProxyTarget, "presetId" | "billingChannel" | "openaiUrl" | "anthropicUrl">): ReadonlyArray<{id: OnboardingStep; label: string}> {
  if (target.billingChannel === "subscription") {
    return [{id: "agent", label: "接入 Agent 并完成配置"}];
  }
  return isOfficialPresetTarget(target) ? ONBOARDING_STEPS.filter(item => item.id !== "discover") : ONBOARDING_STEPS;
}

interface ProxyOnboardingWizardProps {
  target: ProxyTarget;
  config: ProxyConfig;
  credentials: CredentialItem[];
  pricingModels: ModelPriceEntry[];
  busy: boolean;
  initialStep: OnboardingStep;
  initialAgents?: AgentId[];
  /** 新建供应商为 true：即使同路由 ID 存在历史缓存，也不能跳过本次密钥录入。 */
  requireCredentialEntry?: boolean;
  onDiscoverModels: (credentialId?: string) => Promise<ModelDiscoverResponse>;
  onConfirmDiscoveredModels: (credentialId: string, selectedModelIds: string[]) => Promise<ModelDiscoverResponse>;
  onSaveTargetPatch: (patch: Partial<ProxyTarget>, successMessage?: string) => Promise<void>;
  onCreateCredential: (input: {label: string; secret: string; rateMultiplier: number; agentScope?: string[]}) => Promise<string | undefined>;
  /** 向导结束时把本次新建密钥的适用同步为最终勾选的 Agent。 */
  onUpdateCredentialScope: (credentialId: string, agents: AgentId[]) => Promise<void>;
  onConnectAgent: (agent: AgentId) => Promise<void>;
  onSyncCli: () => Promise<void>;
  onClose: () => void;
  onDone: (message: string) => void;
}

/**
 * 向导只处理最小闭环：保存首个密钥、自动探测/确认模型、选择 Agent。
 * 默认密钥、默认模型和首次默认代理供应商由服务端规则自动补齐，详细编辑留在其它页签。
 */
export function ProxyOnboardingWizard({
  target,
  config,
  credentials,
  pricingModels,
  busy,
  initialStep,
  initialAgents,
  requireCredentialEntry = false,
  onDiscoverModels,
  onConfirmDiscoveredModels,
  onSaveTargetPatch,
  onCreateCredential,
  onConnectAgent,
  onSyncCli,
  onClose,
  onDone,
  onUpdateCredentialScope,
}: ProxyOnboardingWizardProps) {
  const steps = onboardingStepsForTarget(target);
  const officialPreset = isOfficialPresetTarget(target);
  // 价格中心选择默认按当前供应商过滤（2026-10-07 用户确认，与「密钥与模型」页签同口径）：
  // 官方预设 vendor 优先，其次目标显式 vendor；解析不到不预过滤。
  const pricingVendorFilter = resolveOfficialPresetForTarget(target)?.vendor ?? target.pricing?.vendor ?? "";
  // 可接入 Agent 需要「协议支持 ∩ 至少一个 wire 兼容模型（不要求已标记适用）」；
  // 协议不满足或无兼容模型的 Agent 仍置灰展示并说明原因，避免用户误以为缺失选项是 bug。
  // wire 兼容判定让「主动取消适用后模型适用被级联清空」的 Agent 仍可重新接入并补齐适用。
  const availableAgents = AGENT_CATALOG.filter(entry => {
    if (!resolveTargetAgentCapability(target, entry.id).supported) return false;
    return wireApiCompatibleModelsForTarget(target, entry.id).length > 0;
  });
  const [step, setStep] = useState<OnboardingStep>(() =>
    steps.some(item => item.id === initialStep) ? initialStep : steps[0]!.id,
  );
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>(() => (initialAgents || deriveOnboardingAgents(target, credentials, config))
    .filter(id => availableAgents.some(entry => entry.id === id)));
  // 首个密钥名称默认跟随当前代理供应商，避免不同供应商都出现同一写死占位名。
  const [credDraft, setCredDraft] = useState(() => ({
    label: nextCredentialLabel(target.name || target.id || "供应商",
      credentials.filter(item => item.targetId === target.id).map(item => item.label)),
    secret: "",
    rate: "1",
  }));
  // 密钥适用不在此处选择：finish 时按最终接入的 Agent 写入，之后可在「密钥与模型」页签调整。
  const [createdCredentialId, setCreatedCredentialId] = useState<string>();
  /** 完成阶段的动态进度：按环节逐个打勾，避免串行创建过程被误认为卡死。 */
  const [finishProgress, setFinishProgress] = useState<Array<{key: string; label: string; state: "pending" | "running" | "done"}>>([]);
  const [savingCredential, setSavingCredential] = useState(false);
  const [discoverState, setDiscoverState] = useState<"idle" | "probing" | "ready" | "empty" | "failed">("idle");
  const [discoverResult, setDiscoverResult] = useState<ModelDiscoverResponse | null>(null);
  const [selectedDiscoveredModels, setSelectedDiscoveredModels] = useState<string[]>([]);
  // 价格中心选择默认按当前供应商过滤（2026-10-07 用户确认，与「密钥与模型」页签同口径）。
  const [pricingVendorOnly, setPricingVendorOnly] = useState(true);
  // 选择器专用取数（2026-10-07 修复：服务端 vendor/search + 100/页分页；共享 pricingModels
  // 是 limit=200 截断列表，客户端按 vendor 过滤会滤空排在 200 名开外的供应商条目）。
  const pricingPicker = usePricingCatalogPicker({
    vendor: pricingVendorOnly && pricingVendorFilter ? pricingVendorFilter : undefined,
    supportedModels: target.supportedModels,
    modelVendors: target.pricing?.modelVendors,
  });
  const [savingModel, setSavingModel] = useState(false);
  // 本次会话从价格中心挑选并已保存进支持列表的模型：先收集展示、用户确认后才进入下一步。
  const [pickedCatalogModels, setPickedCatalogModels] = useState<string[]>([]);
  // 本次接入的模型关联范围（2026-10-07 用户确认，取代「全部兼容模型自动并集」）：
  // null = 未手动调整（跟随默认集）；默认集与完成阶段「初始化默认模型」同一套判定——
  // 各所选 Agent 的默认模型（显式默认优先，否则兼容交集第一位，再退该 Agent 首个兼容模型）
  // ∪ 本次会话从价格中心挑选的模型。
  const [associateModelOverride, setAssociateModelOverride] = useState<string[] | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  const discoverKeyRef = useRef("");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 已完整接入当前供应商的 Agent（接入关系存在 + 链路完整：协议/适用模型/适用密钥齐备）：
  // 向导中置灰不可取消，避免误操作；链路不完整的（如缺适用密钥）仍可勾选补齐。
  const connectedAgentIds = new Set(AGENT_CATALOG
    .filter(entry => {
      const connection = config.agentConnections[entry.id];
      const bound = connection?.enabled !== false
        && (connection?.boundTargetIds?.includes(target.id) || connection?.defaultTargetId === target.id);
      return bound && targetSupportsAgent(target, entry.id, credentials);
    })
    .map(entry => entry.id));
  // 存在「未完整接入」的可勾选 Agent 时，启用按钮才有意义；全部已接入时禁用并提示。
  const hasActionableAgent = availableAgents.some(entry => !connectedAgentIds.has(entry.id));

  /** 默认关联集：各所选 Agent 的默认模型 ∪ 本次会话新选模型（见 associateModelOverride 注释）。 */
  const defaultAssociateModelIds = useMemo(() => {
    const ids = new Set<string>(pickedCatalogModels);
    const compatibleByAgent = selectedAgents.map(agent => ({agent, models: wireApiCompatibleModelsForTarget(target, agent)}));
    const commonModel = compatibleByAgent.length > 0
      ? compatibleByAgent.map(item => item.models).reduce((intersection: string[], models: string[]) => intersection.filter(id => models.includes(id)))[0]
      : undefined;
    for (const {agent, models} of compatibleByAgent) {
      const explicit = target.development?.defaultModels?.[agent];
      if (explicit && models.includes(explicit)) {
        ids.add(explicit);
        continue;
      }
      const eligible = commonModel !== undefined && models.includes(commonModel) ? commonModel : models[0];
      if (eligible) ids.add(eligible);
    }
    return [...ids];
  }, [pickedCatalogModels, selectedAgents, target]);
  const associateModelIds = associateModelOverride ?? defaultAssociateModelIds;
  // 可关联模型 = 与任一所选 Agent wire 兼容的目标模型（已完整接入的 Agent 不在 selectedAgents 内，不参与）。
  const associateModelOptions = target.supportedModels
    .filter(modelId => selectedAgents.some(agent => wireApiCompatibleModelsForTarget(target, agent).includes(modelId)));

  const targetCredentials = credentials.filter(item => item.targetId === target.id);
  const defaultCredentialId = selectedAgents
    .map(agent => target.development?.defaultCredentials?.[agent])
    .find((id): id is string => Boolean(id) && targetCredentials.some(item => item.id === id))
    || targetCredentials[0]?.id;
  // 模型发现密钥：多密钥时允许用户切换（默认取所选 Agent 默认密钥，其次第一条）；
  // 单密钥保持自动探测，不渲染下拉。切换后按新密钥自动重探。
  const [discoverCredentialOverride, setDiscoverCredentialOverride] = useState<string>();
  const discoverCredentialId = discoverCredentialOverride
    && targetCredentials.some(item => item.id === discoverCredentialOverride)
    ? discoverCredentialOverride
    : defaultCredentialId;
  const canAdvanceAgent = selectedAgents.length > 0 && target.supportedModels.length > 0;
  // 已有与本次目标 Agent wire 兼容的模型时，模型探测步骤可跳过：直接进入接入配置，
  // 完成阶段会自动把兼容模型与默认密钥的归属合并进所选 Agent（如 gpt-5.6-sol 接 opencode）。
  const skipDiscoveryAgents = step === "discover"
    ? (initialAgents || []).filter(agent => wireApiCompatibleModelsForTarget(target, agent).length > 0)
    : [];
  const canSkipDiscovery = skipDiscoveryAgents.length > 0 && target.supportedModels.length > 0;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 恢复已有供应商时，异步凭据加载完成后可自动进入下一必要步骤；
  // 新建供应商必须等待用户明确保存本次首个密钥，不能复用历史同 ID 缓存。
  useEffect(() => {
    if (!requireCredentialEntry && step === "credentials" && targetCredentials.length > 0) {
      const next = steps.find(item => item.id !== "credentials");
      if (next) setStep(next.id);
    }
  }, [requireCredentialEntry, step, targetCredentials.length, steps]);

  // 自定义供应商进入模型发现后立即自动探测；单密钥自动选择，多密钥默认取默认密钥并允许切换。
  useEffect(() => {
    if (step !== "discover" || officialPreset || !discoverCredentialId) return;
    const requestKey = `${target.id}:${discoverCredentialId}`;
    if (discoverKeyRef.current === requestKey) return;
    discoverKeyRef.current = requestKey;
    setDiscoverState("probing");
    setError("");
    void onDiscoverModels(discoverCredentialId).then(result => {
      setDiscoverResult(result);
      // 默认不勾选任何模型：由用户显式选择预期要使用的模型，至少选一个才能继续；
      // 本密钥未返回的既有模型由服务端在确认时自动保留，不会互相覆盖。
      const candidateCount = (result.matched?.length || 0) + (result.removed?.length || 0);
      setSelectedDiscoveredModels([]);
      setDiscoverState(candidateCount > 0 ? "ready" : "empty");
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : "模型发现失败");
      setDiscoverState("failed");
    });
  }, [discoverCredentialId, officialPreset, onDiscoverModels, step, target.id]);

  async function saveFirstCredential() {
    if (savingCredential) return;
    if (!credDraft.label.trim() || !credDraft.secret) {
      setError("请填写密钥名称和密钥内容");
      return;
    }
    setSavingCredential(true);
    setError("");
    try {
      const credentialId = await onCreateCredential({label: credDraft.label.trim(), secret: credDraft.secret, rateMultiplier: Number(credDraft.rate) || 1});
      if (credentialId) setCreatedCredentialId(credentialId);
      setCredDraft({label: "", secret: "", rate: "1"});
      const next = steps.find(item => item.id !== "credentials");
      if (next) setStep(next.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存密钥失败");
    } finally {
      setSavingCredential(false);
    }
  }

  async function confirmDiscoveredModels() {
    if (!discoverCredentialId || selectedDiscoveredModels.length === 0) {
      setError("请从价格中心选择至少一个有唯一价格映射的模型");
      return;
    }
    if ((discoverResult?.unpriced || []).some(item => selectedDiscoveredModels.includes(item.modelId))) {
      setError("未定价或供应商歧义模型不能加入 Agent 可见模型，请先从价格中心补充");
      return;
    }
    setError("");
    try {
      await onConfirmDiscoveredModels(discoverCredentialId, selectedDiscoveredModels);
      setStep("agent");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认模型失败");
    }
  }

  function toggleDiscoveredModel(modelId: string, checked: boolean) {
    setSelectedDiscoveredModels(current => checked
      ? [...new Set([...current, modelId])]
      : current.filter(id => id !== modelId));
  }

  /** 全选/全不选：仅作用于可选择行（matched + removed）。 */
  function toggleAllDiscoveredModels(checked: boolean) {
    if (!discoverResult) return;
    // 全选仅作用 matched（removed 行固定保留，不参与勾选）
    const selectable = (discoverResult.matched || []).map(item => item.modelId);
    setSelectedDiscoveredModels(checked ? selectable : []);
  }

  /** 收起探测结果并清空勾选；再次探测会重新生成。 */
  function collapseDiscovery() {
    setSelectedDiscoveredModels([]);
    setDiscoverState("idle");
    setDiscoverResult(null);
  }

  async function addCatalogModel(entry: ModelPriceEntry) {
    if (savingModel) return;
    const runtimeModelId = entry.runtimeModelId || entry.match || entry.patterns[0] || entry.id;
    if (!runtimeModelId || target.supportedModels.includes(runtimeModelId)) return;
    setSavingModel(true);
    setError("");
    try {
      const scopes = selectedAgents.length > 0 ? selectedAgents : protocolAgentsForTarget(target);
      const nextScopes = {...target.supportedModelScopes};
      if (scopes.length === AGENT_CATALOG.length) delete nextScopes[runtimeModelId];
      else nextScopes[runtimeModelId] = scopes;
      await onSaveTargetPatch({
        supportedModels: [...target.supportedModels, runtimeModelId],
        supportedModelScopes: Object.keys(nextScopes).length > 0 ? nextScopes : undefined,
        pricing: {...target.pricing, modelVendors: {...target.pricing?.modelVendors, [runtimeModelId]: {
          vendor: entry.vendor || entry.litellmProvider,
          priceEntryId: entry.id,
        }}},
      }, `已添加模型 ${runtimeModelId}`);
      // 不自动跳步：模型先进入已选列表，由用户确认后再进入接入 Agent 步骤。
      setPickedCatalogModels(current => current.includes(runtimeModelId) ? current : [...current, runtimeModelId]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加模型失败");
    } finally {
      setSavingModel(false);
    }
  }

  /** 从已选列表移除价格中心模型：联动清理支持列表、模型适用与价格映射。 */
  /**
   * 已选模型的「价格中心供应商」标注：模型 + 供应商才唯一，只显示模型名会让用户
   * 分不清同名模型属于哪个供应商（2026-09-18 用户确认）。
   * 真相优先取目标自己的价格映射（`pricing.modelVendors`，与计价同源、随配置持久化），
   * 其次回退到本次会话在价格中心列表里见过的条目。
   */
  function catalogVendorFor(runtimeModelId: string): string | undefined {
    const mapped = target.pricing?.modelVendors?.[runtimeModelId];
    if (mapped?.vendor) return mapped.vendor;
    const entry = pricingModels.find(item => (
      (item.runtimeModelId || item.match || item.patterns[0] || item.id) === runtimeModelId
    ));
    return entry?.vendor || entry?.litellmProvider || undefined;
  }

  async function removeCatalogModel(runtimeModelId: string) {
    if (savingModel) return;
    setSavingModel(true);
    setError("");
    try {
      const nextScopes = {...target.supportedModelScopes};
      delete nextScopes[runtimeModelId];
      const nextVendors = {...(target.pricing?.modelVendors || {})};
      delete nextVendors[runtimeModelId];
      await onSaveTargetPatch({
        supportedModels: target.supportedModels.filter(id => id !== runtimeModelId),
        supportedModelScopes: Object.keys(nextScopes).length > 0 ? nextScopes : undefined,
        pricing: {...target.pricing, modelVendors: nextVendors},
      }, `已移除模型 ${runtimeModelId}`);
      setPickedCatalogModels(current => current.filter(id => id !== runtimeModelId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移除模型失败");
    } finally {
      setSavingModel(false);
    }
  }

  /** 模型确认统一入口：自动探测勾选与价格中心挑选都就绪时一起确认并进入下一步。 */
  async function confirmDiscoveryStep() {
    if (discoverState === "ready" && selectedDiscoveredModels.length > 0) {
      await confirmDiscoveredModels();
      return;
    }
    if (pickedCatalogModels.length > 0) setStep("agent");
  }

  async function finishEnable() {
    if (finishing || selectedAgents.length === 0 || !canAdvanceAgent) {
      setError(selectedAgents.length === 0 ? "请至少选择一个 Agent" : "请先完成模型确认");
      return;
    }
    setFinishing(true);
    setError("");
    // 完成过程环节清单：每个环节完成打勾，让用户看到进度而不是误以为卡死。
    const progressSteps: Array<{key: string; label: string}> = [];
    // 模型适用与本次接入的 Agent 对齐（2026-10-07 用户确认修订）：
    // - 已记录适用的模型只在「本次关联模型」勾选集（默认 = 各所选 Agent 的默认模型 ∪ 本次
    //   会话新选模型）内合并新接入的 Agent，不再全量并集——避免 Agent 模型列表被灌入供应商
    //   全部模型；未勾选模型保持原适用不变。
    // - 未记录适用的模型仍按既有语义收紧到所选 Agent（AGENTS.md 2026-09-08），避免
    //   “只接入 Codex”后模型仍对其它 Agent 开放。
    // 使用 wire 兼容模型（不要求已标记适用），让「主动取消适用后适用被清空」的 Agent 也能重新合并。
    const compatibleAgentsByModel = new Map<string, string[]>();
    for (const agent of selectedAgents) {
      compatibleAgentsByModel.set(agent, wireApiCompatibleModelsForTarget(target, agent));
    }
    const associateModelSet = new Set(associateModelIds);
    const needScopeMerge = selectedAgents.length < AGENT_CATALOG.length
      && target.supportedModels.some(modelId => selectedAgents.some(agent => compatibleAgentsByModel.get(agent)?.includes(modelId)));
    const needCredentialScopeSync = Boolean(createdCredentialId);
    // 密钥适用补齐计划：本次接入的 Agent 中，目标下尚无适用密钥的，把默认密钥（或第一条
    // 目标密钥）的适用合并入该 Agent——否则接入后 targetSupportsAgent 因缺适用密钥而不满足，
    // 已接入列表不会显示（表现为「接入后又被干掉」）。订阅通道免系统密钥，跳过补齐。
    const targetCreds = targetCredentials;
    const defaultCredentialItem = targetCreds.find(item => item.id === defaultCredentialId) || targetCreds[0];
    const credentialBackfill = new Map<AgentId, string>();
    if (target.billingChannel !== "subscription") {
      for (const agent of selectedAgents) {
        const hasCredential = targetCreds.some(item => agentScopeIncludes(item.agentScope, agent));
        if (!hasCredential && defaultCredentialItem) credentialBackfill.set(agent, defaultCredentialItem.id);
      }
    }
    const needCredentialBackfill = credentialBackfill.size > 0;
    if (needScopeMerge) progressSteps.push({key: "scopes", label: "调整模型适用"});
    for (const agent of selectedAgents) progressSteps.push({key: `connect:${agent}`, label: `接入 ${agentLabel(agent)}`});
    if (needCredentialScopeSync || needCredentialBackfill) progressSteps.push({key: "credential", label: "补齐密钥适用"});
    progressSteps.push({key: "defaults", label: "初始化默认模型与密钥"});
    progressSteps.push({key: "cli", label: "同步 CLI 配置"});
    // 启用供应商作为最后收尾：前面的接入/默认链都完成后才真正启用供应商。
    progressSteps.push({key: "enable", label: "启用供应商"});
    setFinishProgress(progressSteps.map(step => ({...step, state: "pending" as const})));
    try {
      const runStep = async (key: string, action: () => Promise<void>) => {
        setFinishProgress(current => current.map(step => step.key === key ? {...step, state: "running" as const} : step));
        await action();
        setFinishProgress(current => current.map(step => step.key === key ? {...step, state: "done" as const} : step));
      };
      if (needScopeMerge) {
        await runStep("scopes", async () => {
          const nextScopes = {...target.supportedModelScopes};
          let changed = false;
          for (const modelId of target.supportedModels) {
            const compatibleAgents = selectedAgents.filter(agent => compatibleAgentsByModel.get(agent)?.includes(modelId));
            if (compatibleAgents.length === 0) continue;
            // 已记录适用且不在「本次关联模型」勾选集内的模型：保持原适用，不并入新 Agent。
            const hasRecordedScope = Array.isArray(target.supportedModelScopes?.[modelId]);
            if (hasRecordedScope && !associateModelSet.has(modelId)) continue;
            const current = nextScopes[modelId] || [];
            const merged = [...new Set([...current, ...compatibleAgents])];
            if (merged.length !== current.length || merged.some(id => !current.includes(id))) {
              nextScopes[modelId] = merged;
              changed = true;
            }
          }
          if (changed) await onSaveTargetPatch({supportedModelScopes: nextScopes});
        });
      }
      for (const agent of selectedAgents) {
        await runStep(`connect:${agent}`, async () => {
          // 接入需要供应商已启用（服务端 connect 校验并隐式设置默认供应商），
          // 因此先静默启用，不占用独立进度节点。
          if (!target.enabled) await onSaveTargetPatch({enabled: true});
          await onConnectAgent(agent);
        });
      }
      if (needCredentialScopeSync || needCredentialBackfill) {
        await runStep("credential", async () => {
          // 新建密钥：适用跟随最终接入的 Agent（新建时未选适用）。
          if (needCredentialScopeSync) {
            await onUpdateCredentialScope(createdCredentialId!, selectedAgents);
          }
          // 已有密钥：按密钥分组，把缺失适用的 Agent 合并进默认/第一条目标密钥的适用。
          const byCredential = new Map<string, AgentId[]>();
          for (const [agent, credentialId] of credentialBackfill) {
            byCredential.set(credentialId, [...(byCredential.get(credentialId) || []), agent]);
          }
          for (const [credentialId, agents] of byCredential) {
            const item = targetCreds.find(candidate => candidate.id === credentialId);
            if (!item) continue;
            const merged = [...new Set([...(item.agentScope || []), ...agents])] as AgentId[];
            await onUpdateCredentialScope(credentialId, merged);
          }
        });
      }
      await runStep("defaults", async () => {
        // 默认模型/默认密钥交集初始化：所有接入 Agent 共用「支持全部接入 Agent」的第一个；
        // 模型交集为空时退化为该 Agent 自己的第一个兼容模型，已有显式默认值不覆盖。
        const development = {...(target.development || {})};
        const defaultModels = {...(development.defaultModels || {})};
        const defaultCredentials = {...(development.defaultCredentials || {})};
        const compatibleByAgent = new Map<string, string[]>();
        for (const agent of selectedAgents) compatibleByAgent.set(agent, wireApiCompatibleModelsForTarget(target, agent));
        const compatibleLists = [...compatibleByAgent.values()];
        const commonModel = compatibleLists.length > 0
          ? compatibleLists.reduce((intersection, models) => intersection.filter(id => models.includes(id)))[0]
          : undefined;
        let defaultsChanged = false;
        for (const agent of selectedAgents) {
          if (defaultModels[agent] === undefined) {
            const eligible = commonModel ?? compatibleByAgent.get(agent)?.[0];
            if (eligible) {
              defaultModels[agent] = eligible;
              defaultsChanged = true;
            }
          }
          if (defaultCredentials[agent] === undefined) {
            // 新建密钥优先作为默认密钥；否则取现有适用密钥，或本次刚补齐适用的密钥。
            const eligibleCredential = createdCredentialId
              ? targetCreds.find(item => item.id === createdCredentialId)
              : (targetCreds.find(item => agentScopeIncludes(item.agentScope, agent))
                ?? (credentialBackfill.has(agent) ? targetCreds.find(item => item.id === credentialBackfill.get(agent)) : undefined));
            if (eligibleCredential) {
              defaultCredentials[agent] = eligibleCredential.id;
              defaultsChanged = true;
            }
          }
        }
        if (defaultsChanged) {
          await onSaveTargetPatch({
            development: {
              ...development,
              ...(Object.keys(defaultModels).length > 0 ? {defaultModels} : {}),
              ...(Object.keys(defaultCredentials).length > 0 ? {defaultCredentials} : {}),
            },
          });
        }
      });
      await runStep("cli", () => onSyncCli());
      await runStep("enable", async () => {
        // 最后收尾：确保供应商启用（前面的接入步骤可能已静默启用，这里幂等确认）。
        if (!target.enabled) await onSaveTargetPatch({enabled: true});
      });
      onDone(`供应商「${target.name}」已启用，已接入 ${selectedAgents.map(agentLabel).join("、")}。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "启用失败");
    } finally {
      setFinishing(false);
      setFinishProgress([]);
    }
  }

  const currentIndex = steps.findIndex(item => item.id === step);
  return <div className={styles.wizardBackdrop} role="presentation" onMouseDown={event => {if (event.currentTarget === event.target) onClose();}}>
    <section className={styles.wizard} role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <header className={styles.wizardHeader}><div><h2 id="onboarding-title">向导：完成供应商「{target.name || target.id}」基础配置</h2>{target.billingChannel === "subscription" ? <p>一步完成：接入 Agent。推理凭据由本机 Codex / Claude CLI 登录透传，无需保存系统密钥。</p> : null}</div><button type="button" className={styles.iconButton} onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <ol className={styles.wizardSteps}>{steps.map((item, index) => <li key={item.id} className={`${styles.wizardStep} ${item.id === step ? styles.wizardStepActive : ""} ${item.id !== step && currentIndex > index ? styles.wizardStepDone : ""}`}><span className={styles.wizardStepIndex}>{item.id !== step && currentIndex > index ? <Check size={13} /> : index + 1}</span><span>{item.label}</span></li>)}</ol>
      <div className={styles.wizardBody}>
        {finishing ? <div className={styles.wizardFinishHero} role="status" aria-live="polite">
          <div className={styles.wizardFinishHeroHead}>
            <span className={styles.wizardFinishHeroSpinner} aria-hidden="true" />
            <div><strong>正在完成创建…</strong><small>正在依次执行以下环节，全部完成后自动关闭。</small></div>
          </div>
          <ul className={styles.wizardFinishHeroSteps}>{finishProgress.map(step => <li key={step.key} className={`${styles.wizardFinishHeroStep} ${step.state === "running" ? styles.wizardFinishHeroStepRunning : ""} ${step.state === "done" ? styles.wizardFinishHeroStepDone : ""}`}><span>{step.state === "done" ? <Check size={14} /> : step.state === "running" ? <RefreshCw size={14} className={styles.wizardFinishSpin} /> : <span className={styles.wizardFinishPendingDot} />}</span>{step.label}</li>)}</ul>
        </div> : null}
        {!finishing && step === "credentials" ? <div className={styles.wizardStepPanel}><div className={styles.wizardStepTitle}>设置密钥</div><p className={styles.wizardStepDesc}>{officialPreset ? "API 密钥设置。官方预设按官方原价计费，倍率固定为 1；密钥适用与模型适用默认跟随后续接入的 Agent，也可在「密钥与模型」页签随时调整。" : "API密钥及价格倍率设置。密钥适用与模型适用默认跟随后续接入的 Agent，也可在「密钥与模型」页签随时调整。"}</p><form className={styles.credentialFormRow} onSubmit={event => {event.preventDefault(); void saveFirstCredential();}}><label className={styles.credentialField}><span>密钥名称</span><input required value={credDraft.label} onChange={event => setCredDraft({...credDraft, label: event.currentTarget.value})} placeholder="例如 供应商名-主密钥" /></label><label className={`${styles.credentialField} ${styles.credentialFieldWide}`}><span>密钥内容</span><input required type="password" autoComplete="off" value={credDraft.secret} onChange={event => setCredDraft({...credDraft, secret: event.currentTarget.value})} placeholder="sk-..." /></label>{!officialPreset ? <label className={styles.credentialRateField}><span>倍率</span><input inputMode="decimal" value={credDraft.rate} onChange={event => setCredDraft({...credDraft, rate: event.currentTarget.value})} /></label> : null}<button type="submit" className={styles.primaryButton} disabled={savingCredential || busy}>{savingCredential ? "保存中…" : "保存密钥并继续"}</button></form>{error ? <p className={styles.errorText} role="alert">{error}</p> : null}</div> : null}
        {!finishing && step === "discover" ? <div className={styles.wizardStepPanel}><div className={styles.wizardStepTitle}>选择预期要使用的模型</div><p className={styles.wizardStepDesc}>系统已按模型族映射到价格中心供应商，并要求精确匹配价格中心条目。默认不勾选，请至少选择一个预期要使用的模型后才能继续。</p>{canSkipDiscovery ? <p className={styles.wizardStepDesc}>已检测到与 {skipDiscoveryAgents.map(agentLabel).join("、")} 协议兼容的既有模型：如无需新增模型，可直接进入下一步完成接入。</p> : null}{!officialPreset && targetCredentials.length > 1 ? <label className={styles.field}><span>模型发现密钥</span><select value={discoverCredentialId || ""} onChange={event => setDiscoverCredentialOverride(event.currentTarget.value)}>{targetCredentials.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>供应商已保存多条密钥：探测与确认使用所选密钥；不同密钥可见的模型集合可能不同。</small></label> : null}{discoverState === "probing" ? <p className={styles.emptyCompact}><RefreshCw size={15} /> 正在自动探测上游模型…</p> : null}{discoverState === "failed" ? <p className={styles.wizardWarn}>自动探测失败：{error}。请直接从价格中心选择模型。</p> : null}{discoverState === "empty" ? <p className={styles.wizardWarn}>未发现可唯一匹配价格中心的模型，请直接从价格中心选择。</p> : null}{discoverResult ? <ModelDiscoveryTable result={discoverResult} selectedModelIds={selectedDiscoveredModels} onToggle={toggleDiscoveredModel} onToggleAll={toggleAllDiscoveredModels} /> : null}<div className={styles.addRow}><label className={`${styles.field} ${styles.modelPicker}`}><span>从价格中心选择模型（如是中转站，需要选择中转站对应原供应商（如：openai，anthropic）下的相关模型，以便准确计价）{pricingVendorFilter ? <label className={styles.pricingVendorToggle} title={`默认只显示当前供应商（${pricingVendorFilter}）的价格中心条目，避免误选其它供应商（如美元区同名模型）；取消后显示全部供应商。`}><input type="checkbox" checked={pricingVendorOnly} onChange={event => setPricingVendorOnly(event.currentTarget.checked)} />仅显示 {pricingVendorFilter}</label> : null}</span><SearchableSelect value="" options={pricingPicker.options} filterOptions={false} searchValue={pricingPicker.search} onSearchChange={pricingPicker.setSearch} onChange={value => {const entry = pricingPicker.findEntryById(value); if (entry) void addCatalogModel(entry);}} placeholder={pricingPicker.loading ? "价格中心加载中…" : "搜索并选择价格中心模型"} searchPlaceholder="搜索模型 ID" loading={pricingPicker.loading || pricingPicker.loadingMore || savingModel} belowSearch={pricingPicker.familyVendor ? <label className="searchable-select-accessory" title={`默认只展示 ${pricingPicker.familyVendor} 供应商的匹配条目；取消勾选后显示其它供应商的同名模型。`}><input type="checkbox" checked={pricingPicker.familyOnly} onChange={event => pricingPicker.setFamilyOnly(event.currentTarget.checked)} />仅显示 {pricingPicker.familyVendor}</label> : undefined} resultMessage={pricingPicker.total > 0 ? `共 ${pricingPicker.total} 条${pricingVendorOnly && pricingVendorFilter ? `（${pricingVendorFilter}）` : ""}，已加入 ${pricingPicker.addedCount} 条` : undefined} footerAction={pricingPicker.hasMore ? {label: `加载更多（${pricingPicker.entries.length}/${pricingPicker.total}）`, onClick: pricingPicker.loadMore, disabled: pricingPicker.loadingMore} : undefined} /></label></div>{pickedCatalogModels.length > 0 ? <div className={styles.wizardPickList} role="list" aria-label="已选择的价格中心模型"><span className={styles.wizardPickTitle}>已选择 {pickedCatalogModels.length} 个价格中心模型，确认后进入接入 Agent 步骤</span><ul>{pickedCatalogModels.map(modelId => <li key={modelId} role="listitem"><span className={styles.wizardPickModel}>{modelId}{catalogVendorFor(modelId) ? <span className={styles.wizardPickVendor}> · {catalogVendorFor(modelId)}</span> : null}</span><button type="button" className={styles.textButton} onClick={() => void removeCatalogModel(modelId)} disabled={savingModel || busy}>移除</button></li>)}</ul></div> : null}{error && discoverState !== "failed" ? <p className={styles.errorText} role="alert">{error}</p> : null}</div> : null}
        {!finishing && step === "agent" ? <div className={styles.wizardStepPanel}><div className={styles.wizardStepTitle}>选择要接入的 Agent</div>{target.billingChannel === "subscription" ? <p className={styles.wizardStepDesc}>{subscriptionWizardNotice(target)} 只选择本次需要接入的 Agent。</p> : null}<div className={styles.wizardAgentOptions}>{AGENT_CATALOG.map(entry => {const capability = resolveTargetAgentCapability(target, entry.id); const available = availableAgents.some(item => item.id === entry.id); const alreadyConnected = connectedAgentIds.has(entry.id); const checked = selectedAgents.includes(entry.id) || alreadyConnected; const unavailableReason = !available ? (capability.supported ? (target.supportedModels.length > 0 ? "当前供应商已选模型的协议与该 Agent 的网关入口不兼容：GPT / o 系列仅支持 Responses，Claude 系列仅支持 Messages；请补充对应家族的模型后再接入" : "当前供应商没有与该 Agent 协议兼容的模型，可在「密钥与模型」添加支持模型后接入") : (capability.message || `当前供应商未配置 ${entry.defaultBinding.protocol === "openai" ? "OpenAI" : "Anthropic"} 协议上游 URL，暂不可选`)) : ""; return <label key={entry.id} className={`${styles.wizardAgentOption} ${!available ? styles.wizardAgentOptionDisabled : ""} ${checked ? styles.wizardAgentOptionChecked : ""}`}><input type="checkbox" disabled={!available || alreadyConnected} checked={checked} onChange={() => setSelectedAgents(current => checked ? current.filter(id => id !== entry.id) : [...current, entry.id])} /><span><strong>{entry.label}</strong><small>{available ? (alreadyConnected ? `已接入 · 网关入口 ${compatibleGatewayPaths(target, entry)}` : `网关入口 ${compatibleGatewayPaths(target, entry)}`) : unavailableReason}</small></span></label>;})}</div>{associateModelOptions.length > 0 ? <div className={styles.wizardAssociateBlock}><p className={styles.wizardStepDesc}><strong>本次关联模型</strong>：本次仅把所选 Agent 关联到勾选的模型（默认为其默认模型{pickedCatalogModels.length > 0 ? "与本次新选模型" : ""}），其余模型保持原适用不变；可稍后在「密钥与模型」页签为其它模型补加适用。</p><div className={styles.wizardAssociateOptions}><label className={styles.wizardAssociateToggle}><input type="checkbox" checked={associateModelIds.length >= associateModelOptions.length} onChange={event => setAssociateModelOverride(event.currentTarget.checked ? [...associateModelOptions] : [])} />全部兼容模型（{associateModelOptions.length}）</label>{associateModelOptions.map(modelId => <label key={modelId} className={`${styles.wizardAssociateOption} ${associateModelIds.includes(modelId) ? styles.wizardAssociateOptionChecked : ""}`}><input type="checkbox" checked={associateModelIds.includes(modelId)} onChange={() => setAssociateModelOverride(current => {const base = current ?? defaultAssociateModelIds; return base.includes(modelId) ? base.filter(id => id !== modelId) : [...base, modelId];})} /><code>{modelId}</code></label>)}</div></div> : null}{!hasActionableAgent && !finishing ? <p className={styles.wizardWarn}>当前供应商已接入全部可用 Agent 且配置完整，无需再执行接入操作。</p> : null}<ZcodeLocalImportHint presetId={target.presetId} agents={[...new Set([...selectedAgents, ...connectedAgentIds])]} variant="wizard" />{error ? <p className={styles.errorText} role="alert">{error}</p> : null}</div> : null}
      </div>
      <footer className={styles.wizardFooter}><button type="button" className={styles.secondaryButton} onClick={onClose} disabled={finishing}>稍后继续</button><div className={styles.wizardFooterActions}>{step === "discover" && (discoverState === "ready" || discoverState === "empty" || discoverState === "failed") ? <button type="button" className={styles.secondaryButton} onClick={collapseDiscovery}>收起模型探测列表</button> : null}{step === "discover" && canSkipDiscovery ? <button type="button" className={styles.secondaryButton} onClick={() => setStep("agent")} disabled={finishing || busy}>已有兼容模型，直接接入</button> : null}{step === "discover" && ((discoverState === "ready" && selectedDiscoveredModels.length > 0) || pickedCatalogModels.length > 0) ? <button type="button" className={styles.primaryButton} onClick={() => void confirmDiscoveryStep()} disabled={busy || savingModel}>确认模型并继续</button> : null}{step === "agent" ? <button type="button" className={styles.primaryButton} onClick={() => void finishEnable()} disabled={finishing || busy || !hasActionableAgent}><Check size={16} /> {finishing ? "正在启用…" : "启用供应商并完成配置"}</button> : null}</div></footer>
    </section>
  </div>;
}

/**
 * 当前供应商对该 Agent 实际可用的网关入口：只列出协议可达且与已选模型
 * wire API 兼容的 binding（如 ZCode 对 GPT 模型显示 /zcode/v1/responses，
 * 而不是默认的 /zcode/v1/messages）。
 */
function compatibleGatewayPaths(target: ProxyTarget, entry: {id: AgentId; defaultBinding: {gatewayPath: string}}): string {
  const availableWireApis = new Set(availableWireApisForAgent(target, entry.id));
  const paths = agentBindings(entry.id)
    .filter(binding => availableWireApis.has(binding.wireApi))
    .map(binding => `/${entry.id}${binding.gatewayPath}`);
  return paths.length > 0 ? paths.join(" / ") : `/${entry.id}${entry.defaultBinding.gatewayPath}`;
}

function deriveOnboardingAgents(target: ProxyTarget, credentials: CredentialItem[], config: ProxyConfig): AgentId[] {
  const ids = new Set<AgentId>();
  for (const scopes of Object.values(target.supportedModelScopes || {})) for (const id of scopes) ids.add(id);
  for (const item of credentials) if (item.targetId === target.id) for (const id of item.agentScope || []) ids.add(id as AgentId);
  for (const entry of AGENT_CATALOG) if (config.agentConnections[entry.id]?.boundTargetIds?.includes(target.id) || config.agentConnections[entry.id]?.defaultTargetId === target.id) ids.add(entry.id);
  return AGENT_CATALOG.filter(entry => ids.has(entry.id)).map(entry => entry.id);
}
