import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as pricingImport from "../src/lib/pricing-import.js";
import {
  LEGACY_PRICING_MIGRATION_NOTES,
  readPersistedPricingConfig,
  readPricingConfig,
  withPricingConfigMutation,
  writePricingConfig,
  type PricingConfigV2,
} from "../src/lib/pricing.js";
import {upsertPricingSourceBaseline} from "../src/lib/pricing/source-baseline-store.js";
import {getDeepaaDatabase, closeAllDeepaaDatabasesForTests} from "../src/lib/db/connection.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Windows 上打开中的 SQLite 句柄会阻止 rm 删除临时目录（EBUSY），先关库再删。
  closeAllDeepaaDatabasesForTests();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("LiteLLM 价格目录启动兜底", () => {
  test("无本地配置且远程失败时用随版本快照初始化", async () => {
    const dataDir = await temporaryDirectory("pricing-fallback-data-");
    const snapshot = pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z");
    const refresh = requiredRefreshFunction();

    const result = await refresh(dataDir, {
      loadBundledSnapshot: async () => snapshot,
      recordPricingRevision: async () => undefined,
      fetchCatalogText: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(result.source).toBe("snapshot");
    expect(result.remoteUpdated).toBe(false);
    expect(result.warning).toContain("network unavailable");
    expect((await readPricingConfig(dataDir)).models[0]?.pricing?.input).toBe(1);
    const baselineCount = getDeepaaDatabase(dataDir)
      .prepare("SELECT COUNT(*) AS count FROM pricing_source_baselines")
      .get() as {count: number};
    expect(baselineCount.count).toBe(0);
  });

  test("随版本 LiteLLM 快照先按供应商和运行时模型收敛路由别名，再写入唯一价格中心", async () => {
    const dataDir = await temporaryDirectory("pricing-snapshot-deduplicate-");
    const snapshot: PricingConfigV2 = {
      ...pricingConfig(1, "snapshot-duplicate-hash", "2026-08-18T08:00:00.000Z"),
      models: [{
        id: "gemini/gemini-flash-latest",
        vendor: "gemini",
        runtimeModelId: "gemini-flash-latest",
        match: "gemini/gemini-flash-latest",
        patterns: ["gemini/gemini-flash-latest"],
        aliases: ["gemini-flash-latest"],
        pricing: {input: 0, output: 0},
        confidence: "third_party",
      }, {
        id: "gemini-flash-latest",
        vendor: "gemini",
        runtimeModelId: "gemini-flash-latest",
        match: "gemini-flash-latest",
        patterns: ["gemini-flash-latest"],
        pricing: {input: 0.3, output: 2.5},
        confidence: "third_party",
      }],
    };

    const result = await requiredRefreshFunction()(dataDir, {
      loadBundledSnapshot: async () => snapshot,
      recordPricingRevision: async () => undefined,
      fetchCatalogText: async () => {
        throw new Error("network unavailable");
      },
    });

    const persisted = await readPricingConfig(dataDir);
    expect(result.source).toBe("snapshot");
    expect(persisted.models).toHaveLength(1);
    expect(persisted.models[0]).toMatchObject({
      id: "gemini-flash-latest",
      runtimeModelId: "gemini-flash-latest",
      pricing: {input: 0.3, output: 2.5},
    });
    expect(persisted.models[0]?.patterns).toEqual(expect.arrayContaining([
      "gemini-flash-latest",
      "gemini/gemini-flash-latest",
    ]));
  });

  test("手动成功目录持久化后重启遇到远程失败不会回退旧快照", async () => {
    const dataDir = await temporaryDirectory("pricing-local-priority-data-");
    const snapshot = pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z");
    await writePricingConfig(dataDir, pricingConfig(2, "remote-new-hash", "2026-07-18T10:00:00.000Z"));
    const refresh = requiredRefreshFunction();

    const result = await refresh(dataDir, {
      loadBundledSnapshot: async () => snapshot,
      recordPricingRevision: async () => undefined,
      fetchCatalogText: async () => {
        throw new Error("github timeout");
      },
    });

    const persisted = await readPricingConfig(dataDir);
    expect(result.source).toBe("local");
    expect(result.remoteUpdated).toBe(false);
    expect(persisted.catalogSource?.hash).toBe("remote-new-hash");
    expect(persisted.models[0]?.pricing?.input).toBe(2);
  });

  test("远程目录成功更新后写入本地并保留用户覆盖", async () => {
    const dataDir = await temporaryDirectory("pricing-remote-update-data-");
    const snapshot = pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z");
    const current = pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z");
    current.models.push({
      id: "manual-model",
      vendor: "local",
      patterns: ["manual-model"],
      pricing: { input: 9, output: 10 },
      confidence: "user_override",
    });
    await writePricingConfig(dataDir, current);
    const refresh = requiredRefreshFunction();
    const remoteText = JSON.stringify({
      "fixture-model": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000004,
      },
    });

    const result = await refresh(dataDir, {
      loadBundledSnapshot: async () => snapshot,
      recordPricingRevision: async () => undefined,
      now: () => new Date("2026-07-18T11:00:00.000Z"),
      fetchCatalogText: async () => remoteText,
    });

    const persisted = await readPricingConfig(dataDir);
    expect(result.source).toBe("remote");
    expect(result.remoteUpdated).toBe(true);
    expect(persisted.catalogSource?.type).toBe("litellm");
    expect(persisted.models.find(model => model.id === "fixture-model")?.pricing?.input).toBe(3);
    expect(persisted.models.find(model => model.id === "manual-model")?.pricing?.input).toBe(9);
  });

  test("损坏的本地价格文件不会被发布快照静默覆盖", async () => {
    const dataDir = await temporaryDirectory("pricing-corrupt-local-");
    const configDir = join(dataDir, "config");
    const pricingPath = join(configDir, "model-pricing.json");
    const corrupt = "{not-valid-json";
    await mkdir(configDir, { recursive: true });
    await writeFile(pricingPath, corrupt, "utf-8");
    let remoteRequested = false;

    await expect(requiredRefreshFunction()(dataDir, {
      loadBundledSnapshot: async () => pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z"),
      fetchCatalogText: async () => {
        remoteRequested = true;
        return "{}";
      },
    })).rejects.toThrow(/不是合法 JSON/u);

    expect(remoteRequested).toBe(false);
    expect(await readFile(pricingPath, "utf-8")).toBe(corrupt);
  });

  test("远程目录落盘与用户保存并发时不丢失用户覆盖", async () => {
    const dataDir = await temporaryDirectory("pricing-concurrent-update-");
    await writePricingConfig(dataDir, pricingConfig(1, "old-hash", "2026-07-18T08:00:00.000Z"));
    let releaseRemotePersist!: () => void;
    let markRemotePersistStarted!: () => void;
    const remotePersistStarted = new Promise<void>(resolve => { markRemotePersistStarted = resolve; });
    const remotePersistGate = new Promise<void>(resolve => { releaseRemotePersist = resolve; });
    let revisionCalls = 0;

    const refreshPromise = requiredRefreshFunction()(dataDir, {
      loadBundledSnapshot: async () => pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z"),
      fetchCatalogText: async () => JSON.stringify({
        "fixture-model": {
          litellm_provider: "openai",
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000004,
        },
      }),
      recordPricingRevision: async () => {
        revisionCalls += 1;
        if (revisionCalls !== 1) return;
        markRemotePersistStarted();
        await remotePersistGate;
      },
    });
    await remotePersistStarted;

    const manualSave = withPricingConfigMutation(dataDir, async () => {
      const current = await readPersistedPricingConfig(dataDir);
      if (!current) throw new Error("测试价格目录意外缺失");
      await writePricingConfig(dataDir, {
        ...current,
        models: [...current.models, {
          id: "manual-concurrent-model",
          vendor: "local",
          patterns: ["manual-concurrent-model"],
          pricing: { input: 9, output: 10 },
          confidence: "user_override",
        }],
      });
    });
    await Promise.resolve();
    releaseRemotePersist();
    await Promise.all([refreshPromise, manualSave]);

    const persisted = await readPersistedPricingConfig(dataDir);
    expect(persisted?.catalogSource?.hash).not.toBe("old-hash");
    expect(persisted?.models.find(model => model.id === "manual-concurrent-model")?.pricing?.input).toBe(9);
  });

  test("随版本快照存在且包含完整 LiteLLM 价格目录", async () => {
    const raw = await readFile("data/defaults/litellm-model-prices.snapshot.json", "utf-8");
    const snapshot = JSON.parse(raw) as PricingConfigV2;

    expect(snapshot.version).toBe(2);
    expect(snapshot.catalogSource?.type).toBe("litellm");
    expect(snapshot.catalogSource?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.models.length).toBeGreaterThan(1_000);
    // 缺 version 的快照曾被误判为 v1 遗留并整体洗成 user_override；两项断言防回归。
    expect(snapshot.models.some(model => model.confidence === "user_override")).toBe(false);
    expect(snapshot.models.every(model => model.confidence === "third_party")).toBe(true);
  });
});

type RefreshFunction = (
  dataDir: string,
  options: {
    loadBundledSnapshot?: () => Promise<PricingConfigV2>;
    fetchCatalogText: (sourceUrl: string) => Promise<string>;
    recordPricingRevision?: (dataDir: string, effectiveAt: string) => Promise<void>;
    now?: () => Date;
  },
) => Promise<{
  source: "remote" | "local" | "snapshot";
  remoteUpdated: boolean;
  warning?: string;
}>;

function requiredRefreshFunction(): RefreshFunction {
  const refresh = (pricingImport as unknown as { refreshLiteLLMPricingCatalog?: RefreshFunction })
    .refreshLiteLLMPricingCatalog;
  expect(typeof refresh).toBe("function");
  return refresh!;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function pricingConfig(inputPrice: number, hash: string, fetchedAt: string): PricingConfigV2 {
  return {
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    sourceCheckedAt: fetchedAt,
    catalogSource: {
      type: "litellm",
      url: pricingImport.DEFAULT_LITELLM_PRICING_URL,
      fetchedAt,
      hash,
      modelCount: 1,
    },
    models: [{
      id: "fixture-model",
      vendor: "openai",
      patterns: ["fixture-model"],
      pricing: { input: inputPrice, output: inputPrice + 1 },
      confidence: "third_party",
    }],
  };
}

describe("LiteLLM 导入标记（价格中心版本条）", () => {
  const REMOTE_TEXT = JSON.stringify({
    "fixture-model": {
      litellm_provider: "openai",
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000004,
    },
  });

  test("远程导入内容变化时写入 litellmSync 导入时间与条数", async () => {
    const dataDir = await temporaryDirectory("pricing-litellm-sync-marker-");
    const refresh = requiredRefreshFunction();

    await refresh(dataDir, {
      loadBundledSnapshot: async () => pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z"),
      recordPricingRevision: async () => undefined,
      now: () => new Date("2026-07-18T11:00:00.000Z"),
      fetchCatalogText: async () => REMOTE_TEXT,
    });

    const persisted = await readPricingConfig(dataDir);
    expect(persisted.litellmSync).toMatchObject({
      syncedAt: "2026-07-18T11:00:00.000Z",
      modelCount: 1,
    });
  });

  test("远程内容未变化时保留既有 litellmSync 时间（不追加落盘）", async () => {
    const dataDir = await temporaryDirectory("pricing-litellm-sync-unchanged-");
    const remoteHash = `sha256:${createHash("sha256").update(REMOTE_TEXT).digest("hex")}`;
    const current = pricingConfig(3, remoteHash, "2026-07-18T09:00:00.000Z");
    current.litellmSync = {syncedAt: "2026-07-18T09:00:00.000Z", modelCount: 1};
    await writePricingConfig(dataDir, current);
    const refresh = requiredRefreshFunction();

    const result = await refresh(dataDir, {
      loadBundledSnapshot: async () => pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z"),
      recordPricingRevision: async () => undefined,
      now: () => new Date("2026-07-18T12:00:00.000Z"),
      fetchCatalogText: async () => REMOTE_TEXT,
    });

    expect(result.source).toBe("remote");
    expect(result.remoteUpdated).toBe(false);
    const persisted = await readPricingConfig(dataDir);
    expect(persisted.litellmSync?.syncedAt).toBe("2026-07-18T09:00:00.000Z");
  });

  test("随版本快照初始化同样记录 litellmSync 标记", async () => {
    const dataDir = await temporaryDirectory("pricing-litellm-sync-snapshot-");
    const refresh = requiredRefreshFunction();

    const result = await refresh(dataDir, {
      loadBundledSnapshot: async () => pricingConfig(1, "snapshot-hash", "2026-07-18T08:00:00.000Z"),
      recordPricingRevision: async () => undefined,
      now: () => new Date("2026-07-18T10:30:00.000Z"),
      fetchCatalogText: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(result.source).toBe("snapshot");
    const persisted = await readPricingConfig(dataDir);
    expect(persisted.litellmSync).toMatchObject({
      syncedAt: "2026-07-18T10:30:00.000Z",
      modelCount: 1,
    });
  });
});

describe("价格中心误标自愈与首启回归（2026-10-11 修复）", () => {
  test("全新目录首启用真实随包快照初始化：全部 third_party，零手工覆盖", async () => {
    const dataDir = await temporaryDirectory("pricing-fresh-boot-regression-");
    const result = await requiredRefreshFunction()(dataDir, {
      fetchCatalogText: async () => {
        throw new Error("network unavailable");
      },
      recordPricingRevision: async () => undefined,
    });

    expect(result.source).toBe("snapshot");
    const persisted = await readPersistedPricingConfig(dataDir);
    expect(persisted?.version).toBe(2);
    expect(persisted?.models.length).toBeGreaterThan(1_000);
    expect(persisted?.models.every(model => model.confidence === "third_party")).toBe(true);
    // 迁移事故形态（user_override + 空价格）必须为零。
    expect(persisted?.models.some(model => model.confidence === "user_override")).toBe(false);
    expect(persisted?.models.filter(model => model.pricing?.input !== undefined).length)
      .toBeGreaterThan(3_000);
  });

  test("自愈：误标条目按底稿→随包快照恢复，无来源的丢弃，真实人工数据不动", async () => {
    const dataDir = await temporaryDirectory("pricing-self-heal-");
    const snapshot: PricingConfigV2 = {
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      catalogSource: {
        type: "litellm",
        url: pricingImport.DEFAULT_LITELLM_PRICING_URL,
        fetchedAt: "2026-09-29T23:08:54.095Z",
        hash: "sha256:self-heal-snapshot",
        modelCount: 1,
      },
      models: [{
        id: "legacy-b",
        vendor: "openai",
        runtimeModelId: "legacy-model-b",
        match: "legacy-model-b",
        patterns: ["legacy-model-b"],
        pricing: {input: 7, output: 7.5},
        confidence: "third_party",
      }],
    };
    const damaged = {
      version: 2 as const,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        // 误标条目 A：底稿可恢复（内部 id 必须保留，供应商映射引用不失效）。
        {id: "legacy-a", vendor: "openai", match: "legacy-model-a", patterns: ["legacy-model-a"],
          pricing: {}, currency: "USD", confidence: "user_override" as const,
          sourceUrl: "local://legacy-model-pricing-v1", sourceCheckedAt: "2026-07-08",
          notes: LEGACY_PRICING_MIGRATION_NOTES},
        // 误标条目 B：无底稿，落在随包快照内。
        {id: "legacy-b", vendor: "openai", match: "legacy-model-b", patterns: ["legacy-model-b"],
          pricing: {}, currency: "USD", confidence: "user_override" as const,
          sourceUrl: "local://legacy-model-pricing-v1", sourceCheckedAt: "2026-07-08",
          notes: LEGACY_PRICING_MIGRATION_NOTES},
        // 误标条目 C：任何来源都没有 → 丢弃，交由后续目录导入按需补齐。
        {id: "legacy-c", vendor: "openai", match: "legacy-model-c", patterns: ["legacy-model-c"],
          pricing: {}, currency: "USD", confidence: "user_override" as const,
          sourceUrl: "local://legacy-model-pricing-v1", sourceCheckedAt: "2026-07-08",
          notes: LEGACY_PRICING_MIGRATION_NOTES},
        // 带迁移标记但有真实价格的条目：不是误标产物，必须原样保留。
        {id: "manual-priced", vendor: "openai", match: "manual-priced-model", patterns: ["manual-priced-model"],
          pricing: {input: 2, output: 3}, currency: "USD", confidence: "user_override" as const,
          sourceUrl: "local://legacy-model-pricing-v1", sourceCheckedAt: "2026-07-08",
          notes: LEGACY_PRICING_MIGRATION_NOTES},
        // 正常 LiteLLM 条目：不动。
        {id: "fresh-model", vendor: "openai", runtimeModelId: "fresh-model", patterns: ["fresh-model"],
          pricing: {input: 8, output: 9}, confidence: "third_party" as const},
      ],
    };
    await writePricingConfig(dataDir, damaged);
    upsertPricingSourceBaseline(getDeepaaDatabase(dataDir), {
      vendor: "openai",
      runtimeModelId: "legacy-model-a",
      sourceKind: "litellm",
      capturedAt: "2026-10-10T19:53:28.202Z",
      entry: {
        id: "litellm-legacy-a",
        vendor: "openai",
        runtimeModelId: "legacy-model-a",
        match: "legacy-model-a",
        patterns: ["legacy-model-a"],
        pricing: {input: 5, output: 6},
        confidence: "third_party",
      },
    });

    const refresh = requiredRefreshFunction();
    const result = await refresh(dataDir, {
      loadBundledSnapshot: async () => snapshot,
      recordPricingRevision: async () => undefined,
      fetchCatalogText: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(result.source).toBe("local");
    const persisted = await readPricingConfig(dataDir);
    expect(persisted.models).toHaveLength(4);
    const byId = new Map(persisted.models.map(model => [model.id, model]));
    // A：底稿恢复，保留内部 id，价格来自底稿。
    expect(byId.get("legacy-a")).toMatchObject({
      vendor: "openai",
      confidence: "third_party",
      pricing: {input: 5, output: 6},
    });
    // B：随包快照恢复。
    expect(byId.get("legacy-b")).toMatchObject({
      confidence: "third_party",
      pricing: {input: 7, output: 7.5},
    });
    // C：无来源 → 丢弃。
    expect(byId.has("legacy-c")).toBe(false);
    // 带价标记条目与正常条目原样保留。
    expect(byId.get("manual-priced")).toMatchObject({confidence: "user_override", pricing: {input: 2, output: 3}});
    expect(byId.get("fresh-model")).toMatchObject({confidence: "third_party", pricing: {input: 8, output: 9}});
    // 自愈后不再存在“迁移标记 + 空价格”条目（幂等基线）。
    expect(persisted.models.some(model =>
      model.notes === LEGACY_PRICING_MIGRATION_NOTES && Object.keys(model.pricing || {}).length === 0
      && !model.pricing?.input && !model.pricing?.output)).toBe(false);

    // 幂等：再次刷新不再产生任何变化。
    await refresh(dataDir, {
      loadBundledSnapshot: async () => snapshot,
      recordPricingRevision: async () => undefined,
      fetchCatalogText: async () => {
        throw new Error("network unavailable");
      },
    });
    const rerun = await readPricingConfig(dataDir);
    expect(rerun.models.map(model => [model.id, model.confidence, model.pricing]))
      .toEqual(persisted.models.map(model => [model.id, model.confidence, model.pricing]));
  });

  test("自愈：同身份更高优先级存量条目已存在时丢弃误标条目而不重复", async () => {
    const dataDir = await temporaryDirectory("pricing-self-heal-existing-");
    const snapshot: PricingConfigV2 = {
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [],
    };
    // writePricingConfig 带唯一性断言，同身份冲突写不进去；只有绕过应用的
    // 手工改写才可能造出这种损坏形态，这里直接落原始 JSON 模拟。
    const configDir = join(dataDir, "config");
    await mkdir(configDir, {recursive: true});
    await writeFile(join(configDir, "model-pricing.json"), JSON.stringify({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "zombie", vendor: "openai", match: "dup-model", patterns: ["dup-model"],
          pricing: {}, currency: "USD", confidence: "user_override",
          sourceUrl: "local://legacy-model-pricing-v1", sourceCheckedAt: "2026-07-08",
          notes: LEGACY_PRICING_MIGRATION_NOTES},
        {id: "official-dup", vendor: "openai", runtimeModelId: "dup-model", patterns: ["dup-model"],
          pricing: {input: 4, output: 4}, confidence: "official"},
      ],
    }), "utf8");

    await requiredRefreshFunction()(dataDir, {
      loadBundledSnapshot: async () => snapshot,
      recordPricingRevision: async () => undefined,
      fetchCatalogText: async () => {
        throw new Error("network unavailable");
      },
    });

    const persisted = await readPricingConfig(dataDir);
    expect(persisted.models).toHaveLength(1);
    expect(persisted.models[0]).toMatchObject({id: "official-dup", confidence: "official"});
  });
});
