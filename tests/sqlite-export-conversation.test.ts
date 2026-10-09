import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  iterateExportConversationItems,
  loadExportConversation,
  preflightFullExport,
  renderExportConversationDownload,
} from "../src/lib/export-conversation.js";
import {
  encodeExportCursor,
  loadExportFilterData,
  selectExportExchangeRefs,
} from "../src/lib/db/export-queries.js";
import { planExportContentPage } from "../src/lib/export-page-plan.js";
import type {
  RawCapturedExchange,
  RawCapturedExchangeV2,
} from "../src/lib/harness/types.js";
import { discoverV2Sources } from "../src/lib/ingestion/raw-source-reader.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

test("交互内容生产入口拒绝缺少 SQLite 数据库依赖的旧调用", async () => {
  const source = readFileSync("src/lib/export-conversation.ts", "utf-8");
  assert.match(source, /交互内容查询必须使用 SQLite 数据库依赖/);
  await assert.rejects(
    loadExportConversation("/definitely-not-readable", {
      session: "legacy-session",
      scope: "all",
      categories: [],
    }),
    /SQLite 数据库依赖/,
  );
});

test("交互内容生产模块不再静态依赖旧索引和旧派生读取器", () => {
  const source = readFileSync("src/lib/export-conversation.ts", "utf-8");
  assert.doesNotMatch(source, /capture-index|derivation\/l2-reader/u);
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

test("Thread 普通查询只读取 SQLite Content Preview，不打开 raw", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedExportFixture(fixture, 1_000, 10);
  let readCount = 0;

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadIds[3],
    scope: "all",
    categories: [],
    exchangeLimit: 5,
    pageMaxBytes: 1024 * 1024,
  }, {
    db: fixture.db,
    rawReader: async () => {
      readCount += 1;
      throw new Error("普通导出不得读取 raw");
    },
  });

  assert.equal(readCount, 0);
  assert.equal(result.candidateCount, 100);
  assert.equal(result.processedCount, 5);
  assert.equal(result.page?.loadedExchangeIds.length, 5);
  assert.ok(result.items.every((item) => item.agentSessionId === seeded.sessionId));
  assert.ok(result.items.every((item) => item.threadId === seeded.threadIds[3]));
});

test("模型请求分页的可见项与隐藏基线都只读取 SQLite 预览", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  let readCount = 0;
  const rawReader = async () => {
    readCount += 1;
    throw new Error("普通导出不得读取 raw");
  };

  const firstPage = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 1024 * 1024,
  }, { db: fixture.db, rawReader });
  const secondPage = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    cursor: firstPage.page?.nextCursor,
    exchangeLimit: 2,
    pageMaxBytes: 1024 * 1024,
  }, { db: fixture.db, rawReader });

  assert.equal(readCount, 0);
  assert.equal(firstPage.page?.baselineExchangeId, "exchange-model-1");
  assert.equal(secondPage.page?.baselineExchangeId, undefined);
  assert.deepEqual(
    firstPage.page?.loadedExchangeIds,
    ["exchange-model-3", "exchange-model-2"],
  );
  assert.deepEqual(
    secondPage.items.map((item) => item.text),
    ["回答 1", "问题 1"],
  );
  assert.equal(firstPage.dedupe?.inheritedItemCount, 3);
  assert.equal(secondPage.dedupe?.inheritedItemCount, 0);
});

test("交互内容页大小只约束可见 Exchange，隐藏基线另行统计", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);

  const plan = planExportContentPage(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 1024 * 1024,
  });

  assert.deepEqual(
    plan.visibleRefs.map((ref) => ref.exchangeId),
    ["exchange-model-3", "exchange-model-2"],
  );
  assert.equal(plan.visibleProcessedCount, 2);
  assert.equal(plan.baselineProcessedCount, 1);
  assert.equal(
    plan.baselinesByThread.get(seeded.threadId)?.ref?.exchangeId,
    "exchange-model-1",
  );
  assert.equal(plan.processedCount, 3);
  assert.equal(plan.baselineRawBytes, 0);
  assert.equal(
    plan.baselinesByThread.get(seeded.threadId)?.status,
    "sqlite_fingerprint",
  );
});

test("隐藏基线 Preview 不完整时才规划 Raw fallback 并计入字节", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  fixture.db.prepare(
    `UPDATE exchange_content_previews
     SET preview_state = 'limited', candidate_count_exact = 0
     WHERE exchange_id = 'exchange-model-1'`,
  ).run();

  const plan = planExportContentPage(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 1024 * 1024,
  });

  assert.equal(
    plan.baselinesByThread.get(seeded.threadId)?.status,
    "raw_fallback",
  );
  assert.equal(plan.baselineRawBytes, 64);
  assert.equal(plan.processedRawBytes, 320);
});

test("历史 v1 Preview 即使完整也必须按 Raw fallback 恢复角色语义", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  fixture.db.prepare(
    `UPDATE exchange_content_previews
     SET projection_version = 1
     WHERE exchange_id = 'exchange-model-1'`,
  ).run();

  const plan = planExportContentPage(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 1024 * 1024,
  });

  assert.equal(plan.baselinesByThread.get(seeded.threadId)?.status, "raw_fallback");
  assert.equal(plan.baselineRawBytes, 64);
});

test("Step 单条可见分页仍按真实 Thread 查询跨 Turn 隐藏基线", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);

  const plan = planExportContentPage(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    turn: seeded.turnId,
    step: "astep-model-3",
    scope: "step",
    categories: [],
    exchangeLimit: 1,
    pageMaxBytes: 1024 * 1024,
  });

  assert.deepEqual(plan.visibleRefs.map((ref) => ref.exchangeId), ["exchange-model-3"]);
  assert.equal(
    plan.baselinesByThread.get(seeded.threadId)?.ref?.exchangeId,
    "exchange-model-2",
  );
});

test("Session 混合时间线为每个实际 Thread 独立规划一条基线", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedMultiThreadModelFixture(fixture);

  const plan = planExportContentPage(fixture.db, {
    session: seeded.sessionId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 1024 * 1024,
  });

  assert.deepEqual(
    plan.visibleRefs.map((ref) => ref.exchangeId),
    ["exchange-thread-b-2", "exchange-thread-a-2"],
  );
  assert.equal(plan.baselineProcessedCount, 2);
  assert.equal(
    plan.baselinesByThread.get(seeded.threadA)?.ref?.exchangeId,
    "exchange-thread-a-1",
  );
  assert.equal(
    plan.baselinesByThread.get(seeded.threadB)?.ref?.exchangeId,
    "exchange-thread-b-1",
  );
});

test("当前范围只有两条请求且每页五条时第一页不应伪造下一页", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    turn: seeded.turnId,
    start: "2026-07-17T00:02:00.000Z",
    scope: "all",
    categories: [],
    exchangeLimit: 5,
    pageMaxBytes: 1024 * 1024,
  }, {
    db: fixture.db,
    rawReader: async (ref) => seeded.rawByExchange.get(ref.exchangeId),
  });

  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.page?.loadedExchangeIds, ["exchange-model-3", "exchange-model-2"]);
  assert.equal(result.page?.hasMoreOlder, false);
  assert.equal(result.page?.nextCursor, undefined);
});

test("类别筛选先于 COUNT 和分页且只保留含可展示独有内容的 Exchange", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const now = "2026-07-25T00:00:00.000Z";
  const insertStatus = fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      effective_context_boundary_id, produced_context_boundary_id,
      baseline_exchange_id, request_fingerprint_count, created_at, updated_at
    ) VALUES(
      ?, 4, 'complete', 'complete', 'complete', ?,
      'full_replay', 'same_epoch', 0, NULL, NULL, ?, 1, ?, ?
    )`,
  );
  const insertStats = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, 'request', 'user_real', 1, ?, ?, 0)`,
  );
  for (let index = 1; index <= 3; index += 1) {
    const exchangeId = `exchange-model-${index}`;
    insertStatus.run(
      exchangeId,
      index === 1 ? "not_required" : "compared",
      index === 1 ? null : `exchange-model-${index - 1}`,
      now,
      now,
    );
    insertStats.run(exchangeId, index === 1 ? 1 : 0, index === 1 ? 0 : 1);
  }

  const uniqueOnly = selectExportExchangeRefs(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: ["user_real"],
    categoriesExplicit: true,
    includeInherited: false,
    exchangeLimit: 25,
  });
  const withInherited = selectExportExchangeRefs(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: ["user_real"],
    categoriesExplicit: true,
    includeInherited: true,
    exchangeLimit: 25,
  });

  assert.equal(uniqueOnly.candidateCount, 1);
  assert.deepEqual(uniqueOnly.refs.map(ref => ref.exchangeId), ["exchange-model-1"]);
  assert.equal(uniqueOnly.hasMore, false);
  assert.equal(withInherited.candidateCount, 3);
  assert.deepEqual(
    withInherited.refs.map(ref => ref.exchangeId),
    ["exchange-model-3", "exchange-model-2", "exchange-model-1"],
  );

  fixture.db.prepare(
    `UPDATE exchange_content_filter_status
     SET filter_state = 'limited', request_filter_state = 'limited'
     WHERE exchange_id = ?`,
  ).run("exchange-model-2");
  fixture.db.prepare(
    "DELETE FROM exchange_content_filter_status WHERE exchange_id = ?",
  ).run("exchange-model-3");
  const incomplete = selectExportExchangeRefs(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: ["user_real"],
    categoriesExplicit: true,
    includeInherited: false,
    exchangeLimit: 25,
  });
  assert.equal(incomplete.candidateCount, 1);
  assert.equal(incomplete.candidateCountExact, false);
  assert.equal(incomplete.filterProjectionMissingCount, 1);
  assert.equal(incomplete.filterProjectionLimitedCount, 1);
});

test("双向类别严格按持久化 body_side 在 Raw 读取前筛选", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const now = "2026-07-25T00:00:00.000Z";
  const insertStatus = fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(
      ?, 4, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 1, ?, ?
    )`,
  );
  const insertStats = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, ?, 'tool_result', 1, 1, 0, 0)`,
  );
  insertStatus.run("exchange-model-1", now, now);
  insertStatus.run("exchange-model-2", now, now);
  insertStats.run("exchange-model-1", "request");
  insertStats.run("exchange-model-2", "response");

  const base = {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all" as const,
    categories: ["tool_result" as const],
    categoriesExplicit: true,
    exchangeLimit: 25,
  };
  const request = selectExportExchangeRefs(fixture.db, {
    ...base,
    side: "request",
  });
  const response = selectExportExchangeRefs(fixture.db, {
    ...base,
    side: "response",
  });

  assert.deepEqual(
    request.refs.map(ref => ref.exchangeId),
    ["exchange-model-1"],
  );
  assert.deepEqual(
    response.refs.map(ref => ref.exchangeId),
    ["exchange-model-2"],
  );
});

test("跨侧 AND：输入侧与输出侧各自独立为硬条件，两侧都选时须同时有新增", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const now = "2026-07-25T00:00:00.000Z";
  const insertStatus = fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 4, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 1, ?, ?)`,
  );
  const insertStats = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, ?, ?, ?, ?, ?, 0)`,
  );
  // exchange-1：请求侧有新增 user_real，响应侧有新增 assistant -> 命中
  insertStatus.run("exchange-model-1", now, now);
  insertStats.run("exchange-model-1", "request", "user_real", 1, 1, 0);
  insertStats.run("exchange-model-1", "response", "assistant", 1, 1, 0);
  // exchange-2：请求侧 user_real 全继承，响应侧有新增 assistant -> 不命中
  insertStatus.run("exchange-model-2", now, now);
  insertStats.run("exchange-model-2", "request", "user_real", 1, 0, 1);
  insertStats.run("exchange-model-2", "response", "assistant", 1, 1, 0);
  // exchange-3：请求侧有新增 user_real，响应侧 assistant 全继承 -> 不命中
  insertStatus.run("exchange-model-3", now, now);
  insertStats.run("exchange-model-3", "request", "user_real", 1, 1, 0);
  insertStats.run("exchange-model-3", "response", "assistant", 1, 0, 1);

  const result = selectExportExchangeRefs(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: ["user_real", "assistant"],
    categoriesExplicit: true,
    includeInherited: false,
    exchangeLimit: 25,
  });
  assert.equal(result.candidateCount, 1);
  assert.deepEqual(
    result.refs.map(ref => ref.exchangeId),
    ["exchange-model-1"],
  );
});

test("仅选输入侧类别时不要求输出侧有新增内容", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const now = "2026-07-25T00:00:00.000Z";
  const insertStatus = fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 4, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 1, ?, ?)`,
  );
  const insertStats = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, ?, ?, ?, ?, ?, 0)`,
  );
  // exchange-1：请求侧有新增 user_real
  insertStatus.run("exchange-model-1", now, now);
  insertStats.run("exchange-model-1", "request", "user_real", 1, 1, 0);
  // exchange-3：请求侧有新增 user_real，但无响应侧统计
  insertStatus.run("exchange-model-3", now, now);
  insertStats.run("exchange-model-3", "request", "user_real", 1, 1, 0);
  // exchange-2：请求侧 user_real 全继承
  insertStatus.run("exchange-model-2", now, now);
  insertStats.run("exchange-model-2", "request", "user_real", 1, 0, 1);

  const result = selectExportExchangeRefs(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: ["user_real"],
    categoriesExplicit: true,
    includeInherited: false,
    exchangeLimit: 25,
  });
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(
    result.refs.map(ref => ref.exchangeId),
    ["exchange-model-3", "exchange-model-1"],
  );
});

test("普通导出只选输入侧类别时输出侧 item 不被过滤", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedStreamingExportFixture(fixture, "真实输入");
  insertCategoryStatsForExport(fixture, "exchange-streaming-export");

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: ["user_real"],
    categoriesExplicit: true,
    exchangeLimit: 5,
    pageMaxBytes: 1024 * 1024,
  }, {
    db: fixture.db,
  });

  const input = result.items.filter(item => item.side === "input");
  const output = result.items.filter(item => item.side === "output");
  assert.ok(input.length >= 1, "输入侧应至少保留一条 user_real");
  assert.ok(input.every(item => item.category === "user_real"));
  assert.ok(output.some(item => item.category === "assistant"),
    "只选输入侧类别时输出侧 assistant 应完整展示");
});

test("普通导出只选输出侧类别时输入侧 item 不被过滤", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = await seedStreamingExportFixture(fixture, "真实输入");
  insertCategoryStatsForExport(fixture, "exchange-streaming-export");

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: ["assistant"],
    categoriesExplicit: true,
    exchangeLimit: 5,
    pageMaxBytes: 1024 * 1024,
  }, {
    db: fixture.db,
  });

  const input = result.items.filter(item => item.side === "input");
  const output = result.items.filter(item => item.side === "output");
  assert.ok(output.length >= 1, "输出侧应至少保留一条 assistant");
  assert.ok(output.every(item => item.category === "assistant"));
  assert.ok(input.some(item => item.category === "user_real"),
    "只选输出侧类别时输入侧 user_real 应完整展示");
});

test("默认空选类别不加过滤，返回全部 Exchange", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const now = "2026-07-25T00:00:00.000Z";
  const insertStatus = fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 4, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 1, ?, ?)`,
  );
  for (let index = 1; index <= 3; index += 1) {
    insertStatus.run(`exchange-model-${index}`, now, now);
  }
  const result = selectExportExchangeRefs(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    categoriesExplicit: false,
    exchangeLimit: 25,
  });
  assert.equal(result.candidateCount, 3);
});

test("交互内容使用双向 keyset 从更早页返回更新页", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const base = {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all" as const,
    categories: [],
    exchangeLimit: 1,
  };
  const first = selectExportExchangeRefs(fixture.db, base);
  const older = selectExportExchangeRefs(fixture.db, {
    ...base,
    cursor: encodeExportCursor(first.refs[0]!),
    direction: "older",
  });
  const newer = selectExportExchangeRefs(fixture.db, {
    ...base,
    cursor: encodeExportCursor(older.refs[0]!),
    direction: "newer",
  });

  assert.deepEqual(first.refs.map(ref => ref.exchangeId), ["exchange-model-3"]);
  assert.deepEqual(older.refs.map(ref => ref.exchangeId), ["exchange-model-2"]);
  assert.deepEqual(newer.refs.map(ref => ref.exchangeId), ["exchange-model-3"]);
});

test("Raw 正文很大时普通导出仍按 SQLite 预览预算加载", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  fixture.db.prepare(
    "UPDATE raw_exchange_refs SET line_length_bytes = ?",
  ).run(20 * 1024 * 1024);
  let readCount = 0;

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 32 * 1024 * 1024,
  }, {
    db: fixture.db,
    rawReader: async (ref) => {
      readCount += 1;
      return seeded.rawByExchange.get(ref.exchangeId);
    },
  });

  assert.equal(readCount, 0);
  assert.notEqual(result.page?.dedupeBaselineStatus, "budget_blocked");
  assert.ok((result.page?.processedBytes ?? 0) < 32 * 1024 * 1024);
  assert.ok(result.items.length > 0);
});

test("Blob 正文字节很大时普通导出不以 Raw 声明大小阻断预览", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedExportFixture(fixture, 10, 1);
  fixture.db.prepare(
    `UPDATE raw_exchange_refs
     SET request_body_bytes = ?, response_body_bytes = ?`,
  ).run(20 * 1024 * 1024, 20 * 1024 * 1024);
  let readCount = 0;

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadIds[0],
    scope: "all",
    categories: [],
    exchangeLimit: 1,
    pageMaxBytes: 32 * 1024 * 1024,
  }, {
    db: fixture.db,
    rawReader: async (ref) => {
      readCount += 1;
      return seeded.rawByExchange.get(ref.exchangeId);
    },
  });

  assert.equal(readCount, 0);
  assert.notEqual(result.page?.dedupeBaselineStatus, "budget_blocked");
  assert.equal(result.page?.loadedExchangeIds.length, 1);
  assert.ok(result.items.length > 0);
});

test("SQLite 预览字节预算在 JSON 解析前同时约束可见项和隐藏基线", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const padding = "p".repeat(180 * 1024);
  const rows = fixture.db.prepare(
    "SELECT exchange_id, preview_json FROM exchange_content_previews",
  ).all() as Array<{ exchange_id: string; preview_json: string }>;
  for (const row of rows) {
    const preview = JSON.parse(row.preview_json) as Record<string, unknown>;
    preview.padding = padding;
    const previewJson = JSON.stringify(preview);
    fixture.db.prepare(
      `UPDATE exchange_content_previews
       SET preview_json = ?, size_bytes = ? WHERE exchange_id = ?`,
    ).run(previewJson, Buffer.byteLength(previewJson), row.exchange_id);
  }
  let readCount = 0;

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 300 * 1024,
  }, {
    db: fixture.db,
    rawReader: async () => {
      readCount += 1;
      throw new Error("预算阻断后不得读取 raw");
    },
  });

  assert.equal(readCount, 0);
  assert.equal(result.page?.dedupeBaselineStatus, "budget_blocked");
  assert.equal(result.page?.loadedExchangeIds.length, 0);
  assert.ok((result.page?.requiredBytes ?? 0) > 300 * 1024);
});

test("完整导出预检不读取 raw 且流式阶段逐页消费 SQLite 引用", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedExportFixture(fixture, 1_000, 10);
  let readCount = 0;
  const dependencies = {
    db: fixture.db,
    rawReader: async (ref: { exchangeId: string }) => {
      readCount += 1;
      return seeded.rawByExchange.get(ref.exchangeId);
    },
  };
  const filters = {
    session: seeded.sessionId,
    thread: seeded.threadIds[3],
    scope: "all" as const,
    categories: [],
    exchangeLimit: 5,
    pageMaxBytes: 1024 * 1024,
  };

  const preflight = await preflightFullExport(
    fixture.dataDir,
    filters,
    dependencies,
  );
  assert.equal(readCount, 0);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.pageCount, 20);
  assert.equal(preflight.candidateExchangeCount, 100);
  assert.equal(preflight.declaredBodyBytes, 100 * 128);

  const items = [];
  for await (const item of iterateExportConversationItems(
    fixture.dataDir,
    filters,
    preflight,
    dependencies,
  )) {
    items.push(item);
  }
  assert.equal(readCount, 100);
  assert.ok(items.length > 0);
});

test("完整导出预检只按单条 Raw 预算判断，不叠加 SQLite 隐藏基线", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  fixture.db.prepare(
    `UPDATE raw_exchange_refs
     SET request_body_bytes = 40, response_body_bytes = 40
     WHERE capture_session_id = 'capture-model'`,
  ).run();

  const preflight = await preflightFullExport(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 100,
  }, { db: fixture.db });

  assert.equal(preflight.ok, true);
  assert.equal(preflight.candidateExchangeCount, 3);
  assert.equal(preflight.declaredBodyBytes, 240);
  assert.equal(preflight.pageCount, 3);
});

test("完整下载按精确 Raw 索引流式输出长文本并过滤 Base64", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const binary = Buffer.from("sqlite-stream-export-image".repeat(512));
  const base64 = binary.toString("base64");
  const longTail = `完整尾部-${"流式文本".repeat(4_000)}`;
  const seeded = await seedStreamingExportFixture(
    fixture,
    `开始 data:image/png;base64,${base64} 结束 ${longTail}`,
  );
  const filters = {
    session: seeded.sessionId,
    thread: seeded.threadId,
    scope: "all" as const,
    categories: [],
    exchangeLimit: 2,
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

  const output = chunks.join("");
  const parsed = JSON.parse(output) as Array<{ text: string; contentSource: string }>;
  assert.ok(parsed.some(item => item.text.includes(longTail)));
  assert.ok(parsed.every(item => item.contentSource === "raw_stream"));
  assert.doesNotMatch(output, /data:image\/png;base64,/u);
  assert.equal(output.includes(base64.slice(100, 300)), false);
  assert.match(output, /\[media image\/png;/u);
  assert.match(output, new RegExp(createHash("sha256").update(binary).digest("hex"), "u"));
});

test("交互内容 facets 初始有界并补入第一页外的已选层级", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const insertSession = fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-export', 'Export Target', 'fingerprint-export',
      'codex', 'fixture', 'exact', ?, ?, 0, 0)`,
  );
  for (let index = 0; index < 60; index += 1) {
    const timestamp = new Date(
      Date.parse("2025-01-01T00:00:00.000Z") + index * 1_000,
    ).toISOString();
    insertSession.run(`asess-old-${String(index).padStart(3, "0")}`, timestamp, timestamp);
  }

  const bounded = loadExportFilterData(fixture.db, {
    target: ["target-export"],
    agent: ["codex"],
    session: "asess-old-000",
  });
  assert.equal(bounded.sessions.length, 50);
  assert.ok(bounded.sessions.some((item) => item.value === "asess-old-000"));

  const hierarchy = loadExportFilterData(fixture.db, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    turn: seeded.turnId,
    step: "astep-model-3",
  });
  assert.deepEqual(hierarchy.threads.map((item) => item.value), [seeded.threadId]);
  assert.deepEqual(hierarchy.turns.map((item) => item.value), [seeded.turnId]);
  assert.equal(hierarchy.steps.length, 3);
  assert.ok(hierarchy.steps.some((item) => item.value === "astep-model-3"));
  assert.ok(hierarchy.steps.every((item) => item.value.startsWith("astep-")));
  assert.ok(hierarchy.steps.every((item) => item.thread === seeded.threadId));
});

test("交互内容用内部 Step ID 精确选择 Exchange 并兼容旧链接", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);
  const base = {
    session: seeded.sessionId,
    thread: seeded.threadId,
    turn: seeded.turnId,
    scope: "step" as const,
    categories: [],
    exchangeLimit: 1,
  };

  const internal = selectExportExchangeRefs(fixture.db, {
    ...base,
    step: "astep-model-3",
  });
  const legacy = selectExportExchangeRefs(fixture.db, {
    ...base,
    step: "exchange-model-3",
  });

  assert.deepEqual(internal.refs.map((ref) => ref.exchangeId), ["exchange-model-3"]);
  assert.equal(internal.candidateCount, 1);
  assert.deepEqual(legacy.refs.map((ref) => ref.exchangeId), ["exchange-model-3"]);
});

test("交互内容用内部 Step ID 生成当前 Step 上下文对比", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedModelFixture(fixture);

  const result = await loadExportConversation(fixture.dataDir, {
    session: seeded.sessionId,
    thread: seeded.threadId,
    turn: seeded.turnId,
    step: "astep-model-3",
    scope: "step",
    categories: [],
    exchangeLimit: 2,
    pageMaxBytes: 1024 * 1024,
  }, {
    db: fixture.db,
    rawReader: async (ref) => seeded.rawByExchange.get(ref.exchangeId),
  });

  assert.equal(result.stepComparison?.status, "compared");
  assert.equal(result.stepComparison?.currentExchangeId, "exchange-model-3");
  assert.equal(result.stepComparison?.previousExchangeId, "exchange-model-2");
});

function seedExportFixture(
  fixture: SqliteFixture,
  exchangeCount: number,
  threadCount: number,
): {
  sessionId: string;
  threadIds: string[];
  rawByExchange: Map<string, RawCapturedExchange>;
} {
  const sessionId = "asess-export";
  const threadIds = Array.from(
    { length: threadCount },
    (_, index) => `athread-export-${index + 1}`,
  );
  const rawByExchange = new Map<string, RawCapturedExchange>();
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/export-fixture.jsonl', 'export-fixture', 0, 0,
      1000000, 0, 'ready', '2026-07-17T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;

  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, source, confidence, start_time, end_time,
      request_count, thread_count
    ) VALUES(?, 'target-export', 'Export Target', 'fingerprint-export',
      'codex', 'session-export', 'fixture', 'exact', ?, ?, ?, ?)`,
  ).run(
    sessionId,
    "2026-07-17T00:00:00.000Z",
    "2026-07-17T01:00:00.000Z",
    exchangeCount,
    threadCount,
  );

  const insertThread = fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', ?, 'exact', 1, ?, ?, ?, 0)`,
  );
  const insertClosure = fixture.db.prepare(
    `INSERT INTO thread_closure(
      ancestor_thread_id, descendant_thread_id, depth
    ) VALUES(?, ?, 0)`,
  );
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-export', ?, ?, 256, ?, ?, 'target-export',
      'Export Target', 'codex', 'fingerprint-export', 'fixture-model',
      200, 0, 64, 64)`,
  );
  const insertAuxiliary = fixture.db.prepare(
    `INSERT INTO auxiliary_requests(
      id, exchange_id, agent_session_id, agent_thread_id,
      target_id, agent_fingerprint_id, agent_name, kind, timestamp, duration_ms
    ) VALUES(?, ?, ?, ?, 'target-export', 'fingerprint-export', 'codex',
      'token_count', ?, 10)`,
  );
  const insertAll = fixture.db.transaction(() => {
    const perThread = exchangeCount / threadCount;
    for (let threadIndex = 0; threadIndex < threadIds.length; threadIndex += 1) {
      const threadId = threadIds[threadIndex]!;
      insertThread.run(
        threadId,
        sessionId,
        `Thread ${threadIndex + 1}`,
        "2026-07-17T00:00:00.000Z",
        "2026-07-17T01:00:00.000Z",
        perThread,
      );
      insertClosure.run(threadId, threadId);
      for (let itemIndex = 0; itemIndex < perThread; itemIndex += 1) {
        const sequence = threadIndex * perThread + itemIndex;
        const exchangeId = `exchange-export-${String(sequence).padStart(4, "0")}`;
        const timestamp = new Date(
          Date.parse("2026-07-17T00:00:00.000Z") + sequence * 1_000,
        ).toISOString();
        insertRef.run(exchangeId, sourceId, sequence * 256, timestamp, timestamp);
        insertAuxiliary.run(
          `aux-export-${sequence}`,
          exchangeId,
          sessionId,
          threadId,
          timestamp,
        );
        rawByExchange.set(exchangeId, makeAuxiliaryExchange(exchangeId, timestamp));
        insertContentPreview(fixture, exchangeId, [{
          side: "response",
          category: "tool",
          role: "tool",
          itemType: "output",
          jsonPath: "$.input_tokens",
          textPreview: `Token 统计 ${sequence}`,
        }]);
      }
    }
  });
  insertAll();

  return { sessionId, threadIds, rawByExchange };
}

/**
 * 类别筛选测试用：为单个 exchange 补齐 filter status 与类别统计，
 * 使 SQL 规划层的按侧类别条件（bfb0bc5 引入）能够命中该 Exchange。
 */
function insertCategoryStatsForExport(
  fixture: SqliteFixture,
  exchangeId: string,
): void {
  const now = "2026-07-22T12:00:00.000Z";
  fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 4, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 0, ?, ?)`,
  ).run(exchangeId, now, now);
  const insertStats = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, ?, ?, ?, ?, ?, 0)`,
  );
  insertStats.run(exchangeId, "request", "user_real", 1, 1, 0);
  insertStats.run(exchangeId, "response", "assistant", 1, 1, 0);
}

async function seedStreamingExportFixture(
  fixture: SqliteFixture,
  requestText: string,
): Promise<{ sessionId: string; threadId: string }> {
  const exchangeId = "exchange-streaming-export";
  const sessionId = "asess-streaming-export";
  const threadId = "athread-streaming-export";
  const turnId = "aturn-streaming-export";
  const timestamp = "2026-07-22T12:00:00.000Z";
  const requestBody = JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content: requestText }],
  });
  const responseBody = JSON.stringify({
    type: "message",
    content: [{ type: "text", text: "流式完整响应" }],
  });
  const exchange: RawCapturedExchangeV2 = {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-streaming-export",
    sequence: 1,
    capturedAt: timestamp,
    completedAt: timestamp,
    durationMs: 10,
    routing: {
      targetId: "target-export",
      targetName: "Export Target",
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
      bodySha256: createHash("sha256").update(requestBody).digest("hex"),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: createHash("sha256").update(responseBody).digest("hex"),
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
  const fileName = "streaming-export.jsonl";
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
    ) VALUES(?, 'target-export', 'Export Target', 'fingerprint-export',
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
    ) VALUES(?, 'capture-streaming-export', ?, 0, ?, ?, ?, 'target-export',
      'Export Target', 'codex', 'fingerprint-export', 'fixture-model', 200, 0, ?, ?)`,
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
    ) VALUES('astep-streaming-export', ?, ?, ?, ?, 1, ?, 'respond', 'continue', 'complete')`,
  ).run(exchangeId, sessionId, threadId, turnId, timestamp);
  insertContentPreview(fixture, exchangeId, [
    {
      side: "request",
      category: "message",
      role: "user",
      itemType: "content",
      jsonPath: "$.messages[0].content",
      textPreview: "开始 [media] 结束 完整尾部预览",
      semanticCategory: "user_real",
      displayPolicy: "conversation",
    },
    {
      side: "response",
      category: "message",
      role: "assistant",
      itemType: "text",
      jsonPath: "$.content[0].text",
      textPreview: "流式完整响应",
      semanticCategory: "assistant",
      displayPolicy: "conversation",
    },
  ]);
  return { sessionId, threadId };
}

function makeAuxiliaryExchange(
  exchangeId: string,
  timestamp: string,
): RawCapturedExchange {
  const request = { model: "fixture-model", messages: [] };
  const response = { input_tokens: 1 };
  return {
    schemaVersion: 1,
    exchangeId,
    captureSessionId: "capture-export",
    sequence: 1,
    capturedAt: timestamp,
    completedAt: timestamp,
    durationMs: 10,
    routing: {
      targetId: "target-export",
      targetName: "Export Target",
      targetFormatHint: "anthropic",
      localUrl: "http://127.0.0.1/v1/messages/count_tokens",
      upstreamUrl: "https://example.test/v1/messages/count_tokens",
      localPath: "/v1/messages/count_tokens",
      upstreamPath: "/v1/messages/count_tokens",
      method: "POST",
    },
    request: {
      headers: {},
      rawBody: JSON.stringify(request),
      parsedBody: request,
      bodySizeBytes: 64,
      bodySha256: "0".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: JSON.stringify(response),
      parsedBody: response,
      bodySizeBytes: 64,
      bodySha256: "1".repeat(64),
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
}

function seedModelFixture(fixture: SqliteFixture): {
  sessionId: string;
  threadId: string;
  turnId: string;
  rawByExchange: Map<string, RawCapturedExchange>;
} {
  const sessionId = "asess-model";
  const threadId = "athread-model";
  const turnId = "aturn-model";
  const rawByExchange = new Map<string, RawCapturedExchange>();
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/model-fixture.jsonl', 'model-fixture', 0, 0,
      4096, 0, 'ready', '2026-07-17T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-export', 'Export Target', 'fingerprint-export',
      'codex', 'fixture', 'exact', ?, ?, 3, 1)`,
  ).run(sessionId, "2026-07-17T00:00:00.000Z", "2026-07-17T00:03:00.000Z");
  fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', 'Root Thread', 'exact', 1, ?, ?, 3, 1)`,
  ).run(threadId, sessionId, "2026-07-17T00:00:00.000Z", "2026-07-17T00:03:00.000Z");
  fixture.db.prepare(
    `INSERT INTO thread_closure(
      ancestor_thread_id, descendant_thread_id, depth
    ) VALUES(?, ?, 0)`,
  ).run(threadId, threadId);
  fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1,
      'exchange-model-1', ?, ?, 3)`,
  ).run(
    turnId,
    sessionId,
    threadId,
    "2026-07-17T00:01:00.000Z",
    "2026-07-17T00:03:00.000Z",
  );

  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-model', ?, ?, 256, ?, ?, 'target-export',
      'Export Target', 'codex', 'fingerprint-export', 'fixture-model',
      200, 0, 64, 64)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'respond', 'continue', 'complete')`,
  );
  for (let index = 1; index <= 3; index += 1) {
    const exchangeId = `exchange-model-${index}`;
    const timestamp = `2026-07-17T00:0${index}:00.000Z`;
    insertRef.run(exchangeId, sourceId, (index - 1) * 256, timestamp, timestamp);
    insertStep.run(
      `astep-model-${index}`,
      exchangeId,
      sessionId,
      threadId,
      turnId,
      index,
      timestamp,
    );
    rawByExchange.set(exchangeId, makeModelExchange(exchangeId, timestamp, index));
    insertContentPreview(fixture, exchangeId, [
      ...Array.from({ length: index }, (_, itemIndex) => ({
        side: "request" as const,
        category: "message",
        role: "user",
        itemType: "content",
        jsonPath: `$.messages[${itemIndex}].content`,
        textPreview: `问题 ${itemIndex + 1}`,
      })),
      {
        side: "response" as const,
        category: "message",
        role: "assistant",
        itemType: "text",
        jsonPath: "$.content[0].text",
        textPreview: `回答 ${index}`,
      },
    ]);
  }
  return { sessionId, threadId, turnId, rawByExchange };
}

function seedMultiThreadModelFixture(fixture: SqliteFixture): {
  sessionId: string;
  threadA: string;
  threadB: string;
} {
  const sessionId = "asess-multi-thread";
  const threadA = "athread-multi-a";
  const threadB = "athread-multi-b";
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/multi-thread.jsonl', 'multi-thread', 0, 0,
      4096, 0, 'ready', '2026-07-17T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-export', 'Export Target', 'fingerprint-export',
      'codex', 'fixture', 'exact', ?, ?, 4, 2)`,
  ).run(sessionId, "2026-07-17T00:00:00.000Z", "2026-07-17T00:04:00.000Z");
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
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-multi-thread', ?, ?, 256, ?, ?, 'target-export',
      'Export Target', 'codex', 'fingerprint-export', 'fixture-model',
      200, 0, 64, 64)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'respond', 'continue', 'complete')`,
  );
  for (const [threadIndex, threadId] of [threadA, threadB].entries()) {
    const turnId = `aturn-multi-${threadIndex}`;
    insertThread.run(
      threadId,
      sessionId,
      `Thread ${threadIndex}`,
      "2026-07-17T00:00:00.000Z",
      "2026-07-17T00:04:00.000Z",
    );
    fixture.db.prepare(
      "INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth) VALUES(?, ?, 0)",
    ).run(threadId, threadId);
    const firstExchangeId = `exchange-thread-${threadIndex === 0 ? "a" : "b"}-1`;
    insertTurn.run(
      turnId,
      sessionId,
      threadId,
      firstExchangeId,
      "2026-07-17T00:00:00.000Z",
      "2026-07-17T00:04:00.000Z",
    );
    for (let index = 1; index <= 2; index += 1) {
      const letter = threadIndex === 0 ? "a" : "b";
      const exchangeId = `exchange-thread-${letter}-${index}`;
      const minute = index === 1 ? threadIndex + 1 : threadIndex + 3;
      const timestamp = `2026-07-17T00:0${minute}:00.000Z`;
      insertRef.run(exchangeId, sourceId, (threadIndex * 2 + index) * 256, timestamp, timestamp);
      insertStep.run(
        `astep-thread-${letter}-${index}`,
        exchangeId,
        sessionId,
        threadId,
        turnId,
        index,
        timestamp,
      );
      insertContentPreview(fixture, exchangeId, [{
        side: "request",
        category: "message",
        role: "user",
        itemType: "content",
        jsonPath: "$.messages[0].content",
        textPreview: `${letter}-${index}`,
      }]);
    }
  }
  return { sessionId, threadA, threadB };
}

function insertContentPreview(
  fixture: SqliteFixture,
  exchangeId: string,
  items: Array<{
    side: "request" | "response";
    category: string;
    role?: string;
    itemType: string;
    jsonPath: string;
    textPreview: string;
    semanticCategory?: string;
    displayPolicy?: string;
  }>,
): void {
  const conversationItems = items.map((item, index) => ({
    ...item,
    textSha256: String(index + 1).repeat(64).slice(0, 64),
    originalTextBytes: Buffer.byteLength(item.textPreview),
    previewTextBytes: Buffer.byteLength(item.textPreview),
    truncated: false,
    mediaDescriptorOrdinals: [],
  }));
  const preview = {
    schemaVersion: 1,
    exchangeId,
    projectionVersion: 2,
    protocol: "anthropic-messages",
    endpointKind: items[0]?.role === "tool" ? "token-count" : "model-call",
    conversationItems,
    itemCandidateCount: conversationItems.length,
    itemProcessedCount: conversationItems.length,
    itemCandidateCountExact: true,
    candidateTextBytes: conversationItems.reduce((sum, item) => sum + item.originalTextBytes, 0),
    processedTextBytes: conversationItems.reduce((sum, item) => sum + item.previewTextBytes, 0),
    diagnosticCodes: [],
    limitedDimensions: [],
    limited: false,
    truncated: false,
  };
  const previewJson = JSON.stringify(preview);
  fixture.db.prepare(
    `INSERT INTO exchange_content_previews(
      exchange_id, projection_version, preview_state, preview_json,
      size_bytes, candidate_item_count, processed_item_count,
      candidate_text_bytes, processed_text_bytes, candidate_count_exact,
      limited, truncated, limited_dimensions_json, created_at, updated_at
    ) VALUES(?, 2, 'complete', ?, ?, ?, ?, ?, ?, 1, 0, 0, '[]', ?, ?)`,
  ).run(
    exchangeId,
    previewJson,
    Buffer.byteLength(previewJson),
    conversationItems.length,
    conversationItems.length,
    preview.candidateTextBytes,
    preview.processedTextBytes,
    "2026-07-22T12:00:00.000Z",
    "2026-07-22T12:00:00.000Z",
  );
}

function makeModelExchange(
  exchangeId: string,
  timestamp: string,
  index: number,
): RawCapturedExchange {
  const messages = Array.from(
    { length: index },
    (_, itemIndex) => ({ role: "user", content: `问题 ${itemIndex + 1}` }),
  );
  const request = { model: "fixture-model", messages };
  const response = {
    type: "message",
    model: "fixture-model",
    content: [{ type: "text", text: `回答 ${index}` }],
  };
  const base = makeAuxiliaryExchange(exchangeId, timestamp);
  return {
    ...base,
    routing: {
      ...base.routing,
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      localUrl: "http://127.0.0.1/v1/messages",
      upstreamUrl: "https://example.test/v1/messages",
    },
    request: {
      ...base.request,
      rawBody: JSON.stringify(request),
      parsedBody: request,
    },
    response: {
      ...base.response,
      rawBody: JSON.stringify(response),
      parsedBody: response,
    },
  };
}
