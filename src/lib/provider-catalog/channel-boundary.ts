/**
 * 三条计费通道的输入边界（设计 5.3/10.3）：PAYG Campaign 只作用于按量链；
 * Plan Calculator 只读官方基础牌价（money_to_credits 严禁读 PAYG 生效价）；
 * Subscription 只保留观察窗口语义。纯函数模块，供 exchange-processor 与测试共用。
 *
 * 注意依赖方向：@/lib/pricing 不得 import 本模块（provider-catalog → pricing 单向）；
 * pricing.ts 内的促销通道闸门为本模块语义的内联实现（见 computeTokenCost 注释）。
 */
import type {PricingRates} from "@/lib/pricing";

/**
 * PAYG Campaign 作用链判定：仅 billingChannel=pay_as_you_go（缺省按 payg 处理，
 * 保留 UI 估算等无通道调用方行为）；plan/subscription 通道一律不套用按量促销。
 */
export function isPaygCampaignLane(billingChannel: string | undefined): boolean {
  return billingChannel !== "plan" && billingChannel !== "subscription";
}

/**
 * Plan Calculator（money_to_credits）换算输入：只允许官方基础牌价（entry.pricing 原始
 * 快照）；条目缺失牌价时才允许快照 baseRates 兜底（此时它未叠加促销/时段，仍为牌价口径）。
 */
export function planCalculatorBaseRates(
  entryPricing: PricingRates | undefined,
  snapshotBaseRates: PricingRates | undefined,
): PricingRates | undefined {
  return entryPricing ?? snapshotBaseRates;
}
