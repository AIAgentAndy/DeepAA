import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  sanitizeExchangeForApi,
  validateRawCapture,
} from "../src/lib/app-state.js";
import { lightweightAgentSessionFromRecords } from "../src/lib/legacy-session-projection.js";
import type { CaptureIndexRecord } from "../src/lib/capture-index.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

describe("app-state 纯 API 边界", () => {
  test("生产模块不再导入旧索引、派生目录或文件扫描 API", () => {
    const source = readFileSync("src/lib/app-state.ts", "utf-8");

    expect(source).not.toMatch(/capture-index|derivation|l2-reader/u);
    expect(source).not.toMatch(/\breaddir\b|\breadFile\b|createReadStream/u);
    expect(source).not.toContain('join(dataDir, "derived"');
    expect(source).not.toContain('join(dataDir, "indexes"');
  });

  test("API Exchange 只脱敏敏感 Header 并保留 raw 证据", () => {
    const exchange = makeExchange();
    const sanitized = sanitizeExchangeForApi(exchange);

    expect(sanitized.request.headers.authorization).toBe(
      "Bearer dummy-**********************uvwxyz",
    );
    expect(sanitized.request.headers["x-api-key"]).toBe(
      "dummy-**********************uvwxyz",
    );
    expect(sanitized.request.headers["content-type"]).toBe("application/json");
    expect(sanitized.request.rawBody).toBe(exchange.request.rawBody);
    expect(JSON.stringify(sanitized)).not.toContain(
      "dummy-token-abcdef1234567890uvwxyz",
    );
  });

  test("raw 完整性状态同时识别内联正文和已解析结果", () => {
    const validation = validateRawCapture(makeExchange());

    expect(validation).toEqual(expect.objectContaining({
      hasRequestHeaders: true,
      hasRequestRawBody: true,
      hasParsedRequestBody: true,
      hasResponseRawBody: true,
      hasParsedResponseBody: true,
    }));
  });

  test("旧增量派生兼容转换只处理调用方已提供的有界索引记录", () => {
    const records = [captureRecord("ex-2", "2026-07-17T00:00:02.000Z"),
      captureRecord("ex-1", "2026-07-17T00:00:01.000Z")];
    const session = lightweightAgentSessionFromRecords(records);

    expect(session.exchangeIds).toEqual(["ex-1", "ex-2"]);
    expect(session.startTime).toBe("2026-07-17T00:00:01.000Z");
    expect(session.endTime).toBe("2026-07-17T00:00:02.100Z");
    expect(session.targetSet).toEqual(["target-test"]);
  });

  test("旧索引 HTTP 入口已经删除", () => {
    expect(existsSync("src/app/api/business-index/route.ts")).toBe(false);
    expect(existsSync("src/app/api/capture-index/route.ts")).toBe(false);
    expect(existsSync("src/app/api/workbench-index/route.ts")).toBe(false);
  });
});

function makeExchange(): RawCapturedExchange {
  const requestBody = JSON.stringify({ model: "gpt-test" });
  const responseBody = JSON.stringify({ ok: true });
  return {
    schemaVersion: 2,
    exchangeId: "capture-v2-1784282400000-12345678-abc:ex-1",
    captureSessionId: "capture-v2-1784282400000-12345678-abc",
    sequence: 1,
    capturedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.100Z",
    durationMs: 100,
    routing: {
      targetId: "target-test",
      targetName: "Target Test",
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: {
      headers: {
        authorization: "Bearer dummy-token-abcdef1234567890uvwxyz",
        "x-api-key": "dummy-token-abcdef1234567890uvwxyz",
        "content-type": "application/json",
      },
      rawBody: requestBody,
      parsedBody: { model: "gpt-test" },
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: "a".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      rawBody: responseBody,
      parsedBody: { ok: true },
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: "b".repeat(64),
      isStreaming: false,
    },
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: true,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function captureRecord(
  exchangeId: string,
  capturedAt: string,
): CaptureIndexRecord {
  return {
    schemaVersion: 1,
    exchangeId,
    captureSessionId: "capture-old",
    filePath: "bounded-input.jsonl",
    byteOffset: 0,
    lineLengthBytes: 1,
    capturedAt,
    completedAt: new Date(Date.parse(capturedAt) + 100).toISOString(),
    targetId: "target-test",
    targetName: "Target Test",
    targetFormatHint: "openai",
    localUrl: "",
    upstreamUrl: "",
    localPath: "/v1/responses",
    upstreamPath: "/v1/responses",
    method: "POST",
    agentName: "codex",
    agentFingerprintId: "fingerprint-codex",
    agentGroupingSource: "agent-session-header",
    agentGroupingConfidence: "exact",
    externalSessionId: "external-session",
    captureDate: "2026-07-17",
    model: "gpt-test",
    status: 200,
    statusText: "OK",
    isStreaming: false,
    requestBodySizeBytes: 1,
    responseBodySizeBytes: 1,
    requestBodySha256: "a",
    responseBodySha256: "b",
    diagnosticCodes: [],
  };
}
