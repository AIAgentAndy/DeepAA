import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import {
  MAX_PROVIDER_CATALOG_BYTES,
  listAutomaticWhitelistCandidates,
  normalizeProviderCatalog,
  parseProviderCatalogText,
} from "../src/lib/provider-catalog/normalize.js";
import {isValidCatalogRevision, isValidRfc3339WithZone} from "../src/lib/provider-catalog/catalog-contract.js";

function validCatalog(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    catalogRevision: "2026.09.10.02",
    publishedAt: "2026-09-10T14:00:00+08:00",
    providers: {
      "zhipu-cn": {
        name: "智谱 GLM（中国区）",
        brandId: "zhipu",
        pricingProviderId: "zhipu-cn",
        region: "cn",
        category: "cn_official",
        openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
        anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
        vendorFamily: "zhipu",
        supportedBillingChannels: ["pay_as_you_go", "plan"],
        models: [
          {
            id: "glm-4-flash",
            category: "chat",
            contextWindowK: 128,
            maxOutputK: 16,
            pricing: {input: 0.1, output: 0.1, cachedInput: 0.02},
          },
          {
            id: "embedding-3",
            category: "embedding",
            contextWindowK: 8,
            pricing: {input: 0.05, output: 0},
          },
          {
            id: "glm-unpriced",
            category: "chat",
            contextWindowK: 128,
          },
        ],
      },
    },
  };
}

describe("供应商模型目录 v2 契约", () => {
  test("规范化固定元信息/providers 结构并保留官方原始价格数值", () => {
    const parsed = normalizeProviderCatalog(validCatalog());

    expect(parsed.catalog.schemaVersion).toBe(2);
    expect(parsed.catalog.catalogRevision).toBe("2026.09.10.02");
    expect(parsed.catalog.publishedAt).toBe("2026-09-10T14:00:00+08:00");
    expect(parsed.catalog.providers["zhipu-cn"]?.pricingProviderId).toBe("zhipu-cn");
    expect(parsed.catalog.providers["zhipu-cn"]?.models[0]?.pricing).toEqual({
      input: 0.1,
      output: 0.1,
      cachedInput: 0.02,
    });
    expect(parsed.diagnostics).toEqual([]);
  });

  test("元信息闸门：schemaVersion/catalogRevision/publishedAt 非法整目录拒绝", () => {
    expect(() => normalizeProviderCatalog({...validCatalog(), schemaVersion: 1})).toThrow(/CATALOG_SCHEMA_UNSUPPORTED/u);
    expect(() => normalizeProviderCatalog({...validCatalog(), schemaVersion: undefined})).toThrow(/CATALOG_SCHEMA_UNSUPPORTED/u);
    // publishedAt 必须 RFC 3339 且带时区：空格分隔与纯日期不再是正式格式。
    expect(() => normalizeProviderCatalog({...validCatalog(), publishedAt: "2026-09-06 16:20:04"})).toThrow(/RFC 3339/u);
    expect(() => normalizeProviderCatalog({...validCatalog(), publishedAt: "2026-09-06"})).toThrow(/RFC 3339/u);
    expect(() => normalizeProviderCatalog({...validCatalog(), publishedAt: "2026-09-06T16:20:04"})).toThrow(/RFC 3339/u);
    // catalogRevision 固定宽度 YYYY.MM.DD.NN。
    expect(() => normalizeProviderCatalog({...validCatalog(), catalogRevision: "2026.9.10.1"})).toThrow(/catalogRevision/u);
    expect(() => normalizeProviderCatalog({...validCatalog(), catalogRevision: "v2"})).toThrow(/catalogRevision/u);
  });

  test("公共日历：日期去重排序、非法日期/时区整目录拒绝", () => {
    const input = validCatalog();
    input.calendars = {
      cn_public_holidays: {
        timezone: "Asia/Shanghai",
        dates: ["2026-10-02", "2026-10-01", "2026-10-02"],
      },
    };
    const parsed = normalizeProviderCatalog(input);
    expect(parsed.catalog.calendars?.cn_public_holidays?.dates).toEqual(["2026-10-01", "2026-10-02"]);

    const bad = validCatalog();
    bad.calendars = {cn: {timezone: "Asia/Shanghai", dates: ["2026-13-01"]}};
    expect(() => normalizeProviderCatalog(bad)).toThrow(/CATALOG_META_INVALID/u);
    const badZone = validCatalog();
    badZone.calendars = {cn: {timezone: "Mars/Olympus", dates: ["2026-10-01"]}};
    expect(() => normalizeProviderCatalog(badZone)).toThrow(/CATALOG_META_INVALID/u);
  });

  test("按 pricingProviderId + modelId 拒绝跨目录 key 的重复条目", () => {
    const input = validCatalog();
    const providers = input.providers as Record<string, unknown>;
    providers.alias = {
      name: "重复变体",
      brandId: "zhipu",
      pricingProviderId: "zhipu-cn",
      region: "global",
      category: "global_official",
      models: [{id: "glm-4-flash", category: "chat", pricing: {input: 1, output: 1}}],
    };

    expect(() => normalizeProviderCatalog(input)).toThrow(/pricingProviderId.*modelId.*重复/u);
  });

  test.each([
    ["负价格", {input: -0.1, output: 1}],
    ["无限价格", {input: 1, output: Number.POSITIVE_INFINITY}],
    ["非安全整数上下文", {input: 1, output: 1}, Number.MAX_SAFE_INTEGER + 1],
  ])("拒绝%s", (_label, pricing, contextWindowK = 128) => {
    const input = validCatalog();
    const provider = (input.providers as Record<string, Record<string, unknown>>)["zhipu-cn"];
    provider.models = [{
      id: "glm-invalid",
      category: "chat",
      contextWindowK,
      maxOutputK: 16,
      pricing,
    }];

    expect(() => normalizeProviderCatalog(input)).toThrow();
  });

  test("容忍未知扩展字段，但拒绝非法已知字段", () => {
    const input = validCatalog();
    input.futureTopLevelField = {enabled: true};
    const provider = (input.providers as Record<string, Record<string, unknown>>)["zhipu-cn"];
    provider.futureProviderField = "next";
    const models = provider.models as Array<Record<string, unknown>>;
    models[0].futureModelField = 42;

    expect(() => normalizeProviderCatalog(input)).not.toThrow();

    provider.region = "moon";
    expect(() => normalizeProviderCatalog(input)).toThrow(/region/u);
  });

  test("自动白名单只包含可计价 chat 模型", () => {
    const provider = normalizeProviderCatalog(validCatalog()).catalog.providers["zhipu-cn"];

    expect(listAutomaticWhitelistCandidates(provider).map(model => model.id)).toEqual([
      "glm-4-flash",
    ]);
  });

  test("在 JSON.parse 前拒绝超过 8 MiB 的响应", () => {
    const oversized = " ".repeat(MAX_PROVIDER_CATALOG_BYTES + 1);

    expect(() => parseProviderCatalogText(oversized)).toThrow(/8 MiB/u);
  });

  test("模型 v2 字段：rateTimeline 声明后顶层价格自动填充、planFactors/planAliases/planProfileRef 透传", () => {
    const input = validCatalog();
    const provider = (input.providers as Record<string, Record<string, unknown>>)["zhipu-cn"];
    provider.models = [{
      id: "glm-5.3",
      category: "chat",
      rateTimeline: [
        {pricing: {input: 4, output: 14}},
        {effectiveFrom: "2026-09-10T12:00:00+08:00", pricing: {input: 2, output: 7}, changeNote: "官方调价"},
      ],
      planProfileRef: "zhipu-coding-v1",
      planAliases: {"glm-5.2": "glm-5.3"},
    }];
    const model = normalizeProviderCatalog(input).catalog.providers["zhipu-cn"]?.models[0];
    expect(model?.planProfileRef).toBe("zhipu-coding-v1");
    expect(model?.planAliases).toEqual({"glm-5.2": "glm-5.3"});
    // 顶层 pricing = 最后一段自动填充。
    expect(model?.pricing).toEqual({input: 2, output: 7});
    expect(model?.rateTimeline).toHaveLength(2);
    expect(model?.rateTimeline?.[1]?.changeNote).toBe("官方调价");
  });
});

describe("目录 v2 Campaign/Profile/预设级隔离（5.2）", () => {
  function catalogWith(campaigns: unknown[], extra: Record<string, unknown> = {}) {
    return normalizeProviderCatalog({
      ...validCatalog(),
      providers: {
        demo: {
          name: "Demo",
          brandId: "demo",
          pricingProviderId: "demo",
          region: "global",
          category: "official",
          defaultTimezone: "Asia/Shanghai",
          ...extra,
          models: [{id: "m1", category: "chat", pricing: {input: 5, output: 30}}],
          campaigns,
        },
      },
    });
  }

  test("合法 payg priceOverride 活动保留并携带结构字段", () => {
    const parsed = catalogWith([{
      id: "demo.m1.payg.1",
      channel: "payg",
      scope: {models: ["m1"]},
      period: {from: "2026-07-01T00:00:00Z"},
      effect: {kind: "priceOverride", rates: {input: 4, output: 20}},
      priority: 100,
      stackingPolicy: "override",
      label: "限时优惠",
      unverified: true,
      note: "来源说明",
    }]);
    expect(parsed.catalog.providers.demo?.campaigns).toHaveLength(1);
    const campaign = parsed.catalog.providers.demo?.campaigns?.[0];
    expect(campaign?.effect).toEqual({kind: "priceOverride", rates: {input: 4, output: 20}});
    expect(campaign?.label).toBe("限时优惠");
    expect(campaign?.unverified).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
  });

  test("结构非法活动按诊断隔离：未知 kind、未知 scope 条件、坏分数、坏时刻", () => {
    const parsed = catalogWith([
      {id: "bad.kind", channel: "payg", period: {from: "2026-07-01T00:00:00Z"}, effect: {kind: "unknownThing"}},
      {id: "bad.scope", channel: "payg", period: {from: "2026-07-01T00:00:00Z"}, scope: {galaxy: ["milkyway"]}, effect: {kind: "priceOverride", rates: {input: 1}}},
      {id: "bad.ratio", channel: "plan", profileRef: "p1", period: {from: "2026-07-01T00:00:00Z"}, effect: {kind: "creditMultiplier", value: {numerator: 2, denominator: 0}}},
      {id: "bad.time", channel: "payg", period: {from: "not-a-date"}, effect: {kind: "priceOverride", rates: {input: 1}}},
      {id: "ok", channel: "payg", period: {from: "2026-07-01T00:00:00Z"}, effect: {kind: "priceOverride", rates: {input: 2}}},
    ], {planProfiles: {p1: {calculator: {kind: "token_weighted"}, timezone: "Asia/Shanghai"}}});
    expect(parsed.catalog.providers.demo?.campaigns?.map(campaign => campaign.id)).toEqual(["ok"]);
    expect(parsed.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining(["CAMPAIGN_STRUCTURE_INVALID", "CAMPAIGN_STRUCTURE_INVALID", "CAMPAIGN_STRUCTURE_INVALID", "CAMPAIGN_STRUCTURE_INVALID"]),
    );
  });

  test("第二期 effect kind（priceMultiplier 等）保留在目录但由编译层隔离（契约前向定义）", () => {
    const parsed = catalogWith([{
      id: "future.mult",
      channel: "payg",
      period: {from: "2026-07-01T00:00:00Z"},
      effect: {kind: "priceMultiplier", value: 0.5},
    }]);
    expect(parsed.catalog.providers.demo?.campaigns).toHaveLength(1);
    expect(parsed.diagnostics).toEqual([]);
  });

  test("presets 结构非法按诊断剔除；合法 presets 透传", () => {
    const parsed = normalizeProviderCatalog({
      ...validCatalog(),
      providers: {
        demo: {
          name: "Demo",
          brandId: "demo",
          pricingProviderId: "demo",
          region: "global",
          category: "official",
          presets: [
            {presetKey: "demo", billingChannel: "pay_as_you_go", name: "Demo"},
            {billingChannel: "pay_as_you_go", name: "缺 presetKey"},
          ],
          models: [{id: "m1", category: "chat", pricing: {input: 5, output: 30}}],
        },
      },
    });
    expect(parsed.catalog.providers.demo?.presets).toHaveLength(1);
    expect(parsed.catalog.providers.demo?.presets?.[0]?.presetKey).toBe("demo");
    expect(parsed.diagnostics.map(item => item.code)).toEqual(["PRESET_REGISTRY_MISMATCH"]);
  });

  test("planProfiles 结构非法按诊断剔除；quotaTiers/toolFactors 归一化", () => {
    const input = normalizeProviderCatalog({
      ...validCatalog(),
      providers: {
        "zhipu-cn": {
          name: "智谱",
          brandId: "zhipu",
          pricingProviderId: "zhipu-cn",
          region: "cn",
          category: "cn_official",
          planProfiles: {
            "zhipu-coding-v1": {
              calculator: {kind: "token_weighted", divisor: 10000},
              timezone: "Asia/Shanghai",
              offPeakMultiplier: 0.5,
              peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00"}],
              quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
              quotaTiers: {lite: {quotaByWindow: {"5h": 2000, weekly: 10000}}},
              toolFactors: [{id: "web_search", mode: "output_factor"}, {id: "fixed_tool", mode: "fixed", perCall: 1.2}],
            },
          },
          models: [{id: "glm-5.3", category: "chat", pricing: {input: 8, output: 28}, planProfileRef: "zhipu-coding-v1"}],
        },
      },
    });
    const profile = input.catalog.providers["zhipu-cn"]?.planProfiles?.["zhipu-coding-v1"];
    expect(profile?.timezone).toBe("Asia/Shanghai");
    expect(profile?.offPeakMultiplier).toBe(0.5);
    expect(profile?.peakWindows?.[0]?.multiplier).toBeUndefined();
    expect(profile?.quotaTiers?.lite?.quotaByWindow).toEqual({"5h": 2000, weekly: 10000});
    expect(profile?.toolFactors).toEqual([{id: "web_search", mode: "output_factor"}, {id: "fixed_tool", mode: "fixed", perCall: 1.2}]);
    expect(input.diagnostics).toEqual([]);

    const broken = normalizeProviderCatalog({
      ...validCatalog(),
      providers: {
        demo: {
          name: "Demo", brandId: "demo", pricingProviderId: "demo", region: "global", category: "official",
          planProfiles: {p1: {calculator: {kind: "quantum_weighted"}}},
          models: [{id: "m1", category: "chat", pricing: {input: 5, output: 30}}],
        },
      },
    });
    expect(broken.catalog.providers.demo?.planProfiles).toBeUndefined();
    expect(broken.diagnostics.map(item => item.code)).toEqual(["PROFILE_CALCULATOR_INVALID"]);
  });
});

describe("随包 v2 目录契约（bundled）", () => {
  test("随包目录满足 v2 契约且包含首批供应商变体", async () => {
    const text = await readFile(join(process.cwd(), "data/defaults/llm_catalog.jsonl"), "utf8");
    const parsed = parseProviderCatalogText(text);

    expect(parsed.catalog.schemaVersion).toBe(2);
    // 版本号随每次发布变化：只钉契约（可字典序比较 + 带时区 RFC 3339），不钉具体值。
    expect(isValidCatalogRevision(parsed.catalog.catalogRevision)).toBe(true);
    expect(isValidRfc3339WithZone(parsed.catalog.publishedAt)).toBe(true);
    expect(Object.keys(parsed.catalog.providers)).toEqual(expect.arrayContaining([
      "deepseek",
      "openai",
      "anthropic",
      "zhipu-cn",
      "moonshot-cn",
      "minimax-cn",
      "volcengine-plan",
      "opencode-go",
    ]));
    // 公共日历：2026 法定节假日 33 天。
    expect(parsed.catalog.calendars?.cn_public_holidays?.dates).toHaveLength(33);
  });

  test("随包离线目录的全部预设模型都可作为自动白名单候选", async () => {
    const text = await readFile(join(process.cwd(), "data/defaults/llm_catalog.jsonl"), "utf8");
    const catalog = parseProviderCatalogText(text).catalog;

    for (const key of [
      "zhipu-cn",
      "moonshot-cn",
      "minimax-cn",
      "volcengine-plan",
    ]) {
      const provider = catalog.providers[key];
      expect(provider, key).toBeDefined();
      expect(provider.models.filter(model => model.category === "chat").every(model => model.pricing !== undefined), key).toBe(true);
      expect(listAutomaticWhitelistCandidates(provider).map(model => model.id), key).toEqual(
        provider.models.filter(model => model.category === "chat").map(model => model.id),
      );
    }
  });

  test("随包目录：智谱 Profile/活动、火山 Profile、DeepSeek 节假日窗口均按 v2 维护", async () => {
    const text = await readFile(join(process.cwd(), "data/defaults/llm_catalog.jsonl"), "utf8");
    const catalog = parseProviderCatalogText(text).catalog;

    const zhipu = catalog.providers["zhipu-cn"]!;
    // 智谱：供应商级 Profile + 模型引用 + planAliases。
    // 2026-09-30 官网改版统一口径：非高峰=基础积分 50%、高峰 1 倍；Flash 专属
    // zhipu-coding-flash-v1（0.4/1.2）已随口径统一合并移除，两模型共用 v1。
    const profile = zhipu.planProfiles?.["zhipu-coding-v1"];
    expect(profile?.calculator.kind).toBe("token_weighted");
    expect(profile?.offPeakMultiplier).toBe(0.5);
    expect(profile?.peakWindows?.[0]?.multiplier).toBe(1);
    expect(zhipu.planProfiles?.["zhipu-coding-flash-v1"]).toBeUndefined();
    // 庆双节活动（2026-09-25 至 10-07）：仅命中工作日 14:00-18:00 ×0.5。
    const festival = zhipu.campaigns?.find(campaign => campaign.id === "zhipu-cn.coding-plan.festival-double-2026");
    expect(festival?.profileRef).toBe("zhipu-coding-v1");
    expect(festival?.effect).toEqual({kind: "creditMultiplier", value: 0.5});
    expect(festival?.recurringWindows).toEqual([{timezone: "Asia/Shanghai", days: [0, 1, 2, 3, 4], start: "14:00", end: "18:00"}]);
    expect(Object.keys(profile?.quotaTiers ?? {})).toEqual(expect.arrayContaining(["lite", "pro", "max"]));
    // MCP 工具积分（2026-10-02 官网核对修正）：官方积分表 MCP 工具行固定 Output 系数
    // 1.2（1.2 积分/次），与当前计费模型系数无关；旧 output_factor 语义（按计费模型
    // Output 系数执行，GLM-5.3 下会错算 20 倍）已废弃，三工具统一 fixed/perCall 1.2。
    expect(profile?.toolFactors?.every(factor => factor.mode === "fixed" && factor.perCall === 1.2)).toBe(true);
    // 仅对明确绑定 Coding Plan 的模型校验套餐系数；官方尚未公开
    // GLM-5.3-FlashX 的独立积分系数时，目录应保留按量价而不是伪造套餐数据。
    const glm53 = zhipu.models.find(model => model.id === "glm-5.3");
    const glm53Flash = zhipu.models.find(model => model.id === "glm-5.3-flash");
    expect(glm53?.planProfileRef).toBe("zhipu-coding-v1");
    expect(glm53?.planFactors).toBeDefined();
    expect(glm53Flash?.planProfileRef).toBe("zhipu-coding-v1");
    expect(glm53Flash?.planFactors).toBeDefined();
    // 夜间活动与统一 profile 同源。
    expect(zhipu.campaigns?.filter(campaign => campaign.scope?.models?.includes("glm-5.3-flash"))
      .every(campaign => campaign.profileRef === "zhipu-coding-v1")).toBe(true);
    const flashx = zhipu.models.find(model => model.id === "glm-5.3-flashx");
    expect(flashx?.planProfileRef).toBeUndefined();
    expect(flashx?.planFactors).toBeUndefined();
    expect(zhipu.models[0]?.planAliases).toEqual({"glm-5.2": "glm-5.3", "glm-5.1": "glm-5.3"});
    expect(zhipu.calendarRef).toBe("cn_public_holidays");

    // Anthropic 已切换到新模型 ID；旧 ID 作为兼容别名并入新条目，
    // 避免既有价格映射在目录升版后失配。
    const anthropic = catalog.providers.anthropic!;
    expect(anthropic.models.find(model => model.id === "claude-fable-5-1")?.aliases).toEqual(["claude-fable-5"]);
    expect(anthropic.models.find(model => model.id === "claude-opus-5-5")?.aliases).toEqual(["claude-opus-5"]);

    // 火山：afp Profile + factorOverride 活动。
    const volc = catalog.providers["volcengine-plan"]!;
    expect(volc.planProfiles?.["volcengine-afp-v1"]?.calculator.kind).toBe("afp_weighted");
    expect(volc.campaigns?.some(campaign =>
      campaign.channel === "plan" && campaign.effect.kind === "factorOverride")).toBe(true);

    // DeepSeek：闲时窗口引用公共日历（includeHolidays）；flash 系列当前主力为 deepseek-flash。
    const flash = catalog.providers.deepseek.models.find(item => item.id === "deepseek-flash");
    const flashTimeline = flash?.rateTimeline ?? [];
    const flashSchedules = flashTimeline[flashTimeline.length - 1]?.priceSchedules ?? [];
    expect(flashSchedules[0]?.windows.some(window => window.includeHolidays === true)).toBe(true);
    // 同模型线旧代 deepseek-v4-flash 已退役（官方价格页不再收录），不再进目录。
    expect(catalog.providers.deepseek.models.some(item => item.id === "deepseek-v4-flash")).toBe(false);

    // deepseek-v4-pro：当前官方价格页仍按 Pro 牌价提供 API，未再声明
    // 2026-09-14 的 Flash 切价；因此目录只保留一段当前有效价格。
    const proTimeline = catalog.providers.deepseek.models.find(item => item.id === "deepseek-v4-pro")?.rateTimeline ?? [];
    expect(proTimeline).toHaveLength(1);
    expect(proTimeline[0]?.effectiveFrom).toBeUndefined();
    expect(proTimeline[0]?.pricing).toMatchObject({input: 9, output: 27, cachedInput: 0.3});
    expect(proTimeline[0]?.priceSchedules?.[0]?.rates).toEqual({input: 4.5, output: 13.5, cachedInput: 0.15});
    expect(proTimeline[0]?.changeNote).toBeTruthy();

    // 全部 18 个官方预设与源码注册表一一对齐（presets[]；2026-09-29 新增腾讯 TokenHub 按量+套餐双通道）。
    const presetKeys = Object.values(catalog.providers).flatMap(provider => (provider.presets ?? []).map(preset => preset.presetKey));
    expect(presetKeys).toHaveLength(18);
  });

  test("目录支持视频/语音/非 Token usage schema，自动模型白名单仍只选择 chat", () => {
    const parsed = parseProviderCatalogText([
      JSON.stringify({
        schemaVersion: 2,
        catalogRevision: "2026.10.04.01",
        publishedAt: "2026-10-04T00:00:00+08:00",
      }),
      JSON.stringify({
        catalogKey: "demo",
        name: "Demo",
        brandId: "demo",
        pricingProviderId: "demo",
        region: "cn",
        category: "official",
        models: [
          {id: "chat", category: "chat", pricing: {input: 1, output: 2}},
          {
            id: "video",
            category: "video",
            usageSchema: {currency: "CNY", fields: {seconds: {unit: "second", price: 0.5}}},
          },
          {
            id: "speech",
            category: "audio",
            usageSchema: {currency: "CNY", fields: {characters: {unit: "character", price: 2}}},
          },
        ],
      }),
    ].join("\n"));
    const provider = parsed.catalog.providers.demo!;
    expect(provider.models.find(model => model.id === "video")?.usageSchema?.fields.seconds.unit).toBe("second");
    expect(provider.models.find(model => model.id === "speech")?.category).toBe("audio");
    expect(listAutomaticWhitelistCandidates(provider).map(model => model.id)).toEqual(["chat"]);
  });
});
