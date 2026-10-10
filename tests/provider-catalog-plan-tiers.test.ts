import {describe, expect, test} from "vitest";
import {matchPlanTierMonthlyFee, resolvePlanTierFee} from "../src/lib/provider-catalog/plan-tiers.js";
import type {ProviderPlanTier} from "../src/lib/provider-catalog/types.js";

const tiers: ProviderPlanTier[] = [
  {id: "lite", name: "Lite", monthlyFee: 20},
  {id: "pro", name: "Pro", monthlyFee: 100},
  {id: "max", name: "Max", monthlyFee: 200},
];

describe("套餐档位月费匹配", () => {
  test("精确匹配档位名（大小写与空白不敏感）", () => {
    expect(matchPlanTierMonthlyFee(tiers, ["lite"])).toBe(20);
    expect(matchPlanTierMonthlyFee(tiers, [" PRO "])).toBe(100);
  });

  test("套餐名包含唯一档位名时按包含命中（如智谱返回的档位 level）", () => {
    expect(matchPlanTierMonthlyFee(tiers, ["智谱 Coding Plan Pro 剩余额度"])).toBe(100);
  });

  test("多快照按顺序优先匹配：先 exact 后包含", () => {
    expect(matchPlanTierMonthlyFee(tiers, [null, undefined, "", "Max"])).toBe(200);
  });

  test("歧义与未命中返回 undefined；短档位名不做包含匹配", () => {
    // “Kimi For Coding”同时包含命中两个档位 → 歧义。
    const kimiTiers: ProviderPlanTier[] = [
      {name: "Kimi For Coding 尝鲜版", monthlyFee: 19},
      {name: "Kimi For Coding 标准版", monthlyFee: 49},
    ];
    expect(matchPlanTierMonthlyFee(kimiTiers, ["Kimi For Coding"])).toBeUndefined();
    expect(matchPlanTierMonthlyFee(tiers, ["OpenCode Go"])).toBeUndefined();
    // 归一化后 ≤2 字符的档位名不做包含匹配，避免子串误命中。
    const shortTiers: ProviderPlanTier[] = [{name: "P5", monthlyFee: 59}];
    expect(matchPlanTierMonthlyFee(shortTiers, ["火山方舟 Agent Plan P5"])).toBeUndefined();
  });

  test("空输入直接返回 undefined", () => {
    expect(matchPlanTierMonthlyFee([], ["Pro"])).toBeUndefined();
    expect(matchPlanTierMonthlyFee(tiers, [])).toBeUndefined();
    expect(matchPlanTierMonthlyFee(tiers, [null, "  "])).toBeUndefined();
  });
});

describe("付款周期折算月价（2026-10-10 智谱 Coding Plan）", () => {
  const zhipuTiers: ProviderPlanTier[] = [
    {id: "lite", name: "Lite", monthlyFee: 118, billingCycles: {monthly: 118, quarterly: 94.4, yearly: 82.6}},
    {id: "pro", name: "Pro", monthlyFee: 538, billingCycles: {monthly: 538, quarterly: 430.4, yearly: 376.6}},
    {id: "max", name: "Max", monthlyFee: 1078, billingCycles: {monthly: 1078, quarterly: 862.4, yearly: 754.6}},
  ];
  const partialCycles: ProviderPlanTier[] = [
    {id: "go", name: "Kimi For Coding go", monthlyFee: 49, billingCycles: {monthly: 49, yearly: 39}},
  ];

  test("resolvePlanTierFee 按周期取折算月价；档位未维护该周期或无周期时回退按月价", () => {
    expect(resolvePlanTierFee(zhipuTiers[1]!, "quarterly")).toBe(430.4);
    expect(resolvePlanTierFee(zhipuTiers[1]!, "yearly")).toBe(376.6);
    expect(resolvePlanTierFee(zhipuTiers[1]!, "monthly")).toBe(538);
    expect(resolvePlanTierFee(zhipuTiers[1]!)).toBe(538);
    // Kimi 未维护按季价 → 回退按月价。
    expect(resolvePlanTierFee(partialCycles[0]!, "quarterly")).toBe(49);
    expect(resolvePlanTierFee(partialCycles[0]!, "yearly")).toBe(39);
    // 无 billingCycles 档位任意周期都回退 monthlyFee。
    expect(resolvePlanTierFee(tiers[1]!, "quarterly")).toBe(100);
  });

  test("免费档 0 是合法价格，不得当作缺失回退按月价", () => {
    const freeTier: ProviderPlanTier = {id: "free", name: "Free", monthlyFee: 0, billingCycles: {monthly: 0, yearly: 0}};
    expect(resolvePlanTierFee(freeTier, "yearly")).toBe(0);
  });

  test("matchPlanTierMonthlyFee 传周期时按折算月价返回，缺省保持按月价（兼容旧行为）", () => {
    expect(matchPlanTierMonthlyFee(zhipuTiers, ["智谱 Coding Plan Pro 剩余额度"], "quarterly")).toBe(430.4);
    expect(matchPlanTierMonthlyFee(zhipuTiers, ["PRO"], "yearly")).toBe(376.6);
    expect(matchPlanTierMonthlyFee(zhipuTiers, ["PRO"])).toBe(538);
    expect(matchPlanTierMonthlyFee(zhipuTiers, ["Pro"], "monthly")).toBe(538);
    // 歧义保护与周期无关，仍不回填。
    expect(matchPlanTierMonthlyFee(zhipuTiers, ["Coding Plan"], "quarterly")).toBeUndefined();
  });
});
