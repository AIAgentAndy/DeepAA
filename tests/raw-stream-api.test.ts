import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types";
import { storeRawBody } from "../src/lib/harness/raw-body";
import { discoverV2Sources } from "../src/lib/ingestion/raw-source-reader";
import { getDeepaaDatabase } from "../src/lib/db/connection";
import {
  acquireExplicitRawLease,
  getExplicitRawLeaseMetrics,
  resetExplicitRawLeasesForTests,
} from "../src/lib/explicit-raw-lease";
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
  const gateway = await import("../src/lib/raw-stream-gateway").catch(() => undefined);
  gateway?.resetRawStreamGatewayForTests();
  resetExplicitRawLeasesForTests();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  delete process.env.DEEPAA_DATA_DIR;
});

describe("显式 Raw 流式 API", () => {
  test("单侧 Raw、页面内容流和完整下载共用两个并发额度", () => {
    const rawBody = acquireExplicitRawLease();
    const contentPage = acquireExplicitRawLease();

    expect(rawBody).toBeDefined();
    expect(contentPage).toBeDefined();
    expect(acquireExplicitRawLease()).toBeUndefined();
    expect(getExplicitRawLeaseMetrics()).toEqual({ active: 2, busy: 1 });

    rawBody?.release();
    rawBody?.release();
    const download = acquireExplicitRawLease();
    expect(download).toBeDefined();
    expect(getExplicitRawLeaseMetrics()).toEqual({ active: 2, busy: 1 });

    contentPage?.release();
    download?.release();
    expect(getExplicitRawLeaseMetrics()).toEqual({ active: 0, busy: 1 });
  });

  test("元数据只读 SQLite，正文按 current/legacy 精确索引流式输出三种 storage", async () => {
    const seeded = await seedRawStreams();
    const [metadataRoute, bodyRoute] = await Promise.all([
      import("../src/app/api/exchanges/[exchangeId]/raw/route"),
      import("../src/app/api/exchanges/[exchangeId]/raw/[side]/route"),
    ]);
    const source = seeded.fixture.db.prepare(
      "SELECT id, relative_path FROM ingestion_sources LIMIT 1",
    ).get() as { id: number; relative_path: string };
    seeded.fixture.db.prepare(
      "UPDATE ingestion_sources SET relative_path = ? WHERE id = ?",
    ).run("captures/v2/raw-must-not-be-read.jsonl", source.id);

    const metadataResponse = await metadataRoute.GET(
      localRequest(`/api/exchanges/${seeded.ids.external}/raw`),
      { params: Promise.resolve({ exchangeId: seeded.ids.external }) },
    );
    const metadata = await metadataResponse.json();
    expect(metadataResponse.status).toBe(200);
    expect(metadata.exchangeId).toBe(seeded.ids.external);
    expect(metadata.indexVerification).toBe("current");
    expect(metadata.request.storage).toBe("external-blob");
    expect(metadata.request.sizeBytes).toBe(Buffer.byteLength(seeded.bodies.external));
    expect(JSON.stringify(metadata)).not.toContain("relative_path");
    expect(JSON.stringify(metadata)).not.toContain("externalPath");
    expect(JSON.stringify(metadata)).not.toContain("inlineBase64");
    expect(JSON.stringify(metadata)).not.toContain("raw-must-not-be-read");

    seeded.fixture.db.prepare(
      "UPDATE ingestion_sources SET relative_path = ? WHERE id = ?",
    ).run(source.relative_path, source.id);

    for (const name of ["inline", "compressed", "external"] as const) {
      const exchangeId = seeded.ids[name];
      const response = await bodyRoute.GET(
        localRequest(
          `/api/exchanges/${exchangeId}/raw/request?disposition=inline`,
        ),
        { params: Promise.resolve({ exchangeId, side: "request" }) },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(seeded.bodies[name]);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("content-disposition")).toBe("inline");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("x-deepaa-expected-size")).toBe(
        String(Buffer.byteLength(seeded.bodies[name])),
      );
      expect(response.headers.get("x-deepaa-expected-sha256")).toBe(
        sha256(seeded.bodies[name]),
      );
      expect(response.headers.get("x-deepaa-index-verification")).toBe("current");
    }

    const legacyResponse = await bodyRoute.GET(
      localRequest(
        `/api/exchanges/${seeded.ids.legacy}/raw/request?disposition=attachment`,
      ),
      { params: Promise.resolve({ exchangeId: seeded.ids.legacy, side: "request" }) },
    );
    expect(legacyResponse.status).toBe(200);
    expect(await legacyResponse.text()).toBe(seeded.bodies.legacy);
    expect(legacyResponse.headers.get("content-type")).toBe("application/octet-stream");
    expect(legacyResponse.headers.get("content-disposition")).toMatch(
      /^attachment; filename="raw-legacy-request\.raw\.txt"$/,
    );
    expect(legacyResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(legacyResponse.headers.get("x-deepaa-index-verification")).toBe("legacy");
  });

  test("拒绝远程 Host、跨 Origin、same-site/cross-site 和 Range", async () => {
    const seeded = await seedRawStreams();
    const bodyRoute = await import(
      "../src/app/api/exchanges/[exchangeId]/raw/[side]/route"
    );
    const id = seeded.ids.inline;
    const requests = [
      new Request(`http://example.test/api/exchanges/${id}/raw/request`),
      localRequest(`/api/exchanges/${id}/raw/request`, {
        origin: "http://evil.test",
        "sec-fetch-site": "same-origin",
      }),
      localRequest(`/api/exchanges/${id}/raw/request`, {
        origin: "http://localhost",
        "sec-fetch-site": "same-site",
      }),
      localRequest(`/api/exchanges/${id}/raw/request`, {
        origin: "http://localhost",
        "sec-fetch-site": "cross-site",
      }),
    ];
    for (const request of requests) {
      const response = await bodyRoute.GET(request, {
        params: Promise.resolve({ exchangeId: id, side: "request" }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "raw_local_origin_required" },
      });
    }

    const rangeResponse = await bodyRoute.GET(
      localRequest(`/api/exchanges/${id}/raw/request`, { range: "bytes=0-10" }),
      { params: Promise.resolve({ exchangeId: id, side: "request" }) },
    );
    expect(rangeResponse.status).toBe(416);
    expect(await rangeResponse.json()).toMatchObject({
      error: { code: "raw_range_not_supported" },
    });
  });

  test("每进程最多两条流，结束和取消都会立即释放额度", async () => {
    const seeded = await seedRawStreams();
    const [bodyRoute, gateway] = await Promise.all([
      import("../src/app/api/exchanges/[exchangeId]/raw/[side]/route"),
      import("../src/lib/raw-stream-gateway"),
    ]);
    const id = seeded.ids.inline;
    const open = () => bodyRoute.GET(
      localRequest(`/api/exchanges/${id}/raw/request`),
      { params: Promise.resolve({ exchangeId: id, side: "request" }) },
    );
    const first = await open();
    const second = await open();
    const busy = await open();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.json()).toMatchObject({ error: { code: "raw_stream_busy" } });

    await first.body?.cancel();
    const afterCancel = await open();
    expect(afterCancel.status).toBe(200);
    await expect(second.text()).resolves.toBe(seeded.bodies.inline);
    await expect(afterCancel.text()).resolves.toBe(seeded.bodies.inline);
    expect(gateway.getRawStreamGatewayMetrics()).toMatchObject({
      active: 0,
      completed: 2,
      cancelled: 1,
      busy: 1,
    });
  });

  test("流末完整性失败会中断连接且不追加 JSON 错误尾部", async () => {
    const seeded = await seedRawStreams();
    const bodyRoute = await import(
      "../src/app/api/exchanges/[exchangeId]/raw/[side]/route"
    );
    const response = await bodyRoute.GET(
      localRequest(`/api/exchanges/${seeded.ids.integrity}/raw/request`),
      { params: Promise.resolve({ exchangeId: seeded.ids.integrity, side: "request" }) },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let failed = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const partial = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
    expect(partial).toBe(seeded.bodies.integrity);
    expect(partial).not.toContain("raw_body_integrity_failed");
    const gateway = await import("../src/lib/raw-stream-gateway");
    expect(gateway.getRawStreamGatewayMetrics()).toMatchObject({
      active: 0,
      interrupted: 1,
    });
  });
});

interface SeededRawStreams {
  fixture: SqliteFixture;
  ids: Record<"inline" | "compressed" | "external" | "legacy" | "integrity", string>;
  bodies: Record<"inline" | "compressed" | "external" | "legacy" | "integrity", string>;
}

async function seedRawStreams(): Promise<SeededRawStreams> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  routeDataDirs.add(fixture.dataDir);
  process.env.DEEPAA_DATA_DIR = fixture.dataDir;
  const ids = {
    inline: "raw-inline",
    compressed: "raw-compressed",
    external: "raw-external",
    legacy: "raw-legacy",
    integrity: "raw-integrity",
  } as const;
  const bodies = {
    inline: JSON.stringify({ storage: "inline", text: "内联正文".repeat(2_000) }),
    compressed: JSON.stringify({ storage: "compressed", text: "压缩正文".repeat(20_000) }),
    external: JSON.stringify({ storage: "external", text: "外置正文".repeat(40_000) }),
    legacy: JSON.stringify({ storage: "legacy", text: "历史正文".repeat(2_000) }),
    integrity: JSON.stringify({ storage: "integrity", text: "完整性正文".repeat(2_000) }),
  };
  const policies = {
    inline: { inlineThresholdBytes: 1024 * 1024, compressedInlineThresholdBytes: 2 * 1024 * 1024 },
    compressed: { inlineThresholdBytes: 1, compressedInlineThresholdBytes: 2 * 1024 * 1024 },
    external: { inlineThresholdBytes: 1, compressedInlineThresholdBytes: 2 },
    legacy: { inlineThresholdBytes: 1024 * 1024, compressedInlineThresholdBytes: 2 * 1024 * 1024 },
    integrity: { inlineThresholdBytes: 1024 * 1024, compressedInlineThresholdBytes: 2 * 1024 * 1024 },
  } as const;
  const exchanges: RawCapturedExchangeV2[] = [];
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const stored = await storeRawBody(fixture.dataDir, bodies[name], policies[name]);
    const declaredSha = name === "integrity" ? "0".repeat(64) : stored.reference.sha256;
    exchanges.push(rawExchange(
      ids[name],
      exchanges.length,
      bodies[name],
      stored.inline,
      { ...stored.reference, sha256: declaredSha },
      declaredSha,
    ));
  }
  const fileName = "raw-streams.jsonl";
  await fixture.writeV2Lines(exchanges, fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const source = fixture.db.prepare(
    `SELECT id, relative_path, file_id, generation
     FROM ingestion_sources WHERE relative_path = ?`,
  ).get(`captures/v2/${fileName}`) as {
    id: number;
    relative_path: string;
    file_id: string;
    generation: number;
  };
  let offset = 0;
  for (const exchange of exchanges) {
    const line = Buffer.from(`${JSON.stringify(exchange)}\n`);
    const current = exchange.exchangeId !== ids.legacy;
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset,
        line_length_bytes, captured_at, completed_at, target_id, target_name,
        agent_name, agent_fingerprint_id, model, status, is_streaming,
        request_body_bytes, response_body_bytes
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'target-raw', 'Raw Target',
        'codex', 'fingerprint-raw', 'gpt-test', 200, 0, ?, 2)`,
    ).run(
      exchange.exchangeId,
      exchange.captureSessionId,
      source.id,
      offset,
      line.length,
      exchange.capturedAt,
      exchange.completedAt,
      exchange.request.bodySizeBytes,
    );
    if (current) {
      const ingestionId = fixture.db.prepare(
        `INSERT INTO ingestion_records(
          exchange_id, source_id, source_generation, source_file_id,
          byte_offset, line_length_bytes, line_sha256, schema_version,
          captured_at, completed_at, request_body_bytes, response_body_bytes,
          request_body_sha256, response_body_sha256,
          request_body_storage, response_body_storage,
          request_body_state, response_body_state, registered_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, 2, ?, ?, ?, 'inline',
          'available', 'available', ?)
        RETURNING id`,
      ).pluck().get(
        exchange.exchangeId,
        source.id,
        source.generation,
        source.file_id,
        offset,
        line.length,
        sha256(line),
        exchange.capturedAt,
        exchange.completedAt,
        exchange.request.bodySizeBytes,
        exchange.request.bodySha256,
        exchange.response.bodySha256,
        exchange.request.rawBodyRef?.storage ?? "inline",
        exchange.capturedAt,
      ) as number;
      fixture.db.prepare(
        "UPDATE raw_exchange_refs SET ingestion_record_id = ? WHERE exchange_id = ?",
      ).run(ingestionId, exchange.exchangeId);
      const integrity = exchange.exchangeId === ids.integrity;
      fixture.db.prepare(
        `INSERT INTO derivation_jobs(
          ingestion_record_id, projection_version, job_status,
          projection_completeness, attempt_count, available_at,
          last_error_code, limited_dimensions_json,
          request_verification, response_verification,
          created_at, updated_at, completed_at
        ) VALUES(?, 1, ?, ?, 1, ?, ?, '[]', ?, 'verified', ?, ?, ?)`,
      ).run(
        ingestionId,
        integrity ? "permanent_error" : "succeeded",
        integrity ? "unavailable" : "complete",
        exchange.capturedAt,
        integrity ? "raw_body_integrity_failed" : null,
        integrity ? "failed" : "verified",
        exchange.capturedAt,
        exchange.capturedAt,
        exchange.capturedAt,
      );
    }
    offset += line.length;
  }
  return { fixture, ids: { ...ids }, bodies };
}

function rawExchange(
  exchangeId: string,
  sequence: number,
  body: string,
  inline: string | undefined,
  reference: RawCapturedExchangeV2["request"]["rawBodyRef"],
  bodySha256: string,
): RawCapturedExchangeV2 {
  const timestamp = new Date(Date.UTC(2026, 6, 22, 12, 0, sequence)).toISOString();
  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-raw-stream",
    sequence,
    capturedAt: timestamp,
    completedAt: timestamp,
    durationMs: 10,
    routing: {
      targetId: "target-raw",
      targetName: "Raw Target",
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1:3211/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: {
      headers: { "content-type": "application/json" },
      rawBody: inline,
      rawBodyRef: reference,
      bodySizeBytes: Buffer.byteLength(body),
      bodySha256,
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      rawBody: "{}",
      rawBodyRef: {
        storage: "inline",
        encoding: "identity",
        sha256: sha256("{}"),
        sizeBytes: 2,
      },
      bodySizeBytes: 2,
      bodySha256: sha256("{}"),
      isStreaming: false,
    },
    bodyStorage: {
      policy: reference?.storage ?? "inline",
      compression: reference?.encoding === "gzip" ? "gzip" : undefined,
      externalBlobDir: reference?.storage === "external-blob" ? "blobs" : undefined,
    },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function localRequest(path: string, headers: HeadersInit = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
