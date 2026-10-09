import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

describe("DeepAA 品牌资源", () => {
  test("页面展示使用 DeepAA 新品牌名与定位副标题", async () => {
    const header = await readFile("src/components/app-header.tsx", "utf8");
    const layout = await readFile("src/app/layout.tsx", "utf8");
    const logo = await readFile("src/components/brand-logo.tsx", "utf8");
    expect(header).toContain('className="brand-name"');
    expect(header).toContain("Deep Agent Analytics");
    expect(header).toContain("harness intelligence for AI agents");
    expect(layout).toContain('title: "DeepAA"');
    expect(layout).toContain("Deep Agent Analytics - local-first gateway, observability, analytics, and harness intelligence for AI agents.");
    expect(logo).toContain('title = "DeepAA Logo"');
    // 2026-09-05 新 LOGO 体系：header 直接渲染官方标记 PNG，旧四方案切换器退役。
    expect(header).toContain("<BrandLogo />");
    expect(header).not.toContain("BrandSwitcher");
    expect(logo).toContain("/deepaa-mark.png");
    expect(logo).not.toContain("harnessLoom");
  });

  test("新品牌资源存在：透明标记 + APP ICON favicon，旧方案资产已移除", async () => {
    expect(existsSync("public/deepaa-mark.png"), "header 透明标记").toBe(true);
    expect(existsSync("src/app/icon.png"), "favicon（APP ICON 256）").toBe(true);
    expect(existsSync("docs/logo/logo.png"), "品牌源文件").toBe(true);
    for (const removed of [
      "src/app/icon.svg",
      "src/components/brand-switcher.tsx",
      "public/brand/deepaa-harness-loom.svg",
      "public/brand/deepaa-orbit.svg",
      "public/brand/deepaa-pulse.svg",
      "public/brand/deepaa-nexus.svg",
    ]) {
      expect(existsSync(removed), removed).toBe(false);
    }
  });
});
