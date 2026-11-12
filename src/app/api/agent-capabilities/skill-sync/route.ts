import {jsonResponse} from "@/lib/app-state";
import {homedir} from "node:os";
import {performSkillSync} from "@/lib/agent-capabilities/skill-sync-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 跨 Agent skill 同步:薄包装,核心逻辑在 skill-sync-core(可注入 home,测试共用)。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as {
      skillName?: string; sourceAgent?: string; targetAgent?: string;
      sourcePath?: string; confirm?: boolean;
    };
    const outcome = performSkillSync({
      home: homedir(),
      skillName: body.skillName ?? "",
      sourceAgent: body.sourceAgent ?? "",
      targetAgent: body.targetAgent ?? "",
      sourcePath: body.sourcePath ?? "",
      confirm: body.confirm,
    });
    if (outcome.status === 200) return jsonResponse(outcome.body);
    return Response.json(outcome.body, {status: outcome.status});
  } catch (error) {
    return Response.json({error: "SYNC_FAILED", message: (error as Error).message}, {status: 500});
  }
}
