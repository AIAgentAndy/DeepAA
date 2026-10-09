/**
 * 客户端可安全引用的纯费率工具（2026-09-23 从 pricing.ts 拆出）：
 * pricing.ts 顶部含 fs/promises（服务端专用），客户端组件（如会话追踪的
 * harness-workbench）值引用其导出会让 Node 内置模块进入浏览器包、构建失败。
 * 本模块只含纯函数与纯类型，依赖仅限类型导入（编译期擦除，不产生运行时依赖）。
 * pricing.ts 原位 re-export 保持既有服务端导入路径不变。
 */
import type {LongContextPricingTier} from "../types";
import type {PricingRates} from "./pricing";

/** 快照里的长上下文档位命中信息（审计与展示用）。 */
export interface LongContextMatchInfo {
  thresholdTokens: number;
  contextTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

/**
 * 展示端复用的长上下文判档与换档单价（2026-09-22，与 costFromRates 派生口径一致）：
 * 判定量 = 净输入 + 缓存读 + 缓存写（不含输出），严格大于阈值才整单换档；
 * 命中返回换档后的单价（绝对价优先，否则按倍率换算）与命中信息（供公式浮窗标注）。
 */
export function resolveLongContextRates(
  rates: PricingRates,
  contextTokens: number,
): {rates: PricingRates; match: LongContextMatchInfo} | undefined {
  const tier = rates.longContext;
  if (!tier || contextTokens <= tier.thresholdTokens) return undefined;
  return {
    rates: longContextTierRates(rates, tier),
    match: {
      thresholdTokens: tier.thresholdTokens,
      contextTokens,
      inputMultiplier: tier.inputMultiplier,
      outputMultiplier: tier.outputMultiplier,
    },
  };
}

/** 长上下文换档单价：字段声明 rates 绝对价时用绝对价，未声明字段按倍率换算。 */
export function longContextTierRates(rates: PricingRates, tier: LongContextPricingTier): PricingRates {
  const abs = tier.rates;
  const cachedInput = abs?.cachedInput
    ?? (rates.cachedInput !== undefined ? rates.cachedInput * tier.inputMultiplier : undefined);
  const cacheWrite = abs?.cacheWrite
    ?? (rates.cacheWrite !== undefined ? rates.cacheWrite * tier.inputMultiplier : undefined);
  const cacheWrite5m = abs?.cacheWrite5m
    ?? (rates.cacheWrite5m !== undefined ? rates.cacheWrite5m * tier.inputMultiplier : undefined);
  const cacheWrite1h = abs?.cacheWrite1h
    ?? (rates.cacheWrite1h !== undefined ? rates.cacheWrite1h * tier.inputMultiplier : undefined);
  return {
    input: abs?.input ?? rates.input * tier.inputMultiplier,
    output: abs?.output ?? rates.output * tier.outputMultiplier,
    ...(cachedInput !== undefined ? {cachedInput} : {}),
    ...(cacheWrite !== undefined ? {cacheWrite} : {}),
    ...(cacheWrite5m !== undefined ? {cacheWrite5m} : {}),
    ...(cacheWrite1h !== undefined ? {cacheWrite1h} : {}),
    ...(rates.reasoning !== undefined ? {reasoning: rates.reasoning * tier.outputMultiplier} : {}),
  };
}
