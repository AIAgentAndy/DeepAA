import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {chmod, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {afterEach, describe, expect, test} from "vitest";
import {ProxyConfigStore} from "../src/proxy-config.js";
import {startProxy, type NodeProxyServer} from "../src/reverse-proxy.js";
import {buildGatewayModelId} from "../src/proxy/gateway-prefix.js";
import {ProxyExchangeStore} from "../src/proxy/exchange-store.js";
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
  const root = await mkdtemp(join(tmpdir(), "failover-credential-helper-"));
  const path = join(root, "echo-token.sh");
  await writeFile(path, "#!/bin/sh\nprintf 'test-token\\n'\n", "utf8");
  await chmod(path, 0o755);
  sharedEchoHelperPath = path;
  return path;
}

interface FailoverTargetFixture {
  id: string;
  url: string;
  anthropicUrl?: string;
  models: string[];
  billingChannel?: "pay_as_you_go" | "plan" | "subscription";
}

interface FailoverProxyOptions {
  failoverAttemptHeaderTimeoutMs?: number;
  failoverChainBudgetMs?: number;
}

async function startFailoverFixture(
  targets: FailoverTargetFixture[],
  fallbacksByTarget: Record<string, Record<string, string[]>>,
  proxyOptions: FailoverProxyOptions = {},
): Promise<{dataDir: string; proxy: NodeProxyServer; config: ProxyConfigStore}> {
  const dataDir = await mkdtemp(join(tmpdir(), "proxy-failover-"));
  const config = new ProxyConfigStore({
    configPath: join(dataDir, "proxy-config.json"),
    developmentCredentialsPath: join(dataDir, "dev-credentials.json"),
    localProxyBaseUrl: "http://127.0.0.1:3211",
  });
  await config.init();
  await config.updateConfig({
    targets: targets.map(target => ({
      id: target.id,
      name: target.id,
      openaiUrl: target.url,
      ...(target.anthropicUrl ? {anthropicUrl: target.anthropicUrl} : {}),
      ...(target.billingChannel ? {billingChannel: target.billingChannel} : {}),
      enabled: true,
      supportedModels: target.models,
      supportedModelScopes: Object.fromEntries(target.models.map(model => [model, ["codex", "claude", "opencode", "dsh"]])),
      supportedModelWireApis: Object.fromEntries(target.models.map(model => [model, ["responses", "chat_completions", "messages"]])),
      development: {defaultCredentials: {
        codex: "test-cred",
        claude: "test-cred",
        opencode: "test-cred",
        dsh: "test-cred",
      }},
    })),
  });
  // 备份链单独补丁写入（与 UI 保存路径同字段；服务端校验同步生效）。
  for (const [targetId, chain] of Object.entries(fallbacksByTarget)) {
    await config.updateConfig({targetPatch: {id: targetId, target: {supportedModelFallbacks: chain}}});
  }
  const store = new ProxyExchangeStore({dataDir});
  await store.init();
  const proxy = await startProxy(store, {
    hostname: "127.0.0.1",
    port: 0,
    configPath: config.getConfigPath(),
    credentialHelperPath: await credentialHelperPath(),
    ...(proxyOptions.failoverAttemptHeaderTimeoutMs !== undefined
      ? {failoverAttemptHeaderTimeoutMs: proxyOptions.failoverAttemptHeaderTimeoutMs} : {}),
    ...(proxyOptions.failoverChainBudgetMs !== undefined
      ? {failoverChainBudgetMs: proxyOptions.failoverChainBudgetMs} : {}),
  });
  cleanups.push(() => proxy.close({force: true}));
  return {dataDir, proxy, config};
}

async function startFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  options: {readBody?: boolean} = {},
): Promise<FixtureServer> {
  const hits: FixtureServer["hits"] = [];
  const readBody = options.readBody !== false;
  const server = createServer(async (request, response) => {
    if (readBody) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      hits.push({
        method: request.method || "GET",
        url: request.url || "/",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
    } else {
      hits.push({
        method: request.method || "GET",
        url: request.url || "/",
        headers: request.headers,
        body: Buffer.alloc(0),
      });
    }
    await handler(request, response);
  });
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

function json(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))});
  response.end(body);
}

function statusJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))});
  response.end(body);
}

async function postModel(port: number, gatewayModel: string, extraBody: Record<string, unknown> = {}, headers: Record<string, string> = {"content-type": "application/json"}): Promise<{status: number; body: string}> {
  const response = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({model: gatewayModel, ...extraBody}),
  });
  return {status: response.status, body: await response.text()};
}

async function waitForRaw(dataDir: string, count: number): Promise<RawCapturedExchangeV2[]> {
  let result: RawCapturedExchangeV2[] = [];
  const deadline = Date.now() + 3_000;
  while (result.length < count && Date.now() < deadline) {
    try {
      const directory = join(dataDir, "captures", "v2");
      const files = await readdir(directory);
      const contents = await Promise.all(files.map(file => readFile(join(directory, file), "utf8")));
      result = contents.flatMap(content => content.trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    } catch {
      // 目录未创建时继续等待。
    }
    if (result.length < count) await delay(10);
  }
  return result.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_TIMEOUT");
    await delay(10);
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("模型故障转移（跨目标候选）", () => {
  test("故障转移候选按 messages wire 同步重建鉴权头（authorization + x-api-key 双头）", async () => {
    let primaryCalls = 0;
    const primary = await startFixture((_request, response) => {
      primaryCalls += 1;
      statusJson(response, 502, {error: "upstream broken"});
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const primaryModel = "claude-test";
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, anthropicUrl: primary.url, models: [primaryModel]},
        {id: "backup.example", url: backup.url, anthropicUrl: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {[primaryModel]: [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/claude/v1/messages`, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: "Bearer client-placeholder"},
      body: JSON.stringify({model: buildGatewayModelId("primary.example", primaryModel), max_tokens: 16}),
    });
    expect(response.status).toBe(200);
    await waitFor(() => backup.hits.length > 0);
    // 候选目标重建的请求头：注入凭据双头携带（messages wire），客户端占位被替换。
    expect(backup.hits[0]?.headers.authorization).toBe("Bearer test-token");
    expect(backup.hits[0]?.headers["x-api-key"]).toBe("test-token");
    expect(primaryCalls).toBe(2);
  });

  test("主模型单请求内两连败即转移并锁定：失败尝试逐条落盘可见", async () => {
    let primaryCalls = 0;
    const primary = await startFixture((_request, response) => {
      primaryCalls += 1;
      statusJson(response, 502, {error: "upstream broken"});
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const primaryModel = "gpt-test";
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: [primaryModel]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {[primaryModel]: [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const gatewayModel = buildGatewayModelId("primary.example", primaryModel);
    // 第一次请求：主模型两连败（锚点重试）→ 立即转移备份并锁定降级。
    const first = await postModel(fixture.proxy.port, gatewayModel);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({source: "backup"});
    expect(primaryCalls).toBe(2);
    // 第二次请求：直达粘性备份，主模型不再被尝试。
    const second = await postModel(fixture.proxy.port, gatewayModel);
    expect(second.status).toBe(200);
    expect(primaryCalls).toBe(2);

    expect(primary.hits).toHaveLength(2);
    expect(backup.hits).toHaveLength(2);
    // 备份收到的请求体：model 已改写为备份模型，其余字节一致。
    expect(backup.hits[0]?.body.toString()).toBe(JSON.stringify({model: "bm-backup"}));

    // 两次请求共落盘 4 条：请求 1 = 2 条主模型失败 + 1 条备份成功；请求 2 = 1 条粘性备份直达。
    // 不能等 3 条就断言长度——负载下批量落盘时请求 2 的记录可能已同时刷出（真实复现过）。
    const records = await waitForRaw(fixture.dataDir, 4);
    expect(records).toHaveLength(4);
    const [fail1, fail2, served] = records!;
    expect(fail1?.routing.targetId).toBe("primary.example");
    expect(fail1?.response.status).toBe(502);
    expect(JSON.parse(fail1?.response.rawBody ?? "{}")).toMatchObject({error: "upstream broken"});
    // 健康态主模型失败尝试不写 failover 字段（未发生转移的纯失败记录）。
    expect(fail1?.routing.failover).toBeUndefined();
    expect(fail2?.response.status).toBe(502);
    expect(fail2?.routing.failover).toBeUndefined();
    expect(served?.routing.targetId).toBe("backup.example");
    expect(served?.routing.requestedModel).toBe(gatewayModel);
    expect(served?.routing.failover).toMatchObject({
      trigger: "consecutive_failures",
      fromTargetId: "primary.example",
      fromTargetName: "primary.example",
      fromModel: primaryModel,
      toTargetId: "backup.example",
      toTargetName: "backup.example",
      toModel: "bm-backup",
      retryCount: 3,
    });
    expect(served?.routing.failover?.attempts).toEqual([
      {targetId: "primary.example", model: primaryModel, outcome: "error", detail: "HTTP 502"},
      {targetId: "primary.example", model: primaryModel, outcome: "error", detail: "HTTP 502"},
      {targetId: "backup.example", model: "bm-backup", outcome: "served"},
    ]);
  });

  test("锚点抖动恢复：主模型失败一次后重试成功，不锁定、成功记录无 failover 字段", async () => {
    let primaryCalls = 0;
    const primary = await startFixture((_request, response) => {
      primaryCalls += 1;
      if (primaryCalls === 1) {
        statusJson(response, 502, {error: "transient"});
        return;
      }
      json(response, {source: "primary"});
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");

    const first = await postModel(fixture.proxy.port, gatewayModel);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({source: "primary"});
    expect(primaryCalls).toBe(2);
    expect(backup.hits).toHaveLength(0);

    // 后续请求仍先试主模型（未锁定）。
    const second = await postModel(fixture.proxy.port, gatewayModel);
    expect(JSON.parse(second.body)).toMatchObject({source: "primary"});
    expect(primaryCalls).toBe(3);

    // 2 条记录：1 条失败尝试（healthy 无转移，纯失败记录）+ 1 条主模型成功（无 failover 字段）。
    const records = await waitForRaw(fixture.dataDir, 2);
    expect(records[0]?.routing.targetId).toBe("primary.example");
    expect(records[0]?.response.status).toBe(502);
    expect(records[0]?.routing.failover).toBeUndefined();
    expect(records[1]?.response.status).toBe(200);
    expect(records[1]?.routing.failover).toBeUndefined();
  });

  test("优先级 3 的备份在单请求内可达（全链即时顺延，失败逐条落盘）", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 502, {error: "primary down"}));
    const backup1 = await startFixture((_request, response) => statusJson(response, 503, {error: "backup1 down"}));
    const backup2 = await startFixture((_request, response) => statusJson(response, 429, {error: "backup2 down"}));
    const backup3 = await startFixture((_request, response) => json(response, {source: "backup3"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "b1.example", url: backup1.url, models: ["bm1"]},
        {id: "b2.example", url: backup2.url, models: ["bm2"]},
        {id: "b3.example", url: backup3.url, models: ["bm3"]},
      ],
      {"primary.example": {"gpt-test": [
        buildGatewayModelId("b1.example", "bm1"),
        buildGatewayModelId("b2.example", "bm2"),
        buildGatewayModelId("b3.example", "bm3"),
      ]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const response = await postModel(fixture.proxy.port, buildGatewayModelId("primary.example", "gpt-test"));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({source: "backup3"});
    expect(primary.hits).toHaveLength(2);
    expect(backup1.hits).toHaveLength(1);
    expect(backup2.hits).toHaveLength(1);
    expect(backup3.hits).toHaveLength(1);

    const records = await waitForRaw(fixture.dataDir, 5);
    expect(records).toHaveLength(5);
    const served = records.find(record => record.routing.targetId === "b3.example");
    expect(served?.routing.failover).toMatchObject({
      trigger: "consecutive_failures",
      toTargetId: "b3.example",
      toModel: "bm3",
      retryCount: 5,
    });
    expect(served?.routing.failover?.attempts).toHaveLength(5);
    // 失败记录归属各自被尝试的目标（用户可见真实失败请求）。
    expect(records.filter(record => record.routing.targetId === "primary.example")).toHaveLength(2);
    expect(records.find(record => record.routing.targetId === "b2.example")?.response.status).toBe(429);
  });

  test("上游未读完请求体即返回 503：立即换候选、客户端无感、代理进程稳定（P0 生命周期）", async () => {
    // fixture 不读请求体直接回 503，复现「上游提前返回」真实时序。
    const primary = await startFixture((_request, response) => {
      statusJson(response, 503, {error: "early reject"});
    }, {readBody: false});
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");
    for (let round = 0; round < 3; round += 1) {
      const response = await postModel(fixture.proxy.port, gatewayModel, {payload: `round-${round}-data`.repeat(200)});
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({source: "backup"});
    }
    // 连续多轮后代理仍稳定服务（旧尝试未残留干扰）。
    expect(backup.hits).toHaveLength(3);
    expect(backup.hits.every(hit => JSON.parse(hit.body.toString()).model === "bm-backup")).toBe(true);
  });

  test("客户端中断不计失败：主模型挂起时中断，下一请求仍先试主模型且未降级", async () => {
    let primaryCalls = 0;
    const primary = await startFixture((_request, response) => {
      primaryCalls += 1;
      if (primaryCalls === 1) {
        // 首个请求挂起不回（模拟主模型挂死），等待客户端放弃。
        return;
      }
      json(response, {source: "primary"});
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await expect(fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: gatewayModel}),
      signal: controller.signal,
    })).rejects.toThrow();

    // 中断不降级：下一请求仍先试主模型（此刻恢复 200）并成功服务。
    const followup = await postModel(fixture.proxy.port, gatewayModel);
    expect(followup.status).toBe(200);
    expect(JSON.parse(followup.body)).toMatchObject({source: "primary"});
    expect(backup.hits).toHaveLength(0);
    expect(primaryCalls).toBe(2);
  });

  test("兜底链候选全部不可路由时退回直连，直连必须改写为真实模型 ID（2026-10-06 dsh responses 404 事故回归）", async () => {
    // 复现链路：模型配了兜底链（peek 保留原始复合模型字节等待按候选改写），
    // 但候选对本次请求的 Agent/协议路径全部不可路由（scope 不含该 Agent）→
    // 故障转移计划落空退回直连路径。修复前：复合模型名原样到达上游触发
    // model_not_found；修复后：直连按主决策模型改写。
    const upstream = await startFixture((_request, response) => json(response, {ok: true}));
    const backupUpstream = await startFixture((_request, response) => json(response, {ok: true}));
    const fixture = await startFailoverFixture(
      [
        {id: "catapi.example", url: upstream.url, models: ["gpt-real"]},
        // 候选目标：模型存在，但 scope 不含 dsh（构造候选不可路由）。
        {id: "backup.example", url: backupUpstream.url, models: ["gpt-real"]},
      ],
      {"catapi.example": {"gpt-real": [buildGatewayModelId("backup.example", "gpt-real")]}},
    );
    {
      const config = fixture.config.getConfig();
      const backup = config.targets.find(target => target.id === "backup.example")!;
      await fixture.config.updateConfig({targets: config.targets.map(target =>
        target.id === "backup.example"
          ? {...target, supportedModelScopes: {"gpt-real": ["codex"]}}
          : target)});
      void backup;
    }
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/dsh/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({model: buildGatewayModelId("catapi.example", "gpt-real"), input: "hi"}),
    });
    expect(response.status).toBe(200);
    await waitFor(() => upstream.hits.length === 1);
    // 转发体必须是真实模型 ID，绝不能是复合名（上游会报 model_not_found）。
    const forwarded = JSON.parse(upstream.hits[0]!.body.toString("utf8")) as {model: string};
    expect(forwarded.model).toBe("gpt-real");
    expect(forwarded.model).not.toContain("_catapi.example");
  });

  test("备份 4xx：候选视为不可用，顺延下一候选并进入冷却（区别于主模型 4xx 提交）", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 502, {error: "primary down"}));
    const backup1 = await startFixture((_request, response) => statusJson(response, 401, {error: "bad backup key"}));
    const backup2 = await startFixture((_request, response) => json(response, {source: "backup2"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "b1.example", url: backup1.url, models: ["bm1"]},
        {id: "b2.example", url: backup2.url, models: ["bm2"]},
      ],
      {"primary.example": {"gpt-test": [
        buildGatewayModelId("b1.example", "bm1"),
        buildGatewayModelId("b2.example", "bm2"),
      ]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");

    // 请求 1：主模型两连败 → 备份1 返回 401（候选不可用，不阻断）→ 顺延备份2 成功服务。
    const first = await postModel(fixture.proxy.port, gatewayModel);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({source: "backup2"});
    expect(backup1.hits).toHaveLength(1);
    expect(backup2.hits).toHaveLength(1);

    // 请求 2：备份1 在冷却中被跳过，直达粘性备份2。
    const second = await postModel(fixture.proxy.port, gatewayModel);
    expect(second.status).toBe(200);
    expect(backup1.hits).toHaveLength(1);
    expect(backup2.hits).toHaveLength(2);
    expect(primary.hits).toHaveLength(2);
  });

  test("全链失败重置：链尾备份失败提交后，下一请求从主模型从头开始（用户 2026-09-14 确认语义）", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 502, {error: "primary down"}));
    const backup1 = await startFixture((_request, response) => statusJson(response, 503, {error: "b1 down"}));
    const backup2 = await startFixture((_request, response) => statusJson(response, 503, {error: "b2 down"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "b1.example", url: backup1.url, models: ["bm1"]},
        {id: "b2.example", url: backup2.url, models: ["bm2"]},
      ],
      {"primary.example": {"gpt-test": [
        buildGatewayModelId("b1.example", "bm1"),
        buildGatewayModelId("b2.example", "bm2"),
      ]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");

    // 请求 1：主模型两连败 → 备份1 失败 → 备份2（链尾）失败提交真实错误给客户端。
    const first = await postModel(fixture.proxy.port, gatewayModel);
    expect(first.status).toBe(503);
    expect(JSON.parse(first.body)).toMatchObject({error: "b2 down"});
    expect(primary.hits).toHaveLength(2);
    expect(backup1.hits).toHaveLength(1);
    expect(backup2.hits).toHaveLength(1);

    // 请求 2：全链失败已重置 → 从主模型重新开始（而非从备份1 轮转）。
    const second = await postModel(fixture.proxy.port, gatewayModel);
    expect(second.status).toBe(503);
    expect(primary.hits).toHaveLength(4);
    expect(backup1.hits).toHaveLength(2);
    expect(backup2.hits).toHaveLength(2);
  });

  test("9 MiB 请求体：重放溢写磁盘后备份仍收到完整字节（旁路 tee 不截断当前请求）", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 502, {error: "down"}));
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    // > 8 MiB 内存上限：重放必然溢写磁盘；转移后备份必须收到逐字节完整的请求体。
    const filler = "x".repeat(1024);
    const bigBody = JSON.stringify({
      model: buildGatewayModelId("primary.example", "gpt-test"),
      input: [{role: "user", content: `${filler}`.repeat(9 * 1024 / 1)}],
      padding: "y".repeat(9 * 1024 * 1024 - 1024),
    });
    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: bigBody,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({source: "backup"});
    // 重放体 = 原体仅 model 值字节被替换（原 25 字节字面量 → 11 字节），其余逐字节一致。
    const modelDelta = JSON.stringify(buildGatewayModelId("primary.example", "gpt-test")).length
      - JSON.stringify("bm-backup").length;
    expect(backup.hits[0]?.body.length).toBe(bigBody.length - modelDelta);
    // model 字段已改写为备份模型，其余内容完整。
    const received = JSON.parse(backup.hits[0]!.body.toString());
    expect(received.model).toBe("bm-backup");
    expect(received.padding.length).toBe(9 * 1024 * 1024 - 1024);
  });

  test("链级预算耗尽：不再发起新候选，返回 504 FAILOVER_BUDGET_EXHAUSTED", async () => {
    const primary = await startFixture((_request, _response) => {
      // 挂起不回：等待响应头超时（测试注入 200ms）。
    }, {readBody: false});
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
      {failoverAttemptHeaderTimeoutMs: 200, failoverChainBudgetMs: 350},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    // 首次尝试 ~200ms 超时失败；锚点重试退避 300ms 后预算已耗尽 → 504，不再尝试任何备份。
    const response = await postModel(fixture.proxy.port, buildGatewayModelId("primary.example", "gpt-test"));
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body)).toEqual({error: "FAILOVER_BUDGET_LIMIT"});
    expect(backup.hits).toHaveLength(0);
  });

  test("codex 窗口编号递增触发主模型探测：压缩后首个请求先试主模型（x-codex-turn-metadata）", async () => {
    let primaryHealthy = false;
    const primary = await startFixture((_request, response) => {
      if (primaryHealthy) {
        json(response, {source: "primary"});
        return;
      }
      statusJson(response, 503, {error: "overloaded"});
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");
    const codexHeaders = (windowNumber: number, sessionId: string) => ({
      "content-type": "application/json",
      "session-id": sessionId,
      "x-codex-turn-metadata": JSON.stringify({window_number: windowNumber, session_id: sessionId}),
    });

    // 请求 1（win#0 基线）：主模型两连败 → 降级锁定备份。
    const first = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: codexHeaders(0, "codex-session-1"),
      body: JSON.stringify({model: gatewayModel}),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({source: "backup"});
    expect(primary.hits).toHaveLength(2);

    // 请求 2（win#0，无递增、无压缩标记）：直达粘性备份，不探测主模型。
    const second = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: codexHeaders(0, "codex-session-1"),
      body: JSON.stringify({model: gatewayModel}),
    });
    expect(await second.json()).toMatchObject({source: "backup"});
    expect(primary.hits).toHaveLength(2);

    // 请求 3（win#1 递增 = 压缩边界）：主模型已恢复 → 先探测主模型并切回。
    primaryHealthy = true;
    const third = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: codexHeaders(1, "codex-session-1"),
      body: JSON.stringify({model: gatewayModel}),
    });
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({source: "primary"});
    // 探测首试即成功（2 次降级失败 + 1 次探测成功）；锚点重试仅在失败后发生。
    expect(primary.hits).toHaveLength(3);

    // 请求 4（win#1 无递增）：健康态直达主模型。
    const fourth = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: codexHeaders(1, "codex-session-1"),
      body: JSON.stringify({model: gatewayModel}),
    });
    expect(await fourth.json()).toMatchObject({source: "primary"});
    expect(backup.hits).toHaveLength(2);
  });

  test("压缩标记越过 64 KiB（字节 100K 处）仍触发主模型探测（扫描窗口 2 MiB 回归）", async () => {
    let primaryHealthy = false;
    const primary = await startFixture((_request, response) => {
      if (primaryHealthy) {
        json(response, {source: "primary"});
        return;
      }
      statusJson(response, 503, {error: "overloaded"});
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");

    // 请求 1：主模型两连败 → 降级锁定备份（此请求不带压缩标记）。
    const first = await postModel(fixture.proxy.port, gatewayModel);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({source: "backup"});

    // 请求 2：主模型恢复 + 压缩摘要标记位于请求体第 ~100K 字节处（> 64 KiB 旧窗口）。
    // 回归 2026-09-15 缺陷：扫描封顶误用 64 KiB 时此用例必失败（不探测）。
    primaryHealthy = true;
    const marker = "Another language model started to solve this problem and produced a summary";
    const bigBody = JSON.stringify({
      model: gatewayModel,
      input: [
        {role: "user", content: marker},
        {role: "user", content: "前导上下文 " + "中".repeat(60 * 1024)},
        {role: "user", content: "填充 " + "x".repeat(40 * 1024)},
      ],
    });
    const recovery = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: bigBody,
    });
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({source: "primary"});
    // 压缩边界触发探测成功 → 切回主模型；备份仅第一请求兜底一次。
    expect(backup.hits).toHaveLength(1);
  });

  test("401/400 等非通道级错误不触发转移，按现状返回客户端", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 401, {error: "bad key"}));
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const response = await postModel(fixture.proxy.port, buildGatewayModelId("primary.example", "gpt-test"));
    expect(response.status).toBe(401);
    expect(primary.hits).toHaveLength(1);
    expect(backup.hits).toHaveLength(0);
  });

  test("降级态下压缩续接标记请求先探测主模型，成功即切回", async () => {
    let primaryHealthy = false;
    const primary = await startFixture((_request, response) => {
      if (primaryHealthy) {
        json(response, {source: "primary"});
        return;
      }
      statusJson(response, 503, {error: "overloaded"});
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");

    // 一次请求内主模型两连败 → 降级锁定备份。
    await postModel(fixture.proxy.port, gatewayModel);

    // 主模型恢复后，携带压缩续接标记的请求应先探测主模型并成功切回。
    primaryHealthy = true;
    const markerBody = JSON.stringify({
      model: gatewayModel,
      input: [{role: "user", content: "This session is being continued from a previous conversation that ran out of context. 摘要……"}],
    });
    const recovery = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: markerBody,
    });
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({source: "primary"});

    // 切回后后续请求直达主模型；备份只在第一请求兜底服务过一次。
    const after = await postModel(fixture.proxy.port, gatewayModel);
    expect(JSON.parse(after.body)).toMatchObject({source: "primary"});
    expect(primary.hits).toHaveLength(4);
    expect(backup.hits).toHaveLength(1);
  });

  test("SSE 正常响应在启用备份链的请求上照常流式转发，不缓冲不重试", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstBlock = sse("response.created", {type: "response.created"});
    const tailBlock = sse("response.completed", {type: "response.completed"});
    const primary = await startFixture(async (_request, response) => {
      response.writeHead(200, {"content-type": "text/event-stream"});
      response.write(firstBlock);
      await gate;
      response.end(tailBlock);
    });
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const response = await fetch(`http://127.0.0.1:${fixture.proxy.port}/codex/v1/responses`, {
      method: "POST",
      headers: {"content-type": "application/json", accept: "text/event-stream"},
      body: JSON.stringify({model: buildGatewayModelId("primary.example", "gpt-test"), stream: true}),
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
    expect(Buffer.concat(chunks).toString()).toBe(firstBlock + tailBlock);
    expect(backup.hits).toHaveLength(0);
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.response.isStreaming).toBe(true);
    expect(raw?.routing.failover).toBeUndefined();
  });

  test("全部候选失败：把最后的上游错误按现状返回，失败尝试与最终失败逐条落盘", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 500, {error: "primary down"}));
    const backup = await startFixture((_request, response) => statusJson(response, 503, {error: "backup down"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const response = await postModel(fixture.proxy.port, buildGatewayModelId("primary.example", "gpt-test"));
    // 主模型 500（含锚点重试共两次）触发转移；最后候选的真实错误响应按现状提交给客户端。
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({error: "backup down"});
    expect(primary.hits).toHaveLength(2);
    expect(backup.hits).toHaveLength(1);

    // 3 条记录：2 条主模型失败 + 1 条备份最终失败（全失败链元数据）。
    const records = await waitForRaw(fixture.dataDir, 3);
    const finalRecord = records.find(record => record.routing.targetId === "backup.example");
    expect(finalRecord?.routing.failover).toMatchObject({
      trigger: "consecutive_failures",
      toTargetId: "backup.example",
      toModel: "bm-backup",
      retryCount: 3,
    });
    expect(finalRecord?.routing.failover?.attempts.every(attempt => attempt.outcome === "error")).toBe(true);
  });

  test("降级态粘性备份抖动：锚点重试成功则粘性不变，不顺延下一优先级", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 502, {error: "primary down"}));
    let backupCalls = 0;
    const backup = await startFixture((_request, response) => {
      backupCalls += 1;
      // 时序：请求1 锁定时命中一次（200）；请求2 抖动（503）→ 锚点重试恢复（200）。
      if (backupCalls === 2) {
        statusJson(response, 503, {error: "transient"});
        return;
      }
      json(response, {source: "backup"});
    });
    const backup2 = await startFixture((_request, response) => json(response, {source: "backup2"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
        {id: "backup2.example", url: backup2.url, models: ["bm2"]},
      ],
      {"primary.example": {"gpt-test": [
        buildGatewayModelId("backup.example", "bm-backup"),
        buildGatewayModelId("backup2.example", "bm2"),
      ]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    const gatewayModel = buildGatewayModelId("primary.example", "gpt-test");

    // 第一次请求：主模型两连败 → 锁定粘性备份 backup。
    const locked = await postModel(fixture.proxy.port, gatewayModel);
    expect(JSON.parse(locked.body)).toMatchObject({source: "backup"});
    expect(backup2.hits).toHaveLength(0);

    // 第二次请求：粘性 backup 抖动（503）→ 锚点重试成功，粘性不变；backup2 零命中。
    const recovered = await postModel(fixture.proxy.port, gatewayModel);
    expect(recovered.status).toBe(200);
    expect(JSON.parse(recovered.body)).toMatchObject({source: "backup"});
    expect(backup2.hits).toHaveLength(0);
    expect(backupCalls).toBe(3);

    // 后续请求仍直达 backup。
    const third = await postModel(fixture.proxy.port, gatewayModel);
    expect(JSON.parse(third.body)).toMatchObject({source: "backup"});
    expect(backup2.hits).toHaveLength(0);
  });

  test("未配置备份链的模型走原有路径：主模型 502 原样返回且无 failover 字段", async () => {
    const primary = await startFixture((_request, response) => statusJson(response, 502, {error: "upstream broken"}));
    const fixture = await startFailoverFixture(
      [{id: "primary.example", url: primary.url, models: ["gpt-test"]}],
      {},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);

    const response = await postModel(fixture.proxy.port, buildGatewayModelId("primary.example", "gpt-test"));
    expect(response.status).toBe(502);
    expect(primary.hits).toHaveLength(1);
    const [raw] = await waitForRaw(fixture.dataDir, 1);
    expect(raw?.routing.failover).toBeUndefined();
  });

  test("配置删除级联：移除备份目标后，引用它的备份链在保存时被修剪", async () => {
    const primary = await startFixture((_request, response) => json(response, {source: "primary"}));
    const backup = await startFixture((_request, response) => json(response, {source: "backup"}));
    const fixture = await startFailoverFixture(
      [
        {id: "primary.example", url: primary.url, models: ["gpt-test"]},
        {id: "backup.example", url: backup.url, models: ["bm-backup"]},
      ],
      {"primary.example": {"gpt-test": [buildGatewayModelId("backup.example", "bm-backup")]}},
    );
    await waitFor(() => fixture.proxy.routing.current().revision === fixture.config.getConfig().revision);
    expect(fixture.config.getConfig().targets[0]?.supportedModelFallbacks).toBeDefined();

    // 删除备份目标前必须先停用（既有删除保护），保存路径的全局 prune 应清掉主目标的悬空备份链。
    await fixture.config.updateConfig({targetPatch: {id: "backup.example", target: {enabled: false}}});
    await fixture.config.updateConfig({targetDelete: {id: "backup.example"}});
    expect(fixture.config.getConfig().targets.find(target => target.id === "primary.example")?.supportedModelFallbacks).toBeUndefined();
  });

  test("服务端保存校验：无共同可用协议维度的备份链被拒绝", async () => {
    const primary = await startFixture((_request, response) => json(response, {source: "primary"}));
    const backupUpstream = await startFixture((_request, response) => json(response, {source: "backup"}));
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-failover-invalid-"));
    const config = new ProxyConfigStore({
      configPath: join(dataDir, "proxy-config.json"),
      developmentCredentialsPath: join(dataDir, "dev-credentials.json"),
      localProxyBaseUrl: "http://127.0.0.1:3211",
    });
    await config.init();
    await config.updateConfig({targets: [
      {id: "primary.example", name: "p", openaiUrl: primary.url, enabled: true, supportedModels: ["gpt-test"],
        supportedModelScopes: {"gpt-test": ["codex"]}, supportedModelWireApis: {"gpt-test": ["responses"]},
        development: {defaultCredentials: {codex: "c1"}}},
      {id: "backup.example", name: "b", openaiUrl: backupUpstream.url, enabled: true, supportedModels: ["bm"],
        supportedModelScopes: {bm: ["codex"]}, supportedModelWireApis: {bm: ["chat_completions"]},
        development: {defaultCredentials: {codex: "c1"}}},
    ]});
    // codex 只有 responses binding；备份只声明 chat_completions → 无共同 (agent, wireApi)。
    await expect(config.updateConfig({targetPatch: {id: "primary.example", target: {
      supportedModelFallbacks: {"gpt-test": [buildGatewayModelId("backup.example", "bm")]},
    }}})).rejects.toThrow(/没有共同可用的 Agent 协议/);
  });
});
