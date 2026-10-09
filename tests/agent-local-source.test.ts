import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { matchAndComposePromotions } from "@/lib/provider-catalog/campaign-matcher";
import type { PlanCreditPromotion } from "@/lib/pricing";
import {
  buildSyntheticExchange,
  createImportCaptureSessionId,
  ImportCaptureFileWriter,
} from "@/lib/agent-local-source/synthetic-capture";
import type { AgentLocalSourceAdapter, LocalUsageRecord } from "@/lib/agent-local-source/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function makeRecord(overrides: Partial<LocalUsageRecord> = {}): LocalUsageRecord {
  const startedAt = overrides.startedAt ?? Date.parse("2026-09-15T08:41:22.136Z");
  return {
    id: "usage_model_main_turn_msg_x_1",
    attemptIndex: 0,
    providerId: "builtin:bigmodel-coding-plan",
    modelId: "GLM-5.3-Flash",
    querySource: "main_turn",
    status: "completed",
    startedAt,
    completedAt: startedAt + 6_000,
    durationMs: 6_000,
    firstTokenMs: 1_200,
    finishReason: "stop",
    usage: {
      inputTokens: 42632,
      outputTokens: 132,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 26624,
    },
    sessionId: "sess_93bf43ba",
    turnId: "turn_063fe4e9",
    traceId: "trace-abc",
    projectDirectory: "/tmp/proj",
    detailRef: { sessionId: "sess_93bf43ba", turnId: "turn_063fe4e9", startedAt },
    ...overrides,
  };
}

const stubAdapter: AgentLocalSourceAdapter = {
  agentId: "zcode",
  label: "ZCode",
  gatewayProviderMarkers: ["deepaa-gateway"],
  officialUpstreamBaseUrl: "https://open.bigmodel.cn/api/anthropic",
  protocolPath: "/v1/messages",
  normalizeModelId: value => value.trim().toLowerCase(),
  discover: async () => ({ availability: { state: "available" }, dataDir: "/tmp" }),
  readUsage: async () => ({ records: [] }),
  readExchangeDetail: async () => ({
    requestRawBody: JSON.stringify({
      model: "GLM-5.3-Flash",
      max_tokens: 16,
      messages: [{ role: "user", content: "1111" }],
    }),
    requestHeaders: { "user-agent": "ZCode/3.11.2", "x-zcode-app-version": "3.11.2" },
    response: {
      finishReason: "stop",
      text: "你好",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  }),
};

describe("合成 v2 raw 捕获", () => {
  test("契约级同构：origin/routeMode/exchangeId 幂等/头合成/usage 权威", () => {
    const record = makeRecord();
    const detail = stubAdapter.readExchangeDetail !== undefined ? undefined : undefined;
    void detail;
    const built = buildSyntheticExchange({
      agentId: "zcode",
      record,
      modelId: "glm-5.3-flash",
      target: { id: "bigmodel.cn-api-coding-paas-v4", name: "bigmodel", defaultCredentialId: "cred_x" },
      adapter: stubAdapter,
      detail: {
        requestRawBody: JSON.stringify({ model: "GLM-5.3-Flash", messages: [{ role: "user", content: "1111" }] }),
        requestHeaders: { "user-agent": "ZCode/3.11.2" },
        response: { finishReason: "stop", text: "你好" },
      },
    });

    assert.equal(built.schemaVersion, 2);
    assert.equal(built.routing.origin, "agent_local_import");
    assert.equal(built.routing.routeMode, "local_import");
    assert.equal(built.routing.agent, "zcode");
    assert.equal(built.routing.wireApi, "messages");
    assert.equal(built.routing.targetId, "bigmodel.cn-api-coding-paas-v4");
    assert.equal(built.routing.clientCredentialId, "cred_x");
    assert.equal(built.routing.upstreamUrl, "https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.equal(built.routing.clientQuerySource, "main_turn");
    // exchangeId 幂等：同记录重复构建完全一致（重放零新增的根基）。
    const rebuilt = buildSyntheticExchange({
      agentId: "zcode",
      record,
      modelId: "glm-5.3-flash",
      target: { id: "bigmodel.cn-api-coding-paas-v4", name: "bigmodel" },
      adapter: stubAdapter,
    });
    assert.equal(built.exchangeId, rebuilt.exchangeId);
    assert.match(built.exchangeId, /^import-zcode-/);

    // thread-identity 折叠头与网关链路同一套。
    assert.equal(built.request.headers["x-zcode-trace-id"], "trace-abc");
    assert.equal(built.request.headers["x-session-id"], "sess_93bf43ba");
    assert.equal(built.request.headers["x-zcode-session-type"], "main");
    // 原生 turn 边界头（rollout 请求体无消息历史时的可靠边界信号）。
    assert.equal(built.request.headers["x-zcode-turn-id"], "turn_063fe4e9");
    // 认证头按占位语义合成。
    assert.equal(built.request.headers.authorization, "Bearer deepaa-gateway");
    assert.equal(built.request.headers["x-api-key"], "deepaa-gateway");

    // body.model 改写为归一名（计价链精确匹配），其余字段保真。
    const body = JSON.parse(built.request.rawBody!) as { model: string; messages: unknown[] };
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(built.routing.requestedModel, "glm-5.3-flash");

    // 真实用户输入回填：messages 为空时注入单条 user 文本消息（本地 message/part 原文）。
    const withUser = buildSyntheticExchange({
      agentId: "zcode",
      record: makeRecord({ userText: "你这又快搞一天了，进展到哪里了？" }),
      modelId: "glm-5.3-flash",
      target: { id: "t", name: "t" },
      adapter: stubAdapter,
      detail: { requestRawBody: JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 16, messages: [] }) },
    });
    const userBody = JSON.parse(withUser.request.rawBody!) as { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> };
    assert.equal(userBody.messages.length, 1);
    assert.equal(userBody.messages[0]!.role, "user");
    assert.equal(userBody.messages[0]!.content[0]!.text, "你这又快搞一天了，进展到哪里了？");

    // 响应为 anthropic 非流式 message；usage 以客户端自报权威值为准。
    assert.equal(built.response.isStreaming, false);
    assert.equal(built.response.status, 200);
    const responseBody = JSON.parse(built.response.rawBody!) as {
      type: string;
      usage: Record<string, number>;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
    };
    assert.equal(responseBody.type, "message");
    // 口径转换：zcode inputTokens 含缓存（OpenAI/GLM 口径），anthropic wire 分列。
    assert.equal(responseBody.usage.input_tokens, 42632 - 26624);
    assert.equal(responseBody.usage.cache_read_input_tokens, 26624);
    assert.equal(responseBody.stop_reason, "end_turn");
    assert.ok(responseBody.content.some(item => item.type === "text" && item.text === "你好"));

    assert.equal(built.durationMs, 6_000);
    assert.equal(built.firstTokenMs, 1_200);
    assert.equal(built.security.containsSensitiveHeaders, false);
  });

  test("正文缺失：missing_raw_body 诊断 + 仅含 usage 的最小响应体（账本不缺数）", () => {
    const built = buildSyntheticExchange({
      agentId: "zcode",
      record: makeRecord(),
      modelId: "glm-5.3-flash",
      target: { id: "t", name: "t" },
      adapter: stubAdapter,
      detail: undefined,
    });
    assert.ok(built.captureDiagnostics.some(item => item.code === "missing_raw_body"));
    const responseBody = JSON.parse(built.response.rawBody!) as { usage: Record<string, number>; content: unknown[] };
    assert.equal(responseBody.usage.input_tokens, 42632 - 26624);
    assert.equal(responseBody.usage.output_tokens, 132);
  });

  test("error/cancelled 状态映射与诊断", () => {
    const failed = buildSyntheticExchange({
      agentId: "zcode",
      record: makeRecord({ status: "error", errorCode: "HTTP 502", errorMessage: "bad gateway" }),
      modelId: "glm-5.3-flash",
      target: { id: "t", name: "t" },
      adapter: stubAdapter,
    });
    assert.equal(failed.response.status, 502);
    assert.ok(failed.captureDiagnostics.some(item => item.code === "upstream_error"));

    const cancelled = buildSyntheticExchange({
      agentId: "zcode",
      record: makeRecord({ status: "cancelled" }),
      modelId: "glm-5.3-flash",
      target: { id: "t", name: "t" },
      adapter: stubAdapter,
    });
    assert.equal(cancelled.response.status, 499);
  });

  test("subagent 会话类型合成 subagent 头（thread-identity 折叠依据）", () => {
    const built = buildSyntheticExchange({
      agentId: "zcode",
      record: makeRecord({ querySource: "subagent", sessionId: "sess_sub" }),
      modelId: "glm-5.3-flash",
      target: { id: "t", name: "t" },
      adapter: stubAdapter,
    });
    assert.equal(built.request.headers["x-zcode-session-type"], "subagent");
  });
});

describe("合成捕获写入器", () => {
  test("落盘 JSONL、captureSessionId/sequence 由写入器统一赋值、超限轮转", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepaa-import-writer-"));
    tempDirs.push(dir);
    const writer = new ImportCaptureFileWriter(dir, "zcode", 40);
    const makeBuilt = (id: string) => buildSyntheticExchange({
      agentId: "zcode",
      record: makeRecord({ id }),
      modelId: "glm-5.3-flash",
      target: { id: "t", name: "t" },
      adapter: stubAdapter,
    });
    await writer.appendBatch([makeBuilt("a"), makeBuilt("b")]);
    const files = (await readdir(join(dir, "captures", "v2"))).sort();
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^import-zcode-\d+-[0-9a-f-]+\.jsonl$/);
    const lines = (await readFile(join(dir, "captures", "v2", files[0]!), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as { captureSessionId: string; sequence: number; exchangeId: string };
    const second = JSON.parse(lines[1]!) as { captureSessionId: string; sequence: number };
    assert.equal(first.captureSessionId, files[0]!.replace(/\.jsonl$/, ""));
    assert.equal(second.captureSessionId, first.captureSessionId);
    assert.equal(second.sequence, first.sequence + 1);
    // 超过 40 字节阈值后轮转新文件。
    await writer.appendBatch([makeBuilt("c")]);
    const afterRotation = (await readdir(join(dir, "captures", "v2"))).sort();
    assert.equal(afterRotation.length, 2);
  });

  test("captureSessionId 固定宽度可追溯（前缀 + 时间戳 + uuid 段）", () => {
    const sessionId = createImportCaptureSessionId("zcode", 1_700_000_000_000);
    assert.match(sessionId, /^import-zcode-1700000000000-[0-9a-f]{8}-[0-9a-f]{3}$/);
  });
});

describe("Campaign origins 通道判定（D-3）", () => {
  const promotions: PlanCreditPromotion[] = [{
    from: "2026-06-01T00:00:00+08:00",
    multiplier: 2 / 3,
    agents: ["zcode"],
    origins: ["agent_local_import"],
    label: "ZCode Agent 限时活动",
  }];

  test("直连导入通道命中 ×0.67，网关通道不命中", () => {
    const direct = matchAndComposePromotions(promotions, "glm-5.3-flash", "2026-09-15T08:41:22.136Z", "zcode", "Asia/Shanghai", "agent_local_import");
    assert.equal(direct.multiplier, 2 / 3);
    assert.equal(direct.labels.length, 1);

    const gateway = matchAndComposePromotions(promotions, "glm-5.3-flash", "2026-09-15T08:41:22.136Z", "zcode", "Asia/Shanghai", "gateway");
    assert.equal(gateway.multiplier, undefined);
    assert.equal(gateway.matched.length, 0);
  });

  test("origins 缺省的活动全通道生效（存量行为不变）", () => {
    const legacy: PlanCreditPromotion[] = [{ from: "2026-06-01T00:00:00+08:00", multiplier: 0.5 }];
    assert.equal(matchAndComposePromotions(legacy, "m", "2026-09-15T00:00:00Z", undefined, "Asia/Shanghai", "gateway").multiplier, 0.5);
    assert.equal(matchAndComposePromotions(legacy, "m", "2026-09-15T00:00:00Z", undefined, "Asia/Shanghai", "agent_local_import").multiplier, 0.5);
  });
});


describe("parts 重建器（2026-09-16 白名单重建机制）", () => {
  test("响应直映射：reasoning→thinking / text→text / tool→tool_use / step-finish→stop_reason", async () => {
    const {indexTimeline, rebuildExchangeFromTimeline} = await import("@/lib/agent-local-source/parts-rebuilder");
    const timeline = {
      messages: [{
        messageId: "asst-1", role: "assistant" as const, visible: true,
        parts: [
          {kind: "step_start"},
          {kind: "reasoning", text: "先想清楚"},
          {kind: "text", text: "我来处理"},
          {kind: "tool", toolName: "Read", callId: "call_1", toolInput: {file_path: "/x"}, toolOutput: "file body", toolStatus: "completed"},
          {kind: "step_finish", reason: "tool-calls"},
        ],
      }],
    };
    const rebuilt = rebuildExchangeFromTimeline(indexTimeline(timeline), "asst-1")!;
    const types = rebuilt.responseContent.map(block => block.type);
    assert.deepEqual(types, ["thinking", "text", "tool_use"]);
    assert.equal(rebuilt.stopReason, "tool-calls");
  });

  test("上下文回放：user/assistant/tool_result 成对、hidden 过滤、compaction 截断", async () => {
    const {indexTimeline, rebuildExchangeFromTimeline, buildRebuiltRequestBody} = await import("@/lib/agent-local-source/parts-rebuilder");
    const timeline = {
      messages: [
        {messageId: "u0", role: "user" as const, visible: true, parts: [{kind: "text", text: "第一问"}]},
        {messageId: "a1", role: "assistant" as const, visible: true, parts: [
          {kind: "text", text: "回答一"},
          {kind: "tool", toolName: "Bash", callId: "call_a", toolInput: {command: "ls"}, toolOutput: "out-a", toolStatus: "completed"},
        ]},
        {messageId: "hidden1", role: "user" as const, visible: false, parts: [{kind: "text", text: "不该出现"}]},
        {messageId: "a2", role: "assistant" as const, visible: true, parts: [
          {kind: "compaction", tailMessageId: "u1"},
        ]},
        {messageId: "u1", role: "user" as const, visible: true, parts: [{kind: "text", text: "第二问"}]},
        {messageId: "a3", role: "assistant" as const, visible: true, parts: [{kind: "text", text: "回答二"}]},
      ],
    };
    const index = indexTimeline(timeline);
    const rebuilt = rebuildExchangeFromTimeline(index, "a3")!;
    const roles = rebuilt.requestMessages.map(message => message.role);
    // compaction tailMessageId=u1 → 上下文从 u1 开始（u0/a1/hidden1/a2 全部截掉）
    assert.deepEqual(roles, ["user"]);
    const body = JSON.parse(buildRebuiltRequestBody(JSON.stringify({system: [], tools: []}), rebuilt, "glm-5.3-flash"));
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal((body.messages as unknown[]).length, 1);

    // 无 compaction 的完整回放（对 a2 重建）：u0 → a1(text+tool_use) → user(tool_result) → hidden 过滤
    const rebuilt2 = rebuildExchangeFromTimeline(index, "a2")!;
    const shapes = rebuilt2.requestMessages.map(message => ({role: message.role, content: message.content}));
    assert.equal(shapes.length, 3);
    assert.equal(shapes[0]!.role, "user");
    assert.equal(shapes[1]!.role, "assistant");
    assert.equal(shapes[2]!.role, "user");
    const toolResultContent = (shapes[2]!.content as Array<Record<string, unknown>>)[0]!;
    assert.equal(toolResultContent.type, "tool_result");
    assert.equal(toolResultContent.tool_use_id, "call_a");
    assert.equal(toolResultContent.content, "out-a");
    const hiddenText = JSON.stringify(rebuilt2.requestMessages);
    assert.ok(!hiddenText.includes("不该出现"), "hidden 消息必须被过滤");
  });
});
