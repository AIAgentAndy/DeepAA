import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import { loadThreadTurns } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  try {
    const { threadId } = await context.params;
    const page = loadThreadTurns(
      getDeepaaDatabase(),
      decodeURIComponent(threadId),
      new URL(request.url).searchParams,
    );
    return page
      ? Response.json(page)
      : notFoundResponse("Agent Thread 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
