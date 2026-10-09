import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  readBoundedJson,
} from "@/lib/development-launch/security";
import {ensurePricingConfigRevision} from "@/lib/ingestion/pricing-revisions";
import {loadProviderCatalog} from "@/lib/provider-catalog/cache";
import {
  readEffectivePricingConfig,
  readPricingConfig,
  withPricingConfigMutation,
  writePricingConfig,
} from "@/lib/pricing";
import {readBundledLiteLLMPricingSnapshot} from "@/lib/pricing-import";
import {
  describeRestoreSource,
  findPricingEntry,
  findPersistedRestoreSources,
  findRestoreSourceInBaseline,
  findRestoreSourceInCatalog,
  findRestoreSourceInLiteLLM,
  findTargetPricingOverrideOwners,
  restorePricingEntry,
  selectRestoreSource,
  type PricingRestoreIdentity,
} from "@/lib/pricing-restore";
import {ProxyConfigStore} from "@/proxy-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATA_DIR = resolveDeepaaDataDir();
const proxyConfig = new ProxyConfigStore();

/** 取消价格中心全局手工覆盖：按官方当前/历史底稿优先、LiteLLM 兜底单条替换，目标映射与目标覆盖保持不变。 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request) as Record<string, unknown>;
    const vendor = stringField(body.vendor, "vendor");
    const runtimeModelId = stringField(body.runtimeModelId, "runtimeModelId");
    const identity: PricingRestoreIdentity = {vendor, runtimeModelId};

    await proxyConfig.reload();
    const currentConfig = proxyConfig.getConfig();
    const database = getDeepaaDatabase(DATA_DIR);
    const previousPricing = await readPricingConfig(DATA_DIR);
    const oldEntry = findPricingEntry(previousPricing, identity);
    if (!oldEntry) {
      return jsonResponse({error: "PRICE_ENTRY_NOT_FOUND", message: "价格中心未找到该条目，可能已被删除。"}, 404);
    }

    // 统一“取消手工覆盖”：当前官方目录 > 历史官方底稿 > LiteLLM 底稿/随包快照。
    const currentCatalogSource = await loadProviderCatalog(DATA_DIR, {forceRefresh: false, allowRemote: false})
      .then(envelope => findRestoreSourceInCatalog(envelope, identity))
      .catch(() => undefined);
    const baselineSource = findRestoreSourceInBaseline(database, identity);
    const persistedSources = findPersistedRestoreSources(previousPricing, oldEntry);
    const persistedOfficialSource = persistedSources.official
      || (oldEntry.confidence === "official" || oldEntry.confidence === "provider_docs"
        ? {kind: "official_baseline" as const, entry: oldEntry}
        : undefined);
    const liteLLMSource = findRestoreSourceInLiteLLM(
      await readBundledLiteLLMPricingSnapshot(),
      identity,
    );
    const source = selectRestoreSource({
      currentCatalogSource,
      baselineSource,
      persistedOfficialSource,
      persistedLiteLLMSource: persistedSources.litellm,
      liteLLMSource,
    });
    if (!source) {
      return jsonResponse({
        error: "RESTORE_SOURCE_NOT_FOUND",
        message: "官方当前/历史底稿与 LiteLLM 底稿中都没有该模型，当前条目将继续保留。",
      }, 409);
    }

    const result = await withPricingConfigMutation(DATA_DIR, async () => {
      const current = await readPricingConfig(DATA_DIR);
      const currentEntry = findPricingEntry(current, identity);
      if (!currentEntry) throw new Error("PRICE_ENTRY_NOT_FOUND");
      const restored = restorePricingEntry(current, source, identity);

      await writePricingConfig(DATA_DIR, restored.config);
      try {
        const effective = await readEffectivePricingConfig(DATA_DIR);
        ensurePricingConfigRevision(database, effective);
      } catch (error) {
        // 价格与供应商已共同提交；版本记录失败由 Worker 后续补建，不能回滚用户操作。
        console.error("[deepaa] restore pricing revision failed", error);
      }
      return {
        restoredEntry: restored.entry,
        targetOverrides: findTargetPricingOverrideOwners(currentConfig, currentEntry),
      };
    });

    return jsonResponse({
      ok: true,
      model: result.restoredEntry,
      ...describeRestoreSource(source, result.targetOverrides),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error(`INVALID_REQUEST:${key}`);
  }
  return value.trim();
}
