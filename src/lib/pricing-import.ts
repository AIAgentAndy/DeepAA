import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalizeLiteLLMPricingConfig,
  mergeLiteLLMPricingConfig,
  normalizeLiteLLMPricingCatalog,
  normalizePricingConfig,
  readEffectivePricingConfig,
  readPersistedPricingConfig,
  readPricingConfig,
  withPricingConfigMutation,
  writePricingConfig,
  type PricingCatalogSource,
  type PricingConfigV2,
} from "./pricing";
import { getDeepaaDatabase } from "./db/connection";
import { ensurePricingConfigRevision } from "./ingestion/pricing-revisions";
import {upsertPricingSourceBaseline} from "./pricing/source-baseline-store";
import { loadProviderCatalog } from "./provider-catalog/cache";
import { mergeProviderCatalogPricing } from "./provider-catalog/pricing";

export const DEFAULT_LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 15_000;
const LOG_PREFIX = "[deepaa:pricing]";

/** 随版本发布的 LiteLLM 离线快照；用于“取消手工覆盖”在没有官方目录条目时的兜底来源。 */
export async function readBundledLiteLLMPricingSnapshot(): Promise<PricingConfigV2> {
  return readBundledPricingSnapshot();
}

let autoImportStarted = false;

export interface LiteLLMImportOptions {
  sourceUrl?: string;
  /** 测试只注入已经解析的快照加载器，生产文件读取始终使用固定发布资源路径。 */
  loadBundledSnapshot?: () => Promise<PricingConfigV2>;
  fetchCatalogText?: (sourceUrl: string, signal?: AbortSignal) => Promise<string>;
  recordPricingRevision?: (dataDir: string, effectiveAt: string) => Promise<void>;
  now?: () => Date;
}

export interface LiteLLMImportResult {
  catalogSource?: PricingCatalogSource;
  importedModelCount: number;
  mergedModelCount: number;
  remoteUpdated: boolean;
}

export interface LiteLLMRefreshResult extends LiteLLMImportResult {
  source: "remote" | "local" | "snapshot";
  warning?: string;
}

/**
 * 刷新 LiteLLM 目录：先保证本地已有可用价格，再尝试远程更新。
 * 远程失败时保留本地成功版本；只有本地配置缺失时才初始化随版本发布的快照。
 */
export async function refreshLiteLLMPricingCatalog(
  dataDir: string,
  options: LiteLLMImportOptions = {},
): Promise<LiteLLMRefreshResult> {
  const now = options.now || (() => new Date());
  const initialized = await withPricingConfigMutation(dataDir, async () => {
    const local = await readPersistedPricingConfig(dataDir);
    if (local) return { current: local, source: "local" as const };
    const loadBundledSnapshot = options.loadBundledSnapshot || readBundledPricingSnapshot;
    // 快照初始化同样记录 LiteLLM 导入标记：价格中心版本条需要展示导入完成时间。
    const snapshotData = await loadBundledSnapshot();
    const snapshot = {
      ...canonicalizeLiteLLMPricingConfig(snapshotData),
      litellmSync: {syncedAt: now().toISOString(), modelCount: snapshotData.models.length},
    };
    await persistPricingConfigWithRevision(dataDir, snapshot, now(), options.recordPricingRevision);
    return { current: snapshot, source: "snapshot" as const };
  });

  try {
    const imported = await importLiteLLMPricingCatalog(dataDir, options);
    return {
      ...imported,
      source: "remote",
    };
  } catch (error) {
    return {
      catalogSource: initialized.current.catalogSource,
      importedModelCount: 0,
      mergedModelCount: initialized.current.models.length,
      remoteUpdated: false,
      source: initialized.source,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 只执行一次远程导入。调用方可用 refreshLiteLLMPricingCatalog 获得本地/快照兜底。
 * 用户手动修改/新增的 user_override 记录不会被覆盖。
 */
export async function importLiteLLMPricingCatalog(
  dataDir: string,
  options: LiteLLMImportOptions = {},
): Promise<LiteLLMImportResult> {
  const sourceUrl = options.sourceUrl?.trim() || DEFAULT_LITELLM_PRICING_URL;
  if (!sourceUrl.startsWith("https://raw.githubusercontent.com/BerriAI/litellm/")) {
    throw new Error("只允许从 LiteLLM 官方 GitHub raw 价格表导入。");
  }

  const text = await fetchLiteLLMCatalogText(sourceUrl, options);
  let catalog: unknown;
  try {
    catalog = JSON.parse(text);
  } catch {
    throw new Error("LiteLLM 价格表不是合法 JSON。");
  }

  const fetchedAt = (options.now || (() => new Date()))().toISOString();
  const imported = normalizeLiteLLMPricingCatalog(catalog, {
    sourceUrl,
    fetchedAt,
    sourceHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  });
  return withPricingConfigMutation(dataDir, async () => {
    // 网络请求期间用户可能已经保存新价格；必须在临界区内重读并以最新版本合并。
    const current = await readPersistedPricingConfig(dataDir) || await readPricingConfig(dataDir);
    const currentByIdentity = new Map(current.models.map(entry => [
      `${entry.vendor.trim().toLowerCase()}\u0000${(entry.runtimeModelId || entry.match || entry.patterns[0] || entry.id).trim().toLowerCase()}`,
      entry,
    ]));
    // LiteLLM 只有在全局人工覆盖存在时才需要保留最新来源；
    // 首次纯 LiteLLM 导入不额外创建重复底稿。
    for (const entry of imported.models) {
      const runtimeModelId = entry.runtimeModelId || entry.match || entry.patterns[0] || entry.id;
      const existing = currentByIdentity.get(`${entry.vendor.trim().toLowerCase()}\u0000${runtimeModelId.trim().toLowerCase()}`);
      if (existing?.confidence !== "user_override") continue;
      upsertPricingSourceBaseline(getDeepaaDatabase(dataDir), {
        vendor: entry.vendor,
        runtimeModelId,
        sourceKind: "litellm",
        sourceRevision: entry.catalogRevision,
        sourceHash: entry.catalogSourceHash,
        capturedAt: fetchedAt,
        entry: {
          ...entry,
          confidence: "third_party",
        },
      });
    }
    const merged = mergeLiteLLMPricingConfig(current, imported);
    const sameSourceHash = current.catalogSource?.type === "litellm"
      && current.catalogSource.hash === imported.catalogSource?.hash;
    if (!sameSourceHash) {
      // 内容有实际变化才落盘；litellmSync 同步更新为本次导入（syncedAt = 版本时间语义）。
      const mergedWithMarker: PricingConfigV2 = {
        ...merged,
        litellmSync: {syncedAt: fetchedAt, modelCount: merged.models.length},
      };
      await persistPricingConfigWithRevision(dataDir, mergedWithMarker, fetchedAt, options.recordPricingRevision);
    }

    return {
      catalogSource: sameSourceHash ? current.catalogSource : merged.catalogSource,
      importedModelCount: imported.models.length,
      mergedModelCount: merged.models.length,
      remoteUpdated: !sameSourceHash,
    };
  });
}

/** Next 启动后异步刷新 LiteLLM 目录。失败只打日志，不阻塞 UI 或代理。 */
export function startPricingImportScheduler(dataDir: string): void {
  if (autoImportStarted) return;
  autoImportStarted = true;
  console.info(`${LOG_PREFIX} LiteLLM auto import starting dataDir=${dataDir}`);
  void refreshLiteLLMPricingCatalog(dataDir)
    .then(result => {
      const detail = result.warning ? ` warning=${result.warning}` : "";
      console.info(`${LOG_PREFIX} LiteLLM auto import source=${result.source} updated=${result.remoteUpdated} models=${result.mergedModelCount}${detail}`);
    })
    .catch(error => {
      autoImportStarted = false;
      console.warn(`${LOG_PREFIX} LiteLLM auto import failed`, error);
    });
}



async function fetchLiteLLMCatalogText(
  sourceUrl: string,
  options: LiteLLMImportOptions,
): Promise<string> {
  const fetchCatalogText = options.fetchCatalogText || defaultFetchCatalogText;
  const text = await fetchCatalogText(sourceUrl, AbortSignal.timeout(REMOTE_TIMEOUT_MS));
  if (Buffer.byteLength(text, "utf-8") > MAX_CATALOG_BYTES) {
    throw new Error("LiteLLM 价格表超过安全大小限制。");
  }
  return text;
}

async function defaultFetchCatalogText(sourceUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(sourceUrl, { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`LiteLLM 价格表下载失败：HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES) {
    throw new Error("LiteLLM 价格表超过安全大小限制。");
  }
  return response.text();
}

async function readBundledPricingSnapshot(): Promise<PricingConfigV2> {
  // 路径固定且由 Next outputFileTracingIncludes 显式发布，禁止 Turbopack 从 cwd 扩散追踪。
  const path = join(
    /* turbopackIgnore: true */ process.cwd(),
    "data",
    "defaults",
    "litellm-model-prices.snapshot.json",
  );
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_CATALOG_BYTES) {
    throw new Error("随版本发布的 LiteLLM 价格快照不可用或超过安全大小限制。");
  }
  const raw = await readFile(path);
  if (raw.byteLength > MAX_CATALOG_BYTES) {
    throw new Error("随版本发布的 LiteLLM 价格快照不可用或超过安全大小限制。");
  }
  const parsed = JSON.parse(raw.toString("utf-8")) as { models?: unknown };
  if (!Array.isArray(parsed.models)) {
    throw new Error("随版本发布的 LiteLLM 价格快照格式无效。");
  }
  return normalizePricingConfig(parsed);
}

async function persistPricingConfigWithRevision(
  dataDir: string,
  config: PricingConfigV2,
  effectiveAt: string | Date,
  recordRevision = defaultRecordPricingRevision,
): Promise<void> {
  const timestamp = effectiveAt instanceof Date ? effectiveAt.toISOString() : effectiveAt;
  try {
    await recordRevision(dataDir, timestamp);
  } catch (error) {
    console.error("[deepaa] pricing revision record failed", error);
  }
  await writePricingConfig(dataDir, config);
  try {
    await recordRevision(dataDir, timestamp);
  } catch (error) {
    console.error("[deepaa] pricing revision record failed", error);
  }
}

async function defaultRecordPricingRevision(dataDir: string, effectiveAt: string): Promise<void> {
  const current = await readEffectivePricingConfig(dataDir);
  ensurePricingConfigRevision(getDeepaaDatabase(dataDir), current, effectiveAt);
}
