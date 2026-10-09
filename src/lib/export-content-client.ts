import type { ConversationItem } from "./export-conversation";
import type {
  ExportContentCompleteness,
  ExportContentEvent,
} from "./export-content-events";

const MAX_NDJSON_LINE_CHARACTERS = 256 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export type ExportContentMediaDescriptor = Omit<
  Extract<ExportContentEvent, { type: "media_descriptor" }>,
  "type" | "exchangeId" | "itemOrdinal"
>;

export interface ExportContentItem extends ConversationItem {
  jsonPath: string;
  itemOrdinal: number;
  logicalId?: string;
  mediaDescriptors: ExportContentMediaDescriptor[];
}

type ExchangeStart = Extract<ExportContentEvent, { type: "exchange_start" }>;
type ExchangeError = Extract<ExportContentEvent, { type: "exchange_error" }>;

export interface ExportContentExchange extends Omit<ExchangeStart, "type"> {
  hiddenInheritedInputCount: number;
  contentError?: ExchangeError;
}

export interface ExportContentExchangeGroup {
  exchange: ExportContentExchange;
  items: ExportContentItem[];
}

/** 列表行（summaryOnly 模式）：只含 SQLite 物化摘要，不含任何 raw 正文。 */
export type ExportListRow = Extract<ExportContentEvent, { type: "exchange_summary" }>;

export interface ExportListPageResult {
  rows: ExportListRow[];
  /** page_start 载荷（含 hasMore/nextCursor 与可观测计数）。 */
  page: Omit<Extract<ExportContentEvent, { type: "page_start" }>, "type">;
  contentCompleteness: ExportContentCompleteness;
}

export interface ExportContentPageResult {
  exchanges: ExportContentExchange[];
  items: ExportContentItem[];
  /** 未统计候选总数时缺省（列表滚动非首屏）；UI 必须显示「未统计」。 */
  candidateCount?: number;
  processedCount: number;
  contentCompleteness: ExportContentCompleteness;
  dedupeStatusByThread: Extract<
    ExportContentEvent,
    { type: "page_start" }
  >["dedupeStatusByThread"];
  dedupeDetailsByThread: Extract<
    ExportContentEvent,
    { type: "page_start" }
  >["dedupeDetailsByThread"];
  exchangeErrors: Array<Extract<ExportContentEvent, { type: "exchange_error" }>>;
  page: Omit<Extract<ExportContentEvent, { type: "page_start" }>, "type">;
}

export interface StreamExportContentPageOptions {
  includeInherited: boolean;
  signal?: AbortSignal;
}

export class ExportContentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly exchangeId?: string,
    readonly requiredBytes?: number,
  ) {
    super(message);
    this.name = "ExportContentRequestError";
  }
}

/**
 * 列表行分页流（summaryOnly）：零 raw 读取，行内只含摘要与状态。
 * 具体步骤正文由用户展开时再按 step 精确加载（见 streamExportContentPage）。
 */
export async function streamExportListPage(
  response: Response,
  options: {signal?: AbortSignal} = {},
): Promise<ExportListPageResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("列表行响应缺少正文流。");
  const decoder = new TextDecoder();
  const rows: ExportListRow[] = [];
  let pageStart: Extract<ExportContentEvent, {type: "page_start"}> | undefined;
  let completeness: ExportContentCompleteness = "complete";
  let buffer = "";
  const consumeLine = (line: string): void => {
    if (!line.trim()) return;
    const event = parseExportContentEvent(line);
    if (event.type === "page_start") {
      pageStart = event;
      return;
    }
    if (event.type === "exchange_summary") {
      rows.push(event);
      return;
    }
    if (event.type === "page_end") {
      completeness = event.contentCompleteness;
    }
  };
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, {once: true});
  let completed = false;
  try {
    for (;;) {
      throwIfAborted(options.signal);
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, {stream: true});
      assertLineBufferWithinLimit(buffer);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    assertLineBufferWithinLimit(buffer);
    if (buffer.trim()) consumeLine(buffer);
    completed = true;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  throwIfAborted(options.signal);
  if (!pageStart) throw new Error("列表行流缺少 page_start 事件。");
  return {
    rows,
    page: stripPageStartType(pageStart),
    contentCompleteness: completeness,
  };
}

/** 图片正文只允许通过服务端精确索引入口读取，客户端不传文件路径或 hash。 */
export function buildRawMediaHref(
  exchangeId: string,
  bodySide: "request" | "response",
  ordinal: number,
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 256) {
    throw new RangeError("图片媒体 ordinal 无效。");
  }
  return `/api/exchanges/${encodeURIComponent(exchangeId)}/media/${bodySide}/${ordinal}`;
}

/** 错误响应固定有界读取，保留超预算确认所需的稳定结构。 */
export async function readExportContentError(response: Response): Promise<ExportContentRequestError> {
  const fallback = new ExportContentRequestError(
    response.status,
    `http_${response.status}`,
    `HTTP ${response.status}`,
  );
  if (!response.body) return fallback;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytesRead += next.value.byteLength;
      if (bytesRead > MAX_ERROR_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fallback;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const payload = JSON.parse(text) as unknown;
    if (!isRecord(payload) || !isRecord(payload.error)) return fallback;
    const error = payload.error;
    const code = safeErrorText(error.code, 128) ?? fallback.code;
    const message = safeErrorText(error.message, 2_048) ?? fallback.message;
    const exchangeId = safeErrorText(error.exchangeId, 512);
    const requiredBytes = Number.isSafeInteger(error.requiredBytes) && Number(error.requiredBytes) >= 0
      ? Number(error.requiredBytes)
      : undefined;
    return new ExportContentRequestError(
      response.status,
      code,
      message,
      exchangeId,
      requiredBytes,
    );
  } catch {
    return fallback;
  } finally {
    reader.releaseLock();
  }
}

interface ActiveItem {
  start: Extract<ExportContentEvent, { type: "item_start" }>;
  chunks: string[];
  mediaDescriptors: ExportContentMediaDescriptor[];
}

type PageStart = Extract<ExportContentEvent, { type: "page_start" }>;

/**
 * 增量消费当前页 NDJSON。函数只保留当前页最终项目，不缓存历史页或完整 Raw。
 */
export async function streamExportContentPage(
  response: Response,
  options: StreamExportContentPageOptions,
): Promise<ExportContentPageResult> {
  throwIfAborted(options.signal);
  if (!response.body) throw new Error("交互内容响应缺少可读流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const exchanges = new Map<string, ExchangeStart>();
  const hiddenInheritedInputCounts = new Map<string, number>();
  const activeItems = new Map<string, ActiveItem>();
  const activeKeysByOrdinal = new Map<string, string>();
  const items: ExportContentItem[] = [];
  const exchangeErrors: ExportContentPageResult["exchangeErrors"] = [];
  let pageStart: PageStart | undefined;
  let pageCompleteness: ExportContentCompleteness = "partial";
  let buffer = "";
  let completed = false;

  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const consumeLine = (line: string): void => {
    if (!line.trim()) return;
    const event = parseExportContentEvent(line);
    if (event.type === "page_start") {
      pageStart = event;
      return;
    }
    if (event.type === "exchange_start") {
      exchanges.set(event.exchangeId, event);
      return;
    }
    if (event.type === "item_start") {
      const key = itemKey(event.exchangeId, event.itemOrdinal, event.logicalId);
      activeItems.set(key, {
        start: event,
        chunks: [],
        mediaDescriptors: [],
      });
      activeKeysByOrdinal.set(ordinalKey(event.exchangeId, event.itemOrdinal), key);
      return;
    }
    if (event.type === "text_chunk") {
      activeItems.get(activeKeysByOrdinal.get(ordinalKey(event.exchangeId, event.itemOrdinal)) ?? "")
        ?.chunks.push(event.value);
      return;
    }
    if (event.type === "media_descriptor") {
      const active = activeItems.get(
        activeKeysByOrdinal.get(ordinalKey(event.exchangeId, event.itemOrdinal)) ?? "",
      );
      if (!active) return;
      const descriptor: ExportContentMediaDescriptor = {
        bodySide: event.bodySide,
        ordinal: event.ordinal,
        jsonPath: event.jsonPath,
        mediaType: event.mediaType,
        encodedBytes: event.encodedBytes,
        decodedBytes: event.decodedBytes,
        sha256: event.sha256,
        sourceStorage: event.sourceStorage,
      };
      active.mediaDescriptors.push(descriptor);
      return;
    }
    if (event.type === "exchange_end") {
      // 服务端 includeInherited=false 时不再下发继承正文，只回计数。
      if (event.hiddenInheritedInputCount !== undefined) {
        hiddenInheritedInputCounts.set(event.exchangeId, event.hiddenInheritedInputCount);
      }
      return;
    }
    if (event.type === "item_end") {
      const ordinal = ordinalKey(event.exchangeId, event.itemOrdinal);
      const key = activeKeysByOrdinal.get(ordinal)
        ?? itemKey(event.exchangeId, event.itemOrdinal);
      const active = activeItems.get(key);
      activeItems.delete(key);
      activeKeysByOrdinal.delete(ordinal);
      if (!active) return;
      if (!options.includeInherited && event.stepDiff === "inherited") {
        if (active.start.side === "input") {
          hiddenInheritedInputCounts.set(
            event.exchangeId,
            (hiddenInheritedInputCounts.get(event.exchangeId) ?? 0) + 1,
          );
        }
        return;
      }
      const exchange = exchanges.get(event.exchangeId);
      if (!exchange) throw new Error(`正文项目缺少 Exchange 元数据：${event.exchangeId}`);
      items.push({
        category: active.start.category,
        side: active.start.side,
        text: active.chunks.join(""),
        toolName: active.start.toolName,
        toolUseId: active.start.toolUseId,
        stepDiff: event.stepDiff,
        exchangeId: event.exchangeId,
        turnId: exchange.turnId,
        threadId: exchange.threadId,
        agentSessionId: exchange.agentSessionId,
        capturedAt: exchange.capturedAt,
        model: exchange.model,
        targetId: exchange.targetId,
        targetName: exchange.targetName,
        isAuxiliary: exchange.isAuxiliary,
        auxiliaryKind: exchange.auxiliaryKind,
        agentProtocol: exchange.agentProtocol,
        contentSource: "raw_stream",
        textSha256: event.textSha256,
        originalTextBytes: event.originalTextBytes,
        previewTextBytes: event.originalTextBytes,
        truncated: false,
        mediaDescriptorOrdinals: active.mediaDescriptors.map((item) => item.ordinal),
        jsonPath: active.start.jsonPath,
        itemOrdinal: event.itemOrdinal,
        logicalId: active.start.logicalId,
        mediaDescriptors: active.mediaDescriptors,
      });
      return;
    }
    if (event.type === "exchange_error") {
      exchangeErrors.push(event);
      for (const key of activeItems.keys()) {
        if (key.startsWith(`${event.exchangeId}:`)) activeItems.delete(key);
      }
      for (const key of activeKeysByOrdinal.keys()) {
        if (key.startsWith(`${event.exchangeId}:`)) activeKeysByOrdinal.delete(key);
      }
      return;
    }
    if (event.type === "page_end") {
      pageCompleteness = event.contentCompleteness;
    }
  };

  try {
    for (;;) {
      throwIfAborted(options.signal);
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      assertLineBufferWithinLimit(buffer);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    assertLineBufferWithinLimit(buffer);
    if (buffer.trim()) consumeLine(buffer);
    completed = true;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  throwIfAborted(options.signal);
  if (!pageStart) throw new Error("交互内容流缺少 page_start 事件。");
  if (activeItems.size > 0) throw new Error("交互内容流存在未完成正文项目。");
  const logicalItems = mergeLogicalConversationItems(items);
  logicalItems.sort((left, right) => {
    const time = right.capturedAt.localeCompare(left.capturedAt);
    if (time !== 0) return time;
    const exchange = right.exchangeId.localeCompare(left.exchangeId);
    return exchange !== 0 ? exchange : right.itemOrdinal - left.itemOrdinal;
  });
  const exchangeErrorById = new Map(
    exchangeErrors.map(error => [error.exchangeId, error]),
  );
  const visibleExchanges = pageStart.visibleExchangeIds.map(exchangeId => {
    const event = exchanges.get(exchangeId);
    if (!event) {
      throw new Error(`交互内容流缺少 Exchange 元数据：${exchangeId}`);
    }
    const { type: _type, ...exchange } = event;
    return {
      ...exchange,
      hiddenInheritedInputCount: hiddenInheritedInputCounts.get(exchangeId) ?? 0,
      contentError: exchangeErrorById.get(exchangeId),
    };
  });
  return {
    exchanges: visibleExchanges,
    items: logicalItems,
    candidateCount: pageStart.candidateCount,
    processedCount: pageStart.processedCount,
    contentCompleteness: pageCompleteness,
    dedupeStatusByThread: pageStart.dedupeStatusByThread,
    dedupeDetailsByThread: pageStart.dedupeDetailsByThread,
    exchangeErrors,
    page: stripPageStartType(pageStart),
  };
}

/** 以服务端选中的 Exchange 为主结构关联正文，空正文不会丢失 Step。 */
export function groupExportContentExchanges(
  exchanges: ExportContentExchange[],
  items: ExportContentItem[],
): ExportContentExchangeGroup[] {
  const itemsByExchange = new Map<string, ExportContentItem[]>();
  for (const item of items) {
    const exchangeItems = itemsByExchange.get(item.exchangeId) ?? [];
    exchangeItems.push(item);
    itemsByExchange.set(item.exchangeId, exchangeItems);
  }
  return exchanges.map(exchange => ({
    exchange,
    items: itemsByExchange.get(exchange.exchangeId) ?? [],
  }));
}

/**
 * SSE delta 和同一工具调用的 output[] 都是协议分片，不是独立对话项。
 * 这里只合并同一 Exchange 内连续、语义身份一致且已判定为本 Step 新增的片段。
 */
function mergeLogicalConversationItems(items: ExportContentItem[]): ExportContentItem[] {
  const merged: ExportContentItem[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    if (!previous || !sameLogicalConversationItem(previous, item)) {
      merged.push(item);
      continue;
    }
    previous.text += item.text;
    previous.originalTextBytes = (previous.originalTextBytes ?? 0) + (item.originalTextBytes ?? 0);
    previous.previewTextBytes = previous.originalTextBytes;
    previous.textSha256 = undefined;
    previous.mediaDescriptors.push(...item.mediaDescriptors);
    previous.mediaDescriptorOrdinals = previous.mediaDescriptors.map(descriptor => descriptor.ordinal);
  }
  return merged;
}

function sameLogicalConversationItem(left: ExportContentItem, right: ExportContentItem): boolean {
  const sameExchange = left.exchangeId === right.exchangeId;
  const sameIdentity = left.logicalId && right.logicalId
    ? left.logicalId === right.logicalId
    : left.category === right.category
    && left.toolName === right.toolName
    && left.toolUseId === right.toolUseId;
  const mergeableOutput = left.side === "output" && right.side === "output";
  const mergeableToolResult = left.side === "input"
    && right.side === "input"
    && left.category === "tool_result"
    && right.category === "tool_result"
    && !!left.toolUseId;
  return sameExchange
    && sameIdentity
    && (mergeableOutput || mergeableToolResult)
    && left.stepDiff === "unique"
    && right.stepDiff === "unique";
}

function parseExportContentEvent(line: string): ExportContentEvent {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("交互内容事件结构无效。");
  }
  const allowed = new Set<ExportContentEvent["type"]>([
    "page_start",
    "exchange_start",
    "exchange_summary",
    "item_start",
    "text_chunk",
    "media_descriptor",
    "item_end",
    "exchange_end",
    "exchange_error",
    "page_end",
  ]);
  if (!allowed.has(value.type as ExportContentEvent["type"])) {
    throw new Error("交互内容事件类型无效。");
  }
  return value as ExportContentEvent;
}

function stripPageStartType(pageStart: PageStart): ExportContentPageResult["page"] {
  const { type: _type, ...page } = pageStart;
  return page;
}

function ordinalKey(exchangeId: string, ordinal: number): string {
  return `${exchangeId}:${ordinal}`;
}

function itemKey(exchangeId: string, ordinal: number, logicalId?: string): string {
  return `${exchangeId}:${ordinal}:${logicalId ?? ""}`;
}

function assertLineBufferWithinLimit(buffer: string): void {
  if (buffer.length > MAX_NDJSON_LINE_CHARACTERS) {
    throw new Error("NDJSON 事件超过客户端单行读取上限。");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorText(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}
