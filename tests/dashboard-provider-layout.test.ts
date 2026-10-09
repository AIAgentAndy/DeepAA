import {describe, expect, test} from "vitest";
import {shouldStackProviderSync} from "../src/lib/dashboard-provider-layout.js";

describe("仪表盘供应商卡同步列布局", () => {
  test("余额胶囊与同步列重叠或间距不超过 5px 时才堆叠", () => {
    expect(shouldStackProviderSync({balanceRight: 200, syncLeft: 200})).toBe(true);
    expect(shouldStackProviderSync({balanceRight: 200, syncLeft: 204})).toBe(true);
    expect(shouldStackProviderSync({balanceRight: 200, syncLeft: 205})).toBe(true);
    expect(shouldStackProviderSync({balanceRight: 200, syncLeft: 206})).toBe(false);
  });

  test("缺少有效边界时保持平铺，避免测量异常撑高卡片", () => {
    expect(shouldStackProviderSync({balanceRight: Number.NaN, syncLeft: 200})).toBe(false);
    expect(shouldStackProviderSync({balanceRight: 200, syncLeft: Number.POSITIVE_INFINITY})).toBe(false);
  });
});
