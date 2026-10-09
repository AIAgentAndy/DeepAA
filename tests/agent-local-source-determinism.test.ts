import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { createZcodeLocalSourceAdapter } from "@/lib/agent-local-source/adapters/zcode";
import {
  extractPromptSkeleton,
  loadLatestPromptSkeleton,
  promptSkeletonId,
  recordPromptSkeleton,
} from "@/lib/agent-local-source/prompt-skeleton";
import {
  indexTimeline,
  rebuildExchangeFromTimeline,
} from "@/lib/agent-local-source/parts-rebuilder";
import type { SessionTimeline, TimelineMessage } from "@/lib/agent-local-source/types";
import { openDeepaaDatabase } from "@/lib/db/connection";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("zcode rollout 尾部窗口读取（去掉 64MiB 整文件拒绝）", () => {
  test("文件远大于尾部窗口时仍能命中窗口内记录，且不整文件读取", async () => {
    const cliDir = await makeTempDir("zcode-tail-");
    const rolloutDir = join(cliDir, "rollout");
    await mkdir(rolloutDir, { recursive: true });
    const sessionId = "sess_tail_window";
    const target = {
      type: "model_io",
      sessionId,
      turnId: "turn_target",
      requestId: "req_target",
      startedAt: "2026-09-16T15:07:13.589Z",
      request: { body: { model: "glm-5.3-flash", system: [{type: "text", text: "S"}], tools: [] } },
      response: { text: "final answer", reasoningText: "thinking", finishReason: "stop" },
    };
    // 大文件前缀（远超注入的 256KiB 窗口），目标记录在最后一行。
    const filler = `${JSON.stringify({type: "model_io", sessionId, turnId: "turn_old", startedAt: "2026-01-01T00:00:00.000Z"})}\n`;
    const fillerCount = Math.ceil((512 * 1024) / filler.length);
    await writeFile(
      join(rolloutDir, `model-io-${sessionId}.jsonl`),
      filler.repeat(fillerCount) + `${JSON.stringify(target)}\n`,
      "utf8",
    );
    const adapter = createZcodeLocalSourceAdapter({
      cliDir,
      rolloutTailBytes: 256 * 1024,
    });
    const detail = await adapter.readExchangeDetail({
      sessionId,
      turnId: "turn_target",
      startedAt: Date.parse("2026-09-16T15:07:13.589Z"),
    });
    assert.ok(detail, "尾部窗口内的记录必须命中（旧实现对超过上限的文件直接放弃）");
    assert.equal(detail.response?.text, "final answer");
    // reasoningText 历史上被 toDetail 丢弃，必须补回。
    assert.equal(detail.response?.reasoningText, "thinking");
  });

  test("窗口外的旧记录不被命中（读取确有界）", async () => {
    const cliDir = await makeTempDir("zcode-tail-old-");
    const rolloutDir = join(cliDir, "rollout");
    await mkdir(rolloutDir, { recursive: true });
    const sessionId = "sess_tail_old";
    const oldRecord = {
      type: "model_io",
      sessionId,
      turnId: "turn_old",
      startedAt: "2026-01-01T00:00:00.000Z",
      request: { body: { model: "glm-5.3-flash", system: [{type: "text", text: "S"}] } },
      response: { text: "old" },
    };
    const filler = `${JSON.stringify({type: "model_io", sessionId, turnId: "turn_filler", startedAt: "2026-02-01T00:00:00.000Z"})}\n`;
    await writeFile(
      join(rolloutDir, `model-io-${sessionId}.jsonl`),
      `${JSON.stringify(oldRecord)}\n` + filler.repeat(Math.ceil((256 * 1024) / filler.length)),
      "utf8",
    );
    const adapter = createZcodeLocalSourceAdapter({
      cliDir,
      rolloutTailBytes: 64 * 1024,
    });
    const detail = await adapter.readExchangeDetail({
      sessionId,
      turnId: "turn_old",
      startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(detail, undefined);
  });

  test("同一 Turn 内 session_title 与 main_turn 只差几毫秒时按 querySource 消歧", async () => {
    const cliDir = await makeTempDir("zcode-identity-");
    const rolloutDir = join(cliDir, "rollout");
    await mkdir(rolloutDir, { recursive: true });
    const sessionId = "sess_identity";
    const shared = {
      type: "model_io",
      sessionId,
      turnId: "turn_shared",
      model: {modelId: "GLM-5.3-Flash"},
      startedAt: "2026-09-16T23:20:54.306Z",
    };
    const records = [
      {
        ...shared,
        requestId: "req-title",
        querySource: "session_title",
        startedAt: "2026-09-16T23:20:54.306Z",
        request: {body: {model: "GLM-5.3-Flash", system: [{type: "text", text: "TITLE"}], messages: []}},
        response: {text: "标题"},
      },
      {
        ...shared,
        requestId: "req-main",
        querySource: "main_turn",
        startedAt: "2026-09-16T23:20:54.315Z",
        request: {
          body: {
            model: "GLM-5.3-Flash",
            system: [{type: "text", text: "S1"}, {type: "text", text: "S2"}],
            tools: [{name: "Bash"}],
            messages: [],
          },
        },
        response: {text: "主请求回答"},
      },
    ];
    await writeFile(
      join(rolloutDir, `model-io-${sessionId}.jsonl`),
      `${records.map(record => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const adapter = createZcodeLocalSourceAdapter({cliDir});
    // usage.started_at 早于两条记录（实测 23:20:54.301），只按邻近度会串到标题记录。
    const main = await adapter.readExchangeDetail({
      sessionId,
      turnId: "turn_shared",
      startedAt: Date.parse("2026-09-16T23:20:54.301Z"),
      querySource: "main_turn",
      modelId: "GLM-5.3-Flash",
    });
    assert.ok(main, "main_turn 记录必须命中");
    assert.match(main.requestRawBody ?? "", /"tools"/);
    assert.match(main.response?.text ?? "", /主请求回答/);
    const title = await adapter.readExchangeDetail({
      sessionId,
      turnId: "turn_shared",
      startedAt: Date.parse("2026-09-16T23:20:54.305Z"),
      querySource: "session_title",
    });
    assert.ok(title);
    assert.match(title.requestRawBody ?? "", /TITLE/);
  });

  test("readRecentRecords 返回尾部窗口内的记录（骨架清扫数据源）", async () => {
    const cliDir = await makeTempDir("zcode-recent-");
    const rolloutDir = join(cliDir, "rollout");
    await mkdir(rolloutDir, { recursive: true });
    const sessionId = "sess_recent";
    const lines = [1, 2, 3].map(index => JSON.stringify({
      type: "model_io",
      sessionId,
      turnId: `turn_${index}`,
      startedAt: `2026-09-16T15:0${index}:00.000Z`,
      request: {
        body: {
          model: "glm-5.3-flash",
          system: [{type: "text", text: `S${index}`}],
          tools: [{name: "Bash"}],
        },
      },
      response: { text: `answer ${index}` },
    }));
    await writeFile(
      join(rolloutDir, `model-io-${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
      "utf8",
    );
    const adapter = createZcodeLocalSourceAdapter({ cliDir });
    const recent = await adapter.readRecentRecords!(sessionId);
    assert.equal(recent.length, 3);
    assert.ok(recent.every(entry => entry.requestRawBody?.includes('"system"')));
  });
});

describe("请求骨架缓存（首见即存 + 会话级复用）", () => {
  test("提取骨架剥离 messages、保留 system/tools，并按 (agent,session,prompt) 去重落库", async () => {
    const dataDir = await makeTempDir("deepaa-skeleton-");
    const db = openDeepaaDatabase({ dataDir });
    try {
      const body = JSON.stringify({
        model: "GLM-5.3-Flash",
        system: [{type: "text", text: "You are ZCode"}],
        tools: [{name: "Bash"}, {name: "Read"}],
        thinking: {type: "enabled"},
        messages: [{role: "user", content: "hi"}],
      });
      const skeleton = extractPromptSkeleton(body);
      assert.ok(skeleton);
      assert.equal(skeleton.toolCount, 2);
      assert.ok(!skeleton.bodyJson.includes('"messages"'));

      recordPromptSkeleton(db, {
        agentId: "zcode",
        sessionId: "sess_a",
        promptSha256: skeleton.promptSha256,
        bodyJson: skeleton.bodyJson,
        toolCount: skeleton.toolCount,
      });
      recordPromptSkeleton(db, {
        agentId: "zcode",
        sessionId: "sess_a",
        promptSha256: skeleton.promptSha256,
        bodyJson: skeleton.bodyJson,
        toolCount: skeleton.toolCount,
      });
      const count = db.prepare(
        "SELECT COUNT(*) AS c FROM agent_prompt_skeletons WHERE session_id = 'sess_a'",
      ).get() as {c: number};
      assert.equal(count.c, 1);

      const loaded = loadLatestPromptSkeleton(db, "zcode", "sess_a");
      assert.ok(loaded);
      assert.equal(loaded.promptSha256, skeleton.promptSha256);
      assert.equal(loaded.toolCount, 2);
      assert.equal(loaded.skeletonId, promptSkeletonId({
        agentId: "zcode",
        sessionId: "sess_a",
        promptSha256: skeleton.promptSha256,
      }));
      // 会话隔离：其它 session 不得借用。
      assert.equal(loadLatestPromptSkeleton(db, "zcode", "sess_b"), undefined);
    } finally {
      db.close();
    }
  });

  test("无 system/tools 的请求体不产生骨架", () => {
    assert.equal(extractPromptSkeleton(JSON.stringify({model: "m", messages: []})), undefined);
    assert.equal(extractPromptSkeleton("not json"), undefined);
    assert.equal(extractPromptSkeleton(undefined), undefined);
    assert.equal(extractPromptSkeleton(JSON.stringify({tools: []})), undefined);
  });
});

describe("终态闸门（parts 未写完不得合成）", () => {
  function message(
    messageId: string,
    role: TimelineMessage["role"],
    finalized: boolean,
  ): TimelineMessage {
    return {
      messageId,
      role,
      visible: true,
      finalized,
      parts: role === "assistant"
        ? [{kind: "text", text: "x"}, ...(finalized ? [{kind: "step_finish" as const, reason: "stop"}] : [])]
        : [{kind: "text", text: "q"}],
    };
  }

  function timeline(messages: TimelineMessage[]): SessionTimeline {
    return {messages};
  }

  test("目标未终态 → responseFinalized=false", () => {
    const rebuilt = rebuildExchangeFromTimeline(
      indexTimeline(timeline([
        message("u1", "user", true),
        message("a1", "assistant", false),
      ])),
      "a1",
    );
    assert.ok(rebuilt);
    assert.equal(rebuilt.responseFinalized, false);
    assert.equal(rebuilt.contextFinalized, true);
  });

  test("更早的 assistant 未终态 → contextFinalized=false（回放上下文不完整）", () => {
    const rebuilt = rebuildExchangeFromTimeline(
      indexTimeline(timeline([
        message("u1", "user", true),
        message("a1", "assistant", false),
        message("u2", "user", true),
        message("a2", "assistant", true),
      ])),
      "a2",
    );
    assert.ok(rebuilt);
    assert.equal(rebuilt.responseFinalized, true);
    assert.equal(rebuilt.contextFinalized, false);
  });

  test("隐藏消息（如会话标题请求）未终态不影响回放终态判定", () => {
    const hidden = message("title", "assistant", false);
    hidden.visible = false;
    const rebuilt = rebuildExchangeFromTimeline(
      indexTimeline(timeline([
        hidden,
        message("u1", "user", true),
        message("a1", "assistant", true),
      ])),
      "a1",
    );
    assert.ok(rebuilt);
    assert.equal(rebuilt.contextFinalized, true);
    assert.equal(rebuilt.responseFinalized, true);
  });

  test("全部终态 → 两个标记都为 true", () => {
    const rebuilt = rebuildExchangeFromTimeline(
      indexTimeline(timeline([
        message("u1", "user", true),
        message("a1", "assistant", true),
        message("a2", "assistant", true),
      ])),
      "a2",
    );
    assert.ok(rebuilt);
    assert.equal(rebuilt.responseFinalized, true);
    assert.equal(rebuilt.contextFinalized, true);
    assert.deepEqual(rebuilt.responseContent, [{type: "text", text: "x"}]);
    assert.equal(rebuilt.stopReason, "stop");
  });
});
