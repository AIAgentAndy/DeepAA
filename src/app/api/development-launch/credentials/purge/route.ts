import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";
import {getDevelopmentLaunchService} from "@/lib/development-launch/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 删除代理供应商时的级联清理：清空该供应商全部系统凭据（绕过「至少保留一个密钥」限制）。 */
export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    if (typeof body.targetId !== "string" || !body.targetId.trim()) throw new Error("INVALID_REQUEST");
    const result = await (await getDevelopmentLaunchService()).purgeTargetCredentials(body.targetId.trim());
    return Response.json({...result, nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
