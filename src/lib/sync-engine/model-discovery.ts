import {normalizePricingConfig, pricingEntryRuntimeModelId, type ModelPriceEntry, type PricingConfig} from "@/lib/pricing";
import {inferDiscoveredVendor, type VendorSuggestionReason} from "@/lib/proxy-management-domain";
import type {ProxyTarget, ProxyTargetModelVendor} from "@/types";

/** 模型发现：探测 OpenAI 兼容 /models 端点，并按价格中心条目匹配（仅对话类）。 */

const DISCOVER_TIMEOUT_MS = 10_000;
const MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 对话类 mode：价格中心条目 mode 为空或属于对话类才可作为网关模型落库。 */
const CHAT_MODES = new Set(["chat", "completion", "chat_completion"]);

export interface DiscoveredModelCandidate {
  modelId: string;
  priceEntryId: string;
  vendor: string;
  mode?: string;
  pricing?: ModelPriceEntry["pricing"];
  contextWindow?: number;
  maxOutput?: number;
  matched: boolean;
  suggestionReason?: VendorSuggestionReason;
  skippedReason?: "no_price_entry" | "non_chat_mode";
}

export interface UnpricedModelCandidate {
  modelId: string;
  reason: "no_price_entry" | "ambiguous_price_entry" | "non_chat_mode" | "price_missing" | "unsupported_model_family";
  suggestedVendor?: string;
  suggestionReason?: VendorSuggestionReason;
}

export interface ModelDiscoveryResult {
  ok: boolean;
  /** 接口需要密钥鉴权（401/403）且未提供/无效。 */
  authRequired: boolean;
  /** 远端返回的模型总数（含跳过）。 */
  total: number;
  /** 匹配到价格中心且为对话类的模型（可进入 Agent 可见模型）。 */
  matched: DiscoveredModelCandidate[];
  unpriced: UnpricedModelCandidate[];
  added: DiscoveredModelCandidate[];
  existing: string[];
  removed: string[];
  /** 被跳过的模型数（未匹配价格中心 或 非对话类）。 */
  skipped: number;
  message: string;
}

export interface ModelProbeResult {
  models: string[];
  authRequired: boolean;
}

/**
 * 根据用户填写的上游基础 URL 生成有序模型端点候选。
 * 根 URL 优先尝试标准 OpenAI `/v1/models`，同时保留 `/models` 兼容路径；
 * 已带 `/v1` 的地址不会重复拼接，老中转站根路径仍可通过第二候选命中。
 */
export function buildModelEndpointCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return [`${normalized}/v1/models`, `${normalized}/models`];
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  const candidates = path.endsWith("/v1")
    ? [`${normalized}/models`, `${parsed.origin}/models`]
    : path === ""
      ? [`${normalized}/v1/models`, `${normalized}/models`]
      : [`${normalized}/models`, `${normalized}/v1/models`];
  return [...new Set(candidates)];
}

/** 探测 OpenAI 兼容模型列表：兼容 `/v1/models` 与根路径 `/models`。 */
export async function probeOpenAiModels(
  baseUrl: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelProbeResult> {
  let lastFailure: "not_found" | "invalid_response" = "not_found";
  for (const url of buildModelEndpointCandidates(baseUrl)) {
    const response = await fetchImpl(url, {
      headers: apiKey ? {authorization: `Bearer ${apiKey}`} : {},
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {models: [], authRequired: true};
    }
    if (response.status === 404 || response.status === 405) {
      lastFailure = "not_found";
      continue;
    }
    if (!response.ok) {
      throw new Error(`MODEL_DISCOVER_HTTP_${response.status}`);
    }
    const bodyText = await readBoundedModelResponse(response);
    let body: {data?: unknown};
    try {
      body = JSON.parse(bodyText) as {data?: unknown};
    } catch {
      lastFailure = "invalid_response";
      continue;
    }
    const data = body?.data;
    const models = Array.isArray(data)
      ? data.map(item => (item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id : ""))
          .filter(id => id.length > 0)
      : [];
    if (!Array.isArray(data)) {
      lastFailure = "invalid_response";
      continue;
    }
    return {models, authRequired: false};
  }
  throw new Error(lastFailure === "invalid_response"
    ? "MODEL_DISCOVER_RESPONSE_INVALID"
    : "MODEL_DISCOVER_ENDPOINT_NOT_FOUND");
}

/** 在流式读取阶段执行硬上限，不能先把未知大小的模型响应完整装入内存再截断。 */
async function readBoundedModelResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("MODEL_DISCOVER_RESPONSE_INVALID");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("MODEL_DISCOVER_RESPONSE_INVALID");
      }
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * 把远端模型 ID 匹配到价格中心条目；未匹配或非对话类跳过（不进入 Agent 可见模型）。
 * 自定义供应商只接受 GPT/OpenAI o、Claude、Gemini 三类固定供应商映射；
 * 其它家族不推断供应商，即使价格中心存在同名条目也不能加入。
 */
export function matchDiscoveredModels(
  remoteModelIds: string[],
  pricing: PricingConfig,
): {matched: DiscoveredModelCandidate[]; unpriced: UnpricedModelCandidate[]; skipped: number} {
  const models = normalizePricingConfig(pricing).models;
  const matched: DiscoveredModelCandidate[] = [];
  const unpriced: UnpricedModelCandidate[] = [];
  let skipped = 0;
  for (const modelId of remoteModelIds) {
    const comparable = normalizeComparable(modelId);
    const suggestion = inferDiscoveredVendor(modelId);
    if (!suggestion) {
      unpriced.push({modelId, reason: "unsupported_model_family"});
      skipped += 1;
      continue;
    }
    // 价格中心的业务身份只认 runtimeModelId；内部条目 ID、match、patterns 和 aliases
    // 仅用于其它历史计价兼容，不能替代上游真实模型 ID 进入 Agent 可见列表。
    const exactEntries = models.filter(entry =>
      normalizeComparable(pricingEntryRuntimeModelId(entry)) === comparable);
    let candidates = exactEntries;
    if (candidates.length === 0) {
      unpriced.push({
        modelId,
        reason: "no_price_entry",
        ...(suggestion ? {suggestedVendor: suggestion.vendor, suggestionReason: suggestion.reason} : {}),
      });
      skipped += 1;
      continue;
    }
    const suggestedMatches = candidates.filter(entry => entryVendor(entry).toLowerCase() === suggestion.vendor);
    if (suggestedMatches.length === 0) {
      unpriced.push({
        modelId,
        reason: "no_price_entry",
        suggestedVendor: suggestion.vendor,
        suggestionReason: suggestion.reason,
      });
      skipped += 1;
      continue;
    }
    candidates = suggestedMatches;
    // 仍多候选直接视为歧义。价格相同也不能掩盖供应商身份错误，否则后续供应商维度统计会失真。
    if (candidates.length > 1) {
      unpriced.push({modelId, reason: "ambiguous_price_entry"});
      skipped += 1;
      continue;
    }
    const entry = candidates[0]!;
    const mode = (entry.mode || "").trim().toLowerCase();
    if (mode && !CHAT_MODES.has(mode)) {
      unpriced.push({modelId, reason: "non_chat_mode"});
      skipped += 1;
      continue;
    }
    if (!hasUsablePricing(entry)) {
      unpriced.push({modelId, reason: "price_missing"});
      skipped += 1;
      continue;
    }
    matched.push({
      modelId,
      priceEntryId: entry.id,
      vendor: entry.vendor || entry.litellmProvider || "",
      mode: entry.mode,
      pricing: entry.pricing,
      contextWindow: entry.contextWindow,
      maxOutput: entry.maxOutput,
      matched: true,
      suggestionReason: suggestion.reason,
    });
  }
  return {matched, unpriced, skipped};
}

/**
 * 把用户确认的最新 Agent 可见模型解析为运行时模型 ID → 价格中心条目映射。
 * 上游本次未返回的旧模型只有在原映射仍能精确命中有效价格条目时才允许保留。
 */
export function resolveConfirmedModelBindings(
  target: ProxyTarget,
  matched: DiscoveredModelCandidate[],
  selectedModelIds: string[],
  pricing: PricingConfig,
): {supportedModels: string[]; modelVendors: Record<string, ProxyTargetModelVendor>} {
  const supportedModels = [...new Set(selectedModelIds.map(item => item.trim()).filter(Boolean))];
  if (supportedModels.length > 500) throw new Error("Proxy target supportedModels exceeds limit");
  const matchedById = new Map(matched.map(item => [item.modelId, item]));
  const pricingById = new Map(normalizePricingConfig(pricing).models.map(entry => [entry.id, entry]));
  const modelVendors: Record<string, ProxyTargetModelVendor> = {};
  // 2026-09-01 用户确认：移除模型不再销毁其价格映射（惰性保留），
  // 保证之后随时可通过探测或快速添加无损加回，不会触发 MODEL_PRICE_MAPPING_INVALID。
  for (const [modelId, mapping] of Object.entries(target.pricing?.modelVendors || {})) {
    if (mapping && !supportedModels.includes(modelId) && !modelVendors[modelId]) {
      modelVendors[modelId] = mapping;
    }
  }
  for (const modelId of supportedModels) {
    const discovered = matchedById.get(modelId);
    if (discovered?.vendor && discovered.priceEntryId) {
      modelVendors[modelId] = {vendor: discovered.vendor, priceEntryId: discovered.priceEntryId};
      continue;
    }
    const existing = target.pricing?.modelVendors?.[modelId];
    const entry = existing?.priceEntryId ? pricingById.get(existing.priceEntryId) : undefined;
    const mode = (entry?.mode || "").trim().toLowerCase();
    const exactModelMatch = Boolean(entry
      && normalizeComparable(pricingEntryRuntimeModelId(entry)) === normalizeComparable(modelId));
    if (!existing?.vendor
      || !existing.priceEntryId
      || !entry
      || entryVendor(entry).toLowerCase() !== existing.vendor.toLowerCase()
      || !exactModelMatch
      || (mode && !CHAT_MODES.has(mode))
      || !hasUsablePricing(entry)) {
      throw new Error(
        `模型 ${modelId} 缺少可用的价格映射（可能之前被移除）。`
        + `请在「手动从价格中心添加模型」中重新添加该模型，或先在价格中心确认其条目。`,
      );
    }
    modelVendors[modelId] = {vendor: existing.vendor, priceEntryId: existing.priceEntryId};
  }
  return {supportedModels, modelVendors};
}

/** Agent 可见模型必须有可计算的输入/输出基础价格；0 元模型仍是有效显式价格。 */
function hasUsablePricing(entry: ModelPriceEntry): boolean {
  return Boolean(entry.pricing
    && Number.isFinite(entry.pricing.input)
    && entry.pricing.input >= 0
    && Number.isFinite(entry.pricing.output)
    && entry.pricing.output >= 0);
}

function entryVendor(entry: ModelPriceEntry): string {
  return (entry.vendor || entry.litellmProvider || "").trim();
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}
