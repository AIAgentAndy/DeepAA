import { describe, expect, test } from "vitest";
import {
  asDisplayCurrency,
  formatSettlementFxDisplay,
  parseSettlementFxInput,
  resolveDisplayFxRate,
  settlementFxInputHint,
} from "../src/lib/settlement-fx";

describe("结算系数输入解析（几比几 / 小数，2026-09-23）", () => {
  test("小数与整数输入按乘数透传", () => {
    expect(parseSettlementFxInput("1")).toBe(1);
    expect(parseSettlementFxInput("0.0625")).toBe(0.0625);
    expect(parseSettlementFxInput("16")).toBe(16);
    expect(parseSettlementFxInput(" 7.1 ")).toBe(7.1);
  });

  test("比值输入 a:b / a/b / 全角冒号 → 乘数 a/b（1:16 = ×1/16）", () => {
    expect(parseSettlementFxInput("1:16")).toBe(1 / 16);
    expect(parseSettlementFxInput("1/16")).toBe(1 / 16);
    expect(parseSettlementFxInput("1：16")).toBe(1 / 16);
    expect(parseSettlementFxInput("1: 16")).toBe(1 / 16);
    expect(parseSettlementFxInput(" 1 : 16 ")).toBe(1 / 16);
    expect(parseSettlementFxInput("1:1")).toBe(1);
    expect(parseSettlementFxInput("3:2")).toBe(1.5);
  });

  test("非法输入返回 undefined：空串、非数字、非正数、缺段、多段", () => {
    expect(parseSettlementFxInput("")).toBeUndefined();
    expect(parseSettlementFxInput("   ")).toBeUndefined();
    expect(parseSettlementFxInput("abc")).toBeUndefined();
    expect(parseSettlementFxInput("0")).toBeUndefined();
    expect(parseSettlementFxInput("-1")).toBeUndefined();
    expect(parseSettlementFxInput("1:")).toBeUndefined();
    expect(parseSettlementFxInput(":16")).toBeUndefined();
    expect(parseSettlementFxInput("1:16:3")).toBeUndefined();
    expect(parseSettlementFxInput("1:0")).toBeUndefined();
    expect(parseSettlementFxInput("1:16kg")).toBeUndefined();
  });

  test("展示：缺省/1 → 1:1；可还原小分母比值的并列小数；其余按小数", () => {
    expect(formatSettlementFxDisplay(undefined)).toContain("1:1（默认");
    expect(formatSettlementFxDisplay(1)).toBe("1:1");
    // 1/16 还原为 1:16（0.0625）；0.5 还原为 1:2。
    expect(formatSettlementFxDisplay(1 / 16)).toBe("1:16（0.0625）");
    expect(formatSettlementFxDisplay(0.5)).toBe("1:2（0.5）");
    // 整数 16 不伪装成比值；汇率类 7.13（713:100 超出 100）按小数展示。
    expect(formatSettlementFxDisplay(16)).toBe("16");
    expect(formatSettlementFxDisplay(7.13)).toBe("7.13");
  });

  test("输入提示语给出等效乘数（仅合法值）", () => {
    expect(settlementFxInputHint(1 / 16)).toContain("0.0625");
    expect(settlementFxInputHint(undefined)).toBeUndefined();
    expect(settlementFxInputHint(0)).toBeUndefined();
  });
});

describe("展示结算系数解析（2026-10-06 与入账级联对齐）", () => {
  test("CNY 区官方预设上的美元金额按目录 fx 换算（deepseek 事故修复点，不再 ×1）", () => {
    expect(resolveDisplayFxRate({
      amountCurrency: "USD",
      presetCurrency: "CNY",
      fxUsdCny: 6.7351,
    })).toBe(6.7351);
  });

  test("原币 CNY 一律 1，无需括号等值（含 USD 预设上的人民币金额）", () => {
    expect(resolveDisplayFxRate({amountCurrency: "CNY", presetCurrency: "CNY", fxUsdCny: 6.7351})).toBe(1);
    expect(resolveDisplayFxRate({amountCurrency: "CNY", presetCurrency: "USD", fxUsdCny: 6.7351})).toBe(1);
  });

  test("官方预设美元金额缺 fx 快照时回退随包默认；自定义/中转站目标缺省 1:1", () => {
    expect(resolveDisplayFxRate({amountCurrency: "USD", presetCurrency: "CNY"})).toBe(7);
    expect(resolveDisplayFxRate({amountCurrency: "USD"})).toBe(1);
  });

  test("显式 settlementFx 与入账级联同序最优先（自定义目标业务结算系数，如 auto-code 1/16）", () => {
    expect(resolveDisplayFxRate({amountCurrency: "USD", settlementFx: 1 / 16})).toBe(1 / 16);
    // 预设目标上手工配置的显式系数同样优先于 fx 快照（与写入端 versionedSettlementFx 优先一致）。
    expect(resolveDisplayFxRate({amountCurrency: "USD", presetCurrency: "CNY", settlementFx: 2, fxUsdCny: 6.7351})).toBe(2);
  });

  test("未提供金额币种时按预设目录币种推断，保持旧行为（CNY 预设=1、USD 预设=fx）", () => {
    expect(resolveDisplayFxRate({presetCurrency: "CNY", fxUsdCny: 6.7351})).toBe(1);
    expect(resolveDisplayFxRate({presetCurrency: "USD", fxUsdCny: 6.7351})).toBe(6.7351);
  });

  test("asDisplayCurrency 只收窄 CNY/USD，未知与缺失返回 undefined", () => {
    expect(asDisplayCurrency("CNY")).toBe("CNY");
    expect(asDisplayCurrency("USD")).toBe("USD");
    expect(asDisplayCurrency("EUR")).toBeUndefined();
    expect(asDisplayCurrency(undefined)).toBeUndefined();
    expect(asDisplayCurrency(null)).toBeUndefined();
  });
});
