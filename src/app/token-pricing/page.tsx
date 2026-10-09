import { Suspense } from "react";
import type {Metadata} from "next";
import { AppHeader } from "@/components/app-header";
import { SiteFooter } from "@/components/site-footer";
import { TokenPricingContent } from "@/components/token-pricing-content";
import { ProxyConfigStore } from "@/proxy-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = {title: "Token价格 - DeepAA - Deep Agent Analytics"};

export default async function TokenPricingPage() {

  return (
    <main className="app-shell token-pricing-shell">
      <AppHeader
        subtitle="Token 账本 · 价格快照 · 成本追踪"
        metrics={[{ label: "计费账本", value: "按请求" }]}
      />

      {/* 普通限宽容器（同仪表盘）：文档级原生滚动，不做视口高度锁定。 */}
      <div className="page-wrap">
        <Suspense fallback={null}>
          <TokenPricingContent />
        </Suspense>
      </div>
      <SiteFooter />
    </main>
  );
}
