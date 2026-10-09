import {createHash} from "node:crypto";
import {normalizePricingConfig, pricingEntryRuntimeModelId, type ModelPriceEntry, type PricingConfig, type PricingConfigV2} from "@/lib/pricing";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import type {ProxyTarget, ProxyTargetModelVendor} from "@/types";
import {PROVIDER_CATALOG_REMOTE_URL} from "./cache";
import {compileProviderCatalog} from "./compiler";
import type {ProviderCatalog} from "./types";

const PROVIDER_CATALOG_URL = PROVIDER_CATALOG_REMOTE_URL;

/**
 * 价格中心供应商改名表（2026-09-29 用户确认）：中国区 vendor key 加 -cn 后缀，
 * 与 LiteLLM（USD）及未来美元区官方预设的同名 vendor key 保持隔离。目录合并时把
 * 旧 vendor 名下的官方目录条目（catalog 来源）整体迁往新 vendor：条目内部 id 与
 * 既有目标映射（按条目 ID 精确解析）保持不变，官方目标在下一次配置保存时经
 * reconcileOfficialTargetModelVendors 自动改绑到新 vendor；LiteLLM 与用户手工
 * 条目不属于目录来源，一律不动。
 */
const CATALOG_VENDOR_RENAMES: Readonly<Record<string, string>> = {
  deepseek: "deepseek-cn",
  qwenai: "qwenai-cn",
  dashscope: "qwenai-cn",
};

/**
 * 价格中心模型 ID 改名表（2026-09-30）：目录修正了与官方 API/LiteLLM 键不一致的
 * 模型拼写（Anthropic API ID 为连字符形式），旧点号条目在合并时按 vendor+旧 runtime
 * ID 迁移到新 ID，与 LiteLLM 同键条目重新合并为单条，消除重复；条目内部 id 保留
 * （既有目标映射按条目 ID 精确解析，不因改名失效）。LiteLLM 与用户手工条目不动。
 */
const CATALOG_MODEL_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  anthropic: {"claude-sonnet-5.5": "claude-sonnet-5-5"},
};

function rehomeRenamedCatalogVendor(entry: ModelPriceEntry): ModelPriceEntry {
  if (entry.catalogSource !== "catalog" || entry.confidence !== "official") return entry;
  const renamed = CATALOG_VENDOR_RENAMES[entry.vendor.trim().toLowerCase()];
  if (!renamed) return applyCatalogModelRename(entry);
  return applyCatalogModelRename({...entry, vendor: renamed, pricingProviderId: renamed});
}

/** 目录来源条目按改名表迁移 runtime ID（match/patterns 同步改写；内部 id 与 aliases 不动）。 */
function applyCatalogModelRename(entry: ModelPriceEntry): ModelPriceEntry {
  if (entry.catalogSource !== "catalog" || entry.confidence !== "official") return entry;
  const renames = CATALOG_MODEL_RENAMES[entry.vendor.trim().toLowerCase()];
  if (!renames) return entry;
  const current = pricingEntryRuntimeModelId(entry).trim();
  const renamed = renames[current.toLowerCase()];
  if (!renamed || renamed.toLowerCase() === current.toLowerCase()) return entry;
  return {
    ...entry,
    ...(entry.runtimeModelId !== undefined ? {runtimeModelId: renamed} : {}),
    match: renamed,
    patterns: (entry.patterns?.length ? entry.patterns : [current]).map(pattern =>
      pattern.trim().toLowerCase() === current.toLowerCase() ? renamed : pattern),
  };
}

/** 把项目维护的官方目录中可计价模型编译为价格中心条目（v2：消费编译投影）。 */
export function providerCatalogToPricingEntries(
  catalog: ProviderCatalog,
  options: {sourceHash?: string} = {},
): ModelPriceEntry[] {
  return compileProviderCatalog(catalog, options).entries;
}

/**
 * 按供应商 + 运行时模型 ID 增量合并官方目录：历史模型不因目录移除而删除，
 * 同键条目更新价格并保留内部引用，用户手工价格不被自动同步覆盖。
 * 目录价格变化会改变来源 hash，供 SQLite 追加新价格版本。
 */
export function mergeProviderCatalogPricing(
  currentConfig: PricingConfig,
  catalog: ProviderCatalog,
  options: {updateMembership?: boolean} = {},
): PricingConfigV2 {
  const current = normalizePricingConfig(currentConfig);
  const updateMembership = options.updateMembership !== false;
  const catalogEntries = providerCatalogToPricingEntries(catalog);
  const merged = new Map<string, ModelPriceEntry>();
  for (const raw of current.models) {
    // 旧 vendor 名下的官方目录条目先按改名表迁移，再参与合并（见 CATALOG_VENDOR_RENAMES）。
    const entry = rehomeRenamedCatalogVendor(raw);
    const key = pricingIdentity(entry);
    const existing = merged.get(key);
    // 存量冲突时优先保留用户手工价格，避免目录或社区数据成为第二真相。
    if (!existing || entry.confidence === "user_override") merged.set(key, entry);
  }
  for (const entry of catalogEntries) {
    const key = pricingIdentity(entry);
    const existing = merged.get(key);
    // 官方目录只按供应商 + runtimeModelId 更新基础价格；用户手工覆盖始终保留，
    // 其它来源的既有内部引用也必须继续复用，避免供应商映射因目录刷新失效。
    if (existing?.confidence === "user_override") {
      // 两组字段组保护（终极方案）：payg 价字段组手工保护不被覆盖；plan 字段组（套餐规则
      // 投影）、价格时间线与 wireApis（官方能力）始终跟随目录更新。
      const followOfficial: Partial<ModelPriceEntry> = {};
      if (entry.planCreditRules && JSON.stringify(entry.planCreditRules) !== JSON.stringify(existing.planCreditRules)) {
        followOfficial.planCreditRules = entry.planCreditRules;
      }
      if (JSON.stringify(entry.rateTimeline ?? null) !== JSON.stringify(existing.rateTimeline ?? null)) {
        followOfficial.rateTimeline = entry.rateTimeline;
      }
      if (JSON.stringify(entry.supportedWireApis ?? null) !== JSON.stringify(existing.supportedWireApis ?? null)) {
        followOfficial.supportedWireApis = entry.supportedWireApis;
      }
      // 输入模态同属官方能力（2026-09-21 能力下发）：与 wireApis 一样始终跟随目录，
      // 不受 payg/plan 价格字段组保护影响（能力是供应商×模型属性，与计费通道无关）。
      if (JSON.stringify(entry.inputModalities ?? null) !== JSON.stringify(existing.inputModalities ?? null)) {
        followOfficial.inputModalities = entry.inputModalities;
      }
      if (entry.contextWindow !== existing.contextWindow) {
        followOfficial.contextWindow = entry.contextWindow;
      }
      if (entry.maxOutput !== existing.maxOutput) {
        followOfficial.maxOutput = entry.maxOutput;
      }
      if (Object.keys(followOfficial).length > 0) {
        merged.set(key, {...existing, ...followOfficial});
      }
      continue;
    }
    // 时间线整列替换（终极方案）：目录自带完整价格时间线（含历史段），合并无需链式挂接。
    merged.set(key, existing ? {...entry, id: existing.id} : entry);
  }
  const models = [...merged.values()]
    .sort((left, right) => `${left.vendor}/${left.id}`.localeCompare(`${right.vendor}/${right.id}`));
  const serialized = canonicalJson({publishedAt: catalog.publishedAt, providers: catalog.providers});

  return normalizePricingConfig({
    ...current,
    currency: "USD",
    sourceCheckedAt: catalog.publishedAt,
    catalogSource: {
      type: "provider_catalog",
      url: PROVIDER_CATALOG_URL,
      fetchedAt: catalog.publishedAt,
      hash: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
      modelCount: catalogEntries.length,
    },
    models,
    unconvertedCatalogPricing: catalogEntries.some(entry => entry.region === "cn"),
    // 目录携带汇率快照时随合并写入（2026-09-05 四层分离：展示层拉平基准）。
    ...(catalog.fx ? {fx: catalog.fx} : {}),
  });
}

/** 价格中心基础唯一键：供应商 + 运行时模型 ID。 */
function pricingIdentity(entry: ModelPriceEntry): string {
  const runtimeModelId = pricingEntryRuntimeModelId(entry);
  return `${entry.vendor.trim().toLowerCase()}\u0000${runtimeModelId.trim().toLowerCase()}`;
}

export function providerCatalogPriceEntryId(pricingProviderId: string, modelId: string): string {
  return `catalog:${pricingProviderId}:${modelId}`;
}

/**
 * 目录合并保留手工价格时，把供应商里的候选映射改绑到价格中心实际条目 ID。
 * 价格中心唯一键是 vendor + runtimeModelId，不能假设条目 ID 一定是 catalog:*。
 */
export function reconcileModelVendorsToPriceCenter(
  pricing: PricingConfig,
  modelVendors: Record<string, ProxyTargetModelVendor>,
): Record<string, ProxyTargetModelVendor> {
  const entriesByIdentity = new Map<string, ModelPriceEntry>();
  for (const entry of normalizePricingConfig(pricing).models) {
    const runtimeModelId = pricingEntryRuntimeModelId(entry).trim();
    if (!runtimeModelId || !entry.vendor.trim()) continue;
    if (!entry.pricing
      || !Number.isFinite(entry.pricing.input)
      || !Number.isFinite(entry.pricing.output)) continue;
    const identity = `${entry.vendor.trim().toLowerCase()}\u0000${runtimeModelId.toLowerCase()}`;
    if (entriesByIdentity.has(identity)) {
      throw new Error(`PRICE_CENTER_VENDOR_MODEL_CONFLICT:${entry.vendor}:${runtimeModelId}`);
    }
    entriesByIdentity.set(identity, entry);
  }

  return Object.fromEntries(Object.entries(modelVendors).map(([runtimeModelId, reference]) => {
    const vendor = reference.vendor?.trim();
    if (!vendor) throw new Error(`PRICE_CENTER_MODEL_MAPPING_REQUIRED:${runtimeModelId}`);
    const entry = entriesByIdentity.get(`${vendor.toLowerCase()}\u0000${runtimeModelId.toLowerCase()}`);
    if (!entry) throw new Error(`PRICE_CENTER_MODEL_MAPPING_REQUIRED:${vendor}:${runtimeModelId}`);
    return [runtimeModelId, {vendor: entry.vendor, priceEntryId: entry.id}];
  }));
}

/**
 * 对 URL 可精确识别的官方供应商重建“Agent 可见模型 → 价格中心条目”引用。
 * 只在全部白名单模型都能按供应商 + runtimeModelId 唯一命中时返回补丁，
 * 不增加、删除或替换供应商的 Agent 可见模型。
 */
export function reconcileOfficialTargetModelVendors(
  target: ProxyTarget,
  pricing: PricingConfig,
): Partial<ProxyTarget> | undefined {
  const preset = resolveOfficialPresetForTarget(target);
  if (!preset || target.supportedModels.length === 0) return undefined;
  let modelVendors: Record<string, ProxyTargetModelVendor>;
  try {
    modelVendors = reconcileModelVendorsToPriceCenter(
      pricing,
      Object.fromEntries(target.supportedModels.map(modelId => [modelId, {vendor: preset.pricingProviderId}])),
    );
  } catch {
    return undefined;
  }
  const existing = target.pricing?.modelVendors || {};
  const mappingsChanged = target.supportedModels.some(modelId => {
    const before = existing[modelId];
    const after = modelVendors[modelId];
    return before?.vendor !== after?.vendor || before?.priceEntryId !== after?.priceEntryId;
  }) || Object.keys(existing).some(modelId => !target.supportedModels.includes(modelId));
  if (!mappingsChanged
    && target.presetId === preset.id
    && target.pricing?.vendor === preset.pricingProviderId) return undefined;
  return {
    presetId: preset.id,
    pricing: {
      ...target.pricing,
      vendor: preset.pricingProviderId,
      modelVendors,
    },
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}
