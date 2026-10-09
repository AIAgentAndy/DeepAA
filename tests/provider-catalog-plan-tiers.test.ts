import {describe, expect, test} from "vitest";
import {matchPlanTierMonthlyFee} from "../src/lib/provider-catalog/plan-tiers.js";
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
