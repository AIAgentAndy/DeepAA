/**
 * 订阅预设路由判据（2026-10-08 用户确认，取代「默认目标必须是订阅」的旧耦合）。
 *
 * 混合路由形态：codex/claude 的 CLI 凭据形态（OAuth 透传 vs 占位 token）按
 * 「目录里是否存在订阅预设路由模型 + 本机 CLI 已登录」决定，默认目标可为任意
 * 供应商。判据必须精确匹配订阅预设 id——opencode-go 等 plan 通道（档位化市价
 * 份额、密钥注入计费）永不命中；订阅预设与 Agent 的对应关系由声明表维护，
 * 新增订阅预设加一行（Agent 扩展面守卫同款 ratchet 风格）。
 */
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {
  agentScopeIncludes,
  type AgentId,
  type ProxyConfig,
  type ProxyTarget,
} from "@/types";

/** 订阅预设 id → 需要透传其登录态的官方 CLI Agent；扩展新订阅预设加一行。 */
const SUBSCRIPTION_PRESET_AGENTS: Readonly<Record<string, AgentId>> = {
  "openai-subscription": "codex",
  "anthropic-subscription": "claude",
};

/**
 * 目标是否为指定订阅预设、且对对应 Agent 至少暴露一个 scope 内模型
 * （零模型的目标不进目录，OAuth 形态对它无受益者）。
 */
export function isSubscriptionPresetRouteTarget(target: ProxyTarget, presetId: string): boolean {
  const agent = SUBSCRIPTION_PRESET_AGENTS[presetId];
  if (!agent) return false;
  return resolveOfficialPresetForTarget(target)?.id === presetId
    && target.supportedModels.some(model => agentScopeIncludes(target.supportedModelScopes?.[model], agent));
}

/**
 * 轻量预检（无 warning 副作用，供 sync-manager 决定是否值得探测 CLI 登录态）：
 * 配置里是否存在启用中的该订阅预设路由目标。授权判据仍以适配器内
 * boundTargets 的合格性为准，此处只做保守预过滤。
 */
export function hasSubscriptionPresetRoute(config: ProxyConfig, presetId: string): boolean {
  return config.targets.some(target => target.enabled && isSubscriptionPresetRouteTarget(target, presetId));
}
