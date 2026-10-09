/**
 * Harness 证据层：上下文压缩（Compaction）证据检测（P1 校准，2026-09-11）。
 *
 * 三类真实证据（全部经本机抓包验证，绝不猜测格式）：
 * 1. dsh 官方 purpose 头 `x-deepseek-harness-compact`（wire 显式标记压缩请求，零推断）；
 * 2. claude-code / zcode 压缩续接摘要：请求 user 消息以
 *    "This session is being continued from a previous conversation that ran out of context"
 *    开头（真实库 105 处命中，两 Agent 共用）；
 * 3. codex 压缩摘要：请求 user 消息以
 *    "Another language model started to solve this problem" 开头（真实库 425 处命中）。
 *
 * 语义边界：摘要标记匹配限定在消息文本头部（前 200 字符），避免用户引用该句式造成
 * 误报；置信度 high（wire 观测的模板句式，非官方契约）。remote_state_reference
 * （previous_response_id/conversation 正常续写）不算压缩证据，由消费方区分。
 */

export interface CompactionEvidence {
  kind: "purpose_header" | "summary_marker";
  confidence: "exact" | "high";
  /** summary_marker 命中的标记类别，便于 UI 归因（continuation / codex_summary）。 */
  markerKind?: "continuation" | "codex_summary";
  /** 命中片段预览（≤120 字符）。 */
  preview: string;
}

export const DSH_COMPACT_HEADER = "x-deepseek-harness-compact";

export const SUMMARY_MARKERS: Array<{kind: "continuation" | "codex_summary"; text: string}> = [
  {
    kind: "continuation",
    text: "This session is being continued from a previous conversation that ran out of context",
  },
  {
    kind: "codex_summary",
    text: "Another language model started to solve this problem",
  },
];

/** 摘要标记只认消息头部，避免正文引用模板句式造成误报。 */
const MARKER_HEAD_WINDOW = 200;
const PREVIEW_LIMIT = 120;

export function hasDshCompactionHeader(headers: Record<string, string | undefined>): boolean {
  const value = headers[DSH_COMPACT_HEADER];
  return typeof value === "string" && value.trim() !== "" && value !== "0";
}

export function detectCompactionSummaryMarker(texts: string[]): CompactionEvidence | undefined {
  for (const text of texts) {
    if (!text) continue;
    const head = text.length > MARKER_HEAD_WINDOW ? text.slice(0, MARKER_HEAD_WINDOW) : text;
    for (const marker of SUMMARY_MARKERS) {
      const index = head.indexOf(marker.text);
      if (index >= 0) {
        return {
          kind: "summary_marker",
          confidence: "high",
          markerKind: marker.kind,
          preview: previewOf(text, index),
        };
      }
    }
  }
  return undefined;
}

export function detectCompactionEvidence(
  headers: Record<string, string | undefined>,
  inputTexts: string[],
): CompactionEvidence | undefined {
  if (hasDshCompactionHeader(headers)) {
    return {
      kind: "purpose_header",
      confidence: "exact",
      preview: `${DSH_COMPACT_HEADER}: ${headers[DSH_COMPACT_HEADER] ?? ""}`.slice(0, PREVIEW_LIMIT),
    };
  }
  return detectCompactionSummaryMarker(inputTexts);
}

function previewOf(text: string, index: number): string {
  const raw = text.slice(index, index + PREVIEW_LIMIT).replace(/\s+/g, " ").trim();
  return raw.length >= PREVIEW_LIMIT ? `${raw.slice(0, PREVIEW_LIMIT - 1)}…` : raw;
}
