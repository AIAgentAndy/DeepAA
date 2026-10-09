import { jsonResponse } from "@/lib/app-state";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { DEFAULT_LITELLM_PRICING_URL, refreshLiteLLMPricingCatalog } from "@/lib/pricing-import";

export const dynamic = "force-dynamic";

const DATA_DIR = resolveDeepaaDataDir();
// 显式导入 LiteLLM 社区价格表；失败时保留本地成功版本或随版本快照。
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { sourceUrl?: unknown };
  const sourceUrl = typeof body.sourceUrl === "string" && body.sourceUrl.trim()
    ? body.sourceUrl.trim()
    : DEFAULT_LITELLM_PRICING_URL;
  try {
    const result = await refreshLiteLLMPricingCatalog(DATA_DIR, { sourceUrl });
    return jsonResponse({
      ok: true,
      catalogSource: result.catalogSource,
      modelCount: result.importedModelCount,
      mergedModelCount: result.mergedModelCount,
      source: result.source,
      remoteUpdated: result.remoteUpdated,
      warning: result.warning,
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "LiteLLM 价格表导入失败。" }, 502);
  }
}
