import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  iterateExportContentEvents,
  type ExportContentEvent,
} from "../src/lib/export-content-events.js";
import { getDeepaaDatabase } from "../src/lib/db/connection.js";
import { loadExportListRows } from "../src/lib/export-list-rows.js";
import { selectExportExchangeRefs } from "../src/lib/db/export-queries.js";
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
  delete process.env.DEEPAA_DATA_DIR;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

/**
 * 列表行夹具：**故意不写 raw capture 文件**——列表摘要必须完全来自 SQLite，
 * 任何 raw 读取都会让这些用例失败（这正是「滚动零 raw」的守卫）。
 */
function seedListRows(fixture: SqliteFixture, options: {
  count: number;
  withPreview: boolean;
  diagnostics?: string[];
}): string[] {
  const db = fixture.db;
  const sessionId = "asess-list";
  const threadId = "athread-list";
  const timestamp = "2026-09-16T10:00:00.000Z";
  db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(?, 'target-list', 'List Target', 'fp-list', 'codex', 'fixture', 'exact', ?, ?, ?, 1)`,
  ).run(sessionId, timestamp, timestamp, options.count);
  db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, 'fixture', 'Root', 'exact', 1, ?, ?, ?, 1)`,
  ).run(threadId, sessionId, timestamp, timestamp, options.count);
  db.prepare(
    "INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth) VALUES(?, ?, 0)",
  ).run(threadId, threadId);
  // 引用必须指向真实 source 行（FK）；列表路径不会去读它的文件内容。
  db.prepare(
    `INSERT INTO ingestion_sources(
      id, relative_path, file_id, generation, byte_offset, scan_offset,
      file_size, processed_count, status, updated_at
    ) VALUES(1, 'captures/v2/absent.jsonl', 'file-absent', 0, 0, 0, 0, 0, 'ready', ?)`,
  ).run(timestamp);
  const exchangeIds: string[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const exchangeId = `exchange-list-${index}`;
    const turnId = `aturn-list-${index}`;
    const stepId = `astep-list-${index}`;
    const capturedAt = `2026-09-16T10:0${index}:00.000Z`;
    exchangeIds.push(exchangeId);
    db.prepare(
      `INSERT INTO agent_turns(
        id, agent_session_id, agent_thread_id, source, confidence, status,
        segment_index, start_exchange_id, start_time, end_time, step_count
      ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', ?, ?, ?, ?, 1)`,
    ).run(turnId, sessionId, threadId, index + 1, exchangeId, capturedAt, capturedAt);
    db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
        captured_at, completed_at, target_id, target_name, agent_name,
        agent_fingerprint_id, model, status, is_streaming,
        request_body_bytes, response_body_bytes, diagnostic_codes_json
      ) VALUES(?, 'capture-list', 1, ?, 4096, ?, ?, 'target-list', 'List Target',
        'codex', 'fp-list', 'gpt-5.6-sol', 200, 1, 1024, 2048, ?)`,
    ).run(
      exchangeId,
      index * 4096,
      capturedAt,
      capturedAt,
      JSON.stringify(options.diagnostics ?? []),
    );
    db.prepare(
      `INSERT INTO agent_steps(
        id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
        step_index, timestamp, phase, request_action, response_action
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'respond', 'continue', 'complete')`,
    ).run(stepId, exchangeId, sessionId, threadId, turnId, index + 1, capturedAt);
    if (options.withPreview) {
      const preview = {
        schemaVersion: 4,
        exchangeId,
        projectionVersion: 4,
        protocol: "openai-responses",
        agentKind: "codex",
        endpointKind: "model-call",
        conversationItems: [],
        historyReplaySamples: [],
        historyReplayCount: 0,
        overviewCandidates: [
          {
            side: "request",
            category: "message",
            itemType: "text",
            jsonPath: "$.input[4].content[0].text",
            textPreview: `第 ${index} 步的真实用户输入`,
            semanticCategory: "user_real",
            conversationCategory: "user_real",
            displayPolicy: "conversation",
            mediaDescriptorOrdinals: [],
          },
          {
            side: "response",
            category: "tool",
            itemType: "custom_tool_call",
            jsonPath: "$.events[91].data.delta",
            textPreview: "const cmds = [\"readme\"]",
            toolName: "exec",
            semanticCategory: "tool_use",
            conversationCategory: "tool_use",
            displayPolicy: "conversation",
            mediaDescriptorOrdinals: [],
          },
        ],
        requestContextMode: "full_replay",
        itemCandidateCount: 2,
        itemProcessedCount: 2,
        itemCandidateCountExact: true,
        limited: false,
        truncated: false,
        limitedDimensions: [],
        diagnosticCodes: [],
      };
      db.prepare(
        `INSERT INTO exchange_content_previews(
          exchange_id, projection_version, preview_state, preview_json, size_bytes,
          candidate_item_count, processed_item_count, candidate_text_bytes,
          processed_text_bytes, candidate_count_exact, limited, truncated,
          limited_dimensions_json, created_at, updated_at
        ) VALUES(?, 4, 'complete', ?, ?, 2, 2, 100, 100, 1, 0, 0, '[]', ?, ?)`,
      ).run(
        exchangeId,
        JSON.stringify(preview),
        Buffer.byteLength(JSON.stringify(preview), "utf8"),
        capturedAt,
        capturedAt,
      );
    }
  }
  return exchangeIds;
}

test("列表行摘要只来自 SQLite 物化投影（raw 文件不存在也能出摘要）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const exchangeIds = seedListRows(fixture, {count: 3, withPreview: true});
  const selected = selectExportExchangeRefs(fixture.db, {
    scope: "all",
    categories: [],
    exchangeLimit: 10,
    deferBaseline: true,
  });
  assert.equal(selected.refs.length, 3);
  const rows = loadExportListRows(fixture.db, selected.refs, {
    requestDedupeStates: new Map(),
    deferred: true,
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.exchangeId).sort(), [...exchangeIds].sort());
  const first = rows.find(row => row.exchangeId === "exchange-list-2")!;
  assert.match(first.requestSummary ?? "", /第 2 步的真实用户输入/);
  // 工具调用摘要带工具名前缀，便于一眼看出「这步调用了什么」。
  assert.match(first.responseSummary ?? "", /^\[exec\] const cmds/);
  assert.equal(first.dedupeState, "deferred");
  assert.equal(first.summaryLimited, false);
  assert.equal(first.rawAvailable, true);
  assert.equal(first.httpStatus, 200);
  assert.equal(first.durationMs, 0);
});

test("列表行透出内部 step ID：交互内容深链接据此自动展开「本步新增」", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  seedListRows(fixture, {count: 3, withPreview: true});
  const selected = selectExportExchangeRefs(fixture.db, {
    scope: "all",
    categories: [],
    exchangeLimit: 10,
    deferBaseline: true,
  });
  const rows = loadExportListRows(fixture.db, selected.refs, {
    requestDedupeStates: new Map(),
    deferred: true,
  });
  // URL 的 step 参数是内部 AgentStep.id；列表行必须透出同一个 ID 空间的值，
  // 前端才能把「精确到 step 的深链接」对应到具体一行（2026-09-18）。
  assert.deepEqual(
    rows.map(row => row.agentStepId).sort(),
    ["astep-list-0", "astep-list-1", "astep-list-2"],
  );
  const target = rows.find(row => row.agentStepId === "astep-list-2")!;
  assert.equal(target.exchangeId, "exchange-list-2");
});

test("已物化排重状态按 compared / not_applicable / unconfirmed 如实映射", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  seedListRows(fixture, {count: 3, withPreview: true});
  const selected = selectExportExchangeRefs(fixture.db, {
    scope: "all",
    categories: [],
    exchangeLimit: 10,
    deferBaseline: true,
  });
  const rows = loadExportListRows(fixture.db, selected.refs, {
    requestDedupeStates: new Map([
      ["exchange-list-0", "compared"],
      ["exchange-list-1", "not_applicable"],
      ["exchange-list-2", "unconfirmed"],
    ]),
    deferred: true,
  });
  const byId = new Map(rows.map(row => [row.exchangeId, row.dedupeState]));
  assert.equal(byId.get("exchange-list-0"), "compared");
  assert.equal(byId.get("exchange-list-1"), "not_applicable");
  assert.equal(byId.get("exchange-list-2"), "unconfirmed");
});

test("摘要不可用时如实标注（不冒充完整数据）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  seedListRows(fixture, {count: 1, withPreview: false});
  const selected = selectExportExchangeRefs(fixture.db, {
    scope: "all",
    categories: [],
    exchangeLimit: 10,
    deferBaseline: true,
  });
  const rows = loadExportListRows(fixture.db, selected.refs, {
    requestDedupeStates: new Map(),
    deferred: false,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.summaryLimited, true);
  assert.equal(rows[0]!.requestSummary, undefined);
  assert.equal(rows[0]!.dedupeState, "unconfirmed");
});

test("导入降级诊断透出到列表行（骨架缺失/借用/正文不完整）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  seedListRows(fixture, {
    count: 1,
    withPreview: true,
    diagnostics: ["request_skeleton_missing"],
  });
  const selected = selectExportExchangeRefs(fixture.db, {
    scope: "all",
    categories: [],
    exchangeLimit: 10,
    deferBaseline: true,
  });
  const rows = loadExportListRows(fixture.db, selected.refs, {
    requestDedupeStates: new Map(),
    deferred: true,
  });
  assert.equal(rows[0]!.degraded, "skeleton_missing");
});

test("summaryOnly 事件流零 raw 读取、零正文事件，且可跳过候选总数", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  seedListRows(fixture, {count: 2, withPreview: true});
  const events: ExportContentEvent[] = [];
  for await (const event of iterateExportContentEvents({
    db: fixture.db,
    dataDir: fixture.dataDir,
    filters: {
      scope: "all",
      categories: [],
      exchangeLimit: 25,
      summaryOnly: true,
      deferBaseline: true,
      includeInherited: false,
      includeInheritedExplicit: true,
      skipCandidateCount: true,
    },
  })) events.push(event);

  const types = events.map(event => event.type);
  assert.deepEqual(types, ["page_start", "exchange_summary", "exchange_summary", "page_end"]);
  assert.equal(events.some(event => event.type === "item_start"), false);
  assert.equal(events.some(event => event.type === "text_chunk"), false);
  assert.equal(events.some(event => event.type === "exchange_error"), false);
  const pageStart = events[0];
  assert.equal(pageStart?.type, "page_start");
  if (pageStart?.type !== "page_start") throw new Error("缺少 page_start");
  // 跳过大范围 COUNT 时不得伪造 0：字段缺省，UI 显示「总数未统计」。
  assert.equal(pageStart.candidateCount, undefined);
  const summary = events[1];
  assert.equal(summary?.type, "exchange_summary");
  if (summary?.type !== "exchange_summary") throw new Error("缺少 exchange_summary");
  assert.equal(summary.rawAvailable, true);
});

test("summaryOnly 全局无范围查询命中时间索引（不退化全表排序）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  seedListRows(fixture, {count: 3, withPreview: true});
  const plan = fixture.db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT r.exchange_id FROM raw_exchange_refs r
     JOIN agent_steps st ON st.exchange_id = r.exchange_id
     ORDER BY r.captured_at DESC, r.exchange_id DESC LIMIT 26`,
  ).all() as Array<{detail: string}>;
  const details = plan.map(row => row.detail).join(" | ");
  assert.match(details, /idx_raw_captured/);
});
