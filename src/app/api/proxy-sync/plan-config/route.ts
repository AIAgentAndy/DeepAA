import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";
import {getSyncService} from "@/lib/sync-engine/service";
import {
  isSyncIntervalMinutes,
  type PlanProviderType,
  type SyncIntervalMinutes,
} from "@/lib/sync-engine/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    // 先做纯请求校验，再初始化服务：非法周期不触碰同步引擎。
    const syncIntervalMinutes = optionalSyncIntervalField(body);
    const {config, sync} = await (await getSyncService()).savePlanSyncConfig({
      targetId: stringField(body, "targetId"),
      providerType: providerField(body.providerType),
      credentialId: optionalString(body.credentialId),
      accessKeyId: optionalString(body.accessKeyId),
      secretAccessKey: optionalString(body.secretAccessKey),
      expectedRevision: revisionField(body.expectedRevision),
      syncIntervalMinutes,
      planTier: optionalTierField(body.planTier),
    });
    // sync 是保存后立即执行的首次同步结果；失败时页面据此立刻提醒用户。
    return Response.json({
      config: {
        targetId: config.targetId,
        providerType: config.providerType,
        credentialId: config.credentialId,
        status: config.status,
        hasAccessKey: Boolean(config.accessKeyRef),
        hasSecretKey: Boolean(config.secretKeyRef),
        syncIntervalMinutes: config.syncIntervalMinutes,
      },
      sync,
      nonce: getLaunchNonceStore().issue(),
    }, {status: 201});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const removed = await (await getSyncService()).removePlanSyncConfig(
      stringField(body, "targetId"),
      revisionField(body.expectedRevision),
    );
    return Response.json({removed, nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error("INVALID_REQUEST");
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4096) throw new Error("INVALID_REQUEST");
  return value.trim() || undefined;
}

function revisionField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("INVALID_REQUEST");
  }
  return value;
}

/** 可选同步周期（分钟）：传入时必须是白名单值域，否则视为非法请求。 */
function optionalSyncIntervalField(body: Record<string, unknown>): SyncIntervalMinutes | undefined {
  const value = body.syncIntervalMinutes;
  if (value === undefined || value === null) return undefined;
  if (isSyncIntervalMinutes(value)) return value;
  throw new Error("INVALID_REQUEST");
}

/** 可选套餐档位 id（2026-09-30 OpenCode Go go/go-plus）：语法恒校验，目录归属由 SyncService 校验。 */
function optionalTierField(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
    throw new Error("INVALID_REQUEST");
  }
  return value;
}

function providerField(value: unknown): PlanProviderType {
  if (value === "kimi-coding" || value === "zhipu" || value === "minimax"
    || value === "volcengine-plan" || value === "volcengine-coding-plan"
    || value === "qwenai-token-plan" || value === "opencode-go"
    || value === "openai-subscription" || value === "anthropic-subscription") return value;
  if (value === "dashscope") return "qwenai-token-plan";
  throw new Error("INVALID_REQUEST");
}
