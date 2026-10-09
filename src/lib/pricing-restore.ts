import {normalizePricingConfig, pricingEntryRuntimeModelId, type ModelPriceEntry, type PricingConfig, type PricingConfigV2} from "@/lib/pricing";
import {providerCatalogToPricingEntries} from "@/lib/provider-catalog/pricing";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {resolveLatestPricingSource} from "@/lib/pricing/source-baseline-store";
import type {ProviderCatalog, ProviderCatalogEnvelope} from "@/lib/provider-catalog/types";
import type {ProxyConfig, ProxyTarget} from "@/types";

export type RestoreSource =
  | {
      kind: "catalog";
      catalog: ProviderCatalog;
      sourceRevision?: string;
      sourceHash?: string;
      capturedAt?: string;
    }
  | {
      kind: "litellm";
      entry: ModelPriceEntry;
      sourceRevision?: string;
      sourceHash?: string;
      capturedAt?: string;
    }
  | {
      kind: "official_baseline";
      entry: ModelPriceEntry;
      sourceRevision?: string;
      sourceHash?: string;
      capturedAt?: string;
    }
  | {
      kind: "litellm_baseline";
      entry: ModelPriceEntry;
      sourceRevision?: string;
      sourceHash?: string;
      capturedAt?: string;
    };

export type RestoreSourceState =
  | "current_official"
  | "historical_official"
  | "litellm_baseline"
  | "litellm_snapshot";

export interface RestoreAvailability {
  source: "official" | "litellm";
  sourceState: RestoreSourceState;
  sourceRevision?: string;
  sourceHash?: string;
  sourceCapturedAt?: string;
  targetOverrides?: TargetPricingOverrideOwner[];
}

export interface PricingRestoreIdentity {
  vendor: string;
  runtimeModelId: string;
}

/** 从官方目录中按供应商 + 模型 ID 定位恢复来源；Provider 元数据随条目一并保留。 */
export function findRestoreSourceInCatalog(
  envelope: ProviderCatalogEnvelope,
  identity: PricingRestoreIdentity,
): RestoreSource | undefined {
  const vendor = identity.vendor.trim().toLowerCase();
  for (const [catalogKey, provider] of Object.entries(envelope.catalog.providers)) {
    if (provider.pricingProviderId.trim().toLowerCase() !== vendor) continue;
    const model = provider.models.find(item => item.id === identity.runtimeModelId);
    if (!model) continue;
    return {
      kind: "catalog",
      sourceRevision: envelope.catalog.catalogRevision,
      sourceHash: envelope.sourceHash,
      capturedAt: envelope.catalog.publishedAt,
      catalog: {
        schemaVersion: envelope.catalog.schemaVersion,
        catalogRevision: envelope.catalog.catalogRevision,
        publishedAt: envelope.catalog.publishedAt,
        providers: {[catalogKey]: {...provider, models: [model]}},
        ...(envelope.catalog.fx ? {fx: envelope.catalog.fx} : {}),
        ...(envelope.catalog.calendars ? {calendars: envelope.catalog.calendars} : {}),
      },
    };
  }
  return undefined;
}

/** 从随包 LiteLLM 快照中按供应商 + 运行时模型 ID 定位恢复来源。 */
export function findRestoreSourceInLiteLLM(
  snapshot: PricingConfigV2,
  identity: PricingRestoreIdentity,
): RestoreSource | undefined {
  const entry = findPricingEntry(snapshot, identity);
  return entry ? {
    kind: "litellm",
    entry,
    sourceHash: snapshot.catalogSource?.hash,
    capturedAt: snapshot.catalogSource?.fetchedAt,
  } : undefined;
}

export function findRestoreSourceInBaseline(
  db: DeepaaDatabase,
  identity: PricingRestoreIdentity,
): RestoreSource | undefined {
  const baseline = resolveLatestPricingSource(db, identity.vendor, identity.runtimeModelId);
  if (!baseline) return undefined;
  return {
    kind: baseline.sourceKind === "official" ? "official_baseline" : "litellm_baseline",
    entry: baseline.entry,
    sourceRevision: baseline.sourceRevision,
    sourceHash: baseline.sourceHash,
    capturedAt: baseline.capturedAt,
  };
}

/**
 * 兼容来源底稿表启用前的旧价格文件：
 * - 价格文件总来源为 LiteLLM，且条目存在 previousPricing 时，将其视为旧 LiteLLM 底稿；
 * - 官方条目被人工覆盖且保留 catalog 标记时，将 previousPricing 视为旧官方底稿。
 *
 * 这是一次性兼容推断，不会把推断结果自动写回底稿表；用户执行取消手工覆盖后，
 * 后续官方/LiteLLM 同步会按新规则维护正式底稿。
 */
export function findPersistedRestoreSources(
  config: PricingConfigV2,
  entry: ModelPriceEntry,
): {official?: RestoreSource; litellm?: RestoreSource} {
  if (!entry.previousPricing) return {};
  const {previousPricing: _previousPricing, ...entryWithoutPreviousPricing} = entry;
  const baselineEntry = {
    ...entryWithoutPreviousPricing,
    pricing: entry.previousPricing,
  };
  const official = entry.catalogSource === "catalog"
    ? {
        kind: "official_baseline" as const,
        entry: {
          ...baselineEntry,
          confidence: "official" as const,
          catalogSource: "catalog" as const,
        },
        sourceRevision: entry.catalogRevision,
        sourceHash: entry.catalogSourceHash,
        capturedAt: entry.sourceCheckedAt,
      }
    : undefined;
  const litellm = config.catalogSource?.type === "litellm"
    ? {
        kind: "litellm_baseline" as const,
        entry: {
          ...baselineEntry,
          confidence: "third_party" as const,
          catalogSource: undefined,
        },
        sourceHash: config.catalogSource.hash,
        capturedAt: config.catalogSource.fetchedAt,
      }
    : undefined;
  return {official, litellm};
}

export interface TargetPricingOverrideOwner {
  targetId: string;
  targetName: string;
  targetModelId: string;
}

/**
 * 把恢复来源转换为页面可展示的来源状态，并附带目标级覆盖拥有者。
 * 该函数只做展示投影，不改变恢复优先级或任何持久化数据。
 */
export function describeRestoreSource(
  source: RestoreSource | undefined,
  targetOverrides: TargetPricingOverrideOwner[] = [],
): RestoreAvailability | undefined {
  if (!source) return undefined;
  const sourceState: RestoreSourceState = source.kind === "catalog"
    ? "current_official"
    : source.kind === "official_baseline"
      ? "historical_official"
      : source.kind === "litellm_baseline"
        ? "litellm_baseline"
        : "litellm_snapshot";
  return {
    source: source.kind === "catalog" || source.kind === "official_baseline" ? "official" : "litellm",
    sourceState,
    ...(source.sourceRevision ? {sourceRevision: source.sourceRevision} : {}),
    ...(source.sourceHash ? {sourceHash: source.sourceHash} : {}),
    ...(source.capturedAt ? {sourceCapturedAt: source.capturedAt} : {}),
    ...(targetOverrides.length > 0 ? {targetOverrides} : {}),
  };
}

export interface RestoreSourceCandidates {
  currentCatalogSource?: RestoreSource;
  baselineSource?: RestoreSource;
  persistedOfficialSource?: RestoreSource;
  persistedLiteLLMSource?: RestoreSource;
  liteLLMSource?: RestoreSource;
}

/**
 * 统一恢复来源优先级：当前官方 > 历史官方底稿 > LiteLLM 底稿/快照。
 * baselineSource 只允许在其类别对应的位置参与，避免 LiteLLM 底稿抢在历史官方前面。
 */
export function selectRestoreSource(candidates: RestoreSourceCandidates): RestoreSource | undefined {
  const {
    currentCatalogSource,
    baselineSource,
    persistedOfficialSource,
    persistedLiteLLMSource,
    liteLLMSource,
  } = candidates;
  return currentCatalogSource
    || (baselineSource?.kind === "official_baseline" ? baselineSource : undefined)
    || persistedOfficialSource
    || (baselineSource?.kind === "litellm_baseline" ? baselineSource : undefined)
    || persistedLiteLLMSource
    || liteLLMSource;
}

export function findTargetPricingOverrideOwners(
  config: ProxyConfig,
  entry: ModelPriceEntry,
): TargetPricingOverrideOwner[] {
  const vendor = entry.vendor.trim().toLowerCase();
  const runtimeModelId = pricingEntryRuntimeModelId(entry).trim().toLowerCase();
  return config.targets.flatMap(target => {
    const mapping = target.pricing?.modelVendors || {};
    return target.supportedModels.flatMap(targetModelId => {
      const modelMapping = mapping[targetModelId];
      const identityMatches = modelMapping?.priceEntryId === entry.id
        || (modelMapping?.vendor?.trim().toLowerCase() === vendor
          && targetModelId.trim().toLowerCase() === runtimeModelId);
      if (!identityMatches) return [];
      const hasOverride = target.pricing?.modelOverrides?.some(item => item.targetModelId === targetModelId);
      return hasOverride ? [{
        targetId: target.id,
        targetName: target.name,
        targetModelId,
      }] : [];
    });
  });
}

/** 在原条目身份上直接替换单条来源，永久保留原 priceEntryId，不触发全目录 membership 投影。 */
export function restorePricingEntry(
  current: PricingConfig,
  source: RestoreSource,
  identity: PricingRestoreIdentity,
): {config: PricingConfigV2; entry: ModelPriceEntry} {
  const previous = normalizePricingConfig(current);
  const previousEntry = findPricingEntry(previous, identity);
  if (!previousEntry) throw new Error("PRICE_ENTRY_NOT_FOUND");
  const sourceEntry = source.kind === "catalog"
    ? providerCatalogToPricingEntries(source.catalog).find(entry =>
        entry.vendor.trim().toLowerCase() === identity.vendor.trim().toLowerCase()
        && pricingEntryRuntimeModelId(entry).trim().toLowerCase() === identity.runtimeModelId.trim().toLowerCase())
    : source.entry;
  if (!sourceEntry) throw new Error("RESTORE_SOURCE_NOT_FOUND");
  const entry = {...sourceEntry, id: previousEntry.id};
  const finalConfig: PricingConfigV2 = {
    ...previous,
    models: previous.models.map(item =>
      pricingEntryRuntimeModelId(item).trim().toLowerCase() === identity.runtimeModelId.trim().toLowerCase()
      && item.vendor.trim().toLowerCase() === identity.vendor.trim().toLowerCase()
        ? entry
        : item),
  };
  const restored = findPricingEntry(finalConfig, identity);
  if (!restored) throw new Error("RESTORE_SOURCE_NOT_FOUND");
  return {config: finalConfig, entry: restored};
}

/** 把引用旧条目的供应商映射全部改绑到恢复后的条目；未引用的供应商保持原样。 */
export function repairTargetModelVendors(
  config: ProxyConfig,
  oldEntry: ModelPriceEntry,
  restoredEntry: ModelPriceEntry,
): {targets: ProxyTarget[]; affectedTargetIds: string[]} {
  const affectedTargetIds: string[] = [];
  const oldRuntimeModelId = pricingEntryRuntimeModelId(oldEntry).trim().toLowerCase();
  const oldVendor = oldEntry.vendor.trim().toLowerCase();
  const targets = config.targets.map(target => {
    const modelVendors = {...(target.pricing?.modelVendors || {})};
    let changed = false;
    for (const [modelId, mapping] of Object.entries(modelVendors)) {
      if (!mapping) continue;
      const identityHit = mapping.priceEntryId === oldEntry.id
        || (mapping.vendor
          && mapping.vendor.trim().toLowerCase() === oldVendor
          && modelId.trim().toLowerCase() === oldRuntimeModelId);
      if (!identityHit) continue;
      const nextMapping = {vendor: restoredEntry.vendor, priceEntryId: restoredEntry.id};
      if (mapping.vendor === nextMapping.vendor && mapping.priceEntryId === nextMapping.priceEntryId) continue;
      modelVendors[modelId] = nextMapping;
      changed = true;
    }
    if (!changed) return target;
    affectedTargetIds.push(target.id);
    return {
      ...target,
      pricing: {...target.pricing, modelVendors},
    };
  });
  return {targets, affectedTargetIds};
}

export function findPricingEntry(
  config: PricingConfig,
  identity: PricingRestoreIdentity,
): ModelPriceEntry | undefined {
  const models = normalizePricingConfig(config).models;
  const vendor = identity.vendor.trim().toLowerCase();
  const modelId = identity.runtimeModelId.trim().toLowerCase();
  return models.find(entry =>
    entry.vendor.trim().toLowerCase() === vendor
    && pricingEntryRuntimeModelId(entry).trim().toLowerCase() === modelId);
}

/** 返回引用指定价格条目的代理供应商清单；命中价格条目 ID 或供应商 + 运行时模型 ID 两种引用方式。 */
export function findReferencingTargets(
  config: {targets: Array<{id: string; name: string; pricing?: {modelVendors?: Record<string, {vendor?: string; priceEntryId?: string}>}}>},
  entry: ModelPriceEntry,
): Array<{id: string; name: string; models: string[]}> {
  const runtimeModelId = pricingEntryRuntimeModelId(entry).trim().toLowerCase();
  const vendor = entry.vendor.trim().toLowerCase();
  return config.targets.flatMap(target => {
    const models = Object.entries(target.pricing?.modelVendors || {})
      .filter(([modelId, mapping]) => {
        if (!mapping) return false;
        if (mapping.priceEntryId === entry.id) return true;
        return Boolean(mapping.vendor
          && mapping.vendor.trim().toLowerCase() === vendor
          && modelId.trim().toLowerCase() === runtimeModelId);
      })
      .map(([modelId]) => modelId);
    return models.length > 0 ? [{id: target.id, name: target.name, models}] : [];
  });
}
