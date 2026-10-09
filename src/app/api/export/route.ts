import { jsonResponse } from "@/lib/app-state";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import { loadExportConversation, ALL_CATEGORIES, type ConversationCategory, type ExportFilters } from "@/lib/export-conversation";
import { parseExportBodySide } from "@/lib/export-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_EXPORT_EXCHANGE_LIMIT = 5;
const STEP_EXPORT_EXCHANGE_LIMIT = 2;
const HARD_EXPORT_EXCHANGE_LIMIT = 100;
const DEFAULT_EXPORT_PAGE_MAX_BYTES = 32 * 1024 * 1024;
const HARD_EXPORT_PAGE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * 对话流导出 API：按 target/agent/session/turn/step 过滤，scope=all|upto|step，
 * categories 多选筛选（system/developer/user_real/user_injected/tool_result/assistant/tool_use/reasoning）。
 * 返回按时间倒序的 SQLite 有界对话预览；完整内容只由显式下载 Route 流式读取。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam === "step" ? "step" : scopeParam === "upto" ? "upto" : "all";
  const categoriesParam = url.searchParams.get("categories");
  const categories: ConversationCategory[] = categoriesParam
    ? categoriesParam.split(",").filter((c): c is ConversationCategory =>
        ALL_CATEGORIES.includes(c as ConversationCategory))
    : [];
  const categoriesExplicit = url.searchParams.has("categories");
  let side: ExportFilters["side"];
  try {
    side = parseExportBodySide(url.searchParams.get("side"));
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "交互内容方向无效。",
    }, { status: 400 });
  }
  const filters: ExportFilters = {
    target: splitList(url.searchParams.get("target")),
    agent: splitList(url.searchParams.get("agent")),
    session: url.searchParams.get("session") || undefined,
    thread: url.searchParams.get("thread") || undefined,
    turn: url.searchParams.get("turn") || undefined,
    step: url.searchParams.get("step") || undefined,
    start: url.searchParams.get("start") || undefined,
    end: url.searchParams.get("end") || undefined,
    scope,
    side,
    categories,
    categoriesExplicit,
    cursor: url.searchParams.get("cursor") || undefined,
    exchangeLimit: parseExchangeLimit(url.searchParams.get("exchangeLimit") || url.searchParams.get("maxExchanges"), scope),
    pageMaxBytes: parsePageMaxBytes(url.searchParams.get("pageMaxBytes") || url.searchParams.get("maxBytes")),
    includeInherited: parseBoolean(url.searchParams.get("includeInherited")),
  };
  const dataDir = resolveDeepaaDataDir();
  const db = getDeepaaDatabase(dataDir);
  const result = await loadExportConversation(dataDir, filters, { db });
  return jsonResponse(result);
}

function parseBoolean(value: string | null): boolean {
  return value === "true" || value === "1";
}

function parseExchangeLimit(value: string | null, scope: ExportFilters["scope"]): number {
  const fallback = scope === "step" ? STEP_EXPORT_EXCHANGE_LIMIT : DEFAULT_EXPORT_EXCHANGE_LIMIT;
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), HARD_EXPORT_EXCHANGE_LIMIT);
}

function parsePageMaxBytes(value: string | null): number {
  if (!value) return DEFAULT_EXPORT_PAGE_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXPORT_PAGE_MAX_BYTES;
  return Math.min(Math.floor(parsed), HARD_EXPORT_PAGE_MAX_BYTES);
}

function splitList(value: string | null): string[] | undefined {
  const items = value?.split(",").map(item => item.trim()).filter(Boolean) || [];
  return items.length > 0 ? items : undefined;
}
