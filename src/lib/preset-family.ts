/** 供应商族展示元数据：侧栏分组标题、下拉分组标题与通道标识文案。 */
import type {BillingChannel} from "@/types";
import {PRESET_FAMILY_LABELS_FROM_PLUGINS} from "@/lib/provider-plugins/meta";

/** 族标签唯一来源已收敛到 provider-plugins/meta（P1-9）。 */
export const PRESET_FAMILY_LABELS: Record<string, string> = PRESET_FAMILY_LABELS_FROM_PLUGINS;

export function presetFamilyLabel(family: string): string {
  return PRESET_FAMILY_LABELS[family] || family;
}

/** 计费通道短标签，用于下拉选项与详情徽标。 */
export function billingChannelLabel(channel: BillingChannel): string {
  return channel === "plan" ? "套餐" : channel === "subscription" ? "订阅" : "按量";
}
