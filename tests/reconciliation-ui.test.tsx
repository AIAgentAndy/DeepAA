import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, test} from "vitest";
import {readFile} from "node:fs/promises";
import {ReconciliationPanel} from "../src/components/reconciliation-panel.js";

describe("Token 价格站点结算视图", () => {
  test("面板静默化：标题与文案更新，初始只做本地摘要读取", () => {
    const html = renderToStaticMarkup(
      createElement(ReconciliationPanel, {targetId: "catapi.chat"}),
    );
    expect(html).toContain("中转站结算小时对账补差");
    expect(html).not.toContain("请求时间轴");
    expect(html).not.toContain("旧五分钟");
    expect(html).not.toContain("显示无消费小时");
  });

  test("面板只装配待复核操作：确认补差与忽略弹窗、无旧窗口与空小时入口", async () => {
    const source = await readFile(
      new URL("../src/components/token-pricing-content.tsx", import.meta.url), "utf8",
    );
    // 2026-10-10 供应商多选：单选时下传 targetId，多选/未选退回全量口径（undefined）。
    expect(source).toContain("targetId={filters.target && !filters.target.includes(\",\") ? filters.target : undefined}");
    expect(source).not.toContain("applyReconciliation(window.id)");
    expect(source).not.toContain("按站点补差");
    const panel = await readFile(
      new URL("../src/components/reconciliation-panel.tsx", import.meta.url), "utf8",
    );
    // 2026-09-28 展示定稿：静默（candidateCount 为 0 不渲染）、图标按钮、统一弹窗。
    expect(panel).toContain("candidateCount ?? 0) === 0) return null");
    expect(panel).toContain("确认补差");
    expect(panel).toContain("忽略该小时残差");
    expect(panel).toContain("SimpleDialog");
    expect(panel).not.toContain("window.confirm");
    expect(panel).toContain("reason.trim().length < 4");
    expect(panel).not.toContain("legacyCount");
    expect(panel).not.toContain("显示无消费小时");
    expect(panel).not.toContain("另有");
    const dialog = await readFile(
      new URL("../src/components/simple-dialog.tsx", import.meta.url), "utf8",
    );
    expect(dialog).toContain('role="dialog"');
  });

  test("摘要卡区分小时残差自动补来源（2026-09-28）", async () => {
    const panel = await readFile(
      new URL("../src/components/reconciliation-panel.tsx", import.meta.url), "utf8",
    );
    // 近 24 小时自动补差把 recon:residual: 单列条数；人工补差不混入。
    expect(panel).toContain("autoApplied24hResidualCount");
    expect(panel).toContain("小时残差 ${page.summary.autoApplied24hResidualCount} 条");
    const service = await readFile(
      new URL("../src/lib/sync-engine/service.ts", import.meta.url), "utf8",
    );
    expect(service).toContain("exchange_id LIKE 'recon:residual:%'");
    // 残差补差行用独立模型标签与逐条归属/人工补差区分。
    const ledger = await readFile(
      new URL("../src/lib/sync-engine/reconciliation/ledger.ts", import.meta.url), "utf8",
    );
    expect(ledger).toContain('"(对账补差·小时残差)"');
  });

  test("补差行展示：原始记录深链全选结果、ID 列回填原始 Step、纯金额更正倍率置 -、归因只认站点声明（2026-09-28，2026-09-29 更新）", async () => {
    const source = await readFile(
      new URL("../src/components/token-pricing-content.tsx", import.meta.url), "utf8",
    );
    // 「原始记录 ↗」与补差行 ID 链接：新标签打开 token-pricing 六元组深链，不再当前页跳 /export。
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener"');
    expect(source).toContain('topLevelHref("/token-pricing", recon.linkedSelection)');
    expect(source).not.toContain("href={`/export?step=${encodeURIComponent(item.recon.linkedStepId)}`}");
    // 深链携带 result=all（2026-09-29 用户确认）：step 已精确定位，原始行多为失败类，
    // 回落默认口径会被结果筛选滤掉导致只见补差不见原行。
    expect(source).toContain('result=all');
    // 补差行 ID 列回填挂靠的原始请求 Step（纯展示）。
    expect(source).toContain("补差行挂靠的原始请求 Step");
    // 折扣归因文案仅由服务端 discountExplainsDelta（站点声明 + 全额解释）驱动。
    expect(source).toContain("recon.discountExplainsDelta && recon.siteDiscountNano !== undefined");
    // 纯金额更正补差行零 Token，列表与详情倍率置 -；用量载体行（站点真值已回填）
    // 由 reconUsageCarrier 判定后正常展示倍率与单价。
    expect(source).toContain('item.requestKind === "reconciliation" && !reconUsageCarrier(item) ? "-" : formatDecimal(item.rateMultiplier, 4)');
    expect(source).toContain("function reconUsageCarrier(item: TokenPricingItem): boolean");
  });
});
