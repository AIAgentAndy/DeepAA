import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {loadProviderCatalog} from "@/lib/provider-catalog/cache";
import {createProviderCatalogReview} from "@/lib/provider-catalog/service";
import {readPricingConfig} from "@/lib/pricing";
import {ProxyConfigStore} from "@/proxy-config";
import {getLaunchNonceStore} from "@/lib/development-launch/security";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {listCurrentOfficialModelIds} from "@/lib/provider-catalog/membership-store";
import {PROVIDER_PRESETS} from "@/lib/provider-presets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATA_DIR = resolveDeepaaDataDir();
const proxyConfig = new ProxyConfigStore();

/** 读取目录候选；forceRefresh 只影响固定远端缓存，不写价格或供应商配置。 */
export async function GET(request: Request): Promise<Response> {
  try {
    await proxyConfig.reload();
    const url = new URL(request.url);
    const presetId = requiredQuery(url.searchParams.get("preset"));
    const targetId = optionalQuery(url.searchParams.get("target"));
    // 供应商管理「刷新预设模型」只读取价格中心与本地目录元数据，不触网。
    // 远程目录刷新由启动/每小时官方目录同步器负责，避免 UI 查询产生网络副作用。
    const envelope = await loadProviderCatalog(DATA_DIR, {allowRemote: false});
    const pricing = await readPricingConfig(DATA_DIR);
    const catalogKey = PROVIDER_PRESETS.find(item => item.id === presetId || item.catalogKey === presetId)?.catalogKey || presetId;
    const review = createProviderCatalogReview(
      proxyConfig.getConfig(),
      targetId,
      presetId,
      envelope,
      pricing,
      listCurrentOfficialModelIds(getDeepaaDatabase(DATA_DIR), catalogKey),
    );
    return jsonResponse({...review, modelSource: "price_center", nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return jsonResponse({error: errorCode(error), message: error instanceof Error ? error.message : "供应商目录读取失败"}, 400);
  }
}

function requiredQuery(value: string | null): string {
  if (!value?.trim() || value.length > 128) throw new Error("INVALID_REQUEST");
  return value.trim();
}

function optionalQuery(value: string | null): string | undefined {
  if (!value) return undefined;
  if (value.length > 128) throw new Error("INVALID_REQUEST");
  return value.trim() || undefined;
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)
    ? error.message
    : "PROVIDER_CATALOG_UNAVAILABLE";
}
