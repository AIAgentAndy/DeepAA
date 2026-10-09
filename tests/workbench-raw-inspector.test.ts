import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types";
import { storeRawBody } from "../src/lib/harness/raw-body";
import { getDeepaaDatabase } from "../src/lib/db/connection";
import {
  getExplicitRawLeaseMetrics,
  resetExplicitRawLeasesForTests,
} from "../src/lib/explicit-raw-lease";
import { discoverV2Sources } from "../src/lib/ingestion/raw-source-reader";
import {
  loadWorkbenchRawInspectorMetadata,
  openWorkbenchRawInspectorBodyResponse,
} from "../src/lib/workbench-raw-inspector";
import {
  WORKBENCH_RAW_DISPLAY_LIMIT_BYTES,
  WORKBENCH_RAW_SCAN_LIMIT_BYTES,
} from "../src/lib/workbench-raw-inspector-types";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture";

const fixtures: SqliteFixture[] = [];
const routeDataDirs = new Set<string>();

afterEach(async () => {
  for (const dataDir of routeDataDirs) {
    const db = getDeepaaDatabase(dataDir);
    if (db.open) db.close();
  }
  routeDataDirs.clear();
  resetExplicitRawLeasesForTests();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  delete process.env.DEEPAA_DATA_DIR;
});

describe("首页单侧 Raw Inspector", () => {
  test("元数据只返回当前单侧的脱敏 Headers、正文身份和媒体描述符", async () => {
    const fixture = await seedInspectorExchange();
    const metadata = await loadWorkbenchRawInspectorMetadata(
      fixture.db,
      fixture.dataDir,
      "inspector-exchange",
      "request",
    );

    expect(metadata).toMatchObject({
      exchangeId: "inspector-exchange",
      side: "request",
      candidateCount: 1,
      processedCount: 1,
      limited: false,
      routing: {
        targetId: "target-inspector",
        targetName: "Inspector Target",
        method: "POST",
        path: "/v1/responses",
      },
      model: "gpt-inspector",
      headers: {
        items: {
          authorization: "Bearer abcdef**********uvwxyz",
          cookie: "sessio*****************alue-1",
          "content-type": "application/json",
        },
        candidateCount: 3,
        processedCount: 3,
        limited: false,
      },
      body: {
        sizeBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        storage: "inline",
        rawScanAllowed: true,
        displayLimitBytes: 8 * 1024 * 1024,
        rawScanLimitBytes: 128 * 1024 * 1024,
      },
      media: {
        items: [{
          bodySide: "request",
          ordinal: 0,
          jsonPath: "$.input[0].image_url",
          mediaType: "image/png",
          encodedBytes: 8,
          decodedBytes: 4,
          viewable: true,
        }],
        candidateCount: 1,
        processedCount: 1,
        limited: false,
      },
    });
    expect("response" in metadata).toBe(false);

    const serialized = JSON.stringify(metadata);
    for (const forbidden of [
      "response-secret",
      "data:image/png;base64",
      "rawBody",
      "rawBodyRef",
      "inlineBase64",
      "externalPath",
      "byteOffset",
      "relativePath",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("注入凭据的请求按上游真实视角展示：上游 URL + 凭据头标注注入指纹", async () => {
    const requestBody = JSON.stringify({model: "gpt-inspector"});
    const base = rawExchange(requestBody, JSON.stringify({ok: true}));
    const exchange: RawCapturedExchangeV2 = {
      ...base,
      request: rawSide(requestBody, {
        authorization: "Bearer deepaa-gateway",
        "x-api-key": "deepaa-gateway",
        "content-type": "application/json",
      }),
      routing: {...base.routing, clientCredentialId: "cred_inject_probe"},
    };
    const fixture = await seedInspectorExchange({exchange});
    await mkdir(join(fixture.dataDir, "config"), {recursive: true});
    await writeFile(
      join(fixture.dataDir, "config", "development-credentials.json"),
      JSON.stringify({version: 1, credentials: [{id: "cred_inject_probe", fingerprintSuffix: "3c53****QWoJ"}]}),
      "utf8",
    );

    const metadata = await loadWorkbenchRawInspectorMetadata(
      fixture.db,
      fixture.dataDir,
      exchange.exchangeId,
      "request",
    );
    expect(metadata.routing).toMatchObject({
      upstreamUrl: "https://example.test/v1/responses",
      path: "/v1/responses",
    });
    expect(metadata.credentialInjected).toBe(true);
    expect(metadata.credentialFingerprint).toBe("3c53****QWoJ");
    // 客户端占位符不代表上游事实：凭据头改标注入指纹，占位符不出现在返回 DTO。
    expect(metadata.headers.items.authorization).toBe("已注入系统凭据 3c53****QWoJ");
    expect(metadata.headers.items["x-api-key"]).toBe("已注入系统凭据 3c53****QWoJ");
    expect(JSON.stringify(metadata)).not.toContain("deepaa-gateway");
  });

  test("元数据 Route 只允许本机同源读取并返回安全响应头", async () => {
    const fixture = await seedInspectorExchange();
    routeDataDirs.add(fixture.dataDir);
    process.env.DEEPAA_DATA_DIR = fixture.dataDir;
    const route = await import(
      "../src/app/api/exchanges/[exchangeId]/inspector/[side]/route"
    );

    const response = await route.GET(
      localRequest("/api/exchanges/inspector-exchange/inspector/response"),
      { params: Promise.resolve({ exchangeId: "inspector-exchange", side: "response" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await response.json()).toMatchObject({
      side: "response",
      http: { status: 200, statusText: "OK" },
      headers: {
        items: {
          "content-type": "application/json",
          "set-cookie": "respon***secret",
        },
      },
    });

    const remote = await route.GET(
      new Request("http://example.test/api/exchanges/inspector-exchange/inspector/request"),
      { params: Promise.resolve({ exchangeId: "inspector-exchange", side: "request" }) },
    );
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({
      error: { code: "raw_local_origin_required" },
    });
  });

  test("大 Base64 图片不计入 8 MiB 且原始编码不会进入正文 NDJSON", async () => {
    const image = Buffer.alloc(7 * 1024 * 1024, 7);
    const encoded = image.toString("base64");
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(WORKBENCH_RAW_DISPLAY_LIMIT_BYTES);
    const body = JSON.stringify({
      model: "gpt-inspector",
      before: "图片之前",
      image: `data:image/png;base64,${encoded}`,
      after: "图片之后",
    });
    const fixture = await seedInspectorBody(body, {
      media: {
        mediaType: "image/png",
        encodedBytes: Buffer.byteLength(encoded),
        decodedBytes: image.length,
        sha256: sha256(image),
      },
    });

    const response = await openWorkbenchRawInspectorBodyResponse({
      db: fixture.db,
      dataDir: fixture.dataDir,
      exchangeId: "inspector-body",
      side: "request",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    const ndjson = await response.text();
    expect(ndjson).not.toContain("data:image/png;base64");
    expect(ndjson).not.toContain(encoded.slice(0, 1_024));
    const events = parseNdjson(ndjson);
    const text = events
      .filter(event => event.type === "chunk")
      .map(event => String(event.value))
      .join("");
    expect(JSON.parse(text)).toEqual({
      model: "gpt-inspector",
      before: "图片之前",
      image: expect.stringMatching(/^__DEEPAA_MEDIA_0_[a-f0-9]{64}__$/),
      after: "图片之后",
    });
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      candidateCount: 1,
      processedCount: 1,
      limited: false,
      rawProcessedBytes: Buffer.byteLength(body),
    });
    expect(Number(events.at(-1)?.displayBytes)).toBeLessThan(1_024);
    expect(getExplicitRawLeaseMetrics().active).toBe(0);
  });

  test("非媒体正文超过 8 MiB 时受限，Raw 超过 128 MiB 时在打开前拒绝", async () => {
    const displayLimited = await seedInspectorBody(
      "x".repeat(WORKBENCH_RAW_DISPLAY_LIMIT_BYTES + 1),
      { contentType: "text/plain" },
    );
    const limitedResponse = await openWorkbenchRawInspectorBodyResponse({
      db: displayLimited.db,
      dataDir: displayLimited.dataDir,
      exchangeId: "inspector-body",
      side: "request",
    });
    const limitedEvents = parseNdjson(await limitedResponse.text());
    expect(limitedEvents.at(-1)).toMatchObject({
      type: "limit",
      code: "display_bytes_exceeded",
      maxDisplayBytes: WORKBENCH_RAW_DISPLAY_LIMIT_BYTES,
      limited: true,
    });
    expect(limitedEvents.some(event => event.type === "complete")).toBe(false);

    const rawLimited = await seedInspectorBody("small-body", {
      contentType: "text/plain",
      declaredSizeBytes: WORKBENCH_RAW_SCAN_LIMIT_BYTES + 1,
    });
    const rawResponse = await openWorkbenchRawInspectorBodyResponse({
      db: rawLimited.db,
      dataDir: rawLimited.dataDir,
      exchangeId: "inspector-body",
      side: "request",
    });
    expect(rawResponse.status).toBe(413);
    expect(await rawResponse.json()).toMatchObject({
      error: {
        code: "raw_scan_bytes_exceeded",
        details: {
          sizeBytes: WORKBENCH_RAW_SCAN_LIMIT_BYTES + 1,
          maxBytes: WORKBENCH_RAW_SCAN_LIMIT_BYTES,
        },
      },
    });
    expect(getExplicitRawLeaseMetrics()).toEqual({ active: 0, busy: 0 });
  });

  test("取消结构化正文流会立即释放共享 Raw 并发额度", async () => {
    const fixture = await seedInspectorBody(JSON.stringify({ text: "正文".repeat(50_000) }));
    const response = await openWorkbenchRawInspectorBodyResponse({
      db: fixture.db,
      dataDir: fixture.dataDir,
      exchangeId: "inspector-body",
      side: "request",
    });
    expect(getExplicitRawLeaseMetrics().active).toBe(1);
    await response.body?.cancel();
    expect(getExplicitRawLeaseMetrics().active).toBe(0);
  });

  test("正文 Route 复用本机同源与 Range 门禁并只返回安全 NDJSON", async () => {
    const fixture = await seedInspectorBody(JSON.stringify({ text: "route-body" }));
    routeDataDirs.add(fixture.dataDir);
    process.env.DEEPAA_DATA_DIR = fixture.dataDir;
    const route = await import(
      "../src/app/api/exchanges/[exchangeId]/inspector/[side]/body/route"
    );

    const response = await route.GET(
      localRequest("/api/exchanges/inspector-body/inspector/request/body"),
      { params: Promise.resolve({ exchangeId: "inspector-body", side: "request" }) },
    );
    expect(response.status).toBe(200);
    const events = parseNdjson(await response.text());
    expect(events.at(-1)?.type).toBe("complete");
    expect(events.map(event => event.value ?? "").join("")).toContain("route-body");

    const ranged = await route.GET(
      new Request("http://localhost/api/exchanges/inspector-body/inspector/request/body", {
        headers: {
          host: "localhost",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
          range: "bytes=0-10",
        },
      }),
      { params: Promise.resolve({ exchangeId: "inspector-body", side: "request" }) },
    );
    expect(ranged.status).toBe(416);
    expect(await ranged.json()).toMatchObject({
      error: { code: "raw_range_not_supported" },
    });
  });
});

async function seedInspectorExchange(options: {exchange?: RawCapturedExchangeV2} = {}): Promise<SqliteFixture> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const requestBody = JSON.stringify({
    model: "gpt-inspector",
    input: [{ image_url: "data:image/png;base64,AQIDBA==" }],
  });
  const responseBody = JSON.stringify({ output: "response-secret" });
  const exchange = options.exchange ?? rawExchange(requestBody, responseBody);
  const fileName = "workbench-raw-inspector.jsonl";
  await fixture.writeV2Lines([exchange], fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const source = fixture.db.prepare(
    `SELECT id, file_id, generation
     FROM ingestion_sources WHERE relative_path = ?`,
  ).get(`captures/v2/${fileName}`) as {
    id: number;
    file_id: string;
    generation: number;
  };
  const line = Buffer.from(`${JSON.stringify(exchange)}\n`);
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id, target_name,
      agent_name, agent_fingerprint_id, model, status, is_streaming,
      request_body_bytes, response_body_bytes
    ) VALUES(?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    exchange.exchangeId,
    exchange.captureSessionId,
    source.id,
    line.length,
    exchange.capturedAt,
    exchange.completedAt,
    exchange.routing.targetId,
    exchange.routing.targetName,
    "codex",
    "fingerprint-inspector",
    "gpt-inspector",
    exchange.response.status,
    0,
    exchange.request.bodySizeBytes,
    exchange.response.bodySizeBytes,
  );
  const descriptors = [
    ["request", 0, "$.input[0].image_url", "image/png", 8, 4, sha256(Buffer.from([1, 2, 3, 4])), exchange.request.bodySha256],
    ["response", 0, "$.output_image", "image/webp", 8, 4, "b".repeat(64), exchange.response.bodySha256],
  ] as const;
  const insertDescriptor = fixture.db.prepare(
    `INSERT INTO exchange_media_descriptors(
      exchange_id, body_side, ordinal, json_path, media_type,
      encoded_bytes, decoded_bytes, sha256, raw_body_sha256, source_storage
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'inline')`,
  );
  for (const descriptor of descriptors) {
    insertDescriptor.run(exchange.exchangeId, ...descriptor);
  }
  return fixture;
}

function rawExchange(requestBody: string, responseBody: string): RawCapturedExchangeV2 {
  const capturedAt = "2026-07-26T06:00:00.000Z";
  return {
    schemaVersion: 2,
    exchangeId: "inspector-exchange",
    captureSessionId: "capture-inspector",
    sequence: 1,
    capturedAt,
    completedAt: "2026-07-26T06:00:01.250Z",
    durationMs: 1_250,
    routing: {
      targetId: "target-inspector",
      targetName: "Inspector Target",
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1:3211/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: rawSide(requestBody, {
      authorization: "Bearer abcdef1234567890uvwxyz",
      cookie: "session-cookie-secret-value-1",
      "content-type": "application/json",
    }),
    response: {
      ...rawSide(responseBody, {
        "content-type": "application/json",
        "set-cookie": "response-secret",
      }),
      status: 200,
      statusText: "OK",
      isStreaming: false,
    },
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: true,
      headerRedactionAppliedInApi: false,
      rawBodiesStoredLocally: true,
    },
  };
}

async function seedInspectorBody(
  body: string,
  options: {
    contentType?: string;
    declaredSizeBytes?: number;
    media?: {
      mediaType: string;
      encodedBytes: number;
      decodedBytes: number;
      sha256: string;
    };
  } = {},
): Promise<SqliteFixture> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const stored = await storeRawBody(fixture.dataDir, body, {
    inlineThresholdBytes: 1,
    compressedInlineThresholdBytes: 2,
  });
  const declaredSizeBytes = options.declaredSizeBytes ?? Buffer.byteLength(body);
  const declaredSha256 = sha256(body);
  const capturedAt = "2026-07-26T07:00:00.000Z";
  const exchange: RawCapturedExchangeV2 = {
    ...rawExchange("{}", "{}"),
    exchangeId: "inspector-body",
    captureSessionId: "capture-inspector-body",
    capturedAt,
    completedAt: capturedAt,
    request: {
      headers: { "content-type": options.contentType ?? "application/json" },
      rawBody: stored.inline,
      rawBodyRef: {
        ...stored.reference,
        sizeBytes: declaredSizeBytes,
        sha256: declaredSha256,
      },
      bodySizeBytes: declaredSizeBytes,
      bodySha256: declaredSha256,
    },
  };
  const fileName = `workbench-inspector-body-${fixtures.length}.jsonl`;
  await fixture.writeV2Lines([exchange], fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const source = fixture.db.prepare(
    `SELECT id FROM ingestion_sources WHERE relative_path = ?`,
  ).get(`captures/v2/${fileName}`) as { id: number };
  const line = Buffer.from(`${JSON.stringify(exchange)}\n`);
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id, target_name,
      agent_name, agent_fingerprint_id, model, status, is_streaming,
      request_body_bytes, response_body_bytes
    ) VALUES(?, ?, ?, 0, ?, ?, ?, 'target-inspector', 'Inspector Target',
      'codex', 'fingerprint-inspector', 'gpt-inspector', 200, 0, ?, 2)`,
  ).run(
    exchange.exchangeId,
    exchange.captureSessionId,
    source.id,
    line.length,
    capturedAt,
    capturedAt,
    declaredSizeBytes,
  );
  if (options.media) {
    fixture.db.prepare(
      `INSERT INTO exchange_media_descriptors(
        exchange_id, body_side, ordinal, json_path, media_type,
        encoded_bytes, decoded_bytes, sha256, raw_body_sha256, source_storage
      ) VALUES(?, 'request', 0, '$.image', ?, ?, ?, ?, ?, ?)`,
    ).run(
      exchange.exchangeId,
      options.media.mediaType,
      options.media.encodedBytes,
      options.media.decodedBytes,
      options.media.sha256,
      declaredSha256,
      stored.reference.storage,
    );
  }
  return fixture;
}

function rawSide(body: string, headers: Record<string, string>) {
  return {
    headers,
    rawBody: body,
    rawBodyRef: {
      storage: "inline" as const,
      encoding: "identity" as const,
      sha256: sha256(body),
      sizeBytes: Buffer.byteLength(body),
    },
    bodySizeBytes: Buffer.byteLength(body),
    bodySha256: sha256(body),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function localRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
  });
}

function parseNdjson(value: string): Array<Record<string, unknown>> {
  return value.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
