import { jsonResponse } from "@/lib/app-state";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import { ensurePricingConfigRevision } from "@/lib/ingestion/pricing-revisions";
import {litellmChangeRevision, manualChangeRevision, recordPriceChange} from "@/lib/provider-catalog/notification-store";
import {modelFieldChanges} from "@/lib/provider-catalog/pricing-diff";
import {readTargetModelUsage} from "@/lib/provider-catalog/catalog-runner";
import {
  normalizeLiteLLMPricingCatalog,
  mergeLiteLLMPricingConfig,
  normalizePricingConfig,
  pricingEntryRuntimeModelId,
  queryPricingCatalog,
  queryPricingVendors,
  applyProxyTargetPricing,
  readProxyConfigForPricing,
  readPricingConfig,
  upsertPricingConfigModels,
  withPricingConfigMutation,
  writePricingConfig,
  parsePricingModelEntryKey,
  resolveFxRate,
  type ModelPriceEntry,
  type PricingConfigV2,
  type PricingConfig,
  type PricingEntrySourceCategory,
} from "@/lib/pricing";
import {loadProviderCatalog} from "@/lib/provider-catalog/cache";
import {providerCatalogToPricingEntries} from "@/lib/provider-catalog/pricing";
import {
  describeRestoreSource,
  findPersistedRestoreSources,
  findRestoreSourceInBaseline,
  findRestoreSourceInCatalog,
  findRestoreSourceInLiteLLM,
  findTargetPricingOverrideOwners,
  selectRestoreSource,
} from "@/lib/pricing-restore";
import {readBundledLiteLLMPricingSnapshot} from "@/lib/pricing-import";
import {upsertPricingSourceBaseline} from "@/lib/pricing/source-baseline-store";

export const dynamic = "force-dynamic";

const DATA_DIR = resolveDeepaaDataDir();

// 价格表读写：GET 返回当前生效配置（用户覆盖优先，回退默认），POST 持久化用户修改。
export async function GET(request: Request) {
  const config = await readPricingConfig(DATA_DIR);
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "fx") {
    // 轻量 fx 快照（2026-09-28）：几十字节响应，供展示层「原值（约￥等值）」括号换算；
    // 与入账同源（生效配置 fx），快照缺失时回退随包默认并标记 fallback=true。
    const rawRate = config.fx?.rates?.["USD/CNY"];
    const hasSnapshot = typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate > 0;
    return jsonResponse({
      fx: {
        rate: resolveFxRate(config.fx, "USD", "CNY"),
        ...(config.fx?.asOf ? {asOf: config.fx.asOf} : {}),
        ...(config.fx?.source ? {source: config.fx.source} : {}),
        fallback: !hasSnapshot,
      },
    });
  }
  if (url.searchParams.get("view") === "vendors") {
    return jsonResponse(queryPricingVendors(config));
  }
  if (url.searchParams.get("view") === "catalog") {
    // 多选筛选走重复查询参数（如 vendor=a&vendor=b）；出现多选时旧单值参数不叠加，避免交集语义错误。
    // 模型筛选为条目级复合键 modelEntry（供应商\u0000模型），同名模型跨供应商各自成项。
    const vendorMulti = multiValues(url, "vendor");
    const page = queryPricingCatalog(config, {
      search: url.searchParams.get("search") || undefined,
      vendor: vendorMulti === undefined ? (url.searchParams.get("vendor") || undefined) : undefined,
      mode: url.searchParams.get("mode") || undefined,
      modelEntries: multiValues(url, "modelEntry")
        ?.map(value => parsePricingModelEntryKey(value))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
      vendors: vendorMulti,
      categories: multiValues(url, "category") as PricingEntrySourceCategory[],
      limit: numericParam(url.searchParams.get("limit")),
      offset: numericParam(url.searchParams.get("offset")),
    });
    // 官方预设上游同步状态（版本条「已同步上游最新版」判定）：只读本地目录缓存，绝不触网；
    // 缓存文件仅在远程成功拉取时写入，file-cache/remote 即「触达过上游」，bundled 为从未成功。
    try {
      const envelope = await loadProviderCatalog(DATA_DIR, {allowRemote: false});
      page.upstreamCatalog = {
        publishedAt: envelope.catalog.publishedAt,
        seenUpstream: envelope.source !== "bundled",
      };
    } catch {
      /* 目录缓存不可用：不填 upstreamCatalog，版本条按无法确认上游状态展示 */
    }
    // 恢复按钮只在存在可恢复底稿时出现；判断走有界目录/SQLite/随包快照，
    // 不把纯人工条目误导成“可恢复”。
    try {
      const db = getDeepaaDatabase(DATA_DIR);
      const envelope = await loadProviderCatalog(DATA_DIR, {allowRemote: false});
      const liteLLM = await readBundledLiteLLMPricingSnapshot();
      const proxyConfig = await readProxyConfigForPricing(DATA_DIR);
      const restoreAvailability: NonNullable<typeof page.restoreAvailability> = {};
      for (const item of page.items) {
        if (item.confidence !== "user_override") continue;
        const identity = {
          vendor: item.vendor,
          runtimeModelId: pricingEntryRuntimeModelId(item),
        };
        const baselineSource = findRestoreSourceInBaseline(db, identity);
        const persistedSources = findPersistedRestoreSources(config, item);
        const source = selectRestoreSource({
          currentCatalogSource: findRestoreSourceInCatalog(envelope, identity),
          baselineSource,
          persistedOfficialSource: persistedSources.official,
          persistedLiteLLMSource: persistedSources.litellm,
          liteLLMSource: findRestoreSourceInLiteLLM(liteLLM, identity),
        });
        const availability = describeRestoreSource(
          source,
          proxyConfig ? findTargetPricingOverrideOwners(proxyConfig, item) : [],
        );
        if (availability) restoreAvailability[item.id] = availability;
      }
      page.restoreAvailability = restoreAvailability;
    } catch {
      page.restoreAvailability = {};
    }
    return jsonResponse(page);
  }
  return jsonResponse(config);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
  return withPricingConfigMutation(DATA_DIR, async () => {
    if (body?.litellmCatalog) {
      const current = await readPricingConfig(DATA_DIR);
      const source = typeof (body as { catalogSource?: unknown }).catalogSource === "object" && (body as { catalogSource?: unknown }).catalogSource
        ? (body as { catalogSource: { url?: unknown; fetchedAt?: unknown; hash?: unknown } }).catalogSource
        : undefined;
      const imported = normalizeLiteLLMPricingCatalog(body.litellmCatalog, {
        sourceUrl: typeof source?.url === "string" ? source.url : undefined,
        fetchedAt: typeof source?.fetchedAt === "string" ? source.fetchedAt : undefined,
        sourceHash: typeof source?.hash === "string" ? source.hash : undefined,
      });
      const merged = mergeLiteLLMPricingConfig(current, imported);
      await writePricingConfig(DATA_DIR, merged);
      await recordPricingRevision(merged);
      /* LiteLLM 变更流水（2026-09-10 用户决策）：只记录满足三个条件的模型——
         ① 合并后仍是兜底来源（未被人工作覆盖、未被官方预设置换）
         ② 价格字段确有变化
         ③ 该模型正被某供应商目标关联使用
         数量众多的其余差异（未使用模型的导入刷新）不入表，避免噪音。 */
      try {
        const usage = await readTargetModelUsage(DATA_DIR);
        const beforeByIdentity = new Map(normalizePricingConfig(current).models.map(item => [
          `${item.vendor.trim().toLowerCase()}\u0000${pricingEntryRuntimeModelId(item).trim().toLowerCase()}`,
          item,
        ]));
        const changedAt = new Date();
        const entries = normalizePricingConfig(merged).models.flatMap(item => {
          const modelId = pricingEntryRuntimeModelId(item);
          if (item.confidence === "user_override" || item.confidence === "official") return [];
          const previous = beforeByIdentity.get(`${item.vendor.trim().toLowerCase()}\u0000${modelId.trim().toLowerCase()}`);
          if (!previous) return [];
          if (!usage.isModelInUse(item.vendor, modelId)) return [];
          const changes = modelFieldChanges(item, previous);
          if (changes.length === 0) return [];
          return [{
            vendor: item.vendor,
            modelId,
            changes: changes.map(change => ({
              field: change.field, label: change.label,
              ...(change.before ? {before: change.before} : {}),
              after: change.after, kind: change.kind,
            })),
          }];
        });
        recordPriceChange(getDeepaaDatabase(DATA_DIR), {
          source: "litellm_auto",
          revision: litellmChangeRevision(changedAt),
          changedAt,
          entries,
        });
      } catch (error) {
        // 变更流水失败不影响导入结果。
        console.error("[deepaa] litellm price change record failed", error);
      }
      return jsonResponse({ ok: true, config: merged });
    }
    if (body?.model) {
      const current = await readPricingConfig(DATA_DIR);
      const model = normalizeModelPatch(body.model, current);
      if (!model) return jsonResponse({ error: "invalid pricing model patch" }, 400);
      // 用户在价格中心保存即形成手工覆盖；按供应商 + 运行时模型 upsert，
      // 同一业务条目复用已有内部 id，未提交的历史模型始终保留。
      // previousPricing 始终记录「本次修改前的价格」：列表展示划线旧值 + 绿色新值，
      // 无论条目之前是官方/litellm 来源还是已手动改过，划线永远反映本次变更前的值。
      const existing = current.models.find(item =>
        item.vendor.trim().toLowerCase() === model.vendor.trim().toLowerCase()
        && (item.runtimeModelId || pricingEntryRuntimeModelId(item)).trim().toLowerCase()
          === (model.runtimeModelId || pricingEntryRuntimeModelId(model)).trim().toLowerCase());
      // 价格覆盖只改价格：补丁未携带套餐积分规则时继承既有条目；
      // 既有条目也缺失（曾被旧版本覆盖抹掉）则回填官方目录规则，
      // 避免覆盖保存抹掉 planCreditRules 后套餐通道派生不出积分。
      if (!model.planCreditRules) {
        const inherited = existing?.planCreditRules
          ?? await findCatalogPlanCreditRules(model.vendor, model.runtimeModelId || pricingEntryRuntimeModelId(model));
        if (inherited) model.planCreditRules = inherited;
      }
      const previousPricing = existing?.pricing;
      if (existing && (existing.confidence === "official"
        || existing.confidence === "provider_docs"
        || existing.catalogSource === "catalog")) {
        try {
          upsertPricingSourceBaseline(getDeepaaDatabase(DATA_DIR), {
            vendor: existing.vendor,
            runtimeModelId: pricingEntryRuntimeModelId(existing),
            sourceKind: "official",
            sourceRevision: existing.catalogRevision,
            sourceHash: existing.catalogSourceHash,
            capturedAt: new Date().toISOString(),
            entry: existing,
          });
        } catch (error) {
          console.error("[deepaa] official source baseline backfill failed", error);
        }
      } else if (existing?.confidence === "third_party") {
        try {
          upsertPricingSourceBaseline(getDeepaaDatabase(DATA_DIR), {
            vendor: existing.vendor,
            runtimeModelId: pricingEntryRuntimeModelId(existing),
            sourceKind: "litellm",
            sourceRevision: existing.catalogRevision,
            sourceHash: existing.catalogSourceHash,
            capturedAt: new Date().toISOString(),
            entry: existing,
          });
        } catch (error) {
          console.error("[deepaa] LiteLLM source baseline backfill failed", error);
        }
      }
      const next = upsertPricingConfigModels(current, [{
        ...model,
        confidence: "user_override" as const,
        ...(previousPricing ? {previousPricing} : {}),
      }]);
      // 版本记录只记变更后状态（2026-09-10 性能优化：去掉写盘前那次，
      // 它记录的是变更前旧配置且使全量哈希/SQLite blob 写入翻倍）。
      await writePricingConfig(DATA_DIR, next);
      await recordPricingRevision(next);
      const saved = next.models.find(item => item.vendor.trim().toLowerCase() === model.vendor.trim().toLowerCase()
        && item.runtimeModelId?.trim().toLowerCase() === model.runtimeModelId?.trim().toLowerCase());
      // 人工覆盖变更流水（2026-09-10 用户决策）：只作可查历史，不影响官方映射与计价优先级。
      if (saved) {
        try {
          const changedAt = new Date();
          recordPriceChange(getDeepaaDatabase(DATA_DIR), {
            source: "manual_override",
            revision: manualChangeRevision(changedAt),
            changedAt,
            entries: [{
              vendor: saved.vendor,
              modelId: pricingEntryRuntimeModelId(saved),
              changes: modelFieldChanges(saved, existing ? {...existing, pricing: previousPricing} : undefined as never)
                .map(change => ({field: change.field, label: change.label, ...(change.before ? {before: change.before} : {}), after: change.after, kind: change.kind})),
            }],
          });
        } catch (error) {
          // 变更流水失败不影响保存结果。
          console.error("[deepaa] manual price change record failed", error);
        }
      }
      return jsonResponse({ ok: true, model: saved || model });
    }
    if (!body || !Array.isArray(body.models)) {
      return jsonResponse({ error: "invalid pricing config: models required" }, 400);
    }
    const current = await readPricingConfig(DATA_DIR);
    const submitted = normalizePricingConfig(body as unknown as PricingConfig);
    const nextConfig = upsertPricingConfigModels(current, submitted.models, {protectUserOverride: true});
    await recordPricingRevision(await readPricingConfig(DATA_DIR));
    await writePricingConfig(DATA_DIR, nextConfig);
    await recordPricingRevision(await readPricingConfig(DATA_DIR));
    return jsonResponse({ ok: true });
  });
}

/** 价格中心条目永久保留；恢复官方/LiteLLM 是取消手工覆盖的正式入口。 */
export async function DELETE(_request: Request) {
  return jsonResponse({
    error: "PRICE_ENTRY_DELETE_DISABLED",
    message: "价格中心条目永久保留；如需取消手工覆盖，请使用“取消手工覆盖”入口。",
  }, 409);
}

/**
 * 记录价格版本（2026-09-10 性能优化）：复用刚写盘的配置，只补读很小的
 * proxy-config 应用目标级覆盖，避免重读 2.8 MiB 全量配置并再次归一化。
 */
async function recordPricingRevision(config: PricingConfigV2): Promise<void> {
  try {
    const proxyConfig = await readProxyConfigForPricing(DATA_DIR);
    const effective = proxyConfig ? applyProxyTargetPricing(config, proxyConfig) : config;
    ensurePricingConfigRevision(getDeepaaDatabase(DATA_DIR), effective);
  } catch (error) {
    // 价格文件已经成功保存；版本记录失败时由 Worker 在下批刷新时补建。
    console.error("[deepaa] pricing revision record failed", error);
  }
}

function normalizeModelPatch(value: unknown, current: PricingConfig): ModelPriceEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<ModelPriceEntry>;
  const vendor = typeof raw.vendor === "string" ? raw.vendor.trim() : "";
  const runtimeModelId = typeof raw.runtimeModelId === "string" && raw.runtimeModelId.trim()
    ? raw.runtimeModelId.trim()
    : typeof raw.id === "string" ? raw.id.trim() : "";
  if (!vendor || !runtimeModelId) return undefined;
  const existing = normalizePricingConfig(current).models.find(item =>
    item.vendor.trim().toLowerCase() === vendor.toLowerCase()
    && pricingEntryRuntimeModelId(item).trim().toLowerCase() === runtimeModelId.toLowerCase());
  const requestedId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const normalized = normalizePricingConfig({
    ...current,
    models: [{
      ...raw,
      id: existing?.id || requestedId || generatedPriceEntryId(vendor, runtimeModelId),
      vendor,
      runtimeModelId,
      match: typeof raw.match === "string" && raw.match.trim() ? raw.match : runtimeModelId,
      patterns: Array.isArray(raw.patterns) && raw.patterns.length > 0 ? raw.patterns : [runtimeModelId],
    }],
  });
  return normalized.models[0];
}

function generatedPriceEntryId(vendor: string, runtimeModelId: string): string {
  const normalize = (input: string) => input.trim().replace(/[^A-Za-z0-9._:/-]+/gu, "_") || "unknown";
  return `price:${normalize(vendor.toLowerCase())}:${normalize(runtimeModelId)}`;
}

/** 官方目录中同名（或别名命中）模型的套餐积分规则；目录不可用时返回 undefined，不阻断保存。 */
async function findCatalogPlanCreditRules(
  vendor: string,
  runtimeModelId: string,
): Promise<ModelPriceEntry["planCreditRules"] | undefined> {
  try {
    const {catalog} = await loadProviderCatalog(DATA_DIR);
    const normalize = (value: string) => value.trim().toLowerCase();
    const sameVendor = providerCatalogToPricingEntries(catalog)
      .filter(entry => entry.vendor.trim().toLowerCase() === normalize(vendor));
    const exact = sameVendor.find(entry =>
      (entry.runtimeModelId || pricingEntryRuntimeModelId(entry)).trim().toLowerCase() === normalize(runtimeModelId));
    if (exact?.planCreditRules) return exact.planCreditRules;
    const aliased = sameVendor.find(entry =>
      entry.aliases?.some(alias => normalize(alias) === normalize(runtimeModelId)));
    return aliased?.planCreditRules;
  } catch {
    return undefined;
  }
}

/** 读取重复查询参数（model=a&model=b）；支持同一参数内逗号分隔；无值返回 undefined = 不过滤。 */
function multiValues(url: URL, key: string): string[] | undefined {
  const values = url.searchParams.getAll(key)
    .flatMap(item => item.split(","))
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return values.length > 0 ? values : undefined;
}

function numericParam(value: string | null): number | undefined {  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
