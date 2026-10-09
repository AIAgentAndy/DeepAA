import {describe, expect, test} from "vitest";
import {resolvePlanProviderForTarget} from "../src/lib/sync-engine/plan-provider.js";

describe("套餐适配器与代理目标精准匹配", () => {
  test("DeepSeek 等未声明套餐的供应商不返回任何套餐适配器", () => {
    expect(resolvePlanProviderForTarget({
      id: "deepseek",
      name: "DeepSeek（官方）",
      openaiUrl: "https://api.deepseek.com",
      anthropicUrl: "https://api.deepseek.com/anthropic",
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      pricing: {vendor: "deepseek"},
    })).toBeUndefined();
  });

  test.each([
    ["kimi-coding", "moonshot-cn", "https://api.moonshot.cn/v1"],
    ["zhipu", "zhipu-cn", "https://open.bigmodel.cn/api/paas/v4"],
    ["zhipu", "zhipu-global", "https://api.z.ai/api/paas/v4"],
    ["minimax", "minimax-cn", "https://api.minimaxi.com/v1"],
    ["minimax", "minimax-global", "https://api.minimax.io/v1"],
    ["volcengine-plan", "volcengine-plan", "https://ark.cn-beijing.volces.com/api/plan"],
    ["volcengine-coding-plan", "volcengine-coding-plan", "https://ark.cn-beijing.volces.com/api/coding"],
    ["opencode-go", "opencode-go", "https://opencode.ai/zen/go/v1"],
  ] as const)("供应商 %s 命中 %s", (expected, vendor, url) => {
    expect(resolvePlanProviderForTarget({
      id: vendor,
      name: vendor,
      openaiUrl: url,
      enabled: true,
      supportedModels: [],
      pricing: {vendor},
    })).toBe(expected);
  });

  test("未记录 vendor 时按上游 URL 兜底匹配套餐供应商", () => {
    expect(resolvePlanProviderForTarget({
      id: "bigmodel",
      name: "bigmodel",
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
      enabled: true,
      supportedModels: [],
    })).toBe("zhipu");
    expect(resolvePlanProviderForTarget({
      id: "opencode-go",
      name: "OpenCode Go",
      openaiUrl: "https://opencode.ai/zen/go/v1",
      enabled: true,
      supportedModels: [],
    })).toBe("opencode-go");
    expect(resolvePlanProviderForTarget({
      id: "volces-coding",
      name: "Volces Coding",
      openaiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      enabled: true,
      supportedModels: [],
      billingChannel: "plan",
    })).toBe("volcengine-coding-plan");
    expect(resolvePlanProviderForTarget({
      id: "relay",
      name: "relay",
      openaiUrl: "https://relay.example/v1",
      enabled: true,
      supportedModels: [],
    })).toBeUndefined();
  });

  test("订阅通道必须显式订阅元数据；裸 OpenAI/Anthropic 按量 URL 不误命中", () => {
    expect(resolvePlanProviderForTarget({
      id: "custom-openai",
      name: "Custom OpenAI",
      openaiUrl: "https://api.openai.com/v1",
      enabled: true,
      supportedModels: [],
      pricing: {vendor: "openai"},
    })).toBeUndefined();
    expect(resolvePlanProviderForTarget({
      id: "custom-anthropic",
      name: "Custom Anthropic",
      anthropicUrl: "https://api.anthropic.com",
      enabled: true,
      supportedModels: [],
      pricing: {vendor: "anthropic"},
    })).toBeUndefined();
    expect(resolvePlanProviderForTarget({
      id: "custom-anthropic",
      name: "Custom Anthropic",
      anthropicUrl: "https://api.anthropic.com",
      enabled: true,
      supportedModels: [],
      billingChannel: "subscription",
    })).toBe("anthropic-subscription");
    expect(resolvePlanProviderForTarget({
      id: "openai-subscription",
      name: "OpenAI 订阅",
      openaiUrl: "https://chatgpt.com/backend-api/codex",
      enabled: true,
      supportedModels: [],
      presetId: "openai-subscription",
      billingChannel: "subscription",
    })).toBe("openai-subscription");
  });
});
