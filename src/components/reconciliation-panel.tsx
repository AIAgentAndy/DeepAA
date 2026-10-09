"use client";

import {useEffect, useState} from "react";
import {Ban, CircleAlert, CircleCheck} from "lucide-react";
import {formatLocalDateTime} from "@/lib/local-time";
import {SimpleDialog} from "./simple-dialog";

interface ReconciliationHour {
  targetId: string;
  hourStartUtc: string;
  status: "pending" | "incomplete" | "balanced" | "needs_review" | "applied" | "ignored";
  siteAmountNano: number | null;
  localAmountNano: number | null;
  appliedAmountNano: number;
  residualNano: number | null;
  siteSource: string | null;
  siteCandidateCount: number;
  siteProcessedCount: number;
  siteLimited: boolean;
  matchedCount: number;
  unmatchedSiteCount: number;
  lastCheckedAt: string | null;
  reason: string | null;
}

interface HourPage {
  items: ReconciliationHour[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  nextCursor?: string;
  summary: {
    needsReviewCount: number;
    needsReviewResidualNano: number;
    autoApplied24hNano: number;
    autoApplied24hCount: number;
    /** 其中来自小时残差自动补（recon:residual:）的条数；缺省视为 0。 */
    autoApplied24hResidualCount?: number;
    backoffs: Array<{targetId: string; retryAfter: string | null; lastError: string | null}>;
  };
  nonce: string;
}

/** 对账证据金额（USD nano）：站点实扣/本地核算/残差均为待审核美元证据，明确 $ 标注。 */
function usdAmount(nano: number | null): string {
  return nano === null ? "待确认" : `$${(nano / 1e9).toFixed(6)}`;
}

/** 已入账补差的人民币汇总（2026-09-28）：读补差行冻结的 actual_cost_cny 物化值。 */
function cnyAmount(nano: number): string {
  return `￥${(nano / 1e9).toFixed(6)}`;
}

/**
 * 中转站结算小时对账补差（2026-09-28 用户确认：面板静默化）——
 * 只读取本地小表摘要判断是否存在待人工复核的小时；没有则整个区块不渲染。
 * 列表只包含 needs_review 小时；确认/忽略经统一弹窗二次确认后提交。
 */
export function ReconciliationPanel({targetId, onApplied}: {
  targetId?: string;
  onApplied?: () => void;
}) {
  const [page, setPage] = useState<HourPage>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [dialog, setDialog] = useState<
    {action: "apply" | "ignore"; hour: ReconciliationHour} | undefined>();
  const [reason, setReason] = useState("");

  useEffect(() => {
    setCursor(undefined);
    setHistory([]);
  }, [targetId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({limit: "20"});
        if (targetId) params.set("targetId", targetId);
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/proxy-sync/reconciliation?${params}`, {cache: "no-store"});
        const body = await response.json() as HourPage & {message?: string};
        if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
        if (!cancelled) setPage(body);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "小时对账读取失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [targetId, cursor, refresh]);

  const submit = async (action: "apply" | "ignore", hour: ReconciliationHour,
    ignoreReason?: string) => {
    if (busy || !page?.nonce) return false;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/proxy-sync/reconciliation", {
        method: "POST",
        headers: {"content-type": "application/json", "sec-fetch-site": "same-origin"},
        body: JSON.stringify({
          action, targetId: hour.targetId, hourStartUtc: hour.hourStartUtc,
          ...(action === "ignore" ? {reason: ignoreReason} : {
            expectedResidualNano: hour.residualNano,
            expectedLastCheckedAt: hour.lastCheckedAt,
          }), nonce: page.nonce,
        }),
      });
      const body = await response.json() as {message?: string};
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      if (action === "apply") onApplied?.();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试");
      return false;
    } finally {
      setBusy(false);
      // nonce 一次性，任何提交后都重新取得列表与摘要。
      setRefresh(current => current + 1);
    }
  };

  // 静默：没有待人工复核的小时（且未在加载/出错）→ 整个区块不渲染。
  if (!loading && !error && (page?.candidateCount ?? 0) === 0) return null;

  const activeDialogHour = dialog?.hour;

  return (
    <section className="token-recon-banner" aria-label="中转站结算小时对账补差">
      <div className="token-recon-head">
        <strong>中转站结算小时对账补差</strong>
        <button type="button" className="token-recon-toggle"
          onClick={() => setRefresh(current => current + 1)}>
          刷新
        </button>
      </div>
      {page ? (
        <div className="token-recon-summary" role="status">
          <span className="token-recon-chip danger">
            待人工复核 {page.summary.needsReviewCount} 小时 · 合计 {usdAmount(page.summary.needsReviewResidualNano)}
          </span>
          {page.summary.backoffs.map(backoff => (
            <span key={backoff.targetId} className="token-recon-chip warn"
              title={backoff.lastError ?? undefined}>
              {backoff.targetId} 取数退避中{backoff.retryAfter
                ? `（${formatLocalDateTime(backoff.retryAfter)} 后重试）` : ""}
            </span>
          ))}
          {page.summary.autoApplied24hNano !== 0 ? (
            <span className="token-recon-chip ok">
              近 24 小时已自动补差 {cnyAmount(page.summary.autoApplied24hNano)}
              （{page.summary.autoApplied24hCount} 条
              {page.summary.autoApplied24hResidualCount
                ? `，小时残差 ${page.summary.autoApplied24hResidualCount} 条` : ""}）
            </span>
          ) : null}
        </div>
      ) : null}
      {loading ? <p role="status">正在读取小时对账…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {page && page.items.length > 0 ? (
        <>
          <div className="token-recon-scroll" role="region" tabIndex={0}
            aria-label="可横向滚动的待复核小时明细">
            <table className="token-recon-table">
              <thead>
                <tr>
                  <th>结算小时</th><th>供应商</th><th>站点消费（USD）</th>
                  <th>本地核算（USD）</th><th>已自动补差（USD）</th><th>未解释残差（USD）</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map(hour => {
                  const confirmable = !(
                    hour.siteLimited && hour.siteSource === "sub2api_trend"
                  );
                  const detail = [
                    `来源 ${hour.siteSource ?? "待取数"}`,
                    `站点 ${hour.siteProcessedCount}/${hour.siteCandidateCount}`,
                    `已匹配 ${hour.matchedCount} / 未归属 ${hour.unmatchedSiteCount}`,
                    ...(hour.reason ? [hour.reason] : []),
                  ].join(" · ");
                  return (
                    <tr key={`${hour.targetId}:${hour.hourStartUtc}`}>
                      <td>{formatLocalDateTime(hour.hourStartUtc)}</td>
                      <td>{hour.targetId}</td>
                      <td>{usdAmount(hour.siteAmountNano)}</td>
                      <td>{usdAmount(hour.localAmountNano)}</td>
                      <td>{usdAmount(hour.appliedAmountNano)}</td>
                      <td title={detail}>{usdAmount(hour.residualNano)}</td>
                      <td className="token-recon-actions">
                        <button type="button" className="token-recon-btn ok" disabled={busy || !confirmable}
                          title={confirmable
                            ? "核对站点实扣与本地核算后，把未解释残差落为补差记录"
                            : "sub2api 趋势明细受限，无法直接确认金额"}
                          onClick={() => {
                            setReason("");
                            setDialog({action: "apply", hour});
                          }}>
                          <CircleCheck size={14} /> 确认补差
                        </button>
                        <button type="button" className="token-recon-btn warn" disabled={busy}
                          title="填写原因后忽略该小时的残差，不产生补差记录"
                          onClick={() => {
                            setReason("");
                            setDialog({action: "ignore", hour});
                          }}>
                          <Ban size={14} /> 忽略
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="token-recon-pager">
            <button type="button" className="token-recon-action" disabled={loading || history.length === 0}
              onClick={() => {
                setCursor(history.at(-1));
                setHistory(items => items.slice(0, -1));
              }}>上一页</button>
            <button type="button" className="token-recon-action" disabled={loading || !page.nextCursor}
              onClick={() => {
                setHistory(items => [...items, cursor]);
                setCursor(page.nextCursor);
              }}>下一页</button>
          </div>
        </>
      ) : null}
      {activeDialogHour && dialog ? (
        dialog.action === "apply" ? (
          <SimpleDialog
            icon={<CircleCheck size={19} />}
            title="确认补差"
            description="请核对以下金额；如站点账号还服务其它目标或金额来源不清，请勿确认。"
            onClose={() => setDialog(undefined)}
            footer={
              <>
                <button type="button" className="secondary" onClick={() => setDialog(undefined)}>取消</button>
                <button type="button" className="primary" disabled={busy}
                  onClick={() => void submit("apply", activeDialogHour).then(ok => {
                    if (ok) setDialog(undefined);
                  })}>确认补差 {usdAmount(activeDialogHour.residualNano)}</button>
              </>
            }>
            <dl className="token-recon-dialog-facts">
              <div><dt>供应商</dt><dd>{activeDialogHour.targetId}</dd></div>
              <div><dt>结算小时</dt><dd>{formatLocalDateTime(activeDialogHour.hourStartUtc)}</dd></div>
              <div><dt>站点消费</dt><dd>{usdAmount(activeDialogHour.siteAmountNano)}</dd></div>
              <div><dt>本地核算</dt><dd>{usdAmount(activeDialogHour.localAmountNano)}</dd></div>
              <div><dt>已自动补差</dt><dd>{usdAmount(activeDialogHour.appliedAmountNano)}</dd></div>
              <div><dt>未解释残差</dt><dd>{usdAmount(activeDialogHour.residualNano)}</dd></div>
            </dl>
            <p className="token-recon-dialog-warn">
              <CircleAlert size={14} /> 提交时会重新核对站点与本地快照，金额或证据发生变化将自动拒绝。
            </p>
          </SimpleDialog>
        ) : (
          <SimpleDialog
            icon={<Ban size={19} />}
            title="忽略该小时残差"
            description="忽略只保留审核状态与原因，不产生补差记录；站点金额变化时会重新打开。"
            onClose={() => setDialog(undefined)}
            footer={
              <>
                <button type="button" className="secondary" onClick={() => setDialog(undefined)}>取消</button>
                <button type="button" className="danger"
                  disabled={busy || reason.trim().length < 4}
                  title={reason.trim().length < 4 ? "原因至少填写 4 个字" : undefined}
                  onClick={() => void submit("ignore", activeDialogHour, reason.trim()).then(ok => {
                    if (ok) setDialog(undefined);
                  })}>提交忽略</button>
              </>
            }>
            <dl className="token-recon-dialog-facts">
              <div><dt>供应商</dt><dd>{activeDialogHour.targetId}</dd></div>
              <div><dt>结算小时</dt><dd>{formatLocalDateTime(activeDialogHour.hourStartUtc)}</dd></div>
              <div><dt>未解释残差</dt><dd>{usdAmount(activeDialogHour.residualNano)}</dd></div>
            </dl>
            <label className="token-recon-dialog-reason">
              <span>忽略原因（必填，至少 4 个字）</span>
              <textarea rows={3} maxLength={512} value={reason}
                placeholder="例如：该账号还服务其它目标，无法归属"
                onChange={event => setReason(event.currentTarget.value)} />
            </label>
          </SimpleDialog>
        )
      ) : null}
    </section>
  );
}
