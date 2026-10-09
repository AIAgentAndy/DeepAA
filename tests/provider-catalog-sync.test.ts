import {describe, expect, test} from "vitest";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";
import {
  appendCatalogNotification,
  classifyCatalogSync,
  migrationEquivalentWithinTolerance,
  shouldSkipCatalogSync,
  type CatalogSyncMarker,
} from "../src/lib/provider-catalog/catalog-sync.js";
import {DEFAULT_PRICING, normalizePricingConfig, type ModelPriceEntry, type PricingConfigV2} from "../src/lib/pricing.js";

const catalog = normalizeProviderCatalog({
  schemaVersion: 2,
  catalogRevision: "2026.09.07.01",
  publishedAt: "2026-09-07T00:00:00+08:00",
  providers: {
    anthropic: {
      name: "Anthropic（官方）", brandId: "anthropic", pricingProviderId: "anthropic",
      region: "global", category: "global_official",
      campaigns: [{
        id: "anthropic.fable.payg.1",
        channel: "payg",
        scope: {models: ["claude-fable-5"]},
        period: {from: "2026-07-01T00:00:00Z"},
        effect: {kind: "priceOverride", rates: {input: 8, output: 40, cachedInput: 0.8}},
        label: "限时优惠",
      }],
      models: [
        {id: "claude-fable-5", category: "chat", pricing: {input: 10, output: 50, cachedInput: 1}},
        {id: "claude-new-model", category: "chat", pricing: {input: 2, output: 10}},
        {id: "claude-override-model", category: "chat", pricing: {input: 5, output: 25}},
        {id: "claude-field-add", category: "chat", pricing: {input: 1, output: 5, cacheWrite: 2}},
        {id: "claude-litellm-model", category: "chat", pricing: {input: 3, output: 15}},
        {id: "claude-gone-from-catalog", category: "chat", pricing: {input: 4, output: 20}},
      ],
    },
  },
}).catalog;

function pricingWith(entries: Array<Partial<ModelPriceEntry>>): PricingConfigV2 {
  return normalizePricingConfig({
    ...DEFAULT_PRICING,
    models: entries.map((entry, i) => ({
      id: entry.id ?? `test-${i}`,
      vendor: entry.vendor ?? "anthropic",
      match: entry.match ?? entry.id,
      patterns: entry.patterns ?? [entry.id ?? `test-${i}`],
      confidence: entry.confidence ?? "official",
      pricing: entry.pricing,
      catalogSource: "catalog" as const,
      ...entry,
    })),
  });
}

const allUsed = {isModelInUse: () => true};
const noneUsed = {isModelInUse: () => false};

function findNotificationItem(plan: ReturnType<typeof classifyCatalogSync>, modelId: string) {
  return plan.notification?.items.find(item => item.modelId === modelId);
}

describe("官方目录同步分类（v2：自动生效 + 通知已阅制）", () => {
  test("新增：目录有、价格中心无 → 自动生效并生成通知项（与使用状态无关）", () => {
    const pricing = pricingWith([
      {id: "claude-fable-5", vendor: "anthropic", pricing: {input: 10, output: 50, cachedInput: 1},
        promotions: [{from: "2026-07-01T00:00:00Z", label: "限时优惠", priceOverride: {input: 8, output: 40, cachedInput: 0.8}}]},
    ]);
    const plan = classifyCatalogSync(pricing, catalog, allUsed);
    expect(plan.insertCount).toBe(5); // 其余 5 个目录模型价格中心都没有
    expect(plan.autoUpdateCount).toBe(0);
    expect(plan.notification?.items).toHaveLength(5);
    // 新增项使用中标注生效（知情增强，不门控生效）。
    expect(findNotificationItem(plan, "claude-new-model")?.inUse).toBe(true);
  });

  test("user_override 只保护人工价格，官方能力字段仍跟随并通知", () => {
    const pricing = pricingWith([
      {
        id: "claude-override-model",
        vendor: "anthropic",
        confidence: "user_override",
        pricing: {input: 99, output: 99},
        inputModalities: ["text"],
      },
    ]);
    const changedCatalog = {
      ...catalog,
      providers: {
        ...catalog.providers,
        anthropic: {
          ...catalog.providers.anthropic,
          models: catalog.providers.anthropic.models.map(model =>
            model.id === "claude-override-model"
              ? {...model, inputModalities: ["text", "image"]}
              : model),
        },
      },
    };
    const plan = classifyCatalogSync(pricing, changedCatalog, allUsed);
    expect(plan.autoUpdateCount).toBe(1);
    expect(findNotificationItem(plan, "claude-override-model")?.changes.some(change => change.field === "inputModalities")).toBe(true);
    expect(plan.silentCatalog.providers.anthropic.models.some(model => model.id === "claude-override-model")).toBe(true);
  });

  test("litellm 兜底层 → official：官方来源首次到达，自动升级并生成通知", () => {
    const pricing = pricingWith([
      {id: "claude-litellm-model", vendor: "anthropic", confidence: "litellm", pricing: {input: 9, output: 45}},
    ]);
    const plan = classifyCatalogSync(pricing, catalog, allUsed);
    expect(plan.autoUpdateCount).toBe(1);
    expect(findNotificationItem(plan, "claude-litellm-model")).toBeDefined();
  });

  test("official 值变化：使用中与未使用都自动生效并生成通知（原确认制废除）", () => {
    const base = [
      {id: "claude-new-model", vendor: "anthropic", pricing: {input: 1.5, output: 10} as ModelPriceEntry["pricing"]},
    ];
    const usedPlan = classifyCatalogSync(pricingWith(base), catalog, allUsed);
    const unusedPlan = classifyCatalogSync(pricingWith(base), catalog, noneUsed);
    for (const plan of [usedPlan, unusedPlan]) {
      expect(plan.autoUpdateCount).toBe(1);
      const item = findNotificationItem(plan, "claude-new-model");
      expect(item?.changes.some(change => change.field === "input")).toBe(true);
    }
    expect(usedPlan.notification?.items[0]?.inUse).toBe(true);
    expect(unusedPlan.notification?.items[0]?.inUse).toBeUndefined();
  });

  test("official 仅字段新增（cacheWrite 原无 → 目录有）→ 自动生效并生成通知（added 项）", () => {
    const pricing = pricingWith([
      {id: "claude-field-add", vendor: "anthropic", pricing: {input: 1, output: 5}},
    ]);
    const plan = classifyCatalogSync(pricing, catalog, allUsed);
    const item = findNotificationItem(plan, "claude-field-add");
    expect(item?.changes.some(change => change.kind === "added")).toBe(true);
  });

  test("价格中心有、目录无 → 永不删除", () => {
    const pricing = pricingWith([
      {id: "claude-gone-from-catalog", vendor: "anthropic", pricing: {input: 4, output: 20}},
    ]);
    const plan = classifyCatalogSync(pricing, catalog, noneUsed);
    expect(findNotificationItem(plan, "claude-gone-from-catalog")).toBeUndefined();
    expect(plan.insertCount).toBe(5);
    expect(plan.autoUpdateCount).toBe(0);
  });

  test("官方目录移除已推荐模型时生成移除通知并更新推荐集合", () => {
    const pricing = pricingWith([
      {
        id: "catalog:anthropic:claude-gone-from-catalog",
        vendor: "anthropic",
        runtimeModelId: "claude-gone-from-catalog",
        pricing: {input: 4, output: 20},
      },
    ]);
    const changedCatalog = {
      ...catalog,
      providers: {
        ...catalog.providers,
        anthropic: {
          ...catalog.providers.anthropic,
          models: catalog.providers.anthropic.models.filter(model => model.id !== "claude-gone-from-catalog"),
        },
      },
    };
    const plan = classifyCatalogSync(
      pricing,
      changedCatalog,
      noneUsed,
      new Set(["anthropic\u0000anthropic\u0000claude-gone-from-catalog"]),
    );
    const item = findNotificationItem(plan, "claude-gone-from-catalog");
    expect(item?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({field: "officialCatalogMembership", kind: "removed"}),
    ]));
    expect(plan.membershipChangeCount).toBe(1);
  });

  test("无任何差异 → 全空且不生成通知", () => {
    const pricing = pricingWith([
      {id: "claude-fable-5", vendor: "anthropic", pricing: {input: 10, output: 50, cachedInput: 1},
        promotions: [{from: "2026-07-01T00:00:00Z", label: "限时优惠", priceOverride: {input: 8, output: 40, cachedInput: 0.8}}]},
      {id: "claude-new-model", vendor: "anthropic", pricing: {input: 2, output: 10}},
      {id: "claude-override-model", vendor: "anthropic", pricing: {input: 5, output: 25}},
      {id: "claude-field-add", vendor: "anthropic", pricing: {input: 1, output: 5, cacheWrite: 2}},
      {id: "claude-litellm-model", vendor: "anthropic", pricing: {input: 3, output: 15}},
      {id: "claude-gone-from-catalog", vendor: "anthropic", pricing: {input: 4, output: 20}},
    ]);
    const plan = classifyCatalogSync(pricing, catalog, allUsed);
    expect(plan.insertCount).toBe(0);
    expect(plan.autoUpdateCount).toBe(0);
    expect(plan.notification).toBeUndefined();
  });

  test("促销（payg Campaign 投影）变化必须进入通知：实扣价变化可见", () => {
    const pricing = pricingWith([
      {id: "claude-fable-5", vendor: "anthropic", pricing: {input: 10, output: 50, cachedInput: 1},
        promotions: [{from: "2026-07-01T00:00:00Z", label: "限时优惠", priceOverride: {input: 9, output: 45, cachedInput: 0.9}}]},
    ]);
    const plan = classifyCatalogSync(pricing, catalog, allUsed);
    const item = findNotificationItem(plan, "claude-fable-5");
    expect(item?.changes.some(change => change.field.startsWith("promotions."))).toBe(true);
  });

  test("套餐促销倍率容差内精化（0.67 ↔ 2/3）→ 自动生效但不生成通知（防刷屏）", () => {
    const zhipuV2 = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.09.10.02",
      publishedAt: "2026-09-10T12:00:00+08:00",
      providers: {
        "zhipu-cn": {
          name: "智谱", brandId: "zhipu", pricingProviderId: "zhipu-cn", region: "cn", category: "cn_official",
          planProfiles: {"p1": {
            calculator: {kind: "token_weighted", divisor: 10000},
            timezone: "Asia/Shanghai",
            quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
          }},
          campaigns: [{
            id: "zhipu.zcode.plan.1", channel: "plan", profileRef: "p1",
            scope: {agents: ["zcode"]}, period: {from: "2026-06-01T00:00:00+08:00"},
            effect: {kind: "creditMultiplier", value: {numerator: 2, denominator: 3}},
          }],
          models: [{id: "glm-5.3", category: "chat", pricing: {input: 8, output: 28}, planProfileRef: "p1", planFactors: {input: 6.9, output: 24, cachedInput: 1.7}}],
        },
      },
    }).catalog;
    // v1 形状的存量条目：模型级 planCreditRules + multiplier 0.67（数值精化场景）。
    const v1Shaped = pricingWith([
      {id: "catalog:zhipu-cn:glm-5.3", vendor: "zhipu-cn", match: "glm-5.3", patterns: ["glm-5.3"], pricing: {input: 8, output: 28},
        planCreditRules: {
          formula: "token_weighted", divisor: 10000, timezone: "Asia/Shanghai",
          modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
          promotions: [{from: "2026-06-01T00:00:00+08:00", models: ["glm-5.3"], agents: ["zcode"], multiplier: 0.67}],
          quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
        }},
    ]);
    const plan = classifyCatalogSync(v1Shaped, zhipuV2, allUsed);
    expect(plan.autoUpdateCount).toBe(1);
    expect(plan.toleranceSilentCount).toBe(1);
    expect(plan.notification).toBeUndefined();
  });

  test("结构性变化不适用容差：模态被目录回退删除（价格不变）必须生成通知（2026-09-23 事故回归）", () => {
    // 事故现场：管理台草稿基于旧发布位生成、丢失 inputModalities 声明；同步时 15 条
    // 「价格不变、仅模态删除」的变化曾被容差判等价而静默，且 merge 照常执行把能力抹掉。
    const catalogNoModality = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.09.23.01",
      publishedAt: "2026-09-23T00:04:45+08:00",
      providers: {
        anthropic: {
          name: "Anthropic（官方）", brandId: "anthropic", pricingProviderId: "anthropic",
          region: "global", category: "global_official",
          models: [{id: "claude-fable-5", category: "chat", pricing: {input: 10, output: 50, cachedInput: 1}}],
        },
      },
    }).catalog;
    const center = pricingWith([
      {id: "catalog:anthropic:claude-fable-5", match: "claude-fable-5", patterns: ["claude-fable-5"],
        pricing: {input: 10, output: 50, cachedInput: 1},
        inputModalities: ["text", "image"]},
    ]);
    const plan = classifyCatalogSync(center, catalogNoModality, allUsed);
    expect(plan.autoUpdateCount).toBe(1);
    expect(plan.toleranceSilentCount).toBe(0);
    const item = findNotificationItem(plan, "claude-fable-5");
    expect(item).toBeDefined();
    expect(item?.changes.some(change => change.field === "inputModalities")).toBe(true);
  });

  test("fast 档倍率变化必须生成通知，不再被容差静默（2026-10-08 盲点修复回归）", () => {
    const fastCatalog = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.10.08.01",
      publishedAt: "2026-10-08T00:36:51+08:00",
      providers: {
        openai: {
          name: "OpenAI", brandId: "openai", pricingProviderId: "openai",
          region: "global", category: "global_official",
          models: [{id: "gpt-5.6-sol", category: "chat", pricing: {input: 5, output: 30}, serviceTierPricing: {fastMultiplier: 2}}],
        },
      },
    }).catalog;

    // 场景一：价格四价全部一致，仅 fastMultiplier 2→3——旧版容差不比较该字段会静默。
    const changedCenter = pricingWith([
      {id: "catalog:openai:gpt-5.6-sol", vendor: "openai", match: "gpt-5.6-sol", patterns: ["gpt-5.6-sol"],
        pricing: {input: 5, output: 30}, serviceTierPricing: {fastMultiplier: 3}},
    ]);
    const changedPlan = classifyCatalogSync(changedCenter, fastCatalog, allUsed);
    expect(changedPlan.autoUpdateCount).toBe(1);
    expect(changedPlan.toleranceSilentCount).toBe(0);
    const changedItem = findNotificationItem(changedPlan, "gpt-5.6-sol");
    expect(changedItem).toBeDefined();
    expect(changedItem?.changes.some(change => change.field === "serviceTierPricing.fastMultiplier")).toBe(true);

    // 场景二：fast 档从无到有（如旧进程丢字段后的恢复）也必须通知。
    const restoredCenter = pricingWith([
      {id: "catalog:openai:gpt-5.6-sol", vendor: "openai", match: "gpt-5.6-sol", patterns: ["gpt-5.6-sol"],
        pricing: {input: 5, output: 30}},
    ]);
    const restoredPlan = classifyCatalogSync(restoredCenter, fastCatalog, allUsed);
    expect(restoredPlan.toleranceSilentCount).toBe(0);
    expect(findNotificationItem(restoredPlan, "gpt-5.6-sol")).toBeDefined();

    // 场景三：倍率等值（表示迁移）仍静默，防止刷屏。
    const sameCenter = pricingWith([
      {id: "catalog:openai:gpt-5.6-sol", vendor: "openai", match: "gpt-5.6-sol", patterns: ["gpt-5.6-sol"],
        pricing: {input: 5, output: 30}, serviceTierPricing: {fastMultiplier: 2}},
    ]);
    const samePlan = classifyCatalogSync(sameCenter, fastCatalog, allUsed);
    expect(samePlan.autoUpdateCount).toBe(0);
    expect(samePlan.toleranceSilentCount).toBe(0);
    expect(samePlan.notification).toBeUndefined();
  });

  test("促销观测通道（origins）收窄是结构性变化：diff 可见且不适用容差静默", () => {
    const withOrigins = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.09.23.01",
      publishedAt: "2026-09-23T00:04:45+08:00",
      providers: {
        "zhipu-cn": {
          name: "智谱", brandId: "zhipu", pricingProviderId: "zhipu-cn", region: "cn", category: "cn_official",
          planProfiles: {"p1": {
            calculator: {kind: "token_weighted", divisor: 10000},
            timezone: "Asia/Shanghai",
          }},
          campaigns: [{
            id: "zhipu.zcode.plan.1", channel: "plan", profileRef: "p1",
            scope: {agents: ["zcode"], origins: ["agent_local_import"]},
            period: {from: "2026-06-01T00:00:00+08:00"},
            effect: {kind: "creditMultiplier", value: 0.67},
          }],
          models: [{id: "glm-5.3", category: "chat", pricing: {input: 8, output: 28}, planProfileRef: "p1", planFactors: {input: 6.9, output: 24, cachedInput: 1.7}}],
        },
      },
    }).catalog;
    // 本地促销价格完全一致，仅缺 origins 限定（全通道 → 仅本地导入）。
    const center = pricingWith([
      {id: "catalog:zhipu-cn:glm-5.3", vendor: "zhipu-cn", match: "glm-5.3", patterns: ["glm-5.3"],
        pricing: {input: 8, output: 28},
        planCreditRules: {
          formula: "token_weighted", divisor: 10000, timezone: "Asia/Shanghai",
          modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
          promotions: [{from: "2026-06-01T00:00:00+08:00", models: ["glm-5.3"], agents: ["zcode"], multiplier: 0.67}],
          quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
        }},
    ]);
    const plan = classifyCatalogSync(center, withOrigins, allUsed);
    expect(plan.toleranceSilentCount).toBe(0);
    const item = findNotificationItem(plan, "glm-5.3");
    expect(item?.changes.some(change => change.field.startsWith("planCredit.promotion."))).toBe(true);
  });

  test("effectiveFrom 透传到通知徽标（本批最早官方生效时刻）", () => {
    const withEffective = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.09.10.02",
      publishedAt: "2026-09-10T11:00:00+08:00",
      providers: {
        deepseek: {
          name: "DeepSeek", brandId: "deepseek", pricingProviderId: "deepseek", region: "cn", category: "official",
          models: [
            {id: "flash", category: "chat", rateTimeline: [{pricing: {input: 1, output: 4}}, {effectiveFrom: "2026-09-10T12:00:00+08:00", pricing: {input: 2, output: 8}}]},
            {id: "pro", category: "chat", rateTimeline: [{pricing: {input: 4, output: 13}}, {effectiveFrom: "2026-09-10T15:00:00+08:00", pricing: {input: 9, output: 27}}]},
          ],
        },
      },
    }).catalog;
    const plan = classifyCatalogSync(pricingWith([]), withEffective, noneUsed);
    expect(plan.notification?.effectiveFrom).toBe("2026-09-10T12:00:00+08:00");
    expect(findNotificationItem(plan, "flash")?.effectiveFrom).toBe("2026-09-10T12:00:00+08:00");
  });
});

describe("版本闸门（含 v2 切换重置）", () => {
  const newer = catalog;

  test("已同步版本不落后且源哈希一致 → 跳过", () => {
    expect(shouldSkipCatalogSync({lastSyncedPublishedAt: "2026-09-07T00:00:00+08:00", lastSyncedCatalogRevision: "2026.09.07.01", lastSyncedSourceHash: "sha256:a"}, newer)).toBe(true);
    expect(shouldSkipCatalogSync({lastSyncedPublishedAt: "2026-09-06T23:00:00+08:00"}, newer)).toBe(false);
  });

  test("同日多版按 catalogRevision 字典序比较", () => {
    expect(shouldSkipCatalogSync({lastSyncedPublishedAt: "2026-09-07T00:00:00+08:00", lastSyncedCatalogRevision: "2026.09.07.02", lastSyncedSourceHash: "sha256:a"}, newer)).toBe(true);
    // revision 虽更大，但 publishedAt 没有严格晚于已同步版本，仍然跳过。
    expect(shouldSkipCatalogSync({lastSyncedPublishedAt: "2026-09-07T00:00:00+08:00", lastSyncedCatalogRevision: "2026.09.06.99", lastSyncedSourceHash: "sha256:a"}, newer)).toBe(true);
  });

  test("同版本内容/源哈希变化一律跳过（2026-09-21 严格版本制）", () => {
    const sameVersion = {lastSyncedPublishedAt: "2026-09-07T00:00:00+08:00", lastSyncedCatalogRevision: "2026.09.07.01"};
    // 哈希变化：不升版不接收——任何内容修改必须升版发布并经通知知情，
    // 杜绝远程同版本旧内容恢复可达后覆盖本地新数据。
    expect(shouldSkipCatalogSync({...sameVersion, lastSyncedSourceHash: "sha256:old"}, newer)).toBe(true);
    // 哈希缺失（历史标记）同样跳过。
    expect(shouldSkipCatalogSync(sameVersion, newer)).toBe(true);
  });

  test("同 revision 但发布时间更新仍跳过，避免旧 revision 内容覆盖随包基准", () => {
    const sameRevisionLaterAt = {
      ...newer,
      publishedAt: "2026-09-07T12:00:00+08:00",
    };
    expect(shouldSkipCatalogSync({
      lastSyncedPublishedAt: "2026-09-07T00:00:00+08:00",
      lastSyncedCatalogRevision: "2026.09.07.01",
    }, sameRevisionLaterAt)).toBe(true);
  });

  test("revision 更新但发布时间倒退时跳过", () => {
    const newerRevisionOlderAt = {
      ...newer,
      catalogRevision: "2026.09.08.01",
      publishedAt: "2026-09-06T23:00:00+08:00",
    };
    expect(shouldSkipCatalogSync({
      lastSyncedPublishedAt: "2026-09-07T00:00:00+08:00",
      lastSyncedCatalogRevision: "2026.09.07.01",
    }, newerRevisionOlderAt)).toBe(true);
  });

  test("不同 RFC3339 时区表达同一时刻时不视为新版本", () => {
    expect(shouldSkipCatalogSync({
      lastSyncedPublishedAt: "2026-09-07T00:00:00Z",
      lastSyncedCatalogRevision: "2026.09.07.01",
    }, {
      ...newer,
      catalogRevision: "2026.09.07.02",
      publishedAt: "2026-09-07T08:00:00+08:00",
    })).toBe(true);
  });

  test("旧格式 marker（空格分隔/纯日期 publishedAt）视为不存在：v2 切换即重置（验收用例 16）", () => {
    expect(shouldSkipCatalogSync({lastSyncedPublishedAt: "2099-01-01 00:00:00"}, newer)).toBe(false);
    expect(shouldSkipCatalogSync({lastSyncedPublishedAt: "2099-01-01"}, newer)).toBe(false);
  });
});

describe("通知追加与有界保留（验收用例 20）", () => {
  function notification(revision: string, acked = false) {
    return {
      catalogRevision: revision,
      publishedAt: `2026-09-${revision.slice(8, 10)}T00:00:00+08:00`,
      createdAt: "2026-09-10T00:00:00Z",
      ...(acked ? {ackedAt: "2026-09-10T01:00:00Z"} : {}),
      items: [],
    };
  }

  test("新通知置顶；同版本去重（重复同步不重复通知）", () => {
    const marker: CatalogSyncMarker = {notifications: [notification("2026.09.09.01", true)]};
    const merged = appendCatalogNotification(marker, notification("2026.09.10.02"));
    expect(merged.map(item => item.catalogRevision)).toEqual(["2026.09.10.02", "2026.09.09.01"]);
    const deduped = appendCatalogNotification({notifications: merged}, notification("2026.09.10.02"));
    expect(deduped).toHaveLength(2);
  });

  test("超出 50 版裁剪最老已阅；未阅不被裁剪", () => {
    const existing = Array.from({length: 50}, (_, index) => notification(`2026.09.01.${String(index + 1).padStart(2, "0")}`, true));
    const merged = appendCatalogNotification({notifications: existing}, notification("2026.09.10.02"));
    expect(merged).toHaveLength(50);
    expect(merged[0]?.catalogRevision).toBe("2026.09.10.02");
    expect(merged[0]?.ackedAt).toBeUndefined();
  });
});

describe("迁移等价容差（深检 2）", () => {
  const base = {id: "e", vendor: "v", patterns: ["m"], confidence: "official" as const};

  test("数值容差：绝对差 ≤ 0.01 或相对差 ≤ 0.5%（0.67 ↔ 2/3 判等价）", () => {
    expect(migrationEquivalentWithinTolerance(
      {...base, pricing: {input: 2 / 3, output: 1}},
      {...base, pricing: {input: 0.67, output: 1}},
    )).toBe(true);
    expect(migrationEquivalentWithinTolerance(
      {...base, pricing: {input: 1.0001, output: 1}},
      {...base, pricing: {input: 1, output: 1}},
    )).toBe(true);
    expect(migrationEquivalentWithinTolerance(
      {...base, pricing: {input: 2, output: 1}},
      {...base, pricing: {input: 1, output: 1}},
    )).toBe(false);
  });

  test("服务档位倍率（2026-10-08 盲点修复）：出现/消失/变化不等价，等值（含数值精化）等价", () => {
    const withPricing = {...base, pricing: {input: 1, output: 2}};
    expect(migrationEquivalentWithinTolerance(
      {...withPricing, serviceTierPricing: {fastMultiplier: 2}},
      withPricing,
    )).toBe(false);
    expect(migrationEquivalentWithinTolerance(
      withPricing,
      {...withPricing, serviceTierPricing: {fastMultiplier: 2}},
    )).toBe(false);
    expect(migrationEquivalentWithinTolerance(
      {...withPricing, serviceTierPricing: {fastMultiplier: 3}},
      {...withPricing, serviceTierPricing: {fastMultiplier: 2}},
    )).toBe(false);
    expect(migrationEquivalentWithinTolerance(
      {...withPricing, serviceTierPricing: {fastMultiplier: 2}},
      {...withPricing, serviceTierPricing: {fastMultiplier: 2.0000001}},
    )).toBe(true);
  });

  test("结构性差异（窗口集合/公式）不在容差内", () => {
    const withPricing = {...base, pricing: {input: 1, output: 2}};
    expect(migrationEquivalentWithinTolerance(
      {...withPricing, priceSchedules: [{label: "闲时", windows: [{start: "00:00", end: "24:00"}], rates: {input: 0.5, output: 1}}]},
      {...withPricing, priceSchedules: [{label: "闲时", windows: [{start: "01:00", end: "24:00"}], rates: {input: 0.5, output: 1}}]},
    )).toBe(false);
    expect(migrationEquivalentWithinTolerance(
      {...withPricing, planCreditRules: {formula: "token_weighted", quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}]}},
      {...withPricing, planCreditRules: {formula: "afp_weighted", quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}]}},
    )).toBe(false);
  });

  test("长上下文档位是结构性字段：仅长档差异（如新增 cacheWrite）绝不判容差等价（2026-09-30 OpenCode Go .04 回归）", () => {
    const withPricing = {...base, pricing: {input: 1, output: 2}};
    const tier = {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5, rates: {input: 0.2, output: 0.75, cachedInput: 0.02}};
    // 事故现场：顶层价格全等、唯一差异为长档 rates 新增 cacheWrite——曾被判容差内
    // 静默（merge 照常应用却无通知，违反「无论任何修改走通知」红线）。
    expect(migrationEquivalentWithinTolerance(
      {...withPricing, pricing: {input: 1, output: 2, longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5, rates: {input: 0.2, output: 0.75, cachedInput: 0.02, cacheWrite: 0.25}}}},
      {...withPricing, pricing: {input: 1, output: 2, longContext: tier}},
    )).toBe(false);
    // 长档完全一致 → 容差语义不受影响（数值精化仍静默）。
    expect(migrationEquivalentWithinTolerance(
      {...withPricing, pricing: {input: 1, output: 2, longContext: {...tier, rates: {...tier.rates}}}},
      {...withPricing, pricing: {input: 1, output: 2, longContext: tier}},
    )).toBe(true);
  });
});
