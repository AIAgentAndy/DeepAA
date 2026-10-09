import {bindingSupportsSubscription} from "@/lib/agent-registry";
import {resolveTargetAgentCapability} from "@/lib/provider-preset-capabilities";
import type {
  CliSyncWarning,
} from "@/lib/config-sync/core/types";
import {
  agentScopeIncludes,
  type AgentId,
  type ProxyConfig,
  type ProxyTarget,
} from "@/types";

/** 判断供应商是否为订阅通道。 */
export function isSubscriptionTarget(target: ProxyTarget): boolean {
  return target.billingChannel === "subscription";
}

/** 判断供应商是否声明登录透传（网关不注入凭据，转发客户端自带凭据）。 */
export function isPassthroughTarget(target: ProxyTarget): boolean {
  return target.credentialMode === "passthrough";
}

/** V3 只接受 Agent 级显式默认模型，不再回退首个模型或旧供应商级字段。 */
export function defaultModelOf(target: ProxyTarget, agent: AgentId): string | undefined {
  const explicit = target.development?.defaultModels?.[agent];
  return explicit
    && target.supportedModels.includes(explicit)
    && modelAllowedForAgent(target, explicit, agent)
    ? explicit
    : undefined;
}

/** 模型适用过滤：缺省/空 scope 默认拒绝（与网关语义一致）。 */
export function modelAllowedForAgent(
  target: ProxyTarget,
  modelId: string,
  agent: AgentId,
): boolean {
  return agentScopeIncludes(target.supportedModelScopes?.[modelId], agent);
}

/** V3 只接受 Agent 级默认密钥，不再回退供应商级兼容字段。 */
export function defaultCredentialOf(target: ProxyTarget, agent: AgentId): string | undefined {
  return target.development?.defaultCredentials?.[agent];
}

/** 订阅通道无需系统凭据；按量/套餐供应商必须显式配置默认凭据。 */
export function requiresCredential(target: ProxyTarget, agent: AgentId): boolean {
  return !isSubscriptionTarget(target)
    && !bindingSupportsSubscription(agent, "responses")
    && !bindingSupportsSubscription(agent, "messages")
    && !bindingSupportsSubscription(agent, "chat_completions");
}

/**
 * 解析 Agent 的 CLI 同步默认供应商；链路不完整时返回 undefined 并记录 warning。
 * 与开发启动共用同一“默认供应商唯一来源”语义。
 */
export function resolveSyncDefaultTarget(
  config: ProxyConfig,
  agent: AgentId,
  warnings: CliSyncWarning[],
  agentLabel: (id: AgentId) => string,
): ProxyTarget | undefined {
  const connection = config.agentConnections[agent];
  if (!connection) {
    warnings.push({targetId: agent, code: "AGENT_NOT_CONNECTED", message: `${agentLabel(agent)} 尚未接入`});
    return undefined;
  }
  if (!connection.cliSyncEnabled) {
    warnings.push({targetId: agent, code: "CLI_SYNC_DISABLED", message: `${agentLabel(agent)} CLI 同步已关闭`});
    return undefined;
  }
  if (!connection.defaultTargetId) {
    warnings.push({targetId: agent, code: "DEFAULT_TARGET_REQUIRED", message: `${agentLabel(agent)} 未选择默认供应商`});
    return undefined;
  }
  const target = config.targets.find(item => item.id === connection.defaultTargetId);
  if (!target) {
    warnings.push({targetId: connection.defaultTargetId, code: "DEFAULT_TARGET_NOT_FOUND", message: "默认供应商不存在"});
    return undefined;
  }
  if (connection.boundTargetIds && !connection.boundTargetIds.includes(target.id)) {
    warnings.push({targetId: target.id, code: "DEFAULT_TARGET_NOT_BOUND", message: `${agentLabel(agent)} 默认供应商未加入接入范围`});
    return undefined;
  }
  return targetEligibleForAgent(target, agent, warnings, agentLabel) ? target : undefined;
}

/** 供应商级可用性：协议 URL、预设 wire API、订阅透传、默认凭据与默认模型；价格映射缺失只告警不淘汰。 */
export function targetEligibleForAgent(
  target: ProxyTarget,
  agent: AgentId,
  warnings: CliSyncWarning[],
  agentLabel: (id: AgentId) => string,
): boolean {
  if (!target.enabled) return false;
  if (target.cliSyncExclusions?.includes(agent)) {
    warnings.push({
      targetId: target.id,
      code: "CLI_SYNC_TARGET_EXCLUDED",
      message: `${target.name} 已从 ${agentLabel(agent)} CLI 同步中排除`,
    });
    return false;
  }
  const capability = resolveTargetAgentCapability(target, agent);
  if (!capability.supported) {
    warnings.push(capability.reason === "PRESET_WIRE_API_UNSUPPORTED"
      ? {targetId: target.id, code: "PRESET_WIRE_API_UNSUPPORTED", message: capability.message || `${target.name} 不支持当前 Agent 的 wire API`}
      : capability.reason === "SUBSCRIPTION_UNSUPPORTED"
        ? {targetId: target.id, code: "SUBSCRIPTION_UNSUPPORTED", message: capability.message || `${target.name} 为订阅通道，该 Agent 首期不支持订阅透传`}
        : protocolWarning(target, agentLabel(agent)));
    return false;
  }
  if (!isSubscriptionTarget(target) && !isPassthroughTarget(target) && !defaultCredentialOf(target, agent)) {
    warnings.push(credentialWarning(target));
    return false;
  }
  const explicitModel = target.development?.defaultModels?.[agent];
  if (explicitModel && target.supportedModels.includes(explicitModel)
    && modelAllowedForAgent(target, explicitModel, agent)
    && (!target.pricing?.modelVendors?.[explicitModel]?.vendor
      || !target.pricing.modelVendors[explicitModel]?.priceEntryId)) {
    // 价格映射是计费元数据：缺失只告警，不让供应商整体不合格——
    // 否则计费配置中间态会触发 CLI 同步 fail-safe 跳写甚至清理层（2026-09-01 实证事故）。
    warnings.push(modelPricingWarning(target));
  }
  if (!defaultModelOf(target, agent)) {
    warnings.push(noModelsWarning(target));
    return false;
  }
  return true;
}

/** 返回 Agent 接入范围内全部合格供应商（默认供应商缺失时按默认供应商回退）。 */
export function boundTargetsForAgent(
  config: ProxyConfig,
  agent: AgentId,
  defaultTarget: ProxyTarget | undefined,
  warnings: CliSyncWarning[],
  agentLabel: (id: AgentId) => string,
): ProxyTarget[] {
  const connection = config.agentConnections[agent];
  const boundTargetIds = connection?.boundTargetIds?.length
    ? connection.boundTargetIds
    : defaultTarget ? [defaultTarget.id] : [];
  return config.targets.filter(target =>
    boundTargetIds.includes(target.id)
    && targetEligibleForAgent(target, agent, warnings, agentLabel));
}

function protocolWarning(target: ProxyTarget, clientName: string): CliSyncWarning {
  return {
    targetId: target.id,
    code: "PROTOCOL_EXCLUDED",
    message: `${target.name} 未配置 ${clientName} 协议上游 URL，已从配置同步中排除`,
  };
}

function credentialWarning(target: ProxyTarget): CliSyncWarning {
  return {targetId: target.id, code: "CREDENTIAL_MISSING", message: `${target.name} 未配置该 Agent 的默认系统凭据`};
}

function noModelsWarning(target: ProxyTarget): CliSyncWarning {
  return {targetId: target.id, code: "NO_MODELS", message: `${target.name} 未配置该 Agent 的默认模型`};
}

function modelPricingWarning(target: ProxyTarget): CliSyncWarning {
  return {targetId: target.id, code: "MODEL_PRICE_MAPPING_REQUIRED", message: `${target.name} 的默认模型缺少价格中心映射`};
}
