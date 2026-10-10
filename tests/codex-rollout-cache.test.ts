/**
 * Codex rollout 解析缓存的资源行为守卫（2026-10-10 修复回归）。
 *
 * 缺陷背景（当日修复）：① 读取缓冲固定分配 32 MiB，解析尾部残片以 subarray
 * 视图存入 cache.tail——rollout 行以 \n 结尾，正常轮次解析完尾部为 0 字节，但
 * 空视图仍钉住整段 32 MiB 底层 ArrayBuffer（实测把进程 RSS 推到 GiB 级）；②
 * 缓存签名（mtime/size）不随解析回写，任何被追加过的文件每 2s 都重走读取路径。
 *
 * 本文件锁死两条不变量：
 * 1. 尾部半行字节跨轮拼接不得丢（ownedBuffer 拷贝语义）；
 * 2. 冷解析 + 稳态重复扫描的 ArrayBuffer 增量必须与文件体积同量级（旧实现
 *    单文件即钉住 32 MiB，与文件大小无关）。
 */
import assert from "node:assert/strict";
import {appendFile, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, test} from "vitest";
import {createCodexLocalSourceAdapter} from "@/lib/agent-local-source/adapters/codex";

const NOW = Date.now();
const FLOOR = NOW - 60 * 60_000;
const ALLOWED = new Set(["gpt-6.1-sol"]);

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

async function newCliDir(): Promise<{cliDir: string; sessionsDayDir: string}> {
  const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-cache-"));
  roots.push(cliDir);
  const nowDate = new Date(NOW);
  const sessionsDayDir = join(cliDir, "sessions",
    String(nowDate.getUTCFullYear()),
    String(nowDate.getUTCMonth() + 1).padStart(2, "0"),
    String(nowDate.getUTCDate()).padStart(2, "0"));
  await mkdir(sessionsDayDir, {recursive: true});
  return {cliDir, sessionsDayDir};
}

function rolloutLine(type: string, ordinal: number, payload: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    timestamp: new Date(NOW - 30_000 + ordinal * 100).toISOString(),
    ordinal,
    payload,
  });
}

/** 最小可入账会话头（session_meta + turn + UserMessage 完成）。 */
function sessionHead(sessionId: string): string {
  return [
    rolloutLine("session_meta", 1, {session_id: sessionId, model_provider: "openai", cli_version: "0.161.0"}),
    rolloutLine("turn_context", 2, {turn_id: "t1", model: "gpt-6.1-sol"}),
    rolloutLine("event_msg", 3, {
      type: "item_completed",
      started_at_ms: NOW - 30_000,
      completed_at_ms: NOW - 29_000,
      item: {type: "UserMessage"},
    }),
  ].join("\n") + "\n";
}

function tokenCountLine(ordinal: number): string {
  return rolloutLine("event_msg", ordinal, {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15,
      },
    },
  });
}

describe("Codex rollout 解析缓存资源行为（2026-10-10 Buffer 持有修复）", () => {
  test("尾部半行跨轮拼接：无换行残片留缓冲，补齐后完整解析（拷贝不得丢字节）", async () => {
    const {cliDir, sessionsDayDir} = await newCliDir();
    const fileKey = "rollout-tail-guard-00000000-0000-0000-0000-000000000001";
    const path = join(sessionsDayDir, `${fileKey}.jsonl`);
    const fullToken = tokenCountLine(4);
    const cut = Math.floor(fullToken.length / 2);
    // 首轮写入：完整头 + 半行 token_count（无换行结尾，模拟写入中途被扫描）。
    await writeFile(path, sessionHead("sess-tail-guard") + fullToken.slice(0, cut));
    const adapter = createCodexLocalSourceAdapter({cliDir});
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED),
      [],
      "半行不得提前成为候选（应留在尾部缓冲）",
    );
    // 追加余下字节 + 换行：跨轮拼接后必须完整解析出该记录。
    await appendFile(path, fullToken.slice(cut) + "\n");
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(candidate => candidate.id),
      [`${fileKey}:4`],
      "尾部残片与新增字节拼接后必须完整解析",
    );
  });

  test("冷解析 + 稳态重复扫描的 ArrayBuffer 增量与文件体积同量级（不得钉住 32 MiB 读取缓冲）", async () => {
    const {cliDir, sessionsDayDir} = await newCliDir();
    // 3 个几 KB 的会话文件：旧实现在首次解析后即各持有一段 32 MiB ArrayBuffer。
    for (let index = 0; index < 3; index += 1) {
      await writeFile(
        join(sessionsDayDir, `rollout-mem-guard-00000000-0000-0000-0000-0000000000${index}a.jsonl`),
        sessionHead(`sess-mem-guard-${index}`) + tokenCountLine(4) + "\n",
      );
    }
    const adapter = createCodexLocalSourceAdapter({cliDir});
    const before = process.memoryUsage().arrayBuffers;
    const first = adapter.readPendingCandidates(FLOOR, ALLOWED);
    assert.equal(first.length, 3, "冷解析应产出全部候选（冷预算 ≥3 文件）");
    // 稳态：文件未变化时重复扫描不得再进入读取路径（签名随解析回写）。
    for (let round = 0; round < 5; round += 1) {
      assert.equal(adapter.readPendingCandidates(FLOOR, ALLOWED).length, 3);
    }
    const delta = process.memoryUsage().arrayBuffers - before;
    assert.ok(
      delta < 8 * 1024 * 1024,
      `解析 + 5 轮重复扫描的 ArrayBuffer 增量须与文件体积同量级，实际 ${delta} bytes`
        + "（旧实现单文件即常驻 32 MiB：3 文件 + churn 应远超阈值）",
    );
  });

  test("正文 LRU 逐出后按需从磁盘重建，详情与首次逐字段一致（2026-10-10 A 修复）", async () => {
    const {cliDir, sessionsDayDir} = await newCliDir();
    const keyA = "rollout-lru-evict-00000000-0000-0000-0000-00000000000a";
    const keyB = "rollout-lru-evict-00000000-0000-0000-0000-00000000000b";
    await writeFile(join(sessionsDayDir, `${keyA}.jsonl`), sessionHead("sess-lru-a") + tokenCountLine(4) + "\n");
    await writeFile(join(sessionsDayDir, `${keyB}.jsonl`), sessionHead("sess-lru-b") + tokenCountLine(4) + "\n");
    // 正文预算 1 字节：任一文件的 items 入缓存后，访问另一文件必然将其逐出（至少保留 1 条）。
    const adapter = createCodexLocalSourceAdapter({cliDir, contentCacheMaxBytes: 1});
    assert.equal(adapter.readPendingCandidates(FLOOR, ALLOWED).length, 2, "元数据解析不受正文策略影响");
    const refA = {sessionId: "sess-lru-a", requestId: `${keyA}:4`, startedAt: 0};
    const first = await adapter.readExchangeDetail(refA);
    assert.ok(first, "首次详情必须可解析（重析进 LRU）");
    assert.ok(await adapter.readExchangeDetail({sessionId: "sess-lru-b", requestId: `${keyB}:4`, startedAt: 0}), "B 详情可解析（同时逐出 A）");
    const rebuilt = await adapter.readExchangeDetail(refA);
    assert.ok(rebuilt, "LRU 逐出后必须能从磁盘重析");
    assert.deepEqual(rebuilt, first, "重析详情与首次逐字段一致（同一映射函数、同一文件字节）");
  });

  test("文件被清理后详情缺失（新语义锁定：不再从内存回放；账本用量不受影响）", async () => {
    const {cliDir, sessionsDayDir} = await newCliDir();
    const fileKey = "rollout-deleted-00000000-0000-0000-0000-00000000000c";
    const path = join(sessionsDayDir, `${fileKey}.jsonl`);
    await writeFile(path, sessionHead("sess-deleted") + tokenCountLine(4) + "\n");
    const adapter = createCodexLocalSourceAdapter({cliDir});
    const candidates = adapter.readPendingCandidates(FLOOR, ALLOWED);
    assert.equal(candidates.length, 1, "记录元数据照常产出");
    // 记录先 hydrate（用量字段来自元数据，不依赖正文文件）。
    const batch = adapter.hydrateUsageRecords([candidates[0]!.id]);
    assert.equal(batch.records.length, 1);
    assert.equal(batch.records[0]!.usage.inputTokens, 10);
    await rm(path);
    assert.equal(
      await adapter.readExchangeDetail({sessionId: "sess-deleted", requestId: `${fileKey}:4`, startedAt: 0}),
      undefined,
      "文件不存在时重析失败 → 详情缺失（与 dsh/zcode 的短命正文语义一致）",
    );
  });

  test("增量续析等价（2026-10-10 活跃会话修复）：多次追加后的详情与全量重建逐字段一致", async () => {
    const {cliDir, sessionsDayDir} = await newCliDir();
    const fileKey = "rollout-incremental-00000000-0000-0000-0000-00000000000d";
    const path = join(sessionsDayDir, `${fileKey}.jsonl`);
    const extraTurn = (index: number, ordinal: number) => [
      rolloutLine("turn_context", ordinal, {turn_id: `ti${index}`, model: "gpt-6.1-sol"}),
      rolloutLine("response_item", ordinal + 1, {
        type: "message", id: `msg_i${index}`, role: "user",
        content: [{type: "input_text", text: `增量输入${index}`}],
      }),
      rolloutLine("event_msg", ordinal + 2, {
        type: "item_completed", started_at_ms: NOW - 20_000 + index, completed_at_ms: NOW - 19_000 + index,
        item: {type: "UserMessage"},
      }),
      tokenCountLine(ordinal + 3),
    ].join("\n") + "\n";

    // 热路径适配器：每轮「扫描 → 读详情 → 追加下一 turn（行中间劈半、中间再扫
    // 一次）」——模拟活跃会话持续追加，LRU 命中后靠增量续析（含半行边界拼装）
    // 服务新记录。
    await writeFile(path, sessionHead("sess-inc") + extraTurn(0, 4));
    const hot = createCodexLocalSourceAdapter({cliDir});
    const refOf = (ordinal: number) => ({sessionId: "sess-inc", requestId: `${fileKey}:${ordinal}`, startedAt: 0});
    const details: Array<NonNullable<Awaited<ReturnType<typeof hot.readExchangeDetail>>>> = [];
    for (let turn = 0; turn < 4; turn += 1) {
      hot.readPendingCandidates(FLOOR, ALLOWED);
      const detail = await hot.readExchangeDetail(refOf(4 + turn * 4 + 3));
      assert.ok(detail, `第 ${turn} 轮详情必须可解析`);
      details.push(detail);
      const next = extraTurn(turn + 1, 8 + turn * 4);
      const split = Math.floor(next.length / 2);
      await appendFile(path, next.slice(0, split));
      hot.readPendingCandidates(FLOOR, ALLOWED);
      await appendFile(path, next.slice(split));
    }

    // 对照适配器（全新实例）：同样的最终文件走全量重建路径，逐字段比对。
    const cold = createCodexLocalSourceAdapter({cliDir});
    cold.readPendingCandidates(FLOOR, ALLOWED);
    for (let turn = 0; turn < 4; turn += 1) {
      const rebuilt = await cold.readExchangeDetail(refOf(4 + turn * 4 + 3));
      assert.ok(rebuilt, `全量重建第 ${turn} 轮详情必须可解析`);
      assert.deepEqual(details[turn], rebuilt,
        `增量续析与全量重建必须逐字段一致（第 ${turn} 轮）`);
    }
    // 增量路径产出的上下文必须真实累积（第 3 轮包含第 0 轮的用户输入）。
    assert.match(details[3]!.requestRawBody ?? "", /增量输入0/u, "增量续析不得丢失早期上下文");
  });
});
