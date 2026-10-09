"use client";

import {ChevronDown, ChevronRight} from "lucide-react";
import {useMemo, useState} from "react";
import {buildGatewayModelId} from "@/proxy/gateway-prefix";
import type {ProxyTarget} from "@/types";

/**
 * 单个模型的 Codex catalog 预览编辑器。
 *
 * 独立组件以隔离 textarea 编辑状态，避免每次输入触发父页面全量重渲染。
 * 编辑期间不做任何 JSON 解析，仅在点击保存时校验。
 */

interface CatalogPreviewEditorProps {
  target: ProxyTarget;
  modelId: string;
  template: {defaults: Record<string, unknown>; models: Record<string, Record<string, unknown>>};
  overrides: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
  onSaveOverrides: (modelId: string, overrides: Record<string, unknown>) => Promise<void>;
}

export function CatalogPreviewEditor({
  target,
  modelId,
  template,
  overrides,
  expanded,
  onToggle,
  onSaveOverrides,
}: CatalogPreviewEditorProps) {
  // 默认 JSON：仅在 template/overrides/target/modelId 变化时重新计算
  const defaultJson = useMemo(() => {
    try {
      const merged: Record<string, unknown> = {
        ...(template.defaults || {}),
        ...(template.models?.[modelId] || {}),
        ...(overrides[modelId] || {}),
        slug: buildGatewayModelId(target.id, modelId),
        display_name: `${target.name} · ${modelId}`,
        description: `DeepAA 网关模型：${target.id} / ${modelId}`,
      };
      return JSON.stringify(merged, null, 2);
    } catch {
      return "{}";
    }
  }, [target.id, target.name, modelId, template, overrides]);

  // 编辑草稿：用户开始编辑后使用草稿，未编辑时使用默认值
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const currentJson = draft ?? defaultJson;

  function handleSave() {
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(currentJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("JSON 必须是对象");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "JSON 格式错误");
      return;
    }
    setSaving(true);
    onSaveOverrides(modelId, parsed)
      .then(() => {
        setDraft(null);
        setSavedFlash(true);
        onToggle();
        window.setTimeout(() => setSavedFlash(false), 2600);
      })
      .catch(e => { setError(e instanceof Error ? e.message : "保存失败"); })
      .finally(() => { setSaving(false); });
  }

  return (
    <div className="catalog-preview-model">
      <button type="button" className="catalog-preview-toggle" onClick={onToggle}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{modelId}</span>
        {savedFlash ? <span className="catalog-preview-saved">已保存</span> : null}
      </button>
      {expanded ? (
        <>
          <textarea
            className="catalog-preview-editor"
            value={currentJson}
            rows={20}
            onChange={e => setDraft(e.currentTarget.value)}
            spellCheck={false}
          />
          {error ? <p className="field-error">{error}</p> : null}
          <button
            type="button"
            className="primary-button compact-button"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "保存中..." : "保存 Catalog 覆盖"}
          </button>
        </>
      ) : null}
    </div>
  );
}
