/** 套餐积分逐请求折算：按官方公式把 token 用量换算为套餐积分/AFP。
 *  v2（2026-09-10 第一期）：活动消费切换为 campaign-matcher 合成结果——
 *  creditMultiplier 全部相乘、freeWindow 命中即终局 0、factorOverride 按最高
 *  priority 唯一胜出；峰谷/活动窗口的节假日日期集合（编译解析产物）由
 *  isWithinTimeWindows 的 includeDates/excludeDates 消费。 */

import {
  isWithinTimeWindows,
  type PlanCreditRules,
  type PricingRates,
} from "./pricing";
import {matchAndComposePromotions} from "./provider-catalog/campaign-matcher";
import {calculateAfp} from "./sync-engine/adapters/plan/afp-rules";

export interface PlanCreditInput {
  model: string;
  rules: PlanCreditRules;
  rates: PricingRates;
  usage: {
    inputTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  capturedAt?: string;
  /** 发起调用的 Agent（账本 agent_name）；promotions.agents 限定时用于匹配。 */
  agentName?: string;
  /**
   * 观测通道（2026-09-15 双链路观测）：gateway=网关捕获（缺省），agent_local_import=
   * Agent 官方客户端直连本地导入。promotions.origins 限定的活动只在对应通道命中。
   */
  origin?: string;
}

export interface PlanCreditResult {
  creditCost?: number;
  unit: string;
  formulaVersion: string;
  confidence: "official" | "unverified";
  notes?: string;
  /** 本次折算实际采用的计算逻辑（单行）；随快照落库，供 Token 价格页展示。 */
  formula?: string;
  /** 多行实际计算过程（含本次真实 token 数与中间结果，\n 分隔）；随快照落库。 */
  formulaDetail?: string;
  /** 命中的活动展示名（v2 合成结果；随快照落库供历史展示，不回读当前目录）。 */
  matchedCampaignLabels?: string[];
}

const PER_MILLION = 1_000_000;

/** 按供应商公式折算本次请求的套餐积分；无法折算时返回 undefined 与未验证标记。 */
export function computePlanCredit(input: PlanCreditInput): PlanCreditResult {
  const {rules, usage} = input;
  const tokens = {
    inputTokens: usage.inputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  switch (rules.formula) {
    case "token_weighted":
      return tokenWeightedCredit(input, tokens);
    case "money_to_credits":
      return moneyToCredits(input, tokens);
    case "afp_weighted":
      return afpWeightedCredit(input, tokens);
    case "market_share":
      /* 市价份额制（OpenCode Go）无逐请求积分：分子=市价消耗走估算市价回退，
         分母=条目 quotaTiers 档位月度额度（估算端 resolveMarketShareQuotaTotal 消费）。
         此分支仅作 dispatch 穷尽防御；computePlanCreditForLedger 对该公式先行短路，
         绝不落 plan_credit_unit（防止行被误判为积分 integral 路径）。 */
      return {
        creditCost: undefined,
        unit: rules.unit ?? "",
        formulaVersion: "market-share-2026-09",
        confidence: "official",
        notes: "market_share 公式不产出逐请求积分（估算走市价回退 + 档位月度额度分母）",
      };
  }
}

/**
 * token_weighted 公式族（智谱 GLM Coding Plan / 腾讯 TokenHub Token Plan 等）：
 * 积分 =（输入×系数 + 缓存命中×系数 + 输出×系数）/ divisor × 时段倍率 × 活动倍率。
 * 系数为模型级 planFactors（积分价），与 pricing 牌价彻底解耦（市价走 priceSchedules 链）。
 * 倍率全部由数据驱动：命中 peakWindows 取 window.multiplier（缺省 1），
 * 未命中取 offPeakMultiplier（缺省 0.5）；智谱 2026-09 官网改版统一口径为
 * 非高峰=基础积分 50%（offPeakMultiplier 0.5）、高峰 1 倍（原 GLM-5.3 ×3 /
 * Flash 专属 0.4/1.2 旧口径已随口径统一移除，Flash 与 GLM-5.3 共用同一 profile）；时区可配置；
 * 历史模型名先经 aliases 重定向（官方"自动切换新模型计费"语义）再查系数；
 * 活动按 v2 合成：multiply 全乘、freeWindow（×0）终局、factorOverride 选胜。
 */
function tokenWeightedCredit(
  input: PlanCreditInput,
  tokens: {inputTokens: number; cacheReadTokens: number; outputTokens: number},
): PlanCreditResult {
  const rules = input.rules;
  const divisor = rules.divisor ?? 10000;
  const unit = rules.unit ?? "积分";
  const resolvedModel = rules.aliases?.[input.model] ?? input.model;
  const factor = rules.modelFactors?.[resolvedModel];
  if (!factor || divisor <= 0) {
    return unverifiedResult(unit, "token-weighted-2026-09", `缺少 ${resolvedModel} 的模型系数，暂不折算`);
  }
  const instant = input.capturedAt ? new Date(input.capturedAt) : new Date();
  const timezone = rules.timezone ?? "Asia/Shanghai";
  const windows = rules.peakWindows ?? [];
  // 窗口直接透传（含编译解析的 includeDates/excludeDates 节假日作用域）。
  const matchedWindow = windows.find(window => isWithinTimeWindows([window], instant, timezone));
  // 命中高峰窗口 → 窗口倍率；窗口外 → offPeakMultiplier；完全未声明窗口 → 基础积分。
  const multiplier = matchedWindow
    ? (matchedWindow.multiplier ?? 1)
    : windows.length > 0 ? (rules.offPeakMultiplier ?? 0.5) : 1;
  // 限时活动（官方文档背书）：合成语义见 campaign-matcher；叠加在时段倍率之后。
  // factorOverride 胜出时直接覆盖对应系数（如腾讯 tc-code 活动价三因子同值 11），
  // 不与基础系数相乘——与 creditMultiplier（倍率连乘）语义不同。
  const composed = matchAndComposePromotions(rules.promotions ?? [], resolvedModel, input.capturedAt, input.agentName, timezone, input.origin);
  const activityMultiplier = composed.multiplier;
  const effectiveInputFactor = composed.inputFactor ?? factor.input;
  const effectiveCachedFactor = composed.cachedInputFactor ?? factor.cachedInput ?? 0;
  const effectiveOutputFactor = composed.outputFactor ?? factor.output;
  const base = tokens.inputTokens * effectiveInputFactor
    + tokens.cacheReadTokens * effectiveCachedFactor
    + tokens.outputTokens * effectiveOutputFactor;
  const credit = base / divisor * multiplier * (activityMultiplier ?? 1);
  const periodLabel = windows.length > 0 ? (matchedWindow ? "高峰" : "非高峰") : undefined;
  return {
    creditCost: credit,
    unit,
    formulaVersion: "token-weighted-2026-09",
    confidence: composed.unverified ? "unverified" : "official",
    formula: `积分 = (非缓存输入×${effectiveInputFactor} + 缓存读取×${effectiveCachedFactor} + 输出×${effectiveOutputFactor}) / ${divisor}`
      + (periodLabel ? ` × 时段倍率（本次 ${multiplier}）` : "")
      + (composed.matched.length > 0 ? ` × 活动（${composed.matched.map(item => `${item.label}${item.multiplier !== undefined ? ` ×${item.multiplier}` : ""}`).join(" × ")}` : ""),
    formulaDetail: [
      `非缓存输入 ${formatCount(tokens.inputTokens)} × ${effectiveInputFactor} = ${formatNumber(tokens.inputTokens * effectiveInputFactor)}`,
      `缓存读取 ${formatCount(tokens.cacheReadTokens)} × ${effectiveCachedFactor} = ${formatNumber(tokens.cacheReadTokens * effectiveCachedFactor)}`,
      `输出 ${formatCount(tokens.outputTokens)} × ${effectiveOutputFactor} = ${formatNumber(tokens.outputTokens * effectiveOutputFactor)}`,
      `小计 ${formatNumber(base)} ÷ ${divisor} = ${formatNumber(base / divisor)}`,
      ...(periodLabel ? [`时段倍率（${periodLabel}）× ${multiplier}`] : []),
      ...composed.matched.map(item => `限时活动「${item.label}」${item.multiplier !== undefined ? `× ${item.multiplier}` : `系数 ${(item.input ?? effectiveInputFactor)} / ${(item.cachedInput ?? effectiveCachedFactor)} / ${(item.output ?? effectiveOutputFactor)}`}`),
      `= ${formatNumber(credit)} ${unit}`,
    ].join("\n"),
    ...(composed.labels.length > 0 ? {matchedCampaignLabels: composed.labels} : {}),
    ...(rules.notes ? {notes: rules.notes} : {}),
  };
}

/** money_to_credits 公式族（MiniMax Token Plan 等）：积分 = 请求按量成本(原币) × creditsPerCurrency。 */
function moneyToCredits(
  input: PlanCreditInput,
  tokens: {inputTokens: number; cacheReadTokens: number; outputTokens: number},
): PlanCreditResult {
  const rules = input.rules;
  const unit = rules.unit ?? "积分";
  const creditsPerCurrency = rules.creditsPerCurrency;
  if (creditsPerCurrency === undefined || creditsPerCurrency <= 0) {
    return unverifiedResult(unit, "money-to-credits-2026-08", "缺少积分换算系数");
  }
  const rates = input.rates;
  const inputCost = tokens.inputTokens / PER_MILLION * rates.input;
  const cacheReadCost = tokens.cacheReadTokens / PER_MILLION * (rates.cachedInput ?? 0);
  const outputCost = tokens.outputTokens / PER_MILLION * rates.output;
  const cost = inputCost + cacheReadCost + outputCost;
  const timezone = rules.timezone ?? "Asia/Shanghai";
  const composed = matchAndComposePromotions(rules.promotions ?? [], input.model, input.capturedAt, input.agentName, timezone, input.origin);
  const credit = cost * creditsPerCurrency * (composed.multiplier ?? 1);
  return {
    creditCost: credit,
    unit,
    formulaVersion: "money-to-credits-2026-08",
    confidence: composed.unverified ? "unverified" : "official",
    formula: `积分 = 请求按量成本(${rules.currency ?? "CNY"}) × ${creditsPerCurrency}`
      + (composed.matched.length > 0 ? ` × 活动（${composed.matched.map(item => `${item.label} ×${item.multiplier}`).join(" × ")}` : ""),
    formulaDetail: [
      `非缓存输入 ${formatCount(tokens.inputTokens)} / 1M × ${rates.input} = ${formatNumber(inputCost)}`,
      `缓存读取 ${formatCount(tokens.cacheReadTokens)} / 1M × ${rates.cachedInput ?? 0} = ${formatNumber(cacheReadCost)}`,
      `输出 ${formatCount(tokens.outputTokens)} / 1M × ${rates.output} = ${formatNumber(outputCost)}`,
      `按量成本 ${formatNumber(cost)} × ${creditsPerCurrency} 积分/${rules.currency ?? "CNY"}`,
      ...composed.matched.map(item => `限时活动「${item.label}」× ${item.multiplier}`),
      `= ${formatNumber(credit)} ${unit}`,
    ].join("\n"),
    ...(composed.labels.length > 0 ? {matchedCampaignLabels: composed.labels} : {}),
    ...(rules.notes ? {notes: rules.notes} : {}),
  };
}

/**
 * afp_weighted 公式族（火山方舟 Agent/Coding Plan，官方口径 docs/82379/2516283）：
 * AFP = (输入 token × 输入抵扣系数 + 输出 token × 输出抵扣系数) / 10,000。
 * 缓存命中 token 按输入抵扣系数计入（官方公式未单列缓存，2026-09-02 用户确认保守口径）。
 * 活动按 v2 合成：factorOverride（限时系数覆盖）按最高 priority 选胜，
 * creditMultiplier 在 AFP 之后相乘、freeWindow 终局 0。
 */
function afpWeightedCredit(
  input: PlanCreditInput,
  tokens: {inputTokens: number; cacheReadTokens: number; outputTokens: number},
): PlanCreditResult {
  const rules = input.rules;
  const unit = rules.unit ?? "AFP";
  const resolvedModel = rules.aliases?.[input.model] ?? input.model;
  const factor = rules.modelFactors?.[resolvedModel];
  const divisor = rules.divisor ?? 10000;
  if (!factor || divisor <= 0) {
    return unverifiedResult(unit, "afp-weighted-2026-09", `缺少 ${resolvedModel} 的抵扣系数，暂不折算`);
  }
  const timezone = rules.timezone ?? "Asia/Shanghai";
  const composed = matchAndComposePromotions(rules.promotions ?? [], resolvedModel, input.capturedAt, input.agentName, timezone, input.origin);
  const inputFactor = composed.inputFactor ?? factor.input;
  const outputFactor = composed.outputFactor ?? factor.output;
  const inputPart = (tokens.inputTokens + tokens.cacheReadTokens) * inputFactor;
  const outputPart = tokens.outputTokens * outputFactor;
  const credit = calculateAfp({
    inputTokens: tokens.inputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    outputTokens: tokens.outputTokens,
  }, {
    input: inputFactor,
    cachedInput: inputFactor,
    output: outputFactor,
  }) * (10000 / divisor) * (composed.multiplier ?? 1);
  return {
    creditCost: credit,
    unit,
    formulaVersion: "afp-weighted-2026-09",
    confidence: composed.unverified || rules.unverified ? "unverified" : "official",
    formula: `AFP = ((非缓存输入 + 缓存读取) × ${inputFactor}`
      + ` + 输出 × ${outputFactor}) / ${divisor}`
      + (composed.matched.length > 0 ? ` × 活动（${composed.matched.map(item => `${item.label}${item.multiplier !== undefined ? ` ×${item.multiplier}` : ` 系数${item.input ?? "-"}/${item.output ?? "-"}`}`).join(" × ")}）` : ""),
    formulaDetail: [
      `非缓存输入 ${formatCount(tokens.inputTokens)} + 缓存读取 ${formatCount(tokens.cacheReadTokens)} = ${formatCount(tokens.inputTokens + tokens.cacheReadTokens)}`,
      `${formatCount(tokens.inputTokens + tokens.cacheReadTokens)} × ${inputFactor} = ${formatNumber(inputPart)}`,
      `输出 ${formatCount(tokens.outputTokens)} × ${outputFactor} = ${formatNumber(outputPart)}`,
      `小计 ${formatNumber(inputPart + outputPart)} ÷ ${divisor} = ${formatNumber((inputPart + outputPart) / divisor)}`,
      ...composed.matched.map(item => `限时活动「${item.label}」${item.multiplier !== undefined ? `× ${item.multiplier}` : `系数 ${item.input ?? "-"} / ${item.output ?? "-"}`}`),
      `= ${formatNumber(credit)} ${unit}`,
    ].join("\n"),
    ...(composed.labels.length > 0 ? {matchedCampaignLabels: composed.labels} : {}),
    ...(rules.notes ? {notes: rules.notes} : {}),
  };
}

function unverifiedResult(unit: string, formulaVersion: string, notes: string): PlanCreditResult {
  return {creditCost: undefined, unit, formulaVersion, confidence: "unverified", notes};
}

/** token 数按整数千分位展示。 */
function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** 中间结果小数最多保留 6 位，去掉尾随零。 */
function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(6));
  return rounded.toLocaleString("en-US", {maximumFractionDigits: 6});
}
