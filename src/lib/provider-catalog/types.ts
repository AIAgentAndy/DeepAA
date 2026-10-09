import type {
  PlanCreditModelFactor,
  PlanCreditQuotaWindow,
  PricingRates,
  ServiceTierPricing,
  SparsePricingRates,
} from "@/lib/pricing";
import type {CatalogDiagnostic} from "./diagnostics";

export type ProviderCatalogRegion = "cn" | "global";
export type ProviderCatalogCategory = "cn_official" | "global_official" | "official" | "aggregator";
export type ProviderCatalogModelCategory = "chat" | "embedding" | "rerank" | "image" | "audio" | "video";
export type ProviderCatalogWireApi = "chat_completions" | "responses" | "messages";
/** 模型输入模态（2026-09-21 能力下发）：目录声明、价格中心投影、各 Agent 按自身 schema 能力映射。 */
export type ProviderCatalogInputModality = "text" | "image" | "audio";
/** 供应商计价币种（2026-09-05 四层分离）：目录按原始币种维护，展示层按汇率快照拉平。 */
export type ProviderCatalogCurrency = "CNY" | "USD";

export type ProviderCatalogUsageUnit = "token" | "second" | "character" | "image" | "request";

export interface ProviderCatalogUsageField {
  unit: ProviderCatalogUsageUnit;
  price?: number;
  notes?: string;
}

export interface ProviderCatalogUsageSchema {
  fields: Record<string, ProviderCatalogUsageField>;
  currency?: ProviderCatalogCurrency;
  notes?: string;
}

/** 运行时计费通道全名（与目标 billingChannel 同口径）。 */
export type CatalogBillingChannel = "pay_as_you_go" | "plan" | "subscription";
/** 规则层通道短名：payg 固定映射 pay_as_you_go（设计 4.5）。 */
export type CampaignChannel = "payg" | "plan" | "subscription";

/** 目录 v2 契约版本（设计 4.1）：解析器按该版本选择字段与校验规则。 */
export const PROVIDER_CATALOG_SCHEMA_VERSION = 2;

/** 公共日历（元信息行维护）：法定节假日等跨供应商共享的日期列表。 */
export interface ProviderCatalogCalendar {
  timezone: string;
  source?: string;
  coverage?: string;
  dates: string[];
  notes?: string;
}

/** 官方预设展示信息（设计 2.2/4.2）：目录只提供数据事实，运行时权威在源码注册表。 */
export interface ProviderCatalogPreset {
  /** 与 provider-presets.ts 注册表联表的稳定键。 */
  presetKey: string;
  billingChannel: CatalogBillingChannel;
  name: string;
  openaiUrl?: string;
  anthropicUrl?: string;
  openaiWireApis?: ProviderCatalogWireApi[];
  /** 套餐用量查询适配器标识（只表示「如何查用量」，不表示如何计算积分）。 */
  planSyncAdapter?: string;
  consoleUrl?: string;
  /**
   * 预设级积分公式声明（2026-10-07 用户确认）：`"none"` = 该预设的官方套餐未公开
   * 逐请求积分公式/系数/额度（如火山 Coding Plan），派生端不落积分列、估算走
   * 「市价参考 + 额度差分回填」管道；缺省 = 跟随价格中心条目公式（如 Agent Plan、
   * 智谱、OpenCode Go）。与 provider-presets.ts 注册表由守护测试锁定一致。
   */
  planCreditFormula?: "none";
  notes?: string;
}

/** Profile 计算器声明：kind 决定公式族，其余字段按 kind 消费。 */
export interface PlanProfileCalculator {
  kind: "token_weighted" | "afp_weighted" | "money_to_credits" | "market_share";
  divisor?: number;
  unit?: string;
  currency?: ProviderCatalogCurrency;
  /** money_to_credits 专用：每 1 原币 = 多少积分。 */
  creditsPerCurrency?: number;
  /** 缓存读进入公式的方式：separate=独立系数（智谱）、input=按输入系数（火山）。 */
  cacheRead?: "separate" | "input";
}

/** MCP 工具按次计积分（第一期仅契约校验与展示，运行时消费属第二期）。 */
export interface PlanProfileToolFactor {
  id: string;
  mode: "output_factor" | "fixed";
  perCall?: number;
  notes?: string;
}

/** 峰谷/窗口的节假日标志：编译期经 calendarRef 解析为具体日期集合（设计 4.4）。 */
export interface HolidayScope {
  excludeHolidays?: boolean;
  includeHolidays?: boolean;
}

/** Profile 高峰窗口：窗口内按 multiplier 抵扣，未命中按 offPeakMultiplier。 */
export interface PlanProfilePeakWindow {
  days?: number[];
  start: string;
  end: string;
  multiplier?: number;
  excludeHolidays?: boolean;
  includeHolidays?: boolean;
}

/** 供应商级套餐计费规则容器（设计 4.4）：所有使用该公式的模型共享。 */
export interface ProviderPlanProfile {
  calculator: PlanProfileCalculator;
  currency?: ProviderCatalogCurrency;
  timezone?: string;
  peakWindows?: PlanProfilePeakWindow[];
  offPeakMultiplier?: number;
  quotaWindows?: PlanCreditQuotaWindow[];
  quotaTiers?: Record<string, {quotaByWindow: Record<string, number>; notes?: string}>;
  toolFactors?: PlanProfileToolFactor[];
  unverified?: boolean;
  notes?: string;
}

/** 比例值：数字或分数对象；编译期统一规范化为数值（numerator/denominator）。 */
export type CampaignRatio = number | {numerator: number; denominator: number};

/** Campaign 效果（有限 DSL，设计 4.5/4.6）。第一期只启用前四种；其余为契约前向定义、加载即隔离。 */
export type CampaignEffect =
  | {kind: "priceOverride"; rates: SparsePricingRates}
  | {kind: "factorOverride"; factors: {input?: number; output?: number; cachedInput?: number}}
  | {kind: "creditMultiplier"; value: CampaignRatio}
  | {kind: "freeWindow"}
  | {kind: "priceMultiplier"; value: CampaignRatio}
  | {kind: "quotaMultiplier"; value: CampaignRatio}
  | {kind: "quotaAdd"; value: number}
  | {kind: "fixedToolCredit"; perCall: number}
  | {kind: "cap"; value: number};

/** Campaign 每日时间窗：左闭右开，跨午夜必须拆段；时区缺省继承 Profile/Provider。 */
export interface CampaignRecurringWindow {
  timezone?: string;
  days?: number[];
  start: string;
  end: string;
  excludeHolidays?: boolean;
  includeHolidays?: boolean;
}

/** 供应商级独立活动实体（设计 4.5）。period 左闭右开：from 含、to 不含。 */
export interface CatalogCampaign {
  id: string;
  channel: CampaignChannel;
  profileRef?: string;
  scope?: {
    models?: string[];
    modelGroups?: string[];
    agents?: string[];
    agentGroups?: string[];
    planTiers?: string[];
    regions?: string[];
    serviceTiers?: string[];
    /**
     * 观测通道限定（2026-09-15 双链路观测）：声明后活动只在对应通道的账本命中。
     * 语义：官方客户端专属活动（如 ZCode 登录折扣，凭客户端签名认定）只在
     * agent_local_import 生效——经网关的流量官方不认定为官方客户端。
     * 缺省 = 全通道生效（存量活动行为不变）。
     */
    origins?: string[];
  };
  period: {from: string; to?: string};
  recurringWindows?: CampaignRecurringWindow[];
  effect: CampaignEffect;
  priority?: number;
  stackingPolicy?: "exclusive" | "multiply" | "override";
  label?: string;
  unverified?: boolean;
  note?: string;
}

/** 目录级时段费率：窗口可携带节假日标志（编译期解析为日期集合）。 */
export interface CatalogScheduleWindow {
  days?: number[];
  start: string;
  end: string;
  excludeHolidays?: boolean;
  includeHolidays?: boolean;
}

export interface CatalogPriceSchedule {
  timezone?: string;
  label: string;
  windows: CatalogScheduleWindow[];
  rates: PricingRates;
  /** v1 行内节假日兼容读取（v2 目录不产出，改用 calendarRef + includeHolidays；编译投影透传）。 */
  holidays?: string[];
}

/**
 * 价格时间线段（终极方案 2026-09-10）：官方调价按时间区间维护，同一时间唯一价格。
 * 段是完整价格快照（缺失字段=该段无此配置）；`effectiveFrom` 为 RFC 3339 带时区的官方
 * 生效时刻，首段缺省=历史现状；`changeNote` 为面向用户的公告式摘要文案（通知与 UI 顶部展示）。
 */
export interface CatalogRateSegment {
  effectiveFrom?: string;
  pricing: PricingRates;
  priceSchedules?: CatalogPriceSchedule[];
  serviceTierPricing?: ServiceTierPricing;
  planFactors?: PlanCreditModelFactor;
  changeNote?: string;
}

/** 套餐档位（设计 4.4）：monthlyFee 固定为连续包月折算月价；billingCycles 为可选的周期折算月价。 */
export interface ProviderPlanTier {
  id?: string;
  name: string;
  monthlyFee: number;
  billingCycles?: {monthly: number; quarterly?: number; yearly?: number};
  /** 每订阅期套餐积分/Credits 总量（2026-09-30 百炼 Credits 月度制）；展示与对账参考，不参与月费回填。 */
  credits?: number;
  /** 限时价原价（如百炼 Lite ¥60 限时 ¥39）；monthlyFee 记当前实际生效价。 */
  originalMonthlyFee?: number;
}

/** 项目维护的单个模型目录项（v2）：套餐规则经 planProfileRef 引用供应商级 Profile。 */
export interface ProviderCatalogModel {
  id: string;
  category: ProviderCatalogModelCategory;
  contextWindowK?: number;
  maxOutputK?: number;
  supportedWireApis?: ProviderCatalogWireApi[];
  /**
   * 输入模态（2026-09-21 能力下发）：供应商 × 模型 层面的官方事实，随目录下发；
   * 价格中心投影后经共享解析层供各 Agent CLI 配置与开发启动弹窗消费。
   * 缺省 = ["text"]（保守）；空数组视为未声明。
   */
  inputModalities?: ProviderCatalogInputModality[];
  /**
   * 价格时间线（终极方案）：官方调价按时间区间维护；声明后为唯一价格真相，
   * 顶层 pricing/priceSchedules/serviceTierPricing/planFactors 由最后一段自动填充
   * （维护者不得再单独声明顶层价格字段）。缺省 = 单段现状（顶层字段直接维护）。
   */
  rateTimeline?: CatalogRateSegment[];
  /** 官方牌价（=时间线最后一段快照；单段模型直接维护）。 */
  pricing?: PricingRates;
  /** 非 Token 计费能力的显式单位/价格；缺 usage 字段时消费端必须标记 unavailable。 */
  usageSchema?: ProviderCatalogUsageSchema;
  serviceTierPricing?: ServiceTierPricing;
  /** 时段费率：base 保持基础价（高峰），窗口内使用 rates；窗口节假日标志编译期解析。 */
  priceSchedules?: CatalogPriceSchedule[];
  /** 引用供应商 planProfiles 的键；套餐通道模型使用。 */
  planProfileRef?: string;
  /** 该模型相对 Profile 的稳定系数差异；临时系数变更必须使用 Campaign。 */
  planFactors?: PlanCreditModelFactor;
  /**
   * market_share 专用：档位 id → 模型月度额度（USD，profile calculator.unit 必须为 USD）。
   * 上游 usage 只回 percent 无绝对额度（OpenCode Go），额度经目录外挂；档位由用户在
   * 套餐同步配置显式选择（上游接口不返回档位标识）。估算 = 市价 × 月费 ÷ 所选档位月度额度。
   */
  planMonthlyLimitUsd?: Record<string, number>;
  /** 套餐公式计费模型重定向（与请求匹配 aliases 分离，设计 4.3）。 */
  planAliases?: Record<string, string>;
  aliases?: string[];
  sourceUrl?: string;
  notes?: string;
}

/** 供应商变体；中国区与国际区使用不同 pricingProviderId，避免按币种复制模型。 */
export interface ProviderCatalogProvider {
  name: string;
  brandId: string;
  pricingProviderId: string;
  region: ProviderCatalogRegion;
  category: ProviderCatalogCategory;
  currency?: ProviderCatalogCurrency;
  /** 供应商族（如 kimi、zhipu、volcengine）；UI 分组与统计归集。 */
  vendorFamily?: string;
  /** 供应商支持的计费通道；presets[].billingChannel 必须落在集合内。 */
  supportedBillingChannels?: CatalogBillingChannel[];
  /** PAYG 活动缺省时区（无窗口活动不需要）。 */
  defaultTimezone?: string;
  /** 引用元信息公共日历的键；峰谷/闲时/活动窗口消费节假日语义。 */
  calendarRef?: string;
  openaiUrl?: string;
  anthropicUrl?: string;
  planTiers?: ProviderPlanTier[];
  presets?: ProviderCatalogPreset[];
  planProfiles?: Record<string, ProviderPlanProfile>;
  campaigns?: CatalogCampaign[];
  models: ProviderCatalogModel[];
}

export interface ProviderCatalog {
  schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  /** 目录发布版本号 YYYY.MM.DD.NN（字典序可比较）。 */
  catalogRevision: string;
  /** RFC 3339 且必须带时区（v2 正式格式）。 */
  publishedAt: string;
  providers: Record<string, ProviderCatalogProvider>;
  /** 汇率快照（可选）：随目录发布更新；展示层拉平基准。 */
  fx?: {rates: Record<string, number>; asOf?: string; source?: string};
  /** 公共日历字典：供应商经 calendarRef 引用。 */
  calendars?: Record<string, ProviderCatalogCalendar>;
}

/**
 * 目录来源。`override` 为维护测试专用：由环境变量 DEEPAA_CATALOG_PATH 指定的
 * 本地草稿文件，绝不联网、不写缓存，仅官方目录维护人员使用。
 */
export type ProviderCatalogSourceKind = "remote" | "file-cache" | "bundled" | "preset-fallback" | "override";

export interface ProviderCatalogEnvelope {
  catalog: ProviderCatalog;
  source: ProviderCatalogSourceKind;
  fetchedAt: string;
  sourceHash: string;
  /** v2 编译期诊断（隔离的活动/档位/预设等维护告警；不阻断加载）。 */
  diagnostics?: CatalogDiagnostic[];
  warning?: string;
}

export interface ProviderCatalogCacheFile {
  version: 2;
  fetchedAt: string;
  sourceHash: string;
  catalog: ProviderCatalog;
  diagnostics?: CatalogDiagnostic[];
}
