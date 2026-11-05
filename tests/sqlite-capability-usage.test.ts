import assert from "node:assert/strict";
import {afterEach, describe, test} from "node:test";
import type {RawCapturedExchangeV2} from "../src/lib/harness/types.js";
import {createExchangeProcessor} from "../src/lib/ingestion/exchange-processor.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";
import {capabilityUsageForAgent, USAGE_MIN_DECLARED_STEPS} from "../src/lib/db/capability-usage-queries.js";

const BASE_TIME = new Date().toISOString();

/**
 * P2-b（2026-11-04）：能力利用率首版回归——声明/调用覆盖率不混算、低调用候选
 * 规则（观察结论）、执行侧聚合（P2-a 数据）、仅调用工具覆盖率不适用、
 * 借补 step 计数透出。隔离临时数据目录（AGENTS.md 验证红线）。
 */
describe("SQLite 能力利用率（P2-b）", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  function makeExchange(seq: number, tools: unknown[], calls: Array<{name: string}>): RawCapturedExchangeV2 {
    const capturedAt = new Date(Date.parse(BASE_TIME) - (20 - seq) * 60_000).toISOString();
    const requestBody = JSON.stringify({
      model: "fixture-model", instructions: "You are a fixture agent.",
      input: [{type: "message", role: "user", content: [{type: "input_text", text: `turn ${seq}`}]}],
      tools,
    });
    const responseBody = JSON.stringify({
      id: `response-${seq}`, object: "response", status: "completed", model: "fixture-model",
      output: calls.map((c, i) => ({type: "function_call", call_id: `call-${seq}-${i}`, name: c.name, arguments: "{}"})),
      usage: {input_tokens: 100, output_tokens: 4},
    });
    return {
      schemaVersion: 2, exchangeId: `capture-usage:ex-${seq}`, captureSessionId: "capture-usage", sequence: seq,
      capturedAt, completedAt: new Date(Date.parse(capturedAt) + 25).toISOString(), durationMs: 25,
      routing: {targetId: "t", targetName: "T", targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/zcode/v1/responses", upstreamUrl: "https://e.test/v1/responses",
        localPath: "/zcode/v1/responses", upstreamPath: "/v1/responses", method: "POST", agent: "zcode", wireApi: "responses"},
      request: {headers: {"user-agent": "ZCode/1.0.0", session_id: "sess-u", thread_id: "th-u",
        "x-codex-turn-metadata": JSON.stringify({session_id: "sess-u", thread_id: "th-u", turn_id: "tu-u", request_kind: "turn", workspaces: {}})},
        rawBody: requestBody, bodySizeBytes: 100, bodySha256: `r-${seq}`},
      response: {status: 200, statusText: "OK", headers: {}, rawBody: responseBody, bodySizeBytes: 100, bodySha256: `s-${seq}`, isStreaming: false},
      bodyStorage: {policy: "inline"}, captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    };
  }

  test("覆盖率/候选/执行侧/仅调用工具口径", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/usage.jsonl', 'f', 4096, ?) RETURNING id`,
    ).pluck().get(BASE_TIME) as number;
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});

    const tools = [
      {type: "function", name: "heavy-tool", parameters: {type: "object"}},
      {type: "function", name: "idle-tool", parameters: {type: "object"}},
    ];
    // 12 步声明两种工具;heavy 调用于 6 步,idle 仅 1 步;另有 orphan(未声明)调用。
    let offset = 0;
    for (let seq = 1; seq <= 12; seq += 1) {
      const calls = seq <= 6 ? [{name: "heavy-tool"}] : seq === 7 ? [{name: "idle-tool"}, {name: "orphan-tool"}] : [];
      await processor.processExchangeRecord({
        sourceId, sourceRelativePath: "captures/v2/usage.jsonl",
        byteOffset: offset, lineLengthBytes: 100, exchange: makeExchange(seq, tools, calls),
      });
      offset += 100;
    }
    // 执行侧:heavy 3 次成功 + 1 次错误。
    const insertExec = fixture.db.prepare(
      `INSERT INTO agent_tool_executions(id, agent_name, tool_call_id, tool_name, status,
        duration_ms, exit_code, started_at, synced_at) VALUES(?, 'zcode', ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 4; i += 1) {
      insertExec.run(`exec-${i}`, `call-x-${i}`, "heavy-tool",
        i === 3 ? "error" : "completed", 1000 + i * 500, i === 3 ? 1 : 0,
        Date.now() - 3_600_000, BASE_TIME);
    }

    const usage = capabilityUsageForAgent(fixture.db, {agentName: "zcode", windowDays: 7});
    const byName = new Map(usage.items.map(item => [item.name, item]));
    const heavy = byName.get("heavy-tool");
    assert.ok(heavy);
    assert.equal(heavy.declaredSteps, 12);
    assert.equal(heavy.invokedSteps, 6);
    assert.equal(heavy.invokedCalls, 6);
    assert.ok(Math.abs((heavy.coverage ?? 0) - 0.5) < 1e-9);
    assert.equal(heavy.lowUseCandidate, false, "50% 覆盖不是候选");
    assert.equal(heavy.executedCount, 4);
    assert.equal(heavy.avgDurationMs, Math.round((1000 + 1500 + 2000 + 2500) / 4));
    assert.equal(heavy.errorCount, 1);

    const idle = byName.get("idle-tool");
    assert.ok(idle);
    assert.equal(idle.declaredSteps, 12);
    assert.equal(idle.invokedSteps, 1);
    assert.ok(Math.abs((idle.coverage ?? 1) - 1 / 12) < 1e-9);
    assert.equal(idle.lowUseCandidate, true, `声明 ${USAGE_MIN_DECLARED_STEPS}+ 且覆盖 <20% 必须是候选`);

    const orphan = byName.get("orphan-tool");
    assert.ok(orphan);
    assert.equal(orphan.declaredSteps, 0);
    assert.equal(orphan.coverage, undefined, "仅调用工具覆盖率不适用");
    assert.equal(orphan.lowUseCandidate, false, "无分母不进候选");
    // 审计修订 A(§11.1 红线):分子必须是同分母子集——覆盖率恒 ≤100%,
    // 其它快照上的调用(observed-only)不得计入分子。
    for (const item of usage.items) {
      if (item.coverage !== undefined) {
        assert.ok(item.coverage <= 1, `${item.name} coverage=${item.coverage} 超过 100%`);
        assert.ok(item.invokedSteps <= item.declaredSteps, `${item.name} 分子超过分母`);
      }
    }
    // 候选排序优先。
    assert.equal(usage.items[0]?.name, "idle-tool");
    assert.equal(usage.borrowedStepCount, 0);
    assert.equal(usage.thresholds.minDeclaredSteps, USAGE_MIN_DECLARED_STEPS);
  });
});
