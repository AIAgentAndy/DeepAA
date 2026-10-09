/**
 * 目录 v2 有限规则 DSL 的公共工具（设计 4.5/10.3）：只定义有限原语（比例、时间窗、
 * 作用域），不执行任意表达式。供 normalize / static-validator / compiler 共用。
 */
import type {CampaignRatio, CatalogCampaign} from "./types";

/** 比例归一：数字原样；分数对象要求分母 > 0，返回 numerator/denominator。 */
export function resolveCampaignRatio(value: CampaignRatio, path: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${path} 必须是非负有限数值`);
    return value;
  }
  const {numerator, denominator} = value;
  if (typeof numerator !== "number" || typeof denominator !== "number"
    || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0 || numerator < 0) {
    throw new Error(`${path} 分数必须满足 numerator ≥ 0 且 denominator > 0`);
  }
  return numerator / denominator;
}

/** 数值等价容差（迁移/精化判定，深检 2）：绝对差 ≤ 0.01 或相对差 ≤ 0.5%（取大者）。 */
export function withinMigrationTolerance(before: number, after: number): boolean {
  if (before === after) return true;
  const absolute = Math.abs(before - after);
  const relative = Math.abs(before) > 0 ? absolute / Math.abs(before) : Number.POSITIVE_INFINITY;
  return absolute <= 0.01 || relative <= 0.005;
}

/** 活动稳定排序：priority 降序（缺省 0），同优先级按 id 保证确定性。 */
export function sortCampaignsByPriority(campaigns: CatalogCampaign[]): CatalogCampaign[] {
  return [...campaigns].sort((left, right) =>
    (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));
}

/** 活动作用域是否含有效边界（5.2 规则 4：免费/×0/封顶/大额加成必须有边界）。 */
export function campaignHasBoundary(campaign: CatalogCampaign): boolean {
  const scope = campaign.scope;
  if (scope?.models?.length || scope?.agents?.length || scope?.modelGroups?.length || scope?.agentGroups?.length) return true;
  if (campaign.period.to !== undefined) return true;
  if (campaign.recurringWindows?.length) return true;
  return false;
}

/** 规则层通道短名 → 运行时通道全名（payg ↔ pay_as_you_go 固定映射，设计 4.5）。 */
export function campaignChannelToBillingChannel(channel: CatalogCampaign["channel"]): "pay_as_you_go" | "plan" | "subscription" {
  return channel === "payg" ? "pay_as_you_go" : channel;
}
