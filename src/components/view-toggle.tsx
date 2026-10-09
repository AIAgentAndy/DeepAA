"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CircleDollarSign,
  LayoutDashboard,
  ListTree,
  MessageSquareText,
  Server,
} from "lucide-react";
import { topLevelNavHref, type TopLevelPath } from "@/lib/shared-selection";

/**
 * 顶部导航：在仪表盘、会话追踪、交互内容、Token价格和供应商管理页面间切换。
 * 仪表盘 (/dashboard) = 默认首页：小时事实趋势、维度分析和套餐/订阅价值审计
 * 会话追踪 (/sessions) = session/turn/step 维度的调用链详情
 * 交互内容 (/export) = 大模型请求响应的提示词与输出查看/下载
 * Token价格 (/token-pricing) = 每次请求的 token 价格快照、成本和耗时列表
 * 基于 pathname 判断当前页。业务上下文参数只在三个数据页之间互带（2026-09-24
 * 用户确认）；切向仪表盘/供应商管理不带参数，从这两页切向数据页同样不带。
 */
export function ViewToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activePath = pathname === "/export" || pathname === "/token-pricing" || pathname === "/proxy-management" || pathname === "/dashboard" || pathname === "/sessions" ? pathname : "/dashboard";

  function go(target: TopLevelPath) {
    const liveSearch = typeof window === "undefined" ? searchParams.toString() : window.location.search;
    router.push(topLevelNavHref(target, activePath, new URLSearchParams(liveSearch)), { scroll: false });
  }

  return (
    <nav className="header-nav" aria-label="页面导航">
      <button
        type="button"
        className={`nav-tab${activePath === "/dashboard" ? " active" : ""}`}
        onClick={() => go("/dashboard")}
      >
        <LayoutDashboard aria-hidden="true" />
        仪表盘
      </button>
      <button
        type="button"
        className={`nav-tab${activePath === "/sessions" ? " active" : ""}`}
        onClick={() => go("/sessions")}
      >
        <ListTree aria-hidden="true" />
        会话追踪
      </button>
      <button
        type="button"
        className={`nav-tab${activePath === "/export" ? " active" : ""}`}
        onClick={() => go("/export")}
      >
        <MessageSquareText aria-hidden="true" />
        交互内容
      </button>
      <button
        type="button"
        className={`nav-tab${activePath === "/token-pricing" ? " active" : ""}`}
        onClick={() => go("/token-pricing")}
      >
        <CircleDollarSign aria-hidden="true" />
        Token价格
      </button>
      <button
        type="button"
        className={`nav-tab${activePath === "/proxy-management" ? " active" : ""}`}
        onClick={() => go("/proxy-management")}
      >
        <Server aria-hidden="true" />
        供应商管理
      </button>
    </nav>
  );
}
