import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import {
  ExportContentStreamError,
  iterateExportContentEvents,
  type ExportContentEvent,
} from "../src/lib/export-content-events.js";
import {
  loadExportConversation,
  preflightFullExport,
  renderExportConversationDownload,
} from "../src/lib/export-conversation.js";
import { conversationFingerprintKey } from "../src/lib/conversation-semantics/index.js";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import { discoverV2Sources } from "../src/lib/ingestion/raw-source-reader.js";
import { getDeepaaDatabase } from "../src/lib/db/connection.js";
import {
  acquireExplicitRawLease,
  getExplicitRawLeaseMetrics,
  resetExplicitRawLeasesForTests,
} from "../src/lib/explicit-raw-lease.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures) {
    const db = getDeepaaDatabase(fixture.dataDir);
    if (db.open && db !== fixture.db) db.close();
  }
  resetExplicitRawLeasesForTests();
  delete process.env.DEEPAA_DATA_DIR;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

test("当前页事件流完整输出长文本并把 Base64 转换为有界描述符", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const binaryA = Buffer.from("image-a".repeat(1_000));
  const binaryB = Buffer.from("image-b".repeat(1_500));
  const longTail = `完整尾部-${"流式长文本".repeat(5_000)}`;
  const visibleText = [
    "开头",
    `data:image/png;base64,${binaryA.toString("base64")}`,
    "中间",
    `data:image/jpeg;base64,${binaryB.toString("base64")}`,
    longTail,
  ].join(" ");
  const seeded = await seedContentExchange(fixture, visibleText);
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      scope: "all",
      categories: [],
      exchangeLimit: 5,
      pageMaxBytes: 32 * 1024 * 1024,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.candidateCount, 1);
  assert.equal(pageStart.visibleProcessedCount, 1);
  assert.equal(pageStart.baselineProcessedCount, 0);
  assert.deepEqual(pageStart.visibleExchangeIds, [seeded.exchangeId]);
  assert.equal(pageStart.contentCompleteness, "complete");

  const text = events
    .filter((event): event is Extract<ExportContentEvent, { type: "text_chunk" }> =>
      event.type === "text_chunk")
    .map((event) => event.value)
    .join("");
  assert.match(text, new RegExp(longTail));
  assert.doesNotMatch(text, /data:image\/(?:png|jpeg);base64,/u);
  assert.doesNotMatch(text, /\[media\s/u);
  assert.equal(text.includes(binaryA.toString("base64").slice(100, 500)), false);
  assert.ok(events
    .filter((event): event is Extract<ExportContentEvent, { type: "text_chunk" }> =>
      event.type === "text_chunk")
    .every((event) => Buffer.byteLength(event.value) <= 16 * 1024));
  const descriptors = events.filter(
    (event): event is Extract<ExportContentEvent, { type: "media_descriptor" }> =>
      event.type === "media_descriptor",
  );
  assert.equal(descriptors.length, 2);
  assert.deepEqual(descriptors.map((item) => item.mediaType), ["image/png", "image/jpeg"]);
  assert.ok(events.some((event) => event.type === "page_end"));
  assert.equal(JSON.stringify(events).includes(binaryB.toString("base64").slice(200, 600)), false);
});

test("Exchange 开始事件携带 SQLite 已有的 HTTP 状态、耗时和有界诊断码", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedContentExchange(fixture, "状态元数据");
  fixture.db.prepare(
    `UPDATE raw_exchange_refs
     SET status = 502, completed_at = '2026-07-22T12:00:30.006Z'
     WHERE exchange_id = ?`,
  ).run(seeded.exchangeId);
  fixture.db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, code, severity, message, details_json, created_at
    ) VALUES(?, 'connection_error', 'warning', 'fixture', '{}',
      '2026-07-22T12:00:30.006Z')`,
  ).run(seeded.exchangeId);
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      scope: "all",
      categories: [],
      exchangeLimit: 5,
      pageMaxBytes: 32 * 1024 * 1024,
    },
  })) events.push(event);

  const exchangeStart = events.find(
    (event): event is Extract<ExportContentEvent, { type: "exchange_start" }> =>
      event.type === "exchange_start",
  );
  assert.ok(exchangeStart);
  assert.equal(exchangeStart.httpStatus, 502);
  assert.equal(exchangeStart.durationMs, 30_006);
  assert.deepEqual(exchangeStart.diagnosticCodes, ["connection_error"]);
});

test("图片媒体 Route 按 SQLite 描述符精确流式返回原始字节", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const binary = Buffer.from("explicit-image-".repeat(2_000));
  const requestText = `图片 data:image/png;base64,${binary.toString("base64")} 结束`;
  const seeded = await seedContentExchange(fixture, requestText);
  const requestBody = JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content: requestText }],
  });
  insertMediaDescriptor(fixture, {
    exchangeId: seeded.exchangeId,
    ordinal: 0,
    mediaType: "image/png",
    encodedBytes: binary.toString("base64").length,
    decodedBytes: binary.length,
    sha256: sha256(binary),
    rawBodySha256: sha256(requestBody),
  });
  process.env.DEEPAA_DATA_DIR = fixture.dataDir;
  const route = await import(
    "../src/app/api/exchanges/[exchangeId]/media/[side]/[ordinal]/route.js"
  ).catch(() => undefined);

  assert.ok(route, "图片媒体 Route 尚未实现");
  const response = await route.GET(
    localRequest(`/api/exchanges/${seeded.exchangeId}/media/request/0`),
    {
      params: Promise.resolve({
        exchangeId: seeded.exchangeId,
        side: "request",
        ordinal: "0",
      }),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-length"), String(binary.length));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value);
  assert.ok(first.value.byteLength < binary.length);
  const chunks = [Buffer.from(first.value)];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(Buffer.from(next.value));
  }
  const decoded = Buffer.concat(chunks);
  assert.deepEqual(decoded, binary);
  assert.equal(sha256(decoded), sha256(binary));
});

test("图片媒体 Route 拒绝无效定位、非图片、身份不一致和非同源请求", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const binary = Buffer.from("guarded-image");
  const requestText = `data:image/png;base64,${binary.toString("base64")}`;
  const seeded = await seedContentExchange(fixture, requestText);
  const requestBody = JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content: requestText }],
  });
  insertMediaDescriptor(fixture, {
    exchangeId: seeded.exchangeId,
    ordinal: 0,
    mediaType: "image/png",
    encodedBytes: binary.toString("base64").length,
    decodedBytes: binary.length,
    sha256: sha256(binary),
    rawBodySha256: sha256(requestBody),
  });
  process.env.DEEPAA_DATA_DIR = fixture.dataDir;
  const route = await import(
    "../src/app/api/exchanges/[exchangeId]/media/[side]/[ordinal]/route.js"
  );
  const call = (
    side: string,
    ordinal: string,
    request = localRequest(
      `/api/exchanges/${seeded.exchangeId}/media/${side}/${ordinal}`,
    ),
  ) => route.GET(request, {
    params: Promise.resolve({ exchangeId: seeded.exchangeId, side, ordinal }),
  });

  assert.equal((await call("invalid", "0")).status, 400);
  assert.equal((await call("request", "-1")).status, 400);
  assert.equal((await call("request", "256")).status, 400);
  assert.equal((await call("request", "1")).status, 404);
  assert.equal((await call(
    "request",
    "0",
    new Request(
      `http://example.test/api/exchanges/${seeded.exchangeId}/media/request/0`,
    ),
  )).status, 403);
  assert.equal((await call(
    "request",
    "0",
    localRequest(
      `/api/exchanges/${seeded.exchangeId}/media/request/0`,
      { range: "bytes=0-10" },
    ),
  )).status, 416);

  fixture.db.prepare(
    "UPDATE exchange_media_descriptors SET media_type = 'application/pdf' WHERE exchange_id = ?",
  ).run(seeded.exchangeId);
  assert.equal((await call("request", "0")).status, 415);

  fixture.db.prepare(
    `UPDATE exchange_media_descriptors
     SET media_type = 'image/png', raw_body_sha256 = ?
     WHERE exchange_id = ?`,
  ).run("0".repeat(64), seeded.exchangeId);
  const mismatch = await call("request", "0");
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), {
    error: {
      code: "raw_media_source_mismatch",
      message: "图片描述符与当前 Raw 正文身份不一致。",
    },
  });
});

test("取消图片媒体流会立即关闭 Raw 并释放共享并发额度", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const binary = Buffer.from("cancel-image-".repeat(3_000));
  const requestText = `data:image/png;base64,${binary.toString("base64")}`;
  const seeded = await seedContentExchange(fixture, requestText);
  const requestBody = JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content: requestText }],
  });
  insertMediaDescriptor(fixture, {
    exchangeId: seeded.exchangeId,
    ordinal: 0,
    mediaType: "image/png",
    encodedBytes: binary.toString("base64").length,
    decodedBytes: binary.length,
    sha256: sha256(binary),
    rawBodySha256: sha256(requestBody),
  });
  process.env.DEEPAA_DATA_DIR = fixture.dataDir;
  const route = await import(
    "../src/app/api/exchanges/[exchangeId]/media/[side]/[ordinal]/route.js"
  );
  const response = await route.GET(
    localRequest(`/api/exchanges/${seeded.exchangeId}/media/request/0`),
    {
      params: Promise.resolve({
        exchangeId: seeded.exchangeId,
        side: "request",
        ordinal: "0",
      }),
    },
  );
  const reader = response.body!.getReader();

  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(getExplicitRawLeaseMetrics().active, 1);
  await reader.cancel();
  assert.equal(getExplicitRawLeaseMetrics().active, 0);
});

test("首条可见 Exchange 超过预算时在打开 Raw 前失败", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedContentExchange(fixture, "小正文");
  fixture.db.prepare(
    `UPDATE raw_exchange_refs
     SET request_body_bytes = ?, response_body_bytes = 0
     WHERE exchange_id = ?`,
  ).run(40 * 1024 * 1024, seeded.exchangeId);
  fixture.db.prepare(
    "UPDATE ingestion_sources SET relative_path = 'captures/v2/does-not-exist.jsonl'",
  ).run();

  const iterator = iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      scope: "all",
      categories: [],
      exchangeLimit: 5,
      pageMaxBytes: 32 * 1024 * 1024,
    },
  });

  await assert.rejects(iterator.next(), (error: unknown) => {
    assert.ok(error instanceof ExportContentStreamError);
    assert.equal(error.code, "oversized_visible_exchange");
    assert.equal(error.exchangeId, seeded.exchangeId);
    assert.equal(error.requiredBytes, 40 * 1024 * 1024);
    return true;
  });
});

test("用户确认超预算 Exchange 后只流式加载当前游标下该条记录", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedContentExchange(fixture, "确认后完整正文");
  const requiredBytes = 40 * 1024 * 1024;
  fixture.db.prepare(
    `UPDATE raw_exchange_refs
     SET request_body_bytes = ?, response_body_bytes = 0
     WHERE exchange_id = ?`,
  ).run(requiredBytes, seeded.exchangeId);
  process.env.DEEPAA_DATA_DIR = fixture.dataDir;
  const route = await import("../src/app/api/export/content/route.js");
  const query = new URLSearchParams({
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    exchangeLimit: "5",
    pageMaxBytes: String(32 * 1024 * 1024),
  });
  const requestFor = (params: URLSearchParams) => new Request(
    `http://localhost/api/export/content?${params}`,
    { headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } },
  );

  const blocked = await route.GET(requestFor(query));
  assert.equal(blocked.status, 413);
  assert.deepEqual(await blocked.json(), {
    error: {
      code: "oversized_visible_exchange",
      message: `Exchange ${seeded.exchangeId} 需要 ${requiredBytes} 字节。`,
      exchangeId: seeded.exchangeId,
      requiredBytes,
    },
  });

  query.set("confirmedOversizedExchangeId", seeded.exchangeId);
  const confirmed = await route.GET(requestFor(query));
  assert.equal(confirmed.status, 200);
  const events = (await confirmed.text()).trim().split("\n")
    .map((line) => JSON.parse(line) as ExportContentEvent);
  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.visibleExchangeLimit, 1);
  assert.deepEqual(pageStart.visibleExchangeIds, [seeded.exchangeId]);

  query.set("confirmedOversizedExchangeId", "exchange-other");
  const changed = await route.GET(requestFor(query));
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), {
    error: {
      code: "oversized_exchange_changed",
      message: "待确认的超大 Exchange 已不在当前页首位，请刷新后重试。",
    },
  });
});

test("多 Thread 独立消耗重复基线且单 Thread fallback 故障不影响其他 Thread", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedMultiThreadContent(fixture);
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      start: "2026-07-22T12:02:00.000Z",
      scope: "all",
      side: "request",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 5,
      pageMaxBytes: 32 * 1024 * 1024,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadA], "sqlite_fingerprint");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadB], "unavailable");
  const itemEnds = events.filter(
    (event): event is Extract<ExportContentEvent, { type: "item_end" }> =>
      event.type === "item_end",
  );
  assert.deepEqual(
    itemEnds.filter((event) => event.exchangeId === seeded.visibleA)
      .map((event) => event.stepDiff),
    ["inherited", "inherited", "unique"],
  );
  assert.deepEqual(
    itemEnds.filter((event) => event.exchangeId === seeded.visibleB)
      .map((event) => event.stepDiff),
    ["unconfirmed", "unconfirmed"],
  );
});

test("多 Thread 的基线 Request 共享页面级 128 MiB 硬上限", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedMultiThreadContent(fixture);
  fixture.db.prepare(
    `UPDATE exchange_content_previews
     SET preview_state = 'limited', candidate_count_exact = 0
     WHERE exchange_id = 'exchange-content-a-1'`,
  ).run();
  fixture.db.prepare(
    `UPDATE raw_exchange_refs
     SET request_body_bytes = ?
     WHERE exchange_id IN ('exchange-content-a-1', 'exchange-content-b-1')`,
  ).run(70 * 1024 * 1024);
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      start: "2026-07-22T12:02:00.000Z",
      scope: "all",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 5,
      pageMaxBytes: 32 * 1024 * 1024,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.baselineProcessedCount, 2);
  assert.equal(pageStart.baselineRawBytes, 70 * 1024 * 1024);
  assert.equal(
    pageStart.dedupeDetailsByThread[seeded.threadA]?.failureCode,
    "baseline_raw_budget_exceeded",
  );
  assert.equal(
    pageStart.dedupeDetailsByThread[seeded.threadB]?.failureCode,
    "raw_body_unavailable",
  );
});

test("相邻 Request 损坏时继续回溯到最近完整 Request 且不受页面预算限制", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedBaselineRecoveryContent(fixture, "malformed_middle");
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      start: seeded.visibleTimestamp,
      scope: "all",
      side: "request",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: seeded.visibleRawBytes,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadId], "raw_fallback");
  assert.equal(pageStart.baselineProcessedCount, 2);
  assert.equal(pageStart.baselineRawBytes, seeded.expectedBaselineRequestBytes);
  assert.equal(pageStart.visibleProcessedCount, 1);
  assert.equal(pageStart.limitedByBytes, false);
  assert.deepEqual(pageStart.dedupeDetailsByThread[seeded.threadId], {
    status: "raw_fallback",
    affectedExchangeId: seeded.visibleExchangeId,
    selectedBaselineExchangeId: seeded.oldExchangeId,
    attemptedBaselineCount: 2,
    skippedBaselineCount: 1,
    lastSkippedExchangeId: seeded.middleExchangeId,
    failureCode: "request_parse_failed",
  });
  assert.deepEqual(
    events.filter(
      (event): event is Extract<ExportContentEvent, { type: "item_end" }> =>
        event.type === "item_end" && event.exchangeId === seeded.visibleExchangeId,
    ).map((event) => event.stepDiff),
    ["inherited", "unique"],
  );
});

test("合法 Request 即使 Response 为 502 仍直接参与上下文排重", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedBaselineRecoveryContent(fixture, "valid_502_baseline");
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      start: seeded.visibleTimestamp,
      scope: "all",
      side: "request",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: seeded.visibleRawBytes,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadId], "raw_fallback");
  assert.equal(pageStart.baselineProcessedCount, 1);
  assert.equal(pageStart.baselineRawBytes, seeded.expectedBaselineRequestBytes);
  assert.equal(
    pageStart.dedupeDetailsByThread[seeded.threadId]?.selectedBaselineExchangeId,
    seeded.middleExchangeId,
  );
  assert.equal(
    pageStart.dedupeDetailsByThread[seeded.threadId]?.attemptedBaselineCount,
    1,
  );
  assert.deepEqual(
    events.filter(
      (event): event is Extract<ExportContentEvent, { type: "item_end" }> =>
        event.type === "item_end" && event.exchangeId === seeded.visibleExchangeId,
    ).map((event) => event.stepDiff),
    ["inherited", "unique"],
  );
});

test("完整 Request 基线按最终类别识别并排重 Agent 注入上下文", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedBaselineRecoveryContent(fixture, "valid_502_baseline");
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      start: seeded.visibleTimestamp,
      scope: "all",
      side: "request",
      categories: ["user_injected"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: seeded.visibleRawBytes,
    },
  })) events.push(event);

  assert.deepEqual(
    events.filter(
      (event): event is Extract<ExportContentEvent, { type: "item_end" }> =>
        event.type === "item_end" && event.exchangeId === seeded.visibleExchangeId,
    ).map((event) => event.stepDiff),
    ["inherited"],
  );
});

test("基线 Request 独立硬上限在 Raw 打开前生效并保留未确认输入", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedBaselineRecoveryContent(fixture, "valid_502_baseline");
  fixture.db.prepare(
    "UPDATE raw_exchange_refs SET request_body_bytes = ? WHERE exchange_id = ?",
  ).run(128 * 1024 * 1024 + 1, seeded.middleExchangeId);
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      start: seeded.visibleTimestamp,
      scope: "all",
      side: "request",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: seeded.visibleRawBytes,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadId], "unavailable");
  assert.equal(pageStart.baselineProcessedCount, 1);
  assert.equal(pageStart.baselineRawBytes, 0);
  assert.deepEqual(pageStart.dedupeDetailsByThread[seeded.threadId], {
    status: "unavailable",
    affectedExchangeId: seeded.visibleExchangeId,
    attemptedBaselineCount: 1,
    skippedBaselineCount: 1,
    lastSkippedExchangeId: seeded.middleExchangeId,
    failureCode: "baseline_raw_budget_exceeded",
  });
  assert.deepEqual(
    events.filter(
      (event): event is Extract<ExportContentEvent, { type: "item_end" }> =>
        event.type === "item_end" && event.exchangeId === seeded.visibleExchangeId,
    ).map((event) => event.stepDiff),
    ["unconfirmed", "unconfirmed"],
  );
});

test("跨 compaction 内容流优先消费 SQLite boundary_carryover 而不重读基线 Raw", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedBaselineRecoveryContent(fixture, "valid_502_baseline");
  const historyFingerprint = conversationFingerprintKey({
    category: "user_real",
    side: "input",
    provenance: "physical_user",
    providerItemType: "content",
    textSha256: sha256("历史输入"),
    contentKinds: ["text"],
  });
  fixture.db.prepare(
    `UPDATE exchange_content_filter_status
     SET projection_version = 7,
       filter_state = 'complete',
       request_filter_state = 'complete',
       response_filter_state = 'complete',
       request_dedupe_state = 'compared',
       request_context_mode = 'full_replay',
       request_comparison_kind = 'boundary_carryover',
       request_context_epoch = 1,
       effective_context_boundary_id = 'boundary:test',
       baseline_exchange_id = ?
     WHERE exchange_id = ?`,
  ).run(seeded.middleExchangeId, seeded.visibleExchangeId);
  fixture.db.prepare(
    "UPDATE exchange_content_filter_status SET projection_version = 7 WHERE exchange_id = ?",
  ).run(seeded.middleExchangeId);
  fixture.db.prepare(
    `INSERT INTO exchange_request_fingerprints(
      exchange_id, body_side, category, fingerprint,
      provider_lineage_key, occurrence_count
    ) VALUES(?, 'request', 'user_real', ?, '', 1)`,
  ).run(seeded.middleExchangeId, fingerprintBlob(historyFingerprint));
  fixture.db.prepare(
    "UPDATE raw_exchange_refs SET request_body_bytes = ? WHERE exchange_id = ?",
  ).run(128 * 1024 * 1024 + 1, seeded.middleExchangeId);

  const events: ExportContentEvent[] = [];
  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      start: seeded.visibleTimestamp,
      scope: "all",
      side: "request",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: seeded.visibleRawBytes,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadId], "sqlite_fingerprint");
  assert.equal(pageStart.baselineRawBytes, 0);
  assert.deepEqual(
    events.filter(
      (event): event is Extract<ExportContentEvent, { type: "item_end" }> =>
        event.type === "item_end" && event.exchangeId === seeded.visibleExchangeId,
    ).map(event => event.stepDiff),
    ["inherited", "unique"],
  );
});

test("持久化 unconfirmed 时回退读取同 Thread 基线，而不是报告零候选", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedBaselineRecoveryContent(fixture, "valid_502_baseline");
  fixture.db.prepare(
    `UPDATE exchange_content_filter_status
     SET projection_version = 4,
       request_filter_state = 'complete',
       request_dedupe_state = 'unconfirmed',
       request_comparison_kind = 'none',
       request_context_epoch = NULL,
       baseline_exchange_id = NULL
     WHERE exchange_id = ?`,
  ).run(seeded.visibleExchangeId);

  const events: ExportContentEvent[] = [];
  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      start: seeded.visibleTimestamp,
      scope: "all",
      side: "request",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: 32 * 1024 * 1024,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadId], "raw_fallback");
  assert.equal(pageStart.dedupeDetailsByThread[seeded.threadId]?.attemptedBaselineCount, 1);
  assert.notEqual(pageStart.dedupeDetailsByThread[seeded.threadId]?.failureCode, "context_unconfirmed");
});

test("跨 compaction 普通 Preview 与完整下载都继承三个无 ID 旧输入", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const retainedInputs = ["旧输入 A", "旧输入 B", "确认，请实现！"];
  const seeded = await seedBaselineRecoveryContent(
    fixture,
    "valid_502_baseline",
    {
      baselineMessages: [
        ...retainedInputs,
        "You are performing a CONTEXT CHECKPOINT COMPACTION.",
      ],
      visibleMessages: retainedInputs,
    },
  );
  fixture.db.prepare(
    `UPDATE exchange_content_filter_status
     SET projection_version = 7,
       filter_state = 'complete',
       request_filter_state = 'complete',
       response_filter_state = 'complete',
       request_dedupe_state = 'compared',
       request_context_mode = 'full_replay',
       request_comparison_kind = 'boundary_carryover',
       request_context_epoch = 1,
       effective_context_boundary_id = 'boundary:ex-148',
       baseline_exchange_id = ?
     WHERE exchange_id = ?`,
  ).run(seeded.middleExchangeId, seeded.visibleExchangeId);
  fixture.db.prepare(
    "UPDATE exchange_content_filter_status SET projection_version = 7 WHERE exchange_id = ?",
  ).run(seeded.middleExchangeId);
  const insertFingerprint = fixture.db.prepare(
    `INSERT INTO exchange_request_fingerprints(
      exchange_id, body_side, category, fingerprint,
      provider_lineage_key, occurrence_count
    ) VALUES(?, 'request', 'user_real', ?, '', 1)`,
  );
  for (const text of retainedInputs) {
    insertFingerprint.run(
      seeded.middleExchangeId,
      fingerprintBlob(conversationFingerprintKey({
        category: "user_real",
        side: "input",
        provenance: "physical_user",
        providerItemType: "content",
        textSha256: sha256(text),
        contentKinds: ["text"],
      })),
    );
  }
  fixture.db.prepare(
    "UPDATE raw_exchange_refs SET request_body_bytes = ? WHERE exchange_id = ?",
  ).run(128 * 1024 * 1024 + 1, seeded.middleExchangeId);

  let previewRawReads = 0;
  const filters = {
    session: seeded.sessionId,
    thread: seeded.threadId,
    start: seeded.visibleTimestamp,
    scope: "all" as const,
      side: "request",
    categories: ["user_real" as const],
    categoriesExplicit: true,
    includeInherited: true,
    exchangeLimit: 1,
    pageMaxBytes: 1024 * 1024,
  };
  const preview = await loadExportConversation(
    fixture.dataDir,
    filters,
    {
      db: fixture.db,
      rawReader: async () => {
        previewRawReads += 1;
        throw new Error("普通 Preview 不得读取 Raw");
      },
    },
  );

  assert.equal(previewRawReads, 0);
  assert.deepEqual(
    preview.items.map(item => item.text).sort(),
    [...retainedInputs].sort(),
  );
  assert.ok(preview.items.every(item => item.stepDiff === "inherited"));
  assert.equal(preview.page?.baselineBytes, 0);

  const preflight = await preflightFullExport(
    fixture.dataDir,
    filters,
    { db: fixture.db },
  );
  assert.equal(preflight.ok, true);
  const chunks: string[] = [];
  for await (const chunk of renderExportConversationDownload(
    fixture.dataDir,
    filters,
    "json",
    preflight,
    { db: fixture.db },
  )) chunks.push(chunk);
  const download = JSON.parse(chunks.join("")) as Array<{
    text: string;
    stepDiff: string;
    contentSource: string;
  }>;
  assert.deepEqual(
    download.map(item => ({
      text: item.text,
      stepDiff: item.stepDiff,
      contentSource: item.contentSource,
    })),
    retainedInputs.map(text => ({
      text,
      stepDiff: "inherited",
      contentSource: "raw_stream",
    })),
  );
});

test("持久化 same_epoch 指纹消费时消息 id 不导致继承项误判为新增", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedPersistedSameEpochMessageIds(fixture);
  const events: ExportContentEvent[] = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      start: seeded.visibleTimestamp,
      scope: "all",
      categories: [],
      exchangeLimit: 5,
      pageMaxBytes: 32 * 1024 * 1024,
    },
  })) events.push(event);

  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  assert.equal(pageStart.dedupeStatusByThread[seeded.threadId], "sqlite_fingerprint");
  assert.equal(pageStart.baselineRawBytes, 0);
  assert.deepEqual(
    events.filter(
      (event): event is Extract<ExportContentEvent, { type: "item_end" }> =>
        event.type === "item_end" && event.exchangeId === seeded.visibleExchangeId,
    ).map(event => event.stepDiff),
    ["inherited", "inherited", "inherited", "unique", "unique"],
  );
});

test("categories 只选输入侧类别时输出侧 item 不被过滤", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedCategoryFilterContent(fixture);
  const starts: Array<{ side: string; category: string }> = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      scope: "all",
      categories: ["user_real"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: 1024 * 1024,
    },
  })) {
    if (event.type === "item_start") {
      starts.push({ side: event.side, category: event.category });
    }
  }

  assert.deepEqual(starts, [
    { side: "input", category: "user_real" },
    { side: "output", category: "assistant" },
  ]);
});

test("categories 只选输出侧类别时输入侧 item 不被过滤", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedCategoryFilterContent(fixture);
  const starts: Array<{ side: string; category: string }> = [];

  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      session: seeded.sessionId,
      thread: seeded.threadId,
      scope: "all",
      categories: ["assistant"],
      categoriesExplicit: true,
      exchangeLimit: 1,
      pageMaxBytes: 1024 * 1024,
    },
  })) {
    if (event.type === "item_start") {
      starts.push({ side: event.side, category: event.category });
    }
  }

  assert.deepEqual(starts, [
    { side: "input", category: "system" },
    { side: "input", category: "user_real" },
    { side: "output", category: "assistant" },
  ]);
});

test("side 在当前页 Raw 事件与完整下载中使用同一方向语义", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedContentExchange(fixture, "只属于 Input 的正文");
  const itemSides = async (side: "request" | "response") => {
    const sides: string[] = [];
    for await (const event of iterateExportContentEvents({
      db: fixture.db,
      dataDir: fixture.dataDir,
      filters: {
        session: seeded.sessionId,
        thread: seeded.threadId,
        scope: "all",
        side,
        categories: [],
        exchangeLimit: 1,
        pageMaxBytes: 1024 * 1024,
      },
    })) {
      if (event.type === "item_start") sides.push(event.side);
    }
    return sides;
  };

  assert.deepEqual(await itemSides("request"), ["input"]);
  assert.deepEqual(await itemSides("response"), ["output"]);

  const filters = {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all" as const,
    side: "response" as const,
    categories: [],
    exchangeLimit: 1,
    pageMaxBytes: 1024 * 1024,
  };
  const preflight = await preflightFullExport(
    fixture.dataDir,
    filters,
    { db: fixture.db },
  );
  const chunks: string[] = [];
  for await (const chunk of renderExportConversationDownload(
    fixture.dataDir,
    filters,
    "json",
    preflight,
    { db: fixture.db },
  )) chunks.push(chunk);
  const output = JSON.parse(chunks.join("")) as Array<{
    side: string;
    text: string;
  }>;

  assert.ok(output.length > 0);
  assert.ok(output.every(item => item.side === "output"));
  assert.ok(output.every(item => !item.text.includes("只属于 Input 的正文")));
});

test("内容 Route 使用安全 NDJSON 流并与其他 Raw 入口共享并发额度", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedContentExchange(fixture, `Route 正文-${"完整".repeat(5_000)}`);
  process.env.DEEPAA_DATA_DIR = fixture.dataDir;
  const route = await import("../src/app/api/export/content/route.js");
  const query = new URLSearchParams({
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    exchangeLimit: "5",
    pageMaxBytes: String(32 * 1024 * 1024),
  });
  const request = new Request(`http://localhost/api/export/content?${query}`, {
    headers: {
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
  });

  const response = await route.GET(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  const lines = (await response.text()).trim().split("\n");
  assert.ok(lines.length > 3);
  assert.equal((JSON.parse(lines[0]!) as ExportContentEvent).type, "page_start");
  assert.equal((JSON.parse(lines.at(-1)!) as ExportContentEvent).type, "page_end");

  const first = acquireExplicitRawLease();
  const second = acquireExplicitRawLease();
  const busy = await route.GET(request);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "1");
  assert.deepEqual(await busy.json(), {
    error: {
      code: "raw_stream_busy",
      message: "完整 Raw 流并发已达上限，请稍后重试。",
    },
  });
  first?.release();
  second?.release();
});

type BaselineRecoveryMode = "malformed_middle" | "valid_502_baseline";

async function seedBaselineRecoveryContent(
  fixture: SqliteFixture,
  mode: BaselineRecoveryMode,
  options?: {
    baselineMessages?: string[];
    visibleMessages?: string[];
  },
): Promise<{
  sessionId: string;
  threadId: string;
  visibleExchangeId: string;
  visibleTimestamp: string;
  visibleRawBytes: number;
  expectedBaselineRequestBytes: number;
  oldExchangeId: string;
  middleExchangeId: string;
}> {
  const sessionId = `asess-baseline-${mode}`;
  const threadId = `athread-baseline-${mode}`;
  const turnId = `aturn-baseline-${mode}`;
  const captureSessionId = `capture-baseline-${mode}`;
  const visibleExchangeId = `exchange-baseline-${mode}-visible`;
  const oldExchangeId = `exchange-baseline-${mode}-old`;
  const middleExchangeId = `exchange-baseline-${mode}-middle`;
  const inheritedMessages = options?.baselineMessages
    ?? ["# AGENTS.md instructions\n\n<INSTRUCTIONS>", "历史输入"];
  const old = baselineRecoveryExchange({
    captureSessionId,
    exchangeId: oldExchangeId,
    timestamp: "2026-07-24T10:00:00.000Z",
    sequence: 1,
    messages: inheritedMessages,
  });
  const middle = baselineRecoveryExchange({
    captureSessionId,
    exchangeId: middleExchangeId,
    timestamp: "2026-07-24T10:01:00.000Z",
    sequence: 2,
    messages: inheritedMessages,
    status: 502,
    rawRequest: mode === "malformed_middle"
      ? '{"model":"fixture-model","messages":[{"role":"user","content":"历史输入'
      : undefined,
    responsePaddingBytes: 16 * 1024,
  });
  const visible = baselineRecoveryExchange({
    captureSessionId,
    exchangeId: visibleExchangeId,
    timestamp: "2026-07-24T10:02:00.000Z",
    sequence: 3,
    messages: options?.visibleMessages ?? [...inheritedMessages, "新增输入"],
  });
  const rows = mode === "malformed_middle" ? [old, middle, visible] : [middle, visible];
  const fileName = `baseline-${mode}.jsonl`;
  await fixture.writeV2Lines(rows, fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const sourceId = fixture.db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path = ?",
  ).pluck().get(`captures/v2/${fileName}`) as number;
  const firstTimestamp = rows[0]!.capturedAt;
  const lastTimestamp = rows.at(-1)!.capturedAt;
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-content', 'Content Target', 'fingerprint-content',
      'codex', 'fixture', 'exact', ?, ?, ?, 1)`,
  ).run(sessionId, firstTimestamp, lastTimestamp, rows.length);
  fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', 'Root Thread', 'exact', 1, ?, ?, ?, 1)`,
  ).run(threadId, sessionId, firstTimestamp, lastTimestamp, rows.length);
  fixture.db.prepare(
    "INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth) VALUES(?, ?, 0)",
  ).run(threadId, threadId);
  fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?, ?)`,
  ).run(turnId, sessionId, threadId, rows[0]!.exchangeId, firstTimestamp, lastTimestamp, rows.length);
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'target-content', 'Content Target',
      'codex', 'fingerprint-content', 'fixture-model', ?, 0, ?, ?)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'respond', 'continue', 'complete')`,
  );
  let byteOffset = 0;
  for (const [index, exchange] of rows.entries()) {
    const lineLengthBytes = Buffer.byteLength(`${JSON.stringify(exchange)}\n`);
    insertRef.run(
      exchange.exchangeId,
      captureSessionId,
      sourceId,
      byteOffset,
      lineLengthBytes,
      exchange.capturedAt,
      exchange.completedAt,
      exchange.response.status,
      exchange.request.bodySizeBytes,
      exchange.response.bodySizeBytes,
    );
    insertStep.run(
      `astep-${exchange.exchangeId}`,
      exchange.exchangeId,
      sessionId,
      threadId,
      turnId,
      index + 1,
      exchange.capturedAt,
    );
    if (exchange === middle && mode === "malformed_middle") {
      insertEmptyLimitedPreview(fixture, exchange);
    } else {
      insertMultiThreadPreview(fixture, exchange, "limited");
    }
    byteOffset += lineLengthBytes;
  }
  return {
    sessionId,
    threadId,
    visibleExchangeId,
    visibleTimestamp: visible.capturedAt,
    visibleRawBytes: visible.request.bodySizeBytes + visible.response.bodySizeBytes,
    expectedBaselineRequestBytes: mode === "malformed_middle"
      ? old.request.bodySizeBytes + middle.request.bodySizeBytes
      : middle.request.bodySizeBytes,
    oldExchangeId,
    middleExchangeId,
  };
}

function baselineRecoveryExchange(options: {
  captureSessionId: string;
  exchangeId: string;
  timestamp: string;
  sequence: number;
  messages: string[];
  status?: number;
  rawRequest?: string;
  responsePaddingBytes?: number;
}): RawCapturedExchangeV2 {
  const base = multiThreadExchange(
    options.exchangeId,
    options.timestamp,
    options.sequence,
    options.messages,
  );
  const requestBody = options.rawRequest ?? base.request.rawBody!;
  const responseBody = options.status === 502
    ? JSON.stringify({ error: "upstream failed", padding: "x".repeat(options.responsePaddingBytes ?? 0) })
    : base.response.rawBody!;
  return {
    ...base,
    captureSessionId: options.captureSessionId,
    request: {
      ...base.request,
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: sha256(requestBody),
    },
    response: {
      ...base.response,
      status: options.status ?? 200,
      statusText: options.status === 502 ? "Bad Gateway" : "OK",
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: sha256(responseBody),
    },
  };
}

function insertEmptyLimitedPreview(
  fixture: SqliteFixture,
  exchange: RawCapturedExchangeV2,
): void {
  const preview = {
    schemaVersion: 1,
    exchangeId: exchange.exchangeId,
    projectionVersion: 4,
    protocol: "anthropic-messages",
    endpointKind: "model-call",
    conversationItems: [],
    itemCandidateCount: 0,
    itemProcessedCount: 0,
    itemCandidateCountExact: true,
    candidateTextBytes: 0,
    processedTextBytes: 0,
    diagnosticCodes: ["connection_error"],
    limitedDimensions: ["step_diff"],
    limited: true,
    truncated: true,
  };
  const previewJson = JSON.stringify(preview);
  fixture.db.prepare(
    `INSERT INTO exchange_content_previews(
      exchange_id, projection_version, preview_state, preview_json,
      size_bytes, candidate_item_count, processed_item_count,
      candidate_text_bytes, processed_text_bytes, candidate_count_exact,
      limited, truncated, limited_dimensions_json, created_at, updated_at
    ) VALUES(?, 2, 'limited', ?, ?, 0, 0, 0, 0, 1, 1, 1, '["step_diff"]', ?, ?)`,
  ).run(
    exchange.exchangeId,
    previewJson,
    Buffer.byteLength(previewJson),
    exchange.capturedAt,
    exchange.capturedAt,
  );
  insertFilterProjection(fixture, exchange, [], "limited");
}

async function seedMultiThreadContent(fixture: SqliteFixture): Promise<{
  sessionId: string;
  threadA: string;
  threadB: string;
  visibleA: string;
  visibleB: string;
}> {
  const sessionId = "asess-content-multi";
  const threadA = "athread-content-a";
  const threadB = "athread-content-b";
  const visibleA = "exchange-content-a-2";
  const visibleB = "exchange-content-b-2";
  const rows = [
    {
      exchange: multiThreadExchange(
        "exchange-content-a-1",
        "2026-07-22T12:00:00.000Z",
        1,
        ["A 重复上下文", "A 重复上下文"],
      ),
      threadId: threadA,
      turnId: "aturn-content-a",
      stepIndex: 1,
      previewState: "complete" as const,
    },
    {
      exchange: multiThreadExchange(
        "exchange-content-b-1",
        "2026-07-22T12:01:00.000Z",
        2,
        ["B 继承上下文"],
        true,
      ),
      threadId: threadB,
      turnId: "aturn-content-b",
      stepIndex: 1,
      previewState: "limited" as const,
    },
    {
      exchange: multiThreadExchange(
        visibleA,
        "2026-07-22T12:02:00.000Z",
        3,
        ["A 重复上下文", "A 重复上下文", "A 重复上下文"],
      ),
      threadId: threadA,
      turnId: "aturn-content-a",
      stepIndex: 2,
      previewState: "complete" as const,
    },
    {
      exchange: multiThreadExchange(
        visibleB,
        "2026-07-22T12:03:00.000Z",
        4,
        ["B 继承上下文", "B 新增内容"],
      ),
      threadId: threadB,
      turnId: "aturn-content-b",
      stepIndex: 2,
      previewState: "complete" as const,
    },
  ];
  const fileName = "content-multi-thread.jsonl";
  await fixture.writeV2Lines(rows.map((row) => row.exchange), fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const sourceId = fixture.db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path = ?",
  ).pluck().get(`captures/v2/${fileName}`) as number;
  const firstTimestamp = rows[0]!.exchange.capturedAt;
  const lastTimestamp = rows.at(-1)!.exchange.capturedAt;
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-content', 'Content Target', 'fingerprint-content',
      'codex', 'fixture', 'exact', ?, ?, 4, 2)`,
  ).run(sessionId, firstTimestamp, lastTimestamp);
  const insertThread = fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', ?, 'exact', 1, ?, ?, 2, 1)`,
  );
  const insertTurn = fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?, 2)`,
  );
  for (const [threadId, turnId, label, startExchangeId] of [
    [threadA, "aturn-content-a", "Thread A", "exchange-content-a-1"],
    [threadB, "aturn-content-b", "Thread B", "exchange-content-b-1"],
  ] as const) {
    insertThread.run(threadId, sessionId, label, firstTimestamp, lastTimestamp);
    fixture.db.prepare(
      "INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth) VALUES(?, ?, 0)",
    ).run(threadId, threadId);
    insertTurn.run(
      turnId,
      sessionId,
      threadId,
      startExchangeId,
      firstTimestamp,
      lastTimestamp,
    );
  }
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-content-multi', ?, ?, ?, ?, ?, 'target-content',
      'Content Target', 'codex', 'fingerprint-content', 'fixture-model', 200, 0, ?, ?)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'respond', 'continue', 'complete')`,
  );
  let byteOffset = 0;
  for (const row of rows) {
    const lineLengthBytes = Buffer.byteLength(`${JSON.stringify(row.exchange)}\n`);
    insertRef.run(
      row.exchange.exchangeId,
      sourceId,
      byteOffset,
      lineLengthBytes,
      row.exchange.capturedAt,
      row.exchange.completedAt,
      row.exchange.request.bodySizeBytes,
      row.exchange.response.bodySizeBytes,
    );
    insertStep.run(
      `astep-${row.exchange.exchangeId}`,
      row.exchange.exchangeId,
      sessionId,
      row.threadId,
      row.turnId,
      row.stepIndex,
      row.exchange.capturedAt,
    );
    insertMultiThreadPreview(
      fixture,
      row.exchange,
      row.previewState,
    );
    byteOffset += lineLengthBytes;
  }
  return { sessionId, threadA, threadB, visibleA, visibleB };
}

function multiThreadExchange(
  exchangeId: string,
  timestamp: string,
  sequence: number,
  messages: string[],
  missingRequestBlob = false,
): RawCapturedExchangeV2 {
  const requestBody = JSON.stringify({
    model: "fixture-model",
    messages: messages.map((content) => ({ role: "user", content })),
  });
  const responseText = `回答 ${exchangeId}`;
  const responseBody = JSON.stringify({
    type: "message",
    content: [{ type: "text", text: responseText }],
  });
  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-content-multi",
    sequence,
    capturedAt: timestamp,
    completedAt: timestamp,
    durationMs: 10,
    routing: {
      targetId: "target-content",
      targetName: "Content Target",
      targetFormatHint: "anthropic",
      localUrl: "http://127.0.0.1:3211/v1/messages",
      upstreamUrl: "https://example.test/v1/messages",
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      method: "POST",
    },
    request: {
      headers: {},
      rawBody: missingRequestBlob ? undefined : requestBody,
      rawBodyRef: missingRequestBlob ? {
        storage: "external-blob",
        encoding: "gzip",
        sha256: sha256(requestBody),
        sizeBytes: Buffer.byteLength(requestBody),
        compressedSizeBytes: 1,
        externalPath: `blobs/missing/${exchangeId}.body.gz`,
      } : undefined,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: sha256(requestBody),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: sha256(responseBody),
      isStreaming: false,
    },
    bodyStorage: {
      policy: missingRequestBlob ? "external-blob" : "inline",
      compression: missingRequestBlob ? "gzip" : undefined,
      externalBlobDir: missingRequestBlob ? "blobs" : undefined,
    },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function insertMultiThreadPreview(
  fixture: SqliteFixture,
  exchange: RawCapturedExchangeV2,
  previewState: "complete" | "limited",
): void {
  const requestBody = JSON.parse(
    exchange.request.rawBody
      ?? JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "B 继承上下文" }] }),
  ) as { messages: Array<{ content: string }> };
  const responseBody = JSON.parse(exchange.response.rawBody ?? "{}") as {
    content?: Array<{ text?: string }>;
  };
  const requestItems = requestBody.messages.map((message, index) => {
    const injected = message.content.trimStart().startsWith("# AGENTS.md instructions");
    return {
      side: "request" as const,
      category: "message",
      role: "user",
      itemType: "content",
      ancestorTypes: [],
      jsonPath: `$.messages[${index}].content`,
      semanticCategory: injected ? "user_injected" as const : "user_real" as const,
      provenance: injected ? "agent_injected" as const : "physical_user" as const,
      confidence: injected ? "exact" as const : "structural" as const,
      displayPolicy: "conversation" as const,
      dedupePolicy: "occurrence" as const,
      logicalId: `semantic:request:message:${index}`,
      textPreview: message.content,
      textSha256: sha256(message.content),
      originalTextBytes: Buffer.byteLength(message.content),
      previewTextBytes: Buffer.byteLength(message.content),
      truncated: false,
      mediaDescriptorOrdinals: [],
    };
  });
  const responseText = responseBody.content?.[0]?.text ?? `回答 ${exchange.exchangeId}`;
  const items = [...requestItems, {
    side: "response" as const,
    category: "message",
    role: "assistant",
    itemType: "text",
    ancestorTypes: [],
    jsonPath: "$.content[0].text",
    semanticCategory: "assistant" as const,
    provenance: "model_output" as const,
    confidence: "exact" as const,
    displayPolicy: "conversation" as const,
    dedupePolicy: "none" as const,
    logicalId: "semantic:response:message:0",
    textPreview: responseText,
    textSha256: sha256(responseText),
    originalTextBytes: Buffer.byteLength(responseText),
    previewTextBytes: Buffer.byteLength(responseText),
    truncated: false,
    mediaDescriptorOrdinals: [],
  }];
  const limited = previewState === "limited";
  const preview = {
    schemaVersion: 1,
    exchangeId: exchange.exchangeId,
    projectionVersion: 2,
    protocol: "anthropic-messages",
    endpointKind: "model-call",
    conversationItems: items,
    itemCandidateCount: items.length,
    itemProcessedCount: items.length,
    itemCandidateCountExact: true,
    candidateTextBytes: items.reduce((sum, item) => sum + item.originalTextBytes, 0),
    processedTextBytes: items.reduce((sum, item) => sum + item.previewTextBytes, 0),
    diagnosticCodes: [],
    limitedDimensions: limited ? ["request_text"] : [],
    limited,
    truncated: limited,
  };
  const previewJson = JSON.stringify(preview);
  fixture.db.prepare(
    `INSERT INTO exchange_content_previews(
      exchange_id, projection_version, preview_state, preview_json,
      size_bytes, candidate_item_count, processed_item_count,
      candidate_text_bytes, processed_text_bytes, candidate_count_exact,
      limited, truncated, limited_dimensions_json, created_at, updated_at
    ) VALUES(?, 4, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    exchange.exchangeId,
    previewState,
    previewJson,
    Buffer.byteLength(previewJson),
    items.length,
    items.length,
    preview.candidateTextBytes,
    preview.processedTextBytes,
    limited ? 1 : 0,
    limited ? 1 : 0,
    JSON.stringify(preview.limitedDimensions),
    exchange.capturedAt,
    exchange.capturedAt,
  );
  insertFilterProjection(
    fixture,
    exchange,
    requestBody.messages.map(message => message.content),
    "complete",
  );
}

function insertFilterProjection(
  fixture: SqliteFixture,
  exchange: RawCapturedExchangeV2,
  requestTexts: string[],
  filterState: "complete" | "limited",
): void {
  fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      baseline_exchange_id, request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 3, ?, ?, ?, 'not_required', 'full_replay', 'none', 0,
      NULL, ?, ?, ?)`,
  ).run(
    exchange.exchangeId,
    filterState,
    filterState,
    filterState,
    Math.min(requestTexts.length, 4_096),
    exchange.capturedAt,
    exchange.capturedAt,
  );
  if (filterState !== "complete") return;
  const categories = new Map<"user_real" | "user_injected", number>();
  for (const text of requestTexts) {
    const category = text.trimStart().startsWith("# AGENTS.md instructions")
      ? "user_injected"
      : "user_real";
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const insert = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, 'request', ?, ?, ?, 0, 0)`,
  );
  for (const [category, count] of categories) {
    insert.run(exchange.exchangeId, category, count, count);
  }
}

async function seedContentExchange(
  fixture: SqliteFixture,
  requestText: string,
): Promise<{ exchangeId: string; sessionId: string; threadId: string }> {
  const exchangeId = "exchange-content-stream";
  const sessionId = "asess-content-stream";
  const threadId = "athread-content-stream";
  const turnId = "aturn-content-stream";
  const timestamp = "2026-07-22T12:00:00.000Z";
  const requestBody = JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content: requestText }],
  });
  const responseText = "完整响应";
  const responseBody = JSON.stringify({
    type: "message",
    content: [{ type: "text", text: responseText }],
  });
  const exchange: RawCapturedExchangeV2 = {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-content-stream",
    sequence: 1,
    capturedAt: timestamp,
    completedAt: timestamp,
    durationMs: 10,
    routing: {
      targetId: "target-content",
      targetName: "Content Target",
      targetFormatHint: "anthropic",
      localUrl: "http://127.0.0.1:3211/v1/messages",
      upstreamUrl: "https://example.test/v1/messages",
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      method: "POST",
    },
    request: {
      headers: {},
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: sha256(requestBody),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: sha256(responseBody),
      isStreaming: false,
    },
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
  const fileName = "content-stream.jsonl";
  await fixture.writeV2Lines([exchange], fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const sourceId = fixture.db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path = ?",
  ).pluck().get(`captures/v2/${fileName}`) as number;
  const lineLengthBytes = Buffer.byteLength(`${JSON.stringify(exchange)}\n`);
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-content', 'Content Target', 'fingerprint-content',
      'codex', 'fixture', 'exact', ?, ?, 1, 1)`,
  ).run(sessionId, timestamp, timestamp);
  fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', 'Root Thread', 'exact', 1, ?, ?, 1, 1)`,
  ).run(threadId, sessionId, timestamp, timestamp);
  fixture.db.prepare(
    "INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth) VALUES(?, ?, 0)",
  ).run(threadId, threadId);
  fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?, 1)`,
  ).run(turnId, sessionId, threadId, exchangeId, timestamp, timestamp);
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-content-stream', ?, 0, ?, ?, ?, 'target-content',
      'Content Target', 'codex', 'fingerprint-content', 'fixture-model', 200, 0, ?, ?)`,
  ).run(
    exchangeId,
    sourceId,
    lineLengthBytes,
    timestamp,
    timestamp,
    exchange.request.bodySizeBytes,
    exchange.response.bodySizeBytes,
  );
  fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES('astep-content-stream', ?, ?, ?, ?, 1, ?, 'respond', 'continue', 'complete')`,
  ).run(exchangeId, sessionId, threadId, turnId, timestamp);
  insertPreview(fixture, exchangeId, requestText, responseText, timestamp);
  return { exchangeId, sessionId, threadId };
}

/**
 * 类别筛选测试用：openai-responses 单 Exchange，带完整 v4 投影与类别统计，
 * 使内容流按 raw 重建分类（user_real/assistant）且 SQL 规划层能命中该 Exchange。
 */
async function seedCategoryFilterContent(
  fixture: SqliteFixture,
): Promise<{ sessionId: string; threadId: string; exchangeId: string }> {
  const sessionId = "asess-category-filter";
  const threadId = "athread-category-filter";
  const turnId = "aturn-category-filter";
  const exchangeId = "exchange-category-filter";
  const timestamp = "2026-07-24T10:00:00.000Z";
  const exchange = openAiResponsesExchange({
    exchangeId,
    timestamp,
    sequence: 1,
    instructions: "系统说明",
    input: [
      {
        type: "message",
        id: "msg-user-1",
        role: "user",
        content: [{ type: "input_text", text: "真实输入" }],
      },
    ],
  });
  const fileName = "category-filter.jsonl";
  await fixture.writeV2Lines([exchange], fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const sourceId = fixture.db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path = ?",
  ).pluck().get(`captures/v2/${fileName}`) as number;
  const lineLengthBytes = Buffer.byteLength(`${JSON.stringify(exchange)}
`);
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-content', 'Content Target', 'fingerprint-content',
      'codex', 'fixture', 'exact', ?, ?, 1, 1)`,
  ).run(sessionId, timestamp, timestamp);
  fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', 'Root Thread', 'exact', 1, ?, ?, 1, 1)`,
  ).run(threadId, sessionId, timestamp, timestamp);
  fixture.db.prepare(
    "INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth) VALUES(?, ?, 0)",
  ).run(threadId, threadId);
  fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?, 1)`,
  ).run(turnId, sessionId, threadId, exchangeId, timestamp, timestamp);
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-category-filter', ?, 0, ?, ?, ?, 'target-content',
      'Content Target', 'codex', 'fingerprint-content', 'fixture-model', 200, 0, ?, ?)`,
  ).run(
    exchangeId,
    sourceId,
    lineLengthBytes,
    timestamp,
    timestamp,
    exchange.request.bodySizeBytes,
    exchange.response.bodySizeBytes,
  );
  fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES('astep-category-filter', ?, ?, ?, ?, 1, ?, 'respond', 'continue', 'complete')`,
  ).run(exchangeId, sessionId, threadId, turnId, timestamp);
  insertOpenAiResponsesCompletePreview(fixture, exchange);
  fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 4, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 0, ?, ?)`,
  ).run(exchangeId, timestamp, timestamp);
  const insertStats = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, ?, ?, ?, ?, ?, 0)`,
  );
  insertStats.run(exchangeId, "request", "user_real", 1, 1, 0);
  insertStats.run(exchangeId, "response", "assistant", 1, 1, 0);
  return { sessionId, threadId, exchangeId };
}


function insertPreview(
  fixture: SqliteFixture,
  exchangeId: string,
  requestText: string,
  responseText: string,
  timestamp: string,
): void {
  const items = [
    {
      side: "request",
      category: "message",
      role: "user",
      itemType: "content",
      jsonPath: "$.messages[0].content",
      textPreview: requestText.slice(0, 128),
      textSha256: sha256(requestText),
      originalTextBytes: Buffer.byteLength(requestText),
      previewTextBytes: Buffer.byteLength(requestText.slice(0, 128)),
      truncated: requestText.length > 128,
      mediaDescriptorOrdinals: [],
    },
    {
      side: "response",
      category: "message",
      role: "assistant",
      itemType: "text",
      jsonPath: "$.content[0].text",
      textPreview: responseText,
      textSha256: sha256(responseText),
      originalTextBytes: Buffer.byteLength(responseText),
      previewTextBytes: Buffer.byteLength(responseText),
      truncated: false,
      mediaDescriptorOrdinals: [],
    },
  ];
  const preview = {
    schemaVersion: 1,
    exchangeId,
    projectionVersion: 1,
    protocol: "anthropic-messages",
    endpointKind: "model-call",
    conversationItems: items,
    itemCandidateCount: items.length,
    itemProcessedCount: items.length,
    itemCandidateCountExact: true,
    candidateTextBytes: items.reduce((sum, item) => sum + item.originalTextBytes, 0),
    processedTextBytes: items.reduce((sum, item) => sum + item.previewTextBytes, 0),
    diagnosticCodes: [],
    limitedDimensions: [],
    limited: false,
    truncated: true,
  };
  const previewJson = JSON.stringify(preview);
  fixture.db.prepare(
    `INSERT INTO exchange_content_previews(
      exchange_id, projection_version, preview_state, preview_json,
      size_bytes, candidate_item_count, processed_item_count,
      candidate_text_bytes, processed_text_bytes, candidate_count_exact,
      limited, truncated, limited_dimensions_json, created_at, updated_at
    ) VALUES(?, 1, 'limited', ?, ?, ?, ?, ?, ?, 1, 1, 1, '["request_text"]', ?, ?)`,
  ).run(
    exchangeId,
    previewJson,
    Buffer.byteLength(previewJson),
    items.length,
    items.length,
    preview.candidateTextBytes,
    preview.processedTextBytes,
    timestamp,
    timestamp,
  );
}

function insertMediaDescriptor(
  fixture: SqliteFixture,
  input: {
    exchangeId: string;
    ordinal: number;
    mediaType: string;
    encodedBytes: number;
    decodedBytes: number;
    sha256: string;
    rawBodySha256: string;
  },
): void {
  fixture.db.prepare(
    `INSERT INTO exchange_media_descriptors(
      exchange_id, body_side, ordinal, json_path, media_type,
      encoded_bytes, decoded_bytes, sha256, raw_body_sha256, source_storage
    ) VALUES(?, 'request', ?, '$.messages[0].content', ?, ?, ?, ?, ?, 'inline')`,
  ).run(
    input.exchangeId,
    input.ordinal,
    input.mediaType,
    input.encodedBytes,
    input.decodedBytes,
    input.sha256,
    input.rawBodySha256,
  );
}

function localRequest(path: string, headers?: HeadersInit): Request {
  return new Request(`http://localhost${path}`, {
    headers: {
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
}

interface OpenAiResponsesInputItem {
  type: string;
  id?: string;
  role?: string;
  call_id?: string;
  name?: string;
  content?: Array<{ type: string; text: string }>;
  output?: string;
  arguments?: string;
}

function openAiResponsesExchange(options: {
  exchangeId: string;
  timestamp: string;
  sequence: number;
  instructions: string;
  input: OpenAiResponsesInputItem[];
}): RawCapturedExchangeV2 {
  const requestBody = JSON.stringify({
    model: "fixture-model",
    instructions: options.instructions,
    input: options.input,
  });
  const responseText = `回答 ${options.exchangeId}`;
  const responseBody = JSON.stringify({
    type: "message",
    content: [{ type: "text", text: responseText }],
  });
  return {
    schemaVersion: 2,
    exchangeId: options.exchangeId,
    captureSessionId: "capture-same-epoch-ids",
    sequence: options.sequence,
    capturedAt: options.timestamp,
    completedAt: options.timestamp,
    durationMs: 10,
    routing: {
      targetId: "target-content",
      targetName: "Content Target",
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1:3211/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: {
      headers: {},
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: sha256(requestBody),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: sha256(responseBody),
      isStreaming: false,
    },
    bodyStorage: {
      policy: "inline",
    },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

/** 完整 v4 投影（空 conversationItems 即可，导出端按 Raw 重建指纹）。 */
function insertOpenAiResponsesCompletePreview(
  fixture: SqliteFixture,
  exchange: RawCapturedExchangeV2,
): void {
  const preview = {
    schemaVersion: 3,
    exchangeId: exchange.exchangeId,
    projectionVersion: 4,
    protocol: "openai-responses",
    agentKind: "codex",
    endpointKind: "model-call",
    conversationItems: [],
    itemCandidateCount: 0,
    itemProcessedCount: 0,
    itemCandidateCountExact: true,
    candidateTextBytes: 0,
    processedTextBytes: 0,
    diagnosticCodes: [],
    limitedDimensions: [],
    limited: false,
    truncated: false,
    requestContext: {
      contextMode: "full_replay",
      contextEpoch: 0,
      comparisonKind: "same_epoch",
      baselineExchangeId: "exchange-same-epoch-ids-baseline",
      resolution: "resolved",
    },
  };
  const previewJson = JSON.stringify(preview);
  fixture.db.prepare(
    `INSERT INTO exchange_content_previews(
      exchange_id, projection_version, preview_state, preview_json,
      size_bytes, candidate_item_count, processed_item_count,
      candidate_text_bytes, processed_text_bytes, candidate_count_exact,
      limited, truncated, limited_dimensions_json, created_at, updated_at
    ) VALUES(?, 4, 'complete', ?, ?, 0, 0, 0, 0, 1, 0, 0, '[]', ?, ?)`,
  ).run(
    exchange.exchangeId,
    previewJson,
    Buffer.byteLength(previewJson),
    exchange.capturedAt,
    exchange.capturedAt,
  );
}

/**
 * 构造带消息 id 的 openai-responses 同纪元排重场景：
 * 可见 Request 完整重放基线（system/developer/user_real），仅新增一条 user_real。
 */
async function seedPersistedSameEpochMessageIds(fixture: SqliteFixture): Promise<{
  sessionId: string;
  threadId: string;
  visibleExchangeId: string;
  visibleTimestamp: string;
}> {
  const sessionId = "asess-same-epoch-ids";
  const threadId = "athread-same-epoch-ids";
  const turnId = "aturn-same-epoch-ids";
  const baselineExchangeId = "exchange-same-epoch-ids-baseline";
  const visibleExchangeId = "exchange-same-epoch-ids-visible";
  const sharedInput: OpenAiResponsesInputItem[] = [
    {
      type: "message",
      id: "msg-dev-1",
      role: "developer",
      content: [{ type: "input_text", text: "开发约束" }],
    },
    {
      type: "message",
      id: "msg-user-1",
      role: "user",
      content: [{ type: "input_text", text: "真实输入" }],
    },
  ];
  const baseline = openAiResponsesExchange({
    exchangeId: baselineExchangeId,
    timestamp: "2026-07-24T10:00:00.000Z",
    sequence: 1,
    instructions: "系统说明",
    input: sharedInput,
  });
  const visible = openAiResponsesExchange({
    exchangeId: visibleExchangeId,
    timestamp: "2026-07-24T10:01:00.000Z",
    sequence: 2,
    instructions: "系统说明",
    input: [
      ...sharedInput,
      {
        type: "message",
        id: "msg-user-2",
        role: "user",
        content: [{ type: "input_text", text: "新增输入" }],
      },
    ],
  });
  const rows = [baseline, visible];
  const fileName = "same-epoch-message-ids.jsonl";
  await fixture.writeV2Lines(rows, fileName);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const sourceId = fixture.db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path = ?",
  ).pluck().get(`captures/v2/${fileName}`) as number;
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-content', 'Content Target', 'fingerprint-content',
      'codex', 'fixture', 'exact', ?, ?, 2, 1)`,
  ).run(sessionId, rows[0]!.capturedAt, rows.at(-1)!.capturedAt);
  fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', 'Root Thread', 'exact', 1, ?, ?, 2, 1)`,
  ).run(threadId, sessionId, rows[0]!.capturedAt, rows.at(-1)!.capturedAt);
  fixture.db.prepare(
    "INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth) VALUES(?, ?, 0)",
  ).run(threadId, threadId);
  fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?, 2)`,
  ).run(turnId, sessionId, threadId, rows[0]!.exchangeId, rows[0]!.capturedAt, rows.at(-1)!.capturedAt);
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'target-content', 'Content Target',
      'codex', 'fingerprint-content', 'fixture-model', 200, 0, ?, ?)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'respond', 'continue', 'complete')`,
  );
  let byteOffset = 0;
  for (const [index, exchange] of rows.entries()) {
    const lineLengthBytes = Buffer.byteLength(`${JSON.stringify(exchange)}\n`);
    insertRef.run(
      exchange.exchangeId,
      "capture-same-epoch-ids",
      sourceId,
      byteOffset,
      lineLengthBytes,
      exchange.capturedAt,
      exchange.completedAt,
      exchange.request.bodySizeBytes,
      exchange.response.bodySizeBytes,
    );
    insertStep.run(
      `astep-same-epoch-${index + 1}`,
      exchange.exchangeId,
      sessionId,
      threadId,
      turnId,
      index + 1,
      exchange.capturedAt,
    );
    insertOpenAiResponsesCompletePreview(fixture, exchange);
    byteOffset += lineLengthBytes;
  }

  fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      baseline_exchange_id, request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 7, 'complete', 'complete', 'complete', 'compared',
      'full_replay', 'same_epoch', 0, ?, 3, ?, ?)`,
  ).run(
    visibleExchangeId,
    baselineExchangeId,
    visible.capturedAt,
    visible.capturedAt,
  );
  fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 7, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 3, ?, ?)`,
  ).run(
    baselineExchangeId,
    baseline.capturedAt,
    baseline.capturedAt,
  );

  const insertFingerprint = fixture.db.prepare(
    `INSERT INTO exchange_request_fingerprints(
      exchange_id, body_side, category, fingerprint,
      provider_lineage_key, occurrence_count
    ) VALUES(?, 'request', ?, ?, ?, 1)`,
  );
  insertFingerprint.run(
    baselineExchangeId,
    "system",
    fingerprintBlob(conversationFingerprintKey({
      category: "system",
      side: "input",
      provenance: "protocol_system",
      providerItemType: "instructions",
      textSha256: sha256("系统说明"),
      contentKinds: ["text"],
    })),
    "",
  );
  insertFingerprint.run(
    baselineExchangeId,
    "developer",
    fingerprintBlob(conversationFingerprintKey({
      category: "developer",
      side: "input",
      provenance: "protocol_system",
      providerItemType: "input_text",
      textSha256: sha256("开发约束"),
      contentKinds: ["text"],
    })),
    "provider:9:msg-dev-1:20:content:0:input_text",
  );
  insertFingerprint.run(
    baselineExchangeId,
    "user_real",
    fingerprintBlob(conversationFingerprintKey({
      category: "user_real",
      side: "input",
      provenance: "physical_user",
      providerItemType: "input_text",
      textSha256: sha256("真实输入"),
      contentKinds: ["text"],
    })),
    "provider:9:msg-user-1:20:content:0:input_text",
  );

  return {
    sessionId,
    threadId,
    visibleExchangeId,
    visibleTimestamp: visible.capturedAt,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** v29 起 exchange_request_fingerprints.fingerprint 为 32 字节 BLOB。 */
function fingerprintBlob(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
