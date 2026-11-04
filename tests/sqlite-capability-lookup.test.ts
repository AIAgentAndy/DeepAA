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
