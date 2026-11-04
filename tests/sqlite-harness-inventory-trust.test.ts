import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import { createExchangeProcessor } from "../src/lib/ingestion/exchange-processor.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";
import { loadAgentStepHarness } from "../src/lib/db/harness-queries.js";

const BASE_TIME = "2026-11-03T08:00:00.000Z";

/**
 * I1 能力清单可信回归（2026-11-03，docs/Agent底层Harness剖析与推进方案-2026-10-30.md）：
 * - F11：传递清单（declared）与调用证据（observed_only）分离，调用项不混入传递分母；
 * - F12：调用分组 201 上限哨兵，超出工具调用数标未知不落 0；
 * - F1：本地导入行借补清单降级为参考（reference 带 donor），不作为当次确定传递。
 * 全部使用隔离临时数据目录（AGENTS.md 验证红线）。
 */
describe("SQLite Harness 清单可信（F1/F11/F12）", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  function seedIngestionSource(fixture: SqliteFixture, relativePath: string): {sourceId: number} {
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES(?, ?, 4096, ?) RETURNING id`,
    ).pluck().get(relativePath, `fixture:${relativePath}`, BASE_TIME) as number;
    return {sourceId};
  }

  function makeExchange(options: {
    sequence: number;
    threadId: string;
    userAgent?: string;
    declaredTools: Array<{type: string; name?: string; function?: {name: string; parameters?: unknown}}>;
    /** 响应 output 中的 function_call 调用（name 即调用名）。 */
    calls?: Array<{name: string}>;
    routingOrigin?: "gateway" | "agent_local_import";
    agent?: string;
  }): RawCapturedExchangeV2 {
    const capturedAt = new Date(Date.parse(BASE_TIME) + options.sequence * 1_000).toISOString();
    const agent = options.agent ?? "codex";
    const requestBody = JSON.stringify({
      model: "fixture-model",
      instructions: "You are a fixture agent.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: `turn ${options.sequence}` }] },
      ],
      tools: options.declaredTools,
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
      session_id: "session-trust",
      thread_id: options.threadId,
      turn_id: "turn-trust",
      request_kind: "turn",
      workspaces: { "/tmp/deepaa-trust-project": {} },
    };
    return {
      schemaVersion: 2,
      exchangeId: `capture-trust:ex-${options.sequence}`,
      captureSessionId: "capture-trust",
      sequence: options.sequence,
      capturedAt,
      completedAt: new Date(Date.parse(capturedAt) + 25).toISOString(),
      durationMs: 25,
      routing: {
        targetId: "target-trust",
        targetName: "Trust Target",
        targetFormatHint: "openai",
        origin: options.routingOrigin,
        localUrl: "http://127.0.0.1:1234/codex/v1/responses",
        upstreamUrl: "https://example.test/v1/responses",
        localPath: "/codex/v1/responses",
        upstreamPath: "/v1/responses",
        method: "POST",
        agent,
        wireApi: "responses",
      },
      request: {
        headers: {
          "user-agent": options.userAgent ?? "codex-tui/fixture",
          session_id: "session-trust",
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

  async function processExchange(
    fixture: SqliteFixture,
    source: {sourceId: number},
    exchange: RawCapturedExchangeV2,
    byteOffset: number,
  ): Promise<{exchangeId: string; stepId: string}> {
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    const result = await processor.processExchangeRecord({
      sourceId: source.sourceId,
      sourceRelativePath: "captures/v2/trust.jsonl",
      byteOffset,
      lineLengthBytes: 100,
      exchange,
    });
    assert.ok(result.exchangeId);
    const stepId = fixture.db.prepare(
      "SELECT id FROM agent_steps WHERE exchange_id = ?",
    ).pluck().get(result.exchangeId) as string;
    assert.ok(stepId);
    return {exchangeId: result.exchangeId, stepId};
  }

  test("F11：只声明 1 个、响应调用另一个 → 传递数仍为 1，调用项单列不进分母", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/trust.jsonl");

    const { stepId } = await processExchange(fixture, source, makeExchange({
      sequence: 1,
      threadId: "thread-f11",
      declaredTools: [
        { type: "function", name: "declared-only", parameters: { type: "object" } },
      ],
      calls: [{ name: "observed-only" }],
    }), 0);

    const harness = loadAgentStepHarness(fixture.db, stepId);
    assert.ok(harness);
    // 传递清单只含声明的 1 个。
    assert.equal(harness.inventory.tools.length, 1);
    assert.equal(harness.inventory.tools[0].name, "declared-only");
    assert.equal(harness.inventory.tools[0].exposure, "declared");
    // 调用的另一个工具单列为 observed_only，不并入传递数组。
    assert.ok(harness.inventory.observedOnlyTools);
    assert.equal(harness.inventory.observedOnlyTools.length, 1);
    assert.equal(harness.inventory.observedOnlyTools[0].name, "observed-only");
    assert.equal(harness.inventory.observedOnlyTools[0].exposure, "observed_only");
    assert.equal(harness.inventory.observedOnlyTools[0].invoked, true);
    assert.ok(harness.inventory.observedOnlyTools[0].callsThisStep >= 1);
    // 声明未调用的工具保持 invoked=false（这是真实结论，两个集合已分开）。
    assert.equal(harness.inventory.tools[0].invoked, false);
    // 未达分组上限时无截断标记。
    assert.equal(harness.callsLimited?.step, false);
  });

  test("F12：205 种工具全部调用 → 无「调用了却显示 0」，超出分组标未知", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/trust.jsonl");

    const toolNames = Array.from({ length: 205 }, (_, index) => `tool-${String(index).padStart(3, "0")}`);
    const { stepId } = await processExchange(fixture, source, makeExchange({
      sequence: 1,
      threadId: "thread-f12",
      declaredTools: toolNames.map(name => ({ type: "function", name, parameters: { type: "object" } })),
      calls: toolNames.map(name => ({ name })),
    }), 0);

    const harness = loadAgentStepHarness(fixture.db, stepId);
    assert.ok(harness);
    // 快照声明 205 个全部进 declared 清单。
    assert.equal(harness.inventory.tools.length, 205);
    assert.ok(harness.inventory.tools.every(tool => tool.exposure === "declared"));
    // 分组达上限：哨兵生效。
    assert.equal(harness.callsLimited?.step, true);
    // 205 个全部调用：201 个进入已处理集合（invoked=true），
    // 其余 4 个不得显示为「未调用」，必须 callsUnknown=true。
    const invoked = harness.inventory.tools.filter(tool => tool.invoked);
    const unknown = harness.inventory.tools.filter(tool => tool.callsUnknown === true);
    assert.equal(invoked.length + unknown.length, 205);
    assert.equal(unknown.length, 4);
    // 不允许出现任何「确定未调用且调用数未知」之外的假阴性结论。
    for (const tool of unknown) {
      assert.equal(tool.invoked, false, `${tool.name} 调用数未知时不得断言 invoked`);
    }
    // observed_only 集合为空（全部声明过）。
    assert.equal((harness.inventory.observedOnlyTools ?? []).length, 0);
  });

  test("F1：导入行借补清单 → 查询返回 reference（borrowed + donor），网关行无 reference", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/trust.jsonl");

    const dshTools = [
      { type: "function", name: "bash", parameters: { type: "object" } },
      { type: "function", name: "read", parameters: { type: "object" } },
    ];
    // 网关富快照（带 tools 声明）。
    const gateway = await processExchange(fixture, source, makeExchange({
      sequence: 1,
      threadId: "thread-f1-gw",
      declaredTools: dshTools,
      agent: "codex",
    }), 0);
    // 导入行：无 tools 声明 → 借补触发。
    const imported = await processExchange(fixture, source, makeExchange({
      sequence: 2,
      threadId: "thread-f1-imp",
      declaredTools: [],
      routingOrigin: "agent_local_import",
      agent: "codex",
    }), 100);

    const gatewayHarness = loadAgentStepHarness(fixture.db, gateway.stepId);
    assert.ok(gatewayHarness);
    assert.equal(gatewayHarness.reference, undefined, "网关行清单是当次事实，不得带参考标注");

    const importedHarness = loadAgentStepHarness(fixture.db, imported.stepId);
    assert.ok(importedHarness);
    assert.ok(importedHarness.reference, "借补行必须透出 reference 参考标注");
    assert.deepEqual(importedHarness.reference.borrowed, ["tools"]);
    const gatewayHash = fixture.db.prepare(
      "SELECT harness_snapshot_hash FROM agent_steps WHERE exchange_id = ?",
    ).pluck().get(gateway.exchangeId) as string;
    assert.equal(importedHarness.reference.donorSnapshotHash, gatewayHash);
    assert.ok(importedHarness.reference.donorLastSeenAt);
    // 借补清单仍返回（参考展示），但标注语义已由 reference 承载。
    assert.equal(importedHarness.inventory.tools.length, 2);
  });

  test("P1-1/F10：UA 版本写入 agent_sessions 首见列,Step 查询 snapshot.agentVersion 透出", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/v10.jsonl");
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const exchange = makeExchange({
      sequence: 1,
      threadId: "thread-v10",
      userAgent: "codex-tui/0.165.0",
      declaredTools: [{type: "function", name: "exec", parameters: {type: "object"}}],
    });
    const result = await processor.processExchangeRecord({
      ...source, sourceRelativePath: "captures/v2/v10.jsonl",
      byteOffset: 0, lineLengthBytes: 100, exchange,
    });
    assert.ok(result.exchangeId);
    const storedVersion = fixture.db.prepare(
      "SELECT agent_version FROM agent_sessions LIMIT 1",
    ).pluck().get() as string | null;
    assert.equal(storedVersion, "0.165.0", "schema v54 列未写入或解析失败");
    const stepId = fixture.db.prepare(
      "SELECT id FROM agent_steps WHERE exchange_id = ?",
    ).pluck().get(result.exchangeId) as string;
    const harness = loadAgentStepHarness(fixture.db, stepId);
    assert.ok(harness);
    assert.equal(harness.snapshot?.agentVersion, "0.165.0");
  });

});
