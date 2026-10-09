import { describe, expect, test, vi } from "vitest";
import type { WorkbenchRawInspectorMetadata } from "../src/lib/workbench-raw-inspector-types";
import {
  fetchWorkbenchRawInspectorMetadata,
  findWorkbenchRawMediaDescriptor,
  formatWorkbenchRawBodyForCopy,
  loadWorkbenchRawBody,
  parseWorkbenchRawBody,
  splitWorkbenchRawMediaText,
  valueContainsWorkbenchMediaMarker,
} from "../src/lib/workbench-raw-client";

describe("首页 Raw Inspector 浏览器客户端", () => {
  test("元数据客户端校验 Exchange、side、预算和媒体描述符", async () => {
    const expected = metadata();
    await expect(fetchWorkbenchRawInspectorMetadata({
      exchangeId: expected.exchangeId,
      side: expected.side,
      signal: new AbortController().signal,
      fetcher: async () => Response.json(expected),
    })).resolves.toEqual(expected);

    await expect(fetchWorkbenchRawInspectorMetadata({
      exchangeId: expected.exchangeId,
      side: expected.side,
      signal: new AbortController().signal,
      fetcher: async () => Response.json({ ...expected, side: "response" }),
    })).rejects.toThrow("元数据响应格式无效");
  });

  test("增量读取完成的 JSON 正文并把媒体标记保留在原字段位置", async () => {
    const marker = `__DEEPAA_MEDIA_0_${"a".repeat(64)}__`;
    const text = JSON.stringify({ before: "前", image: marker, after: "后" });
    const events = [
      { type: "chunk", value: text.slice(0, 17) },
      { type: "chunk", value: text.slice(17) },
      {
        type: "complete",
        rawProcessedBytes: 9 * 1024 * 1024,
        displayBytes: Buffer.byteLength(text),
        candidateCount: 1,
        processedCount: 1,
        limited: false,
        diagnosticCodes: [],
      },
    ];
    const fetcher = vi.fn(async () => ndjsonResponse(events));

    const result = await loadWorkbenchRawBody({
      exchangeId: "client-json",
      side: "request",
      metadata: metadata({ sizeBytes: 9 * 1024 * 1024 }),
      signal: new AbortController().signal,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/exchanges/client-json/inspector/request/body",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(result).toMatchObject({
      status: "ready",
      rawProcessedBytes: 9 * 1024 * 1024,
      displayBytes: Buffer.byteLength(text),
      body: {
        kind: "json",
        value: { before: "前", image: marker, after: "后" },
      },
    });
    expect(formatWorkbenchRawBodyForCopy(result.body!, metadata().media.items)).toContain(
      "[图片 #1 · image/png · 4 B]",
    );
  });

  test("完整分类 SSE、非 JSON 文本和空正文", () => {
    const sse = parseWorkbenchRawBody(
      "event: response.output_text.delta\ndata: {\"delta\":\"hello\"}\n\ndata: [DONE]\n\n",
      metadata({ side: "response", isStreaming: true, contentType: "text/event-stream" }),
    );
    expect(sse).toMatchObject({
      kind: "sse",
      doneMarkerSeen: true,
      events: [{ event: "response.output_text.delta", data: { delta: "hello" } }],
    });

    expect(parseWorkbenchRawBody(
      "<html>upstream failed</html>",
      metadata({ side: "response", contentType: "text/html" }),
    )).toMatchObject({ kind: "text", text: "<html>upstream failed</html>" });
    expect(parseWorkbenchRawBody("", metadata())).toEqual({ kind: "empty", text: "" });
  });

  test("混合正文中的媒体标记保留相对位置且必须同时匹配序号与摘要", () => {
    const validMarker = `__DEEPAA_MEDIA_0_${"a".repeat(64)}__`;
    const missingMarker = `__DEEPAA_MEDIA_1_${"b".repeat(64)}__`;
    expect(splitWorkbenchRawMediaText(`前文 ${validMarker} 后文 ${missingMarker}`)).toEqual([
      { kind: "text", value: "前文 " },
      { kind: "media", ordinal: 0, sha256: "a".repeat(64) },
      { kind: "text", value: " 后文 " },
      { kind: "media", ordinal: 1, sha256: "b".repeat(64) },
    ]);

    const descriptor = metadata().media.items[0]!;
    expect(findWorkbenchRawMediaDescriptor(
      { ordinal: 0, sha256: "a".repeat(64) },
      [descriptor],
    )).toEqual(descriptor);
    expect(findWorkbenchRawMediaDescriptor(
      { ordinal: 0, sha256: "c".repeat(64) },
      [descriptor],
    )).toBeUndefined();
    expect(findWorkbenchRawMediaDescriptor(
      { ordinal: 1, sha256: "a".repeat(64) },
      [descriptor],
    )).toBeUndefined();
  });

  test("仅把包含媒体标记的嵌套 SSE data 识别为需要默认展开", () => {
    const marker = `__DEEPAA_MEDIA_0_${"a".repeat(64)}__`;
    expect(valueContainsWorkbenchMediaMarker({
      delta: { content: `前文 ${marker} 后文` },
    })).toBe(true);
    expect(valueContainsWorkbenchMediaMarker({
      delta: { content: "普通 SSE 文本" },
    })).toBe(false);

    let tooDeep: unknown = marker;
    for (let index = 0; index < 40; index++) tooDeep = { child: tooDeep };
    expect(valueContainsWorkbenchMediaMarker(tooDeep)).toBe(false);
  });

  test("Raw 预检和流中非媒体超限都不返回部分正文", async () => {
    const fetcher = vi.fn(async () => ndjsonResponse([]));
    const rawLimited = await loadWorkbenchRawBody({
      exchangeId: "raw-limited",
      side: "request",
      metadata: metadata({ rawScanAllowed: false, sizeBytes: 128 * 1024 * 1024 + 1 }),
      signal: new AbortController().signal,
      fetcher,
    });
    expect(rawLimited).toMatchObject({ status: "raw_limited" });
    expect(fetcher).not.toHaveBeenCalled();

    const text = "partial must be discarded";
    const displayLimited = await loadWorkbenchRawBody({
      exchangeId: "display-limited",
      side: "request",
      metadata: metadata(),
      signal: new AbortController().signal,
      fetcher: async () => ndjsonResponse([
        { type: "chunk", value: text },
        {
          type: "limit",
          code: "display_bytes_exceeded",
          maxDisplayBytes: 8 * 1024 * 1024,
          processedDisplayBytes: Buffer.byteLength(text),
          rawProcessedBytes: 8 * 1024 * 1024 + 1,
          candidateCount: 0,
          processedCount: 0,
          limited: true,
        },
      ]),
    });
    expect(displayLimited).toMatchObject({
      status: "display_limited",
      maxDisplayBytes: 8 * 1024 * 1024,
    });
    expect(displayLimited).not.toHaveProperty("body");
  });

  test("服务端回流的内联 Base64 就地脱敏（不再整段失败），并在 AbortSignal 触发时取消 reader", async () => {
    // 2026-09-18 用户反馈：投影漏网的内联图片曾让整块正文报「结构化正文非法包含
    // Base64 Data URL」，请求页签直接不可读。现在改成脱敏：正文照常渲染，
    // DOM 里永远不出现大段 base64。
    const unsafeBody = "{\"image\":\"data:image/png;base64,AQIDBA==\"}";
    const unsafeBytes = new TextEncoder().encode(unsafeBody).length;
    const redacted = await loadWorkbenchRawBody({
      exchangeId: "unsafe-base64",
      side: "request",
      metadata: metadata({ sizeBytes: unsafeBytes }),
      signal: new AbortController().signal,
      fetcher: async () => ndjsonResponse([
        { type: "chunk", value: unsafeBody },
        {
          type: "complete",
          rawProcessedBytes: unsafeBytes,
          displayBytes: unsafeBytes,
          candidateCount: 0,
          processedCount: 0,
          limited: false,
          diagnosticCodes: [],
        },
      ]),
    });
    expect(redacted.status).toBe("ready");
    const redactedBody = redacted.status === "ready" ? redacted.body : undefined;
    expect(redactedBody?.kind).toBe("json");
    expect(JSON.stringify(redactedBody?.value)).not.toContain("base64,");
    expect(JSON.stringify(redactedBody?.value)).toContain("【内联媒体已省略】");
    expect(redactedBody?.text).not.toContain("AQIDBA==");

    const controller = new AbortController();
    controller.abort();
    await expect(loadWorkbenchRawBody({
      exchangeId: "aborted",
      side: "response",
      metadata: metadata({ side: "response" }),
      signal: controller.signal,
      fetcher: vi.fn(),
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});

function metadata(overrides: {
  side?: "request" | "response";
  sizeBytes?: number;
  rawScanAllowed?: boolean;
  isStreaming?: boolean;
  contentType?: string;
} = {}): WorkbenchRawInspectorMetadata {
  const side = overrides.side ?? "request";
  return {
    exchangeId: "client-json",
    side,
    candidateCount: 1,
    processedCount: 1,
    limited: false,
    indexVerification: "current",
    routing: {
      targetId: "target",
      targetName: "Target",
      method: "POST",
      path: "/v1/responses",
    },
    model: "gpt-test",
    durationMs: 10,
    headers: {
      items: { "content-type": overrides.contentType ?? "application/json" },
      candidateCount: 1,
      processedCount: 1,
      limited: false,
    },
    body: {
      sizeBytes: overrides.sizeBytes ?? 100,
      sha256: "f".repeat(64),
      storage: "external-blob",
      availability: "available",
      verification: "verified",
      contentType: overrides.contentType ?? "application/json",
      isStreaming: overrides.isStreaming ?? false,
      rawScanAllowed: overrides.rawScanAllowed ?? true,
      displayLimitBytes: 8 * 1024 * 1024,
      rawScanLimitBytes: 128 * 1024 * 1024,
    },
    media: {
      items: [{
        bodySide: side,
        ordinal: 0,
        jsonPath: "$.image",
        mediaType: "image/png",
        encodedBytes: 8,
        decodedBytes: 4,
        sha256: "a".repeat(64),
        sourceStorage: "external-blob",
        viewable: true,
      }],
      candidateCount: 1,
      processedCount: 1,
      limited: false,
    },
  };
}

function ndjsonResponse(events: unknown[]): Response {
  return new Response(events.map(event => `${JSON.stringify(event)}\n`).join(""), {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
