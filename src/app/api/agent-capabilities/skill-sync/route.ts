import {jsonResponse} from "@/lib/app-state";
import {homedir} from "node:os";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";
import {performSkillSync} from "@/lib/agent-capabilities/skill-sync-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 跨 Agent skill 同步:薄包装,核心逻辑在 skill-sync-core(可注入 home,测试共用)。
 * 写盘接口走同源闸门 + 单次 nonce(config-sync 同款,验收审计 B HIGH-1 补齐);
 * nonce 每次消费后轮换下发(含 409/400 响应),客户端用最新值发起下一次。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const outcome = performSkillSync({
      home: homedir(),
      skillName: typeof body.skillName === "string" ? body.skillName : "",
      sourceAgent: typeof body.sourceAgent === "string" ? body.sourceAgent : "",
      targetAgent: typeof body.targetAgent === "string" ? body.targetAgent : "",
      sourcePath: typeof body.sourcePath === "string" ? body.sourcePath : "",
      confirm: body.confirm === true,
    });
    if (outcome.status === 200) return jsonResponse({...outcome.body, nonce: getLaunchNonceStore().issue()});
    return Response.json({...outcome.body, nonce: getLaunchNonceStore().issue()}, {status: outcome.status});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
