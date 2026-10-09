import {
  ALL_CATEGORIES,
  preflightFullExport,
  renderExportConversationDownload,
  type ConversationCategory,
  type ExportConversationDownloadFormat,
  type ExportFilters,
} from "@/lib/export-conversation";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  assertRawStreamRequest,
  rawStreamGatewayErrorResponse,
  RawStreamGatewayError,
} from "@/lib/raw-stream-gateway";
import {
  acquireExplicitRawLease,
  type ExplicitRawLease,
} from "@/lib/explicit-raw-lease";
import { parseExportBodySide } from "@/lib/export-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_EXPORT_EXCHANGE_LIMIT = 5;
const STEP_EXPORT_EXCHANGE_LIMIT = 2;
const HARD_EXPORT_EXCHANGE_LIMIT = 100;
const DEFAULT_EXPORT_PAGE_MAX_BYTES = 32 * 1024 * 1024;
const HARD_EXPORT_PAGE_MAX_BYTES = 128 * 1024 * 1024;

export async function GET(request: Request) {
  try {
    assertRawStreamRequest(request);
  } catch (error) {
    return rawStreamGatewayErrorResponse(error);
  }
  const url = new URL(request.url);
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam === "step" ? "step" : scopeParam === "upto" ? "upto" : "all";
  const format = parseFormat(url.searchParams.get("format"));
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
    }, { status: 400, headers: safeDownloadHeaders() });
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
  const dependencies = { db };
  const preflight = await preflightFullExport(dataDir, filters, dependencies);
  if (!preflight.ok) {
    return Response.json({
      error: preflight.reason === "range_required"
        ? "完整导出必须选择 Session、Thread、Turn 或 Step 范围。"
        : "完整导出读取预算不足，请缩小范围或提高单页读取预算后重试。",
      preflight,
      page: preflight.blockedPage,
    }, {
      status: preflight.reason === "range_required" ? 400 : 413,
      headers: safeDownloadHeaders(),
    });
  }
  if (parseBoolean(url.searchParams.get("preflight"))) {
    return Response.json({ preflight }, { headers: safeDownloadHeaders() });
  }
  const lease = acquireExplicitRawLease();
  if (!lease) {
    return rawStreamGatewayErrorResponse(new RawStreamGatewayError(
      "raw_stream_busy",
      429,
      "完整 Raw 流并发已达上限，请稍后重试。",
    ));
  }
  const filename = `conversation-${safeFilename(filters.step || filters.turn || filters.thread || filters.session || "export")}.${format === "markdown" ? "md" : format}`;
  try {
    return new Response(streamText(renderExportConversationDownload(
      dataDir,
      filters,
      format,
      preflight,
      dependencies,
    ), lease), {
      headers: {
        ...Object.fromEntries(safeDownloadHeaders()),
        "Content-Type": contentType(format),
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    lease.release();
    throw error;
  }
}

function safeDownloadHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}

function streamText(
  chunks: AsyncIterable<string>,
  lease: ExplicitRawLease,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          lease.release();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        lease.release();
        controller.error(error);
      }
    },
    async cancel() {
      try {
        await iterator.return?.();
      } finally {
        lease.release();
      }
    },
  });
}

function parseFormat(value: string | null): ExportConversationDownloadFormat {
  if (value === "jsonl" || value === "json") return value;
  return "markdown";
}

function contentType(format: ExportConversationDownloadFormat): string {
  if (format === "jsonl") return "application/x-ndjson; charset=utf-8";
  if (format === "json") return "application/json; charset=utf-8";
  return "text/markdown; charset=utf-8";
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

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
}
