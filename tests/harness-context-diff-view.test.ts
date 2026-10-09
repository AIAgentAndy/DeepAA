import { describe, expect, test } from "vitest";
import {
  buildObservedContextSnapshot,
  buildStepContextDiffView,
  diffContextSnapshots,
  normalizeExchange,
} from "../src/lib/harness/index.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

describe("Harness context diff view model", () => {
  test("builds a full target context with added assistant calls and tool outputs highlighted", () => {
    const before = normalizeExchange(makeResponsesExchange("cap:ex-90", {
      input: [
        message("user", "检查 toolshub"),
        message("assistant", "我先确认目录引用。"),
        functionCall("call_old", "exec_command", { cmd: "rg toolshub" }),
        functionOutput("call_old", "rg output"),
      ],
      output: [
        message("assistant", "我再看 package 和 README。"),
        functionCall("call_a", "exec_command", { cmd: "cat package.json" }),
        functionCall("call_b", "exec_command", { cmd: "sed -n '1,120p' README.md" }),
      ],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    }));
    const after = normalizeExchange(makeResponsesExchange("cap:ex-91", {
      input: [
        message("user", "检查 toolshub"),
        message("assistant", "我先确认目录引用。"),
        functionCall("call_old", "exec_command", { cmd: "rg toolshub" }),
        functionOutput("call_old", "rg output"),
        message("assistant", "我再看 package 和 README。"),
        functionCall("call_a", "exec_command", { cmd: "cat package.json" }),
        functionCall("call_b", "exec_command", { cmd: "sed -n '1,120p' README.md" }),
        functionOutput("call_a", "package output"),
        functionOutput("call_b", "readme output"),
      ],
      output: [message("assistant", "可以删除。")],
      usage: { input_tokens: 130, output_tokens: 35, total_tokens: 165 },
    }));
    const beforeSnapshot = buildObservedContextSnapshot(before, "step-90");
    const afterSnapshot = buildObservedContextSnapshot(after, "step-91");
    const diff = diffContextSnapshots(beforeSnapshot, afterSnapshot);

    const view = buildStepContextDiffView(beforeSnapshot, afterSnapshot, diff);

    expect(view.targetRows).toHaveLength(9);
    expect(view.targetRows.map(row => row.status)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
      "added",
      "added",
      "added",
      "added",
      "added",
    ]);
    expect(view.targetRows.slice(4).map(row => row.kind)).toEqual([
      "message",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ]);
    expect(view.changeSummary).toMatchObject({
      addedMessages: 3,
      addedToolResults: 2,
      removedMessages: 0,
      removedToolResults: 0,
      addedToolUses: 0,
      removedToolUses: 2,
    });
    expect(view.tokenDelta).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
    });
    expect(view.targetRows.find(row => row.toolUseId === "call_a")).toMatchObject({
      status: "added",
      title: "工具调用 exec_command",
      preview: "{\"cmd\":\"cat package.json\"}",
      evidence: [{ exchangeId: "cap:ex-91", side: "request", path: "$.input[5]" }],
    });
    expect(view.targetRows.find(row => row.toolUseId === "call_b" && row.kind === "tool_result")).toMatchObject({
      status: "added",
      title: "工具结果 call_b",
      preview: "readme output",
    });
  });

  test("keeps duplicate context rows addressable and diffs them by occurrence", () => {
    const duplicatedInput = message("user", "重复的问题");
    const before = normalizeExchange(makeResponsesExchange("cap:ex-92", {
      input: [duplicatedInput],
      output: [message("assistant", "收到。")],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    }));
    const after = normalizeExchange(makeResponsesExchange("cap:ex-93", {
      input: [duplicatedInput, duplicatedInput],
      output: [message("assistant", "收到。")],
      usage: { input_tokens: 24, output_tokens: 3, total_tokens: 27 },
    }));
    const beforeSnapshot = buildObservedContextSnapshot(before, "step-92");
    const afterSnapshot = buildObservedContextSnapshot(after, "step-93");
    const diff = diffContextSnapshots(beforeSnapshot, afterSnapshot);

    const view = buildStepContextDiffView(beforeSnapshot, afterSnapshot, diff);

    expect(diff.addedMessages).toHaveLength(1);
    expect(view.targetRows.map(row => row.status)).toEqual(["unchanged", "added"]);
    expect(new Set(view.targetRows.map(row => row.id)).size).toBe(view.targetRows.length);
  });
});

function makeResponsesExchange(
  exchangeId: string,
  values: {
    input: unknown[];
    output: unknown[];
    usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  }
): RawCapturedExchange {
  const request = {
    model: "gpt-5",
    prompt_cache_key: "session-1",
    input: values.input,
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
  };
  const response = {
    object: "response",
    status: "completed",
    output: values.output,
    usage: values.usage,
  };
  return {
    schemaVersion: 1,
    exchangeId,
    captureSessionId: "cap",
    sequence: Number(exchangeId.split("-").at(-1)) || 1,
    capturedAt: "2026-06-04T00:00:00.000Z",
    completedAt: "2026-06-04T00:00:01.000Z",
    durationMs: 1000,
    routing: {
      targetId: "api.example.com",
      targetName: "api.example.com",
      targetFormatHint: "openai",
      localUrl: "/responses",
      upstreamUrl: "https://api.example.com/v1/responses",
      localPath: "/responses",
      upstreamPath: "/responses",
      method: "POST",
    },
    request: {
      headers: { "session-id": "session-1" },
      rawBody: JSON.stringify(request),
      parsedBody: request,
      bodySizeBytes: 1,
      bodySha256: "req",
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: JSON.stringify(response),
      parsedBody: response,
      bodySizeBytes: 1,
      bodySha256: "res",
      isStreaming: false,
    },
    bodyStorage: {
      policy: "inline",
      compression: "gzip",
      externalBlobDir: "blobs",
      thresholdBytes: 262144,
    },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function message(role: "user" | "assistant", text: string) {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  };
}

function functionCall(callId: string, name: string, args: unknown) {
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function functionOutput(callId: string, output: string) {
  return {
    type: "function_call_output",
    call_id: callId,
    output,
  };
}
