import type {Metadata} from "next";
import {AppHeader} from "@/components/app-header";
import {SiteFooter} from "@/components/site-footer";
import {AgentCapabilitiesPage} from "@/components/agent-capabilities/agent-capabilities-page";
import {loadMechanismProfiles} from "@/lib/agent-capabilities/mechanism-profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = {title: "Agent 能力 - DeepAA - Deep Agent Analytics"};

/**
 * P1-6（2026-11-03）：「Agent 能力」一级页面（最小版：本机能力台账总览）。
 * 数据由客户端按需拉取 /api/agent-capabilities（只读有界扫描 + 60s 缓存）；
 * 机制剖面 / 使用分析等视图后续批次充实。
 */
export default async function AgentCapabilitiesRoute() {
  const mechanismProfiles = await loadMechanismProfiles();
  return (
    <main className="app-shell agent-capabilities-shell">
      <AppHeader subtitle="Agent 能力 · 本机能力台账 · 底层机制与使用分析" />
      <div className="page-wrap page-wrap-fill">
        <AgentCapabilitiesPage mechanismProfiles={mechanismProfiles} />
      </div>
      <SiteFooter />
    </main>
  );
}
