import assert from "node:assert/strict";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import {
  storeRawBody,
  UnsafeRawBodyReferenceError,
} from "../src/lib/harness/raw-body.js";
import { discoverV2Sources } from "../src/lib/ingestion/raw-source-reader.js";
import { getDeepaaDatabase } from "../src/lib/db/connection.js";
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from "../src/lib/db/cursors.js";
import {
  loadSessionThreads,
  loadApiAgentSessions,
  loadApiAgentStepDetail,
  loadApiAgentSteps,
  loadApiAgentTurns,
  loadApiAgents,
  loadApiAuxiliaryRequests,
  loadApiCaptureExchangeRefs,
  loadApiCaptures,
  loadStoredStepArtifact,
  loadExchangeDetail,
  loadScopeSummary,
  loadThreadTurns,
  loadTurnSteps,
  loadWorkbenchTree,
  RawBodyExceedsPreviewBudgetError,
  resolveWorkbenchSelection,
  resolveCanonicalWorkbenchSelection,
  resolveApiAgentStepId,
  UnsafeRawReferenceError,
} from "../src/lib/db/workbench-queries.js";
import { workbenchRouteErrorResponse } from "../src/lib/db/route-responses.js";
import { parseWorkbenchTreePage } from "../src/components/workbench/use-workbench-selection.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

describe("SQLite 工作台有界查询", () => {
  test("兼容 API 在 SQL 读取前限制为 100 条并精确读取 Context/Diff", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 120);
    const stepId = `${tree.grandchildTurnId}-step-extra`;
    const sourceId = fixture.db.prepare(
      "SELECT id FROM ingestion_sources LIMIT 1",
    ).pluck().get() as number;
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset,
        line_length_bytes, captured_at, completed_at, target_id,
        target_name, agent_name, agent_fingerprint_id, status,
        is_streaming, request_body_bytes, response_body_bytes
      ) VALUES('aux-exchange', 'capture-workbench', ?, 900000, 100,
        '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.100Z',
        'target-workbench', 'Workbench Target', 'codex',
        'fingerprint-codex', 200, 0, 10, 10)`,
    ).run(sourceId);
    fixture.db.prepare(
      `INSERT INTO auxiliary_requests(
        id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
        target_id, agent_fingerprint_id, agent_name, kind, timestamp, duration_ms
      ) VALUES('aux-id', 'aux-exchange', ?, ?, ?, 'target-workbench',
        'fingerprint-codex', 'codex', 'metadata',
        '2026-07-17T00:00:00.000Z', 100)`,
    ).run(tree.oldSessionId, tree.grandchildThreadId, tree.grandchildTurnId);
    fixture.db.prepare(
      `INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes)
       VALUES(?, ?, ?)`,
    ).run(stepId, JSON.stringify({ snapshot: { stepId, marker: "context" } }), 64);
    fixture.db.prepare(
      `INSERT INTO step_diffs(agent_step_id, diff_json, size_bytes)
       VALUES(?, ?, ?)`,
    ).run(stepId, JSON.stringify({ toStepId: stepId, marker: "diff" }), 64);

    const sessions = loadApiAgentSessions(
      fixture.db,
      new URLSearchParams({ limit: "999" }),
    );
    const turns = loadApiAgentTurns(
      fixture.db,
      new URLSearchParams({ session: tree.oldSessionId, limit: "999" }),
    );
    const steps = loadApiAgentSteps(
      fixture.db,
      new URLSearchParams({ turn: tree.grandchildTurnId, limit: "999" }),
    );
    const captures = loadApiCaptures(
      fixture.db,
      new URLSearchParams({ limit: "999" }),
    );
    const agents = loadApiAgents(fixture.db, new URLSearchParams());
    const auxiliary = loadApiAuxiliaryRequests(
      fixture.db,
      new URLSearchParams({ turn: tree.grandchildTurnId }),
    );
    const captureRefs = loadApiCaptureExchangeRefs(
      fixture.db,
      "capture-workbench",
      new URLSearchParams({ limit: "2" }),
    );

    assert.equal(sessions.limit, 100);
    assert.equal(sessions.items.length, 100);
    assert.equal(sessions.processedCount, 100);
    assert.equal(sessions.candidateCount, 120);
    assert.equal(sessions.hasMore, true);
    assert.ok(turns.items.every((turn) => turn.agentSessionId === tree.oldSessionId));
    assert.ok(steps.items.every((step) => step.agentTurnId === tree.grandchildTurnId));
    assert.equal(steps.items[0]?.toolUseCount, 1);
    assert.equal(captures.items[0]?.captureSessionId, "capture-workbench");
    assert.equal(agents.items[0]?.agentName, "codex");
    assert.equal(auxiliary.items[0]?.exchangeId, "aux-exchange");
    assert.equal(captureRefs.items.length, 2);
    assert.equal(captureRefs.hasMore, true);
    assert.equal(resolveApiAgentStepId(fixture.db, stepId), stepId);
    assert.equal(
      resolveApiAgentStepId(fixture.db, tree.latestExchangeId),
      stepId,
    );
    assert.equal(
      loadStoredStepArtifact(fixture.db, stepId, "context")?.value.marker,
      "context",
    );
    assert.equal(
      loadStoredStepArtifact(fixture.db, stepId, "diff")?.value.marker,
      "diff",
    );
    assert.equal(loadStoredStepArtifact(fixture.db, "missing", "context"), undefined);
  });

  test("cursor 使用固定 base64url 格式且非法值 fail closed", () => {
    const cursor = encodeCursor({
      time: "2026-07-17T08:00:00.000Z",
      id: "session-cursor",
    });
    assert.deepEqual(decodeCursor(cursor), {
      time: "2026-07-17T08:00:00.000Z",
      id: "session-cursor",
    });
    assert.equal(decodeCursor(null), undefined);
    assert.throws(() => decodeCursor("not-a-cursor"), InvalidCursorError);
  });

  test("最新页之外的深链只补入目标 Session 且 Thread 统计包含后代", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 120);

    const page = loadWorkbenchTree(
      fixture.db,
      new URLSearchParams({ session: tree.oldSessionId }),
      { limit: 50 },
    );
    const sessions = page.agents.flatMap(agent => agent.sessions);

    assert.equal(sessions.length, 51);
    assert.equal(sessions.some(item => item.id === tree.oldSessionId), true);
    assert.ok(page.processedCount <= 51);
    assert.equal(page.candidateCount, 120);
    assert.equal(page.resolvedPath?.thread, tree.rootThreadId);
    assert.equal(
      loadScopeSummary(fixture.db, "thread", tree.rootThreadId)?.requestCount,
      6,
    );
  });

  test("首页全目标树只把 target 用于深链定位而不隐藏其他代理目标", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    fixture.db.prepare(
      `UPDATE agent_sessions
       SET target_id = 'target-other', target_name = 'Other Target'
       WHERE id = 'session-001'`,
    ).run();

    const page = loadWorkbenchTree(
      fixture.db,
      new URLSearchParams({
        target: "target-workbench",
        agent: "codex",
        session: tree.oldSessionId,
        thread: tree.rootThreadId,
      }),
      { limit: 50, includeAllTargets: true },
    );

    // Agent 维度会话（2026-09-17）：一 Agent 一组；target 只做深链定位参数，
    // 跨 target 的同 Agent 会话同组可见。
    const groupNames = page.agents.map(agent => agent.agentName).sort();
    assert.deepEqual(groupNames, ["codex"]);
    const sessionIds = page.agents
      .flatMap(agent => agent.sessions.map(session => session.id))
      .sort();
    assert.deepEqual(sessionIds, ["session-000", "session-001"]);
    assert.equal(page.resolvedPath?.session, tree.oldSessionId);
    assert.equal(page.resolvedPath?.thread, tree.rootThreadId);
  });

  /**
   * 契约往返（防字段漂移）：服务端 loadWorkbenchTree 的真实输出必须被客户端
   * parseWorkbenchTreePage 接受。两侧各自单测无法发现漂移——2026-09-17 分组改为
   * Agent 维度后，服务端不再发 targetId/targetName，而客户端校验器仍要求它们，
   * 导致会话树刷新被误判为「响应格式无效」。
   */
  test("会话树响应契约：服务端输出必须被客户端校验器接受", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 3);

    // 与会话追踪页首屏同源：全局范围 + 时间范围 + 深链。
    const page = loadWorkbenchTree(
      fixture.db,
      new URLSearchParams({
        session: tree.oldSessionId,
        thread: tree.rootThreadId,
        start: "2026-07-16T00:00:00.000Z",
        end: "2026-07-18T00:00:00.000Z",
      }),
      { limit: 50, includeAllTargets: true },
    );

    const parsed = parseWorkbenchTreePage(page);
    assert.ok(parsed, "客户端校验器拒绝了服务端真实响应（响应字段契约漂移）");
    const group = parsed.agents[0];
    assert.ok(group, "全局范围下应至少返回一个 Agent 分组");
    assert.equal(typeof group.agentFingerprintId, "string");
    assert.equal(typeof group.agentName, "string");
    assert.ok(group.sessions.length > 0);
    // 分组字段即客户端校验的完整契约：新增字段必须同步两端后再更新此处。
    assert.deepEqual(Object.keys(group).sort(), [
      "agentFingerprintId",
      "agentName",
      "sessions",
    ]);
  });

  test("首页树和最新路径排除没有真实 Step 的辅助 Session", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedWorkbenchTree(fixture, 2);
    fixture.db.exec(`
      INSERT INTO agent_sessions(
        id, target_id, target_name, agent_fingerprint_id, agent_name,
        source, confidence, start_time, end_time, request_count, thread_count
      ) VALUES(
        'session-aux-only', 'target-workbench', 'Workbench Target',
        'fingerprint-aux', 'codex', 'capture-session', 'low',
        '2026-07-19T00:00:00.000Z', '2099-07-19T00:00:00.000Z', 20, 1
      );
      INSERT INTO agent_threads(
        id, agent_session_id, source, display_name, confidence, is_root,
        start_time, end_time, request_count, turn_count
      ) VALUES(
        'thread-aux-only', 'session-aux-only', 'default-root', '根 Thread',
        'low', 1, '2026-07-19T00:00:00.000Z',
        '2099-07-19T00:00:00.000Z', 20, 0
      );
      INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth)
      VALUES('thread-aux-only', 'thread-aux-only', 0);
    `);

    const page = loadWorkbenchTree(fixture.db, new URLSearchParams(), { limit: 50 });
    const sessionIds = page.agents.flatMap(agent => agent.sessions.map(session => session.id));

    assert.equal(sessionIds.includes("session-aux-only"), false);
    assert.notEqual(page.latestPath?.session, "session-aux-only");
    assert.equal(page.candidateCount, 2);
  });

  test("Session cursor 翻页无重无漏且每页最多读取 limit + 1", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedWorkbenchTree(fixture, 23);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const params = new URLSearchParams({ limit: "7" });
      if (cursor) params.set("cursor", cursor);
      const page = loadWorkbenchTree(fixture.db, params);
      seen.push(...page.agents.flatMap(agent => agent.sessions.map(item => item.id)));
      assert.ok(page.processedCount <= 8);
      assert.equal(page.processedCount, page.hasMore ? 8 : page.processedCount);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23);
  });

  test("Session 模型集合由 SQL 按元素限制为 32 项和每项 256 字符", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedWorkbenchTree(fixture, 2);
    const models = [
      "m".repeat(300),
      ...Array.from({ length: 39 }, (_, index) => `model-${index + 1}`),
    ];
    fixture.db.prepare(
      "UPDATE agent_sessions SET model_set_json = ? WHERE id = ?",
    ).run(JSON.stringify(models), "session-001");

    const page = loadWorkbenchTree(fixture.db);
    const session = page.agents
      .flatMap(agent => agent.sessions)
      .find(item => item.id === "session-001");

    assert.equal(session?.modelSetLimited, true);
    assert.deepEqual(session?.modelSet, [
      "m".repeat(256),
      ...models.slice(1, 32),
    ]);
  });

  test("异常历史 model_set_json 稳定降级为空集合", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedWorkbenchTree(fixture, 2);
    fixture.db.prepare(
      "UPDATE agent_sessions SET model_set_json = ? WHERE id = ?",
    ).run("[\"broken\"", "session-001");

    const page = loadWorkbenchTree(fixture.db);
    const session = page.agents
      .flatMap(agent => agent.sessions)
      .find(item => item.id === "session-001");

    assert.deepEqual(session?.modelSet, []);
    assert.equal(session?.modelSetLimited, false);
  });

  test("最新页之外的精确 Session 复用同一模型集合 SQL 投影", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 120);
    const models = Array.from({ length: 35 }, (_, index) => `deep-model-${index}`);
    fixture.db.prepare(
      "UPDATE agent_sessions SET model_set_json = ? WHERE id = ?",
    ).run(JSON.stringify(models), tree.oldSessionId);

    const page = loadWorkbenchTree(
      fixture.db,
      new URLSearchParams({ session: tree.oldSessionId, limit: "50" }),
    );
    const session = page.agents
      .flatMap(agent => agent.sessions)
      .find(item => item.id === tree.oldSessionId);

    assert.deepEqual(session?.modelSet, models.slice(0, 32));
    assert.equal(session?.modelSetLimited, true);
  });

  test("Turn 或 Step 深链缺少 thread 时反查完整路径且祖先最多 32 层", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);

    const byTurn = resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({ turn: tree.grandchildTurnId }),
    );
    const byStep = resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({ step: tree.grandchildExchangeId }),
    );

    assert.equal(byTurn?.thread, tree.grandchildThreadId);
    assert.equal(byStep?.turn, tree.grandchildTurnId);
    assert.equal(byStep?.step, tree.grandchildStepId);
    assert.deepEqual(byStep?.ancestorThreadIds, [
      tree.rootThreadId,
      tree.childThreadId,
    ]);
    assert.ok((byStep?.ancestorThreadIds.length ?? 0) <= 32);
  });

  test("超过 32 层的 Thread 深链只返回最近 32 个祖先", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 1);
    const insertThread = fixture.db.prepare(
      `INSERT INTO agent_threads(
        id, agent_session_id, parent_agent_thread_id, source, display_name,
        confidence, is_root, start_time, end_time
      ) VALUES(?, ?, ?, 'fixture', ?, 'exact', 0, ?, ?)`,
    );
    const timestamp = "2026-07-17T00:00:00.000Z";
    const threadIds = [tree.rootThreadId];
    for (let depth = 1; depth <= 40; depth += 1) {
      const id = `thread-deep-${String(depth).padStart(2, "0")}`;
      insertThread.run(
        id,
        tree.oldSessionId,
        threadIds.at(-1),
        `Depth ${depth}`,
        timestamp,
        timestamp,
      );
      threadIds.push(id);
    }
    const descendant = threadIds.at(-1)!;
    const insertClosure = fixture.db.prepare(
      `INSERT INTO thread_closure(
        ancestor_thread_id, descendant_thread_id, depth
      ) VALUES(?, ?, ?)`,
    );
    for (let index = 0; index < threadIds.length; index += 1) {
      insertClosure.run(
        threadIds[index],
        descendant,
        threadIds.length - 1 - index,
      );
    }

    const path = resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({ thread: descendant }),
    );

    assert.equal(path?.ancestorThreadIds.length, 32);
    assert.equal(path?.ancestorThreadIds[0], "thread-deep-08");
    assert.equal(path?.ancestorThreadIds.at(-1), "thread-deep-39");
  });

  test("无参数恢复最新完整路径，只有 Session 时固定选择根 Thread", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const latestTime = "2026-07-18T00:00:00.000Z";
    fixture.db.prepare(
      "UPDATE agent_sessions SET end_time = ? WHERE id = ?",
    ).run(latestTime, tree.oldSessionId);
    fixture.db.prepare(
      "UPDATE agent_threads SET end_time = ? WHERE id = ?",
    ).run(latestTime, tree.grandchildThreadId);
    fixture.db.prepare(
      "UPDATE agent_turns SET end_time = ? WHERE id = ?",
    ).run(latestTime, tree.grandchildTurnId);

    const latest = resolveWorkbenchSelection(fixture.db);
    const sessionOnly = resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({ session: tree.oldSessionId }),
    );

    assert.deepEqual(latest, {
      target: "target-workbench",
      agent: "codex",
      session: tree.oldSessionId,
      thread: tree.grandchildThreadId,
      turn: tree.grandchildTurnId,
      step: tree.latestStepId,
      ancestorThreadIds: [tree.rootThreadId, tree.childThreadId],
    });
    assert.equal(sessionOnly?.thread, tree.rootThreadId);
    assert.equal(sessionOnly?.turn, undefined);
    assert.equal(sessionOnly?.step, undefined);
  });

  test("最新 Session 思考中无 Step 时 latestPath 落到上一个有数据的 Session", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 1);
    // 构造一个更新的「思考中」Session：有根 Thread 但 0 Turn / 0 Step / 0 账本行。
    fixture.db.exec(`
      INSERT INTO agent_sessions(
        id, target_id, target_name, agent_fingerprint_id, agent_name,
        external_session_id, source, confidence, start_time, end_time,
        model_set_json, request_count, thread_count
      ) VALUES(
        'session-thinking', 'target-workbench', 'Workbench Target',
        'fingerprint-codex', 'codex', 'external-thinking', 'fixture', 'exact',
        '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
        '["gpt-fixture"]', 0, 1
      );
      INSERT INTO agent_threads(
        id, agent_session_id, parent_agent_thread_id, external_thread_id,
        source, display_name, confidence, is_root, is_placeholder,
        start_time, end_time, model_set_json, request_count, turn_count
      ) VALUES(
        'thread-thinking-root', 'session-thinking', null,
        'external-thread-thinking', 'fixture', '思考中根 Thread', 'exact',
        1, 0, '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
        '["gpt-fixture"]', 0, 0
      );
      INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth)
      VALUES('thread-thinking-root', 'thread-thinking-root', 0);
    `);

    const latest = resolveWorkbenchSelection(fixture.db);

    // 自动选中必须跳过没有 Step 的新 Session，落到上一个有数据的完整路径，
    // 而不是停在「正在自动选择最新 Turn…」（2026-09-20 用户确认）。
    assert.deepEqual(latest, {
      target: "target-workbench",
      agent: "codex",
      session: tree.oldSessionId,
      thread: tree.grandchildThreadId,
      turn: tree.grandchildTurnId,
      step: tree.latestStepId,
      ancestorThreadIds: [tree.rootThreadId, tree.childThreadId],
    });
    // 显式深链到思考中 Session 仍然可达（只到 Thread 层级，由客户端自动下钻补全）。
    const explicit = resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({ session: "session-thinking" }),
    );
    assert.equal(explicit?.session, "session-thinking");
    assert.equal(explicit?.thread, "thread-thinking-root");
    assert.equal(explicit?.turn, undefined);
    assert.equal(explicit?.step, undefined);
  });

  test("范围内只有无 Step 的思考中 Session 时 latestPath 为空而不是空转", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec(`
      INSERT INTO agent_sessions(
        id, target_id, target_name, agent_fingerprint_id, agent_name,
        external_session_id, source, confidence, start_time, end_time,
        model_set_json, request_count, thread_count
      ) VALUES(
        'session-thinking', 'target-workbench', 'Workbench Target',
        'fingerprint-codex', 'codex', 'external-thinking', 'fixture', 'exact',
        '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
        '["gpt-fixture"]', 0, 1
      );
      INSERT INTO agent_threads(
        id, agent_session_id, parent_agent_thread_id, external_thread_id,
        source, display_name, confidence, is_root, is_placeholder,
        start_time, end_time, model_set_json, request_count, turn_count
      ) VALUES(
        'thread-thinking-root', 'session-thinking', null,
        'external-thread-thinking', 'fixture', '思考中根 Thread', 'exact',
        1, 0, '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
        '["gpt-fixture"]', 0, 0
      );
      INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth)
      VALUES('thread-thinking-root', 'thread-thinking-root', 0);
    `);

    // 没有任何可展示 Step 时不再指向空 Session 空转，而是按空状态处理。
    assert.equal(resolveWorkbenchSelection(fixture.db), undefined);
  });

  test("同时间 Thread 默认恢复到 usage_ledger 中最新的实际 Step", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 1);

    const threadEndTimes = fixture.db.prepare(
      "SELECT DISTINCT end_time FROM agent_threads WHERE agent_session_id = ?",
    ).pluck().all(tree.oldSessionId);
    const path = resolveWorkbenchSelection(fixture.db);
    const queryPlan = fixture.db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT st.agent_thread_id, st.agent_turn_id, st.exchange_id
       FROM usage_ledger ledger
       JOIN agent_steps st ON st.id = ledger.agent_step_id
       WHERE ledger.agent_session_id = ? AND ledger.agent_step_id IS NOT NULL
       ORDER BY ledger.created_at DESC, ledger.exchange_id DESC
       LIMIT 1`,
    ).all(tree.oldSessionId) as Array<{ detail: string }>;

    assert.equal(threadEndTimes.length, 1);
    assert.equal(path?.thread, tree.grandchildThreadId);
    assert.equal(path?.turn, tree.grandchildTurnId);
    assert.equal(path?.step, tree.latestStepId);
    assert.match(
      queryPlan.map(row => row.detail).join("\n"),
      /idx_usage_session_time/,
    );
  });

  test("精确 Step 路径拒绝不一致的上级参数", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);

    assert.equal(resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({
        session: "session-001",
        step: tree.grandchildStepId,
      }),
    ), undefined);
    assert.equal(resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({
        thread: tree.rootThreadId,
        step: tree.grandchildStepId,
      }),
    ), undefined);
  });

  test("内部 Step ID 与旧 Exchange ID 均精确解析并规范为内部 ID", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);

    const internal = resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({ step: tree.grandchildStepId }),
    );
    const legacy = resolveWorkbenchSelection(
      fixture.db,
      new URLSearchParams({ step: tree.grandchildExchangeId }),
    );

    assert.equal(internal?.step, tree.grandchildStepId);
    assert.deepEqual(legacy, internal);
  });

  test("规范选择逐级清除无效下级而保留有效 Turn", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);

    const path = resolveCanonicalWorkbenchSelection(
      fixture.db,
      new URLSearchParams({
        session: tree.oldSessionId,
        thread: tree.grandchildThreadId,
        turn: tree.grandchildTurnId,
        step: "exchange-invalid",
      }),
    );

    assert.equal(path?.turn, tree.grandchildTurnId);
    assert.equal(path?.step, undefined);
  });

  test("Thread 与 Turn 子节点查询均使用 limit + 1", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);

    const roots = loadSessionThreads(
      fixture.db,
      tree.oldSessionId,
      new URLSearchParams({ limit: "1" }),
    );
    const children = loadSessionThreads(
      fixture.db,
      tree.oldSessionId,
      new URLSearchParams({ parent: tree.rootThreadId, limit: "1" }),
    );
    const turns = loadThreadTurns(
      fixture.db,
      tree.grandchildThreadId,
      new URLSearchParams({ limit: "1" }),
    );

    assert.equal(roots?.items[0]?.id, tree.rootThreadId);
    assert.equal(children?.items[0]?.id, tree.childThreadId);
    assert.equal(turns?.items.length, 1);
    assert.equal(turns?.processedCount, 2);
    assert.equal(turns?.hasMore, true);
  });

  test("Step cursor 的 time 不是整数时保持 invalid_cursor 错误语义", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);

    assert.throws(() => loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({
        cursor: encodeCursor({ time: "not-an-index", id: "step-id" }),
      }),
    ), InvalidCursorError);
  });

  test("Step 页只读取 limit + 1 并汇总真实工具调用与结果状态", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);

    const page = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "1" }),
    );

    assert.equal(page.items.length, 1);
    assert.equal(page.processedCount, 2);
    assert.equal(page.items[0]?.toolUseCount, 1);
    assert.equal(page.items[0]?.toolResultCount, 1);
    assert.deepEqual(page.items[0]?.toolUseNames, ["Read"]);
  });

  test("意图统计按本 Turn 全部 Step 聚合，不随分页 limit 截断", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const insertSteps = seedIntentStatSteps(fixture, tree);
    // seed 已有 index 2/3 两条 tool_use；追加 error / incomplete / final /
    // retry_like（重试行的 request_action 恒为 retry_like，见 loadTurnIntentStats 口径）。
    insertSteps([
      {index: 4, requestAction: "continue", responseAction: "error", label: "继续工具调用", compressed: 0},
      {index: 5, requestAction: "continue", responseAction: "incomplete", label: "继续工具调用", compressed: 0},
      {index: 6, requestAction: "continue", responseAction: "final", label: "续接工具结果", compressed: 0},
      {index: 7, requestAction: "retry_like", responseAction: "tool_use", label: "重试", compressed: 0},
    ]);

    // 分页只返回最新 2 条，但意图统计必须覆盖本 Turn 全部 6 条 Step。
    const page = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "2" }),
    );

    assert.equal(page.items.length, 2);
    assert.equal(page.candidateCount, 6);
    assert.deepEqual(page.intentStats, {
      toolUseSteps: 3,
      retries: 1,
      interruptions: 2,
      finals: 1,
      compressions: 0,
    });
  });

  test("摘要标记压缩边界生成事件注解并从「完成」剔除生成调用", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const insertSteps = seedIntentStatSteps(fixture, tree);
    const insertSnapshot = fixture.db.prepare(
      `INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes)
       VALUES(?, ?, ?)`,
    );
    const markerEvidence = JSON.stringify({
      compaction: {
        kind: "summary_marker",
        confidence: "high",
        markerKind: "codex_summary",
        preview: "Another language model started to solve this problem",
      },
    });
    // seed 已有 index 2/3 两条 tool_use。index 4 = 压缩生成调用（final，无证据）；
    // index 5 = 压缩后首请求（标记证据）；6/7 = 摘要常驻/纯压缩态（不该再注解）。
    const ids = insertSteps([
      {index: 4, requestAction: "continue", responseAction: "final", label: "续接工具结果", compressed: 0},
      {index: 5, requestAction: "conversation_continue", responseAction: "tool_use", label: "上下文压缩", compressed: 1},
      {index: 6, requestAction: "conversation_continue", responseAction: "tool_use", label: "上下文压缩", compressed: 1},
      {index: 7, requestAction: "conversation_continue", responseAction: "tool_use", label: "上下文压缩", compressed: 1},
    ]);
    insertSnapshot.run(ids.get(5), markerEvidence, markerEvidence.length);
    insertSnapshot.run(ids.get(6), markerEvidence, markerEvidence.length);

    const page = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "10" }),
    );

    // finals 剔除压缩生成调用（index 4）；compressions 只计有证据的事件。
    assert.deepEqual(page.intentStats, {
      toolUseSteps: 5,
      retries: 0,
      interruptions: 0,
      finals: 0,
      compressions: 1,
    });
    const byIndex = new Map(page.items.map(item => [item.stepIndex, item]));
    assert.equal(byIndex.get(4)?.compactionRole, "generation");
    assert.equal(byIndex.get(4)?.compactionOrdinal, 1);
    assert.equal(byIndex.get(5)?.compactionRole, "first-after");
    assert.equal(byIndex.get(5)?.compactionOrdinal, 1);
    assert.equal(byIndex.get(6)?.compactionRole, undefined);
    assert.equal(byIndex.get(7)?.compactionRole, undefined);
    // 「上下文压缩」标签还原：事件步（index 5）保留；摘要常驻的后续步按
    // request_action 重算意图（conversation_continue → 远端状态续接），不再满屏压缩。
    assert.equal(byIndex.get(5)?.requestIntentLabel, "上下文压缩");
    assert.equal(byIndex.get(6)?.requestIntentLabel, "远端状态续接");
    assert.equal(byIndex.get(7)?.requestIntentLabel, "远端状态续接");

    // 深链 Step 详情携带同源 compactionEvent（概览条门控依据）与非事件步的还原标签。
    const detail = loadApiAgentStepDetail(fixture.db, ids.get(5)!);
    assert.deepEqual(detail?.compactionEvent, {role: "first-after", ordinal: 1});
    assert.equal(detail?.requestIntentLabel, "上下文压缩");
    const generationDetail = loadApiAgentStepDetail(fixture.db, ids.get(4)!);
    assert.deepEqual(generationDetail?.compactionEvent, {role: "generation", ordinal: 1});
    const persistentDetail = loadApiAgentStepDetail(fixture.db, ids.get(6)!);
    assert.equal(persistentDetail?.compactionEvent, undefined);
    assert.equal(persistentDetail?.requestIntentLabel, "远端状态续接");
  });

  test("纯裁剪边界无 wire 证据：不注解不计数，「完成」不受影响", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const insertSteps = seedIntentStatSteps(fixture, tree);
    // claude-code 形态：error 后本地裁剪，无摘要调用无标记。
    const ids = insertSteps([
      {index: 4, requestAction: "continue", responseAction: "error", label: "续接工具结果", compressed: 0},
      {index: 5, requestAction: "conversation_continue", responseAction: "tool_use", label: "上下文压缩", compressed: 1},
    ]);

    const page = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "10" }),
    );

    assert.deepEqual(page.intentStats, {
      toolUseSteps: 3,
      retries: 0,
      interruptions: 1,
      finals: 0,
      compressions: 0,
    });
    const byIndex = new Map(page.items.map(item => [item.stepIndex, item]));
    assert.equal(byIndex.get(5)?.compactionRole, undefined);
    const detail = loadApiAgentStepDetail(fixture.db, ids.get(5)!);
    assert.equal(detail?.compactionEvent, undefined);
  });

  test("purpose 头边界（dsh 形态）自身即压缩生成调用", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const insertSteps = seedIntentStatSteps(fixture, tree);
    const headerEvidence = JSON.stringify({
      compaction: {
        kind: "purpose_header",
        confidence: "exact",
        preview: "x-deepseek-harness-compact: 1",
      },
    });
    const ids = insertSteps([
      {index: 4, requestAction: "continue", responseAction: "tool_use", label: "续接工具结果", compressed: 0},
      {index: 5, requestAction: "unknown", responseAction: "final", label: "上下文压缩", compressed: 1},
    ]);
    fixture.db.prepare(
      `INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes)
       VALUES(?, ?, ?)`,
    ).run(ids.get(5), headerEvidence, headerEvidence.length);

    const page = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "10" }),
    );

    // 边界步响应为 final（压缩摘要）：自身 generation 并从「完成」剔除。
    assert.deepEqual(page.intentStats, {
      toolUseSteps: 3,
      retries: 0,
      interruptions: 0,
      finals: 0,
      compressions: 1,
    });
    const byIndex = new Map(page.items.map(item => [item.stepIndex, item]));
    assert.equal(byIndex.get(5)?.compactionRole, "generation");
  });

  test("turn 首步即压缩（跨 turn 持久状态）不算本 turn 事件", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const markerEvidence = JSON.stringify({
      compaction: {
        kind: "summary_marker",
        confidence: "high",
        markerKind: "continuation",
        preview: "This session is being continued from a previous conversation",
      },
    });
    // 在孙 Thread 新开一个 turn，首步即压缩态（上一 turn 的历史摘要常驻）。
    const turnId = `${tree.grandchildThreadId}-turn-carry`;
    fixture.db.prepare(
      `INSERT INTO agent_turns(
        id, agent_session_id, agent_thread_id, source, confidence, status,
        segment_index, start_exchange_id, start_time, end_time,
        model_set_json, step_count, auxiliary_request_count
      ) VALUES(?, 'session-000', ?, 'fixture', 'exact', 'closed', 3, ?, ?, ?,
        '["gpt-fixture"]', 1, 0)`,
    ).run(
      turnId,
      tree.grandchildThreadId,
      `${turnId}-exchange`,
      "2026-07-17T00:00:10.000Z",
      "2026-07-17T00:00:10.000Z",
    );
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset,
        line_length_bytes, captured_at, completed_at, target_id,
        target_name, agent_name, agent_fingerprint_id, status,
        is_streaming, request_body_bytes, response_body_bytes
      ) VALUES(?, 'capture-workbench', (SELECT id FROM ingestion_sources LIMIT 1), 600000, 100,
        ?, ?, 'target-workbench', 'Workbench Target', 'codex',
        'fingerprint-codex', 200, 0, 10, 10)`,
    ).run(`${turnId}-exchange`, "2026-07-17T00:00:10.000Z", "2026-07-17T00:00:10.000Z");
    fixture.db.prepare(
      `INSERT INTO agent_steps(
        id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
        step_index, timestamp, phase, request_action, response_action,
        request_intent_label, context_compressed
      ) VALUES(?, ?, 'session-000', ?, ?, 1, ?, 'tool', 'conversation_continue',
        'tool_use', '上下文压缩', 1)`,
    ).run(
      `${turnId}-step`,
      `${turnId}-exchange`,
      tree.grandchildThreadId,
      turnId,
      "2026-07-17T00:00:10.000Z",
    );
    fixture.db.prepare(
      `INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes)
       VALUES(?, ?, ?)`,
    ).run(`${turnId}-step`, markerEvidence, markerEvidence.length);

    const page = loadTurnSteps(
      fixture.db,
      turnId,
      new URLSearchParams({ limit: "5" }),
    );

    assert.deepEqual(page.intentStats, {
      toolUseSteps: 1,
      retries: 0,
      interruptions: 0,
      finals: 0,
      compressions: 0,
    });
    assert.equal(page.items[0]?.compactionRole, undefined);
  });

  test("Turn/Step 摘要透出 Agent 原生业务 ID，未上报时不伪造空值", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    fixture.db.prepare(
      "UPDATE agent_turns SET native_turn_id = ? WHERE id = ?",
    ).run("native-turn-1", tree.grandchildTurnId);
    fixture.db.prepare(
      "UPDATE agent_steps SET native_step_id = ? WHERE agent_turn_id = ?",
    ).run("native-step-1", tree.grandchildTurnId);

    const turns = loadThreadTurns(
      fixture.db,
      tree.grandchildThreadId,
      new URLSearchParams({ limit: "5" }),
    );
    assert.equal(turns?.items[0]?.nativeTurnId, "native-turn-1");

    const steps = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "5" }),
    );
    assert.equal(steps.items[0]?.nativeStepId, "native-step-1");

    // 未上报原生 ID 的行必须保持 undefined，UI 层据此隐藏对应业务 ID 行。
    const rootTurns = loadThreadTurns(
      fixture.db,
      tree.rootThreadId,
      new URLSearchParams({ limit: "5" }),
    );
    assert.equal(rootTurns?.items[0]?.nativeTurnId, undefined);
  });

  test("Session 与 Turn 直接读取单行聚合并保持命中率零分母语义", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const timestamp = "2026-07-17T00:00:00.000Z";
    const insertAggregate = fixture.db.prepare(
      `INSERT INTO scope_aggregates(
        scope_type, scope_id, step_request_count, auxiliary_request_count,
        input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
        vendor_cost, actual_cost, duration_total_ms, duration_sample_count,
        tool_call_count, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertAggregate.run(
      "session",
      tree.oldSessionId,
      6,
      0,
      0,
      0,
      0,
      30,
      1.5,
      0.5,
      0,
      0,
      6,
      timestamp,
    );
    insertAggregate.run(
      "turn",
      tree.grandchildTurnId,
      2,
      1,
      20,
      10,
      5,
      8,
      0.4,
      0.2,
      50,
      2,
      2,
      timestamp,
    );

    const session = loadScopeSummary(fixture.db, "session", tree.oldSessionId);
    const turn = loadScopeSummary(fixture.db, "turn", tree.grandchildTurnId);

    assert.equal(session?.requestCount, 6);
    assert.equal(session?.cacheHitRate, undefined);
    assert.equal(session?.averageDurationMs, undefined);
    assert.deepEqual(session?.tools, [{
      name: "Read",
      status: "completed",
      count: 6,
    }]);
    assert.equal(turn?.requestCount, 3);
    assert.equal(turn?.cacheHitRate, 1 / 3);
    assert.equal(turn?.averageDurationMs, 25);
  });

  test("Step 统计和详情只投影当前主键的账本、工具与 Turn 洞察", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const snapshot = {
      unit: "per_million_tokens",
      matchedModel: "gpt-fixture",
      vendor: "OpenAI",
      matchStrategy: "global_exact",
      rateMultiplier: 0.5,
      baseRates: { input: 1, cachedInput: 0.5, output: 2 },
      effectiveRates: { input: 0.5, cachedInput: 0.25, output: 1 },
      priced: true,
      currency: "USD",
    };
    fixture.db.prepare(
      `UPDATE usage_ledger SET model = 'gpt-fixture', vendor = 'OpenAI',
        rate_multiplier = 0.5, input_tokens = 101, cache_read_tokens = 202,
        cache_write_tokens = 3, output_tokens = 44, vendor_cost = 1.25,
        actual_cost = 0.625, duration_ms = 2345,
        usage_source = 'provider_usage', usage_confidence = 'exact',
        pricing_snapshot_json = ? WHERE agent_step_id = ?`,
    ).run(JSON.stringify(snapshot), tree.latestStepId);
    const insight = {
      turnId: tree.grandchildTurnId,
      agentSessionId: tree.oldSessionId,
      summary: "工具调用后完成",
      harnessPattern: "tool_loop_then_final",
      confidence: "high",
      observations: [],
      copyableTemplate: "先调用工具再回答",
      evidence: [],
      truncated: false,
      completeness: { complete: true },
    };
    fixture.db.prepare(
      `INSERT INTO learning_insights(agent_turn_id, insight_json, size_bytes, updated_at)
       VALUES(?, ?, ?, ?)`,
    ).run(
      tree.grandchildTurnId,
      JSON.stringify(insight),
      Buffer.byteLength(JSON.stringify(insight)),
      "2026-07-17T00:00:00.000Z",
    );

    const summary = loadScopeSummary(fixture.db, "step", tree.latestStepId);
    const detail = loadApiAgentStepDetail(fixture.db, tree.latestStepId);

    assert.deepEqual(summary && {
      requestCount: summary.requestCount,
      stepRequestCount: summary.stepRequestCount,
      auxiliaryRequestCount: summary.auxiliaryRequestCount,
      totalTokens: summary.totalTokens,
      vendorCost: summary.vendorCost,
      actualCost: summary.actualCost,
      averageDurationMs: summary.averageDurationMs,
      toolCallCount: summary.toolCallCount,
    }, {
      requestCount: 1,
      stepRequestCount: 1,
      auxiliaryRequestCount: 0,
      totalTokens: 350,
      vendorCost: 1.25,
      actualCost: 0.625,
      averageDurationMs: 2345,
      toolCallCount: 1,
    });
    assert.deepEqual(summary?.tools, [{
      name: "Read",
      status: "completed",
      count: 1,
    }]);
    assert.deepEqual(detail && {
      id: detail.id,
      exchangeId: detail.exchangeId,
      model: detail.model,
      vendor: detail.vendor,
      rateMultiplier: detail.rateMultiplier,
      inputTokens: detail.inputTokens,
      cacheReadTokens: detail.cacheReadTokens,
      cacheWriteTokens: detail.cacheWriteTokens,
      outputTokens: detail.outputTokens,
      vendorCost: detail.vendorCost,
      actualCost: detail.actualCost,
      durationMs: detail.durationMs,
      usageSource: detail.usageSource,
      usageConfidence: detail.usageConfidence,
      pricingSnapshot: detail.pricingSnapshot,
      learningInsight: detail.learningInsight,
    }, {
      id: tree.latestStepId,
      exchangeId: tree.latestExchangeId,
      model: "gpt-fixture",
      vendor: "OpenAI",
      rateMultiplier: 0.5,
      inputTokens: 101,
      cacheReadTokens: 202,
      cacheWriteTokens: 3,
      outputTokens: 44,
      vendorCost: 1.25,
      actualCost: 0.625,
      durationMs: 2345,
      usageSource: "provider_usage",
      usageConfidence: "exact",
      pricingSnapshot: snapshot,
      learningInsight: insight,
    });

    fixture.db.prepare(
      "UPDATE usage_ledger SET pricing_snapshot_json = '{' WHERE agent_step_id = ?",
    ).run(tree.latestStepId);
    assert.equal(
      loadApiAgentStepDetail(fixture.db, tree.latestStepId)?.pricingSnapshot,
      undefined,
    );

    const plans = [
      fixture.db.prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM usage_ledger WHERE agent_step_id = ? LIMIT 1",
      ).all(tree.latestStepId),
      fixture.db.prepare(
        `EXPLAIN QUERY PLAN SELECT tool_name, status, COUNT(*) FROM tool_calls
         WHERE agent_step_id = ? GROUP BY tool_name, status LIMIT 101`,
      ).all(tree.latestStepId),
    ].flat().map(row => (row as { detail: string }).detail).join("\n");
    assert.match(plans, /idx_usage_step/);
    assert.match(plans, /idx_tools_step_name_status/);
  });

  test("Step 详情解析映射命中策略的价格快照（target_model_entry）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const snapshot = {
      unit: "per_million_tokens",
      matchedModel: "gpt-5.6-sol",
      vendor: "openai",
      priceEntryId: "gpt-5.6-sol",
      matchStrategy: "target_model_entry",
      rateMultiplier: 0.1,
      baseRates: { input: 5, cachedInput: 0.5, output: 30, cacheWrite: 6.25 },
      effectiveRates: { input: 0.5, cachedInput: 0.05, output: 3, cacheWrite: 0.625 },
      priced: true,
      currency: "USD",
    };
    fixture.db.prepare(
      "UPDATE usage_ledger SET pricing_snapshot_json = ? WHERE agent_step_id = ?",
    ).run(JSON.stringify(snapshot), tree.latestStepId);

    const detail = loadApiAgentStepDetail(fixture.db, tree.latestStepId);

    assert.equal(detail?.pricingSnapshot?.matchStrategy, "target_model_entry");
    assert.equal(detail?.pricingSnapshot?.rateMultiplier, 0.1);
    assert.deepEqual(detail?.pricingSnapshot?.baseRates, snapshot.baseRates);
  });

  test("Step 详情透传套餐估算明细四件套（market_share 逐步公式，2026-09-30：会话追踪与 Token 价格页同文）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    /* 会话追踪路径的 planEstimateDetail 解析器（workbench-queries）此前只白名单旧字段，
       逐步公式四件套被剥掉导致 ？浮窗回退通用两行文案（Token 价格页另一解析器正常）。 */
    fixture.db.prepare(
      `UPDATE usage_ledger SET billing_channel = 'plan', plan_estimated_status = 'estimated',
        plan_estimated_currency = 'USD', plan_estimated_cost_nano = 10738999,
        plan_estimate_detail_json = ? WHERE agent_step_id = ?`,
    ).run(JSON.stringify({
      monthlyFee: 10,
      consumed: 0.064435,
      consumedBasis: "market_cny",
      consumedUsd: 0.009547,
      modelId: "deepseek-v4.1-flash",
      planTier: "go",
      monthlyLimitUsd: 60,
      quotaTotal: 404.934,
      windowDays: 30,
      windowLabel: "monthly",
      fxUsdCny: 6.7489,
    }), tree.latestStepId);

    const detail = loadApiAgentStepDetail(fixture.db, tree.latestStepId);

    assert.equal(detail?.planEstimateDetail?.consumedUsd, 0.009547);
    assert.equal(detail?.planEstimateDetail?.modelId, "deepseek-v4.1-flash");
    assert.equal(detail?.planEstimateDetail?.planTier, "go");
    assert.equal(detail?.planEstimateDetail?.monthlyLimitUsd, 60);
  });

  test("Step 价格快照保留长上下文阶梯（会话追踪 ？浮窗按派生同规则复算档位，2026-09-24）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const longContextTier = {
      thresholdTokens: 128_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      rates: { input: 12 },
    };
    fixture.db.prepare(
      "UPDATE usage_ledger SET pricing_snapshot_json = ? WHERE agent_step_id = ?",
    ).run(JSON.stringify({
      unit: "per_million_tokens",
      matchedModel: "gpt-5.6-sol",
      vendor: "openai",
      matchStrategy: "target_model_entry",
      rateMultiplier: 1,
      baseRates: {
        input: 6,
        cachedInput: 0.6,
        output: 30,
        cacheWrite: 7.5,
        longContext: longContextTier,
      },
      effectiveRates: { input: 6, cachedInput: 0.6, output: 30 },
      priced: true,
      currency: "USD",
    }), tree.latestStepId);

    const detail = loadApiAgentStepDetail(fixture.db, tree.latestStepId);

    assert.deepEqual(detail?.pricingSnapshot?.baseRates?.longContext, longContextTier);

    // 阶梯字段非法时只丢弃阶梯本身，不影响其余费率与快照可用性。
    fixture.db.prepare(
      "UPDATE usage_ledger SET pricing_snapshot_json = ? WHERE agent_step_id = ?",
    ).run(JSON.stringify({
      unit: "per_million_tokens",
      matchStrategy: "target_model_entry",
      rateMultiplier: 1,
      baseRates: {
        input: 6,
        output: 30,
        longContext: { thresholdTokens: -1, inputMultiplier: 2, outputMultiplier: 1.5 },
      },
      priced: true,
    }), tree.latestStepId);

    const degraded = loadApiAgentStepDetail(fixture.db, tree.latestStepId);

    assert.equal(degraded?.pricingSnapshot?.baseRates?.longContext, undefined);
    assert.equal(degraded?.pricingSnapshot?.baseRates?.input, 6);
    assert.equal(degraded?.pricingSnapshot?.baseRates?.output, 30);
  });

  test("Step 详情带出套餐估算人民币物化列与冻结汇率（2026-09-28 人民币口径取数链）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    fixture.db.prepare(
      `UPDATE usage_ledger SET
         billing_channel = 'plan',
         plan_credit_cost = 41.49,
         plan_credit_unit = '积分',
         plan_estimated_status = 'estimated',
         plan_estimated_cost = 0.02,
         plan_estimated_currency = 'USD',
         plan_estimated_fx = 6.7489,
         plan_estimated_cost_nano = 134977800
       WHERE agent_step_id = ?`,
    ).run(tree.latestStepId);

    const detail = loadApiAgentStepDetail(fixture.db, tree.latestStepId);

    assert.equal(detail?.billingChannel, "plan");
    assert.equal(detail?.planEstimatedStatus, "estimated");
    assert.equal(detail?.planEstimatedCost, 0.02);
    assert.equal(detail?.planEstimatedCurrency, "USD");
    assert.equal(detail?.planEstimatedFx, 6.7489);
    assert.equal(detail?.planEstimatedCostNano, 134_977_800);
  });

  test("Step 和范围统计在工具名称高基数时先聚合再有界返回", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const initialPage = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "1" }),
    );
    const step = initialPage?.items[0];
    assert.ok(step);
    const insertTool = fixture.db.prepare(
      `INSERT INTO tool_calls(
        id, exchange_id, agent_session_id, agent_thread_id,
        agent_turn_id, agent_step_id, tool_use_id, tool_name,
        status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
    );
    for (let index = 0; index < 105; index += 1) {
      const toolName = `Tool-${String(index).padStart(3, "0")}`;
      insertTool.run(
        `${step.id}-high-cardinality-${index}`,
        step.exchangeId,
        step.agentSessionId,
        step.agentThreadId,
        step.agentTurnId,
        step.id,
        `${step.id}-use-${index}`,
        toolName,
        step.timestamp,
      );
    }

    const page = loadTurnSteps(
      fixture.db,
      tree.grandchildTurnId,
      new URLSearchParams({ limit: "1" }),
    );
    const summary = loadScopeSummary(fixture.db, "session", tree.oldSessionId);

    assert.equal(page?.items[0]?.toolUseCount, 106);
    assert.equal(page?.items[0]?.toolUseNames.length, 100);
    assert.equal(page?.items[0]?.toolUseNamesLimited, true);
    assert.equal(summary?.tools.length, 100);
    assert.equal(summary?.toolsCandidateCount, 106);
    assert.equal(summary?.toolsProcessedCount, 101);
    assert.equal(summary?.toolsLimited, true);
  });

  test("单 Exchange 详情只按一个 raw ref 的范围读取并有界水合 blob", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const requestText = JSON.stringify({ message: "只读取目标 ref" });
    const stored = await storeRawBody(fixture.dataDir, requestText, {
      inlineThresholdBytes: 0,
      compressedInlineThresholdBytes: 0,
    });
    const exchange = rawExchange("exchange-detail", 7);
    exchange.request = {
      headers: exchange.request.headers,
      bodySizeBytes: Buffer.byteLength(requestText),
      bodySha256: stored.reference.sha256,
      rawBodyRef: stored.reference,
    };
    exchange.bodyStorage = {
      policy: "external-blob",
      externalBlobDir: "blobs",
    };
    const targetLine = `${JSON.stringify(exchange)}\n`;
    const prefix = "这不是 JSON，范围读取不应解析它\n";
    const filePath = await fixture.writeV2Lines([], "exchange-detail.jsonl");
    await fixture.appendRaw(
      filePath,
      `${prefix}${targetLine}{"unreadTail":"${"x".repeat(128_000)}"}`,
    );
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const sourceId = fixture.db.prepare(
      "SELECT id FROM ingestion_sources WHERE relative_path = ?",
    ).pluck().get("captures/v2/exchange-detail.jsonl") as number;
    insertRawRef(
      fixture,
      exchange,
      sourceId,
      Buffer.byteLength(prefix),
      Buffer.byteLength(targetLine),
    );

    const detail = await loadExchangeDetail(
      fixture.db,
      fixture.dataDir,
      exchange.exchangeId,
    );

    assert.equal(detail?.exchangeId, exchange.exchangeId);
    assert.equal(detail?.request.rawBody, requestText);
    assert.deepEqual(detail?.request.parsedBody, { message: "只读取目标 ref" });
    assert.equal(detail?.response.rawBody, exchange.response.rawBody);
  });

  test("raw ref 越界或超过 8 MiB 时返回安全错误并写诊断", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const exchange = rawExchange("exchange-unsafe", 8);
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(
        relative_path, file_id, file_size, updated_at
      ) VALUES('../outside.jsonl', 'outside-file', 9000000, ?)
      RETURNING id`,
    ).pluck().get(exchange.capturedAt) as number;
    insertRawRef(
      fixture,
      exchange,
      sourceId,
      0,
      8 * 1024 * 1024 + 1,
    );

    await assert.rejects(
      loadExchangeDetail(fixture.db, fixture.dataDir, exchange.exchangeId),
      UnsafeRawReferenceError,
    );
    const diagnostic = fixture.db.prepare(
      `SELECT code, severity, exchange_id, source_id
       FROM derivation_diagnostics WHERE exchange_id = ?`,
    ).get(exchange.exchangeId) as {
      code: string;
      severity: string;
      exchange_id: string;
      source_id: number;
    };
    assert.deepEqual(diagnostic, {
      code: "unsafe_raw_exchange_ref",
      severity: "error",
      exchange_id: exchange.exchangeId,
      source_id: sourceId,
    });
  });

  test("单 Exchange 读取保留底层 OS 错误且不写安全诊断", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const exchange = rawExchange("exchange-os-error", 9);
    await seedRawDetail(fixture, exchange, "os-error.jsonl");

    await assert.rejects(
      loadExchangeDetail(
        fixture.db,
        fixture.dataDir,
        exchange.exchangeId,
        {
          rawBodyReader: async () => {
            throw new UnsafeRawBodyReferenceError(
              "request raw body declared size 9000000 exceeds 8388608-byte hydration budget.",
            );
          },
        },
      ),
      RawBodyExceedsPreviewBudgetError,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics
         WHERE exchange_id = ? AND code = 'unsafe_raw_exchange_ref'`,
      ).pluck().get(exchange.exchangeId),
      0,
    );

    for (const code of ["ENOENT", "EACCES", "EIO"] as const) {
      const fault = Object.assign(new Error(`raw body ${code}`), { code });
      await assert.rejects(
        loadExchangeDetail(
          fixture.db,
          fixture.dataDir,
          exchange.exchangeId,
          {
            rawBodyReader: async () => {
              throw fault;
            },
          },
        ),
        error => error === fault,
      );
    }

    const diagnosticCount = fixture.db.prepare(
      `SELECT COUNT(*) FROM derivation_diagnostics
       WHERE exchange_id = ? AND code = 'unsafe_raw_exchange_ref'`,
    ).pluck().get(exchange.exchangeId) as number;
    assert.equal(diagnosticCount, 0);

    await assert.rejects(
      loadExchangeDetail(
        fixture.db,
        fixture.dataDir,
        exchange.exchangeId,
        {
          rawBodyReader: async () => {
            throw new UnsafeRawBodyReferenceError("blob integrity mismatch");
          },
        },
      ),
      UnsafeRawReferenceError,
    );
    const integrityDiagnosticCount = fixture.db.prepare(
      `SELECT COUNT(*) FROM derivation_diagnostics
       WHERE exchange_id = ? AND code = 'unsafe_raw_exchange_ref'`,
    ).pluck().get(exchange.exchangeId) as number;
    assert.equal(integrityDiagnosticCount, 1);

    fixture.db.exec("DROP TABLE derivation_diagnostics");
    await assert.rejects(
      loadExchangeDetail(
        fixture.db,
        fixture.dataDir,
        exchange.exchangeId,
        {
          rawBodyReader: async () => {
            throw new UnsafeRawBodyReferenceError("blob integrity mismatch");
          },
        },
      ),
      UnsafeRawReferenceError,
    );
  });

  test("Node API 分层返回树、Thread、Turn、Step、选择、统计和单条详情", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tree = seedWorkbenchTree(fixture, 2);
    const detailExchange = rawExchange("exchange-route-detail", 9);
    await seedRawDetail(fixture, detailExchange, "route-detail.jsonl");
    seedExchangeProjection(fixture, detailExchange.exchangeId);
    fixture.db.prepare(
      `UPDATE ingestion_sources SET relative_path = 'captures/v2/raw-must-not-be-read.jsonl'
       WHERE id = (SELECT source_id FROM raw_exchange_refs WHERE exchange_id = ?)`,
    ).run(detailExchange.exchangeId);
    const routeStepId = `${tree.grandchildTurnId}-step-extra`;
    fixture.db.prepare(
      `INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes)
       VALUES(?, ?, ?)`,
    ).run(routeStepId, JSON.stringify({ snapshot: { stepId: routeStepId } }), 64);
    fixture.db.prepare(
      `INSERT INTO step_diffs(agent_step_id, diff_json, size_bytes)
       VALUES(?, ?, ?)`,
    ).run(routeStepId, JSON.stringify({ toStepId: routeStepId }), 64);
    process.env.DEEPAA_DATA_DIR = fixture.dataDir;
    try {
      const [
        treeRoute,
        versionRoute,
        threadsRoute,
        turnsRoute,
        stepsRoute,
        selectionRoute,
        costRoute,
        exchangeRoute,
        agentsRoute,
        sessionsRoute,
        apiTurnsRoute,
        stepRoute,
        contextRoute,
        diffRoute,
        capturesRoute,
        captureExchangesRoute,
        derivationRoute,
        normalizedRoute,
        protocolRoute,
        validationRoute,
      ] = await Promise.all([
        import("../src/app/api/workbench-tree/route.js"),
        import("../src/app/api/workbench-version/route.js"),
        import("../src/app/api/agent-sessions/[agentSessionId]/threads/route.js"),
        import("../src/app/api/agent-threads/[threadId]/turns/route.js"),
        import("../src/app/api/agent-turns/[turnId]/steps/route.js"),
        import("../src/app/api/workbench-selection/route.js"),
        import("../src/app/api/cost/[scopeType]/[scopeId]/route.js"),
        import("../src/app/api/exchanges/[exchangeId]/route.js"),
        import("../src/app/api/agents/route.js"),
        import("../src/app/api/agent-sessions/route.js"),
        import("../src/app/api/agent-turns/route.js"),
        import("../src/app/api/agent-steps/[stepId]/route.js"),
        import("../src/app/api/agent-steps/[stepId]/context-snapshot/route.js"),
        import("../src/app/api/agent-steps/[stepId]/diff/route.js"),
        import("../src/app/api/captures/route.js"),
        import("../src/app/api/captures/[captureSessionId]/exchanges/route.js"),
        import("../src/app/api/derivation-status/route.js"),
        import("../src/app/api/exchanges/[exchangeId]/normalized/route.js"),
        import("../src/app/api/exchanges/[exchangeId]/protocol/route.js"),
        import("../src/app/api/exchanges/[exchangeId]/validation/route.js"),
      ]);
      for (const route of [
        treeRoute,
        versionRoute,
        threadsRoute,
        turnsRoute,
        stepsRoute,
        selectionRoute,
        costRoute,
        exchangeRoute,
        agentsRoute,
        sessionsRoute,
        apiTurnsRoute,
        stepRoute,
        contextRoute,
        diffRoute,
        capturesRoute,
        captureExchangesRoute,
        derivationRoute,
        normalizedRoute,
        protocolRoute,
        validationRoute,
      ]) {
        assert.equal(route.dynamic, "force-dynamic");
        assert.equal(route.runtime, "nodejs");
      }

      const treeResponse = await treeRoute.GET(new Request(
        `http://localhost/api/workbench-tree?session=${tree.oldSessionId}&limit=1`,
      ));
      const treeBody = await treeResponse.json();
      assert.equal(treeResponse.status, 200);
      assert.equal(treeBody.resolvedPath.session, tree.oldSessionId);
      assert.equal(treeBody.processedCount, 2);

      const threadsResponse = await threadsRoute.GET(
        new Request("http://localhost/api/agent-sessions/session/threads?limit=1"),
        { params: Promise.resolve({ agentSessionId: tree.oldSessionId }) },
      );
      const threadsBody = await threadsResponse.json();
      assert.equal(threadsResponse.status, 200);
      assert.equal(threadsBody.items[0].id, tree.rootThreadId);

      const turnsResponse = await turnsRoute.GET(
        new Request("http://localhost/api/agent-threads/thread/turns?limit=1"),
        { params: Promise.resolve({ threadId: tree.grandchildThreadId }) },
      );
      const turnsBody = await turnsResponse.json();
      assert.equal(turnsBody.processedCount, 2);
      assert.equal(turnsBody.hasMore, true);

      const stepsResponse = await stepsRoute.GET(
        new Request("http://localhost/api/agent-turns/turn/steps?limit=1"),
        { params: Promise.resolve({ turnId: tree.grandchildTurnId }) },
      );
      const stepsBody = await stepsResponse.json();
      assert.equal(stepsBody.items[0].exchangeId, tree.latestExchangeId);
      assert.equal(stepsBody.processedCount, 2);

      const selectionResponse = await selectionRoute.GET(new Request(
        `http://localhost/api/workbench-selection?step=${tree.grandchildExchangeId}`,
      ));
      const selectionBody = await selectionResponse.json();
      assert.equal(selectionBody.resolvedPath.thread, tree.grandchildThreadId);
      assert.equal(selectionBody.resolvedPath.step, tree.grandchildStepId);

      const costResponse = await costRoute.GET(
        new Request("http://localhost/api/cost/thread/id"),
        { params: Promise.resolve({
          scopeType: "thread",
          scopeId: tree.rootThreadId,
        }) },
      );
      const costBody = await costResponse.json();
      assert.equal(costBody.summary.requestCount, 6);
      assert.equal(costBody.summary.tools[0].name, "Read");

      const exchangeResponse = await exchangeRoute.GET(
        new Request("http://localhost/api/exchanges/id"),
        { params: Promise.resolve({ exchangeId: detailExchange.exchangeId }) },
      );
      const exchangeBody = await exchangeResponse.json();
      assert.equal(exchangeBody.exchange.exchangeId, detailExchange.exchangeId);
      assert.equal(exchangeBody.exchange.previewState, "limited");
      assert.equal(exchangeBody.exchange.preview.items[0].textPreview, "有界请求预览");
      assert.equal(exchangeBody.exchange.media.items[0].mediaType, "image/png");
      assert.equal(exchangeBody.exchange.request.sizeBytes, detailExchange.request.bodySizeBytes);
      assert.equal(exchangeBody.exchange.request.verification, "verified");
      assert.equal(exchangeBody.exchange.jobStatus, "succeeded");
      assert.equal(exchangeBody.exchange.projectionCompleteness, "limited");
      assert.equal(JSON.stringify(exchangeBody).includes("rawBody"), false);
      assert.equal(JSON.stringify(exchangeBody).includes("parsedBody"), false);
      assert.equal(JSON.stringify(exchangeBody).includes("inlineBase64"), false);
      assert.equal(JSON.stringify(exchangeBody).includes("raw-must-not-be-read"), false);

      const agentsBody = await agentsRoute.GET(new Request(
        "http://localhost/api/agents?limit=1",
      )).then((response) => response.json());
      assert.equal(agentsBody.agents[0].agentName, "codex");
      assert.equal(agentsBody.processedCount, 1);

      const sessionsBody = await sessionsRoute.GET(new Request(
        "http://localhost/api/agent-sessions?limit=1",
      )).then((response) => response.json());
      assert.equal(sessionsBody.sessions.length, 1);
      assert.equal(sessionsBody.hasMore, true);

      const apiTurnsBody = await apiTurnsRoute.GET(new Request(
        `http://localhost/api/agent-turns?session=${tree.oldSessionId}&limit=1`,
      )).then((response) => response.json());
      assert.equal(apiTurnsBody.turns[0].agentSessionId, tree.oldSessionId);

      const stepBody = await stepRoute.GET(
        new Request("http://localhost/api/agent-steps/id"),
        { params: Promise.resolve({ stepId: routeStepId }) },
      ).then((response) => response.json());
      assert.equal(stepBody.step.id, routeStepId);

      const contextBody = await contextRoute.GET(
        new Request("http://localhost/api/agent-steps/id/context-snapshot"),
        { params: Promise.resolve({ stepId: routeStepId }) },
      ).then((response) => response.json());
      const diffBody = await diffRoute.GET(
        new Request("http://localhost/api/agent-steps/id/diff"),
        { params: Promise.resolve({ stepId: routeStepId }) },
      ).then((response) => response.json());
      assert.equal(contextBody.snapshot.stepId, routeStepId);
      assert.equal(diffBody.diff.toStepId, routeStepId);

      const capturesBody = await capturesRoute.GET(new Request(
        "http://localhost/api/captures?limit=10",
      )).then((response) => response.json());
      assert.ok(capturesBody.captures.some((item: { captureSessionId: string }) =>
        item.captureSessionId === detailExchange.captureSessionId
      ));
      const captureExchangeBody = await captureExchangesRoute.GET(
        new Request("http://localhost/api/captures/id/exchanges?limit=25"),
        { params: Promise.resolve({
          captureSessionId: detailExchange.captureSessionId,
        }) },
      ).then((response) => response.json());
      assert.equal(captureExchangeBody.limit, 20);
      assert.equal(captureExchangeBody.exchanges[0].exchangeId, detailExchange.exchangeId);
      assert.equal(captureExchangeBody.exchanges[0].previewState, "limited");
      assert.equal(captureExchangeBody.processedCount, 1);
      assert.equal(captureExchangeBody.hasMore, false);
      assert.equal(JSON.stringify(captureExchangeBody).includes("rawBody"), false);

      const derivationBody = await derivationRoute.GET().then((response) =>
        response.json()
      );
      assert.equal(derivationBody.derivedStatus, "idle");
      assert.equal(derivationBody.dataVersion, 0);
      assert.equal(derivationBody.registeredCount, 1);
      assert.deepEqual(derivationBody.jobCounts, {
        pending: 0,
        running: 0,
        retryWait: 0,
        succeeded: 1,
        permanentError: 0,
      });
      assert.deepEqual(derivationBody.completenessCounts, {
        complete: 0,
        limited: 1,
        unavailable: 0,
      });
      assert.equal(derivationBody.previewCounts.limited, 1);
      assert.ok(derivationBody.previewCounts.notMaterialized > 0);
      assert.equal(derivationBody.backlogAgeMs, 0);
      assert.equal(derivationBody.lastRegisteredAt, "2026-07-22T12:00:00.000Z");
      assert.equal(derivationBody.lastDerivedAt, "2026-07-22T12:00:00.000Z");
      assert.equal(JSON.stringify(derivationBody).includes("preview_json"), false);

      const normalizedBody = await normalizedRoute.GET(
        new Request("http://localhost/api/exchanges/id/normalized"),
        { params: Promise.resolve({ exchangeId: detailExchange.exchangeId }) },
      ).then((response) => response.json());
      assert.equal(normalizedBody.normalized.protocol, "openai-responses");
      assert.equal(normalizedBody.normalized.preview.items[0].textPreview, "有界请求预览");
      assert.equal(JSON.stringify(normalizedBody).includes("rawBody"), false);

      const protocolBody = await protocolRoute.GET(
        new Request("http://localhost/api/exchanges/id/protocol"),
        { params: Promise.resolve({ exchangeId: detailExchange.exchangeId }) },
      ).then((response) => response.json());
      assert.deepEqual(protocolBody.protocol, {
        exchangeId: detailExchange.exchangeId,
        protocol: "openai-responses",
        endpointKind: "model-call",
        isModelCall: true,
        isAuxiliary: false,
        projectionCompleteness: "limited",
      });

      const validationBody = await validationRoute.GET(
        new Request("http://localhost/api/exchanges/id/validation"),
        { params: Promise.resolve({ exchangeId: detailExchange.exchangeId }) },
      ).then((response) => response.json());
      assert.equal(validationBody.validation.indexVerification, "current");
      assert.equal(validationBody.validation.request.verification, "verified");
      assert.equal(validationBody.validation.diagnostics.items[0].code, "request_text_limited");

      const historicalResponse = await exchangeRoute.GET(
        new Request("http://localhost/api/exchanges/id"),
        { params: Promise.resolve({ exchangeId: tree.latestExchangeId }) },
      );
      const historicalBody = await historicalResponse.json();
      assert.equal(historicalResponse.status, 200);
      assert.equal(historicalBody.exchange.previewState, "not_materialized");
      assert.equal(historicalBody.exchange.indexVerification, "legacy");
      assert.equal(historicalBody.exchange.request.storage, "unknown");
      assert.equal(historicalBody.exchange.request.verification, "legacy");

      const versionResponse = await versionRoute.GET(new Request(
        "http://localhost/api/workbench-version",
      ));
      const versionBody = await versionResponse.json();
      assert.equal(versionBody.dataVersion, 0);
      assert.equal(versionBody.derivedStatus, "idle");
      const idleEtag = versionResponse.headers.get("etag");
      assert.ok(idleEtag);

      fixture.db.prepare(
        "UPDATE schema_meta SET worker_status = 'running' WHERE id = 1",
      ).run();
      const runningResponse = await versionRoute.GET(new Request(
        "http://localhost/api/workbench-version",
        { headers: { "If-None-Match": idleEtag } },
      ));
      assert.equal(runningResponse.status, 200);
      const runningBody = await runningResponse.json();
      const runningEtag = runningResponse.headers.get("etag");
      assert.equal(runningBody.dataVersion, 0);
      assert.equal(runningBody.derivedStatus, "running");
      assert.notEqual(runningBody.version, versionBody.version);
      assert.ok(runningEtag);
      assert.notEqual(runningEtag, idleEtag);

      const notModified = await versionRoute.GET(new Request(
        "http://localhost/api/workbench-version",
        { headers: { "If-None-Match": runningEtag } },
      ));
      assert.equal(notModified.status, 304);
      assert.equal(notModified.headers.get("etag"), runningEtag);
    } finally {
      closeRouteDatabase(fixture.dataDir);
      delete process.env.DEEPAA_DATA_DIR;
    }
  });

  test("API 将非法 cursor 映射为 400，将数据库不可用映射为稳定 503", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedWorkbenchTree(fixture, 2);
    const treeRoute = await import("../src/app/api/workbench-tree/route.js");
    process.env.DEEPAA_DATA_DIR = fixture.dataDir;
    try {
      const invalidCursor = await treeRoute.GET(new Request(
        "http://localhost/api/workbench-tree?cursor=not-a-cursor",
      ));
      assert.equal(invalidCursor.status, 400);
      assert.equal((await invalidCursor.json()).error.code, "invalid_cursor");

      closeRouteDatabase(fixture.dataDir);
      const invalidDataDir = join(fixture.dataDir, "not-a-directory");
      await writeFile(invalidDataDir, "file blocks sqlite data directory");
      process.env.DEEPAA_DATA_DIR = invalidDataDir;
      const unavailable = await treeRoute.GET(new Request(
        "http://localhost/api/workbench-tree",
      ));
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), {
        error: {
          code: "derived_unavailable",
          message: "派生数据库暂时不可用，请稍后重试。",
        },
        derivedStatus: "failed",
      });
    } finally {
      delete process.env.DEEPAA_DATA_DIR;
    }
  });

  test("API 仅将可识别的数据库不可用异常映射为 503", async () => {
    // node:sqlite 错误形态（2026-10-08 切换）：code='ERR_SQLITE_ERROR' + 数字
    // errcode（扩展码 & 0xff 归并到主码：BUSY=5/LOCKED=6/READONLY=8/PERM=3）。
    for (const errcode of [
      5, // SQLITE_BUSY
      517, // SQLITE_BUSY_SNAPSHOT
      262, // SQLITE_LOCKED_SHAREDCACHE
      1032, // SQLITE_READONLY_DBMOVED
      520, // SQLITE_READONLY_CANTLOCK
      3, // SQLITE_PERM
    ]) {
      const unavailable = workbenchRouteErrorResponse(Object.assign(
        new Error(`unavailable: errcode ${errcode}`),
        {code: "ERR_SQLITE_ERROR", errcode},
      ));
      assert.equal(unavailable.status, 503, String(errcode));
      assert.equal(
        (await unavailable.json()).error.code,
        "derived_unavailable",
        String(errcode),
      );
    }
    const denied = workbenchRouteErrorResponse(Object.assign(
      new Error("permission denied: /secret/database"),
      { code: "EACCES" },
    ));

    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).error.code, "derived_unavailable");
  });

  test("API 将 SQLite 损坏、约束和未知异常映射为不泄漏的 500", async () => {
    // CONSTRAINT=19 / CORRUPT=11 / NOTADB=26 不在不可用码表内。
    for (const errcode of [19, 11, 26]) {
      const internal = workbenchRouteErrorResponse(Object.assign(
        new Error(`internal: errcode ${errcode}`),
        {code: "ERR_SQLITE_ERROR", errcode},
      ));
      assert.equal(internal.status, 500, String(errcode));
      assert.deepEqual(await internal.json(), {
        error: {
          code: "internal_error",
          message: "服务端处理请求失败。",
        },
      }, String(errcode));
    }
    const unknown = workbenchRouteErrorResponse(
      new Error("secret path must not leak"),
    );
    assert.equal(unknown.status, 500);
    const unknownBody = await unknown.text();
    assert.equal(JSON.parse(unknownBody).error.code, "internal_error");
    assert.doesNotMatch(unknownBody, /secret path/);
  });
});

interface SeededTree {
  oldSessionId: string;
  rootThreadId: string;
  childThreadId: string;
  grandchildThreadId: string;
  grandchildTurnId: string;
  grandchildStepId: string;
  grandchildExchangeId: string;
  latestStepId: string;
  latestExchangeId: string;
}

function seedWorkbenchTree(
  fixture: SqliteFixture,
  sessionCount: number,
): SeededTree {
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, file_size, updated_at
    ) VALUES('captures/v2/workbench.jsonl', 'workbench-file', 1000000, ?)
    RETURNING id`,
  ).pluck().get("2026-07-17T00:00:00.000Z") as number;
  const insertSession = fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, source, confidence, start_time, end_time,
      model_set_json, request_count, thread_count
    ) VALUES(?, 'target-workbench', 'Workbench Target', 'fingerprint-codex',
      'codex', ?, 'fixture', 'exact', ?, ?, '["gpt-fixture"]', ?, ?)`
  );
  const insertThread = fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, parent_agent_thread_id, external_thread_id,
      source, display_name, confidence, is_root, is_placeholder,
      start_time, end_time, model_set_json, request_count, turn_count
    ) VALUES(?, ?, ?, ?, 'fixture', ?, 'exact', ?, 0, ?, ?,
      '["gpt-fixture"]', ?, ?)`
  );
  const insertClosure = fixture.db.prepare(
    `INSERT INTO thread_closure(
      ancestor_thread_id, descendant_thread_id, depth
    ) VALUES(?, ?, ?)`
  );
  const base = Date.parse("2026-07-17T00:00:00.000Z");

  let stepOffset = 9000;
  for (let index = 0; index < sessionCount; index += 1) {
    const id = `session-${String(index).padStart(3, "0")}`;
    const rootId = `thread-${String(index).padStart(3, "0")}-root`;
    const timestamp = new Date(base + index * 60_000).toISOString();
    insertSession.run(id, `external-${index}`, timestamp, timestamp, 1, 1);
    insertThread.run(
      rootId,
      id,
      null,
      `external-thread-${index}`,
      `Session ${index} 根 Thread`,
      1,
      timestamp,
      timestamp,
      1,
      1,
    );
    insertClosure.run(rootId, rootId, 0);
    // 每个 session 一条最小模型 Step（空壳 Session 过滤要求有真实 Step；2026-09-17）。
    const exchangeId = `session-${String(index).padStart(3, "0")}-exchange`;
    const stepId = `${rootId}-step`;
    const turnId = `${rootId}-turn`;
    fixture.db.prepare(
      `INSERT INTO agent_turns(
        id, agent_session_id, agent_thread_id, source, confidence, status,
        segment_index, start_exchange_id, start_time, end_time,
        model_set_json, step_count, auxiliary_request_count
      ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?, '[]', 1, 0)`
    ).run(turnId, id, rootId, exchangeId, timestamp, timestamp);
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset,
        line_length_bytes, captured_at, completed_at, target_id,
        target_name, agent_name, agent_fingerprint_id, status,
        is_streaming, request_body_bytes, response_body_bytes
      ) VALUES(?, 'capture-workbench', ?, ?, 100, ?, ?,
        'target-workbench', 'Workbench Target', 'codex',
        'fingerprint-codex', 200, 0, 10, 10)`
    ).run(exchangeId, sourceId, stepOffset, timestamp, timestamp);
    fixture.db.prepare(
      `INSERT INTO agent_steps(
        id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
        step_index, timestamp, phase, request_action, response_action
      ) VALUES(?, ?, ?, ?, ?, 1, ?, 'final_answer', 'user_prompt', 'final')`
    ).run(stepId, exchangeId, id, rootId, `${rootId}-turn`, timestamp);
    stepOffset += 100;
  }

  const oldSessionId = "session-000";
  const rootThreadId = "thread-000-root";
  const childThreadId = "thread-000-child";
  const grandchildThreadId = "thread-000-grandchild";
  const oldTime = new Date(base).toISOString();
  insertThread.run(
    childThreadId,
    oldSessionId,
    rootThreadId,
    "external-child",
    "Child Thread",
    0,
    oldTime,
    oldTime,
    2,
    2,
  );
  insertThread.run(
    grandchildThreadId,
    oldSessionId,
    childThreadId,
    "external-grandchild",
    "Grandchild Thread",
    0,
    oldTime,
    oldTime,
    2,
    2,
  );
  fixture.db.prepare(
    `UPDATE agent_sessions SET request_count = 6, thread_count = 3
     WHERE id = ?`,
  ).run(oldSessionId);
  for (const [ancestor, descendant, depth] of [
    [rootThreadId, childThreadId, 1],
    [rootThreadId, grandchildThreadId, 2],
    [childThreadId, childThreadId, 0],
    [childThreadId, grandchildThreadId, 1],
    [grandchildThreadId, grandchildThreadId, 0],
  ] as const) {
    insertClosure.run(ancestor, descendant, depth);
  }

  let offset = 0;
  let grandchildTurnId = "";
  let grandchildStepId = "";
  let grandchildExchangeId = "";
  for (const threadId of [rootThreadId, childThreadId, grandchildThreadId]) {
    fixture.db.prepare(
      `INSERT INTO scope_aggregates(
        scope_type, scope_id, step_request_count, auxiliary_request_count,
        input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
        vendor_cost, actual_cost, duration_total_ms, duration_sample_count,
        tool_call_count, updated_at
      ) VALUES('thread', ?, 2, 0, 20, 10, 0, 8, 0.2, 0.1, 50, 2, 2, ?)`
    ).run(threadId, oldTime);

    for (let turnIndex = 1; turnIndex <= 2; turnIndex += 1) {
      const turnId = `${threadId}-turn-${turnIndex}`;
      fixture.db.prepare(
        `INSERT INTO agent_turns(
          id, agent_session_id, agent_thread_id, source, confidence, status,
          segment_index, start_exchange_id, start_time, end_time,
          model_set_json, step_count, auxiliary_request_count
        ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', ?, ?, ?, ?,
          '["gpt-fixture"]', 1, 0)`
      ).run(
        turnId,
        oldSessionId,
        threadId,
        turnIndex,
        `${turnId}-exchange`,
        oldTime,
        new Date(base + turnIndex * 1_000).toISOString(),
      );
      const exchangeId = `${turnId}-exchange`;
      const stepId = `${turnId}-step`;
      fixture.db.prepare(
        `INSERT INTO raw_exchange_refs(
          exchange_id, capture_session_id, source_id, byte_offset,
          line_length_bytes, captured_at, completed_at, target_id,
          target_name, agent_name, agent_fingerprint_id, status,
          is_streaming, request_body_bytes, response_body_bytes
        ) VALUES(?, 'capture-workbench', ?, ?, 100, ?, ?,
          'target-workbench', 'Workbench Target', 'codex',
          'fingerprint-codex', 200, 0, 10, 10)`
      ).run(exchangeId, sourceId, offset, oldTime, oldTime);
      fixture.db.prepare(
        `INSERT INTO agent_steps(
          id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
          step_index, timestamp, phase, request_action, response_action,
          request_intent_label, response_status_label, tool_schema_count
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'tool', 'continue', 'tool_use',
          '继续工具调用', '工具已完成', 1)`
      ).run(
        stepId,
        exchangeId,
        oldSessionId,
        threadId,
        turnId,
        turnIndex,
        new Date(base + turnIndex * 1_000).toISOString(),
      );
      fixture.db.prepare(
        `INSERT INTO usage_ledger(
          exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
          agent_step_id, target_id, agent_fingerprint_id, agent_name, model,
          vendor, rate_multiplier, input_tokens, cache_read_tokens,
          cache_write_tokens, output_tokens, vendor_cost, actual_cost,
          duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
          created_at
        ) VALUES(?, ?, ?, ?, ?, 'target-workbench', 'fingerprint-codex',
          'codex', 'gpt-fixture', 'openai', 1, 10, 5, 0, 4, 0.1, 0.05,
          25, 'fixture', 'exact', '{}', ?)`
      ).run(
        exchangeId,
        oldSessionId,
        threadId,
        turnId,
        stepId,
        new Date(base + offset + turnIndex * 1_000).toISOString(),
      );
      fixture.db.prepare(
        `INSERT INTO tool_calls(
          id, exchange_id, agent_session_id, agent_thread_id,
          agent_turn_id, agent_step_id, tool_use_id, tool_name,
          status, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'Read', 'completed', ?)`
      ).run(
        `${stepId}-tool`,
        exchangeId,
        oldSessionId,
        threadId,
        turnId,
        stepId,
        `${stepId}-use`,
        oldTime,
      );
      offset += 100;
      if (threadId === grandchildThreadId && turnIndex === 2) {
        grandchildTurnId = turnId;
        grandchildStepId = stepId;
        grandchildExchangeId = exchangeId;
      }
    }
  }

  const emptyTurnId = `${grandchildThreadId}-turn-1`;
  const emptyStepId = `${emptyTurnId}-step`;
  const emptyExchangeId = `${emptyTurnId}-exchange`;
  fixture.db.prepare("DELETE FROM tool_calls WHERE agent_step_id = ?")
    .run(emptyStepId);
  fixture.db.prepare("DELETE FROM usage_ledger WHERE agent_step_id = ?")
    .run(emptyStepId);
  fixture.db.prepare("DELETE FROM agent_steps WHERE id = ?").run(emptyStepId);
  fixture.db.prepare("DELETE FROM raw_exchange_refs WHERE exchange_id = ?")
    .run(emptyExchangeId);
  fixture.db.prepare("UPDATE agent_turns SET step_count = 0 WHERE id = ?")
    .run(emptyTurnId);

  const extraExchangeId = `${grandchildTurnId}-exchange-extra`;
  const extraStepId = `${grandchildTurnId}-step-extra`;
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-workbench', ?, ?, 100, ?, ?,
      'target-workbench', 'Workbench Target', 'codex',
      'fingerprint-codex', 200, 0, 10, 10)`
  ).run(extraExchangeId, sourceId, offset, oldTime, oldTime);
  fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action,
      request_intent_label, response_status_label, tool_schema_count
    ) VALUES(?, ?, ?, ?, ?, 3, ?, 'tool', 'continue', 'tool_use',
      '继续工具调用', '工具已完成', 1)`
  ).run(
    extraStepId,
    extraExchangeId,
    oldSessionId,
    grandchildThreadId,
    grandchildTurnId,
    new Date(base + 3_000).toISOString(),
  );
  fixture.db.prepare(
    `INSERT INTO tool_calls(
      id, exchange_id, agent_session_id, agent_thread_id,
      agent_turn_id, agent_step_id, tool_use_id, tool_name,
      status, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'Read', 'completed', ?)`
  ).run(
    `${extraStepId}-tool`,
    extraExchangeId,
    oldSessionId,
    grandchildThreadId,
    grandchildTurnId,
    extraStepId,
    `${extraStepId}-use`,
    oldTime,
  );
  fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      agent_step_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      created_at
    ) VALUES(?, ?, ?, ?, ?, 'target-workbench', 'fingerprint-codex',
      'codex', 'gpt-fixture', 'openai', 1, 10, 5, 0, 4, 0.1, 0.05,
      25, 'fixture', 'exact', '{}', ?)`
  ).run(
    extraExchangeId,
    oldSessionId,
    grandchildThreadId,
    grandchildTurnId,
    extraStepId,
    new Date(base + 3_000).toISOString(),
  );
  fixture.db.prepare(
    "UPDATE agent_turns SET step_count = 2 WHERE id = ?",
  ).run(grandchildTurnId);

  return {
    oldSessionId,
    rootThreadId,
    childThreadId,
    grandchildThreadId,
    grandchildTurnId,
    grandchildStepId,
    grandchildExchangeId,
    latestStepId: extraStepId,
    latestExchangeId: extraExchangeId,
  };
}

/** 意图统计/压缩事件用例的通用播种：向孙 Turn 追加带动作与压缩标志的 Step。 */
function seedIntentStatSteps(
  fixture: SqliteFixture,
  tree: SeededTree,
): (steps: Array<{
  index: number;
  requestAction: string;
  responseAction: string;
  label: string | null;
  compressed: 0 | 1;
}>) => Map<number, string> {
  const sourceId = fixture.db.prepare(
    "SELECT id FROM ingestion_sources LIMIT 1",
  ).pluck().get() as number;
  const insertExchange = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-workbench', ?, ?, 100, ?, ?,
      'target-workbench', 'Workbench Target', 'codex',
      'fingerprint-codex', 500, 0, 10, 10)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action,
      request_intent_label, context_compressed
    ) VALUES(?, ?, 'session-000', ?, ?, ?, ?, 'tool', ?, ?, ?, ?)`,
  );
  const base = Date.parse("2026-07-17T00:00:00.000Z");
  return steps => {
    const ids = new Map<number, string>();
    for (const step of steps) {
      const exchangeId = `${tree.grandchildTurnId}-exchange-intent-${step.index}`;
      const stepId = `${tree.grandchildTurnId}-step-intent-${step.index}`;
      const timestamp = new Date(base + step.index * 1_000).toISOString();
      insertExchange.run(exchangeId, sourceId, 500000 + step.index, timestamp, timestamp);
      insertStep.run(
        stepId,
        exchangeId,
        tree.grandchildThreadId,
        tree.grandchildTurnId,
        step.index,
        timestamp,
        step.requestAction,
        step.responseAction,
        step.label,
        step.compressed,
      );
      ids.set(step.index, stepId);
    }
    return ids;
  };
}

function insertRawRef(
  fixture: SqliteFixture,
  exchange: RawCapturedExchangeV2,
  sourceId: number,
  byteOffset: number,
  lineLengthBytes: number,
): void {
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'codex', 'fingerprint-codex',
      'gpt-fixture', ?, ?, ?, ?)`
  ).run(
    exchange.exchangeId,
    exchange.captureSessionId,
    sourceId,
    byteOffset,
    lineLengthBytes,
    exchange.capturedAt,
    exchange.completedAt,
    exchange.routing.targetId,
    exchange.routing.targetName,
    exchange.response.status,
    exchange.response.isStreaming ? 1 : 0,
    exchange.request.bodySizeBytes,
    exchange.response.bodySizeBytes,
  );
}

function rawExchange(exchangeId: string, sequence: number): RawCapturedExchangeV2 {
  const requestBody = JSON.stringify({ model: "gpt-fixture", sequence });
  const responseBody = JSON.stringify({ id: `response-${sequence}`, ok: true });
  const timestamp = new Date(Date.UTC(2026, 6, 17, 10, 0, sequence)).toISOString();
  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-v2-1784282400000-12345678-abc",
    sequence,
    capturedAt: timestamp,
    completedAt: timestamp,
    durationMs: 10,
    routing: {
      targetId: "target-workbench",
      targetName: "Workbench Target",
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1:4000/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: {
      headers: { "content-type": "application/json" },
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: "a".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: "b".repeat(64),
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

async function seedRawDetail(
  fixture: SqliteFixture,
  exchange: RawCapturedExchangeV2,
  fileName: string,
): Promise<void> {
  const line = `${JSON.stringify(exchange)}\n`;
  await fixture.writeV2Lines([], fileName);
  await fixture.appendRaw(join(fixture.dataDir, "captures", "v2", fileName), line);
  await discoverV2Sources(fixture.db, fixture.dataDir);
  const relativePath = `captures/v2/${fileName}`;
  const sourceId = fixture.db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path = ?",
  ).pluck().get(relativePath) as number;
  insertRawRef(fixture, exchange, sourceId, 0, Buffer.byteLength(line));
}

function seedExchangeProjection(fixture: SqliteFixture, exchangeId: string): void {
  const row = fixture.db.prepare(
    `SELECT r.source_id, r.byte_offset, r.line_length_bytes, r.captured_at,
      r.completed_at, r.request_body_bytes, r.response_body_bytes,
      s.file_id, s.generation
     FROM raw_exchange_refs r
     JOIN ingestion_sources s ON s.id = r.source_id
     WHERE r.exchange_id = ?`,
  ).get(exchangeId) as {
    source_id: number;
    byte_offset: number;
    line_length_bytes: number;
    captured_at: string;
    completed_at: string;
    request_body_bytes: number;
    response_body_bytes: number;
    file_id: string;
    generation: number;
  };
  const now = "2026-07-22T12:00:00.000Z";
  const ingestionRecordId = fixture.db.prepare(
    `INSERT INTO ingestion_records(
      exchange_id, source_id, source_generation, source_file_id,
      byte_offset, line_length_bytes, line_sha256, schema_version,
      captured_at, completed_at, request_body_bytes, response_body_bytes,
      request_body_sha256, response_body_sha256,
      request_body_storage, response_body_storage,
      request_body_state, response_body_state, registered_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?,
      'inline', 'inline', 'available', 'available', ?)
    RETURNING id`,
  ).pluck().get(
    exchangeId,
    row.source_id,
    row.generation,
    row.file_id,
    row.byte_offset,
    row.line_length_bytes,
    "c".repeat(64),
    row.captured_at,
    row.completed_at,
    row.request_body_bytes,
    row.response_body_bytes,
    "a".repeat(64),
    "b".repeat(64),
    now,
  ) as number;
  fixture.db.prepare(
    "UPDATE raw_exchange_refs SET ingestion_record_id = ? WHERE exchange_id = ?",
  ).run(ingestionRecordId, exchangeId);
  fixture.db.prepare(
    `INSERT INTO derivation_jobs(
      ingestion_record_id, projection_version, job_status,
      projection_completeness, attempt_count, available_at,
      limited_dimensions_json, request_verification, response_verification,
      created_at, updated_at, completed_at
    ) VALUES(?, 1, 'succeeded', 'limited', 1, ?, '["request_text"]',
      'verified', 'verified', ?, ?, ?)`,
  ).run(ingestionRecordId, now, now, now, now);
  const preview = {
    schemaVersion: 1,
    exchangeId,
    projectionVersion: 1,
    protocol: "openai-responses",
    endpointKind: "model-call",
    conversationItems: [{
      side: "request",
      category: "message",
      role: "user",
      itemType: "input_text",
      jsonPath: "$.input[0].content[0].text",
      textPreview: "有界请求预览",
      textSha256: "d".repeat(64),
      originalTextBytes: 32,
      previewTextBytes: Buffer.byteLength("有界请求预览"),
      truncated: true,
      mediaDescriptorOrdinals: [0],
    }],
    itemCandidateCount: 2,
    itemProcessedCount: 1,
    itemCandidateCountExact: true,
    candidateTextBytes: 64,
    processedTextBytes: Buffer.byteLength("有界请求预览"),
    diagnosticCodes: ["request_text_limited"],
    limitedDimensions: ["request_text"],
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
    ) VALUES(?, 1, 'limited', ?, ?, 2, 1, 64, ?, 1, 1, 1,
      '["request_text"]', ?, ?)`,
  ).run(
    exchangeId,
    previewJson,
    Buffer.byteLength(previewJson),
    Buffer.byteLength("有界请求预览"),
    now,
    now,
  );
  fixture.db.prepare(
    `INSERT INTO exchange_media_descriptors(
      exchange_id, body_side, ordinal, json_path, media_type,
      encoded_bytes, decoded_bytes, sha256, raw_body_sha256, source_storage
    ) VALUES(?, 'request', 0, '$.input[0].image_url', 'image/png',
      128, 96, ?, ?, 'inline')`,
  ).run(exchangeId, "e".repeat(64), "a".repeat(64));
  fixture.db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, ingestion_record_id, projection_version,
      code, severity, message, details_json, created_at
    ) VALUES(?, ?, ?, 1, 'request_text_limited', 'warning',
      '请求文本预览受限。', '{}', ?)`,
  ).run(exchangeId, row.source_id, ingestionRecordId, now);
}

function closeRouteDatabase(dataDir: string): void {
  const db = getDeepaaDatabase(dataDir);
  if (db.open) db.close();
}
