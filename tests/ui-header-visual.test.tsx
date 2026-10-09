import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

describe("公共头部视觉语义", () => {
  test("品牌名不占用页面 h1，页面标题由页面内容承担", async () => {
    const header = await readFile("src/components/app-header.tsx", "utf8");
    expect(header).not.toContain("<h1>DeepAA</h1>");
    expect(header).toContain("Deep Agent Analytics");
  });

  test("头部保留可访问的主题与价格设置入口", async () => {
    const header = await readFile("src/components/app-header.tsx", "utf8");
    const theme = await readFile("src/components/theme-toggle.tsx", "utf8");
    const pricing = await readFile("src/components/pricing-settings-dialog.tsx", "utf8");
    expect(header).toContain("<ThemeToggle />");
    // 2026-09-14：价格中心入口收敛进「管理」下拉（存储管理同列），自带触发按钮隐藏。
    expect(header).toContain("<PricingSettingsDialog hideTrigger />");
    expect(header).toContain("<ManagementMenu />");
    expect(theme).toContain("aria-label");
    expect(pricing).toContain("aria-label");
  });

  test("公共 Header 不吸顶：随页面正文一起滚动（2026-09-18 用户确认）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const topbar = css.slice(css.indexOf(".topbar {"), css.indexOf(".topbar-inner {"));
    expect(topbar).toContain("position: static");
    expect(topbar).not.toContain("position: sticky;");
    expect(topbar).not.toContain("top: 0;");
    expect(topbar).not.toContain("z-index: 50;");
    // 背景与投影保留（跟随滚动时仍需与正文分层）。
    expect(topbar).toContain("background: var(--header-bg)");
    // 页内 sticky 元素（价格表头 / 目录工具条）不受影响：它们相对各自滚动容器定位。
    expect(css).toContain(".token-pricing-row.header {\n  position: sticky;");
  });

  test("公共 Footer 右下角提供 GitHub 新标签页入口，且右缘与 Header 操作区对齐", async () => {
    const footer = await readFile("src/components/site-footer.tsx", "utf8");
    const css = await readFile("src/app/globals.css", "utf8");
    expect(footer).toContain("<span>GitHub</span>");
    expect(footer).not.toContain("打开GitHub");
    expect(footer).toContain('https://github.com/AIAgentAndy/DeepAA');
    expect(footer).toContain('target="_blank"');
    expect(footer).toContain("site-footer-github");
    // 2026-09-18 用户确认：入口右缘必须与公共 Header 右上角操作区右缘对齐，
    // 不越过整体对齐宽度 —— 用与 .topbar-inner 同几何的三列网格实现。
    const footerInner = css.slice(css.indexOf(".site-footer-inner {"), css.indexOf(".site-footer-brand {"));
    expect(footerInner).toContain("max-width: var(--page-max-width)");
    expect(footerInner).toContain("padding: 0 var(--page-gutter)");
    expect(footerInner).toContain("grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)");
    const github = css.slice(css.indexOf(".site-footer-github {"), css.indexOf(".site-footer-github:hover"));
    expect(github).toContain("grid-column: 3");
    expect(github).toContain("justify-self: end");
    // 不再使用会跑到视口最右侧的绝对定位。
    expect(github).not.toContain("position: absolute");
  });

  test("公共导航胶囊间距比原先宽 10px（2026-09-18 用户确认，两次各 +5px）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    // 断点覆盖块里也有 .header-nav / .nav-tab，必须取主规则（最后一处）。
    // 2026-09-30：深色覆盖层追加了 html[data-theme="dark"] 前缀的同名规则，
    // 用 \n 锚定行首匹配，既跳过缩进的断点块，也跳过带深色前缀的覆盖层规则。
    const nav = css.slice(css.lastIndexOf("\n.header-nav {"), css.lastIndexOf("\n.nav-tab {"));
    expect(nav).toContain("gap: 24px;");
    // 旧的 14px / 19px 间距必须消失。
    expect(nav).not.toContain("gap: 14px");
    expect(nav).not.toContain("gap: 19px");
  });
});
