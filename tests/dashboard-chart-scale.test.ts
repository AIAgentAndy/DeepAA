import {describe, expect, test} from "vitest";
import {
  buildNiceTicks,
  formatTokenAxis,
} from "../src/components/dashboard/chart-scale.js";

describe("仪表盘动态 Y 轴", () => {
  test.each([
    [39_000_000, 40_000_000],
    [43_000_000, 50_000_000],
    [55_000_000, 60_000_000],
    [65_000_000, 70_000_000],
  ])("最大值 %i 使用贴近数据的顶部刻度 %i", (maximum, expectedTop) => {
    const ticks = buildNiceTicks(maximum);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(expectedTop);
    expect(ticks.every(Number.isFinite)).toBe(true);
  });

  test("65M 使用 10M 步进，不跳到 80M 或 100M", () => {
    expect(buildNiceTicks(65_000_000)).toEqual([
      0,
      10_000_000,
      20_000_000,
      30_000_000,
      40_000_000,
      50_000_000,
      60_000_000,
      70_000_000,
    ]);
  });

  test("全零和小请求量返回有限整数刻度", () => {
    expect(buildNiceTicks(0, {integerOnly: true})).toEqual([0, 1]);
    expect(buildNiceTicks(3, {integerOnly: true})).toEqual([0, 1, 2, 3]);
  });

  test("Token 轴使用 M/K，不使用亿", () => {
    expect(formatTokenAxis(65_000_000)).toBe("65M");
    expect(formatTokenAxis(500_000)).toBe("500K");
    expect(formatTokenAxis(0)).toBe("0");
    expect(formatTokenAxis(100_000_000)).not.toContain("亿");
  });
});
