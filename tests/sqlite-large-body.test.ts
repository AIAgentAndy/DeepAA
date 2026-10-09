import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { buildRawCapturedExchangeV2 } from "../src/lib/harness/raw-capture";
import { createExchangeProjector } from "../src/lib/ingestion/exchange-projector";
import { createIngestionWorker } from "../src/lib/ingestion/worker";
import {
  chooseExchangeProjectionPath,
  projectMaterializedProtocolValue,
  projectProtocolStream,
} from "../src/lib/ingestion/protocol-stream-projector";
import { createSqliteFixture } from "./helpers/sqlite-fixture";

describe("大正文协议流式投影", () => {
  test("8 MiB 边界选择 small/small/large", () => {
    expect(chooseExchangeProjectionPath(8 * 1024 * 1024 - 1, 0)).toBe("small");
    expect(chooseExchangeProjectionPath(8 * 1024 * 1024, 0)).toBe("small");
    expect(chooseExchangeProjectionPath(8 * 1024 * 1024 + 1, 0)).toBe("large");
  });

  test("OpenCode/dsh 投影 preview.agentKind 保留真实 Agent 名称", async () => {
    const fixture = await createSqliteFixture();
    try {
      for (const agent of ["opencode", "dsh"] as const) {
        const wireApi = agent === "opencode" ? "responses" : "chat_completions";
        const path = agent === "opencode" ? "/v1/responses" : "/v1/chat/completions";
        const requestBody = agent === "opencode"
          ? JSON.stringify({
            model: "fixture-model",
            input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }],
          })
          : JSON.stringify({
            model: "fixture-model",
            messages: [{ role: "user", content: "你好" }],
          });
        const responseBody = agent === "opencode"
          ? JSON.stringify({
            id: "resp-agent",
            object: "response",
            status: "completed",
            model: "fixture-model",
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "好的" }],
            }],
          })
          : JSON.stringify({
            id: "chat-agent",
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "好的" } }],
          });
        const exchange = {
          schemaVersion: 2 as const,
          exchangeId: `preview-agent-${agent}`,
          captureSessionId: "capture-agent-kind",
          sequence: 1,
          capturedAt: "2026-07-22T02:00:00.000Z",
          completedAt: "2026-07-22T02:00:01.000Z",
          durationMs: 100,
          routing: {
            targetId: "target-agent",
            targetName: "Agent Target",
            targetFormatHint: "openai" as const,
            localUrl: `http://127.0.0.1:3211/${agent}${path}`,
            upstreamUrl: `https://example.test${path}`,
            localPath: path,
            upstreamPath: path,
            method: "POST",
            agent,
            wireApi,
          },
          request: {
            headers: {
              "user-agent": agent === "opencode" ? "opencode/0.1" : "deepseek-harness/0.1",
            },
            rawBody: requestBody,
            bodySizeBytes: Buffer.byteLength(requestBody),
            bodySha256: sha256(requestBody),
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            rawBody: responseBody,
            bodySizeBytes: Buffer.byteLength(responseBody),
            bodySha256: sha256(responseBody),
            isStreaming: false,
          },
          bodyStorage: { policy: "inline" as const },
          captureDiagnostics: [],
          security: {
            containsSensitiveHeaders: false,
            headerRedactionAppliedInApi: true,
            rawBodiesStoredLocally: true,
          },
        };
        const projected = await createExchangeProjector({
          dataDir: fixture.dataDir,
          projectionVersion: 3,
        }).project(exchange);
        expect(projected.preview.agentKind).toBe(agent);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("small 与 large 投影都为嵌套文本保留祖先 role", async () => {
    const value = {
      input: [{ role: "developer", content: [{ type: "input_text", text: "开发约束" }] }],
    };
    const common = {
      exchangeId: "preview-role",
      bodySide: "request" as const,
      rawBodySha256: sha256(JSON.stringify(value)),
      sourceStorage: "inline" as const,
      projectionVersion: 1,
      protocol: "openai_responses",
    };

    const small = projectMaterializedProtocolValue({ ...common, value: structuredClone(value) });
    const large = await projectProtocolStream({
      ...common,
      stream: chunked(JSON.stringify(value), 7),
      format: "json",
    });

    expect(small.preview.items).toEqual([
      expect.objectContaining({ role: "developer", itemType: "input_text", textPreview: "开发约束" }),
    ]);
    expect(large.preview.items).toEqual([
      expect.objectContaining({ role: "developer", itemType: "input_text", textPreview: "开发约束" }),
    ]);
  });

  test("small 与 large 投影都保留 custom_tool_call_output 父级语义", async () => {
    const value = {
      input: [{
        type: "custom_tool_call_output",
        call_id: "call-array-preview",
        output: [
          { type: "input_text", text: "Script completed" },
          { type: "input_text", text: "命令错误" },
        ],
      }],
    };
    const common = {
      exchangeId: "preview-tool-output-array",
      bodySide: "request" as const,
      rawBodySha256: sha256(JSON.stringify(value)),
      sourceStorage: "inline" as const,
      projectionVersion: 2,
      protocol: "openai_responses",
    };

    const small = projectMaterializedProtocolValue({ ...common, value: structuredClone(value) });
    const large = await projectProtocolStream({
      ...common,
      stream: chunked(JSON.stringify(value), 7),
      format: "json",
    });

    for (const result of [small, large]) {
      expect(result.preview.items).toEqual([
        expect.objectContaining({
          category: "tool",
          itemType: "input_text",
          toolUseId: "call-array-preview",
          textPreview: "Script completed",
        }),
        expect.objectContaining({
          category: "tool",
          itemType: "input_text",
          toolUseId: "call-array-preview",
          textPreview: "命令错误",
        }),
      ]);
      expect(result.preview.items.every(item => item.role !== "user")).toBe(true);
    }
  });

  test("small 与 large Request Preview 都保留顶层 instructions 并精确计数", async () => {
    const value = {
      instructions: "You are Codex.",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "真实输入" }],
      }],
    };
    const serialized = JSON.stringify(value);
    const common = {
      exchangeId: "preview-request-instructions",
      bodySide: "request" as const,
      rawBodySha256: sha256(serialized),
      sourceStorage: "inline" as const,
      projectionVersion: 2,
      protocol: "openai-responses",
    };

    const small = projectMaterializedProtocolValue({
      ...common,
      value: structuredClone(value),
    });
    const large = await projectProtocolStream({
      ...common,
      stream: chunked(serialized, 7),
      format: "json",
    });

    for (const result of [small, large]) {
      expect(result.preview.items).toEqual([
        expect.objectContaining({
          jsonPath: "$.instructions",
          itemType: "instructions",
          textPreview: "You are Codex.",
        }),
        expect.objectContaining({
          jsonPath: "$.input[0].content[0].text",
          role: "user",
          textPreview: "真实输入",
        }),
      ]);
      expect(result.preview.itemCandidateCount).toBe(2);
      expect(result.preview.itemProcessedCount).toBe(2);
      expect(result.preview.itemCandidateCountExact).toBe(true);
    }
  });

  test("SSE Preview 为 Anthropic 工具参数保留 content block 标识", async () => {
    const event = {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" },
    };
    const sse = `data: ${JSON.stringify(event)}\n\n`;
    const result = await projectProtocolStream({
      exchangeId: "preview-anthropic-tool",
      bodySide: "response",
      rawBodySha256: sha256(sse),
      sourceStorage: "inline",
      projectionVersion: 2,
      protocol: "anthropic-messages",
      format: "sse",
      stream: chunked(sse, 5),
    });

    expect(result.preview.items).toEqual([
      expect.objectContaining({
        category: "tool",
        itemType: "input_json_delta",
        toolUseId: "content-block:3",
        textPreview: "{\"path\":\"a\"}",
      }),
    ]);
  });

  test("SSE Preview 忽略空占位并按 item_id 关联 OpenAI 工具元数据", async () => {
    const sse = [
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
        output_index: 0,
      },
      {
        type: "response.function_call_arguments.delta",
        delta: "{\"cmd\":\"pwd\"}",
        item_id: "fc-production",
        output_index: 0,
      },
      {
        type: "response.function_call_arguments.done",
        arguments: "{\"cmd\":\"pwd\"}",
        item_id: "fc-production",
        output_index: 0,
      },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");

    const result = await projectProtocolStream({
      exchangeId: "preview-openai-production-order",
      bodySide: "response",
      rawBodySha256: sha256(sse),
      sourceStorage: "inline",
      projectionVersion: 2,
      protocol: "openai-responses",
      format: "sse",
      stream: chunked(sse, 5),
    });

    expect(result.preview.items).toEqual([
      expect.objectContaining({
        category: "tool",
        itemType: "response.function_call_arguments.delta",
        toolName: "exec_command",
        toolUseId: "call-production",
        textPreview: "{\"cmd\":\"pwd\"}",
      }),
    ]);
    expect(result.preview.itemCandidateCount).toBe(1);
    expect(result.preview.itemProcessedCount).toBe(1);
  });

  test("SSE Preview 保留 added 事件直接携带的非空工具参数", async () => {
    const event = {
      type: "response.output_item.added",
      item: {
        id: "fc-inline",
        type: "function_call",
        status: "completed",
        arguments: "{\"cmd\":\"pwd\"}",
        call_id: "call-inline",
        name: "exec_command",
      },
      output_index: 0,
    };
    const sse = `data: ${JSON.stringify(event)}\n\n`;

    const result = await projectProtocolStream({
      exchangeId: "preview-openai-inline-added",
      bodySide: "response",
      rawBodySha256: sha256(sse),
      sourceStorage: "inline",
      projectionVersion: 2,
      protocol: "openai-responses",
      format: "sse",
      stream: chunked(sse, 7),
    });

    expect(result.preview.items).toEqual([
      expect.objectContaining({
        itemType: "function_call",
        toolName: "exec_command",
        toolUseId: "call-inline",
        textPreview: "{\"cmd\":\"pwd\"}",
      }),
    ]);
  });

  test("SSE Preview 忽略生命周期控制快照中的 instructions", async () => {
    const sse = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          instructions: "控制快照中的完整系统指令",
          status: "in_progress",
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-1",
        delta: "真实回答",
      },
      {
        type: "response.completed",
        response: {
          id: "resp-1",
          instructions: "控制快照中的完整系统指令",
          output: [{ type: "message", content: [{ type: "output_text", text: "真实回答" }] }],
          status: "completed",
        },
      },
    ].map(value => `event: message\ndata: ${JSON.stringify(value)}\n\n`).join("");

    const result = await projectProtocolStream({
      exchangeId: "preview-control-snapshot",
      bodySide: "response",
      rawBodySha256: sha256(sse),
      sourceStorage: "inline",
      projectionVersion: 2,
      protocol: "openai-responses",
      format: "sse",
      stream: chunked(sse, 11),
    });

    expect(result.preview.items.map(item => item.textPreview)).toEqual(["真实回答"]);
  });

  test("13 MiB 多模态 JSON 只产生 5 个媒体描述符和有界文本", async () => {
    const payloads = Array.from({ length: 5 }, (_, index) =>
      Buffer.alloc(2 * 1024 * 1024, 0x41 + index));
    const marker = "BASE64-MUST-NOT-ENTER-PROJECTION";
    const request = JSON.stringify({
      model: "gpt-test",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `UTF-8 跨块\\n${"长文本".repeat(4_000)}` },
          ...payloads.map((payload, index) => ({
            type: "input_image",
            image_url: `data:image/png;base64,${payload.toString("base64")}`,
            marker: index === 0 ? marker : undefined,
          })),
        ],
      }],
    });
    expect(Buffer.byteLength(request)).toBeGreaterThan(13 * 1024 * 1024);

    const projected = await projectProtocolStream({
      stream: chunked(request, 65_521),
      format: "json",
      exchangeId: "large-json",
      bodySide: "request",
      rawBodySha256: sha256(request),
      sourceStorage: "external-blob",
      projectionVersion: 1,
    });

    expect(projected.mediaDescriptors).toHaveLength(5);
    for (let index = 0; index < payloads.length; index += 1) {
      expect(projected.mediaDescriptors[index]).toMatchObject({
        bodySide: "request",
        decodedBytes: payloads[index]!.length,
        sha256: createHash("sha256").update(payloads[index]!).digest("hex"),
      });
    }
    expect(projected.preview.sizeBytes).toBeLessThanOrEqual(256 * 1024);
    expect(projected.preview.items.every(item => item.previewTextBytes <= 8 * 1024)).toBe(true);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("data:");
    expect(serialized).not.toContain(payloads[0]!.toString("base64").slice(500, 700));
    expect(serialized).toContain(marker);
  }, 30_000);

  test("SSE 按事件增量解析并保留 terminal/usage，不累计原始响应", async () => {
    const sse = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "你好".repeat(6_000) })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 7 } } })}`,
      "",
    ].join("\n");
    const projected = await projectProtocolStream({
      stream: chunked(sse, 17),
      format: "sse",
      exchangeId: "large-sse",
      bodySide: "response",
      rawBodySha256: sha256(sse),
      sourceStorage: "compressed-inline",
      projectionVersion: 1,
    });

    expect(projected.eventTypes).toEqual([
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(projected.body).toMatchObject({
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 7 },
    });
    expect(projected.preview.limitedDimensions).toContain("response_text");
    expect(JSON.stringify(projected)).not.toContain("你好".repeat(6_000));
  });

  test("SSE 超过 256 条时继续扫描到最终终态且只限制诊断样本", async () => {
    const events = [
      ...Array.from({ length: 256 }, (_, index) => ({
        type: "response.output_text.delta",
        item_id: "message-1",
        delta: index === 0 ? "完整回答" : "",
      })),
      {
        type: "response.output_item.done",
        item: {
          id: "call-1",
          type: "function_call",
          call_id: "call-1",
          name: "exec_command",
          arguments: "{\"cmd\":\"pwd\"}",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "response-1",
          status: "completed",
          output: [{
            id: "call-1",
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: "{\"cmd\":\"pwd\"}",
          }],
          usage: { input_tokens: 12, output_tokens: 7 },
        },
      },
    ];
    const sse = events
      .map(value => `data: ${JSON.stringify(value)}\n\n`)
      .join("");

    const projected = await projectProtocolStream({
      stream: chunked(sse, 29),
      format: "sse",
      exchangeId: "sse-terminal-after-sample-limit",
      bodySide: "response",
      rawBodySha256: sha256(sse),
      sourceStorage: "compressed-inline",
      projectionVersion: 3,
      protocol: "openai-responses",
    });

    expect(projected.streamLifecycle).toEqual(expect.objectContaining({
      eventCount: 258,
      lastEventType: "response.completed",
      terminalEventSeen: true,
      terminalEventType: "response.completed",
      providerStatus: "completed",
      doneMarkerSeen: false,
      parseErrorCount: 0,
      sampleLimited: true,
    }));
    expect(projected.eventTypes).toHaveLength(256);
    expect(projected.eventTypes).not.toContain("response.completed");
    expect(projected.body).toMatchObject({
      status: "completed",
      output: [expect.objectContaining({
        type: "function_call",
        name: "exec_command",
      })],
    });
  });

  test("small 流式响应使用 SSE 语义投影且不把生命周期 instructions 当输出", async () => {
    const fixture = await createSqliteFixture();
    const requestBody = JSON.stringify({
      model: "gpt-5",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "请执行 pwd" }],
      }],
    });
    const responseBody = [
      {
        type: "response.created",
        response: {
          id: "response-small",
          instructions: "You are Codex, a coding agent based on GPT-5.",
          status: "in_progress",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "call-small",
        output_index: 0,
        delta: "{\"cmd\":\"pwd\"}",
      },
      {
        type: "response.completed",
        response: {
          id: "response-small",
          instructions: "You are Codex, a coding agent based on GPT-5.",
          status: "completed",
          output: [{
            id: "call-small",
            type: "function_call",
            call_id: "call-small",
            name: "exec_command",
            arguments: "{\"cmd\":\"pwd\"}",
          }],
        },
      },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    const exchange = await buildRawCapturedExchangeV2({
      dataDir: fixture.dataDir,
      captureSessionId: "capture-v2-1784691000000-abcdef12-345",
      sequence: 1,
      capturedAt: "2026-07-22T01:10:00.000Z",
      completedAt: "2026-07-22T01:10:01.000Z",
      routing: {
        targetId: "target-small-stream",
        targetName: "Small Stream Target",
        targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/v1/responses",
        upstreamUrl: "https://example.test/v1/responses",
        localPath: "/v1/responses",
        upstreamPath: "/v1/responses",
        method: "POST",
      },
      request: {
        headers: { "user-agent": "codex-tui/fixture" },
        rawBody: requestBody,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream" },
        rawBody: responseBody,
        isStreaming: true,
      },
    });

    try {
      const projected = await createExchangeProjector({
        dataDir: fixture.dataDir,
        projectionVersion: 3,
      }).project(exchange);
      const responseItems = projected.preview.items
        .filter(item => item.side === "response");

      expect(projected.path).toBe("small");
      expect(responseItems).toEqual([
        expect.objectContaining({
          itemType: "response.function_call_arguments.delta",
          toolUseId: "call-small",
          textPreview: "{\"cmd\":\"pwd\"}",
        }),
      ]);
      expect(responseItems.some(item =>
        item.textPreview?.includes("You are Codex"))).toBe(false);
      expect(projected.exchange.stream?.lifecycleSummary).toEqual(
        expect.objectContaining({
          eventCount: 3,
          terminalEventSeen: true,
          providerStatus: "completed",
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("超过媒体条数和 JSON 深度时成功受限且对象保持有界", async () => {
    const media = Array.from({ length: 257 }, (_, index) => ({
      image_url: `data:image/png;base64,${Buffer.from(`media-${index}`).toString("base64")}`,
    }));
    const deep = `${"{\"nested\":".repeat(130)}"end"${"}".repeat(130)}`;
    const mediaProjected = await projectProtocolStream({
      stream: chunked(JSON.stringify({ input: media }), 101),
      format: "json",
      exchangeId: "media-limit",
      bodySide: "request",
      rawBodySha256: "c".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 1,
    });
    const deepProjected = await projectProtocolStream({
      stream: chunked(deep, 13),
      format: "json",
      exchangeId: "depth-limit",
      bodySide: "request",
      rawBodySha256: "d".repeat(64),
      sourceStorage: "inline",
      projectionVersion: 1,
    });

    expect(mediaProjected.mediaDescriptors).toHaveLength(256);
    expect(mediaProjected.limitedDimensions).toContain("request_media");
    expect(JSON.stringify(mediaProjected)).not.toContain("data:");
    expect(deepProjected.diagnosticCodes).toContain("json_depth_exceeded");
    expect(deepProjected.limitedDimensions).toContain("request_text");
  });

  test("Worker 对超过 8 MiB 的真实 external blob 建立业务投影和预览", async () => {
    const fixture = await createSqliteFixture();
    const binary = Buffer.alloc(7 * 1024 * 1024, 0x5a);
    const requestBody = JSON.stringify({
      model: "gpt-large-fixture",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "large request" },
          { type: "input_image", image_url: `data:image/png;base64,${binary.toString("base64")}` },
        ],
      }],
    });
    const responseBody = JSON.stringify({
      object: "response",
      status: "completed",
      model: "gpt-large-fixture",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const exchange = await buildRawCapturedExchangeV2({
      dataDir: fixture.dataDir,
      captureSessionId: "capture-v2-1784690000000-abcdef12-345",
      sequence: 1,
      capturedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:01.000Z",
      routing: {
        targetId: "target-large",
        targetName: "Large Target",
        targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/v1/responses",
        upstreamUrl: "https://example.test/v1/responses",
        localPath: "/v1/responses",
        upstreamPath: "/v1/responses",
        method: "POST",
      },
      request: {
        headers: {
          "user-agent": "codex-tui/fixture",
          session_id: "session-large",
          thread_id: "thread-large",
          "x-codex-turn-metadata": JSON.stringify({
            session_id: "session-large",
            thread_id: "thread-large",
            turn_id: "turn-large",
            request_kind: "turn",
          }),
        },
        rawBody: requestBody,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        rawBody: responseBody,
        isStreaming: false,
      },
      rawBodyPolicy: { inlineThresholdBytes: 1, compressedInlineThresholdBytes: 2 },
    });
    expect(exchange.request.rawBodyRef?.storage).toBe("external-blob");
    expect(exchange.request.bodySizeBytes).toBeGreaterThan(8 * 1024 * 1024);
    await fixture.writeV2Lines([exchange], "large-worker.jsonl");
    const worker = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "large-worker",
      diskReserveBytes: 0,
      availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    try {
      expect(worker.acquireLease()).toBe(true);
      const batch = await worker.runOneBatch();
      expect(batch.processedCount).toBe(1);
      expect(fixture.db.prepare(
        `SELECT job_status, projection_completeness, request_verification
         FROM derivation_jobs`,
      ).get()).toEqual({
        job_status: "succeeded",
        projection_completeness: "limited",
        request_verification: "verified",
      });
      expect(fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_steps WHERE exchange_id = ?",
      ).pluck().get(exchange.exchangeId)).toBe(1);
      expect(fixture.db.prepare(
        "SELECT decoded_bytes, sha256 FROM exchange_media_descriptors",
      ).get()).toEqual({
        decoded_bytes: binary.length,
        sha256: createHash("sha256").update(binary).digest("hex"),
      });
      const preview = fixture.db.prepare(
        "SELECT preview_json, size_bytes FROM exchange_content_previews",
      ).get() as { preview_json: string; size_bytes: number };
      expect(preview.size_bytes).toBeLessThanOrEqual(256 * 1024);
      expect(preview.preview_json).not.toContain("data:");
      expect(preview.preview_json).not.toContain(binary.toString("base64").slice(100, 300));
    } finally {
      await worker.close();
      await fixture.cleanup();
    }
  }, 30_000);
});

function chunked(value: string, size: number): Readable {
  const bytes = Buffer.from(value);
  return Readable.from((async function* () {
    for (let offset = 0; offset < bytes.length; offset += size) {
      yield bytes.subarray(offset, offset + size);
    }
  })());
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
