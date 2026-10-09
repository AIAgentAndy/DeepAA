import {describe, expect, test} from "vitest";
import {
  buildUpstreamUrl,
  ensureOpenCodeGoSessionHeader,
  UpstreamAgentPool,
} from "../src/proxy/upstream-transport.js";

describe("上游连接池", () => {
  test("允许 100 个长流同时建立并保持连接数有界", async () => {
    const pool = new UpstreamAgentPool();
    // acquire 自 2026-10-08 起为异步（官方上游白名单的代理解析），同 origin 并发获取仍复用同一 Agent。
    const leases = await Promise.all(Array.from({length: 100}, () => pool.acquire(new URL("http://127.0.0.1:4311/v1/stream"))));

    expect(leases[0]!.agent.maxSockets).toBeGreaterThanOrEqual(100);
    expect(leases[0]!.agent.maxSockets).toBeLessThanOrEqual(128);

    for (const lease of leases) lease.release();
    pool.close();
  });
});

describe("OpenCode Go 上游会话头", () => {
  test("复用 Agent 自己的业务 Session，不随机伪造会话", () => {
    const headers: Record<string, string> = {"x-deepseek-harness-session-id": "dsh-session-1"};
    const upstreamUrl = new URL("https://opencode.ai/zen/go/v1/chat/completions");

    const resolved = ensureOpenCodeGoSessionHeader(headers, upstreamUrl, "dsh");

    expect(resolved).toBe("dsh-session-1");
    expect(headers["x-opencode-session"]).toBe("dsh-session-1");

    const existing = {"x-opencode-session": "ses_client"};
    expect(ensureOpenCodeGoSessionHeader(existing, upstreamUrl, "opencode")).toBe("ses_client");
    expect(existing["x-opencode-session"]).toBe("ses_client");
  });

  test("支持从 Agent 通用 Session 头映射，缺失时不注入任何随机值", () => {
    const headers: Record<string, string> = {session_id: "session-from-agent"};
    const upstreamUrl = new URL("https://opencode.ai/zen/go/v1/chat/completions");

    expect(ensureOpenCodeGoSessionHeader(headers, upstreamUrl, "codex")).toBe("session-from-agent");
    expect(headers["x-opencode-session"]).toBe("session-from-agent");

    const missing: Record<string, string> = {};
    expect(ensureOpenCodeGoSessionHeader(missing, upstreamUrl, "dsh")).toBeUndefined();
    expect(missing["x-opencode-session"]).toBeUndefined();
  });

  test("非 OpenCode Go 上游不注入供应商专用会话头", () => {
    const headers: Record<string, string> = {};

    expect(ensureOpenCodeGoSessionHeader(
      headers,
      new URL("https://example.com/zen/go/v1/chat/completions"),
    )).toBeUndefined();
    expect(headers["x-opencode-session"]).toBeUndefined();
  });

  test("识别不带 v1 路径段的 OpenCode Go base URL", () => {
    const headers: Record<string, string> = {"x-session-id": "session-1"};

    expect(ensureOpenCodeGoSessionHeader(
      headers,
      new URL("https://opencode.ai/zen/go/chat/completions"),
      "dsh",
    )).toBe("session-1");
  });
});

describe("buildUpstreamUrl 上游 URL 拼接（OpenAI/Anthropic SDK 行业规范）", () => {
  test("OpenAI：裸根 base 自动补齐 /v1（兼容 New API 只注册 /v1 路由）", () => {
    expect(buildUpstreamUrl("https://modelport.link", "/v1/responses", "").toString())
      .toBe("https://modelport.link/v1/responses");
    expect(buildUpstreamUrl("https://api.deepseek.com", "/v1/chat/completions", "").toString())
      .toBe("https://api.deepseek.com/v1/chat/completions");
    expect(buildUpstreamUrl("https://api.straitapi.com", "/v1/responses", "").toString())
      .toBe("https://api.straitapi.com/v1/responses");
  });

  test("OpenAI：base 自带 /v1 时拼接为 base + 端点", () => {
    expect(buildUpstreamUrl("https://api.openai.com/v1", "/v1/responses", "").toString())
      .toBe("https://api.openai.com/v1/responses");
    expect(buildUpstreamUrl("https://api.moonshot.cn/v1", "/v1/chat/completions", "").toString())
      .toBe("https://api.moonshot.cn/v1/chat/completions");
  });

  test("OpenAI：base 自带非 v1 版本段（火山方舟/智谱风格）不再重复 /v1", () => {
    expect(buildUpstreamUrl("https://ark.cn-beijing.volces.com/api/plan/v3", "/v1/responses", "").toString())
      .toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
    expect(buildUpstreamUrl("https://open.bigmodel.cn/api/paas/v4", "/v1/chat/completions", "").toString())
      .toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
  });

  test("Anthropic：base + /v1/messages 原样拼接", () => {
    expect(buildUpstreamUrl("https://api.anthropic.com", "/v1/messages", "").toString())
      .toBe("https://api.anthropic.com/v1/messages");
    expect(buildUpstreamUrl("https://ark.cn-beijing.volces.com/api/plan", "/v1/messages", "").toString())
      .toBe("https://ark.cn-beijing.volces.com/api/plan/v1/messages");
    expect(buildUpstreamUrl("https://api.deepseek.com/anthropic", "/v1/messages", "").toString())
      .toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  test("兼容历史配置：base 以 v1 结尾时 Anthropic 请求按末段去重", () => {
    expect(buildUpstreamUrl("https://proxy.example/v1", "/v1/messages", "").toString())
      .toBe("https://proxy.example/v1/messages");
  });

  test("保留 search 参数", () => {
    expect(buildUpstreamUrl("https://api.deepseek.com", "/v1/responses", "?beta=true").toString())
      .toBe("https://api.deepseek.com/v1/responses?beta=true");
  });

  test("base 末尾带斜杠时不会产生双斜杠", () => {
    expect(buildUpstreamUrl("https://api.lajiang.xyz/", "/v1/responses", "").toString())
      .toBe("https://api.lajiang.xyz/v1/responses");
    expect(buildUpstreamUrl("https://api.deepseek.com/v1/", "/v1/responses", "").toString())
      .toBe("https://api.deepseek.com/v1/responses");
    expect(buildUpstreamUrl("https://ark.cn-beijing.volces.com/api/plan/v3/", "/v1/responses", "").toString())
      .toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
    expect(buildUpstreamUrl("https://api.anthropic.com/", "/v1/messages", "").toString())
      .toBe("https://api.anthropic.com/v1/messages");
  });
});
