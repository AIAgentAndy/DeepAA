import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

describe("仪表盘 UI 约束", () => {
  test("不再展示上一周期或环比数据", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const charts = await readFile("src/components/dashboard/charts.tsx", "utf8");
    expect(content).not.toContain("deltaBadge");
    expect(content).not.toContain("prevValues");
    expect(content).not.toContain("上一周期");
    expect(content).not.toContain("data?.comparison");
    expect(charts).not.toContain("prevValues");
    expect(charts).not.toContain("上一周期");
  });

  test("小时趋势完整展示各时间桶并在跨日边界标记日期", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    expect(content).toContain("bucketAxisLabel");
    expect(content).toContain("previousKey");
    expect(content).toContain('showAll={granularity === "hour"}');
  });

  test("页头不再展示数据层文案且页面标题保留统一品牌后缀", async () => {
    const page = await readFile("src/app/dashboard/page.tsx", "utf8");
    expect(page).not.toContain("数据层");
    expect(page).toContain("仪表盘 - DeepAA - Deep Agent Analytics");
    expect(page).toContain("更新");
  });

  test("周期强度热力图生成完整 00 到 23 小时表头", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    expect(content).toContain("heatmapHourHeader");
    expect(content).toContain("Array.from({length: 24}");
    expect(content).toContain("pad(hour)");
  });

  test("热力图跳转与数据更新时间跟随顶部时区", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    expect(content).toContain("timeZoneOffsetMinutes");
    expect(content).toContain("heatmapCellHref(date: string, hour: number, timeZone: string)");
    expect(content).toContain("timeZoneOffsetMinutes(timeZone)");
    expect(content).toContain("cellHref={(date, hour) => heatmapCellHref(date, hour, tz)}");
    expect(content).toContain("zonedHourParts(data.freshness.asOf, timeZoneIana(tz))");
  });

  test("Agent 与供应商卡片 hover/focus 使用可识别的松绿色边框（v4.2 令牌）", async () => {
    const css = await readFile("src/components/dashboard.module.css", "utf8");
    expect(css).toContain("--border-strong: var(--pine-a35)");
    expect(css).toContain(".launchBadge:hover,\n.launchBadge:focus-visible");
    expect(css).toContain(".providerCard:hover,\n.providerCard:focus-visible");
    expect(css).toContain("box-shadow: 0 0 0 2px var(--pine-a10), var(--shadow-sm)");
  });

  test("KPI 三卡结构（总请求/总Token/总金额）每卡右上角 总/量/套 三维度切换", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    expect(content).toContain("总请求");
    expect(content).toContain("总 Token");
    expect(content).toContain("总金额");
    /* 三卡各自独立的维度状态与切换器 */
    expect(content).toContain("KPI_DIM_OPTIONS");
    expect(content).toContain('useState<KpiDimKey>("total")');
    expect(content).toContain("setReqDim");
    expect(content).toContain("setTokenDim");
    expect(content).toContain("setCostDim");
    expect(content).toContain("kpiDimTabs");
    expect(content).toContain("kpiDimTabActive");
    /* 各维度指标口径 */
    expect(content).toContain("paygSuccessRate");
    expect(content).toContain("planSuccessRate");
    expect(content).toContain("paygTokenValues");
    expect(content).toContain("planTokenValues");
    expect(content).toContain("planRealValues");
    expect(content).toContain("缓存率");
    expect(content).toContain("省钱率");
    expect(content).toContain("kpiCardGold");
  });

  test("Token 成本排行榜与三列分析模块存在且共用区块级选择器", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    expect(content).toContain("Token 成本排行榜");
    expect(content).toContain("costLeaderboard");
    expect(content).toContain('setLbDim("modelVendor")');
    expect(content).toContain('setLbDim("model")');
    expect(content).toContain('setLbDim("vendor")');
    expect(content).toContain("模型 / 供应商 / Agent 分析");
    expect(content).toContain('setAnalysisMetric("token")');
    expect(content).toContain('setAnalysisMetric("cost")');
    expect(content).toContain('setAnalysisMetric("requests")');
    expect(content).toContain("analysisGrid");
  });

  test("环形图引线拉开空间（Donut 画布加宽）且首页底部文案已移除", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const charts = await readFile("src/components/dashboard/charts.tsx", "utf8");
    /* 排行榜与消耗趋势两个环形均使用加宽画布 */
    expect(charts).toContain("width?: number");
    expect(content.match(/width=\{440\}/g)?.length ?? 0).toBe(0);
    /* 首页专属底部分析文案移除，全站 slim footer 保留 */
    expect(content).not.toContain("时间范围统计");
    expect(content).not.toContain("analytics_hourly_facts · Token = 输入");
  });

  test("三列分析按指标排序并带序号，按钮统一指针光标", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const globals = await readFile("src/app/globals.css", "utf8");
    /* 排序与排名序号 */
    expect(content).toContain("analysisMetricValue(right, analysisMetric) - analysisMetricValue(left, analysisMetric)");
    expect(content).toContain("#{index + 1}");
    expect(content).toContain("left.name.startsWith(\"其他\")");
    /* 全局按钮指针（刷新数据等） */
    expect(globals).toContain("button {");
    expect(globals).toContain("cursor: pointer;\n}\n\nbutton:disabled {\n  cursor: default;\n}");
  });

  test("公共 Header 限宽居中且导航居中散开（v4.2）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const header = await readFile("src/components/app-header.tsx", "utf8");
    expect(header).toContain('className="topbar"');
    expect(header).toContain('className="topbar-inner"');
    expect(css).toContain(".topbar-inner {");
    expect(css).toContain("max-width: 1440px");
    expect(css).toContain(".page-wrap {");
    expect(css).toContain(".site-footer {");
    /* 导航居中：justify-content center + 胶囊样式 */
    expect(css).toContain(".header-nav {");
    expect(css).toMatch(/\.header-nav \{[^}]*justify-content: center/s);
  });

  test("导航胶囊对齐参考图：全圆角 + 前置图标 + 悬停提亮（无描边感）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const nav = await readFile("src/components/view-toggle.tsx", "utf8");
    expect(css).toMatch(/\.nav-tab \{[^}]*border-radius: 999px/s);
    expect(css).toMatch(/\.nav-tab:hover \{[^}]*background: var\(--white-a22\)/s);
    expect(css).not.toMatch(/\.nav-tab:hover \{[^}]*border-color/s);
    /* 五个导航项均带前置图标 */
    for (const [icon, label] of [
      ["LayoutDashboard", "仪表盘"],
      ["ListTree", "会话追踪"],
      ["MessageSquareText", "交互内容"],
      ["CircleDollarSign", "Token价格"],
      ["Server", "供应商管理"],
    ]) {
      expect(nav, icon).toContain(`<${icon} aria-hidden="true" />`);
      expect(nav, label).toContain(label);
    }
  });

  test("品牌两行左对齐（去掉分隔符前缀）且全站 footer 与 header 同色", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const dashboard = await readFile("src/components/dashboard.module.css", "utf8");
    expect(css).not.toContain("brand-tagline::before");
    // v5：footer 不再各写一遍色值，直接引用 header 令牌，两者恒等。
    expect(css).toContain("--footer-bg: var(--header-bg)");
    expect(css).toContain("--header-bg: #0e6e6b");
    /* Agent 列表 hero 上下各留 10px + 顶部 30px 呼吸间距 */
    expect(dashboard).toContain("padding: 30px var(--page-gutter) 10px");
  });

  test("总金额量/套明细使用独立对齐信息块且套餐文案无多余分隔点", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const css = await readFile("src/components/dashboard.module.css", "utf8");
    expect(content).toContain("kpiChannelStack");
    expect(content).toContain("kpiChannelPayg");
    expect(content).toContain("kpiChannelPlan");
    expect(content).toContain("省钱率");
    expect(content).not.toContain("市价 <a className={styles.subtitleLink} href={marketHref}>{fmtMoney(summary?.marketCostNano ?? null)}</a> ·");
    expect(css).toContain(".kpiChannelPayg");
    expect(css).toContain(".kpiChannelPlan");
  });

  test("套餐金额在总维度与套维度统一展示划线市价到真实金额", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    expect(content).toContain("planCostFlow");
    expect(content).toContain("planCostFlowRow");
    expect(content).toContain("planMarketCostStrike");
    expect(content).toContain("市价");
    expect(content).toContain("→");
    expect(content).toContain("真实");
    expect(content.match(/\{planCostFlow\}/g)?.length).toBe(2);
  });

  test("两个环图使用左右标注安全区而不是固定 440x300 画布", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const charts = await readFile("src/components/dashboard/charts.tsx", "utf8");
    expect(charts).toContain("donut-callout-column");
    expect(charts).toContain("donut-callout-left");
    expect(charts).toContain("donut-callout-right");
    expect(charts).toContain("donut-callout-value");
    expect(content.match(/width=\{440\}/g)?.length ?? 0).toBe(0);
    expect(content.match(/height=\{300\}/g)?.length ?? 0).toBe(0);
  });

  test("环图从每个环段锚点绘制连续引线到对应文案", async () => {
    const charts = await readFile("src/components/dashboard/charts.tsx", "utf8");
    const css = await readFile("src/components/dashboard.module.css", "utf8");
    expect(charts).toContain("donut-callout-lines");
    expect(charts).toContain("donut-callout-anchor");
    expect(charts).toContain("buildDonutConnectorPath");
    expect(charts).toContain("anchorRadius = radius + strokeWidth / 2 + 1");
    expect(charts).toContain("normalX");
    expect(charts).toContain("normalY");
    expect(charts).toContain("outwardControlX");
    expect(charts).toContain("outwardControlY");
    expect(charts).toContain("const sidePull = 20");
    expect(charts).toContain("rawOutwardControlX");
    expect(charts).toContain("normalX * outwardDistance + direction * sidePull");
    expect(charts).toContain("approachControlX");
    expect(charts).toContain("approachControlX - 4");
    expect(charts).toContain("approachControlX + 4");
    expect(charts).toContain(" C ${outwardControlX.toFixed(1)}");
    expect(charts).not.toContain(" Q ${outwardControlX.toFixed(1)}");
    expect(charts).not.toContain("shoulderX");
    expect(charts).not.toContain(" L ${radialX.toFixed(1)}");
    expect(charts).toContain("visibleFraction");
    expect(charts).toContain("donutSegmentGap / circumference");
    expect(charts).toContain("ResizeObserver");
    expect(charts).toContain("stroke={connector.color}");
    expect(css).toContain(".donut-callout-lines");
    expect(css).toContain(".donut-callout-wrap .donut-callout-lines");
    expect(css).toMatch(/\.donut-callout-lines\) \{[^}]*z-index:\s*2/s);
    expect(css).toMatch(/\.donut-callout-column\) \{[^}]*z-index:\s*3/s);
  });

  test("Agent 与供应商列表保留至少 10px 结构间距", async () => {
    const css = await readFile("src/components/dashboard.module.css", "utf8");
    expect(css).toMatch(/row-gap:\s*10px|gap:\s*10px/);
  });
  test("模块排序：悬停出上/下箭头、写 localStorage、最上不超过时间选择器（2026-09-18 用户确认）", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const css = await readFile("src/components/dashboard.module.css", "utf8");
    const order = await readFile("src/lib/dashboard-module-order.ts", "utf8");
    // 顺序数据与持久化收敛到纯函数模块，页面只消费。
    expect(order).toContain('DASHBOARD_MODULE_STORAGE_KEY = "deepaa.dashboard.moduleOrder"');
    expect(order).toContain("normalizeDashboardModuleOrder");
    expect(content).toContain("readDashboardModuleOrder()");
    expect(content).toContain("writeDashboardModuleOrder(next)");
    // 悬停控制条：fixed 贴浏览器右边缘，垂直位置被夹在时间筛选条下方。
    expect(content).toContain("anchorReorderControls");
    expect(content).toContain("filtersRef");
    expect(content).toContain("const minTop = filterBottom + 8;");
    expect(content).toContain("onMouseEnter={() => {");
    expect(css).toContain(".reorderControls");
    expect(css).toContain(".reorderButton");
    // 时间筛选条固定在排序列表之外（永远第一，不参与排序）。
    expect(content).toContain('aria-label="时间范围筛选"');
    expect(content).toContain("renderedModuleOrder.map");
  });

  test("仪表盘供应商卡展示健康标识：同步正常=黄，配置缺口/连续同步失败=红（更显眼）", async () => {
    const launcher = await readFile("src/components/dashboard/dashboard-launcher.tsx", "utf8");
    const badgeLib = await readFile("src/lib/sync-engine/target-health-badge.ts", "utf8");
    const badgeCss = await readFile("src/components/proxy-management/target-health-badge.module.css", "utf8");
    expect(launcher).toContain("resolveTargetBadge");
    expect(launcher).toContain("badgeInputFromStatus");
    expect(launcher).toContain("<TargetHealthBadge badge={badge} />");
    // 判定与渲染统一走公共模块/公共组件，不允许就地再写一份。
    expect(launcher).not.toContain("resolveRateWarning(");
    expect(badgeCss).toContain(".healthBadge");
    expect(badgeCss).toContain(".healthBadgeSevere");
    // 配置缺口（账号未设置 / 套餐同步未保存）在供应商卡上同样要说清缺什么：
    // 适配器统一在共享模块里设置，两处列表不允许各自漂移。
    expect(badgeLib).toContain("includeConfigurationGaps: true");
    expect(badgeLib).toContain("resolveOfficialPresetForTarget");
    expect(badgeLib).toContain("resolvePlanProviderForTarget");
    // 严重度判定必须复用共享模块，不允许就地再写一份。
    expect(launcher).not.toContain("isRateUnconfirmed(");
    // 窗口标签 / 百分比口径同理。
    expect(launcher).toContain("planQuotaWindowLabel");
    expect(launcher).toContain("planQuotaPercent");
    expect(launcher).not.toContain("QUOTA_WINDOW_LABELS");
  });

  test("供应商余额过长时只堆叠右侧同步列，不改变卡片整体高度", async () => {
    const launcher = await readFile("src/components/dashboard/dashboard-launcher.tsx", "utf8");
    const css = await readFile("src/components/dashboard.module.css", "utf8");
    expect(launcher).toContain("shouldStackProviderSync");
    expect(launcher).toContain("providerContentRef");
    expect(launcher).toContain("ref={providerContentRef}");
    expect(launcher).toContain("ResizeObserver");
    expect(launcher).toContain("providerSyncColStacked");
    expect(launcher).toContain("providerSyncStatus");
    expect(css).toContain(".providerSyncColStacked");
    expect(css).not.toContain(".shell .providerSyncColStacked");
    expect(css).toContain("flex: 0 0 40px");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("white-space: normal");
    expect(css).toContain(".providerSyncStatus");
    expect(css).toContain("height: 118px");
  });

  test("时间范围 URL 与会话追踪页统一为 UTC ISO，读路径只接受 ISO（2026-10-10 移除墙钟兼容）", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const range = await readFile("src/lib/dashboard-url-range.ts", "utf8");
    // URL 读写统一走编解码模块：写入绝对 ISO，读取同样只认绝对 ISO。
    expect(content).toContain("parseDashboardRangeQuery");
    expect(content).toContain("dashboardWallRangeToIso");
    expect(content).toContain("rebaseWallClockHour");
    // 显式范围（URL 或用户选择）是绝对时间：切时区重排墙钟而不是平移窗口，
    // 也不再在挂载时被默认「今天」覆盖。
    expect(content).toContain("rangeExplicitRef");
    expect(content).not.toContain("rangeTouchedRef");
    // 不再把墙钟串直接写进 URL。
    expect(content).not.toContain("encodeURIComponent(startInput)");
    expect(content).not.toContain("encodeURIComponent(endInput)");
    expect(range).toContain("ABSOLUTE_ISO_RE");
    expect(range).not.toContain("WALL_HOUR_RE");
  });

  test("模块排序：仅模块本体悬停触发，不再画虚线描边，箭头纵向拉长", async () => {
    const content = await readFile("src/components/dashboard-content.tsx", "utf8");
    const css = await readFile("src/components/dashboard.module.css", "utf8");
    // 5.3 撤销（2026-09-18 用户确认）：不再用 window 级 mousemove 覆盖「模块右侧带状区」，
    // 只在模块本体范围内悬停才出现控制条，避免满屏乱冒箭头。
    expect(content).not.toContain("resolveReorderPointerZone");
    expect(content).not.toContain('window.addEventListener("mousemove"');
    expect(content).toContain("onMouseEnter={() => {");
    // 5.1：不再出现悬停虚线框。
    expect(css).not.toContain(".moduleHostActive");
    expect(content).not.toContain("moduleHostActive");
    // 5.2：上下箭头纵向高度拉长约 1 倍（26 → 56）。
    const button = css.slice(css.indexOf(".reorderButton {"), css.indexOf(".reorderButton:hover"));
    expect(button).toContain("height: 56px;");
    expect(content).toContain("const REORDER_CONTROL_HEIGHT = 124;");
  });
});
