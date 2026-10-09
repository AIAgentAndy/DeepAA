import {ChevronLeft, ChevronRight, LoaderCircle, Search, X} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ConfigFileDisplayData,
  ConfigFileSection,
} from "@/lib/config-sync/file-display";
import {hasMaskedSecret} from "@/lib/config-sync/file-display";
import styles from "./proxy-management.module.css";

interface ConfigFileDialogProps {
  file: ConfigFileDisplayData;
  targetId: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/** 全屏配置检查器：对照同步前后内容，并保持当前供应商贡献的逐行来源标识。 */
export function ConfigFileDialog({file, targetId, returnFocusRef, onClose}: ConfigFileDialogProps) {
  const [currentFile, setCurrentFile] = useState(file);
  const [view, setView] = useState<"merged" | "before">("merged");
  const [query, setQuery] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const content = view === "merged" ? currentFile.content : currentFile.beforeContent;
  const sections = view === "merged" ? currentFile.sections : [];
  const matchCount = useMemo(() => countLineMatches(content, query), [content, query]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      (returnFocusRef.current || previouslyFocused)?.focus();
    };
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    setCurrentFile(file);
  }, [file]);

  async function revealSecrets() {
    if (revealing || !hasMaskedSecret(content)) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const params = new URLSearchParams({fileId: file.fileId, targetId, reveal: "1"});
      const response = await fetch(`/api/config-sync/file?${params.toString()}`, {cache: "no-store"});
      const body = await response.json() as {ok?: boolean; file?: ConfigFileDisplayData; message?: string};
      if (!response.ok || !body.file) throw new Error(body.message || "敏感值展开失败");
      setCurrentFile(body.file);
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : "敏感值展开失败");
    } finally {
      setRevealing(false);
    }
  }

  return <div
    className={styles.configFileDialogBackdrop}
    onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <div
      ref={dialogRef}
      className={styles.configFileDialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="config-file-dialog-title"
    >
      <header className={styles.configFileDialogHeader}>
        <div>
          <span className={styles.configFileDialogEyebrow}>受管配置文件检查器</span>
          <h2 id="config-file-dialog-title">{file.description}</h2>
          <code>{file.path}</code>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className={styles.configFileDialogClose}
          aria-label="关闭配置文件全屏查看"
          title="关闭（Esc）"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>

      <div className={styles.configFileDialogToolbar}>
        <div className={styles.configFileViewTabs} role="tablist" aria-label="配置文件内容版本">
          <button
            type="button"
            role="tab"
            aria-selected={view === "merged"}
            className={view === "merged" ? styles.configFileViewTabActive : ""}
            onClick={() => setView("merged")}
          >
            合并后内容
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "before"}
            className={view === "before" ? styles.configFileViewTabActive : ""}
            onClick={() => setView("before")}
          >
            同步前内容
          </button>
        </div>
        <label className={styles.configFileSearch}>
          <span>搜索文件内容</span>
          <span className={styles.configFileSearchControl}>
            <Search size={15} />
            <input
              type="search"
              value={query}
              placeholder="模型、配置键或供应商…"
              onChange={event => setQuery(event.currentTarget.value)}
            />
            {query ? <small>{matchCount} 行</small> : null}
          </span>
        </label>
      </div>

      <div className={styles.configFileDialogContext}>
        {view === "merged" ? <ConfigFileLegend /> : <span>同步前内容用于对照 DeepAA 写入前的本地配置。</span>}
        <span>{currentFile.exists ? `当前文件 ${formatBytes(currentFile.bytes)}` : "当前文件尚未创建"} · 单文件读取上限 {formatBytes(currentFile.maxBytes)}</span>
      </div>

      {revealError ? <div className={styles.configFileError} role="alert">{revealError}</div> : null}

      <div className={styles.configFileDialogBody} role="tabpanel">
        {content.trim() === ""
          ? <div className={styles.configFileDialogEmpty}>{view === "before" ? "同步前文件不存在或内容为空。" : "合并后暂无可展示内容。"}</div>
          : <ConfigFileCodeView
            content={content}
            sections={sections}
            search={query}
            showUnmanaged
            before={view === "before"}
            secretsRevealed={!hasMaskedSecret(content)}
            revealLoading={revealing}
            onRevealSecrets={() => void revealSecrets()}
          />}
      </div>

      <footer className={styles.configFileDialogFooter}>
        <span>敏感值默认显示前后各 4 位；点击“展开敏感值”后显示完整本地配置。</span>
        <span><ChevronLeft size={13} /> Esc 关闭 <ChevronRight size={13} /></span>
      </footer>
    </div>
  </div>;
}

interface ConfigFileCodeViewProps {
  content: string;
  sections: ConfigFileSection[];
  showUnmanaged: boolean;
  search?: string;
  before?: boolean;
  secretsRevealed?: boolean;
  revealLoading?: boolean;
  onRevealSecrets?: () => void;
}

/**
 * 内嵌与全屏共用的逐行查看器。section 来源由服务端根据各 Agent 的真实配置语义计算，
 * 前端只负责可视化；敏感值的完整展示必须通过用户显式点击触发。
 */
export function ConfigFileCodeView({
  content,
  sections,
  showUnmanaged,
  search = "",
  before = false,
  secretsRevealed = false,
  revealLoading = false,
  onRevealSecrets,
}: ConfigFileCodeViewProps) {
  const lines = content.split("\n");
  if (content.endsWith("\n") && lines.at(-1) === "") lines.pop();
  const sectionByLine: Array<ConfigFileSection | undefined> = new Array(lines.length + 1);
  for (const section of sections) {
    for (let line = section.startLine; line <= Math.min(section.endLine, lines.length); line++) {
      sectionByLine[line] = section;
    }
  }

  const nodes: ReactNode[] = [];
  let line = 1;
  while (line <= lines.length) {
    const section = sectionByLine[line];
    if (!before && (!section || section.kind === "unmanaged") && !showUnmanaged) {
      let end = line;
      while (end <= lines.length && (!sectionByLine[end] || sectionByLine[end]!.kind === "unmanaged")) end++;
      const count = end - line;
      nodes.push(<div key={`folded-${line}`} className={`${styles.configLine} ${styles.configLineFolded}`}>
        <span className={styles.configLineNo}>{count > 1 ? `${line}–${end - 1}` : line}</span>
        <code>⋯ 用户保留内容 {count} 行（可在下方展开，敏感值已由服务端脱敏）⋯</code>
      </div>);
      line = end;
      continue;
    }

    const text = lines[line - 1] || " ";
    const kind = before ? "before" : section?.kind || "unmanaged";
    nodes.push(<div
      key={`line-${line}`}
      className={`${styles.configLine} ${lineKindClass(kind)}`}
      data-source={kind}
      title={section?.label}
    >
      <span className={styles.configLineNo}>{line}</span>
      <code>{highlightSearch(text, search)}</code>
      {!secretsRevealed && hasMaskedSecret(text) && onRevealSecrets ? <button
        type="button"
        className={styles.configSecretRevealButton}
        onClick={onRevealSecrets}
        disabled={revealLoading}
      >
        {revealLoading ? <LoaderCircle className={styles.spinIcon} size={12} /> : null}
        {revealLoading ? "展开中…" : "展开敏感值"}
      </button> : null}
      {section && section.startLine === line
        ? <span className={styles.configLineSourceLabel}>{sectionKindLabel(section.kind)} · {section.label}</span>
        : null}
    </div>);
    line++;
  }
  return <div className={styles.configLineList}>{nodes}</div>;
}

/** 当前供应商贡献与其它来源不能只靠颜色表达，图例同时提供明确文字。 */
export function ConfigFileLegend() {
  return <div className={styles.configFileLegend} aria-label="配置内容来源图例">
    <span><i className={styles.configLegendCurrent} />当前供应商贡献</span>
    <span><i className={styles.configLegendShared} />DeepAA 共享接管</span>
    <span><i className={styles.configLegendManaged} />其它供应商贡献</span>
    <span><i className={styles.configLegendUser} />用户保留内容</span>
  </div>;
}

function lineKindClass(kind: ConfigFileSection["kind"] | "before"): string {
  if (kind === "current-target") return styles.configLineCurrent;
  if (kind === "shared-managed") return styles.configLineShared;
  if (kind === "managed-other") return styles.configLineManaged;
  if (kind === "before") return styles.configLineBefore;
  return styles.configLineUnmanaged;
}

function sectionKindLabel(kind: ConfigFileSection["kind"]): string {
  if (kind === "current-target") return "当前供应商";
  if (kind === "shared-managed") return "DeepAA 共享";
  if (kind === "managed-other") return "其它供应商";
  return "用户保留";
}

function highlightSearch(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const lowerText = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerNeedle, cursor);
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={`${index}-${parts.length}`}>{text.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
    index = lowerText.indexOf(lowerNeedle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? <Fragment>{parts}</Fragment> : text;
}

function countLineMatches(content: string, query: string): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  return content.split("\n").filter(line => line.toLocaleLowerCase().includes(needle)).length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
