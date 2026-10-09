"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useMemo } from "react";

/**
 * 超长正文跳过 Markdown 解析直接回退纯文本，避免打开详情时阻塞主线程；
 * 阈值按常见模型单条输出的量级放宽，覆盖绝大多数 markdown 响应。
 */
const MAX_MARKDOWN_CHARACTERS = 200_000;

/**
 * 共享 Markdown 渲染视图：GFM（表格/任务列表/删除线）+ 代码块语法高亮
 * （rehype-highlight，未知语言自动按纯文本处理）。
 * 默认不渲染原始 HTML（react-markdown 默认行为），模型输出无法注入脚本。
 */
export function MarkdownView({ text }: { text: string }) {
  const oversized = text.length > MAX_MARKDOWN_CHARACTERS;
  const content = useMemo(() => {
    if (oversized) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
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
