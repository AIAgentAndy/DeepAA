"use client";

import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

/**
 * Mermaid 图表渲染组件：拦截 ```mermaid 代码块后按当前明暗主题渲染为 SVG。
 *
 * 设计约束：
 * - mermaid 主包约 1MB+，必须按需动态 import（页面无图表时零加载）；
 *   模块级 Promise 缓存保证同页多图共享一次加载。
 * - 主题跟随 html[data-theme]（MutationObserver 监听 ThemeToggle 写入），
 *   切换主题后用对应 mermaid 主题重渲染。
 * - securityLevel 严格模式：标签转义、禁用 click 交互，与「不渲染原始 HTML」
 *   的模型输出安全姿态一致；SVG 经 mermaid 清洗后注入。
 * - 解析失败回退为源码块 + 错误提示（模型输出的 mermaid 语法不保证合法），
 *   不让一张坏图拖垮整个 Markdown 视图。
 */

type MermaidModule = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => mod.default);
    mermaidPromise.catch(() => {
      // 动态加载失败（如网络异常的 chunk）时清空缓存，下次挂载重试。
      mermaidPromise = null;
    });
  }
  return mermaidPromise;
}

/** 与 .markdown-view 正文一致的字体栈，图表文字不脱离版面气质。 */
const MERMAID_FONT_FAMILY =
  'Manrope, "Noto Sans SC", "Microsoft YaHei", -apple-system, ' +
  'BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif';

let uidCounter = 0;

/** 监听全局明暗主题（html[data-theme]），供图表随主题切换重渲染。 */
function useAppTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.dataset.theme === "dark" ? "dark" : "light");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const theme = useAppTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      loadMermaid()
        .then(async (mermaid) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme: theme === "dark" ? "dark" : "default",
            fontFamily: MERMAID_FONT_FAMILY,
            fontSize: 13,
            // 容器 .md-mermaid 自带主题底色，SVG 背景透明避免双底。
            themeVariables: { background: "transparent" },
          });
          const id = `deepaa-mermaid-svg-${++uidCounter}`;
          const { svg: rendered } = await mermaid.render(id, chart);
          if (!cancelled) {
            setSvg(rendered);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chart, theme]);

  if (error) {
    return (
      <figure className="md-mermaid-error">
        <figcaption>
          Mermaid 图表解析失败，已回退为源码
          {error ? <span className="md-mermaid-error-detail">{error.split("\n")[0]}</span> : null}
        </figcaption>
        <pre>
          <code>{chart}</code>
        </pre>
      </figure>
    );
  }

  if (svg === null) {
    return <div className="md-mermaid md-mermaid-loading" aria-busy="true" />;
  }

  return (
    <div
      className="md-mermaid"
      // securityLevel 严格模式下 mermaid 已对标签转义清洗，注入其产物是标准用法。
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** 从 react-markdown 传下的 code/pre 节点里提取纯文本源码。 */
export function reactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => reactNodeText(child)).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    return reactNodeText(element.props.children);
  }
  return "";
}

/** 判断 react-markdown 的 pre 子节点是否为 ```mermaid 代码块。 */
export function isMermaidCodeElement(node: ReactNode): boolean {
  if (typeof node !== "object" || node === null || !("props" in node)) return false;
  const element = node as ReactElement<{ className?: unknown }>;
  return (
    typeof element.props.className === "string"
    && element.props.className.split(/\s+/).includes("language-mermaid")
  );
}
