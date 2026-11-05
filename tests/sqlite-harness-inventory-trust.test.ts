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
  test("P2/F6（2026-11-04）：A→A→B→A 连续片段——序号稳定、包络不跨 B、回切展示变化", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/trust.jsonl");
    const toolsA = [{type: "function", name: "alpha", parameters: {type: "object"}}];
    const toolsB = [{type: "function", name: "beta", parameters: {type: "object"}}];
    const steps: string[] = [];
    let offset = 0;
    for (const [seq, tools] of [[1, toolsA], [2, toolsA], [3, toolsB], [4, toolsA]] as Array<[number, unknown[]]>) {
      const {stepId} = await processExchange(fixture, source, makeExchange({
        sequence: seq,
        threadId: "thread-f6",
        declaredTools: tools as Array<{type: string; name: string; parameters: unknown}>,
      }), offset);
      steps.push(stepId);
      offset += 100;
    }

    const [s1, s2, s3, s4] = steps.map(id => {
      const harness = loadAgentStepHarness(fixture.db, id);
      assert.ok(harness);
      return harness;
    });

    // ① 序号稳定:清单未变的第二步 A 仍是「第 1 个」快照(旧实现显示 2)。
    assert.equal(s2.snapshot?.seqInThread, 1, `s2 seq=${s2.snapshot?.seqInThread}`);
    assert.equal(s1.snapshot?.seqInThread, 1);
    // ② 片段不跨 B:s1/s2 的 A 片段 = 1–2,s3 的 B 片段 = 3–3,s4 的 A 第二段 = 4–4。
    assert.deepEqual(s1.snapshot?.coverage, {fromStepIndex: 1, toStepIndex: 2});
    assert.deepEqual(s2.snapshot?.coverage, {fromStepIndex: 1, toStepIndex: 2});
    assert.deepEqual(s3.snapshot?.coverage, {fromStepIndex: 3, toStepIndex: 3});
    assert.deepEqual(s4.snapshot?.coverage, {fromStepIndex: 4, toStepIndex: 4}, `s4 coverage=${JSON.stringify(s4.snapshot?.coverage)}`);
    // 首现口径:同一 A 哈希在 s4 仍显示首现 Step 1。
    assert.equal(s4.snapshot?.firstSeenStepIndex, 1);
    // ③ 回切展示:s4(A)相对紧邻前的 B 显示 B→A 变化(旧实现无变化)。
    assert.ok(s4.changes, "s4 必须展示 B→A 的快照变化");
    assert.deepEqual(s4.changes?.toolsAdded, ["alpha"]);
    assert.deepEqual(s4.changes?.toolsRemoved, ["beta"]);
    // s2 与 s1 同清单:无变化(片段前无不同快照)。
    assert.equal(s2.changes, undefined);
    // s3(B)相对 A:added=beta removed=alpha。
    assert.ok(s3.changes);
    assert.deepEqual(s3.changes?.toolsAdded, ["beta"]);
  });
  test("审计修订 B(P-2)：多 turn thread(step_index 每 turn 重置)按时间序计算片段", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/trust.jsonl");
    const toolsA = [{type: "function", name: "alpha", parameters: {type: "object"}}];
    const toolsB = [{type: "function", name: "beta", parameters: {type: "object"}}];
    // 三 turn:turn1(A×2步) → turn2(B×1步) → turn3(A×1步);step_index 各 turn 从 1 重置。
    // makeExchange 的 metadata turn_id 固定——手工覆盖 x-codex-turn-metadata 的 turn。
    const steps: Array<{id: string; seq: number}> = [];
    let offset = 0;
    const plan: Array<[number, unknown[], string]> = [
      [1, toolsA, "turn-1"], [2, toolsA, "turn-1"],
      [3, toolsB, "turn-2"],
      [4, toolsA, "turn-3"],
    ];
    for (const [seq, tools, turnId] of plan) {
      const exchange = makeExchange({sequence: seq, threadId: "thread-multi-turn", declaredTools: tools as Array<{type: string; name: string}>});
      // 覆盖 turn 元数据使每 turn 的 step_index 重置(模拟真实形态)。
      const raw = JSON.parse(exchange.request.rawBody as string);
      void raw;
      const headers = exchange.request.headers as Record<string, string>;
      const meta = JSON.parse(headers["x-codex-turn-metadata"]);
      meta.turn_id = turnId;
      headers["x-codex-turn-metadata"] = JSON.stringify(meta);
      const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
      const result = await processor.processExchangeRecord({...source, sourceRelativePath: "captures/v2/trust.jsonl", byteOffset: offset, lineLengthBytes: 100, exchange});
      offset += 100;
      const id = fixture.db.prepare("SELECT id FROM agent_steps WHERE exchange_id = ?").pluck().get(result.exchangeId) as string;
      steps.push({id, seq});
    }
    // 时间序断言:最后一个 A(turn-3 的 seq4)片段=自身、序号=2、相对 B 有变化。
    const s4 = loadAgentStepHarness(fixture.db, steps[3]!.id);
    assert.ok(s4);
    assert.equal(s4.snapshot?.seqInThread, 2, `多turn时间序 seq=${s4.snapshot?.seqInThread}`);
    assert.deepEqual(s4.snapshot?.coverage, {fromStepIndex: 1, toStepIndex: 1}, "turn-3 的 A 是独立片段");
    assert.ok(s4.changes, "turn-3 的 A 必须相对紧邻前的 B 展示变化");
    assert.deepEqual(s4.changes?.toolsAdded, ["alpha"]);
    // turn-1 的 A(前两步):片段含同 turn 两步、无变化、序号 1。
    const s1 = loadAgentStepHarness(fixture.db, steps[0]!.id);
    assert.ok(s1);
    assert.equal(s1.snapshot?.seqInThread, 1);
    assert.equal(s1.changes, undefined);
  });
});
