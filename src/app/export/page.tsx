import type {Metadata} from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import {
  ExportContent,
  type ExportFilterData,
} from "@/components/export-content";
import { SiteFooter } from "@/components/site-footer";
import { agentDisplayName } from "@/lib/agent-display";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  loadExportFilterData,
  resolveExportDeepLinkRedirect,
} from "@/lib/db/export-queries";
import { ProxyConfigStore } from "@/proxy-config";
import { readRetentionConfig } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = {title: "交互内容 - DeepAA - Deep Agent Analytics"};

interface ExportPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ExportPage({ searchParams }: ExportPageProps) {
  const query = await searchParams;
  const dataDir = resolveDeepaaDataDir();
  const db = getDeepaaDatabase(dataDir);
  normalizeExportDeepLink(query, db);
  const rawFilterData = loadExportFilterData(db, {
    target: query.target,
    agent: query.agent,
    session: singleValue(query.session),
    thread: singleValue(query.thread),
    turn: singleValue(query.turn),
    step: singleValue(query.step),
  });
  const filterData: ExportFilterData = {
    ...rawFilterData,
    agents: rawFilterData.agents.map((option) => ({
      ...option,
      label: agentDisplayName(option.value),
    })),
  };
  const sessionCount = db.prepare(
    "SELECT COUNT(*) FROM agent_sessions",
  ).pluck().get() as number;
  const turnCount = db.prepare(
    "SELECT COUNT(*) FROM agent_turns",
  ).pluck().get() as number;

  return (
    <main className="app-shell export-page-shell">
      <AppHeader
        subtitle="交互还原 · 上下文去重 · 证据导出"
        metrics={[
          { label: "业务会话", value: sessionCount },
          { label: "Turn", value: turnCount },
        ]}
      />

      <div className="page-wrap page-wrap-fill">
        <ExportContent filterData={filterData} retentionDays={readRetentionConfig(dataDir).rawRetentionDays} />
      </div>
      <SiteFooter />
    </main>
  );
}

/**
 * 深链接归一化（2026-09-17 用户确认）：交互内容页不接受「无 Session」状态——
 * step/thread/turn 深链接沿 SQLite 外键回填缺失上级（含 target/agent），
 * 四个范围参数全空时自动选中当前过滤下最新的 session，全部 302 回填 URL 让
 * 筛选框自动选中整条从属链。显式给出的参数与解析结果冲突时不覆盖；
 * 库中无 session 时按空态渲染。
 */
function normalizeExportDeepLink(
  query: Record<string, string | string[] | undefined>,
  db: ReturnType<typeof getDeepaaDatabase>,
): void {
  const additions = resolveExportDeepLinkRedirect(db, {
    targets: listValues(query.target),
    agents: listValues(query.agent),
    session: singleValue(query.session),
    thread: singleValue(query.thread),
    turn: singleValue(query.turn),
    step: singleValue(query.step),
  });
  if (!additions) return;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    const joined = Array.isArray(value) ? value.join(",") : value;
    if (joined) params.set(key, joined);
  }
  for (const [key, value] of Object.entries(additions)) {
    params.set(key, value);
  }
  redirect(`/export?${params.toString()}`);
}

function listValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => item.trim()).filter(Boolean);
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
