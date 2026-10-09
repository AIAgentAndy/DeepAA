/**
 * 按量促销展示共享模块（2026-10-09 F7 用户确认）：「密钥与模型」页签显示生效中的
 * 促销价（牌价划线 + 促销价 + 期限）。pricing.ts 是 node 运行时模块（fs/crypto），
 * 客户端组件只能 type-only 引用——本模块以纯函数复刻入账端 activePaygPromotion /
 * overlaySparseRates 的「当前时刻」语义，两者一致性由守卫测试
 * tests/promotion-display.test.ts 锁定（同输入断言同结果）。
 */
import type {ModelPriceEntry, PaygPromotion, PricingRates, SparsePricingRates} from "@/lib/pricing";

/** 当前时刻命中的促销：models 缺省匹配条目全部模型、agents 缺省不限（传入目标
 *  服务的 Agent 集合做交集判定），from（含）≤ now ≤ to（含，缺省无限期）；
 *  多条命中取第一条（与入账端一致）。 */
export function activeDisplayPromotion(
  entry: ModelPriceEntry | undefined,
  now: Date = new Date(),
  agentNames?: readonly string[],
): PaygPromotion | undefined {
  const promotions = entry?.promotions ?? [];
  if (promotions.length === 0) return undefined;
  const time = now.getTime();
  if (!Number.isFinite(time)) return undefined;
  const entryModels = [entry?.runtimeModelId, entry?.match, ...(entry?.patterns ?? []), ...(entry?.aliases ?? [])]
    .map(term => (typeof term === "string" ? term.trim().toLowerCase() : ""))
    .filter(term => term.length > 0);
  const scopeAgents = (agentNames ?? [])
    .map(agent => agent.trim().toLowerCase())
    .filter(agent => agent.length > 0);
  for (const promotion of promotions) {
    if (promotion.models?.length
      && !promotion.models.some(model => entryModels.includes(model.trim().toLowerCase()))) continue;
    if (promotion.agents?.length
      && !promotion.agents.some(agent => scopeAgents.includes(agent.trim().toLowerCase()))) continue;
    const from = new Date(promotion.from).getTime();
    if (!Number.isFinite(from) || time < from) continue;
    if (promotion.to !== undefined) {
      const to = new Date(promotion.to).getTime();
      if (!Number.isFinite(to) || time > to) continue;
    }
    return promotion;
  }
  return undefined;
}

/** 促销价 = 牌价字段级稀疏覆盖（与入账端 overlaySparseRates 逐字段一致；未覆盖字段保留牌价）。 */
export function overlayDisplayRates(base: PricingRates, override: SparsePricingRates): PricingRates {
  return {
    ...base,
    ...(override.input !== undefined ? {input: override.input} : {}),
    ...(override.output !== undefined ? {output: override.output} : {}),
    ...(override.cachedInput !== undefined ? {cachedInput: override.cachedInput} : {}),
    ...(override.cacheWrite !== undefined ? {cacheWrite: override.cacheWrite} : {}),
    ...(override.cacheWrite5m !== undefined ? {cacheWrite5m: override.cacheWrite5m} : {}),
    ...(override.cacheWrite1h !== undefined ? {cacheWrite1h: override.cacheWrite1h} : {}),
  };
}

/** 促销期限文案：无限期 → "限时促销"；有终点 → "至 yyyy-MM-DD"（本地时区日期）。 */
export function promotionWindowLabel(promotion: PaygPromotion): string {
  if (promotion.to === undefined) return "限时促销";
  const to = new Date(promotion.to);
  return Number.isFinite(to.getTime())
    ? `至 ${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}-${String(to.getDate()).padStart(2, "0")}`
    : "限时促销";
}
