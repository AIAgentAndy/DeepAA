import { describe, expect, test } from "vitest";
import * as exportContentClient from "../src/lib/export-content-client";
import {
  readExportContentError,
  streamExportContentPage,
} from "../src/lib/export-content-client";
import type { ExportContentEvent } from "../src/lib/export-content-events";

describe("交互内容浏览器增量客户端", () => {
  test("图片查看地址只使用精确 Exchange、side 和 ordinal", () => {
    expect("buildRawMediaHref" in exportContentClient).toBe(true);
    const buildRawMediaHref = (
      exportContentClient as typeof exportContentClient & {
        buildRawMediaHref: (
          exchangeId: string,
          bodySide: "request" | "response",
          ordinal: number,
        ) => string;
      }
    ).buildRawMediaHref;

    expect(buildRawMediaHref("exchange/a b", "request", 3)).toBe(
      "/api/exchanges/exchange%2Fa%20b/media/request/3",
    );
  });

  test("按任意网络边界增量组装当前页并在 item_end 丢弃 inherited", async () => {
    const events: ExportContentEvent[] = [
      {
        type: "page_start",
        candidateCount: 2,
        candidateCountExact: true,
        filterProjectionMissingCount: 0,
        filterProjectionLimitedCount: 0,
        visibleExchangeLimit: 2,
        visibleExchangeIds: ["exchange-new", "exchange-old"],
        visibleProcessedCount: 2,
        baselineProcessedCount: 1,
        processedCount: 3,
        visibleRawBytes: 1_024,
        baselineRawBytes: 256,
        processedRawBytes: 1_280,
        nextCursor: "next-cursor",
        hasMoreOlder: true,
        hasMoreNewer: false,
        hasMore: true,
        limitedByBytes: false,
        dedupeStatusByThread: { "thread-1": "sqlite_fingerprint" },
        dedupeDetailsByThread: {
          "thread-1": {
            status: "sqlite_fingerprint",
            affectedExchangeId: "exchange-old",
            selectedBaselineExchangeId: "exchange-baseline",
            attemptedBaselineCount: 1,
            skippedBaselineCount: 0,
          },
        },
        contentCompleteness: "complete",
      },
      {
        type: "exchange_start",
        exchangeId: "exchange-old",
        capturedAt: "2026-07-22T12:00:00.000Z",
        threadId: "thread-1",
        turnId: "turn-1",
        agentSessionId: "session-1",
        targetId: "target-1",
        targetName: "Target 1",
        model: "model-1",
        isAuxiliary: false,
        agentProtocol: "openai-responses",
      },
      {
        type: "item_start",
        exchangeId: "exchange-old",
        itemOrdinal: 0,
        category: "user_real",
        side: "input",
        jsonPath: "$.messages[0].content",
      },
      { type: "text_chunk", exchangeId: "exchange-old", itemOrdinal: 0, value: "继承" },
      {
        type: "item_end",
        exchangeId: "exchange-old",
        itemOrdinal: 0,
        textSha256: "a".repeat(64),
        originalTextBytes: 6,
        stepDiff: "inherited",
      },
      { type: "exchange_end", exchangeId: "exchange-old" },
      {
        type: "exchange_start",
        exchangeId: "exchange-new",
        capturedAt: "2026-07-22T12:01:00.000Z",
        threadId: "thread-1",
        turnId: "turn-1",
        agentSessionId: "session-1",
        targetId: "target-1",
        targetName: "Target 1",
        model: "model-1",
        isAuxiliary: true,
        auxiliaryKind: "metadata",
        agentProtocol: "anthropic-messages",
      },
      {
        type: "item_start",
        exchangeId: "exchange-new",
        itemOrdinal: 0,
        category: "assistant",
        side: "output",
        jsonPath: "$.content[0].text",
      },
      { type: "text_chunk", exchangeId: "exchange-new", itemOrdinal: 0, value: "完整" },
      {
        type: "media_descriptor",
        exchangeId: "exchange-new",
        itemOrdinal: 0,
        bodySide: "response",
        ordinal: 0,
        jsonPath: "$.content[0].text",
        mediaType: "image/png",
        encodedBytes: 100,
        decodedBytes: 75,
        sha256: "b".repeat(64),
        sourceStorage: "external-blob",
      },
      { type: "text_chunk", exchangeId: "exchange-new", itemOrdinal: 0, value: "正文" },
      {
        type: "item_end",
        exchangeId: "exchange-new",
        itemOrdinal: 0,
        textSha256: "c".repeat(64),
        originalTextBytes: 12,
        stepDiff: "unique",
      },
      { type: "exchange_end", exchangeId: "exchange-new" },
      { type: "page_end", contentCompleteness: "complete", processedExchangeCount: 2 },
    ];
    const response = splitNdjsonResponse(events, 7);

    const result = await streamExportContentPage(response, {
      includeInherited: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      exchangeId: "exchange-new",
      category: "assistant",
      text: "完整正文",
      stepDiff: "unique",
      contentSource: "raw_stream",
      textSha256: "c".repeat(64),
      originalTextBytes: 12,
      auxiliaryKind: "metadata",
      agentProtocol: "anthropic-messages",
    });
    expect(result.items[0]?.text).not.toContain("[media");
    expect(result.items[0]?.mediaDescriptors).toEqual([{
      bodySide: "response",
      ordinal: 0,
      jsonPath: "$.content[0].text",
      mediaType: "image/png",
      encodedBytes: 100,
      decodedBytes: 75,
      sha256: "b".repeat(64),
      sourceStorage: "external-blob",
    }]);
    expect(result.page.visibleProcessedCount).toBe(2);
    expect(result.page.baselineProcessedCount).toBe(1);
    expect(result.page.nextCursor).toBe("next-cursor");
    expect(result.page.candidateCountExact).toBe(true);
    expect(result.page.hasMoreOlder).toBe(true);
    expect(result.contentCompleteness).toBe("complete");
  });

  test("没有可见正文的 Exchange 仍按服务端顺序保留并记录隐藏输入", async () => {
    const events = [
      {
        type: "page_start", candidateCount: 2, candidateCountExact: true,
        filterProjectionMissingCount: 0, filterProjectionLimitedCount: 0,
        visibleExchangeLimit: 2,
        visibleExchangeIds: ["exchange-final", "exchange-502"],
        visibleProcessedCount: 2, baselineProcessedCount: 0, processedCount: 2,
        visibleRawBytes: 200, baselineRawBytes: 0, processedRawBytes: 200,
        hasMoreOlder: false, hasMoreNewer: false, hasMore: false,
        limitedByBytes: false, dedupeStatusByThread: { thread: "not_required" },
        dedupeDetailsByThread: {
          thread: {
            status: "not_required", affectedExchangeId: "exchange-502",
            attemptedBaselineCount: 0, skippedBaselineCount: 0,
          },
        },
        contentCompleteness: "complete",
      },
      {
        type: "exchange_start", exchangeId: "exchange-502",
        capturedAt: "2026-07-26T01:00:00.000Z", threadId: "thread",
        turnId: "turn", agentSessionId: "session", targetId: "target",
        targetName: "Target", model: "model", isAuxiliary: false,
        agentProtocol: "openai-responses", httpStatus: 502, durationMs: 30_006,
        diagnosticCodes: ["upstream_error", "connection_error"],
      },
      {
        type: "item_start", exchangeId: "exchange-502", itemOrdinal: 0,
        category: "user_real", side: "input", jsonPath: "$.input[0].content[0].text",
      },
      {
        type: "text_chunk", exchangeId: "exchange-502", itemOrdinal: 0,
        value: "继承输入",
      },
      {
        type: "item_end", exchangeId: "exchange-502", itemOrdinal: 0,
        textSha256: "a".repeat(64), originalTextBytes: 12, stepDiff: "inherited",
      },
      { type: "exchange_end", exchangeId: "exchange-502" },
      {
        type: "exchange_start", exchangeId: "exchange-final",
        capturedAt: "2026-07-26T01:01:00.000Z", threadId: "thread",
        turnId: "turn", agentSessionId: "session", targetId: "target",
        targetName: "Target", model: "model", isAuxiliary: false,
        agentProtocol: "openai-responses", httpStatus: 200, durationMs: 2_000,
        diagnosticCodes: [],
      },
      {
        type: "item_start", exchangeId: "exchange-final", itemOrdinal: 0,
        category: "assistant", side: "output", jsonPath: "$.events[1].delta",
      },
      {
        type: "text_chunk", exchangeId: "exchange-final", itemOrdinal: 0,
        value: "完成",
      },
      {
        type: "item_end", exchangeId: "exchange-final", itemOrdinal: 0,
        textSha256: "b".repeat(64), originalTextBytes: 6, stepDiff: "unique",
      },
      { type: "exchange_end", exchangeId: "exchange-final" },
      { type: "page_end", contentCompleteness: "complete", processedExchangeCount: 2 },
    ] as unknown as ExportContentEvent[];

    const result = await streamExportContentPage(splitNdjsonResponse(events, 11), {
      includeInherited: false,
    });
    const exchanges = (result as typeof result & {
      exchanges: Array<{
        exchangeId: string;
        httpStatus: number;
        hiddenInheritedInputCount: number;
      }>;
    }).exchanges;

    expect(exchanges).toMatchObject([
      {
        exchangeId: "exchange-final",
        httpStatus: 200,
        hiddenInheritedInputCount: 0,
      },
      {
        exchangeId: "exchange-502",
        httpStatus: 502,
        hiddenInheritedInputCount: 1,
      },
    ]);

    const groupExportContentExchanges = (
      exportContentClient as typeof exportContentClient & {
        groupExportContentExchanges: (
          exchangeValues: typeof exchanges,
          items: typeof result.items,
        ) => Array<{ exchange: { exchangeId: string }; items: typeof result.items }>;
      }
    ).groupExportContentExchanges;
    expect(groupExportContentExchanges).toBeTypeOf("function");
    expect(groupExportContentExchanges(exchanges, result.items).map(group => ({
      exchangeId: group.exchange.exchangeId,
      itemCount: group.items.length,
    }))).toEqual([
      { exchangeId: "exchange-final", itemCount: 1 },
      { exchangeId: "exchange-502", itemCount: 0 },
    ]);
  });

  test("拒绝超长 NDJSON 单行且不调用 Response text/json", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(300 * 1024)));
        controller.close();
      },
    }));
    Object.defineProperty(response, "text", {
      value: () => { throw new Error("不得调用 response.text"); },
    });
    Object.defineProperty(response, "json", {
      value: () => { throw new Error("不得调用 response.json"); },
    });

    await expect(streamExportContentPage(response, {
      includeInherited: true,
    })).rejects.toThrow("NDJSON 事件超过");
  });

  test("默认隐藏继承上下文时仍保留排重未确认的输入", async () => {
    const events = [
      {
        type: "page_start", candidateCount: 1, candidateCountExact: true,
        filterProjectionMissingCount: 0, filterProjectionLimitedCount: 0,
        visibleExchangeLimit: 1,
        visibleExchangeIds: ["exchange-unconfirmed"], visibleProcessedCount: 1,
        baselineProcessedCount: 2, processedCount: 3, visibleRawBytes: 100,
        baselineRawBytes: 80, processedRawBytes: 180,
        hasMoreOlder: false, hasMoreNewer: false, hasMore: false,
        limitedByBytes: false, dedupeStatusByThread: { thread: "unavailable" },
        dedupeDetailsByThread: {
          thread: {
            status: "unavailable", affectedExchangeId: "exchange-unconfirmed",
            attemptedBaselineCount: 2, skippedBaselineCount: 2,
            lastSkippedExchangeId: "exchange-broken", failureCode: "request_parse_failed",
          },
        },
        contentCompleteness: "complete",
      },
      {
        type: "exchange_start", exchangeId: "exchange-unconfirmed",
        capturedAt: "2026-07-24T00:00:00.000Z", threadId: "thread",
        agentSessionId: "session", targetId: "target", targetName: "Target",
        isAuxiliary: false, agentProtocol: "openai-responses",
      },
      {
        type: "item_start", exchangeId: "exchange-unconfirmed", itemOrdinal: 0,
        category: "user_real", side: "input", jsonPath: "$.input[0].content[0].text",
      },
      {
        type: "text_chunk", exchangeId: "exchange-unconfirmed", itemOrdinal: 0,
        value: "无法确认是否继承",
      },
      {
        type: "item_end", exchangeId: "exchange-unconfirmed", itemOrdinal: 0,
        textSha256: "d".repeat(64), originalTextBytes: 24, stepDiff: "unconfirmed",
      },
      { type: "exchange_end", exchangeId: "exchange-unconfirmed" },
      { type: "page_end", contentCompleteness: "complete", processedExchangeCount: 1 },
    ] as unknown as ExportContentEvent[];

    const result = await streamExportContentPage(splitNdjsonResponse(events, 9), {
      includeInherited: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      exchangeId: "exchange-unconfirmed",
      text: "无法确认是否继承",
      stepDiff: "unconfirmed",
    });
    expect(result.dedupeDetailsByThread.thread).toMatchObject({
      failureCode: "request_parse_failed",
    });
  });

  test("同一 Exchange 的中文 SSE 输出片段合并为一个逻辑 assistant 项", async () => {
    const events: ExportContentEvent[] = [
      {
        type: "page_start", candidateCount: 1, candidateCountExact: true,
        filterProjectionMissingCount: 0, filterProjectionLimitedCount: 0,
        visibleExchangeLimit: 1,
        visibleExchangeIds: ["exchange-stream"], visibleProcessedCount: 1,
        baselineProcessedCount: 0, processedCount: 1, visibleRawBytes: 100,
        baselineRawBytes: 0, processedRawBytes: 100,
        hasMoreOlder: false, hasMoreNewer: false, hasMore: false,
        limitedByBytes: false, dedupeStatusByThread: { thread: "not_required" },
        dedupeDetailsByThread: {
          thread: {
            status: "not_required", affectedExchangeId: "exchange-stream",
            attemptedBaselineCount: 0, skippedBaselineCount: 0,
          },
        },
        contentCompleteness: "complete",
      },
      {
        type: "exchange_start", exchangeId: "exchange-stream",
        capturedAt: "2026-07-23T00:00:00.000Z", threadId: "thread",
        turnId: "turn", agentSessionId: "session", targetId: "target",
        isAuxiliary: false, agentProtocol: "openai_responses",
      },
      {
        type: "item_start", exchangeId: "exchange-stream", itemOrdinal: 0,
        category: "user_real", side: "input", jsonPath: "$.input[0].text",
      },
      { type: "text_chunk", exchangeId: "exchange-stream", itemOrdinal: 0, value: "当前请求" },
      {
        type: "item_end", exchangeId: "exchange-stream", itemOrdinal: 0,
        textSha256: "f".repeat(64), originalTextBytes: 12, stepDiff: "unique",
      },
    ];
    const fragments = ["我", "会", "按", "已", "确认", "的", "方案", "实现"];
    for (const [fragmentIndex, value] of fragments.entries()) {
      const itemOrdinal = fragmentIndex + 1;
      events.push(
        {
          type: "item_start", exchangeId: "exchange-stream", itemOrdinal,
          category: "assistant", side: "output", jsonPath: `$.events[${itemOrdinal}].delta`,
        },
        { type: "text_chunk", exchangeId: "exchange-stream", itemOrdinal, value },
        {
          type: "item_end", exchangeId: "exchange-stream", itemOrdinal,
          textSha256: String(itemOrdinal).padStart(64, "0"),
          originalTextBytes: new TextEncoder().encode(value).byteLength,
          stepDiff: "unique",
        },
      );
    }
    events.push(
      { type: "exchange_end", exchangeId: "exchange-stream" },
      { type: "page_end", contentCompleteness: "complete", processedExchangeCount: 1 },
    );

    const result = await streamExportContentPage(splitNdjsonResponse(events, 11), {
      includeInherited: false,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      category: "assistant",
      side: "output",
      text: fragments.join(""),
      stepDiff: "unique",
    });
    expect(result.items[1]).toMatchObject({
      category: "user_real",
      side: "input",
      text: "当前请求",
      stepDiff: "unique",
    });
  });

  test("同一 Codex 工具调用的多个 input 输出片段合并为一个工具结果", async () => {
    const events: ExportContentEvent[] = [
      {
        type: "page_start", candidateCount: 1, candidateCountExact: true,
        filterProjectionMissingCount: 0, filterProjectionLimitedCount: 0,
        visibleExchangeLimit: 1,
        visibleExchangeIds: ["exchange-tool"], visibleProcessedCount: 1,
        baselineProcessedCount: 0, processedCount: 1, visibleRawBytes: 100,
        baselineRawBytes: 0, processedRawBytes: 100,
        hasMoreOlder: false, hasMoreNewer: false, hasMore: false,
        limitedByBytes: false, dedupeStatusByThread: { thread: "not_required" },
        dedupeDetailsByThread: {
          thread: {
            status: "not_required", affectedExchangeId: "exchange-tool",
            attemptedBaselineCount: 0, skippedBaselineCount: 0,
          },
        },
        contentCompleteness: "complete",
      },
      {
        type: "exchange_start", exchangeId: "exchange-tool",
        capturedAt: "2026-07-23T00:00:00.000Z", threadId: "thread",
        turnId: "turn", agentSessionId: "session", targetId: "target",
        isAuxiliary: false, agentProtocol: "openai-responses",
      },
      {
        type: "item_start", exchangeId: "exchange-tool", itemOrdinal: 0,
        category: "tool_result", side: "input", toolUseId: "call-1",
        jsonPath: "$.input[0].output[0].text",
      },
      { type: "text_chunk", exchangeId: "exchange-tool", itemOrdinal: 0, value: "Script completed" },
      {
        type: "item_end", exchangeId: "exchange-tool", itemOrdinal: 0,
        textSha256: "a".repeat(64), originalTextBytes: 16, stepDiff: "unique",
      },
      {
        type: "item_start", exchangeId: "exchange-tool", itemOrdinal: 1,
        category: "tool_result", side: "input", toolUseId: "call-1",
        jsonPath: "$.input[0].output[1].text",
      },
      { type: "text_chunk", exchangeId: "exchange-tool", itemOrdinal: 1, value: "命令错误" },
      {
        type: "item_end", exchangeId: "exchange-tool", itemOrdinal: 1,
        textSha256: "b".repeat(64), originalTextBytes: 12, stepDiff: "unique",
      },
      { type: "exchange_end", exchangeId: "exchange-tool" },
      { type: "page_end", contentCompleteness: "complete", processedExchangeCount: 1 },
    ];

    const result = await streamExportContentPage(splitNdjsonResponse(events, 9), {
      includeInherited: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      category: "tool_result",
      side: "input",
      toolUseId: "call-1",
      text: "Script completed命令错误",
    });
  });

  test("Exchange 倒序展示且同一 Exchange 内逻辑项也倒序", async () => {
    const events: ExportContentEvent[] = [
      {
        type: "page_start", candidateCount: 2, candidateCountExact: true,
        filterProjectionMissingCount: 0, filterProjectionLimitedCount: 0,
        visibleExchangeLimit: 2,
        visibleExchangeIds: ["exchange-new", "exchange-old"], visibleProcessedCount: 2,
        baselineProcessedCount: 0, processedCount: 2, visibleRawBytes: 200,
        baselineRawBytes: 0, processedRawBytes: 200,
        hasMoreOlder: false, hasMoreNewer: false, hasMore: false,
        limitedByBytes: false, dedupeStatusByThread: { thread: "not_required" },
        dedupeDetailsByThread: {
          thread: {
            status: "not_required", affectedExchangeId: "exchange-old",
            attemptedBaselineCount: 0, skippedBaselineCount: 0,
          },
        },
        contentCompleteness: "complete",
      },
      {
        type: "exchange_start", exchangeId: "exchange-old",
        capturedAt: "2026-07-23T00:00:00.000Z", threadId: "thread",
        turnId: "turn", agentSessionId: "session", targetId: "target",
        isAuxiliary: false, agentProtocol: "openai-responses",
      },
      {
        type: "item_start", exchangeId: "exchange-old", itemOrdinal: 0,
        category: "user_real", side: "input", jsonPath: "$.input[0].text",
      },
      { type: "text_chunk", exchangeId: "exchange-old", itemOrdinal: 0, value: "旧请求" },
      {
        type: "item_end", exchangeId: "exchange-old", itemOrdinal: 0,
        textSha256: "a".repeat(64), originalTextBytes: 9, stepDiff: "unique",
      },
      { type: "exchange_end", exchangeId: "exchange-old" },
      {
        type: "exchange_start", exchangeId: "exchange-new",
        capturedAt: "2026-07-23T00:01:00.000Z", threadId: "thread",
        turnId: "turn", agentSessionId: "session", targetId: "target",
        isAuxiliary: false, agentProtocol: "openai-responses",
      },
      {
        type: "item_start", exchangeId: "exchange-new", itemOrdinal: 0,
        category: "user_real", side: "input", jsonPath: "$.input[0].text",
      },
      { type: "text_chunk", exchangeId: "exchange-new", itemOrdinal: 0, value: "新请求" },
      {
        type: "item_end", exchangeId: "exchange-new", itemOrdinal: 0,
        textSha256: "b".repeat(64), originalTextBytes: 9, stepDiff: "unique",
      },
      {
        type: "item_start", exchangeId: "exchange-new", itemOrdinal: 1,
        category: "assistant", side: "output", jsonPath: "$.events[0].delta",
      },
      { type: "text_chunk", exchangeId: "exchange-new", itemOrdinal: 1, value: "新响应" },
      {
        type: "item_end", exchangeId: "exchange-new", itemOrdinal: 1,
        textSha256: "c".repeat(64), originalTextBytes: 9, stepDiff: "unique",
      },
      { type: "exchange_end", exchangeId: "exchange-new" },
      { type: "page_end", contentCompleteness: "complete", processedExchangeCount: 2 },
    ];

    const result = await streamExportContentPage(splitNdjsonResponse(events, 13), {
      includeInherited: false,
    });

    expect(result.items.map(item => `${item.exchangeId}:${item.text}`)).toEqual([
      "exchange-new:新响应",
      "exchange-new:新请求",
      "exchange-old:旧请求",
    ]);
  });

  test("客户端取消使用 AbortError 结束而不返回残缺页面", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = splitNdjsonResponse([], 3);

    await expect(streamExportContentPage(response, {
      includeInherited: true,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("保留超大单条错误的稳定代码、Exchange 和精确声明字节", async () => {
    const response = Response.json({
      error: {
        code: "oversized_visible_exchange",
        message: "Exchange exchange-large 需要 41943040 字节。",
        exchangeId: "exchange-large",
        requiredBytes: 40 * 1024 * 1024,
      },
    }, { status: 413 });

    await expect(readExportContentError(response)).resolves.toMatchObject({
      name: "ExportContentRequestError",
      status: 413,
      code: "oversized_visible_exchange",
      exchangeId: "exchange-large",
      requiredBytes: 40 * 1024 * 1024,
    });
  });
});

function splitNdjsonResponse(
  events: ExportContentEvent[],
  chunkSize: number,
): Response {
  const content = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  const bytes = new TextEncoder().encode(content);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  }), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}
