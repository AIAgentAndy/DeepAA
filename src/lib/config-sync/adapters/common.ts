import {availableWireApisForAgent} from "@/lib/provider-preset-capabilities";
import {agentLabel} from "@/lib/agent-registry";
import {resolveTargetModelWireApis} from "@/lib/proxy-management-domain";
import type {
  AgentCliPlan,
  CliSyncContext,
  CliSyncWarning,
} from "@/lib/config-sync/core/types";
import {
  boundTargetsForAgent,
  defaultModelOf,
  modelAllowedForAgent,
  resolveSyncDefaultTarget,
} from "@/lib/config-sync/core/target-eligibility";
import type {AgentId, ProxyConfig, ProxyTarget, WireApi} from "@/types";

/** Agent 是否显式断开：未接入或关闭 CLI 同步；只有该状态允许清理层移除受管分节。 */
export function explicitlyDisconnected(config: ProxyConfig, agent: AgentId): boolean {
  const connection = config.agentConnections[agent];
  return !connection || !connection.cliSyncEnabled;
}

/**
 * 开发启动偏好：按网关模型 ID（<模型ID>_<目标路由ID>）覆盖上下文窗口。
 * 键为「供应商目标 + 模型」复合键（2026-10-02 用户确认统一规范）：同一模型
 * 跨目标可各自覆盖（如中转站简配 272000 vs 官方 1024000）。
 */
export function launchPreferenceContextWindow(
  preferences: {contextWindows?: Record<string, number>} | undefined | null,
  gatewayModelId: string,
): number | undefined {
  const value = preferences?.contextWindows?.[gatewayModelId];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 开发启动偏好：按网关模型 ID 覆盖自动压缩阈值（当前仅 codex 目录条目消费）。 */
export function launchPreferenceAutoCompactLimit(
  preferences: {autoCompactTokenLimits?: Record<string, number>} | undefined | null,
  gatewayModelId: string,
): number | undefined {
  const value = preferences?.autoCompactTokenLimits?.[gatewayModelId];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 链路瞬时不合格的保守计划：跳过该 Agent 的一切文件写入（既不写受管配置，
 * 也不写清理层），保留磁盘现状并透出已收集的 warning。计费元数据缺失、默认
 * 供应商中间态、模型 wire API 不合格等瞬态绝不能触发破坏性清理。
 */
export function preservePlan(agent: AgentId, warnings: CliSyncWarning[]): AgentCliPlan {
  return {
    agent,
    active: false,
    preserve: true,
    artifacts: [],
    warnings,
    notes: [
      "默认链路瞬时不合格，已跳过写入并保留现有配置；显式断开接入或关闭同步才会写清理层。",
    ],
  };
}

/** 返回模型允许且与供应商可用 binding 相交的 wire API（声明 → 预设级 → URL 推断）。 */
export function modelWireApisForTarget(
  target: ProxyTarget,
  modelId: string,
  agent: AgentId,
): WireApi[] {
  const available = availableWireApisForAgent(target, agent);
  const modelWireApis = resolveTargetModelWireApis(target, modelId);
  return available.filter(wireApi => modelWireApis.includes(wireApi));
}

/** 返回供应商中同时满足 Agent scope 与指定 wire API 的模型列表。 */
export function modelsForAgentWireApi(
  target: ProxyTarget,
  agent: AgentId,
  wireApi: WireApi,
): string[] {
  return target.supportedModels.filter(modelId =>
    modelAllowedForAgent(target, modelId, agent)
    && modelWireApisForTarget(target, modelId, agent).includes(wireApi));
}

/** 按注册表顺序选择 OpenCode 默认 wire API：显式偏好 > responses > chat > messages。 */
export function preferredWireApi(
  context: CliSyncContext,
  agent: AgentId,
  defaultTarget: ProxyTarget | undefined,
  order: readonly WireApi[],
): WireApi | undefined {
  const connection = context.config.agentConnections[agent];
  const explicit = connection?.preferredWireApi;
  if (!defaultTarget) return undefined;
  const defaultModel = defaultModelOf(defaultTarget, agent);
  if (!defaultModel) return undefined;
  if (explicit
    && modelWireApisForTarget(defaultTarget, defaultModel, agent).includes(explicit)) {
    return explicit;
  }
  const allowed = modelWireApisForTarget(defaultTarget, defaultModel, agent);
  return order.find(wireApi => allowed.includes(wireApi));
}

/** 统一的 Agent 标签回调，供共享供应商判定复用（注册表驱动）。 */
export function agentLabelOf(agent: AgentId): string {
  return agentLabel(agent);
}

export {
  boundTargetsForAgent,
  defaultModelOf,
  modelAllowedForAgent,
  resolveSyncDefaultTarget,
};

export type {CliSyncWarning};
