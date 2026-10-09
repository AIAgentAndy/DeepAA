import { Suspense, type ReactNode } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { PricingSettingsDialog } from "@/components/pricing-settings-dialog";
import { ManagementMenu } from "@/components/management-menu";
import { TimeZoneSelect } from "@/components/timezone-select";
import { ProviderCatalogUpdatesDialog } from "@/components/provider-catalog-updates-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { ViewToggle } from "@/components/view-toggle";

/** 兼容旧调用方的传参类型（2026-09-10 用户决策：右上角文案区整块移除，不再渲染）。 */
export interface AppHeaderMetric {
  label: string;
  value: ReactNode;
}

interface AppHeaderProps {
  /** 页面定位说明（v4.2 仅作为品牌区 title 提示，不再单独占一行文案）。 */
  subtitle: string;
  /** 兼容保留：右上角状态文案区已整块移除（2026-09-10 用户决策），传参被忽略。 */
  metrics?: AppHeaderMetric[];
  showThemeToggle?: boolean;
}

/**
 * 顶级页面公共头部（v4.2）：深青绿实底通栏色带 + 内层与正文同宽限宽居中。
 * 左品牌（仅 DeepAA / Deep Agent Analytics）· 导航居中等距散开 · 右操作区；五页共用。
 */
export function AppHeader({ subtitle, showThemeToggle = true }: AppHeaderProps) {
  const taglineTitle = subtitle
    ? `${subtitle} · local-first gateway, observability, analytics, and harness intelligence for AI agents`
    : "local-first gateway, observability, analytics, and harness intelligence for AI agents";
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand-lockup">
          <BrandLogo />
          <div>
            <div className="brand-name">DeepAA</div>
            <p className="brand-tagline" title={taglineTitle}>Deep Agent Analytics</p>
          </div>
        </div>
        <Suspense fallback={null}>
          <ViewToggle />
        </Suspense>
        <div className="proxy-strip">
          {/* 右上角状态文案区已整块移除（2026-09-10 用户决策）：只保留功能入口图标。 */}
          <TimeZoneSelect />
          <ProviderCatalogUpdatesDialog />
          {/* 2026-09-14 用户确认：价格中心与存储管理收敛到「管理」下拉入口。 */}
          <PricingSettingsDialog hideTrigger />
          <ManagementMenu />
          {showThemeToggle ? <ThemeToggle /> : null}
        </div>
      </div>
    </header>
  );
}
