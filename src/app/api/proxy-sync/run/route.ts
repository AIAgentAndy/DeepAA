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

/** 立即同步指定代理供应商的控制台或套餐；两条链路不隐式互相回退。 */
export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const targetId = typeof body.targetId === "string" && body.targetId.trim()
      ? body.targetId.trim()
      : undefined;
    if (!targetId) throw new Error("INVALID_REQUEST");
    const service = await getSyncService();
    const result = body.mode === "plan"
      ? await service.runPlanSync(targetId)
      : body.mode === undefined || body.mode === "console"
        ? await service.runSync(targetId)
        : (() => { throw new Error("INVALID_REQUEST"); })();
    return Response.json({result, nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
