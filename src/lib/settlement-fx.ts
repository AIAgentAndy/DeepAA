/**
 * 结算系数（牌价数字 → 人民币）的输入解析与展示（2026-09-23 用户确认）。
 *
 * 中转站普遍按「美元牌价数字 × 倍率 = 人民币」1:1 结算（默认 1）；特殊站点需要
 * 显式覆盖，如 auto-code.net 的「倍率后价格 × 1/16 才是真实人民币」。为形象起见
 * 输入支持「几比几」比值写法（1:16 = 乘 1/16），也兼容小数/整数（0.0625、1、16）。
 *
 * 存储仍是单一数字乘数（TargetPricingOverride.settlementFx），本模块只负责
 * 输入字符串 ⇄ 乘数 ⇄ 展示文案的转换，计价端（exchange-processor）零改动。
 * 2026-09-28 新增 resolveDisplayFxRate：展示层「原值（约￥等值）」的换算系数解析，
 * 与入账级联同规则，但只用于展示括号等值、绝不入账。
 */

import {DEFAULT_USD_CNY_RATE} from "@/lib/pricing-model-entry";

/** 比值还原尝试的最大分母：超过此范围按普通小数展示，不做逼近拟合。 */
const MAX_RATIO_DENOMINATOR = 1000;

/** 比值/小数输入的解析结果：非法返回 undefined（含空串）。 */
export function parseSettlementFxInput(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  // 全角冒号/比号归一为半角、忽略分隔符两侧空格（“1: 16” 等输入习惯），统一按比值处理。
  const normalized = trimmed.replace(/\s+/g, "").replace(/：/g, ":").replace(/／/g, "/");
  const ratioMatch = /^(\d+(?:\.\d+)?)[:/](\d+(?:\.\d+)?)$/.exec(normalized);
  if (ratioMatch) {
    const numerator = Number(ratioMatch[1]);
    const denominator = Number(ratioMatch[2]);
    if (
      !Number.isFinite(numerator) || numerator <= 0
      || !Number.isFinite(denominator) || denominator <= 0
    ) return undefined;
    const multiplier = numerator / denominator;
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : undefined;
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * 展示文案：缺省 → 默认 1:1；1 → 「1:1」；能精确还原为小分母比值（1:16）时
 * 「a:b（小数）」并列；其余按原值小数输出（去尾零由调用方 toLocaleString 决定）。
 */
export function formatSettlementFxDisplay(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "1:1（默认：美元牌价 1:1 记人民币）";
  }
  if (value === 1) return "1:1";
  const ratio = ratioForValue(value);
  if (ratio) {
    const [numerator, denominator] = ratio;
    return `${numerator}:${denominator}（${decimalText(value)}）`;
  }
  return decimalText(value);
}

/** 1:16 这类输入的提示语：说明「填的是比值，实际乘数是多少」。 */
export function settlementFxInputHint(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return `等效乘数 ${decimalText(value)}（牌价 × ${decimalText(value)} = 人民币）`;
}

export interface DisplayFxInput {
  /** 被换算金额自身的币种：CNY → 1（无需括号等值）；非 CNY 按下方规则解析。 */
  amountCurrency?: "CNY" | "USD";
  /** 目标预设的目录币种（PROVIDER_PRESETS[].currency）：存在即视为官方预设目标。 */
  presetCurrency?: "CNY" | "USD";
  /** 目标显式结算系数（pricing.settlementFx）：与入账级联同序、最优先。 */
  settlementFx?: number;
  /** 当前目录 fx 快照（USD/CNY），来自 /api/model-pricing?view=fx。 */
  fxUsdCny?: number;
}

/** 任意币种字符串收窄为展示支持的币种（未知/缺失返回 undefined，由级联按预设推断）。 */
export function asDisplayCurrency(value: string | undefined | null): "CNY" | "USD" | undefined {
  if (value === "CNY") return "CNY";
  if (value === "USD") return "USD";
  return undefined;
}

/**
 * 展示用结算系数（2026-09-28 用户确认；2026-10-06 与入账级联重新对齐）：
 * - 目标显式 settlementFx（自定义/中转站目标的业务兑换比例，如 auto-code 1/16）最优先；
 * - 原币 CNY → 1（原生人民币，无需括号等值）；
 * - 官方预设目标（presetCurrency 存在，任意目录币种）的非人民币金额 → 目录 fx 快照
 *   （缺失时回退随包默认）——与入账端「USD 且官方预设 = 价格版本 fx」同规则，CNY 区
 *   预设上的美元条目（价格中心手工配置/LiteLLM 兜底命中）同样按汇率换算；
 * - 自定义/中转站目标缺省 1:1（美元牌价 1:1 记人民币）。
 * 未提供 amountCurrency 时按预设目录币种推断（CNY 预设视为人民币金额 = 1，保持旧行为）。
 * 只用于展示层「非人民币金额 × rate ≈ 人民币」的括号等值，绝不参与入账计价。
 */
export function resolveDisplayFxRate(input: DisplayFxInput): number {
  const explicitFx = input.settlementFx;
  if (typeof explicitFx === "number" && Number.isFinite(explicitFx) && explicitFx > 0) {
    return explicitFx;
  }
  if (input.amountCurrency === "CNY") return 1;
  if (input.presetCurrency) {
    if (input.amountCurrency === undefined && input.presetCurrency === "CNY") return 1;
    const rate = input.fxUsdCny;
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_CNY_RATE;
  }
  return 1;
}

/**
 * 找 |value - a/b| 在相对容差内且分母最小的整数比；整数（可整除）与
 * 分子/分母超过 100 的（如汇率 7.13 → 713:100，比值写法反而难读）不还原，
 * 按普通小数展示。
 */
function ratioForValue(value: number): [number, number] | undefined {
  for (let denominator = 2; denominator <= MAX_RATIO_DENOMINATOR; denominator += 1) {
    const numerator = value * denominator;
    const rounded = Math.round(numerator);
    if (rounded < 1) continue;
    if (Math.abs(numerator - rounded) <= 1e-9 * Math.max(1, Math.abs(numerator))) {
      const divisor = gcd(rounded, denominator);
      const reduced: [number, number] = [rounded / divisor, denominator / divisor];
      // 整数（约分后分母为 1）按普通数字展示，不伪装成 a:1 比值。
      if (reduced[1] === 1) return undefined;
      if (reduced[0] > 100 || reduced[1] > 100) return undefined;
      return reduced;
    }
  }
  return undefined;
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function decimalText(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 8});
}
