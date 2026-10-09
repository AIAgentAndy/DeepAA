"use client";

import {useState} from "react";
import {Check, Copy} from "lucide-react";
import styles from "./proxy-management.module.css";

/**
 * 凭据打码串 + 复制明文按钮：默认只展示服务端下发的打码串（前4+****+后4）；
 * 用户点击后才经同源 + nonce 保护的 reveal 接口取回明文并写入剪贴板，用后即弃。
 */
export function SecretRevealChip({kind, targetId, credentialId, masked, label, showMasked = true}: {
  kind: "credential" | "console" | "plan-ak" | "plan-sk";
  targetId: string;
  credentialId?: string;
  /** 服务端下发的打码串；缺省时不渲染（无已保存凭据）。 */
  masked?: string;
  label?: string;
  /** 相邻位置已展示过同样打码串时传 false，只渲染复制按钮。 */
  showMasked?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!masked) return null;
  const actionLabel = label || "复制完整明文";

  async function copy() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const caps = await fetch("/api/development-launch/capabilities", {cache: "no-store"});
      const nonce = ((await caps.json()) as {nonce?: string}).nonce ?? "";
      if (!nonce) throw new Error("NO_NONCE");
      const response = await fetch("/api/development-launch/credentials/reveal", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({kind, targetId, ...(credentialId ? {credentialId} : {}), nonce}),
      });
      const body = await response.json() as {value?: string};
      if (!body.value) throw new Error("REVEAL_FAILED");
      await navigator.clipboard.writeText(body.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 1600);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.secretRevealChip}>
      {showMasked ? <code>{masked}</code> : null}
      <button
        type="button"
        className={styles.secretRevealCopy}
        onClick={() => void copy()}
        disabled={busy}
        title={failed ? "复制失败，请重试" : actionLabel}
        aria-label={actionLabel}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}
