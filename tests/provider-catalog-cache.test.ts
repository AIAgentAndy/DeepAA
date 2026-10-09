import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, test, vi} from "vitest";
import {expectPosixFileMode} from "./helpers/posix-permissions.js";
import {
  CATALOG_OVERRIDE_ENV,
  PROVIDER_CATALOG_CACHE_TTL_MS,
  PROVIDER_CATALOG_REMOTE_URL,
  loadProviderCatalog,
  resetProviderCatalogMemoryCacheForTests,
} from "../src/lib/provider-catalog/cache.js";
import {MAX_PROVIDER_CATALOG_BYTES, parseProviderCatalogText} from "../src/lib/provider-catalog/normalize.js";

const temporaryDirectories: string[] = [];

/** 随包目录的 publishedAt（动态读取，不钉具体发布值）。 */
async function bundledPublishedAt(): Promise<string> {
  const text = await readFile("data/defaults/llm_catalog.jsonl", "utf8");
  return parseProviderCatalogText(text).catalog.publishedAt;
}

/** 双源调和语义：元信息取字典序较新的一方（publishedAt RFC 3339 带时区，字典序=时间序）。 */
function newerPublishedAt(left: string, right: string): string {
  return left > right ? left : right;
}

afterEach(async () => {
  resetProviderCatalogMemoryCacheForTests();
  delete process.env[CATALOG_OVERRIDE_ENV];
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

describe("供应商模型目录缓存", () => {
  test("只请求固定在线目录且一小时内复用内存缓存", async () => {
    const dataDir = await temporaryDirectory();
    const fetchCatalogText = vi.fn(async (url: string) => {
      expect(url).toBe("https://deepaa.dev/data/defaults/llm_catalog.jsonl");
      return catalogText("2026-08-17", "deepseek-v4-flash");
    });
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-08-17T08:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-08-17T08:59:59.999Z"));

    const first = await loadProviderCatalog(dataDir, {fetchCatalogText, now});
    const second = await loadProviderCatalog(dataDir, {fetchCatalogText, now});

    expect(PROVIDER_CATALOG_REMOTE_URL).toBe("https://deepaa.dev/data/defaults/llm_catalog.jsonl");
    expect(PROVIDER_CATALOG_CACHE_TTL_MS).toBe(60 * 60 * 1_000);
    expect(first.source).toBe("remote");
    expect(second.catalog).toEqual(first.catalog);
    expect(fetchCatalogText).toHaveBeenCalledTimes(1);
  });

  test("强制刷新绕过未过期缓存并原子写入 0600 文件", async () => {
    const dataDir = await temporaryDirectory();
    const fetchCatalogText = vi.fn()
      .mockResolvedValueOnce(catalogText("2026-09-03", "model-a"))
      .mockResolvedValueOnce(catalogText("2026-09-10", "model-b"));
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-08-17T08:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-08-17T08:01:00.000Z"));

    await loadProviderCatalog(dataDir, {fetchCatalogText, now});
    const refreshed = await loadProviderCatalog(dataDir, {fetchCatalogText, now, forceRefresh: true});
    const cachePath = join(dataDir, "config", "provider-catalog-cache.json");
    const persisted = JSON.parse(await readFile(cachePath, "utf8")) as {
      catalog: {publishedAt: string};
      sourceHash: string;
    };

    // 随包真实目录新于远端夹具（2026-09-10）：双源合并元信息取较新一方（动态计算，不钉发布值）。
    const expectedPublishedAt = newerPublishedAt(await bundledPublishedAt(), "2026-09-10");
    expect(refreshed.catalog.publishedAt).toBe(expectedPublishedAt);
    expect(fetchCatalogText).toHaveBeenCalledTimes(2);
    expect(persisted.catalog.publishedAt).toBe(expectedPublishedAt);
    expect(persisted.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expectPosixFileMode((await stat(cachePath)).mode & 0o777, 0o600);
  });

  test("进程重启后优先复用未过期文件缓存", async () => {
    const dataDir = await temporaryDirectory();
    const fetchCatalogText = vi.fn(async () => catalogText("2026-09-10", "model-a"));
    await loadProviderCatalog(dataDir, {
      fetchCatalogText,
      now: () => new Date("2026-08-17T08:00:00.000Z"),
    });
    resetProviderCatalogMemoryCacheForTests();

    const result = await loadProviderCatalog(dataDir, {
      fetchCatalogText,
      now: () => new Date("2026-08-17T08:30:00.000Z"),
    });

    expect(result.source).toBe("file-cache");
    // 文件缓存保留双源合并结果：随包目录新于夹具时取随包值（动态计算）。
    expect(result.catalog.publishedAt).toBe(newerPublishedAt(await bundledPublishedAt(), "2026-09-10"));
    expect(fetchCatalogText).toHaveBeenCalledTimes(1);
  });

  test("双源调和：远端 publishedAt 旧于随包时同 key 以随包为准（发布窗口期防倒退）", async () => {
    const dataDir = await temporaryDirectory();
    // 远端 demo 版本 2026-08-17（旧，无积分活动）；随包 demo 版本 2026-09-03（新，带活动）。
    const bundled = {
      schemaVersion: 2,
      catalogRevision: "2026.09.03.01",
      publishedAt: "2026-09-03T00:00:00+08:00",
      providers: {
        demo: {
          name: "Demo", brandId: "demo", pricingProviderId: "demo", region: "global", category: "official",
          models: [{id: "bundled-model", category: "chat", pricing: {input: 1, output: 2}}],
        },
      },
    };
    const result = await loadProviderCatalog(dataDir, {
      fetchCatalogText: async () => catalogText("2026-08-17", "remote-model"),
      loadBundledCatalog: async () => bundled,
      now: () => new Date("2026-09-03T08:00:00.000Z"),
    });
    expect(result.source).toBe("remote");
    expect(result.catalog.publishedAt).toBe("2026-09-03T00:00:00+08:00");
    // 同 key（demo）随包新版本胜出；随包没有的 provider 仍由远端提供。
    expect(result.catalog.providers.demo?.models.map(item => item.id)).toEqual(["bundled-model"]);
    // 反向：随包更旧时维持远端优先（既有行为）。
    const dataDir2 = await temporaryDirectory();
    const result2 = await loadProviderCatalog(dataDir2, {
      fetchCatalogText: async () => catalogText("2026-09-10", "remote-model"),
      loadBundledCatalog: async () => bundled,
      now: () => new Date("2026-09-10T08:00:00.000Z"),
    });
    expect(result2.catalog.providers.demo?.models.map(item => item.id)).toEqual(["remote-model"]);
  });

  test("旧文件缓存命中时仍用随包目录补齐新增官方预设", async () => {
    const dataDir = await temporaryDirectory();
    await loadProviderCatalog(dataDir, {
      fetchCatalogText: async () => catalogText("2026-08-17", "cached-model"),
      loadBundledCatalog: async () => { throw new Error("模拟旧版本尚无随包补齐"); },
      now: () => new Date("2026-08-17T08:00:00.000Z"),
    });
    resetProviderCatalogMemoryCacheForTests();

    const result = await loadProviderCatalog(dataDir, {
      fetchCatalogText: vi.fn(async () => { throw new Error("未过期缓存不应访问远端"); }),
      loadBundledCatalog: async () => bundledCatalogWithOpenRouter(),
      now: () => new Date("2026-08-17T08:30:00.000Z"),
    });

    expect(result.source).toBe("file-cache");
    expect(result.catalog.publishedAt).toBe("2026-08-19T00:00:00+08:00");
    expect(result.catalog.providers.demo?.models.map(item => item.id)).toEqual(["cached-model"]);
    expect(result.catalog.providers.openrouter?.models.map(item => item.id)).toEqual(["openai/gpt-5.6-sol"]);
  });

  test("远端失败时先用旧文件缓存，无文件时再用随包目录", async () => {
    const dataDir = await temporaryDirectory();
    await loadProviderCatalog(dataDir, {
      fetchCatalogText: async () => catalogText("2026-08-16", "cached-model"),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    });
    resetProviderCatalogMemoryCacheForTests();

    const stale = await loadProviderCatalog(dataDir, {
      forceRefresh: true,
      fetchCatalogText: async () => { throw new Error("network unavailable"); },
      loadBundledCatalog: async () => bundledCatalogWithOpenRouter(),
      now: () => new Date("2026-08-17T08:00:00.000Z"),
    });
    const fallbackDataDir = await temporaryDirectory();
    const bundled = await loadProviderCatalog(fallbackDataDir, {
      fetchCatalogText: async () => { throw new Error("network unavailable"); },
      loadBundledCatalog: async () => catalogText("2026-08-15", "bundled-model"),
      now: () => new Date("2026-08-17T08:00:00.000Z"),
    });

    expect(stale.source).toBe("file-cache");
    expect(stale.catalog.providers.openrouter).toBeDefined();
    expect(stale.warning).toContain("network unavailable");
    expect(bundled.source).toBe("bundled");
    expect(bundled.catalog.publishedAt).toBe("2026-08-15T00:00:00+08:00");
    expect(bundled.warning).toContain("network unavailable");
  });

  test("远端响应超过 8 MiB 时在 JSON.parse 前拒绝", async () => {
    const dataDir = await temporaryDirectory();
    const invalid = " ".repeat(MAX_PROVIDER_CATALOG_BYTES + 1);

    await expect(loadProviderCatalog(dataDir, {
      fetchCatalogText: async () => invalid,
      loadBundledCatalog: async () => { throw new Error("bundled unavailable"); },
    })).rejects.toThrow(/8 MiB/u);
  });

  test("发布配置同时追踪并打包随包目录", async () => {
    const nextConfig = await readFile(join(process.cwd(), "next.config.ts"), "utf8");
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {files: string[]};

    expect(nextConfig).toContain("./data/defaults/llm_catalog.jsonl");
    expect(packageJson.files).toContain("data/defaults/llm_catalog.jsonl");
  });

  test("在线目录缺少新官方预设时与随包目录合并，在线已有供应商保持优先", async () => {
    const dataDir = await temporaryDirectory();
    const result = await loadProviderCatalog(dataDir, {
      fetchCatalogText: async () => catalogText("2026-08-19", "remote-model"),
      loadBundledCatalog: async () => ({
        schemaVersion: 2,
        catalogRevision: "2026.08.18.01",
        publishedAt: "2026-08-18T00:00:00+08:00",
        providers: {
          demo: {name: "Demo bundled", brandId: "demo", pricingProviderId: "demo", region: "global", category: "official", models: [{id: "bundled-model", category: "chat", pricing: {input: 1, output: 2}}]},
          openrouter: {name: "OpenRouter", brandId: "openrouter", pricingProviderId: "openrouter", region: "global", category: "aggregator", openaiUrl: "https://openrouter.ai/api/v1", models: [{id: "openai/gpt-5.6-sol", category: "chat", pricing: {input: 5, output: 30}}]},
        },
      }),
    });
    expect(result.catalog.providers.demo?.models.map(item => item.id)).toEqual(["remote-model"]);
    expect(result.catalog.providers.openrouter?.models.map(item => item.id)).toEqual(["openai/gpt-5.6-sol"]);
  });

  test("远端陈旧副本不覆盖更新的本地缓存（单调性守卫）", async () => {
    const dataDir = await temporaryDirectory();
    // 注入更旧的随包目录，隔离双源调和影响，让比较只发生在远端与缓存之间。
    const oldBundled = {
      schemaVersion: 2,
      catalogRevision: "2026.08.01.01",
      publishedAt: "2026-08-01T00:00:00+08:00",
      providers: {},
    };
    await loadProviderCatalog(dataDir, {
      fetchCatalogText: async () => catalogText("2026-09-10", "newer-model"),
      loadBundledCatalog: async () => oldBundled,
      now: () => new Date("2026-09-10T08:00:00.000Z"),
    });
    resetProviderCatalogMemoryCacheForTests();

    // 远端回退到更旧版本：应拒绝覆盖，继续沿用较新的缓存内容。
    const result = await loadProviderCatalog(dataDir, {
      forceRefresh: true,
      fetchCatalogText: async () => catalogText("2026-08-17", "stale-model"),
      loadBundledCatalog: async () => oldBundled,
      now: () => new Date("2026-09-11T08:00:00.000Z"),
    });

    expect(result.source).toBe("file-cache");
    expect(result.catalog.publishedAt).toBe("2026-09-10T00:00:00+08:00");
    expect(result.catalog.providers.demo?.models.map(item => item.id)).toEqual(["newer-model"]);
    expect(result.warning).toContain("早于本地缓存");

    const persisted = JSON.parse(
      await readFile(join(dataDir, "config", "provider-catalog-cache.json"), "utf8"),
    ) as {catalog: {publishedAt: string}};
    expect(persisted.catalog.publishedAt).toBe("2026-09-10T00:00:00+08:00");
  });

  test("缓存 sourceHash 与目录内容不一致时丢弃缓存并回退随包目录", async () => {
    const dataDir = await temporaryDirectory();
    await mkdir(join(dataDir, "config"), {recursive: true});
    const tamperedLines = catalogText("2026-09-12", "tampered-model")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const tamperedProvider = tamperedLines[1] as Record<string, unknown>;
    tamperedProvider.models = [{
      id: "tampered-model-changed",
      category: "chat",
      pricing: {input: 1, output: 2},
    }];
    await writeFile(join(dataDir, "config", "provider-catalog-cache.json"), JSON.stringify({
      version: 2,
      fetchedAt: new Date().toISOString(),
      sourceHash: "sha256:wrong",
      catalog: {
        ...tamperedLines[0],
        providers: {demo: tamperedProvider},
      },
    }), "utf8");

    const result = await loadProviderCatalog(dataDir, {
      allowRemote: false,
      loadBundledCatalog: async () => catalogText("2026-09-13", "bundled-model"),
      now: () => new Date(),
    });

    expect(result.source).toBe("bundled");
    expect(result.catalog.providers.demo?.models.map(item => item.id)).toEqual(["bundled-model"]);
  });
});

describe("维护测试覆盖（DEEPAA_CATALOG_PATH）", () => {
  test("覆盖生效时只读指定文件：不联网、不写缓存，来源标记为 override", async () => {
    const dataDir = await temporaryDirectory();
    const overridePath = join(await temporaryDirectory(), "pending.jsonl");
    await writeFile(overridePath, catalogText("2026-09-11", "draft-model"), "utf8");
    process.env[CATALOG_OVERRIDE_ENV] = overridePath;

    const result = await loadProviderCatalog(dataDir, {
      fetchCatalogText: vi.fn(async () => {
        throw new Error("覆盖模式不应触网");
      }),
      loadBundledCatalog: async () => {
        throw new Error("覆盖模式不应读取随包目录");
      },
      now: () => new Date("2026-09-11T10:00:00.000Z"),
    });

    expect(result.source).toBe("override");
    expect(result.catalog.providers.demo?.models.map(item => item.id)).toEqual(["draft-model"]);
    expect(result.warning).toContain("维护测试模式");
    // 关键：绝不写缓存文件，避免污染维护者真实状态。
    await expect(stat(join(dataDir, "config", "provider-catalog-cache.json"))).rejects.toThrow();
  });

  test("覆盖路径非绝对路径时直接报错（不静默回退）", async () => {
    process.env[CATALOG_OVERRIDE_ENV] = "catalog-drafts/pending.jsonl";
    const dataDir = await temporaryDirectory();

    await expect(loadProviderCatalog(dataDir, {
      fetchCatalogText: vi.fn(async () => {
        throw new Error("覆盖模式不应触网");
      }),
    })).rejects.toThrow(/必须是绝对路径/u);
  });

  test("覆盖文件缺失时直接报错（不静默回退正常模式）", async () => {
    process.env[CATALOG_OVERRIDE_ENV] = join(await temporaryDirectory(), "missing.jsonl");
    const dataDir = await temporaryDirectory();

    await expect(loadProviderCatalog(dataDir, {
      fetchCatalogText: vi.fn(async () => {
        throw new Error("覆盖模式不应触网");
      }),
    })).rejects.toThrow(/维护测试目录不可用/u);
  });

  test("覆盖文件内容非法时直接报错", async () => {
    const overridePath = join(await temporaryDirectory(), "pending.jsonl");
    await writeFile(overridePath, "{ not jsonl", "utf8");
    process.env[CATALOG_OVERRIDE_ENV] = overridePath;
    const dataDir = await temporaryDirectory();

    await expect(loadProviderCatalog(dataDir, {})).rejects.toThrow();
  });

  test("未设置覆盖变量时行为与既有路径完全一致", async () => {
    const dataDir = await temporaryDirectory();
    const fetchCatalogText = vi.fn(async () => catalogText("2026-09-10", "remote-model"));

    const result = await loadProviderCatalog(dataDir, {
      fetchCatalogText,
      now: () => new Date("2026-09-10T08:00:00.000Z"),
    });

    expect(result.source).toBe("remote");
    expect(fetchCatalogText).toHaveBeenCalledTimes(1);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "provider-catalog-cache-"));
  temporaryDirectories.push(path);
  return path;
}

function catalogText(publishedAt: string, modelId: string): string {
  // JSONL 目录格式（v2）：首行元信息，之后每行一个供应商。
  return [
    JSON.stringify({schemaVersion: 2, catalogRevision: "2026.08.17.01", publishedAt: `${publishedAt}T00:00:00+08:00`}),
    JSON.stringify({
      catalogKey: "demo",
      name: "Demo",
      brandId: "demo",
      pricingProviderId: "demo",
      region: "global",
      category: "official",
      openaiUrl: "https://demo.example/v1",
      models: [{id: modelId, category: "chat", pricing: {input: 1, output: 2}}],
    }),
  ].join("\n");
}

function bundledCatalogWithOpenRouter() {
  return {
    schemaVersion: 2,
    catalogRevision: "2026.08.19.01",
    publishedAt: "2026-08-19T00:00:00+08:00",
    providers: {
      openrouter: {
        name: "OpenRouter",
        brandId: "openrouter",
        pricingProviderId: "openrouter",
        region: "global",
        category: "aggregator",
        openaiUrl: "https://openrouter.ai/api/v1",
        models: [{id: "openai/gpt-5.6-sol", category: "chat", pricing: {input: 5, output: 30}}],
      },
    },
  };
}
