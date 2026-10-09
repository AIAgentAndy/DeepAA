import {Readable} from "node:stream";
import {describe, expect, test} from "vitest";
import {projectProtocolStream} from "../src/lib/ingestion/protocol-stream-projector.js";
import {tokenUsageFromExchange} from "../src/lib/harness/stream-response.js";
import type {RawCapturedExchange} from "../src/lib/harness/types.js";

function projectSse(sse: string, protocol: string) {
  return projectProtocolStream({
    stream: Readable.from([sse]),
    format: "sse",
    exchangeId: "stream-usage",
    bodySide: "response",
    rawBodySha256: "a".repeat(64),
    sourceStorage: "inline",
    projectionVersion: 4,
    protocol,
    endpointKind: "model-call",
  });
}

function sseEvents(events: Array<Record<string, unknown>>): string {
  return events.map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
}

describe("SSE 流式 usage 聚合（投影 body）", () => {
  test("chat_completions：usage 只在末 chunk，聚合到投影 body", async () => {
    const projected = await projectSse(sseEvents([
      {id: "c1", object: "chat.completion.chunk", choices: [{index: 0, delta: {role: "assistant", content: "你好"}}], usage: null},
      {id: "c2", object: "chat.completion.chunk", choices: [{index: 0, delta: {content: "世界"}}], usage: null},
      {id: "c3", object: "chat.completion.chunk", choices: [], usage: {prompt_tokens: 17190, completion_tokens: 303, total_tokens: 17493, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 17190, prompt_tokens_details: {cached_tokens: 0}, completion_tokens_details: {reasoning_tokens: 113}}},
    ]), "openai-chat-completions");

    const body = projected.body as Record<string, unknown>;
    expect((body.usage as Record<string, unknown>)).toMatchObject({
      prompt_tokens: 17190,
      completion_tokens: 303,
      total_tokens: 17493,
    });
  });

  test("chat_completions：无 usage 事件时装配 body 不含 usage 键（chunk 自带 null 同样不采信）", async () => {
    const projected = await projectSse(sseEvents([
      {id: "c1", object: "chat.completion.chunk", choices: [{index: 0, delta: {role: "assistant", content: "a"}}], usage: null},
      {id: "c2", object: "chat.completion.chunk", choices: [{index: 0, delta: {content: "b"}}], usage: null},
    ]), "openai-chat-completions");

    // 装配 body 只含聚合到的真实 usage；chunk 的 usage:null 不进入 body，
    // extractTokenUsage 对缺失 usage 走降级路径，不会被 null 干扰。
    expect((projected.body as Record<string, unknown>).usage).toBeUndefined();
  });

  test("anthropic messages：message_start 占位 0，message_delta 真实 usage 合并", async () => {
    const projected = await projectSse(sseEvents([
      {type: "message_start", message: {id: "m1", type: "message", role: "assistant", content: [], model: "deepseek-v4-flash", stop_reason: null, usage: {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0}}},
      {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "你好"}},
      {type: "message_delta", delta: {stop_reason: "end_turn"}, usage: {input_tokens: 35294, output_tokens: 286, cache_read_input_tokens: 0}},
      {type: "message_stop"},
    ]), "anthropic-messages");

    expect((projected.body as Record<string, unknown>).usage).toMatchObject({
      input_tokens: 35294,
      output_tokens: 286,
      cache_read_input_tokens: 0,
    });
  });

  test("anthropic messages：message_start 真实 input + message_delta output 逐字段合并", async () => {
    const projected = await projectSse(sseEvents([
      {type: "message_start", message: {id: "m2", type: "message", role: "assistant", content: [], model: "claude-x", stop_reason: null, usage: {input_tokens: 1000, cache_creation_input_tokens: 50, cache_read_input_tokens: 200}}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "hi"}},
      {type: "message_delta", delta: {stop_reason: "end_turn"}, usage: {output_tokens: 77}},
      {type: "message_stop"},
    ]), "anthropic-messages");

    expect((projected.body as Record<string, unknown>).usage).toMatchObject({
      input_tokens: 1000,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 200,
      output_tokens: 77,
    });
  });

  test("openai responses：response.completed 携带完整 usage（回归）", async () => {
    const projected = await projectSse(sseEvents([
      {type: "response.created", response: {id: "r1", object: "response", status: "in_progress", usage: null}},
      {type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi"},
      {type: "response.completed", response: {id: "r1", object: "response", status: "completed", usage: {input_tokens: 122146, input_tokens_details: {cached_tokens: 121216}, output_tokens: 668, output_tokens_details: {reasoning_tokens: 363}, total_tokens: 122814}}},
    ]), "openai-responses");

    expect((projected.body as Record<string, unknown>).usage).toMatchObject({
      input_tokens: 122146,
      output_tokens: 668,
      total_tokens: 122814,
    });
  });

  test("断流：无 message_delta 时 body 只保留 message_start usage", async () => {
    const projected = await projectSse(sseEvents([
      {type: "message_start", message: {id: "m3", type: "message", role: "assistant", content: [], model: "x", stop_reason: null, usage: {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0}}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "部分"}},
    ]), "anthropic-messages");

    expect((projected.body as Record<string, unknown>).usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  test("集成：投影 body → tokenUsageFromExchange 拿到供应商真实 usage（chat_completions）", async () => {
    const projected = await projectSse(sseEvents([
      {id: "c1", object: "chat.completion.chunk", choices: [{index: 0, delta: {role: "assistant", content: "你好"}}], usage: null},
      {id: "c2", object: "chat.completion.chunk", choices: [], usage: {prompt_tokens: 17190, completion_tokens: 303, total_tokens: 17493, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 17190, prompt_tokens_details: {cached_tokens: 0}, completion_tokens_details: {reasoning_tokens: 113}}},
    ]), "openai-chat-completions");

    const exchange = {
      exchangeId: "stream-usage-e2e",
      captureSessionId: "capture-v2-1-abcdef12-345",
      sequence: 1,
      capturedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:01.000Z",
      durationMs: 1000,
      routing: {targetId: "t", targetName: "T", targetFormatHint: "openai", localUrl: "/", upstreamUrl: "/", localPath: "/", upstreamPath: "/", method: "POST"},
      request: {headers: {}, parsedBody: {model: "x"}, bodySizeBytes: 10, bodySha256: "b".repeat(64)},
      response: {status: 200, statusText: "OK", headers: {}, bodySizeBytes: 10, bodySha256: "c".repeat(64), isStreaming: true, parsedBody: projected.body},
      bodyStorage: {policy: "inline"},
      captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    } as unknown as RawCapturedExchange;

    const usage = tokenUsageFromExchange(exchange);
    expect(usage.source).toBe("provider_usage");
    expect(usage.usageConfidence).toBe("exact");
    expect(usage.inputTokens).toBe(17190);
    expect(usage.outputTokens).toBe(303);
    expect(usage.totalTokens).toBe(17493);
    expect(usage.reasoningTokens).toBe(113);
  });

  test("Anthropic usage 保留 5m/1h 缓存写入分项", () => {
    const exchange = {
      exchangeId: "anthropic-cache-ttl",
      request: {parsedBody: {model: "claude-opus-5-5"}},
      response: {
        parsedBody: {
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 3,
            cache_creation: {
              ephemeral_5m_input_tokens: 5,
              ephemeral_1h_input_tokens: 7,
            },
          },
        },
      },
    } as unknown as RawCapturedExchange;
    expect(tokenUsageFromExchange(exchange)).toMatchObject({
      cacheCreationTokens: 12,
      cacheCreation5mTokens: 5,
      cacheCreation1hTokens: 7,
    });
  });

  test("集成：投影 body → tokenUsageFromExchange 合并 Anthropic message_delta usage", async () => {
    const projected = await projectSse(sseEvents([
      {type: "message_start", message: {id: "m4", type: "message", role: "assistant", content: [], model: "x", stop_reason: null, usage: {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0}}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "hi"}},
      {type: "message_delta", delta: {stop_reason: "end_turn"}, usage: {input_tokens: 35294, output_tokens: 286, cache_read_input_tokens: 0}},
      {type: "message_stop"},
    ]), "anthropic-messages");

    const exchange = {
      exchangeId: "stream-usage-e2e-anthropic",
      captureSessionId: "capture-v2-1-abcdef12-345",
      sequence: 2,
      capturedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:01.000Z",
      durationMs: 1000,
      routing: {targetId: "t", targetName: "T", targetFormatHint: "anthropic", localUrl: "/", upstreamUrl: "/", localPath: "/", upstreamPath: "/", method: "POST"},
      request: {headers: {}, parsedBody: {model: "x"}, bodySizeBytes: 10, bodySha256: "b".repeat(64)},
      response: {status: 200, statusText: "OK", headers: {}, bodySizeBytes: 10, bodySha256: "c".repeat(64), isStreaming: true, parsedBody: projected.body},
      bodyStorage: {policy: "inline"},
      captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    } as unknown as RawCapturedExchange;

    const usage = tokenUsageFromExchange(exchange);
    expect(usage.source).toBe("provider_usage");
    expect(usage.inputTokens).toBe(35294);
    expect(usage.outputTokens).toBe(286);
    expect(usage.cacheReadTokens).toBe(0);
  });
});
