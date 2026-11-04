import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import { createExchangeProcessor } from "../src/lib/ingestion/exchange-processor.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";
import {
  loadStepCapabilityItems,
  loadStepCapabilitySummary,
  summarizeHarness,
} from "../src/lib/db/step-capability-queries.js";
import { loadAgentStepHarness } from "../src/lib/db/harness-queries.js";

const BASE_TIME = "2026-11-03T12:00:00.000Z";

/**
 * P1-2（2026-11-03）：Step 能力契约回归——summary 口径（declared/observed 分离、
 * 借补参考、调用受限未知）与 items keyset 分页（分页不改变 candidateCount）。
 * 全部使用隔离临时数据目录（AGENTS.md 验证红线）。
 */
describe("SQLite Step 能力契约（P1-2）", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  function seedSource(fixture: SqliteFixture): {sourceId: number} {
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/p12.jsonl', 'f', 4096, ?) RETURNING id`,
    ).pluck().get(BASE_TIME) as number;
    return {sourceId};
  }

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
      session_id: "session-p12",
      thread_id: options.threadId,
      turn_id: "turn-p12",
      request_kind: "turn",
      workspaces: { "/tmp/deepaa-p12": {} },
    };
    return {
      schemaVersion: 2,
      exchangeId: `capture-p12:ex-${options.sequence}`,
      captureSessionId: "capture-p12",
      sequence: options.sequence,
      capturedAt,
      completedAt: new Date(Date.parse(capturedAt) + 25).toISOString(),
      durationMs: 25,
      routing: {
        targetId: "target-p12",
        targetName: "P12 Target",
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
          session_id: "session-p12",
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

  async function processOne(
    fixture: SqliteFixture,
    source: {sourceId: number},
    exchange: RawCapturedExchangeV2,
  ): Promise<string> {
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    const result = await processor.processExchangeRecord({
      ...source,
      sourceRelativePath: "captures/v2/p12.jsonl",
      byteOffset: 0,
      lineLengthBytes: 100,
      exchange,
    });
    assert.ok(result.exchangeId);
    const stepId = fixture.db.prepare(
      "SELECT id FROM agent_steps WHERE exchange_id = ?",
    ).pluck().get(result.exchangeId) as string;
    assert.ok(stepId);
    return stepId;
  }

  test("summary：声明/调用/未调用/未匹配四口径不混算，版本透出", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedSource(fixture);
    const stepId = await processOne(fixture, source, makeExchange({
      sequence: 1,
      threadId: "thread-p12-a",
      tools: [
        { type: "function", name: "alpha", parameters: { type: "object" } },
        { type: "function", name: "beta", parameters: { type: "object" } },
        { type: "function", name: "mcp__docs__search", parameters: { type: "object" } },
      ],
      calls: [{ name: "alpha" }, { name: "alpha" }, { name: "gamma" }],
    }));

    const summary = loadStepCapabilitySummary(fixture.db, stepId);
    assert.ok(summary);
    assert.equal(summary.declaredToolCount, 3);
    assert.equal(summary.invokedToolKinds, 2, "alpha(声明匹配) + gamma(未匹配)");
    assert.equal(summary.invokedToolCalls, 3);
    assert.equal(summary.notInvokedDeclaredCount, 2, "beta 与 mcp__docs__search 未调用");
    assert.equal(summary.observedOnlyCount, 1, "gamma 仅调用证据");
    assert.equal(summary.mcpServerCount, 1);
    assert.equal(summary.skillsParseStatus, "parsed");
    assert.equal(summary.agentName, "codex");
    assert.equal(summary.agentVersion, "0.165.0");
    assert.equal(summary.reference, undefined);
    assert.equal(summary.inputComplete, true);
  });

  test("items：tools 分类 keyset 分页,分页不改变 candidateCount", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedSource(fixture);
    const toolNames = Array.from({ length: 7 }, (_, index) => `tool-${index}`);
    const stepId = await processOne(fixture, source, makeExchange({
      sequence: 1,
      threadId: "thread-p12-b",
      tools: toolNames.map(name => ({ type: "function", name, parameters: { type: "object" } })),
    }));

    const page1 = loadStepCapabilityItems(fixture.db, stepId, {kind: "tools", limit: 3});
    assert.ok(page1);
    assert.equal(page1.candidateCount, 7);
    assert.equal(page1.items.length, 3);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor);

    const page2 = loadStepCapabilityItems(fixture.db, stepId, {kind: "tools", limit: 3, cursor: page1.nextCursor});
    assert.ok(page2);
    assert.equal(page2.candidateCount, 7, "分页不改变总数");
    assert.equal(page2.items.length, 3);
    assert.ok(page2.hasMore);

    const page3 = loadStepCapabilityItems(fixture.db, stepId, {kind: "tools", limit: 3, cursor: page2.nextCursor});
    assert.ok(page3);
    assert.equal(page3.items.length, 1);
    assert.equal(page3.hasMore, false);

    // 页间不重叠且并集为全集。
    const names = [...page1.items, ...page2.items, ...page3.items].map(item => item.name);
    assert.equal(new Set(names).size, 7);
    assert.deepEqual([...names].sort(), [...toolNames].sort());

    const observed = loadStepCapabilityItems(fixture.db, stepId, {kind: "observed", limit: 50});
    assert.ok(observed);
    assert.equal(observed.candidateCount, 0);
    assert.equal(observed.items.length, 0);
    assert.equal(observed.hasMore, false);
  });

  test("summarizeHarness：与 loadAgentStepHarness 同源不产第二套数字", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedSource(fixture);
    const stepId = await processOne(fixture, source, makeExchange({
      sequence: 1,
      threadId: "thread-p12-c",
      tools: [{ type: "function", name: "solo", parameters: { type: "object" } }],
      calls: [{ name: "solo" }],
    }));
    const harness = loadAgentStepHarness(fixture.db, stepId);
    assert.ok(harness);
    const summary = summarizeHarness(harness);
    assert.equal(summary.declaredToolCount, harness.inventory.tools.length);
    assert.equal(summary.observedOnlyCount, (harness.inventory.observedOnlyTools ?? []).length);
    assert.equal(summary.notInvokedDeclaredCount + summary.invokedToolKinds - summary.observedOnlyCount, summary.declaredToolCount);
  });

  test("审计修订（2026-11-04）：无快照 step 的调用证据仍以 observed_only 透出 + turnInvokedCalls/legacyData", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedSource(fixture);
    const stepId = await processOne(fixture, source, makeExchange({
      sequence: 1,
      threadId: "thread-p12-d",
      tools: [{ type: "function", name: "declared-a", parameters: { type: "object" } }],
      calls: [{ name: "declared-a" }, { name: "orphan-b" }],
    }));
    // summary 正常态:turn 累计 = 本步(单步 turn)
    const normal = loadStepCapabilitySummary(fixture.db, stepId);
    assert.ok(normal);
    assert.equal(normal.turnInvokedCalls, normal.invokedToolCalls, "单步 Turn 内累计=本步");
    assert.equal(normal.invokedToolCalls, 2);
    assert.equal(normal.observedOnlyCount, 1);
    assert.equal(normal.legacyData, undefined);

    // 模拟 legacy:去掉快照引用 → 调用证据仍以 observed_only 透出,不再随快照消失。
    fixture.db.prepare("UPDATE agent_steps SET harness_snapshot_hash = NULL WHERE id = ?").run(stepId);
    const legacyHarness = loadAgentStepHarness(fixture.db, stepId);
    assert.ok(legacyHarness);
    assert.equal(legacyHarness.snapshot, undefined);
    assert.ok(legacyHarness.inventory.observedOnlyTools, "无快照时调用证据必须仍透出");
    const names = legacyHarness.inventory.observedOnlyTools.map(tool => tool.name).sort();
    assert.deepEqual(names, ["declared-a", "orphan-b"], "无快照时全部调用均为 observed_only");
    const legacySummary = loadStepCapabilitySummary(fixture.db, stepId);
    assert.ok(legacySummary);
    assert.equal(legacySummary.declaredToolCount, 0);
    assert.equal(legacySummary.observedOnlyCount, 2);
    assert.equal(legacySummary.invokedToolCalls, 2);
    assert.equal(legacySummary.turnInvokedCalls, 2);
    assert.equal(legacySummary.noSnapshot, true, "无快照披露字段必须透出");
    assert.equal(legacySummary.legacyData, undefined, "legacyData 专指 Tier A 回填口径,本场景不适用");
  });
});
