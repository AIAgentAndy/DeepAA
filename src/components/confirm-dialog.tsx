"use client";

import {useEffect, useState} from "react";
import {createPortal} from "react-dom";
import type {ReactNode} from "react";

/**
 * 统一的居中确认弹窗：替换原生 window.confirm。
 * confirmDialog() 在任意客户端组件中直接调用即可；弹窗由 AppDialogs 宿主渲染
 * （挂载于全局 layout，居中展示，支持标题、确认/取消文案与危险操作红色按钮）。
 */

export interface ConfirmOptions {
  /** 弹窗标题（可选）。 */
  title?: string;
  /** 提示正文，支持 \\n 换行。 */
  message: ReactNode;
  /** 宿主未挂载时原生确认框使用的纯文本回退文案。 */
  fallbackMessage?: string;
  /** 确认按钮文案。 */
  confirmLabel?: string;
  /** 取消按钮文案。 */
  cancelLabel?: string;
  /** 危险操作：确认按钮使用红色警示样式。 */
  danger?: boolean;
}

interface PendingConfirm {
  title?: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

let setRequest: ((request: PendingConfirm | null) => void) | null = null;

/** 弹出统一确认框；宿主未挂载（如 SSR/未加载）时退化为原生确认，保证功能可用。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (!setRequest) {
    const fallback = options.fallbackMessage
      || (typeof options.message === "string" ? options.message : "确认继续？");
    return Promise.resolve(window.confirm(fallback));
  }
  const active = setRequest;
  return new Promise(resolve => {
    active?.({
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel || "确认",
      cancelLabel: options.cancelLabel || "取消",
      danger: options.danger === true,
      resolve,
    });
  });
}

function ConfirmDialogHost() {
  const [request, setRequestState] = useState<PendingConfirm | null>(null);
  useEffect(() => {
    setRequest = next => setRequestState(next);
    return () => {
      setRequest = null;
    };
  }, []);
  function close(ok: boolean) {
    setRequestState(null);
    request?.resolve(ok);
  }
  if (!request) return null;
  return createPortal(
    <div className="app-confirm-backdrop" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget) close(false);}}>
      <div className="app-confirm-dialog" role="dialog" aria-modal="true">
        {request.title ? <strong className="app-confirm-title">{request.title}</strong> : null}
        <div className="app-confirm-message">{request.message}</div>
        <div className="app-confirm-actions">
          <button type="button" className="secondary-button" onClick={() => close(false)}>{request.cancelLabel}</button>
          <button type="button" className={request.danger ? "danger-button" : "primary-button"} onClick={() => close(true)}>{request.confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 全局弹窗宿主：挂载在应用根布局（server layout 可引用该 client 组件）。 */
export function AppDialogs() {
  return <ConfirmDialogHost />;
}
