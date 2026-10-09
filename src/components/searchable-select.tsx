"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** 行中部淡色辅助维度（如供应商名，2026-10-07 价格中心选择器）：主标签精简、辅助维度弱化。 */
  hint?: string;
  /** 行最右状态列（如「可加入 / 已加入」，2026-10-07 价格中心选择器）。 */
  status?: string;
  /** 置灰不可选行（如已加入模型白名单的条目）：不可点击、不参与键盘选中。 */
  disabled?: boolean;
}

export interface SearchableSelectProps {
  value: string;
  options: SearchableSelectOption[];
  searchValue: string;
  onSearchChange: (value: string) => void;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  placeholder: string;
  searchPlaceholder: string;
  loading?: boolean;
  disabled?: boolean;
  resultMessage?: string;
  filterOptions?: boolean;
  ariaLabel?: string;
  /** 菜单底部操作区（如「加载更多」分页，2026-10-07）：与 resultMessage 计数行并存。 */
  footerAction?: {label: string; onClick: () => void; disabled?: boolean};
  /** 搜索框紧贴下方的内容插槽（2026-10-07 价格中心选择器：搜索词家族供应商过滤开关）。 */
  belowSearch?: ReactNode;
}

/** 统一代理设置与开发启动的可搜索列表框行为。 */
export function SearchableSelect({
  value,
  options,
  searchValue,
  onSearchChange,
  onChange,
  onOpenChange,
  placeholder,
  searchPlaceholder,
  loading = false,
  disabled = false,
  resultMessage,
  filterOptions = true,
  ariaLabel,
  footerAction,
  belowSearch,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPos, setMenuPos] = useState<{top?: number; bottom?: number; left: number; width: number} | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const query = searchValue.trim().toLowerCase();
  const filteredOptions = filterOptions && query
    ? options.filter(option =>
      option.label.toLowerCase().includes(query)
      || option.value.toLowerCase().includes(query),
    )
    : options;
  const visibleOptions = uniqueOptions([
    ...(value && !filteredOptions.some(option => option.value === value)
      ? [{ value, label: value }]
      : []),
    ...filteredOptions,
  ]);
  const selectedLabel = options.find(option => option.value === value)?.label || value;
  const activeOptionId = activeIndex >= 0
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  useEffect(() => {
    setActiveIndex(current => visibleOptions.length === 0
      ? -1
      : Math.min(Math.max(current, 0), visibleOptions.length - 1));
  }, [visibleOptions.length]);

  // 打开状态下：点击触发器/菜单外部关闭；视口滚动/缩放时关闭，避免 fixed 定位错位。
  useEffect(() => {
    if (!open) return;
    const closeOnDocumentDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpenState(false);
    };
    const closeOnViewportChange = (event: Event) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      setOpenState(false);
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

  function setOpenState(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      const selectedIndex = visibleOptions.findIndex(option => option.value === value);
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : visibleOptions.length > 0 ? 0 : -1);
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        // 菜单渲染到 body（portal），可突破弹窗/卡片边界；下方空间不足时向上展开。
        const estimatedHeight = Math.min(340, 96 + visibleOptions.length * 30);
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const openUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
        setMenuPos(openUp
          ? {bottom: window.innerHeight - rect.top + 4, left: rect.left, width: Math.max(rect.width, 220)}
          : {top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 220)});
      } else {
        setMenuPos(null);
      }
    } else {
      setActiveIndex(-1);
      setMenuPos(null);
    }
    onOpenChange?.(nextOpen);
  }

  function selectOption(index: number) {
    const option = visibleOptions[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpenState(false);
    triggerRef.current?.focus();
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(current => visibleOptions.length > 0
        ? Math.min(current + 1, visibleOptions.length - 1)
        : -1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(current => visibleOptions.length > 0
        ? current <= 0 ? visibleOptions.length - 1 : current - 1
        : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectOption(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpenState(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="searchable-select">
      <button
        ref={triggerRef}
        type="button"
        className="searchable-select-trigger"
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => setOpenState(!open)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpenState(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpenState(false);
          }
        }}
      >
        <span>{selectedLabel || (loading ? "加载中..." : placeholder)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && menuPos ? createPortal(
        <div
          ref={menuRef}
          className="searchable-select-menu searchable-select-menu-portal"
          style={{position: "fixed", top: menuPos.top, bottom: menuPos.bottom, left: menuPos.left, width: menuPos.width}}
        >
          <input
            className="searchable-select-search"
            type="search"
            role="combobox"
            value={searchValue}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            autoFocus
            onChange={event => onSearchChange(event.currentTarget.value)}
            onKeyDown={handleListKeyDown}
          />
          {belowSearch}
          <div id={listboxId} className="searchable-select-options" role="listbox">
            {visibleOptions.length > 0 ? visibleOptions.map((option, index) => (
              <button
                id={`${listboxId}-option-${index}`}
                key={option.value}
                type="button"
                className={`searchable-select-option${option.value === value ? " selected" : ""}${index === activeIndex ? " active" : ""}${option.disabled ? " disabled" : ""}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
                onClick={() => selectOption(index)}
              >
                <span className="searchable-select-option-label">{option.label}</span>
                {option.hint ? <span className="searchable-select-option-hint">{option.hint}</span> : null}
                {option.status ? <span className={`searchable-select-option-status${option.disabled ? " added" : ""}`}>{option.status}</span> : null}
              </button>
            )) : (
              <div className="searchable-select-empty">{loading ? "加载中..." : "无匹配项"}</div>
            )}
          </div>
          {resultMessage || footerAction ? <div className="searchable-select-status" aria-live="polite">
            {resultMessage ? <span className="searchable-select-status-text">{resultMessage}</span> : null}
            {footerAction ? <button type="button" className="searchable-select-more" onClick={footerAction.onClick} disabled={footerAction.disabled || loading}>{footerAction.label}</button> : null}
          </div> : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function uniqueOptions(options: SearchableSelectOption[]): SearchableSelectOption[] {
  const seen = new Set<string>();
  const result: SearchableSelectOption[] = [];
  for (const option of options) {
    if (!option.value || seen.has(option.value)) continue;
    seen.add(option.value);
    result.push(option);
  }
  return result;
}
