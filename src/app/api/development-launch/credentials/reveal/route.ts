import {getSyncService} from "@/lib/sync-engine/service";
import {fingerprintForSecret} from "@/lib/development-launch/credential-metadata";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_KINDS = new Set(["credential", "console", "plan-ak", "plan-sk"]);

/**
 * 凭据明文取回（复制按钮专用）：同源 loopback + 单次 nonce 保护；
 * 响应只含打码串与明文，明文不落日志、不入任何持久化状态。
 */
export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    const nonce = requireLaunchNonce(body);
    const kind = typeof body.kind === "string" && VALID_KINDS.has(body.kind) ? body.kind : "";
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    const credentialId = typeof body.credentialId === "string" ? body.credentialId.trim() : undefined;
    if (!kind || !targetId) throw new Error("INVALID_REQUEST");
    const value = await (await getSyncService()).revealSecret({
      kind: kind as "credential" | "console" | "plan-ak" | "plan-sk",
      targetId,
      ...(credentialId ? {credentialId} : {}),
    });
    return Response.json({masked: fingerprintForSecret(value), value, nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
