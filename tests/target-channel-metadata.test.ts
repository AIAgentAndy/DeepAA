import {describe, expect, test} from "vitest";
import {
  inferTargetChannelMetadata,
  normalizeBillingChannel,
  normalizeVendorFamily,
} from "../src/lib/target-channel-metadata.js";

describe("目标计费通道元数据（B 方案）", () => {
  test("预设优先返回官方声明的通道与供应商族", () => {
    expect(inferTargetChannelMetadata({
      presetId: "moonshot-cn",
      openaiUrl: "https://api.moonshot.cn/v1",
    })).toEqual({billingChannel: "pay_as_you_go", vendorFamily: "kimi"});
    expect(inferTargetChannelMetadata({
      presetId: "volcengine-plan",
      openaiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    })).toEqual({billingChannel: "plan", vendorFamily: "volcengine"});
    expect(inferTargetChannelMetadata({
      presetId: "anthropic-subscription",
      anthropicUrl: "https://api.anthropic.com",
    })).toEqual({billingChannel: "subscription", vendorFamily: "anthropic"});
  });

  test("自定义套餐 URL 识别为 plan 并推断供应商族", () => {
    expect(inferTargetChannelMetadata({
      openaiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    })).toEqual({billingChannel: "plan", vendorFamily: "volcengine"});
    expect(inferTargetChannelMetadata({
      openaiUrl: "https://api.kimi.com/coding/v1",
    })).toEqual({billingChannel: "plan", vendorFamily: "kimi"});
    expect(inferTargetChannelMetadata({
      openaiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    })).toEqual({billingChannel: "plan", vendorFamily: "zhipu"});
    expect(inferTargetChannelMetadata({
      openaiUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
    })).toEqual({billingChannel: "plan", vendorFamily: "qwenai"});
    expect(inferTargetChannelMetadata({
      anthropicUrl: "https://api.lkeap.cloud.tencent.com/plan/anthropic",
    })).toEqual({billingChannel: "plan", vendorFamily: "tencent-hunyuan"});
  });

  test("订阅 URL 识别为 subscription（chatgpt.com/backend-api/codex）", () => {
    expect(inferTargetChannelMetadata({
      openaiUrl: "https://chatgpt.com/backend-api/codex",
    })).toEqual({billingChannel: "subscription", vendorFamily: "openai"});
  });

  test("普通自定义目标默认按量，供应商族回退 pricing.vendor", () => {
    expect(inferTargetChannelMetadata({
      openaiUrl: "https://proxy.example/v1",
      pricing: {vendor: "my-relay", rateMultiplier: 1},
    })).toEqual({billingChannel: "pay_as_you_go", vendorFamily: "my-relay"});
    expect(inferTargetChannelMetadata({openaiUrl: "https://proxy.example/v1"})).toEqual({
      billingChannel: "pay_as_you_go",
    });
  });

  test("非法显式值被拒绝", () => {
    expect(normalizeBillingChannel("prepaid")).toBeUndefined();
    expect(normalizeVendorFamily("中文名")).toBeUndefined();
    expect(normalizeVendorFamily(" KIMI ")).toBe("kimi");
  });
});
