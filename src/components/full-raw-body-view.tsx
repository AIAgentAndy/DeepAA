"use client";

import { useState, type ReactNode } from "react";
import { confirmDialog } from "@/components/confirm-dialog";
import { Braces, Download, ExternalLink, FileText, LoaderCircle } from "lucide-react";

const RAW_VIEW_CONFIRM_BYTES = 8 * 1024 * 1024;
const RAW_DOWNLOAD_RECOMMEND_BYTES = 32 * 1024 * 1024;

interface FullRawBodyViewProps {
  exchangeId: string;
  side: "request" | "response";
  sizeBytes: number;
  canStream: boolean;
  formattedContent: ReactNode;
}

type RawBodyMode = "formatted" | "raw";

/**
 * 格式化正文是默认阅读路径；完整 Raw 只在用户显式切换并批准后交给隔离 iframe。
 * 父组件使用 exchangeId + side 作为 key，切换 Step 或侧别会销毁 iframe 和批准状态。
 */
export function FullRawBodyView({
  exchangeId,
  side,
  sizeBytes,
  canStream,
  formattedContent,
}: FullRawBodyViewProps) {
  const [mode, setMode] = useState<RawBodyMode>("formatted");
  const [loadApproved, setLoadApproved] = useState(false);
  const sideLabel = side === "request" ? "请求" : "响应";
  const inlineHref = rawStreamHref(exchangeId, side, "inline");
  const downloadHref = rawStreamHref(exchangeId, side, "attachment");
  const iframeSrc = loadApproved ? inlineHref : undefined;

  async function approveInlineLoad(): Promise<void> {
    if (sizeBytes > RAW_VIEW_CONFIRM_BYTES) {
      if (!await confirmDialog({title: "加载完整正文", danger: sizeBytes > 8 * 1024 * 1024, message: `完整${sideLabel}正文大小为 ${formatRawSize(sizeBytes)}，确认加载？`})) return;
      if (
        sizeBytes > RAW_DOWNLOAD_RECOMMEND_BYTES
        && !await confirmDialog({title: "加载完整正文", danger: true, message: "该正文超过 32 MiB，推荐下载。确认仍在当前页内嵌查看？"})
      ) return;
    }
    setLoadApproved(true);
  }

  function confirmRawNavigation(
    event: React.MouseEvent<HTMLAnchorElement>,
    disposition: "inline" | "attachment",
  ): void {
    if (sizeBytes <= RAW_VIEW_CONFIRM_BYTES) return;
    // 先同步阻止默认导航（await 后合成事件失效），确认通过后再手动导航。
    event.preventDefault();
    const action = disposition === "inline" ? "查看" : "下载";
    void (async () => {
      if (!await confirmDialog({title: action === "下载" ? "下载完整正文" : "查看完整正文", danger: sizeBytes > 32 * 1024 * 1024, message: `完整${sideLabel}正文大小为 ${formatRawSize(sizeBytes)}，确认继续${action}？`})) return;
      if (
        disposition === "inline"
        && sizeBytes > RAW_DOWNLOAD_RECOMMEND_BYTES
        && !await confirmDialog({title: "查看完整正文", danger: true, message: "该正文超过 32 MiB，推荐下载。确认仍在新标签页流式查看？"})
      ) return;
      const href = disposition === "inline" ? inlineHref : downloadHref;
      if (disposition === "inline") {
        window.location.href = href;
      } else {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = "";
        anchor.click();
      }
    })();
  }

  return (
    <section className="full-raw-body-view" aria-label={`${sideLabel}正文查看方式`}>
      <div className="full-raw-toolbar">
        <div className="raw-view-segmented" role="group" aria-label={`${sideLabel}正文模式`}>
          <button
            type="button"
            className={mode === "formatted" ? "active" : ""}
            aria-pressed={mode === "formatted"}
            onClick={() => setMode("formatted")}
          >
            <Braces size={15} />
            格式化正文
          </button>
          <button
            type="button"
            className={mode === "raw" ? "active" : ""}
            aria-pressed={mode === "raw"}
            disabled={!canStream}
            onClick={() => setMode("raw")}
          >
            <FileText size={15} />
            完整 Raw
          </button>
        </div>
        {canStream ? (
          <div className="raw-stream-actions">
            <a
              className="raw-stream-link secondary"
              href={inlineHref}
              target="_blank"
              rel="noreferrer"
              onClick={event => confirmRawNavigation(event, "inline")}
            >
              <ExternalLink size={15} />
              {side === "request" ? "查看完整请求" : "查看完整响应"}
            </a>
            <a
              className="raw-stream-link secondary"
              href={downloadHref}
              onClick={event => confirmRawNavigation(event, "attachment")}
            >
              <Download size={15} />
              {side === "request" ? "下载完整请求" : "下载完整响应"}
            </a>
          </div>
        ) : null}
      </div>

      {mode === "formatted" || !canStream ? formattedContent : (
        loadApproved ? (
          <div className="full-raw-frame-shell">
            <iframe
              key={`${exchangeId}:${side}`}
              className="full-raw-frame"
              src={iframeSrc}
              sandbox=""
              title={`${sideLabel}完整 Raw 正文`}
            />
          </div>
        ) : (
          <div className="full-raw-load-gate" role="status">
            <LoaderCircle size={24} aria-hidden="true" />
            <strong>完整 Raw 尚未加载</strong>
            <span>
              当前{sideLabel}正文为 {formatRawSize(sizeBytes)}。
              {sizeBytes > RAW_DOWNLOAD_RECOMMEND_BYTES ? " 建议优先下载，避免长文本影响浏览器页面。" : " 确认后将在隔离视图中流式展示。"}
            </span>
            <button type="button" className="raw-stream-link" onClick={approveInlineLoad}>
              <FileText size={15} />
              加载完整{sideLabel}
            </button>
          </div>
        )
      )}
    </section>
  );
}

function rawStreamHref(
  exchangeId: string,
  side: "request" | "response",
  disposition: "inline" | "attachment",
): string {
  return disposition === "inline"
    ? `/api/exchanges/${encodeURIComponent(exchangeId)}/raw/${side}?disposition=inline`
    : `/api/exchanges/${encodeURIComponent(exchangeId)}/raw/${side}?disposition=attachment`;
}

function formatRawSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
