import {
  ALL_CATEGORIES,
  type ConversationCategory,
  type ExportFilters,
} from "@/lib/export-conversation";
import {
  ExportContentStreamError,
  iterateExportContentEvents,
  type ExportContentEvent,
} from "@/lib/export-content-events";
import { planExportContentPage } from "@/lib/export-page-plan";
import { parseExportBodySide } from "@/lib/export-query";
import {
  acquireExplicitRawLease,
  type ExplicitRawLease,
} from "@/lib/explicit-raw-lease";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  assertRawStreamRequest,
  rawStreamGatewayErrorResponse,
  RawStreamGatewayError,
} from "@/lib/raw-stream-gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_EXCHANGE_LIMIT = 5;
const HARD_EXCHANGE_LIMIT = 100;
const DEFAULT_PAGE_MAX_BYTES = 32 * 1024 * 1024;
const HARD_PAGE_MAX_BYTES = 128 * 1024 * 1024;

export async function GET(request: Request): Promise<Response> {
  try {
    assertRawStreamRequest(request);
  } catch (error) {
    return rawStreamGatewayErrorResponse(error);
  }
  const url = new URL(request.url);
  let confirmedOversizedExchangeId: string | undefined;
  try {
    confirmedOversizedExchangeId = parseConfirmedOversizedExchangeId(url);
  } catch (error) {
    return rawStreamGatewayErrorResponse(error);
  }
  let parsedFilters: ExportFilters;
  try {
    parsedFilters = parseFilters(url);
  } catch (error) {
    return Response.json({
      error: {
        code: "invalid_export_side",
        message: error instanceof Error ? error.message : "交互内容方向无效。",
      },
    }, { status: 400, headers: contentHeaders() });
  }
  const filters = confirmedOversizedExchangeId
    ? {
        ...parsedFilters,
        exchangeLimit: 1,
        pageMaxBytes: HARD_PAGE_MAX_BYTES,
      }
    : parsedFilters;
  if (
    filters.summaryOnly !== true
    && !filters.exchangeId
    && !filters.session
    && !filters.thread
    && !filters.turn
    && !filters.step
  ) {
    return contentErrorResponse(
      new RawStreamGatewayError(
        "export_range_required",
        400,
        "完整交互内容必须选择 Session、Thread、Turn 或 Step 范围。",
      ),
    );
  }
  const dataDir = resolveDeepaaDataDir();
  const db = getDeepaaDatabase(dataDir);
  const plan = planExportContentPage(db, filters);
  if (confirmedOversizedExchangeId) {
    const plannedExchangeId = plan.blocked?.exchangeId ?? plan.visibleRefs[0]?.exchangeId;
    if (plannedExchangeId !== confirmedOversizedExchangeId) {
      return rawStreamGatewayErrorResponse(new RawStreamGatewayError(
        "oversized_exchange_changed",
        409,
        "待确认的超大 Exchange 已不在当前页首位，请刷新后重试。",
      ));
    }
  }
  if (plan.blocked) {
    return contentErrorResponse(new ExportContentStreamError(
      plan.blocked.code,
      `Exchange ${plan.blocked.exchangeId} 需要 ${plan.blocked.requiredBytes} 字节。`,
      plan.blocked.exchangeId,
      plan.blocked.requiredBytes,
    ));
  }
  // summaryOnly 列表只读 SQLite 物化摘要、零 raw 字节：不占 raw 流并发额度，
  // 否则列表首屏/StrictMode 双发会与真正的正文读取互相 429（2026-09-21）。
  const lease = filters.summaryOnly === true
    ? { release: () => {} }
    : acquireExplicitRawLease();
  if (!lease) {
    return rawStreamGatewayErrorResponse(new RawStreamGatewayError(
      "raw_stream_busy",
      429,
      "完整 Raw 流并发已达上限，请稍后重试。",
    ));
  }
  const iterator = iterateExportContentEvents({
    db,
    dataDir,
    filters,
    signal: request.signal,
  })[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    return new Response(ndjsonStream(iterator, first, lease, request.signal), {
      headers: contentHeaders(),
    });
  } catch (error) {
    lease.release();
    await iterator.return?.(undefined).catch(() => undefined);
    return contentErrorResponse(error);
  }
}

function ndjsonStream(
  iterator: AsyncIterator<ExportContentEvent>,
  first: IteratorResult<ExportContentEvent>,
  lease: ExplicitRawLease,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pending = first.done ? undefined : first.value;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    try {
      await iterator.return?.(undefined);
    } finally {
      lease.release();
    }
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) {
          await close();
          controller.close();
          return;
        }
        const next = pending === undefined
          ? await iterator.next()
          : { done: false as const, value: pending };
        pending = undefined;
        if (next.done) {
          await close();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });
}

function parseFilters(url: URL): ExportFilters {
  const scopeValue = url.searchParams.get("scope");
  const scope = scopeValue === "step" ? "step" : scopeValue === "upto" ? "upto" : "all";
  const categoriesParam = url.searchParams.get("categories");
  const categories = categoriesParam
    ? categoriesParam.split(",").filter((category): category is ConversationCategory =>
        ALL_CATEGORIES.includes(category as ConversationCategory))
    : [];
  const side = parseExportBodySide(url.searchParams.get("side"));
  return {
    target: splitList(url.searchParams.get("target")),
    agent: splitList(url.searchParams.get("agent")),
    session: url.searchParams.get("session") || undefined,
    thread: url.searchParams.get("thread") || undefined,
    turn: url.searchParams.get("turn") || undefined,
    step: url.searchParams.get("step") || undefined,
    exchangeId: url.searchParams.get("exchange") || undefined,
    start: url.searchParams.get("start") || undefined,
    end: url.searchParams.get("end") || undefined,
    scope,
    side,
    categories,
    categoriesExplicit: url.searchParams.has("categories"),
    cursor: url.searchParams.get("cursor") || undefined,
    direction: url.searchParams.get("direction") === "newer" ? "newer" : "older",
    page: boundedPage(url.searchParams.get("page")),
    exchangeLimit: boundedInteger(
      url.searchParams.get("exchangeLimit") || url.searchParams.get("maxExchanges"),
      DEFAULT_EXCHANGE_LIMIT,
      HARD_EXCHANGE_LIMIT,
    ),
    pageMaxBytes: boundedInteger(
      url.searchParams.get("pageMaxBytes") || url.searchParams.get("maxBytes"),
      DEFAULT_PAGE_MAX_BYTES,
      HARD_PAGE_MAX_BYTES,
    ),
    includeInherited: parseBoolean(url.searchParams.get("includeInherited")),
    includeInheritedExplicit: url.searchParams.has("includeInherited"),
    summaryOnly: parseBoolean(url.searchParams.get("summaryOnly")),
    skipCandidateCount: parseBoolean(url.searchParams.get("skipCandidateCount")),
    deferBaseline: parseBoolean(url.searchParams.get("deferBaseline")),
  };
}

function boundedPage(value: string | null): number {
  if (!value) return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

function parseConfirmedOversizedExchangeId(url: URL): string | undefined {
  const raw = url.searchParams.get("confirmedOversizedExchangeId");
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!value || value.length > 512) {
    throw new RawStreamGatewayError(
      "invalid_confirmed_exchange",
      400,
      "确认加载的 Exchange ID 无效。",
    );
  }
  return value;
}

function contentErrorResponse(error: unknown): Response {
  if (error instanceof ExportContentStreamError) {
    const status = error.code === "oversized_visible_exchange" ? 413 : 409;
    return Response.json({
      error: {
        code: error.code,
        message: error.message,
        exchangeId: error.exchangeId,
        requiredBytes: error.requiredBytes,
      },
    }, { status, headers: contentHeaders() });
  }
  return rawStreamGatewayErrorResponse(error);
}

function contentHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}

function splitList(value: string | null): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return items.length > 0 ? items : undefined;
}

function parseBoolean(value: string | null): boolean {
  return value === "true" || value === "1";
}

function boundedInteger(value: string | null, fallback: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), maximum);
}
