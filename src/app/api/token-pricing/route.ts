import { jsonResponse } from "@/lib/app-state";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import { loadTokenPricingState } from "@/lib/token-pricing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const dataDir = resolveDeepaaDataDir();
  const db = getDeepaaDatabase(dataDir);
  return jsonResponse(await loadTokenPricingState(url.searchParams, {
    dataDir,
    db,
  }));
}
