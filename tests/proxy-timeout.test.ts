import {buildGatewayModelId} from "../src/proxy/gateway-prefix.js";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {chmod, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {afterEach, describe, expect, test} from "vitest";
import {ProxyConfigStore, routeIdFromUpstreamUrl} from "../src/proxy-config.js";
import {startProxy, type NodeProxyServer} from "../src/reverse-proxy.js";
import {ProxyExchangeStore} from "../src/proxy/exchange-store.js";

interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

interface ProxyFixture {
  dataDir: string;
  proxy: NodeProxyServer;
  config: ProxyConfigStore;
}

const cleanups: Array<() => Promise<void>> = [];
let sharedEchoHelperPath: string | undefined;

async function credentialHelperPath(): Promise<string> {
  if (sharedEchoHelperPath) return sharedEchoHelperPath;
  const root = await mkdtemp(join(tmpdir(), "proxy-timeout-helper-"));
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

function prefixedModel(config: ProxyConfigStore, modelId: string): string {
  const targetId = config.getConfig().targets?.[0]?.id;
  if (!targetId) throw new Error("fixture target missing");
  return buildGatewayModelId(targetId, modelId);
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()));
});

describe("Node 代理上游超时兜底", () => {
  test("响应头绝对超时：上游挂起不响应时，代理在限定时间内以 502 兜底返回", async () => {
    const upstream = await startFixture((_request, _response) => {
      // 永不响应，也不关闭连接
    });
    const fixture = await startProxyFixture(upstream.url, {
      upstreamHeaderTimeoutMs: 250,
    });

    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel(fixture.config, "gpt-test")}),
    });
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({error: "Bad Gateway"});
    expect(elapsed).toBeLessThan(2_000);
  });

  test("响应体空闲超时：上游返回响应头后不发数据，客户端流会被断开", async () => {
    const upstream = await startFixture((_request, response) => {
      response.writeHead(200, {"content-type": "text/event-stream"});
      // 先写一个字节让代理把响应头与首块数据转发给客户端，之后不再写数据
      response.write("x");
    });
    const fixture = await startProxyFixture(upstream.url, {
      responseIdleTimeoutMs: 250,
      responseTotalTimeoutMs: 10_000,
    });

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel(fixture.config, "gpt-test")}),
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const startedAt = Date.now();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe("x");
    await expect(reader.read()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("非流式响应总时长上限：上游持续写入但迟迟不结束，也会在限定时间内断开", async () => {
    const upstream = await startFixture(async (_request, response) => {
      response.writeHead(200, {"content-type": "application/json"});
      const interval = setInterval(() => {
        response.write(`{"chunk":${Date.now()}}\n`);
      }, 50);
      response.once("close", () => clearInterval(interval));
    });
    const fixture = await startProxyFixture(upstream.url, {
      responseIdleTimeoutMs: 10_000,
      responseTotalTimeoutMs: 300,
    });

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      body: JSON.stringify({model: prefixedModel(fixture.config, "gpt-test")}),
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const startedAt = Date.now();
    let sawData = false;
    await expect((async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        if (next.value && next.value.byteLength > 0) sawData = true;
      }
    })()).rejects.toThrow();
    expect(sawData).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

async function startProxyFixture(
  upstreamUrl: string,
  timeouts: {
    upstreamHeaderTimeoutMs?: number;
    responseIdleTimeoutMs?: number;
    responseTotalTimeoutMs?: number;
  },
): Promise<ProxyFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "proxy-timeout-"));
  const config = new ProxyConfigStore({
    configPath: join(dataDir, "proxy-config.json"),
    localProxyBaseUrl: "http://127.0.0.1:3211",
  });
  await config.init();
  const currentTargetId = routeIdFromUpstreamUrl(upstreamUrl);
  await config.updateConfig({
    targets: [{
      id: currentTargetId,
      name: "test-target",
      openaiUrl: upstreamUrl,
      enabled: true,
      supportedModels: [],
    }],
  });
  await config.updateConfig({
    targetPatch: {
      id: currentTargetId,
      target: {
        supportedModels: ["gpt-test"],
        supportedModelScopes: {"gpt-test": ["codex", "claude", "opencode", "dsh"]},
        supportedModelWireApis: {"gpt-test": ["responses", "chat_completions", "messages"]},
        development: {defaultCredentials: {codex: "test-cred"}},
      },
    },
  });
  const store = new ProxyExchangeStore({dataDir});
  await store.init();
  const proxy = await startProxy(store, {
    hostname: "127.0.0.1",
    port: 0,
    configPath: config.getConfigPath(),
    credentialHelperPath: await credentialHelperPath(),
    ...timeouts,
  });
  cleanups.push(() => proxy.close({force: true}));
  return {dataDir, proxy, config};
}

async function startFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* 消费请求体 */ }
      await handler(request, response);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", resolve);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to listen");
  const close = async () => await new Promise<void>(resolve => server.close(() => resolve()));
  cleanups.push(close);
  return {url: `http://127.0.0.1:${address.port}`, close};
}
