/**
 * 目录 v2 编译器（设计 5.1/〇 分期总览）：parse 后的合法目录 → 价格中心条目投影 + 诊断。
 * 第一期编译器唯一产物即「条目投影 + 诊断码」（不引入独立 IR 层）：
 * - payg Campaign（第一期仅 priceOverride）投影为现有 entry.promotions；
 * - Plan Profile + modelFactors + Plan Campaign（creditMultiplier/factorOverride/freeWindow）
 *   投影为现有 entry.planCreditRules（campaign-matcher 合成语义由 plan-credit 消费）；
 * - 节假日标志（includeHolidays/excludeHolidays）编译期解析为具体日期集合，运行时不回读目录元信息；
 * - 无 Profile 的套餐通道 = crediting unavailable（条目无 planCreditRules，账本不折算积分）；
 * - Campaign period 左闭右开（to 不含）投影为现有含端点语义（to - 1ms）。
 */
import type {
  PaygPromotion,
  PlanCreditPromotion,
  PlanCreditRules,
  PricingRates,
  ServiceTierPricing,
  TemporalPriceSchedule,
} from "@/lib/pricing";
import type {ModelPriceEntry} from "@/lib/pricing";
import type {CatalogCampaign, CatalogPriceSchedule, ProviderCatalog, ProviderCatalogProvider, ProviderCatalogModel, ProviderPlanProfile} from "./types";
import {catalogDiagnostic, type CatalogDiagnostic} from "./diagnostics";
import {calculatorFormulaFor} from "./calculator-registry";
import {validateProviderBilling} from "./static-validator";
import {resolveCampaignRatio} from "./rule-dsl";

export interface CompiledProviderCatalog {
  /** 编译产出的价格中心条目（含投影后的 promotions/planCreditRules/rateTimeline/supportedWireApis）。 */
  entries: ModelPriceEntry[];
  /** 编译期维护诊断（静态校验隔离 + 投影期告警）。 */
  diagnostics: CatalogDiagnostic[];
  /** 本批时间线中最早的官方生效时刻（revision effective_at 回填用；无时间线段时 undefined）。 */
  earliestEffectiveFrom?: string;
}

export interface CompileOptions {
  /** 加载器计算的源哈希（sha256:<hex>）；缺省条目不携带 catalogSourceHash。 */
  sourceHash?: string;
}

const PROVIDER_CATALOG_URL_FALLBACK = "https://deepaa.dev/data/defaults/llm_catalog.jsonl";

/** 编译目录：静态校验（隔离非法活动/档位/Profile）→ 节假日解析 → 逐模型条目投影。 */
export function compileProviderCatalog(catalog: ProviderCatalog, options: CompileOptions = {}): CompiledProviderCatalog {
  const diagnostics: CatalogDiagnostic[] = [];
  const entries: ModelPriceEntry[] = [];
  const effectiveFroms: string[] = [];

  for (const [catalogKey, provider] of Object.entries(catalog.providers)) {
    const validation = validateProviderBilling(catalogKey, provider, catalog.calendars ?? {});
    diagnostics.push(...validation.diagnostics);
    const holidayDates = provider.calendarRef ? catalog.calendars?.[provider.calendarRef]?.dates : undefined;
    if (provider.calendarRef && !holidayDates) {
      diagnostics.push(catalogDiagnostic("CALENDAR_NOT_FOUND", "provider",
        `calendarRef 引用的公共日历不存在: ${String(provider.calendarRef)}`, {target: catalogKey}));
    }

    for (const model of provider.models) {
      if (!model.pricing) continue;
      entries.push(projectModelEntry(catalog, catalogKey, provider, model, {
        campaigns: validation.campaigns,
        planProfiles: validation.planProfiles ?? {},
        holidayDates,
        diagnostics,
        sourceHash: options.sourceHash,
      }));
      for (const segment of model.rateTimeline ?? []) {
        if (segment.effectiveFrom) effectiveFroms.push(segment.effectiveFrom);
      }
    }
  }

  entries.sort((left, right) => left.id.localeCompare(right.id));
  return {
    entries,
    diagnostics,
    ...(effectiveFroms.length > 0 ? {earliestEffectiveFrom: effectiveFroms.sort()[0]} : {}),
  };
}

/** 按供应商取编译投影（modelId → 条目）；供应商管理页 diff/review 消费。 */
export function compileProviderModelEntries(catalog: ProviderCatalog, catalogKey: string): Map<string, ModelPriceEntry> {
  const provider = catalog.providers[catalogKey];
  const result = new Map<string, ModelPriceEntry>();
  if (!provider) return result;
  const compiled = compileProviderCatalog(catalog);
  for (const entry of compiled.entries) {
    if (entry.vendor === provider.pricingProviderId && entry.runtimeModelId) {
      result.set(entry.runtimeModelId, entry);
    }
  }
  return result;
}

interface ProjectionContext {
  campaigns: CatalogCampaign[];
  planProfiles: Record<string, ProviderPlanProfile>;
  holidayDates?: string[];
  diagnostics: CatalogDiagnostic[];
  sourceHash?: string;
}

function projectModelEntry(
  catalog: ProviderCatalog,
  catalogKey: string,
  provider: ProviderCatalogProvider,
  model: ProviderCatalogModel,
  context: ProjectionContext,
): ModelPriceEntry {
  const paygPromotions = projectPaygCampaigns(provider, model, context);
  const planCreditRules = projectPlanRules(provider, model, context);
  return {
    id: `catalog:${provider.pricingProviderId}:${model.id}`,
    vendor: provider.pricingProviderId,
    runtimeModelId: model.id,
    match: model.id,
    patterns: [model.id],
    aliases: model.aliases,
    mode: model.category,
    contextWindow: model.contextWindowK === undefined ? undefined : model.contextWindowK * 1_024,
    maxOutput: model.maxOutputK === undefined ? undefined : model.maxOutputK * 1_024,
    pricingProviderId: provider.pricingProviderId,
    region: provider.region,
    catalogSource: "catalog",
    pricing: model.pricing,
    ...(model.usageSchema ? {usageSchema: model.usageSchema} : {}),
    serviceTierPricing: model.serviceTierPricing,
    ...(paygPromotions.length > 0 ? {promotions: paygPromotions} : {}),
    priceSchedules: projectSchedules(model.priceSchedules, context.holidayDates),
    ...(planCreditRules ? {planCreditRules} : {}),
    currency: provider.currency === "CNY" ? "CNY" : "USD",
    confidence: "official",
    sourceUrl: model.sourceUrl || PROVIDER_CATALOG_URL_FALLBACK,
    sourceCheckedAt: catalog.publishedAt,
    catalogRevision: catalog.catalogRevision,
    ...(context.sourceHash ? {catalogSourceHash: context.sourceHash} : {}),
    ...(model.rateTimeline?.length
      ? {rateTimeline: model.rateTimeline.map(segment => ({
          ...(segment.effectiveFrom !== undefined ? {effectiveFrom: segment.effectiveFrom} : {}),
          pricing: segment.pricing,
          ...(segment.priceSchedules !== undefined ? {priceSchedules: projectSchedules(segment.priceSchedules, context.holidayDates) ?? []} : {}),
          ...(segment.serviceTierPricing !== undefined ? {serviceTierPricing: segment.serviceTierPricing} : {}),
          ...(segment.planFactors !== undefined ? {planFactors: segment.planFactors} : {}),
          ...(segment.changeNote !== undefined ? {changeNote: segment.changeNote} : {}),
        }))}
      : {}),
    ...(model.supportedWireApis?.length ? {supportedWireApis: [...model.supportedWireApis]} : {}),
    // 输入模态投影（2026-09-21 能力下发）：价格中心为模型能力唯一真源，消费端经共享解析层读取。
    ...(model.inputModalities?.length ? {inputModalities: [...model.inputModalities]} : {}),
    notes: [
      `项目供应商目录 ${catalogKey}；价格按供应商官方原始币种原始数值保存。`,
      paygPromotions.length > 0 ? "promotions 为目录 v2 payg Campaign 编译投影（官方通道实扣口径，中转站按牌价）。" : undefined,
      planCreditRules ? "planCreditRules 为目录 v2 Profile/Campaign 编译投影。" : undefined,
      model.rateTimeline?.length ? "rateTimeline 为官方价格时间线（按请求时间选段计费）。" : undefined,
      model.notes,
    ].filter(Boolean).join(" "),
  };
}

/** payg Campaign（第一期仅 priceOverride，priority 降序）→ 现有 PaygPromotion 投影。
 *  投影省略 models 字段：条目本身即活动作用域（与 v1 存量促销的 diff 键对齐，减少迁移噪音）。 */
function projectPaygCampaigns(
  provider: ProviderCatalogProvider,
  model: ProviderCatalogModel,
  context: ProjectionContext,
): PaygPromotion[] {
  const promotions: PaygPromotion[] = [];
  for (const campaign of context.campaigns) {
    if (campaign.channel !== "payg" || campaign.effect.kind !== "priceOverride") continue;
    if (campaign.scope?.models?.length && !campaign.scope.models.includes(model.id)) continue;
    promotions.push({
      from: campaign.period.from,
      ...(campaign.period.to !== undefined ? {to: toInclusive(campaign.period.to)} : {}),
      ...(campaign.scope?.agents?.length ? {agents: [...campaign.scope.agents]} : {}),
      ...(campaign.label ? {label: campaign.label} : {}),
      priceOverride: campaign.effect.rates,
      ...(campaign.note ? {note: campaign.note} : {}),
    });
  }
  return promotions;
}

/** Plan Profile + modelFactors + Plan Campaign → 现有 PlanCreditRules 投影。 */
function projectPlanRules(
  provider: ProviderCatalogProvider,
  model: ProviderCatalogModel,
  context: ProjectionContext,
): PlanCreditRules | undefined {
  const profileId = model.planProfileRef;
  if (!profileId) return undefined;
  const profile = context.planProfiles[profileId];
  if (!profile) {
    context.diagnostics.push(catalogDiagnostic("PROFILE_NOT_FOUND", "provider",
      `模型 ${model.id} 引用的 Profile 不存在或已隔离: ${profileId}（该模型套餐积分不可折算）`));
    return undefined;
  }
  const formula = calculatorFormulaFor(profile);
  if (!formula) return undefined;
  const calculator = profile.calculator;
  /* market_share（OpenCode Go）：无逐请求积分公式——规则只承载「模型×档位月度美元额度」
     供估算分母解析（quotaTiers.quotaByWindow.monthly + 档位月费）；缺额度整条不投影，
     运行时按 market_blocked 诚实降级。不投影 campaigns/promotions（积分倍率语义不适用）。 */
  if (calculator.kind === "market_share") {
    const limits = model.planMonthlyLimitUsd;
    if (!limits) {
      context.diagnostics.push(catalogDiagnostic("MARKET_SHARE_LIMITS_MISSING", "provider",
        `模型 ${model.id} 引用 market_share Profile 但缺 planMonthlyLimitUsd（估算分母不可解析）`,
        {target: model.id}));
      return undefined;
    }
    const quotaTiers: NonNullable<PlanCreditRules["quotaTiers"]> = {};
    for (const [tierId, limit] of Object.entries(limits)) {
      const tier = provider.planTiers?.find(item => item.id === tierId);
      quotaTiers[tierId] = {
        quotaByWindow: {monthly: limit},
        ...(tier ? {monthlyFee: tier.monthlyFee} : {}),
      };
    }
    return {
      formula,
      profileId,
      ...(calculator.unit !== undefined ? {unit: calculator.unit} : {}),
      ...(calculator.currency ?? profile.currency ? {currency: (calculator.currency ?? profile.currency) as "CNY" | "USD"} : {}),
      quotaTiers,
      quotaWindows: profile.quotaWindows?.length
        ? profile.quotaWindows
        : [{id: "monthly", label: "每月", reset: "monthly"}],
      ...(profile.notes ? {notes: profile.notes} : {}),
    };
  }
  const promotions = projectPlanCampaigns(provider, model, profile.timezone, context);
  return {
    formula,
    profileId,
    ...(calculator.unit !== undefined ? {unit: calculator.unit} : {}),
    ...(calculator.currency ?? profile.currency ? {currency: (calculator.currency ?? profile.currency) as "CNY" | "USD"} : {}),
    ...(calculator.kind === "money_to_credits" && calculator.creditsPerCurrency !== undefined
      ? {creditsPerCurrency: calculator.creditsPerCurrency}
      : {}),
    ...(calculator.divisor !== undefined ? {divisor: calculator.divisor} : {}),
    ...(model.planFactors ? {modelFactors: {[model.id]: model.planFactors}} : {}),
    ...(profile.peakWindows?.length
      ? {peakWindows: profile.peakWindows.map(window => ({
          ...(window.days?.length ? {days: [...window.days]} : {}),
          start: window.start,
          end: window.end,
          multiplier: window.multiplier ?? 1,
          ...(window.excludeHolidays && context.holidayDates ? {excludeDates: context.holidayDates} : {}),
          ...(window.includeHolidays && context.holidayDates ? {includeDates: context.holidayDates} : {}),
        }))}
      : {}),
    ...(profile.timezone ? {timezone: profile.timezone} : {}),
    ...(profile.offPeakMultiplier !== undefined ? {offPeakMultiplier: profile.offPeakMultiplier} : {}),
    ...(model.planAliases ? {aliases: model.planAliases} : {}),
    ...(promotions.length > 0 ? {promotions} : {}),
    ...(profile.quotaTiers ? {quotaTiers: profile.quotaTiers} : {}),
    ...(profile.toolFactors?.length
      ? {toolFactors: profile.toolFactors.map(factor => ({
          id: factor.id,
          ...(factor.mode === "fixed" && factor.perCall !== undefined ? {perCall: factor.perCall} : {}),
          notes: [
            factor.notes,
            factor.mode === "output_factor"
              ? "output_factor 模式：消耗积分=调用次数×Output 抵扣系数（运行时消费属第二期）"
              : undefined,
          ].filter(Boolean).join("；") || undefined,
        }))}
      : {}),
    quotaWindows: profile.quotaWindows?.length
      ? profile.quotaWindows
      : [{id: "weekly", label: "每周", reset: "weekly"}],
    ...(profile.unverified ? {unverified: true} : {}),
    ...(profile.notes ? {notes: profile.notes} : {}),
  };
}

/** Plan Campaign（creditMultiplier/factorOverride/freeWindow）→ PlanCreditPromotion 投影。 */
function projectPlanCampaigns(
  provider: ProviderCatalogProvider,
  model: ProviderCatalogModel,
  profileTimezone: string | undefined,
  context: ProjectionContext,
): PlanCreditPromotion[] {
  const promotions: PlanCreditPromotion[] = [];
  for (const campaign of context.campaigns) {
    if (campaign.channel !== "plan") continue;
    if (campaign.scope?.models?.length && !campaign.scope.models.includes(model.id)) continue;
    const base = {
      from: campaign.period.from,
      ...(campaign.period.to !== undefined ? {to: toInclusive(campaign.period.to)} : {}),
      models: [model.id],
      ...(campaign.scope?.agents?.length ? {agents: [...campaign.scope.agents]} : {}),
      // 观测通道限定（双链路观测）：官方客户端专属活动投影 origins，运行时按通道命中。
      ...(campaign.scope?.origins?.length ? {origins: [...campaign.scope.origins]} : {}),
      ...(campaign.recurringWindows?.length
        ? {windows: campaign.recurringWindows.map(window => ({
            ...(window.days?.length ? {days: [...window.days]} : {}),
            start: window.start,
            end: window.end,
            ...(window.timezone ? {timezone: window.timezone} : {}),
            ...(window.excludeHolidays && context.holidayDates ? {excludeDates: context.holidayDates} : {}),
            ...(window.includeHolidays && context.holidayDates ? {includeDates: context.holidayDates} : {}),
          }))}
        : {}),
      ...(campaign.priority !== undefined ? {priority: campaign.priority} : {}),
      ...(campaign.label ? {label: campaign.label} : {}),
      ...(campaign.unverified ? {unverified: true} : {}),
      ...(campaign.note ? {note: campaign.note} : {}),
      // 每日窗口未显式声明时区时沿用 Profile 时区（静态校验已保证可继承）。
      ...(campaign.recurringWindows?.length && !campaign.recurringWindows.some(window => window.timezone) && profileTimezone
        ? {timezone: profileTimezone}
        : {}),
    };
    switch (campaign.effect.kind) {
      case "creditMultiplier":
        promotions.push({...base, multiplier: resolveCampaignRatio(campaign.effect.value, `campaign ${campaign.id} value`)});
        continue;
      case "factorOverride": {
        const factors = campaign.effect.factors;
        promotions.push({
          ...base,
          ...(factors.input !== undefined ? {input: factors.input} : {}),
          ...(factors.output !== undefined ? {output: factors.output} : {}),
          ...(factors.cachedInput !== undefined ? {cachedInput: factors.cachedInput} : {}),
        });
        continue;
      }
      case "freeWindow":
        promotions.push({...base, multiplier: 0});
        continue;
      default:
        continue;
    }
  }
  return promotions;
}

/** 目录 v2 时段费率 → 现有 TemporalPriceSchedule（节假日标志解析为日期集合）。 */
function projectSchedules(
  schedules: CatalogPriceSchedule[] | undefined,
  contextHolidayDates: string[] | undefined,
): TemporalPriceSchedule[] | undefined {
  if (!schedules?.length) return undefined;
  return schedules.map(schedule => {
    // includeHolidays（任意窗口声明）→ schedule 级节假日强制命中（沿用现有 holidays 语义）；
    // excludeHolidays → 窗口级排除日期；v1 行内 holidays 兼容透传。
    const includeAny = schedule.windows.some(window => window.includeHolidays);
    const holidayDates = schedule.holidays ?? contextHolidayDates;
    return {
      ...(schedule.timezone ? {timezone: schedule.timezone} : {}),
      label: schedule.label,
      windows: schedule.windows.map(window => ({
        ...(window.days?.length ? {days: [...window.days]} : {}),
        start: window.start,
        end: window.end,
        ...(window.excludeHolidays && holidayDates ? {excludeDates: holidayDates} : {}),
      })),
      rates: schedule.rates,
      ...(includeAny && holidayDates ? {holidays: holidayDates} : {}),
      ...(schedule.holidays ? {holidays: schedule.holidays} : {}),
    };
  });
}

/** v2 左闭右开 period.to（不含端点）→ 现有含端点语义：回退 1ms。 */
function toInclusive(to: string): string {
  const time = Date.parse(to);
  if (!Number.isFinite(time)) return to;
  return new Date(time - 1).toISOString();
}

/** 编译投影的类型辅助（pricing 侧 SparsePricingRates 与 PricingRates 结构兼容）。 */
export type {PricingRates, ServiceTierPricing};
