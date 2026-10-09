/**
 * 派生期供应商通道元数据读取：从 proxy-config.json 有界提取，避免把大配置全量带入内存。
 * 解析失败或超限时返回空表，派生不因此失败（账本通道字段保持 NULL）。
 */

import {readFile, stat} from "node:fs/promises";
import {join} from "node:path";
import type {BillingChannel} from "@/types";
import {PROVIDER_PRESETS} from "@/lib/provider-presets";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";

export interface TargetBillingMetadata {
  billingChannel?: BillingChannel;
  vendorFamily?: string;
  /** 官方预设 ID（目标由预设创建时）；用于 promo 双价与结算语义判定。 */
  presetId?: string;
  /** 计价币种（2026-09-05 四层分离）；缺省按 USD 记账口径。 */
  settlementCurrency?: "CNY" | "USD";
  /** 计价数字→人民币折算系数；显式配置时优先于默认规则。 */
  settlementFx?: number;
  /** 套餐月费（原币种数值，币种随 settlementCurrency）；套餐估算入账冻结用。 */
  planMonthlyFee?: number;
  /** 套餐档位 id（如 opencode-go 的 go/go-plus）；market_share 估算分母解析用。 */
  planTier?: string;
  /**
   * 预设级积分公式声明（2026-10-07）：`"none"` = 官方未公开逐请求积分公式（火山
   * Coding Plan），派生端不落积分列、估算走市价参考 + 额度差分回填。预设解析带
   * URL 兜底（手工建目标缺 presetId 时仍能命中）；该字段只作用于积分折算抑制，
   * 不影响 promo/结算等其它按 presetId 判定的语义。
   */
  planCreditFormula?: "none";
}

const MAX_PROXY_CONFIG_BYTES = 1024 * 1024;
const BILLING_CHANNELS = new Set(["pay_as_you_go", "plan", "subscription"]);

/** 配置文件签名：mtime + size，变化时派生器才重新读取。 */
export async function targetMetadataSignature(dataDir: string): Promise<string> {
  const stats = await stat(join(dataDir, "proxy-config.json")).catch(() => undefined);
  return stats ? `${stats.mtimeMs}:${stats.size}` : "";
}

/** 有界读取供应商通道元数据；解析失败或超限返回空表，派生不因此失败。 */
export async function readTargetBillingMetadata(dataDir: string): Promise<Map<string, TargetBillingMetadata>> {
  const path = join(dataDir, "proxy-config.json");
  const info = await stat(path).catch(() => undefined);
  if (!info || info.size > MAX_PROXY_CONFIG_BYTES) return new Map();
  const parsed = JSON.parse(await readFile(path, "utf8")) as {targets?: unknown};
  if (!parsed || !Array.isArray(parsed.targets)) return new Map();
  const result = new Map<string, TargetBillingMetadata>();
  for (const raw of parsed.targets) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const target = raw as Record<string, unknown>;
    if (typeof target.id !== "string" || !target.id.trim()) continue;
    const billingChannel = typeof target.billingChannel === "string"
      && BILLING_CHANNELS.has(target.billingChannel)
      ? target.billingChannel as BillingChannel
      : undefined;
    const vendorFamily = typeof target.vendorFamily === "string"
      && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(target.vendorFamily)
      ? target.vendorFamily
      : undefined;
    const presetId = typeof target.presetId === "string" && target.presetId.trim()
      ? target.presetId.trim()
      : undefined;
    const pricing = target.pricing as Record<string, unknown> | undefined;
    const settlementCurrency = pricing && (pricing.settlementCurrency === "CNY" || pricing.settlementCurrency === "USD")
      ? pricing.settlementCurrency
      : undefined;
    const settlementFxRaw = pricing ? pricing.settlementFx : undefined;
    const settlementFx = typeof settlementFxRaw === "number" && Number.isFinite(settlementFxRaw) && settlementFxRaw > 0
      ? settlementFxRaw
      : undefined;
    const planMonthlyFeeRaw = pricing ? pricing.planMonthlyFee : undefined;
    const planMonthlyFee = typeof planMonthlyFeeRaw === "number" && Number.isFinite(planMonthlyFeeRaw) && planMonthlyFeeRaw >= 0
      ? planMonthlyFeeRaw
      : undefined;
    const planTierRaw = pricing ? pricing.planTier : undefined;
    const planTier = typeof planTierRaw === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(planTierRaw)
      ? planTierRaw
      : undefined;
    // 预设级积分公式声明（2026-10-07）：显式 presetId 优先，URL 反查兜底（手工目标）。
    // 只消费 planCreditFormula 字段本身，绝不把兜底结果回写 presetId——promo/结算
    // 语义仍以显式 presetId 为准，避免 URL 兜底扩大其它行为面。
    const planCreditPreset = (presetId ? PROVIDER_PRESETS.find(preset => preset.id === presetId) : undefined)
      ?? resolveOfficialPresetForTarget({
        openaiUrl: typeof target.openaiUrl === "string" ? target.openaiUrl : undefined,
        anthropicUrl: typeof target.anthropicUrl === "string" ? target.anthropicUrl : undefined,
        presetId,
        billingChannel,
      });
    const planCreditFormula = planCreditPreset?.planCreditFormula;
    if (billingChannel || vendorFamily || presetId || settlementCurrency || settlementFx || planMonthlyFee !== undefined || planTier || planCreditFormula) {
      result.set(target.id.trim(), {billingChannel, vendorFamily, presetId, settlementCurrency, settlementFx, planMonthlyFee, planTier, planCreditFormula});
    }
  }
  return result;
}
