import { describe, expect, test, vi } from "vitest";
import { resolveAgentPath } from "../src/lib/ingestion/thread-identity.js";
import { stableHash } from "../src/lib/harness/normalizer.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

describe("跨供应商 Session/Thread 身份解析", () => {
  test("Codex 同 Session 的根 Thread 与子 Thread 共享 Session 并建立父子关系", () => {
    const root = resolveAgentPath(codexExchange({ session: "s-1", thread: "s-1" }));
    const child = resolveAgentPath(codexExchange({
      session: "s-1",
      thread: "t-child",
      parentThread: "s-1",
      subagentKind: "reviewer",
    }));

    expect(child.agentSessionId).toBe(root.agentSessionId);
    expect(child.agentThreadId).not.toBe(root.agentThreadId);
    expect(child.parentAgentThreadId).toBe(root.agentThreadId);
    expect(root.isRootThread).toBe(true);
    expect(child.isRootThread).toBe(false);
    expect(child.displayName).toContain("reviewer");
    expect(child.displayName).toContain("t-child");
  });

  test("Session ID 对 Codex thread_id 变化不敏感", () => {
    const first = resolveAgentPath(codexExchange({ session: "s-stable", thread: "thread-a" }));
    const second = resolveAgentPath(codexExchange({ session: "s-stable", thread: "thread-b" }));

    expect(second.agentSessionId).toBe(first.agentSessionId);
    expect(second.agentThreadId).not.toBe(first.agentThreadId);
  });

  test("Codex 缺少 thread_id 时与 thread_id 等于 Session 的显式根合并", () => {
    const explicitRoot = resolveAgentPath(codexExchange({ session: "s-root", thread: "s-root" }));
    const implicitRoot = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        session_id: "s-root",
      },
    }));

    expect(implicitRoot.agentSessionId).toBe(explicitRoot.agentSessionId);
    expect(implicitRoot.agentThreadId).toBe(explicitRoot.agentThreadId);
    expect(implicitRoot.externalThreadId).toBeUndefined();
    expect(implicitRoot.parentAgentThreadId).toBeUndefined();
    expect(implicitRoot.isRootThread).toBe(true);
  });

  test("Codex 子 Thread 缺少 parent 时挂到明确 Session 对应的真实根", () => {
    const root = resolveAgentPath(codexExchange({ session: "s-orphan", thread: "s-orphan" }));
    const child = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        session_id: "s-orphan",
        thread_id: "child-orphan",
        "x-codex-turn-metadata": JSON.stringify({
          subagent_kind: "reviewer",
          thread_source: "subagent",
        }),
      },
    }));

    expect(child.agentThreadId).not.toBe(root.agentThreadId);
    expect(child.parentAgentThreadId).toBe(root.agentThreadId);
    expect(child.isRootThread).toBe(false);
    expect(child.confidence).toBe("high");
    expect(child.diagnostics).toContainEqual(expect.objectContaining({
      code: "codex-parent-root-inferred",
    }));
  });

  test("Codex thread_id 与 Session 不同即使未标记 subagent 也挂到真实根", () => {
    const root = resolveAgentPath(codexExchange({ session: "s-general-child", thread: "s-general-child" }));
    const child = resolveAgentPath(codexExchange({ session: "s-general-child", thread: "child-general" }));

    expect(child.parentAgentThreadId).toBe(root.agentThreadId);
    expect(child.isRootThread).toBe(false);
    expect(child.confidence).toBe("high");
  });

  test("内部 Session/Thread ID 严格使用公共稳定哈希公式", () => {
    const resolved = resolveAgentPath(codexExchange({ session: "s-formula", thread: "t-formula" }));
    // 2026-09-17 Agent 维度会话：Session 身份不再包含 targetId。
    const expectedSessionId = `asess-${stableHash({
      agentFingerprintId: resolved.agentFingerprintId,
      externalSessionIdentity: "s-formula",
    })}`;

    expect(resolved.agentSessionId).toBe(expectedSessionId);
    expect(resolved.agentThreadId).toBe(`athread-${stableHash({
      agentSessionId: expectedSessionId,
      providerThreadIdentity: "t-formula",
    })}`);
  });

  test("顶层 body.session_id 优先于 window 稳定分组身份", () => {
    const withWindow = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        "x-codex-window-id": "window-session:window-1",
      },
      body: { session_id: "body-session", thread_id: "body-thread" },
    }));
    const bodyOnly = resolveAgentPath(makeExchange({
      headers: { "user-agent": "codex-tui/0.1" },
      body: { session_id: "body-session", thread_id: "body-thread" },
    }));

    expect(withWindow.externalSessionId).toBe("body-session");
    expect(withWindow.sessionSource).toBe("session-body");
    expect(withWindow.agentSessionId).toBe(bodyOnly.agentSessionId);
  });

  test("明确 conversation ID 优先于 prompt_cache_key 稳定分组", () => {
    const resolved = resolveAgentPath(makeExchange({
      headers: { "user-agent": "OpenAI/JS 5" },
      body: { conversation: "conversation-1", prompt_cache_key: "cache-1" },
    }));

    expect(resolved.externalConversationId).toBe("conversation-1");
    expect(resolved.sessionSource).toBe("conversation-id");
  });

  test("Codex metadata.window_id 按前缀跨 capture 稳定分组且不同前缀不合并", () => {
    const first = resolveAgentPath(makeExchange({
      captureSessionId: "capture-window-a",
      headers: {
        "user-agent": "codex-tui/0.1",
        "x-codex-turn-metadata": JSON.stringify({ window_id: "window-session:0" }),
      },
    }));
    const second = resolveAgentPath(makeExchange({
      captureSessionId: "capture-window-b",
      headers: {
        "user-agent": "codex-tui/0.1",
        "x-codex-turn-metadata": JSON.stringify({ window_id: "window-session:0" }),
      },
    }));
    const otherWindow = resolveAgentPath(makeExchange({
      captureSessionId: "capture-window-c",
      headers: {
        "user-agent": "codex-tui/0.1",
        "x-codex-turn-metadata": JSON.stringify({ window_id: "other-window:0" }),
      },
    }));
    const expectedSessionId = `asess-${stableHash({
      agentFingerprintId: first.agentFingerprintId,
      externalSessionIdentity: "window-session",
    })}`;

    expect(first).toMatchObject({
      agentSessionId: expectedSessionId,
      sessionSource: "provider-grouping",
      confidence: "high",
    });
    expect(second.agentSessionId).toBe(expectedSessionId);
    expect(second.agentThreadId).toBe(first.agentThreadId);
    expect(otherWindow.agentSessionId).not.toBe(expectedSessionId);
  });

  test("Codex window 分组的显式根、隐式根和孤儿子 Thread 共用唯一真根", () => {
    const explicitRoot = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        thread_id: "window-session",
        "x-codex-turn-metadata": JSON.stringify({ window_id: "window-session:0" }),
      },
    }));
    const implicitRoot = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        "x-codex-turn-metadata": JSON.stringify({ window_id: "window-session:0" }),
      },
    }));
    const child = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        thread_id: "window-child",
        "x-codex-turn-metadata": JSON.stringify({
          window_id: "window-session:0",
          subagent_kind: "reviewer",
          thread_source: "subagent",
        }),
      },
    }));

    expect(implicitRoot.agentSessionId).toBe(explicitRoot.agentSessionId);
    expect(child.agentSessionId).toBe(explicitRoot.agentSessionId);
    expect(explicitRoot.externalSessionId).toBeUndefined();
    expect(implicitRoot.externalThreadId).toBeUndefined();
    expect(implicitRoot.agentThreadId).toBe(explicitRoot.agentThreadId);
    expect(child.parentAgentThreadId).toBe(explicitRoot.agentThreadId);
    expect(child.isRootThread).toBe(false);
    expect(new Set([explicitRoot, implicitRoot, child]
      .filter(item => item.isRootThread)
      .map(item => item.agentThreadId))).toEqual(new Set([explicitRoot.agentThreadId]));
  });

  test("Codex conversation 身份同样统一显式与隐式根", () => {
    const explicitRoot = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        thread_id: "conversation-root",
      },
      body: { conversation: "conversation-root" },
    }));
    const implicitRoot = resolveAgentPath(makeExchange({
      headers: { "user-agent": "codex-tui/0.1" },
      body: { conversation: "conversation-root" },
    }));

    expect(implicitRoot.agentSessionId).toBe(explicitRoot.agentSessionId);
    expect(implicitRoot.agentThreadId).toBe(explicitRoot.agentThreadId);
    expect(implicitRoot.externalSessionId).toBeUndefined();
    expect(implicitRoot.externalConversationId).toBe("conversation-root");
  });

  test("resolveAgentPath 对同一 Codex metadata header 只解析一次 JSON", () => {
    const metadataValue = JSON.stringify({
      session_id: "s-parse-once",
      thread_id: "s-parse-once",
      thread_source: "user",
    });
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      resolveAgentPath(makeExchange({
        headers: {
          "user-agent": "codex-tui/0.1",
          "x-codex-turn-metadata": metadataValue,
        },
      }));

      const metadataParseCalls = parseSpy.mock.calls.filter(([value]) => value === metadataValue);
      expect(metadataParseCalls).toHaveLength(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  test("Claude 缺少 agent_id 时多次解析得到同一个默认根 Thread", () => {
    const first = resolveAgentPath(claudeExchange({ session: "c-1" }));
    const second = resolveAgentPath(claudeExchange({ session: "c-1" }));

    expect(second.agentSessionId).toBe(first.agentSessionId);
    expect(second.agentThreadId).toBe(first.agentThreadId);
    expect(first.isRootThread).toBe(true);
    expect(first.threadSource).toBe("default-root");
  });

  test("Claude 只用明确的 agent_id 和 parent_agent_id 映射子父 Thread", () => {
    const parent = resolveAgentPath(claudeExchange({ session: "c-2", agentId: "agent-parent" }));
    const child = resolveAgentPath(claudeExchange({
      session: "c-2",
      agentId: "agent-child",
      parentAgentId: "agent-parent",
    }));

    expect(child.agentSessionId).toBe(parent.agentSessionId);
    expect(child.agentThreadId).not.toBe(parent.agentThreadId);
    expect(child.parentAgentThreadId).toBe(parent.agentThreadId);
    expect(child.externalAgentId).toBe("agent-child");
    expect(child.externalParentAgentId).toBe("agent-parent");
    expect(child.isRootThread).toBe(false);
    expect(child.displayName).toContain("agent-child");
  });

  test("Claude 子代理缺少父 metadata 时仍显式返回同 Session 的确定性真根", () => {
    const root = resolveAgentPath(claudeExchange({ session: "c-root-id" }));
    const child = resolveAgentPath(claudeExchange({
      session: "c-root-id",
      agentId: "agent-without-parent",
    }));

    expect(child.rootAgentThreadId).toBe(root.agentThreadId);
    expect(child.rootAgentThreadId).not.toBe(child.agentThreadId);
  });

  test("OpenCode x-opencode-session 提供 exact Session 身份且 Thread 恒为根", () => {
    const resolved = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "opencode/0.2",
        "x-opencode-session": "ses_123",
      },
    }));

    expect(resolved).toMatchObject({
      agentName: "opencode",
      externalSessionId: "ses_123",
      sessionSource: "session-header",
      threadSource: "default-root",
      isRootThread: true,
      confidence: "exact",
    });
  });

  test("OpenCode x-parent-session-id 只记录外部 Session 级父关系，不推断 Thread 父子", () => {
    const resolved = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "opencode/0.2",
        "x-opencode-session": "ses_child",
        "x-parent-session-id": "ses_parent",
      },
    }));

    expect(resolved.externalParentAgentId).toBe("ses_parent");
    expect(resolved.isRootThread).toBe(true);
    expect(resolved.parentAgentThreadId).toBeUndefined();
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({
      code: "opencode-parent-session-header",
    }));
  });

  test("dsh x-deepseek-harness-session-id 提供 exact Session 身份且 Thread 为根", () => {
    const resolved = resolveAgentPath(makeExchange({
      path: "/v1/chat/completions",
      headers: {
        "user-agent": "deepseek-harness/1.0",
        "x-deepseek-harness-session-id": "session-42",
      },
      body: {model: "deepseek-v4", messages: []},
    }));

    expect(resolved).toMatchObject({
      agentName: "dsh",
      externalSessionId: "session-42",
      sessionSource: "session-header",
      threadSource: "default-root",
      isRootThread: true,
      confidence: "exact",
    });
  });

  test("routing.agent 优先于头部猜测作为 Agent 指纹", () => {
    const resolved = resolveAgentPath(makeExchange({
      routingAgent: "dsh",
      path: "/v1/chat/completions",
      headers: {
        "user-agent": "claude-cli/1.0",
        "x-claude-code-session-id": "ignored-claude-session",
      },
      body: {model: "deepseek-v4", messages: []},
    }));

    expect(resolved.agentName).toBe("dsh");
    expect(resolved.agentFingerprintId).toBe("fp-dsh");
  });

  test("Claude 不从嵌套内容猜测 agent_id", () => {
    const resolved = resolveAgentPath(claudeExchange({
      session: "c-nested",
      nestedAgentId: "nested-agent",
    }));

    expect(resolved.externalAgentId).toBeUndefined();
    expect(resolved.threadSource).toBe("default-root");
    expect(resolved.isRootThread).toBe(true);
  });

  test("其他 Agent 使用确定性的 default-root", () => {
    const exchange = makeExchange({
      headers: { "user-agent": "OpenAI/JS 5" },
      body: { conversation: "openai-conversation" },
    });

    const first = resolveAgentPath(exchange);
    const second = resolveAgentPath(exchange);

    expect(second.agentThreadId).toBe(first.agentThreadId);
    expect(first.threadSource).toBe("default-root");
    expect(first.isRootThread).toBe(true);
  });

  test("无 Session 身份时按 captureSessionId 低置信回退且不同 capture 不混合", () => {
    const first = resolveAgentPath(makeExchange({ captureSessionId: "capture-a" }));
    const second = resolveAgentPath(makeExchange({ captureSessionId: "capture-b" }));

    expect(second.agentSessionId).not.toBe(first.agentSessionId);
    expect(first.sessionSource).toBe("capture-session");
    expect(first.confidence).toBe("low");
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      code: "session-identity-capture-fallback",
    }));
  });

  test("captureSessionId 回退会 trim 非空值", () => {
    const padded = resolveAgentPath(makeExchange({
      exchangeId: "capture-trimmed:ex-padded",
      captureSessionId: "  capture-trimmed  ",
    }));
    const normalized = resolveAgentPath(makeExchange({
      exchangeId: "capture-trimmed:ex-normalized",
      captureSessionId: "capture-trimmed",
    }));

    expect(padded.agentSessionId).toBe(normalized.agentSessionId);
  });

  test("空白 captureSessionId 按 exchangeId 稳定隔离并写诊断", () => {
    const first = resolveAgentPath(makeExchange({
      exchangeId: "blank-capture:ex-1",
      captureSessionId: "   ",
    }));
    const second = resolveAgentPath(makeExchange({
      exchangeId: "blank-capture:ex-2",
      captureSessionId: "   ",
    }));

    expect(second.agentSessionId).not.toBe(first.agentSessionId);
    expect(first.confidence).toBe("low");
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      code: "capture-session-id-invalid-fallback",
    }));
  });

  test("capture 与 exchange ID 都空白时 Session fallback 不受正文 thread_id 影响", () => {
    const first = resolveAgentPath(makeExchange({
      exchangeId: "   ",
      captureSessionId: "   ",
      headers: { "user-agent": "codex-tui/0.1" },
      body: { model: "gpt-5", thread_id: "thread-a" },
      requestBodySha256: "a".repeat(64),
    }));
    const second = resolveAgentPath(makeExchange({
      exchangeId: "   ",
      captureSessionId: "   ",
      headers: { "user-agent": "codex-tui/0.1" },
      body: { model: "gpt-5", thread_id: "thread-b" },
      requestBodySha256: "b".repeat(64),
    }));

    expect(second.agentSessionId).toBe(first.agentSessionId);
    expect(second.agentThreadId).not.toBe(first.agentThreadId);
    expect(first).toMatchObject({
      sessionSource: "capture-session",
      confidence: "low",
    });
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      code: "capture-session-id-invalid-fallback",
    }));
  });

  test("匿名 Session fallback 用 sequence 或 capturedAt 隔离不同 exchange", () => {
    const base = resolveAgentPath(makeExchange({
      exchangeId: " ",
      captureSessionId: " ",
      sequence: 7,
      capturedAt: "2026-07-17T01:00:00.000Z",
    }));
    const otherSequence = resolveAgentPath(makeExchange({
      exchangeId: " ",
      captureSessionId: " ",
      sequence: 8,
      capturedAt: "2026-07-17T01:00:00.000Z",
    }));
    const otherTime = resolveAgentPath(makeExchange({
      exchangeId: " ",
      captureSessionId: " ",
      sequence: 7,
      capturedAt: "2026-07-17T02:00:00.000Z",
    }));

    expect(otherSequence.agentSessionId).not.toBe(base.agentSessionId);
    expect(otherTime.agentSessionId).not.toBe(base.agentSessionId);
  });

  test("匿名 Session fallback 用 completedAt 隔离 capturedAt 与 sequence 相同的 exchange", () => {
    const first = resolveAgentPath(makeExchange({
      exchangeId: " ",
      captureSessionId: " ",
      sequence: 7,
      capturedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:00:01.000Z",
    }));
    const second = resolveAgentPath(makeExchange({
      exchangeId: " ",
      captureSessionId: " ",
      sequence: 7,
      capturedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:00:02.000Z",
    }));

    expect(second.agentSessionId).not.toBe(first.agentSessionId);
  });

  test("匿名 Session fallback 保留非法 sequence 原值以避免混合", () => {
    const sessionIds = [-1, Number.NaN, Number.POSITIVE_INFINITY].map(sequence => (
      resolveAgentPath(makeExchange({
        exchangeId: " ",
        captureSessionId: " ",
        sequence,
        capturedAt: " ",
        completedAt: " ",
      })).agentSessionId
    ));

    expect(new Set(sessionIds).size).toBe(sessionIds.length);
  });

  test("Codex 子 Thread 父身份自引用时改挂真实根并写诊断", () => {
    const root = resolveAgentPath(codexExchange({ session: "s-self", thread: "s-self" }));
    const resolved = resolveAgentPath(codexExchange({
      session: "s-self",
      thread: "thread-self",
      parentThread: "thread-self",
      subagentKind: "reviewer",
    }));

    expect(resolved.parentAgentThreadId).toBe(root.agentThreadId);
    expect(resolved.parentAgentThreadId).not.toBe(resolved.agentThreadId);
    expect(resolved.isRootThread).toBe(false);
    expect(resolved.confidence).toBe("high");
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({
      code: "thread-parent-self-reference",
    }));
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({
      code: "codex-parent-root-inferred",
    }));
  });

  test("Codex 根 Thread 父身份自引用时删除父关系并保持根", () => {
    const resolved = resolveAgentPath(codexExchange({
      session: "s-root-self",
      thread: "s-root-self",
      parentThread: "s-root-self",
    }));

    expect(resolved.parentAgentThreadId).toBeUndefined();
    expect(resolved.isRootThread).toBe(true);
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({
      code: "thread-parent-self-reference",
    }));
  });

  test("私有默认根不会与真实 external thread literal default-root 碰撞", () => {
    const privateRoot = resolveAgentPath(makeExchange({
      headers: { "user-agent": "codex-tui/0.1" },
      body: { conversation: "conversation-private-root" },
    }));
    const externalLiteral = resolveAgentPath(makeExchange({
      headers: {
        "user-agent": "codex-tui/0.1",
        thread_id: "default-root",
      },
      body: { conversation: "conversation-private-root" },
    }));

    expect(externalLiteral.agentSessionId).toBe(privateRoot.agentSessionId);
    expect(externalLiteral.externalThreadId).toBe("default-root");
    expect(privateRoot.externalThreadId).toBeUndefined();
    expect(externalLiteral.agentThreadId).not.toBe(privateRoot.agentThreadId);
  });

  test("相同外部 Session 在不同 target 下合并为同一会话（2026-09-17 Agent 维度会话）", () => {
    const first = resolveAgentPath(codexExchange({ session: "shared", thread: "shared", targetId: "target-a" }));
    const second = resolveAgentPath(codexExchange({ session: "shared", thread: "shared", targetId: "target-b" }));

    expect(second.agentSessionId).toBe(first.agentSessionId);
    expect(second.agentThreadId).toBe(first.agentThreadId);
  });

  test("相同 target 和外部 Session 在不同 Agent 指纹下不会碰撞", () => {
    const codex = resolveAgentPath(codexExchange({ session: "shared", thread: "shared", targetId: "shared-target" }));
    const claude = resolveAgentPath(claudeExchange({ session: "shared", targetId: "shared-target" }));

    expect(claude.agentFingerprintId).not.toBe(codex.agentFingerprintId);
    expect(claude.agentSessionId).not.toBe(codex.agentSessionId);
    expect(claude.agentThreadId).not.toBe(codex.agentThreadId);
  });

  test("ZCode 主会话与 subagent 共享 trace-id 时归并同一 Session 且子代理挂根 Thread", () => {
    const main = resolveAgentPath(zcodeExchange({ trace: "trace-z1", session: "sess-main-1", sessionType: "main" }));
    const subagent = resolveAgentPath(zcodeExchange({ trace: "trace-z1", session: "sess-sub-1", sessionType: "subagent" }));

    expect(subagent.agentSessionId).toBe(main.agentSessionId);
    expect(main.isRootThread).toBe(true);
    expect(subagent.isRootThread).toBe(false);
    expect(subagent.agentThreadId).not.toBe(main.agentThreadId);
    expect(subagent.parentAgentThreadId).toBe(main.agentThreadId);
    expect(subagent.rootAgentThreadId).toBe(main.agentThreadId);
    expect(subagent.displayName).toContain("ZCode 子代理");
    expect(subagent.displayName).toContain("sess-sub");
    expect(subagent.externalThreadId).toBe("sess-sub-1");
    expect(subagent.confidence).toBe("exact");
  });

  test("ZCode Session 内部 ID 由 trace-id 推导，与 x-session-id 无关", () => {
    const main = resolveAgentPath(zcodeExchange({ trace: "trace-formula", session: "sess-formula-main" }));
    const expectedSessionId = `asess-${stableHash({
      agentFingerprintId: main.agentFingerprintId,
      externalSessionIdentity: "trace-formula",
    })}`;

    expect(main.agentSessionId).toBe(expectedSessionId);
  });

  test("ZCode 并行主会话（不同 trace）不互相归并", () => {
    const firstMain = resolveAgentPath(zcodeExchange({ trace: "trace-a", session: "sess-window-a", sessionType: "main" }));
    const firstSub = resolveAgentPath(zcodeExchange({ trace: "trace-a", session: "sess-sub-a", sessionType: "subagent" }));
    const secondMain = resolveAgentPath(zcodeExchange({ trace: "trace-b", session: "sess-window-b", sessionType: "main" }));
    const secondSub = resolveAgentPath(zcodeExchange({ trace: "trace-b", session: "sess-sub-b", sessionType: "subagent" }));

    expect(secondMain.agentSessionId).not.toBe(firstMain.agentSessionId);
    expect(secondSub.agentSessionId).not.toBe(firstMain.agentSessionId);
    expect(firstSub.agentSessionId).toBe(firstMain.agentSessionId);
    expect(secondSub.agentSessionId).toBe(secondMain.agentSessionId);
    expect(secondSub.parentAgentThreadId).toBe(secondMain.agentThreadId);
    expect(firstSub.parentAgentThreadId).not.toBe(secondMain.agentThreadId);
  });

  test("ZCode 导入行子代理（sess_subagent_agent_ 前缀）显示名取 uuid 段，不同子代理可区分", () => {
    // 2026-09-17 实测回归：本地导入的子代理外部 id 为 sess_subagent_agent_<uuid>，
    // 直接 slice(0,8) 会让多个子代理线程全部显示成 "ZCode 子代理 (sess_sub)"。
    const first = resolveAgentPath(zcodeExchange({
      trace: "trace-imp",
      session: "sess_subagent_agent_4b1ccb16-bc26-4422-b0aa-0aa5977c6c76",
      sessionType: "subagent",
    }));
    const second = resolveAgentPath(zcodeExchange({
      trace: "trace-imp",
      session: "sess_subagent_agent_e3afbba6-0c2f-4d85-a6ce-4909d1623b22",
      sessionType: "subagent",
    }));

    expect(first.displayName).toBe("ZCode 子代理 (4b1ccb16)");
    expect(second.displayName).toBe("ZCode 子代理 (e3afbba6)");
    expect(first.displayName).not.toBe(second.displayName);
  });

  test("ZCode externalSessionId 只由 main/other 请求回填主会话 uuid", () => {
    const main = resolveAgentPath(zcodeExchange({ trace: "trace-display", session: "sess-display-main", sessionType: "main" }));
    const subagent = resolveAgentPath(zcodeExchange({ trace: "trace-display", session: "sess-display-sub", sessionType: "subagent" }));
    const auxiliary = resolveAgentPath(zcodeExchange({ trace: "trace-display", session: "sess-display-main", sessionType: "other" }));

    expect(main.externalSessionId).toBe("sess-display-main");
    expect(subagent.externalSessionId).toBeUndefined();
    expect(auxiliary.externalSessionId).toBe("sess-display-main");
  });

  test("ZCode subagent 请求先于 main 到达时身份仍稳定且共享同一根", () => {
    const subagentFirst = resolveAgentPath(zcodeExchange({ trace: "trace-order", session: "sess-order-sub", sessionType: "subagent" }));
    const mainLater = resolveAgentPath(zcodeExchange({ trace: "trace-order", session: "sess-order-main", sessionType: "main" }));

    expect(mainLater.agentSessionId).toBe(subagentFirst.agentSessionId);
    expect(mainLater.agentThreadId).toBe(subagentFirst.rootAgentThreadId);
    expect(subagentFirst.parentAgentThreadId).toBe(mainLater.agentThreadId);
  });

  test("ZCode 无 trace-id 时退回 x-session-id 独立 Session 且 Thread 为根", () => {
    const resolved = resolveAgentPath(makeExchange({
      routingAgent: "zcode",
      path: "/zcode/v1/messages",
      headers: {
        "user-agent": "ZCode/1.0",
        "x-session-id": "sess-no-trace",
      },
      body: { model: "glm-5.3", messages: [] },
    }));

    expect(resolved).toMatchObject({
      agentName: "zcode",
      externalSessionId: "sess-no-trace",
      sessionSource: "session-header",
      threadSource: "default-root",
      isRootThread: true,
      confidence: "exact",
    });
  });
});

function codexExchange(options: {
  session: string;
  thread: string;
  parentThread?: string;
  subagentKind?: string;
  targetId?: string;
}): RawCapturedExchange {
  return makeExchange({
    targetId: options.targetId,
    headers: {
      "user-agent": "codex-tui/0.1",
      session_id: options.session,
      thread_id: options.thread,
      "x-codex-turn-metadata": JSON.stringify({
        session_id: options.session,
        thread_id: options.thread,
        parent_thread_id: options.parentThread,
        subagent_kind: options.subagentKind,
        thread_source: options.parentThread ? "subagent" : "user",
      }),
    },
  });
}

function claudeExchange(options: {
  session: string;
  agentId?: string;
  parentAgentId?: string;
  nestedAgentId?: string;
  targetId?: string;
}): RawCapturedExchange {
  return makeExchange({
    targetId: options.targetId,
    targetName: "Anthropic",
    targetFormatHint: "anthropic",
    path: "/v1/messages",
    headers: {
      "user-agent": "claude-cli/1.0",
      "x-claude-code-session-id": options.session,
    },
    body: {
      model: "claude-sonnet",
      agent_id: options.agentId,
      parent_agent_id: options.parentAgentId,
      messages: options.nestedAgentId
        ? [{ role: "user", content: [{ type: "text", text: "inspect", agent_id: options.nestedAgentId }] }]
        : [],
    },
  });
}

function zcodeExchange(options: {
  trace: string;
  session: string;
  sessionType?: "main" | "subagent" | "other";
  targetId?: string;
}): RawCapturedExchange {
  return makeExchange({
    targetId: options.targetId,
    targetName: "BigModel",
    targetFormatHint: "anthropic",
    path: "/zcode/v1/messages",
    routingAgent: "zcode",
    wireApi: "messages",
    headers: {
      "user-agent": "ZCode/1.0",
      "x-session-id": options.session,
      "x-zcode-trace-id": options.trace,
      "x-zcode-session-type": options.sessionType ?? "main",
    },
    body: { model: "glm-5.3", messages: [] },
  });
}

function makeExchange(options: {
  exchangeId?: string;
  captureSessionId?: string;
  sequence?: number;
  capturedAt?: string;
  completedAt?: string;
  requestBodySha256?: string;
  responseBodySha256?: string;
  targetId?: string;
  targetName?: string;
  targetFormatHint?: RawCapturedExchange["routing"]["targetFormatHint"];
  routingAgent?: string;
  wireApi?: RawCapturedExchange["routing"]["wireApi"];
  path?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
} = {}): RawCapturedExchange {
  const body = options.body ?? { model: "gpt-5", input: [] };
  const path = options.path ?? "/responses";
  return {
    schemaVersion: 1,
    exchangeId: options.exchangeId ?? `${options.captureSessionId ?? "capture-default"}:ex-1`,
    captureSessionId: options.captureSessionId ?? "capture-default",
    sequence: options.sequence ?? 1,
    capturedAt: options.capturedAt ?? "2026-07-17T00:00:00.000Z",
    completedAt: options.completedAt ?? "2026-07-17T00:00:01.000Z",
    durationMs: 1_000,
    routing: {
      targetId: options.targetId ?? "target-default",
      targetName: options.targetName ?? "OpenAI",
      targetFormatHint: options.targetFormatHint ?? "openai",
      localUrl: `http://localhost:3211${path}`,
      upstreamUrl: `https://example.test${path}`,
      localPath: path,
      upstreamPath: path,
      method: "POST",
      ...(options.routingAgent ? {agent: options.routingAgent} : {}),
      ...(options.wireApi ? {wireApi: options.wireApi} : {}),
    },
    request: {
      headers: lowerHeaders(options.headers ?? {}),
      rawBody: JSON.stringify(body),
      parsedBody: body,
      bodySizeBytes: JSON.stringify(body).length,
      bodySha256: options.requestBodySha256 ?? "0".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: "{}",
      parsedBody: {},
      bodySizeBytes: 2,
      bodySha256: options.responseBodySha256 ?? "1".repeat(64),
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

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
