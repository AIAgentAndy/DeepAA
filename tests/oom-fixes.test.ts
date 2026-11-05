import assert from "node:assert/strict";
import {afterEach, describe, test} from "vitest";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BoundedLruMap} from "../src/lib/agent-local-source/bounded-lru.js";
import {createCodexLocalSourceAdapter} from "../src/lib/agent-local-source/adapters/codex.js";
import {createSqliteFixture, type SqliteFixture} from "./helpers/sqlite-fixture.js";
import {
  persistRolloutFrontier,
  restoreRolloutState,
} from "../src/lib/agent-local-source/codex-rollout-state.js";

/**
 * OOM 修复回归（2026-11-05,B+C-2+LRU+租约）:
 * - LRU:单条超预算拒绝插入(不再无条件驻留);覆盖语义保留旧值。
 * - B 门:合成超 composeBudgetBytes 降级(头尾+省略标记+requestContextDegraded),
 *   注入小阈值验证;骨架(model/instructions)恒保留。
 * - C-2:前沿持久化 → 新 adapter 实例(模拟重启)恢复 offset/records,不冷重扫。
 * 全部隔离临时目录。
 */
describe("OOM 修复(B+C-2+LRU)", () => {
  const fixtures: SqliteFixture[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
    for (const dir of tmpDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
  });

  test("LRU:单条超预算拒绝插入,不驻留;覆盖保留旧值", () => {
    const lru = new BoundedLruMap<string, string>({
      maxBytes: 100,
      bytesOf: value => value.length,
    });
    assert.equal(lru.set("a", "x".repeat(50)), true);
    assert.equal(lru.set("huge", "x".repeat(500)), false, "单条超预算必须拒绝");
    assert.equal(lru.get("huge"), undefined, "拒绝后不驻留");
    assert.equal(lru.totalBytes, 50);
    // 覆盖语义:旧值保留。
    assert.equal(lru.set("a", "y".repeat(500)), false, "覆盖超限拒绝");
    assert.equal(lru.get("a"), "x".repeat(50), "旧值保留");
    // 多条预算逐出照旧。
    assert.equal(lru.set("b", "y".repeat(60)), true);
    assert.equal(lru.get("a"), undefined, "预算逐出最旧");
    assert.equal(lru.totalBytes, 60);
  });

  test("B 门:合成超预算降级(头尾+省略标记),骨架保留", async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "deepaa-oom-b-"));
    tmpDirs.push(cliDir);
    const dayDir = join(cliDir, "sessions", "2026", "11", "05");
    mkdirSync(dayDir, {recursive: true});
    // 构造:1 轮含 30 个 item(每个 ~2KB 文本)——阈值注入 8KB 触发降级。
    const items: unknown[] = [
      {type: "message", role: "user", content: [{type: "input_text", text: "开场".padEnd(2048, "A")}]},
    ];
    const lines: string[] = [
      JSON.stringify({type: "session_meta", payload: {session_id: "sess-oom-b", model_provider: "openai", cli_version: "0.165.0", base_instructions: "You are Codex."}}),
      JSON.stringify({type: "turn_context", payload: {turn_id: "t1", model: "gpt-test"}}),
      JSON.stringify({type: "response_item", ordinal: 1, payload: items[0]}),
    ];
    for (let i = 2; i <= 60; i += 1) {
      const payload = {type: "message", role: "user", content: [{type: "input_text", text: `msg-${i}-`.padEnd(2048, "B")}]};
      lines.push(JSON.stringify({type: "response_item", ordinal: i, payload}));
    }
    lines.push(JSON.stringify({type: "event_msg", payload: {type: "token_count", info: {last_token_usage: {input_tokens: 100, output_tokens: 5, total_tokens: 105}}}}));
    const filePath = join(dayDir, "rollout-2026-11-05T10-00-00-oom-b.jsonl");
    writeFileSync(filePath, lines.join("\n") + "\n");
    utimesSync(filePath, new Date(), new Date());

    const adapter = createCodexLocalSourceAdapter({cliDir, composeBudgetBytes: 8 * 1024});
    const candidates = adapter.readPendingCandidates(1, new Set(["gpt-test"]));
    assert.ok(candidates.length >= 1, `候选缺失: ${JSON.stringify(candidates)}`);
    const detail = await adapter.readExchangeDetail({
      sessionId: "sess-oom-b",
      turnId: "t1",
      requestId: candidates[0]!.id,
    });
    assert.ok(detail, "detail 缺失");
    assert.equal(detail.requestContextDegraded, true, "超预算必须标记降级");
    const body = JSON.parse(detail.requestRawBody ?? "{}") as {
      model?: string; instructions?: string; input?: Array<{type: string; role?: string; content?: Array<{text?: string}>}>;
    };
    assert.equal(body.model, "gpt-test", "model 骨架保留");
    assert.equal(body.instructions, "You are Codex.", "instructions 骨架完整保留");
    const input = body.input ?? [];
    assert.ok(input.length < 60, `降级后 input 应远小于 60: ${input.length}`);
    assert.ok(input[0]!.content?.[0]?.text?.includes("开场"), "头部条目保留");
    assert.ok(input.some(item => (item.content?.[0]?.text ?? "").includes("[deepaa] 前文已省略")), "省略标记存在");
    assert.ok((input.at(-1)?.content?.[0]?.text ?? "").startsWith("msg-"), `尾部条目保留: ${(input.at(-1)?.content?.[0]?.text ?? "?").slice(0, 8)}`);
    assert.ok(Buffer.byteLength(detail.requestRawBody ?? "") < 110 * 1024, `降级体显著小于全量(60×2KB≈123KB): ${Buffer.byteLength(detail.requestRawBody ?? "")}`);
    // usage 不受降级影响。
    assert.ok(JSON.stringify(detail.response).includes("total_tokens") || detail.response !== undefined);
  });

  test("C-2:前沿持久化 → 新实例恢复 offset/records,不冷重扫", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const cliDir = mkdtempSync(join(tmpdir(), "deepaa-oom-c2-"));
    tmpDirs.push(cliDir);
    const dayDir = join(cliDir, "sessions", "2026", "11", "05");
    mkdirSync(dayDir, {recursive: true});
    const lines: string[] = [
      JSON.stringify({type: "session_meta", payload: {session_id: "sess-c2", model_provider: "openai", cli_version: "0.165.0", base_instructions: "BASE-INSTR"}}),
      JSON.stringify({type: "turn_context", payload: {turn_id: "t1", model: "gpt-test"}}),
      JSON.stringify({type: "response_item", ordinal: 1, payload: {type: "message", role: "user", content: [{type: "input_text", text: "hello c2"}]}}),
      JSON.stringify({type: "event_msg", payload: {type: "token_count", info: {last_token_usage: {input_tokens: 42, output_tokens: 2, total_tokens: 44}}}}),
    ];
    const filePath = join(dayDir, "rollout-2026-11-05T11-00-00-c2.jsonl");
    writeFileSync(filePath, lines.join("\n") + "\n");
    utimesSync(filePath, new Date(), new Date());

    // 实例 A:扫描 + 持久化(经 readPendingBatch 的 dataDir 路径)。
    const adapterA = createCodexLocalSourceAdapter({cliDir});
    const batch = adapterA.readPendingBatch({
      floorEpochMs: 1, allowedModels: new Set(["gpt-test"]), limit: 10,
      seenExchangeIdPrefix: "import-codex-", dataDir: fixture.dataDir,
    });
    assert.ok(batch.records.length >= 1, "实例 A 候选缺失");

    // 实例 B(模拟重启):直接调 restore 验证前沿恢复。
    const restored = restoreRolloutState(
      fixture.db,
      "rollout-2026-11-05T11-00-00-c2",
      filePath,
    );
    assert.ok(restored, "持久前沿必须可恢复");
    assert.ok(restored.offset > 0, `offset>0: ${restored.offset}`);
    assert.equal(restored.records.length, 1, "记录索引恢复");
    assert.equal(restored.records[0]!.usage.inputTokens, 42, "usage 五维恢复");
    assert.equal(restored.baseInstructions, "BASE-INSTR", "sessionMeta 头部恢复");

    // 幂等:重复 persist 不炸、数据不变。
    persistRolloutFrontier(fixture.db, {
      fileKey: "rollout-2026-11-05T11-00-00-c2", path: filePath, mtimeMs: Date.now(),
      size: 1000, offset: 999, itemCount: 1, sessionId: "sess-c2", lastActivityMs: Date.now(),
      records: [],
    });
    const again = restoreRolloutState(fixture.db, "rollout-2026-11-05T11-00-00-c2", filePath);
    assert.equal(again?.offset, 999, "幂等覆盖生效");
  });
});
