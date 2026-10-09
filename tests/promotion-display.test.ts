import {describe, expect, test} from "vitest";
import {activePaygPromotion, overlaySparseRates, type ModelPriceEntry} from "../src/lib/pricing.js";
import {
  activeDisplayPromotion,
  overlayDisplayRates,
  promotionWindowLabel,
} from "../src/lib/promotion-display.js";

/**
 * 展示端与入账端促销语义一致性守卫（2026-10-09 F7）：promotion-display.ts 为
 * 客户端复刻实现（pricing.ts 含 node:fs 不能进客户端 bundle），两边对同一输入
 * 必须给出同一命中结果与同一覆盖费率，防止展示价与入账价漂移。
 */

const entry: ModelPriceEntry = {
  id: "catalog:openai:gpt-5.6-sol",
  vendor: "openai",
  runtimeModelId: "gpt-5.6-sol",
  patterns: ["gpt-5.6-sol"],
  pricing: {input: 5, output: 30, cachedInput: 0.5, cacheWrite: 6.25},
  currency: "USD",
  confidence: "official",
  promotions: [
    {from: "2026-08-21T00:00:00+00:00", to: "2026-11-20T23:59:59.999Z", priceOverride: {input: 4, output: 20, cachedInput: 0.4, cacheWrite: 5}, label: "GPT-5.6 Sol 官方限时促销"},
    {from: "2026-12-01T00:00:00+00:00", to: "2026-12-31T23:59:59Z", priceOverride: {input: 3, output: 15}, label: "年末促销"},
  ],
};

const instantInside = new Date("2026-10-09T04:00:00Z");
const instantBefore = new Date("2026-08-01T00:00:00Z");
const instantSecond = new Date("2026-12-15T00:00:00Z");
const instantAfterAll = new Date("2027-01-01T00:00:00Z");

describe("促销展示与入账一致性", () => {
  test("同一时刻两端命中同一促销（窗口内/窗口前/第二段/全部过期）", () => {
    for (const instant of [instantInside, instantBefore, instantSecond, instantAfterAll]) {
      const ledger = activePaygPromotion(entry, instant.toISOString(), undefined);
      const display = activeDisplayPromotion(entry, instant);
      expect(display?.label).toBe(ledger?.label);
      expect(display?.priceOverride).toEqual(ledger?.priceOverride);
    }
    expect(activeDisplayPromotion(entry, instantInside)?.label).toBe("GPT-5.6 Sol 官方限时促销");
    expect(activeDisplayPromotion(entry, instantSecond)?.label).toBe("年末促销");
    expect(activeDisplayPromotion(entry, instantBefore)).toBeUndefined();
    expect(activeDisplayPromotion(entry, instantAfterAll)).toBeUndefined();
  });

  test("稀疏覆盖费率与入账端 overlaySparseRates 逐字段一致", () => {
    const promotion = activeDisplayPromotion(entry, instantInside)!;
    const base = entry.pricing;
    expect(overlayDisplayRates(base, promotion.priceOverride!))
      .toEqual(overlaySparseRates(base, promotion.priceOverride!));
    /* 未覆盖字段保留牌价（cacheWrite 由促销显式覆盖、longContext 保留牌价档位）。 */
    const overlaid = overlayDisplayRates(base, promotion.priceOverride!);
    expect(overlaid.input).toBe(4);
    expect(overlaid.output).toBe(20);
  });

  test("期限文案：有终点输出日期（本地时区口径）、无限期输出限时促销", () => {
    const to = new Date("2026-11-20T23:59:59.999Z");
    const expectedDate = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}-${String(to.getDate()).padStart(2, "0")}`;
    expect(promotionWindowLabel(activeDisplayPromotion(entry, instantInside)!)).toBe(`至 ${expectedDate}`);
    expect(promotionWindowLabel({from: "2026-01-01T00:00:00Z", priceOverride: {input: 1}})).toBe("限时促销");
  });

  test("agents 限定促销：入参命中集合交集才展示（与入账端 agentName 命中一致）", () => {
    const agentEntry: ModelPriceEntry = {
      ...entry,
      promotions: [{from: "2026-08-01T00:00:00Z", agents: ["codex"], priceOverride: {input: 1}, label: "Codex 专享"}],
    };
    expect(activeDisplayPromotion(agentEntry, instantInside, ["codex"])?.label).toBe("Codex 专享");
    expect(activeDisplayPromotion(agentEntry, instantInside, ["claude"])).toBeUndefined();
    expect(activeDisplayPromotion(agentEntry, instantInside)).toBeUndefined();
    expect(activePaygPromotion(agentEntry, instantInside.toISOString(), "codex")?.label).toBe("Codex 专享");
    expect(activePaygPromotion(agentEntry, instantInside.toISOString(), "claude")).toBeUndefined();
  });
});
