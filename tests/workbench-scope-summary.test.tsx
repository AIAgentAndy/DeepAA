import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  exportScopeHref,
  parseScopeSummaryResponse,
  ScopeSummary,
} from "../src/components/workbench/scope-summary";
import type { ScopeSummary as ScopeSummaryData } from "../src/lib/db/workbench-queries";

const summary: ScopeSummaryData = {
  scopeType: "thread",
  scopeId: "thread-1",
  requestCount: 12,
  stepRequestCount: 10,
  auxiliaryRequestCount: 2,
  inputTokens: 100,
  cacheReadTokens: 900,
  cacheWriteTokens: 20,
  outputTokens: 30,
  totalTokens: 1_050,
  cacheHitRate: 0.9,
  vendorCost: 4.8,
  actualCost: 0.45,
  durationTotalMs: 25_000,
  durationSampleCount: 10,
  averageDurationMs: 2_500,
  toolCallCount: 4,
  tools: [{ name: "exec_command", status: "completed", count: 4 }],
  toolsCandidateCount: 1,
  toolsProcessedCount: 1,
  toolsLimited: false,
  dataVersion: 8,
};

const selection = {
  target: "catapi.chat",
  agent: "codex",
  session: "session-1",
  thread: "thread-1",
  turn: "turn-1",
  step: "astep-1",
};

describe("ScopeSummary", () => {
  test("聚合条只展示统计范围和当前 scope 路径，不再渲染跳转按钮", () => {
    const html = renderToStaticMarkup(
      <ScopeSummary summary={summary} scopeType="thread" selection={selection} />,
    );

    // 五项聚合指标（总请求数 / 总 Token / 总消费 / 平均耗时 / 工具调用）已整体移除。
    expect(html).not.toContain("总请求数");
    expect(html).not.toContain("总 Token");
    expect(html).not.toContain("总消费");
    expect(html).not.toContain("平均耗时");
    expect(html).not.toContain("工具调用");
    expect(html).not.toContain("10 Step · 2 辅助请求");
    expect(html).not.toContain("非缓存输入 100");
    expect(html).not.toContain("缓存读取 900");
    expect(html).not.toContain("缓存写入 20");
    expect(html).not.toContain("输出 30");
    expect(html).not.toContain("缓存命中率");
    expect(html).not.toContain("倍率后实际");
    expect(html).not.toContain("exec_command");
    // 聚合条不再承担跨页跳转，跳转入口下沉到「交互内容」页签内的「新窗口打开」按钮。
    expect(html).not.toContain("查看本Thread交互内容");
    expect(html).not.toContain('class="summary-view-action');
    // 仍保留：统计范围 + 当前范围 + 完整路径
    expect(html).toContain("统计范围");
    expect(html).toContain("当前 Thread");
    expect(html).toContain("catapi.chat / codex / session-1 / thread-1");
  });

  test("四种查看链接只保留对应范围", () => {
    expect(exportScopeHref("session", selection)).toBe(
      "/export?target=catapi.chat&agent=codex&session=session-1",
    );
    expect(exportScopeHref("thread", selection)).toBe(
      "/export?target=catapi.chat&agent=codex&session=session-1&thread=thread-1",
    );
    expect(exportScopeHref("turn", selection)).toBe(
      "/export?target=catapi.chat&agent=codex&session=session-1&thread=thread-1&turn=turn-1",
    );
    expect(exportScopeHref("step", selection)).toBe(
      "/export?target=catapi.chat&agent=codex&session=session-1&thread=thread-1&turn=turn-1&step=astep-1&scope=step",
    );
  });

  test("没有选择范围时显示空路径且不再渲染跳转按钮", () => {
    const html = renderToStaticMarkup(
      <ScopeSummary scopeType="session" selection={{}} />,
    );

    expect(html).toContain("暂无选择范围");
    expect(html).not.toContain("暂无统计数据");
    expect(html).not.toContain("查看本Session交互内容");
    expect(html).not.toContain('class="summary-view-action');
    expect(html).not.toContain('href="/export"');
  });

  test("统计响应严格校验当前 scope", () => {
    expect(parseScopeSummaryResponse({ summary, derivedStatus: "idle" }, "thread", "thread-1"))
      .toEqual(summary);
    expect(parseScopeSummaryResponse({
      summary: { ...summary, toolCallCount: -1 },
      derivedStatus: "idle",
    }, "thread", "thread-1")).toBeUndefined();
    expect(parseScopeSummaryResponse({ summary, derivedStatus: "idle" }, "turn", "thread-1"))
      .toBeUndefined();
  });
});
