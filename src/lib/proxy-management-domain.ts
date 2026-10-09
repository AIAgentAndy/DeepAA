import type {AgentId, AgentConnectionSettings, ProxyConfig, ProxyTarget, WireApi} from "@/types";
import {agentScopeIncludes, KNOWN_AGENT_IDS} from "@/types";
import {AGENT_REGISTRY, agentBindings} from "@/lib/agent-registry";
import type {ModelPriceEntry} from "@/lib/pricing";
import {availableWireApisForAgent, resolveOfficialPresetForTarget, resolveTargetAgentCapability} from "@/lib/provider-preset-capabilities";
import {inferCustomTargetModelWireApis} from "@/lib/wire-api-infer";
import {inferTargetChannelMetadata} from "@/lib/target-channel-metadata";
import {parseGatewayModelId, buildGatewayModelId} from "@/proxy/gateway-prefix";
import type {ProxyTargetModelVendor} from "@/types";
import {inferModelVendor, type ModelVendorMapReason} from "@/lib/model-vendor-map";

/** 新增密钥默认名：<供应商名>-密钥N；N 取现有名称中未占用的最小序号。 */
export function nextCredentialLabel(targetName: string, existingLabels: readonly string[]): string {
  const base = targetName.trim() || "供应商";
  const used = new Set(existingLabels.map(label => label.trim()));
  for (let index = 1; index <= existingLabels.length + 1; index += 1) {
    const candidate = `${base}-密钥${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-密钥${existingLabels.length + 1}`;
}

export type VendorSuggestionReason = ModelVendorMapReason;

export interface VendorSuggestion {
  vendor: string;
  reason: VendorSuggestionReason;
}

export type TargetReadinessReason =
  | "TARGET_DISABLED"
  | "PROTOCOL_URL_REQUIRED"
  | "PRESET_WIRE_API_UNSUPPORTED"
  | "CREDENTIAL_REQUIRED"
  | "MODEL_REQUIRED"
  | "MODEL_PRICE_MAPPING_REQUIRED";

export interface TargetReadiness {
  ready: boolean;
  reasons: TargetReadinessReason[];
}

export type AgentReadinessReason =
  | "AGENT_NOT_CONNECTED"
  | "DEFAULT_TARGET_REQUIRED"
  | "DEFAULT_TARGET_NOT_FOUND"
  | "DEFAULT_TARGET_NOT_BOUND"
  | "TARGET_DISABLED"
  | "PROTOCOL_URL_REQUIRED"
  | "PRESET_WIRE_API_UNSUPPORTED"
  | "DEFAULT_MODEL_REQUIRED"
  | "DEFAULT_MODEL_NOT_SUPPORTED"
  | "DEFAULT_MODEL_AGENT_SCOPE_MISMATCH"
  | "DEFAULT_MODEL_WIRE_API_MISMATCH"
  | "DEFAULT_MODEL_PRICE_MAPPING_REQUIRED"
  | "DEFAULT_CREDENTIAL_REQUIRED";

export interface AgentReadiness {
  ready: boolean;
  reasons: AgentReadinessReason[];
  targetId?: string;
}

export interface ProxyTargetCredentialCandidate {
  id: string;
  targetId: string;
  agentScope?: readonly string[];
}

export type ProxyOnboardingStep = "credentials" | "discover" | "agent";

function isSubscriptionTarget(target: Pick<ProxyTarget, "billingChannel">): boolean {
  return target.billingChannel === "subscription";
}

/**
 * 解析代理接入向导的起始步骤。新建供应商必须由用户录入本次供应商的首个密钥，
 * 不能因为同路由 ID 的历史前端缓存或孤立凭据元数据而跳过安全边界。
 */
export function resolveProxyOnboardingStartStep(input: {
  target: ProxyTarget;
  config: ProxyConfig;
  credentials: readonly ProxyTargetCredentialCandidate[];
  agent?: AgentId;
  isNewTarget?: boolean;
}): ProxyOnboardingStep | null {
  const {target, config, credentials, agent, isNewTarget = false} = input;
  if (isNewTarget) return isSubscriptionTarget(target) ? "agent" : "credentials";

  const officialPreset = Boolean(target.presetId || resolveOfficialPresetForTarget(target));
  if (agent) {
    // 就绪度按 wire API 兼容判定（与向导完成阶段的 scope 合并口径一致），而不是已有归属：
    // gpt-5.6-sol（归属 codex）接入 opencode 时，完成阶段本就能自动补齐归属，
    // 不应因 scope 未含该 Agent 而被强制重走模型探测。密钥同理：目标下已有任意密钥即
    // 可进入后续步骤（向导完成阶段会把缺归属的密钥 scope 合并进所选 Agent）。
    const targetCredentials = credentials.filter(item => item.targetId === target.id);
    const hasAnyCredential = isSubscriptionTarget(target) || targetCredentials.length > 0;
    if (!hasAnyCredential) return "credentials";
    const bindingWireApis = bindingWireApisForTarget(target, agent);
    const hasModel = target.supportedModels.some(modelId =>
      modelWireApiAllowed(modelId, bindingWireApis, target));
    if (!hasModel && !officialPreset) return "discover";
    const connection = config.agentConnections[agent];
    if (!connection?.boundTargetIds?.includes(target.id) || !target.enabled) return "agent";
    return null;
  }

  if (!isSubscriptionTarget(target) && !credentials.some(item => item.targetId === target.id)) return "credentials";
  // 完全没有 wire 兼容模型（含白名单为空、或声明过期为空数组）时进入探测步骤，
  // 由重新确认按当前 URL 重算模型协议能力，避免落进无可选 Agent 的死胡同。
  const hasCompatibleModel = AGENT_REGISTRY.some(entry => {
    const bindingWireApis = bindingWireApisForTarget(target, entry.id);
    return bindingWireApis.length > 0
      && target.supportedModels.some(modelId => modelWireApiAllowed(modelId, bindingWireApis, target));
  });
  if ((!hasCompatibleModel || target.supportedModels.length === 0) && !officialPreset) return "discover";
  const hasAgent = AGENT_REGISTRY.some(entry => config.agentConnections[entry.id]?.boundTargetIds?.includes(target.id));
  if (!hasAgent || !target.enabled) return "agent";
  return null;
}

/**
 * 代理管理页只替换 target 单值上下文，保留其它查询条件和 hash；空供应商时移除参数。
 * 返回相对地址，避免把本地 Origin 固化进浏览器历史。
 */
export function proxyManagementTargetHref(currentHref: string, targetId: string | undefined): string {
  const url = new URL(currentHref);
  if (targetId) url.searchParams.set("target", targetId);
  else url.searchParams.delete("target");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * 解析供应商模型在价格中心中的权威条目。优先按供应商映射的 priceEntryId 精确命中；
 * 兜底只允许“供应商 + 运行时模型 ID”同键匹配，绝不跨供应商按模型名猜测，
 * 避免同名模型在多个供应商（如 openai / azure / opencode-go）并存时展示错误供应商或错误价格。
 */
export function resolveTargetModelPriceEntry(
  pricingModels: readonly ModelPriceEntry[],
  modelId: string,
  mapping: ProxyTargetModelVendor | undefined,
): ModelPriceEntry | undefined {
  if (!mapping?.vendor?.trim()) return undefined;
  if (mapping.priceEntryId) {
    const byId = pricingModels.find(item => item.id.trim() === mapping.priceEntryId);
    if (byId) return byId;
  }
  const vendor = mapping.vendor.trim().toLowerCase();
  const comparableModelId = modelId.trim().toLowerCase();
  return pricingModels.find(item =>
    (item.vendor || item.litellmProvider || "").trim().toLowerCase() === vendor
    && runtimeModelIdOfEntry(item).trim().toLowerCase() === comparableModelId);
}

/** 价格中心条目运行时模型 ID；与 pricing 模块的推导规则保持一致（纯函数，客户端可安全引用）。 */
function runtimeModelIdOfEntry(entry: ModelPriceEntry): string {
  const explicit = entry.runtimeModelId?.trim();
  if (explicit) return explicit;
  const candidate = entry.match?.trim() || entry.patterns[0]?.trim() || entry.id.trim();
  const vendorPrefix = `${entry.vendor.trim().toLowerCase()}/`;
  return candidate.toLowerCase().startsWith(vendorPrefix)
    ? candidate.slice(vendorPrefix.length)
    : candidate;
}

/**
 * 为供应商首次配置自动补齐默认链所需的最小引用。
 * 只补缺失或已失效的默认模型/密钥，不覆盖用户已经明确保存的有效值；
 * 供应商协议、模型 scope、价格映射和密钥 scope 任一不满足时都不会强行写入。
 */
export function ensureProxyTargetAgentDefaults(
  target: ProxyTarget,
  credentials: readonly ProxyTargetCredentialCandidate[] = [],
): ProxyTarget {
  const defaultModels = {...(target.development?.defaultModels || {})};
  const defaultCredentials = {...(target.development?.defaultCredentials || {})};
  const targetCredentials = credentials.filter(item => item.targetId === target.id);
  for (const agent of AGENT_REGISTRY) {
    const capability = resolveTargetAgentCapability(target, agent.id);
    const bindingWireApis = bindingWireApisForTarget(target, agent.id);
    const eligibleModel = capability.supported ? target.supportedModels.find(modelId => {
      const mapping = target.pricing?.modelVendors?.[modelId];
      return agentScopeIncludes(target.supportedModelScopes?.[modelId], agent.id)
        && modelWireApiAllowed(modelId, bindingWireApis, target)
        && Boolean(mapping?.vendor && mapping.priceEntryId);
    }) : undefined;
    const existingModel = defaultModels[agent.id];
    const existingModelValid = Boolean(capability.supported
      && existingModel
      && target.supportedModels.includes(existingModel)
      && agentScopeIncludes(target.supportedModelScopes?.[existingModel], agent.id)
      && modelWireApiAllowed(existingModel, bindingWireApis, target)
      && target.pricing?.modelVendors?.[existingModel]?.vendor
      && target.pricing?.modelVendors?.[existingModel]?.priceEntryId);
    if (!existingModelValid) {
      if (eligibleModel) defaultModels[agent.id] = eligibleModel;
      else delete defaultModels[agent.id];
    }

    const eligibleCredential = !isSubscriptionTarget(target) && capability.supported
      ? targetCredentials.find(item => agentScopeIncludes(item.agentScope, agent.id))
      : undefined;
    const existingCredential = defaultCredentials[agent.id];
    const existingCredentialValid = Boolean(capability.supported
      && existingCredential
      && targetCredentials.some(item => item.id === existingCredential && agentScopeIncludes(item.agentScope, agent.id)));
    // 凭据元数据在代理配置与系统凭据库之间分开保存；供应商 patch 阶段可能拿不到
    // 完整元数据，因此这里只在找到明确替代项时补齐，不擅自清理已有引用。
    // 删除/改适用时由凭据服务自己的原子命令负责迁移或清理默认密钥。
    if (!existingCredentialValid && eligibleCredential) defaultCredentials[agent.id] = eligibleCredential.id;
  }
  const development = {
    ...(Object.keys(defaultModels).length > 0 ? {defaultModels} : {}),
    ...(Object.keys(defaultCredentials).length > 0 ? {defaultCredentials} : {}),
    ...(target.development?.preferredTerminal ? {preferredTerminal: target.development.preferredTerminal} : {}),
    ...(target.development?.lastProjectDir ? {lastProjectDir: target.development.lastProjectDir} : {}),
  };
  return {
    ...target,
    ...(Object.keys(development).length > 0 ? {development} : {development: undefined}),
  };
}

/** 中转站模型族映射统一由 model-vendor-map 维护，调用方不得提供 vendor 选择器。 */
export function inferDiscoveredVendor(runtimeModelId: string): VendorSuggestion | undefined {
  return inferModelVendor(runtimeModelId);
}

/** 供应商 ready 是所有 Agent 和启动入口共用的基础判断，不接受“有 URL 即可用”。 */
export function getTargetReadiness(
  target: ProxyTarget,
  credentials?: ReadonlyArray<{targetId: string}>,
): TargetReadiness {
  const reasons: TargetReadinessReason[] = [];
  if (!target.enabled) reasons.push("TARGET_DISABLED");
  if (!target.openaiUrl && !target.anthropicUrl) reasons.push("PROTOCOL_URL_REQUIRED");
  if (!target.enabled) return {ready: false, reasons};
  const hasCredential = isSubscriptionTarget(target) || (credentials
    ? credentials.some(item => item.targetId === target.id)
    : hasTargetCredentialReference(target));
  if (!hasCredential) reasons.push("CREDENTIAL_REQUIRED");
  if (target.supportedModels.length === 0) reasons.push("MODEL_REQUIRED");
  for (const modelId of target.supportedModels) {
    const mapping = target.pricing?.modelVendors?.[modelId];
    if (!mapping?.vendor || !mapping.priceEntryId) {
      reasons.push("MODEL_PRICE_MAPPING_REQUIRED");
      break;
    }
  }
  return {ready: reasons.length === 0, reasons: [...new Set(reasons)]};
}

/**
 * Agent 默认链就绪判定。凭据元数据只在 Node 服务层可查，浏览器侧传入的
 * credentialIds 仅用于判断是否存在，真实 secret 永远不进入该纯函数。
 */
export function getAgentReadiness(
  config: ProxyConfig,
  agent: AgentId,
  credentialIds?: ReadonlySet<string>,
): AgentReadiness {
  const connection = config.agentConnections[agent];
  if (!connection || connection.enabled === false) return {ready: false, reasons: ["AGENT_NOT_CONNECTED"]};
  const targetId = connection.defaultTargetId;
  if (!targetId) return {ready: false, reasons: ["DEFAULT_TARGET_REQUIRED"]};
  const target = config.targets.find(item => item.id === targetId);
  if (!target) return {ready: false, reasons: ["DEFAULT_TARGET_NOT_FOUND"], targetId};
  const boundTargetIds = connection.boundTargetIds ?? (connection.defaultTargetId ? [connection.defaultTargetId] : []);
  if (!boundTargetIds.includes(targetId)) return {ready: false, reasons: ["DEFAULT_TARGET_NOT_BOUND"], targetId};
  const reasons: AgentReadinessReason[] = [];
  if (!target.enabled) reasons.push("TARGET_DISABLED");
  const capability = resolveTargetAgentCapability(target, agent);
  if (!capability.supported) reasons.push(capability.reason === "PRESET_WIRE_API_UNSUPPORTED"
    ? "PRESET_WIRE_API_UNSUPPORTED"
    : "PROTOCOL_URL_REQUIRED");
  const bindingWireApis = bindingWireApisForTarget(target, agent);
  const modelId = target.development?.defaultModels?.[agent];
  if (!modelId) reasons.push("DEFAULT_MODEL_REQUIRED");
  else if (!target.supportedModels.includes(modelId)) reasons.push("DEFAULT_MODEL_NOT_SUPPORTED");
  else if (!agentScopeIncludes(target.supportedModelScopes?.[modelId], agent)) reasons.push("DEFAULT_MODEL_AGENT_SCOPE_MISMATCH");
  else if (!modelWireApiAllowed(modelId, bindingWireApis, target)) reasons.push("DEFAULT_MODEL_WIRE_API_MISMATCH");
  else {
    const mapping = target.pricing?.modelVendors?.[modelId];
    if (!mapping?.vendor || !mapping.priceEntryId) reasons.push("DEFAULT_MODEL_PRICE_MAPPING_REQUIRED");
  }
  if (!isSubscriptionTarget(target)) {
    const credentialId = target.development?.defaultCredentials?.[agent];
    if (!credentialId || (credentialIds && !credentialIds.has(credentialId))) reasons.push("DEFAULT_CREDENTIAL_REQUIRED");
  }
  return {ready: reasons.length === 0, reasons: [...new Set(reasons)], targetId};
}

/**
 * 解析供应商模型的 wire API 能力（四层判定共用）：
 * 1. 供应商已落库的 supportedModelWireApis 声明优先（空数组 = 显式拒绝，不回退）；
 * 2. 官方预设供应商缺声明时继承预设级 openaiWireApis + anthropicUrl 的 messages；
 * 3. 自定义供应商（无预设）按 URL + 模型家族推断（gpt 系列与 o 系列 → responses，其余 → chat）。
 */
export function resolveTargetModelWireApis(
  target: Pick<ProxyTarget, "openaiUrl" | "anthropicUrl" | "presetId" | "billingChannel" | "supportedModelWireApis">,
  modelId: string,
): WireApi[] {
  const declared = target.supportedModelWireApis?.[modelId];
  if (Array.isArray(declared)) return [...declared];
  const preset = resolveOfficialPresetForTarget(target);
  if (preset) {
    const wireApis = new Set<WireApi>((preset.openaiWireApis ?? []) as WireApi[]);
    if (target.anthropicUrl?.trim()) wireApis.add("messages");
    return [...wireApis];
  }
  return inferCustomTargetModelWireApis(modelId, target);
}

/** 默认模型必须与供应商可用 binding 的 wire API 有交集；解析后仍为空 = 不允许。 */
function modelWireApiAllowed(
  modelId: string,
  bindingWireApis: readonly WireApi[],
  target: ProxyTarget,
): boolean {
  const modelWireApis = resolveTargetModelWireApis(target, modelId);
  return modelWireApis.length > 0
    && modelWireApis.some(wireApi => bindingWireApis.includes(wireApi));
}

/** 供应商当前对指定 Agent 可用 binding 的 wire API 列表（协议 URL 已配置才算可用）。 */
function bindingWireApisForTarget(
  target: Pick<ProxyTarget, "openaiUrl" | "anthropicUrl">,
  agent: AgentId,
): WireApi[] {
  return agentBindings(agent)
    .filter(binding => binding.protocol === "openai"
      ? Boolean(target.openaiUrl?.trim())
      : Boolean(target.anthropicUrl?.trim()))
    .map(binding => binding.wireApi);
}

/** 停用默认供应商时只接受其它 active 且能完整形成默认链的供应商。 */
export function selectFallbackTarget(
  targets: readonly ProxyTarget[],
  agent: AgentId,
  excludedTargetId: string,
  boundTargetIds: readonly string[],
  credentialIds?: ReadonlySet<string>,
): ProxyTarget | undefined {
  const bound = new Set(boundTargetIds);
  return targets.find(target => target.id !== excludedTargetId
    && bound.has(target.id)
    && getTargetReadiness(target).ready
    && resolveTargetAgentCapability(target, agent).supported
    && Boolean(target.development?.defaultModels?.[agent])
    && (isSubscriptionTarget(target)
      || (Boolean(target.development?.defaultCredentials?.[agent])
        && (!credentialIds || credentialIds.has(target.development?.defaultCredentials?.[agent]!))))
    && agentScopeIncludes(
      target.supportedModelScopes?.[target.development?.defaultModels?.[agent]!],
      agent,
    ));
}

/**
 * 返回侧栏第一个供应商的 ID：与代理供应商侧栏保持同一过滤与排序规则——
 * 先按搜索词过滤名称/路由 ID，再按供应商族分组（组内保持配置数组原序），
 * 删除供应商或失效链接回退时使用，避免误跳配置数组首项（侧栏首个不一定等于它）。
 */
export function firstSidebarTargetId(targets: readonly ProxyTarget[], search = ""): string | undefined {
  const needle = search.trim().toLowerCase();
  const groups = new Map<string, string[]>();
  for (const target of targets) {
    if (needle && !`${target.name} ${target.id}`.toLowerCase().includes(needle)) continue;
    const family = target.vendorFamily
      || inferTargetChannelMetadata(target).vendorFamily
      || "other";
    const items = groups.get(family) || [];
    items.push(target.id);
    groups.set(family, items);
  }
  const firstGroup = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN"))[0];
  return firstGroup?.[1][0];
}

function hasTargetCredentialReference(target: ProxyTarget): boolean {
  return Object.values(target.development?.defaultCredentials || {}).some(value => Boolean(value));
}

export function normalizeAgentConnection(
  value: AgentConnectionSettings | undefined,
  targets: readonly ProxyTarget[],
): AgentConnectionSettings | undefined {
  if (!value) return undefined;
  const available = new Set(targets.map(target => target.id));
  const boundTargetIds = [...new Set((value.boundTargetIds || []).filter(id => available.has(id)))];
  const fallbackBound = value.defaultTargetId && available.has(value.defaultTargetId) && boundTargetIds.length === 0
    ? [value.defaultTargetId]
    : boundTargetIds;
  return {
    ...(fallbackBound.length > 0 ? {boundTargetIds: fallbackBound} : {}),
    ...(value.enabled === false ? {enabled: false} : {enabled: true}),
    ...(value.defaultTargetId ? {defaultTargetId: value.defaultTargetId} : {}),
    cliSyncEnabled: value.cliSyncEnabled === true,
    ...(value.modelAliases ? {modelAliases: value.modelAliases} : {}),
  };
}

/** 单个主模型允许配置的备份模型上限（与代理侧 MAX_MODEL_FALLBACKS 同值）。 */
export const MAX_TARGET_MODEL_FALLBACKS = 5;

/** 模型的可服务协议维度：(Agent, wireApi) 对——故障转移按该粒度判定兼容。 */
export interface ServableBinding {
  agent: AgentId;
  wireApi: WireApi;
}

function bindingKey(binding: ServableBinding): string {
  return `${binding.agent}::${binding.wireApi}`;
}

/**
 * 网关 `/v1/models` 同口径：模型在目标上真实可服务的 (Agent, wireApi) 对集合。
 * 四条件与网关合成模型列表一致：scope 显式适用 + 该 Agent 可用 binding 中与模型
 * wire API 声明有交集的每个协议 + 凭据（非订阅/透传通道要求目标已配置该 Agent
 * 默认凭据；订阅/透传要求 binding 声明 supportsSubscription）。不包含「Agent 接入
 * 绑定」维度——绑定只影响 CLI 配置同步，不影响网关手工请求。
 */
export function servableBindingsForModel(target: ProxyTarget, modelId: string): ServableBinding[] {
  const modelWireApis = resolveTargetModelWireApis(target, modelId);
  if (modelWireApis.length === 0) return [];
  const passthrough = target.billingChannel === "subscription" || target.credentialMode === "passthrough";
  const result: ServableBinding[] = [];
  for (const agent of KNOWN_AGENT_IDS) {
    if (!agentScopeIncludes(target.supportedModelScopes?.[modelId], agent)) continue;
    for (const binding of agentBindings(agent)) {
      if (!modelWireApis.includes(binding.wireApi)) continue;
      if (passthrough) {
        if (binding.supportsSubscription !== true) continue;
      } else if (!target.development?.defaultCredentials?.[agent]) {
        continue;
      }
      result.push({agent, wireApi: binding.wireApi});
    }
  }
  return result;
}

/** 网关 `/v1/models` 同口径：模型在目标上对指定 Agent 是否真实可服务。 */
export function modelServableForAgent(target: ProxyTarget, modelId: string, agent: AgentId): boolean {
  return servableBindingsForModel(target, modelId).some(binding => binding.agent === agent);
}

/** 模型在目标上真实可服务的 Agent 集合（按注册表顺序）；即该模型在各 CLI 模型列表中出现的维度。 */
export function servableAgentsForModel(target: ProxyTarget, modelId: string): AgentId[] {
  const agents: AgentId[] = [];
  for (const binding of servableBindingsForModel(target, modelId)) {
    if (!agents.includes(binding.agent)) agents.push(binding.agent);
  }
  return agents;
}

/** 候选目标是否禁止作为故障转移目标（passthrough/订阅通道：防客户端 OAuth 出境）。 */
export function isPassthroughFailoverTarget(target: ProxyTarget): boolean {
  return target.billingChannel === "subscription" || target.credentialMode === "passthrough";
}

/**
 * 校验目标故障转移模型链（供应商保存与服务端 PUT 共用的安全边界）：
 * - 条目必须是有效网关模型串、指向已知启用目标的白名单模型；
 * - 与主模型存在「共同可服务的 (Agent, wireApi)」（协议级精确交集，OpenCode 多协议
 *   场景下 responses 主模型不会配到 messages-only 候选）；
 * - 不得指向 passthrough/订阅目标（客户端 OAuth 越界防护）；
 * - 不超过上限。返回中文错误列表（空 = 通过）。
 */
export function validateTargetModelFallbacks(
  target: ProxyTarget,
  allTargets: readonly ProxyTarget[],
): string[] {
  const errors: string[] = [];
  const fallbacks = target.supportedModelFallbacks;
  if (!fallbacks) return errors;
  const label = target.name.trim() || target.id;
  for (const [modelId, entries] of Object.entries(fallbacks)) {
    if (entries.length > MAX_TARGET_MODEL_FALLBACKS) {
      errors.push(`${label} 的模型 ${modelId} 故障转移模型最多 ${MAX_TARGET_MODEL_FALLBACKS} 个`);
    }
    const primaryBindings = new Set(servableBindingsForModel(target, modelId).map(bindingKey));
    entries.forEach((entry, index) => {
      const parsed = parseGatewayModelId(entry);
      if (!parsed) {
        errors.push(`${label} 的模型 ${modelId} 第 ${index + 1} 优先级故障转移模型「${entry}」不是有效的网关模型串`);
        return;
      }
      const owner = allTargets.find(item => item.id === parsed.targetId);
      if (!owner || !owner.supportedModels.includes(parsed.modelId)) {
        errors.push(`${label} 的模型 ${modelId} 第 ${index + 1} 优先级故障转移模型「${entry}」不在任何供应商的白名单中`);
        return;
      }
      if (isPassthroughFailoverTarget(owner)) {
        errors.push(`${label} 的模型 ${modelId} 故障转移模型「${parsed.modelId}」所属供应商 ${owner.name || owner.id} 是订阅/透传通道，不能作为故障转移目标（客户端登录凭据不可跨目标转发）`);
        return;
      }
      const hasSharedBinding = primaryBindings.size > 0
        && servableBindingsForModel(owner, parsed.modelId).some(binding => primaryBindings.has(bindingKey(binding)));
      if (!hasSharedBinding) {
        errors.push(`${label} 的模型 ${modelId} 故障转移模型「${parsed.modelId}」与主模型没有共同可用的 Agent 协议（适用范围、协议或凭据不匹配），无法实现故障转移`);
      }
    });
  }
  return errors;
}

/** 故障转移模型候选（弹层候选区与已选回显共用）：网关模型串 + 模型/供应商/可服务 Agent 元数据。 */
export interface FallbackCandidateOption {
  gatewayModelId: string;
  modelId: string;
  targetId: string;
  targetName: string;
  /** 该候选模型在其目标上真实可服务的 Agent 集合（网关 /v1/models 同口径）。 */
  agents: AgentId[];
}

/**
 * 收集某主模型的故障转移候选（配置态，与网关运行时闸门同口径）：
 * 全部启用目标的白名单模型中，与主模型存在「共同可服务的 (Agent, wireApi)」者——
 * 即存在至少一个协议维度，使主模型与候选在该维度上都满足网关可服务口径，
 * 请求经该维度发生时转移只需改写 model 字段、零转换。排除主模型自身与
 * passthrough/订阅目标；主模型自身没有任何可服务维度时返回空列表。
 */
export function collectFallbackCandidateOptions(
  primaryTarget: ProxyTarget,
  allTargets: readonly ProxyTarget[],
  primaryModelId: string,
): FallbackCandidateOption[] {
  const primaryBindings = new Set(servableBindingsForModel(primaryTarget, primaryModelId).map(bindingKey));
  if (primaryBindings.size === 0) return [];
  const selfGatewayModelId = buildGatewayModelId(primaryTarget.id, primaryModelId);
  const result: FallbackCandidateOption[] = [];
  for (const owner of allTargets) {
    if (owner.enabled === false || isPassthroughFailoverTarget(owner)) continue;
    for (const modelId of owner.supportedModels) {
      const gatewayModelId = buildGatewayModelId(owner.id, modelId);
      if (gatewayModelId === selfGatewayModelId) continue;
      const bindings = servableBindingsForModel(owner, modelId);
      if (!bindings.some(binding => primaryBindings.has(bindingKey(binding)))) continue;
      const agents: AgentId[] = [];
      for (const binding of bindings) {
        if (!agents.includes(binding.agent)) agents.push(binding.agent);
      }
      result.push({
        gatewayModelId,
        modelId,
        targetId: owner.id,
        targetName: owner.name || owner.id,
        agents,
      });
    }
  }
  return result;
}
