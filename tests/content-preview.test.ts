import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  CONTENT_PREVIEW_ITEM_MAX_BYTES,
  CONTENT_PREVIEW_MAX_BYTES,
  CONTENT_PREVIEW_RETAINED_ITEM_LIMIT,
  ContentPreviewBuilder,
  mergeContentPreviews,
} from "../src/lib/ingestion/content-preview";
import {
  DataUrlProjector,
} from "../src/lib/ingestion/data-url-projector";
import {
  projectMaterializedProtocolValue,
  projectProtocolStream,
} from "../src/lib/ingestion/protocol-stream-projector";
import { Readable } from "node:stream";

describe("Preview 存储瘦身守卫：user_real 不被驱逐（2026-09-11）", () => {
  test("条目超预算时保留 user_real 正文（旧实现仅 47% 存活）", () => {
    const builder = new ContentPreviewBuilder({
      exchangeId: "user-real-survives",
      projectionVersion: 4,
    });
    // 先用大量工具结果塞满预算，再插入用户真实输入。
    for (let index = 0; index < 200; index += 1) {
      const item = builder.beginTextItem({
        side: "request",
        category: "tool_result",
        role: "tool",
        itemType: "tool_result",
        jsonPath: `$.messages[${index}].content`,
      });
      item.pushText("工具输出".repeat(500));
      item.finish();
    }
    const prompt = builder.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "input_text",
      jsonPath: "$.messages[200].content",
    });
    prompt.pushText("这是用户真实输入，必须保留");
    prompt.finish();

    const preview = builder.finalize();
    const userReal = preview.items.filter(item => item.semanticCategory === "user_real");
    expect(userReal.length).toBeGreaterThan(0);
    expect(userReal.some(item => item.textPreview === "这是用户真实输入，必须保留")).toBe(true);
    // 索引态有界：单条预览与整体封套都在新口径内。
    expect(preview.items.every(item => item.previewTextBytes <= CONTENT_PREVIEW_ITEM_MAX_BYTES)).toBe(true);
    expect(Buffer.byteLength(preview.previewJson)).toBeLessThanOrEqual(CONTENT_PREVIEW_MAX_BYTES);
  });
});

describe("SQLite Content Preview 预算", () => {
  test("dsh part 作用域图片句柄不污染同消息的真实用户文本", () => {
    const projected = projectMaterializedProtocolValue({
      value: {
        messages: [{
          role: "user",
          content: [
            {type: "text", text: "Image #1 (image/png; 10x10)"},
            {type: "text", text: "普通用户文本"},
          ],
        }],
      },
      exchangeId: "dsh-image-scope",
      bodySide: "request",
      rawBodySha256: "c".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 7,
      protocol: "openai-chat-completions",
      agentKind: "dsh",
      endpointKind: "model-call",
    });

    expect(projected.preview.items.map(item => item.semanticCategory)).toEqual([
      "user_injected",
      "user_real",
    ]);
  });

  test("单项、总量和条数预算按 UTF-8 字节确定性收敛", () => {
    const builder = new ContentPreviewBuilder({
      exchangeId: "preview-budget",
      projectionVersion: 1,
    });

    for (let index = 0; index < 300; index += 1) {
      const item = builder.beginTextItem({
        side: index % 2 === 0 ? "request" : "response",
        category: "message",
        role: "user",
        itemType: "text",
        jsonPath: `$.messages[${index}].content`,
      });
      item.pushText("中文内容".repeat(3_000));
      item.finish();
    }

    const preview = builder.finalize();
    expect(preview.itemCandidateCount).toBe(300);
    expect(preview.itemProcessedCount).toBeLessThanOrEqual(CONTENT_PREVIEW_RETAINED_ITEM_LIMIT);
    expect(preview.items).toHaveLength(preview.itemProcessedCount);
    expect(preview.items.every(item => item.previewTextBytes <= CONTENT_PREVIEW_ITEM_MAX_BYTES)).toBe(true);
    expect(Buffer.byteLength(preview.previewJson)).toBeLessThanOrEqual(CONTENT_PREVIEW_MAX_BYTES);
    expect(preview.sizeBytes).toBe(Buffer.byteLength(preview.previewJson));
    expect(preview.limited).toBe(true);
    expect(preview.truncated).toBe(true);
    expect(preview.limitedDimensions).toEqual(expect.arrayContaining([
      "content_preview",
      "request_text",
      "response_text",
    ]));
  });

  test("条数和字节受限时保留 Request 头尾并为 Response 保留独立份额", () => {
    const request = new ContentPreviewBuilder({
      exchangeId: "representative-request",
      projectionVersion: 2,
    });
    for (let index = 0; index < 300; index += 1) {
      const item = request.beginTextItem({
        side: "request",
        category: "message",
        role: "user",
        itemType: "input_text",
        jsonPath: `$.input[${index}].content[0].text`,
      });
      item.pushText(index === 299
        ? "本次请求最新真实输入"
        : `历史请求-${index}-${"长上下文".repeat(2_000)}`);
      item.finish();
    }
    const response = new ContentPreviewBuilder({
      exchangeId: "representative-response",
      projectionVersion: 2,
    });
    for (let index = 0; index < 4; index += 1) {
      const item = response.beginTextItem({
        side: "response",
        category: "message",
        role: "assistant",
        itemType: "response.output_text.delta",
        jsonPath: `$.events[${index}].data.delta`,
      });
      item.pushText(`回答-${index}`);
      item.finish();
    }

    const merged = mergeContentPreviews({
      exchangeId: "representative-exchange",
      projectionVersion: 2,
      drafts: [request.finalize(), response.finalize()],
    });

    expect(merged.itemCandidateCount).toBe(304);
    // 保留条数受代表项目上限约束（正文按需读 raw，不再逐项落库）。
    expect(merged.itemProcessedCount).toBeLessThanOrEqual(CONTENT_PREVIEW_RETAINED_ITEM_LIMIT);
    expect(merged.items.some(item => item.jsonPath.includes("$.input[0]"))).toBe(true);
    expect(merged.items.some(item => item.jsonPath.includes("$.input[299]"))).toBe(true);
    expect(merged.items.find(item => item.jsonPath.includes("$.input[299]"))?.textPreview)
      .toBe("本次请求最新真实输入");
    expect(merged.items.filter(item => item.side === "response").map(item => item.textPreview))
      .toEqual(["回答-0", "回答-1", "回答-2", "回答-3"]);
    expect(merged.sizeBytes).toBeLessThanOrEqual(CONTENT_PREVIEW_MAX_BYTES);
    expect(merged.limitedDimensions).toEqual(expect.arrayContaining([
      "content_preview",
      "request_text",
    ]));
  });

  test("筛选指纹独立于代表项 Preview 并在 4096 项后明确受限", () => {
    const builder = new ContentPreviewBuilder({
      exchangeId: "content-filter-limit",
      projectionVersion: 4,
    });
    for (let index = 0; index < 4_097; index += 1) {
      const item = builder.beginTextItem({
        side: "request",
        category: "message",
        role: "user",
        itemType: "input_text",
        jsonPath: `$.input[${index}].content[0].text`,
      });
      item.pushText(`content-filter-${index}`);
      item.finish();
    }

    const preview = builder.finalize();
    expect(preview.items).toHaveLength(CONTENT_PREVIEW_RETAINED_ITEM_LIMIT);
    expect(preview.filterItemCandidateCount).toBe(4_097);
    expect(preview.filterItemCandidateCountExact).toBe(true);
    expect(preview.filterItems).toHaveLength(4_096);
    expect(preview.filterItems.every(item => item.category === "user_real")).toBe(true);
    expect(JSON.parse(preview.previewJson)).not.toHaveProperty("filterItems");
  });

  test("Responses Preview 与筛选投影排除历史 reasoning 摘要", () => {
    const projected = projectMaterializedProtocolValue({
      value: {
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
      },
      exchangeId: "preview-responses-reasoning-history",
      bodySide: "request",
      rawBodySha256: "a".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 3,
      protocol: "openai-responses",
      endpointKind: "model-call",
    });

    expect(projected.preview.filterItems).toHaveLength(1);
    expect(projected.preview.filterItems[0]?.category).toBe("user_real");
    expect(projected.preview.overviewCandidates).toEqual([
      expect.objectContaining({
        conversationCategory: "user_real",
        jsonPath: "$.input[2].content[0].text",
        textPreview: "6",
      }),
    ]);
  });

  test("Anthropic 顶层 system 不进入真实用户输入筛选", () => {
    const projected = projectMaterializedProtocolValue({
      value: {
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.218.663" },
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: "You are an interactive agent that helps users." },
        ],
        messages: [{
          role: "user",
          content: [{ type: "text", text: "这是什么项目？" }],
        }],
      },
      exchangeId: "preview-anthropic-system",
      bodySide: "request",
      rawBodySha256: "b".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
      agentKind: "claude-code",
    });

    expect(projected.preview.filterItems.map(item => item.category)).toEqual([
      "system",
      "system",
      "system",
      "user_real",
    ]);
    expect(projected.preview.items.map(item => ({
      path: item.jsonPath,
      category: item.semanticCategory,
      provenance: item.provenance,
    }))).toEqual([
      {
        path: "$.system[0].text",
        category: "system",
        provenance: "protocol_system",
      },
      {
        path: "$.system[1].text",
        category: "system",
        provenance: "protocol_system",
      },
      {
        path: "$.system[2].text",
        category: "system",
        provenance: "protocol_system",
      },
      {
        path: "$.messages[0].content[0].text",
        category: "user_real",
        provenance: "physical_user",
      },
    ]);
  });

  test("Codex checkpoint 在 Preview 与筛选投影中归为 control", () => {
    const projected = projectMaterializedProtocolValue({
      value: {
        input: [{
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary",
          }],
        }],
      },
      exchangeId: "preview-codex-checkpoint",
      bodySide: "request",
      rawBodySha256: "c".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-responses",
      endpointKind: "model-call",
      agentKind: "codex",
    });

    expect(projected.preview.filterItems).toEqual([
      expect.objectContaining({ category: "control" }),
    ]);
    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "control",
        provenance: "agent_control",
      }),
    ]);
  });

  test("稳定 provider item ID 生成 lineage key 且不使用数组索引", () => {
    const projected = projectMaterializedProtocolValue({
      value: {
        input: [{
          id: "msg-stable-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "新输入" }],
        }],
      },
      exchangeId: "preview-provider-lineage",
      bodySide: "request",
      rawBodySha256: "d".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-responses",
      endpointKind: "model-call",
      agentKind: "codex",
    });

    expect(projected.preview.filterItems[0]).toMatchObject({
      category: "user_real",
      providerLineageKey: expect.stringContaining("msg-stable-1"),
    });
    expect(projected.preview.filterItems[0]?.providerLineageKey).not.toContain("input:0");
  });

  test("流式大数组超过物化上限后仍保留祖先 role 与 type", async () => {
    const input = Array.from({ length: 300 }, (_, index) => ({
      type: "message",
      role: index === 299 ? "system" : "assistant",
      content: [{
        type: index === 299 ? "input_text" : "output_text",
        text: index === 299 ? "深层系统输入" : `历史回复-${index}`,
      }],
    }));
    const projected = await projectProtocolStream({
      stream: Readable.from([JSON.stringify({ input })]),
      format: "json",
      exchangeId: "preview-deep-ancestor-state",
      bodySide: "request",
      rawBodySha256: "e".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-responses",
      endpointKind: "model-call",
      agentKind: "codex",
    });

    expect(projected.preview.filterItems).toEqual([
      expect.objectContaining({
        category: "system",
      }),
    ]);
    expect(projected.preview.items.find(
      item => item.jsonPath === "$.input[299].content[0].text",
    )).toMatchObject({
      semanticCategory: "system",
      role: "system",
      itemType: "input_text",
    });
  });

  test("OpenAI SSE 只有 done 快照时以 final 正文生成一个逻辑项", async () => {
    const sse = [{
      type: "response.output_text.done",
      item_id: "message-final-only",
      output_index: 0,
      content_index: 0,
      text: "只有终态正文",
    }].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");

    const projected = await projectProtocolStream({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "preview-openai-final-only",
      bodySide: "response",
      rawBodySha256: "f".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-responses",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "assistant",
        textPreview: "只有终态正文",
        originalTextBytes: Buffer.byteLength("只有终态正文"),
      }),
    ]);
  });

  test("OpenAI SSE 已有 delta 时 done final 不重复正文", async () => {
    const sse = [
      {
        type: "response.output_text.delta",
        item_id: "message-delta-final",
        output_index: 0,
        content_index: 0,
        delta: "增量",
      },
      {
        type: "response.output_text.delta",
        item_id: "message-delta-final",
        output_index: 0,
        content_index: 0,
        delta: "正文",
      },
      {
        type: "response.output_text.done",
        item_id: "message-delta-final",
        output_index: 0,
        content_index: 0,
        text: "增量正文",
      },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");

    const projected = await projectProtocolStream({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "preview-openai-delta-final",
      bodySide: "response",
      rawBodySha256: "e".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-responses",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "assistant",
        textPreview: "增量正文",
        originalTextBytes: Buffer.byteLength("增量正文"),
      }),
    ]);
  });

  test("OpenAI SSE 只有 output_item.done 时采用 Item final 正文", async () => {
    const sse = [{
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "function-final-only",
        type: "function_call",
        call_id: "call-final-only",
        name: "exec_command",
        arguments: "{\"cmd\":\"pwd\"}",
      },
    }].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");

    const projected = await projectProtocolStream({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "preview-openai-item-final-only",
      bodySide: "response",
      rawBodySha256: "7".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "openai-responses",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "tool_use",
        toolName: "exec_command",
        toolUseId: "call-final-only",
        textPreview: "{\"cmd\":\"pwd\"}",
      }),
    ]);
  });

  test("Anthropic SSE 在 Message final 晚到 refusal 时只发布最终类别", async () => {
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
      exchangeId: "preview-anthropic-refusal",
      bodySide: "response",
      rawBodySha256: "d".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "refusal",
        provenance: "model_output",
        textPreview: "无法协助该请求",
      }),
    ]);
  });

  test("Anthropic SSE refusal 无正文时使用有界 explanation 合成正文", async () => {
    const sse = [
      {
        type: "message_start",
        message: { id: "message-refusal-explanation", type: "message", role: "assistant" },
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
      exchangeId: "preview-anthropic-refusal-explanation",
      bodySide: "response",
      rawBodySha256: "c".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "refusal",
        provenance: "provider_control",
        textPreview: "该请求无法处理",
      }),
    ]);
  });

  test("Anthropic SSE refusal explanation 为空时不制造空正文项", async () => {
    const sse = [
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: { type: "refusal", explanation: "" },
        },
      },
      { type: "message_stop" },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");

    const projected = await projectProtocolStream({
      stream: Readable.from([sse]),
      format: "sse",
      exchangeId: "preview-anthropic-empty-refusal",
      bodySide: "response",
      rawBodySha256: "b".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([]);
  });

  test("Anthropic 非流式 JSON 按 Message final 将 text block 归为 refusal", () => {
    const projected = projectMaterializedProtocolValue({
      value: {
        id: "message-json-refusal",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "无法协助该请求" },
          { type: "text", text: "请调整请求内容" },
        ],
        stop_reason: "refusal",
        stop_details: { type: "refusal" },
      },
      exchangeId: "preview-anthropic-json-refusal",
      bodySide: "response",
      rawBodySha256: "a".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "refusal",
        textPreview: "无法协助该请求",
      }),
      expect.objectContaining({
        semanticCategory: "refusal",
        textPreview: "请调整请求内容",
      }),
    ]);
  });

  test("Anthropic 非流式 JSON 无正文时使用 stop_details explanation", () => {
    const projected = projectMaterializedProtocolValue({
      value: {
        id: "message-json-refusal-explanation",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          explanation: "该请求无法处理",
        },
      },
      exchangeId: "preview-anthropic-json-refusal-explanation",
      bodySide: "response",
      rawBodySha256: "9".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "refusal",
        provenance: "provider_control",
        textPreview: "该请求无法处理",
      }),
    ]);
  });

  test("Anthropic JSON 流式解析路径同样等待 Message final 再分类", async () => {
    const body = JSON.stringify({
      id: "message-streamed-json-refusal",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "流式解析的拒绝正文" }],
      stop_reason: "refusal",
      stop_details: { type: "refusal" },
    });
    const projected = await projectProtocolStream({
      stream: Readable.from(splitAt(body, [3, 7, 2, 11])),
      format: "json",
      exchangeId: "preview-anthropic-streamed-json-refusal",
      bodySide: "response",
      rawBodySha256: "8".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 4,
      protocol: "anthropic-messages",
      endpointKind: "model-call",
    });

    expect(projected.preview.items).toEqual([
      expect.objectContaining({
        semanticCategory: "refusal",
        textPreview: "流式解析的拒绝正文",
      }),
    ]);
  });

  test("首页语义候选独立保留文本摘要和稳定 Raw 来源", () => {
    const request = new ContentPreviewBuilder({
      exchangeId: "overview-candidates-request",
      projectionVersion: 3,
      protocol: "openai-responses",
      agentKind: "codex",
      endpointKind: "model-call",
    });
    for (let index = 0; index < 40; index += 1) {
      const historical = request.beginTextItem({
        side: "request",
        category: "message",
        role: "user",
        itemType: "input_text",
        jsonPath: `$.input[${index}].content[0].text`,
      });
      historical.pushText(`历史上下文-${index}-${"长文本".repeat(2_000)}`);
      historical.finish();
    }
    const injected = request.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "input_text",
      jsonPath: "$.input[40].content[0].text",
    });
    injected.pushText("# AGENTS.md instructions\n当前 Agent 注入");
    injected.finish();
    const toolResult = request.beginTextItem({
      side: "request",
      category: "tool",
      semanticType: "call_output",
      itemType: "custom_tool_call_output",
      jsonPath: "$.input[41].output",
      toolUseId: "call-1",
    });
    toolResult.pushText("Script completed");
    toolResult.finish();

    const response = new ContentPreviewBuilder({
      exchangeId: "overview-candidates-response",
      projectionVersion: 3,
    });
    const toolUse = response.beginTextItem({
      side: "response",
      category: "tool",
      itemType: "response.function_call_arguments.delta",
      jsonPath: "$.events[0].data.delta",
      toolName: "exec_command",
      toolUseId: "call-2",
    });
    toolUse.pushText("{\"cmd\":\"pwd\"}");
    toolUse.finish();

    const preview = mergeContentPreviews({
      exchangeId: "overview-candidates",
      projectionVersion: 3,
      drafts: [request.finalize(), response.finalize()],
    });

    expect(preview.overviewCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationCategory: "user_injected",
        side: "request",
        jsonPath: "$.input[40].content[0].text",
        textPreview: "# AGENTS.md instructions\n当前 Agent 注入",
      }),
      expect.objectContaining({
        conversationCategory: "tool_result",
        side: "request",
        toolUseId: "call-1",
        textPreview: "Script completed",
      }),
      expect.objectContaining({
        conversationCategory: "tool_use",
        side: "response",
        toolName: "exec_command",
        toolUseId: "call-2",
        textPreview: "{\"cmd\":\"pwd\"}",
      }),
    ]));
    expect(Buffer.byteLength(preview.previewJson)).toBeLessThanOrEqual(256 * 1024);
  });

  test("首页真实文本候选不被同类别纯图片占位覆盖", () => {
    const builder = new ContentPreviewBuilder({
      exchangeId: "overview-media-priority",
      projectionVersion: 3,
    });
    const text = builder.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "input_text",
      jsonPath: "$.input[0].content[0].text",
    });
    text.pushText("真实用户输入");
    text.finish();
    const image = builder.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "input_image",
      jsonPath: "$.input[0].content[1].image_url",
    });
    image.pushText("[media]");
    image.addMediaOrdinal(0);
    image.finish();

    expect(builder.finalize().overviewCandidates).toContainEqual(
      expect.objectContaining({
        conversationCategory: "user_real",
        jsonPath: "$.input[0].content[0].text",
        textPreview: "真实用户输入",
      }),
    );
  });

  test("Data URL 跨 chunk 增量解码，正文预览不保留前缀或 Base64", () => {
    const binary = Buffer.from("media-payload-".repeat(4_000));
    const encoded = binary.toString("base64");
    const safeText: string[] = [];
    const descriptors: Array<{ decodedBytes: number; sha256: string }> = [];
    const projector = new DataUrlProjector({
      exchangeId: "preview-media",
      bodySide: "request",
      jsonPath: "$.input[0].content[0].image_url",
      rawBodySha256: "a".repeat(64),
      sourceStorage: "external-blob",
      ordinal: 0,
      onText: value => safeText.push(value),
      onDescriptor: value => descriptors.push(value),
    });
    const value = `before:data:image/png;base64,${encoded}:after`;
    for (const chunk of splitAt(value, [4, 7, 3, 11, 5])) projector.push(chunk);
    const result = projector.finish();

    expect(descriptors).toEqual([expect.objectContaining({
      mediaType: "image/png",
      encodedBytes: encoded.length,
      decodedBytes: binary.length,
      sha256: createHash("sha256").update(binary).digest("hex"),
    })]);
    expect(safeText.join("")).toBe("before:[media]:after");
    expect(safeText.join("")).not.toContain("data:");
    expect(safeText.join("")).not.toContain(encoded.slice(100, 180));
    expect(result).toMatchObject({ candidateCount: 1, processedCount: 1, limited: false });
  });

  test("媒体 SHA 从 Preview item 进入有界筛选指纹", () => {
    const builder = new ContentPreviewBuilder({
      exchangeId: "preview-media-fingerprint",
      projectionVersion: 7,
      protocol: "openai-chat-completions",
      agentKind: "dsh",
      endpointKind: "model-call",
    });
    const item = builder.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "input_text",
      jsonPath: "$.messages[0].content[0].text",
    });
    item.pushText("带图片的输入");
    item.addMediaSha256("a".repeat(64));
    item.finish();

    const preview = builder.finalize();
    expect(preview.items[0]?.mediaSha256).toEqual(["a".repeat(64)]);
    expect(preview.filterItems[0]?.mediaSha256).toEqual(["a".repeat(64)]);
  });

  test("Data URL 只为选定 ordinal 回调固定大小的解码字节块", () => {
    const binary = Buffer.allocUnsafe(40 * 1024);
    for (let index = 0; index < binary.length; index += 1) {
      binary[index] = index % 251;
    }
    const decodedChunks: Buffer[] = [];
    const options = {
      exchangeId: "preview-media-bytes",
      bodySide: "request" as const,
      jsonPath: "$.input[0].content[0].image_url",
      rawBodySha256: "c".repeat(64),
      sourceStorage: "external-blob" as const,
      ordinal: 3,
      decodedMediaOrdinal: 3,
      onText: () => undefined,
      onDescriptor: () => undefined,
      onDecodedBytes: (value: Uint8Array) => decodedChunks.push(Buffer.from(value)),
    };
    const projector = new DataUrlProjector(options);

    projector.push(`data:image/png;base64,${binary.toString("base64")}`);
    projector.finish();

    expect(decodedChunks.length).toBeGreaterThan(1);
    expect(decodedChunks.every(chunk => chunk.length <= 16 * 1024)).toBe(true);
    expect(Buffer.concat(decodedChunks)).toEqual(binary);
  });

  test("普通文本中的 data: 原样保留且不产生媒体诊断", () => {
    const safeText: string[] = [];
    const diagnostics: string[] = [];
    const descriptors: unknown[] = [];
    const projector = new DataUrlProjector({
      exchangeId: "plain-data-colon",
      bodySide: "request",
      jsonPath: "$.input[0].tools[0].description",
      rawBodySha256: "d".repeat(64),
      sourceStorage: "inline",
      ordinal: 0,
      onText: value => safeText.push(value),
      onDescriptor: value => descriptors.push(value),
      onDiagnostic: code => diagnostics.push(code),
    });
    const value = "Use a base64-encoded `data:` URL. type ImageContent = { data: string, mimeType: string };";
    for (const chunk of splitAt(value, [2, 7, 1, 11, 3])) projector.push(chunk);
    const result = projector.finish();

    expect(safeText.join("")).toBe(value);
    expect(descriptors).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(result).toEqual({ candidateCount: 0, processedCount: 0, limited: false });
  });

  test("非法 Base64 只产生有界占位和诊断，不回流原始编码", () => {
    const safeText: string[] = [];
    const diagnostics: string[] = [];
    const descriptors: unknown[] = [];
    const projector = new DataUrlProjector({
      exchangeId: "invalid-media",
      bodySide: "response",
      jsonPath: "$.content",
      rawBodySha256: "b".repeat(64),
      sourceStorage: "compressed-inline",
      ordinal: 0,
      onText: value => safeText.push(value),
      onDescriptor: value => descriptors.push(value),
      onDiagnostic: code => diagnostics.push(code),
    });
    projector.push("prefix data:image/png;base64,QU=J");
    const result = projector.finish();

    expect(result).toMatchObject({ candidateCount: 1, processedCount: 0, limited: true });
    expect(descriptors).toEqual([]);
    expect(diagnostics).toContain("data_url_base64_invalid");
    expect(safeText.join("")).toBe("prefix [invalid-media]");
    expect(safeText.join("")).not.toContain("data:");
    expect(safeText.join("")).not.toContain("QU=J");
  });
});

function splitAt(value: string, sizes: number[]): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let index = 0;
  while (offset < value.length) {
    const size = sizes[index % sizes.length]!;
    chunks.push(value.slice(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}
