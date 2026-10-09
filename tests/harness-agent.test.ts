import { describe, expect, test } from "vitest";
import {
  codexTurnMetadata,
  deriveHarnessDataset,
  deriveHarnessLearningInsights,
  diffContextSnapshots,
  normalizeExchange,
} from "../src/lib/harness/index.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

describe("MVP-B agent session, turn, step and context derivation", () => {
  test("Codex metadata 保留既有字段并按显式 header、metadata、顶层 body 顺序解析 Thread 字段", () => {
    const raw = makeExchange({
      exchangeId: "cap:ex-101",
      path: "/responses",
      headers: {
        "user-agent": "codex-tui/0.1",
        "thread-id": "thread-header",
        "parent-thread-id": "parent-header",
        "x-codex-turn-metadata": JSON.stringify({
          turn_id: "turn-header",
          request_kind: "turn",
          thread_id: "thread-metadata",
          parent_thread_id: "parent-metadata",
          subagent_kind: "reviewer",
          thread_source: "subagent",
        }),
      },
      request: {
        thread_id: "thread-body",
        parent_thread_id: "parent-body",
        subagent_kind: "body-kind",
        thread_source: "body-source",
      },
      response: {},
    });

    expect(codexTurnMetadata(raw)).toEqual({
      turnId: "turn-header",
      requestKind: "turn",
      threadId: "thread-header",
      parentThreadId: "parent-header",
      subagentKind: "reviewer",
      threadSource: "subagent",
    });
  });

  test("Codex metadata 缺少 header 字段时只回退到顶层 body", () => {
    const raw = makeExchange({
      exchangeId: "cap:ex-102",
      path: "/responses",
      headers: { "user-agent": "codex-tui/0.1" },
      request: {
        thread_id: "thread-body",
        parent_thread_id: "parent-body",
        subagent_kind: "explorer",
        thread_source: "body-source",
        input: [{ type: "message", content: [{ nested: { thread_id: "nested-thread" } }] }],
      },
      response: {},
    });

    expect(codexTurnMetadata(raw)).toEqual({
      threadId: "thread-body",
      parentThreadId: "parent-body",
      subagentKind: "explorer",
      threadSource: "body-source",
    });
  });

  test("Codex metadata 无有效字段时保持返回空对象", () => {
    const raw = makeExchange({
      exchangeId: "cap:ex-103",
      path: "/responses",
      headers: { "user-agent": "codex-tui/0.1" },
      request: { input: [] },
      response: {},
    });

    expect(Object.keys(codexTurnMetadata(raw))).toEqual([]);
  });

  test("groups Claude Code exchanges by exact session header and keeps count_tokens auxiliary out of steps", () => {
    const exchanges = [
      makeExchange({
        exchangeId: "cap:ex-1",
        path: "/v1/messages",
        headers: {
          "user-agent": "claude-cli/1.0",
          "x-claude-code-session-id": "claude-session-1",
          "anthropic-version": "2023-06-01",
        },
        request: {
          model: "claude-sonnet",
          system: "You are a coding agent.",
          messages: [{ role: "user", content: [{ type: "text", text: "Read package" }] }],
          tools: [{ name: "Read", input_schema: { type: "object" } }],
        },
        response: {
          type: "message",
          model: "claude-sonnet",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "package.json" } }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-2",
        path: "/v1/messages/count_tokens",
        headers: {
          "user-agent": "claude-cli/1.0",
          "x-claude-code-session-id": "claude-session-1",
          "anthropic-version": "2023-06-01",
        },
        request: { model: "claude-sonnet", messages: [] },
        response: { input_tokens: 123 },
      }),
      makeExchange({
        exchangeId: "cap:ex-3",
        path: "/v1/messages",
        headers: {
          "user-agent": "claude-cli/1.0",
          "x-claude-code-session-id": "claude-session-1",
          "anthropic-version": "2023-06-01",
        },
        request: {
          model: "claude-sonnet",
          system: "You are a coding agent.",
          messages: [
            { role: "user", content: [{ type: "text", text: "Read package" }] },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "package.json" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "package contents" }] },
          ],
          tools: [{ name: "Read", input_schema: { type: "object" } }],
        },
        response: {
          type: "message",
          model: "claude-sonnet",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done" }],
          usage: { input_tokens: 130, output_tokens: 4 },
        },
      }),
    ];

    const derived = deriveHarnessDataset(exchanges);

    expect(derived.agentSessions).toHaveLength(1);
    expect(derived.agentSessions[0]).toMatchObject({
      source: "agent-session-header",
      externalSessionId: "claude-session-1",
      confidence: "exact",
      exchangeIds: ["cap:ex-1", "cap:ex-3"],
      auxiliaryExchangeIds: ["cap:ex-2"],
    });
    expect(derived.agentTurns).toHaveLength(1);
    expect(derived.steps.map(step => step.exchangeId)).toEqual(["cap:ex-1", "cap:ex-3"]);
    expect(derived.steps.map(step => step.index)).toEqual([1, 2]);
    expect(derived.auxiliaryExchanges).toHaveLength(1);
    expect(derived.steps[0]).toMatchObject({
      phase: "tool_request",
      requestAction: "user_prompt",
      responseAction: "tool_use",
      toolUseIds: ["toolu_1"],
    });
    expect(derived.steps[1]).toMatchObject({
      phase: "final_answer",
      requestAction: "tool_result",
      responseAction: "final",
      toolResultIds: ["toolu_1"],
    });
  });

  test("groups Codex by session_id while preserving thread_id and remote state references in snapshots", () => {
    const exchanges = [
      makeExchange({
        exchangeId: "cap:ex-10",
        path: "/responses",
        headers: {
          "user-agent": "codex-tui/0.1",
          session_id: "codex-session-1",
          thread_id: "thread-a",
          "x-client-request-id": "req-a",
        },
        request: {
          model: "gpt-5",
          input: [{ type: "message", role: "user", content: "Inspect project" }],
          tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        },
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"package.json\"}" }],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-11",
        path: "/responses",
        headers: {
          "user-agent": "codex-tui/0.1",
          session_id: "codex-session-1",
          thread_id: "thread-a",
          "x-client-request-id": "req-b",
        },
        request: {
          model: "gpt-5",
          previous_response_id: "resp_1",
          input: [
            { type: "message", role: "user", content: "Inspect project" },
            { type: "function_call_output", call_id: "call_1", output: "package contents" },
          ],
          tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        },
        response: {
          id: "resp_2",
          object: "response",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
        },
      }),
    ];

    const derived = deriveHarnessDataset(exchanges);

    expect(derived.agentSessions[0]).toMatchObject({
      source: "agent-session-header",
      externalSessionId: "codex-session-1",
      externalThreadId: "thread-a",
      confidence: "exact",
    });
    expect(derived.agentSessions[0]?.evidence.map(item => item.kind)).toContain("thread-header");
    expect(derived.steps).toHaveLength(2);
    expect(derived.contextSnapshots[1]?.remoteStateReferences).toEqual([
      expect.objectContaining({
        kind: "previous_response_id",
        value: "resp_1",
        observability: "remote_context_not_fully_observable",
      }),
    ]);
    expect(derived.steps[1]).toMatchObject({
      requestAction: "tool_result",
      responseAction: "final",
      toolResultIds: ["call_1"],
    });
  });

  test("groups current Codex captures by hyphenated session headers instead of tool-link fallback", () => {
    const sessionId = "019e83bf-3062-71f1-8d34-7d6638f879cf";
    const exchanges = [
      makeExchange({
        exchangeId: "cap:ex-115",
        path: "/responses",
        headers: {
          "user-agent": "codex-tui/0.1",
          "session-id": sessionId,
          "thread-id": sessionId,
          "x-client-request-id": sessionId,
          "x-codex-turn-metadata": JSON.stringify({
            session_id: sessionId,
            thread_id: sessionId,
            turn_id: "turn-1",
            request_kind: "turn",
            thread_source: "user",
          }),
        },
        request: {
          model: "gpt-5.5",
          prompt_cache_key: sessionId,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] }],
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{}" }],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-116",
        path: "/responses",
        headers: {
          "user-agent": "codex-tui/0.1",
          "session-id": sessionId,
          "thread-id": sessionId,
          "x-client-request-id": sessionId,
        },
        request: {
          model: "gpt-5.5",
          prompt_cache_key: sessionId,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
            { type: "function_call_output", call_id: "call_1", output: "skill loaded" },
          ],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "你好，我在 EffiRoom 仓库里。" }] }],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-117",
        path: "/responses",
        headers: {
          "user-agent": "codex-tui/0.1",
          "session-id": sessionId,
          "thread-id": sessionId,
          "x-client-request-id": sessionId,
        },
        request: {
          model: "gpt-5.5",
          prompt_cache_key: sessionId,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好，我在 EffiRoom 仓库里。" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "你的底层是什么模型？" }] },
          ],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "我是 Codex，一个基于 GPT-5 的编码智能体。" }] }],
        },
      }),
    ];

    const derived = deriveHarnessDataset(exchanges);

    expect(derived.agentSessions).toHaveLength(1);
    expect(derived.agentSessions[0]).toMatchObject({
      source: "agent-session-header",
      externalSessionId: sessionId,
      externalThreadId: sessionId,
      confidence: "exact",
      exchangeIds: ["cap:ex-115", "cap:ex-116", "cap:ex-117"],
    });
    expect(derived.agentTurns[0]).toMatchObject({
      source: "agent-session",
      externalSessionId: sessionId,
      exchangeIds: ["cap:ex-115", "cap:ex-116", "cap:ex-117"],
    });
    expect(derived.steps.map(step => step.exchangeId)).toEqual(["cap:ex-115", "cap:ex-116", "cap:ex-117"]);
    expect(derived.steps[0]).toMatchObject({
      codexTurnId: "turn-1",
      codexRequestKind: "turn",
      codexThreadSource: "user",
    });
    expect(derived.contextSnapshots).toHaveLength(3);
    expect(derived.stepDiffs).toHaveLength(3);
  });

  test("splits Codex turns by explicit user turn id even when replayed context contains tool results", () => {
    const sessionId = "019f2604-246f-7e21-9f0b-b6c77f6e363c";
    const baseHeaders = {
      "user-agent": "codex-tui/0.1",
      "session-id": sessionId,
      "thread-id": sessionId,
    };
    const turnHeaders = (turnId: string) => ({
      ...baseHeaders,
      "x-codex-turn-metadata": JSON.stringify({
        session_id: sessionId,
        thread_id: sessionId,
        turn_id: turnId,
        request_kind: "turn",
        thread_source: "user",
      }),
    });
    const exchanges = [
      makeExchange({
        exchangeId: "cap:ex-201",
        path: "/responses",
        headers: turnHeaders("turn-1"),
        request: {
          model: "gpt-5.5",
          previous_response_id: "resp_before",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "分析 Hyperframes" }] }],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{}" }],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-202",
        path: "/responses",
        headers: turnHeaders("turn-1"),
        request: {
          model: "gpt-5.5",
          previous_response_id: "resp_1",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "分析 Hyperframes" }] },
            { type: "function_call_output", call_id: "call_1", output: "tool result" },
          ],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "第一轮完成" }] }],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-203",
        path: "/responses",
        headers: turnHeaders("turn-2"),
        request: {
          model: "gpt-5.5",
          previous_response_id: "resp_2",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "分析 Hyperframes" }] },
            { type: "function_call_output", call_id: "call_1", output: "tool result" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "需要，继续" }] },
          ],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "function_call", call_id: "call_2", name: "exec_command", arguments: "{}" }],
        },
      }),
    ];

    const derived = deriveHarnessDataset(exchanges);

    expect(derived.agentSessions).toHaveLength(1);
    expect(derived.agentTurns).toHaveLength(2);
    expect(derived.agentTurns.map(turn => turn.exchangeIds)).toEqual([
      ["cap:ex-201", "cap:ex-202"],
      ["cap:ex-203"],
    ]);
    expect(derived.steps.map(step => ({
      exchangeId: step.exchangeId,
      turnId: step.turnId,
      index: step.index,
      requestAction: step.requestAction,
      codexTurnId: step.codexTurnId,
    }))).toEqual([
      expect.objectContaining({ exchangeId: "cap:ex-201", index: 1, requestAction: "user_prompt", codexTurnId: "turn-1" }),
      expect.objectContaining({ exchangeId: "cap:ex-202", index: 2, requestAction: "tool_result", codexTurnId: "turn-1" }),
      expect.objectContaining({ exchangeId: "cap:ex-203", index: 1, requestAction: "user_prompt", codexTurnId: "turn-2" }),
    ]);
  });

  test("links tool uses and results across Anthropic, OpenAI Responses and Chat Completions", () => {
    const anthropic = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-20",
        path: "/v1/messages",
        headers: { "x-claude-code-session-id": "s1", "anthropic-version": "2023-06-01" },
        request: {
          model: "claude",
          messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }] },
          ],
        },
        response: { type: "message", content: [{ type: "text", text: "ok" }] },
      }),
    ]);
    const responses = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-21",
        path: "/responses",
        headers: { session_id: "s2" },
        request: {
          model: "gpt-5",
          input: [{ type: "function_call_output", call_id: "call_r", output: "ok" }],
        },
        response: { object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] },
      }),
    ]);
    const chat = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-22",
        path: "/v1/chat/completions",
        headers: { "user-agent": "OpenAI/JS 5" },
        request: {
          model: "gpt-4o",
          messages: [
            { role: "assistant", tool_calls: [{ id: "call_c", type: "function", function: { name: "Read", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "call_c", content: "ok" },
          ],
        },
        response: {
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        },
      }),
    ]);

    expect(anthropic.steps[0]?.toolResultIds).toEqual(["toolu_a"]);
    expect(responses.steps[0]?.toolResultIds).toEqual(["call_r"]);
    expect(chat.steps[0]?.toolResultIds).toEqual(["call_c"]);
  });

  test("OpenCode x-opencode-request 同 ID 工具循环沿用 Turn，新 ID 开新 Turn", () => {
    const derived = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-301",
        path: "/v1/chat/completions",
        routingAgent: "opencode",
        wireApi: "chat_completions",
        headers: {
          "user-agent": "opencode/0.2",
          "x-opencode-session": "ses_1",
          "x-opencode-request": "turn-1",
        },
        request: {
          model: "deepseek-v4",
          messages: [{role: "user", content: "hello"}],
        },
        response: {
          choices: [{message: {role: "assistant", content: "hi"}}],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-302",
        path: "/v1/chat/completions",
        routingAgent: "opencode",
        wireApi: "chat_completions",
        headers: {
          "user-agent": "opencode/0.2",
          "x-opencode-session": "ses_1",
          "x-opencode-request": "turn-1",
        },
        request: {
          model: "deepseek-v4",
          messages: [
            {role: "user", content: "hello"},
            {role: "assistant", content: "hi"},
            {role: "user", content: [{type: "tool_result", tool_use_id: "call_1", content: "ok"}]},
          ],
        },
        response: {
          choices: [{message: {role: "assistant", content: "done"}}],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-303",
        path: "/v1/chat/completions",
        routingAgent: "opencode",
        wireApi: "chat_completions",
        headers: {
          "user-agent": "opencode/0.2",
          "x-opencode-session": "ses_1",
          "x-opencode-request": "turn-2",
        },
        request: {
          model: "deepseek-v4",
          messages: [
            {role: "user", content: "hello"},
            {role: "assistant", content: "done"},
            {role: "user", content: "next task"},
          ],
        },
        response: {
          choices: [{message: {role: "assistant", content: "ok"}}],
        },
      }),
    ]);

    expect(derived.agentTurns).toHaveLength(2);
    expect(derived.agentTurns.map(turn => turn.exchangeIds)).toEqual([
      ["cap:ex-301", "cap:ex-302"],
      ["cap:ex-303"],
    ]);
    expect(derived.agentTurns.map(turn => turn.nativeTurnId)).toEqual(["turn-1", "turn-2"]);
    expect(derived.steps.map(step => step.exchangeId)).toEqual(["cap:ex-301", "cap:ex-302", "cap:ex-303"]);
  });

  test("dsh 无 turn 头时按消息多重集推断：仅工具/助手历史增长沿用当前 Turn", () => {
    const derived = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-401",
        path: "/v1/chat/completions",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        headers: {
          "user-agent": "deepseek-harness/1.0",
          "x-deepseek-harness-session-id": "session-1",
        },
        request: {
          model: "deepseek-v4",
          messages: [{role: "user", content: "hello"}],
        },
        response: {
          choices: [{message: {role: "assistant", content: "hi"}}],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-402",
        path: "/v1/chat/completions",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        headers: {
          "user-agent": "deepseek-harness/1.0",
          "x-deepseek-harness-session-id": "session-1",
        },
        request: {
          model: "deepseek-v4",
          messages: [
            {role: "user", content: "hello"},
            {role: "assistant", content: "hi"},
            {role: "user", content: [{type: "tool_result", tool_use_id: "call_1", content: "ok"}]},
          ],
        },
        response: {
          choices: [{message: {role: "assistant", content: "done"}}],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-403",
        path: "/v1/chat/completions",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        headers: {
          "user-agent": "deepseek-harness/1.0",
          "x-deepseek-harness-session-id": "session-1",
        },
        request: {
          model: "deepseek-v4",
          messages: [
            {role: "user", content: "hello"},
            {role: "assistant", content: "done"},
            {role: "user", content: "next task"},
          ],
        },
        response: {
          choices: [{message: {role: "assistant", content: "ok"}}],
        },
      }),
    ]);

    expect(derived.agentTurns).toHaveLength(2);
    expect(derived.agentTurns.map(turn => turn.exchangeIds)).toEqual([
      ["cap:ex-401", "cap:ex-402"],
      ["cap:ex-403"],
    ]);
  });

  test("Step 使用完整生命周期摘要而不是被截断的 SSE 诊断样本判断终态", () => {
    const raw = makeExchange({
      exchangeId: "cap:ex-258",
      path: "/responses",
      headers: {
        "user-agent": "codex-tui/0.1",
        session_id: "session-lifecycle",
      },
      request: {
        model: "gpt-5",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "执行 pwd" }],
        }],
      },
      response: {
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "执行完成" }],
        }],
      },
      streamEvents: Array.from({ length: 256 }, (_, index) => ({
        index,
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          item_id: "message-1",
          delta: index === 0 ? "执行完成" : "",
        },
        rawData: "",
      })),
    });
    Object.assign(raw.stream!, {
      lifecycleSummary: {
        eventCount: 258,
        lastEventType: "response.completed",
        terminalEventSeen: true,
        terminalEventType: "response.completed",
        providerStatus: "completed",
        doneMarkerSeen: false,
        parseErrorCount: 0,
        sampleLimited: true,
      },
    });

    const derived = deriveHarnessDataset([raw]);

    expect(derived.steps).toHaveLength(1);
    expect(derived.steps[0]).toMatchObject({
      exchangeId: "cap:ex-258",
      phase: "final_answer",
      responseAction: "final",
      responseStatusLabel: "已完成",
      streamStatus: "complete",
    });
  });

  test("builds snapshot diff with context trimming and raw evidence links", () => {
    const first = normalizeExchange(makeExchange({
      exchangeId: "cap:ex-30",
      path: "/responses",
      headers: { session_id: "s3" },
      request: {
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: "A" },
          { type: "function_call_output", call_id: "old_call", output: "old result" },
        ],
        tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      },
      response: { object: "response", output: [] },
    }));
    const second = normalizeExchange(makeExchange({
      exchangeId: "cap:ex-31",
      path: "/responses",
      headers: { session_id: "s3" },
      request: {
        model: "gpt-5",
        previous_response_id: "resp_old",
        input: [
          { type: "message", role: "user", content: "A" },
          { type: "message", role: "user", content: "B" },
        ],
        tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      },
      response: { object: "response", output: [] },
    }));
    const derived = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-30",
        path: "/responses",
        headers: { session_id: "s3" },
        request: first.request.params,
        response: {},
      }),
    ]);
    const from = derived.contextSnapshots[0]!;
    const diff = diffContextSnapshots(
      {
        ...from,
        conversationItemHashes: first.harnessPayload.conversationItems.map(item => item.stableHash),
        harnessPayload: first.harnessPayload,
      },
      {
        ...from,
        id: "ctx-next",
        exchangeId: "cap:ex-31",
        harnessPayload: second.harnessPayload,
        conversationItemHashes: second.harnessPayload.conversationItems.map(item => item.stableHash),
        remoteStateReferences: [{
          kind: "previous_response_id",
          value: "resp_old",
          observability: "remote_context_not_fully_observable",
          evidence: [{ exchangeId: "cap:ex-31", side: "request", path: "$.previous_response_id" }],
        }],
      }
    );

    expect(diff.addedMessages).toHaveLength(1);
    expect(diff.removedToolResults.map(item => item.toolUseId)).toEqual(["old_call"]);
    expect(diff.contextTrimming).toEqual([
      expect.objectContaining({ kind: "tool_result_removed", confidence: "high" }),
      expect.objectContaining({ kind: "remote_state_reference", confidence: "exact" }),
    ]);
    expect(diff.evidence.some(item => item.exchangeId === "cap:ex-31")).toBe(true);
  });

  test("groups exchanges without explicit session by tool linkage before time-window fallback", () => {
    const derived = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-40",
        path: "/responses",
        headers: { "user-agent": "OpenAI/JS 5" },
        request: {
          model: "gpt-5",
          input: [{ type: "message", role: "user", content: "Read package" }],
        },
        response: {
          object: "response",
          status: "completed",
          output: [
            { type: "function_call", call_id: "call_linked", name: "read_file", arguments: "{\"path\":\"package.json\"}" },
          ],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-41",
        path: "/responses",
        headers: { "user-agent": "OpenAI/JS 5" },
        request: {
          model: "gpt-5",
          input: [{ type: "function_call_output", call_id: "call_linked", output: "package contents" }],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
        },
      }),
    ]);

    expect(derived.agentSessions).toHaveLength(1);
    expect(derived.agentSessions[0]).toMatchObject({
      source: "tool-link",
      confidence: "high",
      exchangeIds: ["cap:ex-40", "cap:ex-41"],
    });
    expect(derived.agentSessions[0]?.evidence).toEqual([
      expect.objectContaining({
        kind: "tool-link",
        fromExchangeId: "cap:ex-40",
        toExchangeId: "cap:ex-41",
        value: "call_linked",
      }),
    ]);
  });

  test("does not merge time-window fallback exchanges beyond the configured window", () => {
    const first = makeExchange({
      exchangeId: "cap:ex-50",
      path: "/v1/chat/completions",
      headers: { "user-agent": "curl/8.0" },
      request: { model: "gpt-4o", messages: [{ role: "user", content: "first" }] },
      response: { choices: [{ message: { role: "assistant", content: "ok" } }] },
    });
    const second = {
      ...makeExchange({
        exchangeId: "cap:ex-51",
        path: "/v1/chat/completions",
        headers: { "user-agent": "curl/8.0" },
        request: { model: "gpt-4o", messages: [{ role: "user", content: "second" }] },
        response: { choices: [{ message: { role: "assistant", content: "ok" } }] },
      }),
      capturedAt: "2026-05-31T10:30:00.000Z",
      completedAt: "2026-05-31T10:30:01.000Z",
    };

    const derived = deriveHarnessDataset([first, second]);

    expect(derived.agentSessions).toHaveLength(2);
    expect(derived.agentSessions.map(session => session.source)).toEqual(["time-window", "time-window"]);
  });

  test("groups exchanges by message prefix growth when no explicit session or tool link exists", () => {
    const derived = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-60",
        path: "/v1/chat/completions",
        headers: { "user-agent": "curl/8.0" },
        request: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "first" }],
        },
        response: { choices: [{ message: { role: "assistant", content: "ok" } }] },
      }),
      makeExchange({
        exchangeId: "cap:ex-61",
        path: "/v1/chat/completions",
        headers: { "user-agent": "curl/8.0" },
        request: {
          model: "gpt-4o",
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "second" },
          ],
        },
        response: { choices: [{ message: { role: "assistant", content: "ok" } }] },
      }),
    ]);

    expect(derived.agentSessions).toHaveLength(1);
    expect(derived.agentSessions[0]).toMatchObject({
      source: "message-prefix",
      confidence: "medium",
      exchangeIds: ["cap:ex-60", "cap:ex-61"],
    });
  });

  test("derives learning insights that explain tool loops, context changes and evidence links", () => {
    const derived = deriveHarnessDataset([
      makeExchange({
        exchangeId: "cap:ex-70",
        path: "/responses",
        headers: { "user-agent": "codex-tui/0.1", session_id: "learn-session", thread_id: "thread-learn" },
        request: {
          model: "gpt-5",
          input: [{ type: "message", role: "user", content: "Read package" }],
          tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "function_call", call_id: "call_learn", name: "read_file", arguments: "{\"path\":\"package.json\"}" }],
        },
      }),
      makeExchange({
        exchangeId: "cap:ex-71",
        path: "/responses",
        headers: { "user-agent": "codex-tui/0.1", session_id: "learn-session", thread_id: "thread-learn" },
        request: {
          model: "gpt-5",
          previous_response_id: "resp_learn_1",
          input: [
            { type: "message", role: "user", content: "Read package" },
            { type: "function_call_output", call_id: "call_learn", output: "package contents" },
          ],
          tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        },
        response: {
          object: "response",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
        },
      }),
    ]);

    const insights = deriveHarnessLearningInsights(derived);

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      summary: expect.stringContaining("工具循环"),
      harnessPattern: "tool_loop_then_final",
      confidence: "high",
    });
    expect(insights[0]?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool_loop",
        title: "工具循环",
        evidence: expect.arrayContaining([expect.objectContaining({ exchangeId: "cap:ex-70" })]),
      }),
      expect.objectContaining({
        kind: "remote_state",
        title: "远端上下文续接",
      }),
      expect.objectContaining({
        kind: "context_diff",
        title: "上下文差异",
      }),
    ]));
    expect(insights[0]?.copyableTemplate).toContain("while");
    expect(insights[0]?.copyableTemplate).toContain("tool_result");
  });
});

function makeExchange(options: {
  exchangeId: string;
  path: string;
  routingAgent?: string;
  wireApi?: RawCapturedExchange["routing"]["wireApi"];
  headers?: Record<string, string>;
  request: unknown;
  response: unknown;
  status?: number;
  streamEvents?: RawCapturedExchange["stream"] extends infer S ? S extends { events: infer E } ? E : never : never;
  diagnostics?: RawCapturedExchange["captureDiagnostics"];
}): RawCapturedExchange {
  const capturedAt = new Date(Date.parse("2026-05-31T10:00:00.000Z") + Number(options.exchangeId.split("-").at(-1) || 0)).toISOString();
  return {
    schemaVersion: 1,
    exchangeId: options.exchangeId,
    captureSessionId: "capture-2026-05-31-001",
    sequence: Number(options.exchangeId.split("-").at(-1) || 1),
    capturedAt,
    completedAt: capturedAt,
    durationMs: 100,
    routing: {
      targetId: options.path.includes("messages") ? "anthropic" : "openai",
      targetName: options.path.includes("messages") ? "Anthropic" : "OpenAI",
      targetFormatHint: options.path.includes("messages") ? "anthropic" : "openai",
      localUrl: `http://localhost:3211${options.path}`,
      upstreamUrl: `https://example.test${options.path}`,
      localPath: options.path,
      upstreamPath: options.path,
      method: "POST",
      ...(options.routingAgent ? {agent: options.routingAgent} : {}),
      ...(options.wireApi ? {wireApi: options.wireApi} : {}),
    },
    request: {
      headers: lower(options.headers || {}),
      rawBody: JSON.stringify(options.request),
      parsedBody: options.request,
      bodySizeBytes: JSON.stringify(options.request).length,
      bodySha256: "0".repeat(64),
    },
    response: {
      status: options.status || 200,
      statusText: "OK",
      headers: {},
      rawBody: JSON.stringify(options.response),
      parsedBody: options.response,
      bodySizeBytes: JSON.stringify(options.response).length,
      bodySha256: "1".repeat(64),
      isStreaming: !!options.streamEvents,
    },
    stream: options.streamEvents
      ? {
        events: options.streamEvents,
        parseErrors: [],
        doneMarkerSeen: false,
        rawBodyStorage: "inline",
      }
      : undefined,
    bodyStorage: { policy: "inline" },
    captureDiagnostics: options.diagnostics || [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
