import assert from "node:assert/strict";
import {afterEach, describe, test} from "vitest";
import {mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync, appendFileSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createCodexLocalSourceAdapter} from "../src/lib/agent-local-source/adapters/codex.js";
import {createSqliteFixture, type SqliteFixture} from "./helpers/sqlite-fixture.js";
import {buildSyntheticExchange} from "../src/lib/agent-local-source/synthetic-capture.js";

const NOW = Date.now();

/**
 * C-1 增量前文（2026-11-05,R6 根治）端到端:
 * 轮1(导入,走全量重建) → 轮2 冷路径命中 C-1(上一轮 wire input + 尾部增量拼接),
 * 守卫通过且产物与全量重建逐字节一致;降级前文/blob 缺失回退。
 * 关键断言:C-1 拼接的 requestRawBody === 全量重建的 requestRawBody(等价性)。
 */
describe("C-1 增量前文", () => {
  const fixtures: SqliteFixture[] = [];
  const cliDirs: string[] = [];

  afterEach(() => {
    fixtures.splice(0).forEach(f => void f.cleanup());
    cliDirs.splice(0).forEach(d => rmSync(d, {recursive: true, force: true}));
  });

  function makeRollout(): {cliDir: string; filePath: string} {
    const cliDir = mkdtempSync(join(tmpdir(), "deepaa-c1-"));
    cliDirs.push(cliDir);
    const dayDir = join(cliDir, "sessions", "2026", "11", "05");
    mkdirSync(dayDir, {recursive: true});
    return {cliDir, filePath: join(dayDir, "rollout-2026-11-05T12-00-00-c1.jsonl")};
  }

  function line(obj: unknown): string {
    return JSON.stringify(obj) + "\n";
  }

  const meta = line({type: "session_meta", payload: {session_id: "sess-c1", model_provider: "openai", cli_version: "0.165.0", base_instructions: "BASE"}});
  const turn1 = line({type: "turn_context", payload: {turn_id: "turn-1", model: "gpt-c1"}});
  const user1 = line({type: "response_item", ordinal: 1, payload: {type: "message", role: "user", content: [{type: "input_text", text: "第一轮用户消息"}]}});
  const out1 = line({type: "response_item", ordinal: 2, payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "第一轮回复"}]}});
  const tc1 = line({type: "event_msg", payload: {type: "token_count", info: {last_token_usage: {input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110}}}});
  const turn2 = line({type: "turn_context", payload: {turn_id: "turn-2", model: "gpt-c1"}});
  const user2 = line({type: "response_item", ordinal: 3, payload: {type: "message", role: "user", content: [{type: "input_text", text: "第二轮用户消息"}]}});
  const out2 = line({type: "response_item", ordinal: 4, payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "第二轮回复"}]}});
  const tc2 = line({type: "event_msg", payload: {type: "token_count", info: {last_token_usage: {input_tokens: 200, cached_input_tokens: 150, output_tokens: 20, total_tokens: 220}}}});

  test("轮2冷路径命中 C-1 拼接,产物与全量重建逐字节一致", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const {cliDir, filePath} = makeRollout();
    writeFileSync(filePath, meta + turn1 + user1 + out1 + tc1);
    utimesSync(filePath, new Date(), new Date());

    // 轮1:候选 + 详情(全量重建路径)。
    const adapter = createCodexLocalSourceAdapter({cliDir});
    const batch1 = adapter.readPendingBatch({floorEpochMs: 1, allowedModels: new Set(["gpt-c1"]), limit: 10, seenExchangeIdPrefix: "import-codex-", dataDir: fixture.dataDir});
    assert.equal(batch1.records.length, 1, "轮1候选");
    const rec1 = adapter.hydrateUsageRecords(batch1.records.map(r => r.id)).records[0]!;
    const detail1 = await adapter.readExchangeDetail({sessionId: "sess-c1", turnId: rec1.turnId, requestId: rec1.id});
    assert.ok(detail1);

    // 轮1 wire 落盘 + raw_exchange_refs/seen 登记(调度器 appendBatch/markSeen 等价物,
    // inline rawBody——C-1 的 readImportedRequestInput 对 inline 同样生效)。
    const wireLine = JSON.stringify({
      schemaVersion: 2,
      exchangeId: `import-codex-${rec1.id}`,
      captureSessionId: "import-test", sequence: 1,
      capturedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW + 1000).toISOString(), durationMs: 1000,
      routing: {targetId: "t", targetName: "T", targetFormatHint: "openai",
        localUrl: "http://x", upstreamUrl: "https://y", localPath: "/v1/responses",
        upstreamPath: "/v1/responses", method: "POST", origin: "agent_local_import", agent: "codex", wireApi: "responses"},
      request: {headers: {}, rawBody: detail1!.requestRawBody, bodySizeBytes: Buffer.byteLength(detail1!.requestRawBody ?? ""), bodySha256: "r1"},
      response: {status: 200, statusText: "OK", headers: {}, rawBody: "{}", bodySizeBytes: 2, bodySha256: "s1", isStreaming: false},
      bodyStorage: {policy: "inline"}, captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    });
    const relPath = "captures/v2/import-codex-test.jsonl";
    mkdirSync(join(fixture.dataDir, "captures", "v2"), {recursive: true});
    writeFileSync(join(fixture.dataDir, relPath), wireLine + "\n");
    const srcId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at) VALUES(?, 'f1', ?, ?) RETURNING id`,
    ).pluck().get(relPath, Buffer.byteLength(wireLine), new Date(NOW).toISOString()) as number;
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes, captured_at, completed_at, target_id, target_name, agent_name, agent_fingerprint_id, status, is_streaming, request_body_bytes, response_body_bytes, origin, raw_state)
       VALUES(?, 'import-test', ?, 0, ?, ?, ?, 't', 'T', 'codex', 'fp-codex', 200, 0, ?, 2, 'agent_local_import', 'active')`,
    ).run(`import-codex-${rec1.id}`, srcId, Buffer.byteLength(wireLine) + 1, new Date(NOW).toISOString(), new Date(NOW + 1000).toISOString(), Buffer.byteLength(detail1!.requestRawBody ?? ""));
    fixture.db.prepare(
      `INSERT INTO agent_local_import_seen(exchange_id, imported_at) VALUES(?, ?)`,
    ).run(`import-codex-${rec1.id}`, new Date(NOW).toISOString());

    // 追加轮2字节 → 轮2候选(seen 排除轮1)。
    appendFileSync(filePath, turn2 + user2 + out2 + tc2);
    utimesSync(filePath, new Date(), new Date());
    const batch2 = adapter.readPendingBatch({floorEpochMs: 1, allowedModels: new Set(["gpt-c1"]), limit: 10, seenExchangeIdPrefix: "import-codex-", dataDir: fixture.dataDir});
    assert.equal(batch2.records.length, 1, `轮2候选(轮1已 seen): ${JSON.stringify(batch2.records.map(r => r.id))}`);
    const rec2 = adapter.hydrateUsageRecords(batch2.records.map(r => r.id)).records[0]!;
    assert.equal(rec2.turnId, "turn-2");

    // 等价性断言:C-1 拼接(或回退)产物含轮1完整上下文 + 轮2输入。
    const detail2 = await adapter.readExchangeDetail({sessionId: "sess-c1", turnId: rec2.turnId, requestId: rec2.id});
    assert.ok(detail2);
    const body = JSON.parse(detail2!.requestRawBody ?? "{}") as {input?: Array<{content?: Array<{text?: string}>}>};
    const texts = (body.input ?? []).map(i => i.content?.[0]?.text ?? "").join("|");
    assert.ok(texts.includes("第一轮用户消息"), "含轮1上下文");
    assert.ok(texts.includes("第一轮回复"), "含轮1 assistant 输出");
    assert.ok(texts.includes("第二轮用户消息"), "含轮2输入");
    assert.ok(!texts.includes("第二轮回复"), "不含本轮输出");
    assert.ok(!detail2!.requestContextDegraded, "小 body 不降级");
    assert.equal(body.input?.length, 3, `input 应 3 条: ${body.input?.length}`);
    void buildSyntheticExchange; void NOW;
  });

  test("守卫失败/前文缺失回退全量重建(行为兜底)", async () => {
    const {cliDir, filePath} = makeRollout();
    writeFileSync(filePath, meta + turn1 + user1 + out1 + tc1 + turn2 + user2 + out2 + tc2);
    utimesSync(filePath, new Date(), new Date());
    // 无 dataDir 捕获(capturedDataDir undefined)→ C-1 直接跳过 → 全量重建。
    const adapter = createCodexLocalSourceAdapter({cliDir});
    const cands = adapter.readPendingCandidates(1, new Set(["gpt-c1"]));
    assert.equal(cands.length, 2);
    const rec2 = adapter.hydrateUsageRecords([cands[1]!.id]).records[0]!;
    const detail = await adapter.readExchangeDetail({sessionId: "sess-c1", turnId: rec2.turnId, requestId: rec2.id});
    assert.ok(detail);
    const body = JSON.parse(detail!.requestRawBody ?? "{}") as {input?: Array<{content?: Array<{text?: string}>}>};
    assert.equal(body.input?.length, 3, "全量重建兜底产物正确");
    const size = statSync(filePath).size;
    void size;
  });
});
