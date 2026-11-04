import {describe, expect, test} from "vitest";
import {fingerprintAgent} from "../src/lib/harness/fingerprint.js";
import {classifyProtocol} from "../src/lib/harness/protocol.js";
import type {RawCapturedExchange} from "../src/lib/harness/types.js";

describe("Agent 指纹与 wireApi 协议分类", () => {
  test("routing.agent 已知时直接采用且置信度 exact", () => {
    const fingerprint = fingerprintAgent(exchange({
      routingAgent: "opencode",
      headers: {"user-agent": "claude-cli/1.0", "x-claude-code-session-id": "ignored"},
    }));

    expect(fingerprint.agentName).toBe("opencode");
    expect(fingerprint.confidence).toBe("exact");
    expect(fingerprint.evidence[0]?.kind).toBe("routing-agent");
  });

  test("OpenCode 头与 User-Agent 识别", () => {
    expect(fingerprintAgent(exchange({headers: {"x-opencode-session": "ses_1"}})).agentName).toBe("opencode");
    expect(fingerprintAgent(exchange({headers: {"x-session-affinity": "affinity-1"}})).agentName).toBe("opencode");
    expect(fingerprintAgent(exchange({headers: {"user-agent": "opencode/0.2"}})).agentName).toBe("opencode");
  });

  test("ZCode UA 与 x-zcode-* 头识别，且优先于 opencode 的 x-session-id 兜底", () => {
    expect(fingerprintAgent(exchange({
      headers: {"user-agent": "ZCode/3.9.2", "x-session-id": "sess-zcode-1"},
    })).agentName).toBe("zcode");
    expect(fingerprintAgent(exchange({headers: {"x-zcode-agent": "glm"}})).agentName).toBe("zcode");
    expect(fingerprintAgent(exchange({headers: {"x-zcode-trace-id": "trace-1"}})).agentName).toBe("zcode");
    // 若无 zcode 专属证据，通用 x-session-id 仍归 opencode 兜底（行为不变）。
    expect(fingerprintAgent(exchange({headers: {"x-session-id": "sess-generic"}})).agentName).toBe("opencode");
  });

  test("routing.agent=zcode 直接命中且置信度 exact", () => {
    const fingerprint = fingerprintAgent(exchange({
      routingAgent: "zcode",
      headers: {"user-agent": "opencode/0.9"},
    }));
    expect(fingerprint.agentName).toBe("zcode");
    expect(fingerprint.confidence).toBe("exact");
  });

  test("dsh 头与 User-Agent 识别", () => {
    expect(fingerprintAgent(exchange({headers: {"x-deepseek-harness-session-id": "session-1"}})).agentName).toBe("dsh");
    expect(fingerprintAgent(exchange({headers: {"x-deepseek-harness-user-id": "user-1"}})).agentName).toBe("dsh");
    expect(fingerprintAgent(exchange({headers: {"user-agent": "deepseek-harness/1.2"}})).agentName).toBe("dsh");
  });

  test("wireApi 驱动协议分类，路径推断只用于历史 raw", () => {
    const responses = classifyProtocol(exchange({
      wireApi: "responses",
      path: "/v1/responses",
      body: {model: "gpt-test", input: []},
    }));
    expect(responses.protocol).toBe("openai-responses");

    const chat = classifyProtocol(exchange({
      wireApi: "chat_completions",
      path: "/v1/chat/completions",
      body: {model: "deepseek-v4", messages: []},
    }));
    expect(chat.protocol).toBe("openai-chat-completions");

    const messages = classifyProtocol(exchange({
      wireApi: "messages",
      path: "/v1/messages",
      headers: {"anthropic-version": "2023-06-01"},
      body: {model: "claude-sonnet", messages: []},
    }));
    expect(messages.protocol).toBe("anthropic-messages");
    expect(messages.evidence[0]?.path).toBe("wireApi");
  });

  test("Agent 自报 session_title 的请求归类为辅助（不进模型 Step 链）", () => {
    const title = classifyProtocol(exchange({
      routingAgent: "zcode",
      wireApi: "messages",
      path: "/zcode/v1/messages",
      clientQuerySource: "session_title",
      headers: {"anthropic-version": "2023-06-01"},
      body: {model: "glm-5.3-flash", system: [{type: "text", text: "Generate a concise title"}], messages: []},
    }));
    expect(title.endpointKind).toBe("title-generation");
    expect(title.isAuxiliary).toBe(true);
    expect(title.isModelCall).toBe(false);
    expect(title.protocol).toBe("anthropic-messages");
    expect(title.evidence[0]?.path).toBe("clientQuerySource");

    const main = classifyProtocol(exchange({
      routingAgent: "zcode",
      wireApi: "messages",
      path: "/zcode/v1/messages",
      clientQuerySource: "main_turn",
      headers: {"anthropic-version": "2023-06-01"},
      body: {model: "glm-5.3-flash", messages: [{role: "user", content: "hi"}]},
    }));
    expect(main.endpointKind).toBe("model-call");
    expect(main.isModelCall).toBe(true);
  });

  test("无 wireApi 的旧 raw 仍按路径回退分类", () => {
    const classification = classifyProtocol(exchange({
      path: "/v1/messages",
      headers: {"anthropic-version": "2023-06-01"},
      body: {model: "claude-sonnet", messages: []},
    }));
    expect(classification.protocol).toBe("anthropic-messages");
    expect(classification.evidence[0]?.path).toBe("upstreamPath");
  });
});

function exchange(options: {
  routingAgent?: string;
  wireApi?: RawCapturedExchange["routing"]["wireApi"];
  path?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  clientQuerySource?: string;
}): RawCapturedExchange {
  const path = options.path ?? "/v1/responses";
  const body = options.body ?? {model: "gpt-test", input: []};
  return {
    schemaVersion: 1,
    exchangeId: "fp-test:ex-1",
    captureSessionId: "capture-fp",
    sequence: 1,
    capturedAt: "2026-08-22T00:00:00.000Z",
    completedAt: "2026-08-22T00:00:01.000Z",
    durationMs: 1_000,
    routing: {
      targetId: "target-1",
      targetName: "Target 1",
      targetFormatHint: path.includes("messages") ? "anthropic" : "openai",
      localUrl: `http://localhost:3211${path}`,
      upstreamUrl: `https://example.test${path}`,
      localPath: path,
      upstreamPath: path,
      method: "POST",
      ...(options.routingAgent ? {agent: options.routingAgent} : {}),
      ...(options.wireApi ? {wireApi: options.wireApi} : {}),
      ...(options.clientQuerySource ? {clientQuerySource: options.clientQuerySource} : {}),
    },
    request: {
      headers: Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
      rawBody: JSON.stringify(body),
      parsedBody: body,
      bodySizeBytes: JSON.stringify(body).length,
      bodySha256: "0".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: "{}",
      parsedBody: {},
      bodySizeBytes: 2,
      bodySha256: "1".repeat(64),
      isStreaming: false,
    },
    bodyStorage: {policy: "inline"},
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

describe("P1-1/F10（2026-11-03）：agentVersion 从 UA / 专属头解析", () => {
  test("codex-tui UA 版本解析,指纹 id 保持 fp-<agent>", () => {
    const fp = fingerprintAgent(exchange({
      path: "/codex/v1/responses",
      headers: {"user-agent": "codex-tui/0.165.0 (Mac OS X 15.2.0)"},
    }));
    expect(fp.agentName).toBe("codex");
    expect(fp.agentVersion).toBe("0.165.0");
    expect(fp.id).toBe("fp-codex");
  });

  test("zcode 优先 x-zcode-app-version 头;claude-cli/dsh/opencode UA 同规则", () => {
    const zcode = fingerprintAgent(exchange({
      path: "/zcode/v1/messages",
      headers: {"user-agent": "ZCode/1.0.0", "x-zcode-app-version": "1.2.34"},
    }));
    expect(zcode.agentName).toBe("zcode");
    expect(zcode.agentVersion).toBe("1.2.34");

    const claude = fingerprintAgent(exchange({
      path: "/claude/v1/messages",
      headers: {"user-agent": "claude-cli/2.1.34 (external, cli)"},
    }));
    expect(claude.agentVersion).toBe("2.1.34");

    const dsh = fingerprintAgent(exchange({
      path: "/dsh/v1/chat/completions",
      headers: {"user-agent": "deepseek-harness/0.2.1-rc.1", "x-deepseek-harness-session-id": "s"},
    }));
    expect(dsh.agentVersion).toBe("0.2.1-rc.1");
  });

  test("无可解析版本时 undefined,不虚构", () => {
    const fp = fingerprintAgent(exchange({
      path: "/codex/v1/responses",
      headers: {"user-agent": "curl/8.0"},
    }));
    expect(fp.agentVersion).toBeUndefined();
  });
});
