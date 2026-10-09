/**
 * 价格中心条目级筛选键（供应商 + 模型成对）与 fx 汇率纯函数。
 * 独立成模块：纯字符串/纯数值函数，无 Node 依赖，可被客户端组件安全导入；
 * `src/lib/pricing.ts` 再导出保持服务端单一入口。
 */

/** 价格中心「模型」筛选候选条目：模型 × 供应商成对出现，同名模型跨供应商各自成项。 */
export interface PricingCatalogModelEntry {
  model: string;
  vendor: string;
}

/** 汇率快照：rates 键为 "BASE/QUOTE"（如 "USD/CNY"）。 */
export interface PricingFxSnapshot {
  rates: Record<string, number>;
  asOf?: string;
  source?: string;
}

/**
 * 目录随包默认汇率（2026-09-28 用户确认取整数 7）：仅在「无 fx 快照 / 无该货币对 /
 * 旧价格版本 blob 无 fx」的回退路径生效；正常链路一律用价格版本里的目录快照。
 */
export const DEFAULT_USD_CNY_RATE = 7;

/** 解析汇率快照中的目标汇率；无快照或无该对时回退随包默认。 */
export function resolveFxRate(fx: PricingFxSnapshot | undefined, base: string, quote: string): number {
  const value = fx?.rates?.[`${base}/${quote}`];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_USD_CNY_RATE;
}

/** 复合筛选键（供应商 + 模型）：NUL 不可能出现在真实供应商/模型 ID 中，保证切分无歧义。 */
export function pricingModelEntryKey(vendor: string, model: string): string {
  return `${vendor}\u0000${model}`;
}

/** 解析复合筛选键；格式非法时返回 undefined。 */
export function parsePricingModelEntryKey(value: string): PricingCatalogModelEntry | undefined {
  const separator = value.indexOf("\u0000");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {vendor: value.slice(0, separator), model: value.slice(separator + 1)};
}
