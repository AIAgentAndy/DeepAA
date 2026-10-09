import type {Metadata} from "next";
import {AppHeader} from "@/components/app-header";
import {ProxyManagementPage} from "@/components/proxy-management-page";
import {SiteFooter} from "@/components/site-footer";
import {ProxyConfigStore} from "@/proxy-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = {title: "供应商管理 - DeepAA - Deep Agent Analytics"};

export default async function ProxyManagementRoute() {
  const proxyConfigStore = new ProxyConfigStore();
  await proxyConfigStore.init();
  const proxyConfig = proxyConfigStore.getConfig();

  return (
    <main className="app-shell proxy-management-shell">
      <AppHeader
        subtitle="供应商管理 · Agent 接入 · 网关路由 · CLI 同步"
        metrics={[{label: "供应商", value: proxyConfig.targets?.length ?? 0}]}
      />
      <div className="page-wrap page-wrap-fill">
        <ProxyManagementPage initialConfig={proxyConfig} />
      </div>
      <SiteFooter />
    </main>
  );
}
