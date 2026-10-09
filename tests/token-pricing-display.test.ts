import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import {
  actualCostDetailFormula,
  costComponentLines,
  costDetailFormula,
  multipliedCostDetailFormula,
  planEstimateConversionNote,
  formatCacheHitRateFormula,
  formatDetailMoney,
  formatSummaryTokenAmount,
  formatSummaryMoney,
  formatTokenAmount,
  formatTotalTokenMillions,
  formatUnitPrice,
  formatVendorMoney,
  peakWindowText,
  scheduleBadge,
  scheduleWindowText,
} from "../src/lib/token-pricing-display.js";
import { resolveLongContextRates } from "../src/lib/pricing.js";

describe("Token 价格页展示格式", () => {
  test("汇总 Token 固定用 M，明细 token 按 K/M 自适应", () => {
    expect(formatTotalTokenMillions(14_321_157)).toBe("14.32M");
    expect(formatTokenAmount(999)).toBe("999");
    expect(formatTokenAmount(1_150)).toBe("1.15K");
    expect(formatTokenAmount(11_590_000)).toBe("11.59M");
  });

  test("首页和 Token 价格页汇总 Token 使用相同的 K/M 阈值", () => {
    expect(formatSummaryTokenAmount(19_804)).toBe("19.80K");
    expect(formatSummaryTokenAmount(999_999)).toBe("1000.00K");
    expect(formatSummaryTokenAmount(1_000_000)).toBe("1.00M");
  });

  test("缓存命中率展示计算过程", () => {
    expect(formatCacheHitRateFormula(400_000, 11_590_000)).toBe("11.59M/11.99M 96.7%");
  });

  test("汇总金额保留 4 位，明细金额保留 6 位", () => {
    expect(formatSummaryMoney(0.8308412)).toBe("0.8308");
    expect(formatSummaryMoney(11.86916)).toBe("11.8692");
    expect(formatDetailMoney(0.00321622)).toBe("0.003216");
    expect(formatDetailMoney(0.0459464)).toBe("0.045946");
  });

  test("金额格式化支持币种符号（2026-09-28）：人民币终值 ￥、原币 $、未知不加符号", () => {
    expect(formatSummaryMoney(0.8308412, "CNY")).toBe("￥0.8308");
    expect(formatDetailMoney(0.00321622, "USD")).toBe("$0.003216");
    expect(formatUnitPrice(0.3, "USD")).toBe("$0.3/M");
    expect(formatUnitPrice(2, "CNY")).toBe("￥2/M");
    expect(formatVendorMoney(1.5, false, "CNY")).toBe("￥1.5000");
    expect(formatVendorMoney(0, false, "CNY")).toBe("-");
  });

  test("有 scheduleLabel 才返回标签，无则返回 null", () => {
    expect(scheduleBadge("闲时")).toBe("闲时");
    expect(scheduleBadge("高峰")).toBe("高峰");
    expect(scheduleBadge(undefined)).toBeNull();
  });

  test("生效窗口文案来自 priceSchedules", () => {
    expect(scheduleWindowText([{
      label: "闲时",
      windows: [{days: [0, 1, 2, 3, 4], start: "12:00", end: "14:00"}],
      rates: {input: 0.22, output: 0.66},
    }])).toBe("闲时：周一至周五 12:00-14:00");
    expect(scheduleWindowText(undefined)).toBeNull();
  });
});

describe("Token 价格页受限提示条（2026-09-18 用户确认）", () => {
  test("下拉候选被安全上限截断不再渲染提示条，也不占提示条容器", async () => {
    const content = await readFile("src/components/token-pricing-content.tsx", "utf8");
    // 该文案已下线（看着别扭且容易误解成「查询结果被截断」）。
    expect(content).not.toContain("筛选下拉项已按安全上限截断");
    // limited.facets 仍保留在响应里作为可观测字段，只是不再触发提示条容器。
    const helper = content.slice(
      content.indexOf("function hasLimitWarning("),
      content.indexOf("function formatCacheHitRateValue("),
    );
    expect(helper).not.toContain("limited.facets");
    expect(helper).toContain("state.limited.sortWindow");
    expect(helper).toContain("state.limited.ledgerScan");
    expect(helper).toContain("state.limited.durationHydration");
  });
});

describe("长上下文档位展示（2026-09-22 修复：公式浮窗此前漏套 ×2/×1.5）", () => {
  const tierRates = {
    input: 5,
    output: 30,
    cachedInput: 0.5,
    cacheWrite: 7.5,
    longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5},
  };

  test("resolveLongContextRates：判定量严格大于阈值才整单换档", () => {
    const matched = resolveLongContextRates(tierRates, 305822);
    expect(matched?.rates.input).toBe(10);
    expect(matched?.rates.output).toBe(45);
    expect(matched?.rates.cachedInput).toBe(1);
    expect(matched?.rates.cacheWrite).toBe(15);
    expect(matched?.match).toEqual({
      thresholdTokens: 272000,
      contextTokens: 305822,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    });
    expect(resolveLongContextRates(tierRates, 272000)).toBeUndefined();
    expect(resolveLongContextRates({...tierRates, longContext: undefined}, 305822)).toBeUndefined();
  });

  test("声明绝对档位价时优先绝对价，未声明字段仍按倍率换算", () => {
    const matched = resolveLongContextRates({
      input: 5,
      output: 30,
      longContext: {
        thresholdTokens: 272000,
        inputMultiplier: 2,
        outputMultiplier: 1.5,
        rates: {input: 12},
      },
    }, 300000);
    expect(matched?.rates.input).toBe(12);
    expect(matched?.rates.output).toBe(45);
  });

  test("公式浮窗携带档位标注行，分项与账本金额自洽；未命中行无标注", () => {
    const item = {
      inputTokens: 305822,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 3064,
      inputUnitPrice: 10,
      outputUnitPrice: 45,
      inputCost: 3.05822,
      outputCost: 0.13788,
      vendorCost: 3.1961,
      actualCost: 0.479415,
      rateMultiplier: 0.15,
      longContextTier: {thresholdTokens: 272000, contextTokens: 305822, inputMultiplier: 2, outputMultiplier: 1.5},
    };
    const lines = costComponentLines(item);
    expect(lines[0]).toContain("长上下文档位");
    expect(lines[0]).toContain("305,822 > 272,000");
    const vendorFormula = costDetailFormula(item);
    expect(vendorFormula).toContain("× 10/M");
    expect(vendorFormula).toContain("× 45/M");
    expect(vendorFormula).toContain("供应商成本合计 3.196100");
    expect(actualCostDetailFormula(item)).toContain("× 价格倍率 0.15");
    const plain = costComponentLines({...item, longContextTier: undefined});
    expect(plain[0]).toContain("非缓存输入");
    expect(plain).toHaveLength(4);
  });

  test("结算系数非 1 时公式追加折算行；1:1 结算不追加（2026-09-23 人民币口径）", () => {
    const item = {
      inputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      inputUnitPrice: 5,
      inputCost: 5,
      vendorCost: 5,
      actualCost: 20,
      rateMultiplier: 4,
      currency: "USD",
      fxRateToCny: 0.0625,
      vendorCostCny: 0.3125,
      actualCostCny: 1.25,
    };
    const vendorFormula = costDetailFormula(item);
    // 供应商成本 = 原币种分解视图（2026-09-23 用户确认）：不追加结算系数折算行。
    expect(vendorFormula).toContain("供应商成本合计 5.000000");
    expect(vendorFormula).not.toContain("结算系数");
    const actualFormula = actualCostDetailFormula(item);
    expect(actualFormula).toContain("× 价格倍率 4");
    expect(actualFormula).toContain("估算真实成本 20.000000");
    expect(actualFormula).toContain("× 结算系数 0.0625");
    expect(actualFormula).toContain("USD 牌价 → 人民币");
    expect(actualFormula).toContain("人民币合计 1.250000");
    // 按量倍率后成本 = 原币种分解视图（2026-09-23 会话追踪价格成本面板复用）：
    // 有倍率行但无结算系数折算行。
    const multiplied = multipliedCostDetailFormula(item);
    expect(multiplied).toContain("× 价格倍率 4");
    expect(multiplied).toContain("按量倍率后成本 20.000000");
    expect(multiplied).not.toContain("结算系数");
    // 1:1 结算（系数缺省或恰为 1）不追加折算行，公式与旧格式一致。
    expect(costDetailFormula({...item, fxRateToCny: 1, vendorCostCny: 5, actualCostCny: 20}))
      .not.toContain("结算系数");
    expect(costDetailFormula({...item, fxRateToCny: undefined, vendorCostCny: undefined, actualCostCny: undefined}))
      .not.toContain("结算系数");
  });

  test("套餐积分→金额换算链：月费×消耗比率×窗口天数，入账冻结（2026-09-23 共享）", () => {
    const note = planEstimateConversionNote(
      {
        monthlyFee: 430.4,
        consumed: 41.4891872,
        consumedBasis: "credits",
        quotaTotal: 60000,
        windowDays: 7,
        windowLabel: "weekly",
      },
      0.06944368,
      "CNY",
    );
    expect(note).toBeDefined();
    expect(note).toContain("本请求消耗积分 41.489187");
    expect(note).toContain("÷ 窗口总额度 60,000（weekly）");
    expect(note).toContain("× 套餐月费 430.4 CNY");
    expect(note).toContain("× 窗口天数 7/30");
    expect(note).toContain("≈ 估算真实成本（套餐成本估算） ￥0.069444（人民币，入账时冻结）");
    // 关键字段缺失（历史行无折算明细）：返回 undefined，消费端跳过换算段不虚构。
    expect(planEstimateConversionNote({monthlyFee: 430.4}, 0.069, "CNY")).toBeUndefined();
  });

  test("额度差分换算链（2026-10-09 解锁）：quota_delta detail 不带 consumed/quotaTotal 也能渲染完整公式", () => {
    /* 真实事故样本（chatgpt.com 2026-10-09）：$18.41 月费、周窗 1%→2%、
       7 请求按市价份额分摊、本行份额 11.21%。此前两处解析器剥掉差分字段 +
       入口守卫要求 consumed/quotaTotal → 公式永不渲染（死代码）。 */
    const note = planEstimateConversionNote(
      {
        monthlyFee: 18.41,
        consumedBasis: "quota_delta",
        currency: "USD",
        fxUsdCny: 6.7351,
        windowLabel: "weekly",
        windowDays: 7,
        usedFrom: 1,
        usedTo: 2,
        total: 100,
        deltaUsed: 1,
        periodFrom: "2026-10-09T02:44:54.540Z",
        periodTo: "2026-10-09T02:50:07.526Z",
        shareOfMarketCost: 0.11213254432142306,
      },
      0.032442,
      "USD",
    );
    expect(note).toBeDefined();
    expect(note).toContain("额度差分估算（近似）：周期 2026-10-09 02:44 UTC → 2026-10-09 02:50 UTC");
    expect(note).toContain("窗口 周窗 额度消耗 1% → 2%（Δ 1 ÷ 总额度 100）");
    expect(note).toContain("周期价值 ≈ 月费 18.41 USD（入账汇率 6.7351） × 7/30 天 × 消耗比例 = ￥0.289317");
    expect(note).toContain("本请求按市价份额分摊：占周期内 11.213254% → ￥0.032442");
    expect(note).toContain("≈ 估算真实成本（额度差分估算） ￥0.032442（人民币，入账时冻结）");
    // 差分关键字段缺失（旧口径行）：不虚构公式。
    expect(planEstimateConversionNote({consumedBasis: "quota_delta", monthlyFee: 18.41, windowDays: 7}, 0.03, "USD"))
      .toBeUndefined();
  });

  test("额度差分全链路 + 查看者时区（2026-10-09 B2/B3）：周期市价反推、四项单价×token 分解、份额除式", () => {
    /* 用户真实样本（chatgpt.com 2026-10-09 15:51→15:56 东八区）：周窗 3%→4%、
       周期 7 条请求、本行市价 ￥0.270708、份额 14.739997%。 */
    const note = planEstimateConversionNote(
      {
        monthlyFee: 18.41,
        consumedBasis: "quota_delta",
        currency: "USD",
        fxUsdCny: 6.7351,
        windowLabel: "weekly",
        windowDays: 7,
        usedFrom: 3,
        usedTo: 4,
        total: 100,
        deltaUsed: 1,
        periodFrom: "2026-10-09T07:51:33.732Z",
        periodTo: "2026-10-09T07:56:35.161Z",
        shareOfMarketCost: 0.1473999744178803,
        requestCount: 7,
      },
      0.042645384,
      "USD",
      {
        timeZone: "Asia/Shanghai",
        rowMarketCny: 0.270708,
        marketCurrency: "USD",
        marketComponents: [
          {label: "非缓存输入", unitPrice: 5, tokens: 19_108, cost: 0.09554},
          {label: "缓存读取", unitPrice: 0.5, tokens: 40_064, cost: 0.020032},
          {label: "缓存写入", unitPrice: 6.25, tokens: 0, cost: 0},
          {label: "输出", unitPrice: 30, tokens: 2_330, cost: 0.0699},
        ],
      },
    );
    expect(note).toBeDefined();
    if (!note) return;
    // 时区：东八区展示（15:51），不再固定 UTC。
    expect(note).toContain("周期 2026-10-09 15:51 UTC+8 → 2026-10-09 15:56 UTC+8");
    expect(note).toContain("周期内共 7 条请求 · 市价合计 ￥1.836554");
    // 四项分解：单价 × token 数（零 token 项跳过）。
    expect(note).toContain("本请求市价 ￥0.270708（原币种分解，见下行）：");
    expect(note).toContain("非缓存输入 $0.09554 = $5/M × 19,108 tok");
    expect(note).toContain("缓存读取 $0.020032 = $0.5/M × 40,064 tok");
    expect(note).toContain("输出 $0.0699 = $30/M × 2,330 tok");
    expect(note).not.toContain("缓存写入");
    // 份额除式：本行 ÷ 周期合计 = 14.74% → 周期价值 × 份额。
    expect(note).toContain("份额 = ￥0.270708 ÷ ￥1.836554 = 14.739997% → ￥0.289317 × 14.739997% = ￥0.042645");
  });

  test("比率兜底与 reset 残差换算链（2026-10-09 A1/A2）", () => {
    const ratio = planEstimateConversionNote(
      {
        consumedBasis: "ratio_fallback",
        monthlyFee: 18.41,
        fallbackRatio: 0.112,
        evidenceRows: 19,
        evidenceMarketCny: 5.631,
        evidenceEstimateCny: 0.6307,
      },
      0.39,
      "CNY",
      {timeZone: "Asia/Shanghai", rowMarketCny: 3.4905},
    );
    expect(ratio).toContain("历史窗口 · 比率兜底（近似）：本请求早于最早的额度快照，无法差分归属");
    expect(ratio).toContain("依据：该目标已结算 19 条请求，市价合计 ￥5.631 → 估算合计 ￥0.6307");
    expect(ratio).toContain("本请求市价 ￥3.4905 × 比率 0.112");
    expect(ratio).toContain("≈ 估算真实成本（比率兜底估算） ￥0.39");
    const residual = planEstimateConversionNote(
      {
        consumedBasis: "reset_residual",
        monthlyFee: 18.41,
        currency: "USD",
        fxUsdCny: 6.7351,
        windowLabel: "weekly",
        windowDays: 7,
        usedTo: 4,
        total: 100,
        midpointPercent: 0.5,
        periodFrom: "2026-10-02T00:00:00.000Z",
        periodTo: "2026-10-09T15:51:31.000Z",
        shareOfMarketCost: 0.32,
      },
      0.0926,
      "USD",
      {timeZone: "Asia/Shanghai"},
    );
    expect(residual).toContain("窗口重置残差 · 中点估算（近似）");
    expect(residual).toContain("窗口 周窗 关闭时额度消耗 4%，整数刻度下最后一段消耗 ∈ [4%, 5%)，取中点 0.5% 估算");
    expect(residual).toContain("残差价值 ≈ 月费 18.41 USD（入账汇率 6.7351） × 7/30 天 × 0.5/100 = ￥0.144659");
    expect(residual).toContain("占周期内 32% → ￥0.046291");
    // 关键依据缺失不虚构。
    expect(planEstimateConversionNote({consumedBasis: "ratio_fallback"}, 0.1)).toBeUndefined();
    expect(planEstimateConversionNote({consumedBasis: "reset_residual", monthlyFee: 18.41}, 0.1)).toBeUndefined();
  });

  test("market_share 逐步公式（2026-09-30）：每行写全「￥值 = $原值 × 入账汇率」换算与档位来源；旧行缺字段回退通用两行", () => {
    const marketDetail = {
      monthlyFee: 10,
      consumed: 0.064435,
      consumedBasis: "market_cny",
      consumedUsd: 0.009547,
      modelId: "deepseek-v4.1-flash",
      planTier: "go",
      monthlyLimitUsd: 60,
      quotaTotal: 404.934,
      windowDays: 30,
      windowLabel: "monthly",
      fxUsdCny: 6.7489,
    };
    const note = planEstimateConversionNote(marketDetail, 0.010739, "USD");
    expect(note).toContain("本请求消耗市价（美元额度口径，OpenCode Go） ￥0.064435 = $0.009547 ×（入账汇率 6.7489）");
    expect(note).toContain("÷ 窗口总额度 ￥404.934（monthly）= 模型 deepseek-v4.1-flash 对应月度额度 $60 ×（入账汇率 6.7489）");
    expect(note).toContain("× 套餐月费 ￥67.489 = Go 档位月费 $10 ×（入账汇率 6.7489）");
    expect(note).toContain("× 窗口天数 30/30");
    expect(note).toContain("≈ 估算真实成本（套餐成本估算） ￥0.010739（人民币，入账时冻结）");
    // 旧行（2026-09-30 前入账）缺四件套：回退通用文案，不虚构档位来源。
    const legacy = planEstimateConversionNote(
      {monthlyFee: 10, consumed: 0.064435, consumedBasis: "market_cny", quotaTotal: 404.934, windowDays: 30, windowLabel: "monthly", fxUsdCny: 6.7489},
      0.010739,
      "USD",
    );
    expect(legacy).toContain("本请求消耗市价（美元额度口径，OpenCode Go） 0.064435");
    expect(legacy).not.toContain("对应月度额度");
  });
});

describe("时段窗口按查看者时区展示（2026-09-30；目录维护官方原时区，展示换算缺省东八区）", () => {
  const deepseekUtcSchedules = [{
    timezone: "UTC",
    label: "闲时",
    windows: [
      {days: [0, 1, 2, 3, 4], start: "00:30", end: "08:30"},
      {days: [0, 1, 2, 3, 4], start: "16:30", end: "24:00"},
    ],
    rates: {input: 0.5, output: 1},
  }];

  test("不传目标时区：按目录声明时区（UTC）原样展示", () => {
    expect(scheduleWindowText(deepseekUtcSchedules)).toBe("闲时：周一至周五 00:30-08:30、16:30-24:00");
  });

  test("UTC → 东八区：跨午夜窗口拆到次日、按日重新分组", () => {
    // UTC 00:30-08:30 → +8 08:30-16:30（周一至周五）；UTC 16:30-24:00 → +8 次日 00:30-08:00（周二至周六）。
    expect(scheduleWindowText(deepseekUtcSchedules, "Asia/Shanghai"))
      .toBe("闲时：周一 08:30-16:30；周二至周五 00:30-08:00、08:30-16:30；周六 00:30-08:00");
  });

  test("高峰补集同样在目标时区计算", () => {
    expect(peakWindowText(deepseekUtcSchedules, "Asia/Shanghai")).toBe(
      "高峰：周一 00:00-08:30、16:30-24:00；周二至周五 00:00-00:30、08:00-08:30、16:30-24:00；周六 00:00-00:30、08:00-24:00；周日 00:00-24:00；其余时间为闲时",
    );
  });

  test("目标时区与声明时区相同：零偏移不改变结果", () => {
    expect(scheduleWindowText(deepseekUtcSchedules, "UTC")).toBe("闲时：周一至周五 00:30-08:30、16:30-24:00");
  });
});
