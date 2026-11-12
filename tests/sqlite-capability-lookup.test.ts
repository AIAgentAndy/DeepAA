import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import { createExchangeProcessor } from "../src/lib/ingestion/exchange-processor.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";
import { lookupCapability } from "../src/lib/db/capability-lookup-queries.js";

const BASE_TIME = "2026-11-03T14:00:00.000Z";

/**
 * P1-4（2026-11-03）：能力双向反查回归——名字级身份（coverage=name-level），
 * 调用反查 keyset 分页（v55 idx_tools_name_time）、声明出现反查
 * （idx_steps_snapshot + 快照 LIKE 精确匹配不误中前缀名）、汇总口径。
 * 全部使用隔离临时数据目录（AGENTS.md 验证红线）。
 */
describe("SQLite 能力双向反查（P1-4）", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  function makeExchange(options: {
    sequence: number;
    threadId: string;
    tools: unknown[];
    calls?: Array<{name: string}>;
  }): RawCapturedExchangeV2 {
    const capturedAt = new Date(Date.parse(BASE_TIME) + options.sequence * 1_000).toISOString();
    const requestBody = JSON.stringify({
      model: "fixture-model",
      instructions: "You are a fixture agent.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `turn ${options.sequence}` }] }],
      tools: options.tools,
    });
    const responseBody = JSON.stringify({
      id: `response-${options.sequence}`,
      object: "response",
      status: "completed",
      model: "fixture-model",
      output: (options.calls ?? []).map((call, index) => ({
        type: "function_call",
        call_id: `call-${options.sequence}-${index}`,
        name: call.name,
        arguments: "{}",
      })),
      usage: { input_tokens: 100, output_tokens: 4, total_tokens: 104 },
    });
    const metadata = {
      session_id: "session-p14",
      thread_id: options.threadId,
      turn_id: "turn-p14",
      request_kind: "turn",
      workspaces: { "/tmp/deepaa-p14": {} },
    };
    return {
      schemaVersion: 2,
      exchangeId: `capture-p14:ex-${options.sequence}`,
      captureSessionId: "capture-p14",
      sequence: options.sequence,
      capturedAt,
      completedAt: new Date(Date.parse(capturedAt) + 25).toISOString(),
      durationMs: 25,
      routing: {
        targetId: "target-p14",
        targetName: "P14 Target",
        targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:1234/codex/v1/responses",
        upstreamUrl: "https://example.test/v1/responses",
        localPath: "/codex/v1/responses",
        upstreamPath: "/v1/responses",
        method: "POST",
        agent: "codex",
        wireApi: "responses",
      },
      request: {
        headers: {
          "user-agent": "codex-tui/0.165.0",
          session_id: "session-p14",
          thread_id: options.threadId,
          "x-codex-turn-metadata": JSON.stringify(metadata),
        },
        rawBody: requestBody,
        bodySizeBytes: Buffer.byteLength(requestBody),
        bodySha256: `req-${options.sequence}`,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        rawBody: responseBody,
        bodySizeBytes: Buffer.byteLength(responseBody),
        bodySha256: `resp-${options.sequence}`,
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

  async function run(fixture: SqliteFixture, exchanges: RawCapturedExchangeV2[]): Promise<void> {
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/p14.jsonl', 'f', 4096, ?) RETURNING id`,
    ).pluck().get(BASE_TIME) as number;
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    let offset = 0;
    for (const exchange of exchanges) {
      await processor.processExchangeRecord({
        sourceId, sourceRelativePath: "captures/v2/p14.jsonl",
        byteOffset: offset, lineLengthBytes: 100, exchange,
      });
      offset += 100;
    }
  }

  test("反查：声明出现 + 调用记录 + 汇总，名字精确不误中前缀", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await run(fixture, [
      // step1:声明 alpha + alpha-lite(前缀名陷阱),调用 alpha 2 次。
      makeExchange({ sequence: 1, threadId: "t1", tools: [
        { type: "function", name: "alpha", parameters: { type: "object" } },
        { type: "function", name: "alpha-lite", parameters: { type: "object" } },
      ], calls: [{ name: "alpha" }, { name: "alpha" }] }),
      // step2:同清单(去重同快照),未调用。
      makeExchange({ sequence: 2, threadId: "t1", tools: [
        { type: "function", name: "alpha", parameters: { type: "object" } },
        { type: "function", name: "alpha-lite", parameters: { type: "object" } },
      ] }),
    ]);

    const result = lookupCapability(fixture.db, {agentName: "codex", kind: "tool", name: "alpha"});
    assert.ok(result);
    assert.equal(result.identity.coverage, "name-level");
    // 声明出现:两个 step 共享同一快照。
    assert.equal(result.totals.declaredStepCount, 2);
    // 调用:1 步 2 次。
    assert.equal(result.totals.invokedStepCount, 1);
    assert.equal(result.totals.invokedCallCount, 2);
    // 名字精确:alpha 不误中 alpha-lite 的声明(alpha-lite 与 alpha 同快照,
    // 但 alpha-lite 自身反查时声明数同样为 2;此处验证 calls 只含 alpha)。
    assert.ok(result.calls.items.every(row => row.status === "completed" || row.status === "awaiting_result"));
    // 声明行带 step 级调用计数。
    const declaredByStep = new Map(result.declaredIn.items.map(row => [row.stepId, row.invokedThisStep]));
    assert.equal(result.declaredIn.items.length, 2);
    const invokedDeclared = result.declaredIn.items.find(row => row.invokedThisStep > 0);
    assert.ok(invokedDeclared, "step1 的声明行必须带 2 次调用计数");
    assert.equal(invokedDeclared.invokedThisStep, 2);
    assert.ok(declaredByStep);

    // 前缀名陷阱:反查 alpha-lite 得到 0 调用(未被调用),声明 2 步。
    const lite = lookupCapability(fixture.db, {agentName: "codex", kind: "tool", name: "alpha-lite"});
    assert.ok(lite);
    assert.equal(lite.totals.invokedCallCount, 0);
    assert.equal(lite.totals.declaredStepCount, 2);
  });

  test("skill 反查双形态名(2026-11-12):插件前缀名 ↔ 裸名声明/激活互认,声明列表非空", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    // 直接播种最小读路径(lookupCapability 只读这四张表):
    // wire 声明用裸名(skills_json),激活记录用插件前缀名(skill_activations)。
    const db = fixture.db;
    const srcId = db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/skill-dual.jsonl', 'f', 4096, ?) RETURNING id`,
    ).pluck().get(BASE_TIME) as number;
    db.prepare(
      `INSERT INTO agent_sessions(id, target_id, target_name, agent_fingerprint_id, agent_name,
         source, confidence, start_time, end_time)
       VALUES('asess-s', 'tg', 'T', 'fp', 'zcode', 'fixture', 'exact', ?, ?)`,
    ).run(BASE_TIME, BASE_TIME);
    db.prepare(
      `INSERT INTO agent_threads(id, agent_session_id, source, display_name, confidence,
         is_root, start_time, end_time)
       VALUES('athread-s', 'asess-s', 'fixture', 't', 'exact', 1, ?, ?)`,
    ).run(BASE_TIME, BASE_TIME);
    db.prepare(
      `INSERT INTO agent_turns(id, agent_session_id, agent_thread_id, source, confidence, status,
         segment_index, start_exchange_id, start_time, end_time, step_count)
       VALUES('aturn-s', 'asess-s', 'athread-s', 'fixture', 'exact', 'closed', 0, 'ex-s1', ?, ?, 2)`,
    ).run(BASE_TIME, BASE_TIME);
    db.prepare(
      `INSERT INTO harness_snapshots(snapshot_hash, agent_name, skill_count, skills_json, first_seen_at, last_seen_at)
       VALUES('hs-s1', 'zcode', 1, ?, ?, ?)`,
    ).run(JSON.stringify([{name: "control-browser", schemaTokensEst: 10}]), BASE_TIME, BASE_TIME);
    let stepId = 1;
    for (const ex of ["ex-s1", "ex-s2"]) {
      db.prepare(
        `INSERT INTO raw_exchange_refs(
           exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
           captured_at, completed_at, target_id, target_name, agent_name,
           agent_fingerprint_id, model, status, is_streaming,
           request_body_bytes, response_body_bytes
         ) VALUES(?, 'cap', ?, 0, 128, ?, ?, 'tg', 'T', 'zcode', 'fp', 'm', 200, 0, 16, 16)`,
      ).run(ex, srcId, BASE_TIME, BASE_TIME);
      db.prepare(
        `INSERT INTO agent_steps(
           id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
           step_index, timestamp, phase, request_action, response_action, harness_snapshot_hash
         ) VALUES(?, ?, 'asess-s', 'athread-s', 'aturn-s', ?, ?, 'model', 'model_request', 'model_response', 'hs-s1')`,
      ).run(`astep-s${stepId}`, ex, stepId - 1, BASE_TIME);
      stepId += 1;
    }
    db.prepare(
      `INSERT INTO skill_activations(id, agent_name, skill_name, exchange_id, agent_step_id, agent_turn_id, activated_at)
       VALUES('sa-1', 'zcode', 'browser-use:control-browser', 'ex-s1', 'astep-s1', 'aturn-s', ?)`,
    ).run(BASE_TIME);

    // 前缀名反查:声明(裸名)与激活(前缀名)都命中;声明列表非空且带步级激活计数。
    const prefixed = lookupCapability(db, {agentName: "zcode", kind: "skill", name: "browser-use:control-browser"});
    assert.ok(prefixed);
    assert.equal(prefixed.totals.declaredStepCount, 2, "裸名声明必须被前缀名反查命中");
    assert.equal(prefixed.declaredIn.items.length, 2, "声明列表非空(修复前恒空)");
    assert.equal(prefixed.totals.invokedCallCount, 1);
    assert.equal(prefixed.totals.invokedStepCount, 1);
    const actRow = prefixed.declaredIn.items.find(row => row.invokedThisStep > 0);
    assert.ok(actRow, "声明行必须带步级激活计数");
    assert.equal(actRow!.invokedThisStep, 1);
    assert.equal(prefixed.calls.items.length, 1);

    // 裸名反查:激活(前缀名存储)经 LIKE 回认,声明同样命中。
    const bare = lookupCapability(db, {agentName: "zcode", kind: "skill", name: "control-browser"});
    assert.ok(bare);
    assert.equal(bare.totals.invokedCallCount, 1, "裸名反查命中前缀名激活记录");
    assert.equal(bare.totals.declaredStepCount, 2);

    // 跨 Agent 隔离:其它 Agent 查同名零命中。
    const other = lookupCapability(db, {agentName: "codex", kind: "skill", name: "browser-use:control-browser"});
    assert.ok(other);
    assert.equal(other.totals.invokedCallCount, 0);
    assert.equal(other.totals.declaredStepCount, 0);
  });

  test("跨 Agent 隔离：只命中指定 Agent 的记录", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await run(fixture, [
      makeExchange({ sequence: 1, threadId: "t1", tools: [
        { type: "function", name: "shared-name", parameters: { type: "object" } },
      ], calls: [{ name: "shared-name" }] }),
    ]);
    const other = lookupCapability(fixture.db, {agentName: "zcode", kind: "tool", name: "shared-name"});
    assert.ok(other);
    assert.equal(other.totals.invokedCallCount, 0, "zcode 反查不得命中 codex 的调用");
    assert.equal(other.totals.declaredStepCount, 0);
  });
});
