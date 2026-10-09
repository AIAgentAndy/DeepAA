/**
 * Codex 官方直连本地导入端到端测试（2026-10-09 通道 B，B2 身份/正文/时间增强）：
 * 临时 dataDir + 临时 CODEX_CLI_DIR（ZCODE/DSH CLI_DIR 一并指向空目录，绝不触碰
 * 真实 ~/.codex / ~/.zcode / ~/.dsh / ~/.deepaa）。覆盖：官方 provider 白名单导入、
 * 网关标记排重（session_meta.model_provider = deepaa_gateway）、模型面过滤、
 * append-only 增量续析、幂等重放、responses wire 合成（身份头 x-codex-session-id /
 * x-codex-turn-metadata、上下文回放请求体、真实 assistant 响应、首字/耗时）、
 * Worker 派生（origin / usage_source / 订阅通道 / 五维口径 / external_session_id /
 * native_turn_id 回填 / 交互内容分类）。
 */
import assert from "node:assert/strict";
import {appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, describe, test} from "node:test";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {createIngestionWorker} from "../src/lib/ingestion/worker.js";
import {createSqliteFixture, type SqliteFixture} from "./helpers/sqlite-fixture.js";

/** 模块级共享夹具：适配器在注册表加载时固化 cliDir，因此 env 必须先于动态导入设置。 */
const rootDir = await mkdtemp(join(tmpdir(), "deepaa-codex-import-"));
const codexCliDir = join(rootDir, "codex-cli");
const zcodeCliDir = join(rootDir, "zcode-cli");
const dshCliDir = join(rootDir, "dsh-cli");
const dataDir = join(rootDir, "data");
process.env.CODEX_CLI_DIR = codexCliDir;
process.env.ZCODE_CLI_DIR = zcodeCliDir;
process.env.DSH_CLI_DIR = dshCliDir;
const NOW = Date.now();
const MINUTE = 60_000;
/** rollout 基准时刻（行时间戳从这里偏移）。 */
const T0 = NOW - 10 * MINUTE;

/** rollout 日期目录按 NOW 所在日生成（适配器按日期目录裁剪窗口）。 */
const nowDate = new Date(NOW);
const sessionsDayDir = join(codexCliDir, "sessions",
  String(nowDate.getUTCFullYear()),
  String(nowDate.getUTCMonth() + 1).padStart(2, "0"),
  String(nowDate.getUTCDate()).padStart(2, "0"));

const FIXTURE_PROXY_CONFIG = {
  version: 3,
  revision: 1,
  updatedAt: new Date(NOW).toISOString(),
  localProxyBaseUrl: "http://localhost:3211",
  agentConnections: {
    codex: {defaultTargetId: "chatgpt-fixture", boundTargetIds: ["chatgpt-fixture"], cliSyncEnabled: true, enabled: true},
  },
  targets: [{
    id: "chatgpt-fixture",
    name: "OpenAI 订阅（夹具）",
    presetId: "openai-subscription",
    // openai-subscription 预设按 URL 消歧（与用户真实目标一致），缺失会导致预设解析失败。
    openaiUrl: "https://chatgpt.com/backend-api/codex",
    billingChannel: "subscription",
    vendorFamily: "openai",
    enabled: true,
    supportedModels: ["gpt-6.1-sol"],
    supportedModelScopes: {"gpt-6.1-sol": ["codex"]},
    development: {},
    createdAt: new Date(NOW - 40 * 24 * 3_600_000).toISOString(),
  }],
};

const FIXTURE_PRICING_CONFIG = {
  version: 2,
  currency: "CNY",
  unit: "per_million_tokens",
  models: [{
    id: "catalog:openai:gpt-6.1-sol",
    vendor: "openai",
    patterns: ["gpt-6.1-sol"],
    pricing: {input: 1.25, output: 10},
    currency: "USD",
    confidence: "official",
  }],
  targetOverrides: [],
};

async function seedConsumerConfig(fixture: SqliteFixture): Promise<void> {
  await mkdir(join(fixture.dataDir, "config"), {recursive: true});
  await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify(FIXTURE_PROXY_CONFIG));
  await writeFile(join(fixture.dataDir, "config", "model-pricing.json"), JSON.stringify(FIXTURE_PRICING_CONFIG));
}

interface RolloutLine {
  type: string;
  timestamp: string;
  ordinal: number;
  payload: Record<string, unknown>;
}

function rolloutLines(entries: Array<Partial<RolloutLine> & {type: string}>, startOrdinal = 1): string {
  return entries.map((entry, index) => JSON.stringify({
    timestamp: new Date(T0 + (startOrdinal + index) * 1_000).toISOString(),
    ordinal: startOrdinal + index,
    ...entry,
    payload: entry.payload ?? {},
  })).join("\n") + "\n";
}

const tokenCount = (usage: Record<string, number>) => ({
  type: "event_msg",
  payload: {type: "token_count", info: {last_token_usage: usage, total_token_usage: usage}},
});
const itemCompleted = (itemType: string, startedMs: number, completedMs: number) => ({
  type: "event_msg",
  payload: {type: "item_completed", started_at_ms: startedMs, completed_at_ms: completedMs, item: {id: `fixture-${itemType}-${startedMs}`, type: itemType}},
});
const userMessage = (itemId: string, text: string) => ({
  type: "response_item",
  payload: {type: "message", id: itemId, role: "user", content: [{type: "input_text", text}]},
});
const assistantMessage = (itemId: string, text: string) => ({
  type: "response_item",
  payload: {type: "message", id: itemId, role: "assistant", content: [{type: "output_text", text}]},
});

// 实测数值口径（2026-10-09 官方会话）：input_tokens 含 cached 子集、reasoning 为 output 子集。
const officialUsageA = {input_tokens: 40835, cached_input_tokens: 22144, cache_write_input_tokens: 0, output_tokens: 66, reasoning_output_tokens: 14, total_tokens: 40901};
const officialUsageB = {input_tokens: 42222, cached_input_tokens: 40704, cache_write_input_tokens: 0, output_tokens: 32, reasoning_output_tokens: 0, total_tokens: 42254};

/**
 * 官方会话文件 A：两个 turn——
 * turn-a1：user "哈喽" → 请求1（无 assistant 输出，验证空响应容错）；
 * turn-a2：user "继续" → 请求2 → assistant "回答"（item_completed 提供首字信号）。
 */
const fileAKey = "rollout-fixture-official-00000000-0000-0000-0000-00000000000a";
await mkdir(sessionsDayDir, {recursive: true});
const customToolOutput = (callId: string, texts: string[]) => ({
  type: "response_item",
  payload: {type: "custom_tool_call_output", id: `cto_${callId}`, call_id: callId, output: texts.map(text => ({type: "input_text", text}))},
});

const customToolCall = (callId: string, name: string) => ({
  type: "response_item",
  payload: {type: "custom_tool_call", id: `ctc_${callId}`, call_id: callId, name, input: "test input"},
});

// 四修夹具：模拟真实 codex agentic 流——模型输出(AgentMessage) → 工具调用 → 工具执行
// (CommandExecution，不推锚) → 工具结果 → token_count。锚只由 UserMessage 和
// 上一 token_count 推进；首字 = output.started − 锚。
await writeFile(join(sessionsDayDir, `${fileAKey}.jsonl`), rolloutLines([
  {type: "session_meta", payload: {session_id: "sess-official-a", model_provider: "openai", cli_version: "0.161.0", source: "vscode", thread_source: "user", base_instructions: "You are Codex.（夹具基础指令）"}},
  {type: "turn_context", payload: {turn_id: "turn-a1", model: "gpt-6.1-sol"}},
  userMessage("msg_u1", "哈喽"),
  // 锚 = UserMessage payload completed(3500)。
  itemCompleted("UserMessage", T0 + 3_200, T0 + 3_500),
  assistantMessage("msg_a1", "回答1"),
  customToolCall("call_1", "read_file"),
  // AgentMessage.started(4500) → 首字 = 4500−3500 = 1000；completed(5500) → 耗时 = 2000。
  itemCompleted("AgentMessage", T0 + 4_500, T0 + 5_500),
  // CommandExecution(5800) 不推锚（发生在模型输出之后、请求生命周期内部）。
  itemCompleted("CommandExecution", T0 + 5_600, T0 + 5_800),
  customToolOutput("call_1", ["file content"]),
  tokenCount(officialUsageA),
  {type: "turn_context", payload: {turn_id: "turn-a2", model: "gpt-6.1-sol"}},
  // 更早轮次的工具结果（input_text 段数组）：进入 turn-a2 的请求回放。
  customToolOutput("call_x", ["Script completed", "Output: ok"]),
  itemCompleted("CommandExecution", T0 + 10_500, T0 + 10_800),
  userMessage("msg_u2", "继续"),
  // 锚 = max(turn_context 行 ts, UserMessage payload completed) = T0+12_500。
  itemCompleted("UserMessage", T0 + 12_200, T0 + 12_500),
  assistantMessage("msg_a2", "回答"),
  // 首字 = 13500−12500 = 1000；完成 = 14800 → 耗时 2300。
  itemCompleted("AgentMessage", T0 + 13_500, T0 + 14_800),
  tokenCount(officialUsageB),
]));
/** 网关会话文件 B：model_provider = deepaa_gateway（必须整文件排重）。 */
await writeFile(join(sessionsDayDir, "rollout-fixture-gateway-00000000-0000-0000-0000-00000000000b.jsonl"), rolloutLines([
  {type: "session_meta", payload: {session_id: "sess-gateway-b", model_provider: "deepaa_gateway", cli_version: "0.161.0"}},
  {type: "turn_context", payload: {turn_id: "turn-b1", model: "gpt-6.1-sol_chatgpt.com"}},
  tokenCount(officialUsageA),
]));
/** 官方会话文件 C：模型不在供应商配置面（候选即排除）。 */
await writeFile(join(sessionsDayDir, "rollout-fixture-unprovisioned-00000000-0000-0000-0000-000000000c.jsonl"), rolloutLines([
  {type: "session_meta", payload: {session_id: "sess-unprovisioned-c", model_provider: "openai", cli_version: "0.161.0"}},
  {type: "turn_context", payload: {turn_id: "turn-c1", model: "gpt-9-pro"}},
  tokenCount(officialUsageA),
]));

await mkdir(join(dataDir, "config"), {recursive: true});
await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify(FIXTURE_PROXY_CONFIG));
await writeFile(join(dataDir, "config", "model-pricing.json"), JSON.stringify(FIXTURE_PRICING_CONFIG));
await writeFile(join(dataDir, "config", "retention.json"), JSON.stringify({version: 1, rawRetentionDays: 180}) + "\n");

const {runAgentLocalImportRound} = await import(
  "../src/lib/agent-local-source/local-import-scheduler.js"
);

const fixtures: SqliteFixture[] = [];
const workers: Array<{close(): Promise<void>}> = [];

after(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()));
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  await rm(rootDir, {recursive: true, force: true});
});

async function createConsumingFixture(): Promise<SqliteFixture> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  await seedConsumerConfig(fixture);
  return fixture;
}

/** 把导入产物复制到消费夹具并跑完派生。 */
async function deriveImportedRows(fixture: SqliteFixture): Promise<void> {
  const captureDir = join(dataDir, "captures", "v2");
  await mkdir(join(fixture.dataDir, "captures", "v2"), {recursive: true});
  for (const name of (await readdir(captureDir)).filter(name => name.startsWith("import-"))) {
    await writeFile(join(fixture.dataDir, "captures", "v2", name), await readFile(join(captureDir, name)));
  }
  const worker = createIngestionWorker({
    dataDir: fixture.dataDir,
    ownerId: `worker-codex-import-${Math.random().toString(36).slice(2)}`,
  });
  workers.push(worker);
  assert.equal(worker.acquireLease(), true);
  for (let i = 0; i < 6; i += 1) {
    const result = await worker.runOneBatch();
    if (result.processedCount === 0 && result.discoveredCount === 0) break;
  }
}

interface RawRow {
  exchangeId: string;
  durationMs: number;
  firstTokenMs?: number;
  routing: {origin: string; agent: string; wireApi: string; requestedModel: string; clientQuerySource?: string};
  request: {headers: Record<string, string>; rawBody?: string};
  response: {rawBody: string; headers?: Record<string, string>};
  captureDiagnostics?: Array<{code: string}>;
}

function readRawRows(rows: string[]): RawRow[] {
  return rows.map(line => JSON.parse(line) as RawRow);
}

describe("Codex 官方直连本地导入", () => {
  test("白名单导入 + 排重 + 模型面过滤 + responses 合成（身份头/回放/首字耗时）", async () => {
    const imported = await runAgentLocalImportRound({dataDir, nowMs: NOW});
    // 官方文件 A 两条入账；网关文件 B（provider 标记）与模型面外文件 C 均排除。
    assert.equal(imported, 2);

    const captureDir = join(dataDir, "captures", "v2");
    const files = (await readdir(captureDir)).filter(name => name.startsWith("import-codex-"));
    assert.equal(files.length, 1);
    const rows = readRawRows((await readFile(join(captureDir, files[0]!), "utf8")).trim().split("\n"));
    assert.deepEqual(rows.map(row => row.exchangeId), [
      `import-codex-${fileAKey}:10`,
      `import-codex-${fileAKey}:18`,
    ]);
    assert.ok(rows.every(row => row.routing.origin === "agent_local_import" && row.routing.agent === "codex"));
    assert.ok(rows.every(row => row.routing.wireApi === "responses"));
    assert.ok(rows.every(row => row.routing.requestedModel === "gpt-6.1-sol"));
    // 入口来源透传（vscode = 桌面 App；CLI 会话为其独立 rollout）。
    assert.ok(rows.every(row => row.routing.clientQuerySource === "vscode"));
    // 身份头（网关 codex 同款信号）：Session 折叠 + native_turn_id 回填的输入。
    assert.ok(rows.every(row => row.request.headers["x-codex-session-id"] === "sess-official-a"));
    assert.match(rows[0]!.request.headers["x-codex-turn-metadata"] ?? "", /turn-a1/u);
    assert.match(rows[1]!.request.headers["x-codex-turn-metadata"] ?? "", /turn-a2/u);
    // 四修：CommandExecution 不推锚（模型输出在工具执行之前，推锚会吞掉首字）。
    // 第一条：锚 = UserMessage.completed(3500)；首字 = AgentMessage.started(4500)−3500=1000；完成 5500 → 2000。
    assert.equal(rows[0]!.durationMs, 2_000, `row0 durationMs=${rows[0]!.durationMs}`);
    assert.equal(rows[0]!.firstTokenMs, 1_000, `row0 firstTokenMs=${rows[0]!.firstTokenMs}`);
    // 第二条：锚 = UserMessage.completed(12500)；首字 = AgentMessage.started(13500)−12500=1000；完成 14800 → 2300。
    assert.equal(rows[1]!.firstTokenMs, 1_000, `row1 firstTokenMs=${rows[1]!.firstTokenMs}`);
    assert.equal(rows[1]!.durationMs, 2_300, `row1 durationMs=${rows[1]!.durationMs}`);
    // 请求体 = responses 上下文回放（wire 原始形态）：instructions（base_instructions）
    // + 两条 user 消息 + 工具结果（input_text 段数组拼接为 function_call_output.output）。
    const requestBody = JSON.parse(rows[1]!.request.rawBody ?? "{}") as {
      instructions?: string;
      input?: Array<{type: string; role?: string; content?: Array<{text?: string}>; output?: string}>;
    };
    assert.match(requestBody.instructions ?? "", /You are Codex/u);
    const inputTexts = (requestBody.input ?? []).flatMap(item => (item.content ?? []).map(part => part.text ?? ""));
    assert.ok(inputTexts.includes("哈喽"), `上下文缺少首轮用户输入: ${JSON.stringify(inputTexts)}`);
    assert.ok(inputTexts.includes("继续"), `上下文缺少本轮用户输入: ${JSON.stringify(inputTexts)}`);
    const toolResult = (requestBody.input ?? []).find(item => item.type === "function_call_output" && item.call_id === "call_x");
    assert.ok(toolResult, "上下文缺少 call_x 工具结果");
    assert.equal(toolResult!.output, "Script completed\nOutput: ok");
    // 有 instructions 的回放体不再误报骨架缺失；无 instructions（skeletonUnavailable
    // 标记）也不产生警告——codex rollout 不含工具定义是已知常态（2026-10-09 确认）。
    assert.ok(!rows[0]!.captureDiagnostics?.some(diagnostic => diagnostic.code === "request_skeleton_missing"),
      `骨架缺失误报: ${JSON.stringify(rows[0]!.captureDiagnostics?.map(d => d.code))}`);
    // 响应体：真实 assistant 输出 + usage 互逆口径。
    const responseBody = JSON.parse(rows[1]!.response.rawBody) as {
      output: Array<{type: string; content?: Array<{text?: string}>}>;
      usage: {input_tokens: number; input_tokens_details: {cached_tokens: number}};
    };
    assert.ok(responseBody.output.some(item => (item.content ?? []).some(part => part.text === "回答")),
      `响应缺少 assistant 正文: ${JSON.stringify(responseBody.output)}`);
    assert.equal(responseBody.usage.input_tokens, 42222);
    assert.equal(responseBody.usage.input_tokens_details.cached_tokens, 40704);
    // 响应头合成占位（本地记录不含真实响应头）。
    assert.equal(rows[0]!.response.headers?.["content-type"], "application/json");
  });

  test("幂等重放：同一轮再跑零新增", async () => {
    const imported = await runAgentLocalImportRound({dataDir, nowMs: NOW});
    assert.equal(imported, 0);
  });

  test("append-only 增量续析：同文件追加新 token_count 只导新增行", async () => {
    // 追加的行序号接续原文件（14-17），token_count 的幂等 id = fileKey:17。
    await appendFile(join(sessionsDayDir, `${fileAKey}.jsonl`), rolloutLines([
      {type: "turn_context", payload: {turn_id: "turn-a3", model: "gpt-6.1-sol"}},
      userMessage("msg_u3", "第三问"),
      itemCompleted("UserMessage", T0 + 14_200, T0 + 14_500),
      tokenCount({input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 50, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 1020}),
    ], 19));    const imported = await runAgentLocalImportRound({dataDir, nowMs: NOW});
    assert.equal(imported, 1);
    // 再跑一轮：无新增。
    assert.equal(await runAgentLocalImportRound({dataDir, nowMs: NOW}), 0);
  });

  test("Worker 派生：层级折叠 / 原生 ID 回填 / 订阅通道 / 交互内容 / 五维口径", async () => {
    const fixture = await createConsumingFixture();
    await deriveImportedRows(fixture);

    const refs = fixture.db.prepare(
      "SELECT exchange_id, origin, agent_name FROM raw_exchange_refs ORDER BY exchange_id",
    ).all() as Array<{exchange_id: string; origin: string; agent_name: string}>;
    assert.equal(refs.length, 3);
    assert.ok(refs.every(row => row.origin === "agent_local_import" && row.agent_name === "codex"));

    // 身份折叠（B2 核心）：external_session_id 精确回填；两个原生 turn 各自建 Turn。
    const session = fixture.db.prepare(
      "SELECT external_session_id, source, confidence FROM agent_sessions",
    ).get() as {external_session_id: string | null; source: string; confidence: string};
    assert.equal(session.external_session_id, "sess-official-a");
    assert.equal(session.source, "session-header");
    assert.equal(session.confidence, "exact");
    const turns = fixture.db.prepare(
      "SELECT native_turn_id FROM agent_turns ORDER BY start_time",
    ).all() as Array<{native_turn_id: string | null}>;
    assert.deepEqual(turns.map(turn => turn.native_turn_id), ["turn-a1", "turn-a2", "turn-a3"]);

    const ledger = fixture.db.prepare(
      `SELECT exchange_id, usage_source, usage_confidence, billing_channel, vendor_family,
              input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
       FROM usage_ledger ORDER BY exchange_id`,
    ).all() as Array<Record<string, unknown>>;
    assert.equal(ledger.length, 3);
    for (const row of ledger) {
      assert.equal(row.usage_source, "agent_local_import");
      assert.equal(row.usage_confidence, "client_declared");
      assert.equal(row.billing_channel, "subscription");
      assert.equal(row.vendor_family, "openai");
    }
    // 第一条：input_tokens(40835) 含 cached(22144) 子集 → 非缓存输入 18691。
    const first = ledger.find(row => String(row.exchange_id).endsWith(":10"));
    assert.ok(first, `未找到 :5 行，实际=${ledger.map(row => row.exchange_id).join(",")}`);
    assert.equal(first.input_tokens, 40835 - 22144);
    assert.equal(first.cache_read_tokens, 22144);
    assert.equal(first.output_tokens, 66);
    assert.equal(first.reasoning_tokens, 14);
    // 增量追加行（含 cache write 50）。
    const appended = ledger.find(row => String(row.exchange_id).endsWith(":22"));
    assert.ok(appended, "增量行未入账");
    assert.equal(appended.input_tokens, 1000);
    assert.equal(appended.cache_write_tokens, 50);
    assert.equal(appended.output_tokens, 20);

    // 交互内容（responses input 回放）：第二条请求的预览含真实用户输入。
    const preview = fixture.db.prepare(
      `SELECT p.preview_json FROM exchange_content_previews p
       JOIN raw_exchange_refs r ON r.exchange_id = p.exchange_id
       WHERE r.exchange_id = ?`,
    ).get(`import-codex-${fileAKey}:18`) as {preview_json: string} | undefined;
    assert.ok(preview, "预览未生成");
    const items = JSON.parse(preview.preview_json).conversationItems as Array<{semanticCategory?: string; textPreview?: string}>;
    assert.ok(items.some(item => item.semanticCategory === "user_real" && (item.textPreview ?? "").includes("哈喽")),
      `首轮用户输入缺失: ${JSON.stringify(items.map(item => item.semanticCategory))}`);
    assert.ok(items.some(item => item.semanticCategory === "user_real" && (item.textPreview ?? "").includes("继续")),
      `本轮用户输入缺失: ${JSON.stringify(items.map(item => item.semanticCategory))}`);
  });
});
