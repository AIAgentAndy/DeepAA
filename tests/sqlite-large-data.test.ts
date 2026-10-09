import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadExportConversation } from "../src/lib/export-conversation.js";
import { planExportContentPage } from "../src/lib/export-page-plan.js";
import {
  loadApiAgentSteps,
  loadWorkbenchTree,
} from "../src/lib/db/workbench-queries.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const HIERARCHY_GROUP_COUNT = 25_000;
const fixtures: SqliteFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

test("十万层级行仍按索引返回最新 50 条并在读取 raw 前限流", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  seedLargeHierarchy(fixture);

  const page = loadWorkbenchTree(
    fixture.db,
    new URLSearchParams({ target: "target-large", agent: "codex" }),
    { limit: 50 },
  );
  const sessions = page.agents.flatMap(agent => agent.sessions);
  assert.equal(sessions.length, 50);
  assert.equal(page.candidateCount, HIERARCHY_GROUP_COUNT);
  assert.equal(page.processedCount, 51);
  assert.equal(page.hasMore, true);
  assert.equal(sessions[0]?.id, sessionId(HIERARCHY_GROUP_COUNT - 1));
  assert.ok(page.nextCursor);

  const secondPage = loadWorkbenchTree(
    fixture.db,
    new URLSearchParams({
      target: "target-large",
      agent: "codex",
      cursor: page.nextCursor!,
    }),
    { limit: 50 },
  );
  const secondPageSessions = secondPage.agents.flatMap(agent => agent.sessions);
  assert.equal(secondPageSessions.length, 50);
  assert.equal(secondPage.processedCount, 51);
  assert.equal(secondPageSessions[0]?.id, sessionId(HIERARCHY_GROUP_COUNT - 51));

  const targetedPlan = fixture.db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT id FROM agent_sessions
     WHERE target_id = ? AND agent_fingerprint_id = ?
     ORDER BY end_time DESC, id DESC LIMIT 51`,
  ).all("target-large", "fingerprint-large") as Array<{ detail: string }>;
  assert.ok(targetedPlan.some(row => row.detail.includes("idx_sessions_latest")));
  assert.ok(targetedPlan.every(row => !row.detail.includes("USE TEMP B-TREE")));

  const globalPlan = fixture.db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT id FROM agent_sessions
     ORDER BY end_time DESC, id DESC LIMIT 51`,
  ).all() as Array<{ detail: string }>;
  assert.ok(globalPlan.some(row => row.detail.includes("idx_sessions_global_latest")));
  assert.ok(globalPlan.every(row => !row.detail.includes("USE TEMP B-TREE")));

  const exactStep = loadApiAgentSteps(
    fixture.db,
    new URLSearchParams({ stepId: stepId(12_345, 1), limit: "100" }),
  );
  assert.equal(exactStep.candidateCount, 1);
  assert.equal(exactStep.processedCount, 1);
  assert.equal(exactStep.items[0]?.id, stepId(12_345, 1));

  let rawReadCount = 0;
  const exportResult = await loadExportConversation(fixture.dataDir, {
    session: sessionId(0),
    scope: "all",
    categories: [],
    exchangeLimit: 5,
    pageMaxBytes: 1024 * 1024,
  }, {
    db: fixture.db,
    rawReader: async () => {
      rawReadCount += 1;
      return undefined;
    },
  });
  assert.equal(exportResult.candidateCount, 10);
  assert.equal(exportResult.processedCount, 5);
  assert.equal(exportResult.page?.loadedExchangeIds.length, 5);
  assert.equal(rawReadCount, 0);

  const newestExchangeId = fixture.db.prepare(
    `SELECT r.exchange_id
     FROM raw_exchange_refs r
     JOIN agent_steps st ON st.exchange_id = r.exchange_id
     WHERE st.agent_session_id = ?
     ORDER BY r.captured_at DESC, r.exchange_id DESC
     LIMIT 1`,
  ).pluck().get(sessionId(0)) as string;
  const invalidPreviewJson = "{".repeat(2_048);
  fixture.db.prepare(
    `INSERT INTO exchange_content_previews(
      exchange_id, projection_version, preview_state, preview_json,
      size_bytes, candidate_item_count, processed_item_count,
      candidate_text_bytes, processed_text_bytes, candidate_count_exact,
      limited, truncated, limited_dimensions_json, created_at, updated_at
    ) VALUES(?, 1, 'limited', ?, ?, 1, 0, 1, 0, 0,
      1, 1, '["preview_bytes"]', ?, ?)`,
  ).run(
    newestExchangeId,
    invalidPreviewJson,
    Buffer.byteLength(invalidPreviewJson),
    "2026-07-22T00:00:00.000Z",
    "2026-07-22T00:00:00.000Z",
  );

  const byteLimited = await loadExportConversation(fixture.dataDir, {
    session: sessionId(0),
    scope: "all",
    categories: [],
    exchangeLimit: 5,
    pageMaxBytes: 1_024,
  }, {
    db: fixture.db,
    rawReader: async () => {
      rawReadCount += 1;
      throw new Error("普通导出不得读取 Raw");
    },
  });
  assert.equal(byteLimited.processedCount, 0);
  assert.equal(byteLimited.page?.loadedExchangeIds.length, 0);
  assert.equal(byteLimited.page?.dedupeBaselineStatus, "budget_blocked");
  assert.equal(byteLimited.page?.blockedExchangeId, newestExchangeId);
  assert.equal(rawReadCount, 0);

  const filteredPage = planExportContentPage(fixture.db, {
    target: ["target-large"],
    agent: ["codex"],
    scope: "all",
    categories: ["user_real"],
    categoriesExplicit: true,
    exchangeLimit: 5,
    pageMaxBytes: 1_024 * 1_024,
  });
  assert.equal(filteredPage.candidateCount, 25);
  assert.equal(filteredPage.candidateCountExact, true);
  assert.equal(filteredPage.visibleProcessedCount, 5);
  assert.equal(filteredPage.processedCount, 5);
  assert.equal(filteredPage.hasMoreOlder, true);
  assert.equal(filteredPage.filterProjectionMissingCount, 0);
  assert.equal(filteredPage.filterProjectionLimitedCount, 0);
  assert.deepEqual(
    filteredPage.visibleRefs.map(ref => ref.exchangeId),
    [24_000, 23_000, 22_000, 21_000, 20_000]
      .map(index => exchangeId(index, 1)),
  );
});

/**
 * 每组写一条 Session、Thread、Turn、Step，首组额外写 9 个 Step 供导出限流验证。
 * 事务内只写轻量列和 raw 引用，不创建或读取任何大正文。
 */
function seedLargeHierarchy(fixture: SqliteFixture): void {
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/large-fixture.jsonl', 'large-fixture', 0, 0,
      100000000, 0, 'ready', '2026-01-01T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  const insertSession = fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, source, confidence, start_time, end_time,
      model_set_json, request_count, thread_count
    ) VALUES(?, 'target-large', 'Large Target', 'fingerprint-large',
      'codex', ?, 'fixture', 'exact', ?, ?, '["gpt-large"]', ?, 1)`,
  );
  const insertThread = fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, external_thread_id, source, display_name,
      confidence, is_root, start_time, end_time, model_set_json,
      request_count, turn_count
    ) VALUES(?, ?, ?, 'fixture', 'Root Thread', 'exact', 1, ?, ?,
      '["gpt-large"]', ?, 1)`,
  );
  const insertClosure = fixture.db.prepare(
    "INSERT INTO thread_closure VALUES(?, ?, 0)",
  );
  const insertTurn = fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time,
      model_set_json, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?,
      '["gpt-large"]', ?)`,
  );
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-large', ?, ?, 128, ?, ?, 'target-large',
      'Large Target', 'codex', 'fingerprint-large', 'gpt-large', 200,
      0, 32, 32)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'final_answer', 'prompt', 'final')`,
  );
  const insertFilterStatus = fixture.db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      request_fingerprint_count, created_at, updated_at
    ) VALUES(?, 7, 'complete', 'complete', 'complete', 'not_required',
      'full_replay', 'none', 0, 1, ?, ?)`,
  );
  const insertCategory = fixture.db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, 'request', 'user_real', 1, 1, 0, 0)`,
  );

  fixture.db.transaction(() => {
    let rawOffset = 0;
    for (let index = 0; index < HIERARCHY_GROUP_COUNT; index += 1) {
      const timestamp = timestampFor(index);
      const session = sessionId(index);
      const thread = threadId(index);
      const turn = turnId(index);
      const stepCount = index === 0 ? 10 : 1;
      insertSession.run(session, `external-${index}`, timestamp, timestamp, stepCount);
      insertThread.run(thread, session, `external-thread-${index}`, timestamp, timestamp, stepCount);
      insertClosure.run(thread, thread);
      insertTurn.run(turn, session, thread, exchangeId(index, 1), timestamp, timestamp, stepCount);
      for (let stepIndex = 1; stepIndex <= stepCount; stepIndex += 1) {
        const exchange = exchangeId(index, stepIndex);
        insertRef.run(exchange, sourceId, rawOffset, timestamp, timestamp);
        insertStep.run(
          stepId(index, stepIndex),
          exchange,
          session,
          thread,
          turn,
          stepIndex,
          timestamp,
        );
        insertFilterStatus.run(exchange, timestamp, timestamp);
        if (stepIndex === 1 && index % 1_000 === 0) {
          insertCategory.run(exchange);
        }
        rawOffset += 128;
      }
    }
  })();
}

function padded(value: number): string {
  return String(value).padStart(5, "0");
}

function sessionId(index: number): string {
  return `session-large-${padded(index)}`;
}

function threadId(index: number): string {
  return `thread-large-${padded(index)}`;
}

function turnId(index: number): string {
  return `turn-large-${padded(index)}`;
}

function exchangeId(index: number, stepIndex: number): string {
  return `exchange-large-${padded(index)}-${stepIndex}`;
}

function stepId(index: number, stepIndex: number): string {
  return `step-large-${padded(index)}-${stepIndex}`;
}

function timestampFor(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
}
