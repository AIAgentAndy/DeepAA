import {describe, expect, test} from "vitest";
import {
  AUTO_COMPACT_CONTEXT_PERCENT,
  DEFAULT_CONTEXT_WINDOW,
  GPT56_CONTEXT_WINDOW,
  resolveAutoCompactTokenLimit,
  resolveFallbackContextWindow,
} from "../src/lib/development-launch/model-capabilities.js";

describe("开发启动模型窗口默认值", () => {
  test("未知模型使用 272000，上下文压缩阈值按 95% 计算", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(272000);
    expect(AUTO_COMPACT_CONTEXT_PERCENT).toBe(0.95);
    expect(resolveFallbackContextWindow("vendor-model")).toBe(272000);
    expect(resolveAutoCompactTokenLimit(272000)).toBe(258400);
  });

  test("GPT-5.6-* 中转模型使用 350000，上下文压缩阈值仍按 95% 计算", () => {
    expect(GPT56_CONTEXT_WINDOW).toBe(350000);
    expect(resolveFallbackContextWindow("gpt-5.6-sol")).toBe(350000);
    expect(resolveFallbackContextWindow("gpt-5.6-terra_ai98pro.xyz")).toBe(350000);
    expect(resolveAutoCompactTokenLimit(350000)).toBe(332500);
  });
});
