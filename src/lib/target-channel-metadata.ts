/** 供应商计费通道元数据：B 方案下每个代理供应商只代表一个计费通道。 */

import {PROVIDER_PRESETS} from "@/lib/provider-presets";
import {PROVIDER_PLUGINS} from "@/lib/provider-plugins/meta";
import type {BillingChannel, ProxyTarget} from "@/types";

export interface TargetChannelMetadata {
  billingChannel: BillingChannel;
  vendorFamily?: string;
}

const BILLING_CHANNELS = new Set<BillingChannel>(["pay_as_you_go", "plan", "subscription"]);

/** URL 规则唯一来源已收敛到 provider-plugins/meta（P1-9），这里按声明顺序编译。 */
const URL_BILLING_CHANNEL_RULES: ReadonlyArray<{pattern: RegExp; channel: BillingChannel}> =
  PROVIDER_PLUGINS
    .filter(plugin => plugin.urlChannelPattern)
    .map(plugin => ({
      pattern: new RegExp(plugin.urlChannelPattern!, "i"),
      channel: plugin.urlChannel! as BillingChannel,
    }));

const URL_VENDOR_FAMILY_RULES: ReadonlyArray<{pattern: RegExp; family: string}> =
  PROVIDER_PLUGINS
    .filter(plugin => plugin.urlFamilyPattern)
    .map(plugin => ({
      pattern: new RegExp(plugin.urlFamilyPattern!, "i"),
      family: plugin.family,
    }));

/** 归一化计费通道；非法值返回 undefined，由调用方决定回退推断。 */
export function normalizeBillingChannel(value: unknown): BillingChannel | undefined {
  return typeof value === "string" && BILLING_CHANNELS.has(value as BillingChannel)
    ? (value as BillingChannel)
    : undefined;
}

/** 归一化供应商族；只允许小写字母、数字与连字符。 */
export function normalizeVendorFamily(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * 推断供应商通道元数据：预设优先；自定义供应商按套餐 URL 规则识别 billingChannel，
 * vendorFamily 依次按 URL 规则、pricing.vendor 兜底。推断只影响展示与统计归集，不参与网关路由。
 */
export function inferTargetChannelMetadata(
  target: Pick<ProxyTarget, "presetId" | "pricing" | "openaiUrl" | "anthropicUrl">,
): TargetChannelMetadata {
  const preset = target.presetId
    ? PROVIDER_PRESETS.find(item => item.id === target.presetId)
    : undefined;
  if (preset) {
    return {
      billingChannel: preset.billingChannel,
      vendorFamily: preset.vendorFamily,
    };
  }
  const urls = `${target.openaiUrl || ""} ${target.anthropicUrl || ""}`.toLowerCase();
  const billingChannel = URL_BILLING_CHANNEL_RULES.find(rule => rule.pattern.test(urls))?.channel ?? "pay_as_you_go";
  const vendorFamily = URL_VENDOR_FAMILY_RULES.find(rule => rule.pattern.test(urls))?.family
    ?? normalizeVendorFamily(target.pricing?.vendor);
  return {
    billingChannel,
    ...(vendorFamily ? {vendorFamily} : {}),
  };
}
