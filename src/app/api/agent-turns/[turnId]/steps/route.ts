import { getDeepaaDatabase } from "@/lib/db/connection";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import { loadTurnSteps } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  try {
    const { turnId } = await context.params;
    const page = loadTurnSteps(
      getDeepaaDatabase(),
      decodeURIComponent(turnId),
      new URL(request.url).searchParams,
      // 压缩边界证据可能存于外置 derived blob（大 turn 快照），需 dataDir 解析。
      resolveDeepaaDataDir(),
    );
    return page
      ? Response.json(page)
      : notFoundResponse("Agent Turn 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
