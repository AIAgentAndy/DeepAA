import {jsonResponse} from "@/lib/app-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: {params: Promise<{jobId: string}>}) {
  const {jobId} = await context.params;
  return jsonResponse({jobId, status: "succeeded", candidateCount: 0, processedCount: 0, limited: false, hasMore: false});
}
