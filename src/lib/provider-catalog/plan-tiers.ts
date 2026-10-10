import type {ProviderPlanTier} from "./types";

/** 套餐付款周期（2026-10-10 智谱 Coding Plan）：目录档位 billingCycles 的键值域。 */
export type PlanBillingCycle = "monthly" | "quarterly" | "yearly";

/**
 * 按付款周期解析档位折算月价（纯函数，供同步引擎与 UI 共用）：
 * 优先取目录 billingCycles 对应周期的折算月价（如 Pro 按季 430.4），
 * 档位未维护该周期或缺省周期时回退 monthlyFee（= 按月价）。
 * 注意 0 是合法价格（免费档），不得当作缺失回退。
 */
export function resolvePlanTierFee(tier: ProviderPlanTier, cycle?: PlanBillingCycle): number {
  const fee = cycle === undefined ? undefined : tier.billingCycles?.[cycle];
  return fee !== undefined ? fee : tier.monthlyFee;
}

/**
 * 套餐档位月费匹配（纯函数，供同步引擎与 UI 共用）：
 * 套餐同步返回的 planName 与目录维护的档位表按「先精确、后包含」匹配。
 * 包含匹配必须唯一命中才返回——套餐名未带档位（如固定的「Kimi For Coding」）
 * 而档位表有多个档位时视为歧义，不自动回填，由用户手动录入。
 * cycle（2026-10-10）传入时按付款周期取折算月价，缺省保持按月价兼容旧行为。
 */
export function matchPlanTierMonthlyFee(
  tiers: readonly ProviderPlanTier[],
  planNames: ReadonlyArray<string | null | undefined>,
  cycle?: PlanBillingCycle,
): number | undefined {
  const normalizedNames = planNames
    .map(name => normalizeTierText(name))
    .filter((value): value is string => value.length > 0);
  if (normalizedNames.length === 0 || tiers.length === 0) return undefined;

  for (const planName of normalizedNames) {
    const exact = tiers.find(tier => normalizeTierText(tier.name) === planName);
    if (exact) return resolvePlanTierFee(exact, cycle);
  }
  for (const planName of normalizedNames) {
    const matches = tiers.filter(tier => {
      const tierName = normalizeTierText(tier.name);
      // 短名（≤2 字符）不做包含匹配，避免 "ro" 之类的误命中。
      if (!tierName || tierName.length <= 2) return false;
      return planName.includes(tierName) || tierName.includes(planName);
    });
    if (matches.length === 1) return resolvePlanTierFee(matches[0]!, cycle);
  }
  return undefined;
}

function normalizeTierText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/gu, "");
}
