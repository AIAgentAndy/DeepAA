import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {DEFAULT_USD_CNY_RATE, resolveFxRate, type PlanCreditRules} from "@/lib/pricing";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 套餐真实成本共享模块（2026-09-04 从 analytics-queries 抽出）：
 * 公式 = 套餐月费 × (消耗积分 ÷ 窗口总积分) × (窗口天数 ÷ 30)。
 * 仪表盘 KPI/排行榜与 Token 价格页汇总共用同一口径；按周积分的供应商
 * （如 bigmodel）窗口天数 = 7，自动等价于「月费 / 30 × 7」。
 */

const MAX_PROXY_CONFIG_BYTES = 1024 * 1024;
/** 套餐额度快照扫描上限：plan_quota_snapshots 为低频小表，仍设硬界。 */
const PLAN_QUOTA_SCAN = 512;

/** 套餐计费窗口 → 覆盖天数（月费按 30 天折算窗口费用份额；额度差分估算共用同一张表）。 */
export const PLAN_WINDOW_DAYS: Record<string, number> = {
  monthly: 30,
  "30d": 30,
  weekly: 7,
  weekly_opus: 7,
  weekly_sonnet: 7,
  "5h": 5 / 24,
};

const PLAN_WINDOW_PRIORITY = ["monthly", "30d", "weekly", "weekly_opus", "weekly_sonnet", "5h"];

/** 套餐周期额度：来自 plan_quota_snapshots 最新快照，按最长可用窗口折算。 */
export interface PlanQuotaTotal {
  total: number;
  windowDays: number;
  windowLabel: string;
  /**
   * 额度单位（快照 unit 透传；market_share 条目解析后为金额口径 "CNY"）。
   * 市价回退估算（无积分公式时）只允许与消耗同量纲的金额口径（CNY/USD）；
   * percent/积分/AFP 等刻度与市价金额不同量纲，禁止相除折算。
   */
  unit?: string;
  /**
   * market_share 专属（2026-09-30）：目标档位的「月度美元额度」原始值
   * （total = 本值 × 请求时汇率）；供估算明细逐步公式展示，非 market_share 不落。
   */
  monthlyLimitUsd?: number;
}

/** 每目标各窗口的原始额度合计（fx 无关）：派生器缓存这个，再按请求时汇率解析。 */
export type PlanQuotaWindows = Map<string, {total: number; providerType: string; unit?: string}>;

export interface PlanTargetInfo {
  name: string;
  /** 供应商套餐月费（原始数值，币种随目标 settlementCurrency）；未录入时缺省。 */
  planMonthlyFee?: number;
  /** 月费币种（目标 pricing.settlementCurrency）；缺省按 CNY 数字直存处理。 */
  planFeeCurrency?: "CNY" | "USD";
}

export function computePlanRealCostNano(input: {
  monthlyFee: number | undefined;
  creditsConsumed: number;
  quotaTotal: number | undefined;
  windowDays: number | undefined;
}): number | null {
  /* 无套餐消耗即无套餐成本（月费/额度是否可得不影响该结论）。 */
  if (!(input.creditsConsumed > 0)) return 0;
  const fee = input.monthlyFee;
  if (fee === undefined || !Number.isFinite(fee) || fee < 0) return null;
  if (input.quotaTotal === undefined || !(input.quotaTotal > 0)) return null;
  if (input.windowDays === undefined || !(input.windowDays > 0)) return null;
  return Math.round(fee * 1e9 * (input.creditsConsumed / input.quotaTotal) * (input.windowDays / 30));
}

/** 入账冻结的套餐成本估算结果（2026-09-15）：查询端只读这些冻结值，不再现算。 */
export interface PlanEstimateForLedger {
  status: "estimated" | "unavailable" | "none";
  /** 估算金额（月费币种数值）；estimated 时必有。 */
  cost?: number;
  currency?: "CNY" | "USD";
  /** 月费币种 → CNY 的入账时汇率（CNY=1）。 */
  fx?: number;
  /** 人民币 nano 物化（= cost × fx）。 */
  nano?: number;
  /** 审计依据快照：月费、消耗与口径、额度、窗口、汇率。 */
  detailJson?: string;
}

/**
 * 派生期冻结套餐成本估算：只用入账时可见的月费（原币种 + settlementCurrency 标币种）、
 * 最新额度快照与当次价格版本汇率；公式 = 月费(CNY) × 消耗/窗口额度 × 窗口天数/30。
 * 消耗口径与查询时代（2026-09-08）一致：积分制以 planCreditUnit 存在为准（0 积分是真实
 * 零消耗）；美元额度制无逐请求积分时回退套餐通道市价成本（CNY）。
 */
export function computePlanEstimateForLedger(input: {
  billingChannel?: string;
  planCreditCost?: number;
  planCreditUnit?: string | null;
  referenceCostNano?: number;
  monthlyFee?: number;
  feeCurrency?: "CNY" | "USD";
  quotaTotal?: number;
  /** 额度快照单位（PlanQuotaTotal.unit）：市价回退折算的量纲守卫输入。 */
  quotaUnit?: string;
  windowDays?: number;
  windowLabel?: string;
  /** market_share 逐步公式依据（2026-09-30）：请求模型、目标档位与档位月度美元额度。 */
  modelId?: string;
  planTier?: string;
  monthlyLimitUsd?: number;
  fxUsdCny: number;
}): PlanEstimateForLedger {
  if (input.billingChannel !== "plan" && input.billingChannel !== "subscription") {
    return {status: "none"};
  }
  const integral = Boolean(input.planCreditUnit);
  const quotaIsMonetary = input.quotaUnit === "CNY" || input.quotaUnit === "USD";
  const fallbackMarket = input.referenceCostNano !== undefined && input.referenceCostNano > 0
    ? input.referenceCostNano / 1e9
    : 0;
  const consumed = integral ? input.planCreditCost ?? 0 : fallbackMarket;
  if (!integral && !(consumed > 0)) return {status: "none"};
  const currency = input.feeCurrency === "USD" ? "USD" : "CNY";
  const fx = currency === "USD" ? (Number.isFinite(input.fxUsdCny) && input.fxUsdCny > 0 ? input.fxUsdCny : 1) : 1;
  /* 量纲守卫（2026-09-29 一期）：市价回退只在额度同为金额口径（OpenCode Go 美元额度
     常量按请求时汇率折算为 CNY）时折算；percent/积分/AFP 刻度与市价金额不可相除，
     一律诚实降级 unavailable，待额度差分估算机制（二期）补写。 */
  if (!integral && !quotaIsMonetary) {
    const detail = {
      monthlyFee: input.monthlyFee,
      consumed,
      consumedBasis: "market_blocked",
      quotaTotal: input.quotaTotal,
      quotaUnit: input.quotaUnit,
      windowDays: input.windowDays,
      windowLabel: input.windowLabel,
    };
    return {status: "unavailable", currency, fx, detailJson: JSON.stringify(detail)};
  }
  const feeCny = input.monthlyFee !== undefined && Number.isFinite(input.monthlyFee) && input.monthlyFee >= 0
    ? input.monthlyFee * fx
    : undefined;
  const nano = computePlanRealCostNano({
    monthlyFee: feeCny,
    creditsConsumed: consumed,
    quotaTotal: input.quotaTotal,
    windowDays: input.windowDays,
  });
  /* market_share 逐步公式依据（2026-09-30）：三件套齐备时落明细，展示端按
     「消耗￥ = $×汇率 → ÷ 档位月度额度$×汇率 → × 档位月费$×汇率 → × 窗口天数」
     逐步展开；旧行缺字段回退通用两行文案。 */
  const marketShareSteps = input.monthlyLimitUsd !== undefined
    && input.modelId !== undefined
    && input.planTier !== undefined
    && currency === "USD"
    && fx > 0
    ? {
      consumedUsd: consumed / fx,
      modelId: input.modelId,
      planTier: input.planTier,
      monthlyLimitUsd: input.monthlyLimitUsd,
    }
    : undefined;
  const detail = {
    monthlyFee: input.monthlyFee,
    consumed,
    consumedBasis: integral ? "credits" : "market_cny",
    quotaTotal: input.quotaTotal,
    windowDays: input.windowDays,
    windowLabel: input.windowLabel,
    fxUsdCny: currency === "USD" ? fx : undefined,
    ...marketShareSteps,
  };
  if (nano === null) {
    return {status: "unavailable", currency, fx, detailJson: JSON.stringify(detail)};
  }
  return {
    status: "estimated",
    cost: nano / fx / 1e9,
    currency,
    fx,
    nano,
    detailJson: JSON.stringify(detail),
  };
}

/**
 * 每目标各（密钥×窗口）最新快照额度合计：fx 无关的原始窗口表，供派生器缓存；
 * 展示语义（最长窗口选择、OpenCode Go 美元额度折算）由 resolvePlanQuotaTotal 按请求时汇率完成。
 */
export function loadPlanQuotaWindows(db: DeepaaDatabase): Map<string, PlanQuotaWindows> {
  try {
    const rows = db.prepare(`SELECT target_id, COALESCE(credential_id, '') AS credential_id,
      window_label, total, provider_type, unit, MAX(captured_at) AS captured_at
      FROM plan_quota_snapshots
      WHERE total IS NOT NULL AND total > 0
      GROUP BY target_id, COALESCE(credential_id, ''), window_label
      ORDER BY captured_at DESC
      LIMIT ${PLAN_QUOTA_SCAN}`).all() as Array<{target_id: string; credential_id: string; window_label: string; total: number; provider_type: string; unit?: string | null}>;
    const result = new Map<string, PlanQuotaWindows>();
    for (const row of rows) {
      const windows = result.get(row.target_id) ?? new Map<string, {total: number; providerType: string; unit?: string}>();
      const existing = windows.get(row.window_label);
      const unit = typeof row.unit === "string" && row.unit ? row.unit : existing?.unit;
      windows.set(row.window_label, {
        total: (existing?.total ?? 0) + Number(row.total),
        providerType: row.provider_type,
        ...(unit !== undefined ? {unit} : {}),
      });
      result.set(row.target_id, windows);
    }
    return result;
  } catch {
    return new Map();
  }
}

/** 按请求时汇率把原始窗口表解析为可计费额度：优先最长窗口（绝对额度口径）。
 * OpenCode Go 等上游只回 percent 的目标不在此解析（percent 无额度语义）——
 * 其分母由条目 market_share 规则解析（resolveMarketShareQuotaTotal）；
 * 解析不到即 market_blocked 诚实降级，绝不用写死常量兜底（2026-09-30 用户确认）。 */
export function resolvePlanQuotaTotal(windows: PlanQuotaWindows | undefined, fxUsdCny: number): PlanQuotaTotal | undefined {
  if (!windows) return undefined;
  for (const label of PLAN_WINDOW_PRIORITY) {
    const entry = windows.get(label);
    if (entry === undefined) continue;
    const windowDays = PLAN_WINDOW_DAYS[label];
    if (windowDays === undefined) continue;
    if (entry.total > 0) {
      return {total: entry.total, windowDays, windowLabel: label, ...(entry.unit !== undefined ? {unit: entry.unit} : {})};
    }
  }
  return undefined;
}

/**
 * market_share（OpenCode Go）估算分母：条目 quotaTiers 按目标所选档位取「月度美元额度」，
 * ×请求时汇率折算 CNY 金额口径（与账本 CNY 市价消耗同量纲）。估算固定月窗：
 * 真实消耗 ≈ 市价消耗 × 月费 ÷ 模型月度额度（官方 5h/周窗口比例仅文案参考）。
 * 档位未选/额度缺失返回 undefined → 调用方按 market_blocked（unavailable）降级。
 */
export function resolveMarketShareQuotaTotal(
  rules: Pick<PlanCreditRules, "formula" | "unit" | "quotaTiers">,
  planTier: string | undefined,
  fxUsdCny: number,
): PlanQuotaTotal | undefined {
  if (rules.formula !== "market_share" || !planTier) return undefined;
  const tier = rules.quotaTiers?.[planTier];
  const monthlyUsd = tier?.quotaByWindow?.monthly;
  if (monthlyUsd === undefined || !(monthlyUsd > 0)) return undefined;
  const fx = rules.unit === "CNY" ? 1 : (Number.isFinite(fxUsdCny) && fxUsdCny > 0 ? fxUsdCny : 1);
  return {
    total: monthlyUsd * fx,
    windowDays: PLAN_WINDOW_DAYS.monthly!,
    windowLabel: "monthly",
    unit: "CNY",
    monthlyLimitUsd: monthlyUsd,
  };
}

/**
 * 兼容入口：一次性加载并按给定汇率解析全部目标的套餐周期额度。
 * 派生器请改用 loadPlanQuotaWindows + resolvePlanQuotaTotal（fx 随请求时快照）。
 */
export function loadPlanQuotaTotals(
  db: DeepaaDatabase,
  options: {fxUsdCny?: number} = {},
): Map<string, PlanQuotaTotal> {
  const windows = loadPlanQuotaWindows(db);
  const result = new Map<string, PlanQuotaTotal>();
  for (const [targetId, entry] of windows) {
    const total = resolvePlanQuotaTotal(entry, options.fxUsdCny ?? 1);
    if (total) result.set(targetId, total);
  }
  return result;
}

/** 有界读取 proxy-config.json 中的目标显示名与套餐月费；失败回退 target_id，不影响查询。 */
export async function readPlanTargetInfos(dataDir?: string): Promise<Map<string, PlanTargetInfo>> {
  try {
    const {resolveDeepaaDataDir} = await import("@/lib/data-paths");
    const path = join(dataDir || resolveDeepaaDataDir(), "proxy-config.json");
    const info = await stat(path).catch(() => undefined);
    if (!info || !info.isFile() || info.size > MAX_PROXY_CONFIG_BYTES) return new Map();
    const parsed = JSON.parse(await readFile(path, "utf8")) as {targets?: unknown};
    const result = new Map<string, PlanTargetInfo>();
    if (parsed && Array.isArray(parsed.targets)) {
      for (const raw of parsed.targets) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const target = raw as Record<string, unknown>;
        if (typeof target.id !== "string" || !target.id.trim()) continue;
        const id = target.id.trim();
        const name = typeof target.name === "string" && target.name.trim() ? target.name.trim() : id;
        const pricing = target.pricing as Record<string, unknown> | undefined;
        const fee = pricing && typeof pricing === "object" && !Array.isArray(pricing)
          ? (pricing.planMonthlyFee as unknown)
          : undefined;
        const settlementCurrency = pricing && typeof pricing === "object" && !Array.isArray(pricing)
          && (pricing.settlementCurrency === "CNY" || pricing.settlementCurrency === "USD")
          ? pricing.settlementCurrency
          : undefined;
        const info: PlanTargetInfo = typeof fee === "number" && Number.isFinite(fee) && fee >= 0
          ? {name, planMonthlyFee: fee, ...(settlementCurrency ? {planFeeCurrency: settlementCurrency} : {})}
          : {name};
        result.set(id, info);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}


/** 读取最近生效价格配置的 USD/CNY 汇率（pricing_config_revisions → catalog blob fx）；
 *  无记录时回退随包默认。低频小查询，供账本读时折算。 */
export function readLatestUsdCnyRate(db: DeepaaDatabase): number {
  try {
    const row = db.prepare(`
      SELECT cc.config_json AS config_json
      FROM pricing_config_revisions r
      JOIN pricing_catalog_blobs cc ON cc.hash = r.catalog_hash
      ORDER BY r.effective_at DESC LIMIT 1`).get() as {config_json?: string} | undefined;
    if (!row?.config_json) return DEFAULT_USD_CNY_RATE;
    const parsed = JSON.parse(row.config_json) as {fx?: {rates: Record<string, number>}};
    return resolveFxRate(parsed.fx, "USD", "CNY");
  } catch {
    return DEFAULT_USD_CNY_RATE;
  }
}
