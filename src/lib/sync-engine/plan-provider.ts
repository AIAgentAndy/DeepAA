import type {BillingChannel, ProxyTarget} from "@/types";
import type {PlanProviderType} from "./types";
import {PLAN_VENDOR_ALIASES_FROM_PLUGINS, PROVIDER_PLUGINS} from "../provider-plugins/meta";

/** 供应商 pricing.vendor / 显式 vendor 到套餐适配器的稳定映射（派生自 provider-plugins）。 */
const PLAN_VENDOR_ALIASES: Record<string, PlanProviderType> =
  PLAN_VENDOR_ALIASES_FROM_PLUGINS as Record<string, PlanProviderType>;

const PLAN_URL_ROUTES = PROVIDER_PLUGINS
  .filter(plugin => plugin.plan)
  .map(plugin => ({
    type: plugin.plan!.type as PlanProviderType,
    needles: plugin.plan!.urlNeedles,
    gatedNeedles: plugin.plan!.subscriptionGatedUrlNeedles ?? [],
  }));

/**
 * 套餐模块必须与供应商精准匹配：只有声明 planSync 适配器的供应商才允许
 * 展示套餐配置；DeepSeek、OpenAI、Anthropic 等不返回任何适配器。
 */
export function resolvePlanProviderForTarget(
  target: Pick<ProxyTarget, "pricing" | "openaiUrl" | "anthropicUrl" | "presetId" | "billingChannel">,
): PlanProviderType | undefined {
  if (target.billingChannel === "plan") {
    if (target.presetId === "volcengine-coding-plan") return "volcengine-coding-plan";
    if (target.presetId === "qwenai-token-plan") return "qwenai-token-plan";
  }
  const vendor = target.pricing?.vendor?.trim().toLowerCase();
  if (vendor === "volcengine-coding-plan") return "volcengine-coding-plan";
  if (vendor && PLAN_VENDOR_ALIASES[vendor]) {
    const provider = PLAN_VENDOR_ALIASES[vendor];
    // 套餐适配器只允许显式 plan 通道；按量目标不能因为 vendor/URL
    // 共享而误展示套餐同步入口（例如 Moonshot、智谱、MiniMax、千问）。
    if (provider !== "openai-subscription"
      && provider !== "anthropic-subscription"
      && target.billingChannel !== undefined
      && target.billingChannel !== "plan") {
      return undefined;
    }
    // OpenAI/Anthropic 的 vendor 值按量与订阅共用：只有显式订阅元数据才允许命中订阅适配器。
    if (provider === "openai-subscription" && !isExplicitSubscription(target, "openai-subscription")) {
      return undefined;
    }
    if (provider === "anthropic-subscription" && !isExplicitSubscription(target, "anthropic-subscription")) {
      return undefined;
    }
    return provider;
  }

  const urls = `${target.openaiUrl || ""} ${target.anthropicUrl || ""}`.toLowerCase();
  if (target.billingChannel === "plan" && urls.includes("volces.com/api/coding")) {
    return "volcengine-coding-plan";
  }
  for (const route of PLAN_URL_ROUTES) {
    if (route.needles.some(needle => urls.includes(needle))) {
      if (route.type !== "openai-subscription"
        && route.type !== "anthropic-subscription"
        && target.billingChannel !== undefined
        && target.billingChannel !== "plan") {
        return undefined;
      }
      return route.type as PlanProviderType;
    }
  }
  // chatgpt.com/backend-api/codex 是订阅专用地址，可无条件命中；
  // api.openai.com / api.anthropic.com 被按量与订阅共用，必须显式订阅元数据。
  for (const route of PLAN_URL_ROUTES) {
    if (
      route.gatedNeedles.length > 0
      && (route.type === "openai-subscription" || route.type === "anthropic-subscription")
      && route.gatedNeedles.some(needle => urls.includes(needle))
      && isExplicitSubscription(target, route.type)
    ) {
      return route.type;
    }
  }
  return undefined;
}

/** 订阅通道门控：只有预设明确为订阅或供应商计费通道为订阅时才允许自动命中。 */
function isExplicitSubscription(
  target: {presetId?: string; billingChannel?: BillingChannel},
  presetId: "openai-subscription" | "anthropic-subscription",
): boolean {
  return target.presetId === presetId || target.billingChannel === "subscription";
}
