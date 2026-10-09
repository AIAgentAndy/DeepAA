import type {ModelPriceEntry, PaygPromotion, ServiceTierPricing, TemporalPriceSchedule} from "./pricing";

/**
 * 基础价 + 闲时（Off-Peak）费率 + 长上下文档位 + fast 档倍率 + 按量促销的草稿字段；
 * 峰谷模型同时编辑高峰/闲时两组价格。全部为字符串草稿，保存时统一解析。
 */
export type PriceField = "input" | "output" | "cachedInput" | "cacheWrite" | "reasoning"
  | "offPeakInput" | "offPeakOutput" | "offPeakCachedInput" | "offPeakCacheWrite"
  | "promoInput" | "promoOutput" | "promoCachedInput" | "promoCacheWrite";
export type PriceDrafts = Record<PriceField, string> & {
  /** 长上下文档位（空=无阶梯）：阈值 token / 输入倍率 / 输出倍率。 */
  longContextThreshold: string;
  longContextInput: string;
  longContextOutput: string;
  /** fast 档倍率（2026-10-07 倍率制；空 = 未配置），如 2 = 2× 标准价。 */
  fastMultiplier: string;
  /** 按量促销（单条实扣价编辑）：from 必填（YYYY-MM-DD 或 ISO 时刻），to 空=无限期。 */
  promoFrom: string;
  promoTo: string;
  promoLabel: string;
  /** agent 限定（逗号分隔小写标识，如 zcode）；空 = 不限。 */
  promoAgents: string;
};

export function emptyPriceDrafts(): PriceDrafts {
  return { input: "", output: "", cachedInput: "", cacheWrite: "", reasoning: "",
    offPeakInput: "", offPeakOutput: "", offPeakCachedInput: "", offPeakCacheWrite: "",
    promoInput: "", promoOutput: "", promoCachedInput: "", promoCacheWrite: "",
    promoFrom: "", promoTo: "", promoLabel: "", promoAgents: "",
    longContextThreshold: "", longContextInput: "", longContextOutput: "",
    fastMultiplier: "" };
}

export function priceDraftsFromModel(model: ModelPriceEntry | null): PriceDrafts {
  const scheduleRates = model?.priceSchedules?.[0]?.rates;
  const promotion = model?.promotions?.find(item => item.priceOverride !== undefined);
  const override = promotion?.priceOverride;
  return {
    input: priceDraftFromValue(model?.pricing?.input),
    output: priceDraftFromValue(model?.pricing?.output),
    cachedInput: priceDraftFromValue(model?.pricing?.cachedInput),
    cacheWrite: priceDraftFromValue(model?.pricing?.cacheWrite),
    reasoning: priceDraftFromValue(model?.pricing?.reasoning),
    offPeakInput: priceDraftFromValue(scheduleRates?.input),
    offPeakOutput: priceDraftFromValue(scheduleRates?.output),
    offPeakCachedInput: priceDraftFromValue(scheduleRates?.cachedInput),
    offPeakCacheWrite: priceDraftFromValue(scheduleRates?.cacheWrite),
    fastMultiplier: priceDraftFromValue(model?.serviceTierPricing?.fastMultiplier),
    promoInput: priceDraftFromValue(override?.input),
    promoOutput: priceDraftFromValue(override?.output),
    promoCachedInput: priceDraftFromValue(override?.cachedInput),
    promoCacheWrite: priceDraftFromValue(override?.cacheWrite),
    promoFrom: promotion?.from ? promotion.from.slice(0, 10) : "",
    promoTo: promotion?.to ? promotion.to.slice(0, 10) : "",
    promoLabel: promotion?.label ?? "",
    promoAgents: promotion?.agents?.join(",") ?? "",
    longContextThreshold: model?.pricing?.longContext
      ? String(model.pricing.longContext.thresholdTokens)
      : "",
    longContextInput: model?.pricing?.longContext
      ? String(model.pricing.longContext.inputMultiplier)
      : "",
    longContextOutput: model?.pricing?.longContext
      ? String(model.pricing.longContext.outputMultiplier)
      : "",
  };
}

export function isDecimalDraft(value: string): boolean {
  return value === "" || /^\d*(?:\.\d*)?$/.test(value);
}

export interface PriceDraftsResult {
  pricing: ModelPriceEntry["pricing"];
  /** 闲时费率草稿非空时返回更新后的时段费率；无时段费率或未填闲时价时省略。 */
  priceSchedules?: TemporalPriceSchedule[];
  /** fast 档价格集草稿非空时返回；全部清空时省略（清除 fast 配置）。 */
  serviceTierPricing?: ServiceTierPricing;
  /** 促销草稿（任一字段填写）时返回单条实扣价促销；全部清空时省略（清除促销）。 */
  promotions?: PaygPromotion[];
}

/**
 * 基础价格必填 input/output；闲时费率整组填写（input/output 必填）才会写回时段窗口，
 * 避免用户只改高峰价时误清空峰谷定义。fast 档与促销为稀疏覆盖：填写的字段才生效。
 */
export function priceDraftsToPricing(
  drafts: PriceDrafts,
  existingSchedules?: TemporalPriceSchedule[],
): PriceDraftsResult | undefined {
  const input = parsePriceDraft(drafts.input);
  const output = parsePriceDraft(drafts.output);
  const cachedInput = parsePriceDraft(drafts.cachedInput);
  const cacheWrite = parsePriceDraft(drafts.cacheWrite);
  const reasoning = parsePriceDraft(drafts.reasoning);
  if (input === "invalid" || output === "invalid" || cachedInput === "invalid"
    || cacheWrite === "invalid" || reasoning === "invalid") {
    return undefined;
  }
  // 长上下文档位：三字段整组填写才生效；部分填写视为非法输入。
  const tierThreshold = parsePriceDraft(drafts.longContextThreshold);
  const tierInput = parsePriceDraft(drafts.longContextInput);
  const tierOutput = parsePriceDraft(drafts.longContextOutput);
  if (tierThreshold === "invalid" || tierInput === "invalid" || tierOutput === "invalid") return undefined;
  const hasTier = tierThreshold !== undefined || tierInput !== undefined || tierOutput !== undefined;
  if (hasTier && (tierThreshold === undefined || tierInput === undefined || tierOutput === undefined)) return undefined;
  const pricing: ModelPriceEntry["pricing"] = {
    input: input ?? 0,
    output: output ?? 0,
    cachedInput: cachedInput ?? undefined,
    cacheWrite: cacheWrite ?? undefined,
    reasoning: reasoning ?? undefined,
    ...(hasTier && tierThreshold !== undefined && tierInput !== undefined && tierOutput !== undefined
      ? {longContext: {thresholdTokens: tierThreshold, inputMultiplier: tierInput, outputMultiplier: tierOutput}}
      : {}),
  };
  const offPeakInput = parsePriceDraft(drafts.offPeakInput);
  const offPeakOutput = parsePriceDraft(drafts.offPeakOutput);
  const offPeakCachedInput = parsePriceDraft(drafts.offPeakCachedInput);
  const offPeakCacheWrite = parsePriceDraft(drafts.offPeakCacheWrite);
  if (offPeakInput === "invalid" || offPeakOutput === "invalid"
    || offPeakCachedInput === "invalid" || offPeakCacheWrite === "invalid") return undefined;
  const priceSchedules = existingSchedules?.length && offPeakInput !== undefined && offPeakOutput !== undefined
    ? existingSchedules.map(schedule => ({
      ...schedule,
      rates: {
        ...schedule.rates,
        input: offPeakInput,
        output: offPeakOutput,
        ...(offPeakCachedInput !== undefined ? {cachedInput: offPeakCachedInput} : {}),
        ...(offPeakCacheWrite !== undefined ? {cacheWrite: offPeakCacheWrite} : {}),
      },
    }))
    : undefined;

  // fast 档倍率（2026-10-07 倍率制）：留空 = 移除；填写则须为正有限数（如 2 = 2×）。
  const fastMultiplierText = drafts.fastMultiplier.trim();
  let serviceTierPricing: ServiceTierPricing | undefined;
  if (fastMultiplierText !== "") {
    const parsed = Number(fastMultiplierText);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    serviceTierPricing = {fastMultiplier: parsed};
  }

  // 按量促销（单条实扣价编辑）：价格与 from 都填写才生效；全部清空 = 移除。
  const promoOverride = parseSparseDraft({
    input: drafts.promoInput,
    output: drafts.promoOutput,
    cachedInput: drafts.promoCachedInput,
    cacheWrite: drafts.promoCacheWrite,
  });
  if (promoOverride === "invalid") return undefined;
  const promoTrimmedFrom = drafts.promoFrom.trim();
  const promoTrimmedTo = drafts.promoTo.trim();
  const promoFilled = promoOverride !== undefined || promoTrimmedFrom !== "" || drafts.promoLabel.trim() !== "";
  let promotions: PaygPromotion[] | undefined;
  if (promoFilled) {
    // 实扣价促销至少一个价格字段 + 可解析起始时间；to 可空 = 无限期。
    if (!promoOverride || !isParseableDate(promoTrimmedFrom)) return undefined;
    if (promoTrimmedTo !== "" && !isParseableDate(promoTrimmedTo)) return undefined;
    const agents = [...new Set(drafts.promoAgents
      .split(/[,，]/u)
      .map(agent => agent.trim().toLowerCase())
      .filter(agent => agent.length > 0))];
    promotions = [{
      from: promoTrimmedFrom,
      ...(promoTrimmedTo !== "" ? {to: promoTrimmedTo} : {}),
      ...(agents.length > 0 ? {agents} : {}),
      ...(drafts.promoLabel.trim() ? {label: drafts.promoLabel.trim()} : {}),
      priceOverride: promoOverride,
    }];
  }

  return {
    pricing,
    ...(priceSchedules ? {priceSchedules} : {}),
    ...(serviceTierPricing ? {serviceTierPricing} : {}),
    ...(promotions ? {promotions} : {}),
  };
}

/** 四价稀疏覆盖草稿解析：全部空 = undefined；任一非法 = "invalid"；否则返回已声明字段集。 */
function parseSparseDraft(values: Record<"input" | "output" | "cachedInput" | "cacheWrite", string>)
  : {input?: number; output?: number; cachedInput?: number; cacheWrite?: number} | "invalid" | undefined {
  const result: {input?: number; output?: number; cachedInput?: number; cacheWrite?: number} = {};
  let count = 0;
  for (const field of ["input", "output", "cachedInput", "cacheWrite"] as const) {
    const parsed = parsePriceDraft(values[field]);
    if (parsed === "invalid") return "invalid";
    if (parsed !== undefined) {
      result[field] = parsed;
      count += 1;
    }
  }
  return count > 0 ? result : undefined;
}

function isParseableDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function priceDraftFromValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function parsePriceDraft(value: string): number | undefined | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : "invalid";
}
