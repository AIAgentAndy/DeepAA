import { getDevelopmentLaunchService } from "@/lib/development-launch/service";
import {isKnownAgentId, type AgentId} from "@/types";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const result = await getDevelopmentLaunchService().preflight({
      cli: cliField(body, "cli"),
      targetId: stringField(body, "targetId"),
      projectDir: optionalStringField(body, "projectDir"),
      profile: optionalStringField(body, "profile"),
    });
    return Response.json({ ...result, nonce: getLaunchNonceStore().issue() });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string" || !body[key]) throw new Error("INVALID_REQUEST");
  return body[key];
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  return typeof body[key] === "string" && body[key] ? body[key] : undefined;
}

function cliField(body: Record<string, unknown>, key: string): AgentId {
  const value = body[key];
  if (typeof value !== "string" || !isKnownAgentId(value)) throw new Error("INVALID_REQUEST");
  return value;
}
