import { expect, test } from "vitest";
import { sseEventsToMessageBody } from "../src/anthropic.js";
import { parseSSEEvents } from "../src/sse.js";
import type { SSEEvent } from "../src/sse.js";

test("parses SSE data fields without a space after the colon", () => {
  const events = parseSSEEvents([
    "event: message_start",
    'data:{"type":"message_start","message":{"model":"ali/glm-5.1"}}',
    "",
    "event: content_block_delta",
    'data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    "",
  ].join("\n"));

  expect(events).toEqual([
    {
      event: "message_start",
      data: { type: "message_start", message: { model: "ali/glm-5.1" } },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "你好" },
      },
    },
  ]);
});

test("uses the SSE event field when JSON data does not include a type", () => {
  const events = parseSSEEvents([
    "event: content_block_delta",
    'data:{"index":0,"delta":{"type":"text_delta","text":"你好"}}',
    "",
  ].join("\n"));

  expect(events).toEqual([
    {
      event: "content_block_delta",
      data: {
        index: 0,
        delta: { type: "text_delta", text: "你好" },
      },
    },
  ]);
});

test("converts Anthropic SSE events into a final message JSON body", () => {
  const body = sseEventsToMessageBody([
    {
      event: "message_start",
      data: {
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "glm-5.1",
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { index: 0, delta: { type: "text_delta", text: "你好" } },
    },
    {
      event: "content_block_delta",
      data: { index: 0, delta: { type: "text_delta", text: "，世界" } },
    },
    {
      event: "content_block_stop",
      data: { index: 0 },
    },
    {
      event: "message_delta",
      data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    },
    {
      event: "message_stop",
      data: {},
    },
  ], "ali/glm-5.1");

  expect(body).toEqual({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-5.1",
    content: [{ type: "text", text: "你好，世界" }],
    usage: { input_tokens: 10, output_tokens: 4 },
    stop_reason: "end_turn",
  });
});

test("converts streamed tool input JSON into a tool_use content block", () => {
  const body = sseEventsToMessageBody([
    {
      event: "message_start",
      data: { message: { type: "message", role: "assistant", model: "glm-5.1", content: [] } },
    },
    {
      event: "content_block_start",
      data: {
        index: 0,
        content_block: { type: "tool_use", id: "tool_1", name: "Read", input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: { index: 0, delta: { type: "input_json_delta", partial_json: "{\"file_" } },
    },
    {
      event: "content_block_delta",
      data: { index: 0, delta: { type: "input_json_delta", partial_json: "path\":\"/tmp/a.ts\"}" } },
    },
    {
      event: "content_block_stop",
      data: { index: 0 },
    },
    {
      event: "message_delta",
      data: { delta: { stop_reason: "tool_use" } },
    },
  ]);

  expect(body.content).toEqual([
    {
      type: "tool_use",
      id: "tool_1",
      name: "Read",
      input: { file_path: "/tmp/a.ts" },
    },
  ]);
  expect(body.stop_reason).toBe("tool_use");
});

// 保留 SSEEvent 类型的编译时引用，确保类型导出可用
function _typeCheck(e: SSEEvent): SSEEvent { return e; }
