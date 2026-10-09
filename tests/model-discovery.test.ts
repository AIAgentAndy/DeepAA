import {expect, test} from "vitest";
import {buildModelEndpointCandidates, matchDiscoveredModels, probeOpenAiModels, resolveConfirmedModelBindings} from "../src/lib/sync-engine/model-discovery";
import {normalizePricingConfig, type PricingConfig} from "../src/lib/pricing";
import type {ProxyTarget} from "../src/types";

function pricingConfig(models: Array<Partial<import("../src/lib/pricing").ModelPriceEntry> & {id: string}>): PricingConfig {
  return {version: 2, currency: "USD", models: models as never};
}

test("模型探测根 URL 优先尝试 /v1/models，404 后回退 /models，HTML 不伪装成成功", async () => {
  expect(buildModelEndpointCandidates("https://api.straitapi.com")).toEqual([
    "https://api.straitapi.com/v1/models",
    "https://api.straitapi.com/models",
  ]);
  expect(buildModelEndpointCandidates("https://api.example.com/v1")).toEqual([
    "https://api.example.com/v1/models",
    "https://api.example.com/models",
  ]);

  const calls: string[] = [];
  const result = await probeOpenAiModels("https://api.straitapi.com", "secret", (async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("not found", {status: 404});
    return new Response(JSON.stringify({data: [{id: "gpt-5.6-sol"}]}), {status: 200, headers: {"content-type": "application/json"}});
  }) as typeof fetch);
  expect(calls).toEqual(["https://api.straitapi.com/v1/models", "https://api.straitapi.com/models"]);
  expect(result.models).toEqual(["gpt-5.6-sol"]);

  await expect(probeOpenAiModels("https://api.example.com", "secret", (async () =>
    new Response("<!doctype html><html></html>", {status: 200, headers: {"content-type": "text/html"}})) as typeof fetch,
  )).rejects.toThrow("MODEL_DISCOVER_RESPONSE_INVALID");
});

test("模型探测在首个端点 401 时不回退，避免掩盖鉴权错误", async () => {
  const calls: string[] = [];
  const result = await probeOpenAiModels("https://api.example.com", "secret", (async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({error: "invalid token"}), {status: 401});
  }) as typeof fetch);
  expect(result).toEqual({models: [], authRequired: true});
  expect(calls).toEqual(["https://api.example.com/v1/models"]);
});

test("模型探测在响应超过 2 MiB 时立即取消流并返回稳定错误", async () => {
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls <= 4) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }), {status: 200, headers: {"content-type": "application/json"}});

  await expect(probeOpenAiModels("https://api.example.com", "secret", (async () => response) as typeof fetch))
    .rejects.toThrow("MODEL_DISCOVER_RESPONSE_INVALID");
  expect(cancelled).toBe(true);
});

test("模型发现：匹配到价格中心且为对话类的模型才落库", () => {
  const pricing = pricingConfig([
    {id: "openai/gpt-5.6-sol", vendor: "openai", patterns: ["gpt-5.6-sol"], mode: "chat", pricing: {input: 1, output: 2}},
    {id: "openai/gpt-5.6-terra", vendor: "openai", patterns: ["gpt-5.6-terra"], mode: "completion", pricing: {input: 1, output: 2}},
    {id: "openai/text-embedding-3", vendor: "openai", patterns: ["text-embedding-3"], mode: "embedding", pricing: {input: 1, output: 2}},
    {id: "openai/whisper-1", vendor: "openai", patterns: ["whisper-1"], mode: "audio", pricing: {input: 1, output: 2}},
  ]);
  const result = matchDiscoveredModels(
    ["gpt-5.6-sol", "gpt-5.6-terra", "text-embedding-3", "whisper-1", "unknown-model-xyz"],
    pricing,
  );
  // 对话类且匹配 → 落库；非对话类与未匹配 → 跳过，绝不落库。
  expect(result.matched.map(item => item.modelId)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
  expect(result.skipped).toBe(3);
});

test("模型发现：模型族映射到官方 vendor 后才允许精确匹配", () => {
  const pricing = pricingConfig([
    {id: "vendor/glm-5.6", vendor: "vendor", patterns: ["glm-5.6"], pricing: {input: 1, output: 2}},
  ]);
  const result = matchDiscoveredModels(["glm-5.6"], pricing);
  expect(result.matched).toEqual([]);
  expect(result.unpriced).toEqual([{
    modelId: "glm-5.6",
    reason: "no_price_entry",
    suggestedVendor: "zhipu-cn",
    suggestionReason: "zhipu_model_family",
  }]);
});

test("模型发现：全部未匹配时返回空匹配（前端提示手动添加）", () => {
  const pricing = pricingConfig([
    {id: "vendor/a", vendor: "v", patterns: ["model-a"], mode: "chat"},
  ]);
  const result = matchDiscoveredModels(["unknown-1", "unknown-2"], pricing);
  expect(result.matched).toEqual([]);
  expect(result.skipped).toBe(2);
  expect(result.unpriced).toEqual([
    {modelId: "unknown-1", reason: "unsupported_model_family"},
    {modelId: "unknown-2", reason: "unsupported_model_family"},
  ]);
});

test("模型发现：GPT 与 Claude 家族按官方供应商消歧，不要求用户预选供应商", () => {
  const pricing = pricingConfig([
    {id: "relay/gpt-5.6-sol", vendor: "relay", patterns: ["gpt-5.6-sol"], mode: "chat", pricing: {input: 1, output: 1}},
    {id: "openai/gpt-5.6-sol", vendor: "openai", patterns: ["gpt-5.6-sol"], mode: "chat", pricing: {input: 2, output: 2}},
    {id: "relay/claude-sonnet-5", vendor: "relay", patterns: ["claude-sonnet-5"], mode: "chat", pricing: {input: 1, output: 1}},
    {id: "anthropic/claude-sonnet-5", vendor: "anthropic", patterns: ["claude-sonnet-5"], mode: "chat", pricing: {input: 3, output: 3}},
  ]);
  const result = matchDiscoveredModels(["gpt-5.6-sol", "claude-sonnet-5"], pricing);
  expect(result.matched).toMatchObject([
    {modelId: "gpt-5.6-sol", vendor: "openai", priceEntryId: "openai/gpt-5.6-sol", suggestionReason: "openai_model_family"},
    {modelId: "claude-sonnet-5", vendor: "anthropic", priceEntryId: "anthropic/claude-sonnet-5", suggestionReason: "anthropic_model_family"},
  ]);
});

test("模型发现：未纳入首期字典的 Gemini 家族不猜 vendor", () => {
  const pricing = pricingConfig([
    {id: "vertex/gemini-3-flash", vendor: "vertex_ai", runtimeModelId: "gemini-3-flash", patterns: ["gemini-3-flash"], mode: "chat", pricing: {input: 1, output: 1}},
    {id: "gemini/gemini-3-flash", vendor: "gemini", runtimeModelId: "gemini-3-flash", patterns: ["gemini-3-flash"], mode: "chat", pricing: {input: 2, output: 2}},
  ]);

  const result = matchDiscoveredModels(["gemini-3-flash"], pricing);

  expect(result.matched).toEqual([]);
  expect(result.unpriced).toEqual([{
    modelId: "gemini-3-flash",
    reason: "unsupported_model_family",
  }]);
});

test("模型发现：价格条目别名不能代替真实运行时模型 ID 加入白名单", () => {
  const pricing = pricingConfig([{
    id: "internal-openai-entry",
    vendor: "openai",
    runtimeModelId: "gpt-5.6",
    patterns: ["gpt-5.6", "gpt-5.6-alias"],
    aliases: ["gpt-5.6-alias"],
    mode: "chat",
    pricing: {input: 1, output: 2},
  }]);

  const result = matchDiscoveredModels(["gpt-5.6-alias"], pricing);

  expect(result.matched).toEqual([]);
  expect(result.unpriced).toEqual([{
    modelId: "gpt-5.6-alias",
    reason: "no_price_entry",
    suggestedVendor: "openai",
    suggestionReason: "openai_model_family",
  }]);
});

test("模型发现：GPT 或 Claude 家族缺少官方供应商价格时禁止回退中转站 vendor", () => {
  const pricing = pricingConfig([
    {id: "relay/gpt-x", vendor: "relay", patterns: ["gpt-x"], mode: "chat", pricing: {input: 1, output: 1}},
    {id: "relay/claude-x", vendor: "relay", patterns: ["claude-x"], mode: "chat", pricing: {input: 1, output: 1}},
  ]);

  const result = matchDiscoveredModels(["gpt-x", "claude-x"], pricing);

  expect(result.matched).toEqual([]);
  expect(result.unpriced).toEqual([
    {modelId: "gpt-x", reason: "no_price_entry", suggestedVendor: "openai", suggestionReason: "openai_model_family"},
    {modelId: "claude-x", reason: "no_price_entry", suggestedVendor: "anthropic", suggestionReason: "anthropic_model_family"},
  ]);
});

test("模型发现：未知模型不接受，固定家族仍不做包含式模糊匹配", () => {
  const pricing = pricingConfig([
    {id: "vendor-a/glm-5.3", vendor: "vendor-a", patterns: ["glm-5.3"], mode: "chat", pricing: {input: 1, output: 1}},
    {id: "vendor-b/glm-5.3", vendor: "vendor-b", patterns: ["glm-5.3"], mode: "chat", pricing: {input: 2, output: 2}},
    {id: "openai/gpt-5.6", vendor: "openai", patterns: ["gpt-5.6"], mode: "chat"},
  ]);
  const result = matchDiscoveredModels(["glm-5.3", "gpt-5.6-sol"], pricing);
  expect(result.matched).toEqual([]);
  expect(result.unpriced).toEqual([
    {
      modelId: "glm-5.3",
      reason: "no_price_entry",
      suggestedVendor: "zhipu-cn",
      suggestionReason: "zhipu_model_family",
    },
    {modelId: "gpt-5.6-sol", reason: "no_price_entry", suggestedVendor: "openai", suggestionReason: "openai_model_family"},
  ]);
});

test("模型发现：价格中心条目没有价格时禁止加入白名单", () => {
  const pricing = pricingConfig([
    {id: "openai/gpt-5.6", vendor: "openai", patterns: ["gpt-5.6"], mode: "chat"},
  ]);

  const result = matchDiscoveredModels(["gpt-5.6"], pricing);

  expect(result.matched).toEqual([]);
  expect(result.unpriced).toEqual([{modelId: "gpt-5.6", reason: "price_missing"}]);
});

test("模型确认允许用户保留上游已移除但价格映射仍有效的旧模型", () => {
  const pricing = pricingConfig([
    {id: "openai/gpt-legacy", vendor: "openai", patterns: ["gpt-legacy"], mode: "chat", pricing: {input: 1, output: 2}},
    {id: "openai/gpt-new", vendor: "openai", patterns: ["gpt-new"], mode: "chat", pricing: {input: 2, output: 3}},
  ]);
  const target: ProxyTarget = {
    id: "relay",
    name: "Relay",
    openaiUrl: "https://relay.example/v1",
    enabled: true,
    supportedModels: ["gpt-legacy"],
    pricing: {modelVendors: {"gpt-legacy": {vendor: "openai", priceEntryId: "openai/gpt-legacy"}}},
  };
  const discovery = matchDiscoveredModels(["gpt-new"], pricing);

  const confirmed = resolveConfirmedModelBindings(target, discovery.matched, ["gpt-legacy", "gpt-new"], pricing);

  expect(confirmed.supportedModels).toEqual(["gpt-legacy", "gpt-new"]);
  expect(confirmed.modelVendors).toEqual({
    "gpt-legacy": {vendor: "openai", priceEntryId: "openai/gpt-legacy"},
    "gpt-new": {vendor: "openai", priceEntryId: "openai/gpt-new"},
  });
});

test("确认时移除模型保留其价格映射，之后可无损重新加入", () => {
  const target: ProxyTarget = {
    id: "t",
    name: "t",
    enabled: true,
    openaiUrl: "https://relay.example/v1",
    supportedModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    supportedModelScopes: {
      "gpt-5.6-sol": ["codex"],
      "gpt-5.6-terra": ["codex"],
    },
    pricing: {
      modelVendors: {
        "gpt-5.6-sol": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-sol"},
        "gpt-5.6-terra": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-terra"},
      },
    },
  };
  const pricing = normalizePricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [
      {id: "catalog:openai:gpt-5.6-sol", vendor: "openai", runtimeModelId: "gpt-5.6-sol", patterns: ["gpt-5.6-sol"], pricing: {input: 4, output: 20}},
      {id: "catalog:openai:gpt-5.6-terra", vendor: "openai", runtimeModelId: "gpt-5.6-terra", patterns: ["gpt-5.6-terra"], pricing: {input: 2, output: 12}},
    ],
  });
  // 只确认 terra：sol 被移除，但其映射保留（惰性）
  const first = resolveConfirmedModelBindings(target, [], ["gpt-5.6-terra"], pricing);
  expect(first.supportedModels).toEqual(["gpt-5.6-terra"]);
  expect(first.modelVendors["gpt-5.6-sol"]).toEqual({vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-sol"});

  // 之后重新加入 sol：即使本次 matched 为空（如换了密钥探测），原映射仍可用，不再抛 MODEL_PRICE_MAPPING_INVALID
  const reAdded = resolveConfirmedModelBindings(
    {...target, supportedModels: first.supportedModels, pricing: {modelVendors: first.modelVendors}},
    [], ["gpt-5.6-terra", "gpt-5.6-sol"], pricing,
  );
  expect(reAdded.supportedModels).toEqual(["gpt-5.6-terra", "gpt-5.6-sol"]);
  expect(reAdded.modelVendors["gpt-5.6-sol"]).toEqual({vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-sol"});
});
