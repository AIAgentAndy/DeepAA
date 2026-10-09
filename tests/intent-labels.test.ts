import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  deriveHarnessDataset,
  enrichStepIntentLabels,
} from "../src/lib/harness/index.js";
import type { AgentStep, StepDiff } from "../src/lib/harness/index.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

/** 构造 RawCapturedExchange，bodySha256 由真实请求体计算，避免夹具常量哈希干扰重试检测 */
function makeExchange(options: {
  exchangeId: string;
  path: string;
  headers?: Record<string, string>;
  request: unknown;
  response: unknown;
  status?: number;
  streamEvents?: Array<{ index: number; event: string; data: unknown; rawData: string }>;
  diagnostics?: RawCapturedExchange["captureDiagnostics"];
}): RawCapturedExchange {
  const seq = Number(options.exchangeId.split("-").at(-1) || 1);
  const capturedAt = new Date(Date.parse("2026-07-01T10:00:00.000Z") + seq).toISOString();
  const rawBody = JSON.stringify(options.request);
  const responseBody = JSON.stringify(options.response);
  return {
    schemaVersion: 1,
    exchangeId: options.exchangeId,
    captureSessionId: "capture-2026-07-01-001",
    sequence: seq,
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
    },
    request: {
      headers: Object.fromEntries(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
      rawBody,
      parsedBody: options.request,
      bodySizeBytes: rawBody.length,
      bodySha256: createHash("sha256").update(rawBody).digest("hex"),
    },
    response: {
      status: options.status || 200,
      statusText: "OK",
      headers: {},
      rawBody: responseBody,
      parsedBody: options.response,
      bodySizeBytes: responseBody.length,
      bodySha256: createHash("sha256").update(responseBody).digest("hex"),
      isStreaming: !!options.streamEvents,
    },
    stream: options.streamEvents
      ? { events: options.streamEvents, parseErrors: [], doneMarkerSeen: false, rawBodyStorage: "inline" }
      : undefined,
    bodyStorage: { policy: "inline" },
    captureDiagnostics: options.diagnostics || [],
    security: { containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true },
  };
}

describe("任务8：请求意图与响应状态标签", () => {
  test("为工具循环 Turn 派生中文意图/状态标签，且不因不同请求体误判重试", () => {
    const exchanges = [
      makeExchange({
        exchangeId: "cap:ex-1",
        path: "/v1/messages",
        headers: { "x-claude-code-session-id": "s1", "anthropic-version": "2023-06-01" },
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
        path: "/v1/messages",
        headers: { "x-claude-code-session-id": "s1", "anthropic-version": "2023-06-01" },
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
    expect(derived.steps).toHaveLength(2);
    expect(derived.steps[0]).toMatchObject({
      requestIntentLabel: "首次提问",
      responseStatusLabel: "待工具调用（Read）",
    });
    // 第二步请求体不同（追加了工具结果），不应误判为重试
    expect(derived.steps[1]).toMatchObject({
      requestIntentLabel: "续接工具结果",
      responseStatusLabel: "已完成",
    });
  });

  test("相同请求体重发标记为重试", () => {
    const request = {
      model: "claude-sonnet",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    };
    const exchanges = [
      makeExchange({
        exchangeId: "cap:ex-1",
        path: "/v1/messages",
        headers: { "x-claude-code-session-id": "s2", "anthropic-version": "2023-06-01" },
        request,
        response: { type: "message", content: [{ type: "text", text: "oops" }] },
        status: 500,
      }),
      makeExchange({
        exchangeId: "cap:ex-2",
        path: "/v1/messages",
        headers: { "x-claude-code-session-id": "s2", "anthropic-version": "2023-06-01" },
        request,
        response: {
          type: "message",
          model: "claude-sonnet",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Hi" }],
        },
      }),
    ];

    const derived = deriveHarnessDataset(exchanges);
    expect(derived.steps[0]?.responseStatusLabel).toContain("上游错误");
    expect(derived.steps[1]?.requestIntentLabel).toBe("重试");
  });

  test("远端状态续接（previous_response_id）标记请求意图", () => {
    const exchanges = [
      makeExchange({
        exchangeId: "cap:ex-10",
        path: "/responses",
        headers: { session_id: "codex-s1" },
        request: {
          model: "gpt-5",
          previous_response_id: "resp_old",
          input: [{ type: "message", role: "user", content: "继续" }],
        },
        response: { id: "resp_1", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] },
      }),
    ];
    const derived = deriveHarnessDataset(exchanges);
    expect(derived.steps[0]?.requestIntentLabel).toBe("远端状态续接");
  });

  test("enrichStepIntentLabels 标记上下文压缩", () => {
    const steps: AgentStep[] = [
      {
        id: "astep-1", turnId: "aturn-1", agentSessionId: "asess-1", exchangeId: "ex-1", index: 1,
        timestamp: "2026-07-01T10:00:00.000Z", phase: "tool_request",
        requestAction: "user_prompt", responseAction: "tool_use",
        requestIntentLabel: "首次提问", responseStatusLabel: "待工具调用（Read）",
        toolSchemaCount: 1, toolUseNames: ["Read"], toolUseIds: ["t1"], toolResultIds: [],
        contextSnapshotId: "ctx-1",
      },
      {
        id: "astep-2", turnId: "aturn-1", agentSessionId: "asess-1", exchangeId: "ex-2", index: 2,
        timestamp: "2026-07-01T10:00:01.000Z", phase: "final_answer",
        requestAction: "user_prompt", responseAction: "final",
        requestIntentLabel: "新用户输入", responseStatusLabel: "已完成",
        toolSchemaCount: 1, toolUseNames: [], toolUseIds: [], toolResultIds: [],
        contextSnapshotId: "ctx-2",
      },
    ];
    const diffs: StepDiff[] = [
      {
        id: "diff-2", toStepId: "astep-2", toSnapshotId: "ctx-2",
        addedMessages: [], removedMessages: [], addedToolResults: [], removedToolResults: [],
        addedAssistantToolUses: [], removedAssistantToolUses: [],
        changedSystem: [], changedTools: { added: [], removed: [], changed: [], beforeCount: 1, afterCount: 1 },
        changedParams: [], contextTrimming: [
          { kind: "message_removed", summary: "旧消息被移除", confidence: "high", evidence: [] },
        ],
        summary: ["上下文被压缩"], evidence: [],
      } as StepDiff,
    ];
    const exchanges = [
      { exchangeId: "ex-1", request: { bodySha256: "a", parsedBody: { a: 1 } } },
      { exchangeId: "ex-2", request: { bodySha256: "b", parsedBody: { b: 2 } } },
    ] as unknown as RawCapturedExchange[];

    enrichStepIntentLabels(steps, diffs, exchanges);
    expect(steps[1]?.contextCompressed).toBe(true);
    expect(steps[1]?.requestIntentLabel).toBe("上下文压缩");
  });
});
