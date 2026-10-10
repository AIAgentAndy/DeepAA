import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, test} from "vitest";
import {runOfficialCatalogSync, readTargetModelUsage} from "../src/lib/provider-catalog/catalog-runner.js";
import {resetProviderCatalogMemoryCacheForTests} from "../src/lib/provider-catalog/cache.js";
import {readPricingConfig} from "../src/lib/pricing.js";
import {getDeepaaDatabase, closeAllDeepaaDatabasesForTests} from "../src/lib/db/connection.js";
import {queryCatalogNotifications, loadCatalogNotification} from "../src/lib/provider-catalog/notification-store.js";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";

const tempDirs: string[] = [];

/** fixture 目录版本必须恒新于随包 llm_catalog.jsonl（双源调和取较新者），
 * 因此用固定远期 RFC 3339 版本，避免随包文件发布新版本后测试漂移。 */
const FIXTURE_PUBLISHED_AT = "2099-01-01T00:00:00+08:00";
const FIXTURE_CATALOG_REVISION = "2099.01.01.01";

afterEach(async () => {
  resetProviderCatalogMemoryCacheForTests();
  // Windows 上打开中的 SQLite 句柄会阻止 rm 删除临时目录（EBUSY），先关库再删。
  closeAllDeepaaDatabasesForTests();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});

/** 隔离数据目录：写入 v2 文件缓存（远端拉取结果的落盘形态）。 */
async function isolatedDataDir(catalogJsonl?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "catalog-sync-runner-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "config"), {recursive: true});
  await writeFile(join(dir, "config", "provider-catalog-cache.json"), JSON.stringify({
    version: 2,
    fetchedAt: new Date().toISOString(),
    catalog: JSON.parse(catalogJsonl ?? catalogObjectLine(FIXTURE_PUBLISHED_AT)),
  }));
  const cachePath = join(dir, "config", "provider-catalog-cache.json");
  const cache = JSON.parse(await readFile(cachePath, "utf8")) as {catalog: unknown};
  const normalizedCatalog = normalizeProviderCatalog(cache.catalog).catalog;
  await writeFile(cachePath, JSON.stringify({
    ...cache,
    catalog: normalizedCatalog,
    sourceHash: `sha256:${createHash("sha256").update(JSON.stringify(normalizedCatalog)).digest("hex")}`,
  }));
  return dir;
}

function catalogObjectLine(publishedAt: string, modelOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    catalogRevision: FIXTURE_CATALOG_REVISION,
    publishedAt,
    providers: {
      anthropic: {
        name: "Anthropic", brandId: "anthropic", pricingProviderId: "anthropic",
        region: "global", category: "global_official",
        models: [
          {id: "claude-new", category: "chat", ...(modelOverrides["claude-new"] ?? {}), ...(!modelOverrides["claude-new"]?.rateTimeline ? {pricing: {input: 1, output: 2}} : {})},
          {id: "claude-used", category: "chat", pricing: {input: 3, output: 6}, ...(modelOverrides["claude-used"] ?? {})},
        ],
      },
    },
  });
}

describe("官方目录同步 runner（v2：自动生效 + 通知已阅制）", () => {
  test("新增自动生效：启动同步写入缺失模型并记录版本标记与未阅通知", async () => {
    const dir = await isolatedDataDir();
    const result = await runOfficialCatalogSync(dir);
    expect(result.skippedByVersion).toBe(false);
    expect(result.insertedCount).toBeGreaterThanOrEqual(2);
    const pricing = await readPricingConfig(dir);
    const ids = pricing.models.filter(m => m.vendor === "anthropic").map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining(["catalog:anthropic:claude-new", "catalog:anthropic:claude-used"]));
    expect(pricing.catalogSync?.lastSyncedPublishedAt).toBe(FIXTURE_PUBLISHED_AT);
    expect(pricing.catalogSync?.lastSyncedCatalogRevision).toBe(FIXTURE_CATALOG_REVISION);
    expect(pricing.catalogSync?.syncedAt).toBeTruthy();
    // 通知已记录且未阅（2026-09-10 起通知历史存 SQLite，价格中心 JSON 不再承载）。
    const db = getDeepaaDatabase(dir);
    const page = queryCatalogNotifications(db, {});
    expect(page.total).toBe(1);
    expect(page.rows[0]?.catalogRevision).toBe(FIXTURE_CATALOG_REVISION);
    expect(page.rows[0]?.ackedAt).toBeUndefined();
    expect(page.unreadCount).toBe(1);
    expect(loadCatalogNotification(db, FIXTURE_CATALOG_REVISION)?.items.length).toBeGreaterThanOrEqual(2);
    const baselines = db.prepare(`
      SELECT vendor, runtime_model_id, source_kind
      FROM pricing_source_baselines
      WHERE source_kind = 'official'
      ORDER BY vendor, runtime_model_id
    `).all() as Array<{vendor: string; runtime_model_id: string; source_kind: string}>;
    expect(baselines).toHaveLength(0);
  });

  test("LiteLLM 已有条目被官方覆盖前保存 LiteLLM 底稿", async () => {
    const dir = await isolatedDataDir();
    const current = await readPricingConfig(dir);
    const nextPricing = {
      ...current,
      models: [...current.models, {
      id: "litellm/anthropic/claude-new",
      vendor: "anthropic",
      runtimeModelId: "claude-new",
      patterns: ["claude-new"],
      pricing: {input: 9, output: 45},
      confidence: "third_party",
      }],
    };
    await writeFile(join(dir, "config", "model-pricing.json"), JSON.stringify(nextPricing));

    await runOfficialCatalogSync(dir);
    const db = getDeepaaDatabase(dir);
    const baseline = db.prepare(`
      SELECT source_kind AS sourceKind, entry_json AS entryJson
      FROM pricing_source_baselines
      WHERE vendor = 'anthropic' AND runtime_model_id = 'claude-new'
    `).get() as {sourceKind: string; entryJson: string} | undefined;
    expect(baseline?.sourceKind).toBe("litellm");
    expect(JSON.parse(baseline!.entryJson).pricing).toEqual({input: 9, output: 45});
  });

  test("已有全局人工覆盖时官方同步只更新官方底稿，不把首次官方导入误当成底稿", async () => {
    const dir = await isolatedDataDir();
    const current = await readPricingConfig(dir);
    const nextPricing = {
      ...current,
      models: [...current.models, {
      id: "manual:anthropic:claude-new",
      vendor: "anthropic",
      runtimeModelId: "claude-new",
      patterns: ["claude-new"],
      pricing: {input: 99, output: 199},
      confidence: "user_override",
      }],
    };
    await writeFile(join(dir, "config", "model-pricing.json"), JSON.stringify(nextPricing));

    await runOfficialCatalogSync(dir);
    const db = getDeepaaDatabase(dir);
    const baseline = db.prepare(`
      SELECT source_kind AS sourceKind, entry_json AS entryJson
      FROM pricing_source_baselines
      WHERE vendor = 'anthropic' AND runtime_model_id = 'claude-new'
    `).get() as {sourceKind: string; entryJson: string} | undefined;
    expect(baseline?.sourceKind).toBe("official");
    expect(JSON.parse(baseline!.entryJson).pricing).toEqual({input: 1, output: 2});
  });

  test("版本闸门：重复同步跳过写入（同版本去重，不重复通知）", async () => {
    const dir = await isolatedDataDir();
    await runOfficialCatalogSync(dir);
    const second = await runOfficialCatalogSync(dir);
    expect(second.skippedByVersion).toBe(true);
    expect(second.insertedCount).toBe(0);
    const db = getDeepaaDatabase(dir);
    expect(queryCatalogNotifications(db, {}).total).toBe(1);
  });

  test("应用集非空时追加价格版本记录，版本闸门命中不追加", async () => {
    const dir = await isolatedDataDir();
    const revisions: Array<{dataDir: string; effectiveAt: string}> = [];
    const recordRevision = (dataDir: string, _config: unknown, effectiveAt: string) => {
      revisions.push({dataDir, effectiveAt});
    };
    const first = await runOfficialCatalogSync(dir, {recordRevision});
    expect(first.insertedCount).toBeGreaterThanOrEqual(1);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.dataDir).toBe(dir);
    const second = await runOfficialCatalogSync(dir, {recordRevision});
    expect(second.skippedByVersion).toBe(true);
    expect(revisions).toHaveLength(1);
  });

  test("effective_at 回填：本批携带官方生效时刻（早于当前）时按官方时刻记录版本（验收用例 19）", async () => {
    const effectiveFrom = "2000-01-01T12:00:00+08:00";
    const dir = await isolatedDataDir(JSON.stringify({
      schemaVersion: 2, catalogRevision: FIXTURE_CATALOG_REVISION, publishedAt: FIXTURE_PUBLISHED_AT,
      providers: {anthropic: {name: "Anthropic", brandId: "anthropic", pricingProviderId: "anthropic", region: "global", category: "official",
        models: [
          {id: "claude-new", category: "chat", rateTimeline: [{pricing: {input: 1, output: 2}}, {effectiveFrom, pricing: {input: 2, output: 8}}]},
          {id: "claude-used", category: "chat", pricing: {input: 3, output: 6}},
        ]}},
    }));
    const revisions: string[] = [];
    await runOfficialCatalogSync(dir, {recordRevision: (_dataDir, _config, effectiveAt) => revisions.push(effectiveAt)});
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toBe(effectiveFrom);
    const db = getDeepaaDatabase(dir);
    expect(loadCatalogNotification(db, FIXTURE_CATALOG_REVISION)?.effectiveFrom).toBe(effectiveFrom);
    // 合并保留时间线段（生效前回退旧价）。
    const pricing = await readPricingConfig(dir);
    const entry = pricing.models.find(m => m.id === "catalog:anthropic:claude-new");
    expect(entry?.rateTimeline?.[1]?.effectiveFrom).toBe(effectiveFrom);
    expect(entry?.rateTimeline?.[0]?.pricing).toEqual({input: 1, output: 2}); // 历史段保留。
  });

  test("使用中值变更自动生效并生成带 inUse 标注的通知（确认制废除）", async () => {
    const dir = await isolatedDataDir();
    // 预置使用快照：claude-used 被目标 catapi 通过 modelVendors 使用
    await writeFile(join(dir, "proxy-config.json"), JSON.stringify({
      targets: [{
        id: "catapi", name: "CatAPI",
        pricing: {modelVendors: {"claude-used": {vendor: "anthropic"}}},
      }],
    }));
    // 预置一个 official 条目（值与目录不同 → 值变化 + 使用中）
    const before = await readPricingConfig(dir);
    const withEntry = {
      ...before,
      models: [...before.models, {
        id: "catalog:anthropic:claude-used", vendor: "anthropic", runtimeModelId: "claude-used",
        match: "claude-used", patterns: ["claude-used"], catalogSource: "catalog",
        pricing: {input: 9, output: 99}, confidence: "official",
      }],
    };
    await writeFile(join(dir, "config", "model-pricing.json"), JSON.stringify(withEntry));

    const result = await runOfficialCatalogSync(dir);
    // DEFAULT_PRICING 里的同名 anthropic 条目同样自动生效（新语义不区分使用状态）。
    expect(result.autoUpdatedCount).toBeGreaterThanOrEqual(1);
    const after = await readPricingConfig(dir);
    const entry = after.models.find(m => m.id === "catalog:anthropic:claude-used");
    expect(entry?.pricing?.input).toBe(3); // 已自动更新为目录价
    const db2 = getDeepaaDatabase(dir);
    const item = loadCatalogNotification(db2, FIXTURE_CATALOG_REVISION)?.items.find(notification => notification.modelId === "claude-used");
    expect(item?.inUse).toBe(true);
  });

  test("instrumentation 启动布线：调度器传入价格版本记录回调（Worker 感知自动生效变更）", async () => {
    const source = await readFile("src/instrumentation.ts", "utf8");
    expect(source).toContain("ensurePricingConfigRevision");
    expect(source).toMatch(/startOfficialCatalogSyncScheduler\(dataDir, undefined, async/);
  });

  test("readTargetModelUsage：modelVendors 与 vendor+supportedModels 两种口径", async () => {
    const dir = await isolatedDataDir();
    await writeFile(join(dir, "proxy-config.json"), JSON.stringify({
      targets: [
        {id: "a", pricing: {modelVendors: {"m1": {vendor: "OpenAI"}}}},
        {id: "b", pricing: {vendor: "zhipu-cn"}, supportedModels: ["glm-5.3"]},
      ],
    }));
    const usage = await readTargetModelUsage(dir);
    expect(usage.isModelInUse("openai", "m1")).toBe(true);
    expect(usage.isModelInUse("zhipu-cn", "glm-5.3")).toBe(true);
    expect(usage.isModelInUse("openai", "glm-5.3")).toBe(false);
  });
});
