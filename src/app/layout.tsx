import type { Metadata } from "next";
import {AppDialogs} from "@/components/confirm-dialog";
import {CatalogMaintenanceBanner} from "@/components/catalog-maintenance-banner";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeepAA",
  description: "DeepAA · Deep Agent Analytics - local-first gateway, observability, analytics, and harness intelligence for AI agents.",
};

/** 主题防闪烁初始化：hydration 前写 data-theme（localStorage 偏好 → 系统偏好兜底）。 */
const THEME_INIT_SCRIPT = `(() => { try { const stored = localStorage.getItem("deepaa-theme"); const theme = stored === "dark" || stored === "light" ? stored : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); document.documentElement.dataset.theme = theme; } catch {} })();`;
/** 规范主机收敛（全站统一 127.0.0.1）：以 localhost/::1 别名打开的页面在
    hydration 前一次性 replace 到 127.0.0.1，保证后续 dsh 弹窗等导航为
    同站（SameSite=Strict cookie 才会附带）。不用服务端 307：Next 16 会把
    middleware 重定向的 Location 改写为相对路径，跨主机重定向会原地打转。 */
const CANONICAL_HOST_SCRIPT = `(() => { try { const h = location.hostname.toLowerCase(); if (h === "localhost" || h === "::1" || h === "[::1]") { location.replace(location.protocol + "//127.0.0.1" + (location.port ? ":" + location.port : "") + location.pathname + location.search + location.hash); } } catch {} })();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* React 19 下组件树内普通 <script> 在 client 渲染时会触发
            "Scripts inside React components"警告；async script 走 React 19 的
            特殊资源路径（hoist + 去重执行，不重复执行、无警告）。inline 脚本的
            浏览器行为不受 async 影响（仍同步执行），防闪烁语义不变。 */}
        <script async dangerouslySetInnerHTML={{__html: THEME_INIT_SCRIPT}} />
        <script async dangerouslySetInnerHTML={{__html: CANONICAL_HOST_SCRIPT}} />
      </head>
      <body>
        <CatalogMaintenanceBanner />
        {children}
        <AppDialogs />
      </body>
    </html>
  );
}
