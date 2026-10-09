import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

/**
 * 会话追踪三栏配色 v5「松玉青绿」守卫测试。
 *
 * 用户在 2026-09-18 确认的四条视觉契约：
 * ① 第一栏（会话树）保持既有层级结构，选中只有一种语言：松玉雾填充 + 3px 松玉实边；
 * ② 选中 Turn 行的填充色 === 第二栏纸色 —— 跨栏色带送过去的颜色与目标栏背景同值，
 *    所以边界与栏内都不存在色差；
 * ③ 选中 Step 卡片的填充色 === 第三栏纸色（白），同理无缝；
 * ④ 三栏不再有 4px 粗彩条；第三栏内部小块统一（价格成本不再单独染色）。
 *
 * 这些不变量散落在 12k 行的 globals.css 里，被改坏时视觉上只表现为「色带断了 /
 * 栏里两块颜色对不上」，评审很难发现，因此用测试钉住。
 */

type TokenBlock = Map<string, string>;

/** 收集某个选择器块里的自定义属性（去注释后精确匹配选择器）。 */
function readTokens(css: string, selector: string): TokenBlock {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens: TokenBlock = new Map();
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map(item => item.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of match[2]!.matchAll(/(--[0-9a-z-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(decl[1]!, decl[2]!.trim());
    }
  }
  return tokens;
}

/** 跟踪 var(--x) 引用链，返回最终字面量。 */
function resolveValue(blocks: TokenBlock[], value: string, depth = 0): string {
  const trimmed = value.trim();
  if (depth > 8) return trimmed;
  const match = trimmed.match(/^var\((--[0-9a-z-]+)(?:\s*,\s*(.+))?\)$/);
  if (!match) return trimmed;
  for (const block of blocks) {
    const next = block.get(match[1]!);
    if (next !== undefined) return resolveValue(blocks, next, depth + 1);
  }
  if (match[2] !== undefined) return resolveValue(blocks, match[2]!, depth + 1);
  return trimmed;
}

/** 收集命中指定选择器的声明块（支持逗号选择器列表）。 */
function ruleBodies(css: string, selector: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies: string[] = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map(item => item.trim());
    if (selectors.includes(selector)) bodies.push(match[2]!);
  }
  return bodies;
}

function expectRule(css: string, selector: string, declarations: string[]): void {
  const bodies = ruleBodies(css, selector);
  expect(bodies.length, `未找到规则 ${selector}`).toBeGreaterThan(0);
  for (const declaration of declarations) {
    expect(
      bodies.some(body => body.includes(declaration)),
      `${selector} 缺少声明 ${declaration}`,
    ).toBe(true);
  }
}

describe("会话追踪三栏配色 v5 · 松玉青绿", () => {
  test("选中 Turn 行的填充色就是第二栏的纸色（同值才可能无缝）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const root = readTokens(css, ":root");
    const workbench = readTokens(css, ".workbench");
    const blocks = [workbench, root];

    const rowSelected = resolveValue(blocks, workbench.get("--row-selected-bg")!);
    const colEvent = resolveValue(blocks, workbench.get("--col-event")!);
    const handoff = resolveValue(blocks, workbench.get("--handoff-scope")!);

    expect(rowSelected).toBe(colEvent);
    expect(handoff).toBe(colEvent);
    // 第二栏必须是松玉雾，而不是白 —— 否则第一栏的选中色无从"延展"过去
    expect(colEvent).toBe(resolveValue(blocks, root.get("--pine-50")!));

    expectRule(css, ".sqlite-workbench .tree-turn.selected-scope", [
      "background: var(--row-selected-bg)",
      "box-shadow: inset 3px 0 0 var(--row-selected-line)",
    ]);
    expectRule(css, ".workbench-connector", ["var(--handoff-scope)"]);
  });

  test("选中 Step 卡片的填充色就是第三栏的纸色（白）", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    const root = readTokens(css, ":root");
    const workbench = readTokens(css, ".workbench");
    const blocks = [workbench, root];

    const colEvidence = resolveValue(blocks, workbench.get("--col-evidence")!);
    const handoffEvidence = resolveValue(blocks, workbench.get("--handoff-evidence")!);
    expect(colEvidence).toBe(resolveValue(blocks, root.get("--surface")!));
    expect(handoffEvidence).toBe(colEvidence);

    // 选中卡片 = 白底 + 右侧直角 + 贴到本栏右缘；不能有描边或左侧竖线挡住连接
    const bodies = ruleBodies(css, ".sqlite-workbench .step-row.active .step-card");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some(body => body.includes("background: var(--row-step-bg, var(--surface))"))).toBe(true);
    expect(bodies.some(body => body.includes("border-color: transparent"))).toBe(true);
    expect(bodies.some(body => body.includes("border-radius: 10px 0 0 10px"))).toBe(true);
    // 右延由 workbench-connector 白带 + 第三栏门洞负责；卡片自身不得负 margin
    // 外溢——纵向滚动容器会出现横向滚动条并裁切内容，且越过第三栏左缘会清空连接带
    // （2026-09-20 根治）。
    expect(bodies.some(body => body.includes("margin-right: 0"))).toBe(true);
    expectRule(css, ".workbench-connector.rail-violet", ["var(--handoff-evidence)"]);
  });

  test("三栏不再有 4px 彩色粗顶轨，栏面只有白卡与松玉雾两档", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    expect(css).not.toContain("border-top: 4px solid var(--rail-");
    expectRule(css, ".sqlite-workbench .session-tree-column", [
      "background-color: var(--col-scope)",
      "border-top: 1px solid var(--line)",
    ]);
    expectRule(css, ".sqlite-workbench .timeline-column", ["background-color: var(--col-event)"]);
    // 列头识别改用 22px 色块，而不是色条
    expectRule(css, ".sqlite-workbench .workbench-panel-head .rail-mark", [
      "width: 22px",
      "height: 22px",
    ]);
  });

  test("第三栏小块统一：价格成本不再单独染色，页签是下划线式", async () => {
    const css = await readFile("src/app/globals.css", "utf8");
    expectRule(css, ".sqlite-workbench .fact", ["background: var(--surface-2)"]);
    const pricingFact = ruleBodies(css, ".sqlite-workbench .pricing-cost-panel .fact");
    expect(pricingFact.length).toBeGreaterThan(0);
    for (const body of pricingFact) {
      expect(body).toContain("var(--surface-2)");
      expect(body).not.toContain("gold");
    }
    // 页签：下划线，不是胶囊
    expectRule(css, ".sqlite-workbench .tab-strip button.active::after", [
      "background: var(--pine-700)",
      "height: 3.5px",
    ]);
    expect(css).not.toContain("--panel-surface");
    expect(css).not.toContain("--block-surface");
  });

  test("已删除常驻状态条与 SQLite 诊断区块，提示不再随刷新抖动", async () => {
    const [client, css] = await Promise.all([
      readFile("src/components/harness-workbench.tsx", "utf8"),
      readFile("src/app/globals.css", "utf8"),
    ]);
    expect(client).not.toContain("statusStripText");
    expect(client).not.toContain("statusStripTone");
    expect(client).not.toContain("inspector-status-strip");
    expect(client).not.toContain("SQLite 预览与派生诊断");
    expect(client).toContain("会话数据分析失败：请查看服务端日志。");
    expect(css).not.toContain(".inspector-status-strip");
  });

  test("跨栏色带几何：源取选中卡片本体，只探入目标栏 1px", async () => {
    const client = await readFile("src/components/harness-workbench.tsx", "utf8");
    // 源必须是卡片而不是整行：行带 10~12px 下内边距，色带会比白块高出一截
    expect(client).toContain('measure(".step-row.active .step-card", ".inspector-column", false)');
    expect(client).toContain("const overlap = 10;");
    // 只压住目标栏那 1px 边框；探入更多会把目标栏左缘边线整段盖掉（用户反馈"像压着右栏"）
    expect(client).toContain("const penetrate = 1;");
  });

  test("第二栏是时间线：类型图标 + 动作标题 + 关键元信息", async () => {
    const client = await readFile("src/components/harness-workbench.tsx", "utf8");
    expect(client).toContain("function timelineKind(");
    expect(client).toContain("function timelineTitle(");
    expect(client).toContain("function timelineIcon(");
    expect(client).toContain('className={`step-row tl-${timelineKind(row.step)}');
    // 元信息：直连/代理 · 状态码 · 耗时 · 首字
    expect(client).toContain('{row.step.origin === "agent_local_import" ? "直连" : "代理"}');
    expect(client).toContain("{row.step.httpStatus}");
    expect(client).toContain("formatDuration(row.step.durationMs)");
    expect(client).toContain("首字 {formatFirstTokenLatency(row.step.firstTokenMs)}");
  });

  test("本 Turn 用户输入卡片：内部滚动 + 复制 + 真实截断标记", async () => {
    const [client, queries, preview] = await Promise.all([
      readFile("src/components/harness-workbench.tsx", "utf8"),
      readFile("src/lib/db/workbench-queries.ts", "utf8"),
      readFile("src/lib/ingestion/content-preview.ts", "utf8"),
    ]);
    expect(client).toContain("turn-user-prompt-text");
    expect(client).toContain("已复制");
    expect(client).not.toContain("展开全文");
    // 截断判定必须来自投影条目事实，而不是长度阈值猜测
    expect(queries).toContain("chosen.truncated === true");
    expect(preview).toContain("truncated: this.previewTextBytes < this.originalTextBytes");
  });
});
