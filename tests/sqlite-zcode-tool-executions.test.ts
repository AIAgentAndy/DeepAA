import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, test} from "node:test";
import {createSqliteFixture, type SqliteFixture} from "./helpers/sqlite-fixture.js";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  findToolExecutionByCallId,
  syncZcodeToolExecutions,
  TOOL_EXECUTION_BATCH_LIMIT,
} from "../src/lib/agent-local-source/tool-execution-sync.js";
import {lookupCapability} from "../src/lib/db/capability-lookup-queries.js";
import {createExchangeProcessor} from "../src/lib/ingestion/exchange-processor.js";
import type {RawCapturedExchangeV2} from "../src/lib/harness/types.js";

const BASE_TIME = "2026-11-04T12:00:00.000Z";

/**
 * P2-a（2026-11-04）：zcode 原生执行证据采集回归。
 * 隔离 mock zcode CLI 目录（ZCODE_CLI_DIR 指向临时目录,绝不触碰真实 ~/.zcode）;
 * 覆盖:只读采集/水位续跑/批量上限哨兵/幂等/查询 join(tool_call_id ↔ tool_use_id)。
 */
describe("P2-a zcode 原生执行证据", () => {
  const fixtures: SqliteFixture[] = [];
  const cliDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
    for (const dir of cliDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
  });

  function makeMockZcodeCli(rows: Array<Record<string, unknown>>): string {
    const cliDir = mkdtempSync(join(tmpdir(), "deepaa-zcode-exec-"));
    cliDirs.push(cliDir);
    mkdirSync(join(cliDir, "db"), {recursive: true});
    const db = new DeepaaDatabase(join(cliDir, "db", "db.sqlite"));
    db.exec(`CREATE TABLE tool_usage (
      id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, tool_call_id TEXT, tool_name TEXT NOT NULL,
      status TEXT, approval_status TEXT, side_effect_scope TEXT,
      read_only INTEGER, destructive INTEGER, started_at INTEGER, completed_at INTEGER,
      duration_ms INTEGER, time_to_first_output_ms INTEGER, exit_code INTEGER, output_bytes INTEGER,
      retry_count INTEGER, cancelled_by_user INTEGER, error_type TEXT, error_message TEXT
    )`);
    const insert = db.prepare(
      `INSERT INTO tool_usage(id, session_id, turn_id, tool_call_id, tool_name, status, approval_status,
        side_effect_scope, read_only, destructive, started_at, completed_at, duration_ms,
        time_to_first_output_ms, exit_code, output_bytes, retry_count, cancelled_by_user,
        error_type, error_message)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) insert.run(...[
      row.id, row.session_id ?? null, row.turn_id ?? null, row.tool_call_id ?? null,
      row.tool_name, row.status ?? null, row.approval_status ?? null, row.side_effect_scope ?? null,
      row.read_only ?? null, row.destructive ?? null, row.started_at ?? null, row.completed_at ?? null,
      row.duration_ms ?? null, row.time_to_first_output_ms ?? null, row.exit_code ?? null,
      row.output_bytes ?? null, row.retry_count ?? 0, row.cancelled_by_user ?? 0,
      row.error_type ?? null, row.error_message ?? null,
    ]);
    db.close();
    return cliDir;
  }

  test("增量采集:水位续跑 + limit 哨兵 + 幂等 + join 键保留", async () => {
    const rows = Array.from({length: TOOL_EXECUTION_BATCH_LIMIT + 3}, (_, i) => ({
      id: `usage_tool_${i}`,
      session_id: "sess-a",
      tool_call_id: `call_${i}`,
      tool_name: "Bash",
      status: i % 10 === 0 ? "error" : "completed",
      started_at: 1793790000000 + i,
      duration_ms: 100 + i,
      exit_code: i % 10 === 0 ? 1 : 0,
      error_type: i % 10 === 0 ? "exec_failed" : null,
    }));
    const cliDir = makeMockZcodeCli(rows);
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    // 第一轮:limit 哨兵(500+1 → 处理 500, hasMore)。
    const first = syncZcodeToolExecutions(fixture.db, {cliDir});
    assert.equal(first.processedCount, TOOL_EXECUTION_BATCH_LIMIT);
    assert.equal(first.hasMore, true);
    // 第二轮:余 3 行。
    const second = syncZcodeToolExecutions(fixture.db, {cliDir});
    assert.equal(second.processedCount, 3);
    assert.equal(second.hasMore, false);
    // 第三轮:水位后无新行 → 0。
    const third = syncZcodeToolExecutions(fixture.db, {cliDir});
    assert.equal(third.processedCount, 0);
    // 幂等:重复跑零新增(总数不变)。
    void syncZcodeToolExecutions(fixture.db, {cliDir});
    const total = fixture.db.prepare("SELECT COUNT(*) c FROM agent_tool_executions").get().c;
    assert.equal(total, rows.length);

    // 查询键:tool_call_id 精确命中执行侧。
    const evidence = findToolExecutionByCallId(fixture.db, "call_0");
    assert.ok(evidence);
    assert.equal(evidence.status, "error");
    assert.equal(evidence.exitCode, 1);
    assert.equal(evidence.errorType, "exec_failed");
    assert.equal(findToolExecutionByCallId(fixture.db, "call_nonexistent"), undefined);
  });

  test("源库只读保护:query_only 下写操作被拒(结构验证)", async () => {
    const cliDir = makeMockZcodeCli([{id: "u1", tool_name: "Bash", status: "completed"}]);
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    assert.equal(syncZcodeToolExecutions(fixture.db, {cliDir}).processedCount, 1);
    // 采集绝不修改源库:源行数不变。
    const source = new DeepaaDatabase(join(cliDir, "db", "db.sqlite"), {readonly: true});
    try {
      assert.equal(source.prepare("SELECT COUNT(*) c FROM tool_usage").get().c, 1);
    } finally {
      source.close();
    }
  });

  test("反查 join:wire tool_use_id ↔ 原生 tool_call_id 执行侧透出", async () => {
    const cliDir = makeMockZcodeCli([{
      id: "usage_call_99",
      tool_call_id: "call_99",
      tool_name: "Bash",
      status: "completed",
      approval_status: "none",
      duration_ms: 12708,
      exit_code: 0,
      started_at: 1793791416991,
    }]);
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    assert.equal(syncZcodeToolExecutions(fixture.db, {cliDir}).processedCount, 1);

    // 构造一个 wire 侧 step:响应调用 call_99(name=Bash,与 zcode 原生记录同名)。
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/p2a.jsonl', 'f', 4096, ?) RETURNING id`,
    ).pluck().get(BASE_TIME) as number;
    const capturedAt = new Date(1793791416991).toISOString();
    const requestBody = JSON.stringify({model: "m", instructions: "You are Codex.", input: [], tools: [{type: "function", name: "Bash", parameters: {type: "object"}}]});
    const responseBody = JSON.stringify({id: "r1", object: "response", status: "completed", model: "m",
      output: [{type: "function_call", call_id: "call_99", name: "Bash", arguments: "{}"}],
      usage: {input_tokens: 100, output_tokens: 4}});
    const exchange: RawCapturedExchangeV2 = {
      schemaVersion: 2, exchangeId: "capture-p2a:ex-1", captureSessionId: "capture-p2a", sequence: 1,
      capturedAt, completedAt: new Date(Date.parse(capturedAt) + 25).toISOString(), durationMs: 25,
      routing: {targetId: "t", targetName: "T", targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/zcode/v1/responses", upstreamUrl: "https://example.test/v1/responses",
        localPath: "/zcode/v1/responses", upstreamPath: "/v1/responses", method: "POST", agent: "zcode", wireApi: "responses"},
      request: {headers: {"user-agent": "ZCode/1.0.0", session_id: "sess-x", thread_id: "th-x",
        "x-codex-turn-metadata": JSON.stringify({session_id: "sess-x", thread_id: "th-x", turn_id: "tu-x", request_kind: "turn", workspaces: {}})},
        rawBody: requestBody, bodySizeBytes: 100, bodySha256: "r1"},
      response: {status: 200, statusText: "OK", headers: {}, rawBody: responseBody, bodySizeBytes: 100, bodySha256: "s1", isStreaming: false},
      bodyStorage: {policy: "inline"}, captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    };
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const result = await processor.processExchangeRecord({sourceId, sourceRelativePath: "captures/v2/p2a.jsonl", byteOffset: 0, lineLengthBytes: 100, exchange});
    const stepId = fixture.db.prepare("SELECT id FROM agent_steps WHERE exchange_id = ?").pluck().get(result.exchangeId) as string;

    const lookup = lookupCapability(fixture.db, {agentName: "zcode", kind: "tool", name: "Bash"});
    assert.ok(lookup);
    assert.equal(lookup.calls.items.length, 1);
    const call = lookup.calls.items[0]!;
    assert.equal(call.toolUseId, "call_99");
    assert.ok(call.execution, "原生执行侧证据必须经 join 透出");
    assert.equal(call.execution.status, "completed");
    assert.equal(call.execution.durationMs, 12708);
    assert.equal(call.execution.exitCode, 0);
    assert.equal(call.execution.approvalStatus, "none");
    // 无执行记录的 agent(codex)不误挂。
    const codex = lookupCapability(fixture.db, {agentName: "codex", kind: "tool", name: "Bash"});
    assert.ok(codex);
    assert.equal(codex.calls.items.length, 0);
    void stepId;
  });
});
