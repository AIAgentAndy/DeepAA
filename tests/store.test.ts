import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExchangeStore } from "../src/store.js";
import type { CapturedExchangeInput, SessionRoutingInput } from "../src/store.js";
import type { CaptureRouting } from "../src/lib/harness/types.js";

interface MakeCaptureOptions {
  targetId?: string;
  targetName?: string;
  timestamp?: string;
  headers?: Record<string, string>;
}

test("每个 capture Session 只缓存最近 20 条正文且轻量摘要覆盖全部当前进程请求", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-store-bounded-"));
  const store = new ExchangeStore({ dataDir });
  await store.init();
  const firstRoute = makeCapture("gpt-5", {
    targetId: "api.openai.com",
    targetName: "OpenAI",
    timestamp: "2026-07-16T00:00:01.000Z",
  }).routingInput;
  const secondRoute = makeCapture("claude-sonnet", {
    targetId: "api.anthropic.com",
    targetName: "Anthropic",
    timestamp: "2026-07-16T01:00:01.000Z",
  }).routingInput;
  const sessionA = store.getSessionIdForExchange(firstRoute);
  const sessionB = store.getSessionIdForExchange(secondRoute);

  for (let index = 1; index <= 25; index++) {
    await store.addCapturedExchange(makeCapture("gpt-5", {
      targetId: "api.openai.com",
      targetName: "OpenAI",
      timestamp: new Date(Date.UTC(2026, 6, 16, 0, 0, index)).toISOString(),
    }).input, sessionA);
  }
  for (let index = 1; index <= 22; index++) {
    await store.addCapturedExchange(makeCapture("claude-sonnet", {
      targetId: "api.anthropic.com",
      targetName: "Anthropic",
      timestamp: new Date(Date.UTC(2026, 6, 16, 1, 0, index)).toISOString(),
    }).input, sessionB);
  }

  expect(store.getRawExchanges(sessionA).map(exchange => exchange.sequence)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 6),
  );
  expect(store.getRawExchanges(sessionB).map(exchange => exchange.sequence)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 3),
  );

  const sessions = await store.discoverSessions();
  const summaryA = sessions.find(session => session.id === sessionA);
  const summaryB = sessions.find(session => session.id === sessionB);
  expect(summaryA).toEqual(expect.objectContaining({
    turnCount: 25,
    startTime: "2026-07-16T00:00:01.000Z",
    lastActivityTime: "2026-07-16T00:00:25.012Z",
    model: "gpt-5",
  }));
  expect(summaryA?.fileSize).toBeGreaterThan(0);
  expect(summaryB).toEqual(expect.objectContaining({
    turnCount: 22,
    startTime: "2026-07-16T01:00:01.000Z",
    lastActivityTime: "2026-07-16T01:00:22.012Z",
    model: "claude-sonnet",
  }));
});

test("初始化不读取旧索引、旧派生或既有 v2 raw", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-store-no-history-"));
  const existingV2Dir = join(dataDir, "captures", "v2");
  await mkdir(existingV2Dir, { recursive: true });
  await mkdir(join(dataDir, "indexes"), { recursive: true });
  await mkdir(join(dataDir, "derived"), { recursive: true });
  await writeFile(
    join(existingV2Dir, "capture-v2-1-12345678-abc.jsonl"),
    '{"mustNotBeParsed":true}\n',
    "utf-8",
  );
  await writeFile(join(dataDir, "indexes", "exchanges.jsonl"), "not-json\n", "utf-8");
  await writeFile(join(dataDir, "derived", "manifest.json"), "not-json\n", "utf-8");

  const store = new ExchangeStore({ dataDir });
  await store.init();

  expect(await store.discoverSessions()).toEqual([]);
  expect(store.getRawExchanges("capture-v2-1-12345678-abc")).toEqual([]);

  const exchange = await store.addCapturedExchange(makeCapture("gpt-5").input);
  expect(exchange.captureSessionId).not.toBe("capture-v2-1-12345678-abc");
  expect(exchange.sequence).toBe(1);
  expect(await readFile(join(dataDir, "indexes", "exchanges.jsonl"), "utf-8")).toBe("not-json\n");
  expect(await readFile(join(dataDir, "derived", "manifest.json"), "utf-8")).toBe("not-json\n");
});

test("自动 Session 按代理目标、模型和本地日期分组", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-store-auto-"));
  const store = new ExchangeStore({ dataDir });
  await store.init();

  await store.addCapturedExchange(makeCapture("gpt-5", {
    targetId: "api.openai.com", targetName: "OpenAI", timestamp: "2026-05-27T01:00:00.000Z",
  }).input);
  await store.addCapturedExchange(makeCapture("gpt-5", {
    targetId: "api.openai.com", targetName: "OpenAI", timestamp: "2026-05-27T02:00:00.000Z",
  }).input);
  await store.addCapturedExchange(makeCapture("gpt-5", {
    targetId: "api.anthropic.com", targetName: "Anthropic", timestamp: "2026-05-27T03:00:00.000Z",
  }).input);
  await store.addCapturedExchange(makeCapture("claude-sonnet", {
    targetId: "api.openai.com", targetName: "OpenAI", timestamp: "2026-05-27T04:00:00.000Z",
  }).input);
  await store.addCapturedExchange(makeCapture("gpt-5", {
    targetId: "api.openai.com", targetName: "OpenAI", timestamp: "2026-05-28T01:00:00.000Z",
  }).input);

  const sessions = await store.discoverSessions();
  expect(sessions).toHaveLength(4);
  expect(sessions.map(session => session.label)).toContain("当前进程 · OpenAI · gpt-5 · 2026-05-27");
  expect(sessions.map(session => session.label)).toContain("当前进程 · Anthropic · gpt-5 · 2026-05-27");
  expect(sessions.map(session => session.label)).toContain("当前进程 · OpenAI · claude-sonnet · 2026-05-27");
  expect(sessions.map(session => session.label)).toContain("实时 · OpenAI · gpt-5 · 2026-05-28");
  expect(sessions.find(session =>
    session.label === "当前进程 · OpenAI · gpt-5 · 2026-05-27"
  )?.turnCount).toBe(2);
});

test("新请求只追加一份 v2 raw 且不创建旧 indexes 或 derived", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-store-v2-"));
  const store = new ExchangeStore({ dataDir });
  await store.init();

  const exchange = await store.addCapturedExchange(makeCapture("gpt-5", {
    targetId: "api.openai.com",
    targetName: "OpenAI",
    timestamp: "2026-05-27T01:00:00.000Z",
    headers: { session_id: "codex-session-1" },
  }).input);
  const files = await readdir(join(dataDir, "captures", "v2"));
  const line = await readFile(join(dataDir, "captures", "v2", files[0]!), "utf-8");
  const persisted = JSON.parse(line) as Record<string, unknown>;

  expect(files).toHaveLength(1);
  expect(exchange.schemaVersion).toBe(2);
  expect(persisted.schemaVersion).toBe(2);
  expect(persisted.exchangeId).toBe(exchange.exchangeId);
  expect(persisted).not.toHaveProperty("stream");
  expect(persisted.request).not.toHaveProperty("parsedBody");
  expect(persisted.response).not.toHaveProperty("parsedBody");
  expect(await pathExists(join(dataDir, "indexes"))).toBe(false);
  expect(await pathExists(join(dataDir, "derived"))).toBe(false);
});

test("手动轮转为同一目标、模型和日期创建下一代 Session", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-store-manual-"));
  const store = new ExchangeStore({ dataDir });
  await store.init();
  const first = makeCapture("gpt-5.5", {
    targetId: "api.openai.com",
    targetName: "OpenAI",
    timestamp: "2026-05-27T01:00:00.000Z",
  });
  await store.addCapturedExchange(first.input);
  const firstSessionId = store.getSessionIdForExchange(first.routingInput);

  const rotation = await store.rotateCurrentSession();
  await store.addCapturedExchange(makeCapture("gpt-5.5", {
    targetId: "api.openai.com",
    targetName: "OpenAI",
    timestamp: "2026-05-27T02:00:00.000Z",
  }).input);

  const sessions = (await store.discoverSessions()).filter(session =>
    session.label.includes("OpenAI · gpt-5.5 · 2026-05-27")
  );
  expect(rotation.previousSessionId).toBe(firstSessionId);
  expect(rotation.currentSessionId).not.toBe(firstSessionId);
  expect(sessions).toHaveLength(2);
  expect(sessions.find(session => session.generation === 2)?.label).toContain("#2");
  expect(store.getRawExchanges(firstSessionId).map(exchange => exchange.sequence)).toEqual([1]);
  expect(store.getRawExchanges(rotation.currentSessionId).map(exchange => exchange.sequence)).toEqual([1]);
});

test("请求结束时仍写入其开始时绑定的 Session", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-store-in-flight-"));
  const store = new ExchangeStore({ dataDir });
  await store.init();
  const inFlight = makeCapture("test-before");
  const requestStartSessionId = store.getSessionIdForExchange(inFlight.routingInput);
  await store.rotateCurrentSession(requestStartSessionId);
  const rotatedSessionId = store.getCurrentSessionId();

  await store.addCapturedExchange(inFlight.input, requestStartSessionId);
  await store.addCapturedExchange(makeCapture("test-before").input);

  expect(store.getRawExchanges(requestStartSessionId).map(exchange => exchange.sequence)).toEqual([1]);
  expect(store.getRawExchanges(rotatedSessionId).map(exchange => exchange.sequence)).toEqual([1]);
});

/** 构造抓包输入和会话路由输入，避免测试依赖代理网络层。 */
function makeCapture(model: string, options: MakeCaptureOptions = {}): {
  input: CapturedExchangeInput;
  routingInput: SessionRoutingInput;
} {
  const targetId = options.targetId || "api.example.test";
  const targetName = options.targetName || targetId;
  const timestamp = options.timestamp || "2026-07-17T00:00:00.000Z";
  const routing: CaptureRouting = {
    targetId,
    targetName,
    targetFormatHint: "openai",
    localUrl: "/v1/messages",
    upstreamUrl: "https://example.test/v1/messages",
    localPath: "/v1/messages",
    upstreamPath: "/v1/messages",
    method: "POST",
  };
  const input: CapturedExchangeInput = {
    capturedAt: timestamp,
    completedAt: new Date(new Date(timestamp).getTime() + 12).toISOString(),
    routing,
    request: {
      headers: options.headers || {},
      rawBody: JSON.stringify({ model, messages: [] }),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: JSON.stringify({ model, content: [] }),
      isStreaming: false,
    },
  };
  return {
    input,
    routingInput: { targetId, targetName, timestamp, model },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
