import { getDeepaaDatabase } from "@/lib/db/connection";
import { jsonResponse } from "@/lib/app-state";
import { lookupCapability } from "@/lib/db/capability-lookup-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * P1-4（2026-11-03）：能力双向反查（只读，名字级身份）。
 * GET /api/capabilities/lookup?agent=<agentName>&kind=tool|skill&name=<name>&cursor=
 * 返回调用反查（keyset 分页）+ 声明出现 + 汇总；不扫描磁盘、不读 Raw。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const agent = params.get("agent")?.trim() || "";
    const name = params.get("name")?.trim() || "";
    const kindParam = params.get("kind") ?? "tool";
    const cursor = params.get("cursor")?.trim() || undefined;
    if (!agent || !name) {
      return Response.json({error: "MISSING_PARAMS", message: "agent 与 name 必填"}, {status: 400});
    }
    if (kindParam !== "tool" && kindParam !== "skill") {
      return Response.json({error: "INVALID_KIND", message: "kind 只支持 tool|skill"}, {status: 400});
    }
    if (name.length > 256) {
      return Response.json({error: "NAME_TOO_LONG"}, {status: 400});
    }
    const db = getDeepaaDatabase();
    const result = lookupCapability(db, {agentName: agent, kind: kindParam, name, ...(cursor ? {cursor} : {})});
    if (!result) {
      return Response.json({error: "MISSING_PARAMS", message: "agent 与 name 必填"}, {status: 400});
    }
    return jsonResponse(result);
  } catch (error) {
    return Response.json({error: "LOOKUP_FAILED", message: (error as Error).message}, {status: 500});
  }
}
