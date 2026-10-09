import { getDevelopmentLaunchService } from "@/lib/development-launch/service";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ credentialId: string }> },
) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const { credentialId } = await context.params;
    const targetId = typeof body.targetId === "string" ? body.targetId : "";
    if (!targetId) throw new Error("INVALID_REQUEST");
    await getDevelopmentLaunchService().deleteCredential({ targetId, credentialId });
    return Response.json({ deleted: true, nonce: getLaunchNonceStore().issue() });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
