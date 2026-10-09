import type {
  CatalogBillingChannel,
  CatalogCampaign,
  CatalogPriceSchedule,
  CatalogRateSegment,
  CatalogScheduleWindow,
  CampaignChannel,
  CampaignEffect,
  ProviderCatalog,
  ProviderCatalogCategory,
  ProviderCatalogCurrency,
  ProviderCatalogInputModality,
  ProviderCatalogModel,
  ProviderCatalogModelCategory,
  ProviderCatalogPreset,
  ProviderCatalogProvider,
  ProviderCatalogRegion,
  ProviderCatalogUsageSchema,
  ProviderCatalogUsageUnit,
  ProviderCatalogWireApi,
  ProviderPlanProfile,
  ProviderPlanTier,
} from "./types";
import {PROVIDER_CATALOG_SCHEMA_VERSION} from "./types";
import type {
  LongContextPricingTier,
  PaygPromotion,
  PlanCreditModelFactor,
  PlanCreditQuotaWindow,
  PricingRates,
  ServiceTierPricing,
  SparsePricingRates,
} from "@/lib/pricing";
import {catalogDiagnostic, type CatalogDiagnostic} from "./diagnostics";
import {isValidCatalogRevision, isValidRfc3339WithZone, validateCatalogCalendars} from "./catalog-contract";
import {resolveCampaignRatio} from "./rule-dsl";

export const MAX_PROVIDER_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDERS = 128;
const MAX_MODELS_PER_PROVIDER = 2_000;
const MAX_STRING_LENGTH = 4_096;
const MAX_CATALOG_LINES = 2_000;
const MAX_CATALOG_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_TIERS = 32;
const MAX_CAMPAIGNS_PER_PROVIDER = 64;
const MAX_PROFILES_PER_PROVIDER = 16;
const MAX_PRESETS_PER_PROVIDER = 8;
const PROVIDER_REGIONS = new Set<ProviderCatalogRegion>(["cn", "global"]);
const PROVIDER_CATEGORIES = new Set<ProviderCatalogCategory>([
  "cn_official",
  "global_official",
  "official",
  "aggregator",
]);
const MODEL_CATEGORIES = new Set<ProviderCatalogModelCategory>([
  "chat",
  "embedding",
  "rerank",
  "image",
  "audio",
  "video",
]);
const WIRE_APIS = new Set<ProviderCatalogWireApi>(["chat_completions", "responses", "messages"]);
const INPUT_MODALITIES = new Set<ProviderCatalogInputModality>(["text", "image", "audio"]);
const USAGE_UNITS = new Set<ProviderCatalogUsageUnit>(["token", "second", "character", "image", "request"]);
const CATALOG_CURRENCIES = new Set<ProviderCatalogCurrency>(["CNY", "USD"]);
const BILLING_CHANNELS = new Set<CatalogBillingChannel>(["pay_as_you_go", "plan", "subscription"]);
const CAMPAIGN_CHANNELS = new Set<CampaignChannel>(["payg", "plan", "subscription"]);
const CALCULATOR_KINDS = new Set(["token_weighted", "afp_weighted", "money_to_credits", "market_share"] as const);
const KNOWN_SCOPE_KEYS = ["models", "modelGroups", "agents", "agentGroups", "planTiers", "regions", "serviceTiers", "origins"] as const;

/** 观测通道限定合法值（双链路观测，2026-09-15）；未知通道抛出隔离。 */
const KNOWN_ORIGIN_VALUES = ["gateway", "agent_local_import"] as const;
const KNOWN_EFFECT_KINDS = new Set([
  "priceOverride", "factorOverride", "creditMultiplier", "freeWindow",
  "priceMultiplier", "quotaMultiplier", "quotaAdd", "fixedToolCredit", "cap",
] as const);

/** 解析结果：目录 + 编译前隔离诊断（5.2：活动/Profile/预设级隔离，整目录级错误仍抛出）。 */
export interface ParsedProviderCatalog {
  catalog: ProviderCatalog;
  diagnostics: CatalogDiagnostic[];
}

/**
 * 解析 JSONL 格式的供应商模型目录（v2 契约，2026-09-10 第一期）：
 * - 首条数据行是元信息：{schemaVersion: 2, catalogRevision, publishedAt, fx?, calendars?}；
 * - 之后每条数据行是一个供应商（含 catalogKey）；
 * - 支持整行注释（// 或 #）与空行；行尾注释不支持。
 * 整目录级错误（schemaVersion 不支持、元信息非法、重复 catalogKey、模型结构非法）抛出，
 * 由调用方隔离整份目录并回退；活动/Profile/预设级错误以诊断隔离，不阻断其余内容。
 */
export function parseProviderCatalogText(text: string): ParsedProviderCatalog {
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_CATALOG_BYTES) {
    throw new Error("供应商模型目录超过 8 MiB 上限");
  }
  const dataLines: Array<{lineNumber: number; text: string}> = [];
  const rawLines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (rawLines.length > MAX_CATALOG_LINES) {
    throw new Error(`供应商模型目录超过 ${MAX_CATALOG_LINES} 行上限`);
  }
  for (let index = 0; index < rawLines.length; index += 1) {
    const trimmed = rawLines[index]!.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    if (Buffer.byteLength(trimmed, "utf8") > MAX_CATALOG_LINE_BYTES) {
      throw new Error(`供应商模型目录第 ${index + 1} 行超过单行上限`);
    }
    dataLines.push({lineNumber: index + 1, text: trimmed});
  }
  if (dataLines.length === 0) throw new Error("供应商模型目录没有数据行");

  const metaLine = dataLines[0]!;
  const meta = parseCatalogJsonLine(metaLine);
  if (meta.schemaVersion !== PROVIDER_CATALOG_SCHEMA_VERSION) {
    throw new Error(`CATALOG_SCHEMA_UNSUPPORTED：目录 schemaVersion=${String(meta.schemaVersion)}，本版本只支持 ${PROVIDER_CATALOG_SCHEMA_VERSION}`);
  }
  if (!isValidCatalogRevision(meta.catalogRevision)) {
    throw new Error("CATALOG_META_INVALID：catalogRevision 必须是 YYYY.MM.DD.NN 固定宽度格式");
  }
  if (!isValidRfc3339WithZone(meta.publishedAt)) {
    throw new Error("CATALOG_META_INVALID：publishedAt 必须是带时区的 RFC 3339 时刻");
  }
  const metaFx = normalizeCatalogFx(meta.fx);
  const calendars = normalizeCatalogCalendars(meta.calendars);

  const diagnostics: CatalogDiagnostic[] = [];
  const providers: Record<string, unknown> = {};
  for (let index = 1; index < dataLines.length; index += 1) {
    const entry = parseCatalogJsonLine(dataLines[index]!);
    const catalogKey = entry.catalogKey;
    if (typeof catalogKey !== "string" || !catalogKey.trim()) {
      throw new Error(`供应商模型目录第 ${dataLines[index]!.lineNumber} 行缺少 catalogKey`);
    }
    const {catalogKey: _ignored, ...provider} = entry;
    if (providers[catalogKey.trim()] !== undefined) {
      throw new Error(`供应商模型目录存在重复 catalogKey：${catalogKey.trim()}`);
    }
    providers[catalogKey.trim()] = provider;
  }
  const normalized = normalizeProviderCatalog({
    schemaVersion: meta.schemaVersion,
    catalogRevision: meta.catalogRevision,
    publishedAt: meta.publishedAt,
    providers,
    ...(metaFx ? {fx: metaFx} : {}),
    ...(calendars ? {calendars} : {}),
  });
  return {catalog: normalized.catalog, diagnostics: [...diagnostics, ...normalized.diagnostics]};
}

function parseCatalogJsonLine(line: {lineNumber: number; text: string}): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.text);
  } catch (cause) {
    throw new Error(`供应商模型目录第 ${line.lineNumber} 行不是合法 JSON`, {cause});
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`供应商模型目录第 ${line.lineNumber} 行必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

/** 目录元信息行汇率快照校验：键为 BASE/QUOTE，值为正有限数。 */
function normalizeCatalogFx(value: unknown): ProviderCatalog["fx"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("供应商模型目录 fx 必须是对象（rates/asOf/source）");
  }
  const raw = value as {rates?: unknown; asOf?: unknown; source?: unknown};
  if (!raw.rates || typeof raw.rates !== "object" || Array.isArray(raw.rates)) {
    throw new Error("供应商模型目录 fx.rates 必须是对象");
  }
  const rates: Record<string, number> = {};
  for (const [pair, rate] of Object.entries(raw.rates as Record<string, unknown>)) {
    if (!/^[A-Z]{3}\/[A-Z]{3}$/u.test(pair)) {
      throw new Error(`供应商模型目录 fx 汇率键格式错误：${pair}`);
    }
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`供应商模型目录 fx 汇率值非法：${pair}`);
    }
    rates[pair] = rate;
  }
  if (Object.keys(rates).length === 0) throw new Error("供应商模型目录 fx.rates 不能为空");
  return {
    rates,
    ...(typeof raw.asOf === "string" ? {asOf: raw.asOf} : {}),
    ...(typeof raw.source === "string" ? {source: raw.source} : {}),
  };
}

/** 公共日历结构校验；日期语义错误属元信息级（整目录隔离）。 */
function normalizeCatalogCalendars(value: unknown): ProviderCatalog["calendars"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CATALOG_META_INVALID：calendars 必须是对象");
  }
  const calendars: NonNullable<ProviderCatalog["calendars"]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    try {
      const item = objectValue(raw, `calendars.${key}`);
      const timezone = ianaTimezoneValue(item.timezone, `calendars.${key}.timezone`);
      const dates = arrayValue(item.dates, `calendars.${key}.dates`)
        .map((date, index) => stringValue(date, `calendars.${key}.dates[${index}]`));
      if (dates.length === 0 || dates.length > 730) {
        throw new Error(`calendars.${key}.dates 必须是 1-730 个日期`);
      }
      calendars[key] = {
        timezone,
        ...(typeof item.source === "string" && item.source.trim() ? {source: item.source.trim()} : {}),
        ...(typeof item.coverage === "string" && item.coverage.trim() ? {coverage: item.coverage.trim()} : {}),
        dates: [...new Set(dates)].sort(),
        ...(typeof item.notes === "string" && item.notes.trim() ? {notes: item.notes.trim()} : {}),
      };
    } catch (error) {
      throw new Error(`CATALOG_META_INVALID：${errorMessage(error)}`, {cause: error});
    }
  }
  const errors = validateCatalogCalendars(calendars);
  if (errors.length > 0) throw new Error(`CATALOG_META_INVALID：${errors.join("；")}`);
  return calendars;
}

/**
 * 深度校验所有已知字段（对象入口）：活动/Profile/预设级错误以诊断隔离并从目录剔除；
 * 供应商/模型级结构错误抛出（维护者拼写保护）。
 */
export function normalizeProviderCatalog(value: unknown): ParsedProviderCatalog {
  const root = objectValue(value, "供应商模型目录");
  if (root.schemaVersion !== PROVIDER_CATALOG_SCHEMA_VERSION) {
    throw new Error(`CATALOG_SCHEMA_UNSUPPORTED：schemaVersion=${String(root.schemaVersion)}`);
  }
  if (!isValidCatalogRevision(root.catalogRevision)) {
    throw new Error("CATALOG_META_INVALID：catalogRevision 必须是 YYYY.MM.DD.NN 格式");
  }
  const publishedAt = root.publishedAt;
  if (typeof publishedAt !== "string" || !isValidRfc3339WithZone(publishedAt)) {
    throw new Error("CATALOG_META_INVALID：publishedAt 必须是带时区的 RFC 3339 时刻");
  }
  const rawProviders = objectValue(root.providers, "providers");
  const fx = normalizeCatalogFx(root.fx);
  const calendars = normalizeCatalogCalendars(root.calendars);
  const entries = Object.entries(rawProviders);
  if (entries.length === 0 || entries.length > MAX_PROVIDERS) {
    throw new Error(`providers 数量必须在 1-${MAX_PROVIDERS} 之间`);
  }

  const diagnostics: CatalogDiagnostic[] = [];
  const providers: Record<string, ProviderCatalogProvider> = {};
  const pricingKeys = new Set<string>();
  for (const [catalogKey, rawProvider] of entries) {
    const normalizedKey = identifierValue(catalogKey, "providers key");
    const provider = normalizeProvider(rawProvider, normalizedKey, diagnostics);
    for (const model of provider.models) {
      const pricingKey = `${provider.pricingProviderId}\u0000${model.id}`;
      if (pricingKeys.has(pricingKey)) {
        throw new Error(`pricingProviderId + modelId 重复：${provider.pricingProviderId} + ${model.id}`);
      }
      pricingKeys.add(pricingKey);
    }
    providers[normalizedKey] = provider;
  }
  return {
    catalog: {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      catalogRevision: root.catalogRevision as string,
      publishedAt,
      providers,
      ...(fx ? {fx} : {}),
      ...(calendars ? {calendars} : {}),
    },
    diagnostics,
  };
}

/** 自动候选必须同时满足对话模型和可计价，避免无法映射的请求被默认为费用 0。 */
export function listAutomaticWhitelistCandidates(
  provider: ProviderCatalogProvider | undefined,
): ProviderCatalogModel[] {
  if (!provider) return [];
  return provider.models.filter(model => model.category === "chat" && model.pricing !== undefined);
}

function normalizeProvider(value: unknown, catalogKey: string, diagnostics: CatalogDiagnostic[]): ProviderCatalogProvider {
  const raw = objectValue(value, `providers.${catalogKey}`);
  const region = enumValue(raw.region, PROVIDER_REGIONS, `providers.${catalogKey}.region`);
  const category = enumValue(raw.category, PROVIDER_CATEGORIES, `providers.${catalogKey}.category`);
  const rawModels = arrayValue(raw.models, `providers.${catalogKey}.models`);
  if (rawModels.length === 0 || rawModels.length > MAX_MODELS_PER_PROVIDER) {
    throw new Error(`providers.${catalogKey}.models 数量必须在 1-${MAX_MODELS_PER_PROVIDER} 之间`);
  }
  const models = rawModels.map((model, index) => normalizeModel(model, `${catalogKey}.models[${index}]`));
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) throw new Error(`providers.${catalogKey}.models 存在重复 modelId：${model.id}`);
    modelIds.add(model.id);
  }
  const planTiers = normalizePlanTiers(raw.planTiers, `providers.${catalogKey}.planTiers`);
  const currency = raw.currency === undefined
    ? undefined
    : enumValue(raw.currency, CATALOG_CURRENCIES, `providers.${catalogKey}.currency`);
  const supportedBillingChannels = raw.supportedBillingChannels === undefined
    ? undefined
    : arrayValue(raw.supportedBillingChannels, `providers.${catalogKey}.supportedBillingChannels`)
        .map((channel, index) => enumValue(channel, BILLING_CHANNELS, `providers.${catalogKey}.supportedBillingChannels[${index}]`));
  const presets = normalizePresets(raw.presets, catalogKey, diagnostics);
  const planProfiles = normalizePlanProfiles(raw.planProfiles, catalogKey, diagnostics);
  const campaigns = normalizeCampaigns(raw.campaigns, catalogKey, diagnostics);
  return {
    name: stringValue(raw.name, `providers.${catalogKey}.name`),
    brandId: identifierValue(raw.brandId, `providers.${catalogKey}.brandId`),
    pricingProviderId: identifierValue(raw.pricingProviderId, `providers.${catalogKey}.pricingProviderId`),
    region,
    category,
    ...(currency ? {currency} : {}),
    ...(raw.vendorFamily !== undefined ? {vendorFamily: identifierValue(raw.vendorFamily, `providers.${catalogKey}.vendorFamily`)} : {}),
    ...(supportedBillingChannels?.length ? {supportedBillingChannels: [...new Set(supportedBillingChannels)]} : {}),
    ...(raw.defaultTimezone !== undefined ? {defaultTimezone: ianaTimezoneValue(raw.defaultTimezone, `providers.${catalogKey}.defaultTimezone`)} : {}),
    ...(raw.calendarRef !== undefined ? {calendarRef: stringValue(raw.calendarRef, `providers.${catalogKey}.calendarRef`)} : {}),
    ...optionalUrl(raw.openaiUrl, `providers.${catalogKey}.openaiUrl`, "openaiUrl"),
    ...optionalUrl(raw.anthropicUrl, `providers.${catalogKey}.anthropicUrl`, "anthropicUrl"),
    ...(planTiers ? {planTiers} : {}),
    ...(presets ? {presets} : {}),
    ...(planProfiles ? {planProfiles} : {}),
    ...(campaigns ? {campaigns} : {}),
    models,
  };
}

/** 深度校验套餐档位表；billingCycles 结构校验（语义规则 15 在 static-validator）。 */
function normalizePlanTiers(value: unknown, path: string): ProviderPlanTier[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN_TIERS) {
    throw new Error(`${path} 必须是 1-${MAX_PLAN_TIERS} 个档位`);
  }
  return value.map((item, index) => {
    const raw = objectValue(item, `${path}[${index}]`);
    const tier: ProviderPlanTier = {
      name: stringValue(raw.name, `${path}[${index}].name`),
      monthlyFee: nonNegativeFiniteNumber(raw.monthlyFee, `${path}[${index}].monthlyFee`),
    };
    if (raw.id !== undefined) {
      tier.id = stringValue(raw.id, `${path}[${index}].id`);
    }
    if (raw.credits !== undefined) {
      tier.credits = nonNegativeFiniteNumber(raw.credits, `${path}[${index}].credits`);
    }
    if (raw.originalMonthlyFee !== undefined) {
      tier.originalMonthlyFee = nonNegativeFiniteNumber(raw.originalMonthlyFee, `${path}[${index}].originalMonthlyFee`);
    }
    if (raw.billingCycles !== undefined) {
      const cycles = objectValue(raw.billingCycles, `${path}[${index}].billingCycles`);
      const cycleEntries: Record<string, number> = {};
      for (const key of ["monthly", "quarterly", "yearly"] as const) {
        if (cycles[key] !== undefined) {
          cycleEntries[key] = nonNegativeFiniteNumber(cycles[key], `${path}[${index}].billingCycles.${key}`);
        }
      }
      tier.billingCycles = cycleEntries as ProviderPlanTier["billingCycles"];
    }
    return tier;
  });
}

/** presets[] 结构校验：结构非法的预设以诊断剔除（注册表一致性在 static-validator 规则 13）。 */
function normalizePresets(value: unknown, catalogKey: string, diagnostics: CatalogDiagnostic[]): ProviderCatalogPreset[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRESETS_PER_PROVIDER) {
    throw new Error(`providers.${catalogKey}.presets 必须是 0-${MAX_PRESETS_PER_PROVIDER} 个预设`);
  }
  const presets: ProviderCatalogPreset[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = objectValue(value[index], `providers.${catalogKey}.presets[${index}]`);
    try {
      presets.push({
        presetKey: identifierValue(raw.presetKey, `providers.${catalogKey}.presets[${index}].presetKey`),
        billingChannel: enumValue(raw.billingChannel, BILLING_CHANNELS, `providers.${catalogKey}.presets[${index}].billingChannel`),
        name: stringValue(raw.name, `providers.${catalogKey}.presets[${index}].name`),
        ...optionalUrl(raw.openaiUrl, `providers.${catalogKey}.presets[${index}].openaiUrl`, "openaiUrl"),
        ...optionalUrl(raw.anthropicUrl, `providers.${catalogKey}.presets[${index}].anthropicUrl`, "anthropicUrl"),
        ...optionalWireApis(raw.openaiWireApis, `providers.${catalogKey}.presets[${index}].openaiWireApis`),
        ...(raw.planSyncAdapter !== undefined ? {planSyncAdapter: identifierValue(raw.planSyncAdapter, `providers.${catalogKey}.presets[${index}].planSyncAdapter`)} : {}),
        ...(raw.planCreditFormula === "none" ? {planCreditFormula: "none" as const} : {}),
        ...optionalUrl(raw.consoleUrl, `providers.${catalogKey}.presets[${index}].consoleUrl`, "consoleUrl"),
        ...(typeof raw.notes === "string" && raw.notes.trim() ? {notes: raw.notes.trim()} : {}),
      });
    } catch (error) {
      diagnostics.push(catalogDiagnostic("PRESET_REGISTRY_MISMATCH", "preset",
        `预设结构非法已剔除：${errorMessage(error)}`, {target: `${catalogKey}/presets[${index}]`}));
    }
  }
  return presets.length > 0 ? presets : undefined;
}

/** planProfiles 结构校验：calculator 非法的 Profile 以诊断剔除（依赖方由 static-validator 隔离）。 */
function normalizePlanProfiles(value: unknown, catalogKey: string, diagnostics: CatalogDiagnostic[]): Record<string, ProviderPlanProfile> | undefined {
  if (value === undefined) return undefined;
  const raw = objectValue(value, `providers.${catalogKey}.planProfiles`);
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MAX_PROFILES_PER_PROVIDER) {
    throw new Error(`providers.${catalogKey}.planProfiles 必须是 1-${MAX_PROFILES_PER_PROVIDER} 个 Profile`);
  }
  const profiles: Record<string, ProviderPlanProfile> = {};
  for (const [profileId, profileRaw] of entries) {
    try {
      profiles[profileId] = normalizePlanProfile(profileRaw, `providers.${catalogKey}.planProfiles.${profileId}`, diagnostics);
    } catch (error) {
      diagnostics.push(catalogDiagnostic("PROFILE_CALCULATOR_INVALID", "provider",
        `Profile 结构非法已剔除：${errorMessage(error)}`, {target: `${catalogKey}/${profileId}`}));
    }
  }
  return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function normalizePlanProfile(value: unknown, path: string, diagnostics: CatalogDiagnostic[]): ProviderPlanProfile {
  const raw = objectValue(value, path);
  const calculatorRaw = objectValue(raw.calculator, `${path}.calculator`);
  const kind = enumValue(calculatorRaw.kind, CALCULATOR_KINDS, `${path}.calculator.kind`);
  const calculator: ProviderPlanProfile["calculator"] = {
    kind,
    ...(calculatorRaw.formula !== undefined ? {formula: enumValue(calculatorRaw.formula, new Set(["zhipu", "afp"] as const), `${path}.calculator.formula`)} : {}),
    ...(calculatorRaw.divisor !== undefined ? {divisor: positiveFiniteNumber(calculatorRaw.divisor, `${path}.calculator.divisor`)} : {}),
    ...(calculatorRaw.unit !== undefined ? {unit: stringValue(calculatorRaw.unit, `${path}.calculator.unit`)} : {}),
    ...(calculatorRaw.currency !== undefined ? {currency: enumValue(calculatorRaw.currency, CATALOG_CURRENCIES, `${path}.calculator.currency`)} : {}),
    ...(calculatorRaw.creditsPerCurrency !== undefined ? {creditsPerCurrency: positiveFiniteNumber(calculatorRaw.creditsPerCurrency, `${path}.calculator.creditsPerCurrency`)} : {}),
    ...(calculatorRaw.cacheRead !== undefined ? {cacheRead: enumValue(calculatorRaw.cacheRead, new Set(["separate", "input"] as const), `${path}.calculator.cacheRead`)} : {}),
  };
  const quotaWindows = raw.quotaWindows === undefined
    ? undefined
    : arrayValue(raw.quotaWindows, `${path}.quotaWindows`).map((item, index) => {
        const windowRaw = objectValue(item, `${path}.quotaWindows[${index}]`);
        return {
          id: enumValue(windowRaw.id, new Set(["5h", "weekly", "monthly"] as const), `${path}.quotaWindows[${index}].id`),
          label: stringValue(windowRaw.label, `${path}.quotaWindows[${index}].label`),
          reset: enumValue(windowRaw.reset, new Set(["rolling_5h", "fixed_5h", "weekly", "monthly"] as const), `${path}.quotaWindows[${index}].reset`),
        } satisfies PlanCreditQuotaWindow;
      });
  const quotaTiers = raw.quotaTiers === undefined
    ? undefined
    : Object.fromEntries(Object.entries(objectValue(raw.quotaTiers, `${path}.quotaTiers`)).map(([tier, tierRaw]) => {
        const tierObject = objectValue(tierRaw, `${path}.quotaTiers.${tier}`);
        const quota = objectValue(tierObject.quotaByWindow, `${path}.quotaTiers.${tier}.quotaByWindow`);
        return [tier, {
          quotaByWindow: Object.fromEntries(Object.entries(quota).map(([windowId, amount]) => [
            windowId, nonNegativeFiniteNumber(amount, `${path}.quotaTiers.${tier}.quotaByWindow.${windowId}`),
          ])),
          ...(typeof tierObject.notes === "string" && tierObject.notes.trim() ? {notes: tierObject.notes.trim()} : {}),
        }];
      }));
  const toolFactors = raw.toolFactors === undefined
    ? undefined
    : arrayValue(raw.toolFactors, `${path}.toolFactors`).map((item, index) => {
        const factorRaw = objectValue(item, `${path}.toolFactors[${index}]`);
        const mode = enumValue(factorRaw.mode, new Set(["output_factor", "fixed"] as const), `${path}.toolFactors[${index}].mode`);
        return {
          id: stringValue(factorRaw.id, `${path}.toolFactors[${index}].id`),
          mode,
          ...(factorRaw.perCall !== undefined ? {perCall: nonNegativeFiniteNumber(factorRaw.perCall, `${path}.toolFactors[${index}].perCall`)} : {}),
          ...(typeof factorRaw.notes === "string" && factorRaw.notes.trim() ? {notes: factorRaw.notes.trim()} : {}),
        };
      });
  return {
    calculator,
    ...(raw.currency !== undefined ? {currency: enumValue(raw.currency, CATALOG_CURRENCIES, `${path}.currency`)} : {}),
    ...(raw.timezone !== undefined ? {timezone: ianaTimezoneValue(raw.timezone, `${path}.timezone`)} : {}),
    ...(raw.peakWindows !== undefined
      ? {peakWindows: arrayValue(raw.peakWindows, `${path}.peakWindows`).map((windowRaw, index) => normalizeWindowWithHolidayFlags(windowRaw, `${path}.peakWindows[${index}]`, true))}
      : {}),
    ...(raw.offPeakMultiplier !== undefined ? {offPeakMultiplier: nonNegativeFiniteNumber(raw.offPeakMultiplier, `${path}.offPeakMultiplier`)} : {}),
    ...(quotaWindows?.length ? {quotaWindows} : {}),
    ...(quotaTiers ? {quotaTiers} : {}),
    ...(toolFactors ? {toolFactors} : {}),
    ...(raw.unverified === true ? {unverified: true} : {}),
    ...(typeof raw.notes === "string" && raw.notes.trim() ? {notes: raw.notes.trim()} : {}),
  };
}

/** campaigns 结构校验：非法活动以诊断隔离并剔除（整目录不受影响）。 */
function normalizeCampaigns(value: unknown, catalogKey: string, diagnostics: CatalogDiagnostic[]): CatalogCampaign[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAMPAIGNS_PER_PROVIDER) {
    throw new Error(`providers.${catalogKey}.campaigns 必须是 0-${MAX_CAMPAIGNS_PER_PROVIDER} 条活动`);
  }
  const campaigns: CatalogCampaign[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `providers.${catalogKey}.campaigns[${index}]`;
    const raw = objectValue(value[index], path);
    try {
      const campaign = normalizeCampaign(raw, path);
      if (seenIds.has(campaign.id)) {
        diagnostics.push(catalogDiagnostic("CAMPAIGN_STRUCTURE_INVALID", "campaign",
          `活动 id 重复已剔除：${campaign.id}`, {target: `${catalogKey}/${campaign.id}`}));
        continue;
      }
      seenIds.add(campaign.id);
      campaigns.push(campaign);
    } catch (error) {
      diagnostics.push(catalogDiagnostic("CAMPAIGN_STRUCTURE_INVALID", "campaign",
        `活动结构非法已剔除：${errorMessage(error)}`, {target: `${catalogKey}/campaigns[${index}]`}));
    }
  }
  return campaigns;
}

function normalizeCampaign(value: unknown, path: string): CatalogCampaign {
  const raw = objectValue(value, path);
  const id = stringValue(raw.id, `${path}.id`);
  const channel = enumValue(raw.channel, CAMPAIGN_CHANNELS, `${path}.channel`);
  const periodRaw = objectValue(raw.period, `${path}.period`);
  const from = stringValue(periodRaw.from, `${path}.period.from`);
  const fromTime = Date.parse(from);
  if (!Number.isFinite(fromTime)) throw new Error(`${path}.period.from 必须是可解析时刻`);
  const to = periodRaw.to === undefined ? undefined : stringValue(periodRaw.to, `${path}.period.to`);
  if (to !== undefined) {
    const toTime = Date.parse(to);
    if (!Number.isFinite(toTime)) throw new Error(`${path}.period.to 必须是可解析时刻`);
    if (toTime <= fromTime) throw new Error(`${path}.period.to 必须晚于 from（左闭右开）`);
  }
  const effect = normalizeCampaignEffect(raw.effect, `${path}.effect`);
  const scope = normalizeCampaignScope(raw.scope, `${path}.scope`);
  const recurringWindows = raw.recurringWindows === undefined
    ? undefined
    : arrayValue(raw.recurringWindows, `${path}.recurringWindows`).map((windowRaw, index) => normalizeWindowWithHolidayFlags(windowRaw, `${path}.recurringWindows[${index}]`, false));
  return {
    id,
    channel,
    ...(raw.profileRef !== undefined ? {profileRef: stringValue(raw.profileRef, `${path}.profileRef`)} : {}),
    ...(scope ? {scope} : {}),
    period: {from, ...(to !== undefined ? {to} : {})},
    ...(recurringWindows ? {recurringWindows} : {}),
    effect,
    ...(raw.priority !== undefined ? {priority: nonNegativeFiniteNumber(raw.priority, `${path}.priority`)} : {}),
    ...(raw.stackingPolicy !== undefined ? {stackingPolicy: enumValue(raw.stackingPolicy, new Set(["exclusive", "multiply", "override"] as const), `${path}.stackingPolicy`)} : {}),
    ...(raw.label !== undefined && typeof raw.label === "string" && raw.label.trim() ? {label: raw.label.trim()} : {}),
    ...(raw.unverified === true ? {unverified: true} : {}),
    ...(typeof raw.note === "string" && raw.note.trim() ? {note: raw.note.trim()} : {}),
  };
}

/** 未知 effect.kind / 未知效果结构：抛出（调用方按诊断隔离，绝不静默当无条件生效）。 */
function normalizeCampaignEffect(value: unknown, path: string): CampaignEffect {
  const raw = objectValue(value, path);
  const kind = stringValue(raw.kind, `${path}.kind`);
  if (!KNOWN_EFFECT_KINDS.has(kind as never)) throw new Error(`${path}.kind 未知: ${kind}`);
  switch (kind) {
    case "priceOverride":
      return {kind, rates: normalizeSparseRates(raw.rates, `${path}.rates`)};
    case "factorOverride": {
      const factors = objectValue(raw.factors, `${path}.factors`);
      const projected: {input?: number; output?: number; cachedInput?: number} = {};
      if (factors.input !== undefined) projected.input = nonNegativeFiniteNumber(factors.input, `${path}.factors.input`);
      if (factors.output !== undefined) projected.output = nonNegativeFiniteNumber(factors.output, `${path}.factors.output`);
      if (factors.cachedInput !== undefined) projected.cachedInput = nonNegativeFiniteNumber(factors.cachedInput, `${path}.factors.cachedInput`);
      if (Object.keys(projected).length === 0) throw new Error(`${path}.factors 必须至少声明 input/output 之一`);
      return {kind, factors: projected};
    }
    case "creditMultiplier":
    case "priceMultiplier":
    case "quotaMultiplier":
      return {kind, value: normalizeCampaignRatioValue(raw.value, `${path}.value`)};
    case "quotaAdd":
    case "cap":
    case "fixedToolCredit": {
      const numeric = nonNegativeFiniteNumber(raw.value ?? raw.perCall, `${path}.value`);
      return kind === "fixedToolCredit" ? {kind, perCall: numeric} : {kind, value: numeric};
    }
    case "freeWindow":
      return {kind};
  }
  throw new Error(`${path}.kind 未知: ${kind}`);
}

function normalizeCampaignRatioValue(value: unknown, path: string): CampaignEffect extends {kind: infer K; value: infer R} ? R : never {
  if (typeof value === "number") {
    resolveCampaignRatio(value, path);
    return value as never;
  }
  const raw = objectValue(value, path);
  const ratio = {
    numerator: nonNegativeFiniteNumber(raw.numerator, `${path}.numerator`),
    denominator: positiveFiniteNumber(raw.denominator, `${path}.denominator`),
  };
  resolveCampaignRatio(ratio, path);
  return ratio as never;
}

/** 作用域：未知维度=未知条件，抛出隔离（设计 4.5）。 */
function normalizeCampaignScope(value: unknown, path: string): CatalogCampaign["scope"] | undefined {
  if (value === undefined) return undefined;
  const raw = objectValue(value, path);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SCOPE_KEYS.includes(key as never)) throw new Error(`${path}.${key} 是未知作用域条件`);
  }
  const stringList = (key: typeof KNOWN_SCOPE_KEYS[number]) => {
    if (raw[key] === undefined) return undefined;
    const list = arrayValue(raw[key], `${path}.${key}`)
      .map((item, index) => stringValue(item, `${path}.${key}[${index}]`));
    if (list.length === 0) throw new Error(`${path}.${key} 声明后不能为空`);
    return list;
  };
  const origins = stringList("origins");
  if (origins !== undefined) {
    for (const origin of origins) {
      if (!(KNOWN_ORIGIN_VALUES as readonly string[]).includes(origin)) {
        throw new Error(`${path}.origins 值非法: ${origin}`);
      }
    }
  }
  const scope = {
    ...(stringList("models") ? {models: stringList("models")} : {}),
    ...(stringList("modelGroups") ? {modelGroups: stringList("modelGroups")} : {}),
    ...(stringList("agents") ? {agents: stringList("agents")} : {}),
    ...(stringList("agentGroups") ? {agentGroups: stringList("agentGroups")} : {}),
    ...(stringList("planTiers") ? {planTiers: stringList("planTiers")} : {}),
    ...(stringList("regions") ? {regions: stringList("regions")} : {}),
    ...(stringList("serviceTiers") ? {serviceTiers: stringList("serviceTiers")} : {}),
    ...(origins ? {origins} : {}),
  };
  return Object.keys(scope).length > 0 ? scope : undefined;
}

/** 峰谷/活动/时段窗口（带节假日标志）：时刻校验同 v1（end 可 24:00，不支持跨午夜）。 */
function normalizeWindowWithHolidayFlags(
  value: unknown,
  path: string,
  withMultiplier: boolean,
): CatalogScheduleWindow | (CatalogScheduleWindow & {multiplier?: number}) {
  const raw = objectValue(value, path);
  const start = stringValue(raw.start, `${path}.start`);
  const end = stringValue(raw.end, `${path}.end`);
  validateClock(start, `${path}.start`);
  validateClock(end, `${path}.end`);
  const days = raw.days === undefined
    ? undefined
    : arrayValue(raw.days, `${path}.days`)
        .map((day, index) => nonNegativeFiniteNumber(day, `${path}.days[${index}]`))
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  return {
    ...(days?.length ? {days} : {}),
    start,
    end,
    ...(raw.timezone !== undefined ? {timezone: ianaTimezoneValue(raw.timezone, `${path}.timezone`)} : {}),
    ...(raw.excludeHolidays === true ? {excludeHolidays: true} : {}),
    ...(raw.includeHolidays === true ? {includeHolidays: true} : {}),
    ...(withMultiplier && raw.multiplier !== undefined ? {multiplier: nonNegativeFiniteNumber(raw.multiplier, `${path}.multiplier`)} : {}),
  };
}

/** market_share 档位月度额度（USD）：档位 id 非空、额度有限正数；档位数有界。 */
function normalizePlanMonthlyLimitUsd(value: unknown, path: string): ProviderCatalogModel["planMonthlyLimitUsd"] {
  const record = objectValue(value, path);
  const entries = Object.entries(record);
  if (entries.length === 0) throw new Error(`${path} 不能为空`);
  if (entries.length > 16) throw new Error(`${path} 档位数超过 16`);
  const result: Record<string, number> = {};
  for (const [tier, limit] of entries) {
    if (!tier.trim()) throw new Error(`${path} 档位 id 不能为空`);
    result[tier] = positiveFiniteNumber(limit, `${path}.${tier}`);
  }
  return result;
}

function normalizeModel(value: unknown, path: string): ProviderCatalogModel {
  const raw = objectValue(value, path);
  const category = enumValue(raw.category, MODEL_CATEGORIES, `${path}.category`);
  const rateTimeline = normalizeRateTimeline(raw.rateTimeline, `${path}.rateTimeline`);
  const serviceTierPricing = normalizeServiceTierPricing(raw.serviceTierPricing, `${path}.serviceTierPricing`);
  const priceSchedules = normalizePriceSchedules(raw.priceSchedules, `${path}.priceSchedules`);
  const planFactors = raw.planFactors === undefined ? undefined : normalizePlanCreditModelFactor(raw.planFactors, `${path}.planFactors`);
  const planAliases = raw.planAliases === undefined ? undefined : normalizePlanAliases(raw.planAliases, `${path}.planAliases`);
  const planMonthlyLimitUsd = raw.planMonthlyLimitUsd === undefined ? undefined : normalizePlanMonthlyLimitUsd(raw.planMonthlyLimitUsd, `${path}.planMonthlyLimitUsd`);
  const usageSchema = raw.usageSchema === undefined ? undefined : normalizeUsageSchema(raw.usageSchema, `${path}.usageSchema`);
  // 时间线是唯一价格真相：顶层价格字段由最后一段自动填充（幂等——首次解析与
  // 二次归一化（双源合并、缓存重读）都安全覆盖，不因已填充的顶层字段而拒绝）。
  const lastSegment = rateTimeline?.[rateTimeline.length - 1];
  return {
    id: modelIdValue(raw.id, `${path}.id`),
    category,
    ...optionalSafeInteger(raw.contextWindowK, `${path}.contextWindowK`, "contextWindowK"),
    ...optionalSafeInteger(raw.maxOutputK, `${path}.maxOutputK`, "maxOutputK"),
    ...optionalModelWireApis(raw.supportedWireApis, `${path}.supportedWireApis`),
    ...optionalInputModalities(raw.inputModalities, `${path}.inputModalities`),
    ...(rateTimeline ? {rateTimeline} : {}),
    // 顶层价格快照：时间线模型取最后一段，单段模型取顶层字段。
    ...(lastSegment ? {pricing: lastSegment.pricing} : raw.pricing === undefined ? {} : {pricing: normalizePricing(raw.pricing, `${path}.pricing`)}),
    ...(lastSegment
      ? (lastSegment.serviceTierPricing !== undefined ? {serviceTierPricing: lastSegment.serviceTierPricing} : {})
      : serviceTierPricing !== undefined ? {serviceTierPricing} : {}),
    ...(lastSegment
      ? (lastSegment.priceSchedules !== undefined ? {priceSchedules: lastSegment.priceSchedules} : {})
      : priceSchedules !== undefined ? {priceSchedules} : {}),
    ...optionalStringArray(raw.aliases, `${path}.aliases`, "aliases"),
    ...optionalUrl(raw.sourceUrl, `${path}.sourceUrl`, "sourceUrl"),
    ...optionalStringProperty(raw.notes, `${path}.notes`, "notes"),
    ...(raw.planProfileRef !== undefined ? {planProfileRef: stringValue(raw.planProfileRef, `${path}.planProfileRef`)} : {}),
    ...(planMonthlyLimitUsd ? {planMonthlyLimitUsd} : {}),
    ...(lastSegment
      ? (lastSegment.planFactors !== undefined ? {planFactors: lastSegment.planFactors} : {})
      : planFactors !== undefined ? {planFactors} : {}),
    ...(planAliases ? {planAliases} : {}),
    ...(usageSchema ? {usageSchema} : {}),
  };
}

/**
 * 价格时间线深校验（终极方案不变量）：1-8 段、effectiveFrom 严格递增（同一时间唯一价格）、
 * RFC 3339 带时区、每段 pricing 完整；changeNote 为有界公告文案。
 */
function normalizeRateTimeline(value: unknown, path: string): ProviderCatalogModel["rateTimeline"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error(`${path} 必须是 1-8 个价格段`);
  }
  const segments: NonNullable<ProviderCatalogModel["rateTimeline"]> = [];
  let previousFrom: number | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const raw = objectValue(value[index], `${path}[${index}]`);
    let effectiveFrom: string | undefined;
    if (raw.effectiveFrom !== undefined) {
      effectiveFrom = stringValue(raw.effectiveFrom, `${path}[${index}].effectiveFrom`);
      if (!isValidRfc3339WithZone(effectiveFrom)) {
        throw new Error(`${path}[${index}].effectiveFrom 必须是带时区的 RFC 3339 时刻`);
      }
      const fromTime = Date.parse(effectiveFrom);
      if (previousFrom !== undefined && fromTime <= previousFrom) {
        throw new Error(`${path}[${index}].effectiveFrom 必须严格递增（同一时间唯一价格）`);
      }
      previousFrom = fromTime;
    } else if (index > 0) {
      throw new Error(`${path}[${index}] 只有首段可以缺省 effectiveFrom（历史现状）`);
    }
    const schedules = raw.priceSchedules === undefined
      ? undefined
      : normalizePriceSchedules(raw.priceSchedules, `${path}[${index}].priceSchedules`);
    const serviceTierPricing = raw.serviceTierPricing === undefined
      ? undefined
      : normalizeServiceTierPricing(raw.serviceTierPricing, `${path}[${index}].serviceTierPricing`);
    const planFactors = raw.planFactors === undefined
      ? undefined
      : normalizePlanCreditModelFactor(raw.planFactors, `${path}[${index}].planFactors`);
    segments.push({
      ...(effectiveFrom !== undefined ? {effectiveFrom} : {}),
      pricing: normalizePricing(raw.pricing, `${path}[${index}].pricing`),
      ...(schedules !== undefined ? {priceSchedules: schedules} : {}),
      ...(serviceTierPricing !== undefined ? {serviceTierPricing} : {}),
      ...(planFactors !== undefined ? {planFactors} : {}),
      ...(typeof raw.changeNote === "string" && raw.changeNote.trim() ? {changeNote: raw.changeNote.trim()} : {}),
    });
  }
  return segments;
}

/** 四价稀疏覆盖集深校验：至少一个非负有限价格字段。 */
function normalizeSparseRates(value: unknown, path: string): SparsePricingRates {
  const raw = objectValue(value, path);
  const result: SparsePricingRates = {};
  for (const field of ["input", "output", "cachedInput", "cacheWrite", "cacheWrite5m", "cacheWrite1h"] as const) {
    if (raw[field] !== undefined) {
      result[field] = nonNegativeFiniteNumber(raw[field], `${path}.${field}`);
    }
  }
  if (Object.keys(result).length === 0) throw new Error(`${path} 至少声明一个价格字段`);
  return result;
}

/** 服务档位价格集深校验：本期只认 fast 键（与价格中心 ServiceTierPricing 同构）。 */
function normalizeServiceTierPricing(value: unknown, path: string): ServiceTierPricing | undefined {
  if (value === undefined) return undefined;
  const raw = objectValue(value, path);
  if (raw.fastMultiplier === undefined) return undefined;
  return {fastMultiplier: positiveFiniteNumber(raw.fastMultiplier, `${path}.fastMultiplier`)};
}

/** 深度校验模型级时段费率；节假日标志由编译期解析（此处只校验布尔形态）。 */
function normalizePriceSchedules(value: unknown, path: string): CatalogPriceSchedule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error(`${path} 必须是 1-8 个时段组`);
  }
  return value.map((raw, index) => {
    const item = objectValue(raw, `${path}[${index}]`);
    const label = stringValue(item.label, `${path}[${index}].label`);
    const windows = arrayValue(item.windows, `${path}[${index}].windows`)
      .map((windowRaw, windowIndex) => normalizeWindowWithHolidayFlags(windowRaw, `${path}[${index}].windows[${windowIndex}]`, false));
    if (windows.length === 0) throw new Error(`${path}[${index}].windows 不能为空`);
    return {
      ...(typeof item.timezone === "string" && item.timezone.trim() ? {timezone: item.timezone.trim()} : {}),
      label,
      windows,
      rates: normalizePricing(item.rates, `${path}[${index}].rates`),
      ...normalizeScheduleHolidays(item.holidays, `${path}[${index}].holidays`),
    };
  });
}

/** 节假日日期（v1 行内兼容）：YYYY-MM-DD 数组，去重并限制维护规模。 */
function normalizeScheduleHolidays(value: unknown, path: string): {holidays: string[]} | Record<string, never> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length === 0 || value.length > 365) {
    throw new Error(`${path} 必须是 1-365 个 YYYY-MM-DD 日期`);
  }
  const holidays = [...new Set(value.map((item, index) => {
    const date = stringValue(item, `${path}[${index}]`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      throw new Error(`${path}[${index}] 节假日必须是 YYYY-MM-DD 日期: ${date}`);
    }
    const [year, month, day] = date.split("-").map(Number);
    const probe = new Date(Date.UTC(year!, month! - 1, day!));
    if (probe.getUTCFullYear() !== year
      || probe.getUTCMonth() !== month! - 1
      || probe.getUTCDate() !== day) {
      throw new Error(`${path}[${index}] 节假日不是有效日期: ${date}`);
    }
    return date;
  }))].sort();
  return {holidays};
}

/** 校验 "HH:mm" / "HH:mm:ss"：时 0-24（24 只允许 24:00:00），分/秒 0-59。 */
function validateClock(value: string, path: string): void {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) throw new Error(`${path} 非法时间窗口时刻: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const isMidnightEnd = hour === 24 && minute === 0 && second === 0;
  const valid = hour >= 0 && hour <= 24 && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59 && (hour !== 24 || isMidnightEnd);
  if (!valid) throw new Error(`${path} 非法时间窗口时刻: ${value}`);
}

function normalizePlanCreditModelFactor(value: unknown, path: string): PlanCreditModelFactor {
  const raw = objectValue(value, path);
  return {
    input: nonNegativeFiniteNumber(raw.input, `${path}.input`),
    output: nonNegativeFiniteNumber(raw.output, `${path}.output`),
    ...(typeof raw.cachedInput === "number" && Number.isFinite(raw.cachedInput) && raw.cachedInput >= 0
      ? {cachedInput: raw.cachedInput}
      : {}),
  };
}

function normalizePlanAliases(value: unknown, path: string): Record<string, string> {
  const raw = objectValue(value, path);
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > 64) {
    throw new Error(`${path} 必须是 1-64 条计费模型重定向`);
  }
  return Object.fromEntries(entries.map(([modelId, target]) => {
    if (modelId.length === 0 || modelId.length > 256) throw new Error(`${path} 存在非法模型名`);
    return [modelId, stringValue(target, `${path}.${modelId}`)];
  }));
}

/** 模型级协议能力：返回键 supportedWireApis。 */
function optionalModelWireApis(value: unknown, path: string): {supportedWireApis?: ProviderCatalogWireApi[]} {
  const result = optionalWireApis(value, path);
  return result.openaiWireApis === undefined ? {} : {supportedWireApis: result.openaiWireApis};
}

/** 模型级输入模态（2026-09-21 能力下发）：去重；空数组视为未声明（保守 text 由消费端兜底）。 */
function optionalInputModalities(value: unknown, path: string): {inputModalities?: ProviderCatalogInputModality[]} {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 4
    || value.some(item => typeof item !== "string" || !INPUT_MODALITIES.has(item as ProviderCatalogInputModality))) {
    throw new Error(`${path} 不是合法输入模态列表（可选值 text/image/audio）`);
  }
  const modalities = [...new Set(value as ProviderCatalogInputModality[])];
  return modalities.length === 0 ? {} : {inputModalities: modalities};
}

function optionalWireApis(value: unknown, path: string): {openaiWireApis?: ProviderCatalogWireApi[]} {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 8 || value.some(item => typeof item !== "string" || !WIRE_APIS.has(item as ProviderCatalogWireApi))) {
    throw new Error(`${path} 不是合法协议能力列表`);
  }
  return {openaiWireApis: [...new Set(value as ProviderCatalogWireApi[])]};
}

function normalizePricing(value: unknown, path: string): PricingRates {
  const raw = objectValue(value, path);
  return {
    input: nonNegativeFiniteNumber(raw.input, `${path}.input`),
    output: nonNegativeFiniteNumber(raw.output, `${path}.output`),
    ...optionalPrice(raw.cachedInput, `${path}.cachedInput`, "cachedInput"),
    ...optionalPrice(raw.cacheWrite, `${path}.cacheWrite`, "cacheWrite"),
    ...optionalPrice(raw.cacheWrite5m, `${path}.cacheWrite5m`, "cacheWrite5m"),
    ...optionalPrice(raw.cacheWrite1h, `${path}.cacheWrite1h`, "cacheWrite1h"),
    ...optionalPrice(raw.reasoning, `${path}.reasoning`, "reasoning"),
    ...normalizeLongContext(raw.longContext, `${path}.longContext`),
  };
}

function normalizeUsageSchema(value: unknown, path: string): ProviderCatalogUsageSchema | undefined {
  if (value === undefined) return undefined;
  const raw = objectValue(value, path);
  const fieldsRaw = objectValue(raw.fields, `${path}.fields`);
  const fields: ProviderCatalogUsageSchema["fields"] = {};
  for (const [name, fieldValue] of Object.entries(fieldsRaw)) {
    const field = objectValue(fieldValue, `${path}.fields.${name}`);
    const unit = enumValue(field.unit, USAGE_UNITS, `${path}.fields.${name}.unit`);
    fields[name] = {
      unit,
      ...(field.price === undefined ? {} : {price: nonNegativeFiniteNumber(field.price, `${path}.fields.${name}.price`)}),
      ...(field.notes === undefined ? {} : {notes: stringValue(field.notes, `${path}.fields.${name}.notes`)}),
    };
  }
  if (Object.keys(fields).length === 0) throw new Error(`${path}.fields 不能为空`);
  return {
    fields,
    ...(raw.currency === undefined ? {} : {currency: enumValue(raw.currency, CATALOG_CURRENCIES, `${path}.currency`)}),
    ...(raw.notes === undefined ? {} : {notes: stringValue(raw.notes, `${path}.notes`)}),
  };
}

/** 长上下文档位：阈值 + 输入/输出倍率 + 可选 rates 绝对价（字段级）；字段不完整视为未声明。 */
function normalizeLongContext(value: unknown, path: string): {longContext?: LongContextPricingTier} {
  if (value === undefined) return {};
  const raw = objectValue(value, path);
  const rates = raw.rates === undefined ? undefined : normalizeSparseRates(raw.rates, `${path}.rates`);
  return {
    longContext: {
      thresholdTokens: positiveInteger(raw.thresholdTokens, `${path}.thresholdTokens`),
      inputMultiplier: positiveFiniteNumber(raw.inputMultiplier, `${path}.inputMultiplier`),
      outputMultiplier: positiveFiniteNumber(raw.outputMultiplier, `${path}.outputMultiplier`),
      ...(rates ? {rates} : {}),
    },
  };
}

function positiveInteger(value: unknown, path: string): number {
  const numeric = nonNegativeFiniteNumber(value, path);
  if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`${path} 必须是正整数`);
  return numeric;
}

function positiveFiniteNumber(value: unknown, path: string): number {
  const numeric = nonNegativeFiniteNumber(value, path);
  if (numeric <= 0) throw new Error(`${path} 必须是正数`);
  return numeric;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_STRING_LENGTH) {
    throw new Error(`${path} 必须是非空字符串`);
  }
  return value.trim();
}

function identifierValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(text)) throw new Error(`${path} 不是合法标识符`);
  return text;
}

function modelIdValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text.length > 256 || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${path} 不是合法模型 ID`);
  return text;
}

function ianaTimezoneValue(value: unknown, path: string): string {
  const zone = stringValue(value, path);
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: zone});
  } catch {
    throw new Error(`${path} 不是可用的 IANA 时区: ${zone}`);
  }
  return zone;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`${path} 不是受支持的枚举值`);
  return value as T;
}

function nonNegativeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} 必须是非负有限数值`);
  }
  return value;
}

function optionalPrice(value: unknown, path: string, key: "cachedInput" | "cacheWrite" | "cacheWrite5m" | "cacheWrite1h" | "reasoning") {
  return value === undefined ? {} : {[key]: nonNegativeFiniteNumber(value, path)};
}

function optionalSafeInteger(value: unknown, path: string, key: "contextWindowK" | "maxOutputK") {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} 必须是正安全整数`);
  }
  return {[key]: value};
}

function optionalStringProperty(value: unknown, path: string, key: "notes") {
  return value === undefined ? {} : {[key]: stringValue(value, path)};
}

function optionalStringArray(value: unknown, path: string, key: "aliases") {
  if (value === undefined) return {};
  const items = arrayValue(value, path).map((item, index) => stringValue(item, `${path}[${index}]`));
  if (items.length > 64) throw new Error(`${path} 超过 64 项上限`);
  return {[key]: [...new Set(items)]};
}

function optionalUrl(value: unknown, path: string, key: "openaiUrl" | "anthropicUrl" | "sourceUrl" | "consoleUrl") {
  if (value === undefined) return {};
  const text = stringValue(value, path);
  let url: URL;
  try {
    url = new URL(text);
  } catch (cause) {
    throw new Error(`${path} 不是合法 URL`, {cause});
  }
  if (url.protocol !== "https:") throw new Error(`${path} 必须使用 HTTPS`);
  return {[key]: url.toString().replace(/\/$/u, "")};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 未使用引用占位（PaygPromotion 形状由编译投影保证一致性）。 */
export type {PaygPromotion};
