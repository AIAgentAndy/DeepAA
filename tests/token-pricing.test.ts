import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { loadTokenPricingState } from "../src/lib/token-pricing.js";

describe("Token 价格 SQLite 运行边界", () => {
  test("缺少数据库依赖时拒绝旧 JSONL 回退", async () => {
    await expect(loadTokenPricingState(new URLSearchParams(), {
      dataDir: "/definitely-not-readable",
    })).rejects.toThrow("SQLite 数据库依赖");
  });

  test("生产模块不再导入旧索引、旧派生或 JSONL 账本", () => {
    const source = readFileSync("src/lib/token-pricing.ts", "utf-8");
    expect(source).not.toContain("captureIndexPath");
    expect(source).not.toContain("readBusinessIndex");
    expect(source).not.toContain("usageLedgerPath");
    expect(source).not.toContain("readJsonlReverse");
    expect(source).toContain("queryTokenPricingSqlite");
  });
});
