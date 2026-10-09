import {createServer, type Server} from "node:http";
import https from "node:https";
import net from "node:net";
import {mkdtemp} from "node:fs/promises";
import {execFile} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {afterEach, describe, expect, test} from "vitest";
import {
  OFFICIAL_UPSTREAM_HOSTS,
  isOfficialUpstreamHost,
  isPlaceholderAuthorization,
  parseScutilProxy,
  parseUpstreamProxyEnv,
  PROXY_BUNDLE_PLACEHOLDER_TOKEN,
  resetOfficialUpstreamProxyCacheForTests,
  resolveOfficialUpstreamProxy,
  setOfficialUpstreamProxyForTests,
} from "../src/proxy/official-upstream.js";
import {createConnectTunnelHttpsAgent} from "../src/proxy/upstream-proxy.js";
import {UpstreamAgentPool} from "../src/proxy/upstream-transport.js";
import {GATEWAY_PLACEHOLDER_TOKEN} from "../src/lib/config-sync/core/placeholder-auth.js";

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  delete process.env.DEEPAA_UPSTREAM_PROXY;
  resetOfficialUpstreamProxyCacheForTests();
  await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()));
});

describe("官方上游白名单", () => {
  test("白名单包含五个官方域（含 api.openai.com，2026-10-08 用户确认）", () => {
    expect([...OFFICIAL_UPSTREAM_HOSTS]).toEqual([
      "chatgpt.com",
      "api.anthropic.com",
      "api.openai.com",
      "openrouter.ai",
      "opencode.ai",
    ]);
  });

  test("精确与子域命中；中转站/本地域绝不命中", () => {
    expect(isOfficialUpstreamHost("chatgpt.com")).toBe(true);
    expect(isOfficialUpstreamHost("api.anthropic.com")).toBe(true);
    expect(isOfficialUpstreamHost("cdn.chatgpt.com")).toBe(true);
    expect(isOfficialUpstreamHost("relay.auto-code.net")).toBe(false);
    expect(isOfficialUpstreamHost("bigmodel.cn")).toBe(false);
    expect(isOfficialUpstreamHost("127.0.0.1")).toBe(false);
    expect(isOfficialUpstreamHost("notchatgpt.com.evil.example")).toBe(false);
  });
});

describe("代理解析", () => {
  test("显式 env：完整 URL 与裸 host:port 均可解析；https 代理与非法端口拒绝", () => {
    expect(parseUpstreamProxyEnv("http://127.0.0.1:7994")).toEqual({host: "127.0.0.1", port: 7994});
    expect(parseUpstreamProxyEnv("127.0.0.1:7994")).toEqual({host: "127.0.0.1", port: 7994});
    expect(parseUpstreamProxyEnv("socks5://127.0.0.1:1080")).toBeUndefined();
    expect(parseUpstreamProxyEnv("http://127.0.0.1:notaport")).toBeUndefined();
    expect(parseUpstreamProxyEnv("  ")).toBeUndefined();
  });

  test("scutil 输出：HTTPS 代理优先，未启用时回落 HTTP，均未启用返回 undefined", () => {
    expect(parseScutilProxy([
      "HTTPEnable : 1",
      "HTTPProxy : 127.0.0.1",
      "HTTPPort : 7000",
      "HTTPSEnable : 1",
      "HTTPSProxy : 127.0.0.1",
      "HTTPSPort : 7994",
    ].join("\n"))).toEqual({host: "127.0.0.1", port: 7994});
    expect(parseScutilProxy([
      "HTTPEnable : 1",
      "HTTPProxy : 127.0.0.1",
      "HTTPPort : 7000",
      "HTTPSEnable : 0",
    ].join("\n"))).toEqual({host: "127.0.0.1", port: 7000});
    expect(parseScutilProxy("HTTPEnable : 0\nHTTPSEnable : 0")).toBeUndefined();
  });

  test("resolveOfficialUpstreamProxy：非白名单域零开销直连；env 优先", async () => {
    process.env.DEEPAA_UPSTREAM_PROXY = "http://127.0.0.1:7994";
    expect(await resolveOfficialUpstreamProxy("relay.example.com")).toBeUndefined();
    expect(await resolveOfficialUpstreamProxy("chatgpt.com")).toEqual({host: "127.0.0.1", port: 7994});
  });
});

describe("占位 token 镜像与判定", () => {
  test("代理 bundle 镜像与 config-sync 单一事实源锁定一致", () => {
    expect(PROXY_BUNDLE_PLACEHOLDER_TOKEN).toBe(GATEWAY_PLACEHOLDER_TOKEN);
  });

  test("缺失/空白/占位形态命中；真实 OAuth 不命中", () => {
    expect(isPlaceholderAuthorization(undefined)).toBe(true);
    expect(isPlaceholderAuthorization("")).toBe(true);
    expect(isPlaceholderAuthorization(`Bearer ${GATEWAY_PLACEHOLDER_TOKEN}`)).toBe(true);
    expect(isPlaceholderAuthorization("Bearer eyJhbGciOi.real-oauth.token")).toBe(false);
  });
});

describe("UpstreamAgentPool 影响隔离", () => {
  test("白名单 https 上游使用隧道 Agent；其余目标与无代理时保持直连 Agent", async () => {
    process.env.DEEPAA_UPSTREAM_PROXY = "http://127.0.0.1:7994";
    setOfficialUpstreamProxyForTests(undefined);
    const pool = new UpstreamAgentPool();
    const tunnelLease = await pool.acquire(new URL("https://chatgpt.com/backend-api/codex/responses"));
    // 隧道 Agent 在实例上覆写 createConnection（工厂实现）；直连 Agent 只保留原型方法。
    expect(Object.prototype.hasOwnProperty.call(tunnelLease.agent, "createConnection")).toBe(true);
    tunnelLease.release();

    const directLease = await pool.acquire(new URL("https://relay.auto-code.net/v1/responses"));
    expect(Object.prototype.hasOwnProperty.call(directLease.agent, "createConnection")).toBe(false);
    directLease.release();
    pool.close();

    // 无代理（env 清空 + 缓存注入 undefined）：白名单域同样走直连。
    delete process.env.DEEPAA_UPSTREAM_PROXY;
    setOfficialUpstreamProxyForTests(undefined);
    const noProxyPool = new UpstreamAgentPool();
    const noProxyLease = await noProxyPool.acquire(new URL("https://chatgpt.com/backend-api/codex/responses"));
    expect(Object.prototype.hasOwnProperty.call(noProxyLease.agent, "createConnection")).toBe(false);
    noProxyLease.release();
    noProxyPool.close();
  });

  test("非法 env 代理值回退直连（不因配置错误阻断网关）", async () => {
    process.env.DEEPAA_UPSTREAM_PROXY = "socks5://bad";
    setOfficialUpstreamProxyForTests(undefined);
    const pool = new UpstreamAgentPool();
    const lease = await pool.acquire(new URL("https://chatgpt.com/backend-api/codex/responses"));
    expect(Object.prototype.hasOwnProperty.call(lease.agent, "createConnection")).toBe(false);
    lease.release();
    pool.close();
  });
});

describe("CONNECT 隧道 Agent", () => {
  test("代理拒绝 CONNECT 时返回稳定错误码，且 CONNECT 目标正确送达代理", async () => {
    const connectTargets: string[] = [];
    const proxyServer = await startTestProxy((requestUrl, socket) => {
      connectTargets.push(requestUrl);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    const agent = createConnectTunnelHttpsAgent({host: "127.0.0.1", port: proxyServer.port});
    await expect(requestViaAgent("https://chatgpt.com/backend-api/wham/usage", agent))
      .rejects.toThrow(/UPSTREAM_PROXY_TUNNEL_DENIED/u);
    expect(connectTargets).toEqual(["chatgpt.com:443"]);
  });

  test("端到端：经隧道完成 TLS 请求并取回响应体（openssl 不可用时跳过）", async context => {
    const cert = await generateSelfSignedCert().catch(() => undefined);
    if (!cert) return context.skip("openssl 不可用，跳过端到端 TLS 隧道用例");
    const tlsServer = https.createServer({key: cert.key, cert: cert.cert}, (request, response) => {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({via: "tunnel"}));
    });
    await new Promise<void>(resolve => tlsServer.listen(0, "127.0.0.1", resolve));
    const tlsPort = (tlsServer.address() as {port: number}).port;
    cleanups.push(() => closeServerForcibly(tlsServer));

    const proxyServer = await startTestProxy((requestUrl, socket, head) => {
      const [host, port] = requestUrl.split(":");
      const upstream = net.connect(Number(port), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      socket.once("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("error", () => socket.destroy());
      upstream.once("close", () => socket.destroy());
    });
    const agent = createConnectTunnelHttpsAgent(
      {host: "127.0.0.1", port: proxyServer.port},
      {keepAlive: false},
      {rejectUnauthorized: false},
    );
    const response = await requestViaAgent(`https://127.0.0.1:${String(tlsPort)}/usage`, agent);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({via: "tunnel"});
  });
});

function requestViaAgent(url: string, agent: https.Agent, timeoutMs = 8_000): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(new URL(url), {method: "GET", agent}, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {status: response.statusCode ?? 502}));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("TUNNEL_TEST_RESPONSE_TIMEOUT")));
    request.once("error", reject);
    request.end();
  });
}

interface TestProxy {
  port: number;
  server: Server;
}

function startTestProxy(
  onConnect: (requestUrl: string, socket: net.Socket, head: Buffer) => void,
): Promise<TestProxy> {
  const server = createServer();
  // CONNECT 升级后的 socket 不在 Node 服务的内部连接表里（closeAllConnections
  // 管不到），清理时必须自行追踪销毁，否则 server.close() 回调永不触发。
  const connectSockets = new Set<net.Socket>();
  server.on("connect", (request, socket, head) => {
    connectSockets.add(socket);
    socket.once("close", () => connectSockets.delete(socket));
    onConnect(String(request.url ?? ""), socket, head);
  });
  return new Promise<TestProxy>(resolve => {
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => closeServerForcibly(server, connectSockets));
      resolve({port: (server.address() as {port: number}).port, server});
    });
  });
}

/**
 * close + closeAllConnections + CONNECT socket 追踪销毁：隧道路径的管道 socket
 * 在响应结束后可能滞留半开连接，仅 close() 的回调永不触发（实测 afterEach 钩子
 * 30s 超时根因）。
 */
function closeServerForcibly(server: Server, extraSockets?: Set<net.Socket>): Promise<void> {
  return new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
    for (const socket of extraSockets ?? []) socket.destroy();
  });
}

async function generateSelfSignedCert(): Promise<{key: string; cert: string}> {
  const dir = await mkdtemp(join(tmpdir(), "tunnel-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  await execFileAsync("/usr/bin/openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1",
    "-subj", "/CN=localhost",
  ]);
  const {readFile} = await import("node:fs/promises");
  return {key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8")};
}
