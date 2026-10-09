"use client";

import {useState, type ReactNode} from "react";

/**
 * 可折叠模块框（2026-09-10 用户确认）：价格中心编辑区的每个小模块统一为
 * 「矩形框 + 标题行（含折叠/展开标识）」结构，标题行可点击折叠。
 * 折叠状态纯前端本地，不持久化。
 */
export function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = true,
  storageKey,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  /** 可选稳定键：同一页面内多个模块的折叠状态互不影响（仅内存态）。 */
  storageKey?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`editor-module${open ? "" : " collapsed"}`} data-module={storageKey}>
      <button
        type="button"
        className="editor-module-head"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className="editor-module-toggle" aria-hidden>{open ? "▾" : "▸"}</span>
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
      </button>
      {open ? <div className="editor-module-body">{children}</div> : null}
    </section>
  );
}
