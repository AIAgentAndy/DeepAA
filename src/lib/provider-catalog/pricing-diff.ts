/**
 * 官方目录与价格中心的逐字段差异（通用模块，2026-09-03 用户决策：目录改确认制）。
 *
 * 消费方：
 * - `GET /api/provider-catalog/pricing-updates`（右上角常驻入口的角标与弹窗数据）
 * - 目录确认弹窗（git-diff 式左右对比）
 * - 相关测试
 *
 * 对比基准始终是价格中心当前值（用户确认后基准自动前移）；
 * `user_override` 手工价条目不参与（人工优先级最大，永不自动变更）。
 */

import {
  normalizePricingConfig,
  pricingEntryRuntimeModelId,
  type LongContextPricingTier,
  type ModelPriceEntry,
  type PaygPromotion,
  type PricingConfig,
  type ServiceTierPricing,
  type TemporalPriceSchedule,
} from "@/lib/pricing";
import {providerCatalogToPricingEntries} from "./pricing";
import {canonicalPlanCreditJson, planCreditRuleChanges} from "./diff";
import type {ProviderCatalog} from "./types";

export interface CatalogPricingFieldChange {
  field: string;
  label: string;
  before?: string;
  after: string;
  kind: "changed" | "added" | "removed";
}

export interface CatalogPricingModelDiff {
  modelId: string;
  entryId: string;
  /** 整条目为目录新增（价格中心不存在同键条目）时为 true，changes 汇总各字段。 */
  added: boolean;
  changes: CatalogPricingFieldChange[];
}

export interface CatalogPricingProviderDiff {
  pricingProviderId: string;
  providerName: string;
  models: CatalogPricingModelDiff[];
}

export interface CatalogPricingDiffSummary {
  hasUpdates: boolean;
  /** 变化模型条数（added + changed）。 */
  changedModelCount: number;
  providers: CatalogPricingProviderDiff[];
  /** 目录 publishedAt，用于弹窗展示数据版本。 */
  publishedAt?: string;
  /** 模型对比达到上限被截断时为 true（大数据保护）。 */
  limited: boolean;
  /** 截断前实际命中的变化模型总数。 */
  candidateModelCount: number;
}

/** 单次 diff 的模型对比上限（有界输出；目录与价格中心均为有限集合，只防御异常膨胀）。 */
const MAX_DIFF_MODELS = 500;

/**
 * 对比价格中心与官方目录：逐供应商 × 模型 × 字段（价格各项、长上下文档位、
 * service_tier 乘数、时段费率、套餐积分规则（字段级）、上下文/输出窗口、别名）。
 */
export function diffPricingCenterAgainstCatalog(
  currentConfig: PricingConfig,
  catalog: ProviderCatalog,
): CatalogPricingDiffSummary {
  const current = normalizePricingConfig(currentConfig);
  const currentByIdentity = new Map<string, ModelPriceEntry>();
  for (const entry of current.models) {
    currentByIdentity.set(pricingIdentity(entry), entry);
  }
  const providers: CatalogPricingProviderDiff[] = [];
  let candidateModelCount = 0;
  let limited = false;
  for (const catalogEntry of providerCatalogToPricingEntries(catalog)) {
    const identity = pricingIdentity(catalogEntry);
    const existing = currentByIdentity.get(identity);
    if (existing?.confidence === "user_override") continue; // 人工价不参与目录对比。
    const changes = existing
      ? modelFieldChanges(catalogEntry, existing)
      : addedModelChanges(catalogEntry);
    if (changes.length === 0) continue;
    candidateModelCount += 1;
    if (candidateModelCount > MAX_DIFF_MODELS) {
      limited = true;
      continue;
    }
    const providerName = catalog.providers[catalogProviderKey(catalog, catalogEntry)]?.name
      ?? catalogEntry.vendor;
    let provider = providers.find(item => item.pricingProviderId === catalogEntry.vendor);
    if (!provider) {
      provider = {pricingProviderId: catalogEntry.vendor, providerName, models: []};
      providers.push(provider);
    }
    provider.models.push({
      modelId: pricingEntryRuntimeModelId(catalogEntry),
      entryId: catalogEntry.id,
      added: !existing,
      changes,
    });
  }
  return {
    hasUpdates: candidateModelCount > 0,
    changedModelCount: Math.min(candidateModelCount, MAX_DIFF_MODELS),
    providers,
    ...(catalog.publishedAt ? {publishedAt: catalog.publishedAt} : {}),
    limited,
    candidateModelCount,
  };
}

/** 价格中心唯一键与合并逻辑保持一致：vendor + runtimeModelId。 */
function pricingIdentity(entry: ModelPriceEntry): string {
  const runtimeModelId = pricingEntryRuntimeModelId(entry);
  return `${entry.vendor.trim().toLowerCase()}\u0000${runtimeModelId.trim().toLowerCase()}`;
}

/** 从条目 id 反查目录 provider key（catalog:{pricingProviderId}:{modelId}）。 */
function catalogProviderKey(catalog: ProviderCatalog, entry: ModelPriceEntry): string {
  for (const [key, provider] of Object.entries(catalog.providers)) {
    if (provider.pricingProviderId === entry.vendor) return key;
  }
  return entry.vendor;
}

/** 目录新增条目：把非空字段汇总为 added 变化。 */
function addedModelChanges(entry: ModelPriceEntry): CatalogPricingFieldChange[] {
  const changes: CatalogPricingFieldChange[] = [];
  const pricing = entry.pricing;
  if (pricing) {
    changes.push(priceChange("input", "非缓存输入价", undefined, pricing.input));
    changes.push(priceChange("output", "输出价", undefined, pricing.output));
    if (pricing.cachedInput !== undefined) changes.push(priceChange("cachedInput", "缓存命中价", undefined, pricing.cachedInput));
    if (pricing.cacheWrite !== undefined) changes.push(priceChange("cacheWrite", "缓存写入价", undefined, pricing.cacheWrite));
    if (pricing.longContext) {
      changes.push({
        field: "longContext",
        label: "长上下文档位",
        after: summarizeLongContext(pricing.longContext),
        kind: "added",
      });
    }
  }
  if (entry.priceSchedules?.length) {
    changes.push({field: "priceSchedules", label: "时段费率", after: `${entry.priceSchedules.length} 组窗口`, kind: "added"});
  }
  if (entry.serviceTierPricing) {
    changes.push({field: "serviceTierPricing", label: "服务档位价格", after: summarizeServiceTierPricing(entry.serviceTierPricing), kind: "added"});
  }
  if (entry.promotions?.length) {
    changes.push({field: "promotions", label: "按量促销", after: summarizePaygPromotions(entry.promotions), kind: "added"});
  }
  if (entry.planCreditRules) {
    changes.push(...planCreditRuleChanges(entry.planCreditRules, undefined));
  }
  if (entry.inputModalities?.length) {
    changes.push({
      field: "inputModalities",
      label: "输入模态",
      after: entry.inputModalities.join(" / "),
      kind: "added",
    });
  }
  if (entry.contextWindow) {
    changes.push({field: "contextWindow", label: "上下文窗口", after: summarizeTokens(entry.contextWindow), kind: "added"});
  }
  return changes.filter(change => change.kind === "added" || change.before !== change.after);
}

/** 既有条目逐字段对比（catalog-sync 四原则分类复用）。 */
export function modelFieldChanges(next: ModelPriceEntry, previous: ModelPriceEntry): CatalogPricingFieldChange[] {
  const changes: CatalogPricingFieldChange[] = [];
  const nextPricing = next.pricing;
  const previousPricing = previous.pricing;
  if (nextPricing && previousPricing) {
    for (const [field, label] of [
      ["input", "非缓存输入价"],
      ["output", "输出价"],
      ["cachedInput", "缓存命中价"],
      ["cacheWrite", "缓存写入价"],
    ] as const) {
      const before = previousPricing[field];
      const after = nextPricing[field];
      if (before !== after) changes.push(priceChange(field, label, before, after));
    }
    if (summarizeLongContext(nextPricing.longContext) !== summarizeLongContext(previousPricing.longContext)) {
      changes.push({
        field: "longContext",
        label: "长上下文档位",
        before: summarizeLongContext(previousPricing.longContext),
        after: summarizeLongContext(nextPricing.longContext),
        kind: "changed",
      });
    }
  }
  // 时段费率逐档比较（2026-09-22 与官网管理台 diff 同步精准化）：一档变化只出该档条目，
  // 未变档不再挤进整块摘要让用户自己找差异；判等含完整窗口内容（键序稳定）。
  const previousSchedules = scheduleEntryMap(previous.priceSchedules);
  const nextSchedules = scheduleEntryMap(next.priceSchedules);
  for (const label of [...new Set([...previousSchedules.keys(), ...nextSchedules.keys()])]) {
    const before = previousSchedules.get(label);
    const after = nextSchedules.get(label);
    if (before?.canonical === after?.canonical) continue;
    changes.push({
      field: `priceSchedules.${label}`,
      label: `时段费率 · ${label}`,
      ...(before ? {before: before.text} : {}),
      after: after?.text ?? "移除",
      kind: before ? "changed" : "added",
    });
  }
  // 按量促销逐条比较（2026-09-08 与套餐侧 planCreditRuleChanges 对齐的 per-key 粒度）：
  // 促销上下架/变价必须进入四原则分流；新增第二条促销不再被判为整字段 "changed"，
  // 与套餐促销一致——全新活动条目（added）静默，修改/下架既有条目才按使用中分流。
  const previousPromotions = summarizePaygPromotionMap(previous.promotions);
  const nextPromotions = summarizePaygPromotionMap(next.promotions);
  const promotionKeys = [...new Set([...Object.keys(previousPromotions), ...Object.keys(nextPromotions)])].sort();
  for (const key of promotionKeys) {
    if (previousPromotions[key] === nextPromotions[key]) continue;
    changes.push({
      field: `promotions.${key}`,
      label: "按量促销",
      ...(previousPromotions[key] ? {before: previousPromotions[key]} : {}),
      after: nextPromotions[key] ?? "移除",
      kind: previousPromotions[key] ? "changed" : "added",
    });
  }
  // 服务档位价格逐键比较（本期值域只有 fast；逐键后未来加键自动保持精准粒度）。
  const previousTiers = serviceTierEntryMap(previous.serviceTierPricing);
  const nextTiers = serviceTierEntryMap(next.serviceTierPricing);
  for (const tier of [...new Set([...previousTiers.keys(), ...nextTiers.keys()])].sort()) {
    const before = previousTiers.get(tier);
    const after = nextTiers.get(tier);
    if (before?.canonical === after?.canonical) continue;
    changes.push({
      field: `serviceTierPricing.${tier}`,
      label: `服务档位价格 · ${tier}`,
      ...(before ? {before: before.text} : {}),
      after: after?.text ?? "移除",
      kind: before ? "changed" : "added",
    });
  }
  changes.push(...planCreditRuleChanges(next.planCreditRules, previous.planCreditRules));
  if ((next.contextWindow ?? 0) !== (previous.contextWindow ?? 0)) {
    changes.push({
      field: "contextWindow",
      label: "上下文窗口",
      before: previous.contextWindow ? summarizeTokens(previous.contextWindow) : "未配置",
      after: next.contextWindow ? summarizeTokens(next.contextWindow) : "未配置",
      kind: "changed",
    });
  }
  if ((next.maxOutput ?? 0) !== (previous.maxOutput ?? 0)) {
    changes.push({
      field: "maxOutput",
      label: "最大输出 Token",
      before: previous.maxOutput ? summarizeTokens(previous.maxOutput) : "未配置",
      after: next.maxOutput ? summarizeTokens(next.maxOutput) : "未配置",
      kind: "changed",
    });
  }
  // 终极方案：wireApis（协议能力）与价格时间线变化也进入通知。
  if (JSON.stringify(next.supportedWireApis ?? null) !== JSON.stringify(previous.supportedWireApis ?? null)) {
    changes.push({
      field: "supportedWireApis",
      label: "协议能力",
      before: (previous.supportedWireApis ?? []).join(" / ") || "未声明",
      after: (next.supportedWireApis ?? []).join(" / ") || "未声明",
      kind: "changed",
    });
  }
  // 输入模态变化进通知（2026-09-21 能力下发）；该比较同时是目录同步定向静默 CLI 的门控数据源。
  if (JSON.stringify(next.inputModalities ?? null) !== JSON.stringify(previous.inputModalities ?? null)) {
    changes.push({
      field: "inputModalities",
      label: "输入模态",
      before: (previous.inputModalities ?? []).join(" / ") || "未声明",
      after: (next.inputModalities ?? []).join(" / ") || "未声明",
      kind: "changed",
    });
  }
  // 价格时间线逐段比较（2026-09-22 精准化）：一段变化只出该段条目（含 changeNote 文案差异），
  // 未变段不再整串展示；键 = 段生效时刻（契约严格递增唯一，首段缺省=历史现状）。
  const previousTimeline = timelineSegmentMap(previous.rateTimeline);
  const nextTimeline = timelineSegmentMap(next.rateTimeline);
  for (const key of [...new Set([...previousTimeline.keys(), ...nextTimeline.keys()])]) {
    const before = previousTimeline.get(key);
    const after = nextTimeline.get(key);
    if (before?.canonical === after?.canonical) continue;
    const fromText = (after ?? before)?.fromText ?? key;
    changes.push({
      field: `rateTimeline.${key}`,
      label: `价格时间线 · ${fromText} 起`,
      ...(before ? {before: before.text} : {}),
      after: after?.text ?? "移除",
      kind: before ? "changed" : "added",
    });
  }
  return changes;
}

/** 逐条目比较的摘要载体：canonical 键序稳定判等（含完整嵌套内容），text 为通知栏可读摘要。 */
interface EntryDiffSummary {
  canonical: string;
  text: string;
}

/** 时段费率逐档摘要映射：键 = 档位 label（重复后缀去重），判等含完整窗口内容。 */
function scheduleEntryMap(schedules?: TemporalPriceSchedule[]): Map<string, EntryDiffSummary> {
  const map = new Map<string, EntryDiffSummary>();
  for (const schedule of schedules ?? []) {
    const baseLabel = schedule.label ?? `档位${map.size + 1}`;
    let key = baseLabel;
    for (let n = 2; map.has(key); n += 1) key = `${baseLabel}#${n}`;
    const rates = schedule.rates;
    const rateText = `输入 ${rates.input ?? "-"}/输出 ${rates.output ?? "-"}`
      + (rates.cachedInput !== undefined ? `/缓存 ${rates.cachedInput}` : "");
    const holidayNote = schedule.holidays?.length ? "、含节假日" : "";
    map.set(key, {
      canonical: canonicalPlanCreditJson(schedule),
      text: `${schedule.windows.length} 窗口${holidayNote} · ${rateText}`,
    });
  }
  return map;
}

/** 价格时间线逐段摘要映射：键 = 段生效时刻（首段缺省 = 历史现状）。 */
function timelineSegmentMap(timeline: ModelPriceEntry["rateTimeline"]): Map<string, TimelineSegmentSummary> {
  const map = new Map<string, TimelineSegmentSummary>();
  timeline?.forEach((segment, index) => {
    const from = segment.effectiveFrom;
    const fromText = from ? from.slice(0, 16).replace("T", " ") : (index === 0 ? "历史" : `段${index + 1}`);
    const rates = segment.pricing;
    const rateText = `${rates.input ?? "-"}/${rates.output ?? "-"}`
      + (rates.cachedInput !== undefined ? `/缓存 ${rates.cachedInput}` : "");
    map.set(from ?? `#${index}`, {
      canonical: canonicalPlanCreditJson(segment),
      text: `${fromText}起 ${rateText}${segment.changeNote ? `（${segment.changeNote}）` : ""}`,
      fromText,
    });
  });
  return map;
}

interface TimelineSegmentSummary extends EntryDiffSummary {
  fromText: string;
}

/** 服务档位倍率摘要映射（2026-10-07 倍率制；本期值域 fastMultiplier，逐键保持未来扩展粒度）。 */
function serviceTierEntryMap(tier?: ServiceTierPricing): Map<string, EntryDiffSummary> {
  const map = new Map<string, EntryDiffSummary>();
  const multiplier = tier?.fastMultiplier;
  if (multiplier !== undefined) {
    map.set("fastMultiplier", {canonical: String(multiplier), text: `Fast ${multiplier}×`});
  }
  return map;
}

function priceChange(field: string, label: string, before: number | undefined, after: number | undefined): CatalogPricingFieldChange {
  return {
    field,
    label,
    ...(before !== undefined ? {before: `${before}/M`} : {}),
    after: after !== undefined ? `${after}/M` : "未配置",
    kind: before === undefined ? "added" : "changed",
  };
}

function summarizeLongContext(tier?: LongContextPricingTier): string {
  if (!tier) return "未配置";
  const base = `> ${summarizeTokens(tier.thresholdTokens)} 输入×${tier.inputMultiplier} 输出×${tier.outputMultiplier}`;
  if (!tier.rates) return base;
  const absolute = [
    tier.rates.input !== undefined ? `输入 ${tier.rates.input}` : "",
    tier.rates.output !== undefined ? `输出 ${tier.rates.output}` : "",
    tier.rates.cachedInput !== undefined ? `缓存读 ${tier.rates.cachedInput}` : "",
    tier.rates.cacheWrite !== undefined ? `缓存写 ${tier.rates.cacheWrite}` : "",
  ].filter(Boolean).join(" / ");
  return `${base} 绝对价 ${absolute}`;
}

/** 按量促销摘要：标签、时间窗（to 缺省=不限）、效果（实扣价/倍率）与 agent 限定。 */
function summarizePaygPromotions(promotions?: PaygPromotion[]): string {
  if (!promotions?.length) return "未配置";
  return promotions.map(promotion => [
    promotion.label ?? "促销",
    `${promotion.from.slice(0, 10)}~${promotion.to ? promotion.to.slice(0, 10) : "不限"}`,
    promotion.priceOverride
      ? `实扣 ${promotion.priceOverride.input ?? "-"}/${promotion.priceOverride.output ?? "-"}`
        + (promotion.priceOverride.cachedInput !== undefined ? `/缓存${promotion.priceOverride.cachedInput}` : "")
      : `×${promotion.multiplier}`,
    ...(promotion.agents?.length ? [`限 ${promotion.agents.join("/")}`] : []),
  ].join(" ")).join("；");
}

/**
 * 按量促销逐条摘要映射（per-key diff 用）：键 = 模型 × 日期区间 × Agent 限定，
 * 值 = 完整摘要（含标签与实扣价/倍率）——同键不同价判 "changed"，全新键判 "added"。
 */
function summarizePaygPromotionMap(promotions?: PaygPromotion[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const promotion of promotions ?? []) {
    const models = promotion.models?.length ? promotion.models.join("+") : "全部模型";
    const window = `${promotion.from.slice(0, 10)}~${promotion.to ? promotion.to.slice(0, 10) : "不限"}`;
    const agents = promotion.agents?.length ? promotion.agents.join("/") : "全部Agent";
    result[`${models}:${window}:${agents}`] = [
      promotion.label ?? "促销",
      window,
      promotion.priceOverride
        ? `实扣 ${promotion.priceOverride.input ?? "-"}/${promotion.priceOverride.output ?? "-"}`
          + (promotion.priceOverride.cachedInput !== undefined ? `/缓存${promotion.priceOverride.cachedInput}` : "")
          + (promotion.priceOverride.cacheWrite !== undefined ? `/缓存写${promotion.priceOverride.cacheWrite}` : "")
        : `×${promotion.multiplier}`,
      ...(promotion.agents?.length ? [`限 ${promotion.agents.join("/")}`] : []),
    ].join(" ");
  }
  return result;
}

/** 服务档位价格集摘要（整条目新增时汇总展示用）：输入/输出/缓存读实价。 */
function summarizeServiceTierPricing(tier?: ServiceTierPricing): string {
  const multiplier = tier?.fastMultiplier;
  return multiplier === undefined ? "未配置" : `Fast ${multiplier}×`;
}

function summarizeTokens(tokens: number): string {
  return tokens >= 1024 && tokens % 1024 === 0 ? `${tokens / 1024}K` : tokens.toLocaleString("en-US");
}
