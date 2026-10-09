"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { HardDrive, RefreshCw, Save, Trash2, X } from "lucide-react";
import { confirmDialog } from "@/components/confirm-dialog";

/**
 * 存储管理弹窗（右上角「管理」菜单入口，2026-09-14 用户确认 B/C 项）。
 * 面向整个数据目录的全局功能：体量卡片、保留窗口、历史数据清理（文件级预览 +
 * 两次确认执行）、数据目录说明与清理影响矩阵。所有写操作走服务端
 * loopback/Origin/nonce 门禁。
 */

interface StorageBucketStats {
  bytes: number;
  fileCount: number;
  truncated: boolean;
}

interface StorageOverviewResponse {
  stats: {
    captures: StorageBucketStats;
    blobs: StorageBucketStats;
    derivedBlobs: StorageBucketStats;
    sqlite: StorageBucketStats;
    config: StorageBucketStats;
  };
  retention: {version: 1; rawRetentionDays: number};
  autoPurge: {
    trigger: "daily" | "retention-change";
    startedAt: string;
    finishedAt: string;
    purgedFileCount: number;
    purgedBytes: number;
    deletedBlobFiles: number;
    deletedDerivedArtifactFiles: number;
    deletedOrphanBlobFiles?: number;
    deletedOrphanArtifactFiles?: number;
    vacuumedPages: number;
    skippedCount: number;
    errorCount: number;
  } | null;
  purgePreview: {
    candidateCount: number;
    skippedCount: number;
    reclaimableBytes: {
      captureFiles: number;
      externalBlobs: number;
      derivedArtifacts: number;
      total: number;
    };
    orphanReclaim: {
      blobFileCount: number;
      artifactFileCount: number;
      bytes: number;
      limited: boolean;
    };
    cutoff: string;
    limited: boolean;
  };
  nonce: string;
}

interface PurgeCandidateRow {
  sourceId: number;
  relativePath: string;
  fileBytes: number;
  exchangeCount: number;
  earliestCapturedAt: string;
  latestCapturedAt: string;
}

interface PurgePreviewDetail {
  retentionDays: number;
  cutoff: string;
  candidates: PurgeCandidateRow[];
  skipped: Array<{relativePath: string; reason: string}>;
  reclaimableBytes: {
    captureFiles: number;
    externalBlobs: number;
    derivedArtifacts: number;
    total: number;
  };
  orphanReclaim: {
    blobFileCount: number;
    artifactFileCount: number;
    bytes: number;
    limited: boolean;
  };
  limited: boolean;
}

interface PurgeExecuteResult {
  purgedFiles: Array<{relativePath: string; fileBytes: number; exchangeCount: number}>;
  deletedBlobFiles: number;
  deletedDerivedArtifactFiles: number;
  deletedOrphanBlobFiles?: number;
  deletedOrphanArtifactFiles?: number;
  vacuumedPages: number;
  skippedCount?: number;
  errors: Array<{relativePath: string; message: string}>;
}

const RETENTION_CHOICES = [3, 7, 15, 30, 60, 90, 180];

interface PurgeImpactTableEntry {
  name: string;
  desc?: string;
}

interface PurgeImpactRow {
  location: {label: string; path: string; tables?: PurgeImpactTableEntry[]};
  /** 每条一行展示：用户视角的页面功能路径与超窗/清理后的表现。 */
  features: string[];
  permanent?: boolean;
}

const PURGE_IMPACT_ROWS: PurgeImpactRow[] = [
  {
    location: {
      label: "原始捕获（captures）",
      path: "~/.deepaa/captures/v2/*.jsonl",
    },
    features: [
      "会话追踪 → Step 详情 →「完整 Raw」查看与下载",
      "交互内容 → 列表行「查看原文」与完整导出下载（展示为已按保留策略清理）",
      "交互内容 → 隐藏上下文基线（降级为「未确认」）",
    ],
  },
  {
    location: {
      label: "正文 Blob（blobs）",
      path: "~/.deepaa/blobs/<xx>/<sha256>.body.gz",
    },
    features: [
      "交互内容 / Step 详情 → 超过 2 MiB 的大正文查看（「完整 Raw」的正文载体）",
      "交互内容 → 图片等媒体附件「N 张图片」的点击查看",
    ],
  },
  {
    location: {
      label: "派生物（derived-blobs）",
      path: "~/.deepaa/derived-blobs/<xx>/<sha256>.json.gz",
    },
    features: [
      "会话追踪 → Step 详情 →「上下文」页签（上下文快照，展示为已清理）",
      "会话追踪 → Step 详情 →「Diff」页签（上下文对比，展示为已清理）",
      "会话追踪 → Step 详情 →「Harness 构成估算」",
    ],
  },
  {
    location: {
      label: "SQLite 内容投影表",
      path: "~/.deepaa/deepaa.sqlite（+wal/shm）",
      tables: [
        {name: "exchange_content_previews", desc: "内容预览"},
        {name: "exchange_request_fingerprints", desc: "去重指纹"},
        {name: "exchange_content_category_stats / exchange_content_filter_status", desc: "类别统计"},
        {name: "exchange_media_descriptors", desc: "媒体描述符"},
        {name: "derivation_diagnostics", desc: "派生诊断"},
      ],
    },
    features: [
      "交互内容 → 列表行的内容摘要与类别筛选（助手回复 / 工具调用 / 推理等）",
      "交互内容 → 排重统计（唯一 / 继承计数）",
      "会话追踪 → Turn 栏的用户输入锚点",
      "会话追踪 → Step 详情 → 结构化 Request / Response 页签",
      "交互内容 → Exchange 详情 → 结构化 Request / Response 页签",
      "交互内容 → 图片附件「N 张图片」入口与数量徽标",
    ],
  },
  {
    location: {
      label: "以下内容永不删除（各页面数据 · SQLite 主数据表 · 配置文件）",
      path: "~/.deepaa/deepaa.sqlite（+wal/shm）｜~/.deepaa/config/（价格中心、凭据元数据、控制台账号）｜~/.deepaa/proxy-config.json（供应商与 Agent 配置）",
      tables: [
        {name: "agent_sessions / agent_threads / agent_turns / agent_steps", desc: "会话层级与 Step"},
        {name: "usage_ledger", desc: "Token 与费用账本"},
        {name: "analytics_hourly_facts", desc: "仪表盘小时统计，永久保存"},
        {name: "scope_aggregates", desc: "会话 / 线程 / Turn 汇总卡"},
        {name: "tool_calls", desc: "工具调用统计"},
      ],
    },
    features: [
      "仪表盘 → 全部统计与图表（任意历史时间范围）",
      "Token 价格页 → 全部请求明细、汇总与价格时间线",
      "供应商管理 → 全部供应商、密钥、账号、模型与 Agent 关联配置与同步状态",
      "模型价格中心 → 全部模型目录基础数据、价格时间线与版本历史",
      "右上角通知栏 → 模型价格变动通知历史",
      "会话追踪 → 会话树、Step 列表与基础指标类数据。",
    ],
    permanent: true,
  },
];

export function StorageManagementDialog({open, onClose}: {open: boolean; onClose: () => void}) {  const [overview, setOverview] = useState<StorageOverviewResponse | undefined>();
  const [detail, setDetail] = useState<PurgePreviewDetail | undefined>();
  const [nonce, setNonce] = useState<string | undefined>();
  const [retentionDraft, setRetentionDraft] = useState<number>(15);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [lastResult, setLastResult] = useState<PurgeExecuteResult | undefined>();

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/storage", {cache: "no-store"});
      const payload = (await response.json()) as StorageOverviewResponse & {
        error?: string;
      };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? "存储信息读取失败");
      }
      setOverview(payload);
      setNonce(payload.nonce);
      setRetentionDraft(payload.retention.rawRetentionDays);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "存储信息读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadOverview();
  }, [open, loadOverview]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function saveRetention(): Promise<void> {
    if (!nonce) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch("/api/storage/retention", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({rawRetentionDays: retentionDraft, nonce}),
      });
      const payload = (await response.json()) as {
        nonce?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok || payload.error) {
        throw new Error(payload.message ?? payload.error ?? "保留设置保存失败");
      }
      if (payload.nonce) setNonce(payload.nonce);
      setMessage(`保留窗口已更新为 ${retentionDraft} 天（对之后的新数据生效；空闲时将尽快按新窗口清理）。`);
      await loadOverview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保留设置保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(): Promise<void> {
    if (!nonce) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/storage/purge", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({action: "preview", nonce}),
      });
      const payload = (await response.json()) as {
        preview?: PurgePreviewDetail;
        nonce?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok || payload.error || !payload.preview) {
        throw new Error(payload.message ?? payload.error ?? "清理预览失败");
      }
      setDetail(payload.preview);
      if (payload.nonce) setNonce(payload.nonce);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "清理预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function executePurge(): Promise<void> {
    if (!nonce || !detail) return;
    const candidateCount = detail.candidates.length;
    const orphanCount = detail.orphanReclaim.blobFileCount + detail.orphanReclaim.artifactFileCount;
    if (candidateCount === 0 && orphanCount === 0) return;
    const actions: string[] = [];
    if (candidateCount > 0) {
      actions.push(`删除 ${candidateCount} 个原始捕获文件（约释放 ${formatBytes(detail.reclaimableBytes.total)}）`);
    }
    if (orphanCount > 0) {
      actions.push(`回收无引用孤儿文件 ${orphanCount} 个（约 ${formatBytes(detail.orphanReclaim.bytes)}）`);
    }
    const confirmed = await confirmDialog({
      title: "清除历史原始数据",
      danger: true,
      message: `将${actions.join("，")}。会话层级、Step 统计与账本费用会永久保留；被清理记录的完整正文将不再可见。确认继续？`,
    });
    if (!confirmed) return;
    const doubleConfirmed = await confirmDialog({
      title: "再次确认",
      danger: true,
      message: "该操作不可撤销。确认清除以上历史原始数据？",
    });
    if (!doubleConfirmed) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch("/api/storage/purge", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({action: "execute", confirm: true, nonce}),
      });
      const payload = (await response.json()) as {
        result?: PurgeExecuteResult;
        preview?: PurgePreviewDetail;
        nonce?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok || payload.error || !payload.result) {
        throw new Error(payload.message ?? payload.error ?? "清理执行失败");
      }
      setLastResult(payload.result);
      setDetail(payload.preview);
      if (payload.nonce) setNonce(payload.nonce);
      const orphanDeleted = (payload.result.deletedOrphanBlobFiles ?? 0)
        + (payload.result.deletedOrphanArtifactFiles ?? 0);
      setMessage(
        `已清理 ${payload.result.purgedFiles.length} 个文件，释放约 ${formatBytes(
          payload.result.purgedFiles.reduce((sum, file) => sum + file.fileBytes, 0),
        )}`
        + (orphanDeleted > 0 ? `；回收孤儿文件 ${orphanDeleted} 个` : "")
        + `${payload.result.errors.length > 0 ? `；${payload.result.errors.length} 个文件失败` : ""}。`,
      );
      await loadOverview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "清理执行失败");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="settings-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="settings-dialog storage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-management-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="storage-management-title">存储管理</h2>
          <button type="button" className="storage-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="storage-dialog-body">
          <section className="storage-card">
            <div className="storage-card-head">
              <h3><HardDrive size={15} aria-hidden="true" /> 存储体量</h3>
              <button type="button" className="storage-secondary" onClick={() => void loadOverview()} disabled={loading || busy}>
                <RefreshCw size={13} aria-hidden="true" /> 刷新
              </button>
            </div>
            <div className="storage-grid">
              {overview ? (
                [
                  {label: "原始捕获（captures）", stat: overview.stats.captures},
                  {label: "正文 Blob（blobs）", stat: overview.stats.blobs},
                  {label: "派生物（derived-blobs）", stat: overview.stats.derivedBlobs},
                  {label: "SQLite 数据库", stat: overview.stats.sqlite},
                  {label: "配置（config）", stat: overview.stats.config},
                ].map(item => (
                  <div key={item.label} className="storage-cell">
                    <span className="storage-label">{item.label}</span>
                    <strong className="storage-value">{formatBytes(item.stat.bytes)}</strong>
                    <span className="storage-meta">
                      {item.stat.fileCount} 个文件{item.stat.truncated ? "（统计有界截断）" : ""}
                    </span>
                  </div>
                ))
              ) : (
                <p className="storage-meta">{loading ? "读取中…" : "暂无数据"}</p>
              )}
            </div>
          </section>

          <section className="storage-card">
            <div className="storage-card-head">
              <h3>保留窗口</h3>
            </div>
            <p className="storage-meta">
              由于模型请求涉及大量的重复上下文（大模型请求交互的机制，就是每次请求会把上下文窗口内的全部已有继承消息，拼接上新消息，一起再发给大模型），
              会占用较大存储空间，可以根据实际需要，选择数据保留窗口，超过保留窗口期的磁盘空间将在1天内的空闲时段自动清理（见下：清理影响说明）。
            </p>
            <div className="storage-retention-row">
              <label htmlFor="storage-retention-days">保留天数</label>
              <div className="storage-retention-control">
                <select
                  id="storage-retention-days"
                  className="storage-retention-select"
                  value={retentionDraft}
                  disabled={busy}
                  onChange={event => setRetentionDraft(Number(event.target.value))}
                >
                  {RETENTION_CHOICES.map(days => (
                    <option key={days} value={days}>{days} 天</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="storage-save"
                  onClick={() => void saveRetention()}
                  disabled={busy || !nonce || (overview != null && overview.retention.rawRetentionDays === retentionDraft)}
                >
                  <Save size={13} aria-hidden="true" /> 保存
                </button>
              </div>
            </div>
          </section>

          <section className="storage-card">
            <div className="storage-card-head">
              <h3>历史数据清理</h3>
              <button type="button" className="storage-secondary" onClick={() => void loadDetail()} disabled={busy || !nonce}>
                <RefreshCw size={13} aria-hidden="true" /> 扫描可清理文件
              </button>
            </div>
            {overview ? (
              <p className="storage-meta">
                自动清理：每日空闲执行一次（本地 00:00 后的首个空闲时刻，当日若调整保留窗口，也会再次触发空闲时刻执行）。
                {overview.autoPurge
                  ? `最近一次：${formatDateTime(overview.autoPurge.finishedAt)}`
                    + `（${overview.autoPurge.trigger === "retention-change" ? "窗口调整触发" : "每日例行"}）`
                    + ` —— 清理 ${overview.autoPurge.purgedFileCount} 个文件、释放 ${formatBytes(overview.autoPurge.purgedBytes)}`
                    + `、回收 Blob ${overview.autoPurge.deletedBlobFiles} 个`
                    + (overview.autoPurge.deletedOrphanBlobFiles || overview.autoPurge.deletedOrphanArtifactFiles
                      ? `（含孤儿 ${overview.autoPurge.deletedOrphanBlobFiles ?? 0} 个）`
                      : "")
                    + `、派生物 ${overview.autoPurge.deletedDerivedArtifactFiles} 个`
                    + (overview.autoPurge.deletedOrphanArtifactFiles
                      ? `（含孤儿 ${overview.autoPurge.deletedOrphanArtifactFiles} 个）`
                      : "")
                    + `、跳过 ${overview.autoPurge.skippedCount} 个`
                    + (overview.autoPurge.errorCount > 0 ? `、失败 ${overview.autoPurge.errorCount} 个` : "")
                    + "。"
                  : "尚未执行过。"}
              </p>
            ) : null}
            {overview ? (
              <p className="storage-meta">
                当前窗口截止时间：{formatDateTime(overview.purgePreview.cutoff)}
                {" "}之前可清理文件 {overview.purgePreview.candidateCount} 个、约释放 {formatBytes(overview.purgePreview.reclaimableBytes.total)}
                （捕获 {formatBytes(overview.purgePreview.reclaimableBytes.captureFiles)} + 正文 Blob {formatBytes(overview.purgePreview.reclaimableBytes.externalBlobs)} + 派生物 {formatBytes(overview.purgePreview.reclaimableBytes.derivedArtifacts)}）
                {overview.purgePreview.orphanReclaim.bytes > 0
                  ? `；另有孤儿文件 ${overview.purgePreview.orphanReclaim.blobFileCount + overview.purgePreview.orphanReclaim.artifactFileCount} 个（无引用正文/派生物）约 ${formatBytes(overview.purgePreview.orphanReclaim.bytes)}，执行清理时一并回收`
                  : ""}
                ；跳过 {overview.purgePreview.skippedCount} 个（包含窗口内数据 / 近期仍在写入 / 尚未扫描完成 / 非捕获文件数据源等）。
              </p>
            ) : null}
            {detail ? (
              <>
                {detail.candidates.length > 0 ? (
                  <div className="storage-table-wrap">
                    <table className="storage-table">
                      <thead>
                        <tr>
                          <th>文件</th>
                          <th>大小</th>
                          <th>Exchange</th>
                          <th>最新捕获时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.candidates.map(candidate => (
                          <tr key={candidate.sourceId}>
                            <td title={candidate.relativePath}>{candidate.relativePath.split("/").pop()}</td>
                            <td>{formatBytes(candidate.fileBytes)}</td>
                            <td>{candidate.exchangeCount}</td>
                            <td>{formatDateTime(candidate.latestCapturedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {detail.orphanReclaim.blobFileCount + detail.orphanReclaim.artifactFileCount > 0 ? (
                  <p className="storage-meta">
                    另有孤儿文件 {detail.orphanReclaim.blobFileCount + detail.orphanReclaim.artifactFileCount} 个
                    （无引用正文 / 派生物，约 {formatBytes(detail.orphanReclaim.bytes)}）
                    ——孤儿文件不列入上表，执行清理时一并自动回收。
                  </p>
                ) : null}
                {detail.skipped.length > 0 ? (
                  <details className="storage-skipped">
                    <summary>跳过 {detail.skipped.length} 个文件（{SKIP_REASON_LABELS[detail.skipped[0].reason] ?? detail.skipped[0].reason} 等）</summary>
                    <ul>
                      {detail.skipped.slice(0, 50).map(item => (
                        <li key={`${item.relativePath}:${item.reason}`} title={item.relativePath}>
                          {item.relativePath.split("/").pop()} — {SKIP_REASON_LABELS[item.reason] ?? item.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {detail.candidates.length > 0
                  || detail.orphanReclaim.blobFileCount + detail.orphanReclaim.artifactFileCount > 0 ? (
                    <button type="button" className="storage-danger" onClick={() => void executePurge()} disabled={busy}>
                      <Trash2 size={13} aria-hidden="true" />
                      {detail.candidates.length > 0
                        ? `一键清除以上 ${detail.candidates.length} 个文件（含回收孤儿文件）`
                        : `回收 ${detail.orphanReclaim.blobFileCount + detail.orphanReclaim.artifactFileCount} 个孤儿文件`}
                    </button>
                  ) : (
                    <p className="storage-meta">当前没有可清理的文件。</p>
                  )}
              </>
            ) : (
              <p className="storage-meta">点击「扫描可清理文件」查看文件级明细。</p>
            )}
            {lastResult ? (
              <p className="storage-meta">
                上次清理：{lastResult.purgedFiles.length} 个文件、回收 Blob {lastResult.deletedBlobFiles} 个
                {lastResult.deletedOrphanBlobFiles ? `（含孤儿 ${lastResult.deletedOrphanBlobFiles} 个）` : ""}、
                派生物 {lastResult.deletedDerivedArtifactFiles} 个
                {lastResult.deletedOrphanArtifactFiles ? `（含孤儿 ${lastResult.deletedOrphanArtifactFiles} 个）` : ""}、
                SQLite 归还 {lastResult.vacuumedPages} 页。
                {lastResult.errors.length > 0 ? ` 失败：${lastResult.errors.map(item => item.relativePath).join("、")}` : ""}
              </p>
            ) : null}
          </section>

          <section className="storage-card">
            <div className="storage-card-head">
              <h3>清理影响说明</h3>
            </div>
            <div className="storage-table-wrap storage-impact-wrap">
              <table className="storage-table storage-impact-table">
                <thead>
                  <tr>
                    <th>存储位置</th>
                    <th>对应的页面功能（超窗 / 清理后表现）</th>
                  </tr>
                </thead>
                <tbody>
                  {PURGE_IMPACT_ROWS.map(row => (
                    <tr
                      key={row.location.label}
                      className={row.permanent ? "storage-impact-permanent" : undefined}
                    >
                      <td>
                        <div className="storage-impact-label">{row.location.label}</div>
                        <div className="storage-impact-path">{row.location.path}</div>
                        {row.location.tables ? (
                          <ul className="storage-impact-tables">
                            {row.location.tables.map(table => (
                              <li key={table.name}>
                                <code>{table.name}</code>
                                {table.desc ? `（${table.desc}）` : ""}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td>
                        <ul className="storage-impact-features">
                          {row.features.map(feature => (
                            <li key={feature}>{feature}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {error ? <p className="storage-error" role="alert">{error}</p> : null}
          {message ? <p className="storage-message" role="status">{message}</p> : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

const SKIP_REASON_LABELS: Record<string, string> = {
  non_capture_source: "非捕获文件数据源（对账补差合成行，不参与清理）",
  status_not_ready: "文件轮转待重扫",
  active_jobs: "仍有未完成派生",
  no_records: "尚未扫描完成或仍有窗口内登记",
  mixed_window: "包含窗口内数据",
  recently_modified: "近期仍在写入",
  file_identity_mismatch: "文件身份不一致",
  stat_failed: "文件读取失败",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}
