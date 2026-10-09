/**
 * Step 证据层 P1 补强的派生级测试（2026-09-11）：
 * - agent_steps.stop_reason 落库（schema v28）；
 * - 压缩证据分流：续接摘要注入置 context_compressed=1，
 *   remote_state_reference（previous_response_id 正常续写）不再计为压缩；
 * - context_snapshots.summary_json 携带 paramsDetail / compaction / 系统块 textPreview；
 * - step_diffs.diff_json 携带 contextView 行级视图与 changedParamDetails 值级变化。
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createHash } from "node:crypto";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { createExchangeProcessor } from "../src/lib/ingestion/exchange-processor.js";
import { resolveDerivedArtifactJson } from "../src/lib/ingestion/derived-artifact-store.js";
import { normalizeStoredContextSnapshot } from "../src/lib/ingestion/harness-payload-compact.js";
import { createSqliteFixture, type SqliteFixture } from "./helpers/sqlite-fixture.js";

/** 派生物读取 helper：兼容 inline/external 双策略（P1-6）。 */
function storedArtifactTextP1(
  db: DeepaaDatabase,
  dataDir: string,
  table: "context_snapshots" | "step_diffs",
  stepId: string,
): string {
  const column = table === "context_snapshots" ? "summary_json" : "diff_json";
  const row = db.prepare(
    `SELECT ${column} AS json, artifact_storage, artifact_hash
     FROM ${table} WHERE agent_step_id = ?`,
  ).get(stepId) as {
    json: string;
    artifact_storage: string | null;
    artifact_hash: string | null;
  };
  const text = resolveDerivedArtifactJson(dataDir, {
    artifact_storage: row.artifact_storage,
    artifact_hash: row.artifact_hash,
    inline_json: row.json,
  });
  assert.ok(text, `${table} 派生物应可解析`);
  return text;
}

interface ProcessInputSource {
  sourceId: number;
  sourceRelativePath: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CLAUDE_CONTINUATION = "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below.";

function anthropicStreamingExchange(options: {
  exchangeId: string;
  sequence: number;
  userText: string;
  thinkingBudget: number;
  effort: string;
  sseText?: string;
}) {
  const requestBody = JSON.stringify({
    model: "glm-5.3",
    max_tokens: 128000,
    stream: true,
    thinking: {type: "enabled", budget_tokens: options.thinkingBudget},
    output_config: {effort: options.effort},
    system: [{type: "text", text: "You are ZCode, an interactive coding agent"}],
    tools: [{name: "Bash", description: "run", input_schema: {type: "object"}}],
    messages: [{role: "user", content: [{type: "text", text: options.userText}]}],
  });
  const sse = options.sseText ?? [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"glm-5.3","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":50}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n") + "\n\n";
  return {
    schemaVersion: 2 as const,
    exchangeId: options.exchangeId,
    captureSessionId: "capture-step-evidence-p1",
    sequence: options.sequence,
    capturedAt: `2026-09-11T06:0${options.sequence}:00.000Z`,
    completedAt: `2026-09-11T06:0${options.sequence}:01.000Z`,
    durationMs: 1000,
    routing: {
      targetId: "target-1",
      targetName: "Target",
      targetFormatHint: "anthropic" as const,
      localUrl: "http://127.0.0.1:3211/zcode/v1/messages",
      upstreamUrl: "https://example.test/v1/messages",
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      method: "POST",
      agent: "zcode",
      wireApi: "messages",
    },
    request: {
      headers: {"user-agent": "ZCode/3.11.2", "x-session-id": "sess-step-evidence"},
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: sha256(requestBody),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {"content-type": "text/event-stream"},
      rawBody: sse,
      bodySizeBytes: Buffer.byteLength(sse),
      bodySha256: sha256(sse),
      isStreaming: true,
    },
    bodyStorage: {policy: "inline" as const, compression: "gzip" as const, externalBlobDir: "blobs", thresholdBytes: 65536},
    captureDiagnostics: [],
    security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
  };
}

interface StepStopRow {
  stop_reason: string | null;
  response_action: string;
}

function readStepStopRow(db: DeepaaDatabase, stepId: string): StepStopRow {
  return db.prepare("SELECT stop_reason, response_action FROM agent_steps WHERE id = ?")
    .get(stepId) as StepStopRow;
}

describe("存储预算守卫（2026-09-11 存储瘦身）", () => {
  const fixtures: SqliteFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  test("单步 artifact 体积有界、指纹为 BLOB(32)、快照不重复落库哈希、diff 不落 contextView", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('capture-budget.jsonl', 'fid-budget', 8388608, ?)`,
    ).run(new Date().toISOString());
    // 构造重负载请求：大量历史条目 + 长文本，逼出旧实现的体积膨胀。
    const history = Array.from({ length: 220 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{type: "text", text: `历史消息 ${index} ${"正文填充".repeat(200)}`}],
    }));
    const requestBody = JSON.stringify({
      model: "glm-5.3",
      max_tokens: 128000,
      stream: true,
      thinking: {type: "enabled", budget_tokens: 16000},
      system: [{type: "text", text: "You are ZCode".repeat(50)}],
      tools: Array.from({length: 54}, (_, index) => ({
        name: `tool_${index}`,
        description: `工具 ${index} 描述`,
        input_schema: {type: "object", properties: {}},
      })),
      messages: [
        ...history,
        {role: "user", content: [{type: "text", text: "这是用户真实输入"}]},
      ],
    });
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"glm-5.3","content":[],"usage":{"input_tokens":90000,"output_tokens":1}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"tool_0","input":{}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";

    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const result = await processor.processExchangeRecord({
      sourceId: 1,
      sourceRelativePath: "capture-budget.jsonl",
      byteOffset: 0,
      lineLengthBytes: Buffer.byteLength(requestBody) + 1,
      exchange: {
        schemaVersion: 2 as const,
        exchangeId: "capture-budget:ex-1",
        captureSessionId: "capture-budget",
        sequence: 1,
        capturedAt: "2026-09-11T06:30:00.000Z",
        completedAt: "2026-09-11T06:30:01.000Z",
        durationMs: 1000,
        routing: {
          targetId: "target-1",
          targetName: "Target",
          targetFormatHint: "anthropic" as const,
          localUrl: "http://127.0.0.1:3211/zcode/v1/messages",
          upstreamUrl: "https://example.test/v1/messages",
          localPath: "/v1/messages",
          upstreamPath: "/v1/messages",
          method: "POST",
          agent: "zcode",
          wireApi: "messages",
        },
        request: {
          headers: {"user-agent": "ZCode/3.11.2", "x-session-id": "sess-budget"},
          rawBody: requestBody,
          bodySizeBytes: Buffer.byteLength(requestBody),
          bodySha256: sha256(requestBody),
        },
        response: {
          status: 200,
          statusText: "OK",
          headers: {"content-type": "text/event-stream"},
          rawBody: sse,
          bodySizeBytes: Buffer.byteLength(sse),
          bodySha256: sha256(sse),
          isStreaming: true,
        },
        bodyStorage: {policy: "inline" as const, compression: "gzip" as const, externalBlobDir: "blobs", thresholdBytes: 65536},
        captureDiagnostics: [],
        security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
      },
    });
    assert.ok(result.stepId);

    const sizes = fixture.db.prepare(
      `SELECT
        (SELECT size_bytes FROM exchange_content_previews WHERE exchange_id = ?) pv,
        (SELECT size_bytes FROM context_snapshots WHERE agent_step_id = ?) sn,
        (SELECT size_bytes FROM step_diffs WHERE agent_step_id = ?) df`,
    ).get(result.exchangeId, result.stepId, result.stepId) as {pv: number; sn: number; df: number};
    // 上限守卫：旧口径实测 218KB / 141KB / 67KB（每步合计约 500KB）。
    assert.ok(sizes.pv <= 48 * 1024, `preview ${sizes.pv} 超 48KiB`);
    assert.ok(sizes.sn <= 64 * 1024, `snapshot ${sizes.sn} 超 64KiB`);
    assert.ok(sizes.df <= 32 * 1024, `diff ${sizes.df} 超 32KiB`);

    // 指纹列为 32 字节 BLOB
    const fingerprint = fixture.db.prepare(
      "SELECT fingerprint, length(fingerprint) AS len FROM exchange_request_fingerprints LIMIT 1",
    ).get() as {fingerprint: Buffer; len: number};
    assert.equal(fingerprint.len, 32);
    assert.ok(Buffer.isBuffer(fingerprint.fingerprint));

    // 快照不再重复落库条目哈希；diff 不再落 contextView
    const summary = JSON.parse(storedArtifactTextP1(
      fixture.db,
      fixture.dataDir,
      "context_snapshots",
      result.stepId,
    )) as {snapshot: Record<string, unknown>};
    assert.equal(summary.snapshot.conversationItemHashes, undefined);
    assert.equal(summary.snapshot.harnessPayload, undefined);
    assert.ok(summary.snapshot.cx, "紧凑 harnessPayload 存在");
    const diff = JSON.parse(storedArtifactTextP1(
      fixture.db,
      fixture.dataDir,
      "step_diffs",
      result.stepId,
    )) as Record<string, unknown>;
    assert.equal(diff.contextView, undefined);

    // 读取侧展开后仍需保持完整语义（条目、工具清单、哈希）
    const expanded = normalizeStoredContextSnapshot(summary.snapshot) as {
      conversationItemHashes: string[];
      harnessPayload: {conversationItems: unknown[]; toolSchemas: unknown[]; systemPrompts: Array<{textPreview?: string}>};
    };
    assert.ok(expanded.harnessPayload.conversationItems.length > 0);
    assert.equal(expanded.harnessPayload.toolSchemas.length, 54);
    assert.equal(
      expanded.conversationItemHashes.length,
      expanded.harnessPayload.conversationItems.length,
    );
  });
});

describe("Step 证据层 P1 补强（stop_reason / 压缩分流 / paramsDetail / contextView）", () => {
  const fixtures: SqliteFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  async function processTwoSteps(): Promise<{db: DeepaaDatabase; stepIds: string[]}> {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('capture-step-evidence.jsonl', 'fid-p1', 4096, ?)`,
    ).run(new Date().toISOString());
    const source: ProcessInputSource = {sourceId: 1, sourceRelativePath: "capture-step-evidence.jsonl"};
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const first = await processor.processExchangeRecord({
      ...source,
      byteOffset: 0,
      lineLengthBytes: 100,
      exchange: anthropicStreamingExchange({
        exchangeId: "capture-step-evidence-p1:ex-1",
        sequence: 1,
        userText: "这是啥项目",
        thinkingBudget: 16000,
        effort: "high",
      }),
    });
    const second = await processor.processExchangeRecord({
      ...source,
      byteOffset: 100,
      lineLengthBytes: 100,
      exchange: anthropicStreamingExchange({
        exchangeId: "capture-step-evidence-p1:ex-2",
        sequence: 2,
        userText: CLAUDE_CONTINUATION,
        thinkingBudget: 32000,
        effort: "max",
      }),
    });
    assert.ok(first.stepId, "first step id");
    assert.ok(second.stepId, "second step id");
    return {db: fixture.db, stepIds: [first.stepId!, second.stepId!]};
  }

  test("stop_reason 落库（v28 列）且来自 SSE message_delta", async () => {
    const {db, stepIds} = await processTwoSteps();
    const rows = stepIds.map(id => readStepStopRow(db, id));
    assert.equal(rows[0].stop_reason, "tool_use");
    assert.equal(rows[0].response_action, "tool_use");
    assert.equal(rows[1].stop_reason, "tool_use");
  });

  test("续接摘要注入：context_compressed=1 且 diff 记录 compaction_summary_injected", async () => {
    const {db, stepIds} = await processTwoSteps();
    const step = db.prepare("SELECT context_compressed FROM agent_steps WHERE id = ?").get(stepIds[1]) as {
      context_compressed: number;
    };
    assert.equal(step.context_compressed, 1);
    const diffJson = db.prepare("SELECT diff_json FROM step_diffs WHERE agent_step_id = ?").pluck().get(stepIds[1]) as string;
    const diff = JSON.parse(diffJson) as {contextTrimming?: Array<{kind: string}>, value?: {contextTrimming?: Array<{kind: string}>}};
    const trimming = diff.contextTrimming ?? diff.value?.contextTrimming ?? [];
    assert.ok(trimming.some(item => item.kind === "compaction_summary_injected"), "摘要注入证据存在");
  });

  test("snapshot 携带 paramsDetail（thinking 预算/effort）与系统块 textPreview", async () => {
    const {db, stepIds} = await processTwoSteps();
    const summaryJson = db.prepare("SELECT summary_json FROM context_snapshots WHERE agent_step_id = ?").pluck().get(stepIds[0]) as string;
    const envelope = JSON.parse(summaryJson) as {snapshot?: Record<string, unknown>};
    // 存储侧 harnessPayload 为紧凑形态，统一经读侧入口展开后再断言。
    const summary = normalizeStoredContextSnapshot(envelope.snapshot ?? {}) as {
      paramsDetail?: Record<string, unknown>;
      compaction?: unknown;
      harnessPayload?: {systemPrompts?: Array<{textPreview?: string}>};
    };
    assert.equal(summary.paramsDetail?.max_tokens, 128000);
    assert.deepEqual(summary.paramsDetail?.thinking, {type: "enabled", budget_tokens: 16000});
    assert.deepEqual(summary.paramsDetail?.output_config, {effort: "high"});
    assert.ok(summary.harnessPayload?.systemPrompts?.[0]?.textPreview?.includes("You are ZCode"));
    assert.equal(summary.compaction, undefined, "普通步骤无压缩证据");
  });

  test("diff 携带 contextView 行级视图与 changedParamDetails 值级变化", async () => {
    const {db, stepIds} = await processTwoSteps();
    const realDiffJson = db.prepare("SELECT diff_json FROM step_diffs WHERE agent_step_id = ?").pluck().get(stepIds[1]) as string;
    const diff = JSON.parse(realDiffJson) as {
      contextView?: unknown;
      changedParamDetails?: Array<{key: string; from: string; to: string}>;
    };
    // 行级视图改为 API 按需计算（存储瘦身）：step_diffs 不再落库 contextView。
    assert.equal(diff.contextView, undefined, "contextView 不再写库");
    const paramChanges = diff.changedParamDetails ?? [];
    const thinkingChange = paramChanges.find(change => change.key === "thinking");
    assert.ok(thinkingChange, "thinking 值级变化存在");
    assert.match(thinkingChange!.to, /32000/);
    assert.notEqual(thinkingChange!.from, thinkingChange!.to, "from/to 必须是不同值");
    const effortChange = paramChanges.find(change => change.key === "output_config");
    assert.ok(effortChange && effortChange.to.includes("max"), "output_config effort 记录到 max");
  });

  test("remote_state_reference 不再触发 context_compressed（codex 过报修复）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('capture-remote-ref.jsonl', 'fid-rr', 4096, ?)`,
    ).run(new Date().toISOString());
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const makeResponsesExchange = (exchangeId: string, sequence: number, previousResponseId?: string) => {
      const requestBody = JSON.stringify({
        model: "gpt-5.6-x",
        stream: true,
        instructions: "You are Codex",
        ...(previousResponseId ? {previous_response_id: previousResponseId} : {}),
        input: [{type: "message", role: "user", content: [{type: "input_text", text: "hello"}]}],
      });
      const sse = [
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"function_call","call_id":"c1","name":"shell","arguments":"{}"}],"usage":{"input_tokens":50,"output_tokens":5,"input_tokens_details":{"cached_tokens":10}}}}',
      ].join("\n\n") + "\n\n";
      return {
        schemaVersion: 2 as const,
        exchangeId,
        captureSessionId: "capture-remote-ref",
        sequence,
        capturedAt: `2026-09-11T06:1${sequence}:00.000Z`,
        completedAt: `2026-09-11T06:1${sequence}:01.000Z`,
        durationMs: 1000,
        routing: {
          targetId: "target-1",
          targetName: "Target",
          targetFormatHint: "openai" as const,
          localUrl: "http://127.0.0.1:3211/codex/v1/responses",
          upstreamUrl: "https://example.test/v1/responses",
          localPath: "/v1/responses",
          upstreamPath: "/v1/responses",
          method: "POST",
          agent: "codex",
          wireApi: "responses",
        },
        request: {
          headers: {"user-agent": "codex_cli_rs/0.153.4", "session_id": "sess-rr", ...(previousResponseId ? {["x-codex-turn-metadata"]: JSON.stringify({session_id: "sess-rr", thread_id: "th-rr"})} : {})},
          rawBody: requestBody,
          bodySizeBytes: Buffer.byteLength(requestBody),
          bodySha256: sha256(requestBody),
        },
        response: {
          status: 200,
          statusText: "OK",
          headers: {"content-type": "text/event-stream"},
          rawBody: sse,
          bodySizeBytes: Buffer.byteLength(sse),
          bodySha256: sha256(sse),
          isStreaming: true,
        },
        bodyStorage: {policy: "inline" as const, compression: "gzip" as const, externalBlobDir: "blobs", thresholdBytes: 65536},
        captureDiagnostics: [],
        security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
      };
    };
    const first = await processor.processExchangeRecord({
      sourceId: 1,
      sourceRelativePath: "capture-remote-ref.jsonl",
      byteOffset: 0,
      lineLengthBytes: 100,
      exchange: makeResponsesExchange("capture-remote-ref:ex-1", 1),
    });
    const second = await processor.processExchangeRecord({
      sourceId: 1,
      sourceRelativePath: "capture-remote-ref.jsonl",
      byteOffset: 100,
      lineLengthBytes: 100,
      exchange: makeResponsesExchange("capture-remote-ref:ex-2", 2, "resp_prev"),
    });
    assert.ok(first.stepId && second.stepId);
    const step = fixture.db.prepare("SELECT context_compressed FROM agent_steps WHERE id = ?").get(second.stepId) as {
      context_compressed: number;
    };
    const diffJson = fixture.db.prepare("SELECT diff_json FROM step_diffs WHERE agent_step_id = ?").pluck().get(second.stepId) as string;
    const diff = JSON.parse(diffJson) as {contextTrimming?: Array<{kind: string}>, value?: {contextTrimming?: Array<{kind: string}>}};
    const trimming = diff.contextTrimming ?? diff.value?.contextTrimming ?? [];
    assert.ok(trimming.some(item => item.kind === "remote_state_reference"), "remote_state_reference 仍作为事实列出");
    assert.equal(step.context_compressed, 0, "正常续写不再标记为压缩");
  });
});
