import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

/**
 * 交互内容页列表形态约束（2026-09-18 用户确认）。
 *
 * 背景：`79a59d6` 把列表改成 8 列 `<table class="exp-table">`，用户确认该形态
 * 「字段太多、不再是原来的样子」。这里锁死回退结果，防止后续又被改回表格：
 *   - 每行 = 标题行（# / 时间 / Agent 彩色徽标 + 供应商 / 模型 / 状态徽标 / 操作）
 *     + 正文两行（输入摘要 / 输出摘要）；
 *   - 行与行之间用细线分隔（一整块表格式面板），不再各自成卡、也没有左侧 Agent 色带；
 *   - 展开仍走每条独立的 Map（多开互不收起），正文继续用原 NDJSON 流式渲染链路。
 */
describe("交互内容列表形态", () => {
  test("不再使用 8 列表格，恢复卡片式行（2026-09-18 用户确认）", async () => {
    const viewer = await readFile("src/components/conversation-export-viewer.tsx", "utf8");
    const css = await readFile("src/app/globals.css", "utf8");
    expect(viewer).not.toContain("exp-table");
    expect(viewer).not.toContain("exp-row-group");
    expect(viewer).not.toContain("exp-col-");
    expect(css).not.toContain(".exp-table");
    expect(css).not.toContain(".exp-row-main");
    expect(css).not.toContain(".exp-col-");
    // 恢复后的结构：外层一整块 + 每行 section。
    expect(viewer).toContain('className="exp-list-table"');
    expect(viewer).toContain('className="exp-list-head"');
    expect(viewer).toContain('className="exp-list-body"');
    expect(css).toContain(".exp-list-table {");
    expect(css).toContain(".exp-list-head {");
    expect(css).toContain(".exp-list-body {");
  });

  test("去掉左侧 Agent 色带，改用彩色徽标；行间以细线分隔", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const rowRule = css.slice(css.indexOf(".exp-list-row {"), css.indexOf(".exp-list-head {"));
    // 旧「蓝线」来自 .exp-list-row::before 的 3px 色带，必须彻底消失。
    expect(css).not.toContain(".exp-list-row::before");
    expect(css).not.toContain(".exp-list-row.auxiliary::before");
    // 行与行之间用表格式细线分隔。
    expect(rowRule).toContain("border-bottom: 1px solid var(--line-2)");
    expect(css).toContain(".exp-list-row:last-child {");
    // Agent 主色只用于徽标。
    expect(css).toContain('.exp-list-row[data-agent="codex"]');
    expect(css).toContain(".exp-agent-badge {");
  });

  test("正文只保留输入摘要与输出摘要两行，模型与状态徽标留在标题行", async () => {
    const viewer = await readFile("src/components/conversation-export-viewer.tsx", "utf8");
    const body = viewer.slice(
      viewer.indexOf('className="exp-list-body"'),
      viewer.indexOf('className="exp-list-detail"'),
    );
    expect(body).toContain("exp-list-summary-side");
    expect(body).toContain("输入");
    expect(body).toContain("输出");
    expect(body).toContain("requestSummaryText");
    expect(body).toContain("responseSummaryText");
    // 「那么多字段」不允许回到正文区：模型/状态/耗时只在标题行出现。
    expect(body).not.toContain("exp-list-model");
    expect(body).not.toContain("exchange-http-status");
    expect(body).not.toContain("exchange-duration");
    const head = viewer.slice(
      viewer.indexOf('className="exp-list-head"'),
      viewer.indexOf('className="exp-list-body"'),
    );
    expect(head).toContain("exp-list-model");
    expect(head).toContain("exp-agent-badge");
    expect(head).toContain("exchange-http-status");
    expect(head).toContain("本步新增");
    expect(head).toContain("完整上下文");
  });

  test("全屏查看保留左上角类型文案并提供右上角复制按钮", async () => {
    const viewer = await readFile("src/components/conversation-export-viewer.tsx", "utf8");
    const css = await readFile("src/app/globals.css", "utf8");
    expect(viewer).toContain("fullscreen-copy-btn");
    expect(viewer).toContain("copyText(item.text, `${key}-fullscreen`)");
    expect(viewer).toContain("复制");
    expect(viewer).not.toContain("全屏复制");
    expect(css).toContain(".fullscreen-section-header");
    expect(css).toContain(".fullscreen-copy-btn");
    expect(css).toContain("html[data-theme=\"dark\"] .fullscreen-section-header");
  });

  test("展开为单开：点开新的一条自动收起并释放上一条，同一行同视图再点才收起", async () => {
    const viewer = await readFile("src/components/conversation-export-viewer.tsx", "utf8");
    // 2026-09-18 用户确认改回单开：不再同时堆多条展开正文。
    expect(viewer).toContain("const [expansion, setExpansion] = useState<StepExpansion>();");
    expect(viewer).not.toContain("useState<Map<string, StepExpansion>>");
    // 加载新的一条前先中止上一条的请求，避免并发堆积 raw。
    expect(viewer).toContain("stepControllerRef.current?.abort();");
    expect(viewer).toContain("if (expansion && expansion.exchangeId === row.exchangeId && expansion.mode === view) {");
    expect(viewer).not.toContain("setExpandedRow");
    // 展开正文仍走原 NDJSON 流式渲染链路与共享卡片渲染器。
    expect(viewer).toContain("streamExportContentPage");
    expect(viewer).toContain("renderExchangeCard(");
    // 展开正文放在 div 里，不再落进 <td>，避免表格单元格样式污染正文里的 Markdown 表格。
    expect(viewer).not.toContain("colSpan={8}");
    const detail = viewer.slice(
      viewer.indexOf('className="exp-list-detail"'),
      viewer.indexOf('</section>', viewer.indexOf('className="exp-list-detail"')),
    );
    expect(detail).toContain("rowExpansion?.data && exchangeGroup");
    expect(detail).toContain("renderExchangeCard(");
  });

  test("精确到 step 的深链接：进入即等价于点一次「本步新增」（2026-09-18 用户确认）", async () => {
    const viewer = await readFile("src/components/conversation-export-viewer.tsx", "utf8");
    // 用行上的内部 agentStepId 匹配 URL 的 step（同一 ID 空间），不是 exchangeId。
    expect(viewer).toContain("autoExpandedStepRef");
    expect(viewer).toContain("const row = rows.find(item => item.agentStepId === step);");
    // 2026-09-21：embedded 下钻（查看原文）默认展开「完整上下文」（该类别条目排重后
    // 几乎全是继承），整页深链仍默认「本步新增」。
    // 默认视图仍为「本步新增」；仅「查看原文 →」的类别下钻（initialQuery 带
    // categories，该类别条目排重后几乎全是继承）默认展开「完整上下文」。
    expect(viewer).toContain('void loadStep(row.exchangeId, defaultView);');
    // 默认「本步新增」；仅「查看原文 →」的类别下钻（drillCategories prop）默认展开
    // 「完整上下文」（该类别条目排重后几乎全是继承）。
    expect(viewer).toContain('embedded && (drillCategories?.length ?? 0) > 0 ? "full" : "new"');
    // 同一 step 只自动展开一次：用户手动收起后不再被弹开。
    expect(viewer).toContain("if (autoExpandedStepRef.current === step) return;");
    // 2026-09-21 用户确认：embedded（会话追踪「交互内容」页签）整体共用一级页的
    // 「列表行 + 行展开」效果，自动展开不再区分整页/内嵌。
    expect(viewer).toContain("if (!step) return;");
  });

  test("斑马纹 / 悬停 / 展开三种底色两两可辨（2026-09-18 用户确认）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const zebra = css.slice(
      css.indexOf(".exp-list-row:nth-child(even) {"),
      css.indexOf(".exp-list-row.auxiliary {"),
    );
    // 斑马纹必须与悬停色是不同色系：悬停改用更深一档的松绿，不再复用表面灰阶。
    expect(zebra).toContain("background: color-mix(in srgb, var(--surface-2) 45%, var(--surface-1));");
    expect(zebra).toContain("background: color-mix(in srgb, var(--pine-300) 34%, var(--surface-1));");
    // 展开态与悬停态区分开，但同属松绿家族。
    expect(zebra).toContain("background: color-mix(in srgb, var(--pine-100) 70%, var(--surface-1));");
    expect(zebra).toContain("background: color-mix(in srgb, var(--pine-300) 46%, var(--surface-1));");
    // 旧的撞色写法（悬停用 --surface-3）必须消失。
    expect(zebra).not.toContain("var(--surface-3) 45%");
  });
});
