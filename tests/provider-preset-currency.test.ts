import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import {
  PROVIDER_PRESETS,
  derivePresetCurrency,
  resolvePlanFeeCurrency,
} from "../src/lib/provider-presets.js";
import { resolveDisplayFxRate } from "../src/lib/settlement-fx.js";
import { DEFAULT_USD_CNY_RATE, resolveFxRate } from "../src/lib/pricing-model-entry.js";
import {
  formatCnyMoney,
  formatMoneyWithCnyEquivalent,
  formatOriginalMoney,
  formatOriginalPrice,
  formatPriceWithCnyEquivalent,
} from "../src/lib/money-display.js";

/** 解析随包目录的供应商行（跳过注释、空行与 meta 行），得到 catalogKey → currency 映射。 */
async function catalogCurrencyMap(): Promise<Map<string, "CNY" | "USD">> {
  const raw = await readFile("data/defaults/llm_catalog.jsonl", "utf8");
  const result = new Map<string, "CNY" | "USD">();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed.schemaVersion === "number") continue;
    if (typeof parsed.catalogKey !== "string") continue;
    const currency = parsed.currency;
    if (currency === "CNY" || currency === "USD") result.set(parsed.catalogKey, currency);
  }
  return result;
}

describe("官方预设币种注册表（2026-09-28）", () => {
  test("每个预设都声明币种，且与随包目录供应商行完全一致（守护测试）", async () => {
    const catalog = await catalogCurrencyMap();
    expect(catalog.size).toBeGreaterThan(0);
    expect(PROVIDER_PRESETS.length).toBe(18);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.currency === "CNY" || preset.currency === "USD").toBe(true);
      const catalogCurrency = catalog.get(preset.catalogKey);
      expect(catalogCurrency, `目录缺少预设 ${preset.id}（catalogKey=${preset.catalogKey}）的供应商行`).toBeDefined();
      expect(preset.currency, `预设 ${preset.id} 币种与目录不一致`).toBe(catalogCurrency);
    }
  });

  test("全球区预设 USD、中国区预设 CNY 的关键样本", () => {
    const byId = new Map(PROVIDER_PRESETS.map(preset => [preset.id, preset]));
    expect(byId.get("opencode-go")?.currency).toBe("USD");
    expect(byId.get("openai-subscription")?.currency).toBe("USD");
    expect(byId.get("anthropic-subscription")?.currency).toBe("USD");
    expect(byId.get("openrouter")?.currency).toBe("USD");
    expect(byId.get("zhipu-coding-plan")?.currency).toBe("CNY");
    expect(byId.get("deepseek")?.currency).toBe("CNY");
    expect(byId.get("kimi-coding")?.currency).toBe("CNY");
  });

  test("derivePresetCurrency：自定义目标（无预设）返回 undefined", () => {
    expect(derivePresetCurrency(PROVIDER_PRESETS.find(preset => preset.id === "opencode-go"))).toBe("USD");
    expect(derivePresetCurrency(undefined)).toBeUndefined();
  });
});

describe("套餐月费币种解析（P0 修复，2026-09-28）", () => {
  const opencodeGo = PROVIDER_PRESETS.find(preset => preset.id === "opencode-go")!;
  const zhipuPlan = PROVIDER_PRESETS.find(preset => preset.id === "zhipu-coding-plan")!;

  test("显式 settlementCurrency 优先于预设币种", () => {
    expect(resolvePlanFeeCurrency({explicit: "CNY", preset: opencodeGo})).toBe("CNY");
    expect(resolvePlanFeeCurrency({explicit: "USD", preset: zhipuPlan})).toBe("USD");
  });

  test("缺显式币种时按预设目录币种兜底：global→USD、cn→CNY", () => {
    expect(resolvePlanFeeCurrency({preset: opencodeGo})).toBe("USD");
    expect(resolvePlanFeeCurrency({preset: zhipuPlan})).toBe("CNY");
  });

  test("无预设的自定义目标不猜测，返回 undefined（维持缺省 CNY 语义）", () => {
    expect(resolvePlanFeeCurrency({})).toBeUndefined();
    expect(resolvePlanFeeCurrency({explicit: "EUR", preset: undefined})).toBeUndefined();
  });
});

describe("展示用结算系数解析（与入账级联同规则，2026-09-28）", () => {
  test("CNY 预设原生人民币；USD 预设用目录 fx 快照，缺失回退默认", () => {
    expect(resolveDisplayFxRate({presetCurrency: "CNY", fxUsdCny: 6.7489})).toBe(1);
    expect(resolveDisplayFxRate({presetCurrency: "USD", fxUsdCny: 6.7489})).toBe(6.7489);
    expect(resolveDisplayFxRate({presetCurrency: "USD"})).toBe(DEFAULT_USD_CNY_RATE);
    expect(resolveDisplayFxRate({presetCurrency: "USD", fxUsdCny: 0})).toBe(DEFAULT_USD_CNY_RATE);
  });

  test("自定义/中转站目标用 settlementFx（auto-code 1/16），缺省 1:1", () => {
    expect(resolveDisplayFxRate({settlementFx: 0.0625})).toBe(0.0625);
    expect(resolveDisplayFxRate({})).toBe(1);
    // 显式 settlementFx 优先于 fx 快照（自定义目标无预设币种）。
    expect(resolveDisplayFxRate({settlementFx: 0.0625, fxUsdCny: 6.7489})).toBe(0.0625);
  });

  test("随包默认汇率为整数 7（2026-09-28 用户确认），resolveFxRate 仅在无快照时回退", () => {
    expect(DEFAULT_USD_CNY_RATE).toBe(7);
    expect(resolveFxRate(undefined, "USD", "CNY")).toBe(7);
    expect(resolveFxRate({rates: {"USD/CNY": 6.7489}}, "USD", "CNY")).toBe(6.7489);
    expect(resolveFxRate({rates: {"USD/CNY": -1}}, "USD", "CNY")).toBe(7);
  });
});

describe("金额展示格式（2026-09-28 币种标注）", () => {
  test("人民币终值带 ￥，原币带 $/￥，未知币种纯数值", () => {
    expect(formatCnyMoney(1.2)).toBe("￥1.20");
    expect(formatOriginalMoney(1.2, "USD")).toBe("$1.20");
    expect(formatOriginalMoney(1.2, "CNY")).toBe("￥1.20");
    expect(formatOriginalMoney(1.2, "unknown")).toBe("1.20");
    expect(formatCnyMoney(undefined)).toBe("—");
  });

  test("余额/月费括号等值：中转站按 settlementFx（auto-code 88.68 × 1/16 ≈ ￥5.54）", () => {
    expect(formatMoneyWithCnyEquivalent(88.68, "USD", 0.0625)).toBe("$88.68（约￥5.54）");
    // 人民币原值不加括号。
    expect(formatMoneyWithCnyEquivalent(430.4, "CNY", 1)).toBe("￥430.40");
  });

  test("结算系数恰为 1 的 USD 金额直接收敛为人民币单值（2026-09-29 中转站 1:1）", () => {
    // 1:1 站点：美元牌价数字 = 确定人民币，双值展示无信息量。
    expect(formatMoneyWithCnyEquivalent(1.89, "USD", 1)).toBe("￥1.89");
    expect(formatMoneyWithCnyEquivalent(88.68, "USD", 1)).toBe("￥88.68");
    // 未知币种不猜测 1:1 结算语义，维持原值 + 括号等值。
    expect(formatMoneyWithCnyEquivalent(1.89, "unknown", 1)).toBe("1.89（约￥1.89）");
    // 非 1 系数保持双值风格（回归保护）。
    expect(formatMoneyWithCnyEquivalent(1.89, "USD", 7)).toBe("$1.89（约￥13.23）");
  });

  test("单价括号等值保留高精度；无有效汇率时只标币种（D1 价格中心场景）", () => {
    expect(formatPriceWithCnyEquivalent(0.3, "USD", 6.7489)).toBe("$0.3（约￥2.0247）");
    expect(formatPriceWithCnyEquivalent(0.3, "USD")).toBe("$0.3");
    expect(formatPriceWithCnyEquivalent(0.3, "CNY", 6.7489)).toBe("￥0.3");
    expect(formatOriginalPrice(0.000012, "USD")).toBe("$0.000012");
  });
});
