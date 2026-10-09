/**
 * 交互内容列表行（2026-09-17 用户确认的「DSH 式无限加载」数据源）。
 *
 * 设计目标：列表滚动**零 raw 读取**。行的可读摘要完全来自 SQLite 已物化的
 * `exchange_content_previews.overviewCandidates`（Worker 派生时按类别优先级保留的
 * 代表项，≤1600 字符文本前缀），配合 raw_exchange_refs 的元数据即可。
 *
 * 具体步骤的正文（本步新增 / 完整上下文）由用户展开该行时才按 step 精确流式加载，
 * 用完即释放——这正是「按需增量获取、及时释放」的落点。
 */
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { ExportExchangeRef } from "./db/export-queries";
import type { AuxiliaryKind } from "./export-conversation";
import { auxiliaryKindFromEndpoint } from "./export-conversation";

export interface ExportListRow {
  exchangeId: string;
  agentStepId?: string;
  capturedAt: string;
  threadId: string;
  turnId?: string;
  agentSessionId: string;
  targetId: string;
  targetName: string;
  agentName: string;
  model?: string;
  httpStatus?: number;
  durationMs?: number;
  isAuxiliary: boolean;
  auxiliaryKind?: AuxiliaryKind;
  /** 请求侧代表摘要（优先真实用户输入 → Agent 注入 → 工具结果）。 */
  requestSummary?: string;
  /** 响应侧代表摘要（优先 assistant 文本 → 工具调用 → 思考）。 */
  responseSummary?: string;
  /**
   * 排重状态：compared=已与上一条请求比对；not_applicable=本线程首步（无基线）；
   * unconfirmed=派生期无法确认（展开该步时会回退 raw 基线比对）；deferred=列表模式
   * 未解析基线（展开时按需解析）。
   */
  dedupeState: "compared" | "not_applicable" | "unconfirmed" | "deferred";
  /** 摘要来自受限/缺失投影时为 true，UI 必须显示「摘要不可用」而不是空白。 */
  summaryLimited: boolean;
  /** 正文可用性（raw 已清理时展开会失败，列表先如实标注）。 */
  rawAvailable: boolean;
  degraded?: "skeleton_missing" | "skeleton_borrowed" | "parts_incomplete";
}

/** 列表摘要文本上限（行内单行展示，超长在 UI 侧省略）。 */
const LIST_SUMMARY_MAX_CHARS = 320;

const REQUEST_SUMMARY_PRIORITY = [
  "user_real",
  "user_injected",
  "tool_result",
  "developer",
  "system",
  "control",
  "unknown_input",
] as const;

const RESPONSE_SUMMARY_PRIORITY = [
  "assistant",
  "tool_use",
  "reasoning",
  "refusal",
  "control",
  "unknown_output",
] as const;

interface OverviewCandidateRow {
  side?: string;
  semanticCategory?: string;
  conversationCategory?: string;
  textPreview?: string;
  toolName?: string;
  mediaDescriptorOrdinals?: number[];
}

/**
 * 批量读取列表行：一次 SQLite 查询取一页（≤100 条）的元数据 + 预览 JSON。
 * 预览 JSON 单条上限 48KiB，逐条 JSON.parse；只取代表项，绝不水合 raw。
 */
export function loadExportListRows(
  db: DeepaaDatabase,
  refs: readonly ExportExchangeRef[],
  options: {requestDedupeStates: ReadonlyMap<string, string>; deferred: boolean},
): ExportListRow[] {
  if (refs.length === 0) return [];
  void options;
  const placeholders = refs.map(() => "?").join(",");
  const previewRows = db.prepare(
    `SELECT exchange_id, preview_json FROM exchange_content_previews
     WHERE exchange_id IN (${placeholders})`,
  ).all(...refs.map(ref => ref.exchangeId)) as Array<{
    exchange_id: string;
    preview_json: string;
  }>;
  const previewByExchange = new Map(previewRows.map(row => [row.exchange_id, row]));
  return refs.map(ref => {
    const preview = previewByExchange.get(ref.exchangeId);
    const candidates = preview ? parseOverviewCandidates(preview.preview_json) : undefined;
    // 只有「投影缺失/不可用/解析失败」才算摘要不可用；limited 表示派生期按预算
    // 保留了代表项（仍有可用摘要），不能因此对整行显示「摘要不可用」。
    const summaryLimited = preview === undefined
      || ref.previewState === "unavailable"
      || ref.previewState === "not_materialized"
      || candidates === undefined;
    const requestSummary = pickSummary(candidates, REQUEST_SUMMARY_PRIORITY, "request");
    const responseSummary = pickSummary(candidates, RESPONSE_SUMMARY_PRIORITY, "response");
    const persistedDedupe = options.requestDedupeStates.get(ref.exchangeId);
    const degraded = degradedFromDiagnostics(ref.captureDiagnosticCodes);
    return {
      exchangeId: ref.exchangeId,
      ...(ref.agentStepId !== undefined ? {agentStepId: ref.agentStepId} : {}),
      capturedAt: ref.capturedAt,
      threadId: ref.agentThreadId,
      ...(ref.agentTurnId !== undefined ? {turnId: ref.agentTurnId} : {}),
      agentSessionId: ref.agentSessionId,
      targetId: ref.targetId,
      targetName: ref.targetName,
      agentName: ref.agentName,
      ...(ref.model !== undefined ? {model: ref.model} : {}),
      ...(ref.httpStatus !== undefined ? {httpStatus: ref.httpStatus} : {}),
      ...(durationMsOf(ref) !== undefined ? {durationMs: durationMsOf(ref)!} : {}),
      isAuxiliary: ref.isAuxiliary,
      ...(ref.isAuxiliary && preview
        ? {auxiliaryKind: auxiliaryKindFromEndpoint(endpointKindOf(preview.preview_json))}
        : {}),
      ...(requestSummary !== undefined ? {requestSummary} : {}),
      ...(responseSummary !== undefined ? {responseSummary} : {}),
      dedupeState: persistedDedupe === "compared"
        ? "compared"
        : persistedDedupe === "not_required" || persistedDedupe === "not_applicable"
          ? "not_applicable"
          : persistedDedupe === "unconfirmed"
            ? "unconfirmed"
            : options.deferred ? "deferred" : "unconfirmed",
      summaryLimited,
      rawAvailable: ref.rawState === "active",
      ...(degraded !== undefined ? {degraded} : {}),
    };
  });
}

function durationMsOf(ref: ExportExchangeRef): number | undefined {
  if (ref.completedAt === undefined) return undefined;
  const completed = Date.parse(ref.completedAt);
  const captured = Date.parse(ref.capturedAt);
  if (!Number.isFinite(completed) || !Number.isFinite(captured)) return undefined;
  const delta = completed - captured;
  return delta >= 0 ? delta : undefined;
}

function degradedFromDiagnostics(
  codes: readonly string[],
): ExportListRow["degraded"] {
  if (codes.includes("assistant_parts_incomplete")) return "parts_incomplete";
  if (codes.includes("request_skeleton_missing")) return "skeleton_missing";
  if (codes.includes("request_skeleton_borrowed")) return "skeleton_borrowed";
  return undefined;
}

/** 预览 JSON 解析失败视为摘要不可用（不放大错误，也不回退 raw）。 */
function parseOverviewCandidates(previewJson: string): OverviewCandidateRow[] | undefined {
  try {
    const parsed = JSON.parse(previewJson) as {overviewCandidates?: unknown};
    if (!Array.isArray(parsed.overviewCandidates)) return [];
    return parsed.overviewCandidates
      .filter((item): item is OverviewCandidateRow =>
        typeof item === "object" && item !== null)
      .slice(0, 16);
  } catch {
    return undefined;
  }
}

function endpointKindOf(previewJson: string): string | undefined {
  try {
    const parsed = JSON.parse(previewJson) as {endpointKind?: unknown};
    return typeof parsed.endpointKind === "string" ? parsed.endpointKind : undefined;
  } catch {
    return undefined;
  }
}

function pickSummary(
  candidates: OverviewCandidateRow[] | undefined,
  priority: readonly string[],
  side: "request" | "response",
): string | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  for (const category of priority) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index]!;
      // side 缺失（旧格式投影）时不作排除，按类别优先级兜底。
      if (candidate.side !== undefined && candidate.side !== side) continue;
      const candidateCategory = candidate.conversationCategory ?? candidate.semanticCategory;
      if (candidateCategory !== category) continue;
      const text = (candidate.textPreview ?? "").replace(/\s+/gu, " ").trim();
      const tool = candidate.toolName ? `[${candidate.toolName}] ` : "";
      const media = (candidate.mediaDescriptorOrdinals?.length ?? 0) > 0 ? "[图片] " : "";
      const composed = `${tool}${media}${text}`.trim();
      if (composed.length === 0) continue;
      return composed.length > LIST_SUMMARY_MAX_CHARS
        ? `${composed.slice(0, LIST_SUMMARY_MAX_CHARS)}…`
        : composed;
    }
  }
  return undefined;
}
