/**
 * dsh 本地扫描增量性回归（2026-09-18）。
 *
 * 事故背景：身份索引与正文共用一份 96 MiB LRU，而 dsh 会话库解压后 100 MB+，
 * 每轮扫描都会把先解析的会话逐出、下一轮再重新解压；fzstd 是纯 JS 解压
 * （本机实测 ~4.5 MB/s），于是每个导入轮次把 Next 主线程独占 20 s+，接口
 * 22–32 s 停顿、派生任务租约过期、待补投影积压。
 *
 * 本文件锁死修复后的三条不变量：
 * 1. 未变化的会话文件**不再重新解压**（不变量用"原地改成不可解压但保持
 *    size+mtime"来判定：仍能产出身份标注/候选，说明走的是常驻索引）；
 * 2. 单轮解压量受预算约束（冷启动回补不会一次性独占主线程），且逐轮收敛；
 * 3. 父子会话的 root 折叠在索引上仍然正确（祖先链不再依赖正文缓存）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, test } from "vitest";
import { createDshLocalSourceAdapter } from "@/lib/agent-local-source/adapters/dsh";

interface StepSpec {
  turn: number;
  step: number;
  /** 缺省即"官方直连"形态（无 responseId）；给出即写 replayState.responseId。 */
  responseId?: string;
  /** 缺省 deepseek（非网关）；给出则作为 request/context.provider。 */
  provider?: string;
  model?: string;
  /** 追加一个 tool-call 块（覆盖 readExchangeDetail 的工具动作映射）。 */
  toolCall?: {id: string; name: string; arguments: string};
}

function sessionJsonl(input: {
  sessionId: string;
  steps: StepSpec[];
  parentSession?: string;
  delegationDepth?: number;
  createdAt?: number;
  /** 追加无意义的事件把解压体积撑到目标大小（预算测试用）。 */
  padBytes?: number;
}): string {
  const createdAt = input.createdAt ?? 1_789_610_000_000;
  const lines: string[] = [JSON.stringify({
    type: "session",
    version: 3,
    id: input.sessionId,
    createdAt,
    ...(input.parentSession ? {parentSession: input.parentSession} : {}),
    delegationDepth: input.delegationDepth ?? (input.parentSession ? 1 : 0),
  })];
  let time = createdAt + 1;
  let firstStep = true;
  for (const spec of input.steps) {
    const provider = spec.provider ?? "deepseek";
    const model = spec.model ?? "deepseek-chat";
    lines.push(JSON.stringify({
      type: "request/context",
      time: time++,
      data: { provider, model },
    }));
    if (firstStep) {
      // 真实事件序：用户输入在首个 step/start 之前（请求重建必须回放到它）。
      lines.push(JSON.stringify({
        type: "user/message",
        time: time++,
        data: {
          content: [{ type: "text", text: `${input.sessionId} user prompt` }],
          source: { kind: "user" },
          role: "user",
          id: `${input.sessionId}-u1`,
        },
      }));
      firstStep = false;
    }
    lines.push(JSON.stringify({
      type: "step/start",
      time: time++,
      data: { turn: spec.turn, step: spec.step },
    }));
    lines.push(JSON.stringify({
      type: "assistant/message",
      time: time++,
      data: {
        turn: spec.turn,
        step: spec.step,
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: `${input.sessionId} reasoning` },
            { type: "text", text: `${input.sessionId} answer ${spec.step}` },
            ...(spec.toolCall
              ? [{
                type: "tool-call",
                id: spec.toolCall.id,
                name: spec.toolCall.name,
                arguments: spec.toolCall.arguments,
              }]
              : []),
          ],
        },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 5 },
        stream: [{
          chunk: {
            type: "finish",
            reason: { kind: "stop" },
            replayState: {
              response: {
                provider,
                model,
                ...(spec.responseId ? { responseId: spec.responseId } : {}),
              },
            },
          },
        }],
      },
    }));
    lines.push(JSON.stringify({
      type: "step/end",
      time: time++,
      data: { turn: spec.turn, step: spec.step },
    }));
  }
  if (input.padBytes) {
    // request/header 事件带工具定义，是最贴近真实的"大事件"形态。
    lines.push(JSON.stringify({
      type: "request/header",
      time: time++,
      data: { header: { config: { tools: [{ name: "pad", description: "x".repeat(input.padBytes) }] } } },
    }));
  }
  return `${lines.join("\n")}\n`;
}

function writeSession(
  cliDir: string,
  workspace: string,
  directory: string,
  jsonl: string,
): { path: string; size: number; mtimeMs: number} {
  const dir = join(cliDir, "sessions", workspace, directory);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.v3.jsonl.zstd");
  const compressed = zstdCompressSync(Buffer.from(jsonl, "utf8"));
  writeFileSync(path, compressed);
  return { path, size: compressed.byteLength, mtimeMs: 0 };
}

function newCliDir(): string {
  return mkdtempSync(join(tmpdir(), "deepaa-dsh-scan-"));
}

const FLOOR = 1_789_000_000_000;
const ALLOWED = new Set(["deepseek-chat"]);
/** 落在扫描窗内的固定 mtime（整秒），便于"原地替换但 size/mtime 不变"的判定。 */
const PINNED_MTIME_SECONDS = (FLOOR - 60_000) / 1000;


describe("dsh 本地扫描增量性（2026-09-18 每轮全量重解压修复）", () => {
  test("未变化文件零解压：原地换成不可解压内容（size/mtime 不变）后标注与候选照旧", () => {
    const cliDir = newCliDir();
    const file = writeSession(
      cliDir,
      "--ws-a--",
      "sess-unchanged-0001",
      sessionJsonl({
        sessionId: "sess-unchanged-0001",
        steps: [
          { turn: 1, step: 1, responseId: "resp-a-1" },
          { turn: 1, step: 2, responseId: "resp-a-2" },
          // 经网关的步骤不进候选，但必须产出身份标注。
          { turn: 2, step: 1, responseId: "resp-a-3", provider: "deepaa-gateway" },
        ],
      }),
    );
    utimesSync(file.path, PINNED_MTIME_SECONDS, PINNED_MTIME_SECONDS);
    const adapter = createDshLocalSourceAdapter({ cliDir });

    const first = adapter.readPendingCandidates(FLOOR, ALLOWED);
    const firstLinks = adapter.drainIdentityLinks();
    assert.deepEqual(
      first.map(item => item.id).sort(),
      ["sess-unchanged-0001_t1_s1", "sess-unchanged-0001_t1_s2"],
      "直连步骤进候选，网关步骤不进",
    );
    assert.deepEqual(
      firstLinks.map(link => link.responseId).sort(),
      ["resp-a-1", "resp-a-2", "resp-a-3"],
      "身份标注覆盖网关步骤",
    );

    // 原地破坏内容但保持 size 与 mtime：只要仍然走常驻索引，本轮就不需要解压。
    const originalSize = readFileSync(file.path).byteLength;
    writeFileSync(file.path, Buffer.alloc(originalSize, 0x7a));
    utimesSync(file.path, PINNED_MTIME_SECONDS, PINNED_MTIME_SECONDS);

    const second = adapter.readPendingCandidates(FLOOR, ALLOWED);
    const secondLinks = adapter.drainIdentityLinks();
    assert.deepEqual(
      second.map(item => item.id).sort(),
      ["sess-unchanged-0001_t1_s1", "sess-unchanged-0001_t1_s2"],
      "未变化文件不得重新解压（解压会失败并丢候选）",
    );
    assert.deepEqual(
      secondLinks.map(link => link.responseId).sort(),
      ["resp-a-1", "resp-a-2", "resp-a-3"],
      "未变化文件不得重新解压（解压会失败并丢标注）",
    );

    // 真正的变化（size 改变）必须触发重新解析。
    writeFileSync(file.path, zstdCompressSync(Buffer.from(sessionJsonl({
      sessionId: "sess-unchanged-0001",
      steps: [{ turn: 1, step: 1, responseId: "resp-a-1" }],
    }), "utf8")));
    utimesSync(file.path, PINNED_MTIME_SECONDS, PINNED_MTIME_SECONDS);
    const third = adapter.readPendingCandidates(FLOOR, ALLOWED);
    assert.deepEqual(third.map(item => item.id), ["sess-unchanged-0001_t1_s1"]);
  });

  test("单轮解压预算约束冷启动回补，且逐轮收敛到全量", () => {
    const cliDir = newCliDir();
    const sessionCount = 6;
    for (let index = 0; index < sessionCount; index += 1) {
      writeSession(
        cliDir,
        "--ws-b--",
        `sess-budget-000${index}`,
        sessionJsonl({
          sessionId: `sess-budget-000${index}`,
          steps: [{ turn: 1, step: 1, responseId: `resp-b-${index}` }],
          padBytes: 8_192,
        }),
      );
    }
    // 预算只够约两个会话（每个会话解压后 > 8 KiB）：首轮必须显著少于全量。
    const adapter = createDshLocalSourceAdapter({
      cliDir,
      scanDecompressedBytesPerRound: 12_288,
    });
    const roundOne = adapter.readPendingCandidates(FLOOR, ALLOWED);
    adapter.drainIdentityLinks();
    assert.ok(roundOne.length >= 1, "首轮至少索引一个会话（保证前进）");
    assert.ok(
      roundOne.length < sessionCount,
      `首轮受预算约束，不得一次索引全部会话（实际 ${roundOne.length}/${sessionCount}）`,
    );

    // 逐轮收敛：预算受限但每轮都要有进展，最终必须覆盖全部会话。
    let total = roundOne.length;
    let previous = roundOne.length;
    for (let round = 0; round < sessionCount && total < sessionCount; round += 1) {
      const current = adapter.readPendingCandidates(FLOOR, ALLOWED);
      adapter.drainIdentityLinks();
      assert.ok(current.length >= previous, "候选集合只增不减（索引是单调累积的）");
      assert.ok(current.length > previous, "每轮必须有新回补，否则永远不会收敛");
      previous = current.length;
      total = current.length;
    }
    assert.equal(total, sessionCount, "若干轮内必须收敛到全量");

    // 预算放开后一次即可拿到全部会话（未变化的不重复解压也要能被枚举出来）。
    const unbounded = createDshLocalSourceAdapter({ cliDir });
    const full = unbounded.readPendingCandidates(FLOOR, ALLOWED);
    assert.equal(full.length, sessionCount);
  });

  test("祖先链折叠走常驻索引：子会话 root 解析到根，与正文是否驻留无关", () => {
    const cliDir = newCliDir();
    writeSession(cliDir, "--ws-c--", "sess-root-0001", sessionJsonl({
      sessionId: "sess-root-0001",
      steps: [{ turn: 1, step: 1, responseId: "resp-root-1" }],
    }));
    writeSession(cliDir, "--ws-c--", "sess-child-0002", sessionJsonl({
      sessionId: "sess-child-0002",
      parentSession: "sess-root-0001",
      steps: [{ turn: 1, step: 1, responseId: "resp-child-1" }],
    }));
    writeSession(cliDir, "--ws-c--", "sess-grand-0003", sessionJsonl({
      sessionId: "sess-grand-0003",
      parentSession: "sess-child-0002",
      delegationDepth: 2,
      steps: [{ turn: 1, step: 1, responseId: "resp-grand-1" }],
    }));
    const adapter = createDshLocalSourceAdapter({ cliDir });
    adapter.readPendingCandidates(FLOOR, ALLOWED);
    const links = new Map(adapter.drainIdentityLinks().map(link => [link.responseId, link]));

    assert.equal(links.get("resp-root-1")?.rootExternalSessionId, undefined, "根会话不写 root 覆写");
    assert.equal(links.get("resp-child-1")?.rootExternalSessionId, "sess-root-0001");
    assert.equal(
      links.get("resp-grand-1")?.rootExternalSessionId,
      "sess-root-0001",
      "孙会话必须递归折叠到根（旧实现依赖正文缓存，逐出后只能折到父）",
    );
    assert.equal(links.get("resp-grand-1")?.delegationDepth, 2);
  });

  test("交互内容详情：正文被 LRU 逐出后按需重建，不丢详情也不重解压未变化文件", async () => {
    const cliDir = newCliDir();
    writeSession(cliDir, "--ws-e--", "sess-detail-0001", sessionJsonl({
      sessionId: "sess-detail-0001",
      steps: [{
        turn: 1,
        step: 1,
        responseId: "resp-detail-1",
        toolCall: {id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}"},
      }],
    }));
    // 正文缓存上限设为 1 字节：解析后立即逐出，强制走"索引在、正文不在"的路径。
    const adapter = createDshLocalSourceAdapter({ cliDir, bodyCacheMaxBytes: 1 });
    adapter.readPendingCandidates(FLOOR, ALLOWED);
    adapter.drainIdentityLinks();

    const detail = await adapter.readExchangeDetail({
      sessionId: "sess-detail-0001",
      requestId: "resp-detail-1",
      turnId: "1",
      stepNumber: 1,
      startedAt: 0,
    });
    assert.ok(detail, "正文逐出后必须能从索引定位文件并按需重建（此前会返回 undefined）");
    assert.equal(detail.responseId, "resp-detail-1");
    // 请求体 = 目标步之前的 provider-visible 事件回放（用户输入必须在内）。
    assert.match(detail.requestRawBody ?? "", /sess-detail-0001 user prompt/);
    assert.doesNotMatch(detail.requestRawBody ?? "", /answer 1/, "助手回复不得进入请求回放");
    assert.equal(detail.response?.text, "sess-detail-0001 answer 1");
    assert.equal(detail.response?.reasoningText, "sess-detail-0001 reasoning");
    assert.deepEqual(detail.response?.toolCalls, [{
      id: "call_1",
      name: "bash",
      input: {command: "ls"},
    }]);
    assert.deepEqual(detail.toolNames, [], "本会话 request/header 未声明工具定义");

    // 详情重建是"按需单文件"的：不能因为拿详情而重新全量解压（索引仍在）。
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(item => item.id),
      ["sess-detail-0001_t1_s1"],
    );
  });

  test("网关标记 provider 的步骤不进候选，但仍产出身份标注", () => {    const cliDir = newCliDir();
    writeSession(cliDir, "--ws-d--", "sess-gw-0001", sessionJsonl({
      sessionId: "sess-gw-0001",
      steps: [
        { turn: 1, step: 1, responseId: "resp-gw-1", provider: "llm-inspector-gateway" },
        { turn: 1, step: 2, responseId: "resp-gw-2" },
      ],
    }));
    const adapter = createDshLocalSourceAdapter({ cliDir });
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(item => item.id),
      ["sess-gw-0001_t1_s2"],
    );
    assert.deepEqual(
      adapter.drainIdentityLinks().map(link => link.responseId).sort(),
      ["resp-gw-1", "resp-gw-2"],
    );
  });
});

describe("dsh 解析失败预算与退避（2026-10-10 无界重解压修复）", () => {
  /** 坏 zstd 文件：解压或解析必然失败（旧实现每轮重试，每 2s 重复昂贵解压）。 */
  function writeCorruptSession(
    cliDir: string,
    workspace: string,
    directory: string,
  ): {path: string} {
    const dir = join(cliDir, "sessions", workspace, directory);
    mkdirSync(dir, {recursive: true});
    const path = join(dir, "session.v3.jsonl.zstd");
    writeFileSync(path, Buffer.from("this-is-not-zstd-data-0123456789abcdef", "utf8"));
    return {path};
  }

  test("失败消耗预算：本轮不再无界继续，下一轮坏文件零成本退避、健康文件恢复解析", () => {
    const cliDir = newCliDir();
    const corrupt = writeCorruptSession(cliDir, "--ws-f--", "sess-corrupt-0001");
    const healthy = writeSession(cliDir, "--ws-f--", "sess-healthy-0002", sessionJsonl({
      sessionId: "sess-healthy-0002",
      steps: [{ turn: 1, step: 1, responseId: "resp-f-healthy" }],
    }));
    // 坏文件 mtime 更新（unseen 按 mtime 倒序在前被先尝试），预算只容一次失败收取。
    utimesSync(corrupt.path, PINNED_MTIME_SECONDS + 4, PINNED_MTIME_SECONDS + 4);
    utimesSync(healthy.path, PINNED_MTIME_SECONDS + 2, PINNED_MTIME_SECONDS + 2);
    const adapter = createDshLocalSourceAdapter({
      cliDir,
      scanDecompressedBytesPerRound: 12_288,
      failureBackoffBaseMs: 60_000,
    });

    // 首轮：坏文件尝试失败并收取 4 MiB 预算 → 本轮终止（旧实现的 break 要求
    // 「至少成功一个」，全部失败的轮次会对扫描上限内文件逐一重解压）。
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED),
      [],
      "失败收取预算后本轮不得继续无界尝试",
    );
    // 第二轮：坏文件退避中零成本跳过，健康文件获得全额预算。
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(item => item.id),
      ["sess-healthy-0002_t1_s1"],
      "退避跳过坏文件后健康文件必须恢复解析",
    );
  });

  test("退避到期自动重试：修复后的文件恢复索引（瞬时失败自愈语义保持）", async () => {
    const cliDir = newCliDir();
    const corrupt = writeCorruptSession(cliDir, "--ws-g--", "sess-recover-0001");
    utimesSync(corrupt.path, PINNED_MTIME_SECONDS + 2, PINNED_MTIME_SECONDS + 2);
    const adapter = createDshLocalSourceAdapter({ cliDir, failureBackoffBaseMs: 60 });
    assert.deepEqual(adapter.readPendingCandidates(FLOOR, ALLOWED), []);

    // 原地修复为合法会话（size 变化的既有重解析条件不变，但仍受退避约束）。
    writeFileSync(corrupt.path, zstdCompressSync(Buffer.from(sessionJsonl({
      sessionId: "sess-recover-0001",
      steps: [{ turn: 1, step: 1, responseId: "resp-g-recovered" }],
    }), "utf8")));
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(item => item.id),
      [],
      "退避窗口内不得重试（否则活跃坏文件回到每轮重解压）",
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(
      adapter.readPendingCandidates(FLOOR, ALLOWED).map(item => item.id),
      ["sess-recover-0001_t1_s1"],
      "退避到期后修复文件必须恢复解析",
    );
  });
});
