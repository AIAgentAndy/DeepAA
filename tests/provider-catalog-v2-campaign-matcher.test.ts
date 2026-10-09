import {describe, expect, test} from "vitest";
import {composeMatchedPromotions, matchPromotions} from "../src/lib/provider-catalog/campaign-matcher.js";
import {computePlanCredit} from "../src/lib/plan-credit.js";
import {isWithinTimeWindows, type PlanCreditPromotion} from "../src/lib/pricing.js";

/**
 * Campaign 合成语义与节假日窗口（设计 4.6/5.3、深检 3/4，验收用例 1-4）：
 * creditMultiplier 全部相乘、freeWindow 命中即终局 0、factorOverride 按最高 priority 选胜；
 * includeDates/excludeDates（编译解析的节假日集合）参与窗口匹配。
 */

const zhipuFlashRules = {
  formula: "token_weighted" as const,
  divisor: 10000,
  timezone: "Asia/Shanghai",
  peakWindows: [{
    days: [0, 1, 2, 3, 4],
    start: "14:00",
    end: "18:00",
    multiplier: 1,
    excludeDates: ["2026-10-01"],
  }],
  offPeakMultiplier: 0.5,
  modelFactors: {"glm-5.3-flash": {input: 2.3, output: 8, cachedInput: 0.56}},
  quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
  promotions: [
    {from: "2026-09-03T00:00:00+08:00", to: "2026-09-21T08:59:59.999Z", models: ["glm-5.3-flash"], agents: ["zcode"], windows: [{start: "23:00", end: "24:00"}, {start: "00:00", end: "09:00"}], multiplier: 0, priority: 300, label: "夜间畅用"},
    {from: "2026-09-03T00:00:00+08:00", to: "2026-09-21T08:59:59.999Z", models: ["glm-5.3-flash"], windows: [{start: "23:00", end: "24:00"}, {start: "00:00", end: "09:00"}], multiplier: 0.5, priority: 200, label: "夜间半价", unverified: true},
    {from: "2026-06-01T00:00:00+08:00", models: ["glm-5.3-flash"], agents: ["zcode"], multiplier: 2 / 3, priority: 100, label: "ZCode 常驻"},
  ],
};

const usage = {inputTokens: 100_000, cacheReadTokens: 50_000, outputTokens: 10_000};
const baseCredit = (100_000 * 2.3 + 50_000 * 0.56 + 10_000 * 8) / 10000;

function flashCredit(capturedAt: string, agentName?: string) {
  return computePlanCredit({
    model: "glm-5.3-flash",
    rules: zhipuFlashRules,
    rates: {input: 0.8, output: 2.8},
    usage,
    capturedAt,
    agentName,
  });
}

describe("智谱真实场景（验收用例 1-4）", () => {
  test("用例 1：工作日 18:30 非高峰 × ZCode 2/3（不命中夜间窗口）", () => {
    const result = flashCredit("2026-09-09T18:30:00+08:00", "zcode");
    expect(result.creditCost).toBeCloseTo(baseCredit * 0.5 * (2 / 3));
    expect(result.unit).toBe("积分");
  });

  test("用例 2：夜间 23:30 ZCode：freeWindow 终局 0，积分口径保留", () => {
    const result = flashCredit("2026-09-09T23:30:00+08:00", "zcode");
    expect(result.creditCost).toBe(0);
    expect(result.unit).toBe("积分");
    expect(result.formulaDetail).toContain("夜间畅用");
  });

  test("用例 3：夜间 23:30 非 ZCode：非高峰 0.5 × 夜间半价 0.5 = 基础 25%", () => {
    const result = flashCredit("2026-09-09T23:30:00+08:00", "codex");
    expect(result.creditCost).toBeCloseTo(baseCredit * 0.5 * 0.5);
    expect(result.confidence).toBe("unverified");
  });

  test("用例 4：工作日 15:00 命中高峰 ×1；同窗口命中 excludeDates（法定节假日）按非高峰 0.5", () => {
    // 2026-10-01 是周四（工作日 days 含 4），但落在高峰窗口的 excludeDates。
    expect(flashCredit("2026-10-01T15:00:00+08:00", "codex").creditCost).toBeCloseTo(baseCredit * 0.5);
    // 对照：非节假日工作日 15:00 命中高峰倍率 1。
    expect(flashCredit("2026-09-10T15:00:00+08:00", "codex").creditCost).toBeCloseTo(baseCredit * 1);
  });
});

describe("合成原语（composeMatchedPromotions）", () => {
  test("多条 creditMultiplier 全部相乘，不因优先级屏蔽", () => {
    const composed = composeMatchedPromotions([
      {from: "2026-01-01T00:00:00Z", multiplier: 0.8, priority: 100, label: "A"},
      {from: "2026-01-01T00:00:00Z", multiplier: 0.5, priority: 50, label: "B"},
    ]);
    expect(composed.multiplier).toBeCloseTo(0.4);
    expect(composed.labels).toEqual(["A", "B"]);
  });

  test("freeWindow（×0）终局：其后低优先级活动不改变结果但保留标签", () => {
    const composed = composeMatchedPromotions([
      {from: "2026-01-01T00:00:00Z", multiplier: 0, priority: 300, label: "免单"},
      {from: "2026-01-01T00:00:00Z", multiplier: 0.5, priority: 100, label: "半价"},
    ]);
    expect(composed.multiplier).toBe(0);
    expect(composed.labels).toEqual(["免单", "半价"]);
  });

  test("factorOverride 按声明顺序（优先级降序）选胜，input/output 独立", () => {
    const composed = composeMatchedPromotions([
      {from: "2026-01-01T00:00:00Z", input: 0.25, priority: 200, label: "高优"},
      {from: "2026-01-01T00:00:00Z", input: 0.9, output: 0.9, priority: 100, label: "低优"},
    ]);
    expect(composed.inputFactor).toBe(0.25);
    expect(composed.outputFactor).toBe(0.9);
  });

  test("匹配筛选：模型/Agent/日期/窗口（含窗口时区）", () => {
    const promotions: PlanCreditPromotion[] = [
      {from: "2026-01-01T00:00:00Z", models: ["other"], multiplier: 0.1},
      {from: "2026-01-01T00:00:00Z", agents: ["zcode"], multiplier: 0.2},
      {from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", multiplier: 0.3},
      {from: "2026-01-01T00:00:00Z", windows: [{start: "23:00", end: "24:00", timezone: "Asia/Shanghai"}], multiplier: 0.4},
    ];
    const matched = matchPromotions(promotions, "glm-5.3-flash", "2026-01-01T23:30:00+08:00", "codex", "Asia/Shanghai");
    expect(matched.map(item => item.multiplier)).toEqual([0.3, 0.4]);
  });
});

describe("isWithinTimeWindows 节假日日期作用域（编译解析产物）", () => {
  const windows = [{days: [0, 1, 2, 3, 4], start: "14:00", end: "18:00"}];

  test("excludeDates 命中即不匹配（节假日剔除）", () => {
    expect(isWithinTimeWindows([{...windows[0], excludeDates: ["2026-10-01"]}], new Date("2026-10-01T15:00:00+08:00"), "Asia/Shanghai")).toBe(false);
    expect(isWithinTimeWindows(windows, new Date("2026-10-01T15:00:00+08:00"), "Asia/Shanghai")).toBe(true);
  });

  test("includeDates 命中即匹配（节假日强制命中，无视 days/时刻）", () => {
    expect(isWithinTimeWindows([{...windows[0], includeDates: ["2026-10-03"]}], new Date("2026-10-03T08:00:00+08:00"), "Asia/Shanghai")).toBe(true);
    // exclude 优先于 include 的组合语义：同窗口两者都命中日期时剔除。
    expect(isWithinTimeWindows([{...windows[0], includeDates: ["2026-10-03"], excludeDates: ["2026-10-03"]}], new Date("2026-10-03T15:00:00+08:00"), "Asia/Shanghai")).toBe(false);
  });
});
