import {
  AGENT_REGISTRY,
  agentLabel as registryAgentLabel,
  type AgentAdapter,
} from "@/lib/agent-registry";
import {
  resolveOfficialPresetForTarget as registryResolveOfficialPresetForTarget,
  resolveTargetAgentCapability as registryResolveTargetAgentCapability,
  availableWireApisForAgent,
  type TargetAgentCapability,
} from "@/lib/provider-preset-capabilities";
import {resolveTargetModelWireApis} from "@/lib/proxy-management-domain";
import {hasSubscriptionPresetRoute} from "@/lib/config-sync/core/subscription-route";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import {buildGatewayModelId} from "@/proxy/gateway-prefix";
import {agentScopeIncludes, type AgentId, type ProxyConfig, type ProxyTarget} from "@/types";

/**
 * Agent 目录兼容层：Agent 基础定义来自纯注册表，官方预设能力由 Web 业务层统一解析。
 * 本模块保留原导出名，避免页面组件各自复制协议与能力判断。
 */
export type AgentCatalogEntry = AgentAdapter;

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = AGENT_REGISTRY;

export function agentLabel(id: AgentId): string {
  return registryAgentLabel(id);
}

/** Agent 是否已建立接入关系：绑定供应商即可视为已接入，默认供应商缺失只表示待配置。 */
export function isAgentConnected(config: ProxyConfig, agent: AgentId): boolean {
  const connection = config.agentConnections?.[agent];
  if (!connection || connection.enabled === false) return false;
  if (connection.boundTargetIds?.some(targetId => config.targets?.some(target => target.id === targetId))) return true;
  return Boolean(connection.defaultTargetId
    && config.targets?.some(target => target.id === connection.defaultTargetId));
}

/** 当前已接入的 Agent；默认代理供应商为空时仍列出，页面可继续补齐默认链。 */
export function connectedAgents(config: ProxyConfig): AgentId[] {
  return AGENT_CATALOG.filter(entry => isAgentConnected(config, entry.id)).map(entry => entry.id);
}

/**
 * 返回某个 Agent 当前可用于开发入口的供应商候选。
 *
 * 候选必须同时满足：已建立 Agent 绑定关系、供应商已启用、供应商具备
 * 该 Agent 的协议 binding，并且至少有一个 scope 与 wire API 都兼容的模型。
 * 这里不检查密钥：密钥缺失属于启动弹窗中的可修复配置状态，不能因此把
 * 已接入的供应商从“默认供应商”候选中静默移除。
 */
export function boundCompatibleTargetsForAgent(
  config: ProxyConfig,
  agent: AgentId,
): ProxyTarget[] {
  const connection = config.agentConnections?.[agent];
  if (!connection || connection.enabled === false) return [];
  const ids = [...new Set([
    ...(connection.boundTargetIds ?? []),
    ...(connection.defaultTargetId ? [connection.defaultTargetId] : []),
  ])];

  return ids
    .map(id => config.targets?.find(target => target.id === id))
    .filter((target): target is ProxyTarget => Boolean(target && target.enabled !== false))
    .filter(target => resolveTargetAgentCapability(target, agent).supported)
    .filter(target => agentCompatibleModelsForTarget(target, agent).length > 0);
}

/** 供应商是否具备某 Agent 所需的协议上游 URL。 */
export function targetHasProtocolForAgent(
  target: {openaiUrl?: string; anthropicUrl?: string; presetId?: string; billingChannel?: ProxyTarget["billingChannel"]},
  agent: AgentId,
): boolean {
  return registryResolveTargetAgentCapability(target, agent).supported;
}

export function resolveTargetAgentCapability(
  target: {openaiUrl?: string; anthropicUrl?: string; presetId?: string; billingChannel?: ProxyTarget["billingChannel"]},
  agent: AgentId,
): TargetAgentCapability {
  return registryResolveTargetAgentCapability(target, agent);
}

export const resolveOfficialPresetForTarget = registryResolveOfficialPresetForTarget;

function isSubscriptionTarget(target: Pick<ProxyTarget, "billingChannel">): boolean {
  return target.billingChannel === "subscription";
}

/**
 * 供应商当前真正“能服务”的 Agent 集合：与「Agent 接入」页签的可见判定一致
 * （协议上游 + 适用且 wire 兼容的模型 + 适用密钥，订阅通道免密钥），不要求供应商已启用。
 * 模型/密钥的「适用 Agent」选项只能从该集合中产生，保证适用与实际接入联动一致。
 */
export function servedAgentsForTarget(
  target: ProxyTarget,
  credentials: Array<{targetId: string; agentScope?: string[]}>,
): AgentId[] {
  return AGENT_CATALOG
    .filter(entry => targetSupportsAgent(target, entry.id, credentials, {requireEnabled: false}))
    .map(entry => entry.id);
}

/**
 * 供应商失去对某些 Agent 的支持后，从模型适用与 Agent 级默认链中联动移除这些 Agent。
 * 密钥适用的联动由调用方通过凭据 API 单独更新；本函数只产出可保存的供应商补丁。
 * 生成的补丁为空（没有需要清理的字段）时返回 undefined。
 */
export function buildAgentDropPatch(
  target: ProxyTarget,
  dropped: AgentId[],
): Partial<ProxyTarget> | undefined {
  if (dropped.length === 0) return undefined;
  const nextScopes = {...(target.supportedModelScopes || {})};
  let scopesChanged = false;
  for (const modelId of Object.keys(nextScopes)) {
    const kept = (nextScopes[modelId] || []).filter(id => !dropped.includes(id as AgentId));
    if (kept.length === (nextScopes[modelId] || []).length) continue;
    scopesChanged = true;
    if (kept.length === 0) delete nextScopes[modelId];
    else nextScopes[modelId] = kept;
  }
  const development = {...(target.development || {})};
  const defaultModels = {...(development.defaultModels || {})};
  const defaultCredentials = {...(development.defaultCredentials || {})};
  let defaultsChanged = false;
  for (const agent of dropped) {
    if (defaultModels[agent] !== undefined) {
      delete defaultModels[agent];
      defaultsChanged = true;
    }
    if (defaultCredentials[agent] !== undefined) {
      delete defaultCredentials[agent];
      defaultsChanged = true;
    }
  }
  const patch: Partial<ProxyTarget> = {};
  if (scopesChanged) {
    patch.supportedModelScopes = Object.keys(nextScopes).length > 0 ? nextScopes : undefined;
  }
  if (defaultsChanged) {
    patch.development = {
      ...development,
      ...(Object.keys(defaultModels).length > 0 ? {defaultModels} : {}),
      ...(Object.keys(defaultCredentials).length > 0 ? {defaultCredentials} : {}),
    };
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** 供应商协议配置下默认适用的 Agent 集合：只配 OpenAI 协议时不含 Claude Code，
 * 只配 Anthropic 协议时不含 Codex；两者都配才全量。模型/密钥适用的默认值以此为准。
 */
export function protocolAgentsForTarget(
  target: {openaiUrl?: string; anthropicUrl?: string; presetId?: string; billingChannel?: ProxyTarget["billingChannel"]},
): AgentId[] {
  return AGENT_CATALOG.filter(entry => targetHasProtocolForAgent(target, entry.id)).map(entry => entry.id);
}

/** 当前代理供应商是否“支持”某 Agent：启用 + 协议 URL + 有适用且协议兼容该 Agent 的模型 + 有适用该 Agent 的密钥。 */
export function targetSupportsAgent(
  target: {id: string; enabled: boolean; billingChannel?: ProxyTarget["billingChannel"]; openaiUrl?: string; anthropicUrl?: string; supportedModels: string[]; supportedModelScopes?: Record<string, string[]>},
  agent: AgentId,
  credentials: Array<{targetId: string; agentScope?: string[]}>,
  options: {requireEnabled?: boolean} = {},
): boolean {
  if ((options.requireEnabled ?? true) && !target.enabled) return false;
  if (!targetHasProtocolForAgent(target, agent)) return false;
  const hasModel = target.supportedModels.some(model => agentScopeIncludes(target.supportedModelScopes?.[model], agent)
    && modelWireApiIntersectsTarget(target, model, agent));
  const hasCredential = isSubscriptionTarget(target)
    || credentials.some(item => item.targetId === target.id && agentScopeIncludes(item.agentScope, agent));
  return hasModel && hasCredential;
}

/**
 * 供应商中与指定 Agent wire API 兼容的模型列表（不要求已标记适用）：
 * 用于「可接入」判定——用户主动取消某 Agent 的适用后，模型适用被级联清空，
 * 但只要模型本身 wire API 兼容，该 Agent 仍应可重新接入（接入向导会重新合并适用）。
 * wire API 按「供应商声明 → 预设级继承 → URL+模型家族推断」解析，与网关判定一致。
 */
export function wireApiCompatibleModelsForTarget(
  target: ProxyTarget,
  agent: AgentId,
): string[] {
  return target.supportedModels.filter(modelId =>
    modelWireApiIntersectsTarget(target, modelId, agent));
}

/**
 * 供应商中与指定 Agent 真正可用的模型列表：scope 适用 + wire API 与 Agent 可用 binding 有交集。
 * wire API 按「供应商声明 → 预设级继承 → URL+模型家族推断」解析，保证自定义供应商与目录供应商
 * 在 UI 与网关上的判定一致，避免 Chat 模型（如 glm-5.3）出现在只支持 Responses 的 Codex 下拉中。
 */
export function agentCompatibleModelsForTarget(
  target: ProxyTarget,
  agent: AgentId,
): string[] {
  return target.supportedModels.filter(modelId =>
    agentScopeIncludes(target.supportedModelScopes?.[modelId], agent)
    && modelWireApiIntersectsTarget(target, modelId, agent));
}

/** 模型 wire API 是否与 Agent 当前可用 binding 有交集。 */
function modelWireApiIntersectsTarget(
  target: Pick<ProxyTarget, "openaiUrl" | "anthropicUrl" | "presetId" | "billingChannel" | "supportedModelWireApis">,
  modelId: string,
  agent: AgentId,
): boolean {
  const bindingWireApis = availableWireApisForAgent(target, agent);
  if (bindingWireApis.length === 0) return false;
  const modelWireApis = resolveTargetModelWireApis(target, modelId);
  return modelWireApis.length > 0 && modelWireApis.some(wireApi => bindingWireApis.includes(wireApi));
}

/**
 * Claude 当前默认访问链将写入的 settings 预览（与注入格式一致），供「Agent 接入」页展示。
 * 模型取自 Claude 当前默认代理供应商；尚未接入或默认供应商缺失时回退到当前页签供应商，
 * 保证预览不为「待配置」。targetPreviewed 始终标注实际提供模型的供应商，避免与模型来源不一致。
 */
export function buildClaudeSettingsPreview(config: ProxyConfig, target: ProxyTarget): Record<string, unknown> {
  const connection = config.agentConnections.claude;
  const defaultTarget = config.targets.find(item => item.id === connection?.defaultTargetId) ?? target;
  return buildClaudePreviewBody(config, defaultTarget);
}

/**
 * 指定供应商「作为 Claude Code 默认供应商时」将写入的 settings 预览，供新建向导使用。
 * 模型只取当前供应商：development.defaultModels.claude；未显式设置时保持待配置，
 * 不回退第一个支持模型，也不受 Claude 当前默认供应商影响。
 */
export function buildClaudeTargetSettingsPreview(config: ProxyConfig, target: ProxyTarget): Record<string, unknown> {
  return buildClaudePreviewBody(config, target);
}

/**
 * Claude 全局别名（Opus / Sonnet / Haiku）可选的带前缀模型 ID：
 * 已接入 Claude Code（绑定到 claude 连接）的启用供应商中，归属 claude 且
 * wire API 与 Claude binding 兼容的支持模型。与保存校验（proxy-config 的
 * isKnownGatewayModelId）保持同一判定范围，避免下拉展示保存时被静默丢弃的选项。
 */
export function claudeAliasModelOptions(config: ProxyConfig): string[] {
  const connection = config.agentConnections?.claude;
  if (!connection || connection.enabled === false) return [];
  const bound = new Set([
    ...(connection.boundTargetIds ?? []),
    ...(connection.defaultTargetId ? [connection.defaultTargetId] : []),
  ]);
  return config.targets
    .filter(target => target.enabled && bound.has(target.id))
    .flatMap(target => target.supportedModels
      .filter(model => agentScopeIncludes(target.supportedModelScopes?.[model], "claude")
        && modelWireApiIntersectsTarget(target, model, "claude"))
      .map(model => buildGatewayModelId(target.id, model)));
}

/** 按提供模型的供应商构建 Claude settings 预览体；别名取全局 modelAliases，缺省回退该供应商模型。 */
function buildClaudePreviewBody(config: ProxyConfig, modelTarget: ProxyTarget): Record<string, unknown> {
  const model = modelTarget.development?.defaultModels?.claude;
  const gatewayModel = model ? buildGatewayModelId(modelTarget.id, model) : "(待配置)";
  const aliases = config.agentConnections.claude?.modelAliases || {};
  return {
    env: {
      ANTHROPIC_BASE_URL: `${resolveGatewayBaseUrl(config.localProxyBaseUrl)}/claude`,
      // 预览按路由级订阅判据（2026-10-08）展示；预览不感知本机 Claude 登录态——
      // 实际写入由登录态门控，未登录时仍写占位 token（网关 SUBSCRIPTION_LOGIN_REQUIRED 防御兜底）。
      ...(hasSubscriptionPresetRoute(config, "anthropic-subscription") ? {} : {ANTHROPIC_AUTH_TOKEN: "deepaa-gateway"}),
      ANTHROPIC_MODEL: gatewayModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: aliases.opus || gatewayModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: aliases.sonnet || gatewayModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: aliases.haiku || gatewayModel,
    },
    model: gatewayModel,
    targetPreviewed: modelTarget.id,
  };
}
