import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import { createExchangeProcessor } from "../src/lib/ingestion/exchange-processor.js";
import {
  buildHarnessSnapshotIdentity,
  HARNESS_SNAPSHOT_JSON_MAX_BYTES,
  upsertHarnessSnapshotForStep,
} from "../src/lib/ingestion/harness-snapshot-store.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";
import { normalizeExchange } from "../src/lib/harness/normalizer.js";
import { loadAgentStepHarness } from "../src/lib/db/harness-queries.js";
import { runHarnessSnapshotBackfill } from "../src/lib/ingestion/harness-backfill.js";

const BASE_TIME = "2026-09-11T08:00:00.000Z";
const PROJECT_KEY = "/tmp/deepaa-harness-project";

/**
 * Harness 证据层派生测试（v27）：快照去重 / JSON 有界截断 / step 引用回写 /
 * contextComposition 落库 / usage_ledger 不受估算影响。
 * 全部使用隔离临时数据目录（AGENTS.md 验证红线）。
 */
describe("SQLite Harness 快照派生", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  function seedIngestionSource(
    fixture: SqliteFixture,
    relativePath: string,
  ): { sourceId: number; sourceRelativePath: string } {
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(
        relative_path, file_id, file_size, updated_at
      ) VALUES(?, ?, 4096, ?)
      RETURNING id`,
    ).pluck().get(relativePath, `fixture:${relativePath}`, BASE_TIME) as number;
    return { sourceId, sourceRelativePath: relativePath };
  }

  function makeProcessorExchange(options: {
    sequence: number;
    threadId: string;
    tools: unknown[];
    instructions?: string;
    skillsText?: string;
    usage?: Record<string, unknown>;
  }): RawCapturedExchangeV2 {
    const capturedAt = new Date(Date.parse(BASE_TIME) + options.sequence * 1_000).toISOString();
    const requestBody = JSON.stringify({
      model: "fixture-model",
      instructions: options.instructions ?? "You are Codex, an agent based on GPT-5.",
      input: [
        ...(options.skillsText ? [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: options.skillsText }],
        }] : []),
        { type: "message", role: "user", content: [{ type: "input_text", text: `turn ${options.sequence}` }] },
      ],
      tools: options.tools,
    });
    const responseBody = JSON.stringify({
      id: `response-${options.sequence}`,
      object: "response",
      status: "completed",
      model: "fixture-model",
      output: [],
      usage: options.usage ?? {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 4,
        total_tokens: 104,
      },
    });
    const metadata = {
      session_id: "session-harness",
      thread_id: options.threadId,
      turn_id: "turn-harness-1",
      request_kind: "turn",
      workspaces: {
        [PROJECT_KEY]: {
          associated_remote_urls: { origin: "https://example.test/project.git" },
          latest_git_commit_hash: "0".repeat(40),
          has_changes: false,
        },
      },
    };
    return {
      schemaVersion: 2,
      exchangeId: `capture-harness:ex-${options.sequence}`,
      captureSessionId: "capture-harness",
      sequence: options.sequence,
      capturedAt,
      completedAt: new Date(Date.parse(capturedAt) + 25).toISOString(),
      durationMs: 25,
      routing: {
        targetId: "target-harness",
        targetName: "Harness Target",
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
          "user-agent": "codex-tui/fixture",
          session_id: "session-harness",
          thread_id: options.threadId,
          "x-codex-turn-metadata": JSON.stringify(metadata),
        },
        rawBody: requestBody,
        bodySizeBytes: Buffer.byteLength(requestBody),
        bodySha256: `request-${options.sequence}`,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        rawBody: responseBody,
        bodySizeBytes: Buffer.byteLength(responseBody),
        bodySha256: `response-${options.sequence}`,
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

  const DEFAULT_TOOLS = [
    { type: "function", name: "exec_command", description: "Run shell", parameters: { type: "object" } },
    { type: "function", name: "mcp__node_repl__run", description: "Run node", parameters: { type: "object" } },
    { type: "tool_search", execution: "client", description: "Search tools", parameters: { type: "object" } },
  ];

  const SKILLS_TEXT = `<skills_instructions>
### Skill roots
- \`r0\` = /Users/andy/.codex/skills
- \`r6\` = ${PROJECT_KEY}/.agents/skills
### Available skills
- tdd: TDD workflow (file: r0/tdd/SKILL.md)
- frontend-lint: Project lint rules (file: r6/frontend-lint/SKILL.md)
</skills_instructions>`;

  test("同清单 step 去重引用同一快照，不同清单生成新快照", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/harness.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });

    const first = makeProcessorExchange({ sequence: 1, threadId: "thread-harness", tools: DEFAULT_TOOLS, skillsText: SKILLS_TEXT });
    const second = makeProcessorExchange({ sequence: 2, threadId: "thread-harness", tools: DEFAULT_TOOLS, skillsText: SKILLS_TEXT });
    const changed = makeProcessorExchange({
      sequence: 3,
      threadId: "thread-harness",
      tools: [...DEFAULT_TOOLS, { type: "function", name: "mcp__pg__query", description: "Query pg", parameters: { type: "object" } }],
      skillsText: SKILLS_TEXT,
    });

    await processor.processExchangeRecord({ ...source, byteOffset: 0, lineLengthBytes: 100, exchange: first });
    await processor.processExchangeRecord({ ...source, byteOffset: 100, lineLengthBytes: 100, exchange: second });
    await processor.processExchangeRecord({ ...source, byteOffset: 200, lineLengthBytes: 100, exchange: changed });

    const snapshots = fixture.db.prepare(
      `SELECT snapshot_hash, tool_count, mcp_tool_count, mcp_server_count, skill_count,
              step_ref_count, complete, first_seen_at, last_seen_at
       FROM harness_snapshots ORDER BY first_seen_at`,
    ).all() as Array<Record<string, unknown>>;
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].tool_count, 3);
    assert.equal(snapshots[0].mcp_tool_count, 1);
    assert.equal(snapshots[0].mcp_server_count, 1);
    assert.equal(snapshots[0].skill_count, 2);
    assert.equal(snapshots[0].step_ref_count, 2);
    assert.equal(snapshots[0].complete, 1);
    assert.equal(snapshots[1].step_ref_count, 1);
    // last_seen_at 单调：不会回退。
    assert.ok(String(snapshots[0].last_seen_at) >= String(snapshots[0].first_seen_at));

    const steps = fixture.db.prepare(
      `SELECT id, harness_snapshot_hash, project_key FROM agent_steps ORDER BY timestamp`,
    ).all() as Array<{ id: string; harness_snapshot_hash: string; project_key: string }>;
    assert.equal(steps.length, 3);
    assert.equal(steps[0].harness_snapshot_hash, snapshots[0].snapshot_hash);
    assert.equal(steps[1].harness_snapshot_hash, snapshots[0].snapshot_hash);
    assert.equal(steps[2].harness_snapshot_hash, snapshots[1].snapshot_hash);
    assert.equal(steps[0].project_key, PROJECT_KEY);

    // 无名 typed 工具赋伪名 @tool_search，MCP 工具保留 server 维度。
    const tools = JSON.parse(fixture.db.prepare(
      "SELECT tools_json FROM harness_snapshots WHERE snapshot_hash = ?",
    ).pluck().get(snapshots[0].snapshot_hash) as string) as Array<{ name: string; kind: string; mcpServer?: string }>;
    assert.ok(tools.some(tool => tool.name === "@tool_search" && tool.kind === "tool"));
    assert.ok(tools.some(tool => tool.name === "mcp__node_repl__run" && tool.kind === "mcp" && tool.mcpServer === "node_repl"));
  });

  test("contextComposition 落库并按实际 usage 校准", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/harness-composition.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    await processor.processExchangeRecord({
      ...source,
      byteOffset: 0,
      lineLengthBytes: 100,
      exchange: makeProcessorExchange({ sequence: 1, threadId: "thread-composition", tools: DEFAULT_TOOLS, skillsText: SKILLS_TEXT }),
    });

    const stepId = fixture.db.prepare("SELECT id FROM agent_steps").pluck().get() as string;
    const summary = JSON.parse(fixture.db.prepare(
      "SELECT summary_json FROM context_snapshots WHERE agent_step_id = ?",
    ).pluck().get(stepId) as string) as {
      snapshot?: {
        contextComposition?: {
          chars: Record<string, number>;
          estTokens: Record<string, number>;
          calibratedTokens?: Record<string, number>;
          calibration?: { actualInputTokens: number; scale: number };
        };
      };
    };
    const composition = summary.snapshot?.contextComposition;
    assert.ok(composition, "summary_json 应包含 contextComposition");
    assert.ok(composition.chars.mcp > 0);
    assert.ok(composition.chars.skills > 0);
    assert.ok(composition.chars.system > 0);
    // usage：input_tokens 80（不含缓存）+ cache_read 20 = 喂给模型总量 100。
    assert.equal(composition.calibration?.actualInputTokens, 100);
    const calibratedTotal = Object.values(composition.calibratedTokens ?? {}).reduce((sum, value) => sum + value, 0);
    assert.equal(calibratedTotal, 100);
  });

  test("usage_ledger 计价字段不受 harness 估算影响且无新增列", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/harness-ledger.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    await processor.processExchangeRecord({
      ...source,
      byteOffset: 0,
      lineLengthBytes: 100,
      exchange: makeProcessorExchange({ sequence: 1, threadId: "thread-ledger", tools: DEFAULT_TOOLS }),
    });

    const ledger = fixture.db.prepare(
      `SELECT input_tokens, cache_read_tokens, output_tokens, pricing_revision_id
       FROM usage_ledger WHERE exchange_id = ?`,
    ).get("capture-harness:ex-1") as Record<string, unknown>;
    assert.equal(ledger.input_tokens, 80);
    assert.equal(ledger.cache_read_tokens, 20);
    assert.equal(ledger.output_tokens, 4);
    assert.equal(ledger.pricing_revision_id, 1);
    // 账本列集合保持 v26 既有清单，不因 harness 估算引入新列。
    const ledgerColumns = (fixture.db.pragma("table_info(usage_ledger)") as Array<{ name: string }>)
      .map(column => column.name);
    assert.ok(!ledgerColumns.some(name => name.toLowerCase().includes("harness")));
    assert.ok(!ledgerColumns.some(name => name.toLowerCase().includes("composition")));
  });

  test("snapshot identity 工具清单超过 64 KiB 时截断并标记 complete=0", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const bigTools = Array.from({ length: 1200 }, (_, index) => ({
      name: `tool_${index}`,
      kind: "tool" as const,
      schemaChars: 400,
      schemaTokensEst: 100,
    }));
    const identity = {
      ...buildHarnessSnapshotIdentity("codex", normalizeExchange(makeProcessorExchange({
        sequence: 1,
        threadId: "thread-truncate",
        tools: DEFAULT_TOOLS,
      }))),
      tools: bigTools,
      toolCount: bigTools.length,
    };
    upsertHarnessSnapshotForStep(fixture.db, identity, { stepId: "step-fixture", timestamp: BASE_TIME });

    const row = fixture.db.prepare(
      `SELECT tools_json, complete, LENGTH(tools_json) AS size FROM harness_snapshots`,
    ).get() as { tools_json: string; complete: number; size: number };
    assert.equal(row.complete, 0);
    assert.ok(row.size <= HARNESS_SNAPSHOT_JSON_MAX_BYTES);
    const storedTools = JSON.parse(row.tools_json) as unknown[];
    assert.ok(storedTools.length < bigTools.length);
  });
});

describe("SQLite Harness Step 查询（loadAgentStepHarness）", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  function seedIngestionSource(
    fixture: SqliteFixture,
    relativePath: string,
  ): { sourceId: number; sourceRelativePath: string } {
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES(?, ?, 4096, ?) RETURNING id`,
    ).pluck().get(relativePath, `fixture:${relativePath}`, BASE_TIME) as number;
    return { sourceId, sourceRelativePath: relativePath };
  }

  function makeExchange2(options: {
    sequence: number;
    threadId: string;
    tools: unknown[];
    usage?: Record<string, unknown>;
  }): RawCapturedExchangeV2 {
    const capturedAt = new Date(Date.parse(BASE_TIME) + options.sequence * 60_000).toISOString();
    const input: unknown[] = [
      { type: "message", role: "user", content: [{ type: "input_text", text: `turn ${options.sequence}` }] },
    ];
    if (options.sequence === 2) {
      input.push({ type: "function_call", call_id: "call-a", name: "mcp__node_repl__run", arguments: "{}" });
      input.push({ type: "function_call_output", call_id: "call-a", output: "ok" });
    }
    const requestBody = JSON.stringify({
      model: "fixture-model",
      instructions: "You are Codex.",
      input,
      tools: options.tools,
    });
    const responseBody = JSON.stringify({
      id: `response-${options.sequence}`,
      object: "response",
      status: "completed",
      model: "fixture-model",
      output: options.sequence === 2
        ? [{ type: "function_call", call_id: "call-a", name: "mcp__node_repl__run", arguments: "{}" }]
        : [],
      usage: options.usage ?? { input_tokens: 300, output_tokens: 10 },
    });
    const metadata = {
      session_id: "session-harness-q",
      thread_id: options.threadId,
      turn_id: "turn-harness-q",
      request_kind: "turn",
      workspaces: { ["/tmp/deepaa-harness-project"]: {} },
    };
    return {
      schemaVersion: 2,
      exchangeId: `capture-harness-q:ex-${options.sequence}`,
      captureSessionId: "capture-harness-q",
      sequence: options.sequence,
      capturedAt,
      completedAt: new Date(Date.parse(capturedAt) + 25).toISOString(),
      durationMs: 25,
      routing: {
        targetId: "target-harness",
        targetName: "Harness Target",
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
          "user-agent": "codex-tui/fixture",
          session_id: "session-harness-q",
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

  test("快照清单 / 调用计数 / Invoked / 快照序号与变化 / legacyData 标记", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/harness-q.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });

    const toolsA = [
      { type: "function", name: "exec_command", description: "Run", parameters: { type: "object" } },
    ];
    const toolsB = [
      ...toolsA,
      { type: "function", name: "mcp__node_repl__run", description: "Node", parameters: { type: "object" } },
    ];
    await processor.processExchangeRecord({ ...source, byteOffset: 0, lineLengthBytes: 100, exchange: makeExchange2({ sequence: 1, threadId: "thread-q", tools: toolsA }) });
    await processor.processExchangeRecord({ ...source, byteOffset: 100, lineLengthBytes: 100, exchange: makeExchange2({ sequence: 2, threadId: "thread-q", tools: toolsB }) });

    const steps = fixture.db.prepare(
      "SELECT id, step_index FROM agent_steps ORDER BY step_index",
    ).all() as Array<{ id: string; step_index: number }>;
    assert.equal(steps.length, 2);

    const first = loadAgentStepHarness(fixture.db, steps[0].id);
    assert.ok(first);
    assert.equal(first.snapshot?.seqInThread, 1);
    assert.equal(first.snapshot?.complete, true);
    assert.equal(first.project, "deepaa-harness-project");
    assert.equal(first.legacyData, false);
    assert.ok(first.inventory.tools.some(tool => tool.name === "exec_command"));
    assert.ok(first.harnessTokens);
    assert.ok(first.harnessTokens.total > 0);
    assert.ok(first.harnessTokens.calibrated);

    const second = loadAgentStepHarness(fixture.db, steps[1].id);
    assert.ok(second);
    assert.equal(second.snapshot?.seqInThread, 2);
    const mcpTool = second.inventory.tools.find(tool => tool.name === "mcp__node_repl__run");
    assert.ok(mcpTool);
    assert.equal(mcpTool.kind, "mcp");
    assert.equal(mcpTool.mcpServer, "node_repl");
    assert.equal(mcpTool.invoked, true);
    assert.ok(mcpTool.callsThisStep >= 1);
    assert.ok(second.changes);
    assert.deepEqual(second.changes.toolsAdded, ["mcp__node_repl__run"]);
    assert.deepEqual(second.changes.toolsRemoved, []);

    assert.equal(first.candidateCount, 1);
    assert.equal(first.processedCount, 1);
  });

  test("Tier A 回填后的 step 查询返回 legacyData=true 且无构成估算", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    // 造一行"升级前"形态：agent_steps 无 hash，context_snapshots 旧格式。
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/legacy-q.jsonl', 'lq', 4096, ?)`,
    ).run(BASE_TIME);
    fixture.db.prepare(
      `INSERT INTO agent_sessions(id, target_id, target_name, agent_fingerprint_id,
        agent_name, external_session_id, source, confidence, start_time, end_time)
       VALUES('sess-q', 't', 'T', 'fp', 'codex', 'e', 'test', 'exact', ?, ?)`,
    ).run(BASE_TIME, BASE_TIME);
    fixture.db.prepare(
      `INSERT INTO agent_threads(id, agent_session_id, source, display_name, confidence, is_root,
        is_placeholder, start_time, end_time)
       VALUES('thread-q2', 'sess-q', 'test', 'T', 'exact', 1, 1, ?, ?)`,
    ).run(BASE_TIME, BASE_TIME);
    fixture.db.prepare(
      `INSERT INTO agent_turns(id, agent_session_id, agent_thread_id, native_turn_id,
        source, confidence, status, segment_index, start_exchange_id, start_time, end_time)
       VALUES('turn-q2', 'sess-q', 'thread-q2', 'n', 'test', 'exact', 'closed', 1, 'e-q', ?, ?)`,
    ).run(BASE_TIME, BASE_TIME);
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(exchange_id, capture_session_id, source_id, byte_offset,
        line_length_bytes, captured_at, completed_at, target_id, target_name, agent_name,
        agent_fingerprint_id, model, status, is_streaming, request_body_bytes, response_body_bytes)
       VALUES('e-q', 'c', 1, 0, 10, ?, ?, 't', 'T', 'codex', 'fp', 'm', 'completed', 0, 10, 10)`,
    ).run(BASE_TIME, BASE_TIME);
    fixture.db.prepare(
      `INSERT INTO agent_steps(id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
        step_index, timestamp, phase, request_action, response_action)
       VALUES('astep-q', 'e-q', 'sess-q', 'thread-q2', 'turn-q2', 1, ?, 'model', 'new_turn', 'completed')`,
    ).run(BASE_TIME);
    const legacySummary = JSON.stringify({
      snapshot: { harnessPayload: { toolSchemas: [{ name: "old_tool", providerType: "function" }] } },
    });
    fixture.db.prepare(
      "INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes) VALUES('astep-q', ?, ?)",
    ).run(legacySummary, Buffer.byteLength(legacySummary));
    fixture.db.prepare(
      `INSERT INTO usage_ledger(exchange_id, target_id, agent_fingerprint_id, agent_name, model,
        vendor, rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
        vendor_cost, actual_cost, duration_ms, usage_source, usage_confidence, pricing_snapshot_json, created_at)
       VALUES('e-q', 't', 'fp', 'codex', 'm', 'v', 1, 500, 0, 0, 10, 0, 0, 10, 'exact', 'exact', '{}', ?)`,
    ).run(BASE_TIME);

    const before = runHarnessSnapshotBackfill(fixture.db);
    assert.equal(before.processedSteps, 1);

    const harness = loadAgentStepHarness(fixture.db, "astep-q");
    assert.ok(harness);
    assert.equal(harness.legacyData, true);
    assert.equal(harness.snapshot?.complete, true);
    assert.ok(harness.inventory.tools.some(tool => tool.name === "old_tool"));
    assert.equal(harness.harnessTokens, undefined);
    assert.ok(harness.inventory.tools.every(tool => tool.defTokensEst === 0));
  });
});
