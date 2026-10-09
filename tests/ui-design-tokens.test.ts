import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

describe("v4.2 视觉令牌", () => {
  test("全局样式提供基础、语义和组件级主题令牌", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    for (const token of [
      "--paper", "--pine-700", "--gold-700", "--ink-900",
      "--text-secondary", "--text-tertiary", "--status-ok-text",
      "--status-warning-text", "--status-danger-text", "--focus-ring",
      "--turn-a-bg", "--turn-e-line",
    ]) expect(css, token).toContain(token);
    expect(css).toContain('html[data-theme="dark"]');
  });

  test("全局样式里引用的主题令牌必须都有定义（未定义会让整条声明静默失效）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    // 仅校验 v4.2 令牌层这一族；局部组件变量（--pm-*、--exp-*）由各自模块定义。
    const names = new Set<string>();
    for (const match of css.matchAll(/var\((--(?:surface|line|ink|paper|pine|gold)-[0-9a-z-]+)/g)) {
      names.add(match[1]!);
    }
    expect(names.size).toBeGreaterThan(10);
    const defined = new Set<string>();
    for (const match of css.matchAll(/^\s*(--[0-9a-z-]+):/gm)) defined.add(match[1]!);
    const missing = [...names].filter(name => !defined.has(name)).sort();
    // 2026-09-18 修复：--surface-1 / --line-2 / --line-3 / --ink-800 曾缺失，
    // 导致交互内容列表的分隔线整条不渲染（用户反馈「行与行之间没有分隔」）。
    expect(missing).toEqual([]);
  });

  test("页面组件不再依赖已废弃的局部色阶令牌", async () => {
    const [dashboard, dashboardContent, proxy, globals] = await Promise.all([
      readFile("src/components/dashboard.module.css", "utf8"),
      readFile("src/components/dashboard-content.tsx", "utf8"),
      readFile("src/components/proxy-management/proxy-management.module.css", "utf8"),
      readFile("src/app/globals.css", "utf8"),
    ]);
    expect(dashboard).not.toContain("var(--emerald-");
    expect(dashboard).not.toContain("var(--slate-");
    expect(dashboardContent).not.toContain("var(--emerald-");
    expect(dashboardContent).not.toContain("var(--slate-");
    expect(proxy).not.toContain("var(--pm-accent-soft)");
    expect(proxy).not.toContain("var(--pm-surface-subtle)");
    expect(globals).not.toContain("var(--pm-surface-subtle)");
  });

  test("关键页面提供桌面、平板与手机断点契约", async () => {
    const [globals, dashboard, proxy] = await Promise.all([
      readFile("src/app/globals.css", "utf8"),
      readFile("src/components/dashboard.module.css", "utf8"),
      readFile("src/components/proxy-management/proxy-management.module.css", "utf8"),
    ]);
    expect(globals).toContain("@media (min-width: 1600px)");
    expect(globals).toContain("@media (max-width: 1279px)");
    expect(globals).toContain("@media (max-width: 1023px)");
    expect(globals).toContain("@media (max-width: 767px)");
    expect(globals).not.toContain("@media (max-width: 820px)");
    expect(globals).not.toContain("@media (max-width: 1180px)");
    expect(dashboard).toContain("@media (min-width: 1600px)");
    expect(dashboard).toContain("@media (max-width: 1279px)");
    expect(dashboard).toContain("@media (max-width: 767px)");
    expect(dashboard).not.toContain("@media (max-width: 1200px)");
    expect(dashboard).not.toContain("@media (max-width: 639px)");
    expect(dashboard).not.toContain("@media (max-width: 768px)");
    /* 供应商管理模块级断点保留（组件内部网格适配）。 */
    expect(proxy).toContain("@media (max-width: 1099px)");
    expect(proxy).toContain("@media (max-width: 480px)");
    /* 公共容器、限宽 Header 与全站 footer。 */
    expect(globals).toContain(".page-wrap {");
    expect(globals).toContain(".topbar-inner {");
    expect(globals).toContain(".site-footer {");
  });

  test("Demo 组件层颜色使用语义变量而不是裸白色", async () => {
    const demo = await readFile("docs/ui-redesign-v4/demo.css", "utf8");
    const componentCss = demo.split("/* ============================================================\n   v4 融合版覆盖")[0];
    expect(componentCss).not.toMatch(/(?:color|background|border(?:-color)?):\s*#(?:fff|ffffff)\b/i);
    expect(componentCss).not.toContain("rgba(255,255,255");
  });

  test("页面几何、Footer 与官方新 LOGO 品牌契约（2026-09-05）", async () => {
    const [globals, footer, brand] = await Promise.all([
      readFile("src/app/globals.css", "utf8"),
      readFile("src/components/site-footer.tsx", "utf8"),
      readFile("src/components/brand-logo.tsx", "utf8"),
    ]);
    expect(globals).toContain("--page-max-width");
    expect(globals).toContain("--page-gutter");
    expect(footer).not.toContain("青绿色商务系");
    expect(footer).not.toContain("site-footer-ver");
    expect(brand).toContain("/deepaa-mark.png");
  });
});
