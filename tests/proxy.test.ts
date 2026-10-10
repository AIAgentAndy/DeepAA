import {createServer, request as httpRequest, type IncomingMessage, type ServerResponse} from "node:http";
import {chmod, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {createConnection} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {gzipSync} from "node:zlib";
import {afterEach, describe, expect, test, vi} from "vitest";
import {ProxyConfigStore, routeIdFromUpstreamUrl} from "../src/proxy-config.js";
import {startProxy, type NodeProxyServer} from "../src/reverse-proxy.js";
import {buildGatewayModelId} from "../src/proxy/gateway-prefix.js";
import {ProxyExchangeStore} from "../src/proxy/exchange-store.js";
import {supportedAcceptEncodings} from "../src/proxy/upstream-transport.js";
import type {RawCapturedExchangeV2} from "../src/proxy/raw-v2-contract.js";

interface FixtureServer {
  url: string;
  hits: Array<{method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer}>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
let sharedEchoHelperPath: string | undefined;

async function credentialHelperPath(): Promise<string> {
  if (sharedEchoHelperPath) return sharedEchoHelperPath;
  const root = await mkdtemp(join(tmpdir(), "proxy-credential-helper-"));
  const path = join(root, "echo-token.mjs");
  await writeFile(
    path,
    "#!/usr/bin/env node\nprocess.stdout.write('test-token\\n');\n",
    "utf8",
  );
  await chmod(path, 0o755);
  sharedEchoHelperPath = path;
  return path;
}

async function enableGatewayModels(
  config: ProxyConfigStore,
  models = ["gpt-test"],
): Promise<void> {
  const current = config.getConfig();
  const target = current.targets?.[0];
  if (!target) throw new Error("fixture target missing");
  await config.updateConfig({
    targets: [{
      ...target,
      supportedModels: models,
      supportedModelScopes: Object.fromEntries(models.map(model => [model, ["codex", "claude", "opencode", "dsh"]])),
      supportedModelWireApis: Object.fromEntries(models.map(model => [model, ["responses", "chat_completions", "messages"]])),
      development: {defaultCredentials: {
        codex: "test-cred",
        claude: "test-cred",
        opencode: "test-cred",
        dsh: "test-cred",
      }},
    }],
  });
}

function prefixedModel(fixture: {config: ProxyConfigStore}, modelId: string): string {
  const targetId = fixture.config.getConfig().targets?.[0]?.id;
  if (!targetId) throw new Error("fixture target missing");
  return buildGatewayModelId(targetId, modelId);
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()));
});

describe("Node reverse proxy", () => {
  test("hot-applies an atomic routing revision without reading config on the request path", async () => {
    const first = await startFixture((_request, response) => json(response, {source: "first"}));
    const second = await startFixture((_request, response) => json(response, {source: "second"}));
    const fixture = await startProxyFixture(first.url);

    await expect(postJson(fixture.proxy.port, "/codex/v1/responses", {
      model: prefixedModel(fixture, "gpt-test"),
    }))
      .resolves.toMatchObject({source: "first"});
    const target = fixture.config.getConfig().targets[0]!;
    await fixture.config.updateConfig({targetPatch: {id: target.id, target: {openaiUrl: second.url}}});
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    await expect(postJson(fixture.proxy.port, "/codex/v1/responses", {
      model: prefixedModel(fixture, "gpt-test"),
    }))
      .resolves.toMatchObject({source: "second"});

    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
    const raw = await waitForRaw(fixture.dataDir, 2);
    expect(raw.map(item => item.routing.upstreamUrl)).toEqual([
      `${first.url}/v1/responses`,
      `${second.url}/v1/responses`,
    ]);
  });

  test("captures one routing snapshot per request", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url);
    const current = vi.spyOn(fixture.proxy.routing, "current");

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/models`);
    expect(response.status).toBe(200);
    expect(current).toHaveBeenCalledTimes(1);
  });

  test("/v1/models 按 wireApi 输出格式与模型能力过滤", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url, [{
      id: "multi.example",
      name: "Multi",
      openaiUrl: upstream.url,
      anthropicUrl: upstream.url,
      enabled: true,
      supportedModels: ["gpt-test", "claude-test"],
      supportedModelScopes: {
        "gpt-test": ["codex", "opencode", "dsh"],
        "claude-test": ["opencode"],
      },
      supportedModelWireApis: {
        "gpt-test": ["responses", "chat_completions"],
        "claude-test": ["messages"],
      },
      development: {defaultCredentials: {
        codex: "test-cred",
        claude: "test-cred",
        opencode: "test-cred",
        dsh: "test-cred",
      }},
    }]);

    // OpenCode 默认 responses binding → OpenAI 格式，只含 responses 模型。
    const defaultModels = await fetch(`http://127.0.0.1:${fixture.proxy.port}/opencode/v1/models`)
      .then(response => response.json()) as {object: string; data: Array<{id: string}>};
    expect(defaultModels.object).toBe("list");
    expect(defaultModels.data.map(model => model.id)).toEqual(["gpt-test_multi.example"]);

    // OpenCode 显式 messages → Anthropic 格式，只含 messages 模型。
    const messages = await fetch(`http://127.0.0.1:${fixture.proxy.port}/opencode/v1/models?wireApi=messages`)
      .then(response => response.json()) as {data: Array<{id: string; type: string}>};
    expect(messages.data[0]).toMatchObject({id: "claude-test_multi.example", type: "model"});

    // dsh 只有 chat_completions binding → OpenAI 格式，只含 chat 模型。
    const dshModels = await fetch(`http://127.0.0.1:${fixture.proxy.port}/dsh/v1/models`)
      .then(response => response.json()) as {data: Array<{id: string}>};
    expect(dshModels.data.map(model => model.id)).toEqual(["gpt-test_multi.example"]);

    // 非法或未注册 wireApi 直接拒绝，不返回任何模型。
    const bad = await fetch(`http://127.0.0.1:${fixture.proxy.port}/opencode/v1/models?wireApi=bogus`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({error: "MODEL_WIRE_API_UNSUPPORTED"});
  });

  test("raw 落盘 routing 携带 agent 与 wireApi，供派生层精确溯源", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url);

    await postJson(fixture.proxy.port, "/opencode/v1/chat/completions", {
      model: prefixedModel(fixture, "gpt-test"),
    });

    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.routing).toMatchObject({
      agent: "opencode",
      wireApi: "chat_completions",
      requestedModel: prefixedModel(fixture, "gpt-test"),
      routeMode: "model",
    });
  });

  test("keeps an in-flight SSE on its captured target while new requests use the new revision", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstBlock = sse("response.created", {source: "first"});
    const firstTail = sse("response.completed", {source: "first"});
    const first = await startFixture(async (_request, response) => {
      response.writeHead(200, {"content-type": "text/event-stream"});
      response.write(firstBlock);
      await firstGate;
      response.end(firstTail);
    });
    const second = await startFixture((_request, response) => json(response, {source: "second"}));
    const fixture = await startProxyFixture(first.url);

    const oldResponse = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: prefixedModel(fixture, "gpt-test"), stream: true}),
    });
    const oldReader = oldResponse.body!.getReader();
    const oldFirst = await oldReader.read();
    expect(Buffer.from(oldFirst.value!).toString()).toBe(firstBlock);

    const target = fixture.config.getConfig().targets[0]!;
    await fixture.config.updateConfig({targetPatch: {id: target.id, target: {openaiUrl: second.url}}});
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    await expect(postJson(fixture.proxy.port, "/codex/v1/responses", {
      model: prefixedModel(fixture, "gpt-test"),
    }))
      .resolves.toEqual({source: "second"});

    releaseFirst();
    const oldChunks = [Buffer.from(oldFirst.value!)];
    while (true) {
      const next = await oldReader.read();
      if (next.done) break;
      oldChunks.push(Buffer.from(next.value));
    }
    expect(Buffer.concat(oldChunks).toString()).toBe(firstBlock + firstTail);
    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
  });

  test("网关按模型前缀路由目标、保留 query，且未知前缀与协议不匹配直接拒绝", async () => {
    const primary = await startFixture((_request, response) => json(response, {source: "primary"}));
    const gateway = await startFixture((_request, response) => json(response, {source: "gateway"}));
    const fixture = await startProxyFixture(primary.url, [{
      id: "primary.example",
      name: "Primary",
      openaiUrl: primary.url,
      enabled: true,
      supportedModels: ["gpt-test"],
      development: {defaultCredentials: {codex: "test-cred"}},
    }, {
      id: "gateway.example",
      name: "Gateway",
      openaiUrl: gateway.url,
      enabled: true,
      supportedModels: ["gpt-test"],
      development: {defaultCredentials: {codex: "test-cred"}},
    }]);

    const routed = await fetch(
      `http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses?q=a%2Fb%20c`,
      {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({model: "gpt-test_gateway.example"}),
      },
    );
    expect(await routed.json()).toMatchObject({source: "gateway"});
    expect(gateway.hits[0]?.url).toBe("/v1/responses?q=a%2Fb%20c");

    const unknown = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: "gpt-test_missing.example"}),
    });
    expect(unknown.status).toBe(404);
    expect(primary.hits).toHaveLength(0);

    const mismatch = await fetch(`http://127.0.0.1:${fixture.proxy.port}/claude/v1/messages`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: "gpt-test_gateway.example"}),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({error: "PROTOCOL_MISMATCH"});
  });

  test("无前缀模型直接返回 400 MODEL_PREFIX_REQUIRED", async () => {
    const upstream = await startFixture((_request, response) => json(response, {source: "unused"}));
    const fixture = await startProxyFixture(upstream.url);

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: "gpt-test"}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: "MODEL_PREFIX_REQUIRED"});
    expect(upstream.hits).toHaveLength(0);
  });

  test("目标同时配置两个协议 URL 时按路径分别转发到对应上游", async () => {
    const openaiUpstream = await startFixture((_request, response) => json(response, {source: "openai"}));
    const anthropicUpstream = await startFixture((_request, response) => json(response, {source: "anthropic"}));
    const fixture = await startProxyFixture(openaiUpstream.url, [{
      id: "api.deepseek.com",
      name: "DeepSeek",
      openaiUrl: openaiUpstream.url,
      anthropicUrl: anthropicUpstream.url,
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      development: {defaultCredentials: {codex: "test-cred", claude: "test-cred"}},
    }]);

    const responses = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: "deepseek-v4-flash_api.deepseek.com"}),
    });
    expect(await responses.json()).toMatchObject({source: "openai"});

    const messages = await fetch(`http://127.0.0.1:${fixture.proxy.port}/claude/v1/messages`, {
      method: "POST",
      headers: {"content-type": "application/json", "anthropic-version": "2023-06-01"},
      body: JSON.stringify({model: "deepseek-v4-flash_api.deepseek.com"}),
    });
    expect(await messages.json()).toMatchObject({source: "anthropic"});

    expect(openaiUpstream.hits).toHaveLength(1);
    expect(openaiUpstream.hits[0]?.url).toBe("/v1/responses");
    expect(anthropicUpstream.hits).toHaveLength(1);
    expect(anthropicUpstream.hits[0]?.url).toBe("/v1/messages");
  });

  test("订阅目标透传客户端 Authorization，Claude 路径兜底 anthropic-beta 头", async () => {
    const claudeUpstream = await startFixture((_request, response) => json(response, {ok: true}));
    const codexUpstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture("http://127.0.0.1:1", [{
      id: "claude-sub",
      name: "Claude 订阅",
      anthropicUrl: claudeUpstream.url,
      enabled: true,
      billingChannel: "subscription",
      supportedModels: ["claude-sonnet-4-5"],
    }, {
      id: "openai-sub",
      name: "OpenAI 订阅",
      openaiUrl: codexUpstream.url,
      enabled: true,
      billingChannel: "subscription",
      supportedModels: ["gpt-5.6-sol"],
    }]);

    const claudeResponse = await fetch(`http://127.0.0.1:${fixture.proxy.port}/claude/v1/messages`, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: "Bearer client-oauth-claude"},
      body: JSON.stringify({model: "claude-sonnet-4-5_claude-sub"}),
    });
    expect(claudeResponse.status).toBe(200);
    expect(claudeUpstream.hits[0]?.headers.authorization).toBe("Bearer client-oauth-claude");
    expect(claudeUpstream.hits[0]?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");

    const codexResponse = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: "Bearer client-oauth-codex"},
      body: JSON.stringify({model: "gpt-5.6-sol_openai-sub"}),
    });
    expect(codexResponse.status).toBe(200);
    expect(codexUpstream.hits[0]?.headers.authorization).toBe("Bearer client-oauth-codex");
    expect(codexUpstream.hits[0]?.headers["anthropic-beta"]).toBeUndefined();
  });

  test("网关替换客户端占位 Authorization 为按目标注入的凭证，raw 捕获不记录真实 token", async () => {
    const upstream = await startFixture((request, response) => {
      response.writeHead(201, "Created Upstream", [
        "content-type", "application/json",
        "set-cookie", "a=1; Path=/",
        "set-cookie", "b=2; Path=/",
        "connection", "close",
      ]);
      response.end(JSON.stringify({ok: true}));
    });
    const fixture = await startProxyFixture(upstream.url);
    const body = Buffer.from(JSON.stringify({model: prefixedModel(fixture, "gpt-test")}));

    const response = await rawRequest(fixture.proxy.port, {
      method: "POST",
      path: "/codex/v1/responses",
      headers: {
        authorization: "Bearer client-placeholder",
        connection: "x-remove",
        "x-remove": "must-not-forward",
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    });

    expect(response.status).toBe(201);
    expect(response.statusMessage).toBe("Created Upstream");
    expect(response.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(upstream.hits[0]?.headers.authorization).toBe("Bearer test-token");
    expect(upstream.hits[0]?.headers["x-remove"]).toBeUndefined();
    // 客户端未发送 accept-encoding 时不添加（原生直连同形态，不暴露代理自身信号）。
    expect(upstream.hits[0]?.headers["accept-encoding"]).toBeUndefined();
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.request.headers.authorization).toBe("Bearer client-placeholder");
    expect(JSON.stringify(raw)).not.toContain("test-token");
  });

  test("accept-encoding 按解码能力过滤透传：原值保留可解码编码，剔除不支持编码，未发送则不加头", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url);
    const model = prefixedModel(fixture, "gpt-test");
    // zstd 是否透传取决于运行时 zlib 能力（Node 22.15+ 支持），期望值必须同源推导，
    // 不能把「当前运行时不支持 zstd」写死进断言。
    const zstdSupported = supportedAcceptEncodings().includes("zstd");
    const matrix: Array<{client?: string; expected?: string}> = [
      {client: "gzip, deflate", expected: "gzip, deflate"},
      {
        client: "gzip, deflate, br, zstd",
        expected: zstdSupported ? "gzip, deflate, br, zstd" : "gzip, deflate, br",
      },
      {client: "zstd", expected: zstdSupported ? "zstd" : undefined},
      // 运行时永不解码的编码必须始终被剔除：zstd 分支随运行时变化，这条保证过滤语义恒被覆盖。
      {client: "gzip, compress", expected: "gzip"},
      {client: undefined, expected: undefined},
    ];
    for (const {client, expected} of matrix) {
      const body = Buffer.from(JSON.stringify({model}));
      const response = await rawRequest(fixture.proxy.port, {
        method: "POST",
        path: "/codex/v1/responses",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          ...(client ? {"accept-encoding": client} : {}),
        },
        body,
      });
      expect(response.status).toBe(200);
    }
    expect(upstream.hits.slice(-matrix.length).map(hit => hit.headers["accept-encoding"]))
      .toEqual(matrix.map(item => item.expected));
  });

  test("上游返回 gzip 压缩响应时客户端收到解码内容，raw 捕获落盘明文", async () => {
    const payload = JSON.stringify({ok: true, note: "压缩响应捕获语义"});
    const upstream = await startFixture((_request, response) => {
      const compressed = gzipSync(Buffer.from(payload, "utf8"));
      response.writeHead(200, [
        "content-type", "application/json",
        "content-encoding", "gzip",
        "content-length", String(compressed.length),
      ]);
      response.end(compressed);
    });
    const fixture = await startProxyFixture(upstream.url);
    const model = prefixedModel(fixture, "gpt-test");
    const body = Buffer.from(JSON.stringify({model}));

    const response = await rawRequest(fixture.proxy.port, {
      method: "POST",
      path: "/codex/v1/responses",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "gzip, deflate",
        "content-length": String(body.length),
      },
      body,
    });
    expect(response.status).toBe(200);
    // 客户端收到解码后的明文（content-encoding 已被剥除）。
    expect(response.body.toString("utf8")).toBe(payload);
    expect(response.headers["content-encoding"]).toBeUndefined();
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    // 捕获挂在解码之后：落盘的是明文 JSON 而非 gzip 字节。
    expect(raw?.response.rawBody ?? raw?.response.body).toContain("压缩响应捕获语义");
  });

  test("messages wire 注入同时覆写 x-api-key 为同一凭据，raw 捕获保留客户端占位头", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url, [{
      id: "api.deepseek.com",
      name: "DeepSeek",
      anthropicUrl: upstream.url,
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      supportedModelScopes: {"deepseek-v4-flash": ["claude"]},
      supportedModelWireApis: {"deepseek-v4-flash": ["messages"]},
      development: {defaultCredentials: {claude: "test-cred"}},
    }]);
    const body = Buffer.from(JSON.stringify({
      model: "deepseek-v4-flash_api.deepseek.com",
      max_tokens: 16,
      messages: [{role: "user", content: "hi"}],
    }));

    const response = await rawRequest(fixture.proxy.port, {
      method: "POST",
      path: "/claude/v1/messages",
      headers: {
        authorization: "Bearer client-placeholder",
        "x-api-key": "client-placeholder",
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    });

    expect(response.status).toBe(200);
    // anthropic 系 wire：authorization 与 x-api-key 双头携带同一注入凭据（镜像原生客户端形态）。
    expect(upstream.hits[0]?.headers.authorization).toBe("Bearer test-token");
    expect(upstream.hits[0]?.headers["x-api-key"]).toBe("test-token");
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.request.headers.authorization).toBe("Bearer client-placeholder");
    expect(raw?.request.headers["x-api-key"]).toBe("client-placeholder");
    expect(JSON.stringify(raw)).not.toContain("test-token");
  });

  test("请求体多字节字符跨 TCP 分块边界时，转发字节不被改写损坏", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url);
    const model = prefixedModel(fixture, "gpt-test");

    const body = Buffer.from(
      `{"model":"${model}","input":[{"role":"user","content":"评${"A".repeat(2048)}论持久化"}]}`,
    );
    const cut = body.indexOf(Buffer.from("论")) + 1;

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({hostname: "127.0.0.1", port: fixture.proxy.port}, () => {
        const head = [
          `POST /codex/v1/responses HTTP/1.1`,
          `Host: 127.0.0.1:${fixture.proxy.port}`,
          `Content-Type: application/json`,
          `Content-Length: ${body.length}`,
          `Connection: close`,
          ``,
          ``,
        ].join("\r\n");
        socket.write(head);
        socket.write(body.subarray(0, cut));
        setTimeout(() => {
          socket.write(body.subarray(cut));
          socket.end();
        }, 300);
      });
      let receivedHead = Buffer.alloc(0);
      socket.on("data", chunk => {
        receivedHead = Buffer.concat([receivedHead, chunk]);
        if (receivedHead.includes(Buffer.from("\r\n\r\n"))) resolve();
      });
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });

    await waitFor(() => upstream.hits.length === 1);
    const received = upstream.hits[0]!.body;
    expect(received.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(received.toString("utf8")).toBe(
      `{"model":"gpt-test","input":[{"role":"user","content":"评${"A".repeat(2048)}论持久化"}]}`,
    );
  });

  test.each([301, 302, 303, 307, 308])("returns HTTP %s without a second upstream request", async status => {
    const upstream = await startFixture((_request, response) => {
      response.writeHead(status, {location: "/redirected", "content-type": "text/plain"});
      response.end("redirect-body");
    });
    const fixture = await startProxyFixture(upstream.url);

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      redirect: "manual",
      body: JSON.stringify({model: prefixedModel(fixture, "gpt-test")}),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBe("/redirected");
    expect(await response.text()).toBe("redirect-body");
    expect(upstream.hits).toHaveLength(1);
  });

  test("streams SSE before completion and records the exact ordered body", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstBlock = sse("response.created", {type: "response.created"});
    const secondBlock = sse("response.completed", {type: "response.completed"});
    const upstream = await startFixture(async (_request, response) => {
      response.writeHead(200, {"content-type": "text/event-stream"});
      response.write(firstBlock);
      await gate;
      response.end(secondBlock);
    });
    const fixture = await startProxyFixture(upstream.url);

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {accept: "text/event-stream", "content-type": "application/json"},
      body: JSON.stringify({model: prefixedModel(fixture, "gpt-test"), stream: true}),
    });
    const reader = response.body!.getReader();
    const firstRead = await reader.read();
    expect(Buffer.from(firstRead.value!).toString()).toBe(firstBlock);
    release();
    const chunks = [Buffer.from(firstRead.value!)];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    expect(Buffer.concat(chunks).toString()).toBe(firstBlock + secondBlock);
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.response.rawBody).toBe(firstBlock + secondBlock);
    expect(raw?.response.isStreaming).toBe(true);
  });

  test("decodes unexpected gzip responses and removes stale representation headers", async () => {
    const body = JSON.stringify({message: "你好，世界"});
    const compressed = gzipSync(body);
    const upstream = await startFixture((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
      });
      response.end(compressed);
    });
    const fixture = await startProxyFixture(upstream.url);

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel(fixture, "gpt-test")}),
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe(body);
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.response.rawBody).toBe(body);
  });

  test("网关转发时保留未知 content encoding 与表示字节", async () => {
    const body = Buffer.from("custom-encoded-body");
    const upstream = await startFixture((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-encoding": "x-custom",
        "content-length": String(body.length),
      });
      response.end(body);
    });
    const fixture = await startProxyFixture(upstream.url);

    const requestBody = Buffer.from(JSON.stringify({model: prefixedModel(fixture, "gpt-test")}));
    const response = await rawRequest(fixture.proxy.port, {
      method: "POST",
      path: "/codex/v1/responses",
      headers: {"content-type": "application/json", "content-length": String(requestBody.length)},
      body: requestBody,
    });

    expect(response.headers["content-encoding"]).toBe("x-custom");
    expect(response.headers["content-length"]).toBe(String(body.length));
    expect(response.body).toEqual(body);
    expect(upstream.hits[0]?.body.toString()).toBe(JSON.stringify({model: "gpt-test"}));
  });

  test.each([204, 304])("forwards HTTP %s without manufacturing a response body", async status => {
    const upstream = await startFixture((_request, response) => {
      response.writeHead(status, {"x-status-fixture": String(status)});
      response.end();
    });
    const fixture = await startProxyFixture(upstream.url);

    const requestBody = Buffer.from(JSON.stringify({model: prefixedModel(fixture, "gpt-test")}));
    const response = await rawRequest(fixture.proxy.port, {
      method: "POST",
      path: "/codex/v1/responses",
      headers: {"content-type": "application/json", "content-length": String(requestBody.length)},
      body: requestBody,
    });

    expect(response.status).toBe(status);
    expect(response.headers["x-status-fixture"]).toBe(String(status));
    expect(response.body).toHaveLength(0);
  });

  test("非网关路径与非 POST 方法一律拒绝", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url);

    const headModels = await rawRequest(fixture.proxy.port, {method: "HEAD", path: "/v1/models", headers: {}});
    expect(headModels.status).toBe(404);
    const getResponses = await rawRequest(fixture.proxy.port, {method: "GET", path: "/codex/v1/responses", headers: {}});
    expect(getResponses.status).toBe(404);
    const custom = await rawRequest(fixture.proxy.port, {method: "POST", path: "/v1/custom", headers: {}});
    expect(custom.status).toBe(404);
    expect(upstream.hits).toHaveLength(0);
  });

  test("Expect: 100-continue 由代理立即确认并转发改写后的 body", async () => {
    const upstream = await startFixture(async (_request, response) => json(response, {ok: true}));
    const fixture = await startProxyFixture(upstream.url);
    const body = Buffer.from(JSON.stringify({model: prefixedModel(fixture, "gpt-test")}));

    const result = await expectContinueRequest(fixture.proxy.port, body);

    expect(result.continued).toBe(true);
    expect(result.status).toBe(200);
    expect(upstream.hits[0]?.body.toString()).toBe(JSON.stringify({model: "gpt-test"}));
  });

  test("returns stable 502 on connection failure and keeps serving later requests", async () => {
    const unused = await reserveUnusedPort();
    const fixture = await startProxyFixture(`http://127.0.0.1:${unused}`);

    const body = JSON.stringify({model: prefixedModel(fixture, "gpt-test")});
    const first = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body,
    });
    const second = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body,
    });

    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(await first.json()).toMatchObject({error: "Bad Gateway"});
  });

  test("does not wait for slow raw persistence before completing the client response", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-slow-capture-"));
    const realStore = new ProxyExchangeStore({dataDir});
    await realStore.init();
    let persisted = false;
    const store = {
      createBodyCollector: () => realStore.createBodyCollector(),
      async record(input: Parameters<ProxyExchangeStore["record"]>[0]) {
        await delay(200);
        persisted = true;
        return realStore.record(input);
      },
    };
    const config = await configFor(dataDir, upstream.url);
    await enableGatewayModels(config);
    const proxy = await startProxy(store, {
      hostname: "127.0.0.1",
      port: 0,
      configPath: config.getConfigPath(),
      credentialHelperPath: await credentialHelperPath(),
    });
    cleanups.push(() => proxy.close({force: true}));
    const startedAt = Date.now();

    const response = await fetch(`http://127.0.0.1:${proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel({config}, "gpt-test")}),
    });
    await response.text();

    expect(Date.now() - startedAt).toBeLessThan(180);
    expect(persisted).toBe(false);
    await waitFor(() => persisted);
  });

  test("graceful close waits for already accepted capture persistence", async () => {
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-drain-capture-"));
    const realStore = new ProxyExchangeStore({dataDir});
    await realStore.init();
    let persisted = false;
    let pendingRecord: Promise<unknown> | undefined;
    const store = {
      createBodyCollector: () => realStore.createBodyCollector(),
      record(input: Parameters<ProxyExchangeStore["record"]>[0]) {
        pendingRecord = (async () => {
          await delay(100);
          const result = await realStore.record(input);
          persisted = true;
          return result;
        })();
        return pendingRecord;
      },
      async drain() {
        await pendingRecord;
      },
    };
    const config = await configFor(dataDir, upstream.url);
    await enableGatewayModels(config);
    const proxy = await startProxy(store, {
      hostname: "127.0.0.1",
      port: 0,
      configPath: config.getConfigPath(),
      credentialHelperPath: await credentialHelperPath(),
    });
    const response = await fetch(`http://127.0.0.1:${proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel({config}, "gpt-test")}),
    });
    await response.text();

    expect(persisted).toBe(false);
    await proxy.close();

    expect(persisted).toBe(true);
    expect(await waitForRaw(dataDir, 1)).toHaveLength(1);
  });

  test("marks client-aborted streams and keeps the proxy process available", async () => {
    const upstream = await startFixture(async (_request, response) => {
      response.writeHead(200, {"content-type": "text/event-stream"});
      response.write(sse("response.created", {type: "response.created"}));
      await delay(100);
      if (!response.destroyed) response.end(sse("response.completed", {type: "response.completed"}));
    });
    const fixture = await startProxyFixture(upstream.url);

    const abortBody = JSON.stringify({model: prefixedModel(fixture, "gpt-test"), stream: true});
    await abortAfterText(fixture.proxy.port, "response.created", abortBody);
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.captureDiagnostics.map(item => item.code)).toContain("client_aborted");
    const followup = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel(fixture, "gpt-test")}),
    });
    expect(followup.status).toBe(200);
  });

  test("首字节前客户端中断不退休连接池条目：后续请求复用 keep-alive（2026-10-10 修复守卫）", async () => {
    let connections = 0;
    let served = 0;
    const upstream = createServer(async (request, response) => {
      served += 1;
      if (served === 1) {
        response.writeHead(200, {"content-type": "text/event-stream"});
        response.write(sse("response.created", {type: "response.created"}));
        await delay(400);
        if (!response.destroyed) response.end(sse("response.completed", {type: "response.completed"}));
        return;
      }
      try {
        await readRequest(request); // 等完整请求体：被中断的部分上传永远等不到，真实上游同款语义
      } catch {
        response.destroy();
        return;
      }
      json(response, {ok: true});
    });
    upstream.on("connection", () => { connections += 1; });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => {
      upstream.close(() => resolve());
      upstream.closeAllConnections?.();
    }));
    const upstreamPort = (upstream.address() as {port: number}).port;
    const fixture = await startProxyFixture(`http://127.0.0.1:${upstreamPort}`);

    // 请求 1：慢 SSE 在飞，占用 keep-alive 连接 A。
    const first = fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel(fixture, "gpt-test"), stream: true}),
    });
    await delay(120);

    // 请求 2：上传未完成即中断（首字节前）——若误退休池条目，请求 3 将走全新 TCP 连接。
    await abortMidBodyUpload(fixture.proxy.port, prefixedModel(fixture, "gpt-test"));
    await delay(80);

    // 请求 1 收尾后其连接回到空闲池，请求 3 应复用它（上游总 TCP 连接数 = 2）。
    const settled = await first;
    expect(settled.status).toBe(200);
    await settled.text();
    await delay(60);
    const followup = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel(fixture, "gpt-test")}),
    });
    expect(followup.status).toBe(200);
    await followup.text();
    expect(connections).toBe(2);
  });
});

async function startProxyFixture(
  upstreamUrl: string,
  targets?: Array<{
    id: string;
    name: string;
    openaiUrl?: string;
    anthropicUrl?: string;
    billingChannel?: "pay_as_you_go" | "plan" | "subscription";
    enabled: boolean;
    supportedModels?: string[];
    supportedModelScopes?: Record<string, string[]>;
    supportedModelWireApis?: Record<string, string[]>;
    development?: {defaultCredentials?: Partial<Record<"codex" | "claude" | "opencode" | "dsh", string>>};
  }>,
): Promise<{dataDir: string; proxy: NodeProxyServer; config: ProxyConfigStore}> {
  const dataDir = await mkdtemp(join(tmpdir(), "node-proxy-"));
  const config = await configFor(dataDir, upstreamUrl);
  if (targets) await config.updateConfig({targets: targets.map(target => ({
    id: target.id,
    name: target.name,
    ...(target.openaiUrl ? {openaiUrl: target.openaiUrl} : {}),
    ...(target.anthropicUrl ? {anthropicUrl: target.anthropicUrl} : {}),
    ...(target.billingChannel ? {billingChannel: target.billingChannel} : {}),
    enabled: target.enabled,
    supportedModels: target.supportedModels || [],
    supportedModelScopes: target.supportedModelScopes
      || Object.fromEntries((target.supportedModels || []).map(model => [model, ["codex", "claude", "opencode", "dsh"]])),
    supportedModelWireApis: target.supportedModelWireApis
      || Object.fromEntries((target.supportedModels || []).map(model => [model, ["responses", "chat_completions", "messages"]])),
    ...(target.development ? {development: target.development} : {}),
  }))});
  if (!targets) await enableGatewayModels(config);
  const store = new ProxyExchangeStore({dataDir});
  await store.init();
  const proxy = await startProxy(store, {
    hostname: "127.0.0.1",
    port: 0,
    configPath: config.getConfigPath(),
    credentialHelperPath: await credentialHelperPath(),
  });
  cleanups.push(() => proxy.close({force: true}));
  return {dataDir, proxy, config};
}

async function configFor(dataDir: string, upstreamUrl: string): Promise<ProxyConfigStore> {
  const config = new ProxyConfigStore({
    configPath: join(dataDir, "proxy-config.json"),
    developmentCredentialsPath: join(dataDir, "dev-credentials.json"),
    localProxyBaseUrl: "http://127.0.0.1:3211",
  });
  await config.init();
  const id = routeIdFromUpstreamUrl(upstreamUrl);
  await config.updateConfig({
    targets: [{
      id,
      name: "test-target",
      openaiUrl: upstreamUrl,
      enabled: true,
      supportedModels: [],
    }],
  });
  return config;
}

async function startFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<FixtureServer> {
  const hits: FixtureServer["hits"] = [];
  const server = createServer(async (request, response) => {
    const body = await readRequest(request);
    hits.push({method: request.method || "GET", url: request.url || "/", headers: request.headers, body});
    await handler(request, response);
  });
  return listenServer(server, hits);
}

async function listenServer(
  server: ReturnType<typeof createServer>,
  hits: FixtureServer["hits"],
): Promise<FixtureServer> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to listen");
  const close = async () => await new Promise<void>(resolve => server.close(() => resolve()));
  cleanups.push(close);
  return {url: `http://127.0.0.1:${address.port}`, hits, close};
}

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))});
  response.end(body);
}

async function postJson(port: number, path: string, value: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(value),
  });
  return await response.json() as Record<string, unknown>;
}

async function waitForRaw(dataDir: string, count: number): Promise<RawCapturedExchangeV2[]> {
  let result: RawCapturedExchangeV2[] = [];
  await waitFor(async () => {
    try {
      const directory = join(dataDir, "captures", "v2");
      const files = await readdir(directory);
      const contents = await Promise.all(files.map(file => readFile(join(directory, file), "utf8")));
      result = contents.flatMap(content => content.trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line)));
      return result.length >= count;
    } catch {
      return false;
    }
  });
  return result.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_TIMEOUT");
    await delay(10);
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function rawRequest(
  port: number,
  input: {method: string; path: string; headers: Record<string, string>; body?: Buffer},
): Promise<{status: number; statusMessage: string; headers: IncomingMessage["headers"]; body: Buffer}> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({hostname: "127.0.0.1", port, ...input}, response => {
      void readRequest(response).then(body => resolve({
        status: response.statusCode || 0,
        statusMessage: response.statusMessage || "",
        headers: response.headers,
        body,
      }), reject);
    });
    request.once("error", reject);
    request.end(input.body);
  });
}

async function expectContinueRequest(port: number, body: Buffer): Promise<{continued: boolean; status: number}> {
  return await new Promise((resolve, reject) => {
    let continued = false;
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: "/codex/v1/responses",
      headers: {expect: "100-continue", "content-length": String(body.length)},
    }, response => {
      response.resume();
      response.once("end", () => resolve({continued, status: response.statusCode || 0}));
    });
    request.once("continue", () => {
      continued = true;
      request.end(body);
    });
    request.once("error", reject);
    request.flushHeaders();
  });
}

async function reserveUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port reservation failed");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function abortAfterText(port: number, marker: string, body: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({host: "127.0.0.1", port});
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("stream marker timeout"));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write([
      "POST /codex/v1/responses HTTP/1.1",
      "Host: 127.0.0.1",
      "Accept: text/event-stream",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n")));
    socket.on("data", chunk => {
      received += chunk;
      if (!received.includes(marker)) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
    socket.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/** 首字节前中断：声明大 content-length 但只上传含 model 字段的部分请求体后销毁连接。 */
async function abortMidBodyUpload(port: number, model: string): Promise<void> {
  await new Promise<void>(resolve => {
    const socket = createConnection({host: "127.0.0.1", port});
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    };
    socket.once("connect", () => {
      socket.write([
        "POST /codex/v1/responses HTTP/1.1",
        "Host: 127.0.0.1",
        "content-type: application/json",
        "content-length: 4096",
        "",
        "",
      ].join("\r\n"));
      socket.write(`{"model":"${model}","stream":true,"pad":"`);
      setTimeout(finish, 60);
    });
    socket.once("error", finish);
    setTimeout(finish, 1_500);
  });
}

test("保存 round-trip 保留 supportedModelScopes 与 Agent 级默认密钥/模型", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "proxy-roundtrip-"));
  const config = await configFor(dataDir, "https://api.deepseek.com");
  const target = config.getConfig().targets![0]!;
  await config.updateConfig({
    targetPatch: {
      id: target.id,
      target: {
        supportedModels: ["deepseek-v4-flash", "kimi-k3"],
        supportedModelScopes: {"deepseek-v4-flash": ["codex"]},
        supportedModelWireApis: {"deepseek-v4-flash": ["responses"]},
        pricing: {rateMultiplier: 1, modelVendors: {
          "deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "deepseek/deepseek-v4-flash"},
          "kimi-k3": {vendor: "moonshot-cn", priceEntryId: "moonshot-cn/kimi-k3"},
        }},
        development: {
          defaultCredentials: {codex: "cred-a", claude: "cred-b"},
          defaultModels: {codex: "deepseek-v4-flash"},
        },
      },
    },
  });
  const saved = config.getConfig().targets![0]!;
  expect(saved.supportedModelScopes).toEqual({"deepseek-v4-flash": ["codex"]});
  expect(saved.development?.defaultCredentials).toEqual({codex: "cred-a", claude: "cred-b"});
  expect(saved.development?.defaultModels).toEqual({codex: "deepseek-v4-flash"});
  expect(saved.development).not.toHaveProperty("defaultCredentialId");
});

describe("订阅透传防御（2026-10-08 用户确认）", () => {
  async function subscriptionFixture(upstreamUrl: string): Promise<Awaited<ReturnType<typeof startProxyFixture>>> {
    return startProxyFixture(upstreamUrl, [{
      id: "chatgpt.com",
      name: "OpenAI 订阅",
      openaiUrl: upstreamUrl,
      billingChannel: "subscription",
      enabled: true,
      supportedModels: ["gpt-test"],
      supportedModelScopes: {"gpt-test": ["codex"]},
      supportedModelWireApis: {"gpt-test": ["responses"]},
    }]);
  }

  async function postWithAuthorization(
    port: number,
    path: string,
    body: unknown,
    authorization?: string,
  ): Promise<{status: number; payload: Record<string, unknown>}> {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? {authorization} : {}),
      },
      body: JSON.stringify(body),
    });
    return {status: response.status, payload: await response.json() as Record<string, unknown>};
  }

  test("占位 token 打到订阅透传目标：本地 401 SUBSCRIPTION_LOGIN_REQUIRED，不转发上游", async () => {
    const upstream = await startFixture((_request, response) => json(response, {source: "upstream"}));
    const fixture = await subscriptionFixture(upstream.url);
    const result = await postWithAuthorization(fixture.proxy.port, "/codex/v1/responses", {
      model: buildGatewayModelId("chatgpt.com", "gpt-test"),
    }, "Bearer deepaa-gateway");
    expect(result.status).toBe(401);
    expect(result.payload.error).toBe("SUBSCRIPTION_LOGIN_REQUIRED");
    expect(typeof result.payload.message).toBe("string");
    // 上游零命中：防御在本地短路，绝不转发必然失败的请求。
    expect(upstream.hits).toHaveLength(0);
  });

  test("缺失 Authorization 同样触发防御；真实 OAuth 照常透传到上游", async () => {
    const upstream = await startFixture((request, response) => json(response, {
      source: "upstream",
      authorization: request.headers.authorization,
    }));
    const fixture = await subscriptionFixture(upstream.url);

    const missing = await postWithAuthorization(fixture.proxy.port, "/codex/v1/responses", {
      model: buildGatewayModelId("chatgpt.com", "gpt-test"),
    });
    expect(missing.status).toBe(401);
    expect(missing.payload.error).toBe("SUBSCRIPTION_LOGIN_REQUIRED");

    const passthrough = await postWithAuthorization(fixture.proxy.port, "/codex/v1/responses", {
      model: buildGatewayModelId("chatgpt.com", "gpt-test"),
    }, "Bearer real-oauth-token");
    expect(passthrough.status).toBe(200);
    expect(passthrough.payload).toMatchObject({
      source: "upstream",
      authorization: "Bearer real-oauth-token",
    });
    expect(upstream.hits).toHaveLength(1);
  });

  test("非订阅目标（inject）不受防御影响：占位 token 被替换为系统凭据", async () => {
    const upstream = await startFixture((request, response) => json(response, {
      authorization: request.headers.authorization,
    }));
    const fixture = await startProxyFixture(upstream.url, [{
      id: "relay.example",
      name: "中转站",
      openaiUrl: upstream.url,
      enabled: true,
      supportedModels: ["gpt-test"],
      supportedModelScopes: {"gpt-test": ["codex"]},
      supportedModelWireApis: {"gpt-test": ["responses"]},
      development: {defaultCredentials: {codex: "test-cred"}},
    }]);
    const result = await postWithAuthorization(fixture.proxy.port, "/codex/v1/responses", {
      model: buildGatewayModelId("relay.example", "gpt-test"),
    }, "Bearer deepaa-gateway");
    expect(result.status).toBe(200);
    expect(result.payload.authorization).toBe("Bearer test-token");
  });
});
