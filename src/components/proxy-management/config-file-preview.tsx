import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  LoaderCircle,
  Maximize2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {
  ConfigFileCodeView,
  ConfigFileDialog,
  ConfigFileLegend,
} from "@/components/proxy-management/config-file-dialog";
import type {
  ConfigFileDisplayData,
  ConfigFileDisplayManifest,
} from "@/lib/config-sync/file-display";
import {hasMaskedSecret} from "@/lib/config-sync/file-display";
import type {CliFileKind} from "@/lib/config-sync/core/types";
import styles from "./proxy-management.module.css";

interface ConfigFilePreviewResponse {
  ok?: boolean;
  file?: ConfigFileDisplayData;
  message?: string;
}

/**
 * Agent 卡片中的受管文件检查器。
 *
 * 首屏只接收不含正文的 manifest；用户展开或进入全屏时，才以服务端签发的 fileId
 * 读取单个文件。浏览器不会提交本地路径，响应正文默认只显示敏感值首尾；显式展开后才回传完整本地值。
 */
export function ConfigFilePreview({files, targetId}: {
  files: ConfigFileDisplayManifest[];
  targetId: string;
}) {
  return <div className={styles.configFileStack}>
    {files.map(file => <ConfigFileCard key={file.fileId} file={file} targetId={targetId} />)}
  </div>;
}

function ConfigFileCard({file, targetId}: {
  file: ConfigFileDisplayManifest;
  targetId: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(file.statusMessage || null);
  const [preview, setPreview] = useState<ConfigFileDisplayData | null>(null);
  const [showUnmanaged, setShowUnmanaged] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [secretsRevealed, setSecretsRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const previewRequestRef = useRef<AbortController | null>(null);
  const panelId = `config-file-${file.fileId.replace(/[^A-Za-z0-9_-]/gu, "-")}`;

  // fileId 在供应商切换后仍可能相同；manifest 或 target 变化时必须废弃旧请求和旧贡献结果。
  useEffect(() => {
    previewRequestRef.current?.abort();
    previewRequestRef.current = null;
    setOpen(false);
    setLoading(false);
    setError(file.statusMessage || null);
    setPreview(null);
    setShowUnmanaged(false);
    setDialogOpen(false);
    setSecretsRevealed(false);
    setRevealing(false);
    return () => previewRequestRef.current?.abort();
  }, [file, targetId]);

  async function loadPreview(revealSecrets = false): Promise<ConfigFileDisplayData | null> {
    if (preview && (!revealSecrets || secretsRevealed)) return preview;
    previewRequestRef.current?.abort();
    const controller = new AbortController();
    previewRequestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({fileId: file.fileId, targetId});
      if (revealSecrets) params.set("reveal", "1");
      const response = await fetch(`/api/config-sync/file?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json() as ConfigFilePreviewResponse;
      if (controller.signal.aborted) return null;
      if (!response.ok || !body.file) {
        throw new Error(body.message || "受管配置文件读取失败");
      }
      setPreview(body.file);
      if (revealSecrets) setSecretsRevealed(true);
      return body.file;
    } catch (loadError) {
      if (controller.signal.aborted) return null;
      const message = loadError instanceof Error ? loadError.message : "受管配置文件读取失败";
      setError(message);
      return null;
    } finally {
      if (previewRequestRef.current === controller) {
        previewRequestRef.current = null;
        setLoading(false);
      }
    }
  }

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void loadPreview();
  }

  async function openDialog() {
    setOpen(true);
    const loaded = await loadPreview();
    if (loaded) setDialogOpen(true);
  }

  async function revealSecrets() {
    if (secretsRevealed || !preview || !hasMaskedSecret(preview.content)) return;
    setRevealing(true);
    try {
      await loadPreview(true);
    } finally {
      setRevealing(false);
    }
  }

  const unmanagedLineCount = preview?.sections
    .filter(section => section.kind === "unmanaged")
    .reduce((sum, section) => sum + section.endLine - section.startLine + 1, 0) || 0;

  return <section className={styles.configFileCard}>
    <header className={styles.configFileHeader}>
      <button
        type="button"
        className={styles.configFileToggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggleOpen}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <FileCode2 size={15} />
        <span className={styles.configFileIdentity}>
          <code className={styles.configFilePath}>{file.path}</code>
          <small>{file.description}</small>
        </span>
      </button>
      <div className={styles.configFileHeaderActions}>
        <span className={styles.configFileMeta}>
          <span className={`${styles.badge} ${file.active ? styles.badgeReady : styles.badgePending}`}>
            {file.active ? "启用" : "清理"}
          </span>
          <span className={`${styles.badge} ${file.status === "ready" || (file.status === "sensitive" && file.exists) ? styles.badgeReady : styles.badgePending}`}>
            {statusLabel(file)}
          </span>
          <span className={styles.badge}>{kindLabel(file.kind)}</span>
          <span className={`${styles.badge} ${styles.configFileManagement} ${managementTone(file)}`}>
            {managementLabel(file)}
          </span>
          {file.sensitive
            ? <span className={`${styles.badge} ${styles.badgePending}`}><ShieldAlert size={12} /> 凭据文件</span>
            : null}
          <span className={`${styles.badge} ${contributionTone(preview)}`}>{contributionLabel(preview)}</span>
        </span>
        <button
          ref={fullscreenButtonRef}
          type="button"
          className={styles.configFileFullscreenButton}
          aria-label={`全屏查看 ${file.path}`}
          title="全屏查看配置文件"
          disabled={loading}
          onClick={() => void openDialog()}
        >
          {loading ? <LoaderCircle className={styles.spinIcon} size={17} /> : <Maximize2 size={17} />}
        </button>
      </div>
    </header>

    {open ? <div id={panelId} className={styles.configFileBody}>
      {loading && !preview ? <div className={styles.configFileHint} role="status">
        <LoaderCircle className={styles.spinIcon} size={16} /> 正在按需读取并脱敏配置文件…
      </div> : null}
      {error ? <div className={styles.configFileError} role="alert">
        <span>{error}</span>
        <button type="button" className={styles.textButton} onClick={() => void loadPreview()}>
          <RefreshCw size={14} /> 重试
        </button>
      </div> : null}
      {preview && !error ? <>
        {preview.sensitive ? <div className={styles.configFileSensitiveNote}>
          <ShieldAlert size={16} />
          <span>敏感值默认只显示前后各 4 位；点击对应行的“展开敏感值”后，可查看完整本地配置。</span>
        </div> : null}
        {preview.content.trim() === "" && preview.sections.length === 0
          ? <div className={styles.configFileHint}>文件当前不存在或为空；完成同步后会在这里展示服务端脱敏的合并结果。</div>
          : <>
            <ConfigFileLegend />
            <div className={styles.configFileWindow}>
              <ConfigFileCodeView
                content={preview.content}
                sections={preview.sections}
                showUnmanaged={showUnmanaged || preview.sensitive}
                secretsRevealed={secretsRevealed}
                revealLoading={revealing}
                onRevealSecrets={() => void revealSecrets()}
              />
            </div>
          </>}
      </> : null}
    </div> : null}

    {open && preview && unmanagedLineCount > 0 ? <footer className={styles.configFileFooter}>
      <button type="button" className={styles.textButton} onClick={() => setShowUnmanaged(value => !value)}>
        {showUnmanaged ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {showUnmanaged ? "折叠" : "展开"}用户保留内容 {unmanagedLineCount} 行
        {!showUnmanaged ? "（敏感值已由服务端脱敏）" : ""}
      </button>
    </footer> : null}

    {dialogOpen && preview ? <ConfigFileDialog
      file={preview}
      targetId={targetId}
      returnFocusRef={fullscreenButtonRef}
      onClose={() => setDialogOpen(false)}
    /> : null}
  </section>;
}

function contributionLabel(preview: ConfigFileDisplayData | null): string {
  if (!preview) return "展开后查看贡献";
  const currentCount = preview.sections.filter(section => section.kind === "current-target").length;
  if (currentCount > 0) return `当前供应商贡献 ${currentCount} 项`;
  if (preview.sections.some(section => section.kind === "shared-managed")) return "仅含 DeepAA 共享接管";
  if (preview.sections.some(section => section.kind === "managed-other")) return "当前供应商未写入此文件";
  return "暂无受管内容";
}

function statusLabel(file: ConfigFileDisplayManifest): string {
  if (file.status === "error") return "读取异常";
  if (file.status === "pending-create") return "待创建";
  if (file.status === "missing") return "当前不存在";
  if (file.status === "sensitive" && !file.exists) return "待创建";
  return `已存在 · ${formatBytes(file.bytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function contributionTone(preview: ConfigFileDisplayData | null): string {
  if (!preview) return "";
  return preview.sections.some(section => section.kind === "current-target") ? styles.badgeDefault : "";
}

function kindLabel(kind: CliFileKind): string {
  return kind === "jsonc" ? "JSONC" : kind.toUpperCase();
}

function managementLabel(file: ConfigFileDisplayManifest): string {
  if (file.ownership === "sensitive") return "安全定点 Patch";
  if (file.ownership === "full") return "整体受管";
  return "局部合并";
}

function managementTone(file: ConfigFileDisplayManifest): string {
  if (file.ownership === "sensitive") return styles.configFileManagementSensitive;
  if (file.ownership === "full") return styles.configFileManagementFull;
  return styles.configFileManagementPartial;
}
