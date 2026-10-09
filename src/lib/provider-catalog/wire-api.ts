import {AGENT_REGISTRY} from "@/lib/agent-registry";
import {
  availableWireApisForAgent,
  resolveOfficialPresetForTarget,
  resolveTargetAgentCapability,
} from "@/lib/provider-preset-capabilities";
import type {AgentId, ProxyTarget, WireApi} from "@/types";
import type {ProviderCatalogModel, ProviderCatalogProvider} from "./types";

/**
 * 模型 wire API 声明解析：
 * 1. 目录模型显式 supportedWireApis 优先；
 * 2. 官方预设未声明时继承预设能力（openaiWireApis + 可用 anthropic URL 的 messages）；
 * 3. 未知/非预设模型缺省 []，不得因供应商同时配置两种协议 URL 就自动推断全部协议。
 */
export function modelWireApisForTarget(
  provider: ProviderCatalogProvider,
  model: ProviderCatalogModel,
  target?: Pick<ProxyTarget, "openaiUrl" | "anthropicUrl" | "presetId" | "billingChannel">,
): WireApi[] {
  if (model.supportedWireApis?.length) return [...model.supportedWireApis] as WireApi[];
  const identity = target ?? {openaiUrl: provider.openaiUrl, anthropicUrl: provider.anthropicUrl};
  const preset = resolveOfficialPresetForTarget(identity);
  if (!preset) return [];
  const wireApis = new Set<WireApi>((preset.openaiWireApis ?? []) as WireApi[]);
  if (identity.anthropicUrl?.trim()) wireApis.add("messages");
  return [...wireApis];
}

/**
 * 目录模型对供应商可用 Agent 的适用：Agent 供应商 binding 可用且 binding wire API
 * 与模型 wire API 有交集才开放；缺省/空声明一律不允许（默认拒绝）。
 */
export function supportedAgentsForCatalogModel(
  provider: ProviderCatalogProvider,
  model: ProviderCatalogModel,
  target?: Pick<ProxyTarget, "openaiUrl" | "anthropicUrl" | "presetId" | "billingChannel">,
): AgentId[] {
  const identity = target ?? {openaiUrl: provider.openaiUrl, anthropicUrl: provider.anthropicUrl};
  const modelWireApis = modelWireApisForTarget(provider, model, identity);
  if (modelWireApis.length === 0) return [];
  return AGENT_REGISTRY.filter(agent => {
    if (!resolveTargetAgentCapability(identity, agent.id).supported) return false;
    const bindingWireApis = availableWireApisForAgent(identity, agent.id);
    return modelWireApis.some(wireApi => bindingWireApis.includes(wireApi));
  }).map(agent => agent.id);
}
