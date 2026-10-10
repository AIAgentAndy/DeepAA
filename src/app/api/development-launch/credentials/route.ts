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

/** 批量 targets 参数的目标数上限：防御性收紧，当前侧栏一次最多十几个供应商。 */
const MAX_BATCH_TARGETS = 50;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    // 批量读取（供应商管理首屏一次拉全部供应商，替代逐目标 N 次请求）；
    // 响应形状与单目标不同：itemsByTarget 按目标分组。
    const targetsParam = url.searchParams.get("targets");
    if (targetsParam !== null) {
      const targetIds = targetsParam.split(",").map(value => value.trim()).filter(Boolean).slice(0, MAX_BATCH_TARGETS);
      if (targetIds.length === 0) throw new Error("INVALID_REQUEST");
      return Response.json({itemsByTarget: await getDevelopmentLaunchService().listCredentialsForTargets(targetIds)});
    }
    const targetId = url.searchParams.get("targetId");
    if (!targetId) throw new Error("INVALID_REQUEST");
    return Response.json({items: await getDevelopmentLaunchService().listCredentials(targetId)});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const credential = await getDevelopmentLaunchService().createCredential({
      targetId: stringField(body, "targetId"),
      label: stringField(body, "label"),
      secret: stringField(body, "secret"),
      rateMultiplier: optionalRateMultiplier(body),
      agentScope: optionalCreateAgentScope(body),
    });
    return Response.json({ credential, nonce: getLaunchNonceStore().issue() }, { status: 201 });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

/** 更新密钥名称/价格倍率/密钥内容（secret 可选，省略则保留原内容）。 */
export async function PUT(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const credential = await getDevelopmentLaunchService().updateCredential({
      targetId: stringField(body, "targetId"),
      credentialId: stringField(body, "credentialId"),
      label: typeof body.label === "string" ? body.label : undefined,
      rateMultiplier: optionalRateMultiplier(body),
      agentScope: optionalUpdateAgentScope(body),
      secret: typeof body.secret === "string" && body.secret ? body.secret : undefined,
    });
    return Response.json({ credential, nonce: getLaunchNonceStore().issue() });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string" || !body[key]) throw new Error("INVALID_REQUEST");
  return body[key];
}

function optionalRateMultiplier(body: Record<string, unknown>): number | undefined {
  if (body.rateMultiplier === undefined || body.rateMultiplier === null || body.rateMultiplier === "") {
    return undefined;
  }
  const value = Number(body.rateMultiplier);
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_REQUEST");
  return value;
}

function optionalCreateAgentScope(body: Record<string, unknown>): string[] | undefined {
  if (body.agentScope === undefined || body.agentScope === null) return undefined;
  if (!Array.isArray(body.agentScope)) throw new Error("INVALID_REQUEST");
  return body.agentScope.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** PUT 使用 null 明确表示清空白名单；undefined 则保留原值。 */
function optionalUpdateAgentScope(body: Record<string, unknown>): string[] | null | undefined {
  if (body.agentScope === undefined) return undefined;
  if (body.agentScope === null) return null;
  if (!Array.isArray(body.agentScope)) throw new Error("INVALID_REQUEST");
  return body.agentScope.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}
