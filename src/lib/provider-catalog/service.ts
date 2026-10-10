import {PROVIDER_PRESETS} from "@/lib/provider-presets";
import {reconcileModelVendorsToPriceCenter} from "./pricing";
import {computeProviderCatalogDiff, applyProviderCatalogSelection, type ProviderCatalogApplyResult, type ProviderCatalogSelection} from "./diff";
import {normalizePricingConfig, pricingEntryRuntimeModelId, type ModelPriceEntry} from "@/lib/pricing";
import type {ProviderCatalogProvider} from "./types";
import type {ProviderCatalogEnvelope, ProviderCatalogModel} from "./types";
import type {PlanCreditRules, PricingConfigV2, TemporalPriceSchedule} from "@/lib/pricing";
import type {AgentId, ProxyConfig, ProxyTarget} from "@/types";
import {listAutomaticWhitelistCandidates} from "./normalize";
import {modelWireApisForTarget, supportedAgentsForCatalogModel} from "./wire-api";
import {resolveDerivedRouteId} from "@/lib/proxy-url";

export interface ProviderCatalogReview {
  targetId?: string;
  presetId: string;
  expectedRevision: number;
  source: ProviderCatalogEnvelope["source"];
  sourceHash: string;
  fetchedAt: string;
  publishedAt: string;
  pricingProviderId: string;
  providerName: string;
  region: "cn" | "global";
  /** 供应商目录币种（2026-09-28）：价格卡按此标注 $/￥（cn=CNY、global=USD）。 */
  currency?: "CNY" | "USD";
  unconvertedCatalogPricing: boolean;
  diff: ReturnType<typeof computeProviderCatalogDiff>;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  warning?: string;
  /** 新建预设的可计价对话模型详情；前端仅据此展示和维护草稿选择。 */
  models: ProviderCatalogReviewModel[];
  /** 套餐档位表（2026-09-30）：套餐同步配置的档位选择与月费联动数据源（如 OpenCode Go go/go-plus）；
   * billingCycles（2026-10-10）为各付款周期折算月价，供「档位 + 付款周期」联动取价。 */
  planTiers?: Array<{id: string; name: string; monthlyFee: number; billingCycles?: {monthly: number; quarterly?: number; yearly?: number}}>;
}

export interface ProviderCatalogReviewModel {
  id: string;
  vendor: string;
  /** 价格币种（供应商目录行 currency）：价格卡标注 $/￥ 用。 */
  currency?: "CNY" | "USD";
  pricing?: {input: number; output: number; cachedInput?: number};
  priceSchedules?: TemporalPriceSchedule[];
  planCreditRules?: PlanCreditRules;
  contextWindowK?: number;
  maxOutputK?: number;
  supportedWireApis?: string[];
  /** 输入模态（2026-09-21 能力下发）：新建预设面板只读展示。 */
  inputModalities?: string[];
  sourceUrl?: string;
  notes?: string;
  supportedAgents: AgentId[];
}

const MAX_PROVIDER_CATALOG_REVIEW_MODELS = 500;

export interface ProviderCatalogApplyInput extends ProviderCatalogSelection {
  targetId: string;
  presetId: string;
  expectedRevision: number;
}

export interface ProviderCatalogConfigStore {
  reload(): Promise<void>;
  getConfig(): ProxyConfig;
  updateConfig(update: {
    expectedRevision?: number;
    targetPatch?: {id?: string; target: Partial<ProxyTarget>};
  }): Promise<ProxyConfig>;
}

export interface ProviderCatalogServiceDependencies {
  dataDir: string;
  configStore: ProviderCatalogConfigStore;
  loadCatalog: (dataDir: string, options?: {forceRefresh?: boolean}) => Promise<ProviderCatalogEnvelope>;
  readPricingConfig: (dataDir: string) => Promise<PricingConfigV2>;
  writePricingConfig: (dataDir: string, config: PricingConfigV2) => Promise<void>;
  withPricingConfigMutation: <T>(dataDir: string, operation: () => Promise<T>) => Promise<T>;
  recordPricingRevision: (dataDir: string, config: PricingConfigV2, effectiveAt?: string) => Promise<void>;
  readOfficialModelIds?: (dataDir: string, catalogKey: string) => ReadonlySet<string>;
}

export interface ProviderPresetCreateInput {
  presetId: string;
  expectedRevision: number;
  target: ProxyTarget;
  /** 缺省表示服务端按「目录首位推荐模型」默认选择（2026-10-07 用户确认，取代默认全选）；空数组拒绝。 */
  selectedModelIds?: string[];
}

/** 组装 GET 预览；此函数只读内存对象，不触碰价格文件和代理配置。 */
export function createProviderCatalogReview(
  config: ProxyConfig,
  targetId: string | undefined,
  presetId: string,
  envelope: ProviderCatalogEnvelope,
  pricing?: PricingConfigV2,
  officialModelIds?: ReadonlySet<string>,
): ProviderCatalogReview {
  const selectedPreset = PROVIDER_PRESETS.find(item => item.id === presetId || item.catalogKey === presetId);
  const {provider, compiled} = resolveProvider(envelope, presetId, pricing, officialModelIds);
  const target = targetId
    ? config.targets.find(item => item.id === targetId)
    : undefined;
  if (targetId && !target) throw new Error("TARGET_NOT_FOUND");
  // 新建供应商预览必须使用所选预设自身的协议 URL 与预设身份：
  // 套餐/订阅通道与基础供应商目录共用 catalogKey，若按目录 URL 构造预览供应商，
  // 会把 Coding Plan 误识别成标准按量预设，导致 Codex 支持被错误展示。
  const reviewTarget = target || emptyReviewTargetForPreset(selectedPreset, provider);
  const fullDiff = computeProviderCatalogDiff(reviewTarget, provider, pricing, compiled);
  const diff = limitReviewDiff(fullDiff);
  const candidateCount = fullDiff.candidateCount;
  const models = listAutomaticWhitelistCandidates(provider)
    .map(model => ({model, supportedAgents: supportedAgentsForCatalogModel(provider, model, reviewTarget)}))
    .filter(item => item.supportedAgents.length > 0)
    .slice(0, MAX_PROVIDER_CATALOG_REVIEW_MODELS)
    .map(({model, supportedAgents}) => ({
    id: model.id,
    vendor: provider.pricingProviderId,
    ...(provider.currency ? {currency: provider.currency} : {}),
    pricing: model.pricing ? {
      input: model.pricing.input,
      output: model.pricing.output,
      ...(model.pricing.cachedInput === undefined ? {} : {cachedInput: model.pricing.cachedInput}),
    } : undefined,
    priceSchedules: compiled.get(model.id)?.priceSchedules,
    planCreditRules: compiled.get(model.id)?.planCreditRules,
    contextWindowK: model.contextWindowK,
    maxOutputK: model.maxOutputK,
    supportedWireApis: model.supportedWireApis,
    inputModalities: model.inputModalities,
    sourceUrl: model.sourceUrl,
    notes: model.notes,
    supportedAgents,
  }));
  return {
    ...(targetId ? {targetId} : {}),
    presetId,
    expectedRevision: config.revision,
    source: envelope.source,
    sourceHash: envelope.sourceHash,
    fetchedAt: envelope.fetchedAt,
    publishedAt: envelope.catalog.publishedAt,
    pricingProviderId: provider.pricingProviderId,
    providerName: provider.name,
    region: provider.region,
    ...(provider.currency ? {currency: provider.currency} : {}),
    unconvertedCatalogPricing: provider.region === "cn" && provider.models.some(model => model.pricing !== undefined),
    diff,
    candidateCount,
    processedCount: diff.processedCount,
    limited: diff.limited,
    warning: envelope.warning,
    models,
    ...(provider.planTiers?.length
      ? {planTiers: provider.planTiers
        .filter(tier => tier.id && tier.id.trim())
        .map(tier => ({
          id: tier.id!.trim(),
          name: tier.name,
          monthlyFee: tier.monthlyFee,
          ...(tier.billingCycles ? {billingCycles: tier.billingCycles} : {}),
        }))}
      : {}),
  };
}

function limitReviewDiff(diff: ReturnType<typeof computeProviderCatalogDiff>): ReturnType<typeof computeProviderCatalogDiff> {
  let remaining = MAX_PROVIDER_CATALOG_REVIEW_MODELS;
  // 先完整保留存量模型，再用剩余预算展示新增候选，避免用户看不到将被移除的默认模型。
  const existing = diff.existing.slice(0, remaining);
  remaining -= existing.length;
  const removed = diff.removed.slice(0, remaining);
  remaining -= removed.length;
  const added = diff.added.slice(0, remaining);
  const processedCount = existing.length + removed.length + added.length;
  return {
    ...diff,
    added,
    existing,
    removed,
    processedCount,
    limited: processedCount < diff.candidateCount,
  };
}

/**
 * 确认应用：先在价格写入临界区内增量合并官方目录，再提交供应商 patch；供应商保存失败时
 * 尝试恢复旧价格文件，避免单次确认留下半套 Agent 可见模型/价格状态。
 */
export async function applyProviderCatalogUpdate(
  input: ProviderCatalogApplyInput,
  dependencies: ProviderCatalogServiceDependencies,
): Promise<{config: ProxyConfig; target: ProxyTarget; pricing: PricingConfigV2; applied: ProviderCatalogApplyResult}> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("INVALID_REQUEST");
  }
  if (!input.targetId || !input.presetId || !Array.isArray(input.selectedModelIds)) {
    throw new Error("INVALID_REQUEST");
  }
  await dependencies.configStore.reload();
  const currentConfig = dependencies.configStore.getConfig();
  if (currentConfig.revision !== input.expectedRevision) throw new Error("CONFIG_REVISION_CONFLICT");
  const currentTarget = currentConfig.targets.find(target => target.id === input.targetId);
  if (!currentTarget) throw new Error("TARGET_NOT_FOUND");
  const envelope = await dependencies.loadCatalog(dependencies.dataDir);
  const currentPricing = await dependencies.readPricingConfig(dependencies.dataDir);
  const {provider, compiled} = resolveProvider(
    envelope,
    input.presetId,
    currentPricing,
    dependencies.readOfficialModelIds?.(dependencies.dataDir, PROVIDER_PRESETS.find(item => item.id === input.presetId || item.catalogKey === input.presetId)?.catalogKey || input.presetId),
  );
  // 终极方案：白名单确认只写目标（价格中心条目已由小时同步任务入库），
  // 不再在确认节点合并目录价格——「看到的价 = 计价用的价」由数据源统一保证。
  const applied = applyProviderCatalogSelection(currentTarget, provider, input, currentPricing, compiled);
  const targetPatch = applied.targetPatch.pricing?.modelVendors
    ? {
      ...applied.targetPatch,
      pricing: {
        ...applied.targetPatch.pricing,
        modelVendors: reconcileModelVendorsToPriceCenter(
          currentPricing,
          applied.targetPatch.pricing.modelVendors,
        ),
      },
    }
    : applied.targetPatch;
  const config = await dependencies.configStore.updateConfig({
    expectedRevision: input.expectedRevision,
    targetPatch: {id: input.targetId, target: targetPatch},
  });
  const target = config.targets.find(item => item.id === input.targetId);
  if (!target) throw new Error("TARGET_NOT_FOUND");
  return {config, target, pricing: currentPricing, applied};
}

/**
 * 新建官方预设供应商的一次提交命令。客户端只提交草稿字段和可选模型 ID；目录、价格映射、
 * Agent scope 与重复供应商检查全部在服务端重新计算，避免先创建空供应商再二次应用目录。
 */
export async function createProviderPresetTarget(
  input: ProviderPresetCreateInput,
  dependencies: ProviderCatalogServiceDependencies,
): Promise<{config: ProxyConfig; target: ProxyTarget; pricing: PricingConfigV2; candidateCount: number; processedCount: number; limited: false}> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !input.presetId || !input.target) {
    throw new Error("INVALID_REQUEST");
  }
  const preset = PROVIDER_PRESETS.find(item => item.id === input.presetId || item.catalogKey === input.presetId);
  if (!preset) throw new Error("PROVIDER_PRESET_NOT_FOUND");
  await dependencies.configStore.reload();
  const currentConfig = dependencies.configStore.getConfig();
  if (currentConfig.revision !== input.expectedRevision) throw new Error("CONFIG_REVISION_CONFLICT");
  // 客户端未填写路由 ID 时按统一候选链服务端重算；已填写则交由 assertTargetUnique 兜底。
  let target = normalizePresetTargetDraft(input.target, preset);
  if (!target.id) {
    const resolution = resolveDerivedRouteId(
      target.openaiUrl,
      target.anthropicUrl,
      currentConfig.targets,
    );
    if (resolution.status === "conflict") {
      // 同 URL 对（如 MiniMax 按量与 Token Plan 共用端点）无法自动区分，引导手动填写区分词。
      throw new Error(resolution.reason === "identical_upstream_urls"
        ? "ROUTE_ID_IDENTICAL_UPSTREAM_CONFLICT"
        : "ROUTE_ID_DERIVATION_CONFLICT");
    }
    if (resolution.status !== "resolved") throw new Error("PROTOCOL_URL_REQUIRED");
    target = {...target, id: resolution.id};
  }
  assertTargetUnique(currentConfig, target);

  const envelope = await dependencies.loadCatalog(dependencies.dataDir);
  const currentPricingForCreate = await dependencies.readPricingConfig(dependencies.dataDir);
  const {provider} = resolveProvider(
    envelope,
    preset.id,
    currentPricingForCreate,
    dependencies.readOfficialModelIds?.(dependencies.dataDir, preset.catalogKey),
  );
  const automaticModels = listAutomaticWhitelistCandidates(provider)
    .filter(model => supportedAgentsForCatalogModel(provider, model, target).length > 0);
  const automaticById = new Map(automaticModels.map(model => [model.id, model] as const));
  // 默认只选择目录首位推荐模型：目录首位维护约定 = 官方主推模型，
  // 避免 Agent 模型列表被一次性灌入全部候选（2026-10-07 用户确认）。
  const selectedModelIds = input.selectedModelIds === undefined
    ? automaticModels.slice(0, 1).map(model => model.id)
    : [...new Set(input.selectedModelIds.map(modelId => modelId.trim()))];
  if (selectedModelIds.length === 0) throw new Error("MODEL_SELECTION_REQUIRED");
  if (selectedModelIds.some(modelId => !modelId || !automaticById.has(modelId))) {
    throw new Error("MODEL_PRICE_MAPPING_REQUIRED");
  }

  const modelVendors = Object.fromEntries(selectedModelIds.map(modelId => [
    modelId,
    {vendor: provider.pricingProviderId},
  ]));

  {
    // 终极方案：新建供应商只写目标白名单与映射（条目已由同步入库），不再合并目录价格。
    const nextPricing = currentPricingForCreate;
    const reconciledMappings = reconcileModelVendorsToPriceCenter(nextPricing, modelVendors);
    const createdTarget: ProxyTarget = {
      ...target,
      enabled: false,
      supportedModels: selectedModelIds,
      supportedModelScopes: Object.fromEntries(selectedModelIds.map(modelId => [modelId, supportedAgentsForCatalogModel(provider, automaticById.get(modelId)!, target)])),
      supportedModelWireApis: Object.fromEntries(selectedModelIds.map(modelId => [
        modelId,
        modelWireApisForTarget(provider, automaticById.get(modelId)!, target),
      ])),
      pricing: {
        ...target.pricing,
        vendor: provider.pricingProviderId,
        modelVendors: reconciledMappings,
        // 计价币种随目录供应商（四层分离）：cn=CNY，global=USD；结算系数按默认规则派生。
        ...(provider.currency ? {settlementCurrency: provider.currency} : {}),
        // 单档位套餐预设（如 OpenCode Go）直接预填官方月费（provider.currency 原币种）；
        // 多档位无法猜测，留空由套餐同步按档位名回填（matchPlanTierMonthlyFee）。
        ...(provider.planTiers?.length === 1 ? {planMonthlyFee: provider.planTiers[0]!.monthlyFee} : {}),
      },
    };
    const config = await dependencies.configStore.updateConfig({
      expectedRevision: input.expectedRevision,
      targetPatch: {target: createdTarget},
    });
    const persistedTarget = config.targets.find(item => item.id === createdTarget.id);
    if (!persistedTarget) throw new Error("TARGET_NOT_FOUND");
    return {
      config,
      target: persistedTarget,
      pricing: nextPricing,
      candidateCount: automaticModels.length,
      processedCount: automaticModels.length,
      limited: false as const,
    };
  };
}

function resolveProvider(
  envelope: ProviderCatalogEnvelope,
  presetId: string,
  pricing?: PricingConfigV2,
  officialModelIds?: ReadonlySet<string>,
) {
  const preset = PROVIDER_PRESETS.find(item => item.id === presetId || item.catalogKey === presetId);
  const catalogKey = preset?.catalogKey || presetId;
  const catalogProvider = envelope.catalog.providers[catalogKey];
  if (!catalogProvider) throw new Error("PROVIDER_PRESET_NOT_FOUND");
  // 终极方案：向导/刷新的数据源是价格中心条目（小时任务已入库的编译投影）。
  // 目录 provider 仅提供供应商级元数据（名称/区域/币种/档位）；模型列表、价格、时间线
  // 与 wireApis 全部来自价格中心，保证「看到的价 = 计价用的价」。
  const currentCatalogModelIds = officialModelIds || new Set(catalogProvider.models.map(model => model.id));
  const entries = pricing
    ? normalizePricingConfig(pricing).models.filter(entry =>
        entry.vendor.trim().toLowerCase() === catalogProvider.pricingProviderId.trim().toLowerCase()
        && entry.pricing !== undefined
        && currentCatalogModelIds.has(pricingEntryRuntimeModelId(entry)))
    : [];
  const compiled = new Map<string, ModelPriceEntry>();
  const models: ProviderCatalogProvider["models"] = [];
  // 输出顺序跟目录编辑序而非价格中心文件序（2026-10-08）：价格中心按条目 ID 字典序
  // 维护，若直接沿用会把「默认勾选目录首位推荐模型」劫持成字典序首位（OpenAI 目录
  // 首发 gpt-6.1-sol 曾被 gpt-5.6-luna 顶掉）。目录之外的存量条目（历史 membership）
  // 无目录位次可言，按价格中心原序追加在末尾。
  const entryByRuntimeId = new Map<string, ModelPriceEntry>();
  for (const entry of entries) {
    const modelId = pricingEntryRuntimeModelId(entry);
    if (modelId && !entryByRuntimeId.has(modelId)) entryByRuntimeId.set(modelId, entry);
  }
  const emitModel = (modelId: string) => {
    const entry = entryByRuntimeId.get(modelId);
    if (!entry) return;
    entryByRuntimeId.delete(modelId);
    compiled.set(modelId, entry);
    models.push({
      id: modelId,
      category: (entry.mode as ProviderCatalogProvider["models"][number]["category"]) ?? "chat",
      ...(entry.contextWindow !== undefined ? {contextWindowK: Math.round(entry.contextWindow / 1024)} : {}),
      ...(entry.maxOutput !== undefined ? {maxOutputK: Math.round(entry.maxOutput / 1024)} : {}),
      ...(entry.supportedWireApis?.length ? {supportedWireApis: entry.supportedWireApis as ProviderCatalogProvider["models"][number]["supportedWireApis"]} : {}),
      pricing: entry.pricing,
      sourceUrl: entry.sourceUrl,
      notes: entry.notes,
    });
  };
  for (const model of catalogProvider.models) emitModel(model.id);
  for (const modelId of [...entryByRuntimeId.keys()]) emitModel(modelId);
  const provider: ProviderCatalogProvider = {...catalogProvider, models};
  return {catalogKey, provider, compiled};
}

function normalizePresetTargetDraft(target: ProxyTarget, preset: typeof PROVIDER_PRESETS[number]): ProxyTarget {
  // 路由 ID 允许为空：由 createProviderPresetTarget 按统一候选链服务端重算；
  // 已填写时仍需满足路由 ID 字符集规则。
  const id = target.id?.trim();
  if (id && (!/^[a-z0-9.-]+$/u.test(id) || id.includes("_"))) throw new Error("INVALID_TARGET_ID");
  const name = target.name?.trim();
  if (!name) throw new Error("INVALID_REQUEST");
  // URL 以客户端草稿为准：官方预设只提供默认值，不因用户清空某一协议而在服务端补齐。
  const openaiUrl = normalizeOptionalTargetUrl(target.openaiUrl);
  const anthropicUrl = normalizeOptionalTargetUrl(target.anthropicUrl);
  if (!openaiUrl && !anthropicUrl) throw new Error("PROTOCOL_URL_REQUIRED");
  if (target.openaiUrl && preset.openaiUrl && normalizeOptionalTargetUrl(target.openaiUrl) !== normalizeOptionalTargetUrl(preset.openaiUrl)) {
    throw new Error("PROVIDER_PRESET_URL_MISMATCH");
  }
  if (target.anthropicUrl && preset.anthropicUrl && normalizeOptionalTargetUrl(target.anthropicUrl) !== normalizeOptionalTargetUrl(preset.anthropicUrl)) {
    throw new Error("PROVIDER_PRESET_URL_MISMATCH");
  }
  return {
    ...target,
    id,
    name,
    presetId: preset.id,
    billingChannel: preset.billingChannel,
    vendorFamily: preset.vendorFamily,
    ...(openaiUrl ? {openaiUrl} : {openaiUrl: undefined}),
    ...(anthropicUrl ? {anthropicUrl} : {anthropicUrl: undefined}),
    enabled: false,
    supportedModels: [],
    supportedModelScopes: undefined,
    pricing: {
      vendor: preset.pricingProviderId,
    },
  };
}

function assertTargetUnique(config: ProxyConfig, target: ProxyTarget): void {
  if (config.targets.some(item => item.id === target.id)) throw new Error("DUPLICATE_TARGET_ID");
  const candidateUrls = [target.openaiUrl, target.anthropicUrl]
    .map(normalizeOptionalTargetUrl)
    .filter((value): value is string => Boolean(value));
  // 同一 URL 可被不同计费通道共用（如 MiniMax 按量/Token Plan），同一通道重复才拒绝。
  for (const existing of config.targets) {
    if ((existing.billingChannel ?? "pay_as_you_go") !== (target.billingChannel ?? "pay_as_you_go")) continue;
    const existingUrls = [existing.openaiUrl, existing.anthropicUrl]
      .map(normalizeOptionalTargetUrl)
      .filter((value): value is string => Boolean(value));
    if (candidateUrls.some(url => existingUrls.includes(url))) throw new Error("DUPLICATE_TARGET_URL");
  }
}

function normalizeOptionalTargetUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("INVALID_REQUEST");
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function emptyReviewTargetForPreset(
  preset: typeof PROVIDER_PRESETS[number] | undefined,
  provider: ProviderCatalogEnvelope["catalog"]["providers"][string],
): ProxyTarget {
  return {
    id: "new-target-review",
    name: "新建供应商预览",
    ...(preset?.openaiUrl ? {openaiUrl: preset.openaiUrl} : provider.openaiUrl ? {openaiUrl: provider.openaiUrl} : {openaiUrl: "https://catalog-review.invalid"}),
    ...(preset?.anthropicUrl ? {anthropicUrl: preset.anthropicUrl} : provider.anthropicUrl ? {anthropicUrl: provider.anthropicUrl} : {}),
    ...(preset?.id ? {presetId: preset.id} : {}),
    ...(preset?.billingChannel ? {billingChannel: preset.billingChannel} : {}),
    enabled: false,
    supportedModels: [],
  };
}
