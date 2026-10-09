/**
 * 全站金额展示统一入口。
 *
 * 2026-09-28 用户决策（取代 2026-09-04「一律不展示币种符号」口径）：
 * - 最终结果金额（仪表盘 / Token 价格 / 会话追踪的消费结论）统一人民币并带 ￥（formatCnyMoney）；
 * - 原币中间项（供应商单价、供应商成本、倍率后、对账 USD 证据）必须标清币种（formatOriginalMoney）；
 * - 供应商页非人民币金额按「原值（约￥等值）」展示（formatMoneyWithCnyEquivalent），
 *   等值系数由 settlement-fx.ts 的 resolveDisplayFxRate 解析（官方预设=目录 fx、中转站=settlementFx）；
 *   结算系数恰为 1 的 USD 金额（中转站 1:1）直接收敛为人民币单值（2026-09-29 用户确认）。
 * 本模块仍只做展示格式化，绝不参与任何汇率换算或计价逻辑；换算系数一律由调用方传入。
 *
 * 旧口径例外继续保留币种文字（官方换算常数定义而非金额展示）：
 * - 套餐积分换算说明（如「中国区 1000 积分 = ¥7」「国际区 1000 credits = $1」）；
 * - 目录确认弹窗中的「积分币种」字段差异值（CNY/USD 本身是配置语义）。
 */

/** 通用金额数值：非有限数返回占位符，其余按指定小数位输出纯数字。 */
export function formatMoneyValue(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(fractionDigits);
}

/** 余额等带符号敏感场景的展示：只保留数值，币种前缀由调用方不再拼接。 */
export function formatBalanceValue(value: number | null | undefined): string {
  return formatMoneyValue(value, 2);
}

/** 人民币终值展示（消费口径金额）：￥前缀；非有限数返回占位符。 */
export function formatCnyMoney(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `￥${value.toFixed(fractionDigits)}`;
}

/**
 * 原币种金额展示：USD → $、CNY → ￥、未知币种 → 纯数值（不猜测币种）。
 * 用于供应商单价、供应商成本、倍率后中间项与对账 USD 证据等非人民币终值。
 */
export function formatOriginalMoney(
  value: number | null | undefined,
  currency?: string,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const text = value.toFixed(fractionDigits);
  if (currency === "USD") return `$${text}`;
  if (currency === "CNY") return `￥${text}`;
  return text;
}

/**
 * 「原值（约￥等值）」展示（2026-09-28 用户决策，供应商页等非人民币金额）：
 * 人民币原值直接单值返回；非人民币金额附括号人民币等值，等值 = value × rate
 * （rate 由 resolveDisplayFxRate 解析：官方预设=目录 fx 快照、中转站=settlementFx）。
 * 结算系数恰为 1 的 USD 金额（中转站 1:1：美元牌价数字 = 确定人民币，2026-09-29
 * 用户确认）等值与原值恒等，双值展示无信息量，直接收敛为人民币单值；
 * auto-code 等非 1:1 站点保持「原值（约￥等值）」双值风格。未知币种不猜测
 * 1:1 结算语义，维持原值+括号等值。rate 非法（0/负/NaN）时退回单值原值。
 */
export function formatMoneyWithCnyEquivalent(
  value: number | null | undefined,
  currency: string | undefined,
  rate: number,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (currency === "CNY") return formatOriginalMoney(value, currency, fractionDigits);
  const original = formatOriginalMoney(value, currency, fractionDigits);
  if (!Number.isFinite(rate) || rate <= 0) return original;
  if (rate === 1 && currency === "USD") return formatCnyMoney(value, fractionDigits);
  const equivalent = value * rate;
  return `${original}（约${formatCnyMoney(equivalent, fractionDigits)}）`;
}

/** 单价类数值展示：保留至多 8 位小数（模型单价可达 0.0000x），USD/CNY 加符号。 */
export function formatOriginalPrice(value: number | null | undefined, currency?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const text = value.toLocaleString(undefined, {maximumFractionDigits: 8});
  if (currency === "USD") return `$${text}`;
  if (currency === "CNY") return `￥${text}`;
  return text;
}

/**
 * 单价「原值（约￥等值）」（2026-09-28）：供应商页模型牌价等场景。
 * 人民币/未知币种或未提供有效 rate 时只标币种不加括号（价格中心弹窗等 D1 场景即如此调用）。
 */
export function formatPriceWithCnyEquivalent(
  value: number | null | undefined,
  currency: string | undefined,
  rate?: number,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const original = formatOriginalPrice(value, currency);
  if (currency !== "USD") return original;
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return original;
  return `${original}（约${formatCnyMoney(value * rate, 4)}）`;
}
