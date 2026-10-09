import {GithubMark} from "@/components/github-mark";

/** 项目主页地址（2026-09-18 用户指定）。 */
const GITHUB_URL = "https://github.com/AIAgentAndy/DeepAA";

/**
 * 全站公共 slim footer（v4.3）：48px 深松绿收口。
 * 品牌文案整行居中，右下角 GitHub 入口（新标签页打开）。入口右边缘与公共 Header
 * 右上角操作区（主题切换图标）右边缘严格对齐：它绝对定位在 .site-footer-inner 内，
 * 而该内层容器与 .topbar-inner 使用完全相同的限宽与内边距。
 * 纯静态结构，无客户端逻辑，五页共用。
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <span className="site-footer-brand">
          DeepAA
          <i>·</i>
          Deep Agent Analytics
          <i>·</i>
          Local-first Gateway, Observability, Analytics, and Harness intelligence for AI agents.
        </span>
        <a
          className="site-footer-github"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer noopener"
          title="在新标签页打开 GitHub 仓库 AIAgentAndy/DeepAA"
        >
          <GithubMark size={14} />
          <span>GitHub</span>
        </a>
      </div>
    </footer>
  );
}
