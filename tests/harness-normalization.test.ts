import { describe, expect, test } from "vitest";
import {
  buildAgentStep,
  classifyProtocol,
  normalizeExchange,
  refineStreamDiagnostic,
  fingerprintAgent,
} from "../src/lib/harness/index.js";
import type { AgentTurn } from "../src/lib/harness/agent.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

describe("MVP-A protocol classification and normalization", () => {
  test("classifies supported endpoints and auxiliary count_tokens", () => {
    expect(classifyProtocol(makeExchange({
      exchangeId: "responses",
      path: "/v1/responses",
      request: { model: "gpt-5", input: "hello" },
      response: { object: "response", output: [] },
    }))).toMatchObject({
      protocol: "openai-responses",
      endpointKind: "model-call",
      isModelCall: true,
      confidence: "exact",
    });
    expect(classifyProtocol(makeExchange({
      exchangeId: "chat",
      path: "/v1/chat/completions",
      request: { model: "gpt-4o", messages: [] },
      response: { choices: [] },
    }))).toMatchObject({ protocol: "openai-chat-completions", endpointKind: "model-call" });
    expect(classifyProtocol(makeExchange({
      exchangeId: "anthropic",
      path: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      request: { model: "claude-sonnet", messages: [] },
      response: { type: "message", content: [] },
    }))).toMatchObject({ protocol: "anthropic-messages", endpointKind: "model-call" });
    expect(classifyProtocol(makeExchange({
      exchangeId: "count",
      path: "/v1/messages/count_tokens",
      request: { model: "claude-sonnet", messages: [] },
      response: { input_tokens: 10 },
    }))).toMatchObject({
      protocol: "anthropic-count-tokens",
      endpointKind: "token-count",
      isAuxiliary: true,
      isModelCall: false,
    });
    expect(classifyProtocol(makeExchange({
      exchangeId: "models",
      path: "/models",
      request: {},
      response: { data: [] },
    }))).toMatchObject({
      protocol: "unknown",
      endpointKind: "metadata",
      isAuxiliary: true,
      isModelCall: false,
      confidence: "exact",
    });
  });

  test("normalizes Chat Completions reasoning_content separately from final text", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "chat-reasoning",
      path: "/v1/chat/completions",
      request: {
        model: "deepseek-v4",
        messages: [{role: "user", content: "请分析"}],
      },
      response: {
        id: "chatcmpl-reasoning",
        object: "chat.completion",
        model: "deepseek-v4",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            reasoning_content: "先分析再回答",
            content: "最终答案",
          },
          finish_reason: "stop",
        }],
      },
    }));

    expect(normalized.response.finalTextBlocks.map(block => block.text)).toEqual(["最终答案"]);
    expect(normalized.response.reasoningBlocks.map(block => block.text)).toEqual(["先分析再回答"]);
  });

  test("normalizes OpenAI Responses tool loop into harnessPayload", () => {
    const exchange = makeExchange({
      exchangeId: "responses-tool-loop",
      path: "/v1/responses",
      request: {
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: "Search docs" },
          { type: "function_call_output", call_id: "call_1", output: "file contents" },
        ],
        tools: [{ type: "function", name: "Read", description: "Read file", parameters: { type: "object" } }],
        previous_response_id: "resp_prev",
      },
      response: {
        id: "resp_2",
        object: "response",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ text: "Need another file" }] },
          { type: "function_call", call_id: "call_2", name: "Read", arguments: "{\"path\":\"README.md\"}" },
        ],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      },
    });

    const normalized = normalizeExchange(exchange);

    expect(normalized.protocol).toBe("openai-responses");
    expect(normalized.request.sessionHints).toContainEqual(expect.objectContaining({
      kind: "previous-response-id",
      value: "resp_prev",
    }));
    expect(normalized.harnessPayload.providedToolResults.map(item => item.toolUseId)).toEqual(["call_1"]);
    expect(normalized.harnessPayload.requestedToolUses.map(item => item.id)).toEqual(["call_2"]);
    expect(normalized.harnessPayload.toolSchemas.map(item => item.name)).toEqual(["Read"]);
    expect(normalized.response.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, totalTokens: 25, source: "exact" });
  });

  test("responses 响应识别 custom_tool_call（codex 自定义工具）并推导 stop_reason", () => {
    // 2026-09-17 实测回归：codex exec 工具走 custom_tool_call，响应侧此前只认
    // function_call，导致 toolUses=0、responseAction=final、stop_reason 空。
    const exchange = makeExchange({
      exchangeId: "responses-custom-tool-call",
      path: "/v1/responses",
      request: {
        model: "gpt-5.6-sol",
        input: [{ type: "message", role: "user", content: "list files" }],
        tools: [{ type: "function", name: "exec", description: "run shell", parameters: { type: "object" } }],
      },
      response: {
        id: "resp_c",
        object: "response",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ text: "plan" }] },
          { type: "custom_tool_call", id: "item_1", call_id: "call_c1", name: "exec", input: "ls -la" },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    });

    const normalized = normalizeExchange(exchange);

    expect(normalized.response.toolUses).toHaveLength(1);
    expect(normalized.response.toolUses[0]).toMatchObject({
      id: "call_c1",
      name: "exec",
      input: "ls -la",
      providerType: "custom_tool_call",
    });
    expect(normalized.response.stopReason).toBe("tool_use");
    expect(normalized.harnessPayload.requestedToolUses.map(item => item.id)).toEqual(["call_c1"]);
  });

  test("responses completed 无工具调用时 stop_reason 为 end_turn，incomplete 映射 max_tokens", () => {
    const completed = normalizeExchange(makeExchange({
      exchangeId: "responses-stop-end-turn",
      path: "/v1/responses",
      request: { model: "gpt-5", input: "hi" },
      response: {
        id: "resp_e",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      },
    }));
    expect(completed.response.stopReason).toBe("end_turn");

    const incomplete = normalizeExchange(makeExchange({
      exchangeId: "responses-stop-max-tokens",
      path: "/v1/responses",
      request: { model: "gpt-5", input: "hi" },
      response: {
        id: "resp_i",
        object: "response",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
    }));
    expect(incomplete.response.stopReason).toBe("max_tokens");
  });

  test("preserves OpenAI Responses input message roles in conversation item kinds", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "responses-input-message-roles",
      path: "/v1/responses",
      request: {
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "真实用户输入" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Agent 中间回复" }] },
          { type: "message", role: "developer", content: [{ type: "input_text", text: "内部开发者约束" }] },
          { type: "function_call_output", call_id: "call_1", output: "工具输出" },
        ],
      },
      response: { object: "response", output: [] },
    }));

    expect(normalized.harnessPayload.conversationItems.map(item => ({
      kind: item.kind,
      role: item.role,
      summary: item.summary,
    }))).toEqual([
      { kind: "user_text", role: "user", summary: "真实用户输入" },
      { kind: "assistant_text", role: "assistant", summary: "Agent 中间回复" },
      { kind: "developer_text", role: "developer", summary: "内部开发者约束" },
      { kind: "tool_result", role: undefined, summary: "工具输出" },
    ]);
  });

  test("Normalizer 为 Codex checkpoint 与真实输入输出统一语义元数据", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "responses-checkpoint-semantics",
      path: "/v1/responses",
      headers: { "user-agent": "codex-tui/0.1" },
      request: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.",
            }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "确认，请实现！" }],
          },
        ],
      },
      response: { object: "response", output: [] },
    }));

    expect(normalized.harnessPayload.conversationItems.map(item => ({
      semanticCategory: item.semanticCategory,
      provenance: item.provenance,
      displayPolicy: item.displayPolicy,
    }))).toEqual([
      {
        semanticCategory: "control",
        provenance: "agent_control",
        displayPolicy: "conversation",
      },
      {
        semanticCategory: "user_real",
        provenance: "physical_user",
        displayPolicy: "conversation",
      },
    ]);
  });

  test("extracts Codex session hints from hyphenated headers and turn metadata", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "codex-hyphen-session",
      path: "/responses",
      headers: {
        "user-agent": "codex-tui/0.1",
        "session-id": "codex-session-hyphen",
        "thread-id": "codex-thread-hyphen",
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "codex-session-metadata",
          thread_id: "codex-thread-metadata",
          window_id: "codex-session-metadata:0",
        }),
        "x-codex-window-id": "codex-session-hyphen:0",
      },
      request: {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] }],
        prompt_cache_key: "codex-session-prompt-cache",
      },
      response: { object: "response", output: [] },
    }));

    expect(normalized.request.sessionHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "agent-session-header", value: "codex-session-hyphen" }),
      expect.objectContaining({ kind: "thread-header", value: "codex-thread-hyphen" }),
      expect.objectContaining({ kind: "conversation-field", value: "codex-session-prompt-cache" }),
    ]));
    expect(fingerprintAgent(makeExchange({
      exchangeId: "codex-hyphen-fingerprint",
      path: "/responses",
      headers: { "session-id": "codex-session-hyphen" },
      request: { model: "gpt-5", input: [] },
      response: {},
    }))).toMatchObject({ agentName: "codex", confidence: "exact" });
  });

  test("normalizes Anthropic tool blocks without losing provider roles", () => {
    const exchange = makeExchange({
      exchangeId: "anthropic-tool-loop",
      path: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      request: {
        model: "claude-sonnet",
        system: [{ type: "text", text: "You are helpful", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Read package" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "package.json" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "package contents" }] },
        ],
        tools: [{ name: "Read", description: "Read file", input_schema: { type: "object" } }],
      },
      response: {
        type: "message",
        model: "claude-sonnet",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "pwd" } }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    });

    const normalized = normalizeExchange(exchange);

    expect(normalized.protocol).toBe("anthropic-messages");
    expect(normalized.request.messages.map(message => message.providerRole)).toEqual(["user", "assistant", "user"]);
    expect(normalized.harnessPayload.providedToolResults.map(item => item.toolUseId)).toEqual(["toolu_1"]);
    expect(normalized.harnessPayload.requestedToolUses.map(item => item.name)).toEqual(["Bash"]);
    expect(normalized.harnessPayload.systemPrompts[0]?.textPreview).toBe("You are helpful");
  });

  test("does not classify Anthropic tool-result carrier messages as user text", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "anthropic-tool-result-carrier",
      path: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      request: {
        model: "claude-sonnet",
        messages: [
          { role: "user", content: [{ type: "text", text: "真实用户输入" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "README.md" } }] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "README contents" },
              { type: "text", text: "Base directory for this skill: /tmp/skills/brainstorming" },
            ],
          },
        ],
      },
      response: { type: "message", content: [] },
    }));

    expect(normalized.harnessPayload.conversationItems.map(item => ({
      kind: item.kind,
      role: item.role,
      toolUseId: item.toolUseId,
      summary: item.summary,
    }))).toEqual([
      { kind: "user_text", role: "user", toolUseId: undefined, summary: "真实用户输入" },
      { kind: "tool_use", role: "assistant", toolUseId: "toolu_1", summary: "{\"file\":\"README.md\"}" },
      { kind: "tool_result", role: "user", toolUseId: "toolu_1", summary: "README contents" },
    ]);
  });

  test("fingerprints known agents and generic clients from headers and body shape", () => {
    expect(fingerprintAgent(makeExchange({
      exchangeId: "claude-code",
      path: "/v1/messages",
      headers: {
        "user-agent": "claude-cli/1.0",
        "x-claude-code-session-id": "abc",
        "anthropic-beta": "claude-code-20250219",
      },
      request: { model: "claude", messages: [], tools: [{ name: "Bash" }] },
      response: {},
    }))).toMatchObject({ agentName: "claude-code", confidence: "exact" });
    expect(fingerprintAgent(makeExchange({
      exchangeId: "codex",
      path: "/responses",
      headers: { "user-agent": "codex-tui/0.1", session_id: "sess", thread_id: "thread" },
      request: { model: "gpt-5", input: [] },
      response: {},
    }))).toMatchObject({ agentName: "codex", confidence: "exact" });
    expect(fingerprintAgent(makeExchange({
      exchangeId: "curl",
      path: "/v1/chat/completions",
      headers: { "user-agent": "curl/8.0" },
      request: { model: "gpt", messages: [] },
      response: {},
    }))).toMatchObject({ agentName: "curl" });
    expect(fingerprintAgent(makeExchange({
      exchangeId: "generic-runtime",
      path: "/v1/chat/completions",
      headers: {"user-agent": "Bun/1.2.0"},
      request: {model: "gpt", messages: []},
      response: {},
    }))).toMatchObject({agentName: "unknown"});
  });

  test("refines stream diagnostics with protocol and connection layers", () => {
    const exchange = makeExchange({
      exchangeId: "client-abort",
      path: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      request: { model: "claude", messages: [] },
      response: {},
      streamEvents: [{ index: 0, event: "message_start", data: { type: "message_start" }, rawData: "{}" }],
      diagnostics: [{ code: "client_aborted", severity: "warning", message: "client closed" }],
    });

    expect(refineStreamDiagnostic(exchange)).toMatchObject({
      status: "client_aborted",
      connectionStatus: "client_aborted",
      protocolStatus: "terminal_missing",
      expectedTerminalEvents: ["message_stop"],
    });
  });

  test("协议终态已捕获时客户端关闭不应覆盖完成状态", () => {
    const exchange = makeExchange({
      exchangeId: "client-abort-after-terminal",
      path: "/responses",
      headers: { "user-agent": "codex-tui/0.1" },
      request: { model: "gpt-5", input: [] },
      response: {
        object: "response",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-terminal",
          name: "exec",
          arguments: "{\"cmd\":\"pwd\"}",
        }],
      },
      streamEvents: [
        {
          index: 0,
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              status: "completed",
              output: [{
                type: "function_call",
                call_id: "call-terminal",
                name: "exec",
                arguments: "{\"cmd\":\"pwd\"}",
              }],
            },
          },
          rawData: "{}",
        },
      ],
      diagnostics: [{ code: "client_aborted", severity: "warning", message: "client closed after terminal" }],
    });

    expect(refineStreamDiagnostic(exchange)).toMatchObject({
      status: "complete",
      connectionStatus: "client_aborted",
      protocolStatus: "terminal_seen",
      terminalEventSeen: true,
    });
    const turn: AgentTurn = {
      id: "turn-terminal",
      agentSessionId: "session-terminal",
      agentFingerprintId: "agent-terminal",
      source: "agent-session",
      exchangeIds: [exchange.exchangeId],
      auxiliaryExchangeIds: [],
      startTime: exchange.capturedAt,
      endTime: exchange.completedAt,
      modelSet: ["gpt-5"],
      targetSet: ["target"],
      confidence: "exact",
      evidence: [],
    };

    expect(buildAgentStep(turn, exchange, normalizeExchange(exchange), 21)).toMatchObject({
      phase: "tool_request",
      responseAction: "tool_use",
      responseStatusLabel: "待工具调用（exec）",
      streamStatus: "complete",
    });
  });

  test("records unsupported fields and exposes refined diagnostics in normalized streams", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "responses-unsupported-stream",
      path: "/responses",
      request: {
        model: "gpt-5",
        input: "hello",
        modalities: ["text", "audio"],
      },
      response: {
        object: "response",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        audio: { id: "audio_1" },
      },
      streamEvents: [
        {
          index: 0,
          event: "response.incomplete",
          data: { type: "response.incomplete", response: { status: "incomplete" } },
          rawData: "{}",
        },
      ],
    }));

    expect(normalized.stream?.diagnostic).toMatchObject({
      status: "stream_truncated",
      protocolStatus: "truncated",
      lastEvent: "response.incomplete",
    });
    expect(normalized.unsupportedFeatures).toEqual([
      expect.objectContaining({ path: "$.modalities" }),
      expect.objectContaining({ path: "$.audio" }),
    ]);
  });

  test("keeps request-side Chat Completions assistant tool calls in harness conversation items", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "chat-request-tool-call",
      path: "/v1/chat/completions",
      request: {
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_123", type: "function", function: { name: "Read", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_123", content: "ok" },
        ],
      },
      response: {
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      },
    }));

    expect(normalized.harnessPayload.conversationItems).toEqual([
      expect.objectContaining({ kind: "tool_use", toolUseId: "call_123", toolName: "Read" }),
      expect.objectContaining({ kind: "tool_result", toolUseId: "call_123" }),
    ]);
    expect(normalized.harnessPayload.providedToolResults.map(item => item.toolUseId)).toEqual(["call_123"]);
  });

  test("normalizes nested usage details for cached and reasoning tokens", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "nested-usage-normalizer",
      path: "/v1/chat/completions",
      request: { model: "glm-5.2", messages: [{ role: "user", content: "hello" }] },
      response: {
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 130,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      },
    }));

    expect(normalized.response.usage).toMatchObject({
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 20,
      reasoningTokens: 10,
      totalInputTokens: 100,
      totalTokens: 130,
      source: "exact",
    });
  });

  test("normalizes relay prompt cache hit/miss usage as billable categories", () => {
    const normalized = normalizeExchange(makeExchange({
      exchangeId: "deepseek-cache-normalizer",
      path: "/v1/chat/completions",
      request: { model: "deepseek-v4-pro", messages: [{ role: "user", content: "hello" }] },
      response: {
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1500,
          prompt_cache_hit_tokens: 900,
          prompt_cache_miss_tokens: 600,
          completion_tokens: 120,
          total_tokens: 1620,
        },
      },
    }));

    expect(normalized.response.usage).toMatchObject({
      inputTokens: 600,
      totalInputTokens: 1500,
      cacheReadTokens: 900,
      outputTokens: 120,
      totalTokens: 1620,
      source: "exact",
    });
  });
});

function makeExchange(options: {
  exchangeId: string;
  path: string;
  headers?: Record<string, string>;
  request: unknown;
  response: unknown;
  streamEvents?: RawCapturedExchange["stream"] extends infer S ? S extends { events: infer E } ? E : never : never;
  diagnostics?: RawCapturedExchange["captureDiagnostics"];
}): RawCapturedExchange {
  return {
    schemaVersion: 1,
    exchangeId: options.exchangeId,
    captureSessionId: "capture-2026-05-31-001",
    sequence: 1,
    capturedAt: "2026-05-31T10:00:00.000Z",
    completedAt: "2026-05-31T10:00:01.000Z",
    durationMs: 1000,
    routing: {
      targetId: "target",
      targetName: "Target",
      targetFormatHint: options.path.includes("messages") ? "anthropic" : "openai",
      localUrl: `http://localhost:3211${options.path}`,
      upstreamUrl: `https://example.test${options.path}`,
      localPath: options.path,
      upstreamPath: options.path,
      method: "POST",
    },
    request: {
      headers: lower(options.headers || {}),
      rawBody: JSON.stringify(options.request),
      parsedBody: options.request,
      bodySizeBytes: JSON.stringify(options.request).length,
      bodySha256: "0".repeat(64),
    },
    response: {
      status: 200,
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
