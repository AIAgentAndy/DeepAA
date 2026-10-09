import {createHash, randomUUID} from "node:crypto";
import {chmod, mkdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {MAX_PROVIDER_CATALOG_BYTES, normalizeProviderCatalog, parseProviderCatalogText, type ParsedProviderCatalog} from "./normalize";
import type {ProviderCatalog, ProviderCatalogCacheFile, ProviderCatalogEnvelope} from "./types";

export const PROVIDER_CATALOG_REMOTE_URL = "https://deepaa.dev/data/defaults/llm_catalog.jsonl";
export const PROVIDER_CATALOG_CACHE_TTL_MS = 60 * 60 * 1_000;
const PROVIDER_CATALOG_FETCH_TIMEOUT_MS = 15_000;
const CACHE_RELATIVE_PATH = join("config", "provider-catalog-cache.json");
const MAX_CACHE_FILE_BYTES = MAX_PROVIDER_CATALOG_BYTES + 512 * 1024;
const memoryCache = new Map<string, ProviderCatalogEnvelope>();

/**
 * 维护测试专用环境变量：指定本地草稿目录文件，覆盖在线目录。
 *
 * 语义（2026-09-11 用户确认）：设置后**只读该文件、绝不联网、绝不写缓存文件**；
 * 文件缺失或解析失败时**直接抛错中止**（绝不静默回退正常模式，否则维护人员会
 * 误以为测了草稿其实没测）。仅官方目录维护人员本地使用，不写入任何面向用户的配置。
 */
export const CATALOG_OVERRIDE_ENV = "DEEPAA_CATALOG_PATH";

/** 读取覆盖路径；未设置或空串时返回 undefined。 */
export function catalogOverridePath(): string | undefined {
  const value = process.env[CATALOG_OVERRIDE_ENV];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export interface LoadProviderCatalogOptions {
  forceRefresh?: boolean;
  /** false 时绝不访问远程（页面加载角标查询用）：只用内存/文件缓存与随包目录。 */
  allowRemote?: boolean;
  now?: () => Date;
  fetchCatalogText?: (url: string, signal?: AbortSignal) => Promise<string>;
  loadBundledCatalog?: () => Promise<unknown>;
}

/**
 * 读取固定在线目录。正常路径依次检查一小时内存/文件缓存；刷新失败时优先保留
 * 最近一次文件缓存，再降级随包目录，绝不允许客户端覆盖远端 URL。
 * v2：缓存文件版本升为 2（v1 旧缓存自动失效，配合版本闸门切换重置）；解析携带隔离诊断。
 *
 * 维护测试（DEEPAA_CATALOG_PATH 已设置）时短路全部缓存与网络，直接加载指定文件。
 */
export async function loadProviderCatalog(
  dataDir: string,
  options: LoadProviderCatalogOptions = {},
): Promise<ProviderCatalogEnvelope> {
  const now = (options.now || (() => new Date()))();
  const overridePath = catalogOverridePath();
  if (overridePath) return loadCatalogOverride(overridePath, now);

  const cacheKey = join(dataDir, CACHE_RELATIVE_PATH);
  const inMemory = memoryCache.get(cacheKey);
  if (!options.forceRefresh && inMemory && isFresh(inMemory.fetchedAt, now)) return inMemory;

  const fileCache = await readCacheFile(cacheKey);
  if (!options.forceRefresh && fileCache && isFresh(fileCache.fetchedAt, now)) {
    const supplemented = await supplementCacheWithBundled(
      fileCache,
      options.loadBundledCatalog || readBundledCatalogText,
    );
    const envelope = toEnvelope(supplemented, "file-cache");
    memoryCache.set(cacheKey, envelope);
    return envelope;
  }

  if (options.allowRemote === false) {
    // 离线模式（页面加载角标）：缓存任意年龄可用；无缓存则退随包目录。绝不触网。
    if (fileCache) {
      const supplemented = await supplementCacheWithBundled(
        fileCache,
        options.loadBundledCatalog || readBundledCatalogText,
      );
      return toEnvelope(supplemented, "file-cache");
    }
    const parsed = await parseBundled(options.loadBundledCatalog);
    return {
      catalog: parsed.catalog,
      source: "bundled",
      fetchedAt: now.toISOString(),
      sourceHash: sha256(JSON.stringify(parsed.catalog)),
      ...(parsed.diagnostics.length > 0 ? {diagnostics: parsed.diagnostics} : {}),
    } satisfies ProviderCatalogEnvelope;
  }
  try {
    const fetchCatalogText = options.fetchCatalogText || defaultFetchCatalogText;
    const text = await fetchCatalogText(
      PROVIDER_CATALOG_REMOTE_URL,
      AbortSignal.timeout(PROVIDER_CATALOG_FETCH_TIMEOUT_MS),
    );
    const remoteParsed = parseProviderCatalogText(text);
    const merged = await mergeBundledMissingProviders(
      remoteParsed.catalog,
      options.loadBundledCatalog || readBundledCatalogText,
    );
    // 单调性守卫（2026-09-11）：远端可能返回陈旧副本（CDN 缓存、误发低版本）。
    // 若本次结果严格旧于已有缓存，则拒绝覆盖，继续沿用较新的缓存。
    if (fileCache && isOlderCatalog(merged.catalog, fileCache.catalog)) {
      const envelope = {
        ...toEnvelope(fileCache, "file-cache"),
        warning: "在线目录版本早于本地缓存，已忽略本次旧版本。",
      };
      memoryCache.set(cacheKey, envelope);
      return envelope;
    }
    const fetchedAt = now.toISOString();
    const sourceHash = sha256(JSON.stringify(merged.catalog));
    const cacheFile: ProviderCatalogCacheFile = {
      version: 2,
      fetchedAt,
      sourceHash,
      catalog: merged.catalog,
      ...(merged.diagnostics.length > 0 ? {diagnostics: merged.diagnostics} : {}),
    };
    await writeCacheFile(cacheKey, cacheFile);
    const envelope = toEnvelope(cacheFile, "remote");
    memoryCache.set(cacheKey, envelope);
    return envelope;
  } catch (remoteError) {
    const remoteMessage = errorMessage(remoteError);
    if (fileCache) {
      const supplemented = await supplementCacheWithBundled(
        fileCache,
        options.loadBundledCatalog || readBundledCatalogText,
      );
      const envelope = {...toEnvelope(supplemented, "file-cache"), warning: `在线目录刷新失败：${remoteMessage}`};
      memoryCache.set(cacheKey, envelope);
      return envelope;
    }
    try {
      const parsed = await parseBundled(options.loadBundledCatalog);
      const serialized = JSON.stringify(parsed.catalog);
      const envelope: ProviderCatalogEnvelope = {
        catalog: parsed.catalog,
        source: "bundled",
        fetchedAt: now.toISOString(),
        sourceHash: sha256(serialized),
        ...(parsed.diagnostics.length > 0 ? {diagnostics: parsed.diagnostics} : {}),
        warning: `在线目录刷新失败：${remoteMessage}；当前使用随包离线目录。`,
      };
      memoryCache.set(cacheKey, envelope);
      return envelope;
    } catch (bundledError) {
      throw new Error(`供应商目录不可用：${remoteMessage}；随包目录失败：${errorMessage(bundledError)}`);
    }
  }
}

/**
 * 维护测试覆盖加载：只读本地草稿文件，绝不联网、绝不写缓存。
 *
 * 失败一律抛错（路径非绝对、文件缺失、超限、解析失败），保持「测试即所见」。
 */
async function loadCatalogOverride(overridePath: string, now: Date): Promise<ProviderCatalogEnvelope> {
  if (!isAbsolute(overridePath)) {
    throw new Error(`${CATALOG_OVERRIDE_ENV} 必须是绝对路径：${overridePath}`);
  }
  let text: string;
  try {
    const metadata = await stat(overridePath);
    if (!metadata.isFile()) throw new Error("不是常规文件");
    if (metadata.size > MAX_PROVIDER_CATALOG_BYTES) throw new Error("超过 8 MiB 上限");
    text = await readFile(overridePath, "utf8");
  } catch (error) {
    throw new Error(`维护测试目录不可用（${CATALOG_OVERRIDE_ENV}=${overridePath}）：${errorMessage(error)}`);
  }
  const parsed = parseProviderCatalogText(text);
  return {
    catalog: parsed.catalog,
    source: "override",
    fetchedAt: now.toISOString(),
    sourceHash: sha256(JSON.stringify(parsed.catalog)),
    ...(parsed.diagnostics.length > 0 ? {diagnostics: parsed.diagnostics} : {}),
    warning: `维护测试模式：目录来自本地覆盖文件，未联网（${overridePath}）。`,
  };
}

/** next 是否严格旧于 existing：publishedAt 时间戳为主，同刻按 catalogRevision 字典序。 */
function isOlderCatalog(next: ProviderCatalog, existing: ProviderCatalog): boolean {
  const nextAt = Date.parse(next.publishedAt);
  const existingAt = Date.parse(existing.publishedAt);
  if (nextAt !== existingAt) return nextAt < existingAt;
  return next.catalogRevision < existing.catalogRevision;
}

/** 兼容升级前写入的旧文件缓存：v2 起缓存版本必须为 2，旧缓存整体失效（切换重置语义）。 */
async function supplementCacheWithBundled(
  cache: ProviderCatalogCacheFile,
  loadBundledCatalog: () => Promise<unknown>,
): Promise<ProviderCatalogCacheFile> {
  const merged = await mergeBundledMissingProviders(cache.catalog, loadBundledCatalog);
  return {...cache, catalog: merged.catalog, sourceHash: sha256(JSON.stringify(merged.catalog))};
}

/** 在线目录优先，随包目录只补在线尚未发布的供应商，确保新增预设离线/灰度期间仍可创建。 */
async function mergeBundledMissingProviders(
  remoteCatalog: ProviderCatalog,
  loadBundledCatalog: () => Promise<unknown>,
): Promise<ParsedProviderCatalog> {
  try {
    const bundled = await parseBundled(loadBundledCatalog);
    // 双源调和（2026-09-03）：随包目录是发布源文件；远端尚未发布新版本时同 key 以随包为准，
    // 避免发布窗口期远端旧数据覆盖随包新数据。publishedAt 按时间戳比较（跨时区写法安全）。
    const bundledNewer = Date.parse(bundled.catalog.publishedAt) > Date.parse(remoteCatalog.publishedAt);
    const providers = bundledNewer
      ? {...remoteCatalog.providers, ...bundled.catalog.providers}
      : {...bundled.catalog.providers, ...remoteCatalog.providers};
    const winner = bundledNewer ? bundled.catalog : remoteCatalog;
    const merged = normalizeProviderCatalog({
      schemaVersion: winner.schemaVersion,
      catalogRevision: newerRevision(bundled.catalog, remoteCatalog),
      publishedAt: Date.parse(bundled.catalog.publishedAt) >= Date.parse(remoteCatalog.publishedAt)
        ? bundled.catalog.publishedAt
        : remoteCatalog.publishedAt,
      providers,
      ...(winner.fx ? {fx: winner.fx} : {}),
      ...(winner.calendars ? {calendars: winner.calendars} : {}),
    });
    return {catalog: merged.catalog, diagnostics: [...bundled.diagnostics, ...merged.diagnostics]};
  } catch {
    // 随包补齐失败不能把本来可用的在线目录降级成不可用。
    return {catalog: remoteCatalog, diagnostics: []};
  }
}

/** catalogRevision 取字典序更大者（同 publishedAt 时多版区分）。 */
function newerRevision(left: ProviderCatalog, right: ProviderCatalog): string {
  return left.catalogRevision >= right.catalogRevision ? left.catalogRevision : right.catalogRevision;
}

/** 测试隔离入口；生产逻辑只按 dataDir 自动维护缓存。 */
export function resetProviderCatalogMemoryCacheForTests(): void {
  memoryCache.clear();
}

/** 解析随包目录：默认读取源文件文本；测试注入 loadBundledCatalog 时按 JSONL 文本或对象解析。 */
async function parseBundled(loadBundledCatalog?: () => Promise<unknown>): Promise<ParsedProviderCatalog> {
  const injected = loadBundledCatalog && loadBundledCatalog !== readBundledCatalogText ? await loadBundledCatalog() : undefined;
  if (typeof injected === "string") return parseProviderCatalogText(injected);
  if (injected !== undefined) return normalizeProviderCatalog(injected);
  return parseProviderCatalogText(await readBundledCatalogText());
}

function isFresh(fetchedAt: string, now: Date): boolean {
  const timestamp = Date.parse(fetchedAt);
  return Number.isFinite(timestamp)
    && now.getTime() >= timestamp
    && now.getTime() - timestamp < PROVIDER_CATALOG_CACHE_TTL_MS;
}

function toEnvelope(
  cache: ProviderCatalogCacheFile,
  source: ProviderCatalogEnvelope["source"],
): ProviderCatalogEnvelope {
  return {
    catalog: cache.catalog,
    source,
    fetchedAt: cache.fetchedAt,
    sourceHash: cache.sourceHash,
    ...(cache.diagnostics?.length ? {diagnostics: cache.diagnostics} : {}),
  };
}

async function readCacheFile(path: string): Promise<ProviderCatalogCacheFile | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_CACHE_FILE_BYTES) return undefined;
    const raw = await readFile(path);
    if (raw.byteLength > MAX_CACHE_FILE_BYTES) return undefined;
    const value = JSON.parse(raw.toString("utf8")) as Partial<ProviderCatalogCacheFile>;
    if (value.version !== 2 || typeof value.fetchedAt !== "string" || typeof value.sourceHash !== "string") {
      return undefined;
    }
    const normalized = normalizeProviderCatalog(value.catalog);
    const expectedHash = sha256(JSON.stringify(normalized.catalog));
    if (value.sourceHash !== expectedHash) {
      return undefined;
    }
    return {
      version: 2,
      fetchedAt: new Date(value.fetchedAt).toISOString(),
      sourceHash: value.sourceHash,
      catalog: normalized.catalog,
      ...(normalized.diagnostics.length > 0 ? {diagnostics: normalized.diagnostics} : {}),
    };
  } catch {
    return undefined;
  }
}

async function writeCacheFile(path: string, cache: ProviderCatalogCacheFile): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, {force: true}).catch(() => undefined);
  }
}

async function defaultFetchCatalogText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {cache: "no-store", signal});
  if (!response.ok) throw new Error(`在线目录下载失败：HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_CATALOG_BYTES) {
    throw new Error("供应商模型目录超过 8 MiB 上限");
  }
  return response.text();
}

async function readBundledCatalogText(): Promise<string> {
  const path = join(
    /* turbopackIgnore: true */ process.cwd(),
    "data",
    "defaults",
    "llm_catalog.jsonl",
  );
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_PROVIDER_CATALOG_BYTES) {
    throw new Error("随包供应商目录不可用或超过 8 MiB 上限");
  }
  const raw = await readFile(path);
  if (raw.byteLength > MAX_PROVIDER_CATALOG_BYTES) throw new Error("随包供应商目录超过 8 MiB 上限");
  return raw.toString("utf8");
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
