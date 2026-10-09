import {readFile} from "node:fs/promises";
import {expect, test} from "vitest";

test("根 html 抑制主题初始化脚本造成的 hydration 属性差异", async () => {
  const source = await readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8");

  expect(source).toContain('<html lang="zh-CN" suppressHydrationWarning>');
});
