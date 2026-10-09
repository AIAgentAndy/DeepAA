"use client";

import type {ReactNode} from "react";
import {X} from "lucide-react";
import styles from "./simple-dialog.module.css";

/**
 * 最小公共弹窗（2026-09-28 用户确认：对账补差操作与供应商管理弹窗统一视觉）。
 * 三个槽位：标题区（图标+标题+说明+关闭）、内容、底部操作；不引入 portal，
 * 与既有 dialogBackdrop/dialog 同构。后续页面可复用，不反向改动供应商管理。
 */
export function SimpleDialog({icon, title, description, onClose, children, footer}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className={styles.backdrop} role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <header className={styles.header}>
          {icon ? <span className={styles.iconBadge} aria-hidden="true">{icon}</span> : null}
          <div className={styles.headerText}>
            <h3>{title}</h3>
            {description ? <p>{description}</p> : null}
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        <footer className={styles.footer}>{footer}</footer>
      </section>
    </div>
  );
}
