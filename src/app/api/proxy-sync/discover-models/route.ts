import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";
import {getSyncService} from "@/lib/sync-engine/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 模型发现只返回只读候选；action=confirm 时才按用户选择写入 Agent 可见模型。
 */
export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const targetId = stringField(body, "targetId");
    const credentialId = typeof body.credentialId === "string" && body.credentialId.trim()
      ? body.credentialId.trim()
      : undefined;
    const service = await getSyncService();
    const action = body.action === "confirm" ? "confirm" : "discover";
    const result = action === "confirm"
      ? await service.confirmDiscoveredModels(targetId, requiredString(body, "credentialId"), stringArray(body, "selectedModelIds"))
      : await service.discoverModels(targetId, credentialId);
    return Response.json({...result, nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string" || !body[key].trim()) throw new Error("INVALID_REQUEST");
  return body[key].trim();
}

function requiredString(body: Record<string, unknown>, key: string): string {
  return stringField(body, key);
}

function stringArray(body: Record<string, unknown>, key: string): string[] {
  if (!Array.isArray(body[key])) throw new Error("INVALID_REQUEST");
  return body[key].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}
