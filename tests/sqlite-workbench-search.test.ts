import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  loadWorkbenchSessionSearch,
} from "../src/lib/db/workbench-search.js";
import { loadWorkbenchTree } from "../src/lib/db/workbench-queries.js";
import {
  parseOptionalWorkbenchRange,
} from "../src/lib/workbench-time-range.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

interface SeedOptions {
  sessionCount?: number;
}

/** 直接向派生表写入有界会话树：两个供应商 × Agent 分组，session/thread/turn 三级。 */
async function seedSearchFixture(options: SeedOptions = {}): Promise<SqliteFixture> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const sessionCount = options.sessionCount ?? 6;
  const insertSession = fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, source, confidence, start_time, end_time,
      model_set_json, request_count, thread_count
    ) VALUES(?, ?, ?, ?, ?, ?, 'fixture', 'exact', ?, ?, '["gpt-fixture"]', ?, ?)`
  );
  const insertThread = fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, parent_agent_thread_id, external_thread_id,
      source, display_name, confidence, is_root, is_placeholder,
      start_time, end_time, model_set_json, request_count, turn_count
    ) VALUES(?, ?, ?, ?, 'fixture', ?, 'exact', ?, 0, ?, ?, '["gpt-fixture"]', ?, ?)`
  );
  const insertTurn = fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time,
      model_set_json, step_count, auxiliary_request_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 0, ?, ?, ?,
      '["gpt-fixture"]', ?, 0)`
  );
  const base = Date.parse("2026-08-01T00:00:00.000Z");
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
     VALUES('captures/v2/search-fixture.jsonl', 'search-file', 1000000, ?) RETURNING id`,
  ).pluck().get(new Date(base).toISOString()) as number;

  for (let index = 0; index < sessionCount; index += 1) {
    // 前一半属于 bigmodel · codex，后一半属于 catapi · claude。
    const group = index < Math.ceil(sessionCount / 2)
      ? { targetId: "target-bigmodel", targetName: "BigModel", fingerprint: "fp-bigmodel", agent: "codex" }
      : { targetId: "target-catapi", targetName: "CatAPI", fingerprint: "fp-catapi", agent: "claude" };
    const sessionId = `session-${String(index).padStart(3, "0")}`;
    const externalId = `ext-DEMO-${String(index).padStart(3, "0")}`;
    const startTime = new Date(base + index * 3_600_000).toISOString();
    const endTime = new Date(base + index * 3_600_000 + 1_800_000).toISOString();
    insertSession.run(
      sessionId,
      group.targetId,
      group.targetName,
      group.fingerprint,
      group.agent,
      externalId,
      startTime,
      endTime,
      1,
      1,
    );
    const threadId = `${sessionId}-thread`;
    insertThread.run(
      threadId,
      sessionId,
      null,
      `ext-thread-${index}`,
      `会话 ${index} 根 Thread`,
      1,
      startTime,
      endTime,
      1,
      2,
    );
    for (let turnIndex = 0; turnIndex < 2; turnIndex += 1) {
      const turnId = `${threadId}-turn-${turnIndex}`;
      insertTurn.run(
        turnId,
        sessionId,
        threadId,
        `${turnId}-exchange`,
        startTime,
        new Date(Date.parse(startTime) + (turnIndex + 1) * 60_000).toISOString(),
        turnIndex + 1,
      );
    }
    // 空壳 Session 过滤（2026-09-17）：树候选必须有真实 Step——每会话补一条。
    const stepExchangeId = `${sessionId}-exchange`;
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset,
        line_length_bytes, captured_at, completed_at, target_id,
        target_name, agent_name, agent_fingerprint_id, status,
        is_streaming, request_body_bytes, response_body_bytes
      ) VALUES(?, 'capture-search', ?, 0, 100, ?, ?,
        ?, ?, ?, ?, 200, 0, 10, 10)`
    ).run(stepExchangeId, sourceId, startTime, endTime, group.targetId, group.targetName, group.agent, group.fingerprint);
    fixture.db.prepare(
      `INSERT INTO agent_steps(
        id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
        step_index, timestamp, phase, request_action, response_action
      ) VALUES(?, ?, ?, ?, ?, 1, ?, 'final_answer', 'user_prompt', 'final')`
    ).run(`${threadId}-step`, stepExchangeId, sessionId, threadId, `${threadId}-turn-0`, startTime);
  }
  return fixture;
}

describe("会话树模糊搜索（有界）", () => {
  test("外部 Session ID 大小写不敏感子串命中，并按供应商 × Agent 分组展开 Thread/Turn", async () => {
    const fixture = await seedSearchFixture();
    const result = loadWorkbenchSessionSearch(
      fixture.db,
      new URLSearchParams("q=demo-002"),
    );
    assert.equal(result.query, "demo-002");
    assert.equal(result.candidateCount, 1);
    assert.equal(result.groups.length, 1);
    const group = result.groups[0];
    // Agent 维度会话（2026-09-17）：分组键为 Agent，不再含 target。
    assert.equal(group.agentFingerprintId, "fp-bigmodel");
    assert.equal(group.agentName, "codex");
    assert.equal(group.sessions.length, 1);
    const session = group.sessions[0];
    assert.equal(session.externalSessionId, "ext-DEMO-002");
    assert.equal(session.threadCount, 1);
    assert.equal(session.threadsLimited, false);
    assert.equal(session.threads.length, 1);
    const thread = session.threads[0];
    assert.equal(thread.displayName, "会话 2 根 Thread");
    assert.equal(thread.turnCount, 2);
    assert.equal(thread.turns.length, 2);
    assert.equal(thread.turns[0].stepCount, 2);
    assert.equal(thread.turnsLimited, false);
  });

  test("内部 Session ID 也能命中；LIKE 通配符按字面量处理", async () => {
    const fixture = await seedSearchFixture();
    const byInternal = loadWorkbenchSessionSearch(
      fixture.db,
      new URLSearchParams("q=session-004"),
    );
    assert.equal(byInternal.candidateCount, 1);
    assert.equal(byInternal.groups[0]?.agentName, "claude");

    const wildcard = loadWorkbenchSessionSearch(
      fixture.db,
      new URLSearchParams("q=%"),
    );
    assert.equal(wildcard.candidateCount, 0, "% 必须按字面量匹配，不充当通配符");

    const underscore = loadWorkbenchSessionSearch(
      fixture.db,
      new URLSearchParams("q=session_000"),
    );
    assert.equal(underscore.candidateCount, 0, "_ 必须按字面量匹配，不充当单字符通配符");
  });

  test("同一查询命中多个分组时逐组返回；空查询返回空结果", async () => {
    const fixture = await seedSearchFixture();
    const all = loadWorkbenchSessionSearch(fixture.db, new URLSearchParams("q=ext-demo"));
    assert.equal(all.candidateCount, 6);
    // 两个 Agent 指纹（codex/claude）各自成组；同 Agent 跨 target 不再拆组。
    assert.equal(all.groups.length, 2);
    assert.deepEqual(
      all.groups.map(group => group.agentName).sort(),
      ["claude", "codex"],
    );

    const empty = loadWorkbenchSessionSearch(fixture.db, new URLSearchParams("q="));
    assert.equal(empty.candidateCount, 0);
    assert.equal(empty.groups.length, 0);
  });

  test("时间范围过滤会话：与 [start,end) 重叠的会话才返回", async () => {
    const fixture = await seedSearchFixture();
    // 会话 0 的区间是 [00:00, 00:30)，会话 1 是 [01:00, 01:30)。
    const params = new URLSearchParams("q=ext-demo");
    params.set("start", "2026-08-01T00:00:00.000Z");
    params.set("end", "2026-08-01T01:00:00.000Z");
    const result = loadWorkbenchSessionSearch(fixture.db, params);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.groups[0]?.sessions[0]?.externalSessionId, "ext-DEMO-000");
  });

  test("超过 limit 的结果有 hasMore/cursor，processedCount 反映 limit+1 哨兵读取", async () => {
    const fixture = await seedSearchFixture({ sessionCount: 8 });
    const params = new URLSearchParams("q=ext-demo");
    params.set("limit", "3");
    const firstPage = loadWorkbenchSessionSearch(fixture.db, params);
    assert.equal(firstPage.candidateCount, 8);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.limited, true);
    assert.equal(firstPage.processedCount, 4);
    assert.ok(firstPage.nextCursor);
    assert.equal(
      firstPage.groups.reduce((sum, group) => sum + group.sessions.length, 0),
      3,
    );

    const nextParams = new URLSearchParams("q=ext-demo");
    nextParams.set("limit", "3");
    nextParams.set("cursor", firstPage.nextCursor!);
    const secondPage = loadWorkbenchSessionSearch(fixture.db, nextParams);
    assert.equal(secondPage.hasMore, true);
    const firstPageIds = firstPage.groups
      .flatMap(group => group.sessions.map(session => session.id))
      .sort();
    const secondPageIds = secondPage.groups
      .flatMap(group => group.sessions.map(session => session.id))
      .sort();
    for (const id of secondPageIds) {
      assert.ok(!firstPageIds.includes(id), `cursor 翻页不应重复返回 ${id}`);
    }
  });

  test("Thread/Turn 预览有界：超出部分折叠为 limited 标记且不伪装完整", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    fixture.db.prepare(
      `INSERT INTO agent_sessions(
        id, target_id, target_name, agent_fingerprint_id, agent_name,
        external_session_id, source, confidence, start_time, end_time,
        model_set_json, request_count, thread_count
      ) VALUES('session-many', 'target-many', 'Many Target', 'fp-many', 'codex',
        'ext-many', 'fixture', 'exact', ?, ?, '[]', 1, 12)`
    ).run(new Date(base).toISOString(), new Date(base + 1000).toISOString());
    const insertThread = fixture.db.prepare(
      `INSERT INTO agent_threads(
        id, agent_session_id, parent_agent_thread_id, external_thread_id,
        source, display_name, confidence, is_root, is_placeholder,
        start_time, end_time, model_set_json, request_count, turn_count
      ) VALUES(?, 'session-many', ?, ?, 'fixture', ?, 'exact', 1, 0, ?, ?,
        '[]', 1, ?)`
    );
    const insertTurn = fixture.db.prepare(
      `INSERT INTO agent_turns(
        id, agent_session_id, agent_thread_id, source, confidence, status,
        segment_index, start_exchange_id, start_time, end_time,
        model_set_json, step_count, auxiliary_request_count
      ) VALUES(?, 'session-many', ?, 'fixture', 'exact', 'closed', 0, ?, ?, ?,
        '[]', 1, 0)`
    );
    for (let threadIndex = 0; threadIndex < 12; threadIndex += 1) {
      const threadId = `many-thread-${String(threadIndex).padStart(2, "0")}`;
      const threadStart = new Date(base + threadIndex * 60_000).toISOString();
      insertThread.run(
        threadId,
        null,
        `many-ext-${threadIndex}`,
        `Many Thread ${threadIndex}`,
        threadStart,
        new Date(base + threadIndex * 60_000 + 30_000).toISOString(),
        30,
      );
      for (let turnIndex = 0; turnIndex < 30; turnIndex += 1) {
        const turnId = `${threadId}-turn-${String(turnIndex).padStart(2, "0")}`;
        insertTurn.run(
          turnId,
          threadId,
          `${turnId}-exchange`,
          threadStart,
          new Date(base + threadIndex * 60_000 + (turnIndex + 1) * 1_000).toISOString(),
        );
      }
    }

    const result = loadWorkbenchSessionSearch(
      fixture.db,
      new URLSearchParams("q=ext-many"),
    );
    assert.equal(result.candidateCount, 1);
    const session = result.groups[0]?.sessions[0];
    assert.ok(session);
    assert.equal(session.threadCount, 12);
    assert.equal(session.threads.length, 10);
    assert.equal(session.threadsLimited, true, "Thread 超过预览上限必须带 limited 标记");
    const thread = session.threads[0];
    // threads 按 end_time 倒序：首个预览是 Many Thread 11（base + 11 分钟）。
    assert.equal(thread.displayName, "Many Thread 11");
    assert.equal(thread.turnCount, 30);
    assert.equal(thread.turns.length, 20);
    assert.equal(thread.turnsLimited, true, "Turn 超过预览上限必须带 limited 标记");
    // 只返回最新 20 个 turn：首条应是最晚结束（第 30 秒）那一条（end_time 倒序）。
    assert.equal(
      thread.turns[0].endTime,
      new Date(base + 11 * 60_000 + 30_000).toISOString(),
    );  });
});

describe("会话树时间范围过滤", () => {
  test("loadWorkbenchTree 按 [start,end) 重叠语义过滤，统计同步收敛", async () => {
    const fixture = await seedSearchFixture();
    const params = new URLSearchParams();
    params.set("treeScope", "global");
    params.set("start", "2026-08-01T00:00:00.000Z");
    params.set("end", "2026-08-01T02:00:00.000Z");
    const tree = loadWorkbenchTree(fixture.db, params, { includeAllTargets: true });
    const sessions = tree.agents.flatMap(group => group.sessions);
    assert.equal(tree.candidateCount, 2);
    assert.equal(sessions.length, 2);
    for (const session of sessions) {
      assert.ok(session.endTime >= "2026-08-01T00:00:00.000Z");
      assert.ok(session.startTime < "2026-08-01T02:00:00.000Z");
    }
  });

  test("不带时间参数时保持既有行为（全量候选）", async () => {
    const fixture = await seedSearchFixture();
    const tree = loadWorkbenchTree(
      fixture.db,
      new URLSearchParams("treeScope=global"),
      { includeAllTargets: true },
    );
    assert.equal(tree.candidateCount, 6);
  });

  test("parseOptionalWorkbenchRange 不再钳制跨度并忽略非法值", () => {
    // 2026-09-21 用户确认：跨度不设上限（统一受保留窗口约束），仅做合法性校验。
    const wide = parseOptionalWorkbenchRange(new URLSearchParams(
      "start=2026-01-01T00:00:00.000Z&end=2026-03-01T00:00:00.000Z",
    ));
    assert.ok(wide);
    assert.equal(wide.start, "2026-01-01T00:00:00.000Z");
    assert.equal(wide.end, "2026-03-01T00:00:00.000Z");

    const invalid = parseOptionalWorkbenchRange(new URLSearchParams(
      "start=not-a-date&end=2026-03-01T00:00:00.000Z",
    ));
    assert.equal(invalid, undefined);

    const absent = parseOptionalWorkbenchRange(new URLSearchParams());
    assert.equal(absent, undefined);
  });
});
