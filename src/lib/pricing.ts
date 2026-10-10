/**
 * 模型价格表、费用换算与 usage 账本。
 *
 * 维护原则：
 * - 默认价表只放可追溯来源；未核实模型可以匹配，但必须 priced=false。
 * - token 不是永远准确：服务商 usage 最高可信，tokenizer/启发式估算必须带置信度。
 * - 历史 v1 配置可读取并迁移为 v2，避免用户覆盖配置直接失效。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "fs/promises";
import { dirname, join, resolve } from "path";
import {
  DEFAULT_USD_CNY_RATE,
  pricingModelEntryKey,
  resolveFxRate,
  type PricingCatalogModelEntry,
  type PricingFxSnapshot,
} from "./pricing-model-entry";
import type {
  InputModality,
  LongContextPricingTier,
  ProxyConfig,
  ProxyTarget,
  ProxyTargetModelVendor,
  SparsePricingRates,
  TemporalPriceSchedule,
  TemporalPriceScheduleWindow,
  WireApi,
} from "../types";

export type {LongContextPricingTier, SparsePricingRates, TemporalPriceSchedule, TemporalPriceScheduleWindow} from "../types";

const PER_MILLION = 1_000_000;
const USER_PRICING_FILE = join("config", "model-pricing.json");
export const MAX_PRICING_CONFIG_BYTES = 8 * 1024 * 1024;
const pricingMutationTails = new Map<string, Promise<void>>();

export type PricingConfidence = "official" | "provider_docs" | "user_override" | "third_party" | "unverified";

/** 目标级覆盖的 relay_synced（中转站同步价）落到价格中心/快照词表时等价 third_party。 */
function normalizePricingCenterConfidence(
  confidence: "user_override" | "third_party" | "provider_docs" | "relay_synced" | undefined,
): PricingConfidence | undefined {
  return confidence === "relay_synced" ? "third_party" : confidence;
}
export type UsageSource = "provider_usage" | "reconstructed_stream_usage" | "provider_count_tokens" | "tokenizer_estimated" | "heuristic_estimated" | "estimated" | "unavailable";
export type UsageConfidence = "exact" | "high" | "medium" | "low" | "unavailable";
export type UnpricedReason = "model_unmatched" | "model_ambiguous" | "price_unverified" | "usage_unavailable" | "pricing_stale";
export type PricingMatchStrategy =
  | "target_override"
  | "target_model_entry"
  | "official_preset_vendor_exact"
  | "official_preset_vendor_normalized_exact"
  | "target_model_vendor_exact"
  | "target_model_vendor_normalized_exact"
  | "target_vendor_exact"
  | "target_vendor_normalized_exact"
  | "global_exact"
  | "global_exact_vendor_resolved"
  | "global_normalized_exact"
  | "contains"
  | "ambiguous"
  | "unmatched"
  | "unverified"
  | "usage_unavailable";

export interface PricingRates {
  /** 非缓存输入或 cache miss 输入，单位：每百万 token */
  input: number;
  output: number;
  /** cache hit / cache read 输入，单位：每百万 token */
  cachedInput?: number;
  /** cache write / cache creation 输入，单位：每百万 token */
  cacheWrite?: number;
  /** Anthropic 5 分钟缓存写入价格，单位：每百万 token。 */
  cacheWrite5m?: number;
  /** Anthropic 1 小时缓存写入价格，单位：每百万 token。 */
  cacheWrite1h?: number;
  /** 推理 token 单价，当前只保留结构，不默认参与旧 usage 换算 */
  reasoning?: number;
  /**
   * 长上下文阶梯（可选）：判定量 = 净输入 + 缓存读 + 缓存写（不含输出），
   * 严格大于阈值时整单换档——输入侧（含缓存）×inputMultiplier、输出侧 ×outputMultiplier；
   * 字段声明 rates 绝对价时该字段直接用绝对值、不再乘倍率。
   */
  longContext?: LongContextPricingTier;
}

/**
 * 服务档位价格集（2026-09-08 取代旧 serviceTierMultipliers 乘数制）：
 * 请求 service_tier 命中时按字段级稀疏替换「闲时→促销」解析后的价，未声明字段沿用。
 * 本期只开放 fast 键（priority 请求参数同映射 fast 价格集）；flex/batch 键位预留。
 */
/**
 * 服务档位价格（2026-10-07 倍率制重构）：fastMultiplier = fast 档相对请求时刻
 * 实际命中标准价（牌价/闲时/官方促销覆盖后）的倍率（如 2 = 2×，OpenAI 口径）。
 * 倍率作用于各通道自身的基数——官方促销通道得 2×促销价、中转站得 2×牌价，
 * 天然按通道取正确值；并与长上下文档位倍率复合（如 2×fast×2×长档）。
 */
export interface ServiceTierPricing {
  fastMultiplier?: number;
}

export interface ModelUsageSchema {
  fields: Record<string, {unit: string; price?: number; notes?: string}>;
  currency?: string;
  notes?: string;
}

/** 促销公共窗口形状：按量促销与套餐促销共享时间窗与限定维度。 */
export interface PromotionWindow {
  /** 活动开始（含），ISO 8601 时刻。 */
  from: string;
  /** 活动结束（含）；缺省 = 官方未公布截止（无限期）。 */
  to?: string;
  /** 限定模型（缺省 = 本条目全部模型）。 */
  models?: string[];
  /** 限定调用 Agent（账本 agent_name 小写口径）；缺省 = 不限。 */
  agents?: string[];
  /** 展示名（账本快照与 UI 徽标）。 */
  label?: string;
}

/**
 * 按量促销（模型级，2026-09-08 取代旧 promo 单对象）：时间窗命中且目标为官方通道时生效；
 * 效果载体 priceOverride（促销实扣单价，字段级稀疏覆盖）与 multiplier（整单折扣）二选一，
 * 由归一化层强制互斥。与套餐促销（planCreditRules.promotions）分容器存放、绝不跨链。
 */
export interface PaygPromotion extends PromotionWindow {
  priceOverride?: SparsePricingRates;
  multiplier?: number;
  note?: string;
}

/** 快照里的长上下文档位命中信息（审计与展示用）——已拆至客户端安全的 pricing-rates.ts。 */
import {longContextTierRates, resolveLongContextRates, type LongContextMatchInfo} from "./pricing-rates";
export {resolveLongContextRates};
export type {LongContextMatchInfo};

/** 套餐积分模型系数：input/output/cachedInput 为官方公式系数。 */
export interface PlanCreditModelFactor {
  input: number;
  output: number;
  cachedInput?: number;
}

/**
 * 套餐促销每日时间窗（2026-09-08 错峰活动）：与 peakWindows 共享形状/时区，
 * 但不支持跨午夜——23:00~次日 09:00 必须拆 [{23:00,24:00},{00:00,09:00}] 两段维护。
 * includeDates/excludeDates 为目录 v2 节假日标志的编译解析产物（设计 4.4）。
 */
export interface PlanCreditPromotionWindow {
  /** 0=周一..6=周日；缺省 = 每天。 */
  days?: number[];
  start: string;
  end: string;
  includeDates?: string[];
  excludeDates?: string[];
  /** 窗口时区（编译投影携带；缺省沿用 rules.timezone）。 */
  timezone?: string;
}

/** 限时活动抵扣系数：绝对日期区间内覆盖官方基础系数（如火山 glm-5.3-flash 活动 0.25）。 */
export interface PlanCreditPromotion {
  /** 活动开始（含），ISO 8601 时刻。 */
  from: string;
  /** 活动结束（含）；缺省 = 官方未公布截止（无限期）。 */
  to?: string;
  /** 适用的模型（经 aliases 重定向后的模型名）；缺省表示该规则下全部模型。 */
  models?: string[];
  /** 每日时间窗；缺省 = 活动区间内全天生效。命中判定与 peakWindows 同引擎（时区沿用 rules.timezone）。 */
  windows?: PlanCreditPromotionWindow[];
  /** 活动期间的输入抵扣系数覆盖（系数型公式：火山）。 */
  input?: number;
  /** 活动期间的输出抵扣系数覆盖。 */
  output?: number;
  /** 活动期间的缓存命中抵扣系数覆盖（2026-09-30 腾讯 tc-code 活动价三因子同值场景）。 */
  cachedInput?: number;
  /** 活动期间的整体额度扣减倍率（如 ZCode 限时 1.5 倍用量 = 0.67），叠加在时段倍率之后。 */
  multiplier?: number;
  /** 限定享受活动的调用 Agent（账本 agent_name，如 zcode）；缺省表示不限。 */
  agents?: string[];
  /** true 表示活动参数来自实测校准而非官方文档，命中时结果标记 unverified。 */
  unverified?: boolean;
  /** 活动优先级（目录 v2 Campaign 编译投影携带）：override/factor 选胜与展示排序用，缺省 0。 */
  priority?: number;
  /** 活动展示名（目录 v2 Campaign label 投影）：公式与快照展示用。 */
  label?: string;
  /** 每日窗口时区（v2 投影携带；缺省沿用 rules.timezone）。 */
  timezone?: string;
  /**
   * 观测通道限定（2026-09-15 双链路观测）：声明后活动只在对应通道命中
   * （如官方客户端签名活动仅在 agent_local_import 生效，经网关流量官方不认定）；
   * 缺省 = 全通道生效（存量活动行为不变）。
   */
  origins?: string[];
  note?: string;
}

/** 套餐高峰窗口：窗口内按 multiplier 抵扣（如智谱高峰 1、非高峰 0.5）。 */
export interface PlanCreditPeakWindow {
  days?: number[];
  start: string;
  end: string;
  /** 窗口内积分倍率；缺省 1。 */
  multiplier?: number;
  /** excludeHolidays 编译解析产物：命中日期本窗口不匹配（按非高峰处理）。 */
  excludeDates?: string[];
  includeDates?: string[];
}

export interface PlanCreditQuotaWindow {
  id: "5h" | "weekly" | "monthly";
  label: string;
  /** rolling_5h=滚动窗口；fixed_5h=固定 5 小时窗口（如 MiniMax Token Plan，整窗对齐重置）；weekly/monthly=自然周期。 */
  reset: "rolling_5h" | "fixed_5h" | "weekly" | "monthly";
}

/** 套餐积分公式族枚举（computePlanCredit dispatch 与浅校验共用的唯一事实）。 */
const PLAN_CREDIT_FORMULAS: ReadonlySet<string> = new Set(["token_weighted", "money_to_credits", "afp_weighted", "market_share"]);

/** 套餐积分逐请求折算规则：公式、系数与周期窗口。 */
export interface PlanCreditRules {  /** 公式族名（与目录 calculator.kind 同名）：token 系数加权 / 按量金额折积分 / AFP 系数加权 / 市价份额制。 */
  formula: "token_weighted" | "money_to_credits" | "afp_weighted" | "market_share";
  /** 目录 v2 Profile 引用键（编译投影携带；快照/排障定位用，不入用户 UI）。 */
  profileId?: string;
  /** 原币种：CNY/USD；积分口径由 creditsPerCurrency 换算。 */
  currency?: "CNY" | "USD";
  /** 积分单位展示名（如 积分/AFP）；缺省由公式族决定。 */
  unit?: string;
  /** 每 1 原币 = 多少积分；如 MiniMax 中国区 1 元 = 1000/7 积分。 */
  creditsPerCurrency?: number;
  /** 系数分母：智谱/火山 10000、腾讯 TokenHub 1000000。 */
  divisor?: number;
  /** 通用模型系数（智谱/火山/腾讯 TokenHub 积分价）。 */
  modelFactors?: Record<string, PlanCreditModelFactor>;
  /** 高峰窗口；窗口内按 window.multiplier（缺省 1），未命中按 offPeakMultiplier。 */
  peakWindows?: PlanCreditPeakWindow[];
  /** 峰谷窗口 IANA 时区；缺省 Asia/Shanghai。 */
  timezone?: string;
  /** 非高峰倍率；缺省 0.5（智谱官方谷时半价抵扣口径）。 */
  offPeakMultiplier?: number;
  /** 计积分前的模型重定向：官方对历史模型"自动切换新模型计费"语义，键为账本模型名。 */
  aliases?: Record<string, string>;
  /** 限时活动：绝对日期区间内的抵扣系数覆盖，按请求 captured_at 命中。 */
  promotions?: PlanCreditPromotion[];
  /** 档位额度：档位（lite/pro/max…）→ 窗口 id（对应 quotaWindows[].id）→ 额度积分。 */
  quotaTiers?: Record<string, PlanCreditQuotaTier>;
  /** 按次计费工具预留（如 MCP 联网搜索每调用固定积分）；账本暂无调用数据源，仅目录规范。 */
  toolFactors?: PlanCreditToolFactor[];
  quotaWindows: PlanCreditQuotaWindow[];
  /** true 表示社区公式/未公开系数，结果仅供展示参考。 */
  unverified?: boolean;
  notes?: string;
}

/** 套餐档位在各额度窗口内的积分额度（如 Lite 5h=2000/周=10000）。 */
export interface PlanCreditQuotaTier {
  quotaByWindow: Record<string, number>;
  /** 档位月费（目录 planTiers 带入，market_share 档位匹配用；原币种数值）。 */
  monthlyFee?: number;
  notes?: string;
}

/** 按次计费的工具积分成本（每次调用固定扣减）。 */
export interface PlanCreditToolFactor {
  id: string;
  /** 每次调用积分；缺省按 1 计。 */
  perCall?: number;
  notes?: string;
}

/** 解析 "HH:mm" / "HH:mm:ss"，end 可为 "24:00"（表示当天最后一分钟之后）。 */
function parseClockMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (!match) throw new Error(`非法时间窗口时刻: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const isMidnightEnd = hour === 24 && minute === 0 && second === 0;
  if (hour > 24 || minute > 59 || second > 59 || (hour === 24 && !isMidnightEnd)) {
    throw new Error(`非法时间窗口时刻: ${value}`);
  }
  return hour * 60 + minute;
}

/** 判断 instant 是否落在任一窗口（缺省 days 表示每天；end 为开区间；
 *  includeDates 命中即匹配（节假日强制命中），excludeDates 命中即不匹配（节假日剔除），
 *  日期按窗口时区本地日期 YYYY-MM-DD 比较——目录 v2 节假日标志的编译解析产物）。 */
export function isWithinTimeWindows(
  windows: Array<Pick<TemporalPriceScheduleWindow, "days" | "start" | "end"> & Partial<Pick<TemporalPriceScheduleWindow, "includeDates" | "excludeDates">>>,
  instant: Date,
  timezone: string,
): boolean {
  if (!Number.isFinite(instant.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const dayMap: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  const weekdayText = parts.find(part => part.type === "weekday")?.value ?? "Mon";
  const weekday = dayMap[weekdayText] ?? 0;
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? "0");
  const minutes = hour * 60 + minute;
  const localDate = localDateKey(instant, timezone);
  return windows.some(window => {
    if (window.excludeDates?.includes(localDate)) return false;
    if (window.includeDates?.includes(localDate)) return true;
    const days = window.days?.length ? window.days : [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(weekday)) return false;
    const start = parseClockMinutes(window.start);
    const end = parseClockMinutes(window.end);
    return minutes >= start && minutes < end;
  });
}

export interface ResolvedTemporalPricing {
  rates: PricingRates;
  label: string;
  timezone: string;
}

/**
 * 按请求时间解析条目时段费率：
 * - 命中 schedule 窗口 → 窗口费率 + schedule.label；
 * - 配置了 schedule 但未命中任何窗口 → 基础价 + “高峰”；
 * - 无 schedule 或无 capturedAt → undefined。
 */
export function resolveTemporalPricing(
  entry: Pick<ModelPriceEntry, "priceSchedules" | "pricing"> | undefined,
  capturedAt: string | undefined,
): ResolvedTemporalPricing | undefined {
  if (!entry?.priceSchedules?.length || !capturedAt || !entry.pricing) return undefined;
  const instant = new Date(capturedAt);
  if (!Number.isFinite(instant.getTime())) return undefined;
  for (const schedule of entry.priceSchedules) {
    const timezone = schedule.timezone || "Asia/Shanghai";
    // 节假日优先：即使落在高峰窗口也按闲时费率计费。
    if (schedule.holidays?.length && schedule.holidays.includes(localDateKey(instant, timezone))) {
      return { rates: schedule.rates, label: schedule.label, timezone };
    }
    if (isWithinTimeWindows(schedule.windows, instant, timezone)) {
      return { rates: schedule.rates, label: schedule.label, timezone };
    }
  }
  const timezone = entry.priceSchedules[0]?.timezone || "Asia/Shanghai";
  return { rates: entry.pricing, label: "高峰", timezone };
}

/** 请求时刻在指定时区下的本地日期（YYYY-MM-DD），用于节假日匹配。 */
function localDateKey(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find(part => part.type === "year")?.value;
  const month = parts.find(part => part.type === "month")?.value;
  const day = parts.find(part => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export interface PricingSnapshot {
  /** 计价单位（2026-09-15 去币种化命名）：新写入一律 per_million_tokens；
   * 保留历史值 USD_per_million_tokens 仅为兼容旧账本快照读取，币种看 currency 字段。 */
  unit: "per_million_tokens" | "USD_per_million_tokens";
  matchedModel?: string;
  vendor?: string;
  priceEntryId?: string;
  /** 命中条目的上下文窗口（tokens）；随快照冻结，供「模型参数」模块展示，旧数据缺省。 */
  contextWindow?: number;
  overrideId?: string;
  sourceUrl?: string;
  confidence?: PricingConfidence;
  matchStrategy: PricingMatchStrategy;
  ambiguousCandidates?: Array<{ id: string; vendor: string }>;
  baseRates?: PricingRates;
  rateMultiplier: number;
  effectiveRates?: PricingRates;
  /** 命中时段窗口的标签（闲时）或未命中任何窗口的高峰标签；无 schedule 时缺省。 */
  scheduleLabel?: string;
  /** 时段规则使用的 IANA 时区；有 schedule 时写入。 */
  timezone?: string;
  /** 长上下文档位命中信息；配置了阶梯且判定量超过阈值时写入。 */
  longContext?: LongContextMatchInfo;
  /** 命中的按量促销展示名（2026-09-08 促销链，取代旧 promoApplied 布尔）；未命中或非官方通道时缺省。 */
  promotionLabel?: string;
  /** 本单命中的服务档位请求参数（fast/priority）；未命中时缺省。 */
  serviceTier?: string;
  /** 目录 v2 来源定位（9.1 排障字段；不入用户 UI）。 */
  catalogRevision?: string;
  catalogSourceHash?: string;
  /** 本条目本次价格变化的官方生效时刻（effectiveFrom 徽标数据）。 */
  effectiveFrom?: string;
  /**
   * 套餐积分换算公式（套餐/订阅通道随快照冻结，2026-09-23）：
   * formula 为单行摘要、formulaDetail 为逐项明细，供「估算真实成本（套餐成本估算）」
   * 的 ？浮窗展示；按量通道快照不携带。
   */
  planCreditFormula?: string;
  planCreditFormulaDetail?: string;
}

export interface PricingCatalogSource {
  type: "built_in" | "litellm" | "manual" | "provider_catalog";
  url?: string;
  fetchedAt?: string;
  hash?: string;
  modelCount?: number;
}

export interface ModelPriceEntry {
  id: string;
  vendor: string;
  /** 价格中心唯一性与代理白名单使用的上游运行时模型 ID。 */
  runtimeModelId?: string;
  /** v1 兼容字段；v2 优先使用 patterns。 */
  match?: string;
  patterns: string[];
  aliases?: string[];
  mode?: string;
  contextWindow?: number;
  maxOutput?: number;
  litellmProvider?: string;
  /** 项目目录供应商变体；与模型 ID 共同组成目录逻辑唯一键。 */
  pricingProviderId?: string;
  region?: "cn" | "global";
  catalogSource?: "catalog";
  /** 官方牌价：中转站计费基准与市价口径。 */
  pricing?: PricingRates;
  usageSchema?: ModelUsageSchema;
  /** 服务档位价格集（可选）：请求 service_tier=fast/priority 时字段级替换；override 生效时跳过。 */
  serviceTierPricing?: ServiceTierPricing;
  /** 按量促销（可选）：时间窗命中且官方通道时生效；与套餐促销分容器存放（2026-09-08 取代 promo）。 */
  promotions?: PaygPromotion[];
  /** 手动覆盖前的原始价格（仅 user_override 条目记录）：用于列表展示「被覆盖」的划掉旧价。 */
  previousPricing?: PricingRates;
  currency?: string;
  confidence: PricingConfidence;
  sourceUrl?: string;
  sourceCheckedAt?: string;
  deprecatedAt?: string;
  notes?: string;
  /** 时段费率：base 保持基础价（高峰），窗口内使用 rates。 */
  priceSchedules?: TemporalPriceSchedule[];
  /** 套餐积分逐请求折算规则；仅套餐通道供应商使用。 */
  planCreditRules?: PlanCreditRules;
  /** 目录 v2 来源版本（编译投影携带；审计与快照定位用，不入用户 UI）。 */
  catalogRevision?: string;
  /** 目录 v2 源哈希（sha256:<hex>，加载器计算）。 */
  catalogSourceHash?: string;
  /**
   * 模型协议能力（终极方案：价格中心=模型与价格中心，wireApis 随官方目录自动更新；
   * 目标经同步任务物化到 supportedModelWireApis，代理侧不读价格中心）。
   */
  supportedWireApis?: WireApi[];
  /**
   * 模型输入模态（2026-09-21 能力下发）：价格中心为模型能力唯一真源，随官方目录自动更新
   * （followOfficial 语义与 wireApis 一致）；消费端经 config-sync 共享解析层映射到各 Agent
   * CLI 配置与开发启动弹窗。缺省 = ["text"]（保守，由解析层兜底）。
   */
  inputModalities?: InputModality[];
  /**
   * 价格时间线（终极方案）：官方调价按时间区间维护，同一时间唯一价格；计费按
   * captured_at 选段（effectiveFrom ≤ captured_at 的最后一段，无匹配取首段）。
   * 顶层 pricing 等字段恒为「最后一段」快照，供无时间线消费方兼容。
   * user_override 手工价时间不变（时间线仅参考展示，不参与手工价计费）。
   */
  rateTimeline?: PriceRateSegment[];
}

/** 价格中心时间线段（与目录 CatalogRateSegment 同构；priceSchedules 已编译解析节假日）。 */
export interface PriceRateSegment {
  /** 官方生效时刻（RFC 3339 带时区）；首段缺省 = 历史现状（一直如此）。 */
  effectiveFrom?: string;
  pricing: PricingRates;
  priceSchedules?: TemporalPriceSchedule[];
  serviceTierPricing?: ServiceTierPricing;
  planFactors?: PlanCreditModelFactor;
  /** 公告式摘要文案（通知项与 UI 时间线顶部展示）。 */
  changeNote?: string;
}

export interface TargetPricingOverride {
  id: string;
  targetId?: string;
  agentFingerprintId?: string;
  patterns: string[];
  pricing?: PricingRates;
  /** 时段费率：支持分别覆盖高峰基础价与闲时窗口价；缺省表示固定覆盖。 */
  priceSchedules?: TemporalPriceSchedule[];
  currency?: string;
  confidence: "user_override" | "third_party" | "provider_docs" | "relay_synced";
  sourceUrl?: string;
  sourceCheckedAt?: string;
  notes?: string;
}

export interface PricingConfigV2 {
  version: 2;
  currency: string;
  unit: "per_million_tokens" | string;
  sourceCheckedAt?: string;
  catalogSource?: PricingCatalogSource;
  models: ModelPriceEntry[];
  targetOverrides?: TargetPricingOverride[];
  targetVendorPreferences?: Record<string, string>;
  /** 代理供应商 → 支持模型 → 价格中心条目映射；用于同名模型跨供应商消歧与供应商展示。 */
  targetModelMappings?: Record<string, Record<string, ProxyTargetModelVendor>>;
  /**
   * 目标级结算系数（牌价数字 → 人民币，2026-09-23 方案 B 随价格配置版本化）：
   * 键为供应商目标路由 ID，值 = 系数乘数（1:16 录入存 0.0625）。随 policy blob 序列化
   * 并参与语义哈希——修改结算系数即产生新价格版本，派生按 captured_at 选版本值
   * （迟到行按捕获时刻系数入账）；历史版本 blob 无此字段时消费端回退现读值。
   */
  targetSettlementFx?: Record<string, number>;
  /** 国内目录价格沿用 USD 字段但保留官方原始数值，调用方必须展示未换算提示。 */
  unconvertedCatalogPricing?: boolean;
  /**
   * 汇率快照（2026-09-05 四层分离）：目录按原始币种维护，展示层按此快照拉平为人民币。
   * 账本写入时把当时汇率锁进价格快照，历史不随后续汇率变动重算。
   */
  fx?: PricingFxSnapshot;
  /** 官方目录同步标记（四原则：新增自动/变更未使用自动/变更使用中确认/永不删除）。 */
  catalogSync?: PricingCatalogSyncMarker;
  /** LiteLLM 导入标记：最近一次导入完成时间与合并后条数（价格中心版本条展示用）。 */
  litellmSync?: PricingLiteLLMSyncMarker;
}

/**
 * 官方目录同步标记（v2 七章：自动生效 + 通知已阅制）：runner 写入、GET 通知栏读取；
 * LiteLLM 导入不得覆写该字段（mergeLiteLLMPricingConfig 原样保留）。
 */
export interface PricingCatalogSyncMarker {
  /** 最近一次同步（自动生效）完成的目录发布时间（RFC 3339）。 */
  lastSyncedPublishedAt?: string;
  /** 最近一次同步完成的目录版本号（同日多版区分）。 */
  lastSyncedCatalogRevision?: string;
  /**
   * 最近一次同步的源哈希（加载器按当前代码解析目录后计算）：
   * 版本相同但哈希不同（代码升级改变解析/投影结果，或上次同步部分应用）时强制重同步自愈——
   * 否则旧代码消费过某目录版本后，该版本的投影字段永远无法回填。
   */
  lastSyncedSourceHash?: string;
  syncedAt?: string;
  /**
   * 官方目录更新通知（有界保留最近 50 个目录版本）：未阅在上、已阅（ackedAt）进入历史；
   * 2026-09-10 决策取代原 dismissed 忽略记录——变化始终自动生效，通知只承载知情。
   */
  notifications?: PricingCatalogUpdateNotification[];
  /** 兼容读取：旧确认制时代的忽略记录（键 "vendor/modelId"）；迁移时一次性清理。 */
  dismissed?: Record<string, string>;
}

/** 单个目录版本的通知项（未阅/已阅共用结构）。 */
export interface PricingCatalogUpdateNotification {
  catalogRevision: string;
  publishedAt: string;
  createdAt: string;
  /** 用户确认知晓的时刻；缺省=未阅。 */
  ackedAt?: string;
  /** 本批最早官方生效时刻（effectiveFrom 徽标）。 */
  effectiveFrom?: string;
  items: PricingCatalogNotificationItem[];
}

export interface PricingCatalogNotificationItem {
  vendor: string;
  providerName: string;
  modelId: string;
  /** 逐字段 Diff（含时段费率费率级明细）。 */
  changes: Array<{field: string; label: string; before?: string; after: string; kind: "changed" | "added" | "removed"}>;
  /** 该模型本次变化的官方生效时刻（时间线变化段）。 */
  effectiveFrom?: string;
  /** 公告式摘要文案（变化段 changeNote；通知项与 UI 时间线顶部展示）。 */
  changeNote?: string;
  /** 价格时间线（变化后的完整段列表；UI 时间区间展示用，有界 ≤8）。 */
  rateTimeline?: PriceRateSegment[];
  /** 使用中标注（usage 快照命中）。 */
  inUse?: boolean;
}

/** 目录同步标记浅校验：版本字符串与通知列表有界（防异常膨胀）；dismissed 读取时剔除（迁移一次性清理）。 */
function normalizeCatalogSyncMarker(value: unknown): PricingCatalogSyncMarker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<PricingCatalogSyncMarker>;
  const notifications = Array.isArray(raw.notifications)
    ? raw.notifications.filter((item): item is PricingCatalogUpdateNotification =>
        !!item && typeof item === "object"
        && typeof item.catalogRevision === "string" && item.catalogRevision.length <= 32
        && typeof item.publishedAt === "string" && item.publishedAt.length <= 64
        && Array.isArray(item.items) && item.items.length <= 500)
        .map(item => ({
          catalogRevision: item.catalogRevision,
          publishedAt: item.publishedAt,
          createdAt: typeof item.createdAt === "string" && item.createdAt.length <= 64 ? item.createdAt : item.publishedAt,
          ...(typeof item.ackedAt === "string" && item.ackedAt.length <= 64 ? {ackedAt: item.ackedAt} : {}),
          ...(typeof item.effectiveFrom === "string" && item.effectiveFrom.length <= 64 ? {effectiveFrom: item.effectiveFrom} : {}),
          items: item.items.slice(0, 500).map(entry => ({
            vendor: String(entry.vendor ?? "").slice(0, 128),
            providerName: String(entry.providerName ?? "").slice(0, 256),
            modelId: String(entry.modelId ?? "").slice(0, 256),
            changes: Array.isArray(entry.changes) ? entry.changes.slice(0, 64) : [],
            ...(typeof entry.effectiveFrom === "string" ? {effectiveFrom: entry.effectiveFrom} : {}),
            ...(typeof entry.changeNote === "string" ? {changeNote: entry.changeNote.slice(0, 2048)} : {}),
            ...(Array.isArray(entry.rateTimeline) ? {rateTimeline: entry.rateTimeline.slice(0, 8)} : {}),
            ...(entry.inUse === true ? {inUse: true} : {}),
          })),
        }))
        .slice(0, 50)
    : undefined;
  return {
    ...(typeof raw.lastSyncedPublishedAt === "string" && raw.lastSyncedPublishedAt.length <= 64
      ? {lastSyncedPublishedAt: raw.lastSyncedPublishedAt} : {}),
    ...(typeof raw.lastSyncedCatalogRevision === "string" && raw.lastSyncedCatalogRevision.length <= 32
      ? {lastSyncedCatalogRevision: raw.lastSyncedCatalogRevision} : {}),
    ...(typeof raw.lastSyncedSourceHash === "string" && raw.lastSyncedSourceHash.length <= 128
      ? {lastSyncedSourceHash: raw.lastSyncedSourceHash} : {}),
    ...(typeof raw.syncedAt === "string" && raw.syncedAt.length <= 64 ? {syncedAt: raw.syncedAt} : {}),
    ...(notifications && notifications.length > 0 ? {notifications} : {}),
  };
}

/** LiteLLM 导入标记：只保留有界的时间与计数，供价格中心版本条展示「导入完成时间」。 */
export interface PricingLiteLLMSyncMarker {
  syncedAt?: string;
  modelCount?: number;
}

function normalizeLiteLLMSyncMarker(value: unknown): PricingLiteLLMSyncMarker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<PricingLiteLLMSyncMarker>;
  return {
    ...(typeof raw.syncedAt === "string" && raw.syncedAt.length <= 64 ? {syncedAt: raw.syncedAt} : {}),
    ...(typeof raw.modelCount === "number" && Number.isFinite(raw.modelCount) && raw.modelCount >= 0
      ? {modelCount: Math.floor(raw.modelCount)} : {}),
  };
}

/**
 * 价格条目来源类别（2026-09-07 价格中心筛选维度）：
 * - manual：人工维护（纯手工新增，或在 LiteLLM/官方价格基础上修改过——均写入 user_override）。
 * - catalog：DeepAA 官方预设目录条目。
 * - litellm：LiteLLM 兜底条目。
 * - pending：随版本内置占位（待确认），量极少；仅存在时在筛选里出现。
 */
export type PricingEntrySourceCategory = "manual" | "catalog" | "litellm" | "pending";

export function pricingEntrySourceCategory(entry: ModelPriceEntry): PricingEntrySourceCategory {
  if (entry.confidence === "user_override") return "manual";
  if (entry.catalogSource === "catalog" || entry.confidence === "official" || entry.confidence === "provider_docs") return "catalog";
  if (entry.confidence === "third_party") return "litellm";
  return "pending";
}

/** 筛选键与 fx 汇率纯函数位于客户端安全模块（pricing-model-entry），这里再导出保持服务端单一入口。 */
export {DEFAULT_USD_CNY_RATE, parsePricingModelEntryKey, pricingModelEntryKey, resolveFxRate} from "./pricing-model-entry";
export type {PricingCatalogModelEntry, PricingFxSnapshot} from "./pricing-model-entry";

export interface PricingCatalogQuery {
  search?: string;
  vendor?: string;
  mode?: string;
  /** 多选精确过滤（价格中心筛选器）：空数组/缺省 = 不过滤。 */
  vendors?: string[];
  /** 条目级多选过滤（供应商 + 运行时模型成对精确匹配，大小写不敏感）；空数组/缺省 = 不过滤。 */
  modelEntries?: PricingCatalogModelEntry[];
  categories?: PricingEntrySourceCategory[];
  limit?: number;
  offset?: number;
}

export interface PricingCatalogPage {
  items: ModelPriceEntry[];
  total: number;
  limit: number;
  offset: number;
  facets: {
    vendors: string[];
    modes: string[];
    /** 全量模型运行时 ID（去重，按名称排序）。 */
    models: string[];
    /** 模型 × 供应商条目候选（价格中心「模型」筛选展示「模型 - 供应商」，同名模型按条目不去重）。 */
    modelEntries: PricingCatalogModelEntry[];
    /** 来源类别计数（价格中心「来源类别」筛选展示用）。 */
    categoryCounts: Record<PricingEntrySourceCategory, number>;
  };
  catalogSource?: PricingCatalogSource;
  catalogSync?: PricingCatalogSyncMarker;
  litellmSync?: PricingLiteLLMSyncMarker;
  /**
   * DeepAA 官方预设上游同步状态（2026-09-07 价格中心版本条）：
   * 由 API 路由基于本地目录缓存只读填充（绝不触网，缓存由后端定时任务刷新）；
   * queryPricingCatalog 纯函数不填该字段。
   */
  upstreamCatalog?: {
    /** 本地目录缓存中的上游目录版本（最近一次成功触达上游时的内容）。 */
    publishedAt?: string;
    /** true = 缓存来自上游（remote/file-cache，远程至少成功拉取过）；false = 仅随包目录，无法确认上游状态。 */
    seenUpstream: boolean;
  };
  unconvertedCatalogPricing?: boolean;
  restoreAvailability?: Record<string, {
    source: "official" | "litellm";
    sourceState: "current_official" | "historical_official" | "litellm_baseline" | "litellm_snapshot";
    sourceRevision?: string;
    sourceHash?: string;
    sourceCapturedAt?: string;
    targetOverrides?: Array<{targetId: string; targetName: string; targetModelId: string}>;
  }>;
}

export interface PricingVendorList {
  vendors: string[];
  catalogSource?: PricingCatalogSource;
  unconvertedCatalogPricing?: boolean;
}

export interface LegacyModelPriceEntry {
  id: string;
  match: string;
  vendor: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface LegacyPricingConfig {
  version: 1;
  currency: string;
  unit: string;
  models: LegacyModelPriceEntry[];
}

export type PricingConfig = PricingConfigV2 | LegacyPricingConfig;

/** 通用 token 用量接口，兼容 step.tokenUsage 与 TokenUsageSummary */
export interface TokenUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Anthropic 5 分钟缓存写入 Token；缺省时回退总 cacheCreationTokens。 */
  cacheCreation5mTokens?: number;
  /** Anthropic 1 小时缓存写入 Token；缺省时回退总 cacheCreationTokens。 */
  cacheCreation1hTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** 请求体携带的 service_tier 参数（priority/flex 等）；命中乘数规则时整单乘系数。 */
  serviceTier?: string;
}

export interface TokenCost extends TokenUsageInput {
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheCreationCost?: number;
  cacheCreation5mCost?: number;
  cacheCreation1hCost?: number;
  reasoningCost?: number;
  /** 展示口径：target override 后的实际费用；无 override 时等于官方费用 */
  totalCost?: number;
  /** 官方直连成本；命中官方价时保留，用于和中转站价格对比 */
  officialTotalCost?: number;
  currency: string;
  priced: boolean;
  matchedModel?: string;
  vendor?: string;
  confidence?: PricingConfidence;
  sourceUrl?: string;
  priceVersion: number;
  priceEntryId?: string;
  overrideId?: string;
  unpricedReason?: UnpricedReason;
  formula?: string;
  pricingSnapshot?: PricingSnapshot;
}

export interface TokenCostSummary {
  priced: boolean;
  currency: string;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheCreationCost?: number;
  cacheCreation5mCost?: number;
  cacheCreation1hCost?: number;
  reasoningCost?: number;
  totalCost?: number;
  officialTotalCost?: number;
  /**
   * 倍率后实际成本的人民币口径（2026-09-23）：原币种 × 入账冻结结算系数；
   * 会话追踪总览「估算真实成本」消费，与 Token 价格页明细同口径。
   * 旧数据（fx 时代之前/无账本）缺省，消费端回退 totalCost。
   */
  totalCostCny?: number;
  /** 入账冻结的结算系数（原币种 → 人民币）；估算真实成本公式浮窗的折算行用。 */
  fxRateToCny?: number;
  unpricedReason?: UnpricedReason;
}

export interface ModelCostBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCost: number;
  officialTotalCost: number;
  stepCount: number;
  pricedSteps: number;
  unpricedSteps: number;
}

export interface CostAggregate {
  schemaVersion: 2;
  priceVersion: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCost: number;
  officialTotalCost: number;
  currency: string;
  pricedSteps: number;
  unpricedSteps: number;
  byModel: Record<string, ModelCostBreakdown>;
  unpricedReasons: Partial<Record<UnpricedReason, number>>;
  byUsageSource: Record<string, number>;
  byUsageConfidence: Record<string, number>;
  /** 请求总数包含模型 Step 与辅助请求。 */
  requestCount: number;
  stepRequestCount: number;
  auxiliaryRequestCount: number;
  durationTotalMs: number;
  durationSampleCount: number;
  toolCallCount: number;
  toolCallsByName: Record<string, number>;
}

export interface RequestAggregateMetrics {
  durationMs?: number;
  toolUseNames?: string[];
  toolUseIds?: string[];
}

export interface UsageLedgerInput {
  targetId: string;
  agentFingerprintId: string;
  agentName?: string;
  sessionId: string;
  turnId: string;
  nativeTurnId?: string;
  stepId?: string;
  exchangeId: string;
  model?: string;
  usage?: TokenUsageInput;
  usageSource?: UsageSource;
  usageConfidence?: UsageConfidence;
  createdAt: string;
  durationMs?: number;
}

export interface UsageLedgerEntry extends UsageLedgerInput, TokenUsageInput {
  schemaVersion: 1;
  priceVersion: number;
  vendor?: string;
  priceEntryId?: string;
  overrideId?: string;
  priced: boolean;
  unpricedReason?: UnpricedReason;
  currency: string;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheCreationCost?: number;
  cacheCreation5mCost?: number;
  cacheCreation1hCost?: number;
  reasoningCost?: number;
  totalCost?: number;
  officialTotalCost?: number;
  formula?: string;
  pricingSnapshot?: PricingSnapshot;
}

export interface CostComputationContext {
  targetId?: string;
  agentFingerprintId?: string;
  /** 发起调用的 Agent（账本 agent_name）；按量促销 agents 限定时用于匹配。 */
  agentName?: string;
  /** 按请求密钥解析的价格倍率（优先级高于供应商级配置），随 raw 凭据追溯。 */
  rateMultiplierOverride?: number;
  /**
   * 官方预设的价格供应商标识（2026-09-05 双价结构）：目标本身是官方通道时传入；
   * 命中条目 vendor 与其一致时按量促销（promotions）生效（中转站仍按牌价）。
   * 2026-10-06 起兼任匹配兜底优先档：目标条目映射悬空（目录改键/条目删除）时，
   * 先在该 vendor 内精确匹配（链1 官方目录真相源优先，防止 vendor 字符串兜底
   * 静默滑进 LiteLLM 同名第三方命名空间——deepseek 事故：USD 牌价 1:1 记人民币）。
   */
  officialPresetVendor?: string;
  /**
   * 请求所属计费通道（2026-09-10 阶段 0 通道边界）：plan/subscription 通道不套用
   * PAYG 促销（Campaign 三链隔离）；缺省按 pay_as_you_go 处理（保留 UI 估算等无通道调用方行为）。
   */
  billingChannel?: "pay_as_you_go" | "plan" | "subscription";
  /** 请求捕获时间 ISO 字符串；用于匹配时段费率与促销时间窗，缺省不匹配。 */
  capturedAt?: string;
}

const DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing";
const KIMI_K26_SOURCE = "https://platform.kimi.ai/docs/pricing/chat-k26.md";
const KIMI_V1_SOURCE = "https://platform.kimi.ai/docs/pricing/chat-v1.md";
const OFFICIAL_CHECKED_AT = "2026-07-08";

/** 默认预置价格（单位：美元/百万 token）。未核实模型只作为匹配占位，不参与默认计价。 */
export const DEFAULT_PRICING: PricingConfigV2 = {
  version: 2,
  currency: "USD",
  unit: "per_million_tokens",
  sourceCheckedAt: OFFICIAL_CHECKED_AT,
  catalogSource: {
    type: "built_in",
    fetchedAt: OFFICIAL_CHECKED_AT,
    modelCount: 0,
  },
  models: [
    official("claude-opus-4", "Anthropic", ["claude-opus-4", "claude-opus"], { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 }, "unverified", undefined, "Anthropic 官方价当前环境未能稳定访问，保留为待确认占位。"),
    official("claude-sonnet-4", "Anthropic", ["claude-sonnet-4", "claude-sonnet"], { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }, "unverified", undefined, "Anthropic 官方价当前环境未能稳定访问，保留为待确认占位。"),
    official("claude-haiku", "Anthropic", ["claude-haiku"], { input: 0.8, output: 4, cachedInput: 0.08, cacheWrite: 1 }, "unverified", undefined, "Anthropic 官方价当前环境未能稳定访问，保留为待确认占位。"),

    official("gpt-5", "OpenAI", ["gpt-5"], { input: 5, output: 15, cachedInput: 1.25 }, "unverified", undefined, "OpenAI 价格页当前返回 Cloudflare challenge，默认不作为官方计价依据。"),
    official("gpt-4.1", "OpenAI", ["gpt-4.1"], { input: 2, output: 8, cachedInput: 0.5 }, "unverified", undefined, "OpenAI 价格页当前返回 Cloudflare challenge，默认不作为官方计价依据。"),
    official("gpt-4o-mini", "OpenAI", ["gpt-4o-mini"], { input: 0.15, output: 0.6, cachedInput: 0.075 }, "unverified", undefined, "OpenAI 价格页当前返回 Cloudflare challenge，默认不作为官方计价依据。"),
    official("gpt-4o", "OpenAI", ["gpt-4o"], { input: 2.5, output: 10, cachedInput: 1.25 }, "unverified", undefined, "OpenAI 价格页当前返回 Cloudflare challenge，默认不作为官方计价依据。"),

    official("deepseek-v4-pro", "DeepSeek", ["deepseek-v4-pro"], { input: 0.435, output: 0.87, cachedInput: 0.003625 }, "official", DEEPSEEK_SOURCE),
    official("deepseek-v4-flash", "DeepSeek", ["deepseek-v4-flash", "deepseek-chat"], { input: 0.14, output: 0.28, cachedInput: 0.0028 }, "official", DEEPSEEK_SOURCE),
    official("deepseek-reasoner", "DeepSeek", ["deepseek-reasoner"], { input: 0.14, output: 0.28, cachedInput: 0.0028 }, "official", DEEPSEEK_SOURCE, "DeepSeek 官方说明 deepseek-reasoner 兼容映射为 deepseek-v4-flash thinking 模式。"),

    official("kimi-k2.6", "Moonshot", ["kimi-k2.6"], { input: 0.95, output: 4, cachedInput: 0.16 }, "official", KIMI_K26_SOURCE),
    official("moonshot-v1-128k", "Moonshot", ["moonshot-v1-128k"], { input: 2, output: 5 }, "official", KIMI_V1_SOURCE),
    official("moonshot-v1-32k", "Moonshot", ["moonshot-v1-32k"], { input: 1, output: 3 }, "official", KIMI_V1_SOURCE),
    official("moonshot-v1-8k", "Moonshot", ["moonshot-v1-8k", "moonshot-v1"], { input: 0.2, output: 2 }, "official", KIMI_V1_SOURCE),

    official("glm-5.2", "Zhipu", ["glm-5.2"], undefined, "unverified", "https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2", "模型存在和 usage 结构已确认，逐 token API 单价待官方价格页二次确认。"),
    official("glm-5.1", "Zhipu", ["glm-5.1"], undefined, "unverified", "https://docs.bigmodel.cn/api-reference/模型-api/对话补全", "逐 token API 单价待官方价格页二次确认。"),
    official("glm-5", "Zhipu", ["glm-5"], undefined, "unverified", "https://docs.bigmodel.cn/api-reference/模型-api/对话补全", "逐 token API 单价待官方价格页二次确认。"),
    official("qwen3.7-max", "AlibabaCloud", ["qwen3.7-max"], undefined, "unverified", "https://help.aliyun.com/zh/model-studio/models", "模型列表可确认，价格待官方页或控制台二次确认。"),
    official("qwen3.7-plus", "AlibabaCloud", ["qwen3.7-plus"], undefined, "unverified", "https://help.aliyun.com/zh/model-studio/models", "模型列表可确认，价格待官方页或控制台二次确认。"),
    official("minimax-m3", "MiniMax", ["minimax-m3", "minimax"], undefined, "unverified", "https://platform.minimaxi.com/docs/pricing/overview", "价格文档入口可定位，逐 token API 单价待二次确认。"),
    official("gemini", "Google", ["gemini"], undefined, "unverified", "https://ai.google.dev/gemini-api/docs/pricing", "官方价格页本环境连接超时，待二次确认。"),
  ],
};

function official(
  id: string,
  vendor: string,
  patterns: string[],
  pricing: PricingRates | undefined,
  confidence: PricingConfidence,
  sourceUrl?: string,
  notes?: string,
): ModelPriceEntry {
  return {
    id,
    vendor,
    match: patterns[0],
    patterns,
    pricing,
    currency: "USD",
    confidence,
    sourceUrl,
    sourceCheckedAt: OFFICIAL_CHECKED_AT,
    notes,
  };
}

interface PricingMatchCandidate {
  id: string;
  vendor: string;
}

interface PricingMatchResult {
  entry?: ModelPriceEntry;
  strategy: PricingMatchStrategy;
  ambiguousCandidates?: PricingMatchCandidate[];
}

interface GenericMatchResult<T> {
  entry?: T;
  ambiguous?: T[];
}

/** 按模型名匹配价格条目：先精确、再规范化精确，最后才做最长 contains 兜底。 */
export function matchPriceEntry(config: PricingConfig, model: string | undefined): ModelPriceEntry | undefined {
  if (!model) return undefined;
  const normalized = normalizePricingConfig(config);
  return resolvePriceMatch(normalized, model).entry;
}

function resolvePriceMatch(config: PricingConfigV2, model: string | undefined, context: CostComputationContext = {}): PricingMatchResult {
  if (!model) return { strategy: "unmatched" };
  const targetVendor = normalizedVendor(context.targetId ? config.targetVendorPreferences?.[context.targetId] : undefined);
  const rawModel = normalizeComparable(model);
  const normalizedModel = normalizeComparable(normalizeRuntimeModelName(model));
  // 供应商保存支持模型时落库的价格中心条目映射：同名模型跨供应商时以此唯一消歧。
  const mapping = context.targetId ? config.targetModelMappings?.[context.targetId]?.[model] : undefined;

  if (mapping?.priceEntryId) {
    const mappedEntry = config.models.find(item => item.id === mapping.priceEntryId);
    if (mappedEntry
      && (!mapping.vendor || entryMatchesVendor(mappedEntry, mapping.vendor))
      && entryMatchesRuntimeModel(mappedEntry, model)) {
      return { entry: mappedEntry, strategy: "target_model_entry" };
    }
    // 条目已从价格中心移除时继续按供应商与全局匹配兜底。
  }
  /* 官方预设悬空映射防御（2026-10-06）：映射条目不存在（目录改键/条目被删除）时，
     优先回落到预设官方目录 vendor（如 deepseek-cn）内精确匹配，再考虑旧 vendor 字符串
     兜底——官方目录是链1 真相源，且旧 vendor 键可能与 LiteLLM 第三方命名空间同名
     （deepseek→deepseek-cn 改键后 `vendor:"deepseek"` 精确命中 LiteLLM USD 条目，
     叠加 fx 缺口把美元 1:1 记成人民币）。仅悬空时介入：用户显式映射（priceEntryId
     有效命中）仍最优先；官方 vendor 内无该模型时落回原有匹配链，行为不变。 */
  const officialPresetVendor = normalizedVendor(context.officialPresetVendor);
  if (officialPresetVendor) {
    const officialEntries = config.models.filter(entry => entryMatchesVendor(entry, officialPresetVendor));
    const officialExact = matchExactEntry(officialEntries, rawModel);
    if (officialExact.entry) return { entry: officialExact.entry, strategy: "official_preset_vendor_exact" };
    const officialNormalizedExact = matchExactEntry(officialEntries, normalizedModel, true);
    if (officialNormalizedExact.entry) {
      return { entry: officialNormalizedExact.entry, strategy: "official_preset_vendor_normalized_exact" };
    }
  }
  if (mapping?.vendor) {
    const mappedVendorEntries = config.models.filter(entry => entryMatchesVendor(entry, mapping.vendor!));
    const mappedVendorExact = matchExactEntry(mappedVendorEntries, rawModel);
    if (mappedVendorExact.entry) return { entry: mappedVendorExact.entry, strategy: "target_model_vendor_exact" };
    const mappedVendorNormalizedExact = matchExactEntry(mappedVendorEntries, normalizedModel, true);
    if (mappedVendorNormalizedExact.entry) {
      return { entry: mappedVendorNormalizedExact.entry, strategy: "target_model_vendor_normalized_exact" };
    }
  }

  let targetEntries: ModelPriceEntry[] = [];
  if (targetVendor) {
    targetEntries = config.models.filter(entry => entryMatchesVendor(entry, targetVendor));
    const exact = matchExactEntry(targetEntries, rawModel);
    if (exact.entry) return { entry: exact.entry, strategy: "target_vendor_exact" };
    const normalizedExact = matchExactEntry(targetEntries, normalizedModel, true);
    if (normalizedExact.entry) return { entry: normalizedExact.entry, strategy: "target_vendor_normalized_exact" };
  }

  const globalExact = matchExactEntry(config.models, rawModel);
  if (globalExact.ambiguous?.length) {
    const vendorResolved = resolveAmbiguousCandidates(globalExact.ambiguous, mapping?.vendor);
    if (vendorResolved) return { entry: vendorResolved, strategy: "global_exact_vendor_resolved" };
    return { strategy: "ambiguous", ambiguousCandidates: globalExact.ambiguous.map(matchCandidate) };
  }
  if (globalExact.entry) return { entry: globalExact.entry, strategy: "global_exact" };

  const globalNormalizedExact = matchExactEntry(config.models, normalizedModel, true);
  if (globalNormalizedExact.ambiguous?.length) {
    const vendorResolved = resolveAmbiguousCandidates(globalNormalizedExact.ambiguous, mapping?.vendor);
    if (vendorResolved) return { entry: vendorResolved, strategy: "global_exact_vendor_resolved" };
    return { strategy: "ambiguous", ambiguousCandidates: globalNormalizedExact.ambiguous.map(matchCandidate) };
  }
  if (globalNormalizedExact.entry) return { entry: globalNormalizedExact.entry, strategy: "global_normalized_exact" };

  if (targetEntries.length > 0) {
    const targetContains = matchContainsEntry(targetEntries, model);
    if (targetContains.ambiguous?.length) {
      return { strategy: "ambiguous", ambiguousCandidates: targetContains.ambiguous.map(matchCandidate) };
    }
    if (targetContains.entry) return { entry: targetContains.entry, strategy: "contains" };
  }

  const contains = matchContainsEntry(config.models, model);
  if (contains.ambiguous?.length) {
    return { strategy: "ambiguous", ambiguousCandidates: contains.ambiguous.map(matchCandidate) };
  }
  if (contains.entry) return { entry: contains.entry, strategy: "contains" };
  return { strategy: "unmatched" };
}

/** 全局匹配出现同名多供应商歧义时，按供应商保存的模型供应商收敛候选；唯一命中才可消歧。 */
function resolveAmbiguousCandidates(
  candidates: ModelPriceEntry[],
  vendor: string | undefined,
): ModelPriceEntry | undefined {
  if (!vendor) return undefined;
  const matched = candidates.filter(entry => entryMatchesVendor(entry, vendor));
  return matched.length === 1 ? matched[0] : undefined;
}

function matchCandidate(entry: ModelPriceEntry): PricingMatchCandidate {
  return { id: entry.id, vendor: entry.vendor };
}

function entryMatchesVendor(entry: ModelPriceEntry, vendor: string): boolean {
  return normalizedVendor(entry.vendor) === vendor || normalizedVendor(entry.litellmProvider) === vendor;
}

function entryMatchesRuntimeModel(entry: ModelPriceEntry, model: string): boolean {
  return normalizeComparable(pricingEntryRuntimeModelId(entry))
    === normalizeComparable(normalizeRuntimeModelName(model));
}

function normalizedVendor(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRuntimeModelName(value: string): string {
  return value.trim().replace(/\[[^\]]+\]\s*$/u, "");
}

function matchExactEntry<T extends { id?: string; match?: string; patterns?: string[]; aliases?: string[]; vendor?: string }>(
  entries: T[],
  comparableModel: string,
  normalizeTerm = false,
): GenericMatchResult<T> {
  if (!comparableModel) return {};
  const candidates = entries.filter(entry => entryTerms(entry).some(term => {
    const comparableTerm = normalizeTerm ? normalizeComparable(normalizeRuntimeModelName(term)) : normalizeComparable(term);
    return comparableTerm === comparableModel;
  }));
  return uniqueMatch(candidates);
}

function matchContainsEntry<T extends { match?: string; patterns?: string[]; aliases?: string[] }>(entries: T[], model: string | undefined): GenericMatchResult<T> {
  if (!model) return {};
  const lower = normalizeComparable(model);
  let bestLength = -1;
  let bestEntries: T[] = [];
  for (const entry of entries) {
    for (const pattern of entryTerms(entry)) {
      const normalized = normalizeComparable(pattern);
      const matched = normalized === "*" || lower.includes(normalized);
      if (!matched) continue;
      if (normalized.length > bestLength) {
        bestLength = normalized.length;
        bestEntries = [entry];
      } else if (normalized.length === bestLength) {
        bestEntries.push(entry);
      }
    }
  }
  return uniqueMatch(bestEntries);
}

function matchEntry<T extends { match?: string; patterns?: string[]; aliases?: string[] }>(entries: T[], model: string | undefined): T | undefined {
  return matchContainsEntry(entries, model).entry;
}

function entryTerms(entry: { id?: string; runtimeModelId?: string; match?: string; patterns?: string[]; aliases?: string[] }): string[] {
  return uniqueSorted([
    entry.id,
    entry.runtimeModelId,
    entry.match,
    ...(entry.patterns ?? []),
    ...(entry.aliases ?? []),
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0));
}

function uniqueMatch<T>(candidates: T[]): GenericMatchResult<T> {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return {};
  if (unique.length === 1) return { entry: unique[0] };
  return { ambiguous: unique };
}

/** 单步 token → 费用换算。 */
export function computeTokenCost(
  config: PricingConfig,
  model: string | undefined,
  usage: TokenUsageInput,
  context: CostComputationContext = {},
): TokenCost {
  const normalized = normalizePricingConfig(config);
  const match = resolvePriceMatch(normalized, model, context);
  // 计费生效边界（设计七章）：captured_at 早于官方生效时刻时回退 previous* 旧值组。
  const entry = effectiveEntryAt(match.entry, context.capturedAt);
  const targetOverride = matchTargetOverride(normalized, model, context);
  const pricingOverride = targetOverride?.pricing ? targetOverride : undefined;
  // 目录未收录该模型时，用代理供应商配置的供应商兜底，避免展示成 unknown。
  const mapping = context.targetId
    ? normalized.targetModelMappings?.[context.targetId]?.[model || ""]
    : undefined;
  const targetVendor = normalizedVendor(
    context.targetId ? normalized.targetVendorPreferences?.[context.targetId] : undefined,
  );
  const resolvedVendor = entry?.vendor ?? mapping?.vendor ?? targetVendor;
  const base = baseTokenCost(normalized, usage);
  if (!hasAnyUsage(usage)) {
    const schedule = resolveTemporalPricing(entry, context.capturedAt);
    return {
      ...base,
      matchedModel: entry?.id,
      vendor: resolvedVendor,
      priceEntryId: entry?.id,
      overrideId: pricingOverride?.id,
      confidence: normalizePricingCenterConfidence(pricingOverride?.confidence) || entry?.confidence,
      sourceUrl: pricingOverride?.sourceUrl || entry?.sourceUrl,
      unpricedReason: "usage_unavailable",
      pricingSnapshot: buildPricingSnapshot({
        entry,
        override: pricingOverride,
        strategy: "usage_unavailable",
        capturedAt: context.capturedAt,
        ambiguousCandidates: match.ambiguousCandidates,
        baseRates: pricingOverride?.pricing || schedule?.rates || entry?.pricing,
        rateMultiplier: context.rateMultiplierOverride,
        matchedModel: entry?.id || (pricingOverride ? model : undefined),
        ...(pricingOverride ? {} : {scheduleLabel: schedule?.label, timezone: schedule?.timezone}),
      }),
    };
  }

  if (pricingOverride) {
    const rateMultiplier = context.rateMultiplierOverride ?? 1;
    // 供应商计费覆盖支持峰谷：覆盖自带 priceSchedules 时按请求时间解析窗口费率，
    // 未命中窗口或未配置时段时使用覆盖的基础价（固定覆盖语义）。
    const overrideSchedule = resolveTemporalPricing({
      pricing: pricingOverride.pricing,
      priceSchedules: pricingOverride.priceSchedules,
    }, context.capturedAt);
    const overriddenRates = overrideSchedule?.rates ?? pricingOverride.pricing!;
    // 覆盖价币种（2026-09-28 修复）：显式值优先，缺失时继承命中条目币种，
    // 再回退全局默认——否则 CNY 条目（如智谱）的目标级覆盖会被误标 USD 并走错结算分支。
    const overrideCurrency = pricingOverride.currency || entry?.currency || normalized.currency;
    const overridden = costFromRates(usage, overriddenRates, overrideCurrency, rateMultiplier);
    const official = entry && entry.confidence !== "unverified" && entry.pricing
      ? costFromRates(usage, entry.pricing, normalized.currency)
      : undefined;
    const tierMatch = overridden.longContext ?? official?.longContext;
    return {
      ...base,
      ...overridden.parts,
      totalCost: overridden.total,
      officialTotalCost: official?.total,
      currency: overrideCurrency,
      priced: true,
      matchedModel: entry?.id || model,
      priceEntryId: entry?.id,
      overrideId: pricingOverride.id,
      vendor: resolvedVendor,
      confidence: normalizePricingCenterConfidence(pricingOverride.confidence),
      sourceUrl: pricingOverride.sourceUrl || entry?.sourceUrl,
      formula: overridden.formula,
      pricingSnapshot: buildPricingSnapshot({
        entry,
        override: pricingOverride,
        ...(tierMatch ? {longContext: tierMatch} : {}),
        strategy: "target_override",
        baseRates: overriddenRates,
        rateMultiplier,
        matchedModel: entry?.id || model,
        scheduleLabel: overrideSchedule?.label,
        timezone: overrideSchedule?.timezone,
      }),
    };
  }

  if (match.strategy === "ambiguous") {
    return {
      ...base,
      vendor: resolvedVendor,
      unpricedReason: "model_ambiguous",
      pricingSnapshot: buildPricingSnapshot({
        strategy: "ambiguous",
        ambiguousCandidates: match.ambiguousCandidates,
      }),
    };
  }

  if (!entry) {
    return {
      ...base,
      vendor: resolvedVendor,
      unpricedReason: "model_unmatched",
      pricingSnapshot: buildPricingSnapshot({ strategy: "unmatched" }),
    };
  }

  if (entry.confidence === "unverified" || !entry.pricing) {
    const rateMultiplier = context.rateMultiplierOverride ?? 1;
    const schedule = resolveTemporalPricing(entry, context.capturedAt);
    return {
      ...base,
      matchedModel: entry.id,
      priceEntryId: entry.id,
      vendor: entry.vendor,
      confidence: entry.confidence,
      sourceUrl: entry.sourceUrl,
      unpricedReason: "price_unverified",
      pricingSnapshot: buildPricingSnapshot({
        entry,
        strategy: match.strategy,
        baseRates: schedule?.rates ?? entry.pricing,
        rateMultiplier,
        capturedAt: context.capturedAt,
        scheduleLabel: schedule?.label,
        timezone: schedule?.timezone,
      }),
    };
  }

  const rateMultiplier = context.rateMultiplierOverride ?? 1;
  const schedule = resolveTemporalPricing(entry, context.capturedAt);
  /* 按量合成链（2026-09-08 用户确认；2026-10-07 fast 改倍率制）：
     选价 牌价→闲时→促销价→fast 倍率，乘数 长上下文档位→促销倍率→密钥倍率。
     促销（promotions）对官方预设通道统一生效（payg/plan/subscription 全通道，
     2026-10-09 二次用户确认修订，同日撤销「market_share 例外」）：目录供应商行
     独立维护定价与促销，某供应商条目上的促销只可能是它自己的官方促销
     （编译器按供应商作用域投影，绝不跨行）；估算公式的分子（该供应商价格）与
     分母（该供应商额度，如 OpenCode Go 档位月度美元）属同一价格体系、由目录
     同一次修订统一维护——供应商降价则目录挂促销价、放额度则目录调 quotaTiers，
     公式两端永远同源，无需公式级守卫。中转站/非官方目标始终按牌价（pricing）
     计费。fast 倍率作用于各通道实际基数：官方促销期 fast=2×促销价、中转站
     fast=2×牌价（通道各自正确）。 */
  const officialChannel = Boolean(context.officialPresetVendor && context.officialPresetVendor === entry.vendor);
  const promotion = officialChannel
    ? activePaygPromotion(entry, context.capturedAt, context.agentName)
    : undefined;
  const promoMultiplier = promotion?.multiplier;
  const serviceTier = normalizeServiceTierKey(usage.serviceTier);
  const fastMultiplier = serviceTier !== undefined ? resolveServiceTierMultiplier(entry) : undefined;
  let resolvedRates: PricingRates = schedule?.rates ?? entry.pricing;
  if (promotion?.priceOverride) resolvedRates = overlaySparseRates(resolvedRates, promotion.priceOverride);
  if (fastMultiplier !== undefined) resolvedRates = multiplyRates(resolvedRates, fastMultiplier);
  // 档位定义兜底：闲时/促销/fast 价不携带 longContext 时沿用牌价档位（2026-09-08 修复潜在丢失）。
  if (!resolvedRates.longContext && entry.pricing.longContext) {
    resolvedRates = {...resolvedRates, longContext: entry.pricing.longContext};
  }
  const official = costFromRates(usage, resolvedRates, entry.currency || normalized.currency, promoMultiplier ?? 1);
  const override = targetOverride;
  if (!override) {
    // 密钥倍率只作用于实际成本，供应商成本保持官方口径，与既有展示口径一致。
    const actual = rateMultiplier === 1
      ? official
      : costFromRates(usage, resolvedRates, entry.currency || normalized.currency, (promoMultiplier ?? 1) * rateMultiplier);
    return {
      ...base,
      ...actual.parts,
      totalCost: actual.total,
      officialTotalCost: official.total,
      currency: entry.currency || normalized.currency,
      priced: true,
      matchedModel: entry.id,
      priceEntryId: entry.id,
      vendor: entry.vendor,
      confidence: entry.confidence,
      sourceUrl: entry.sourceUrl,
      formula: actual.formula,
      pricingSnapshot: buildPricingSnapshot({
        entry,
        strategy: match.strategy,
        ...(actual.longContext ? {longContext: actual.longContext} : {}),
        baseRates: resolvedRates,
        capturedAt: context.capturedAt,
        rateMultiplier,
        ...(promotion ? {promotionLabel: promotion.label || "促销实扣"} : {}),
        ...(fastMultiplier !== undefined && serviceTier !== undefined ? {serviceTier} : {}),
        scheduleLabel: schedule?.label,
        timezone: schedule?.timezone,
      }),
    };
  }

  const overriddenRates = override.pricing || entry.pricing;
  // 密钥倍率优先于供应商级倍率：按请求实际使用的密钥计价。
  const effectiveRateMultiplier = context.rateMultiplierOverride ?? 1;
  // 覆盖价币种（2026-09-28 修复）：显式值优先，缺失时继承条目币种，再回退全局默认。
  const overrideCurrency = override.currency || entry.currency || normalized.currency;
  const overridden = costFromRates(
    usage,
    overriddenRates,
    overrideCurrency,
    effectiveRateMultiplier,
  );
  return {
    ...base,
    ...overridden.parts,
    totalCost: overridden.total,
    officialTotalCost: official.total,
    currency: overrideCurrency,
    priced: true,
    matchedModel: entry.id,
    priceEntryId: entry.id,
    overrideId: override.id,
    vendor: entry.vendor,
    // relay_synced 属目标级同步价，价格中心词表里等价 third_party。
    confidence: normalizePricingCenterConfidence(override.confidence),
    sourceUrl: override.sourceUrl || entry.sourceUrl,
    formula: overridden.formula,
    pricingSnapshot: buildPricingSnapshot({
      entry,
      override,
      strategy: match.strategy,
      ...(overridden.longContext ? {longContext: overridden.longContext} : {}),
      baseRates: overriddenRates,
      rateMultiplier: effectiveRateMultiplier,
      capturedAt: context.capturedAt,
    }),
  };
}

/**
 * 计费生效边界（终极方案：价格时间线段选择）：取 effectiveFrom ≤ captured_at 的最后一段
 * （无匹配取首段=历史现状），段是完整价格快照——payg 价组与 plan 系数整体切档；
 * 无时间线条目按顶层字段。user_override 手工价时间不变：payg 价组保持手工值，
 * 时间线只切换 plan 系数段（plan 组始终跟随官方）。
 * 供 computeTokenCost 与套餐折算（exchange-processor）共用。
 */
export function effectiveEntryAt(entry: ModelPriceEntry | undefined, capturedAt: string | undefined): ModelPriceEntry | undefined {
  const timeline = entry?.rateTimeline;
  if (!entry || !timeline?.length || !capturedAt) return entry;
  const captured = Date.parse(capturedAt);
  if (!Number.isFinite(captured)) return entry;
  let segment = timeline[0]!;
  for (const candidate of timeline) {
    if (candidate.effectiveFrom === undefined || Date.parse(candidate.effectiveFrom) <= captured) {
      segment = candidate;
    }
  }
  const manual = entry.confidence === "user_override";
  const modelId = entry.runtimeModelId ?? entry.id;
  const planCreditRules = segment.planFactors !== undefined && entry.planCreditRules?.modelFactors
    ? {...entry.planCreditRules, modelFactors: {...entry.planCreditRules.modelFactors, [modelId]: segment.planFactors}}
    : entry.planCreditRules;
  return {
    ...entry,
    ...(manual ? {} : {
      pricing: segment.pricing,
      priceSchedules: segment.priceSchedules,
      ...(segment.serviceTierPricing !== undefined ? {serviceTierPricing: segment.serviceTierPricing} : {}),
    }),
    ...(planCreditRules !== undefined ? {planCreditRules} : {}),
  };
}

/** 时间线段选择（纯查询）：captured_at 命中的段；无时间线返回 undefined。 */
export function applicableRateSegment(entry: ModelPriceEntry | undefined, capturedAt: string | undefined): PriceRateSegment | undefined {
  const timeline = entry?.rateTimeline;
  if (!entry || !timeline?.length || !capturedAt) return timeline?.[0];
  const captured = Date.parse(capturedAt);
  if (!Number.isFinite(captured)) return timeline[0];
  let segment = timeline[0]!;
  for (const candidate of timeline) {
    if (candidate.effectiveFrom === undefined || Date.parse(candidate.effectiveFrom) <= captured) {
      segment = candidate;
    }
  }
  return segment;
}

function buildPricingSnapshot(input: {
  entry?: ModelPriceEntry;
  override?: TargetPricingOverride;
  longContext?: LongContextMatchInfo;
  strategy: PricingMatchStrategy;
  ambiguousCandidates?: PricingMatchCandidate[];
  baseRates?: PricingRates;
  rateMultiplier?: number;
  matchedModel?: string;
  scheduleLabel?: string;
  timezone?: string;
  promotionLabel?: string;
  serviceTier?: string;
  capturedAt?: string;
}): PricingSnapshot {
  const rateMultiplier = input.rateMultiplier ?? 1;
  return {
    unit: "per_million_tokens",
    matchedModel: input.matchedModel || input.entry?.id,
    ...(input.longContext ? {longContext: input.longContext} : {}),
    vendor: input.entry?.vendor,
    priceEntryId: input.entry?.id,
    ...(input.entry?.contextWindow ? {contextWindow: input.entry.contextWindow} : {}),
    overrideId: input.override?.id,
    sourceUrl: input.override?.sourceUrl || input.entry?.sourceUrl,
    confidence: normalizePricingCenterConfidence(input.override?.confidence) || input.entry?.confidence,
    matchStrategy: input.strategy,
    ambiguousCandidates: input.ambiguousCandidates,
    baseRates: input.baseRates ? cloneRates(input.baseRates) : undefined,
    rateMultiplier,
    effectiveRates: input.baseRates ? multiplyRates(input.baseRates, rateMultiplier) : undefined,
    // 目录 v2 来源定位（9.1：随快照落库供排障，不入用户 UI）。
    // effectiveFrom = 本次计费实际命中的时间线段生效时刻（无时间线缺省）。
    catalogRevision: input.entry?.catalogRevision,
    ...(input.entry?.catalogSourceHash ? {catalogSourceHash: input.entry.catalogSourceHash} : {}),
    ...(input.entry?.rateTimeline?.length
      ? (() => {const segment = applicableRateSegment(input.entry, input.capturedAt); return segment?.effectiveFrom ? {effectiveFrom: segment.effectiveFrom} : {};})()
      : {}),
    ...(input.scheduleLabel ? {scheduleLabel: input.scheduleLabel} : {}),
    ...(input.timezone ? {timezone: input.timezone} : {}),
    ...(input.promotionLabel ? {promotionLabel: input.promotionLabel} : {}),
    ...(input.serviceTier ? {serviceTier: input.serviceTier} : {}),
  };
}

function cloneRates(rates: PricingRates): PricingRates {
  return {
    input: rates.input,
    output: rates.output,
    cachedInput: rates.cachedInput,
    cacheWrite: rates.cacheWrite,
    cacheWrite5m: rates.cacheWrite5m,
    cacheWrite1h: rates.cacheWrite1h,
    reasoning: rates.reasoning,
    ...(rates.longContext ? {longContext: rates.longContext} : {}),
  };
}

function multiplyRates(rates: PricingRates, rateMultiplier: number): PricingRates {
  return {
    input: rates.input * rateMultiplier,
    output: rates.output * rateMultiplier,
    cachedInput: rates.cachedInput === undefined ? undefined : rates.cachedInput * rateMultiplier,
    cacheWrite: rates.cacheWrite === undefined ? undefined : rates.cacheWrite * rateMultiplier,
    cacheWrite5m: rates.cacheWrite5m === undefined ? undefined : rates.cacheWrite5m * rateMultiplier,
    cacheWrite1h: rates.cacheWrite1h === undefined ? undefined : rates.cacheWrite1h * rateMultiplier,
    reasoning: rates.reasoning === undefined ? undefined : rates.reasoning * rateMultiplier,
    ...(rates.longContext ? {longContext: rates.longContext} : {}),
  };
}

function baseTokenCost(config: PricingConfigV2, usage: TokenUsageInput): TokenCost {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheCreation5mTokens: usage.cacheCreation5mTokens,
    cacheCreation1hTokens: usage.cacheCreation1hTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    currency: config.currency,
    priced: false,
    priceVersion: config.version,
  };
}

function hasAnyUsage(usage: TokenUsageInput): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.cacheCreation5mTokens,
    usage.cacheCreation1hTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ].some(value => typeof value === "number");
}

function costFromRates(
  usage: TokenUsageInput,
  rates: PricingRates,
  currency: string,
  rateMultiplier = 1,
): {
  total: number;
  parts: Pick<TokenCost, "inputCost" | "outputCost" | "cacheReadCost" | "cacheCreationCost" | "cacheCreation5mCost" | "cacheCreation1hCost" | "reasoningCost" | "currency">;
  formula: string;
  longContext?: LongContextMatchInfo;
} {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreation5mTokens = usage.cacheCreation5mTokens ?? 0;
  const cacheCreation1hTokens = usage.cacheCreation1hTokens ?? 0;
  const hasCacheCreationSplit = usage.cacheCreation5mTokens !== undefined
    || usage.cacheCreation1hTokens !== undefined;
  const cacheCreationTokens = hasCacheCreationSplit
    ? cacheCreation5mTokens + cacheCreation1hTokens
    : usage.cacheCreationTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  // 长上下文判档：输入侧合计严格大于阈值时整单换档；判定量不含输出。
  // 字段声明 tier.rates 绝对价时直接用绝对价，否则按倍率换算（2026-09-08 绝对价优先）。
  const tier = rates.longContext;
  const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const tierMatched = tier !== undefined && contextTokens > tier.thresholdTokens;
  const ratesInUse: PricingRates = tierMatched && tier ? longContextTierRates(rates, tier) : rates;
  const longContext = tierMatched && tier
    ? {thresholdTokens: tier.thresholdTokens, contextTokens, inputMultiplier: tier.inputMultiplier, outputMultiplier: tier.outputMultiplier}
    : undefined;
  const inputCost = price(inputTokens, ratesInUse.input, rateMultiplier);
  // reasoning 语义：主流供应商（OpenAI / DashScope / DeepSeek / GLM 等）的
  // output_tokens 已包含 reasoning_tokens（output_subset）。存在独立 reasoning
  // 单价时按拆分计费：(output - reasoning) × outputRate + reasoning × reasoningRate；
  // reasoning 单价与 output 相同（如 Gemini 类）时拆分自然等价于整段 output 计价；
  // 无 reasoning 单价时 reasoning 不单独计费（已含在 output 价内）。
  const reasoningRate = ratesInUse.reasoning;
  const billableOutput = reasoningRate !== undefined
    ? Math.max(0, outputTokens - reasoningTokens)
    : outputTokens;
  const outputCost = price(billableOutput, ratesInUse.output, rateMultiplier);
  const reasoningCost = reasoningRate !== undefined
    ? price(reasoningTokens, reasoningRate, rateMultiplier)
    : undefined;
  // 缓存读缺省单价时按输入价计费（如中转站未声明缓存折扣），
  // 绝不按 0（免费）计费——那会让本地账单静默低于真实扣费。
  const cacheReadRate = ratesInUse.cachedInput ?? ratesInUse.input;
  const cacheReadCost = cacheReadTokens > 0 ? price(cacheReadTokens, cacheReadRate, rateMultiplier) : undefined;
  const legacyCacheCreationCost = !hasCacheCreationSplit && ratesInUse.cacheWrite !== undefined
    ? price(cacheCreationTokens, ratesInUse.cacheWrite, rateMultiplier)
    : undefined;
  const cacheCreation5mRate = ratesInUse.cacheWrite5m ?? ratesInUse.cacheWrite;
  const cacheCreation1hRate = ratesInUse.cacheWrite1h ?? ratesInUse.cacheWrite;
  const cacheCreation5mCost = hasCacheCreationSplit && cacheCreation5mRate !== undefined
    ? price(cacheCreation5mTokens, cacheCreation5mRate, rateMultiplier)
    : undefined;
  const cacheCreation1hCost = hasCacheCreationSplit && cacheCreation1hRate !== undefined
    ? price(cacheCreation1hTokens, cacheCreation1hRate, rateMultiplier)
    : undefined;
  const cacheCreationCost = hasCacheCreationSplit
    ? (cacheCreation5mCost ?? 0) + (cacheCreation1hCost ?? 0)
    : legacyCacheCreationCost;
  const total = inputCost + outputCost + (cacheReadCost ?? 0) + (cacheCreationCost ?? 0) + (reasoningCost ?? 0);
  const multiplier = rateMultiplier === 1 ? "" : ` * ${rateMultiplier}`;
  const tierNote = longContext
    ? ` [long-context>${longContext.thresholdTokens} x${longContext.inputMultiplier}/x${longContext.outputMultiplier}${tier?.rates ? " 部分绝对价" : ""}]`
    : "";
  const formula = tierNote + [
    `input ${inputTokens} * ${ratesInUse.input} / 1000000${multiplier}`,
    reasoningRate !== undefined
      ? `output ${billableOutput} * ${ratesInUse.output} / 1000000${multiplier} + reasoning ${reasoningTokens} * ${reasoningRate} / 1000000${multiplier}`
      : `output ${outputTokens} * ${ratesInUse.output} / 1000000${multiplier}`,
    ratesInUse.cachedInput !== undefined ? `cacheRead ${cacheReadTokens} * ${ratesInUse.cachedInput} / 1000000${multiplier}` : undefined,
    hasCacheCreationSplit
      ? [
        cacheCreation5mRate !== undefined ? `cacheCreation5m ${cacheCreation5mTokens} * ${cacheCreation5mRate} / 1000000${multiplier}` : undefined,
        cacheCreation1hRate !== undefined ? `cacheCreation1h ${cacheCreation1hTokens} * ${cacheCreation1hRate} / 1000000${multiplier}` : undefined,
      ].filter(Boolean).join(" + ")
      : ratesInUse.cacheWrite !== undefined ? `cacheCreation ${cacheCreationTokens} * ${ratesInUse.cacheWrite} / 1000000${multiplier}` : undefined,
  ].filter(Boolean).join(" + ");
  return {
    total,
    parts: {
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
      cacheCreation5mCost,
      cacheCreation1hCost,
      reasoningCost,
      currency,
    },
    formula,
    ...(longContext ? {longContext} : {}),
  };
}

/**
 * 展示端复用的长上下文判档与换档单价——已拆至客户端安全的 ./pricing-rates.ts
 * （本文件含 fs/promises，客户端组件值引用会破坏构建）；文件顶部已 re-export，
 * 既有服务端导入路径（token-pricing.ts、测试）不变。
 */

/** 字段级稀疏覆盖：override 声明的字段替换 base，其余沿用（fast 档价/促销价共用）。 */
export function overlaySparseRates(base: PricingRates, override: SparsePricingRates): PricingRates {
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

/** 计费相关的 service_tier 取值归一（fast/priority 同映射 fast 价格集）；其余取值不参与档位计价。 */
function normalizeServiceTierKey(value: string | undefined): "fast" | "priority" | undefined {
  const key = value?.trim().toLowerCase();
  return key === "fast" || key === "priority" ? key : undefined;
}

/** 解析请求档位命中的价格集；本期 fast 价格集同时承接 fast/priority 请求参数。 */
/** fast 档倍率（2026-10-07 倍率制）：作用于请求时刻实际命中的各通道标准价。 */
function resolveServiceTierMultiplier(
  entry: Pick<ModelPriceEntry, "serviceTierPricing">,
): number | undefined {
  return entry.serviceTierPricing?.fastMultiplier;
}

/**
 * 命中捕获时刻的按量促销：models 缺省匹配条目全部模型（runtimeModelId 与别名口径），
 * agents 缺省不限，from（含）≤ captured_at ≤ to（含，缺省=无限期）；
 * 多条命中取数组第一条（与套餐侧 activePromotion 语义一致）。
 */
export function activePaygPromotion(
  entry: ModelPriceEntry,
  capturedAt: string | undefined,
  agentName: string | undefined,
): PaygPromotion | undefined {
  const promotions = entry.promotions ?? [];
  if (promotions.length === 0) return undefined;
  const instant = capturedAt ? new Date(capturedAt) : new Date();
  if (!Number.isFinite(instant.getTime())) return undefined;
  const entryModels = [pricingEntryRuntimeModelId(entry), ...(entry.aliases ?? [])]
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length > 0);
  for (const promotion of promotions) {
    if (promotion.models?.length
      && !promotion.models.some(model => entryModels.includes(model.trim().toLowerCase()))) continue;
    if (promotion.agents?.length
      && (!agentName || !promotion.agents.includes(agentName.trim().toLowerCase()))) continue;
    const from = new Date(promotion.from);
    if (!Number.isFinite(from.getTime()) || instant < from) continue;
    if (promotion.to !== undefined) {
      const to = new Date(promotion.to);
      if (!Number.isFinite(to.getTime()) || instant > to) continue;
    }
    return promotion;
  }
  return undefined;
}

function price(tokens: number, perMillion: number, rateMultiplier: number): number {
  return (tokens / PER_MILLION) * perMillion * rateMultiplier;
}

function matchTargetOverride(config: PricingConfigV2, model: string | undefined, context: CostComputationContext): TargetPricingOverride | undefined {
  const overrides = config.targetOverrides || [];
  const candidates = overrides.filter(override => {
    if (override.targetId && override.targetId !== context.targetId) return false;
    if (override.agentFingerprintId && override.agentFingerprintId !== context.agentFingerprintId) return false;
    return true;
  });
  return matchEntry(candidates, model);
}

export function emptyAggregate(currency: string): CostAggregate {
  return {
    schemaVersion: 2,
    priceVersion: 2,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    officialTotalCost: 0,
    currency,
    pricedSteps: 0,
    unpricedSteps: 0,
    byModel: {},
    unpricedReasons: {},
    byUsageSource: {},
    byUsageConfidence: {},
    requestCount: 0,
    stepRequestCount: 0,
    auxiliaryRequestCount: 0,
    durationTotalMs: 0,
    durationSampleCount: 0,
    toolCallCount: 0,
    toolCallsByName: {},
  };
}

export function accumulate(
  agg: CostAggregate,
  cost: TokenCost,
  modelKey: string,
  usageSource?: UsageSource,
  usageConfidence?: UsageConfidence,
  metrics: RequestAggregateMetrics = {},
): void {
  ensureAggregateMaps(agg);
  agg.requestCount += 1;
  agg.stepRequestCount += 1;
  accumulateRequestMetrics(agg, metrics);
  agg.inputTokens += cost.inputTokens ?? 0;
  agg.outputTokens += cost.outputTokens ?? 0;
  agg.cacheReadTokens += cost.cacheReadTokens ?? 0;
  agg.cacheCreationTokens += cost.cacheCreationTokens ?? 0;
  agg.reasoningTokens += cost.reasoningTokens ?? 0;
  agg.totalTokens += cost.totalTokens ?? sumUsageTokens(cost);
  agg.priceVersion = Math.max(agg.priceVersion || 0, cost.priceVersion || 2);
  if (cost.priced) {
    agg.pricedSteps += 1;
    agg.totalCost += cost.totalCost ?? 0;
    agg.officialTotalCost += cost.officialTotalCost ?? cost.totalCost ?? 0;
  } else {
    agg.unpricedSteps += 1;
    if (cost.unpricedReason) {
      agg.unpricedReasons[cost.unpricedReason] = (agg.unpricedReasons[cost.unpricedReason] || 0) + 1;
    }
  }
  if (usageSource) agg.byUsageSource[usageSource] = (agg.byUsageSource[usageSource] || 0) + 1;
  if (usageConfidence) agg.byUsageConfidence[usageConfidence] = (agg.byUsageConfidence[usageConfidence] || 0) + 1;

  const slot = agg.byModel[modelKey] || emptyModelBreakdown();
  slot.inputTokens += cost.inputTokens ?? 0;
  slot.outputTokens += cost.outputTokens ?? 0;
  slot.cacheReadTokens += cost.cacheReadTokens ?? 0;
  slot.cacheCreationTokens += cost.cacheCreationTokens ?? 0;
  slot.reasoningTokens += cost.reasoningTokens ?? 0;
  slot.totalTokens += cost.totalTokens ?? sumUsageTokens(cost);
  slot.totalCost += cost.totalCost ?? 0;
  slot.officialTotalCost += cost.officialTotalCost ?? cost.totalCost ?? 0;
  slot.stepCount += 1;
  if (cost.priced) slot.pricedSteps += 1;
  else slot.unpricedSteps += 1;
  agg.byModel[modelKey] = slot;
}

/** 辅助请求只参与请求数和耗时，不进入模型 Token、费用或工具调用。 */
export function accumulateAuxiliaryRequest(
  agg: CostAggregate,
  metrics: Pick<RequestAggregateMetrics, "durationMs"> = {},
): void {
  ensureAggregateMaps(agg);
  agg.requestCount += 1;
  agg.auxiliaryRequestCount += 1;
  accumulateRequestMetrics(agg, metrics);
}

function accumulateRequestMetrics(agg: CostAggregate, metrics: RequestAggregateMetrics): void {
  if (typeof metrics.durationMs === "number" && Number.isFinite(metrics.durationMs)) {
    agg.durationTotalMs += Math.max(0, metrics.durationMs);
    agg.durationSampleCount += 1;
  }
  const toolUseNames = metrics.toolUseNames?.filter(Boolean) ?? [];
  const toolUseIds = metrics.toolUseIds?.filter(Boolean) ?? [];
  agg.toolCallCount += toolUseIds.length > 0 ? toolUseIds.length : toolUseNames.length;
  for (const name of toolUseNames) {
    agg.toolCallsByName[name] = (agg.toolCallsByName[name] || 0) + 1;
  }
}

function ensureAggregateMaps(agg: CostAggregate): void {
  agg.byModel ||= {};
  agg.unpricedReasons ||= {};
  agg.byUsageSource ||= {};
  agg.byUsageConfidence ||= {};
  agg.requestCount ??= 0;
  agg.stepRequestCount ??= 0;
  agg.auxiliaryRequestCount ??= 0;
  agg.durationTotalMs ??= 0;
  agg.durationSampleCount ??= 0;
  agg.toolCallCount ??= 0;
  agg.toolCallsByName ||= {};
}

export function mergeCostAggregate(target: CostAggregate, source: CostAggregate): void {
  ensureAggregateMaps(target);
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.cacheReadTokens += source.cacheReadTokens || 0;
  target.cacheCreationTokens += source.cacheCreationTokens || 0;
  target.reasoningTokens += source.reasoningTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.totalCost += source.totalCost || 0;
  target.officialTotalCost += source.officialTotalCost || 0;
  target.pricedSteps += source.pricedSteps || 0;
  target.unpricedSteps += source.unpricedSteps || 0;
  target.priceVersion = Math.max(target.priceVersion || 0, source.priceVersion || 0);
  target.requestCount += source.requestCount || 0;
  target.stepRequestCount += source.stepRequestCount || 0;
  target.auxiliaryRequestCount += source.auxiliaryRequestCount || 0;
  target.durationTotalMs += source.durationTotalMs || 0;
  target.durationSampleCount += source.durationSampleCount || 0;
  target.toolCallCount += source.toolCallCount || 0;
  for (const [toolName, count] of Object.entries(source.toolCallsByName || {})) {
    target.toolCallsByName[toolName] = (target.toolCallsByName[toolName] || 0) + (count || 0);
  }
  for (const [reason, count] of Object.entries(source.unpricedReasons || {})) {
    const key = reason as UnpricedReason;
    target.unpricedReasons[key] = (target.unpricedReasons[key] || 0) + (count || 0);
  }
  for (const [usageSource, count] of Object.entries(source.byUsageSource || {})) {
    target.byUsageSource[usageSource] = (target.byUsageSource[usageSource] || 0) + (count || 0);
  }
  for (const [usageConfidence, count] of Object.entries(source.byUsageConfidence || {})) {
    target.byUsageConfidence[usageConfidence] = (target.byUsageConfidence[usageConfidence] || 0) + (count || 0);
  }
  for (const [modelKey, sourceSlot] of Object.entries(source.byModel || {})) {
    const slot = target.byModel[modelKey] || emptyModelBreakdown();
    slot.inputTokens += sourceSlot.inputTokens || 0;
    slot.outputTokens += sourceSlot.outputTokens || 0;
    slot.cacheReadTokens += sourceSlot.cacheReadTokens || 0;
    slot.cacheCreationTokens += sourceSlot.cacheCreationTokens || 0;
    slot.reasoningTokens += sourceSlot.reasoningTokens || 0;
    slot.totalTokens += sourceSlot.totalTokens || 0;
    slot.totalCost += sourceSlot.totalCost || 0;
    slot.officialTotalCost += sourceSlot.officialTotalCost || 0;
    slot.stepCount += sourceSlot.stepCount || 0;
    slot.pricedSteps += sourceSlot.pricedSteps || 0;
    slot.unpricedSteps += sourceSlot.unpricedSteps || 0;
    target.byModel[modelKey] = slot;
  }
}

function emptyModelBreakdown(): ModelCostBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    officialTotalCost: 0,
    stepCount: 0,
    pricedSteps: 0,
    unpricedSteps: 0,
  };
}

function sumUsageTokens(usage: TokenUsageInput): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0) + (usage.reasoningTokens ?? 0);
}

/** 从原始 exchange 请求体提取 model 字段 */
export function extractModel(exchange: { request: { parsedBody?: unknown } }): string | undefined {
  const body = exchange.request.parsedBody;
  if (body && typeof body === "object" && "model" in body) {
    const model = (body as { model?: unknown }).model;
    if (typeof model === "string") return model;
  }
  return undefined;
}

export interface CostAggregationResult {
  byTurn: Map<string, CostAggregate>;
  bySession: Map<string, CostAggregate>;
}

/**
 * 按 Turn / Session 维度聚合 token 与费用。
 * 输入：原始 exchanges（取 model）、派生 dataset（取 steps 的 tokenUsage 与归属）。
 */
export function aggregateCosts(
  config: PricingConfig,
  exchanges: Array<{
    exchangeId: string;
    durationMs?: number;
    capturedAt?: string;
    completedAt?: string;
    request: { parsedBody?: unknown };
  }>,
  dataset: {
    steps: Array<{
      exchangeId: string;
      turnId: string;
      agentSessionId: string;
      toolUseNames?: string[];
      toolUseIds?: string[];
      tokenUsage?: TokenUsageInput & { source?: string };
    }>;
    auxiliaryExchanges?: Array<{
      exchangeId: string;
      agentSessionId?: string;
      agentTurnId?: string;
    }>;
  },
): CostAggregationResult {
  const normalized = normalizePricingConfig(config);
  const exchangeById = new Map(exchanges.map(exchange => [exchange.exchangeId, exchange]));
  const byTurn = new Map<string, CostAggregate>();
  const bySession = new Map<string, CostAggregate>();
  for (const step of dataset.steps) {
    const usage = step.tokenUsage || {};
    const exchange = exchangeById.get(step.exchangeId);
    const model = exchange ? extractModel(exchange) : undefined;
    const cost = computeTokenCost(normalized, model, usage);
    const modelKey = cost.matchedModel || model || "unknown";
    const usageSource = usageSourceFromTokenUsage(usage);
    const usageConfidence = usageConfidenceFromTokenUsage(usage);
    const turnAgg = byTurn.get(step.turnId) || emptyAggregate(normalized.currency);
    const metrics = {
      durationMs: exchangeDurationMs(exchange),
      toolUseNames: step.toolUseNames,
      toolUseIds: step.toolUseIds,
    };
    accumulate(turnAgg, cost, modelKey, usageSource, usageConfidence, metrics);
    byTurn.set(step.turnId, turnAgg);
    const sessionAgg = bySession.get(step.agentSessionId) || emptyAggregate(normalized.currency);
    accumulate(sessionAgg, cost, modelKey, usageSource, usageConfidence, metrics);
    bySession.set(step.agentSessionId, sessionAgg);
  }
  for (const auxiliary of dataset.auxiliaryExchanges ?? []) {
    const metrics = { durationMs: exchangeDurationMs(exchangeById.get(auxiliary.exchangeId)) };
    if (auxiliary.agentTurnId) {
      const turnAgg = byTurn.get(auxiliary.agentTurnId) || emptyAggregate(normalized.currency);
      accumulateAuxiliaryRequest(turnAgg, metrics);
      byTurn.set(auxiliary.agentTurnId, turnAgg);
    }
    if (auxiliary.agentSessionId) {
      const sessionAgg = bySession.get(auxiliary.agentSessionId) || emptyAggregate(normalized.currency);
      accumulateAuxiliaryRequest(sessionAgg, metrics);
      bySession.set(auxiliary.agentSessionId, sessionAgg);
    }
  }
  return { byTurn, bySession };
}

function exchangeDurationMs(exchange: { durationMs?: number; capturedAt?: string; completedAt?: string } | undefined): number | undefined {
  if (!exchange) return undefined;
  if (typeof exchange.durationMs === "number" && Number.isFinite(exchange.durationMs)) {
    return Math.max(0, exchange.durationMs);
  }
  if (!exchange.capturedAt || !exchange.completedAt) return undefined;
  const start = Date.parse(exchange.capturedAt);
  const end = Date.parse(exchange.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function usageSourceFromTokenUsage(usage: { source?: string } | undefined): UsageSource {
  if (usage?.source === "exact") return "provider_usage";
  if (usage?.source === "estimated") return "tokenizer_estimated";
  return "unavailable";
}

function usageConfidenceFromTokenUsage(usage: { source?: string } | undefined): UsageConfidence {
  if (usage?.source === "exact") return "exact";
  if (usage?.source === "estimated") return "medium";
  return "unavailable";
}

export function createUsageLedgerEntry(config: PricingConfig, input: UsageLedgerInput): UsageLedgerEntry {
  const normalized = normalizePricingConfig(config);
  const cost = computeTokenCost(normalized, input.model, input.usage || {}, {
    targetId: input.targetId,
    agentFingerprintId: input.agentFingerprintId,
  });
  return {
    schemaVersion: 1,
    ...input,
    usageSource: input.usageSource || "unavailable",
    usageConfidence: input.usageConfidence || "unavailable",
    priceVersion: normalized.version,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    cacheReadTokens: cost.cacheReadTokens,
    cacheCreationTokens: cost.cacheCreationTokens,
    cacheCreation5mTokens: cost.cacheCreation5mTokens,
    cacheCreation1hTokens: cost.cacheCreation1hTokens,
    reasoningTokens: cost.reasoningTokens,
    totalTokens: cost.totalTokens,
    vendor: cost.vendor,
    priceEntryId: cost.priceEntryId,
    overrideId: cost.overrideId,
    priced: cost.priced,
    unpricedReason: cost.unpricedReason,
    currency: cost.currency,
    inputCost: cost.inputCost,
    outputCost: cost.outputCost,
    cacheReadCost: cost.cacheReadCost,
    cacheCreationCost: cost.cacheCreationCost,
    cacheCreation5mCost: cost.cacheCreation5mCost,
    cacheCreation1hCost: cost.cacheCreation1hCost,
    reasoningCost: cost.reasoningCost,
    totalCost: cost.totalCost,
    officialTotalCost: cost.officialTotalCost,
    formula: cost.formula,
    pricingSnapshot: cost.pricingSnapshot,
  };
}

export function summarizeTokenCost(cost: TokenCost): TokenCostSummary {
  return {
    priced: cost.priced,
    currency: cost.currency,
    inputCost: cost.inputCost,
    outputCost: cost.outputCost,
    cacheReadCost: cost.cacheReadCost,
    cacheCreationCost: cost.cacheCreationCost,
    reasoningCost: cost.reasoningCost,
    totalCost: cost.totalCost,
    officialTotalCost: cost.officialTotalCost,
    unpricedReason: cost.unpricedReason,
  };
}

export function normalizeLiteLLMPricingCatalog(
  rawCatalog: unknown,
  options: {
    sourceUrl?: string;
    fetchedAt?: string;
    sourceHash?: string;
  } = {},
): PricingConfigV2 {
  const catalog = rawCatalog && typeof rawCatalog === "object" && !Array.isArray(rawCatalog)
    ? rawCatalog as Record<string, unknown>
    : {};
  const sourceUrl = options.sourceUrl || "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const sourceHash = options.sourceHash || `sha256:${sha256(JSON.stringify(catalog))}`;
  const models = Object.entries(catalog)
    .map(([id, value]) => liteLLMEntryToModelPrice(id, value, sourceUrl, fetchedAt))
    .filter((entry): entry is ModelPriceEntry => entry !== undefined)
    .sort((a, b) => `${a.vendor}/${a.id}`.localeCompare(`${b.vendor}/${b.id}`));

  return canonicalizeLiteLLMPricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    sourceCheckedAt: fetchedAt,
    catalogSource: {
      type: "litellm",
      url: sourceUrl,
      fetchedAt,
      hash: sourceHash,
      modelCount: models.length,
    },
    models,
    targetOverrides: [],
  });
}

/**
 * LiteLLM 同时发布“直接模型 ID”和“provider/模型 ID”路由别名。两者在同一
 * vendor 下指向同一个 runtimeModelId 时，只保留直接模型条目，并合并全部匹配词；
 * 这样价格中心保持 vendor + runtimeModelId 唯一，又不会丢失带前缀请求的匹配能力。
 */
export function canonicalizeLiteLLMPricingConfig(config: PricingConfig): PricingConfigV2 {
  const normalized = normalizePricingConfig(config);
  const uniqueModels = new Map<string, ModelPriceEntry>();
  for (const model of normalized.models) {
    const key = pricingModelUniqueKey(model);
    const existing = uniqueModels.get(key);
    if (!existing) {
      uniqueModels.set(key, model);
      continue;
    }
    uniqueModels.set(key, mergeLiteLLMAliasEntries(existing, model));
  }
  const models = ensureGloballyUniquePriceEntryIds([...uniqueModels.values()])
    .sort((left, right) => `${left.vendor}/${left.id}`.localeCompare(`${right.vendor}/${right.id}`));
  return {
    ...normalized,
    catalogSource: normalized.catalogSource
      ? {...normalized.catalogSource, modelCount: models.length}
      : undefined,
    models,
  };
}

/**
 * 合并 LiteLLM 最新目录与本地价格中心：
 * - 唯一业务键为供应商 + 运行时模型 ID。
 * - 用户手动修改（user_override）与官方目录（official）条目不被 LiteLLM 覆盖：
 *   官方目录是权威自动更新源，LiteLLM 只负责补官方目录没有的模型。
 * - 其余非保护来源的同键记录使用 LiteLLM 最新值替换。
 * - 代理供应商覆盖、供应商偏好等本地策略继续保留。
 */
export function mergeLiteLLMPricingConfig(currentConfig: PricingConfig, importedConfig: PricingConfig): PricingConfigV2 {
  const current = normalizePricingConfig(currentConfig);
  const imported = canonicalizeLiteLLMPricingConfig(importedConfig);
  const merged = new Map<string, ModelPriceEntry>();

  for (const model of current.models) {
    merged.set(pricingModelUniqueKey(model), model);
  }
  for (const model of imported.models) {
    const key = pricingModelUniqueKey(model);
    const existing = merged.get(key);
    // 官方目录与用户手工价格是更高优先级来源：LiteLLM 不覆盖，只补充缺失模型。
    if (existing?.confidence === "user_override" || existing?.confidence === "official") continue;
    // 价格中心的业务身份是 vendor + runtimeModelId；同一身份更新价格时保留
    // 已有内部引用，避免官方目录与 LiteLLM 来源切换导致供应商映射失效。
    merged.set(key, existing ? {...model, id: existing.id} : model);
  }

  return {
    ...current,
    currency: imported.currency || current.currency,
    unit: imported.unit || current.unit,
    sourceCheckedAt: imported.sourceCheckedAt || current.sourceCheckedAt,
    catalogSource: imported.catalogSource || current.catalogSource,
    // 目录同步标记与汇率快照属于价格中心自身元数据：LiteLLM 导入原样保留，绝不覆写。
    fx: current.fx,
    catalogSync: current.catalogSync,
    models: ensureGloballyUniquePriceEntryIds([...merged.values()])
      .sort((a, b) => pricingModelUniqueKey(a).localeCompare(pricingModelUniqueKey(b))),
    targetOverrides: current.targetOverrides,
    targetVendorPreferences: current.targetVendorPreferences,
  };
}

/**
 * 按价格中心唯一业务键（供应商 + 运行时模型 ID）增量写入模型。
 * 未出现在本次输入中的历史模型始终保留；同一业务条目更新时复用已有内部 id。
 */
export function upsertPricingConfigModels(
  currentConfig: PricingConfig,
  incomingModels: ModelPriceEntry[],
  options: {protectUserOverride?: boolean} = {},
): PricingConfigV2 {
  const current = normalizePricingConfig(currentConfig);
  const incoming = normalizePricingConfig({...current, models: incomingModels}).models;
  const merged = new Map(current.models.map(model => [pricingModelUniqueKey(model), model] as const));
  for (const model of incoming) {
    const key = pricingModelUniqueKey(model);
    const existing = merged.get(key);
    if (options.protectUserOverride && existing?.confidence === "user_override") continue;
    // 保存接口常提交只包含可编辑价格字段的稀疏条目；已有能力、目录和来源字段
    // 必须保持不变，避免一次全局改价把上下文窗口等不可见信息抹掉。
    if (existing) {
      const definedPatch = Object.fromEntries(
        Object.entries(model).filter(([, value]) => value !== undefined),
      ) as ModelPriceEntry;
      merged.set(key, {...existing, ...definedPatch, id: existing.id});
    } else {
      merged.set(key, model);
    }
  }
  return {
    ...current,
    models: ensureGloballyUniquePriceEntryIds([...merged.values()])
      .sort((left, right) => pricingModelUniqueKey(left).localeCompare(pricingModelUniqueKey(right))),
  };
}

/**
 * 从价格中心删除条目（按供应商 + 运行时模型 ID 匹配，大小写不敏感）。
 * 该底层工具仅保留给历史迁移/测试；产品入口统一使用“取消手工覆盖”，
 * 直接替换当前条目来源并保留条目 ID，避免目标映射出现悬空。
 */
export function removePricingConfigModels(
  currentConfig: PricingConfig,
  targets: Array<{vendor: string; runtimeModelId: string}>,
): PricingConfigV2 {
  const current = normalizePricingConfig(currentConfig);
  const keys = new Set(targets
    .filter(item => item.vendor.trim() && item.runtimeModelId.trim())
    .map(item => `${item.vendor.trim().toLowerCase()}\u0000${item.runtimeModelId.trim().toLowerCase()}`));
  if (keys.size === 0) return current;
  return {
    ...current,
    models: current.models.filter(model => !keys.has(pricingModelUniqueKey(model))),
  };
}

function mergeLiteLLMAliasEntries(left: ModelPriceEntry, right: ModelPriceEntry): ModelPriceEntry {
  const runtimeModelId = pricingEntryRuntimeModelId(left);
  const leftDirect = left.id.trim().toLowerCase() === runtimeModelId.toLowerCase();
  const rightDirect = right.id.trim().toLowerCase() === runtimeModelId.toLowerCase();
  if (!leftDirect && !rightDirect && !samePricingBasis(left, right)) {
    throw new Error(`PRICING_IMPORT_VENDOR_MODEL_CONFLICT:${left.id}:${right.id}`);
  }
  const winner = rightDirect && !leftDirect
    ? right
    : leftDirect && !rightDirect
      ? left
      : left.id.localeCompare(right.id) <= 0 ? left : right;
  const alternate = winner === left ? right : left;
  const patterns = uniqueSorted([
    winner.id,
    winner.match,
    ...winner.patterns,
    ...(winner.aliases ?? []),
    alternate.id,
    alternate.match,
    ...alternate.patterns,
    ...(alternate.aliases ?? []),
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0));
  return {
    ...winner,
    runtimeModelId,
    patterns,
    aliases: uniqueSorted([
      ...(winner.aliases ?? []),
      ...(alternate.aliases ?? []),
    ]),
  };
}

/**
 * LiteLLM 的原始模型 ID 并不保证全局唯一：不同供应商可能复用同一字符串。
 * 价格中心又要求 priceEntryId 全局唯一，因此只在跨供应商/运行时模型发生 ID
 * 冲突时生成稳定的 catalog:<vendor>:<runtimeModelId> ID，并保留原 ID 作为匹配词。
 */
function ensureGloballyUniquePriceEntryIds(models: ModelPriceEntry[]): ModelPriceEntry[] {
  const owners = new Map<string, string>();
  return models.map(model => {
    const originalId = model.id.trim();
    const key = pricingModelUniqueKey(model);
    const owner = owners.get(originalId);
    if (!owner || owner === key) {
      owners.set(originalId, key);
      return model;
    }
    const baseId = `catalog:${sanitizePriceEntryIdPart(model.vendor)}:${sanitizePriceEntryIdPart(pricingEntryRuntimeModelId(model))}`;
    let nextId = baseId;
    let suffix = 2;
    while (owners.has(nextId)) nextId = `${baseId}#${suffix++}`;
    owners.set(nextId, key);
    return {
      ...model,
      id: nextId,
      match: model.match || originalId,
      patterns: uniqueSorted([originalId, ...(model.match ? [model.match] : []), ...model.patterns]),
      aliases: uniqueSorted([...(model.aliases || []), originalId]),
    };
  });
}

function sanitizePriceEntryIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._:/-]+/gu, "_") || "unknown";
}

function samePricingBasis(left: ModelPriceEntry, right: ModelPriceEntry): boolean {
  return canonicalPricingBasis(left) === canonicalPricingBasis(right);
}

function canonicalPricingBasis(entry: ModelPriceEntry): string {
  return JSON.stringify({currency: entry.currency || "USD", pricing: entry.pricing});
}

export function pricingModelUniqueKey(model: ModelPriceEntry): string {
  return [
    model.vendor.trim().toLowerCase(),
    pricingEntryRuntimeModelId(model).toLowerCase(),
  ].join("\u0000");
}

/** 价格中心基础唯一键使用的运行时模型 ID；旧条目按别名/匹配规则兼容推导。 */
export function pricingEntryRuntimeModelId(model: ModelPriceEntry): string {
  return derivePricingRuntimeModelId(
    model.vendor,
    model.id,
    model.runtimeModelId,
    model.match,
    model.patterns,
  );
}

function derivePricingRuntimeModelId(
  vendor: string,
  id: string,
  runtimeModelId?: string,
  match?: string,
  patterns: string[] = [],
): string {
  const explicit = runtimeModelId?.trim();
  if (explicit) return explicit;
  const candidate = match?.trim() || patterns[0]?.trim() || id.trim();
  const vendorPrefix = `${vendor.trim().toLowerCase()}/`;
  return candidate.toLowerCase().startsWith(vendorPrefix)
    ? candidate.slice(vendorPrefix.length)
    : candidate;
}

/** 严格阻止同一供应商 + 运行时模型出现多条基础价格。 */
export function assertPricingCatalogUnique(config: PricingConfig): PricingConfigV2 {
  const normalized = normalizePricingConfig(config);
  const seen = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const model of normalized.models) {
    const runtimeModelId = pricingEntryRuntimeModelId(model);
    const priceEntryId = model.id.trim();
    if (!priceEntryId || !model.vendor.trim() || !runtimeModelId) throw new Error("PRICING_VENDOR_MODEL_REQUIRED");
    if (seenIds.has(priceEntryId)) throw new Error(`PRICING_ENTRY_ID_CONFLICT:${priceEntryId}`);
    seenIds.add(priceEntryId);
    const key = pricingModelUniqueKey(model);
    const existing = seen.get(key);
    if (existing) throw new Error(`PRICING_VENDOR_MODEL_CONFLICT:${existing}:${model.id}`);
    seen.set(key, model.id);
  }
  return normalized;
}

function liteLLMEntryToModelPrice(id: string, value: unknown, sourceUrl: string, fetchedAt: string): ModelPriceEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const input = perTokenToPerMillion(raw.input_cost_per_token);
  const output = perTokenToPerMillion(raw.output_cost_per_token);
  if (input === undefined || output === undefined) return undefined;
  const provider = stringValue(raw.litellm_provider) || providerFromModelId(id);
  const alias = id.includes("/") ? id.split("/").slice(1).join("/") : undefined;
  const aliases = alias && alias !== id ? [alias] : undefined;
  return {
    id,
    vendor: provider,
    runtimeModelId: alias || id,
    match: id,
    patterns: [id],
    aliases,
    mode: stringValue(raw.mode),
    contextWindow: numberValue(raw.max_input_tokens) ?? numberValue(raw.max_tokens),
    litellmProvider: provider,
    pricing: {
      input,
      output,
      cachedInput: perTokenToPerMillion(raw.cache_read_input_token_cost),
      cacheWrite: perTokenToPerMillion(raw.cache_creation_input_token_cost),
      reasoning: perTokenToPerMillion(raw.output_cost_per_reasoning_token),
    },
    currency: "USD",
    confidence: "third_party",
    sourceUrl,
    sourceCheckedAt: fetchedAt,
    notes: "由 LiteLLM 社区价格表导入；请在价格中心确认后用于正式计价。",
  };
}

function providerFromModelId(id: string): string {
  const [provider] = id.split("/");
  return provider && provider !== id ? provider : "unknown";
}

function perTokenToPerMillion(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Number((value * PER_MILLION).toPrecision(12));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function queryPricingCatalog(config: PricingConfig, query: PricingCatalogQuery = {}): PricingCatalogPage {
  const normalized = normalizePricingConfig(config);
  const search = query.search?.trim().toLowerCase() || "";
  const vendor = query.vendor?.trim().toLowerCase() || "";
  const mode = query.mode?.trim().toLowerCase() || "";
  // 多选筛选：空数组 = 不过滤；值按大小写不敏感精确匹配。
  // modelEntries 为条目级（供应商 + 运行时模型成对）过滤，服务价格中心「模型 - 供应商」候选。
  const vendorSet = normalizeFilterValues(query.vendors);
  const modelEntrySet = normalizeModelEntryFilter(query.modelEntries);
  const categorySet = new Set(query.categories || []);
  const allItems = normalized.models
    .filter(item => !vendor || item.vendor.toLowerCase() === vendor)
    .filter(item => !mode || (item.mode || "").toLowerCase() === mode)
    .filter(item => vendorSet === undefined || vendorSet.has(item.vendor.trim().toLowerCase()))
    .filter(item => modelEntrySet === undefined
      || modelEntrySet.has(pricingModelEntryKey(item.vendor.trim().toLowerCase(), pricingEntryRuntimeModelId(item).toLowerCase())))
    .filter(item => categorySet.size === 0 || categorySet.has(pricingEntrySourceCategory(item)))
    .filter(item => {
      if (!search) return true;
      const haystack = [
        item.id,
        item.vendor,
        item.mode,
        ...(item.patterns || []),
        ...(item.aliases || []),
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(search);
    })
    .sort((a, b) => `${a.vendor}/${a.id}`.localeCompare(`${b.vendor}/${b.id}`));
  const limit = clampInteger(query.limit, 50, 1, 200);
  const offset = clampInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const categoryCounts: Record<PricingEntrySourceCategory, number> = {manual: 0, catalog: 0, litellm: 0, pending: 0};
  for (const item of normalized.models) {
    categoryCounts[pricingEntrySourceCategory(item)] += 1;
  }
  return {
    items: allItems.slice(offset, offset + limit),
    total: allItems.length,
    limit,
    offset,
    facets: {
      vendors: uniqueSorted(normalized.models.map(item => item.vendor).filter(Boolean)),
      modes: uniqueSorted(normalized.models.map(item => item.mode).filter((item): item is string => !!item)),
      models: uniqueSorted(normalized.models.map(item => pricingEntryRuntimeModelId(item)).filter(Boolean)),
      modelEntries: uniqueModelEntries(normalized.models),
      categoryCounts,
    },
    catalogSource: normalized.catalogSource,
    catalogSync: normalized.catalogSync,
    litellmSync: normalized.litellmSync,
    unconvertedCatalogPricing: normalized.unconvertedCatalogPricing,
  };
}

/** 多选筛选值归一：小写化去空；空集合视为不过滤（返回 undefined）。 */
function normalizeFilterValues(values: string[] | undefined): Set<string> | undefined {
  const normalized = (values || [])
    .map(item => item.trim().toLowerCase())
    .filter(item => item.length > 0);
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

/** 条目级筛选键归一：供应商/模型成对小写化成键；空集合视为不过滤（返回 undefined）。 */
function normalizeModelEntryFilter(entries: PricingCatalogModelEntry[] | undefined): Set<string> | undefined {
  const normalized = (entries || [])
    .map(entry => pricingModelEntryKey(entry.vendor.trim().toLowerCase(), entry.model.trim().toLowerCase()))
    .filter(key => !key.includes("\u0000\u0000") && key !== "\u0000");
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

/** 模型 × 供应商条目候选：按对去重（大小写不敏感，保留首个原始大小写），模型名优先排序。 */
function uniqueModelEntries(models: ModelPriceEntry[]): PricingCatalogModelEntry[] {
  const seen = new Set<string>();
  const entries: PricingCatalogModelEntry[] = [];
  for (const item of models) {
    const model = pricingEntryRuntimeModelId(item);
    const vendor = item.vendor.trim();
    if (!model || !vendor) continue;
    const key = pricingModelEntryKey(vendor.toLowerCase(), model.toLowerCase());
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({model, vendor});
  }
  return entries.sort((a, b) =>
    a.model.localeCompare(b.model) || a.vendor.localeCompare(b.vendor));
}

/** 启动器按供应商 + 真实运行时模型 ID 精确匹配，不使用内部条目 ID、别名或模糊规则。 */
export function findPricingCatalogModel(
  config: PricingConfig,
  vendor: string,
  modelId: string,
): ModelPriceEntry | undefined {
  const normalizedVendor = vendor.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (!normalizedVendor || !normalizedModelId) return undefined;
  return normalizePricingConfig(config).models.find(item =>
    item.vendor.trim().toLowerCase() === normalizedVendor
    && pricingEntryRuntimeModelId(item) === normalizedModelId,
  );
}

/** 服务端写供应商前逐项验证 Agent 可见模型对价格中心真实条目的引用。 */
export function assertProxyTargetPriceMappings(config: PricingConfig, target: Pick<ProxyTarget, "supportedModels" | "pricing">): void {
  // 自定义供应商刚创建时尚未发现模型；此时不能因为价格中心中与供应商无关的历史冲突阻塞空供应商壳创建。
  if (target.supportedModels.length === 0) return;
  const normalized = normalizePricingConfig(config);
  for (const runtimeModelId of target.supportedModels) {
    const mapping = target.pricing?.modelVendors?.[runtimeModelId];
    if (!mapping?.vendor || !mapping.priceEntryId) throw new Error("MODEL_PRICE_MAPPING_REQUIRED");
    const mappingVendor = mapping.vendor;
    const priceEntryId = mapping.priceEntryId;
    // 供应商保存只校验它实际引用的条目；价格中心全量唯一性由价格中心自身保存负责。
    // 但被引用的条目 ID 或“供应商 + 运行时模型”发生冲突时仍必须严格拒绝，
    // 否则同一供应商的计价会依赖数组顺序，无法保证账本唯一性。
    const entriesById = normalized.models.filter(entry => entry.id.trim() === priceEntryId);
    if (entriesById.length === 0) throw new Error("MODEL_PRICE_ENTRY_NOT_FOUND");
    if (entriesById.length > 1) throw new Error(`PRICING_ENTRY_ID_CONFLICT:${priceEntryId}`);
    const entry = entriesById[0]!;
    if (!entryMatchesVendor(entry, mappingVendor)) throw new Error("MODEL_PRICE_VENDOR_MISMATCH");
    if (!entryMatchesRuntimeModel(entry, runtimeModelId)) throw new Error("MODEL_PRICE_RUNTIME_MISMATCH");
    const identityMatches = normalized.models.filter(candidate =>
      entryMatchesVendor(candidate, mappingVendor)
      && entryMatchesRuntimeModel(candidate, runtimeModelId));
    if (identityMatches.length > 1) {
      throw new Error(`PRICING_VENDOR_MODEL_CONFLICT:${identityMatches.map(candidate => candidate.id).join(":")}`);
    }
    if (!entry.pricing
      || !Number.isFinite(entry.pricing.input)
      || entry.pricing.input < 0
      || !Number.isFinite(entry.pricing.output)
      || entry.pricing.output < 0) {
      throw new Error("MODEL_PRICE_MISSING");
    }
  }
}

export function queryPricingVendors(config: PricingConfig): PricingVendorList {
  const normalized = normalizePricingConfig(config);
  return {
    vendors: uniqueSorted(normalized.models.map(item => item.vendor).filter(Boolean)),
    catalogSource: normalized.catalogSource,
    unconvertedCatalogPricing: normalized.unconvertedCatalogPricing,
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export async function readEffectivePricingConfig(dataDir: string): Promise<PricingConfigV2> {
  const pricing = await readPricingConfig(dataDir);
  const proxyConfig = await readProxyConfigForPricing(dataDir);
  return proxyConfig ? applyProxyTargetPricing(pricing, proxyConfig) : pricing;
}

/**
 * 有界读取 proxy-config（≤1 MiB）用于目标级覆盖应用；导出供写入路径复用
 * （2026-09-10 性能优化：保存后记录版本时复用已写盘配置，只需补读这一小块）。
 */
export async function readProxyConfigForPricing(dataDir: string): Promise<ProxyConfig | undefined> {
  try {
    const raw = await readFile(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ dataDir,
        "proxy-config.json",
      ),
      "utf-8",
    );
    return JSON.parse(raw) as ProxyConfig;
  } catch {
    return undefined;
  }
}

export function applyProxyTargetPricing(config: PricingConfig, proxyConfig: ProxyConfig): PricingConfigV2 {
  const normalized = normalizePricingConfig(config);
  const targetOverrides: TargetPricingOverride[] = [...(normalized.targetOverrides || [])];
  const targetVendorPreferences: Record<string, string> = { ...(normalized.targetVendorPreferences || {}) };
  const targetModelMappings: Record<string, Record<string, ProxyTargetModelVendor>> = {
    ...(normalized.targetModelMappings || {}),
  };
  // 结算系数以 proxy-config 为唯一来源构建（模型价格文件不携带该字段）：
  // 仅显式配置了合法系数的目标进入映射，清空系数即从映射消失。
  const targetSettlementFx: Record<string, number> = {};
  for (const target of proxyConfig.targets || []) {
    const policy = target.pricing;
    if (!policy) continue;
    if (
      typeof policy.settlementFx === "number"
      && Number.isFinite(policy.settlementFx)
      && policy.settlementFx > 0
    ) {
      targetSettlementFx[target.id] = policy.settlementFx;
    }
    if (typeof policy.vendor === "string" && policy.vendor.trim()) {
      targetVendorPreferences[target.id] = policy.vendor.trim();
    }
    if (policy.modelVendors && typeof policy.modelVendors === "object") {
      const modelMap: Record<string, ProxyTargetModelVendor> = {};
      for (const [modelId, mapping] of Object.entries(policy.modelVendors)) {
        if (!mapping || typeof mapping !== "object") continue;
        const vendor = typeof mapping.vendor === "string" && mapping.vendor.trim()
          ? mapping.vendor.trim()
          : undefined;
        const priceEntryId = typeof mapping.priceEntryId === "string" && mapping.priceEntryId.trim()
          ? mapping.priceEntryId.trim()
          : undefined;
        if (vendor || priceEntryId) {
          modelMap[modelId] = {
            ...(vendor ? {vendor} : {}),
            ...(priceEntryId ? {priceEntryId} : {}),
          };
        }
      }
      if (Object.keys(modelMap).length > 0) targetModelMappings[target.id] = modelMap;
    }
    for (const override of policy.modelOverrides || []) {
      // 2026-09-03 用户决策移除中转站价格同步链路：存量 relay_synced 覆盖不再参与计价，
      // 计价回归价格中心官方价；站点实扣差异由对账补差闭环。user_override 手工价不受影响。
      if (override.confidence === "relay_synced") continue;
      const patterns = override.targetModelId
        ? targetModelTerms(override.targetModelId)
        : [];
      if (patterns.length === 0) continue;
      targetOverrides.push({
        id: override.id,
        targetId: target.id,
        patterns,
        pricing: override.pricing,
        priceSchedules: override.priceSchedules,
        currency: override.currency || policy.currency,
        confidence: override.confidence || "user_override",
        sourceUrl: override.sourceUrl || `local://proxy-targets/${target.id}/model-overrides/${override.id}`,
        sourceCheckedAt: override.sourceCheckedAt,
        notes: override.notes,
      });
    }
  }
  return {
    ...normalized,
    targetOverrides,
    targetVendorPreferences: Object.keys(targetVendorPreferences).length > 0 ? targetVendorPreferences : undefined,
    targetModelMappings: Object.keys(targetModelMappings).length > 0 ? targetModelMappings : undefined,
    targetSettlementFx: Object.keys(targetSettlementFx).length > 0 ? targetSettlementFx : undefined,
  };
}

function targetModelTerms(modelId: string): string[] {
  const alias = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : undefined;
  return uniqueSorted([modelId, alias].filter((item): item is string => Boolean(item)));
}

function userPricingPath(dataDir: string): string {
  return join(/* turbopackIgnore: true */ dataDir, USER_PRICING_FILE);
}

/**
 * 严格读取已经持久化的价格目录。只有文件不存在返回 undefined；损坏、超限和权限错误必须上抛，
 * 供自动导入区分“首次初始化”和“现有配置不可安全覆盖”。
 *
 * 结果按「文件 mtimeNs + size」指纹缓存：首屏多个接口（config-sync、价格目录、fx 快照）
 * 各自全量读取几 MB 的 model-pricing.json 属纯重复 CPU。写入方全部走 atomicWritePricingFile
 * （重命名新文件，mtime/size 必变）并主动清缓存；跨进程写由指纹自然失效兜底。
 * 缓存返回共享对象：normalizePricingConfig 为纯函数（map 出新对象），调用方按只读契约使用。
 */
interface PricingConfigCacheEntry {
  mtimeNs: string;
  size: number;
  config: PricingConfigV2;
}
const pricingConfigCache = new Map<string, PricingConfigCacheEntry>();

export async function readPersistedPricingConfig(dataDir: string): Promise<PricingConfigV2 | undefined> {
  const path = userPricingPath(dataDir);
  let fingerprint: {mtimeNs: string; size: number};
  let raw: string;
  try {
    const read = await readPricingFileBounded(path);
    fingerprint = {mtimeNs: read.mtimeNs.toString(), size: read.size};
    raw = read.buffer.toString("utf-8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }

  const cacheKey = resolve(path);
  const cached = pricingConfigCache.get(cacheKey);
  if (cached && cached.mtimeNs === fingerprint.mtimeNs && cached.size === fingerprint.size) {
    return cached.config;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("本地模型价格配置不是合法 JSON，已保留原文件。", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) {
    throw new Error("本地模型价格配置缺少 models 数组，已保留原文件。");
  }
  const config = normalizePricingConfig(parsed);
  pricingConfigCache.set(cacheKey, {...fingerprint, config});
  return config;
}

/** 读取价格配置：只有文件不存在时回退内置默认；损坏、超限或权限错误必须显式上抛。 */
export async function readPricingConfig(dataDir: string): Promise<PricingConfigV2> {
  return await readPersistedPricingConfig(dataDir) ?? DEFAULT_PRICING;
}

/** 持久化用户价格覆盖；写入前统一规范化为 v2，并以同目录原子替换避免半写 JSON。 */
export async function writePricingConfig(dataDir: string, config: PricingConfig): Promise<void> {
  const path = userPricingPath(dataDir);
  const content = `${JSON.stringify(assertPricingCatalogUnique(config), null, 2)}\n`;
  if (Buffer.byteLength(content, "utf-8") > MAX_PRICING_CONFIG_BYTES) {
    throw new Error("模型价格配置超过 8 MiB 安全上限。");
  }
  await atomicWritePricingFile(path, content);
}

/** 同一数据目录内串行执行价格修改；网络请求应在进入该临界区前完成。 */
export async function withPricingConfigMutation<T>(
  dataDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(userPricingPath(dataDir));
  const previous = pricingMutationTails.get(key) ?? Promise.resolve();
  const execution = previous.then(operation);
  const tail = execution.then(() => undefined, () => undefined);
  pricingMutationTails.set(key, tail);
  try {
    return await execution;
  } finally {
    if (pricingMutationTails.get(key) === tail) pricingMutationTails.delete(key);
  }
}

async function readPricingFileBounded(filePath: string): Promise<{buffer: Buffer; mtimeNs: bigint; size: number}> {
  const handle = await open(/* turbopackIgnore: true */ filePath, "r");
  try {
    // bigint 统计拿到 ns 级 mtime（缓存指纹用）；before/after 同口径可比。
    const before = await handle.stat({bigint: true});
    if (!before.isFile()) throw new Error(`模型价格配置不是普通文件：${filePath}`);
    if (before.size > BigInt(MAX_PRICING_CONFIG_BYTES)) {
      throw new Error(`模型价格配置超过 8 MiB 安全上限：${filePath}`);
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({bigint: true});
    if (after.size > BigInt(MAX_PRICING_CONFIG_BYTES)) {
      throw new Error(`模型价格配置超过 8 MiB 安全上限：${filePath}`);
    }
    if (after.size !== before.size || offset !== buffer.length) {
      throw new Error(`模型价格配置在读取期间发生变化：${filePath}`);
    }
    return {buffer, mtimeNs: after.mtimeNs, size: Number(after.size)};
  } finally {
    await handle.close();
  }
}

async function atomicWritePricingFile(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    // 写后主动清读缓存（mtime 指纹兜底跨进程写；这里保证同进程写后立即可见）。
    pricingConfigCache.delete(resolve(filePath));
    await syncDirectoryBestEffort(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows 和部分文件系统不支持目录 fsync；同目录 rename 仍保持原子可见性。
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * version 缺失/未知但条目携带 v2 专属字段（confidence / 嵌套 pricing / patterns /
 * runtimeModelId）时按 v2 处理：随包 LiteLLM 快照曾因缺 version 被误判为 v1 遗留，
 * 整体洗成 user_override 且价格全部丢失（2026-10-11 修复）。v1 扁平条目
 * （仅 id/match/vendor/input/output）没有这些字段，不受影响。
 */
function looksLikeV2ModelEntries(models: unknown): boolean {
  if (!Array.isArray(models)) return false;
  return models.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Partial<ModelPriceEntry>;
    return typeof entry.confidence === "string"
      || (!!entry.pricing && typeof entry.pricing === "object")
      || Array.isArray(entry.patterns)
      || typeof entry.runtimeModelId === "string";
  });
}

export function normalizePricingConfig(value: unknown): PricingConfigV2 {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) {
    return DEFAULT_PRICING;
  }
  const candidate = value as Partial<PricingConfigV2> & Partial<LegacyPricingConfig>;
  if (candidate.version === 2
    || (candidate.version !== 1 && looksLikeV2ModelEntries(candidate.models))) {
    return {
      version: 2,
      currency: typeof candidate.currency === "string" ? candidate.currency : "USD",
      unit: typeof candidate.unit === "string" ? candidate.unit : "per_million_tokens",
      sourceCheckedAt: typeof candidate.sourceCheckedAt === "string" ? candidate.sourceCheckedAt : undefined,
      catalogSource: normalizeCatalogSource(candidate.catalogSource),
      models: ((candidate.models || []) as unknown[]).map(normalizeModelEntry).filter((entry): entry is ModelPriceEntry => entry !== undefined),
      targetOverrides: Array.isArray(candidate.targetOverrides)
        ? candidate.targetOverrides.map(normalizeTargetOverride).filter((entry): entry is TargetPricingOverride => entry !== undefined)
        : undefined,
      targetVendorPreferences: normalizeTargetVendorPreferences(candidate.targetVendorPreferences),
      targetModelMappings: normalizeTargetModelMappings(candidate.targetModelMappings),
      targetSettlementFx: normalizeTargetSettlementFx(candidate.targetSettlementFx),
      unconvertedCatalogPricing: candidate.unconvertedCatalogPricing === true || undefined,
      fx: normalizeFxSnapshot(candidate.fx),
      catalogSync: normalizeCatalogSyncMarker(candidate.catalogSync),
      litellmSync: normalizeLiteLLMSyncMarker(candidate.litellmSync),
    };
  }
  return migrateLegacyPricingConfig(candidate as LegacyPricingConfig);
}

/** 目标级结算系数映射：目标路由 ID → 正数乘数；空/非法条目剔除，空映射归一为 undefined。 */
function normalizeTargetSettlementFx(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [targetId, fx] of Object.entries(value as Record<string, unknown>)) {
    if (!targetId.trim()) continue;
    if (typeof fx !== "number" || !Number.isFinite(fx) || fx <= 0) continue;
    result[targetId] = fx;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTargetModelMappings(
  value: unknown,
): Record<string, Record<string, ProxyTargetModelVendor>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, Record<string, ProxyTargetModelVendor>> = {};
  for (const [targetId, models] of Object.entries(value as Record<string, unknown>)) {
    if (!targetId.trim() || !models || typeof models !== "object" || Array.isArray(models)) continue;
    const modelMap: Record<string, ProxyTargetModelVendor> = {};
    for (const [modelId, mapping] of Object.entries(models as Record<string, unknown>)) {
      if (!modelId.trim() || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
      const raw = mapping as Partial<ProxyTargetModelVendor>;
      const vendor = typeof raw.vendor === "string" && raw.vendor.trim() ? raw.vendor.trim() : undefined;
      const priceEntryId = typeof raw.priceEntryId === "string" && raw.priceEntryId.trim()
        ? raw.priceEntryId.trim()
        : undefined;
      if (!vendor && !priceEntryId) continue;
      modelMap[modelId] = {
        ...(vendor ? {vendor} : {}),
        ...(priceEntryId ? {priceEntryId} : {}),
      };
    }
    if (Object.keys(modelMap).length > 0) result[targetId] = modelMap;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTargetVendorPreferences(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([targetId, vendor]) => [targetId.trim(), typeof vendor === "string" ? vendor.trim() : ""] as const)
    .filter(([targetId, vendor]) => targetId.length > 0 && vendor.length > 0);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

/** 汇率快照浅校验：rates 必须是正有限数；键格式 BASE/QUOTE。 */
function normalizeFxSnapshot(value: unknown): PricingFxSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<PricingFxSnapshot>;
  if (!raw.rates || typeof raw.rates !== "object" || Array.isArray(raw.rates)) return undefined;
  const rates: Record<string, number> = {};
  for (const [pair, rate] of Object.entries(raw.rates)) {
    if (!/^[A-Z]{3}\/[A-Z]{3}$/u.test(pair)) continue;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) rates[pair] = rate;
  }
  if (Object.keys(rates).length === 0) return undefined;
  return {
    rates,
    ...(typeof raw.asOf === "string" ? {asOf: raw.asOf} : {}),
    ...(typeof raw.source === "string" ? {source: raw.source} : {}),
  };
}

function normalizeModelEntry(value: unknown): ModelPriceEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ModelPriceEntry & LegacyModelPriceEntry>;
  if (typeof raw.id !== "string" || typeof raw.vendor !== "string") return undefined;
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.filter((item): item is string => typeof item === "string" && item.length > 0)
    : typeof raw.match === "string" ? [raw.match] : [raw.id];
  const legacyPricing = typeof raw.input === "number" && typeof raw.output === "number"
    ? { input: raw.input, output: raw.output, cachedInput: raw.cacheRead, cacheWrite: raw.cacheCreation }
    : undefined;
  return {
    id: raw.id,
    vendor: raw.vendor,
    runtimeModelId: derivePricingRuntimeModelId(
      raw.vendor,
      raw.id,
      typeof raw.runtimeModelId === "string" ? raw.runtimeModelId : undefined,
      typeof raw.match === "string" ? raw.match : undefined,
      patterns,
    ),
    match: typeof raw.match === "string" ? raw.match : patterns[0],
    patterns,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((item): item is string => typeof item === "string") : undefined,
    mode: typeof raw.mode === "string" ? raw.mode : undefined,
    contextWindow: typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow) ? raw.contextWindow : undefined,
    maxOutput: typeof raw.maxOutput === "number" && Number.isFinite(raw.maxOutput) ? raw.maxOutput : undefined,
    litellmProvider: typeof raw.litellmProvider === "string" ? raw.litellmProvider : undefined,
    pricingProviderId: typeof raw.pricingProviderId === "string" ? raw.pricingProviderId : undefined,
    region: raw.region === "cn" || raw.region === "global" ? raw.region : undefined,
    catalogSource: raw.catalogSource === "catalog" ? "catalog" : undefined,
    pricing: raw.pricing || legacyPricing,
    usageSchema: raw.usageSchema,
    serviceTierPricing: normalizeServiceTierPricingShallow(raw.serviceTierPricing),
    promotions: normalizePaygPromotionsShallow(raw.promotions),
    previousPricing: raw.previousPricing,
    priceSchedules: normalizePriceSchedulesShallow(raw.priceSchedules),
    planCreditRules: normalizePlanCreditRulesShallow(raw.planCreditRules),
    currency: typeof raw.currency === "string" ? raw.currency : "USD",
    confidence: raw.confidence || "user_override",
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : undefined,
    sourceCheckedAt: typeof raw.sourceCheckedAt === "string" ? raw.sourceCheckedAt : undefined,
    deprecatedAt: typeof raw.deprecatedAt === "string" ? raw.deprecatedAt : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    // 目录 v2 编译投影字段：来源版本、协议能力与价格时间线（有界浅校验）。
    catalogRevision: typeof raw.catalogRevision === "string" ? raw.catalogRevision : undefined,
    catalogSourceHash: typeof raw.catalogSourceHash === "string" ? raw.catalogSourceHash : undefined,
    supportedWireApis: Array.isArray(raw.supportedWireApis)
      ? [...new Set(raw.supportedWireApis.filter((item): item is WireApi =>
          item === "chat_completions" || item === "responses" || item === "messages"))]
      : undefined,
    // 输入模态浅校验（目录侧已深校验；与 supportedWireApis 同型的白名单放行，防静默丢弃）。
    inputModalities: Array.isArray(raw.inputModalities)
      ? [...new Set(raw.inputModalities.filter((item): item is InputModality =>
          item === "text" || item === "image" || item === "audio"))]
      : undefined,
    rateTimeline: normalizeRateTimelineShallow(raw.rateTimeline),
  };
}

/** 价格时间线浅校验（目录侧已深校验；此处只做结构兜底与有界保护）。 */
function normalizeRateTimelineShallow(value: unknown): PriceRateSegment[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const segments = value.filter((item): item is PriceRateSegment =>
    !!item && typeof item === "object" && !Array.isArray(item)
    && (item as PriceRateSegment).pricing !== undefined
    && typeof (item as PriceRateSegment).pricing.input === "number"
    && typeof (item as PriceRateSegment).pricing.output === "number");
  if (segments.length !== value.length || segments.length === 0 || segments.length > 8) return undefined;
  return segments.map(segment => ({
    ...(typeof segment.effectiveFrom === "string" ? {effectiveFrom: segment.effectiveFrom} : {}),
    pricing: segment.pricing,
    ...(Array.isArray(segment.priceSchedules) ? {priceSchedules: normalizePriceSchedulesShallow(segment.priceSchedules)} : {}),
    ...(segment.serviceTierPricing ? {serviceTierPricing: segment.serviceTierPricing} : {}),
    ...(segment.planFactors ? {planFactors: segment.planFactors} : {}),
    ...(typeof segment.changeNote === "string" ? {changeNote: segment.changeNote} : {}),
  }));
}

/** 价格中心浅校验时段费率；目录侧已深校验，这里只做结构兜底。 */
function normalizePriceSchedulesShallow(value: unknown): TemporalPriceSchedule[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.filter((item): item is TemporalPriceSchedule => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const schedule = item as Partial<TemporalPriceSchedule>;
    return typeof schedule.label === "string"
      && Array.isArray(schedule.windows)
      && !!schedule.rates
      && typeof schedule.rates.input === "number"
      && typeof schedule.rates.output === "number";
  }).map(schedule => ({
    ...schedule,
    ...(Array.isArray(schedule.holidays) && schedule.holidays.length > 0
      ? {holidays: [...new Set(schedule.holidays.filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date)))].sort()}
      : {}),
  }));
}

/** 价格中心浅校验套餐积分规则；目录侧已深校验，这里只做结构兜底（含 v2 新字段的类型兜底）。 */
function normalizePlanCreditRulesShallow(value: unknown): PlanCreditRules | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rules = value as Partial<PlanCreditRules>;
  // formula 必须是已知公式族（computePlanCredit 的 dispatch 穷尽该枚举），非法值整条丢弃。
  if (typeof rules.formula !== "string"
    || !PLAN_CREDIT_FORMULAS.has(rules.formula)
    || !Array.isArray(rules.quotaWindows)) return undefined;
  // promotions 先从展开中剔除、经守卫后再放回：非法活动规则（如坏时刻窗）绝不能
  // 经由浅层展开混入价格中心——引擎 activePromotion 逐窗口解析会抛错，威胁 Worker 稳定。
  const {promotions: rawPromotions, ...rest} = rules;
  return {
    ...rest,
    // 守卫已收窄两个必填字段；置于展开之后覆盖 Partial 展开带来的 undefined 联合。
    formula: rules.formula,
    quotaWindows: rules.quotaWindows,
    ...(typeof rules.timezone === "string" && rules.timezone ? {timezone: rules.timezone} : {}),
    ...(typeof rules.offPeakMultiplier === "number" && Number.isFinite(rules.offPeakMultiplier) && rules.offPeakMultiplier >= 0
      ? {offPeakMultiplier: rules.offPeakMultiplier}
      : {}),
    ...(isValidStringRecord(rules.aliases) ? {aliases: rules.aliases} : {}),
    ...(isValidPromotions(rawPromotions) ? {promotions: rawPromotions} : {}),
    ...(isValidQuotaTiers(rules.quotaTiers) ? {quotaTiers: rules.quotaTiers} : {}),
    ...(isValidToolFactors(rules.toolFactors) ? {toolFactors: rules.toolFactors} : {}),
  };
}

function isValidStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => key.length > 0 && typeof item === "string" && item.length > 0);
}

/** 价格中心浅校验限时活动规则：from 必须是可解析时刻，to 缺省=无限期（2026-09-08 起可空）。 */
function isValidPromotions(value: unknown): value is PlanCreditPromotion[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const promotion = item as Partial<PlanCreditPromotion>;
    if (typeof promotion.from !== "string" || !promotion.from) return false;
    const from = new Date(promotion.from);
    if (!Number.isFinite(from.getTime())) return false;
    if (promotion.to !== undefined
      && (typeof promotion.to !== "string" || !promotion.to || !Number.isFinite(new Date(promotion.to).getTime()))) return false;
    if (promotion.models !== undefined
      && (!Array.isArray(promotion.models) || promotion.models.some(model => typeof model !== "string" || !model))) return false;
    if (promotion.agents !== undefined
      && (!Array.isArray(promotion.agents) || promotion.agents.some(agent => typeof agent !== "string" || !agent))) return false;
    if (promotion.multiplier !== undefined
      && (!Number.isFinite(promotion.multiplier) || (promotion.multiplier as number) < 0)) return false;
    if (promotion.input !== undefined
      && (!Number.isFinite(promotion.input) || (promotion.input as number) < 0)) return false;
    if (promotion.output !== undefined
      && (!Number.isFinite(promotion.output) || (promotion.output as number) < 0)) return false;
    if (promotion.cachedInput !== undefined
      && (!Number.isFinite(promotion.cachedInput) || (promotion.cachedInput as number) < 0)) return false;
    if (promotion.windows !== undefined && !isValidPromotionWindows(promotion.windows)) return false;
    if (promotion.origins !== undefined
      && (!Array.isArray(promotion.origins) || promotion.origins.length === 0
        || promotion.origins.some(origin => origin !== "gateway" && origin !== "agent_local_import"))) return false;
    return true;
  });
}

/** 活动每日时间窗浅校验：非抛错式（引擎 isWithinTimeWindows 的 parseClockMinutes 会 throw，
 *  坏窗口绝不能进入价格中心配置）；形状与目录深校验一致：days 0-6、start/end 合法钟点、end 可 24:00。 */
function isValidPromotionWindows(value: unknown): value is PlanCreditPromotionWindow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return false;
  return value.every(window => {
    if (!window || typeof window !== "object" || Array.isArray(window)) return false;
    const item = window as Partial<PlanCreditPromotionWindow>;
    if (!isValidClockText(item.start) || !isValidClockText(item.end)) return false;
    if (item.days !== undefined
      && (!Array.isArray(item.days) || item.days.length === 0
        || item.days.some(day => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6))) return false;
    return true;
  });
}

/** "HH:mm"/"HH:mm:ss" 非抛错校验；24:00 仅接受整点收尾（与 parseClockMinutes 口径一致）。 */
function isValidClockText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const isMidnightEnd = hour === 24 && minute === 0 && second === 0;
  return hour >= 0 && hour <= 24 && minute <= 59 && second <= 59 && (hour !== 24 || isMidnightEnd);
}

/** 价格中心浅校验按量促销：priceOverride/multiplier 恰好其一，from/to（可空）可解析，字段非负有限。 */
function normalizePaygPromotionsShallow(value: unknown): PaygPromotion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const promotions: PaygPromotion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Partial<PaygPromotion>;
    if (typeof raw.from !== "string" || !raw.from || !Number.isFinite(new Date(raw.from).getTime())) continue;
    if (raw.to !== undefined
      && (typeof raw.to !== "string" || !raw.to || !Number.isFinite(new Date(raw.to).getTime()))) continue;
    const priceOverride = normalizeSparseRatesShallow(raw.priceOverride);
    const multiplier = typeof raw.multiplier === "number" && Number.isFinite(raw.multiplier) && raw.multiplier >= 0
      ? raw.multiplier
      : undefined;
    // 效果载体二选一：都缺或多于其一的条目丢弃，绝不让促销同时以两种形态生效。
    if (priceOverride === undefined ? multiplier === undefined : multiplier !== undefined) continue;
    const models = sanitizePromotionScopeList(raw.models);
    const agents = sanitizePromotionScopeList(raw.agents);
    promotions.push({
      from: raw.from,
      ...(raw.to !== undefined ? {to: raw.to} : {}),
      ...(models ? {models} : {}),
      ...(agents ? {agents} : {}),
      ...(typeof raw.label === "string" && raw.label.trim() ? {label: raw.label.trim()} : {}),
      ...(priceOverride !== undefined ? {priceOverride} : {}),
      ...(multiplier !== undefined ? {multiplier} : {}),
    });
  }
  return promotions.length > 0 ? promotions : undefined;
}

/** 限定维度（models/agents）浅清洗：只保留非空字符串并去重；空数组视为未声明。 */
function sanitizePromotionScopeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
  return items.length > 0 ? items : undefined;
}

/** 四价稀疏覆盖集浅校验：至少一个非负有限价格字段，否则视为未声明。 */
function normalizeSparseRatesShallow(value: unknown): SparsePricingRates | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<SparsePricingRates>;
  const result: SparsePricingRates = {};
  let count = 0;
  for (const field of ["input", "output", "cachedInput", "cacheWrite", "cacheWrite5m", "cacheWrite1h"] as const) {
    const numeric = raw[field];
    if (typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0) {
      result[field] = numeric;
      count += 1;
    }
  }
  return count > 0 ? result : undefined;
}

/** 服务档位价格集浅校验：本期只认 fast 键（priceOverride 同构清洗）。 */
function normalizeServiceTierPricingShallow(value: unknown): ServiceTierPricing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const multiplier = (value as Partial<ServiceTierPricing>).fastMultiplier;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) return undefined;
  return {fastMultiplier: multiplier};
}

function isValidQuotaTiers(value: unknown): value is NonNullable<PlanCreditRules["quotaTiers"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(tier =>
    typeof tier === "object" && tier !== null
    && typeof (tier as PlanCreditQuotaTier).quotaByWindow === "object"
    && (tier as PlanCreditQuotaTier).quotaByWindow !== null
    && ((tier as PlanCreditQuotaTier).monthlyFee === undefined
      || (typeof (tier as PlanCreditQuotaTier).monthlyFee === "number" && Number.isFinite((tier as PlanCreditQuotaTier).monthlyFee!) && (tier as PlanCreditQuotaTier).monthlyFee! >= 0))
    && Object.values((tier as PlanCreditQuotaTier).quotaByWindow).every(quota => typeof quota === "number" && Number.isFinite(quota) && quota >= 0),
  );
}

function isValidToolFactors(value: unknown): value is NonNullable<PlanCreditRules["toolFactors"]> {
  return Array.isArray(value) && value.every(item =>
    typeof item === "object" && item !== null
    && typeof (item as PlanCreditToolFactor).id === "string"
    && (item as PlanCreditToolFactor).id.length > 0
    && ((item as PlanCreditToolFactor).perCall === undefined
      || (typeof (item as PlanCreditToolFactor).perCall === "number" && Number.isFinite((item as PlanCreditToolFactor).perCall))),
  );
}

function normalizeTargetOverride(value: unknown): TargetPricingOverride | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<TargetPricingOverride>;
  if (typeof raw.id !== "string" || !Array.isArray(raw.patterns)) return undefined;
  const patterns = raw.patterns.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (patterns.length === 0) return undefined;
  if (!raw.pricing) return undefined;
  return {
    id: raw.id,
    targetId: typeof raw.targetId === "string" ? raw.targetId : undefined,
    agentFingerprintId: typeof raw.agentFingerprintId === "string" ? raw.agentFingerprintId : undefined,
    patterns,
    pricing: raw.pricing,
    priceSchedules: normalizePriceSchedulesShallow(raw.priceSchedules),
    currency: typeof raw.currency === "string" ? raw.currency : undefined,
    confidence: raw.confidence || "user_override",
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : undefined,
    sourceCheckedAt: typeof raw.sourceCheckedAt === "string" ? raw.sourceCheckedAt : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
  };
}

function normalizeCatalogSource(value: unknown): PricingCatalogSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<PricingCatalogSource>;
  const type = raw.type === "litellm" || raw.type === "manual" || raw.type === "built_in" || raw.type === "provider_catalog"
    ? raw.type
    : undefined;
  if (!type) return undefined;
  return {
    type,
    url: typeof raw.url === "string" ? raw.url : undefined,
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : undefined,
    hash: typeof raw.hash === "string" ? raw.hash : undefined,
    modelCount: typeof raw.modelCount === "number" && Number.isFinite(raw.modelCount) ? raw.modelCount : undefined,
  };
}

/** v1 → v2 迁移条目的 notes 标记；存量自愈据此识别历史迁移产物。 */
export const LEGACY_PRICING_MIGRATION_NOTES = "由 v1 价格配置自动迁移。";

function migrateLegacyPricingConfig(config: LegacyPricingConfig): PricingConfigV2 {
  return {
    version: 2,
    currency: typeof config.currency === "string" ? config.currency : "USD",
    unit: typeof config.unit === "string" ? config.unit : "per_million_tokens",
    // 无价格的 v1 条目不可能来自人工价格维护（人工维护必有数值），若迁移为
    // user_override 会冒充最高保护级来源且价格为空；直接丢弃，交由目录导入补齐。
    models: (config.models || [])
      .filter((entry): entry is LegacyModelPriceEntry =>
        !!entry && (Number.isFinite(entry.input) || Number.isFinite(entry.output)))
      .map(entry => ({
        id: entry.id,
        vendor: entry.vendor,
        match: entry.match,
        patterns: [entry.match],
        pricing: {
          input: entry.input,
          output: entry.output,
          cachedInput: entry.cacheRead,
          cacheWrite: entry.cacheCreation,
        },
        currency: config.currency || "USD",
        confidence: "user_override",
        sourceUrl: "local://legacy-model-pricing-v1",
        sourceCheckedAt: OFFICIAL_CHECKED_AT,
        notes: LEGACY_PRICING_MIGRATION_NOTES,
      })),
  };
}
