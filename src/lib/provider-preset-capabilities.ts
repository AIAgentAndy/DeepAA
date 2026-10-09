import {
  PROVIDER_PRESETS,
  type OpenAiWireApi,
  type ProviderPreset,
} from "@/lib/provider-presets";
import {agentById, agentBindings, type AgentAdapter, type AgentWireBinding} from "@/lib/agent-registry";
import type {AgentId, BillingChannel, WireApi} from "@/types";

export type TargetAgentCapabilityReason =
  | "MISSING_PROTOCOL_URL"
  | "PRESET_WIRE_API_UNSUPPORTED"
  | "SUBSCRIPTION_UNSUPPORTED";

export interface TargetAgentCapability {
  supported: boolean;
  presetId?: string;
  reason?: TargetAgentCapabilityReason;
  message?: string;
}

/** 按协议 + hostname + path 识别官方预设；只识别身份，不从预设补齐缺失的协议 URL。 */
export function resolveOfficialPresetForTarget(
  target: {openaiUrl?: string; anthropicUrl?: string; presetId?: string; billingChannel?: BillingChannel},
): ProviderPreset | undefined {
  const urls = [target.openaiUrl, target.anthropicUrl].filter((value): value is string => Boolean(value?.trim()));
  const urlMatch = PROVIDER_PRESETS.find(preset => urls.some(url =>
    (preset.openaiUrl && normalizePresetUrl(url) === normalizePresetUrl(preset.openaiUrl))
    || (preset.anthropicUrl && normalizePresetUrl(url) === normalizePresetUrl(preset.anthropicUrl)),
  ) && isPresetIdentityAllowed(preset, target));
  // 同一供应商的按量/套餐/订阅预设可能共享同一上游 URL（如 MiniMax 按量与 Token Plan、
  // api.anthropic.com 的按量/订阅）。供应商显式记录了 presetId 时优先按该预设消歧，
  // 避免能力归属被 URL 顺序命中成基础预设。
  if (target.presetId) {
    const explicit = PROVIDER_PRESETS.find(preset => preset.id === target.presetId && isPresetIdentityAllowed(preset, target));
    if (explicit) {
      const explicitUrls = [explicit.openaiUrl, explicit.anthropicUrl]
        .filter((value): value is string => Boolean(value?.trim()));
      if (explicitUrls.some(url => urls.some(candidate => normalizePresetUrl(candidate) === normalizePresetUrl(url)))) {
        return explicit;
      }
    }
  }
  return urlMatch;
}

/**
 * 订阅通道的身份识别需要额外闸门：api.anthropic.com 同时被按量自定义供应商使用，
 * 裸 URL 匹配不能把自定义按量供应商误判为 Claude 订阅；openai-subscription 的
 * chatgpt.com/backend-api/codex 是订阅专用地址，无需闸门。
 */
function isPresetIdentityAllowed(
  preset: ProviderPreset,
  target: {presetId?: string; billingChannel?: BillingChannel},
): boolean {
  if (preset.id !== "anthropic-subscription") return true;
  return target.presetId === "anthropic-subscription"
    || target.billingChannel === "subscription";
}

/**
 * 统一解析供应商对 Agent 的可用性。自定义供应商只要具备对应协议 URL 即保持可用；
 * 官方预设额外校验其声明的 wire API 能力，避免把 chat/completions 误当成 Responses。
 */
export function resolveTargetAgentCapability(
  target: {openaiUrl?: string; anthropicUrl?: string; presetId?: string; billingChannel?: BillingChannel},
  agent: AgentId | string,
): TargetAgentCapability {
  const adapter = agentById(agent);
  if (!adapter) {
    return {supported: false, reason: "MISSING_PROTOCOL_URL", message: "未知 Agent"};
  }
  const preset = resolveOfficialPresetForTarget(target);
  const available = adapter.bindings.some(binding => bindingAvailable(binding, target, preset));
  if (!available) {
    if (target.billingChannel === "subscription") {
      return {
        supported: false,
        presetId: preset?.id,
        reason: "SUBSCRIPTION_UNSUPPORTED",
        message: "当前供应商为订阅通道，该 Agent 首期不支持订阅透传",
      };
    }
    if (preset && adapter.bindings.some(binding =>
      binding.protocol === "openai"
      && binding.wireApi === "responses"
      && !preset.openaiWireApis?.includes("responses"),
    )) {
      return {
        supported: false,
        presetId: preset.id,
        reason: "PRESET_WIRE_API_UNSUPPORTED",
        message: "当前官方预设的 OpenAI 接口只支持 chat/completions，不支持该 Agent 的 Responses binding",
      };
    }
    const hasAnyUrl = Boolean(target.openaiUrl?.trim()) || Boolean(target.anthropicUrl?.trim());
    return {
      supported: false,
      reason: "MISSING_PROTOCOL_URL",
      message: hasAnyUrl ? "该 Agent 的所有 binding 协议 URL 均未配置" : "当前供应商未配置任何协议上游 URL",
    };
  }
  return {supported: true, presetId: preset?.id};
}

/** 单个 binding 是否可用：协议 URL 存在、官方预设允许该 wire API、订阅通道按 binding 放行。 */
function bindingAvailable(
  binding: AgentWireBinding,
  target: {openaiUrl?: string; anthropicUrl?: string; billingChannel?: BillingChannel},
  preset: ProviderPreset | undefined,
): boolean {
  const hasUrl = binding.protocol === "openai"
    ? Boolean(target.openaiUrl?.trim())
    : Boolean(target.anthropicUrl?.trim());
  if (!hasUrl) return false;
  if (preset && binding.protocol === "openai"
    && preset.openaiWireApis
    && !preset.openaiWireApis.includes(binding.wireApi as OpenAiWireApi)) {
    return false;
  }
  if (target.billingChannel === "subscription" && binding.supportsSubscription !== true) {
    return false;
  }
  return true;
}

/** 返回供应商对指定 Agent 当前可用的全部 wire API（binding 级别，不含模型声明）。 */
export function availableWireApisForAgent(
  target: {openaiUrl?: string; anthropicUrl?: string; billingChannel?: BillingChannel},
  agent: AgentId | string,
): WireApi[] {
  const adapter = agentById(agent);
  if (!adapter) return [];
  const preset = resolveOfficialPresetForTarget(target);
  return agentBindings(agent)
    .filter(binding => bindingAvailable(binding, target, preset))
    .map(binding => binding.wireApi);
}

export function targetHasPresetAwareProtocol(target: {openaiUrl?: string; anthropicUrl?: string}, agent: AgentId | string): boolean {
  return resolveTargetAgentCapability(target, agent).supported;
}

function normalizePresetUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim().replace(/\/+$/u, "").toLowerCase();
  }
}

export type {AgentAdapter};
