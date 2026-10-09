import {expect, test} from "vitest";
import {
  createProxyTargetDraft,
  deriveProxyTargetPatchFromBaseUrl,
  displayNameFromUpstreamUrl,
  normalizeSingleTargetDraft,
  proxyTargetsEqual,
  proxyTargetUiKey,
  reconcileDraftWithPersisted,
  routeIdPatchForNameSync,
} from "../src/lib/proxy-settings-draft";
import type {ProxyConfig, ProxyTarget} from "../src/types";

const baseTarget: ProxyTarget = {
  id: "api.openai.com",
  name: "OpenAI",
  openaiUrl: "https://api.openai.com",
  enabled: true,
  supportedModels: ["gpt-5.6"],
};

test("新增目标为空草稿且不写目标级协议兼容字段", () => {
  const draft = createProxyTargetDraft(1, "2026-08-13T00:00:00.000Z", "http://127.0.0.1:3211");
  expect(draft).toMatchObject({
    id: "",
    name: "",
    openaiUrl: "",
    anthropicUrl: "",
    enabled: false,
    supportedModels: [],
    pricing: {},
  });
  expect(draft).not.toHaveProperty("upstreamUrl");
  expect(draft).not.toHaveProperty("format");
  expect(draft).not.toHaveProperty("localBaseUrl");
});

test("URL 候选链可派生新草稿路由 ID 和名称，持久化目标锁定路由 ID", () => {
  // L0 注册主域候选：展示重心落在模型名一侧（2026-09-20 主域优先方案）。
  expect(deriveProxyTargetPatchFromBaseUrl(
    {...baseTarget, id: "new-target-1", name: "", openaiUrl: "http://ark.cn-beijing.volces.com/v1"},
    "http://ark.cn-beijing.volces.com/v1",
    false,
  )).toEqual({id: "volces.com", name: "volces"});

  expect(deriveProxyTargetPatchFromBaseUrl(
    {...baseTarget, id: "api.deepseek.com", name: "deepseek", openaiUrl: "https://api.test.com"},
    "https://api.test.com",
    false,
    "http://localhost:3211",
    true,
  )).toEqual({id: "api.deepseek.com", name: "test"});
});

test("URL 候选链按 主域 → 主域+词 逐层回退且跳过已占用候选", () => {
  const urls = {openaiUrl: "https://open.bigmodel.cn/api/paas/v4", anthropicUrl: "https://open.bigmodel.cn/api/anthropic"};
  // 主域候选与已有供应商撞名时回退到 主域+path 首个有效词。
  expect(deriveProxyTargetPatchFromBaseUrl(
    {...baseTarget, ...urls, id: "", name: ""},
    urls.openaiUrl,
    false,
    "http://localhost:3211",
    false,
    [{id: "bigmodel.cn"}],
  )).toMatchObject({id: "bigmodel.cn-paas"});

  // 全部候选用尽时返回空 ID，由保存校验引导手动修改。
  const exhausted = deriveProxyTargetPatchFromBaseUrl(
    {...baseTarget, ...urls, id: "", name: ""},
    urls.openaiUrl,
    false,
    "http://localhost:3211",
    false,
    [
      {id: "bigmodel.cn"},
      {id: "bigmodel.cn-paas"},
      {id: "bigmodel.cn-anthropic"},
      {id: "bigmodel.cn-api-paas-v4"},
      {id: "bigmodel.cn-api-anthropic"},
      {id: "open.bigmodel.cn-api-paas-v4"},
      {id: "open.bigmodel.cn-api-anthropic"},
    ],
  );
  expect(exhausted.id).toBe("");
});

test("路由 ID 修改只在名称未手动编辑时同步名称", () => {
  expect(routeIdPatchForNameSync(baseTarget, "gateway.example.com", false))
    .toEqual({id: "gateway.example.com", name: "gateway.example.com"});
  expect(routeIdPatchForNameSync({...baseTarget, name: "生产网关"}, "gateway.example.com", true))
    .toEqual({id: "gateway.example.com"});
});

test("从供应商 URL 派生易读名称", () => {
  expect(displayNameFromUpstreamUrl("http://ark.cn-beijing.volces.com/v1")).toBe("volces");
  expect(displayNameFromUpstreamUrl("https://api.openai.com")).toBe("openai");
  expect(displayNameFromUpstreamUrl("https://gateway.example.co.uk/v1")).toBe("example");
});

test("代理 UI key 由 createdAt 与位置共同保证唯一", () => {
  const createdAt = "2026-08-13T00:00:00.000Z";
  expect(proxyTargetUiKey({...baseTarget, createdAt}, 0)).toBe(`${createdAt}-0`);
  expect(proxyTargetUiKey({...baseTarget, id: "other", createdAt}, 1)).toBe(`${createdAt}-1`);
});

test("normalizeSingleTargetDraft 归一化双协议 URL、名称、路由 ID 和倍率", () => {
  const result = normalizeSingleTargetDraft({
    id: "",
    name: "",
    openaiUrl: "https://api.openai.com/",
    anthropicUrl: "",
    enabled: true,
    pricing: {vendor: "openai"},
    supportedModels: ["gpt-5.6"],
  }, 0);
  expect(result).toMatchObject({
    ok: true,
    errors: [],
    target: {
      id: "openai.com",
      name: "openai",
      openaiUrl: "https://api.openai.com",
      pricing: {vendor: "openai"},
    },
  });
  expect(result.target).not.toHaveProperty("localBaseUrl");
});

test("normalizeSingleTargetDraft 对持久化目标锁定路由 ID", () => {
  const result = normalizeSingleTargetDraft({
    ...baseTarget,
    id: "api.deepseek.com",
    name: "deepseek",
    openaiUrl: "https://api.test.com",
  }, 0, {lockRouteId: true});
  expect(result).toMatchObject({ok: true, target: {id: "api.deepseek.com", openaiUrl: "https://api.test.com"}});
});

test("normalizeSingleTargetDraft 用中文返回 URL、模型和重复错误", () => {
  const invalid = normalizeSingleTargetDraft({
    id: "invalid",
    name: "测试代理",
    openaiUrl: "ftp://api.example.com",
    enabled: true,
    supportedModels: [],
    pricing: {},
  }, 0);
  expect(invalid.ok).toBe(false);
  expect(invalid.errors.join("；")).toContain("至少需要配置一个协议上游 URL");
  expect(invalid.errors.join("；")).toContain("至少需要配置一个支持的模型");

  const other = {...baseTarget, id: "api.openai.com", openaiUrl: "https://api.openai.com"};
  const duplicate = normalizeSingleTargetDraft({...other, name: "重复目标"}, 1, {otherTargets: [other]});
  expect(duplicate.errors.join("；")).toContain("路由 ID 与其他供应商重复");
  expect(duplicate.errors.join("；")).toContain("OpenAI 上游 URL 与其他供应商重复");
  expect(duplicate.errors.join("；")).not.toContain("localBaseUrl");
});

test("normalizeSingleTargetDraft 候选用尽时提示手动修改路由 ID", () => {
  // 占用方 URL 对与草稿不同（openai/anthropic 位置互换内容），不触发同 URL 对判定。
  const other = {
    ...baseTarget,
    id: "bigmodel.cn",
    openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
  };
  const result = normalizeSingleTargetDraft({
    id: "",
    name: "智谱编码套餐",
    openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
    anthropicUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    enabled: false,
    supportedModels: ["glm-5.3"],
    pricing: {},
  }, 1, {otherTargets: [
    other,
    {...other, id: "bigmodel.cn-paas"},
    {...other, id: "bigmodel.cn-coding"},
    {...other, id: "bigmodel.cn-api-paas-v4"},
    {...other, id: "bigmodel.cn-api-coding-paas-v4"},
    {...other, id: "open.bigmodel.cn-api-paas-v4"},
    {...other, id: "open.bigmodel.cn-api-coding-paas-v4"},
  ]});
  expect(result.ok).toBe(false);
  expect(result.errors.join("；")).toContain("自动生成的路由 ID 已被其它供应商占用");
  expect(result.errors.join("；")).not.toContain("路由 ID 必填");
});

test("normalizeSingleTargetDraft 同 URL 对提示手动填写区分词（2026-09-20 用户确认）", () => {
  const result = normalizeSingleTargetDraft({
    id: "",
    name: "MiniMax Token Plan",
    openaiUrl: "https://api.minimaxi.com/v1",
    anthropicUrl: "https://api.minimaxi.com/anthropic",
    billingChannel: "plan",
    enabled: false,
    supportedModels: ["abab6.5s-chat"],
    pricing: {},
  }, 1, {otherTargets: [{
    ...baseTarget,
    id: "minimaxi.com",
    openaiUrl: "https://api.minimaxi.com/v1",
    anthropicUrl: "https://api.minimaxi.com/anthropic",
  }]});
  expect(result.ok).toBe(false);
  expect(result.errors.join("；")).toContain("与已有供应商的上游 URL 完全相同");
  expect(result.errors.join("；")).toContain("手动填写");
  expect(result.errors.join("；")).not.toContain("路由 ID 必填");
});

test("模型供应商可空，但目标必须至少有一个模型", () => {
  expect(normalizeSingleTargetDraft({
    ...baseTarget,
    pricing: {vendor: "", rateMultiplier: 1},
  }, 0).ok).toBe(true);
  expect(normalizeSingleTargetDraft({
    ...baseTarget,
    supportedModels: [],
  }, 0).errors).toContain("OpenAI 至少需要配置一个支持的模型");
});

test("reconcileDraftWithPersisted 保留未保存草稿字段和 Agent 连接选择", () => {
  const server = config([{...baseTarget, name: "服务端", createdAt: "2026-08-13T00:00:00.000Z"}], {
    codex: {defaultTargetId: "api.openai.com", cliSyncEnabled: true},
  });
  const draftTarget = {...server.targets[0]!, name: "本地未保存", pricing: {rateMultiplier: 1.5}, enabled: false};
  const draft = config([draftTarget], {claude: {defaultTargetId: "api.openai.com", cliSyncEnabled: false}});
  const result = reconcileDraftWithPersisted(draft, server);
  expect(result.targets[0]).toMatchObject({name: "本地未保存", enabled: true, pricing: {rateMultiplier: 1.5}});
  expect(result.agentConnections).toEqual(draft.agentConnections);
  expect(result.revision).toBe(server.revision);
});

test("reconcileDraftWithPersisted 保留新增草稿，已移除目标不回流", () => {
  const persisted = config([{...baseTarget, id: "backup", openaiUrl: "https://backup.example/v1", createdAt: "2026-08-12T00:00:00.000Z"}], {});
  const draft = config([
    {...persisted.targets[0]!, name: "备用草稿"},
    {id: "new-target", name: "新草稿", openaiUrl: "https://new.example/v1", enabled: false, supportedModels: ["gpt"]},
  ], {});
  const result = reconcileDraftWithPersisted(draft, persisted);
  expect(result.targets.map(item => item.id)).toEqual(["backup", "new-target"]);
  expect(result.targets[0]?.name).toBe("备用草稿");
});

test("proxyTargetsEqual 忽略 createdAt 与 updatedAt，比较全部 V3 业务字段", () => {
  const base = {...baseTarget, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z"};
  expect(proxyTargetsEqual(base, {...base, updatedAt: "2026-08-13T00:00:00.000Z"})).toBe(true);
  expect(proxyTargetsEqual(base, {...base, cliSyncExclusions: ["codex"]})).toBe(false);
});

function config(
  targets: ProxyTarget[],
  agentConnections: ProxyConfig["agentConnections"],
): ProxyConfig {
  return {
    version: 3,
    revision: 5,
    agentConnections,
    targets,
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}
