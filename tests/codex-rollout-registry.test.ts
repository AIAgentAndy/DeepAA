/**
 * Codex rollout 活跃文件注册表守卫（2026-11-03 事故修复回归）。
 *
 * 缺陷背景（当日修复）：Codex 长会话持续 resume 会把新行 append 到任意老的日期
 * 目录（sessions/YYYY/MM/DD 按会话创建日归档）；发现层按「目录名日期」整日裁剪，
 * 把 mtime 活跃的老目录文件永久排除——官方直连导入静默断流 4 天（96MB 活跃会话
 * 文件位于 11 天前的目录，调度器每轮 9ms 空转、零错误零导入）。
 *
 * 本文件锁死七条不变量：
 * 1. 老日期目录里 mtime 活跃的文件必须被发现并产出候选（事故直接回归）；
 * 2. mtime 滑出活跃窗（7 天无写入）后候选消失——解析缓存不得驻留非活跃数据；
 * 3. 进程运行期间老目录文件恢复活跃（resume）→ 低频重扫后重新发现；
 * 4. 文件被清理 → 零残留、零异常；网关 provider 白名单在老目录同样生效；
 * 5. 单块读取上限（32 MiB）造成的中部中断，静默期仍逐轮推进直至追平（二修守卫）；
 * 6. 注册表增量 stat 维护路径：老目录文件日常追加 → 下一轮续析产出新候选；
 * 7. 窗口内（当天目录）文件滑出活跃窗同样逐出（文件级 mtime 是唯一活跃语义）。
 */
import assert from "node:assert/strict";
import {appendFile, mkdir, mkdtemp, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, test} from "vitest";
import {createCodexLocalSourceAdapter} from "@/lib/agent-local-source/adapters/codex";

const NOW = Date.now();
const DAY = 24 * 60 * 60_000;
/** 活跃下界：1 小时前（真实调度为 7 天窗；测试缩短以聚焦文件发现语义）。 */
const FLOOR = NOW - 60 * 60_000;
const ALLOWED = new Set(["gpt-6.1-sol"]);

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

/** 距今 daysAgo 天的日期目录（UTC 口径，与适配器目录名解析一致）。 */
async function legacyDayDir(cliDir: string, daysAgo: number): Promise<string> {
  const date = new Date(NOW - daysAgo * DAY);
  const dayDir = join(cliDir, "sessions",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"));
  await mkdir(dayDir, {recursive: true});
  return dayDir;
}

function rolloutLine(type: string, ordinal: number, payload: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    timestamp: new Date(NOW - 30_000 + ordinal * 100).toISOString(),
    ordinal,
    payload,
  });
}

function sessionHead(sessionId: string, provider = "openai"): string {
  return [
    rolloutLine("session_meta", 1, {session_id: sessionId, model_provider: provider, cli_version: "0.165.0"}),
    rolloutLine("turn_context", 2, {turn_id: "t1", model: "gpt-6.1-sol"}),
    rolloutLine("event_msg", 3, {
      type: "item_completed",
      started_at_ms: NOW - 30_000,
      completed_at_ms: NOW - 29_000,
      item: {type: "UserMessage"},
    }),
    rolloutLine("event_msg", 4, {
      type: "token_count",
      info: {last_token_usage: {
        input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15,
      }},
    }),
  ].join("\n") + "\n";
}

describe("Codex rollout 活跃文件注册表（2026-11-03 老目录活跃文件断流修复）", () => {
  test("不变量 1：老日期目录（30 天前）+ mtime 活跃的文件必须产出候选（事故直接回归）", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const dayDir = await legacyDayDir(cliDir, 30);
    const fileKey = "rollout-legacy-active-00000000-0000-0000-0000-0000000000a1";
    await writeFile(join(dayDir, `${fileKey}.jsonl`), sessionHead("sess-legacy-active"));
    const adapter = createCodexLocalSourceAdapter({cliDir});
    const candidates = adapter.readPendingCandidates(FLOOR, ALLOWED);
    assert.deepEqual(
      candidates.map(candidate => candidate.id),
      [`${fileKey}:4`],
      "老目录里 mtime 活跃的文件必须被发现（冷启动全扫收录进注册表）",
    );
  });

  test("不变量 2：mtime 滑出活跃窗 → 候选消失（增量维护路径逐出，缓存不驻留非活跃数据）", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const dayDir = await legacyDayDir(cliDir, 30);
    const fileKey = "rollout-stale-evict-00000000-0000-0000-0000-0000000000b2";
    const path = join(dayDir, `${fileKey}.jsonl`);
    await writeFile(path, sessionHead("sess-stale-evict"));
    const adapter = createCodexLocalSourceAdapter({cliDir});
    assert.equal(adapter.readPendingCandidates(FLOOR, ALLOWED).length, 1, "活跃期候选照常");
    // mtime 置于 floor 之前（模拟 7 天无写入；默认重扫间隔内 → 走增量 stat 维护路径）。
    await utimes(path, new Date(FLOOR - DAY), new Date(FLOOR - DAY));
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED),
      [],
      "mtime 滑出活跃窗后不得继续产出候选（增量维护移出注册表 + 缓存逐出）",
    );
  });

  test("不变量 3：进程运行期间老目录文件恢复活跃（resume）→ 重扫后重新发现并产出候选", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const dayDir = await legacyDayDir(cliDir, 45);
    const fileKey = "rollout-resume-found-00000000-0000-0000-0000-000000000c3";
    const path = join(dayDir, `${fileKey}.jsonl`);
    await writeFile(path, sessionHead("sess-resume-found"));
    // 初始即不活跃（mtime 早于 floor）：首轮全扫不收录。
    await utimes(path, new Date(FLOOR - DAY), new Date(FLOOR - DAY));
    const adapter = createCodexLocalSourceAdapter({cliDir, registryRescanIntervalMs: 0});
    assert.deepEqual(adapter.readPendingCandidates(FLOOR, ALLOWED), [], "不活跃期无候选");
    // resume：文件恢复写入（mtime 回到当下）→ 每轮全扫（interval=0）必须重新发现。
    await utimes(path, new Date(), new Date());
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(candidate => candidate.id),
      [`${fileKey}:4`],
      "恢复活跃的老目录文件必须被低频重扫重新发现",
    );
  });

  test("不变量 4a：文件被清理 → 候选消失、后续扫描零异常", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const dayDir = await legacyDayDir(cliDir, 30);
    const fileKey = "rollout-gone-clean-00000000-0000-0000-0000-0000000000d4";
    const path = join(dayDir, `${fileKey}.jsonl`);
    await writeFile(path, sessionHead("sess-gone-clean"));
    const adapter = createCodexLocalSourceAdapter({cliDir});
    assert.equal(adapter.readPendingCandidates(FLOOR, ALLOWED).length, 1);
    await rm(path);
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED),
      [],
      "文件消失后注册表条目与缓存必须被清理",
    );
  });

  test("不变量 4b：老目录下的网关 provider 文件仍被白名单排除（排重语义不回归）", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const dayDir = await legacyDayDir(cliDir, 30);
    await writeFile(
      join(dayDir, "rollout-legacy-gateway-00000000-0000-0000-0000-000000000e5.jsonl"),
      sessionHead("sess-legacy-gateway", "deepaa_gateway"),
    );
    const adapter = createCodexLocalSourceAdapter({cliDir});
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED),
      [],
      "注册表收录老目录活跃文件后，provider 白名单过滤必须照常生效（防双通道重复入账）",
    );
  });

  test("窗口内（当天目录）新会话发现不回归：候选照常产出", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const nowDate = new Date(NOW);
    const dayDir = join(cliDir, "sessions",
      String(nowDate.getUTCFullYear()),
      String(nowDate.getUTCMonth() + 1).padStart(2, "0"),
      String(nowDate.getUTCDate()).padStart(2, "0"));
    await mkdir(dayDir, {recursive: true});
    const fileKey = "rollout-today-window-00000000-0000-0000-0000-000000000f6";
    await writeFile(join(dayDir, `${fileKey}.jsonl`), sessionHead("sess-today-window"));
    const adapter = createCodexLocalSourceAdapter({cliDir});
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(candidate => candidate.id),
      [`${fileKey}:4`],
      "当天目录的即时发现路径不受注册表机制影响",
    );
  });

  test("不变量 5（二修）：单块读取上限造成的中部中断，静默期解析前沿仍须逐轮推进直至追平", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const dayDir = await legacyDayDir(cliDir, 30);
    const fileKey = "rollout-cold-catchup-00000000-0000-0000-0000-0000000000g7";
    // 会话头 + 8 个 turn 的 token_count：注入 2KB 单块上限后，首轮只读到文件中部
    // （readChunkMaxBytes 是「解析前沿中部中断」的唯一来源——冷预算只 gate 新文件
    // 启动、不会中断文件中部）。
    const turns = Array.from({length: 8}, (_unused, index) => [
      rolloutLine("turn_context", 5 + index * 2, {turn_id: `tc${index}`, model: "gpt-6.1-sol"}),
      rolloutLine("event_msg", 6 + index * 2, {
        type: "token_count",
        info: {last_token_usage: {
          input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
          output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15,
        }},
      }),
    ].join("\n")).join("\n");
    await writeFile(join(dayDir, `${fileKey}.jsonl`), sessionHead("sess-cold-catchup") + turns + "\n");
    const adapter = createCodexLocalSourceAdapter({cliDir, readChunkMaxBytes: 2048});
    // 多轮驱动且全程不改文件（静默期）：旧实现首轮读到 2KB 后签名已回写完整文件
    // 值，第 2 轮起因「签名相同」跳过——解析前沿永久停在中部、候选残缺；修复后
    // （offset < size 不跳过）必须逐轮推进直至 9 条候选（头部 1 条 + 8 个 turn）全产出。
    const collected = new Set<string>();
    for (let round = 0; round < 20; round += 1) {
      for (const candidate of adapter.readPendingCandidates(FLOOR, ALLOWED)) collected.add(candidate.id);
    }
    assert.equal(collected.size, 9, `静默期多轮扫描必须追平解析前沿（头部 1 条 + 8 个 turn 全部产出），实际 ${collected.size}`);
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(candidate => candidate.id),
      [4, ...Array.from({length: 8}, (_unused, index) => 6 + index * 2)].map(ordinal => `${fileKey}:${ordinal}`),
      "追平后候选完整且顺序稳定（session 内完成时间正序）",
    );
  });

  test("不变量 6：注册表增量维护路径——老目录文件日常追加（mtime/size 变化）→ 下一轮续析产出新候选", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const dayDir = await legacyDayDir(cliDir, 30);
    const fileKey = "rollout-inc-append-00000000-0000-0000-0000-0000000000h8";
    const path = join(dayDir, `${fileKey}.jsonl`);
    await writeFile(path, sessionHead("sess-inc-append"));
    // 默认重扫间隔（10 分钟）内：第二次调用走注册表增量 stat 维护路径（非全扫重建），
    // stat 刷新的 mtime/size 驱动签名比较 → 续析追加块——即 96MB 会话日常追加的生产路径。
    const adapter = createCodexLocalSourceAdapter({cliDir});
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(candidate => candidate.id),
      [`${fileKey}:4`],
      "首轮解析全量",
    );
    await appendFile(path, [
      rolloutLine("turn_context", 5, {turn_id: "t2", model: "gpt-6.1-sol"}),
      rolloutLine("event_msg", 6, {
        type: "token_count",
        info: {last_token_usage: {
          input_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0,
          output_tokens: 8, reasoning_output_tokens: 0, total_tokens: 28,
        }},
      }),
    ].join("\n") + "\n");
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(candidate => candidate.id),
      [`${fileKey}:4`, `${fileKey}:6`],
      "增量 stat 维护刷新签名后必须续析追加块（新候选出现）",
    );
  });

  test("不变量 7：窗口内（当天目录）文件滑出活跃窗 → 逐出（枚举/注册表双路径一致）", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "deepaa-codex-registry-"));
    roots.push(cliDir);
    const nowDate = new Date(NOW);
    const dayDir = join(cliDir, "sessions",
      String(nowDate.getUTCFullYear()),
      String(nowDate.getUTCMonth() + 1).padStart(2, "0"),
      String(nowDate.getUTCDate()).padStart(2, "0"));
    await mkdir(dayDir, {recursive: true});
    const fileKey = "rollout-today-stale-00000000-0000-0000-0000-0000000000i9";
    const path = join(dayDir, `${fileKey}.jsonl`);
    await writeFile(path, sessionHead("sess-today-stale"));
    const adapter = createCodexLocalSourceAdapter({cliDir});
    assert.equal(adapter.readPendingCandidates(FLOOR, ALLOWED).length, 1, "活跃期候选照常");
    await utimes(path, new Date(FLOOR - DAY), new Date(FLOOR - DAY));
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED),
      [],
      "窗口内文件滑出活跃窗后同样逐出（文件级 mtime 判据是唯一活跃语义）",
    );
  });
});
