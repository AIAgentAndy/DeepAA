import {buildGatewayModelId} from "@/proxy/gateway-prefix";
import {agentBindings, targetHasBindingForAgent} from "@/lib/agent-registry";
import {agentScopeIncludes, type AgentId, type ProxyConfig, type ProxyTarget, type WireApi} from "@/types";
import {getAgentReadiness, resolveTargetModelWireApis} from "@/lib/proxy-management-domain";
import type {DevelopmentCredentialMetadata} from "@/lib/development-launch/types";

export type AgentConnectionStatus = "disconnected" | "pending" | "ready";

export type AgentConnectionReasonCode =
  | "AGENT_NOT_CONNECTED"
  | "DEFAULT_TARGET_REQUIRED"
  | "DEFAULT_TARGET_NOT_FOUND"
  | "DEFAULT_TARGET_NOT_BOUND"
  | "TARGET_DISABLED"
  | "PROTOCOL_URL_REQUIRED"
  | "DEFAULT_MODEL_REQUIRED"
  | "DEFAULT_MODEL_NOT_SUPPORTED"
  | "DEFAULT_MODEL_AGENT_SCOPE_MISMATCH"
  | "DEFAULT_MODEL_WIRE_API_MISMATCH"
  | "DEFAULT_MODEL_PRICE_MAPPING_REQUIRED"
  | "DEFAULT_CREDENTIAL_REQUIRED"
  | "DEFAULT_CREDENTIAL_NOT_FOUND"
  | "DEFAULT_CREDENTIAL_AGENT_SCOPE_MISMATCH"
  | "CLI_SYNC_DISABLED"
  | "CLI_SYNC_TARGET_EXCLUDED";

export interface AgentConnectionMissingItem {
  code: AgentConnectionReasonCode;
  label: string;
}

export interface ResolvedAgentConnection {
  agent: AgentId;
  status: AgentConnectionStatus;
  connection?: ProxyConfig["agentConnections"][AgentId];
  target?: ProxyTarget;
  defaultModel?: string;
  defaultGatewayModel?: string;
  defaultCredentialId?: string;
  proxyReady: boolean;
  cliSyncEnabled: boolean;
  cliSyncReady: boolean;
  missing: AgentConnectionMissingItem[];
  reasonCodes: AgentConnectionReasonCode[];
}

/**
 * 统一解析 Agent 的默认访问链。
 * 该函数只接收配置和脱敏凭据元数据，不访问文件、系统钥匙串、网络或数据库，
 * 使页面、CLI 同步和开发启动可以共享完全一致的状态判断。
 */
export function resolveAgentConnection(
  config: ProxyConfig,
  agent: AgentId,
  credentials: readonly DevelopmentCredentialMetadata[] = [],
): ResolvedAgentConnection {
  const connection = config.agentConnections?.[agent];
  if (!connection) {
    return {
      agent,
      status: "disconnected",
      proxyReady: false,
      cliSyncEnabled: false,
      cliSyncReady: false,
      missing: [{code: "AGENT_NOT_CONNECTED", label: "尚未接入该 Agent"}],
      reasonCodes: ["AGENT_NOT_CONNECTED"],
    };
  }

  const reasonCodes: AgentConnectionReasonCode[] = [];
  const missing: AgentConnectionMissingItem[] = [];
  const targetId = connection.defaultTargetId;
  const target = targetId ? config.targets?.find(item => item.id === targetId) : undefined;

  if (!targetId) {
    addMissing(reasonCodes, missing, "DEFAULT_TARGET_REQUIRED", "请选择默认供应商");
  } else if (!target) {
    addMissing(reasonCodes, missing, "DEFAULT_TARGET_NOT_FOUND", "默认供应商不存在");
  } else {
    if (!target.enabled) addMissing(reasonCodes, missing, "TARGET_DISABLED", "默认供应商已停用");
    if (!targetHasBindingForAgent(target, agent)) {
      addMissing(reasonCodes, missing, "PROTOCOL_URL_REQUIRED", "该 Agent 所有 binding 的协议上游 URL 均未配置");
    }
  }

  let defaultModel: string | undefined;
  let defaultCredentialId: string | undefined;
  let bindingWireApis: readonly WireApi[] = [];
  if (target) {
    bindingWireApis = agentBindings(agent)
      .filter(binding => binding.protocol === "openai"
        ? Boolean(target.openaiUrl?.trim())
        : Boolean(target.anthropicUrl?.trim()))
      .map(binding => binding.wireApi);
    const models = (target.supportedModels || []).filter(model => modelAllowedForAgent(target, model, agent));
    defaultModel = target.development?.defaultModels?.[agent];
    if (!defaultModel) {
      addMissing(reasonCodes, missing, "DEFAULT_MODEL_REQUIRED", "请选择该 Agent 的默认模型");
    } else if (!(target.supportedModels || []).includes(defaultModel)) {
      addMissing(reasonCodes, missing, "DEFAULT_MODEL_NOT_SUPPORTED", "默认模型不在供应商支持列表中");
    } else if (!models.includes(defaultModel)) {
      addMissing(reasonCodes, missing, "DEFAULT_MODEL_AGENT_SCOPE_MISMATCH", "默认模型不属于该 Agent");
    } else if (!modelWireApiAllowed(defaultModel, bindingWireApis, target)) {
      addMissing(reasonCodes, missing, "DEFAULT_MODEL_WIRE_API_MISMATCH", "默认模型不支持该 Agent 当前可用的协议路径");
    } else if (!target.pricing?.modelVendors?.[defaultModel]?.vendor
      || !target.pricing.modelVendors[defaultModel]?.priceEntryId) {
      addMissing(reasonCodes, missing, "DEFAULT_MODEL_PRICE_MAPPING_REQUIRED", "默认模型缺少价格中心映射");
    }
    if (models.length === 0 && !reasonCodes.includes("DEFAULT_MODEL_AGENT_SCOPE_MISMATCH")) {
      addMissing(reasonCodes, missing, "DEFAULT_MODEL_NOT_SUPPORTED", "该供应商没有可用模型");
    }

    defaultCredentialId = target.development?.defaultCredentials?.[agent];
    if (!defaultCredentialId) {
      addMissing(reasonCodes, missing, "DEFAULT_CREDENTIAL_REQUIRED", "请选择该 Agent 的默认密钥");
    } else {
      const credential = credentials.find(item => item.id === defaultCredentialId && item.targetId === target.id);
      if (!credential) {
        addMissing(reasonCodes, missing, "DEFAULT_CREDENTIAL_NOT_FOUND", "默认密钥不存在");
      } else if (!agentScopeIncludes(credential.agentScope, agent)) {
        addMissing(reasonCodes, missing, "DEFAULT_CREDENTIAL_AGENT_SCOPE_MISMATCH", "默认密钥不属于该 Agent");
      }
    }
  }

  const baseProxyReady = Boolean(
    target
    && target.enabled
    && targetHasBindingForAgent(target, agent)
    && defaultModel
    && (target.supportedModels || []).includes(defaultModel)
    && modelAllowedForAgent(target, defaultModel, agent)
    && modelWireApiAllowed(defaultModel, bindingWireApis, target)
    && Boolean(target.pricing?.modelVendors?.[defaultModel]?.vendor && target.pricing.modelVendors[defaultModel]?.priceEntryId)
    && defaultCredentialId
    && credentials.some(item => item.id === defaultCredentialId && item.targetId === target.id && agentScopeIncludes(item.agentScope, agent)),
  );

  const cliSyncEnabled = connection.cliSyncEnabled === true;
  if (!cliSyncEnabled) reasonCodes.push("CLI_SYNC_DISABLED");
  const domainReady = getAgentReadiness(
    config,
    agent,
    new Set(credentials.filter(item => item.targetId === target?.id).map(item => item.id)),
  ).ready;
  const proxyReady = baseProxyReady && domainReady;
  const cliSyncReady = proxyReady && domainReady && cliSyncEnabled && Boolean(target && !target.cliSyncExclusions?.includes(agent));
  if (connection.defaultTargetId && target && !(connection.boundTargetIds || [target.id]).includes(target.id)) {
    addMissing(reasonCodes, missing, "DEFAULT_TARGET_NOT_BOUND", "默认供应商未加入该 Agent 接入范围");
  }
  if (proxyReady && cliSyncEnabled && target?.cliSyncExclusions?.includes(agent)) {
    reasonCodes.push("CLI_SYNC_TARGET_EXCLUDED");
  }

  return {
    agent,
    status: proxyReady ? "ready" : "pending",
    connection,
    target,
    defaultModel,
    defaultGatewayModel: target && defaultModel ? buildGatewayModelId(target.id, defaultModel) : undefined,
    defaultCredentialId,
    proxyReady,
    cliSyncEnabled,
    cliSyncReady,
    missing,
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function modelAllowedForAgent(target: ProxyTarget, modelId: string, agent: AgentId): boolean {
  return agentScopeIncludes(target.supportedModelScopes?.[modelId], agent);
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

function addMissing(
  reasonCodes: AgentConnectionReasonCode[],
  missing: AgentConnectionMissingItem[],
  code: AgentConnectionReasonCode,
  label: string,
): void {
  if (reasonCodes.includes(code)) return;
  reasonCodes.push(code);
  missing.push({code, label});
}
