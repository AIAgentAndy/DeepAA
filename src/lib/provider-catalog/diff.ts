import type {AgentId, ProxyTarget, WireApi} from "@/types";
import {listAutomaticWhitelistCandidates} from "./normalize";
import type {ProviderCatalogModel, ProviderCatalogProvider} from "./types";
import {normalizePricingConfig, pricingEntryRuntimeModelId, type ModelPriceEntry, type PlanCreditRules, type PricingConfig, type TemporalPriceSchedule} from "@/lib/pricing";
import {schedulePricingText} from "@/lib/token-pricing-display";
import {modelWireApisForTarget, supportedAgentsForCatalogModel} from "./wire-api";

export type ProviderCatalogDiffKind = "added" | "existing" | "removed";

export interface ProviderCatalogModelChange {
  field: string;
  label: string;
  before?: string;
  after: string;
  kind: "changed" | "added" | "removed";
}

export interface ProviderCatalogDiffItem {
  id: string;
  kind: ProviderCatalogDiffKind;
  selected: boolean;
  category?: ProviderCatalogModel["category"];
  priced: boolean;
  vendor?: string;
  pricing?: ProviderCatalogModel["pricing"];
  /** 目录 v2：时段费率与套餐规则来自编译投影（节假日标志已解析为日期集合）。 */
  priceSchedules?: TemporalPriceSchedule[];
  planCreditRules?: PlanCreditRules;
  contextWindowK?: number;
  maxOutputK?: number;
  supportedWireApis?: ProviderCatalogModel["supportedWireApis"];
  /** 输入模态（2026-09-21 能力下发）：刷新面板只读展示；自动跟随目录，不做确认比较。 */
  inputModalities?: ProviderCatalogModel["inputModalities"];
  sourceUrl?: string;
  notes?: string;
  supportedAgents?: AgentId[];
  /** 提供价格中心后，原有模型只保留有变化的条目。 */
  changed?: boolean;
  /** 具体变化字段与新旧值，供刷新面板着色标注。 */
  changes?: ProviderCatalogModelChange[];
  warning?: string;
}

export interface ProviderCatalogDiff {
  providerId: string;
  publishedAt?: string;
  added: ProviderCatalogDiffItem[];
  existing: ProviderCatalogDiffItem[];
  removed: ProviderCatalogDiffItem[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

export interface ProviderCatalogSelection {
  selectedModelIds: string[];
  replacementDefaultModels?: Partial<Record<AgentId, string>>;
  /**
   * 单模型接入模式（2026-09-06 用户确认「仅更新此模型」语义）：只把勾选模型
   * 接入当前目标，未勾选的有变化模型一律保留现状（不更新、更不移出白名单），
   * 与整卡确认流程「取消勾选 = 移除」的语义互斥。
   */
  preserveUnselected?: boolean;
}

export interface ProviderCatalogApplyResult {
  targetPatch: Partial<ProxyTarget>;
  removedModelIds: string[];
  selectedModelIds: string[];
  candidateCount: number;
  processedCount: number;
  limited: false;
}

/**
 * 模型集合差异（终极方案 2026-09-10）：只管「哪些模型加入/移出白名单」——
 * 价格/时间线/wireApis 已由价格中心自动跟随，不作为待确认差异。
 * added = 价格中心有、白名单无；existing = 双方都有（全部展示，不筛选"有变化"）；
 * removed = 白名单有、价格中心无（目录已移除，默认保留）。
 */
export function computeProviderCatalogDiff(
  target: ProxyTarget,
  provider: ProviderCatalogProvider,
  _pricing?: PricingConfig,
  compiled?: Map<string, ModelPriceEntry>,
): ProviderCatalogDiff {
  const catalogModels = new Map(provider.models.map(model => [model.id, model] as const));
  const automatic = new Set(listAutomaticWhitelistCandidates(provider)
    .filter(model => supportedAgentsForCatalogModel(provider, model, target).length > 0)
    .map(model => model.id));
  const current = new Set(target.supportedModels);
  const added = provider.models
    .filter(model => automatic.has(model.id) && !current.has(model.id))
    .map(model => item(model.id, "added", model, provider, target, false, undefined, compiled));
  // 终极方案：全部存量模型展示（价格/时间线/wireApis 自动跟随，无"有变化"过滤）。
  const existing = target.supportedModels
    .filter(modelId => catalogModels.has(modelId))
    .map(modelId => {
      const model = catalogModels.get(modelId)!;
      return item(
        modelId,
        "existing",
        model,
        provider,
        target,
        Boolean(target.pricing?.modelVendors?.[modelId]?.vendor && target.pricing?.modelVendors?.[modelId]?.priceEntryId),
        undefined,
        compiled,
      );
    });
  // 价格中心无（目录已移除）：默认保留在白名单，仅作提示。
  const removed = target.supportedModels
    .filter(modelId => !catalogModels.has(modelId))
    .map(modelId => ({
      id: modelId,
      kind: "removed" as const,
      selected: Boolean(target.pricing?.modelVendors?.[modelId]?.vendor && target.pricing?.modelVendors?.[modelId]?.priceEntryId),
      priced: Boolean(target.pricing?.modelVendors?.[modelId]?.vendor && target.pricing?.modelVendors?.[modelId]?.priceEntryId),
      vendor: target.pricing?.modelVendors?.[modelId]?.vendor,
      pricing: target.pricing?.modelOverrides?.find(override => override.targetModelId === modelId)?.pricing,
    }));
  return {
    providerId: provider.pricingProviderId,
    publishedAt: undefined,
    added,
    existing,
    removed,
    candidateCount: added.length,
    processedCount: added.length + existing.length + removed.length,
    limited: false,
  };
}

/** 服务端确认时重新基于供应商与目录生成 patch，客户端只提交模型选择和默认替代值。 */
export function applyProviderCatalogSelection(
  target: ProxyTarget,
  provider: ProviderCatalogProvider,
  selection: ProviderCatalogSelection,
  pricing?: PricingConfig,
  compiled?: Map<string, ModelPriceEntry>,
): ProviderCatalogApplyResult {
  const catalogIds = new Set(provider.models.map(model => model.id));
  const fullDiff = computeProviderCatalogDiff(target, provider, pricing, compiled);
  const allowedIds = new Set([...target.supportedModels, ...catalogIds]);
  const selectedModelIds = [...new Set(selection.selectedModelIds.map(modelId => modelId.trim()))];
  if (selectedModelIds.some(modelId => !modelId || !allowedIds.has(modelId))) {
    throw new Error("模型选择包含目录和存量供应商之外的模型");
  }
  const selected = new Set(selectedModelIds);
  for (const modelId of selected) {
    const catalogModel = provider.models.find(model => model.id === modelId);
    const currentMapping = target.pricing?.modelVendors?.[modelId];
    if (!catalogModel?.pricing && (!currentMapping?.vendor || !currentMapping.priceEntryId)) {
      throw new Error("MODEL_PRICE_MAPPING_REQUIRED");
    }
  }
  // 终极方案（集合语义）：用户取消勾选的模型从白名单移除；preserveUnselected 单模型模式
  // 下不做任何移除。目录已移除（不在 catalogIds）的模型默认保留，除非用户主动取消。
  const removedModelIds = selection.preserveUnselected === true ? [] : target.supportedModels.filter(modelId =>
    !selected.has(modelId));
  const modelById = new Map(provider.models.map(model => [model.id, model] as const));
  const defaultModels = {...(target.development?.defaultModels || {})};
  const replacementDefaults = selection.replacementDefaultModels || {};
  for (const [agent, currentModel] of Object.entries(defaultModels) as Array<[AgentId, string]>) {
    if (!removedModelIds.includes(currentModel)) continue;
    const replacement = replacementDefaults[agent];
    if (!replacement || !selected.has(replacement) || !replacementUsableForAgent(target, provider, modelById, replacement, agent)) {
      throw new Error(`${agent} 默认模型已取消，请先选择替代模型`);
    }
    defaultModels[agent] = replacement;
  }
  for (const [agent, replacement] of Object.entries(replacementDefaults) as Array<[AgentId, string]>) {
    if (!selected.has(replacement) || !replacementUsableForAgent(target, provider, modelById, replacement, agent)) {
      throw new Error(`${agent} 默认模型替代值无效`);
    }
  }

  const orderedModels = [...new Set([
    ...provider.models.map(model => model.id).filter(modelId => selected.has(modelId)),
    ...target.supportedModels.filter(modelId => !removedModelIds.includes(modelId)),
  ])];
  const nextMappings: NonNullable<NonNullable<ProxyTarget["pricing"]>["modelVendors"]> = {};
  const nextScopes: Record<string, AgentId[]> = {};
  const nextWireApis: Record<string, readonly WireApi[]> = {};
  for (const modelId of orderedModels) {
    const catalogModel = modelById.get(modelId);
    const currentMapping = target.pricing?.modelVendors?.[modelId];
    const isExistingModel = target.supportedModels.includes(modelId);
    if (catalogModel && isExistingModel && !removedModelIds.includes(modelId) && target.supportedModelScopes?.[modelId]) {
      nextScopes[modelId] = [...target.supportedModelScopes[modelId]!];
    } else {
      nextScopes[modelId] = catalogModel
        ? supportedAgentsForCatalogModel(provider, catalogModel, target)
        : (target.supportedModelScopes?.[modelId] ? [...target.supportedModelScopes[modelId]!] : []);
    }
    nextWireApis[modelId] = catalogModel
      ? modelWireApisForTarget(provider, catalogModel, target)
      : (target.supportedModelWireApis?.[modelId] ? [...target.supportedModelWireApis[modelId]!] : []);
    if (catalogModel?.pricing) {
      // 已有供应商且已存在合法映射的模型保留原映射，避免刷新时无意义地改绑条目 ID；
      // 新增模型只写供应商，由服务端按目录合并后的价格中心唯一条目补全 priceEntryId。
      nextMappings[modelId] = currentMapping && target.supportedModels.includes(modelId)
        ? currentMapping
        : {vendor: provider.pricingProviderId};
    } else if (currentMapping) {
      nextMappings[modelId] = currentMapping;
    }
  }
  const nextOverrides = (target.pricing?.modelOverrides || []).filter(override => {
    return !removedModelIds.includes(override.targetModelId);
  });
  const nextPricing = target.pricing
    ? {
      ...target.pricing,
      modelVendors: Object.keys(nextMappings).length > 0 ? nextMappings : undefined,
      modelOverrides: nextOverrides.length > 0 ? nextOverrides : undefined,
    }
    : undefined;
  return {
    targetPatch: {
      supportedModels: orderedModels,
      supportedModelScopes: Object.keys(nextScopes).length > 0 ? nextScopes : undefined,
      supportedModelWireApis: Object.keys(nextWireApis).length > 0 ? nextWireApis : undefined,
      pricing: nextPricing,
      development: target.development
        ? {...target.development, defaultModels: Object.keys(defaultModels).length > 0 ? defaultModels : undefined}
        : undefined,
    },
    removedModelIds,
    selectedModelIds: orderedModels,
    candidateCount: fullDiff.candidateCount,
    processedCount: fullDiff.processedCount,
    limited: false,
  };
}

function item(
  id: string,
  kind: "added" | "existing",
  model: ProviderCatalogModel,
  provider: ProviderCatalogProvider,
  target: ProxyTarget,
  hasCurrentMapping = false,
  changes?: ProviderCatalogModelChange[],
  compiled?: Map<string, ModelPriceEntry>,
): ProviderCatalogDiffItem {
  const priced = Boolean(model.pricing) || hasCurrentMapping;
  const compiledEntry = compiled?.get(model.id);
  return {
    id,
    kind,
    selected: priced,
    category: model.category,
    priced,
    vendor: provider.pricingProviderId,
    pricing: model.pricing,
    priceSchedules: compiledEntry?.priceSchedules,
    planCreditRules: compiledEntry?.planCreditRules,
    contextWindowK: model.contextWindowK,
    maxOutputK: model.maxOutputK,
    supportedWireApis: model.supportedWireApis,
    inputModalities: model.inputModalities,
    sourceUrl: model.sourceUrl,
    notes: model.notes,
    supportedAgents: supportedAgentsForCatalogModel(provider, model, target),
    ...(changes ? {changed: true, changes} : {}),
    ...(kind === "existing" && !priced && !hasCurrentMapping ? {warning: "目录仍保留该模型，但没有可确认的价格映射，禁止继续保留。"} : {}),
  };
}

/** 供应商当前映射的价格中心条目：优先按 priceEntryId，其次按供应商 + 运行时模型 ID。 */
function currentEntryForModel(
  target: ProxyTarget,
  modelId: string,
  pricing?: PricingConfig,
): ModelPriceEntry | undefined {
  if (!pricing) return undefined;
  const models = normalizePricingConfig(pricing).models;
  const mapping = target.pricing?.modelVendors?.[modelId];
  if (mapping?.priceEntryId) {
    const byId = models.find(entry => entry.id.trim() === mapping.priceEntryId);
    if (byId) return byId;
  }
  if (mapping?.vendor) {
    const vendor = mapping.vendor.trim().toLowerCase();
    return models.find(entry =>
      (entry.vendor || entry.litellmProvider || "").trim().toLowerCase() === vendor
      && pricingEntryRuntimeModelId(entry).trim().toLowerCase() === modelId.trim().toLowerCase());
  }
  return undefined;
}

/** 最新目录模型 vs 供应商当前价格中心条目的逐字段差异；无差异或缺少当前条目时返回 undefined。 */
function buildModelChanges(
  model: ProviderCatalogModel,
  current: ModelPriceEntry | undefined,
  compiledEntry?: ModelPriceEntry,
): ProviderCatalogModelChange[] | undefined {
  if (!current) {
    return [{
      field: "mapping",
      label: "价格中心映射",
      after: "将按最新目录补全",
      kind: "added",
    }];
  }
  const changes: ProviderCatalogModelChange[] = [];
  comparePricingField(changes, "非缓存输入", model.pricing?.input, current.pricing?.input);
  comparePricingField(changes, "缓存输入", model.pricing?.cachedInput, current.pricing?.cachedInput);
  comparePricingField(changes, "输出", model.pricing?.output, current.pricing?.output);
  comparePricingField(changes, "缓存写入", model.pricing?.cacheWrite, current.pricing?.cacheWrite);
  comparePricingField(changes, "推理", model.pricing?.reasoning, current.pricing?.reasoning);
  if (!sameSchedules(compiledEntry?.priceSchedules, current.priceSchedules)) {
    changes.push({
      field: "schedule",
      label: "峰谷费率",
      before: schedulePricingText(current.pricing, current.priceSchedules) || "未配置",
      after: schedulePricingText(model.pricing, compiledEntry?.priceSchedules) || "未配置",
      kind: current.priceSchedules?.length ? "changed" : "added",
    });
  }
  compareContextField(changes, "上下文窗口", model.contextWindowK, current.contextWindow);
  compareContextField(changes, "最大输出 Token", model.maxOutputK, current.maxOutput);
  // 套餐积分规则也随官方目录更新（如既有模型新增/变更积分系数），必须参与差异比较，
  // 否则刷新面板判“无变化”，规则永远无法同步进价格中心条目。
  changes.push(...planCreditRuleChanges(compiledEntry?.planCreditRules, current.planCreditRules));
  return changes.length > 0 ? changes : undefined;
}

/**
 * 套餐积分规则的字段级差异（通用方法）：供目标刷新面板与全局目录确认弹窗复用。
 * 逐项比较公式、币种、分母、峰谷窗口、时段倍率、模型系数与限时活动（promotions），
 * 输出人类可读的新旧值摘要；整体相等时返回空数组。
 */
export function planCreditRuleChanges(
  next: PlanCreditRules | undefined,
  previous: ModelPriceEntry["planCreditRules"],
): ProviderCatalogModelChange[] {
  if (samePlanCreditRules(next, previous)) return [];
  const changes: ProviderCatalogModelChange[] = [];
  /* 整组新增/删除（2026-09-30 用户确认）：边界条目必须携带规则具体内容摘要，
     不再只写「已配置」——通知栏读不到任何公式/档位信息等于没通知。 */
  if (next === undefined || previous === undefined) {
    changes.push({
      field: "planCredit.rules",
      label: "套餐积分规则",
      ...(previous !== undefined ? {before: summarizePlanCreditRulesContent(previous)} : {}),
      after: next !== undefined ? summarizePlanCreditRulesContent(next) : "未配置",
      kind: previous !== undefined ? "changed" : "added",
    });
    return changes;
  }
  if (next.formula !== previous.formula) {
    changes.push({field: "planCredit.formula", label: "积分公式", before: previous.formula, after: next.formula, kind: "changed"});
  }
  if ((next.currency ?? "CNY") !== (previous.currency ?? "CNY")) {
    changes.push({field: "planCredit.currency", label: "积分币种", before: previous.currency ?? "CNY", after: next.currency ?? "CNY", kind: "changed"});
  }
  if ((next.unit ?? "") !== (previous.unit ?? "")) {
    changes.push({field: "planCredit.unit", label: "积分/额度单位", before: previous.unit ?? "默认", after: next.unit ?? "默认", kind: "changed"});
  }
  if ((next.divisor ?? 10000) !== (previous.divisor ?? 10000)) {
    changes.push({
      field: "planCredit.divisor",
      label: "系数分母",
      before: String(previous.divisor ?? 10000),
      after: String(next.divisor ?? 10000),
      kind: "changed",
    });
  }
  const previousWindows = canonicalPlanCreditJson(previous.peakWindows ?? []);
  const nextWindows = canonicalPlanCreditJson(next.peakWindows ?? []);
  if (previousWindows !== nextWindows) {
    changes.push({
      field: "planCredit.peakWindows",
      label: "峰谷时段窗口",
      before: summarizePeakWindows(previous.peakWindows),
      after: summarizePeakWindows(next.peakWindows),
      kind: "changed",
    });
  }
  if ((next.offPeakMultiplier ?? 0.5) !== (previous.offPeakMultiplier ?? 0.5)) {
    changes.push({
      field: "planCredit.offPeakMultiplier",
      label: "非高峰倍率",
      before: String(previous.offPeakMultiplier ?? 0.5),
      after: String(next.offPeakMultiplier ?? 0.5),
      kind: "changed",
    });
  }
  const previousQuotaWindows = canonicalPlanCreditJson(previous.quotaWindows ?? []);
  const nextQuotaWindows = canonicalPlanCreditJson(next.quotaWindows ?? []);
  if (previousQuotaWindows !== nextQuotaWindows) {
    changes.push({
      field: "planCredit.quotaWindows",
      label: "额度窗口",
      before: summarizeQuotaWindows(previous.quotaWindows),
      after: summarizeQuotaWindows(next.quotaWindows),
      kind: "changed",
    });
  }
  // 档位额度逐档比较（2026-09-30 market_share 上线补全）：quotaTiers-only 变化
  // （官方调整某档月度额度）此前落不进任何条目 → 刷新面板判「无变化」永远不同步。
  const previousTiers = previous.quotaTiers ?? {};
  const nextTiers = next.quotaTiers ?? {};
  for (const tierId of [...new Set([...Object.keys(previousTiers), ...Object.keys(nextTiers)])].sort()) {
    const before = previousTiers[tierId];
    const after = nextTiers[tierId];
    if (canonicalPlanCreditJson(before) === canonicalPlanCreditJson(after)) continue;
    changes.push({
      field: `planCredit.quotaTiers.${tierId}`,
      label: `档位额度 ${tierId}`,
      ...(before ? {before: summarizeQuotaTier(before, previous.unit)} : {}),
      after: after ? summarizeQuotaTier(after, next.unit) : "移除",
      kind: before ? "changed" : "added",
    });
  }
  // 模型系数逐模型比较
  const previousFactors = previous.modelFactors ?? {};
  const nextFactors = next.modelFactors ?? {};
  const factorModels = [...new Set([...Object.keys(previousFactors), ...Object.keys(nextFactors)])].sort();
  for (const factorModel of factorModels) {
    const before = previousFactors[factorModel];
    const after = nextFactors[factorModel];
    if (canonicalPlanCreditJson(before) === canonicalPlanCreditJson(after)) continue;
    changes.push({
      field: `planCredit.modelFactors.${factorModel}`,
      label: `积分系数 ${factorModel}`,
      ...(before ? {before: summarizeFactor(before)} : {}),
      after: after ? summarizeFactor(after) : "移除",
      kind: before ? "changed" : "added",
    });
  }
  // 限时活动逐条比较（按模型+区间+倍率摘要）
  const previousPromotions = summarizePromotions(previous.promotions ?? []);
  const nextPromotions = summarizePromotions(next.promotions ?? []);
  const promotionKeys = [...new Set([...Object.keys(previousPromotions), ...Object.keys(nextPromotions)])].sort();
  for (const key of promotionKeys) {
    if (previousPromotions[key] === nextPromotions[key]) continue;
    changes.push({
      field: `planCredit.promotion.${key}`,
      label: "积分限时活动",
      ...(previousPromotions[key] ? {before: previousPromotions[key]} : {}),
      after: nextPromotions[key] ?? "移除",
      kind: previousPromotions[key] ? "changed" : "added",
    });
  }
  return changes;
}

function summarizeFactor(factor: {input: number; output: number; cachedInput?: number}): string {
  return `输入×${factor.input} 输出×${factor.output}${factor.cachedInput !== undefined ? ` 缓存×${factor.cachedInput}` : ""}`;
}

function summarizePeakWindows(windows: NonNullable<ModelPriceEntry["planCreditRules"]>["peakWindows"]): string {
  if (!windows || windows.length === 0) return "未配置";
  return windows.map(window => `${(window.days ?? []).join(",")} ${window.start}-${window.end} ×${window.multiplier ?? 1}`).join("；");
}

/** 公式族 → 通知可读名。 */
const PLAN_FORMULA_LABELS: Record<string, string> = {
  token_weighted: "Token 系数加权积分",
  money_to_credits: "金额折积分",
  afp_weighted: "AFP 系数加权积分",
  market_share: "市价份额估算（无逐请求积分）",
};

function moneySymbol(unit: string | undefined): string {
  return unit === "USD" ? "$" : "";
}

function summarizeQuotaWindows(windows: NonNullable<ModelPriceEntry["planCreditRules"]>["quotaWindows"]): string {
  if (!windows || windows.length === 0) return "未配置";
  return windows.map(window => window.label || window.id).join(" / ");
}

function summarizeQuotaTier(
  tier: NonNullable<NonNullable<ModelPriceEntry["planCreditRules"]>["quotaTiers"]>[string],
  unit: string | undefined,
): string {
  const symbol = moneySymbol(unit);
  const quota = Object.entries(tier.quotaByWindow ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([windowId, value]) => `${windowId} ${symbol}${value}`)
    .join(" / ");
  return `额度 ${quota || "未配置"}${tier.monthlyFee !== undefined ? ` · 月费 ${symbol}${tier.monthlyFee}` : ""}`;
}

/** 整组规则的内容摘要（2026-09-30）：新增/删除整组套餐规则时作为通知条目值，读得出公式、单位、窗口与档位额度。 */
function summarizePlanCreditRulesContent(rules: PlanCreditRules): string {
  const parts: string[] = [PLAN_FORMULA_LABELS[rules.formula] ?? rules.formula];
  if (rules.unit) parts.push(`单位 ${rules.unit}`);
  if (rules.divisor !== undefined) parts.push(`分母 ${rules.divisor}`);
  if (rules.quotaWindows?.length) parts.push(`窗口 ${summarizeQuotaWindows(rules.quotaWindows)}`);
  for (const tierId of Object.keys(rules.quotaTiers ?? {}).sort()) {
    const tier = rules.quotaTiers?.[tierId];
    if (tier) parts.push(`档位 ${tierId}：${summarizeQuotaTier(tier, rules.unit)}`);
  }
  const factorCount = Object.keys(rules.modelFactors ?? {}).length;
  if (factorCount > 0) parts.push(`模型系数 ${factorCount} 项`);
  if (rules.promotions?.length) parts.push(`限时活动 ${rules.promotions.length} 条`);
  return parts.join("；");
}

function summarizePromotions(promotions: NonNullable<ModelPriceEntry["planCreditRules"]>["promotions"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const promotion of promotions ?? []) {
    const models = promotion.models && promotion.models.length > 0 ? promotion.models.join("+") : "全部模型";
    // to 缺省 = 官方未公布截止（无限期）；摘要与去重键统一用 "不限" 占位。
    const window = `${promotion.from.slice(0, 10)}~${promotion.to ? promotion.to.slice(0, 10) : "不限"}`;
    // 每日时间窗（如错峰 23:00~次日 09:00）参与键与摘要：同模型同日期区间、不同时段的活动互不撞键。
    const daily = promotion.windows?.length
      ? promotion.windows.map(item => `${(item.days ?? []).join(",")} ${item.start}-${item.end}`).join(";")
      : undefined;
    // 观测通道限定参与键与摘要（2026-09-23）：活动从全通道收窄到仅本地导入是计费语义变化，不得静默。
    const origins = promotion.origins?.length ? promotion.origins.join("|") : undefined;
    const detail = [
      window,
      models,
      ...(daily ? [`每日 ${daily}`] : []),
      ...(origins ? [`通道 ${origins}`] : []),
      ...(promotion.input !== undefined || promotion.output !== undefined
        ? [`系数 ${promotion.input ?? "-"} / ${promotion.output ?? "-"}`] : []),
      ...(promotion.multiplier !== undefined ? [`倍率 ×${promotion.multiplier}`] : []),
      ...(promotion.agents && promotion.agents.length > 0 ? [`限 ${promotion.agents.join("/")}`] : []),
    ].join(" ");
    result[`${models}:${window}${daily ? `#${daily}` : ""}${origins ? `@${origins}` : ""}`] = detail;
  }
  return result;
}

function samePlanCreditRules(
  next: PlanCreditRules | undefined,
  previous: ModelPriceEntry["planCreditRules"],
): boolean {
  if (next === undefined && previous === undefined) return true;
  if (next === undefined || previous === undefined) return false;
  try {
    return canonicalPlanCreditJson(next) === canonicalPlanCreditJson(previous);
  } catch {
    return false;
  }
}

/** 键序稳定的规范化序列化：同内容不同键序判等（供套餐规则与费率/时间线逐档比较共用）。 */
export function canonicalPlanCreditJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function comparePricingField(
  changes: ProviderCatalogModelChange[],
  label: string,
  next: number | undefined,
  previous: number | undefined,
): void {
  if (next === previous) return;
  changes.push({
    field: label,
    label,
    ...(previous === undefined ? {} : {before: `${previous}`}),
    after: next === undefined ? "—" : `${next}`,
    kind: previous === undefined ? "added" : next === undefined ? "removed" : "changed",
  });
}

function compareContextField(
  changes: ProviderCatalogModelChange[],
  label: string,
  nextK: number | undefined,
  previousTokens: number | undefined,
): void {
  const next = nextK === undefined ? undefined : nextK * 1024;
  if (next === previousTokens) return;
  changes.push({
    field: label,
    label,
    ...(previousTokens === undefined ? {} : {before: `${Math.round(previousTokens / 1024)}K`}),
    after: next === undefined ? "—" : `${nextK}K`,
    kind: previousTokens === undefined ? "added" : next === undefined ? "removed" : "changed",
  });
}

function sameSchedules(
  left: TemporalPriceSchedule[] | undefined,
  right: TemporalPriceSchedule[] | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function isModelUsableForAgent(target: ProxyTarget, modelId: string, agent: AgentId): boolean {
  return target.supportedModelScopes?.[modelId]?.includes(agent) === true;
}

/** 替代默认模型可用性：目录新增模型按供应商派生 scope，存量模型按供应商已保存 scope。 */
function replacementUsableForAgent(
  target: ProxyTarget,
  provider: ProviderCatalogProvider,
  modelById: Map<string, ProviderCatalogModel>,
  modelId: string,
  agent: AgentId,
): boolean {
  const catalogModel = modelById.get(modelId);
  if (catalogModel) return supportedAgentsForCatalogModel(provider, catalogModel, target).includes(agent);
  return isModelUsableForAgent(target, modelId, agent);
}
