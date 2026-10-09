import type {Metadata} from "next";
import { AppHeader } from "@/components/app-header";
import { HarnessWorkbench } from "@/components/harness-workbench";
import { SiteFooter } from "@/components/site-footer";
import { getDeepaaDatabase } from "@/lib/db/connection";
import { loadWorkbenchTree } from "@/lib/db/workbench-queries";
import { ProxyConfigStore } from "@/proxy-config";
import { appendWorkbenchRangeParams, resolveWorkbenchRangeParams } from "@/lib/workbench-time-range";
import { DEFAULT_TIME_ZONE, timeZoneOffsetMinutes } from "@/lib/timezones";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { readRetentionConfig } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = {title: "会话追踪 - DeepAA - Deep Agent Analytics"};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["target", "agent", "session", "thread", "turn", "step"] as const) {
    const value = resolvedSearchParams[key];
    if (typeof value === "string" && value) params.set(key, value);
  }
  // tab 是第三栏页签的初始视图（客户端只识别 context/capabilities/interaction 等
  // 合法值，非法回落「总览」）；原样透传给客户端，保证深链的 SSR 与 hydration 初值一致。
  const requestedTab = resolvedSearchParams.tab;
  if (typeof requestedTab === "string" && requestedTab) params.set("tab", requestedTab);
  const requestedView = resolvedSearchParams.view;
  if (
    requestedView === "session"
    || requestedView === "thread"
    || requestedView === "turn"
  ) {
    params.set("view", requestedView);
  }
  // 时间范围是本页私有参数：缺省按「今天」兜底（服务端无 localStorage，按东八区；
  // 客户端挂载后按右上角全局偏好校正），跨度不设上限（2026-09-21 用户确认，
  // 统一受存储管理的保留窗口约束），并把规范化后的值传给首屏树查询与客户端
  // （两端语义一致）。
  const range = resolveWorkbenchRangeParams(resolvedSearchParams, new Date(), timeZoneOffsetMinutes(DEFAULT_TIME_ZONE));
  appendWorkbenchRangeParams(params, range);
  const state = loadWorkbenchTree(getDeepaaDatabase(), params, {
    limit: 50,
    includeAllTargets: true,
  });
  const sourceBadge = "sourceBadge";
  const confidenceBadge = "confidenceBadge";

  return (
    <main className="app-shell sessions-page-shell" data-source-token={sourceBadge} data-confidence-token={confidenceBadge}>
      <AppHeader
        subtitle="本地抓包 · 分层派生 · 证据驱动"
        metrics={[
          { label: "会话", value: state.candidateCount },
          { label: "当前页 Thread", value: state.agents.flatMap(agent => agent.sessions).reduce((sum, session) => sum + session.threadCount, 0) },
        ]}
      />

      <div className="sessions-shell">
        <HarnessWorkbench
          tree={state}
          initialQuery={params.toString()}
          initialRange={range}
          retentionDays={readRetentionConfig(resolveDeepaaDataDir()).rawRetentionDays}
        />
      </div>

      <span className="sr-only">时间线 上下文 Diff 请求 响应 Harness</span>
      <SiteFooter />
    </main>
  );
}
