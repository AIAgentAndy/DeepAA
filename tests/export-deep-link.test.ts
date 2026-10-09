import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  loadLatestExportSession,
  resolveExportDeepLinkRedirect,
  resolveExportThreadContext,
  resolveExportTurnContext,
} from "../src/lib/db/export-queries.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

interface SeedResult {
  sessionIds: string[];
  threadIds: string[];
  turnIds: string[];
  stepId: string;
}

/** 最小层级夹具：两个 target 各一个 session，首个 session 两个 thread、每 thread 一个 turn，另含一个 step。 */
async function seedHierarchy(): Promise<{fixture: SqliteFixture; seeded: SeedResult}> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  fixture.db.prepare(
    `INSERT INTO ingestion_sources(relative_path, file_id, byte_offset, scan_offset, file_size, processed_count, status, updated_at)
     VALUES('captures/v2/deep-link.jsonl', 'deep-link', 0, 0, 1000, 0, 'ready', '2026-09-17T00:00:00.000Z')
     RETURNING id`,
  ).run();
  const sourceId = fixture.db.prepare(
    `SELECT id FROM ingestion_sources WHERE relative_path = 'captures/v2/deep-link.jsonl'`,
  ).pluck().get() as number;

  const insertSession = fixture.db.prepare(
    `INSERT INTO agent_sessions(
       id, target_id, target_name, agent_fingerprint_id, agent_name,
       external_session_id, source, confidence, start_time, end_time,
       request_count, thread_count
     ) VALUES(?, ?, ?, 'fp', ?, ?, 'fixture', 'exact', ?, ?, 1, 1)`,
  );
  // session-1（target-a / codex）end_time 较新；session-2（target-b / claude-code）较早。
  insertSession.run("asess-1", "target-a", "Target A", "codex", "s1", "2026-09-17T00:00:00.000Z", "2026-09-17T02:00:00.000Z");
  insertSession.run("asess-2", "target-b", "Target B", "claude-code", "s2", "2026-09-17T00:00:00.000Z", "2026-09-17T01:00:00.000Z");

  const insertThread = fixture.db.prepare(
    `INSERT INTO agent_threads(
       id, agent_session_id, source, display_name, confidence, is_root,
       start_time, end_time, request_count, turn_count
     ) VALUES(?, ?, 'fixture', ?, 'exact', 1, ?, ?, 1, 1)`,
  );
  insertThread.run("athread-1", "asess-1", "t1", "2026-09-17T00:00:00.000Z", "2026-09-17T02:00:00.000Z");
  insertThread.run("athread-2", "asess-1", "t2", "2026-09-17T00:00:00.000Z", "2026-09-17T01:30:00.000Z");
  insertThread.run("athread-3", "asess-2", "t3", "2026-09-17T00:00:00.000Z", "2026-09-17T01:00:00.000Z");

  const insertTurn = fixture.db.prepare(
    `INSERT INTO agent_turns(
       id, agent_session_id, agent_thread_id, source, confidence, status,
       segment_index, start_exchange_id, start_time, end_time, step_count
     ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 0, 'ex-1', ?, ?, 1)`,
  );
  insertTurn.run("aturn-1", "asess-1", "athread-1", "2026-09-17T00:10:00.000Z", "2026-09-17T00:20:00.000Z");
  insertTurn.run("aturn-2", "asess-2", "athread-3", "2026-09-17T00:10:00.000Z", "2026-09-17T00:20:00.000Z");

  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
       exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
       captured_at, completed_at, target_id, target_name, agent_name,
       agent_fingerprint_id, model, status, is_streaming,
       request_body_bytes, response_body_bytes
     ) VALUES('ex-deep-link', 'cap', ?, 0, 128, ?, ?, 'target-a', 'Target A',
       'codex', 'fp', 'fixture-model', 200, 0, 16, 16)`,
  ).run(sourceId, "2026-09-17T00:10:00.000Z", "2026-09-17T00:12:00.000Z");
  fixture.db.prepare(
    `INSERT INTO agent_steps(
       id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
       step_index, timestamp, phase, request_action, response_action
     ) VALUES('astep-1', 'ex-deep-link', 'asess-1', 'athread-1', 'aturn-1',
       0, '2026-09-17T00:10:00.000Z', 'model', 'model_request', 'model_response')`,
  ).run();

  return {
    fixture,
    seeded: {
      sessionIds: ["asess-1", "asess-2"],
      threadIds: ["athread-1", "athread-2", "athread-3"],
      turnIds: ["aturn-1", "aturn-2"],
      stepId: "astep-1",
    },
  };
}

test("Thread 深链接沿外键回填缺失 session", async () => {
  const {fixture} = await seedHierarchy();
  assert.deepEqual(
    resolveExportThreadContext(fixture.db, "athread-2"),
    {sessionId: "asess-1"},
  );
  assert.deepEqual(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], thread: "athread-2"}),
    {session: "asess-1"},
  );
});

test("Turn 深链接回填缺失 thread 与 session，已显式给出的一致父级不重复回填", async () => {
  const {fixture} = await seedHierarchy();
  assert.deepEqual(
    resolveExportTurnContext(fixture.db, "aturn-1"),
    {sessionId: "asess-1", threadId: "athread-1"},
  );
  assert.deepEqual(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], turn: "aturn-1"}),
    {thread: "athread-1", session: "asess-1"},
  );
  // 已给 thread 时只补 session。
  assert.deepEqual(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], turn: "aturn-1", thread: "athread-1"}),
    {session: "asess-1"},
  );
});

test("显式父级与解析结果冲突时不回填（从属关系校验）", async () => {
  const {fixture} = await seedHierarchy();
  assert.equal(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], turn: "aturn-1", session: "asess-2"}),
    undefined,
  );
  assert.equal(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], thread: "athread-1", session: "asess-2"}),
    undefined,
  );
});

test("范围参数全空时自动选中最新 session，并按 target/agent 过滤", async () => {
  const {fixture} = await seedHierarchy();
  // 全局最新 = end_time 最晚的 asess-1。
  assert.deepEqual(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: []}),
    {session: "asess-1"},
  );
  assert.equal(loadLatestExportSession(fixture.db, [], []), "asess-1");
  // 按 target 过滤后取该 target 内最新。
  assert.equal(loadLatestExportSession(fixture.db, ["target-b"], []), "asess-2");
  assert.deepEqual(
    resolveExportDeepLinkRedirect(fixture.db, {targets: ["target-b"], agents: []}),
    {session: "asess-2"},
  );
  assert.equal(loadLatestExportSession(fixture.db, [], ["claude-code"]), "asess-2");
  // 过滤无命中：不跳转。
  assert.equal(loadLatestExportSession(fixture.db, ["target-x"], []), undefined);
  assert.equal(
    resolveExportDeepLinkRedirect(fixture.db, {targets: ["target-x"], agents: []}),
    undefined,
  );
});

test("Step 深链接回填整条从属链（含 target/agent），链上冲突时整链不回填", async () => {
  const {fixture} = await seedHierarchy();
  assert.deepEqual(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], step: "astep-1"}),
    {
      session: "asess-1",
      thread: "athread-1",
      turn: "aturn-1",
      target: "target-a",
      agent: "codex",
    },
  );
  // 上级齐全且 target/agent 已显式给出：无需跳转。
  assert.equal(
    resolveExportDeepLinkRedirect(fixture.db, {
      targets: ["target-a"], agents: ["codex"],
      session: "asess-1", thread: "athread-1", turn: "aturn-1", step: "astep-1",
    }),
    undefined,
  );
  // 显式 session 与 step 从属链冲突：整链不回填。
  assert.equal(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], session: "asess-2", step: "astep-1"}),
    undefined,
  );
  // 不存在的 step：不跳转。
  assert.equal(
    resolveExportDeepLinkRedirect(fixture.db, {targets: [], agents: [], step: "astep-404"}),
    undefined,
  );
});
