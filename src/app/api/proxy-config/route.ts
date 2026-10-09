import { jsonResponse } from "@/lib/app-state";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";
import { ensurePricingConfigRevision } from "@/lib/ingestion/pricing-revisions";
import { assertProxyTargetPriceMappings, readEffectivePricingConfig, readPricingConfig } from "@/lib/pricing";
import {reconcileOfficialTargetModelVendors} from "@/lib/provider-catalog/pricing";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {inferCustomTargetModelWireApis} from "@/lib/wire-api-infer";
import {
  proxyRoutingStatusPath,
  waitForRoutingRevision,
} from "@/lib/proxy-routing-status";
import { ProxyConfigStore, type AgentConnectionPatchUpdate, type ProxyConfigUpdate, type TargetPricingOverrideUpdate } from "@/proxy-config";
import {isKnownGatewayAgent} from "@/lib/agent-registry";
import type {ProxyTarget} from "@/types";

export const dynamic = "force-dynamic";

const proxyConfig = new ProxyConfigStore();

export async function GET() {
  await proxyConfig.reload();
  return jsonResponse(proxyConfig.getConfig());
}

export async function PUT(request: Request) {
  const dataDir = resolveDeepaaDataDir();
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const update = normalizeProxyConfigUpdate(body);
    await proxyConfig.reload();
    const currentTargets = proxyConfig.getConfig().targets;
    refreshCustomTargetModelWireApis(update, currentTargets);
    await reconcileOfficialTargetPatchPricing(update, currentTargets, dataDir);
    await assertTargetPatchPricing(update, currentTargets, dataDir);
    // 先固化保存前的策略；这样 Worker 延迟处理的旧 raw 仍能命中旧版本。
    try {
      const previous = await readEffectivePricingConfig(dataDir);
      ensurePricingConfigRevision(getDeepaaDatabase(dataDir), previous);
    } catch (error) {
      console.error("[deepaa] previous pricing revision record failed", error);
    }
    const config = await proxyConfig.updateConfig(update);
    try {
      const effective = await readEffectivePricingConfig(dataDir);
      ensurePricingConfigRevision(
        getDeepaaDatabase(dataDir),
        effective,
        config.updatedAt,
      );
    } catch (error) {
      // 配置写入和代理转发不能被派生版本记录失败阻断；Worker 会在下批重试。
      console.error("[deepaa] pricing revision record failed", error);
    }
    const savedRevision = config.revision ?? 1;
    const appliedStatus = await waitForRoutingRevision(
      proxyRoutingStatusPath(dataDir),
      savedRevision,
    );
    return jsonResponse({
      config,
      saved: true,
      savedRevision,
      applied: Boolean(appliedStatus),
      appliedRevision: appliedStatus?.appliedRevision,
      proxyInstanceId: appliedStatus?.proxyInstanceId,
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

export function normalizeProxyConfigUpdate(body: Record<string, unknown>): ProxyConfigUpdate {
  const allowedKeys = new Set([
    "nonce",
    "expectedRevision",
    "targetPatch",
    "targetPricingOverride",
    "targetDelete",
    "agentConnectionPatch",
    "localProxyBaseUrl",
  ]);
  if (Object.keys(body).some(key => !allowedKeys.has(key))) throw new Error("INVALID_REQUEST");
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new Error("INVALID_REQUEST");
  const update: ProxyConfigUpdate = {expectedRevision: Number(body.expectedRevision)};
  let mutationCount = 0;
  if (body.targetPatch !== undefined) {
    if (!body.targetPatch || typeof body.targetPatch !== "object" || Array.isArray(body.targetPatch)) throw new Error("INVALID_REQUEST");
    const raw = body.targetPatch as Record<string, unknown>;
    if (!raw.target || typeof raw.target !== "object" || Array.isArray(raw.target)) throw new Error("INVALID_REQUEST");
    update.targetPatch = {
      ...(typeof raw.id === "string" && raw.id.trim() ? {id: raw.id.trim()} : {}),
      target: raw.target as Partial<ProxyTarget>,
    };
    mutationCount += 1;
  }
  if (body.targetPricingOverride !== undefined) {
    if (!body.targetPricingOverride || typeof body.targetPricingOverride !== "object" || Array.isArray(body.targetPricingOverride)) {
      throw new Error("INVALID_REQUEST");
    }
    const raw = body.targetPricingOverride as Record<string, unknown>;
    const allowedOverrideKeys = new Set(["action", "targetId", "targetModelId", "pricing", "priceSchedules", "currency"]);
    if (Object.keys(raw).some(key => !allowedOverrideKeys.has(key))) throw new Error("INVALID_REQUEST");
    if (raw.action !== "upsert" && raw.action !== "remove") throw new Error("INVALID_REQUEST");
    if (typeof raw.targetId !== "string" || !raw.targetId.trim()
      || typeof raw.targetModelId !== "string" || !raw.targetModelId.trim()) {
      throw new Error("INVALID_REQUEST");
    }
    if (raw.action === "upsert"
      && (!raw.pricing || typeof raw.pricing !== "object" || Array.isArray(raw.pricing))) {
      throw new Error("INVALID_REQUEST");
    }
    update.targetPricingOverride = {
      action: raw.action,
      targetId: raw.targetId.trim(),
      targetModelId: raw.targetModelId.trim(),
      ...(raw.pricing ? {pricing: raw.pricing as TargetPricingOverrideUpdate["pricing"]} : {}),
      ...(raw.priceSchedules ? {priceSchedules: raw.priceSchedules as TargetPricingOverrideUpdate["priceSchedules"]} : {}),
      ...(raw.currency === "CNY" || raw.currency === "USD" ? {currency: raw.currency} : {}),
    };
    mutationCount += 1;
  }
  if (body.targetDelete !== undefined) {
    if (!body.targetDelete || typeof body.targetDelete !== "object" || Array.isArray(body.targetDelete)) throw new Error("INVALID_REQUEST");
    const id = (body.targetDelete as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim()) throw new Error("INVALID_REQUEST");
    update.targetDelete = {id: id.trim()};
    mutationCount += 1;
  }
  if (body.agentConnectionPatch !== undefined) {
    if (!body.agentConnectionPatch || typeof body.agentConnectionPatch !== "object" || Array.isArray(body.agentConnectionPatch)) throw new Error("INVALID_REQUEST");
    update.agentConnectionPatch = normalizeAgentConnectionPatch(body.agentConnectionPatch as Record<string, unknown>);
    mutationCount += 1;
  }
  if (body.localProxyBaseUrl !== undefined) {
    if (typeof body.localProxyBaseUrl !== "string") throw new Error("INVALID_REQUEST");
    update.localProxyBaseUrl = body.localProxyBaseUrl;
    mutationCount += 1;
  }
  if (mutationCount !== 1) throw new Error("INVALID_REQUEST");
  return update;
}

function normalizeAgentConnectionPatch(raw: Record<string, unknown>): AgentConnectionPatchUpdate {
  const allowedKeys = new Set([
    "agent",
    "action",
    "targetId",
    "boundTargetIds",
    "defaultTargetId",
    "defaultModelId",
    "defaultCredentialId",
    "cliSyncEnabled",
    "modelAliases",
  ]);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) throw new Error("INVALID_REQUEST");

  const agent = raw.agent;
  const action = raw.action;
  if (typeof agent !== "string" || !isKnownGatewayAgent(agent)
    || (action !== "connect" && action !== "disconnect" && action !== "unbind")) {
    throw new Error("INVALID_REQUEST");
  }
  const patch: AgentConnectionPatchUpdate = {agent, action};
  if (raw.targetId !== undefined) {
    if (typeof raw.targetId !== "string" || !raw.targetId.trim()) throw new Error("INVALID_REQUEST");
    patch.targetId = raw.targetId.trim();
  }
  if (action === "unbind" && !patch.targetId) throw new Error("INVALID_REQUEST");
  if (action === "unbind" || action === "disconnect") {
    if (Object.keys(raw).some(key => key !== "agent" && key !== "action" && key !== "targetId")) {
      throw new Error("INVALID_REQUEST");
    }
    return patch;
  }

  if (raw.boundTargetIds !== undefined) {
    if (!Array.isArray(raw.boundTargetIds)
      || raw.boundTargetIds.some(item => typeof item !== "string" || !item.trim())) {
      throw new Error("INVALID_REQUEST");
    }
    patch.boundTargetIds = [...new Set(raw.boundTargetIds.map(item => (item as string).trim()))];
  }
  patch.defaultTargetId = readOptionalString(raw.defaultTargetId, true);
  patch.defaultModelId = readOptionalString(raw.defaultModelId);
  patch.defaultCredentialId = readOptionalString(raw.defaultCredentialId);
  if (raw.cliSyncEnabled !== undefined) {
    if (typeof raw.cliSyncEnabled !== "boolean") throw new Error("INVALID_REQUEST");
    patch.cliSyncEnabled = raw.cliSyncEnabled;
  }
  if (raw.modelAliases !== undefined) patch.modelAliases = normalizeModelAliasesPatch(raw.modelAliases);
  return patch;
}

function readOptionalString(value: unknown, allowEmpty = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("INVALID_REQUEST");
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error("INVALID_REQUEST");
  return normalized;
}

function normalizeModelAliasesPatch(value: unknown): NonNullable<AgentConnectionPatchUpdate["modelAliases"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set(["opus", "sonnet", "haiku"]);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) throw new Error("INVALID_REQUEST");
  const aliases: NonNullable<AgentConnectionPatchUpdate["modelAliases"]> = {};
  for (const key of ["opus", "sonnet", "haiku"] as const) {
    const normalized = readOptionalString(raw[key]);
    if (normalized) aliases[key] = normalized;
  }
  return aliases;
}

export async function assertTargetPatchPricing(
  update: ProxyConfigUpdate,
  currentTargets: ProxyTarget[],
  dataDir: string,
): Promise<void> {
  const targetPatch = update.targetPatch;
  if (!targetPatch) return;
  const patch = targetPatch.target;
  // 停用是收缩运行能力与清理 Agent 受管配置的安全操作，不能被供应商中的历史价格缺口阻塞。
  // 仅对纯 enabled=false 补丁放行；重新启用或同时修改模型/价格时仍执行完整价格中心校验。
  if (targetPatch.id && patch.enabled === false && Object.keys(patch).length === 1) return;
  const current = targetPatch.id ? currentTargets.find(target => target.id === targetPatch.id) : undefined;
  const supportedModels = Array.isArray(patch.supportedModels)
    ? patch.supportedModels
    : current?.supportedModels || [];
  const pricing = patch.pricing === undefined
    ? current?.pricing
    : {...current?.pricing, ...patch.pricing};
  assertProxyTargetPriceMappings(await readPricingConfig(dataDir), {supportedModels, pricing});
}

/**
 * 自定义（非官方预设）目标的 supportedModelWireApis 是按「协议 URL × 模型家族」推断的
 * 派生声明：保存时按合并后的最新 URL 重推断，修复"先只配 openaiUrl 确认 claude 模型
 * （落库空数组）之后才补 anthropicUrl"这类过期空声明——空数组是显式拒绝且读取端不回退，
 * 不重算会永久封死所有 Agent 的兼容判定。官方预设的声明来自模型目录，不在此重算。
 */
export function refreshCustomTargetModelWireApis(update: ProxyConfigUpdate, currentTargets: ProxyTarget[]): void {
  const targetPatch = update.targetPatch;
  if (!targetPatch?.id) return;
  const current = currentTargets.find(target => target.id === targetPatch.id);
  if (!current) return;
  if (current.presetId || resolveOfficialPresetForTarget(current)) return;
  const patch = targetPatch.target;
  // 用键存在性（而非类型）取合并后的 URL：显式置 undefined 表示移除该协议，同样要参与重推断。
  const openaiUrl = "openaiUrl" in patch ? patch.openaiUrl : current.openaiUrl;
  const anthropicUrl = "anthropicUrl" in patch ? patch.anthropicUrl : current.anthropicUrl;
  const modelIds = Array.isArray(patch.supportedModels) ? patch.supportedModels : current.supportedModels;
  if (modelIds.length === 0) return;
  targetPatch.target = {
    ...patch,
    supportedModelWireApis: Object.fromEntries(modelIds.map(modelId => [
      modelId,
      inferCustomTargetModelWireApis(modelId, {openaiUrl, anthropicUrl}),
    ])),
  };
}

/** 官方 URL 供应商在正常保存时补齐价格映射；纯停用保持收缩操作，不附带其它修复。 */export async function reconcileOfficialTargetPatchPricing(
  update: ProxyConfigUpdate,
  currentTargets: ProxyTarget[],
  dataDir: string,
): Promise<void> {
  const targetPatch = update.targetPatch;
  if (!targetPatch?.id) return;
  const patch = targetPatch.target;
  if (patch.enabled === false && Object.keys(patch).length === 1) return;
  const current = currentTargets.find(target => target.id === targetPatch.id);
  if (!current) return;
  const candidate: ProxyTarget = {
    ...current,
    ...patch,
    pricing: patch.pricing === undefined
      ? current.pricing
      : {...current.pricing, ...patch.pricing},
  };
  const repair = reconcileOfficialTargetModelVendors(candidate, await readPricingConfig(dataDir));
  if (!repair) return;
  targetPatch.target = {
    ...patch,
    ...repair,
    pricing: repair.pricing === undefined
      ? patch.pricing
      : {...patch.pricing, ...repair.pricing},
  };
}
