"use client";

import { useEffect, useRef, useState } from "react";
import { HardDrive, Settings, SlidersHorizontal } from "lucide-react";
import { StorageManagementDialog } from "@/components/storage-management-dialog";

/**
 * 右上角「管理」菜单（2026-09-14 用户确认）：模型价格中心与存储管理收敛到
 * 同一下拉入口，点击对应项打开弹窗。价格中心复用既有 deepaa:open-pricing-settings
 * 事件通道，PricingSettingsDialog 本体只隐藏自带触发按钮。
 */
export function ManagementMenu() {
  const [open, setOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 跨组件打开存储管理（2026-09-21）：会话追踪 / 交互内容页的「数据清理机制」
  // 锚点经事件通道打开本弹窗，与价格中心事件同一模式。
  useEffect(() => {
    const onOpenStorage = () => setStorageOpen(true);
    window.addEventListener("deepaa:open-storage-management", onOpenStorage);
    return () => {
      window.removeEventListener("deepaa:open-storage-management", onOpenStorage);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function openPricing(): void {
    setOpen(false);
    window.dispatchEvent(new Event("deepaa:open-pricing-settings"));
  }

  return (
    <div className="management-menu" ref={rootRef}>
      <button
        type="button"
        className="management-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="管理"
        title="管理"
        onClick={() => setOpen(value => !value)}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open ? (
        <div className="management-popover" role="menu" aria-label="管理菜单">
          <button type="button" role="menuitem" className="management-item" onClick={openPricing}>
            <Settings size={14} aria-hidden="true" />
            模型价格中心
          </button>
          <button
            type="button"
            role="menuitem"
            className="management-item"
            onClick={() => {
              setOpen(false);
              setStorageOpen(true);
            }}
          >
            <HardDrive size={14} aria-hidden="true" />
            存储管理
          </button>
        </div>
      ) : null}
      <StorageManagementDialog open={storageOpen} onClose={() => setStorageOpen(false)} />
    </div>
  );
}
