import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  anthropicJsonToolBlockLane,
  classifySemanticLane,
  isAnthropicToolBlockType,
  isToolBlockMetadata,
  normalizeAnthropicBlockType,
  normalizeSseContentFamily,
  resolveAnthropicSseLane,
  resolveOpenAiResponsesSseLane,
  resolveSseLane,
} from "../src/lib/conversation-semantics/index.js";
import { iterateConversationBodyEvents } from "../src/lib/export-conversation.js";
import { projectProtocolStream } from "../src/lib/ingestion/protocol-stream-projector.js";

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 逐事件拼 SSE wire 文本（与真实抓包同形）。 */
function sse(events: Array<{event: string; data: unknown}>): string {
  return events
    .map(({event, data}) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

async function exportItems(options: {
  wire: string;
  format: "sse" | "json";
  protocol: "openai-responses" | "openai-chat-completions" | "anthropic-messages";
  exchangeId: string;
  withPreview: boolean;
  side?: "request" | "response";
}): Promise<{
  starts: Array<Record<string, unknown>>;
  texts: Map<number, string>;
}> {
  const side = options.side ?? "response";
  const projected = options.withPreview
    ? await projectProtocolStream({
        stream: Readable.from([options.wire]),
        format: options.format,
        exchangeId: options.exchangeId,
        bodySide: side,
        rawBodySha256: sha256Text(options.wire),
        sourceStorage: "inline",
        projectionVersion: 4,
        protocol: options.protocol,
        endpointKind: "model-call",
      })
    : undefined;
  const starts: Array<Record<string, unknown>> = [];
  const texts = new Map<number, string>();
  let ordinal = -1;
  for await (const event of iterateConversationBodyEvents({
    stream: Readable.from([options.wire]),
    format: options.format,
    exchangeId: options.exchangeId,
    side,
    rawBodySha256: sha256Text(options.wire),
    sourceStorage: "inline",
    protocol: options.protocol,
    ...(projected ? {previewItems: projected.preview.items} : {}),
  })) {
    if (event.type === "item_start") {
      ordinal += 1;
      starts.push({...event, ordinal});
      texts.set(ordinal, "");
    } else if (event.type === "text") {
      texts.set(ordinal, (texts.get(ordinal) ?? "") + event.value);
    }
  }
  return {starts, texts};
}

describe("共享 lane 分类器（两条链唯一真相）", () => {
  test("openai-responses 覆盖 custom_tool_call_input 且同一 lane 共用稳定键", () => {
    const first = resolveOpenAiResponsesSseLane({
      protocol: "openai-responses",
      eventType: "response.custom_tool_call_input.delta",
      itemId: "ctc_1",
      outputIndex: "3",
    });
    const second = resolveOpenAiResponsesSseLane({
      protocol: "openai-responses",
      eventType: "response.custom_tool_call_input.delta",
      itemId: "ctc_1",
      outputIndex: "3",
    });
    expect(first?.family).toBe("custom_tool_call_input");
    expect(first?.key).toBe(second?.key);
    expect(first?.parentIdentity).toBe("item:ctc_1");
    expect(first?.semanticLane).toBe("content:0:custom_tool_call_input");
    expect(first?.phase).toBe("delta");
    expect(resolveOpenAiResponsesSseLane({
      protocol: "openai-responses",
      eventType: "response.custom_tool_call_input.done",
      itemId: "ctc_1",
    })?.phase).toBe("final");
  });

  test("未知事件不产生 lane，历史家族保持兼容", () => {
    expect(resolveOpenAiResponsesSseLane({
      protocol: "openai-responses",
      eventType: "response.output_item.added",
      itemId: "ctc_1",
    })).toBeUndefined();
    expect(resolveOpenAiResponsesSseLane({
      protocol: "openai-responses",
      eventType: "response.function_call_arguments.delta",
      itemId: "call_1",
    })?.family).toBe("function_call_arguments");
    expect(resolveOpenAiResponsesSseLane({
      protocol: "openai-responses",
      eventType: "response.output_text.delta",
      itemId: "msg_1",
      contentIndex: "2",
    })?.semanticLane).toBe("content:2:output_text");
  });

  test("anthropic block 类型归一化与 lane 判定", () => {
    expect(normalizeAnthropicBlockType("input_json_delta")).toBe("tool_use");
    expect(normalizeAnthropicBlockType("signature_delta")).toBeUndefined();
    expect(resolveAnthropicSseLane({
      protocol: "anthropic-messages",
      eventType: "content_block_delta",
      index: "0",
      blockType: "text_delta",
    })).toMatchObject({key: "anthropic:content-block:0", semanticLane: "content:0:text"});
    expect(resolveSseLane({
      protocol: "openai-chat-completions",
      eventType: "content_block_delta",
      index: "0",
    })).toBeUndefined();
  });

  test("Chat Completions 按字段路径拆分 content/reasoning/refusal 与并行工具 lane", () => {
    const content = resolveSseLane({
      protocol: "openai-chat-completions",
      eventType: "chat.completion.chunk",
      evidencePath: "$.events[0].data.choices[0].delta.content",
    });
    const reasoning = resolveSseLane({
      protocol: "openai-chat-completions",
      eventType: "chat.completion.chunk",
      evidencePath: "$.events[1].data.choices[0].delta.reasoning_content",
    });
    const firstTool = resolveSseLane({
      protocol: "openai-chat-completions",
      eventType: "chat.completion.chunk",
      evidencePath: "$.events[2].data.choices[0].delta.tool_calls[0].function.arguments",
    });
    const secondTool = resolveSseLane({
      protocol: "openai-chat-completions",
      eventType: "chat.completion.chunk",
      evidencePath: "$.events[2].data.choices[1].delta.tool_calls[0].function.arguments",
    });
    const refusal = resolveSseLane({
      protocol: "openai-chat-completions",
      eventType: "chat.completion.chunk",
      evidencePath: "$.events[3].data.choices[0].delta.refusal",
    });

    expect(content).toMatchObject({
      family: "content",
      semanticLane: "choice:0:content",
      parentIdentity: "choice:0",
      phase: "delta",
    });
    expect(reasoning).toMatchObject({
      family: "reasoning",
      semanticLane: "choice:0:reasoning",
      parentIdentity: "choice:0",
    });
    expect(firstTool).toMatchObject({
      family: "tool_use",
      semanticLane: "choice:0:tool:0",
      parentIdentity: "choice:0:tool:0",
    });
    expect(secondTool?.key).not.toBe(firstTool?.key);
    expect(secondTool?.semanticLane).toBe("choice:1:tool:0");
    expect(refusal?.semanticLane).toBe("choice:0:refusal");
    expect(resolveSseLane({
      protocol: "openai-chat-completions",
      eventType: "chat.completion.chunk",
      evidencePath: "$.events[4].data.choices[0].delta.role",
    })).toBeUndefined();
  });

  test("Chat SSE 同一 chunk 的 content/reasoning/并行 tool_calls 在 Preview 中各自聚合", async () => {
    const wire = sse([
      {
        event: "",
        data: {
          id: "chatcmpl-lane",
          object: "chat.completion.chunk",
          model: "deepseek-v4",
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "答案一",
              reasoning_content: "思考一",
              tool_calls: [
                {index: 0, id: "call-a", type: "function", function: {name: "read", arguments: "{path:"}},
                {index: 1, id: "call-b", type: "function", function: {name: "write", arguments: "{path:"}},
              ],
            },
            finish_reason: null,
          }],
        },
      },
      {
        event: "",
        data: {
          id: "chatcmpl-lane",
          object: "chat.completion.chunk",
          model: "deepseek-v4",
          choices: [{
            index: 0,
            delta: {
              content: "答案二",
              reasoning_content: "思考二",
              tool_calls: [
                {index: 0, function: {arguments: "a.txt}"}},
                {index: 1, function: {arguments: "b.txt}"}},
              ],
            },
            finish_reason: "tool_calls",
          }],
        },
      },
      {event: "", data: "[DONE]"},
    ]);

    const projected = await projectProtocolStream({
      stream: Readable.from([wire]),
      format: "sse",
      exchangeId: "ex-chat-lane",
      bodySide: "response",
      rawBodySha256: sha256Text(wire),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-chat-completions",
      agentKind: "dsh",
      endpointKind: "model-call",
    });
    const items = projected.preview.items.filter(item => item.side === "response");
    expect(items.filter(item => item.semanticCategory === "assistant")).toHaveLength(1);
    expect(items.filter(item => item.semanticCategory === "reasoning")).toHaveLength(1);
    expect(items.filter(item => item.semanticCategory === "tool_use")).toHaveLength(2);
    expect(items.find(item => item.semanticCategory === "assistant")?.textPreview).toBe("答案一答案二");
    expect(items.find(item => item.semanticCategory === "reasoning")?.textPreview).toBe("思考一思考二");
    expect(items.filter(item => item.semanticCategory === "tool_use").map(item => item.toolName).sort()).toEqual(["read", "write"]);
  });

  test("Chat SSE 工具 arguments 先到时，后续 id/name 仍回填同一 Preview lane", async () => {
    const wire = sse([
      {
        event: "",
        data: {
          id: "chatcmpl-late-tool-meta",
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: {tool_calls: [{index: 0, function: {arguments: "{\"path\":\""}}]},
            finish_reason: null,
          }],
        },
      },
      {
        event: "",
        data: {
          id: "chatcmpl-late-tool-meta",
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: {tool_calls: [{index: 0, id: "call-late", type: "function", function: {name: "read", arguments: "a.txt\"}"}}]},
            finish_reason: "tool_calls",
          }],
        },
      },
      {event: "", data: "[DONE]"},
    ]);

    const projected = await projectProtocolStream({
      stream: Readable.from([wire]),
      format: "sse",
      exchangeId: "ex-chat-late-tool-meta",
      bodySide: "response",
      rawBodySha256: sha256Text(wire),
      sourceStorage: "inline",
      projectionVersion: 7,
      protocol: "openai-chat-completions",
      agentKind: "dsh",
      endpointKind: "model-call",
    });
    const item = projected.preview.items.find(candidate => candidate.semanticCategory === "tool_use");
    expect(item).toMatchObject({toolUseId: "call-late", toolName: "read"});
    expect(item?.textPreview).toBe('{"path":"a.txt"}');
  });

  test("Chat SSE Raw Export 与 Preview 使用相同 logical lane", async () => {
    const wire = sse([
      {
        event: "",
        data: {
          id: "chatcmpl-export-lane",
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: {content: "正文", reasoning_content: "推理", tool_calls: [
              {index: 0, id: "call-export", type: "function", function: {name: "read", arguments: "{}"}},
            ]},
            finish_reason: null,
          }],
        },
      },
      {event: "", data: {choices: [{index: 0, delta: {}, finish_reason: "stop"}]}},
      {event: "", data: "[DONE]"},
    ]);
    const projected = await projectProtocolStream({
      stream: Readable.from([wire]),
      format: "sse",
      exchangeId: "ex-chat-export-lane",
      bodySide: "response",
      rawBodySha256: sha256Text(wire),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-chat-completions",
      agentKind: "dsh",
      endpointKind: "model-call",
    });
    const exported = await exportItems({
      wire,
      format: "sse",
      protocol: "openai-chat-completions",
      exchangeId: "ex-chat-export-lane",
      withPreview: true,
    });
    const previewByCategory = new Map(
      projected.preview.items
        .filter(item => item.side === "response")
        .map(item => [item.semanticCategory, item] as const),
    );
    expect(exported.starts.map(item => item.category).sort()).toEqual(["assistant", "reasoning", "tool_use"].sort());
    for (const start of exported.starts) {
      const preview = previewByCategory.get(start.category as string);
      expect(preview).toBeDefined();
      expect(start.logicalId).toBe(preview?.logicalId);
    }
  });

  test("custom_tool_call_input 归类为 tool_use（防止再退回 unknown_output）", () => {
    const semantic = classifySemanticLane({
      protocol: "openai-responses",
      bodySide: "response",
      providerItemType: "custom_tool_call_input",
      ancestorTypes: ["response.custom_tool_call_input.delta"],
      evidencePath: "$.events[100].data.delta",
      parentIdentity: "item:ctc_1",
      semanticLane: "content:0:custom_tool_call_input",
      toolName: "exec",
      toolUseId: "call_abc",
    });
    expect(semantic.semanticCategory).toBe("tool_use");
    expect(semantic.provenance).toBe("model_output");
  });

  test("工具块元数据判定排除 call_output", () => {
    expect(isToolBlockMetadata({type: "tool_use"})).toBe(true);
    expect(isToolBlockMetadata({type: "custom_tool_call"})).toBe(true);
    expect(isToolBlockMetadata({type: "function_call_output"})).toBe(false);
    expect(isToolBlockMetadata({type: "text"})).toBe(false);
    expect(isAnthropicToolBlockType("server_tool_use")).toBe(true);
    expect(normalizeSseContentFamily("input-json-delta")).toBe("input_json_delta");
    expect(anthropicJsonToolBlockLane({
      index: 2,
      blockType: "tool_use",
      toolUseId: "call_x",
    })).toEqual({
      parentIdentity: "item:call_x",
      semanticLane: "content:2:tool_use",
    });
  });
});

describe("Codex 自由格式工具（custom_tool_call）不再被拆片", () => {
  const wire = sse([
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "ctc_1",
          type: "custom_tool_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "exec",
          input: "",
        },
      },
    },
    {
      event: "response.custom_tool_call_input.delta",
      data: {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        output_index: 1,
        delta: "const cmds = [",
      },
    },
    {
      event: "response.custom_tool_call_input.delta",
      data: {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        output_index: 1,
        delta: "\n  [\"readme\", \"sed -n 1,20p README.md\"],",
      },
    },
    {
      event: "response.custom_tool_call_input.delta",
      data: {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        output_index: 1,
        delta: "\n];\nout.forEach(text);\n",
      },
    },
    {
      event: "response.custom_tool_call_input.done",
      data: {
        type: "response.custom_tool_call_input.done",
        item_id: "ctc_1",
        output_index: 1,
        input: "const cmds = [];\nout.forEach(text);\n",
      },
    },
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "ctc_1",
          type: "custom_tool_call",
          call_id: "call_abc",
          name: "exec",
          input: "const cmds = [];\nout.forEach(text);\n",
        },
      },
    },
    {
      event: "response.completed",
      data: {type: "response.completed", response: {id: "resp_1", output: []}},
    },
  ]);

  test("Worker 预览只产出一条工具项（不再每个 delta 一条）", async () => {
    const projected = await projectProtocolStream({
      stream: Readable.from([wire]),
      format: "sse",
      exchangeId: "ex-custom-tool",
      bodySide: "response",
      rawBodySha256: sha256Text(wire),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-responses",
      endpointKind: "model-call",
    });
    const responseItems = projected.preview.items.filter(item => item.side === "response");
    expect(responseItems).toHaveLength(1);
    expect(responseItems[0]).toMatchObject({
      semanticCategory: "tool_use",
      toolName: "exec",
      toolUseId: "call_abc",
    });
    // Worker 预览的 itemType 保留原始 SSE 事件类型（与 output_text 等家族的既有惯例一致）。
    expect(responseItems[0]!.itemType).toContain("custom_tool_call_input");
    expect(responseItems[0]!.originalTextBytes).toBeGreaterThan(40);
  });

  test("交互内容导出产出唯一一条 tool_use，无 unknown_output 碎片", async () => {
    const {starts, texts} = await exportItems({
      wire,
      format: "sse",
      protocol: "openai-responses",
      exchangeId: "ex-custom-tool",
      withPreview: true,
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      category: "tool_use",
      side: "output",
      toolName: "exec",
      toolUseId: "call_abc",
    });
    expect(texts.get(0)).toContain("const cmds = [");
    expect(texts.get(0)).toContain("out.forEach(text);");
    expect(starts.some(start => start.category === "unknown_output")).toBe(false);
  });

  test("缺少持久化预览时（仅凭 raw 重投影）仍归为 tool_use", async () => {
    const {starts} = await exportItems({
      wire,
      format: "sse",
      protocol: "openai-responses",
      exchangeId: "ex-custom-tool-no-preview",
      withPreview: false,
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({category: "tool_use", toolUseId: "call_abc"});
  });
});

describe("非流式 anthropic 工具调用可见", () => {
  const body = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-5.3-flash",
    content: [
      {
        type: "tool_use",
        id: "call_3f465a1708504411a4eca68c",
        name: "Bash",
        input: {
          command: "kill -TERM $(lsof -tiTCP:3210 -sTCP:LISTEN)",
          description: "Deploy (restart only)",
          timeout: 300000,
          background: true,
        },
      },
      {type: "text", text: "先重启服务再验证。"},
    ],
    stop_reason: "tool_use",
    usage: {input_tokens: 10, output_tokens: 20},
  });

  test("Worker 预览为每个工具块产出一条 JSON 入参项", async () => {
    const projected = await projectProtocolStream({
      stream: Readable.from([body]),
      format: "json",
      exchangeId: "ex-anthropic-json-tool",
      bodySide: "response",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });
    const toolItems = projected.preview.items.filter(
      item => item.side === "response" && item.semanticCategory === "tool_use",
    );
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]!.toolName).toBe("Bash");
    expect(toolItems[0]!.textPreview).toContain('"command"');
  });

  test("导出重投影产出工具项（键名不在文本白名单也必须可见）", async () => {
    const {starts, texts} = await exportItems({
      wire: body,
      format: "json",
      protocol: "anthropic-messages",
      exchangeId: "ex-anthropic-json-tool",
      withPreview: true,
    });
    const toolIndex = starts.findIndex(start => start.category === "tool_use");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(starts[toolIndex]).toMatchObject({
      side: "output",
      toolName: "Bash",
      toolUseId: "call_3f465a1708504411a4eca68c",
      jsonPath: "$.content[0]",
    });
    const parsed = JSON.parse(texts.get(toolIndex)!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: "kill -TERM $(lsof -tiTCP:3210 -sTCP:LISTEN)",
      description: "Deploy (restart only)",
      timeout: 300000,
      background: true,
    });
    expect(starts.some(start => start.category === "assistant")).toBe(true);
  });

  test("空入参工具块仍然产出条目（不能因为无叶子而消失）", async () => {
    const emptyInput = JSON.stringify({
      id: "msg_2",
      type: "message",
      role: "assistant",
      content: [{type: "tool_use", id: "call_empty", name: "TodoRead", input: {}}],
      stop_reason: "tool_use",
    });
    const {starts, texts} = await exportItems({
      wire: emptyInput,
      format: "json",
      protocol: "anthropic-messages",
      exchangeId: "ex-anthropic-empty-tool",
      withPreview: true,
    });
    const toolIndex = starts.findIndex(start => start.category === "tool_use");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(texts.get(toolIndex)).toBe("{}");
  });
});

describe("请求骨架缺失的排重基线保护", () => {
  test("本地导入缺 system 的请求不推进线程基线；网关请求不受影响", async () => {
    const {isDegradedRequestBaseline} = await import("../src/lib/export-content-events.js");
    expect(isDegradedRequestBaseline(
      {origin: "agent_local_import", captureDiagnosticCodes: []},
      {inputItemCount: 42, hasSystemInput: false},
    )).toBe(true);
    expect(isDegradedRequestBaseline(
      {origin: "agent_local_import", captureDiagnosticCodes: []},
      {inputItemCount: 42, hasSystemInput: true},
    )).toBe(false);
    expect(isDegradedRequestBaseline(
      {origin: "gateway", captureDiagnosticCodes: []},
      {inputItemCount: 42, hasSystemInput: false},
    )).toBe(false);
    expect(isDegradedRequestBaseline(
      {origin: "agent_local_import", captureDiagnosticCodes: ["request_skeleton_missing"]},
      {inputItemCount: 42, hasSystemInput: true},
    )).toBe(true);
    expect(isDegradedRequestBaseline(
      {origin: "agent_local_import", captureDiagnosticCodes: []},
      {inputItemCount: 0, hasSystemInput: false},
    )).toBe(false);
  });
});
