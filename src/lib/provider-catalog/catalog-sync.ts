/**
 * 官方目录同步分类器（v2 七章，2026-09-10 用户确认「自动生效 + 通知已阅制」，
 * 取代 2026-09-07 四原则确认制）：
 *
 * 1. **自动生效**：目录合法变化（新增/变动）在生效时刻（effectiveFrom，缺省同步时刻）
 *    自动落盘价格中心并追加价格版本，不经人工确认——真实价格调整与用户确认与否无关。
 * 2. **知情通知**：变化生成通知项（未阅 Diff → 已阅历史）；迁移容差内的数值精化
 *    （如 v1 0.67 ↔ v2 2/3）自动更新但不生成通知（防刷屏）。
 * 3. **永不删除**：价格中心有、目录最新版无的条目绝不动。
 * 4. **手工价保护**：`user_override` 两组字段组（payg 价 / plan）优先于官方值；
 *    缺失 planCreditRules 的覆盖条目仍从目录回填（既有修复保持）。
 * 5. **白名单不自动变化**：本模块只作用于价格中心计价数据；目标 supportedModels
 *    走供应商管理页的显式差异确认。
 *
 * 纯函数模块：目录/价格中心/目标使用快照均由调用方注入，供启动同步、1 小时任务、
 * GET 通知栏查询与测试共用（AGENTS.md 模块化公用原则）。
 */

import {
  normalizePricingConfig,
  pricingEntryRuntimeModelId,
  type ModelPriceEntry,
  type PriceRateSegment,
  type PricingCatalogNotificationItem,
  type PricingCatalogUpdateNotification,
  type PricingConfig,
} from "@/lib/pricing";
import {providerCatalogToPricingEntries} from "./pricing";
import {modelFieldChanges, type CatalogPricingFieldChange} from "./pricing-diff";
import {canonicalPlanCreditJson} from "./diff";
import {catalogVersionNotNewer, isValidRfc3339WithZone} from "./catalog-contract";
import {withinMigrationTolerance} from "./rule-dsl";
import type {ProviderCatalog} from "./types";

/** 供应商目标使用快照：isModelInUse(vendor, modelId) → 是否被任一目标使用（通知展示标注）。 */
export interface TargetModelUsage {
  isModelInUse: (vendor: string, modelId: string) => boolean;
}

/** 单模型分类结果。 */
export type CatalogSyncClass =
  | {kind: "unchanged"}
  | {kind: "skipped-override"; backfillPlanRules: boolean}
  | {kind: "insert"; entry: ModelPriceEntry}
  | {kind: "auto-update"; entry: ModelPriceEntry; notify: boolean; changes: CatalogPricingFieldChange[]};

export interface CatalogSyncPlan {
  /** 自动生效集（插入 + 更新）对应的全量目录（merge 消费）。 */
  silentCatalog: ProviderCatalog;
  /** 本版通知（容差过滤后仍有可见变化才生成；已阅由 marker 承载）。 */
  notification: PricingCatalogUpdateNotification | undefined;
  insertCount: number;
  autoUpdateCount: number;
  /** 容差内静默迁移（不生成通知）的条数。 */
  toleranceSilentCount: number;
  changedModelCount: number;
  /** 目录移除已推荐模型导致的推荐集合变化数；不删除价格中心条目。 */
  membershipChangeCount: number;
}

/** 价格中心 catalogSync 标记（runner 写入、GET 读取；LiteLLM 导入不得覆写）。 */
export interface CatalogSyncMarker {
  lastSyncedPublishedAt?: string;
  lastSyncedCatalogRevision?: string;
  /** 源哈希：仅作同步元数据记录（诊断「上次同步吃的是什么内容」），不作为闸门放行依据。 */
  lastSyncedSourceHash?: string;
  syncedAt?: string;
  notifications?: PricingCatalogUpdateNotification[];
}

export const MAX_CATALOG_NOTIFICATIONS = 50;

/**
 * 版本闸门（2026-09-21 用户决策收紧为严格版本制，取代 2026-09-10 的源哈希放行条款）：
 * 目录版本 + 发布时间**均大于**上次同步才接收并进价格中心及后链路；同版本的内容/源哈希
 * 变化一律跳过。任何内容修改必须升版发布并经通知让用户知情——杜绝两类已发生/将发生的事故：
 * ① 远程同版本旧内容恢复可达后覆盖本地新数据（旧内容经调和进入 catalog 再整体替换价格中心）；
 * ② 内容变化进了价格中心但通知被同版本 revision 幂等吞掉（生效但不点亮）。
 * 旧格式 marker（空格分隔 publishedAt、非 RFC 3339）视为不存在——v2 切换即重置（验收用例 16）。
 */
export function shouldSkipCatalogSync(
  marker: CatalogSyncMarker | undefined,
  catalog: ProviderCatalog,
): boolean {
  if (!marker?.lastSyncedPublishedAt) return false;
  if (!isValidRfc3339WithZone(marker.lastSyncedPublishedAt)) return false;
  return catalogVersionNotNewer(marker, catalog);
}

/** 追加通知并按界保留：未阅优先，超出上限裁剪最老的已阅（未阅不被裁剪）。 */
export function appendCatalogNotification(
  marker: CatalogSyncMarker | undefined,
  notification: PricingCatalogUpdateNotification,
): PricingCatalogUpdateNotification[] {
  const existing = marker?.notifications ?? [];
  const merged = [notification, ...existing.filter(item => item.catalogRevision !== notification.catalogRevision)];
  if (merged.length <= MAX_CATALOG_NOTIFICATIONS) return merged;
  const unacked = merged.filter(item => item.ackedAt === undefined);
  const acked = merged.filter(item => item.ackedAt !== undefined);
  const budget = Math.max(0, MAX_CATALOG_NOTIFICATIONS - unacked.length);
  return [...unacked, ...acked.slice(0, budget)];
}

/**
 * 自动生效分类：目录每个供应商 × 模型与价格中心对比，产出全量应用集与通知项。
 * user_override 条目跳过（planCreditRules 回填除外）；迁移容差内静默。
 */
export function classifyCatalogSync(
  currentConfig: PricingConfig,
  catalog: ProviderCatalog,
  usage: TargetModelUsage,
  previousOfficialMembership: ReadonlySet<string> = new Set(),
): CatalogSyncPlan {
  const current = normalizePricingConfig(currentConfig);
  const byIdentity = new Map<string, ModelPriceEntry>();
  for (const entry of current.models) {
    byIdentity.set(pricingIdentityOf(entry), entry);
  }

  const catalogEntries = providerCatalogToPricingEntries(catalog);
  const applyKeys = new Set<string>(); // "pricingProviderId/modelId"（filterCatalogByModels 键）
  const items: PricingCatalogNotificationItem[] = [];
  const providerNames = new Map<string, string>();
  for (const provider of Object.values(catalog.providers)) {
    providerNames.set(provider.pricingProviderId, provider.name);
  }
  let insertCount = 0;
  let autoUpdateCount = 0;
  let toleranceSilentCount = 0;
  let membershipChangeCount = 0;
  const effectiveFroms: string[] = [];
  const catalogIdentities = new Set(catalogEntries.map(entry => pricingIdentityOf(entry)));

  for (const catalogEntry of catalogEntries) {
    const modelId = pricingEntryRuntimeModelId(catalogEntry);
    const identity = pricingIdentityOf(catalogEntry);
    const existing = byIdentity.get(identity);
    const key = `${catalogEntry.vendor}/${modelId}`;
    for (const segment of catalogEntry.rateTimeline ?? []) {
      if (segment.effectiveFrom) effectiveFroms.push(segment.effectiveFrom);
    }

    if (!existing) {
      applyKeys.add(key);
      insertCount += 1;
      items.push(notificationItem(catalogEntry, providerNames, modelId, addedModelChanges(catalogEntry), usage, changeSegmentOf(catalogEntry)));
      continue;
    }
    if (existing.confidence === "user_override") {
      // 手工价赢，但官方能力/套餐规则仍需跟随。只把官方跟随字段加入应用集，
      // 避免把用户手工 payg 价格差异伪装成官方价格更新。
      const changes = modelFieldChanges(catalogEntry, existing).filter(change =>
        isOfficialFollowChangeField(change.field));
      if (changes.length === 0) continue;
      applyKeys.add(key);
      autoUpdateCount += 1;
      items.push(notificationItem(catalogEntry, providerNames, modelId, changes, usage, changeSegmentOf(catalogEntry)));
      continue;
    }

    const changes = modelFieldChanges(catalogEntry, existing);
    if (changes.length === 0) continue;

    applyKeys.add(key);
    autoUpdateCount += 1;
    if (migrationEquivalentWithinTolerance(catalogEntry, existing)) {
      // 数值精化在容差内：自动更新、不生成通知（防 0.67 ↔ 2/3 分数精化刷屏）。
      toleranceSilentCount += 1;
      continue;
    }
    items.push(notificationItem(catalogEntry, providerNames, modelId, changes, usage, changeSegmentOf(catalogEntry)));
  }

  for (const existing of current.models) {
    const identity = pricingIdentityOf(existing);
    if (catalogIdentities.has(identity)) continue;
    const runtimeModelId = pricingEntryRuntimeModelId(existing).trim().toLowerCase();
    const vendor = existing.vendor.trim().toLowerCase();
    const wasCurrentOfficial = [...previousOfficialMembership].some(identity => {
      const [catalogKey, pricingProviderId, modelId] = identity.split("\u0000");
      return catalogKey !== undefined
        && pricingProviderId === vendor
        && modelId === runtimeModelId;
    });
    if (!wasCurrentOfficial) continue;
    membershipChangeCount += 1;
    items.push({
      vendor: existing.vendor,
      providerName: existing.vendor,
      modelId: pricingEntryRuntimeModelId(existing),
      changes: [{
        field: "officialCatalogMembership",
        label: "官方推荐集合",
        before: "当前目录推荐",
        after: "从当前目录移除（存量条目保留）",
        kind: "removed",
      }],
      ...(usage.isModelInUse(existing.vendor, pricingEntryRuntimeModelId(existing)) ? {inUse: true} : {}),
    });
  }

  const changedModelCount = items.length;
  return {
    silentCatalog: filterCatalogByModelKeys(catalog, applyKeys),
    notification: changedModelCount > 0
      ? {
        catalogRevision: catalog.catalogRevision,
        publishedAt: catalog.publishedAt,
        createdAt: new Date().toISOString(),
        ...(effectiveFroms.length > 0 ? {effectiveFrom: [...effectiveFroms].sort()[0]} : {}),
        items,
      }
      : undefined,
    insertCount,
    autoUpdateCount,
    toleranceSilentCount,
    changedModelCount,
    membershipChangeCount,
  };
}

/** user_override 保护 payg 价格，但官方能力/套餐链仍然自动跟随。 */
function isOfficialFollowChangeField(field: string): boolean {
  return field === "contextWindow"
    || field === "maxOutput"
    || field === "supportedWireApis"
    || field === "inputModalities"
    || field === "serviceTierPricing"
    || field.startsWith("priceSchedules.")
    || field.startsWith("rateTimeline.")
    || field.startsWith("planCredit.");
}

function notificationItem(
  entry: ModelPriceEntry,
  providerNames: Map<string, string>,
  modelId: string,
  changes: CatalogPricingFieldChange[],
  usage: TargetModelUsage,
  lastChangeSegment?: PriceRateSegment,
): PricingCatalogNotificationItem {
  return {
    vendor: entry.vendor,
    providerName: providerNames.get(entry.vendor) ?? entry.vendor,
    modelId,
    changes,
    ...(entry.rateTimeline?.length ? {rateTimeline: entry.rateTimeline} : {}),
    ...(lastChangeSegment?.effectiveFrom ? {effectiveFrom: lastChangeSegment.effectiveFrom} : {}),
    ...(lastChangeSegment?.changeNote ? {changeNote: lastChangeSegment.changeNote} : {}),
    ...(usage.isModelInUse(entry.vendor, modelId) ? {inUse: true} : {}),
  };
}

/** 本次变化的公告段：时间线中最近一条带 changeNote 的段（无则取最后一段）。 */
function changeSegmentOf(entry: ModelPriceEntry): PriceRateSegment | undefined {
  const timeline = entry.rateTimeline;
  if (!timeline?.length) return undefined;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]!.changeNote) return timeline[index];
  }
  return timeline[timeline.length - 1];
}

function addedModelChanges(entry: ModelPriceEntry): CatalogPricingFieldChange[] {
  const pricing = entry.pricing;
  const changes: CatalogPricingFieldChange[] = [];
  if (pricing) {
    changes.push({field: "input", label: "非缓存输入价", after: `${pricing.input}/M`, kind: "added"});
    changes.push({field: "output", label: "输出价", after: `${pricing.output}/M`, kind: "added"});
    if (pricing.cachedInput !== undefined) changes.push({field: "cachedInput", label: "缓存命中价", after: `${pricing.cachedInput}/M`, kind: "added"});
    if (pricing.cacheWrite !== undefined) changes.push({field: "cacheWrite", label: "缓存写入价", after: `${pricing.cacheWrite}/M`, kind: "added"});
  }
  if (entry.priceSchedules?.length) {
    changes.push({field: "priceSchedules", label: "时段费率", after: summarizeSchedules(entry), kind: "added"});
  }
  if (entry.planCreditRules) {
    changes.push({field: "planCreditRules", label: "套餐积分规则", after: entry.planCreditRules.formula, kind: "added"});
  }
  return changes;
}

function summarizeSchedules(entry: ModelPriceEntry): string {
  return (entry.priceSchedules ?? []).map(schedule =>
    `${schedule.label} ${schedule.rates.input ?? "-"}/${schedule.rates.output ?? "-"}${schedule.rates.cachedInput !== undefined ? `/缓存${schedule.rates.cachedInput}` : ""}`).join("；") || "未配置";
}

/**
 * 迁移等价判定（深检 2）：payg 价组与 plan 组数值对比施加容差
 * （绝对差 ≤ 0.01 或相对差 ≤ 0.5%，取大者），覆盖 v1 0.67 ↔ v2 2/3 分数精化；
 * 结构性差异（能力字段/协议/时间线/促销限定/窗口集合、公式、活动边界）不在容差内。
 *
 * 2026-09-23 事故修复：容差曾只比较价格四组——「价格不变、仅 inputModalities 被
 * 目录回退删除」的 17 条变化全部被误判等价而静默，且 merge 照常执行，能力数据被
 * 抹掉却无任何通知（违反「无论任何修改走通知」红线）。结构性字段必须精确比较。
 * 2026-09-30 补 longContext：OpenCode Go .04 的 3 条长档 cacheWrite 新增因顶层价格
 * 全等被判容差内静默——长档是结构性价格字段，必须精确比较、绝不静默。
 */
export function migrationEquivalentWithinTolerance(next: ModelPriceEntry, previous: ModelPriceEntry): boolean {
  if (JSON.stringify(next.inputModalities ?? null) !== JSON.stringify(previous.inputModalities ?? null)) return false;
  if (JSON.stringify(next.supportedWireApis ?? null) !== JSON.stringify(previous.supportedWireApis ?? null)) return false;
  if ((next.contextWindow ?? 0) !== (previous.contextWindow ?? 0)) return false;
  if ((next.maxOutput ?? 0) !== (previous.maxOutput ?? 0)) return false;
  if (JSON.stringify(next.pricing?.longContext ?? null) !== JSON.stringify(previous.pricing?.longContext ?? null)) return false;
  if (next.rateTimeline?.length || previous.rateTimeline?.length) {
    if ((next.rateTimeline?.length ?? 0) !== (previous.rateTimeline?.length ?? 0)) return false;
    for (let index = 0; index < next.rateTimeline!.length; index += 1) {
      if (canonicalPlanCreditJson(next.rateTimeline![index]) !== canonicalPlanCreditJson(previous.rateTimeline![index])) return false;
    }
  }
  if (!ratesEquivalent(next.pricing, previous.pricing)) return false;
  if (!schedulesEquivalent(next.priceSchedules, previous.priceSchedules)) return false;
  if (!paygPromotionsEquivalent(next.promotions, previous.promotions)) return false;
  if (!serviceTierPricingEquivalent(next.serviceTierPricing, previous.serviceTierPricing)) return false;
  return planRulesEquivalent(next.planCreditRules, previous.planCreditRules);
}

/** 服务档位倍率等价（2026-10-08 盲点修复）：fastMultiplier 出现/消失/变化都属
 *  计费相关变化，不得静默——仅在数值容差内判等价（与价格四价同规则）。 */
function serviceTierPricingEquivalent(
  next: ModelPriceEntry["serviceTierPricing"],
  previous: ModelPriceEntry["serviceTierPricing"],
): boolean {
  if ((next === undefined) !== (previous === undefined)) return false;
  if (!next || !previous) return true;
  return toleranceEqual(next.fastMultiplier, previous.fastMultiplier);
}

function ratesEquivalent(
  next: ModelPriceEntry["pricing"],
  previous: ModelPriceEntry["pricing"],
): boolean {
  if ((next === undefined) !== (previous === undefined)) return false;
  if (!next || !previous) return true;
  return toleranceEqual(next.input, previous.input)
    && toleranceEqual(next.output, previous.output)
    && toleranceEqual(next.cachedInput, previous.cachedInput)
    && toleranceEqual(next.cacheWrite, previous.cacheWrite);
}

/** payg 促销（Campaign 投影）等价：按（区间/Agent/观测通道）键配对，实扣价/倍率容差；标签差异视为等价。 */
function paygPromotionsEquivalent(
  next: ModelPriceEntry["promotions"],
  previous: ModelPriceEntry["promotions"],
): boolean {
  if ((next?.length ?? 0) !== (previous?.length ?? 0)) return false;
  const nextMap = new Map((next ?? []).map(promotion => [
    promotionPairKey(promotion),
    promotion,
  ]));
  for (const promotion of previous ?? []) {
    const candidate = nextMap.get(promotionPairKey(promotion));
    if (!candidate) return false;
    const left = candidate.priceOverride;
    const right = promotion.priceOverride;
    if ((left === undefined) !== (right === undefined)) return false;
    if (left && right
      && (!toleranceEqual(left.input, right.input)
        || !toleranceEqual(left.output, right.output)
        || !toleranceEqual(left.cachedInput, right.cachedInput)
        || !toleranceEqual(left.cacheWrite, right.cacheWrite))) return false;
    if (!toleranceEqual(candidate.multiplier, promotion.multiplier)) return false;
  }
  return true;
}

function schedulesEquivalent(
  next: ModelPriceEntry["priceSchedules"],
  previous: ModelPriceEntry["priceSchedules"],
): boolean {
  if ((next?.length ?? 0) !== (previous?.length ?? 0)) return false;
  for (let index = 0; index < (next?.length ?? 0); index += 1) {
    const left = next![index]!;
    const right = previous![index]!;
    if (left.label !== right.label || (left.timezone ?? "Asia/Shanghai") !== (right.timezone ?? "Asia/Shanghai")) return false;
    if (JSON.stringify(left.windows) !== JSON.stringify(right.windows)) return false;
    if (!ratesEquivalent(left.rates, right.rates)) return false;
  }
  return true;
}

function planRulesEquivalent(
  next: ModelPriceEntry["planCreditRules"],
  previous: ModelPriceEntry["planCreditRules"],
): boolean {
  if ((next === undefined) !== (previous === undefined)) return false;
  if (!next || !previous) return true;
  if (next.formula !== previous.formula) return false;
  if ((next.divisor ?? 10000) !== (previous.divisor ?? 10000)) return false;
  if ((next.creditsPerCurrency ?? 0) !== (previous.creditsPerCurrency ?? 0)
    && !toleranceEqual(next.creditsPerCurrency ?? 0, previous.creditsPerCurrency ?? 0)) return false;
  const nextFactors = next.modelFactors ?? {};
  const previousFactors = previous.modelFactors ?? {};
  for (const modelId of new Set([...Object.keys(nextFactors), ...Object.keys(previousFactors)])) {
    const left = nextFactors[modelId];
    const right = previousFactors[modelId];
    if ((left === undefined) !== (right === undefined)) return false;
    if (!left || !right) continue;
    if (!toleranceEqual(left.input, right.input) || !toleranceEqual(left.output, right.output)
      || !toleranceEqual(left.cachedInput, right.cachedInput)) return false;
  }
  // 活动倍率按（模型/区间/Agent）键配对容差比较；条数或键不一致视为非等价。
  const nextPromotions = promotionMultiplierMap(next.promotions ?? []);
  const previousPromotions = promotionMultiplierMap(previous.promotions ?? []);
  const keys = new Set([...Object.keys(nextPromotions), ...Object.keys(previousPromotions)]);
  for (const key of keys) {
    const left = nextPromotions[key];
    const right = previousPromotions[key];
    if (left === undefined || right === undefined) return false;
    if (!toleranceEqual(left, right)) return false;
  }
  return true;
}

function promotionPairKey(promotion: {from: string; to?: string; agents?: string[]; origins?: string[]}): string {
  // 观测通道限定（origins）参与配对键：同一活动「全通道 → 仅本地导入」是结构性变化，
  // 不适用数值容差静默（与 diff/摘要键同构，2026-09-23 补齐）。
  return `${promotion.from}~${promotion.to ?? "不限"}:${(promotion.agents ?? []).join("/")}:${(promotion.origins ?? []).join("|")}`;
}

function promotionMultiplierMap(promotions: NonNullable<ModelPriceEntry["planCreditRules"]>["promotions"]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const promotion of promotions ?? []) {
    const models = promotion.models?.length ? promotion.models.join("+") : "全部模型";
    const window = `${promotion.from.slice(0, 10)}~${promotion.to ? promotion.to.slice(0, 10) : "不限"}`;
    const agents = promotion.agents?.length ? promotion.agents.join("/") : "全部Agent";
    const origins = promotion.origins?.length ? promotion.origins.join("|") : "全通道";
    result[`${models}:${window}:${agents}:${origins}`] = promotion.multiplier ?? 1;
  }
  return result;
}

function toleranceEqual(left: number | undefined, right: number | undefined): boolean {
  // 字段存在性必须一致：新增/消失字段属结构性变化，不适用数值容差。
  if ((left === undefined) !== (right === undefined)) return false;
  if (left === undefined || right === undefined) return true;
  return withinMigrationTolerance(left, right);
}

/** 价格中心唯一键（与合并/diff 保持一致）：vendor + runtimeModelId，小写归一。 */
function pricingIdentityOf(entry: ModelPriceEntry): string {
  const runtimeModelId = pricingEntryRuntimeModelId(entry);
  return `${entry.vendor.trim().toLowerCase()}\u0000${runtimeModelId.trim().toLowerCase()}`;
}

/** 按键集 "pricingProviderId/modelId" 过滤目录（无命中模型的供应商整行剔除）。
 *  与 catalog-filter.ts 的 filterCatalogByModels 同构；此处直接复用其实现。 */
import {filterCatalogByModels} from "./catalog-filter";
function filterCatalogByModelKeys(catalog: ProviderCatalog, keys: Set<string>): ProviderCatalog {
  if (keys.size === 0) return {...catalog, providers: {}};
  return filterCatalogByModels(catalog, keys);
}
