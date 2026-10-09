import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, test} from "vitest";
import {openDeepaaDatabase} from "../src/lib/db/connection.js";
import {
  claimDueCatalogSyncEffects,
  enqueueCatalogSyncEffects,
  markCatalogSyncEffectRetry,
  markCatalogSyncEffectSucceeded,
} from "../src/lib/provider-catalog/sync-effects.js";
import {listOfficialCatalogMembership, syncOfficialCatalogMembership} from "../src/lib/provider-catalog/membership-store.js";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});

describe("官方目录同步后置效果任务", () => {
  test("同一 revision/effect 幂等入队，并可领取后成功", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "catalog-effects-"));
    dirs.push(dataDir);
    const db = openDeepaaDatabase({dataDir});
    const input = {
      catalogRevision: "2099.01.01.01",
      catalogHash: "sha256:test",
      effectType: "notification" as const,
      targetId: "relay",
      agentId: "opencode",
      modelId: "gpt-test",
    };

    expect(enqueueCatalogSyncEffects(db, [input], "2099-01-01T00:00:00.000Z")).toBe(1);
    expect(enqueueCatalogSyncEffects(db, [input], "2099-01-01T00:00:00.000Z")).toBe(0);
    const claimed = claimDueCatalogSyncEffects(db, "2099-01-01T00:00:01.000Z", "worker-a", 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("running");
    expect(markCatalogSyncEffectSucceeded(db, claimed[0]!.id, "2099-01-01T00:00:02.000Z")).toBe(true);
    expect(claimDueCatalogSyncEffects(db, "2099-01-01T00:00:03.000Z", "worker-b", 10)).toEqual([]);
    db.close();
  });

  test("失败效果顺延后可再次领取", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "catalog-effects-retry-"));
    dirs.push(dataDir);
    const db = openDeepaaDatabase({dataDir});
    enqueueCatalogSyncEffects(db, [{
      catalogRevision: "2099.01.01.01",
      catalogHash: "sha256:test",
      effectType: "cli_config_sync",
    }], "2099-01-01T00:00:00.000Z");
    expect(enqueueCatalogSyncEffects(db, [{
      catalogRevision: "2099.01.01.01",
      catalogHash: "sha256:test",
      effectType: "cli_config_sync",
    }], "2099-01-01T00:00:00.000Z")).toBe(0);
    const claimed = claimDueCatalogSyncEffects(db, "2099-01-01T00:00:01.000Z", "worker-a", 10);
    expect(claimed).toHaveLength(1);
    expect(markCatalogSyncEffectRetry(db, claimed[0]!.id, "temporary", "2099-01-01T00:00:10.000Z")).toBe(true);
    expect(claimDueCatalogSyncEffects(db, "2099-01-01T00:00:05.000Z", "worker-b", 10)).toEqual([]);
    expect(claimDueCatalogSyncEffects(db, "2099-01-01T00:00:10.000Z", "worker-b", 10)).toHaveLength(1);
    db.close();
  });

  test("官方推荐集合独立索引只收窄 currentOfficial，不删除历史行", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "catalog-membership-"));
    dirs.push(dataDir);
    const db = openDeepaaDatabase({dataDir});
    const catalog = (models: string[]) => normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2099.01.01.01",
      publishedAt: "2099-01-01T00:00:00+08:00",
      providers: {
        demo: {
          name: "Demo",
          brandId: "demo",
          pricingProviderId: "demo",
          region: "global",
          category: "official",
          models: models.map(id => ({id, category: "chat", pricing: {input: 1, output: 2}})),
        },
      },
    }).catalog;
    syncOfficialCatalogMembership(db, catalog(["m1", "m2"]), "2099-01-01T00:00:00.000Z");
    syncOfficialCatalogMembership(db, catalog(["m2"]), "2099-01-02T00:00:00.000Z");
    expect(listOfficialCatalogMembership(db, "demo")).toEqual([
      expect.objectContaining({modelId: "m2", currentOfficial: true}),
      expect.objectContaining({modelId: "m1", currentOfficial: false}),
    ]);
    db.close();
  });
});
