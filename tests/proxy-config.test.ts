import {mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "vitest";
import {
  buildLocalProxyBaseUrl,
  buildUpstreamRequestUrl,
  ProxyConfigStore,
  routeIdFromUpstreamUrl,
} from "../src/proxy-config.js";
import {
  assertTargetPatchPricing,
  normalizeProxyConfigUpdate,
  reconcileOfficialTargetPatchPricing,
  refreshCustomTargetModelWireApis,
} from "../src/app/api/proxy-config/route.js";
import {writePricingConfig} from "../src/lib/pricing.js";
import {
  deriveRouteIdCandidates,
  registrableRouteIdFromUpstreamUrl,
  registrableTokenRouteIdFromUpstreamUrl,
  resolveDerivedRouteId,
  shortRouteIdFromUpstreamUrl,
  subdomainRouteIdFromUpstreamUrl,
} from "../src/lib/proxy-url.js";
import type {ProxyTarget} from "../src/types.js";
import type {ProxyConfigUpdate} from "../src/proxy-config.js";

test("上游 URL 拼接去重重复的 v1 路径段", () => {
  expect(buildUpstreamRequestUrl("https://api.openai.com", "/v1/chat/completions", "?x=1"))
    .toBe("https://api.openai.com/v1/chat/completions?x=1");
  expect(buildUpstreamRequestUrl("https://proxy.example.com/v1", "/v1/responses"))
    .toBe("https://proxy.example.com/v1/responses");
  expect(buildUpstreamRequestUrl("https://proxy.example.com/anthropic/", "/v1/messages"))
    .toBe("https://proxy.example.com/anthropic/v1/messages");
});

test("launchPreferences 读取归一化丢弃复合键规范前的裸模型 ID 死键（2026-10-06）", async () => {
  const root = await mkdtemp(join(tmpdir(), "proxy-config-legacy-prefs-"));
  const configPath = join(root, "proxy-config.json");
  await writeFile(configPath, JSON.stringify({
    version: 3,
    revision: 1,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    updatedAt: "2026-10-06T00:00:00.000Z",
    agentConnections: {
      zcode: {
        enabled: true,
        cliSyncEnabled: true,
        launchPreferences: {
          reasoningEffort: "max",
          // 裸键为 2026-10-03 复合键规范前的旧格式：适配器按
          // <模型ID>_<路由ID> 复合键查找，裸键永不命中，读取时即丢弃。
          contextWindows: {
            "glm-5.3-flash": 1048576,
            "glm-5.3-flash_bigmodel.cn-api-coding-paas-v4": 1048576,
          },
        },
      },
    },
    targets: [],
  }));
  const store = new ProxyConfigStore({
    configPath,
    developmentCredentialsPath: join(root, "development-credentials.json"),
  });
  await store.init();
  expect(store.getConfig().agentConnections.zcode?.launchPreferences).toEqual({
    reasoningEffort: "max",
    contextWindows: {"glm-5.3-flash_bigmodel.cn-api-coding-paas-v4": 1048576},
  });
});

test("默认代理配置路径复用统一数据目录解析器", async () => {
  const source = await readFile(new URL("../src/proxy-config.ts", import.meta.url), "utf8");
  expect(source).toContain("resolveDeepaaDataDir()");
  expect(source).not.toContain('join(process.cwd(), "data", "proxy-config.json")');
});

test("代理配置写接口使用同源 nonce、有界 JSON 和价格映射服务端校验", async () => {
  const source = await readFile(new URL("../src/app/api/proxy-config/route.ts", import.meta.url), "utf8");
  expect(source).toContain("assertLocalMutationRequest(request)");
  expect(source).toContain("readBoundedJson(request)");
  expect(source).toContain("requireLaunchNonce(body)");
  expect(source).toContain("assertProxyTargetPriceMappings");
  expect(source).not.toContain("request.json()");
});

test("仅停用代理目标时跳过历史价格映射校验，重新启用仍严格校验", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "proxy-config-disable-pricing-"));
  const current = target({
    id: "deepseek",
    supportedModels: ["deepseek-v4-flash"],
    pricing: {rateMultiplier: 1},
  });

  await expect(assertTargetPatchPricing({
    targetPatch: {id: "deepseek", target: {enabled: false}},
  }, [current], dataDir)).resolves.toBeUndefined();

  await expect(assertTargetPatchPricing({
    targetPatch: {id: "deepseek", target: {enabled: true}},
  }, [current], dataDir)).rejects.toThrow("MODEL_PRICE_MAPPING_REQUIRED");
});

test("官方目标保存时按供应商与运行时模型自动补齐缺失价格映射", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "proxy-config-official-pricing-reconcile-"));
  await writePricingConfig(dataDir, {
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [{
      id: "existing-deepseek-flash",
      // 2026-09-29 中国区 vendor 改名：目录条目 vendor 已迁往 deepseek-cn。
      vendor: "deepseek-cn",
      runtimeModelId: "deepseek-v4-flash",
      patterns: ["deepseek-v4-flash"],
      pricing: {input: 1, output: 2},
      confidence: "official",
    }],
  });
  const current = target({
    id: "deepseek",
    openaiUrl: "https://api.deepseek.com",
    supportedModels: ["deepseek-v4-flash"],
    pricing: {rateMultiplier: 1},
  });
  const update = {
    targetPatch: {id: "deepseek", target: {enabled: true}},
  };

  await reconcileOfficialTargetPatchPricing(update, [current], dataDir);

  expect(update.targetPatch.target).toMatchObject({
    enabled: true,
    presetId: "deepseek",
    pricing: {
      vendor: "deepseek-cn",
      modelVendors: {
        "deepseek-v4-flash": {vendor: "deepseek-cn", priceEntryId: "existing-deepseek-flash"},
      },
    },
  });
  await expect(assertTargetPatchPricing(update, [current], dataDir)).resolves.toBeUndefined();
});

test("代理配置写接口逐字段收窄 Agent 接入补丁", () => {
  expect(normalizeProxyConfigUpdate({
    nonce: "nonce",
    expectedRevision: 2,
    agentConnectionPatch: {
      agent: "codex",
      action: "connect",
      boundTargetIds: ["target-a"],
      defaultTargetId: "",
      defaultModelId: "gpt-5.6",
      defaultCredentialId: "cred-primary",
      cliSyncEnabled: true,
    },
  })).toEqual({
    expectedRevision: 2,
    agentConnectionPatch: {
      agent: "codex",
      action: "connect",
      boundTargetIds: ["target-a"],
      defaultTargetId: "",
      defaultModelId: "gpt-5.6",
      defaultCredentialId: "cred-primary",
      cliSyncEnabled: true,
    },
  });

  expect(() => normalizeProxyConfigUpdate({
    nonce: "nonce",
    expectedRevision: 2,
    agentConnectionPatch: {
      agent: "codex",
      action: "connect",
      boundTargetIds: ["target-a", 7],
    },
  })).toThrow("INVALID_REQUEST");
  expect(() => normalizeProxyConfigUpdate({
    nonce: "nonce",
    expectedRevision: 2,
    agentConnectionPatch: {
      agent: "codex",
      action: "disconnect",
      unexpected: true,
    },
  })).toThrow("INVALID_REQUEST");
});

test("首次接入 Agent 且未有默认目标时自动把本次绑定目标设为默认，已有默认目标不覆盖", async () => {
  const store = await emptyStore("proxy-config-auto-default-target-");
  await store.updateConfig({targetPatch: {target: target({id: "first", openaiUrl: "https://first.example/v1"})}});
  const first = await store.updateConfig({agentConnectionPatch: {
    agent: "codex", action: "connect", boundTargetIds: ["first"], cliSyncEnabled: true,
  }});
  expect(first.agentConnections.codex?.defaultTargetId).toBe("first");

  await store.updateConfig({targetPatch: {target: target({id: "second", openaiUrl: "https://second.example/v1"})}});
  const second = await store.updateConfig({agentConnectionPatch: {
    agent: "codex", action: "connect", boundTargetIds: ["second"], cliSyncEnabled: true,
  }});
  expect(second.agentConnections.codex?.defaultTargetId).toBe("first");
  expect(second.agentConnections.codex?.boundTargetIds).toEqual(["first", "second"]);
});

test("路由 ID 与本地基础 URL 派生保持稳定", () => {
  expect(routeIdFromUpstreamUrl("https://api.anthropic.com/v1")).toBe("api.anthropic.com-v1");
  expect(routeIdFromUpstreamUrl("http://localhost:8080/v1")).toBe("localhost.8080-v1");
  expect(buildLocalProxyBaseUrl("http://localhost:3211", "api.deepseek.com"))
    .toBe("http://localhost:3211/api.deepseek.com");
});

test("短格式路由 ID 剥离域名首段标签，两段域名与公共后缀不剥离；IP 主机不剥", () => {
  expect(shortRouteIdFromUpstreamUrl("https://open.bigmodel.cn/api/paas/v4")).toBe("bigmodel.cn-api-paas-v4");
  expect(shortRouteIdFromUpstreamUrl("https://api.z.ai/api/coding/paas/v4")).toBe("z.ai-api-coding-paas-v4");
  expect(shortRouteIdFromUpstreamUrl("https://api.deepseek.com")).toBe("deepseek.com");
  // 两段域名（z.ai）与单机名保持原样；端口规则沿用。
  expect(shortRouteIdFromUpstreamUrl("https://z.ai/api/paas/v4")).toBe("z.ai-api-paas-v4");
  expect(shortRouteIdFromUpstreamUrl("http://localhost:8080/v1")).toBe("localhost.8080-v1");
  // 剥离到可注册域名（gateway.com.cn）合法；
  // 但剥离后只剩裸公共后缀（com.cn）时不剥。
  expect(shortRouteIdFromUpstreamUrl("https://api.gateway.com.cn")).toBe("gateway.com.cn");
  expect(shortRouteIdFromUpstreamUrl("https://api.com.cn/v1")).toBe("api.com.cn-v1");
  // IP 字面量没有「首段标签」概念，盲剥会把 10.0.0.5 毁成 0.0.5，必须原样保留。
  expect(shortRouteIdFromUpstreamUrl("http://10.0.0.5:8787/v1")).toBe("10.0.0.5.8787-v1");
});

test("L0 注册主域候选：主域优先、两段公共后缀取末三段、IP 与端口规则", () => {
  expect(registrableRouteIdFromUpstreamUrl("https://open.bigmodel.cn/api/paas/v4")).toBe("bigmodel.cn");
  expect(registrableRouteIdFromUpstreamUrl("https://ark.cn-beijing.volces.com/api/plan/v3")).toBe("volces.com");
  expect(registrableRouteIdFromUpstreamUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("aliyuncs.com");
  expect(registrableRouteIdFromUpstreamUrl("https://chatgpt.com/backend-api/codex")).toBe("chatgpt.com");
  expect(registrableRouteIdFromUpstreamUrl("https://api.z.ai")).toBe("z.ai");
  expect(registrableRouteIdFromUpstreamUrl("https://api.gateway.com.cn")).toBe("gateway.com.cn");
  expect(registrableRouteIdFromUpstreamUrl("http://localhost:8080/v1")).toBe("localhost.8080");
  expect(registrableRouteIdFromUpstreamUrl("http://10.0.0.5:8787/v1")).toBe("10.0.0.5.8787");
});

test("L1 主域+path 首个有效词：滤 api/apps/openai 与版本段", () => {
  // 智谱双通道：裸主域被占后由 paas/coding 区分，不再拖完整 path。
  expect(registrableTokenRouteIdFromUpstreamUrl("https://open.bigmodel.cn/api/paas/v4")).toBe("bigmodel.cn-paas");
  expect(registrableTokenRouteIdFromUpstreamUrl("https://open.bigmodel.cn/api/coding/paas/v4")).toBe("bigmodel.cn-coding");
  expect(registrableTokenRouteIdFromUpstreamUrl("https://ark.cn-beijing.volces.com/api/coding/v3")).toBe("volces.com-coding");
  // 噪音段与版本段不参与：/v1、/api/v1 无有效词时退回 L0。
  expect(registrableTokenRouteIdFromUpstreamUrl("https://api.minimaxi.com/v1")).toBe("minimaxi.com");
  expect(registrableTokenRouteIdFromUpstreamUrl("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
  // apps 属端点骨架词：百炼 Coding Plan 的有效词是 anthropic 而非 apps。
  expect(registrableTokenRouteIdFromUpstreamUrl("https://dashscope.aliyuncs.com/apps/anthropic")).toBe("aliyuncs.com-anthropic");
});

test("L1b 有效子域候选：滤平台噪音词，区分同主域不同子域", () => {
  expect(subdomainRouteIdFromUpstreamUrl("https://dashscope.aliyuncs.com/v1")).toBe("dashscope-aliyuncs.com");
  expect(subdomainRouteIdFromUpstreamUrl("https://coding.dashscope.aliyuncs.com/v1")).toBe("coding-dashscope-aliyuncs.com");
  // api/open 等平台前缀是噪音：剥除后退回注册主域，不制造 open-bigmodel.cn 这类无意义长度。
  expect(subdomainRouteIdFromUpstreamUrl("https://open.bigmodel.cn/api/paas/v4")).toBe("bigmodel.cn");
  expect(subdomainRouteIdFromUpstreamUrl("https://api.deepseek.com")).toBe("deepseek.com");
  // 同主域不同子域的自定义中转靠子域区分。
  expect(subdomainRouteIdFromUpstreamUrl("https://a.example.com/v1")).toBe("a-example.com");
  expect(subdomainRouteIdFromUpstreamUrl("https://b.example.com/v1")).toBe("b-example.com");
  // IP 与两段域名无子域概念，退回 L0。
  expect(subdomainRouteIdFromUpstreamUrl("http://10.0.0.5:8787/v1")).toBe("10.0.0.5.8787");
  expect(subdomainRouteIdFromUpstreamUrl("https://z.ai/api/paas/v4")).toBe("z.ai");
});

test("路由 ID 候选链按 主域 → 主域+词 → 子域 → 短格式 → 全格式 排序去重", () => {
  expect(deriveRouteIdCandidates(
    "https://open.bigmodel.cn/api/paas/v4",
    "https://open.bigmodel.cn/api/anthropic",
  )).toEqual([
    "bigmodel.cn",
    "bigmodel.cn-paas",
    "bigmodel.cn-anthropic",
    "bigmodel.cn-api-paas-v4",
    "bigmodel.cn-api-anthropic",
    "open.bigmodel.cn-api-paas-v4",
    "open.bigmodel.cn-api-anthropic",
  ]);
  // 未配置 Anthropic 时跳过该来源；单来源候选即 主域 → 全格式。
  expect(deriveRouteIdCandidates("https://api.deepseek.com", undefined))
    .toEqual(["deepseek.com", "api.deepseek.com"]);
  // 同一供应商两个协议 URL 相同时候选去重。
  expect(deriveRouteIdCandidates("https://api.deepseek.com", "https://api.deepseek.com"))
    .toEqual(["deepseek.com", "api.deepseek.com"]);
  // 非法 URL 不产生候选。
  expect(deriveRouteIdCandidates("not-a-url", undefined)).toEqual([]);
});

test("resolveDerivedRouteId 按全局占用取第一个可用候选，冲突携带原因", () => {
  const urls = {openai: "https://open.bigmodel.cn/api/paas/v4", anthropic: "https://open.bigmodel.cn/api/anthropic"};
  // 全局无占用：直接采用注册主域（模型串形如 glm-5.3_bigmodel.cn）。
  expect(resolveDerivedRouteId(urls.openai, urls.anthropic, [])).toEqual({
    status: "resolved",
    id: "bigmodel.cn",
  });
  // 主域被占：逐层回退（智谱同域双通道场景）。
  expect(resolveDerivedRouteId(urls.openai, urls.anthropic, [
    {id: "bigmodel.cn"},
  ])).toEqual({status: "resolved", id: "bigmodel.cn-paas"});
  // 全部候选用尽：conflict/candidates_exhausted，由调用方引导手动修改。
  expect(resolveDerivedRouteId(urls.openai, urls.anthropic, [
    {id: "bigmodel.cn"},
    {id: "bigmodel.cn-paas"},
    {id: "bigmodel.cn-anthropic"},
    {id: "bigmodel.cn-api-paas-v4"},
    {id: "bigmodel.cn-api-anthropic"},
    {id: "open.bigmodel.cn-api-paas-v4"},
    {id: "open.bigmodel.cn-api-anthropic"},
  ])).toEqual({status: "conflict", reason: "candidates_exhausted"});
  // 无任何合法上游 URL：unavailable。
  expect(resolveDerivedRouteId(undefined, undefined, [])).toEqual({status: "unavailable"});
});

test("同 URL 对无法自动区分：直接 conflict 并跳过整条候选链（2026-09-20 用户确认）", () => {
  // MiniMax 按量与 Token Plan 共用两个端点：URL 本身不携带区分信息，
  // 自动补 -plan 之类的后缀无从判断先后与归属，宁可让用户手动加区分词。
  const minimaxUrls = {openai: "https://api.minimaxi.com/v1", anthropic: "https://api.minimaxi.com/anthropic"};
  expect(resolveDerivedRouteId(minimaxUrls.openai, minimaxUrls.anthropic, [
    {id: "minimaxi.com", openaiUrl: minimaxUrls.openai, anthropicUrl: minimaxUrls.anthropic},
  ])).toEqual({status: "conflict", reason: "identical_upstream_urls"});
  // 即使占用方 ID 与候选链毫无交集，也不允许靠协议顺序遗留候选（如 -anthropic）逃逸。
  expect(resolveDerivedRouteId(minimaxUrls.openai, minimaxUrls.anthropic, [
    {id: "unrelated", openaiUrl: minimaxUrls.openai, anthropicUrl: minimaxUrls.anthropic},
  ])).toEqual({status: "conflict", reason: "identical_upstream_urls"});
  // URL 归一化后一致（尾斜杠差异）同样视为同 URL 对。
  expect(resolveDerivedRouteId(minimaxUrls.openai, `${minimaxUrls.anthropic}/`, [
    {id: "minimaxi.com", openaiUrl: `${minimaxUrls.openai}/`, anthropicUrl: minimaxUrls.anthropic},
  ])).toEqual({status: "conflict", reason: "identical_upstream_urls"});
  // 仅共享单个协议位置（智谱双通道共享 anthropicUrl）不触发：由 L1 path 词正常区分。
  expect(resolveDerivedRouteId(
    "https://open.bigmodel.cn/api/coding/paas/v4",
    "https://open.bigmodel.cn/api/anthropic",
    [{id: "bigmodel.cn", openaiUrl: "https://open.bigmodel.cn/api/paas/v4", anthropicUrl: "https://open.bigmodel.cn/api/anthropic"}],
  )).toEqual({status: "resolved", id: "bigmodel.cn-coding"});
  // 占用方缺失 URL（仅显式 ID 预种）不参与同 URL 对判定，只做 ID 判重。
  expect(resolveDerivedRouteId(minimaxUrls.openai, minimaxUrls.anthropic, [{id: "minimaxi.com"}]))
    .toEqual({status: "resolved", id: "minimaxi.com-anthropic"});
});

test("官方预设全量创建的路由 ID 回归表（主域优先五层链，2026-09-20 用户确认）", () => {
  // MANUAL = 同 URL 对：无法自动区分，需要用户手动填写区分词（如 minimaxi.com-plan）。
  const presets: Array<[string, string | undefined, string | undefined, string]> = [
    ["deepseek", "https://api.deepseek.com", "https://api.deepseek.com/anthropic", "deepseek.com"],
    ["zhipu-cn", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/anthropic", "bigmodel.cn"],
    ["zhipu-coding-plan", "https://open.bigmodel.cn/api/coding/paas/v4", "https://open.bigmodel.cn/api/anthropic", "bigmodel.cn-coding"],
    ["moonshot-cn", "https://api.moonshot.cn/v1", "https://api.moonshot.cn/anthropic", "moonshot.cn"],
    ["kimi-coding", "https://api.kimi.com/coding/v1", "https://api.kimi.com/coding/", "kimi.com"],
    ["minimax-cn", "https://api.minimaxi.com/v1", "https://api.minimaxi.com/anthropic", "minimaxi.com"],
    ["minimax-plan", "https://api.minimaxi.com/v1", "https://api.minimaxi.com/anthropic", "MANUAL"],
    ["volcengine-plan", "https://ark.cn-beijing.volces.com/api/plan/v3", "https://ark.cn-beijing.volces.com/api/plan", "volces.com"],
    ["volcengine-coding-plan", "https://ark.cn-beijing.volces.com/api/coding/v3", "https://ark.cn-beijing.volces.com/api/coding", "volces.com-coding"],
    ["qwenai", "https://maas.qianwenaiapi.com/compatible-mode/v1", "https://maas.qianwenaiapi.com/apps/anthropic", "qianwenaiapi.com"],
    ["qwenai-token-plan", "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1", "https://token-plan.maas.qianwenaiapi.com/apps/anthropic", "qianwenaiapi.com-compatible-mode"],
    ["tencent-tokenhub", "https://api.lkeap.cloud.tencent.com/v1", undefined, "tencent.com"],
    ["tencent-tokenhub-plan", "https://api.lkeap.cloud.tencent.com/plan/v3", "https://api.lkeap.cloud.tencent.com/plan/anthropic", "tencent.com-plan"],
    ["openrouter", "https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1", "openrouter.ai"],
    ["siliconflow", "https://api.siliconflow.cn/v1", "https://api.siliconflow.cn/v1", "siliconflow.cn"],
    ["opencode-go", "https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1", "opencode.ai"],
    ["openai-subscription", "https://chatgpt.com/backend-api/codex", undefined, "chatgpt.com"],
    ["anthropic-subscription", undefined, "https://api.anthropic.com", "anthropic.com"],
  ];
  const created: Array<{id: string; openaiUrl?: string; anthropicUrl?: string}> = [];
  for (const [name, openaiUrl, anthropicUrl, expected] of presets) {
    const resolution = resolveDerivedRouteId(openaiUrl, anthropicUrl, created);
    if (expected === "MANUAL") {
      expect(resolution, name).toEqual({status: "conflict", reason: "identical_upstream_urls"});
      continue;
    }
    expect(resolution, name).toEqual({status: "resolved", id: expected});
    if (resolution.status !== "resolved") continue;
    // 路由 ID 字符集红线：小写字母数字点连字符、绝不含下划线（网关按最后一个下划线切分）。
    expect(expected).toMatch(/^[a-z0-9.-]+$/);
    created.push({id: resolution.id, openaiUrl, anthropicUrl});
  }
});

test("配置重载：同 URL 对空 ID 兜底为全格式，显式 ID 前向阻塞自动派生", async () => {
  // 合法入口（向导/预设创建）已按同 URL 对硬拦截并引导手动填写；
  // 手工编辑配置的防御路径自愈为冗长但诚实的全格式 ID，保持配置可加载。
  const selfHealRoot = await mkdtemp(join(tmpdir(), "route-id-selfheal-"));
  const selfHealPath = join(selfHealRoot, "proxy-config.json");
  await writeFile(selfHealPath, JSON.stringify({
    version: 3,
    revision: 1,
    targets: [
      {id: "", name: "MiniMax 按量", openaiUrl: "https://api.minimaxi.com/v1", anthropicUrl: "https://api.minimaxi.com/anthropic"},
      {id: "", name: "MiniMax Token Plan", billingChannel: "plan", openaiUrl: "https://api.minimaxi.com/v1", anthropicUrl: "https://api.minimaxi.com/anthropic"},
    ],
  }), "utf8");
  const selfHealStore = new ProxyConfigStore({configPath: selfHealPath});
  await selfHealStore.init();
  const [payg, plan] = selfHealStore.getConfig().targets;
  expect(payg.id).toBe("minimaxi.com");
  expect(plan.id).toBe("api.minimaxi.com-v1");

  // 后声明的显式 ID 同样阻塞前面目标的自动派生，避免保存期撞名。
  const forwardRoot = await mkdtemp(join(tmpdir(), "route-id-forward-"));
  const forwardPath = join(forwardRoot, "proxy-config.json");
  await writeFile(forwardPath, JSON.stringify({
    version: 3,
    revision: 1,
    targets: [
      {id: "", name: "A", openaiUrl: "https://x.example.com/v1"},
      {id: "example.com", name: "B", openaiUrl: "https://other.example.net/v1"},
    ],
  }), "utf8");
  const forwardStore = new ProxyConfigStore({configPath: forwardPath});
  await forwardStore.init();
  const [first, second] = forwardStore.getConfig().targets;
  expect(first.id).toBe("x-example.com");
  expect(second.id).toBe("example.com");
});

test("V3 目标、双协议 URL 和 revision 原子持久化并可跨进程 reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "proxy-config-v3-reload-"));
  const configPath = join(root, "proxy-config.json");
  const proxyProcess = new ProxyConfigStore({configPath, localProxyBaseUrl: "http://127.0.0.1:3211"});
  const uiProcess = new ProxyConfigStore({configPath});
  await proxyProcess.init();
  await uiProcess.init();

  const saved = await uiProcess.updateConfig({
    expectedRevision: 1,
    targetPatch: {target: target({
      id: "provider.example",
      openaiUrl: "https://provider.example/openai/v1",
      anthropicUrl: "https://provider.example/anthropic/v1",
    })},
  });
  expect(saved.revision).toBe(2);
  expect(proxyProcess.getConfig().targets).toEqual([]);
  await proxyProcess.reload();
  expect(proxyProcess.getConfig()).toMatchObject({
    version: 3,
    revision: 2,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    targets: [{
      id: "provider.example",
      openaiUrl: "https://provider.example/openai/v1",
      anthropicUrl: "https://provider.example/anthropic/v1",
    }],
  });
  expect((await readdir(root)).filter(name => name.includes(".tmp-"))).toEqual([]);
});

test("不可读配置失败关闭且不覆盖原文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "proxy-config-invalid-"));
  const configPath = join(root, "proxy-config.json");
  await writeFile(configPath, "{ invalid json", "utf8");
  const store = new ProxyConfigStore({configPath});
  await expect(store.init()).rejects.toThrow();
  expect(await readFile(configPath, "utf8")).toBe("{ invalid json");
});

test("目标必须有协议 URL，路由 ID 不允许下划线", async () => {
  const store = await emptyStore("proxy-config-validation-");
  await expect(store.updateConfig({targetPatch: {target: {
    id: "missing-url",
    name: "Missing URL",
    enabled: false,
    supportedModels: [],
  }}})).rejects.toThrow("requires at least one protocol URL");
  await expect(store.updateConfig({targetPatch: {target: target({id: "bad_id"})}}))
    .rejects.toThrow();
});

test("目标 ID 与协议 URL 必须唯一", async () => {
  const store = await emptyStore("proxy-config-unique-");
  await store.updateConfig({targets: [
    target({id: "one", openaiUrl: "https://one.example/v1"}),
    target({id: "two", openaiUrl: "https://two.example/v1"}),
  ]});
  await expect(store.updateConfig({targets: [
    target({id: "one", openaiUrl: "https://one.example/v1"}),
    target({id: "one", openaiUrl: "https://other.example/v1"}),
  ]})).rejects.toThrow("Duplicate proxy target id");
  await expect(store.updateConfig({targetPatch: {id: "two", target: {openaiUrl: "https://one.example/v1/"}}}))
    .rejects.toThrow("Duplicate proxy target baseUrl");
});

test("同一目标的 OpenAI 与 Anthropic URL 相同是合法的，跨目标重复仍拒绝", async () => {
  const store = await emptyStore("proxy-config-dual-url-");
  // 同一目标：openai 与 anthropic 相同 URL 允许（协议由请求路径区分）。
  await expect(store.updateConfig({targets: [
    target({id: "dual", openaiUrl: "https://api.dmapi.xyz", anthropicUrl: "https://api.dmapi.xyz"}),
  ]})).resolves.toBeDefined();
  // 跨目标：其它目标的任一协议 URL 与之重复仍拒绝。
  await expect(store.updateConfig({targetPatch: {target: target({id: "other", openaiUrl: "https://api.dmapi.xyz"})}}))
    .rejects.toThrow("Duplicate proxy target baseUrl");
});

test("价格倍率、套餐月费、唯一价格条目映射和模型覆盖 round-trip 保留", async () => {
  const store = await emptyStore("proxy-config-pricing-");
  await store.updateConfig({targetPatch: {target: target({
    id: "oneapi",
    supportedModels: ["openai/gpt-5.5"],
    pricing: {
      vendor: "openai",
            planMonthlyFee: 199,
      modelVendors: {"openai/gpt-5.5": {vendor: "openai", priceEntryId: "openai/gpt-5.5"}},
      modelOverrides: [{
        id: "oneapi-gpt-5.5",
        targetModelId: "openai/gpt-5.5",
        pricing: {input: 5, cachedInput: 1, cacheWrite: 6, output: 20, reasoning: 2},
        confidence: "user_override",
      }],
    },
  })}});
  const saved = store.getConfig().targets[0]!;
  expect(saved.pricing).toMatchObject({
    vendor: "openai",
        planMonthlyFee: 199,
    modelVendors: {"openai/gpt-5.5": {vendor: "openai", priceEntryId: "openai/gpt-5.5"}},
  });
  expect(saved.pricing?.modelOverrides?.[0]).toMatchObject({
    targetModelId: "openai/gpt-5.5",
    pricing: {input: 5, cachedInput: 1, cacheWrite: 6, output: 20, reasoning: 2},
  });
});

test("目标级价格覆盖按 targetId + targetModelId 原子保存和取消，不影响映射", async () => {
  const store = await emptyStore("proxy-config-target-override-atomic-");
  await store.updateConfig({targetPatch: {target: target({
    id: "modelport",
    supportedModels: ["gpt-x", "claude-x"],
    pricing: {
      modelVendors: {
        "gpt-x": {vendor: "openai", priceEntryId: "openai:gpt-x"},
        "claude-x": {vendor: "anthropic", priceEntryId: "anthropic:claude-x"},
      },
    },
  })}});
  const before = store.getConfig();
  const updated = await store.updateConfig({
    expectedRevision: before.revision,
    targetPricingOverride: {
      action: "upsert",
      targetId: "modelport",
      targetModelId: "gpt-x",
      pricing: {input: 9, output: 45},
    },
  });
  expect(updated.targets[0]?.pricing?.modelOverrides).toMatchObject([{
    targetModelId: "gpt-x",
    pricing: {input: 9, output: 45},
  }]);
  expect(updated.targets[0]?.pricing?.modelVendors?.["gpt-x"]).toEqual({
    vendor: "openai",
    priceEntryId: "openai:gpt-x",
  });

  const removed = await store.updateConfig({
    expectedRevision: updated.revision,
    targetPricingOverride: {
      action: "remove",
      targetId: "modelport",
      targetModelId: "gpt-x",
    },
  });
  expect(removed.targets[0]?.pricing?.modelOverrides).toBeUndefined();
  expect(removed.targets[0]?.pricing?.modelVendors?.["claude-x"]).toEqual({
    vendor: "anthropic",
    priceEntryId: "anthropic:claude-x",
  });
});

test("目标级覆盖 API 载荷只接受 targetId + targetModelId 精确键", () => {
  const normalized = normalizeProxyConfigUpdate({
    expectedRevision: 1,
    targetPricingOverride: {
      action: "upsert",
      targetId: "modelport",
      targetModelId: "gpt-x",
      pricing: {input: 1, output: 2},
    },
  });
  expect(normalized.targetPricingOverride).toMatchObject({
    action: "upsert",
    targetId: "modelport",
    targetModelId: "gpt-x",
  });
  expect(() => normalizeProxyConfigUpdate({
    expectedRevision: 1,
    targetPricingOverride: {
      action: "upsert",
      targetId: "modelport",
      modelId: "gpt-x",
      pricing: {input: 1, output: 2},
    },
  })).toThrow("INVALID_REQUEST");
});

test("套餐档位 planTier round-trip 保留，非法值剔除（2026-09-30 OpenCode Go 档位链路守护）", async () => {
  const store = await emptyStore("proxy-config-plan-tier-");
  await store.updateConfig({targetPatch: {target: target({
    id: "opencode-test",
    openaiUrl: "https://opencode.ai/zen/go/v1",
    pricing: {planTier: "go-plus"},
  })}});
  const saved = store.getConfig().targets[0]!;
  expect(saved.pricing?.planTier).toBe("go-plus");

  // 保存后再更新其它字段：档位不得被归一化剥除。
  await store.updateConfig({targetPatch: {id: "opencode-test", target: {id: "opencode-test", name: "OpenCode"}}});
  expect(store.getConfig().targets[0]!.pricing?.planTier).toBe("go-plus");

  // 非法值（大写/下划线/空串/过长）剔除；undefined 显式移除。
  await store.updateConfig({targetPatch: {target: target({
    id: "tier-bad",
    openaiUrl: "https://tier-bad.example/v1",
    pricing: {planTier: "Go_Plus!" as unknown as string},
  })}});
  expect(store.getConfig().targets.find(item => item.id === "tier-bad")!.pricing?.planTier).toBeUndefined();
  await store.updateConfig({targetPatch: {id: "opencode-test", target: {id: "opencode-test", pricing: {planTier: undefined}}}});
  expect(store.getConfig().targets[0]!.pricing?.planTier).toBeUndefined();
});

test("套餐付款周期 planBillingCycle round-trip 保留，非法值剔除（2026-10-10 档位×周期取价链路守护）", async () => {
  const store = await emptyStore("proxy-config-plan-cycle-");
  await store.updateConfig({targetPatch: {target: target({
    id: "zhipu-test",
    openaiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    pricing: {planTier: "pro", planBillingCycle: "quarterly", planMonthlyFee: 430.4},
  })}});
  const saved = store.getConfig().targets[0]!;
  expect(saved.pricing?.planBillingCycle).toBe("quarterly");
  expect(saved.pricing?.planTier).toBe("pro");

  // 保存后再更新其它字段：周期不得被归一化剥除。
  await store.updateConfig({targetPatch: {id: "zhipu-test", target: {id: "zhipu-test", name: "智谱套餐"}}});
  expect(store.getConfig().targets[0]!.pricing?.planBillingCycle).toBe("quarterly");

  // 非法值（weekly/数字/空串）剔除；undefined 显式移除。
  await store.updateConfig({targetPatch: {target: target({
    id: "cycle-bad",
    openaiUrl: "https://cycle-bad.example/v1",
    pricing: {planBillingCycle: "weekly" as unknown as "monthly"},
  })}});
  expect(store.getConfig().targets.find(item => item.id === "cycle-bad")!.pricing?.planBillingCycle).toBeUndefined();
  await store.updateConfig({targetPatch: {id: "zhipu-test", target: {id: "zhipu-test", pricing: {planBillingCycle: undefined}}}});
  expect(store.getConfig().targets[0]!.pricing?.planBillingCycle).toBeUndefined();
});

test("结算字段（settlementCurrency/settlementFx）round-trip 保留，非法值剔除（2026-09-15 断链修复回归）", async () => {
  const store = await emptyStore("proxy-config-settlement-");
  await store.updateConfig({targetPatch: {target: target({
    id: "relay-usd",
    pricing: {
      settlementCurrency: "USD",
      settlementFx: 7.1,
    },
  })}});
  const saved = store.getConfig().targets[0]!;
  expect(saved.pricing?.settlementCurrency).toBe("USD");
  expect(saved.pricing?.settlementFx).toBe(7.1);

  // 保存后再更新其它字段：结算字段不得被归一化剥除（历史缺陷）。
  await store.updateConfig({targetPatch: {id: "relay-usd", target: {id: "relay-usd", name: "Relay USD"}}});
  expect(store.getConfig().targets[0]!.pricing?.settlementFx).toBe(7.1);

  // 显式覆盖为新的系数值。
  await store.updateConfig({targetPatch: {id: "relay-usd", target: {id: "relay-usd", pricing: {settlementFx: 1}}}});
  expect(store.getConfig().targets[0]!.pricing?.settlementFx).toBe(1);
  // 置 undefined 表示移除显式覆盖，回到默认规则。
  await store.updateConfig({targetPatch: {id: "relay-usd", target: {id: "relay-usd", pricing: {settlementFx: undefined}}}});
  expect(store.getConfig().targets[0]!.pricing?.settlementFx).toBeUndefined();

  // 非法值：币种枚举外、系数非正数——全部剔除。
  await store.updateConfig({targetPatch: {target: target({
    id: "relay-bad",
    openaiUrl: "https://relay-bad.example/v1",
    pricing: {
      settlementCurrency: "EUR" as unknown as "USD",
      settlementFx: -1,
    },
  })}});
  const bad = store.getConfig().targets.find(item => item.id === "relay-bad")!;
  expect(bad.pricing?.settlementCurrency).toBeUndefined();
  expect(bad.pricing?.settlementFx).toBeUndefined();
});

test("套餐月费拒绝负数与非有限值", async () => {
  const store = await emptyStore("proxy-config-plan-fee-");
  await store.updateConfig({targetPatch: {target: target({
    id: "plan-fee",
    pricing: {rateMultiplier: 1, planMonthlyFee: -1},
  })}});
  expect(store.getConfig().targets[0]?.pricing?.planMonthlyFee).toBeUndefined();
  await store.updateConfig({targetPatch: {id: "plan-fee", target: {
    pricing: {rateMultiplier: 1, planMonthlyFee: Number.POSITIVE_INFINITY},
  }}});
  expect(store.getConfig().targets[0]?.pricing?.planMonthlyFee).toBeUndefined();
});

test("targetPatch 只修改指定目标并保留其它目标", async () => {
  const store = await twoTargetStore();
  await store.updateConfig({
    expectedRevision: 2,
    targetPatch: {id: "backup", target: {name: "备用目标-改", enabled: false, pricing: {vendor: "openai"}}},
  });
  expect(store.getConfig().targets).toMatchObject([
    {id: "primary", name: "主目标", enabled: true},
    {id: "backup", name: "备用目标-改", enabled: false, pricing: {vendor: "openai"}},
  ]);
});

test("targetPatch 永久拒绝重命名目标路由 ID", async () => {
  const store = await twoTargetStore();
  await store.updateConfig({agentConnections: {codex: {defaultTargetId: "primary", cliSyncEnabled: false}}});
  await expect(store.updateConfig({targetPatch: {id: "primary", target: {id: "primary-new"}}}))
    .rejects.toThrow("TARGET_ID_IMMUTABLE");
  expect(store.getConfig().targets.map(item => item.id)).toEqual(["primary", "backup"]);
});

test("targetPatch 可新增目标，指定不存在目标时不落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "proxy-config-patch-"));
  const configPath = join(root, "proxy-config.json");
  const store = await twoTargetStore(configPath);
  await store.updateConfig({targetPatch: {target: target({id: "third", openaiUrl: "https://third.example/v1"})}});
  expect(store.getConfig().targets.map(item => item.id)).toEqual(["primary", "backup", "third"]);
  const before = await readFile(configPath, "utf8");
  await expect(store.updateConfig({targetPatch: {id: "ghost", target: {name: "Ghost"}}}))
    .rejects.toThrow("Proxy target not found: ghost");
  expect(await readFile(configPath, "utf8")).toBe(before);
});

test("targetDelete 必须先停用且先清理 Agent 默认引用", async () => {
  const store = await twoTargetStore();
  await store.updateConfig({agentConnections: {codex: {defaultTargetId: "primary", cliSyncEnabled: true}}});
  await store.updateConfig({expectedRevision: 3, targetPatch: {id: "primary", target: {enabled: false}}});
  await expect(store.updateConfig({expectedRevision: 4, targetDelete: {id: "primary"}}))
    .rejects.toThrow("TARGET_DEFAULT_REFERENCE_EXISTS");
  await store.updateConfig({expectedRevision: 4, agentConnectionPatch: {agent: "codex", action: "connect", defaultTargetId: "", cliSyncEnabled: true}});
  const first = await store.updateConfig({expectedRevision: 5, targetDelete: {id: "primary"}});
  expect(first.targets.map(item => item.id)).toEqual(["backup"]);
  expect(first.agentConnections.codex?.defaultTargetId).toBeUndefined();
  await store.updateConfig({expectedRevision: 6, targetPatch: {id: "backup", target: {enabled: false}}});
  const empty = await store.updateConfig({expectedRevision: 7, targetDelete: {id: "backup"}});
  expect(empty.targets).toEqual([]);
  await expect(store.updateConfig({targetDelete: {id: "ghost"}})).rejects.toThrow("Proxy target not found: ghost");
});

test("持久化配置声明的 localProxyBaseUrl 优先于构造器默认值", async () => {
  const root = await mkdtemp(join(tmpdir(), "proxy-config-base-"));
  const configPath = join(root, "proxy-config.json");
  await writeFile(configPath, JSON.stringify({
    version: 3,
    revision: 4,
    agentConnections: {},
    targets: [target({id: "anthropic", openaiUrl: undefined, anthropicUrl: "https://api.anthropic.com"})],
    localProxyBaseUrl: "http://127.0.0.1:3211",
    updatedAt: "2026-08-13T00:00:00.000Z",
  }), "utf8");
  const store = new ProxyConfigStore({configPath});
  await store.init();
  expect(store.getConfig().localProxyBaseUrl).toBe("http://127.0.0.1:3211");
});

test("绑定门禁：boundTargetIds 逐条能力校验，协议不符的目标拒绝绑定（2026-10-06）", async () => {
  const store = await emptyStore("proxy-config-bind-gate-");
  await store.updateConfig({targetPatch: {target: target({
    id: "openai-only",
    supportedModels: ["gpt-5.6"],
    supportedModelScopes: {"gpt-5.6": ["codex", "claude"]},
    supportedModelWireApis: {"gpt-5.6": ["responses", "chat_completions", "messages"]},
    pricing: {rateMultiplier: 1, modelVendors: {"gpt-5.6": {vendor: "test", priceEntryId: "test:gpt-5.6"}}},
  })}});
  // claude 只支持 anthropic/messages：无 anthropicUrl 的目标经 boundTargetIds 绑定即拒。
  await expect(store.updateConfig({
    agentConnectionPatch: {agent: "claude", action: "connect", boundTargetIds: ["openai-only"], cliSyncEnabled: true},
  })).rejects.toThrow("PROTOCOL_URL_REQUIRED");
});

test("读取归一化剔除协议不符的存量绑定与默认供应商（2026-10-06）", async () => {
  const root = await mkdtemp(join(tmpdir(), "proxy-config-bind-clean-"));
  const configPath = join(root, "proxy-config.json");
  // 直写旧版本存量：claude 绑定无 anthropicUrl 的目标并设为默认。
  await writeFile(configPath, JSON.stringify({
    version: 3,
    revision: 1,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    updatedAt: "2026-10-06T00:00:00.000Z",
    agentConnections: {
      claude: {enabled: true, boundTargetIds: ["openai-only"], defaultTargetId: "openai-only", cliSyncEnabled: true},
    },
    targets: [{
      id: "openai-only",
      name: "openai-only",
      enabled: true,
      openaiUrl: "https://openai-only.example/v1",
      supportedModels: ["gpt-5.6"],
    }],
  }));
  const store = new ProxyConfigStore({configPath});
  await store.init();
  const connection = store.getConfig().agentConnections.claude!;
  expect(connection.boundTargetIds).toBeUndefined();
  expect(connection.defaultTargetId).toBeUndefined();
  expect(connection.cliSyncEnabled).toBe(true);
});

test("Agent 级默认模型写入即拒 scope 不符；合法值保留（2026-10-06 收紧写入门禁）", async () => {
  const store = await emptyStore("proxy-config-default-model-");
  // 旧版本同类脏数据在读取归一化时会被静默剔除；现在 targetPatch 写入路径
  // 直接拒绝（fail-fast），合法条目照常保留。
  await expect(store.updateConfig({targetPatch: {target: target({
    id: "provider",
    supportedModels: ["gpt-5.6", "claude-sonnet"],
    supportedModelScopes: {"gpt-5.6": ["codex"], "claude-sonnet": ["claude"]},
    development: {
      defaultModels: {codex: "claude-sonnet", claude: "claude-sonnet"},
      defaultCredentials: {codex: "cred-codex", claude: "cred-claude"},
    },
  })}})).rejects.toThrow("DEFAULT_MODEL_AGENT_SCOPE_MISMATCH");

  // 合法条目照常保留（claude-sonnet 在仅有 openaiUrl 的目标上推断为 chat 协议，
  // 对 claude 默认模型同样写入即拒——旧版本靠读取归一化静默剔除）。
  await expect(store.updateConfig({targetPatch: {target: target({
    id: "provider",
    supportedModels: ["gpt-5.6", "claude-sonnet"],
    supportedModelScopes: {"gpt-5.6": ["codex"], "claude-sonnet": ["claude"]},
    development: {
      defaultModels: {codex: "gpt-5.6", claude: "claude-sonnet"},
      defaultCredentials: {codex: "cred-codex", claude: "cred-claude"},
    },
  })}})).rejects.toThrow("DEFAULT_MODEL_WIRE_API_MISMATCH");

  await store.updateConfig({targetPatch: {target: target({
    id: "provider",
    supportedModels: ["gpt-5.6", "claude-sonnet"],
    supportedModelScopes: {"gpt-5.6": ["codex"], "claude-sonnet": ["claude"]},
    pricing: {rateMultiplier: 1, modelVendors: {
      "gpt-5.6": {vendor: "test", priceEntryId: "test:gpt-5.6"},
    }},
    development: {
      defaultModels: {codex: "gpt-5.6"},
      defaultCredentials: {codex: "cred-codex", claude: "cred-claude"},
    },
  })}});
  expect(store.getConfig().targets[0]?.development).toEqual({
    defaultModels: {codex: "gpt-5.6"},
    defaultCredentials: {codex: "cred-codex", claude: "cred-claude"},
  });
});

test("目标归一化保留并推断计费通道与供应商族", async () => {
  const store = await emptyStore("proxy-config-billing-channel-");
  const result = await store.updateConfig({
    expectedRevision: 1,
    targetPatch: {
      target: {
        id: "kimi-coding",
        name: "Kimi For Coding",
        enabled: false,
        supportedModels: [],
        openaiUrl: "https://api.kimi.com/coding/v1",
        billingChannel: "plan",
        vendorFamily: "kimi",
      },
    },
  });
  const targetSaved = result.targets.find(item => item.id === "kimi-coding")!;
  expect(targetSaved.billingChannel).toBe("plan");
  expect(targetSaved.vendorFamily).toBe("kimi");
});

test("自定义套餐 URL 自动推断计费通道", async () => {
  const store = await emptyStore("proxy-config-infer-billing-");
  const result = await store.updateConfig({
    expectedRevision: 1,
    targetPatch: {
      target: {
        id: "volc-coding",
        name: "火山 Coding",
        enabled: false,
        supportedModels: [],
        openaiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      },
    },
  });
  const targetSaved = result.targets.find(item => item.id === "volc-coding")!;
  expect(targetSaved.billingChannel).toBe("plan");
  expect(targetSaved.vendorFamily).toBe("volcengine");
});

test("跨目标重复 URL 只在同一计费通道时拒绝，按量与套餐/订阅可共存", async () => {
  const store = await emptyStore("proxy-config-unique-channel-");
  const first = await store.updateConfig({
    expectedRevision: 1,
    targetPatch: {
      target: {
        id: "minimax-cn",
        name: "MiniMax 按量",
        enabled: false,
        supportedModels: [],
        openaiUrl: "https://api.minimaxi.com/v1",
        billingChannel: "pay_as_you_go",
        vendorFamily: "minimax",
      },
    },
  });
  const second = await store.updateConfig({
    expectedRevision: first.revision,
    targetPatch: {
      target: {
        id: "minimax-plan",
        name: "MiniMax Token Plan",
        enabled: false,
        supportedModels: [],
        openaiUrl: "https://api.minimaxi.com/v1",
        billingChannel: "plan",
        vendorFamily: "minimax",
      },
    },
  });
  expect(second.targets.map(item => item.id)).toEqual(["minimax-cn", "minimax-plan"]);
  await expect(store.updateConfig({
    expectedRevision: second.revision,
    targetPatch: {
      target: {
        id: "minimax-cn-dup",
        name: "MiniMax 重复",
        enabled: false,
        supportedModels: [],
        openaiUrl: "https://api.minimaxi.com/v1",
        billingChannel: "pay_as_you_go",
      },
    },
  })).rejects.toThrow("Duplicate proxy target baseUrl");
});

function target(overrides: Partial<ProxyTarget> & Pick<ProxyTarget, "id">): ProxyTarget {
  return {
    id: overrides.id,
    name: overrides.id,
    openaiUrl: "https://provider.example/v1",
    enabled: true,
    supportedModels: [],
    pricing: {rateMultiplier: 1},
    ...overrides,
  };
}

async function emptyStore(prefix: string): Promise<ProxyConfigStore> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = new ProxyConfigStore({configPath: join(root, "proxy-config.json")});
  await store.init();
  return store;
}

async function twoTargetStore(configPath?: string): Promise<ProxyConfigStore> {
  const store = configPath
    ? new ProxyConfigStore({configPath})
    : await emptyStore("proxy-config-two-target-");
  if (configPath) await store.init();
  await store.updateConfig({targets: [
    target({id: "primary", name: "主目标", openaiUrl: "https://primary.example/v1"}),
    target({id: "backup", name: "备用目标", openaiUrl: "https://backup.example/v1", pricing: {rateMultiplier: 0.9}}),
  ]});
  return store;
}

test("自定义目标保存时按最新 URL 重推断模型 wire API，修复过期空声明", () => {
  // 场景还原：只配 openaiUrl 时确认了 claude 模型（落库空数组=显式拒绝），
  // 之后补齐 anthropicUrl——保存时必须重推断为 messages，否则所有 Agent 兼容判定永久失败。
  const catapi = target({
    id: "relay-catapi",
    openaiUrl: "https://catapi.example",
    anthropicUrl: "https://catapi.example",
    supportedModels: ["claude-fable-5", "claude-opus-5"],
    supportedModelWireApis: {"claude-fable-5": [], "claude-opus-5": []},
  });
  const update: ProxyConfigUpdate = {
    expectedRevision: 1,
    targetPatch: {id: "relay-catapi", target: {name: "catapi"}},
  };
  refreshCustomTargetModelWireApis(update, [catapi]);
  expect(update.targetPatch?.target.supportedModelWireApis).toEqual({
    "claude-fable-5": ["messages"],
    "claude-opus-5": ["messages"],
  });

  // patch 同时改 URL 时按合并后的 URL 推断：去掉 anthropicUrl 后 claude 模型回到空（拒绝）。
  const dropAnthropic: ProxyConfigUpdate = {
    expectedRevision: 1,
    targetPatch: {id: "relay-catapi", target: {anthropicUrl: undefined}},
  };
  refreshCustomTargetModelWireApis(dropAnthropic, [catapi]);
  expect(dropAnthropic.targetPatch?.target.supportedModelWireApis).toEqual({
    "claude-fable-5": [],
    "claude-opus-5": [],
  });

  // patch 携带新的支持模型列表时，对新列表统一重推断（确认链路的等价快路径）。
  const withModels: ProxyConfigUpdate = {
    expectedRevision: 1,
    targetPatch: {id: "relay-catapi", target: {supportedModels: ["gpt-5.6-sol"]}},
  };
  refreshCustomTargetModelWireApis(withModels, [catapi]);
  expect(withModels.targetPatch?.target.supportedModelWireApis).toEqual({
    "gpt-5.6-sol": ["responses"],
  });
});

test("官方预设目标的模型 wire API 声明来自目录，保存时不重推断", () => {
  const presetTarget = target({
    id: "bigmodel-plan",
    presetId: "zhipu-coding-plan",
    openaiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    supportedModels: ["glm-5.3"],
    supportedModelWireApis: {"glm-5.3": ["chat_completions", "messages"]},
  });
  const update: ProxyConfigUpdate = {
    expectedRevision: 1,
    targetPatch: {id: "bigmodel-plan", target: {name: "bigmodel"}},
  };
  refreshCustomTargetModelWireApis(update, [presetTarget]);
  expect(update.targetPatch?.target.supportedModelWireApis).toBeUndefined();
});
