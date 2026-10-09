import type {Metadata} from "next";
import {AppHeader} from "@/components/app-header";
import {DashboardContent} from "@/components/dashboard-content";
import {DashboardLauncher} from "@/components/dashboard/dashboard-launcher";
import {SiteFooter} from "@/components/site-footer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = {title: "仪表盘 - DeepAA - Deep Agent Analytics"};

/**
 * 仪表盘：应用默认首页。时间范围是唯一过滤维度；URL 只保留 start/end（排他边界，小时对齐）。
 * 正文最上方承载 Agent 一键启动与供应商状态栏，下方是汇总分析模块。
 */
export default async function DashboardPage({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const values = await searchParams;
  const initialRange = new URLSearchParams();
  for (const key of ["start", "end", "tz"] as const) {
    const value = values[key];
    if (typeof value === "string" && value) initialRange.set(key, value);
  }
  return (
    <main className="app-shell dashboard-shell">
      <AppHeader subtitle="实时数据分析 · 小时聚合视图" metrics={[{label: "更新", value: "≤ 5 分钟"}]} showThemeToggle />
      <div>
        <DashboardLauncher />
        <DashboardContent initialQuery={initialRange.toString()} />
      </div>
      <SiteFooter />
    </main>
  );
}
