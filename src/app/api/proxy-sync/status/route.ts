import {getSyncService} from "@/lib/sync-engine/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const targetId = new URL(request.url).searchParams.get("target");
    if (!targetId) throw new Error("INVALID_REQUEST");
    return Response.json(await (await getSyncService()).status(targetId));
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, {status: 400});
  }
}
