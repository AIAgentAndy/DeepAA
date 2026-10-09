"use client";

import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MultiSelectFilterOption {
  value: string;
  label: string;
}

export interface MultiSelectFilterProps {
  /** 触发器标签（如「模型」「供应商」「来源类别」）。 */
  label: string;
  options: MultiSelectFilterOption[];
  /** 当前选中值；空数组 = 不过滤（展示原始标签）。 */
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder?: string;
  ariaLabel?: string;
  /** 触发器最小宽度（px）；面板宽度跟随触发器，用于加宽搜索型多选（如价格中心「模型」）。 */
  triggerMinWidth?: number;
}

const MAX_RENDERED_OPTIONS = 200;
/** 值域超过该数量时，勾选后在工具条下方展示已选项 chips（值域小则列表本身可见，无需重复展示）。 */
const SELECTED_LIST_THRESHOLD = 50;
/** 已选项 chips 渲染上限，超出折叠为计数，防止全选大值域时 DOM 爆量。 */
const MAX_SELECTED_CHIPS = 50;
/** 触发器 title 中拼接已选标签的上限。 */
const MAX_TITLE_LABELS = 20;

/**
 * 通用下拉多选筛选（2026-09-07 价格中心；2026-09-08 定为全站下拉多选规范模板）：
 * 顶部快速搜索 + 全选/全不选 + 「已选 x / y（总数）」 + 复选列表；
 * 值域 > SELECTED_LIST_THRESHOLD 且有勾选时，在工具条下方展示已选项 chips（可单个移除）。
 * 草稿态编辑、下拉收起（外点/Esc/滚动/再点触发器）时一次性提交，避免逐项触发查询。
 * 选中集合覆盖全部选项时归一为空数组（全选 == 不过滤），防止发送超长查询参数。
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  searchPlaceholder,
  ariaLabel,
  triggerMinWidth,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{top?: number; bottom?: number; left: number; width: number} | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Set<string>>(() => new Set(selected));
  const draftRef = useRef(draft);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  draftRef.current = draft;
  const selectedSet = new Set(selected);
  const query = search.trim().toLowerCase();
  const filteredOptions = query
    ? options.filter(option =>
      option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query))
    : options;
  const visibleOptions = filteredOptions.slice(0, MAX_RENDERED_OPTIONS);
  const allFilteredSelected = filteredOptions.length > 0
    && filteredOptions.every(option => draft.has(option.value));
  const optionLabelOf = (value: string) => options.find(option => option.value === value)?.label || value;
  const draftOptions = options.filter(option => draft.has(option.value));

  // 打开状态下：点击触发器/面板外部、视口滚动或缩放时收起并提交（fixed 定位防错位）。
  useEffect(() => {
    if (!open) return;
    const closeOnDocumentDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    const closeOnViewportChange = (event: Event) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", closeOnDocumentDown);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("mousedown", closeOnDocumentDown);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function openPanel() {
    setDraft(new Set(selected));
    setSearch("");
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // 面板渲染到 body（portal），可突破弹窗边界；下方空间不足时向上展开。
      const estimatedHeight = Math.min(320, 92 + Math.min(visibleOptions.length, 8) * 28);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const openUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
      setMenuPos(openUp
        ? {bottom: window.innerHeight - rect.top + 4, left: rect.left, width: Math.max(rect.width, 220)}
        : {top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 220)});
    } else {
      setMenuPos(null);
    }
    setOpen(true);
  }

  /** 收起并提交：与 props 无差异时不触发；覆盖全部选项时归一为「不过滤」。 */
  function close() {
    const next = [...draftRef.current].filter(value => options.some(option => option.value === value));
    const unchanged = next.length === selected.length && next.every(value => selectedSet.has(value));
    setOpen(false);
    setMenuPos(null);
    if (!unchanged) {
      onChange(next.length > 0 && next.length === options.length ? [] : next);
    }
  }

  function toggleOption(value: string) {
    setDraft(current => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function selectAllFiltered() {
    setDraft(current => {
      const next = new Set(current);
      if (allFilteredSelected) {
        // 再次点击 = 取消当前可见范围的勾选。
        for (const option of filteredOptions) next.delete(option.value);
      } else {
        for (const option of filteredOptions) next.add(option.value);
      }
      return next;
    });
  }

  function clearAll() {
    setDraft(new Set());
  }

  // 触发器 title 用标签而非原始值，且限定条数，防止大值域全选时生成超长 DOM 属性。
  const titleLabels = selected.slice(0, MAX_TITLE_LABELS).map(optionLabelOf);
  const titleText = selected.length > 0
    ? `${label}：已选 ${titleLabels.join("、")}${selected.length > titleLabels.length ? ` 等 ${selected.length} 项` : ""}`
    : `${label}：全部`;

  return (
    <div className="msf">
      <button
        ref={triggerRef}
        type="button"
        className={`msf-trigger${selected.length > 0 ? " active" : ""}`}
        style={triggerMinWidth ? {minWidth: triggerMinWidth, justifyContent: "space-between"} : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel || label}
        title={titleText}
        onClick={() => (open ? close() : openPanel())}
      >
        <span>{selected.length > 0 ? `${label} · 已选 ${selected.length}` : label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && menuPos ? createPortal(
        <div
          ref={menuRef}
          className="msf-panel"
          style={{position: "fixed", top: menuPos.top, bottom: menuPos.bottom, left: menuPos.left, width: menuPos.width}}
        >
          <input
            className="msf-search"
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-label={searchPlaceholder || `搜索${label}`}
            placeholder={searchPlaceholder || `搜索${label}…`}
            autoFocus
            value={search}
            onChange={event => setSearch(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                triggerRef.current?.focus();
              }
            }}
          />
          <div className="msf-bar">
            <button type="button" className="msd-mini" onClick={selectAllFiltered}>
              {allFilteredSelected ? "取消全选" : "全选"}
            </button>
            <button type="button" className="msd-mini" onClick={clearAll}>全不选</button>
            <span className="msf-count">已选 {draft.size} / {options.length}</span>
          </div>
          {options.length > SELECTED_LIST_THRESHOLD && draft.size > 0 ? (
            <div className="msf-selected" aria-label={`${label}已选项`}>
              {draftOptions.slice(0, MAX_SELECTED_CHIPS).map(option => (
                <span key={option.value} className="msf-chip" title={option.label}>
                  <span className="msf-chip-label">{option.label}</span>
                  <button
                    type="button"
                    className="msf-chip-remove"
                    aria-label={`移除 ${option.label}`}
                    onClick={() => toggleOption(option.value)}
                  >
                    <X size={10} aria-hidden="true" />
                  </button>
                </span>
              ))}
              {draftOptions.length > MAX_SELECTED_CHIPS ? (
                <span className="msf-chip msf-chip-more">等 {draft.size} 项</span>
              ) : null}
            </div>
          ) : null}
          <div id={listboxId} className="msf-options" role="listbox" aria-multiselectable="true">
            {visibleOptions.length > 0 ? visibleOptions.map(option => (
              <label key={option.value} className="msf-option">
                <input
                  type="checkbox"
                  checked={draft.has(option.value)}
                  onChange={() => toggleOption(option.value)}
                />
                <span>{option.label}</span>
              </label>
            )) : (
              <div className="msf-empty">无匹配项</div>
            )}
            {filteredOptions.length > visibleOptions.length ? (
              <div className="msf-more">共 {filteredOptions.length} 项匹配，仅显示前 {MAX_RENDERED_OPTIONS} 项，请输入缩小范围</div>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
