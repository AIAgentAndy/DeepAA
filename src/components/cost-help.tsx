"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 成本 ？浮窗（共享组件，2026-09-23）：Token 价格页明细行与会话追踪「价格成本/
 * 估算真实成本」字段共用同一实现与视觉（米黄计算纸浮窗，fixed 定位）。
 * 原实现位于 token-pricing-content.tsx，抽取为共享组件后会话追踪页零样式副本。
 *
 * 定位（2026-09-23 升级）：锚点下方 8px 展示；渲染后实测浮窗高度，若下方放不下
 * （会超出视口底部）且上方空间更大则自动向上翻转，保证长公式（套餐积分+换算链）
 * 在视口任何位置都完整可见。fixed 定位不参与祖先滚动溢出（2026-09-05 根治
 * 幻影纵向滚动条）；测量在 useLayoutEffect 中完成，首帧隐藏、定位后显示，无闪烁。
 *
 * 消失时机（2026-09-24 用户确认）：移出 ？ 后延迟 1s 再消失；这 1s 内移入浮框
 * 则取消关闭，直到再次移出浮框才消失——长公式（如套餐积分+换算链）有阅读时间，
 * 鼠标可从 ？ 平移到浮框内不中断。
 */
const CLOSE_DELAY_MS = 1000;

export function CostHelp({ formula, label, children }: {
  /** 计算过程文本（多行以 \n 分隔）；缺省时不渲染标识。 */
  formula?: string;
  /** 浮窗标题与无障碍标签（如「估算真实成本计算过程」）。 */
  label: string;
  /** 可选自定义触发内容；缺省渲染「?」圆标。 */
  children?: ReactNode;
}) {
  const tooltipId = useId();
  const [anchor, setAnchor] = useState<DOMRect | undefined>();
  const [pos, setPos] = useState<{top: number; left: number} | undefined>();
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const cancelPendingClose = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, []);
  useEffect(() => cancelPendingClose, [cancelPendingClose]);
  if (!formula) return null;
  const open = anchor !== undefined;
  const place = (rect: DOMRect) => {
    cancelPendingClose();
    setAnchor(new DOMRect(rect.left, rect.top, rect.width, rect.height));
    setPos(undefined);
  };
  const scheduleClose = () => {
    cancelPendingClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined;
      setAnchor(undefined);
    }, CLOSE_DELAY_MS);
  };

  useLayoutEffect(() => {
    if (!anchor) return;
    const viewportWidth = window.innerWidth || 1280;
    const viewportHeight = window.innerHeight || 800;
    const popoverWidth = Math.min(420, viewportWidth * 0.82);
    const popoverHeight = popoverRef.current?.offsetHeight ?? 220;
    const left = Math.min(Math.max(anchor.left - 60, 8), Math.max(viewportWidth - popoverWidth - 12, 8));
    let top = anchor.bottom + 8;
    const overflowBelow = top + popoverHeight > viewportHeight - 8;
    if (overflowBelow && anchor.top > viewportHeight - anchor.bottom) {
      // 上方空间更大：向上翻转（锚点顶部 - 浮窗高度 - 8px）。
      top = anchor.top - popoverHeight - 8;
    }
    // 两个方向都放不下时贴边钳制（至少保留顶部 8px 可见）。
    top = Math.min(Math.max(top, 8), Math.max(viewportHeight - popoverHeight - 8, 8));
    setPos({top, left});
  }, [anchor]);

  return (
    <span
      className="token-cost-help"
      aria-label={label}
      aria-describedby={tooltipId}
      tabIndex={0}
      onMouseEnter={event => place(event.currentTarget.getBoundingClientRect())}
      onMouseLeave={scheduleClose}
      onFocus={event => place(event.currentTarget.getBoundingClientRect())}
      onBlur={() => {
        cancelPendingClose();
        setAnchor(undefined);
      }}
    >
      {children ?? <span aria-hidden="true">?</span>}
      {open && typeof document !== "undefined"
        ? createPortal(
          <span
            ref={popoverRef}
            className="token-cost-popover token-cost-popover-fixed"
            id={tooltipId}
            role="tooltip"
            style={{
              position: "fixed",
              ...(pos ? {top: pos.top, left: pos.left} : {top: 0, left: 0}),
              zIndex: 90,
              opacity: pos ? 1 : 0,
              visibility: pos ? "visible" : "hidden",
              pointerEvents: "auto",
            }}
            onMouseEnter={cancelPendingClose}
            onMouseLeave={() => {
              cancelPendingClose();
              setAnchor(undefined);
            }}
          >
            <span className="token-cost-popover-title">{label}</span>
            <span className="token-cost-popover-formula">{formula}</span>
          </span>,
          document.body,
        )
      : null}
    </span>
  );
}
