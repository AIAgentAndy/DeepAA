import {describe, expect, test} from "vitest";
import {computePlanCredit} from "../src/lib/plan-credit.js";

const usage = {inputTokens: 100_000, cacheReadTokens: 50_000, outputTokens: 10_000};

describe("套餐积分逐请求折算", () => {
  test("智谱公式：非高峰 50% 抵扣", () => {
    const result = computePlanCredit({
      model: "glm-5.3",
      rules: {
        formula: "token_weighted",
        divisor: 10000,
        modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
        peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00", multiplier: 1}],
        quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
      },
      usage,
      capturedAt: "2026-08-20T10:00:00+08:00",
    });
    expect(result.creditCost).toBeCloseTo(((100_000 * 6.9 + 50_000 * 1.7 + 10_000 * 24) / 10000) * 0.5);
    expect(result.unit).toBe("积分");
    expect(result.confidence).toBe("official");
    expect(result.formulaVersion).toBe("token-weighted-2026-09");
    expect(result.formula).toContain("× 时段倍率（本次 0.5）");
    // 多行计算过程：含真实 token 数、中间小计与最终结果。
    expect(result.formulaDetail).toBe([
      "非缓存输入 100,000 × 6.9 = 690,000",
      "缓存读取 50,000 × 1.7 = 85,000",
      "输出 10,000 × 24 = 240,000",
      "小计 1,015,000 ÷ 10000 = 101.5",
      "时段倍率（非高峰）× 0.5",
      "= 50.75 积分",
    ].join("\n"));
  });

  test("智谱公式：高峰按全量抵扣", () => {
    const result = computePlanCredit({
      model: "glm-5.3",
      rules: {
        formula: "token_weighted",
        divisor: 10000,
        modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
        peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00", multiplier: 1}],
        quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
      },
      usage,
      capturedAt: "2026-08-20T15:00:00+08:00",
    });
    expect(result.creditCost).toBeCloseTo((100_000 * 6.9 + 50_000 * 1.7 + 10_000 * 24) / 10000);
  });

  test("智谱 v2：offPeakMultiplier/window.multiplier 数据化生效", () => {
    const base = {
      formula: "token_weighted" as const,
      divisor: 10000,
      modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
      quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
    };
    // 自定义谷时折扣 0.3。
    const customOffPeak = computePlanCredit({
      model: "glm-5.3",
      rules: {...base, peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00"}], offPeakMultiplier: 0.3},
      usage,
      capturedAt: "2026-08-20T10:00:00+08:00",
    });
    expect(customOffPeak.creditCost).toBeCloseTo(((100_000 * 6.9 + 50_000 * 1.7 + 10_000 * 24) / 10000) * 0.3);
    // 高峰窗口自定义倍率 1.5。
    const customPeak = computePlanCredit({
      model: "glm-5.3",
      rules: {...base, peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00", multiplier: 1.5}]},
      usage,
      capturedAt: "2026-08-20T15:00:00+08:00",
    });
    expect(customPeak.creditCost).toBeCloseTo(((100_000 * 6.9 + 50_000 * 1.7 + 10_000 * 24) / 10000) * 1.5);
    // 完全未声明窗口 → 基础积分（不折扣）。
    const noWindows = computePlanCredit({model: "glm-5.3", rules: base, usage, capturedAt: "2026-08-20T10:00:00+08:00"});
    expect(noWindows.creditCost).toBeCloseTo((100_000 * 6.9 + 50_000 * 1.7 + 10_000 * 24) / 10000);
  });

  test("智谱 v2：timezone 决定峰谷判定，aliases 重定向历史模型", () => {
    const base = {
      formula: "token_weighted" as const,
      divisor: 10000,
      modelFactors: {"glm-5.3-flash": {input: 2.3, output: 8, cachedInput: 0.56}},
      quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
    };
    // 同一时刻 UTC 14:00 = 上海 22:00（谷）：按上海时区谷时折扣，按 UTC 时区高峰全价。
    const rules = {
      ...base,
      peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00"}],
      aliases: {"glm-5-turbo": "glm-5.3-flash", "glm-4.7": "glm-5.3-flash"},
    };
    const instant = "2026-08-20T14:00:00Z";
    const shanghai = computePlanCredit({model: "glm-5-turbo", rules, usage, capturedAt: instant});
    expect(shanghai.creditCost).toBeCloseTo(((100_000 * 2.3 + 50_000 * 0.56 + 10_000 * 8) / 10000) * 0.5);
    const utc = computePlanCredit({model: "glm-5.3-flash", rules: {...rules, timezone: "UTC"}, usage, capturedAt: instant});
    expect(utc.creditCost).toBeCloseTo((100_000 * 2.3 + 50_000 * 0.56 + 10_000 * 8) / 10000);
    // 未命中 aliases 且无系数 → unverified，notes 带重定向后模型名。
    const missing = computePlanCredit({
      model: "glm-9.9",
      rules: {...base, aliases: {"glm-5-turbo": "glm-5.3-flash"}},
      usage,
      capturedAt: "2026-08-20T10:00:00+08:00",
    });
    expect(missing.creditCost).toBeUndefined();
    expect(missing.confidence).toBe("unverified");
    expect(missing.notes).toContain("glm-9.9");
  });

  test("MiniMax：按量目录价 × 积分系数", () => {
    const result = computePlanCredit({
      model: "MiniMax-M3",
      rules: {
        formula: "money_to_credits",
        currency: "CNY",
        creditsPerCurrency: 142.85714285714286,
        quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
      },
      rates: {input: 2.1, output: 8.4, cachedInput: 0.42},
      usage,
      capturedAt: "2026-08-20T10:00:00+08:00",
    });
    const expected = ((100_000 / 1_000_000) * 2.1 + (50_000 / 1_000_000) * 0.42 + (10_000 / 1_000_000) * 8.4)
      * (1000 / 7);
    expect(result.creditCost).toBeCloseTo(expected);
    expect(result.unit).toBe("积分");
    expect(result.confidence).toBe("official");
  });

  test("火山官方 AFP 公式：缓存命中按输入系数计入", () => {
    const result = computePlanCredit({
      model: "deepseek-v4-flash",
      rules: {
        formula: "afp_weighted",
        currency: "CNY",
        divisor: 10000,
        modelFactors: {"deepseek-v4-flash": {input: 0.5, output: 0.5}},
        quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
      },
      usage,
      capturedAt: "2026-08-20T10:00:00+08:00",
    });
    // AFP = ((输入 100k + 缓存命中 50k) × 0.5 + 输出 10k × 0.5) / 10000 = 8
    expect(result.creditCost).toBeCloseTo(((100_000 + 50_000) * 0.5 + 10_000 * 0.5) / 10000);
    expect(result.unit).toBe("AFP");
    expect(result.formulaVersion).toBe("afp-weighted-2026-09");
    expect(result.confidence).toBe("official");
    expect(result.formula).toBe("AFP = ((非缓存输入 + 缓存读取) × 0.5 + 输出 × 0.5) / 10000");
  });

  test("火山活动倍率：日期区间内覆盖基础系数，区间外回落", () => {
    const rules = {
      formula: "afp_weighted" as const,
      currency: "CNY" as const,
      divisor: 10000,
      modelFactors: {"glm-5.3-flash": {input: 0.5, output: 0.5}},
      promotions: [{
        from: "2026-08-28T00:00:00+08:00",
        to: "2026-09-11T23:59:59+08:00",
        models: ["glm-5.3-flash"],
        input: 0.25,
        output: 0.25,
        note: "官方限时折扣：抵扣系数 0.25（5 折）",
      }],
      quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
    };
    const inPromotion = computePlanCredit({
      model: "glm-5.3-flash", rules, usage, capturedAt: "2026-09-01T12:00:00+08:00",
    });
    expect(inPromotion.creditCost).toBeCloseTo(((100_000 + 50_000) * 0.25 + 10_000 * 0.25) / 10000);
    // v2：活动说明并入公式标签，不再单写 notes。
    expect(inPromotion.formula).toContain("0.25");
    expect(inPromotion.formulaDetail).toContain("× 0.25");
    expect(inPromotion.formulaDetail).toContain("100,000 + 缓存读取 50,000 = 150,000");
    expect(inPromotion.formulaDetail).toContain("= 4 AFP");
    const beforePromotion = computePlanCredit({
      model: "glm-5.3-flash", rules, usage, capturedAt: "2026-08-27T23:59:59+08:00",
    });
    expect(beforePromotion.creditCost).toBeCloseTo(((100_000 + 50_000) * 0.5 + 10_000 * 0.5) / 10000);
    expect(beforePromotion.notes).toBeUndefined();
    // 活动声明了 models 限定：其它模型不享受覆盖。
    const otherModel = computePlanCredit({
      model: "glm-5.3", rules, usage, capturedAt: "2026-09-01T12:00:00+08:00",
    });
    expect(otherModel.creditCost).toBeUndefined();
    expect(otherModel.confidence).toBe("unverified");
  });

  test("智谱 ZCode 限时活动：67% 扣减叠加时段倍率，仅限 zcode 调用", () => {
    const rules = {
      formula: "token_weighted" as const,
      divisor: 10000,
      modelFactors: {"glm-5.3-flash": {input: 2.3, output: 8, cachedInput: 0.56}},
      peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00"}],
      promotions: [{
        from: "2026-06-01T00:00:00+08:00",
        to: "2026-12-31T23:59:59+08:00",
        models: ["glm-5.3-flash"],
        agents: ["zcode"],
        multiplier: 0.67,
        note: "ZCode 限时活动：全天 1.5 倍使用额度（67% 扣减）",
      }],
      quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
    };
    const base = 100_000 * 2.3 + 50_000 * 0.56 + 10_000 * 8;
    // ZCode 调用 + 非高峰：0.5 × 0.67 —— 与官方控制台实测闭合（5.74 案例）。
    const zcodeOffPeak = computePlanCredit({
      model: "glm-5.3-flash", rules, usage,
      capturedAt: "2026-09-02T13:00:00Z", agentName: "zcode",
    });
    expect(zcodeOffPeak.creditCost).toBeCloseTo(base / 10000 * 0.5 * 0.67);
    expect(zcodeOffPeak.confidence).toBe("official");
    expect(zcodeOffPeak.formula).toContain("×0.67");
    expect(zcodeOffPeak.formulaDetail).toContain("× 0.67");
    expect(zcodeOffPeak.formulaDetail).toContain("1.5 倍");
    // 非限定的其他 Agent 调用：只享受时段折扣，不命中活动。
    const claudeOffPeak = computePlanCredit({
      model: "glm-5.3-flash", rules, usage,
      capturedAt: "2026-09-02T13:00:00Z", agentName: "claude",
    });
    expect(claudeOffPeak.creditCost).toBeCloseTo(base / 10000 * 0.5);
    expect(claudeOffPeak.formula).not.toContain("活动");
    // ZCode 高峰调用：活动生效但无时段折扣。
    const zcodePeak = computePlanCredit({
      model: "glm-5.3-flash", rules, usage,
      capturedAt: "2026-09-02T07:00:00Z", agentName: "zcode",
    });
    expect(zcodePeak.creditCost).toBeCloseTo(base / 10000 * 0.67);
    // 活动仅限 flash：glm-5.3 不命中。
    const glm53 = computePlanCredit({
      model: "glm-5.3",
      rules: {
        ...rules,
        modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
        promotions: [{...rules.promotions[0]!, models: ["glm-5.3-flash"]}],
      },
      usage,
      capturedAt: "2026-09-02T13:00:00Z", agentName: "zcode",
    });
    expect(glm53.creditCost).toBeCloseTo((100_000 * 6.9 + 50_000 * 1.7 + 10_000 * 24) / 10000 * 0.5);
    expect(glm53.formulaDetail).not.toContain("限时活动");
  });

  test("token_weighted：factorOverride 三因子同值精确覆盖、不与基础系数相乘（机制回归，2026-09-30）", () => {
    // factorOverride 直接覆盖对应系数、不与基础系数相乘（区别于 creditMultiplier 连乘语义）；
    // cachedInput 覆盖因子为 2026-09-30 扩展，配套三因子同值场景回归（示例数值取自腾讯
    // tc-code-latest 活动 11/11/11 vs 基准 19.8，该模型已于同日按用户裁决移出目录）。
    const result = computePlanCredit({
      model: "tc-code-latest",
      rules: {
        formula: "token_weighted",
        divisor: 1_000_000,
        unit: "积分",
        modelFactors: {"tc-code-latest": {input: 19.8, output: 19.8, cachedInput: 19.8}},
        promotions: [{
          from: "2026-09-01T00:00:00+08:00",
          to: "2026-09-30T23:59:59+08:00",
          models: ["tc-code-latest"],
          input: 11,
          output: 11,
          cachedInput: 11,
          label: "官方限时5折（Auto/tc-code-latest）",
        }],
      },
      rates: {input: 0, output: 0},
      usage: {inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 500_000},
      capturedAt: "2026-09-15T12:00:00+08:00",
    });
    expect(result.creditCost).toBeCloseTo((1_000_000 * 11 + 2_000_000 * 11 + 500_000 * 11) / 1_000_000, 6);
    expect(result.formulaDetail).toContain("× 11");
    expect(result.formula).toContain("×11");
  });

  test("火山缺抵扣系数时不折算并标记 unverified", () => {
    const result = computePlanCredit({
      model: "doubao-seed-2.0-pro",
      rules: {
        formula: "afp_weighted",
        currency: "CNY",
        divisor: 10000,
        modelFactors: {"glm-5.3": {input: 4.5, output: 4.5}},
        quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
      },
      usage,
      capturedAt: "2026-08-20T10:00:00+08:00",
    });
    expect(result.creditCost).toBeUndefined();
    expect(result.confidence).toBe("unverified");
    expect(result.unit).toBe("AFP");
    expect(result.notes).toContain("doubao-seed-2.0-pro");
  });
});

describe("套餐限时活动 to 可空（2026-09-08 无限期语义）", () => {
  test("to 缺省 = 官方未公布截止：from 之后任意时刻仍命中活动倍率", () => {
    const result = computePlanCredit({
      model: "glm-5.3",
      rules: {
        formula: "token_weighted",
        divisor: 10000,
        modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
        promotions: [{from: "2026-06-01T00:00:00+08:00", agents: ["zcode"], multiplier: 0.67}],
        quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
      },
      usage,
      capturedAt: "2099-01-01T10:00:00+08:00",
      agentName: "zcode",
    });
    expect(result.creditCost).toBeCloseTo(((100_000 * 6.9 + 50_000 * 1.7 + 10_000 * 24) / 10000) * 0.67);
    expect(result.formula).toContain("×0.67");
  });

  test("to 缺省但未到 from 不命中；agent 不匹配不命中", () => {
    const rules = {
      formula: "token_weighted" as const,
      divisor: 10000,
      modelFactors: {"glm-5.3": {input: 6.9, output: 24, cachedInput: 1.7}},
      promotions: [{from: "2026-06-01T00:00:00+08:00", agents: ["zcode"], multiplier: 0.67}],
      quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h" as const}],
    };
    const tooEarly = computePlanCredit({model: "glm-5.3", rules, usage, capturedAt: "2026-01-01T10:00:00+08:00", agentName: "zcode"});
    expect(tooEarly.formula).not.toContain("活动");
    const wrongAgent = computePlanCredit({model: "glm-5.3", rules, usage, capturedAt: "2099-01-01T10:00:00+08:00", agentName: "codex"});
    expect(wrongAgent.formula).not.toContain("活动");
  });
});

describe("套餐限时活动每日时间窗（2026-09-08 错峰活动）", () => {
  const nightWindows = [{start: "23:00", end: "24:00"}, {start: "00:00", end: "09:00"}];
  const base = 100_000 * 2.3 + 50_000 * 0.56 + 10_000 * 8;
  const nightRules = {
    formula: "token_weighted" as const,
    divisor: 10000,
    timezone: "Asia/Shanghai",
    modelFactors: {"glm-5.3-flash": {input: 2.3, output: 8, cachedInput: 0.56}},
    peakWindows: [{days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00"}],
    promotions: [
      {
        from: "2026-09-03T00:00:00+08:00",
        to: "2026-09-21T09:00:00+08:00",
        models: ["glm-5.3-flash"],
        agents: ["zcode"],
        windows: nightWindows,
        multiplier: 0,
        note: "夜间畅用：ZCode 额度消耗为 0",
      },
      {
        from: "2026-09-03T00:00:00+08:00",
        to: "2026-09-21T09:00:00+08:00",
        models: ["glm-5.3-flash"],
        windows: nightWindows,
        multiplier: 0.5,
        unverified: true,
        note: "夜间畅用：其他 Agent 额度翻倍 = 标准扣减再 ×0.5",
      },
      {
        from: "2026-06-01T00:00:00+08:00",
        to: "2026-12-31T23:59:59+08:00",
        models: ["glm-5.3-flash"],
        agents: ["zcode"],
        multiplier: 0.67,
        note: "ZCode 常驻活动：全天 1.5 倍使用额度（67% 扣减）",
      },
    ],
    quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
  };

  test("窗口内其他 Agent：非高峰 0.5 × 活动 0.5 = 基础积分 25%", () => {
    // 2026-09-10 02:00（+08:00）= 9/9 18:00Z：错峰窗口内且为非高峰。
    const result = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-09-10T02:00:00+08:00", agentName: "claude",
    });
    expect(result.creditCost).toBeCloseTo(base / 10000 * 0.5 * 0.5);
    expect(result.formula).toContain("×0.5");
    expect(result.confidence).toBe("unverified");
    expect(result.formulaDetail).toContain("额度翻倍");
  });

  test("窗口内 ZCode：×0 畅用，积分消耗为 0（排在常驻 0.67 之前命中）", () => {
    const result = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-09-10T02:00:00+08:00", agentName: "zcode",
    });
    expect(result.creditCost).toBe(0);
    expect(result.formula).toContain("×0");
    expect(result.formulaDetail).toContain("× 0");
  });

  test("窗口外（同日活动区间内）：错峰条目跳过，回落常驻规则", () => {
    // 2026-09-10 12:00（+08:00）：错峰窗口外 → ZCode 落常驻 0.67，其他 Agent 无活动；
    // 12:00 不在高峰窗口 14:00~18:00 内，时段倍率仍为非高峰 0.5。
    const zcode = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-09-10T12:00:00+08:00", agentName: "zcode",
    });
    expect(zcode.creditCost).toBeCloseTo(base / 10000 * 0.5 * 0.67);
    expect(zcode.formula).toContain("×0.67");
    const claude = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-09-10T12:00:00+08:00", agentName: "claude",
    });
    expect(claude.creditCost).toBeCloseTo(base / 10000 * 0.5);
    expect(claude.formula).not.toContain("活动");
  });

  test("活动日期区间外：窗口形状不影响，全部不命中", () => {
    // 2026-10-01 02:00（+08:00）：落在每日窗口内但超出活动 to。
    const result = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-10-01T02:00:00+08:00", agentName: "claude",
    });
    expect(result.formula).not.toContain("活动");
  });

  test("窗口边界：23:00 含起点、09:00 不含终点、跨午夜拆两段全覆盖", () => {
    // 23:00 整（+08:00）已入窗；09:00 整（+08:00）已出窗。
    const at2300 = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-09-10T23:00:00+08:00", agentName: "claude",
    });
    expect(at2300.formula).toContain("×0.5");
    const at0900 = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-09-10T09:00:00+08:00", agentName: "claude",
    });
    expect(at0900.formula).not.toContain("活动");
    // 23:30 与 00:30 分属两段窗口，均命中。
    for (const instant of ["2026-09-10T23:30:00+08:00", "2026-09-10T00:30:00+08:00"]) {
      const hit = computePlanCredit({
        model: "glm-5.3-flash", rules: nightRules, usage,
        capturedAt: instant, agentName: "claude",
      });
      expect(hit.formula).toContain("×0.5");
    }
  });

  test("窗口判定使用 rules.timezone：同一时刻东八区入窗、UTC 时区规则未入窗", () => {
    // 2026-09-10 02:00+08:00 = 9/9 18:00Z：Asia/Shanghai 规则入窗。
    const shanghai = computePlanCredit({
      model: "glm-5.3-flash", rules: nightRules, usage,
      capturedAt: "2026-09-09T18:00:00Z", agentName: "claude",
    });
    expect(shanghai.formula).toContain("×0.5");
    // 时区改为 UTC 后，02:00+08:00 = 前一日 18:00 UTC，不在 23:00~24:00/00:00~09:00（UTC）内。
    const utc = computePlanCredit({
      model: "glm-5.3-flash",
      rules: {...nightRules, timezone: "UTC"},
      usage,
      capturedAt: "2026-09-09T18:00:00Z", agentName: "claude",
    });
    expect(utc.formula).not.toContain("活动");
  });
});
