import {describe, expect, test} from "vitest";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {computePlanCreditForLedger} from "../src/lib/ingestion/exchange-processor.js";
import {readTargetBillingMetadata} from "../src/lib/ingestion/target-metadata.js";
import {computePlanEstimateForLedger} from "../src/lib/db/plan-real-cost.js";
import type {ModelPriceEntry, PricingConfigV2} from "../src/lib/pricing.js";

/**
 * 火山 Coding Plan「无公开积分公式」处理（2026-10-07 用户确认）：
 * 官方未公开 Coding Plan 的公式/系数/额度（AFP 抵扣规则页属 Agent Plan 计费说明），
 * coding 预设声明 planCreditFormula=none → 派生端不落积分列 → 估算走市价参考 +
 * 一期量纲守卫（percent 额度 → market_blocked）→ 二期额度差分回填。
 * Agent Plan / 智谱 / OpenCode Go 等精确公式链路必须零影响（回归保护用例）。
 */

const afpEntry: ModelPriceEntry = {
  id: "catalog:volcengine-plan:deepseek-v4.1-flash",
  vendor: "volcengine-plan",
  runtimeModelId: "deepseek-v4.1-flash",
  patterns: ["deepseek-v4.1-flash"],
  pricing: {input: 2, output: 8, cachedInput: 0.2},
  currency: "CNY",
  confidence: "official",
  planCreditRules: {
    formula: "afp_weighted",
    unit: "AFP",
    divisor: 10000,
    quotaWindows: [{id: "monthly", label: "月度", reset: "monthly"}],
    modelFactors: {"deepseek-v4.1-flash": {input: 2.5, output: 2.5}},
  },
};

const config: PricingConfigV2 = {
  version: 2,
  currency: "CNY",
  unit: "per_million_tokens",
  models: [afpEntry],
  fx: {rates: {"USD/CNY": 7}, asOf: "2026-09-30", source: "test"},
};

const usage = {inputTokens: 1157, cacheReadTokens: 39040, outputTokens: 2065, totalTokens: 42262};
const costStub = {
  inputTokens: 0,
  outputTokens: 0,
  currency: "CNY" as const,
  priced: true,
  pricingSnapshot: {
    unit: "USD_per_million_tokens" as const,
    matchStrategy: "pattern" as const,
    priceEntryId: afpEntry.id,
    baseRates: {input: 2, output: 8, cachedInput: 0.2},
    rateMultiplier: 1,
  },
};

describe("computePlanCreditForLedger：预设级「无积分公式」短路", () => {
  test("coding 预设（planCreditFormula=none）即使条目带 AFP 规则也不落积分列", () => {
    const result = computePlanCreditForLedger(
      {pricingConfig: config, model: "deepseek-v4.1-flash", capturedAt: "2026-10-06T16:00:00Z", billingChannel: "plan", targetPlanCreditFormula: "none"},
      costStub,
      usage,
    );
    expect(result.planCreditCost).toBeUndefined();
    expect(result.planCreditUnit).toBeUndefined();
    expect(result.planCreditFormulaVersion).toBeUndefined();
  });

  test("回归保护：同一条目，无声明（Agent Plan / 缺省）时照常按 AFP 公式折算", () => {
    const result = computePlanCreditForLedger(
      {pricingConfig: config, model: "deepseek-v4.1-flash", capturedAt: "2026-10-06T16:00:00Z", billingChannel: "plan"},
      costStub,
      usage,
    );
    // 基础系数 2.5/2.5（无活动）：((1157 + 39040) + 2065) × 2.5 = 105655，÷10000 = 10.5655 AFP。
    // （用户事故行的 5.28275 是叠加「官方限时五折」活动系数 1.25 后的结果。）
    expect(result.planCreditUnit).toBe("AFP");
    expect(result.planCreditCost).toBeCloseTo(10.5655, 10);
  });

  test("按量通道与预设短路互不干扰（payg 依旧不折算积分）", () => {
    const result = computePlanCreditForLedger(
      {pricingConfig: config, model: "deepseek-v4.1-flash", capturedAt: "2026-10-06T16:00:00Z", billingChannel: "pay_as_you_go", targetPlanCreditFormula: "none"},
      costStub,
      usage,
    );
    expect(result.planCreditUnit).toBeUndefined();
  });
});

describe("coding 预设短路后的估算形态：市价参考 + percent 额度 → market_blocked", () => {
  test("积分列为空 + percent 快照分母 → 一期量纲守卫降级 unavailable（可被差分回填）", () => {
    // 市价参考成本：(1157×2 + 39040×0.2 + 2065×8)/1M ≈ 0.026642 CNY。
    const referenceCostNano = Math.round(0.026642 * 1e9);
    const estimate = computePlanEstimateForLedger({
      billingChannel: "plan",
      // coding 预设短路后的形态：无积分 unit，分子走市价参考。
      planCreditCost: undefined,
      planCreditUnit: undefined,
      referenceCostNano,
      monthlyFee: 49.9,
      feeCurrency: "CNY",
      // 火山 Coding Plan 套餐快照只有百分比（total=100, unit=percent）。
      quotaTotal: 100,
      quotaUnit: "percent",
      windowDays: 30,
      windowLabel: "monthly",
      fxUsdCny: 7,
    });
    expect(estimate.status).toBe("unavailable");
    const detail = JSON.parse(estimate.detailJson!) as Record<string, unknown>;
    expect(detail.consumedBasis).toBe("market_blocked");
    expect(detail.quotaUnit).toBe("percent");
    // 绝不能出现旧 Bug 形态：积分分子 ÷ percent 分母 的伪 estimated。
    expect(estimate.nano).toBeUndefined();
  });
});

describe("readTargetBillingMetadata：planCreditFormula 解析与 URL 兜底", () => {
  test("显式 presetId 命中 coding 预设；无 presetId 的手工目标按 URL 反查兜底且不回写 presetId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepaa-plancredit-"));
    try {
      await writeFile(join(dir, "proxy-config.json"), JSON.stringify({
        version: 3,
        revision: 1,
        agentConnections: {},
        targets: [
          {id: "coding-explicit", presetId: "volcengine-coding-plan", billingChannel: "plan", openaiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3"},
          {id: "coding-url-only", billingChannel: "plan", openaiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3"},
          {id: "agent-explicit", presetId: "volcengine-plan", billingChannel: "plan", openaiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"},
          {id: "deepseek-custom", billingChannel: "pay_as_you_go", openaiUrl: "https://api.deepseek.com"},
        ],
      }));
      const meta = await readTargetBillingMetadata(dir);
      expect(meta.get("coding-explicit")?.planCreditFormula).toBe("none");
      expect(meta.get("coding-url-only")?.planCreditFormula).toBe("none");
      // URL 兜底只作用于积分折算抑制，不得扩大其它按 presetId 判定的行为面。
      expect(meta.get("coding-url-only")?.presetId).toBeUndefined();
      expect(meta.get("agent-explicit")?.planCreditFormula).toBeUndefined();
      expect(meta.get("deepseek-custom")?.planCreditFormula).toBeUndefined();
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
