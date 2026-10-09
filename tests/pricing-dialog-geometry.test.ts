import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

/**
 * 两个主弹窗（价格中心 / 模型价格变动通知）的几何契约（2026-09-10 用户确认）：
 * 宽度统一为较宽的一方、高度固定（顶接顶部导航下方、底距视口下边缘 25px），
 * 且价格中心必须显式声明四段行高——否则弹性行被工具条占据，
 * 固定高度下工具条被拉满、按钮垂直居中，标题与工具条之间出现一大片空白。
 */
describe("价格中心与通知弹窗几何契约", () => {
  test("两个弹窗共用同一宽度与固定高度", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const rule = ruleBlock(css, ".settings-dialog.pricing-dialog,\n.catalog-updates-dialog {");
    expect(rule).toBeDefined();
    // 宽度取更宽的一方（价格中心原 1440px > 通知弹窗原 1280px）。
    expect(rule).toContain("width: min(var(--page-max-width), 96vw)");
    // 顶部 76px（64px 导航 + 12px 间距）+ 底部 25px 由遮罩内边距提供。
    expect(rule).toContain("height: calc(100dvh - 101px)");
    expect(rule).toContain("max-height: none");
    expect(rule).not.toContain("1280px");
  });

  test("遮罩顶部起排并预留上下间距，弹窗不再随内容高度浮动", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const rule = ruleBlock(css, ".pricing-modal-backdrop,\n.catalog-updates-backdrop {");
    expect(rule).toBeDefined();
    expect(rule).toContain("align-items: start");
    expect(rule).toContain("padding: 76px 24px 25px");
  });

  test("价格中心声明四段行高，与弹窗的四个直接子节点一一对应", async () => {
    const [css, dialog] = await Promise.all([
      readFile("src/app/globals.css", "utf8"),
      readFile("src/components/pricing-settings-dialog.tsx", "utf8"),
    ]);
    const rule = ruleBlock(css, ".settings-dialog.pricing-dialog {");
    expect(rule).toBeDefined();
    expect(rule).toContain("grid-template-rows: auto auto auto minmax(0, 1fr)");
    // 基类 .settings-dialog 只声明 auto 1fr auto 三段；第四段必须落在显式弹性行，
    // 否则第 4 个子节点进隐式行、第 2 行（工具条）吃掉全部剩余高度。
    for (const section of [
      'className="settings-header"',
      'className="pricing-toolbar"',
      'className="pricing-source-strip"',
      'className={`pricing-content-grid',
    ]) {
      expect(countOccurrences(dialog, section), section).toBe(1);
    }
  });

  test("两个弹窗的内容区各自滚动，固定高度下不裁切", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const rule = ruleBlock(
      css,
      ".settings-dialog.pricing-dialog > .pricing-content-grid,\n.catalog-updates-dialog > .catalog-updates-body {",
    );
    expect(rule).toBeDefined();
    expect(rule).toContain("min-height: 0");
    expect(rule).toContain("overflow: auto");
  });
});

/** 取出以给定选择器开头、到首个右括号结束的规则块（测试夹具，非解析器）。 */
function ruleBlock(css: string, selectorLine: string): string | undefined {
  const start = css.indexOf(selectorLine);
  if (start < 0) return undefined;
  const end = css.indexOf("}", start);
  return end < 0 ? undefined : css.slice(start, end + 1);
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
