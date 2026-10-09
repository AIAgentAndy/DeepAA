"use client";

import {createPortal} from "react-dom";
import {useEffect, useRef, useState} from "react";
import {AGENT_REGISTRY} from "@/lib/agent-registry";

export interface AgentScopeOption<Id extends string = string> {
  id: Id;
  label: string;
  /** 选中态背景色 key：与注册表 id 同名；缺省使用通用选中样式。 */
  color?: string;
  disabled?: boolean;
}

/**
 * 全局 Agent 注册表（与网关 /{agent}/v1 白名单同源）。
 * 新增 Agent 只改 src/lib/agent-registry.ts，这里自动出现可用选项；
 * 专属配色类名在样式表中按 agent id 命名，未定义时回退通用选中样式。
 */
export const KNOWN_AGENT_OPTIONS: AgentScopeOption[] = AGENT_REGISTRY.map(entry => ({
  id: entry.id,
  label: entry.label,
  color: entry.id,
  disabled: false,
}));

interface AgentScopePickerProps<Id extends string> {
  /** 显式勾选集合：没有「全部」值域，空数组表示未选择任何 Agent。 */
  value: Id[];
  /** 提交修改：与 value 不同时面板底部出现「确认修改」按钮。 */
  onConfirm: (selected: Id[]) => void;
  options?: AgentScopeOption<Id>[];
  /** 表格等紧凑场景使用更小的触发按钮。 */
  compact?: boolean;
  /** 触发按钮的默认文案；不传时显示勾选摘要。 */
  label?: string;
}

/**
 * 适用 Agent 精筛下拉：按颜色背景区分勾选/未勾选，修改后必须点「确认修改」才生效，
 * 避免误点即改；面板选项全部来自调用方传入的“当前供应商支持的 Agent”。
 */
export function AgentScopePicker<Id extends string>({
  value,
  onConfirm,
  options = KNOWN_AGENT_OPTIONS as AgentScopeOption<Id>[],
  compact = false,
  label,
}: AgentScopePickerProps<Id>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Id[]>(value);
  const [panelPos, setPanelPos] = useState<{top: number; left: number; width: number; height: number} | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const active = options.filter(option => !option.disabled);
  const dirty = draft.length !== value.length || draft.some(id => !value.includes(id));

  useEffect(() => {
    if (open) setDraft(value);
    // 外部值变化（保存成功回填）时同步草稿，避免面板显示过期勾选。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (
        !rootRef.current?.contains(event.target as Node)
        && !panelRef.current?.contains(event.target as Node)
      ) setOpen(false);
    };
    const onViewportChange = (event: Event) => {
      // 面板自身滚动（未来选项较多时）不视为视口变化，避免误关。
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function togglePanel() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelWidth = Math.max(rect.width, 220);
    const estimateHeight = 34 + 30 + options.length * 30 + 48;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openUp = spaceBelow < estimateHeight && spaceAbove > spaceBelow;
    // 向上展开时以底部锚定：面板顶部 = rect.top - 面板高度，并限制不超过视口顶部；
    // 向下展开时限制面板高度不超过视口底部，避免被页面底部裁掉。
    const panelHeight = Math.min(estimateHeight, openUp ? Math.max(120, spaceAbove) : Math.max(120, spaceBelow));
    setPanelPos({
      top: openUp ? Math.max(8, rect.top - panelHeight) : rect.bottom + 4,
      left: Math.min(Math.max(8, rect.left), window.innerWidth - panelWidth - 8),
      width: panelWidth,
      height: panelHeight,
    });
    setDraft(value);
    setOpen(true);
  }

  function toggle(optionId: Id) {
    setDraft(current => current.includes(optionId)
      ? current.filter(id => id !== optionId)
      : [...current, optionId]);
  }

  function selectAll() {
    setDraft(active.map(option => option.id));
  }

  function confirm() {
    onConfirm(draft);
    setOpen(false);
  }

  const selectedLabels = value
    .map(id => options.find(option => option.id === id)?.label)
    .filter((item): item is string => Boolean(item));
  // 触发按钮右侧的彩色展开标识：取第一个选中 Agent 的主色，未选中时为中性色。
  const caretColor = value.length > 0
    ? (options.find(option => option.id === value[0])?.color ?? "neutral")
    : "neutral";
  // 摘要展示选中的全部 Agent（不因「第一个未选」而少显示）；
  // 表格等紧凑场景宽度受限时才折叠为前两个 + 剩余数量。
  const summaryIds = compact ? value.slice(0, 2) : value;

  return (
    <span className={`agent-scope-picker${compact ? " agent-scope-picker-compact" : ""}`} ref={rootRef}>
      <button type="button" className="agent-scope-trigger" onClick={togglePanel} title="选择适用 Agent（点击展开，确认后生效）">
        <span className="agent-scope-title">{label ?? "适用 Agent"}</span>
        {selectedLabels.length > 0
          ? <span className="agent-scope-tags">{summaryIds.map(id => {
              const option = options.find(item => item.id === id);
              return option ? <span key={id} className={`badge ${option.color}`}>{option.label}</span> : null;
            })}{compact && selectedLabels.length > 2 ? <span className="agent-scope-more">+{selectedLabels.length - 2}</span> : null}</span>
          : <span className="agent-scope-empty">未选择</span>}
        <span className={`agent-scope-caret ${caretColor}`} aria-hidden="true">▾</span>
      </button>
      {open && panelPos ? createPortal(
        <div
          ref={panelRef}
          className="agent-scope-panel"
          style={{position: "fixed", top: panelPos.top, left: panelPos.left, width: panelPos.width, height: panelPos.height, overflowY: "auto"}}
        >
          <div className="agent-scope-panel-head">
            <div className="agent-scope-panel-title">适用 Agent（共 {active.length} 个）</div>
            <button type="button" className="agent-scope-all" onClick={selectAll}>全选</button>
          </div>
          {options.map(option => {
            const selected = draft.includes(option.id);
            return (
              <div
                key={option.id}
                className={[
                  "agent-scope-opt",
                  selected && !option.disabled ? `selected${option.color ? ` ${option.color}` : ""}` : "",
                  option.disabled ? "disabled" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => { if (!option.disabled) toggle(option.id); }}
                role="option"
                aria-selected={selected}
              >
                <span className="agent-scope-dot" />
                {option.label}
                {selected ? <span className="agent-scope-check">✓</span> : null}
              </div>
            );
          })}
          <div className="agent-scope-footer">
            <button
              type="button"
              className={`agent-scope-confirm${dirty ? "" : " disabled"}`}
              disabled={!dirty}
              onClick={confirm}
            >
              确认修改（{draft.length} 个）
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}