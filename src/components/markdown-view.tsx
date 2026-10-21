"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { MermaidDiagram, isMermaidCodeElement, reactNodeText } from "./mermaid-diagram";

/**
 * 超长正文跳过 Markdown 解析直接回退纯文本，避免打开详情时阻塞主线程；
 * 阈值按常见模型单条输出的量级放宽，覆盖绝大多数 markdown 响应。
 */
const MAX_MARKDOWN_CHARACTERS = 200_000;

/**
 * 共享 Markdown 渲染视图：GFM（表格/任务列表/删除线）+ 代码块语法高亮
 * （rehype-highlight，未知语言自动按纯文本处理）+ 代码块外壳（语言标签与
 * hover 复制按钮，VitePress 同款互斥淡出）+ ```mermaid 代码块渲染为图表
 * （mermaid 主包按需动态加载，见 mermaid-diagram.tsx）。
 * 默认不渲染原始 HTML（react-markdown 默认行为），模型输出无法注入脚本。
 */

/** 提取 pre 内 code 元素的语言名（language-xxx → xxx），无语言返回 null。 */
function codeElementLanguage(node: ReactNode): string | null {
  if (typeof node !== "object" || node === null || !("props" in node)) return null;
  const element = node as ReactElement<{ className?: unknown }>;
  if (typeof element.props.className !== "string") return null;
  const match = element.props.className.match(/(?:^|\s)language-([^\s]+)/);
  return match ? match[1] : null;
}

function CodeBlockShell({
  language,
  children,
}: {
  language: string | null;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const preRef = useRef<HTMLPreElement>(null);

  async function copySource() {
    const text = preRef.current?.textContent ?? "";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 非安全上下文兜底：临时 textarea + execCommand（127.0.0.1 正常走 clipboard API）。
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 复制失败（如浏览器权限）静默：按钮回到默认态，不打断阅读。
    }
  }

  return (
    <div className="md-code-block">
      {language ? <span className="md-code-lang">{language}</span> : null}
      <button
        type="button"
        className={`md-code-copy${copied ? " copied" : ""}`}
        onClick={() => void copySource()}
        aria-label={copied ? "已复制" : "复制代码"}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

/** ```mermaid 代码块在 pre 层整体替换为图表；普通代码块套复制外壳。 */
const markdownComponents: Components = {
  pre({ children }) {
    const only = Array.isArray(children) ? children[0] : children;
    if (isMermaidCodeElement(only)) {
      const chart = reactNodeText(
        (only as { props: { children?: ReactNode } }).props.children,
      ).replace(/\n$/, "");
      return <MermaidDiagram chart={chart} />;
    }
    return (
      <CodeBlockShell language={codeElementLanguage(only)}>
        {children}
      </CodeBlockShell>
    );
  },
};

export function MarkdownView({ text }: { text: string }) {
  const oversized = text.length > MAX_MARKDOWN_CHARACTERS;
  const content = useMemo(() => {
    if (oversized) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    );
  }, [oversized, text]);
  if (oversized) {
    return <div className="txt">{text}</div>;
  }
  return <div className="markdown-view">{content}</div>;
}
