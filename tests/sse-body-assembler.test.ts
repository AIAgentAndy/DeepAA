import {Readable} from "node:stream";
import {createHash} from "node:crypto";
import {describe, expect, test} from "vitest";
import {
  createAnthropicSseBodyAssembler,
  createChatSseBodyAssembler,
  createSseBodyAssemblerForProtocol,
} from "../src/lib/harness/sse-body-assembler.js";
import {sseEventsToMessageBody} from "../src/anthropic.js";
import {openAIChunksToChatCompletionBody} from "../src/openai.js";
import {projectProtocolStream} from "../src/lib/ingestion/protocol-stream-projector.js";
import {createExchangeProjector} from "../src/lib/ingestion/exchange-projector.js";
import {normalizeExchange} from "../src/lib/harness/normalizer.js";
import type {SSEEvent} from "../src/types.js";

const anthropicEvents: Array<Record<string, unknown>> = [
  {type: "message_start", message: {id: "msg_1", type: "message", role: "assistant", model: "glm-5.3", content: [], stop_reason: null, usage: {input_tokens: 12, output_tokens: 1}}},
  {type: "content_block_start", index: 0, content_block: {type: "thinking", thinking: ""}},
  {type: "content_block_delta", index: 0, delta: {type: "thinking_delta", thinking: "先看目录"}},
  {type: "content_block_stop", index: 0},
  {type: "content_block_start", index: 1, content_block: {type: "tool_use", id: "call_1", name: "Bash", input: {}}},
  {type: "content_block_delta", index: 1, delta: {type: "input_json_delta", partial_json: "{\"command\":"}},
  {type: "content_block_delta", index: 1, delta: {type: "input_json_delta", partial_json: "\"ls -la\"}"}},
  {type: "content_block_stop", index: 1},
  {type: "content_block_start", index: 2, content_block: {type: "text", text: ""}},
  {type: "content_block_delta", index: 2, delta: {type: "text_delta", text: "开始分析"}},
  {type: "content_block_stop", index: 2},
  {type: "message_delta", delta: {stop_reason: "tool_use"}, usage: {output_tokens: 88}},
  {type: "message_stop"},
];

const chatChunks: Array<Record<string, unknown>> = [
  {id: "chatcmpl-1", object: "chat.completion.chunk", model: "glm-5.3", choices: [{index: 0, delta: {role: "assistant", content: "这个项目"}, finish_reason: null}]},
  {id: "chatcmpl-1", object: "chat.completion.chunk", model: "glm-5.3", choices: [{index: 0, delta: {content: "是一个示例"}, finish_reason: null}]},
  {id: "chatcmpl-1", object: "chat.completion.chunk", model: "glm-5.3", choices: [{index: 0, delta: {tool_calls: [{index: 0, id: "call_a", type: "function", function: {name: "bash", arguments: "{\"command\":"}}]}, finish_reason: null}]},
  {id: "chatcmpl-1", object: "chat.completion.chunk", model: "glm-5.3", choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: "\"ls\"}"}}]}, finish_reason: null}]},
  {id: "chatcmpl-1", object: "chat.completion.chunk", model: "glm-5.3", choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}], usage: {prompt_tokens: 10, completion_tokens: 20}},
];

const chatReasoningChunks: Array<Record<string, unknown>> = [
  {id: "chatcmpl-reasoning", object: "chat.completion.chunk", model: "deepseek-v4", choices: [{index: 0, delta: {role: "assistant", reasoning_content: "先分析"}, finish_reason: null}]},
  {id: "chatcmpl-reasoning", object: "chat.completion.chunk", model: "deepseek-v4", choices: [{index: 0, delta: {reasoning_content: "再回答", content: "结果"}, finish_reason: null}]},
  {id: "chatcmpl-reasoning", object: "chat.completion.chunk", model: "deepseek-v4", choices: [{index: 0, delta: {content: "完成"}, finish_reason: "stop"}]},
];

function toLegacyEvents(events: Array<Record<string, unknown>>): SSEEvent[] {
  return events.map(value => ({event: typeof value.type === "string" ? value.type : "", data: value}));
}

describe("SSE body 增量装配器（anthropic）", () => {
  test("thinking + tool_use(input_json 分片) + text + stop_reason 全量装配", () => {
    const assembler = createAnthropicSseBodyAssembler();
    for (const event of anthropicEvents) {
      assembler.push(String(event.type), event);
    }
    const body = assembler.finalize() as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(body.stop_reason).toBe("tool_use");
    expect(body.id).toBe("msg_1");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content.map(block => block.type)).toEqual(["thinking", "tool_use", "text"]);
    expect(content[1]).toMatchObject({id: "call_1", name: "Bash", input: {command: "ls -la"}});
    expect(content[0].thinking).toBe("先看目录");
    expect(content[2].text).toBe("开始分析");
    expect(assembler.wasTruncated()).toBe(false);
  });

  test("与 sseEventsToMessageBody 语义一致（content/stop_reason/元信息；usage 由投影层聚合覆盖）", () => {
    const assembler = createAnthropicSseBodyAssembler();
    for (const event of anthropicEvents) {
      assembler.push(String(event.type), event);
    }
    const assembled = assembler.finalize() as Record<string, unknown>;
    const legacy = sseEventsToMessageBody(toLegacyEvents(anthropicEvents), "");
    // 装配器保留 message_start 的占位 usage，投影层会用聚合 usage 覆盖；比较时两边剥离。
    const {usage: _assembledUsage, ...assembledRest} = assembled;
    const {usage: _legacyUsage, ...legacyRest} = legacy;
    expect(assembledRest).toEqual(legacyRest);
  });

  test("无 message_start 且无 content block 时 finalize 返回 undefined（回落兜底）", () => {
    const assembler = createAnthropicSseBodyAssembler();
    assembler.push("ping", {type: "ping"});
    expect(assembler.finalize()).toBeUndefined();
  });

  test("字节预算超限：停止追加文本但保留结构（工具名/stop_reason）并标记 truncated", () => {
    const assembler = createAnthropicSseBodyAssembler({maxBodyBytes: 8});
    for (const event of anthropicEvents) {
      assembler.push(String(event.type), event);
    }
    expect(assembler.wasTruncated()).toBe(true);
    const body = assembler.finalize() as Record<string, unknown>;
    expect(body.stop_reason).toBe("tool_use");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content.map(block => block.type)).toEqual(["thinking", "tool_use", "text"]);
    // 结构保留、追加文本被预算截断（不再断言具体拼接结果）。
    const toolUse = content[1];
    expect(toolUse.name).toBe("Bash");
    expect(toolUse.id).toBe("call_1");
  });

  test("残缺 input_json 不会装配失败（降级 _raw）", () => {
    const assembler = createAnthropicSseBodyAssembler();
    const events: Array<Record<string, unknown>> = [
      {type: "message_start", message: {id: "m", role: "assistant", content: [], model: "x"}},
      {type: "content_block_start", index: 0, content_block: {type: "tool_use", id: "t", name: "Bash", input: {}}},
      {type: "content_block_delta", index: 0, delta: {type: "input_json_delta", partial_json: "{\"a\": "}},
      {type: "message_delta", delta: {stop_reason: "tool_use"}},
    ];
    for (const event of events) assembler.push(String(event.type), event);
    const body = assembler.finalize() as Record<string, unknown>;
    const toolUse = (body.content as Array<Record<string, unknown>>)[0];
    expect(toolUse.input).toEqual({_raw: "{\"a\": "});
  });
});

describe("SSE body 增量装配器（chat_completions）", () => {
  test("分片 tool_call arguments + content + finish_reason 全量装配", () => {
    const assembler = createChatSseBodyAssembler();
    for (const chunk of chatChunks) assembler.push("unknown", chunk);
    const body = assembler.finalize() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    const choice = (body.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe("tool_calls");
    const message = choice.message as Record<string, unknown>;
    expect(message.content).toBe("这个项目是一个示例");
    const calls = message.tool_calls as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({id: "call_a", type: "function"});
    expect(calls[0].function).toEqual({name: "bash", arguments: "{\"command\":\"ls\"}"});
  });

  test("与 openAIChunksToChatCompletionBody 语义一致（usage 由投影层覆盖）", () => {
    const assembler = createChatSseBodyAssembler();
    for (const chunk of chatChunks) assembler.push("unknown", chunk);
    const assembled = assembler.finalize() as Record<string, unknown>;
    const legacy = openAIChunksToChatCompletionBody(toLegacyEvents(chatChunks), "");
    expect(assembled.choices).toEqual(legacy.choices);
    expect(assembled.id).toBe(legacy.id);
    expect(assembled.model).toBe(legacy.model);
  });

  test("无 chunk 时 finalize 返回 undefined；字节预算超限保留工具名与 finish_reason", () => {
    const empty = createChatSseBodyAssembler();
    expect(empty.finalize()).toBeUndefined();

    const assembler = createChatSseBodyAssembler({maxBodyBytes: 6});
    for (const chunk of chatChunks) assembler.push("unknown", chunk);
    expect(assembler.wasTruncated()).toBe(true);
    const body = assembler.finalize() as Record<string, unknown>;
    const choice = (body.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe("tool_calls");
    const calls = (choice.message as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect(calls[0].function).toMatchObject({name: "bash"});
  });

  test("reasoning_content 与 content 分开聚合，不能把推理串进正文", () => {
    const assembler = createChatSseBodyAssembler();
    for (const chunk of chatReasoningChunks) assembler.push("unknown", chunk);
    const body = assembler.finalize() as Record<string, unknown>;
    const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
    const message = choice.message as Record<string, unknown>;
    expect(message.content).toBe("结果完成");
    expect(message.reasoning_content).toBe("先分析再回答");
  });
});

describe("createSseBodyAssemblerForProtocol 注册表分发", () => {
  test("anthropic-messages / openai-chat-completions 命中，其余协议 undefined", () => {
    expect(createSseBodyAssemblerForProtocol("anthropic-messages")).toBeDefined();
    expect(createSseBodyAssemblerForProtocol("openai-chat-completions")).toBeDefined();
    expect(createSseBodyAssemblerForProtocol("openai-responses")).toBeUndefined();
    expect(createSseBodyAssemblerForProtocol(undefined)).toBeUndefined();
  });
});

describe("projectSse 集成：投影 body 为装配后的完整响应", () => {
  function projectSse(sse: string, protocol: string) {
    return projectProtocolStream({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "assembly-test",
      bodySide: "response",
      rawBodySha256: "a".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol,
      endpointKind: "model-call",
    });
  }

  function sseOf(events: Array<Record<string, unknown>>, named: boolean): string {
    return events.map(value => (named ? `event: ${String(value.type)}\n` : "") + `data: ${JSON.stringify(value)}\n\n`).join("");
  }

  test("anthropic：body.content 含 thinking/tool_use，stop_reason=tool_use（此前是 content: [] 首帧）", async () => {
    const projected = await projectSse(
      sseOf(anthropicEvents, true),
      "anthropic-messages",
    );
    const body = projected.body as Record<string, unknown>;
    expect(body.stop_reason).toBe("tool_use");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content.map(block => block.type)).toEqual(["thinking", "tool_use", "text"]);
    expect(content[1]).toMatchObject({name: "Bash", input: {command: "ls -la"}});
    expect(projected.diagnosticCodes).not.toContain("sse_body_assembly_truncated");
  });

  test("anthropic：既有 usage 聚合继续覆盖到装配 body", async () => {
    const projected = await projectSse(
      sseOf(anthropicEvents, true),
      "anthropic-messages",
    );
    const body = projected.body as Record<string, unknown>;
    expect(body.usage).toMatchObject({input_tokens: 12, output_tokens: 88});
  });

  test("chat：body.choices[0].message 含合并后的 tool_calls 与 finish_reason", async () => {
    const projected = await projectSse(
      sseOf(chatChunks, false) + "data: [DONE]\n\n",
      "openai-chat-completions",
    );
    const body = projected.body as Record<string, unknown>;
    const choice = (body.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe("tool_calls");
    const calls = (choice.message as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect(calls[0].function).toEqual({name: "bash", arguments: "{\"command\":\"ls\"}"});
    expect(body.usage).toMatchObject({prompt_tokens: 10, completion_tokens: 20});
  });

  test("responses 协议不受影响：仍取 response.completed 快照", async () => {
    const events = [
      {type: "response.created", response: {id: "r1", status: "in_progress"}},
      {type: "response.completed", response: {id: "r1", status: "completed", output: [{type: "function_call", call_id: "c1", name: "shell", arguments: "{}"}], usage: {input_tokens: 5, output_tokens: 6}}},
    ];
    const projected = await projectSse(sseOf(events, false), "openai-responses");
    const body = projected.body as Record<string, unknown>;
    expect(body.status).toBe("completed");
    expect(body.output).toHaveLength(1);
  });
});

describe("端到端：投影 → normalizeExchange 提取 toolUses（修复目标行为）", () => {
  function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  function streamingV2Exchange(exchangeId: string, agent: string, wireApi: "messages" | "chat_completions", path: string, requestBody: string, sseBody: string) {
    return {
      schemaVersion: 2 as const,
      exchangeId,
      captureSessionId: "capture-assembly-e2e",
      sequence: 1,
      capturedAt: "2026-09-11T05:00:00.000Z",
      completedAt: "2026-09-11T05:00:01.000Z",
      durationMs: 1000,
      routing: {
        targetId: "target-1",
        targetName: "Target",
        targetFormatHint: wireApi === "messages" ? "anthropic" as const : "openai" as const,
        localUrl: `http://127.0.0.1:3211/${agent}${path}`,
        upstreamUrl: `https://example.test${path}`,
        localPath: path,
        upstreamPath: path,
        method: "POST",
        agent,
        wireApi,
      },
      request: {
        headers: {"user-agent": `${agent}/1.0`},
        rawBody: requestBody,
        bodySizeBytes: Buffer.byteLength(requestBody),
        bodySha256: sha256(requestBody),
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: {"content-type": "text/event-stream"},
        rawBody: sseBody,
        bodySizeBytes: Buffer.byteLength(sseBody),
        bodySha256: sha256(sseBody),
        isStreaming: true,
      },
      bodyStorage: {policy: "inline" as const, compression: "gzip" as const, externalBlobDir: "blobs", thresholdBytes: 65536},
      captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    };
  }

  test("anthropic 流式（zcode/claude 形态）：toolUses/thinking/stopReason 全部恢复", async () => {
    const requestBody = JSON.stringify({
      model: "glm-5.3",
      max_tokens: 1024,
      stream: true,
      system: [{type: "text", text: "You are ZCode"}],
      tools: [{name: "Bash", description: "run", input_schema: {type: "object"}}],
      messages: [{role: "user", content: [{type: "text", text: "这是啥项目"}]}],
    });
    const sse = anthropicEvents
      .map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const exchange = streamingV2Exchange(
      "capture-assembly-e2e:ex-1",
      "zcode",
      "messages",
      "/v1/messages",
      requestBody,
      sse,
    );
    const projector = createExchangeProjector({dataDir: "/tmp/assembly-e2e-unused"});
    const projection = await projector.project(exchange, 4);
    expect((projection.exchange.response.parsedBody as Record<string, unknown>).content)
      .not.toHaveLength(0);
    const normalized = normalizeExchange(projection.exchange);
    expect(normalized.response.toolUses.map(use => use.name)).toEqual(["Bash"]);
    expect(normalized.response.stopReason).toBe("tool_use");
    expect(normalized.response.reasoningBlocks).toHaveLength(1);
    expect(normalized.response.usage?.inputTokens).toBe(12);
  });

  test("chat 流式（dsh/opencode 形态）：toolUses/stopReason 恢复", async () => {
    const requestBody = JSON.stringify({
      model: "glm-5.3",
      stream: true,
      messages: [{role: "user", content: "这是啥项目"}],
      tools: [{type: "function", function: {name: "bash", description: "run", parameters: {type: "object"}}}],
    });
    const sse = chatChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const exchange = streamingV2Exchange(
      "capture-assembly-e2e:ex-2",
      "opencode",
      "chat_completions",
      "/v1/chat/completions",
      requestBody,
      sse,
    );
    const projector = createExchangeProjector({dataDir: "/tmp/assembly-e2e-unused"});
    const projection = await projector.project(exchange, 4);
    const normalized = normalizeExchange(projection.exchange);
    expect(normalized.response.toolUses.map(use => use.name)).toEqual(["bash"]);
    expect(normalized.response.stopReason).toBe("tool_calls");
    expect(normalized.response.usage?.inputTokens).toBe(10);
  });
});
