import {afterEach, describe, expect, test} from "vitest";
import http from "node:http";
import {
  buildUpstreamUrl,
  createUpstreamRequest,
  ensureOpenCodeGoSessionHeader,
  UpstreamAgentPool,
} from "../src/proxy/upstream-transport.js";
import {
  resetOfficialUpstreamProxyCacheForTests,
  setOfficialUpstreamProxyForTests,
} from "../src/proxy/official-upstream.js";

afterEach(() => {
  delete process.env.DEEPAA_UPSTREAM_PROXY;
  resetOfficialUpstreamProxyCacheForTests();
});

describe("上游连接池", () => {
  test("允许 100 个长流同时建立并保持连接数有界", async () => {
    const pool = new UpstreamAgentPool();
    // acquire 为异步（官方上游白名单的代理解析），同 origin 并发获取仍复用同一 Agent。
    const leases = await Promise.all(Array.from({length: 100}, () => pool.acquire(new URL("http://127.0.0.1:4311/v1/stream"))));

    expect(leases[0]!.agent.maxSockets).toBeGreaterThanOrEqual(100);
    expect(leases[0]!.agent.maxSockets).toBeLessThanOrEqual(128);

    for (const lease of leases) lease.release();
    pool.close();
  });
});

describe("双通道池与连接失败自愈（2026-10-10 用户确认）", () => {
  test("同一门控 origin 双通道并存：国外系模型隧道、国产模型直连，retainOrigins 按 origin 段保留", async () => {
    process.env.DEEPAA_UPSTREAM_PROXY = "http://127.0.0.1:7994";
    setOfficialUpstreamProxyForTests(undefined);
    const pool = new UpstreamAgentPool();
    const url = new URL("https://opencode.ai/zen/go/v1/chat/completions");
    const tunnelLease = await pool.acquire(url, "grok-4.7");
    const directLease = await pool.acquire(url, "deepseek-v4.1-flash");
    // 隧道 Agent 在实例上覆写 createConnection（工厂实现）；直连 Agent 只保留原型方法。
    expect(Object.prototype.hasOwnProperty.call(tunnelLease.agent, "createConnection")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(directLease.agent, "createConnection")).toBe(false);

    // 同 origin 两通道同时保留（按 origin 段匹配，不因通道键后缀误退休兄弟通道）。
    pool.retainOrigins(new Set(["https://opencode.ai"]));
    const tunnelAgain = await pool.acquire(url, "grok-4.7");
    expect(tunnelAgain.agent).toBe(tunnelLease.agent);
    tunnelLease.release();
    directLease.release();
    tunnelAgain.release();
    pool.close();
  });

  test("隧道连接失败：退休条目并失效探测缓存，下次 acquire 按新探测结果重建直连", async () => {
    process.env.DEEPAA_UPSTREAM_PROXY = "http://127.0.0.1:7994";
    setOfficialUpstreamProxyForTests(undefined);
    const pool = new UpstreamAgentPool();
    const url = new URL("https://opencode.ai/zen/go/v1/chat/completions");
    const failed = await pool.acquire(url, "grok-4.7");
    expect(Object.prototype.hasOwnProperty.call(failed.agent, "createConnection")).toBe(true);
    failed.reportConnectFailure(); // 模拟死隧道（连接期 ECONNREFUSED 127.0.0.1:7994）
    failed.release();

    // 「系统代理已清除」后的新探测结果：同模型同 origin 自愈为直连 Agent。
    delete process.env.DEEPAA_UPSTREAM_PROXY;
    setOfficialUpstreamProxyForTests(undefined);
    const healed = await pool.acquire(url, "grok-4.7");
    expect(Object.prototype.hasOwnProperty.call(healed.agent, "createConnection")).toBe(false);
    expect(healed.agent).not.toBe(failed.agent);
    healed.reportConnectFailure(); // 直连条目失败同样退休（幂等，不触碰 failover 状态机）。
    healed.release();
    pool.close();
  });

  test("代理端点变化换新隧道键：同 origin 不复用旧端点 Agent", async () => {
    process.env.DEEPAA_UPSTREAM_PROXY = "http://127.0.0.1:7001";
    setOfficialUpstreamProxyForTests(undefined);
    const pool = new UpstreamAgentPool();
    const url = new URL("https://chatgpt.com/backend-api/codex/responses");
    const first = await pool.acquire(url);
    process.env.DEEPAA_UPSTREAM_PROXY = "http://127.0.0.1:7002";
    const second = await pool.acquire(url);
    expect(Object.prototype.hasOwnProperty.call(second.agent, "createConnection")).toBe(true);
    expect(second.agent).not.toBe(first.agent);
    first.release();
    second.release();
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

describe("createUpstreamRequest 非法 header 不再泄漏定时器（2026-10-13 事故）", () => {
  test("非法 authorization 同步抛错且不产生悬挂定时器", async () => {
    let thrown: unknown;
    try {
      createUpstreamRequest(new URL("http://127.0.0.1:9/v1/x"), {
        method: "POST",
        headers: {authorization: "Bearer bad-\u706b\u5c71-token\n"},
        agent: new http.Agent(),
        headerTimeoutMs: 60,
      }, () => {
        throw new Error("非法 header 不应产生请求对象");
      });
    } catch (error) {
      thrown = error;
    }
    // Node 对 header 值同步抛 ERR_INVALID_CHAR——行为保持不变。
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Invalid character in header content/i);
    // 事故形态：headerDeadline 先于 request 创建，同步抛错后无人清理，60ms 后
    // 回调访问未初始化变量 → TDZ ReferenceError → 未捕获异常杀死整个 proxy。
    // vitest 将未捕获异常判为失败；静置跨过定时器窗口即证明定时器未泄漏。
    await new Promise(resolve => setTimeout(resolve, 150));
  });

  test("合法请求的响应头超时仍按期触发", async () => {
    const server = http.createServer(() => {
      // 接受请求但永不响应：触发 headerTimeout 路径。
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const failure = new Promise<Error>((resolve, reject) => {
        const request = createUpstreamRequest(
          new URL(`http://127.0.0.1:${port}/v1/x`),
          {method: "GET", headers: {}, agent: new http.Agent(), headerTimeoutMs: 80},
          () => reject(new Error("不应收到响应")),
        );
        request.once("error", resolve);
        request.end();
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("headerTimeoutMs 到期未销毁请求")), 2_000));
      const error = await Promise.race([failure, timeout]);
      expect(error.message).toBe("UPSTREAM_RESPONSE_HEADER_TIMEOUT");
    } finally {
      server.close();
    }
  });

  test("正常响应仍回调 onResponse 并清理定时器", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, {"content-type": "application/json"});
      response.end("{}");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = createUpstreamRequest(
          new URL(`http://127.0.0.1:${port}/v1/x`),
          {method: "GET", headers: {}, agent: new http.Agent(), headerTimeoutMs: 2_000},
          response => resolve(response.statusCode),
        );
        request.once("error", reject);
        request.end();
      });
      expect(status).toBe(200);
    } finally {
      server.close();
    }
  });
});
