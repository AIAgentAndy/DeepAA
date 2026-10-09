import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  buildExportConversationQuery,
  type ExportConversationQueryInput,
} from "../src/lib/export-query.js";
import {
  extractConversationItems,
  iterateConversationBodyEvents,
  loadExportConversation,
  conversationFingerprintKey,
  previewConversationCategory,
} from "../src/lib/export-conversation.js";
import { normalizeExchange } from "../src/lib/harness/normalizer.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";
import { projectProtocolStream } from "../src/lib/ingestion/protocol-stream-projector.js";

function makeExchange(options: {
  exchangeId: string;
  path: string;
  headers?: Record<string, string>;
  request: unknown;
  response: unknown;
}): RawCapturedExchange {
  const capturedAt = "2026-05-31T10:00:00.000Z";
  return {
    schemaVersion: 1,
    exchangeId: options.exchangeId,
    captureSessionId: "capture-test",
    sequence: 1,
    capturedAt,
    completedAt: capturedAt,
    durationMs: 100,
    routing: {
      targetId: "anthropic",
      targetName: "Anthropic",
      targetFormatHint: options.path.includes("responses") ? "openai" : "anthropic",
      localUrl: `http://localhost:3211${options.path}`,
      upstreamUrl: `https://example.test${options.path}`,
      localPath: options.path,
      upstreamPath: options.path,
      method: "POST",
    },
    request: {
      headers: options.headers || {},
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
      isStreaming: false,
    },
    stream: undefined,
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

describe("交互内容查询与纯提取", () => {
  test("显式完整导出逐 chunk 输出长文本并把 Base64 媒体替换为描述符", async () => {
    const binary = Buffer.from("stream-export-image".repeat(512));
    const base64 = binary.toString("base64");
    const longTail = `尾部-${"长文本".repeat(4_000)}`;
    const body = JSON.stringify({
      messages: [{
        role: "user",
        content: `开始 data:image/png;base64,${base64} 结束 ${longTail}`,
      }],
    });
    const chunks = Array.from(
      { length: Math.ceil(body.length / 7) },
      (_, index) => body.slice(index * 7, index * 7 + 7),
    );
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from(chunks),
      exchangeId: "exchange-stream-export",
      side: "request",
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
      sourceStorage: "inline",
      protocol: "anthropic-messages",
    })) events.push(event);

    const text = events
      .filter((event): event is Extract<typeof event, { type: "text" }> => event.type === "text")
      .map(event => event.value)
      .join("");
    expect(text).toContain(longTail);
    expect(text).not.toContain("data:image/png;base64,");
    expect(text).not.toContain(base64.slice(100, 300));
    expect(text).toContain("[media image/png");
    expect(text).toContain(createHash("sha256").update(binary).digest("hex"));
    expect(events[0]).toMatchObject({ type: "item_start", side: "input", category: "user_real" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "media_descriptor",
      mediaType: "image/png",
      decodedBytes: binary.length,
      sha256: createHash("sha256").update(binary).digest("hex"),
    }));
    expect(events.at(-1)).toMatchObject({
      type: "item_end",
      textSha256: createHash("sha256")
        .update(`开始 data:image/png;base64,${base64} 结束 ${longTail}`)
        .digest("hex"),
      originalTextBytes: Buffer.byteLength(`开始 data:image/png;base64,${base64} 结束 ${longTail}`),
    });
  });

  test("显式完整导出增量解析 SSE data 事件并忽略 DONE", async () => {
    const sse = [
      "event: response.output_text.delta\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"第一段\"}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"第二段\"}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const chunks = Array.from(
      { length: Math.ceil(sse.length / 5) },
      (_, index) => sse.slice(index * 5, index * 5 + 5),
    );
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from(chunks),
      format: "sse",
      exchangeId: "exchange-sse-export",
      side: "response",
      rawBodySha256: createHash("sha256").update(sse).digest("hex"),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) events.push(event);

    const text = events
      .filter((event): event is Extract<typeof event, { type: "text" }> => event.type === "text")
      .map(event => event.value)
      .join("");
    expect(text).toContain("第一段");
    expect(text).toContain("第二段");
    expect(text).not.toContain("DONE");
    expect(events.filter(event => event.type === "item_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "item_end")).toHaveLength(1);
  });

  test("嵌套 content 从祖先对象保留 developer 角色", async () => {
    const body = JSON.stringify({
      input: [{ role: "developer", content: [{ type: "input_text", text: "开发约束" }] }],
    });
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-developer-role",
      side: "request",
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts).toEqual([
      expect.objectContaining({ category: "developer", side: "input" }),
    ]);
  });

  test("Raw Anthropic 顶层 system 与真实 user 使用统一语义类别", async () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "You are Claude Code." }],
      messages: [{
        role: "user",
        content: [{ type: "text", text: "确认，请实现！" }],
      }],
    });
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-anthropic-system",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "anthropic-messages",
      agentKind: "claude-code",
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts.map(event => event.category)).toEqual([
      "system",
      "user_real",
    ]);
  });

  test("Raw Codex checkpoint 归 control 而不冒充真实 user", async () => {
    const body = JSON.stringify({
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.",
        }],
      }],
    });
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-codex-checkpoint",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "openai-responses",
      agentKind: "codex",
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts).toEqual([
      expect.objectContaining({
        category: "control",
        provenance: "agent_control",
      }),
    ]);
  });

  test("zcode 信封注入（system-reminder）分类 user_injected（2026-09-16 双链路）", async () => {
    const body = JSON.stringify({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "<system-reminder>\nThe TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool.\n</system-reminder>",
        }],
      }],
    });
    const starts: Array<{category: string; provenance: string}> = [];
    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-zcode-reminder",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "anthropic-messages",
      agentKind: "zcode",
    })) {
      if (event.type === "item_start") {
        starts.push({category: event.category, provenance: event.provenance});
      }
    }
    expect(starts).toEqual([
      expect.objectContaining({category: "user_injected", provenance: "agent_injected"}),
    ]);
  });

  test("OpenCode/dsh AgentKind 不做 Codex 信封猜测，保持协议用户语义", async () => {
    const body = JSON.stringify({
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.",
        }],
      }],
    });
    for (const agentKind of ["opencode", "dsh"]) {
      const starts: Array<{
        category: string;
        provenance: string;
        confidence: string;
      }> = [];
      for await (const event of iterateConversationBodyEvents({
        stream: Readable.from([body]),
        exchangeId: `exchange-${agentKind}-checkpoint`,
        side: "request",
        rawBodySha256: sha256Text(body),
        sourceStorage: "inline",
        protocol: "openai-responses",
        agentKind,
      })) {
        if (event.type === "item_start") {
          starts.push({
            category: event.category,
            provenance: event.provenance,
            confidence: event.confidence,
          });
        }
      }
      expect(starts).toEqual([{
        category: "user_real",
        provenance: "protocol_user",
        confidence: "protocol_role",
      }]);
    }
  });

  test("Responses Request 不把历史 reasoning 摘要归为真实用户输入", async () => {
    const body = JSON.stringify({
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "**Planning concise user acknowledgment**" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "收到：5。" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "6" }],
        },
      ],
    });
    const logicalItems: Array<{ category: string; text: string }> = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-responses-reasoning-history",
      side: "request",
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) {
      if (event.type === "item_start") {
        logicalItems.push({ category: event.category, text: "" });
      } else if (event.type === "text") {
        logicalItems.at(-1)!.text += event.value;
      }
    }

    expect(logicalItems).toEqual([{ category: "user_real", text: "6" }]);
  });

  test("Raw 流在没有 SQLite Preview 时仍区分 Agent 注入与真实用户输入", async () => {
    const body = JSON.stringify({
      input: [
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>",
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "<environment_context>\n<cwd>/tmp/project</cwd>",
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "1" }],
        },
      ],
    });
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-raw-injected-context",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "openai-responses",
      agentKind: "codex",
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts.map(event => event.category)).toEqual([
      "user_injected",
      "user_injected",
      "user_real",
    ]);
  });

  test("Agent 注入分类完成后再按最终类别消费继承指纹", async () => {
    const text = "<environment_context>\n<cwd>/tmp/project</cwd>";
    const body = JSON.stringify({
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      }],
    });
    const textSha256 = sha256Text(text);
    const inheritedFingerprints = new Map([[conversationFingerprintKey({
      category: "user_injected",
      side: "input",
      provenance: "agent_injected",
      providerItemType: "content",
      textSha256,
      contentKinds: ["text"],
    }), 1]]);
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-injected-dedupe",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "openai-responses",
      previewItems: [{
        side: "request",
        category: "message",
        role: "user",
        itemType: "content",
        ancestorTypes: [],
        jsonPath: "$.input[0].content[0].text",
        semanticCategory: "user_injected",
        provenance: "agent_injected",
        confidence: "exact",
        displayPolicy: "conversation",
        dedupePolicy: "occurrence",
        logicalId: "semantic:input:injected",
        textSha256,
        originalTextBytes: Buffer.byteLength(text),
        previewTextBytes: 0,
        truncated: true,
        mediaDescriptorOrdinals: [],
      }],
      inheritedFingerprints,
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts).toEqual([
      expect.objectContaining({ category: "user_injected", stepDiff: "inherited" }),
    ]);
    expect(inheritedFingerprints.get(conversationFingerprintKey({
      category: "user_injected",
      side: "input",
      provenance: "agent_injected",
      providerItemType: "content",
      textSha256,
      contentKinds: ["text"],
    }))).toBe(0);
  });

  test("Codex 自定义工具输出识别为工具结果且工具动作不伪装成用户输入", async () => {
    const body = JSON.stringify({
      input: [
        {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "exec_command",
          input: "{\"cmd\":\"pwd\"}",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: "Script completed\nWall time 0.1 seconds\nOutput:",
        },
      ],
    });
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-codex-custom-tool",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts).toEqual([
      expect.objectContaining({
        category: "tool_result",
        side: "input",
        toolUseId: "call-1",
      }),
    ]);
  });

  test("OpenAI JSON 请求的消息 id 不泄漏进 toolUseId 与指纹，工具项仍保留 call_id", async () => {
    const body = JSON.stringify({
      model: "fixture-model",
      instructions: "系统说明",
      input: [
        {
          type: "message",
          id: "msg-dev-1",
          role: "developer",
          content: [{ type: "input_text", text: "开发约束" }],
        },
        {
          type: "message",
          id: "msg-user-1",
          role: "user",
          content: [{ type: "input_text", text: "真实输入" }],
        },
        {
          type: "function_call",
          id: "fc-1",
          call_id: "call-1",
          name: "exec_command",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          id: "fco-1",
          call_id: "call-1",
          output: "ok",
        },
      ],
    });
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-json-message-id",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "openai-responses",
      agentKind: "codex",
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts.map(event => ({
      category: event.category,
      toolUseId: event.toolUseId,
    }))).toEqual([
      { category: "system", toolUseId: undefined },
      { category: "developer", toolUseId: undefined },
      { category: "user_real", toolUseId: undefined },
      { category: "tool_result", toolUseId: "call-1" },
    ]);
  });

  test("Codex 工具输出数组中的 input_text 继承父级工具结果语义并合并为一个逻辑项", async () => {
    const body = JSON.stringify({
      input: [
        {
          type: "custom_tool_call_output",
          call_id: "call-array",
          output: [
            { type: "input_text", text: "Script completed" },
            { type: "input_text", text: "命令失败：找不到文件" },
            { type: "input_text", text: "Output: stderr" },
          ],
        },
      ],
    });
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-codex-custom-tool-array",
      side: "request",
      rawBodySha256: sha256Text(body),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start")).toHaveLength(3);
    expect(events.filter(event => event.type === "item_start").every(event =>
      event.category === "tool_result"
      && event.side === "input"
      && event.toolUseId === "call-array"
    )).toBe(true);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("Script completed命令失败：找不到文件Output: stderr");
    expect(events.filter(event => event.type === "item_end")).toHaveLength(3);
  });

  test("SQLite Preview 对 Codex 自定义工具记录使用同一分类规则", () => {
    const common = {
      side: "request" as const,
      category: "tool",
      jsonPath: "$.input[0].output",
      textPreview: "Script completed",
      textSha256: "a".repeat(64),
      ancestorTypes: [],
      originalTextBytes: 16,
      previewTextBytes: 16,
      truncated: false,
      mediaDescriptorOrdinals: [],
    };

    expect(previewConversationCategory({
      ...common,
      itemType: "custom_tool_call_output",
      semanticCategory: "tool_result",
      provenance: "tool_runtime",
      confidence: "exact",
      displayPolicy: "conversation",
      dedupePolicy: "occurrence",
      logicalId: "semantic:input:custom-tool-output",
      toolUseId: "call-1",
    }, false)).toBe("tool_result");
    expect(previewConversationCategory({
      ...common,
      itemType: "custom_tool_call",
      jsonPath: "$.input[0].input",
      semanticCategory: "tool_use",
      provenance: "model_output",
      confidence: "exact",
      displayPolicy: "history_replay",
      dedupePolicy: "history_replay",
      logicalId: "semantic:input:custom-tool-call",
      toolUseId: "call-1",
    }, false)).toBeUndefined();
  });

  test("OpenAI SSE 按 assistant、reasoning、tool_use 聚合且忽略 done 快照", async () => {
    const sse = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          instructions: "不得作为 Assistant 输出的控制快照",
          status: "in_progress",
        },
      },
      { type: "response.output_text.delta", item_id: "msg-1", delta: "回答" },
      { type: "response.output_text.delta", item_id: "msg-1", delta: "正文" },
      { type: "response.output_text.done", item_id: "msg-1", text: "回答正文" },
      { type: "response.reasoning_summary_text.delta", item_id: "reason-1", delta: "思考摘要" },
      { type: "response.function_call_arguments.delta", item_id: "call-1", delta: "{\"path\":" },
      { type: "response.function_call_arguments.delta", item_id: "call-1", delta: "\"a\"}" },
      { type: "response.function_call_arguments.done", item_id: "call-1", arguments: "{\"path\":\"a\"}" },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]), format: "sse", exchangeId: "exchange-openai-logical",
      side: "response", rawBodySha256: sha256Text(sse), sourceStorage: "inline",
      protocol: "openai-responses",
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start").map(event => event.category))
      .toEqual(["assistant", "reasoning", "tool_use"]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("回答正文思考摘要{\"path\":\"a\"}");
  });

  test("OpenAI SSE 只有 done final 时完整正文只输出一次", async () => {
    const sse = [{
      type: "response.output_text.done",
      item_id: "message-final-only",
      output_index: 0,
      content_index: 0,
      text: "只有终态正文",
    }].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-openai-final-only",
      side: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start")).toEqual([
      expect.objectContaining({ category: "assistant" }),
    ]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("只有终态正文");
    expect(events.filter(event => event.type === "item_end")).toHaveLength(1);
  });

  test("OpenAI SSE 不受属性顺序影响并忽略空生命周期占位", async () => {
    const sse = [
      {
        type: "response.output_item.added",
        item: {
          id: "msg-production",
          type: "message",
          status: "in_progress",
          content: [],
          role: "assistant",
        },
        output_index: 0,
      },
      {
        type: "response.content_part.added",
        content_index: 0,
        item_id: "msg-production",
        output_index: 0,
        part: { type: "output_text", text: "" },
      },
      {
        type: "response.output_text.delta",
        content_index: 0,
        delta: "真实回答",
        item_id: "msg-production",
        output_index: 0,
      },
      {
        type: "response.output_text.done",
        content_index: 0,
        item_id: "msg-production",
        output_index: 0,
        text: "真实回答",
      },
      {
        type: "response.output_item.added",
        item: {
          id: "fc-production",
          type: "function_call",
          status: "in_progress",
          arguments: "",
          call_id: "call-production",
          name: "exec_command",
        },
        output_index: 1,
      },
      {
        type: "response.function_call_arguments.delta",
        delta: "{\"cmd\":\"pwd\"}",
        item_id: "fc-production",
        output_index: 1,
      },
      {
        type: "response.function_call_arguments.done",
        arguments: "{\"cmd\":\"pwd\"}",
        item_id: "fc-production",
        output_index: 1,
      },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-openai-production-order",
      side: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start")).toEqual([
      expect.objectContaining({
        category: "assistant",
        toolUseId: "msg-production",
      }),
      expect.objectContaining({
        category: "tool_use",
        toolName: "exec_command",
        toolUseId: "call-production",
      }),
    ]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("真实回答{\"cmd\":\"pwd\"}");
    expect(events.filter(event => event.type === "item_end").map(event => event.originalTextBytes))
      .toEqual([12, 13]);
  });

  test("OpenAI 生命周期快照的 type 后置时仍不输出 instructions 和完整 output", async () => {
    const sse = [
      {
        response: {
          instructions: "You are Codex, a coding agent based on GPT-5.",
          output: [{ type: "message", content: [{ type: "output_text", text: "不应显示" }] }],
          status: "in_progress",
        },
        type: "response.created",
      },
      {
        response: {
          instructions: "You are Codex, a coding agent based on GPT-5.",
          output: [{ type: "message", content: [{ type: "output_text", text: "不应显示" }] }],
          status: "completed",
        },
        type: "response.completed",
      },
      {
        delta: "真实回答",
        item_id: "msg-real",
        type: "response.output_text.delta",
      },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-openai-lifecycle-type-last",
      side: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start").map(event => event.category))
      .toEqual(["assistant"]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("真实回答");
    expect(events.some(event => event.type === "text" && event.value.includes("Codex"))).toBe(false);
    expect(events.some(event => event.type === "text" && event.value.includes("不应显示"))).toBe(false);
  });

  test("OpenAI SSE 使用 event 类型忽略 type 后置的 done 快照", async () => {
    const responseEvents = [
      {
        event: "response.reasoning_summary_text.delta",
        data: {
          delta: "**Planning concise user acknowledgment**",
          item_id: "reason-1",
          output_index: 0,
          type: "response.reasoning_summary_text.delta",
        },
      },
      {
        event: "response.reasoning_summary_text.done",
        data: {
          item_id: "reason-1",
          output_index: 0,
          text: "**Planning concise user acknowledgment**",
          type: "response.reasoning_summary_text.done",
        },
      },
      {
        event: "response.reasoning_summary_part.done",
        data: {
          item_id: "reason-1",
          output_index: 0,
          part: { text: "**Planning concise user acknowledgment**", type: "summary_text" },
          type: "response.reasoning_summary_part.done",
        },
      },
      {
        event: "response.output_item.done",
        data: {
          item: {
            id: "reason-1",
            summary: [{ text: "**Planning concise user acknowledgment**", type: "summary_text" }],
            type: "reasoning",
          },
          output_index: 0,
          type: "response.output_item.done",
        },
      },
      ...["收到", "：", "5", "。"].map(delta => ({
        event: "response.output_text.delta",
        data: {
          content_index: 0,
          delta,
          item_id: "message-1",
          output_index: 1,
          type: "response.output_text.delta",
        },
      })),
      {
        event: "response.output_text.done",
        data: {
          content_index: 0,
          item_id: "message-1",
          output_index: 1,
          text: "收到：5。",
          type: "response.output_text.done",
        },
      },
      {
        event: "response.content_part.done",
        data: {
          content_index: 0,
          item_id: "message-1",
          output_index: 1,
          part: { text: "收到：5。", type: "output_text" },
          type: "response.content_part.done",
        },
      },
      {
        event: "response.output_item.done",
        data: {
          item: {
            content: [{ text: "收到：5。", type: "output_text" }],
            id: "message-1",
            role: "assistant",
            type: "message",
          },
          output_index: 1,
          type: "response.output_item.done",
        },
      },
      {
        event: "response.completed",
        data: {
          response: {
            output: [{
              content: [{ text: "收到：5。", type: "output_text" }],
              id: "message-1",
              role: "assistant",
              type: "message",
            }],
            status: "completed",
          },
          type: "response.completed",
        },
      },
    ];
    const sse = responseEvents.map(({ event, data }) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-openai-type-last-done",
      side: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      protocol: "openai-responses",
    })) events.push(event);

    const logicalItems: Array<{ category: string; text: string }> = [];
    for (const event of events) {
      if (event.type === "item_start") {
        logicalItems.push({ category: event.category, text: "" });
      } else if (event.type === "text") {
        logicalItems.at(-1)!.text += event.value;
      }
    }
    expect(logicalItems).toEqual([
      { category: "reasoning", text: "**Planning concise user acknowledgment**" },
      { category: "assistant", text: "收到：5。" },
    ]);
  });

  test("Anthropic input_json_delta 聚合为单个 tool_use", async () => {
    const sse = [
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"a\"}" } },
      { type: "content_block_stop", index: 0 },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]), format: "sse", exchangeId: "exchange-anthropic-tool",
      side: "response", rawBodySha256: sha256Text(sse), sourceStorage: "inline",
      protocol: "anthropic-messages",
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start")).toEqual([
      expect.objectContaining({ category: "tool_use" }),
    ]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("{\"path\":\"a\"}");
  });

  test("Anthropic 连续多个工具调用按 content block index 分开聚合", async () => {
    const sse = [
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"b\"}" } },
      { type: "content_block_stop", index: 1 },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]), format: "sse", exchangeId: "exchange-anthropic-tools",
      side: "response", rawBodySha256: sha256Text(sse), sourceStorage: "inline",
      protocol: "anthropic-messages",
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start")).toEqual([
      expect.objectContaining({ category: "tool_use", toolUseId: "content-block:0" }),
      expect.objectContaining({ category: "tool_use", toolUseId: "content-block:1" }),
    ]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("{\"path\":\"a\"}{\"path\":\"b\"}");
  });

  test("Anthropic SSE 使用 Message-final Preview 将正文只输出为 refusal", async () => {
    const sse = [
      {
        type: "message_start",
        message: { id: "message-refusal", type: "message", role: "assistant" },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "无法协助该请求" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: { type: "refusal" },
        },
      },
      { type: "message_stop" },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const projected = await projectProtocolStream({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-anthropic-refusal",
      bodySide: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-anthropic-refusal",
      side: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      protocol: "anthropic-messages",
      previewItems: projected.preview.items,
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start")).toEqual([
      expect.objectContaining({ category: "refusal" }),
    ]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("无法协助该请求");
    expect(events.filter(event => event.type === "item_end")).toHaveLength(1);
  });

  test("Anthropic SSE 无 text block 时 Raw 使用 Preview 合成 refusal explanation", async () => {
    const sse = [
      {
        type: "message_start",
        message: {
          id: "message-refusal-explanation",
          type: "message",
          role: "assistant",
        },
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: {
            type: "refusal",
            explanation: "该请求无法处理",
          },
        },
      },
      { type: "message_stop" },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const projected = await projectProtocolStream({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-anthropic-refusal-explanation",
      bodySide: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });
    const events = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "exchange-anthropic-refusal-explanation",
      side: "response",
      rawBodySha256: sha256Text(sse),
      sourceStorage: "inline",
      protocol: "anthropic-messages",
      previewItems: projected.preview.items,
    })) events.push(event);

    expect(events.filter(event => event.type === "item_start")).toEqual([
      expect.objectContaining({
        category: "refusal",
        provenance: "provider_control",
      }),
    ]);
    expect(events.filter(event => event.type === "text").map(event => event.value).join(""))
      .toBe("该请求无法处理");
    expect(events.filter(event => event.type === "item_end")).toHaveLength(1);
  });

  test("流式排重按结构化指纹 occurrence count 消耗基线次数", async () => {
    const repeatedText = "重复上下文";
    const body = JSON.stringify({ messages: [
      { role: "user", content: repeatedText },
      { role: "user", content: repeatedText },
    ] });
    const textSha256 = createHash("sha256").update(repeatedText).digest("hex");
    const inheritedFingerprints = new Map([[conversationFingerprintKey({
      category: "user_real",
      side: "input",
      provenance: "protocol_user",
      providerItemType: "content",
      textSha256,
      contentKinds: ["text"],
    }), 1]]);
    const previewItems = [0, 1].map(index => ({
      side: "request" as const,
      category: "message",
      role: "user",
      itemType: "content",
      ancestorTypes: [],
      jsonPath: `$.messages[${index}].content`,
      semanticCategory: "user_real" as const,
      provenance: "protocol_user" as const,
      confidence: "protocol_role" as const,
      displayPolicy: "conversation" as const,
      dedupePolicy: "occurrence" as const,
      logicalId: `semantic:input:user-${index}`,
      textSha256,
      originalTextBytes: Buffer.byteLength(repeatedText),
      previewTextBytes: Buffer.byteLength(repeatedText),
      truncated: false,
      mediaDescriptorOrdinals: [],
    }));
    const starts = [];

    for await (const event of iterateConversationBodyEvents({
      stream: Readable.from([body]),
      exchangeId: "exchange-counted-dedupe",
      side: "request",
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
      sourceStorage: "inline",
      protocol: "anthropic-messages",
      previewItems,
      inheritedFingerprints,
    })) {
      if (event.type === "item_start") starts.push(event);
    }

    expect(starts.map(event => event.stepDiff)).toEqual(["inherited", "unique"]);
    expect(inheritedFingerprints.get(conversationFingerprintKey({
      category: "user_real",
      side: "input",
      provenance: "protocol_user",
      providerItemType: "content",
      textSha256,
      contentKinds: ["text"],
    }))).toBe(0);
  });

  test("六级查询只传播业务上下文和页面内导出参数", () => {
    const input: ExportConversationQueryInput & { offset: number; view: string } = {
      target: "catapi.chat",
      agent: "codex",
      session: "asess-1",
      thread: "athread-1",
      turn: "aturn-1",
      step: "capture-1:ex-1",
      scope: "step",
      offset: 50,
      view: "thread",
    };
    expect(buildExportConversationQuery(input)).toBe(
      "target=catapi.chat&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=capture-1%3Aex-1&scope=step",
    );
  });

  test("交互内容方向作为页面私有参数进入稳定查询串", () => {
    expect(buildExportConversationQuery({
      session: "asess-1",
      scope: "all",
      side: "response",
      categories: ["tool_result"],
    })).toBe(
      "session=asess-1&scope=all&side=response&categories=tool_result",
    );
  });

  test("三个导出 API 对非法方向统一返回 400", async () => {
    const [previewRoute, contentRoute, downloadRoute] = await Promise.all([
      import("../src/app/api/export/route.js"),
      import("../src/app/api/export/content/route.js"),
      import("../src/app/api/export/download/route.js"),
    ]);
    const preview = await previewRoute.GET(new Request(
      "http://localhost/api/export?side=input",
    ));
    const rawHeaders = {
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    };
    const content = await contentRoute.GET(new Request(
      "http://localhost/api/export/content?side=input",
      { headers: rawHeaders },
    ));
    const download = await downloadRoute.GET(new Request(
      "http://localhost/api/export/download?side=input",
      { headers: rawHeaders },
    ));

    expect(preview.status).toBe(400);
    expect(content.status).toBe(400);
    expect(download.status).toBe(400);
  });

  test("查询支持双向游标、页码、条数、字节预算和显式空类别", () => {
    expect(buildExportConversationQuery({
      session: "asess-1",
      scope: "all",
      cursor: "cursor-1",
      direction: "newer",
      page: 3,
      exchangeLimit: 20,
      pageMaxBytes: 1024,
      categories: [],
    })).toBe(
      "session=asess-1&scope=all&cursor=cursor-1&direction=newer&page=3&categories=&exchangeLimit=20&pageMaxBytes=1024",
    );
  });

  test("无效页码和方向不会进入查询", () => {
    expect(buildExportConversationQuery({
      turn: "aturn-1",
      scope: "all",
      direction: "sideways" as "older",
      page: 0,
    })).toBe("turn=aturn-1&scope=all");
  });

  test("Anthropic 请求响应提取 input/output 完整类别", () => {
    const exchange = makeExchange({
      exchangeId: "cap:ex-1",
      path: "/v1/messages",
      request: {
        model: "claude-sonnet",
        system: "You are a coding agent.",
        messages: [{ role: "user", content: [{ type: "text", text: "请修复测试" }] }],
      },
      response: {
        type: "message",
        model: "claude-sonnet",
        content: [
          { type: "text", text: "我先读取文件" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    });
    const items = extractConversationItems(
      exchange,
      normalizeExchange(exchange),
      { turnId: "turn-1", threadId: "thread-1", agentSessionId: "session-1" },
    );
    expect(items.map(item => item.category)).toEqual(expect.arrayContaining([
      "system",
      "user_real",
      "assistant",
      "tool_use",
    ]));
    expect(items.find(item => item.category === "tool_use")?.toolName).toBe("Read");
    expect(items.some(item => item.side === "input")).toBe(true);
    expect(items.some(item => item.side === "output")).toBe(true);
  });

  test("Codex instructions、注入上下文和真实用户输入分类稳定", () => {
    const exchange = makeExchange({
      exchangeId: "cap:codex-1",
      path: "/v1/responses",
      headers: { "user-agent": "codex/1.0" },
      request: {
        model: "gpt-test",
        instructions: "You are a coding agent.",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "开发约束" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "请修复测试" }] },
          { type: "function_call_output", call_id: "call-1", output: "exit 0" },
        ],
      },
      response: {
        model: "gpt-test",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "已完成" }] },
          { type: "function_call", call_id: "call-2", name: "shell", arguments: "{}" },
        ],
      },
    });
    const categories = extractConversationItems(
      exchange,
      normalizeExchange(exchange),
      undefined,
    ).map(item => item.category);
    expect(categories).toEqual(expect.arrayContaining([
      "system",
      "developer",
      "user_injected",
      "user_real",
      "tool_result",
      "assistant",
      "tool_use",
    ]));
  });

  test("SQLite Preview 将不带项目路径的 AGENTS 标题识别为 Agent 注入", () => {
    expect(previewConversationCategory({
      side: "request",
      category: "message",
      role: "user",
      itemType: "input_text",
      ancestorTypes: [],
      jsonPath: "$.input[0].content[0].text",
      semanticCategory: "user_injected",
      provenance: "agent_injected",
      confidence: "exact",
      displayPolicy: "conversation",
      dedupePolicy: "occurrence",
      logicalId: "semantic:input:agents",
      textPreview: "# AGENTS.md instructions\n\n<INSTRUCTIONS>",
      textSha256: "a".repeat(64),
      originalTextBytes: 45,
      previewTextBytes: 45,
      truncated: false,
      mediaDescriptorOrdinals: [],
    }, false)).toBe("user_injected");
  });

  test("生产入口拒绝缺少 SQLite 数据库依赖的旧调用", async () => {
    const source = readFileSync("src/lib/export-conversation.ts", "utf-8");
    expect(source).toContain("交互内容查询必须使用 SQLite 数据库依赖");
    await expect(loadExportConversation("/definitely-not-readable", {
      session: "legacy-session",
      scope: "all",
      categories: [],
    })).rejects.toThrow("SQLite 数据库依赖");
  });

  test("完整下载 Route 先做同源预检并设置流式下载安全 Header", () => {
    const route = readFileSync("src/app/api/export/download/route.ts", "utf-8");
    const client = readFileSync("src/components/conversation-export-viewer.tsx", "utf-8");

    expect(route).toContain("assertRawStreamRequest(request)");
    expect(route).toContain('url.searchParams.get("preflight")');
    expect(route).toContain('"Cache-Control": "no-store"');
    expect(route).toContain('"X-Content-Type-Options": "nosniff"');
    expect(route).toContain('"Cross-Origin-Resource-Policy": "same-origin"');
    expect(client).toContain("完整导出预检失败");
    expect(client).toContain("声明正文总量");
    expect(client).toContain("预计分页数");
    // 「复制当前页完整可读内容」已按 2026-09-07 决策移除，防止回归复活。
    expect(client).not.toContain("复制当前页完整可读内容");
    expect(client).not.toContain("function copyAll(");
    // 「下载当前页」已按 2026-09-20 用户决策移除（改为步骤展开内导出 + 完整导出），防止回归复活。
    expect(client).not.toContain("下载当前页 Markdown");
    expect(client).not.toContain("下载当前页 JSONL");
    // 完整导出按钮在列表模式（无整页 data）也必须能触发预检弹窗（2026-09-20 修复静默无反应）。
    expect(client).toContain("if (rangeRequired) return;");
    expect(client).not.toContain("if (!data || rangeRequired) return;");
    expect(client).toContain("当前页完整可读内容");
    // 侧别「全不选→全部」切换必须显式覆盖 side/categories 键：
    // 空补丁盖不住 updateQuery 基础值里残留的旧 side，刷新后会恢复成全不选。
    expect(client).toContain("updateQuery({ side: selection.side, categories: selection.categories })");
    expect(client).not.toContain("updateQuery({ ...sideSelectionForQuery(");
    expect(client).not.toContain("受限预览：当前页仅展示 SQLite 有界内容");
    expect(client).toContain("function resetFullExportConfirmation()");
    expect(client).toContain("if (replacingRange) resetFullExportConfirmation()");
    expect(route).not.toContain("完整 prompt+completion");
  });
});

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
