import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {ensurePricingConfigRevision} from "@/lib/ingestion/pricing-revisions";
import {loadProviderCatalog} from "@/lib/provider-catalog/cache";
import {applyProviderCatalogUpdate, createProviderPresetTarget, type ProviderCatalogServiceDependencies} from "@/lib/provider-catalog/service";
import {readEffectivePricingConfig, readPricingConfig, withPricingConfigMutation, writePricingConfig} from "@/lib/pricing";
import {ProxyConfigStore} from "@/proxy-config";
import {listCurrentOfficialModelIds} from "@/lib/provider-catalog/membership-store";
import {isKnownGatewayAgent} from "@/lib/agent-registry";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";
import type {ProxyTarget} from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATA_DIR = resolveDeepaaDataDir();
const proxyConfig = new ProxyConfigStore();

/** 确认目录差异；服务端重新解析所有关键数据，不信任客户端价格、URL 或模型映射。 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const input = normalizeInput(body);
    const dependencies: ProviderCatalogServiceDependencies = {
      dataDir: DATA_DIR,
      configStore: proxyConfig,
      loadCatalog: (dataDir, options) => loadProviderCatalog(dataDir, options),
      readPricingConfig,
      writePricingConfig,
      withPricingConfigMutation,
      recordPricingRevision: async (dataDir, _config, effectiveAt) => {
        try {
          const effective = await readEffectivePricingConfig(dataDir);
          ensurePricingConfigRevision(getDeepaaDatabase(dataDir), effective, effectiveAt);
        } catch (error) {
          // 价格/供应商文件已经保存；版本记录失败由 Worker 后续补建，不能回滚用户确认。
          console.error("[deepaa] provider catalog revision failed", error);
        }
      },
      readOfficialModelIds: (dataDir, catalogKey) =>
        listCurrentOfficialModelIds(getDeepaaDatabase(dataDir), catalogKey),
    };
    const result = input.action === "create"
      ? await createProviderPresetTarget(input, dependencies)
      : await applyProviderCatalogUpdate(input, dependencies);
    const counts = "applied" in result ? result.applied : result;
    return jsonResponse({
      ok: true,
      config: result.config,
      target: result.target,
      pricing: {
        source: result.pricing.catalogSource,
        unconvertedCatalogPricing: result.pricing.unconvertedCatalogPricing,
      },
      candidateCount: counts.candidateCount,
      processedCount: counts.processedCount,
      limited: counts.limited,
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

export function normalizeInput(body: Record<string, unknown>) {
  const presetId = stringField(body, "presetId", 128);
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("INVALID_REQUEST");
  }
  const action = body.action === "create" ? "create" : "apply";
  const selectedModelIds = normalizeSelectedModelIds(body.selectedModelIds, action === "create");
  if (action === "create") {
    return {
      action,
      presetId,
      expectedRevision,
      target: normalizeTargetDraft(body.target),
      ...(selectedModelIds === undefined ? {} : {selectedModelIds}),
    } as const;
  }
  const targetId = stringField(body, "targetId", 128);
  if (!selectedModelIds) throw new Error("INVALID_REQUEST");
  // 单模型接入（2026-09-06「仅更新此模型」）：恰好一个模型、不移除任何现有模型。
  const singleModel = body.mode === "single";
  if (singleModel && selectedModelIds.length !== 1) throw new Error("INVALID_REQUEST");
  const replacementDefaultModels: Record<string, string> = {};
  if (body.replacementDefaultModels !== undefined) {
    if (!body.replacementDefaultModels || typeof body.replacementDefaultModels !== "object" || Array.isArray(body.replacementDefaultModels)) {
      throw new Error("INVALID_REQUEST");
    }
    for (const [agent, model] of Object.entries(body.replacementDefaultModels as Record<string, unknown>)) {
      if (!isKnownGatewayAgent(agent)) continue;
      if (typeof model !== "string" || !model.trim() || model.length > 256) throw new Error("INVALID_REQUEST");
      replacementDefaultModels[agent] = model.trim();
    }
  }
  return {
    action,
    targetId,
    presetId,
    expectedRevision,
    selectedModelIds,
    replacementDefaultModels,
    ...(singleModel ? {preserveUnselected: true as const} : {}),
  } as const;
}

function normalizeSelectedModelIds(value: unknown, optional: boolean): string[] | undefined {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.length > 500) throw new Error("INVALID_REQUEST");
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.length > 256 || index >= 500) throw new Error("INVALID_REQUEST");
    return item.trim();
  });
}

function normalizeTargetDraft(value: unknown): ProxyTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set(["id", "name", "openaiUrl", "anthropicUrl", "pricing", "createdAt", "updatedAt"]);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) throw new Error("INVALID_REQUEST");
  const pricing = raw.pricing;
  if (pricing !== undefined) {
    // 2026-09-01 移除供应商级倍率概念：pricing 仅允许空对象占位。
    if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)
      || Object.keys(pricing as Record<string, unknown>).length > 0) {
      throw new Error("INVALID_REQUEST");
    }
  }
  return {
    id: stringField(raw, "id", 128),
    name: stringField(raw, "name", 160),
    ...(optionalStringField(raw.openaiUrl, 2_048) ? {openaiUrl: optionalStringField(raw.openaiUrl, 2_048)} : {}),
    ...(optionalStringField(raw.anthropicUrl, 2_048) ? {anthropicUrl: optionalStringField(raw.anthropicUrl, 2_048)} : {}),
    enabled: false,
    supportedModels: [],
    ...(optionalStringField(raw.createdAt, 128) ? {createdAt: optionalStringField(raw.createdAt, 128)} : {}),
    ...(optionalStringField(raw.updatedAt, 128) ? {updatedAt: optionalStringField(raw.updatedAt, 128)} : {}),
  };
}

function stringField(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("INVALID_REQUEST");
  return value.trim();
}

function optionalStringField(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("INVALID_REQUEST");
  return value.trim();
}
