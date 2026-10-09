/**
 * 双链路观测（Agent 官方直连本地导入）端到端测试：
 * 临时 dataDir + 临时 zcode cli 目录（ZCODE_CLI_DIR 隔离，绝不触碰真实 ~/.zcode 与
 * 真实 ~/.deepaa）。覆盖：排重过滤（网关标记）、游标推进与幂等重放、合成行落盘、
 * Worker 派生（origin/usage_source/账本）、Campaign origins 通道判定（D-3）、
 * 模型白名单外跳过计数。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createHash } from "node:crypto";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { appendRawCapturedExchangeV2 } from "../src/proxy/capture-writer.js";
import { createIngestionWorker } from "../src/lib/ingestion/worker.js";
import { createSqliteFixture, type SqliteFixture } from "./helpers/sqlite-fixture.js";

/** 模块级共享夹具：适配器在注册表加载时固化 cliDir，因此 env 必须先于动态导入设置。 */
const rootDir = await mkdtemp(join(tmpdir(), "deepaa-local-import-"));
const zcodeCliDir = join(rootDir, "zcode-cli");
const dataDir = join(rootDir, "data");
process.env.ZCODE_CLI_DIR = zcodeCliDir;
const NOW = Date.now();
const HOUR = 3_600_000;

const FIXTURE_PROXY_CONFIG = {
  version: 3,
  revision: 1,
  updatedAt: new Date(NOW).toISOString(),
  localProxyBaseUrl: "http://localhost:3211",
  agentConnections: { zcode: { defaultTargetId: "zhipu-coding-fixture", enabled: true } },
  targets: [{
    id: "zhipu-coding-fixture",
    name: "智谱 Coding（夹具）",
    presetId: "zhipu-coding-plan",
    billingChannel: "plan",
    vendorFamily: "zhipu",
    enabled: true,
    supportedModels: ["glm-5.3-flash"],
    supportedModelScopes: { "glm-5.3-flash": ["zcode"] },
    development: { defaultCredentials: { zcode: "cred-fixture" } },
  }],
};

const FIXTURE_PRICING_CONFIG = {
  version: 2,
  currency: "CNY",
  unit: "per_million_tokens",
  models: [{
    id: "catalog:zhipu-cn:glm-5.3-flash",
    vendor: "zhipu-cn",
    patterns: ["glm-5.3-flash"],
    pricing: { input: 0.8, output: 2.8, cachedInput: 0.23 },
    currency: "CNY",
    confidence: "official",
    planCreditRules: {
      formula: "token_weighted",
      divisor: 10000,
      quotaWindows: [{ id: "weekly", label: "每周", reset: "weekly" }],
      modelFactors: { "glm-5.3-flash": { input: 2.3, output: 8, cachedInput: 0.56 } },
      promotions: [{
        from: "2026-06-01T00:00:00+08:00",
        multiplier: 2 / 3,
        agents: ["zcode"],
        origins: ["agent_local_import"],
        label: "ZCode Agent 限时活动",
      }],
    },
  }],
  targetOverrides: [],
};

/** 消费夹具与导入目录同配置：processor 按 dataDir 解析目标通道与价格。 */
async function seedConsumerConfig(fixture: SqliteFixture): Promise<void> {
  await mkdir(join(fixture.dataDir, "config"), { recursive: true });
  await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify(FIXTURE_PROXY_CONFIG));
  await writeFile(join(fixture.dataDir, "config", "model-pricing.json"), JSON.stringify(FIXTURE_PRICING_CONFIG));
}

await mkdir(join(zcodeCliDir, "db"), { recursive: true });
await mkdir(join(zcodeCliDir, "rollout"), { recursive: true });
await mkdir(join(dataDir, "config"), { recursive: true });
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, "config", "retention.json"), JSON.stringify({ version: 1, rawRetentionDays: 180 }) + "\n");

const zcodeDb = new DeepaaDatabase(join(zcodeCliDir, "db", "db.sqlite"));
zcodeDb.exec(`
  CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT, app_version TEXT, time_applied INTEGER);
  INSERT INTO schema_migration VALUES ('0001_init', 'hash', '0.15.2', 1);
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
  CREATE TABLE model_usage (
    id TEXT PRIMARY KEY,
    logical_request_id TEXT,
    parent_user_message_id TEXT,
    assistant_message_id TEXT,
    attempt_index INTEGER DEFAULT 0,
    session_id TEXT,
    turn_id TEXT,
    trace_id TEXT,
    query_source TEXT,
    provider_id TEXT,
    model_id TEXT,
    status TEXT,
    started_at INTEGER,
    first_token_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    finish_reason TEXT,
    error_code TEXT,
    error_message TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cache_creation_input_tokens INTEGER DEFAULT 0,
    cache_read_input_tokens INTEGER DEFAULT 0
  );
`);
function db_wrapInsert(table: string, columns: string[]): (...values: unknown[]) => void {
  const stmt = zcodeDb.prepare(
    `INSERT INTO ${table}(${columns.join(", ")}) VALUES(${columns.map(() => "?").join(", ")})`,
  );
  return (...values: unknown[]) => stmt.run(...values);
}

function insertUsage(row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  zcodeDb.prepare(
    `INSERT INTO model_usage(${keys.join(", ")}) VALUES(${keys.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}
const baseUsage = {
  logical_request_id: "req-1",
  parent_user_message_id: "msg-parent-1",
  attempt_index: 0,
  status: "completed",
  finish_reason: "stop",
  input_tokens: 42632,
  output_tokens: 132,
  reasoning_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 26624,
};

/** 直连行（builtin provider）×2 + 网关标记行（必须被排重）+ 白名单外模型行（跳过计数）。 */
insertUsage({
  ...baseUsage, id: "u-direct-1", session_id: "sess-a", turn_id: "turn-a1", trace_id: "trace-a",
  parent_user_message_id: "msg-user-1", assistant_message_id: "msg-asst-1",
  query_source: "main_turn", provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash",
  started_at: NOW - HOUR, first_token_at: NOW - HOUR + 1_200, completed_at: NOW - HOUR + 6_000, duration_ms: 6_000,
});
// 最新的 session（completed = NOW + 30s > sess-a 全部）→ 候选排序第一位
insertUsage({
  ...baseUsage, id: "u-direct-d", session_id: "sess-d", turn_id: "turn-d1", trace_id: "trace-d",
  parent_user_message_id: "msg-user-d", assistant_message_id: "msg-asst-d",
  query_source: "main_turn", provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash",
  started_at: NOW + 24_000, first_token_at: NOW + 24_500, completed_at: NOW + 30_000, duration_ms: 5_500,
  input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0,
});
insertUsage({
  ...baseUsage, id: "u-direct-2", session_id: "sess-a", turn_id: "turn-a2", trace_id: "trace-a",
  parent_user_message_id: "msg-user-2", assistant_message_id: "msg-asst-2",
  query_source: "subagent", provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash",
  started_at: NOW - HOUR + 60_000, first_token_at: NOW - HOUR + 61_000, completed_at: NOW - HOUR + 66_000, duration_ms: 5_000,
  input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0,
});
insertUsage({
  ...baseUsage, id: "u-gateway-1", session_id: "sess-a", turn_id: "turn-g1", trace_id: "trace-g",
  query_source: "main_turn", provider_id: "deepaa-gateway", model_id: "GLM-5.3-Flash",
  started_at: NOW - HOUR + 120_000, completed_at: NOW - HOUR + 126_000, duration_ms: 6_000,
});
insertUsage({
  ...baseUsage, id: "u-legacy-gw", session_id: "sess-b", turn_id: "turn-g2", trace_id: "trace-g2",
  query_source: "main_turn", provider_id: "llm-inspector-gateway", model_id: "GLM-5.3-Flash",
  started_at: NOW - HOUR + 180_000, completed_at: NOW - HOUR + 186_000, duration_ms: 6_000,
});
insertUsage({
  ...baseUsage, id: "u-unprovisioned", session_id: "sess-c", turn_id: "turn-c1", trace_id: "trace-c",
  query_source: "main_turn", provider_id: "builtin:bigmodel-coding-plan", model_id: "glm-4.7",
  started_at: NOW - HOUR + 240_000, completed_at: NOW - HOUR + 246_000, duration_ms: 6_000,
});
zcodeDb.prepare("INSERT INTO session(id, directory) VALUES ('sess-a', '/tmp/proj-a')").run();
// 跨 session 排序验证：sess-d 活动比 sess-a 更新 → 候选排序必须最先导入 sess-d
zcodeDb.prepare("INSERT INTO session(id, directory) VALUES ('sess-d', '/tmp/proj-d')").run();
// 会话语义时间线（parts 重建机制的数据源，真实结构形态）
const insertMessage = db_wrapInsert("message", ["id", "session_id", "time_created", "time_updated", "data", "sequence"]);
const insertPart = db_wrapInsert("part", ["id", "message_id", "session_id", "time_created", "time_updated", "data", "sequence"]);
insertMessage("msg-user-1", "sess-a", 1, 1, JSON.stringify({role: "user", semantics: {providerVisibility: "visible"}}), 0);
insertMessage("msg-user-d", "sess-d", 10, 10, JSON.stringify({role: "user", semantics: {providerVisibility: "visible"}}), 0);
insertMessage("msg-asst-d", "sess-d", 11, 11, JSON.stringify({role: "assistant", time: {completed: 1}, semantics: {providerVisibility: "visible"}}), 1);
insertPart("p-ud", "msg-user-d", "sess-d", 10, 10, JSON.stringify({type: "text", text: "最新会话的提问"}), 0);
insertPart("p-ad", "msg-asst-d", "sess-d", 11, 11, JSON.stringify({type: "text", text: "最新会话的回答"}), 0);
insertPart("p-ad-sf", "msg-asst-d", "sess-d", 11, 11, JSON.stringify({type: "step-finish", reason: "stop"}), 1);
insertMessage("msg-asst-1", "sess-a", 2, 2, JSON.stringify({role: "assistant", time: {completed: 1}, semantics: {providerVisibility: "visible"}}), 1);
insertMessage("msg-user-2", "sess-a", 3, 3, JSON.stringify({role: "user", semantics: {providerVisibility: "visible"}}), 2);
insertMessage("msg-asst-2", "sess-a", 4, 4, JSON.stringify({role: "assistant", time: {completed: 1}, semantics: {providerVisibility: "visible"}}), 3);
insertPart("p-u1", "msg-user-1", "sess-a", 1, 1, JSON.stringify({type: "text", text: "重置重导验证用户输入"}), 0);
insertPart("p-a1-ss", "msg-asst-1", "sess-a", 2, 2, JSON.stringify({type: "step-start"}), 0);
insertPart("p-a1-th", "msg-asst-1", "sess-a", 2, 2, JSON.stringify({type: "reasoning", text: "推理链内容"}), 1);
insertPart("p-a1-tx", "msg-asst-1", "sess-a", 2, 2, JSON.stringify({type: "text", text: "我来处理"}), 2);
insertPart("p-a1-tool", "msg-asst-1", "sess-a", 2, 2, JSON.stringify({type: "tool", callID: "call_1", tool: "Read", state: {status: "completed", input: {file_path: "/x"}, output: "file content"}}), 3);
insertPart("p-a1-sf", "msg-asst-1", "sess-a", 2, 2, JSON.stringify({type: "step-finish", reason: "tool-calls"}), 4);
insertPart("p-u2", "msg-user-2", "sess-a", 3, 3, JSON.stringify({type: "text", text: "继续"}), 0);
insertPart("p-a2-tx", "msg-asst-2", "sess-a", 4, 4, JSON.stringify({type: "text", text: "完成"}), 0);
insertPart("p-a2-sf", "msg-asst-2", "sess-a", 4, 4, JSON.stringify({type: "step-finish", reason: "stop"}), 1);
await writeFile(join(zcodeCliDir, "rollout", "model-io-sess-a.jsonl"), `${JSON.stringify({
  requestId: "req-1",
  sessionId: "sess-a",
  turnId: "turn-a1",
  startedAt: new Date(NOW - HOUR).toISOString(),
  request: {
    headers: { "user-agent": "ZCode/3.11.2", "x-zcode-app-version": "3.11.2" },
    body: { model: "GLM-5.3-Flash", max_tokens: 128000, messages: [] },
  },
  response: {
    finishReason: "stop",
    text: "好的",
    responseId: "msg_test_1",
    toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "/tmp/x" } }],
    usage: { inputTokens: 1, outputTokens: 1 },
  },
})}\n`);

/** 绑定推导输入：zcode 默认目标 = 智谱 Coding Plan 官方预设（套餐通道 + zcode scope）。 */
await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify(FIXTURE_PROXY_CONFIG));

/** 价格中心夹具：zhipu 套餐积分规则 + origins 限定的 ×2/3 活动（与目录 zcode.plan.1 同构）。 */
await writeFile(join(dataDir, "config", "model-pricing.json"), JSON.stringify(FIXTURE_PRICING_CONFIG));

const { runAgentLocalImportRound, readAgentLocalImportStatus } = await import(
  "../src/lib/agent-local-source/local-import-scheduler.js"
);

const fixtures: SqliteFixture[] = [];
const workers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()));
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  zcodeDb.close();
  await rm(rootDir, { recursive: true, force: true });
});

function trackedWorker(fixture: SqliteFixture): ReturnType<typeof createIngestionWorker> {
  const worker = createIngestionWorker({
    dataDir: fixture.dataDir,
    ownerId: `worker-local-import-${Math.random().toString(36).slice(2)}`,
  });
  workers.push(worker);
  return worker;
}

/** 用真实的 createSqliteFixture 建库（触发 v32 迁移路径），把导入产物目录指过去。 */
async function createConsumingFixture(): Promise<SqliteFixture> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  await seedConsumerConfig(fixture);
  return fixture;
}

describe("Agent 本地导入端到端", () => {
  test("排重过滤 + 合成落盘 + 状态推进", async () => {
    const imported = await runAgentLocalImportRound({ dataDir, nowMs: NOW });
    // 直连 3 行：2 行命中白名单入账，1 行（glm-4.7）白名单外跳过；网关标记 2 行排重。
    assert.equal(imported, 3);
    const captureDir = join(dataDir, "captures", "v2");
    const files = (await readdir(captureDir)).filter(name => name.startsWith("import-zcode-"));
    assert.equal(files.length, 1);
    const content = await readFile(join(captureDir, files[0]!), "utf8");
    const rows = content.trim().split("\n").map(line => JSON.parse(line) as { exchangeId: string; routing: { agent: string; origin: string } });
    assert.deepEqual(rows.map(row => row.exchangeId), [
      "import-zcode-u-direct-d",  // 跨 session：最新活动 session 优先
      "import-zcode-u-direct-1",  // 同 session 内按完成时间正序
      "import-zcode-u-direct-2",
    ]);
    assert.ok(rows.every(row => row.routing.origin === "agent_local_import" && row.routing.agent === "zcode"));

    const state = new DeepaaDatabase(join(dataDir, "deepaa.sqlite")).prepare(
      `SELECT imported_count, skipped_model_not_provisioned, consecutive_failures,
              backfill_last_record_id, backfill_finished_at, last_started_at
       FROM agent_local_import_state WHERE agent_name = 'zcode'`,
    ).get() as { imported_count: number; skipped_model_not_provisioned: number; consecutive_failures: number;
      backfill_last_record_id: string; backfill_finished_at: string | null; last_started_at: number | null };
    assert.equal(state.imported_count, 3);
    // 模型不在供应商配置面的行在候选查询即排除（账本口径 = 用户显式配置的模型面），
    // 不再产生逐轮计数。
    assert.equal(state.consecutive_failures, 0);
    // pending 余量 = 0 → 收尾标记置位（新行到达自动清除）。
    assert.ok(state.backfill_finished_at !== null);
  });

  test("timeline 过期重载：活跃 session 新请求的上下文重建不降级（2026-09-16 修复）", async () => {
    // 第一轮已导入 u-direct-1/2；此时 zcode 又完成了第三个请求（新的 assistant 消息）。
    const fixture = await createConsumingFixture();
    insertUsage({
      ...baseUsage, id: "u-direct-3", session_id: "sess-a", turn_id: "turn-a3", trace_id: "trace-a",
      parent_user_message_id: "msg-user-2", assistant_message_id: "msg-asst-3",
      query_source: "main_turn", provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash",
      started_at: NOW + 60_000, first_token_at: NOW + 61_000, completed_at: NOW + 66_000, duration_ms: 5_000,
      input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0,
    });
    insertMessage("msg-user-3", "sess-a", 5, 5, JSON.stringify({role: "user", semantics: {providerVisibility: "visible"}}), 4);
    insertMessage("msg-asst-3", "sess-a", 6, 6, JSON.stringify({role: "assistant", time: {completed: 1}, semantics: {providerVisibility: "visible"}}), 5);
    // 注入消息（todo_reminder）：必须回放为 system-reminder 信封 → 预览分类 user_injected
    insertMessage("msg-inj-3", "sess-a", 5, 5, JSON.stringify({role: "user", semantics: {providerVisibility: "visible", origin: "agent_runtime", kind: "todo_reminder"}}), 4);
    insertPart("p-inj-3", "msg-inj-3", "sess-a", 5, 5, JSON.stringify({type: "text", text: "The TodoWrite tool hasn't been used recently."}), 0);
    insertPart("p-u3", "msg-user-3", "sess-a", 5, 5, JSON.stringify({type: "text", text: "第三问"}), 1);
    insertPart("p-a3", "msg-asst-3", "sess-a", 6, 6, JSON.stringify({type: "text", text: "回答三"}), 0);
    insertPart("p-a3-sf", "msg-asst-3", "sess-a", 6, 6, JSON.stringify({type: "step-finish", reason: "stop"}), 1);
    // 预置过期 timeline 缓存（不含 msg-asst-3）——复现活跃 session 的缓存过期场景，
    // 目标缺失必须触发本批内强制重载并成功重建（而不是降级为骨架）。
    const {indexTimeline} = await import("../src/lib/agent-local-source/parts-rebuilder.js");
    const staleCaches = new Map([["sess-a", {
      timeline: indexTimeline({messages: [
        {messageId: "msg-user-1", role: "user" as const, visible: true, finalized: true,
          parts: [{kind: "text" as const, text: "重置重导验证用户输入"}]},
        {messageId: "msg-asst-1", role: "assistant" as const, visible: true, finalized: true,
          parts: [{kind: "text" as const, text: "我来处理"}, {kind: "step_finish" as const, reason: "stop"}]},
      ]}),
    }]]);
    const imported = await runAgentLocalImportRound({ dataDir, nowMs: NOW, sessionCaches: staleCaches });
    assert.equal(imported, 1);
    // 把（含新旧两份的）导入产物复制到消费夹具
    await mkdir(join(fixture.dataDir, "captures", "v2"), {recursive: true});
    for (const name of (await readdir(join(dataDir, "captures", "v2"))).filter(name => name.startsWith("import-"))) {
      await writeFile(join(fixture.dataDir, "captures", "v2", name), await readFile(join(dataDir, "captures", "v2", name)));
    }
    const worker = trackedWorker(fixture);
    assert.equal(worker.acquireLease(), true);
    for (let i = 0; i < 4; i += 1) {
      const batch = await worker.runOneBatch();
      if (batch.processedCount === 0 && batch.discoveredCount === 0) break;
    }
    const jobState = fixture.db.prepare(
      `SELECT j.job_status, j.attempt_count FROM derivation_jobs j
       JOIN ingestion_records ir ON ir.id = j.ingestion_record_id
       JOIN raw_exchange_refs r ON r.exchange_id = ir.exchange_id
       WHERE r.exchange_id = 'import-zcode-u-direct-3'`,
    ).get() as {job_status: string; attempt_count: number} | undefined;
    assert.ok(jobState, `u-direct-3 未登记: ${fixture.db.prepare("SELECT count(*) FROM raw_exchange_refs").pluck().get()}`);
    assert.equal(jobState.job_status, "succeeded", `job=${JSON.stringify(jobState)}`);
    const preview3 = fixture.db.prepare(
      `SELECT p.preview_json FROM exchange_content_previews p
       JOIN raw_exchange_refs r ON r.exchange_id = p.exchange_id
       WHERE r.exchange_id = 'import-zcode-u-direct-3'`,
    ).get() as {preview_json: string} | undefined;
    assert.ok(preview3, "第三请求未派生");
    const items3 = JSON.parse(preview3.preview_json).conversationItems as Array<{semanticCategory?: string; textPreview?: string}>;
    const categories3 = items3.map(item => item.semanticCategory);
    // 上下文回放：第一轮 assistant 文本与工具结果都必须在（timeline 过期重载生效）
    assert.ok(categories3.includes("assistant"), `missing assistant: ${categories3}`);
    assert.ok(categories3.includes("tool_result"), `missing tool_result: ${categories3}`);
    assert.ok(items3.some(item => item.semanticCategory === "user_real" && (item.textPreview ?? "").includes("第三问")),
      `third user input missing: ${categories3}`);
    assert.ok(items3.some(item => item.semanticCategory === "user_real" && (item.textPreview ?? "").includes("重置重导验证用户输入")),
      `first user input missing: ${categories3}`);
    // 注入提醒分类为 user_injected（信封回放），不得冒充真实输入
    assert.ok(items3.some(item => item.semanticCategory === "user_injected"),
      `missing user_injected: ${categories3}`);
    assert.ok(!items3.some(item => item.semanticCategory === "user_real"
      && (item.textPreview ?? "").includes("TodoWrite")), "注入提醒不得标为真实输入");
  });

  test("timeline 空缓存投毒修复：首行无 assistantMessageId 不影响后续行重建", async () => {
    // session_title 行（无 assistant_message_id）先到：曾导致缓存写入 timeline=undefined
    // 且永不重载（整个 session 永久降级）——修复后 main 行必须正常重建。
    insertUsage({
      ...baseUsage, id: "u-title-z", session_id: "sess-e", turn_id: "turn-e0", trace_id: "trace-e",
      query_source: "session_title", provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash",
      started_at: NOW + 90_000, first_token_at: NOW + 90_500, completed_at: NOW + 91_000, duration_ms: 500,
      input_tokens: 200, output_tokens: 8, cache_read_input_tokens: 0,
    });
    // 同 session 的 main 行（后于 title 完成）
    insertUsage({
      ...baseUsage, id: "u-main-z", session_id: "sess-e", turn_id: "turn-e1", trace_id: "trace-e",
      parent_user_message_id: "msg-user-e", assistant_message_id: "msg-asst-e",
      query_source: "main_turn", provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash",
      started_at: NOW + 120_000, first_token_at: NOW + 120_500, completed_at: NOW + 126_000, duration_ms: 5_500,
      input_tokens: 60, output_tokens: 6, cache_read_input_tokens: 0,
    });
    zcodeDb.prepare("INSERT INTO session(id, directory) VALUES ('sess-e', '/tmp/proj-e')").run();
    insertMessage("msg-user-e", "sess-e", 20, 20, JSON.stringify({role: "user", semantics: {providerVisibility: "visible"}}), 0);
    insertMessage("msg-asst-e", "sess-e", 21, 21, JSON.stringify({role: "assistant", time: {completed: 1}, semantics: {providerVisibility: "visible"}}), 1);
    insertPart("p-ue", "msg-user-e", "sess-e", 20, 20, JSON.stringify({type: "text", text: "真实输入E"}), 0);
    insertPart("p-ae", "msg-asst-e", "sess-e", 21, 21, JSON.stringify({type: "text", text: "回答E"}), 0);
    insertPart("p-ae-sf", "msg-asst-e", "sess-e", 21, 21, JSON.stringify({type: "step-finish", reason: "stop"}), 1);

    const imported = await runAgentLocalImportRound({ dataDir, nowMs: NOW });
    assert.equal(imported, 2);
    const fixture = await createConsumingFixture();
    await mkdir(join(fixture.dataDir, "captures", "v2"), {recursive: true});
    for (const name of (await readdir(join(dataDir, "captures", "v2"))).filter(name => name.startsWith("import-"))) {
      await writeFile(join(fixture.dataDir, "captures", "v2", name), await readFile(join(dataDir, "captures", "v2", name)));
    }
    const worker = trackedWorker(fixture);
    assert.equal(worker.acquireLease(), true);
    for (let i = 0; i < 4; i += 1) {
      const result = await worker.runOneBatch();
      if (result.processedCount === 0 && result.discoveredCount === 0) break;
    }
    const previewE = fixture.db.prepare(
      `SELECT p.preview_json FROM exchange_content_previews p
       JOIN raw_exchange_refs r ON r.exchange_id = p.exchange_id
       WHERE r.exchange_id = 'import-zcode-u-main-z'`,
    ).get() as {preview_json: string} | undefined;
    assert.ok(previewE, "u-main-z 未派生");
    const items = JSON.parse(previewE.preview_json).conversationItems as Array<{semanticCategory?: string; textPreview?: string}>;
    assert.ok(items.some(item => item.semanticCategory === "user_real"
      && (item.textPreview ?? "").includes("真实输入E")),
      `真实输入缺失: ${JSON.stringify(items.map(i => i.semanticCategory))}`);
  });

  test("幂等重放：同一轮再跑零新增", async () => {
    const imported = await runAgentLocalImportRound({ dataDir, nowMs: NOW });
    assert.equal(imported, 0);
  });

  test("Worker 派生合成行：origin / usage_source / 账本通道", async () => {
    const fixture = await createConsumingFixture();
    // 把导入产物目录复制到该 fixture 的 captures/v2（导入文件即普通 v2 raw）。
    const captureDir = join(dataDir, "captures", "v2");
    const files = (await readdir(captureDir)).filter(name => name.startsWith("import-zcode-"));
    for (const file of files) {
      const content = await readFile(join(captureDir, file));
      await mkdir(join(fixture.dataDir, "captures", "v2"), { recursive: true });
      await writeFile(join(fixture.dataDir, "captures", "v2", file), content);
    }
    const worker = trackedWorker(fixture);
    assert.equal(worker.acquireLease(), true);
    for (let i = 0; i < 4; i += 1) {
      const result = await worker.runOneBatch();
      if (result.processedCount === 0 && result.discoveredCount === 0) break;
    }

    const refs = fixture.db.prepare(
      "SELECT exchange_id, origin, agent_name FROM raw_exchange_refs ORDER BY exchange_id",
    ).all() as Array<{ exchange_id: string; origin: string; agent_name: string }>;
    assert.equal(refs.length, 6);
    assert.ok(refs.every(row => row.origin === "agent_local_import"));
    assert.ok(refs.every(row => row.agent_name === "zcode"));

    const ledger = fixture.db.prepare(
      `SELECT exchange_id, usage_source, usage_confidence, billing_channel, vendor_family,
              agent_name, plan_credit_cost, plan_credit_unit, input_tokens, cache_read_tokens, output_tokens
       FROM usage_ledger ORDER BY exchange_id`,
    ).all() as Array<Record<string, unknown>>;
    assert.equal(ledger.length, 6);
    for (const row of ledger) {
      assert.equal(row.usage_source, "agent_local_import");
      assert.equal(row.usage_confidence, "client_declared");
      assert.equal(row.billing_channel, "plan");
      assert.equal(row.vendor_family, "zhipu");
      assert.equal(row.agent_name, "zcode");
    }
    // 原生 turn 边界（2026-09-16 修正）：两个 main 行分属 turn-a1/turn-a2 → 两个 turn，
    // 且 turn 首步 request_action = user_prompt（原生 turn 变更即新用户输入）。
    const turns = fixture.db.prepare(
      "SELECT id, native_turn_id, step_count FROM agent_turns ORDER BY start_time",
    ).all() as Array<{ id: string; native_turn_id: string | null; step_count: number }>;
    // 2026-09-17：Agent 自报 query_source=session_title 的请求按辅助请求落库
    // （auxiliary_requests.kind=title_generation），不再自建 Turn——否则它会夹在
    // 主请求之间污染排重链（同一 Turn 内只差几毫秒的 title/main 记录实测踩过）。
    assert.equal(turns.length, 5);
    assert.deepEqual(turns.map(turn => turn.native_turn_id),
      ["turn-a1", "turn-a2", "turn-d1", "turn-a3", "turn-e1"]);
    assert.deepEqual(turns.map(turn => turn.step_count), [1, 1, 1, 1, 1]);
    const auxiliaries = fixture.db.prepare(
      "SELECT exchange_id, kind, agent_turn_id FROM auxiliary_requests ORDER BY exchange_id",
    ).all() as Array<{exchange_id: string; kind: string; agent_turn_id: string | null}>;
    assert.deepEqual(auxiliaries.map(row => [row.exchange_id, row.kind]), [
      ["import-zcode-u-title-z", "title_generation"],
    ]);
    const turnFirstActions = fixture.db.prepare(
      `SELECT DISTINCT s.request_action FROM agent_steps s
       JOIN agent_turns t ON s.agent_turn_id = t.id
       WHERE s.exchange_id = 'import-zcode-u-direct-1' OR s.exchange_id = 'import-zcode-u-direct-2'`,
    ).all() as Array<{ request_action: string }>;
    assert.ok(turnFirstActions.every(row => row.request_action === "user_prompt"),
      JSON.stringify(turnFirstActions));

    const main = ledger.find(row => row.exchange_id === "import-zcode-u-direct-1")!;
    // 口径转换后：非缓存输入 = 42632 − 26624（zcode inputTokens 含缓存）。
    assert.equal(main.input_tokens, 42632 - 26624);
    assert.equal(main.cache_read_tokens, 26624);
    assert.equal(main.output_tokens, 132);
    // Campaign origins 判定（D-3）：直连行命中 ×2/3（zhipu 公式：base/10000 × 2/3，无窗口 → 倍率 1）。
    const expectedBase = ((42632 - 26624) * 2.3 + 26624 * 0.56 + 132 * 8) / 10000;
    assert.ok(Math.abs((main.plan_credit_cost as number) - expectedBase * (2 / 3)) < 1e-9,
      `plan_credit_cost=${main.plan_credit_cost} expected=${expectedBase * (2 / 3)}`);
    assert.equal(main.plan_credit_unit, "积分");

    // 真实用户输入回填（2026-09-16）：合成请求体注入 user 消息 → 预览出现 user_real。
    const firstPreview = fixture.db.prepare(
      `SELECT p.preview_json FROM exchange_content_previews p
       JOIN raw_exchange_refs r ON r.exchange_id = p.exchange_id
       WHERE r.exchange_id = 'import-zcode-u-direct-1'`,
    ).get() as { preview_json: string } | undefined;
    assert.ok(firstPreview);
    const items = JSON.parse(firstPreview.preview_json).conversationItems as Array<{ semanticCategory?: string; textPreview?: string }>;
    const categories = items.map(item => item.semanticCategory);
    const userItem = items.find(item => item.semanticCategory === "user_real");
    assert.ok(userItem, JSON.stringify(categories));
    assert.ok((userItem.textPreview ?? "").includes("重置重导验证用户输入"),
      `textPreview=${userItem.textPreview}`);
    // parts 重建（2026-09-16）：请求/响应全类别。tool_use 在非流式路径的既有规范是
    // 经 tool_calls 表 + 时间线工具标签呈现（与网关链路对照一致，见下方断言）。
    assert.ok(categories.includes("assistant"), `missing assistant: ${categories}`);
    assert.ok(categories.includes("reasoning"), `missing reasoning: ${categories}`);
    // 第二行的请求上下文应回放第一轮的 tool_result（wire 成对约定）
    const preview2Row = fixture.db.prepare(
      `SELECT p.preview_json FROM exchange_content_previews p
       JOIN raw_exchange_refs r ON r.exchange_id = p.exchange_id
       WHERE r.exchange_id = 'import-zcode-u-direct-2'`,
    ).get() as {preview_json: string} | undefined;
    assert.ok(preview2Row);
    const items2 = JSON.parse(preview2Row.preview_json).conversationItems as Array<{semanticCategory?: string; textPreview?: string}>;
    const categories2 = items2.map(item => item.semanticCategory);
    assert.ok(categories2.includes("tool_result"), `missing tool_result: ${categories2}`);
    assert.ok(items2.some(item => item.semanticCategory === "user_real" && (item.textPreview ?? "").includes("继续")),
      `second user input missing: ${categories2}`);

    // 工具名映射修正（2026-09-16）：rollout {id,name,input} 直通投影，不再退化 unknown。
    const toolRow = fixture.db.prepare(
      `SELECT c.tool_name FROM tool_calls c
       JOIN raw_exchange_refs r ON r.exchange_id = c.exchange_id
       WHERE r.exchange_id = 'import-zcode-u-direct-1' LIMIT 1`,
    ).get() as { tool_name: string } | undefined;
    assert.ok(toolRow, "tool_use 未投影为 tool_calls");
    assert.equal(toolRow.tool_name, "Read");
    // 工具调用的 input/output 全量保存在合成 raw 响应体中（tool_use 块）。
    const rawLine = fixture.db.prepare(
      `SELECT ir.byte_offset, ir.line_length_bytes, s.relative_path
       FROM ingestion_records ir
       JOIN ingestion_sources s ON s.id = ir.source_id
       JOIN raw_exchange_refs r ON r.exchange_id = ir.exchange_id
       WHERE r.exchange_id = 'import-zcode-u-direct-1'`,
    ).get() as {byte_offset: number; line_length_bytes: number; relative_path: string} | undefined;
    assert.ok(rawLine);
    const {readFileSync} = await import("node:fs");
    const targetLine = readFileSync(join(fixture.dataDir, rawLine.relative_path), "utf8")
      .split("\n").find(candidate => candidate.includes("u-direct-1")) ?? "";
    const parsedLine = JSON.parse(targetLine) as {response?: {rawBody?: string}};
    const responseBody = parsedLine.response?.rawBody ?? "";
    assert.ok(responseBody.includes('"tool_use"') && responseBody.includes("Read") && responseBody.includes("file_path"),
      `响应体=${responseBody.slice(0, 500)}`);
    // 工具结果（file content）应出现在后续请求的上下文回放中（u-direct-2 的 tool_result）。
    const line2 = readFileSync(join(fixture.dataDir, rawLine.relative_path), "utf8")
      .split("\n").find(candidate => candidate.includes("u-direct-2")) ?? "";
    const request2 = JSON.parse(line2) as {request?: {rawBody?: string}};
    assert.ok((request2.request?.rawBody ?? "").includes("file content"),
      "u-direct-2 请求上下文必须回放第一轮工具结果（tool_result）");
  });

  test("同语义网关行不命中 origins 限定活动（×1 口径）", async () => {
    const fixture = await createConsumingFixture();
    // 与直连行同 token/同 Agent/同目标，但 origin=gateway：活动不得命中。
    const gatewayCaptureSessionId = `capture-v2-${NOW}-abcdef12-345`;
    const gatewayRequestBody = JSON.stringify({ model: "glm-5.3-flash", max_tokens: 128000, messages: [{ role: "user", content: "1111" }] });
    const gatewayResponseBody = JSON.stringify({
      id: "msg_gw", type: "message", role: "assistant", model: "glm-5.3-flash",
      content: [{ type: "text", text: "好的" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 42632, output_tokens: 132, cache_read_input_tokens: 26624, cache_creation_input_tokens: 0 },
    });
    const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
    const gatewayExchange = {
      schemaVersion: 2,
      exchangeId: `${gatewayCaptureSessionId}:ex-1`,
      captureSessionId: gatewayCaptureSessionId,
      sequence: 0,
      capturedAt: new Date(NOW - HOUR).toISOString(),
      completedAt: new Date(NOW - HOUR + 6_000).toISOString(),
      durationMs: 6_000,
      routing: {
        targetId: "zhipu-coding-fixture",
        targetName: "智谱 Coding（夹具）",
        targetFormatHint: "anthropic",
        localUrl: "/zcode/v1/messages",
        upstreamUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
        localPath: "/zcode/v1/messages",
        upstreamPath: "/v1/messages",
        method: "POST",
        routeMode: "model",
        agent: "zcode",
        wireApi: "messages",
      },
      request: {
        headers: {
          "user-agent": "ZCode/3.11.2",
          "x-zcode-trace-id": "trace-gw",
          "x-session-id": "sess-gw",
          "x-zcode-session-type": "main",
        },
        rawBody: gatewayRequestBody,
        bodySizeBytes: Buffer.byteLength(gatewayRequestBody),
        bodySha256: sha256(gatewayRequestBody),
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        rawBody: gatewayResponseBody,
        bodySizeBytes: Buffer.byteLength(gatewayResponseBody),
        bodySha256: sha256(gatewayResponseBody),
        isStreaming: false,
      },
      bodyStorage: { policy: "inline" },
      captureDiagnostics: [],
      security: { containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true },
    };
    await appendRawCapturedExchangeV2(fixture.dataDir, gatewayExchange as never);
    const worker = trackedWorker(fixture);
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();

    const row = fixture.db.prepare(
      "SELECT plan_credit_cost, usage_source FROM usage_ledger WHERE exchange_id = ?",
    ).get(`${gatewayCaptureSessionId}:ex-1`) as { plan_credit_cost: number; usage_source: string };
    const gatewayRefOrigin = fixture.db.prepare(
      "SELECT origin FROM raw_exchange_refs WHERE exchange_id = ?",
    ).get(`${gatewayCaptureSessionId}:ex-1`) as { origin: string };
    assert.equal(gatewayRefOrigin.origin, "gateway");
    assert.equal(row.usage_source, "provider_usage");
    const expectedBase = (42632 * 2.3 + 26624 * 0.56 + 132 * 8) / 10000;
    // 网关行不命中 ×2/3：账本按全量积分记账（与官方「经网关不享」实扣一致）。
    assert.ok(Math.abs(row.plan_credit_cost - expectedBase) < 1e-9,
      `plan_credit_cost=${row.plan_credit_cost} expected=${expectedBase}`);
  });

  test("供应商创建时间门禁：目标建立之前的请求不导入（2026-09-16 用户确认）", async () => {
    // 独立夹具：目标 createdAt = NOW（晚于 u-direct-1/2/3 的完成时刻，早于 u-direct-d）
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await mkdir(join(fixture.dataDir, "config"), {recursive: true});
    await seedConsumerConfig(fixture);
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      ...FIXTURE_PROXY_CONFIG,
      targets: [{...FIXTURE_PROXY_CONFIG.targets[0], createdAt: new Date(NOW).toISOString()}],
    }));
    const imported = await runAgentLocalImportRound({dataDir: fixture.dataDir, nowMs: NOW});
    // floor = max(now-30d, createdAt=NOW) → NOW 之前完成的行全部排除；
    // createdAt 之后完成的 u-direct-3/d + u-title-z/u-main-z（新到行）正常入账。
    assert.equal(imported, 4, `imported=${imported}`);
    // 合成文件行序 = 导入处理顺序（sess-d 最新在前；u-direct-1/2/3 被 createdAt 门禁排除）
    const gateDir = join(fixture.dataDir, "captures", "v2");
    const gateLines = (await readdir(gateDir)).filter(name => name.startsWith("import-zcode-"));
    const gateExchanges = (await readFile(join(gateDir, gateLines[0]!), "utf8"))
      .trim().split("\n")
      .map(line => (JSON.parse(line) as {exchangeId: string}).exchangeId);
    assert.deepEqual(gateExchanges.sort(), [
      "import-zcode-u-direct-3",
      "import-zcode-u-direct-d",
      "import-zcode-u-main-z",
      "import-zcode-u-title-z",
    ]);
    // 状态透出下界
    const status = await readAgentLocalImportStatus(fixture.dataDir);
    const zcode = status.find(entry => entry.agentId === "zcode");
    assert.equal(zcode?.binding.floorEpochMs, NOW);
  });

  test("默认目标指向第三方时仍导入并归因官方预设目标（2026-10-06 修复）", async () => {
    // 事故形态：zcode 默认目标 = 火山套餐目标，智谱 Coding Plan 官方目标存在、启用、
    // 模型 scope 含 zcode——旧规则判定 disabled，直连导入整体静默停止且状态表冻结。
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await mkdir(join(fixture.dataDir, "config"), {recursive: true});
    await seedConsumerConfig(fixture);
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      ...FIXTURE_PROXY_CONFIG,
      agentConnections: {zcode: {defaultTargetId: "volces-fixture", enabled: true}},
      targets: [
        {
          id: "volces-fixture",
          name: "火山（夹具）",
          presetId: "volcengine-plan",
          billingChannel: "plan",
          vendorFamily: "volcengine",
          enabled: true,
          supportedModels: ["glm-5.3-flash"],
          supportedModelScopes: {"glm-5.3-flash": ["zcode"]},
        },
        FIXTURE_PROXY_CONFIG.targets[0],
      ],
    }));
    const imported = await runAgentLocalImportRound({dataDir: fixture.dataDir, nowMs: NOW});
    assert.ok(imported > 0, `imported=${imported}`);
    // 全部合成行归因到智谱官方预设目标（不是默认的火山目标）。
    const captureDir = join(fixture.dataDir, "captures", "v2");
    const importFiles = (await readdir(captureDir)).filter(name => name.startsWith("import-zcode-"));
    assert.ok(importFiles.length > 0, "必须产生导入 capture 文件");
    for (const name of importFiles) {
      const lines = (await readFile(join(captureDir, name), "utf8")).trim().split("\n");
      for (const line of lines) {
        const row = JSON.parse(line) as {routing: {targetId: string; origin: string}};
        assert.equal(row.routing.origin, "agent_local_import");
        assert.equal(row.routing.targetId, "zhipu-coding-fixture");
      }
    }
    const status = await readAgentLocalImportStatus(fixture.dataDir);
    const zcode = status.find(entry => entry.agentId === "zcode");
    assert.equal(zcode?.binding.state, "bound");
    assert.equal(zcode?.binding.targetId, "zhipu-coding-fixture");
    assert.equal(zcode?.binding.viaDefaultTarget, false);
  });

  test("状态查询只读可用", async () => {
    const status = await readAgentLocalImportStatus(dataDir);
    const zcode = status.find(entry => entry.agentId === "zcode");
    assert.ok(zcode);
    assert.equal(zcode.binding.state, "bound");
    assert.equal(zcode.binding.targetId, "zhipu-coding-fixture");
    assert.equal(zcode.source?.state, "available");
    assert.equal(zcode.importState?.importedCount, 6);
    // skipped 模型行在候选查询即排除，不再逐轮计数（列保留兼容，恒 0）。
    assert.equal(zcode.importState?.skippedModelNotProvisioned, 0);
  });

  test("zcode 0.16.5 account: provider 命名切换：新白名单入账，体验套餐/第三方 account 仍排除（2026-09-28）", async () => {
    // 0.16.5 实测：直连用量 provider_id 由 builtin:bigmodel-coding-plan 改为
    // account:bigmodel-individual-coding-plan——白名单必须双值兼容，否则升级后
    // 新会话静默零候选、零导入（候选 SQL 即排除，无任何报错）。
    zcodeDb.prepare("INSERT INTO session(id, directory) VALUES ('sess-acc', '/tmp/proj-acc')").run();
    insertMessage("msg-user-acc", "sess-acc", 40, 40, JSON.stringify({role: "user", semantics: {providerVisibility: "visible"}}), 0);
    insertMessage("msg-asst-acc", "sess-acc", 41, 41, JSON.stringify({role: "assistant", time: {completed: 1}, semantics: {providerVisibility: "visible"}}), 1);
    insertPart("p-uacc", "msg-user-acc", "sess-acc", 40, 40, JSON.stringify({type: "text", text: "升级后的新会话"}), 0);
    insertPart("p-aacc", "msg-asst-acc", "sess-acc", 41, 41, JSON.stringify({type: "text", text: "回答"}), 0);
    insertPart("p-aacc-sf", "msg-asst-acc", "sess-acc", 41, 41, JSON.stringify({type: "step-finish", reason: "stop"}), 1);
    insertUsage({
      ...baseUsage, id: "u-account-direct", session_id: "sess-acc", turn_id: "turn-acc1", trace_id: "trace-acc",
      parent_user_message_id: "msg-user-acc", assistant_message_id: "msg-asst-acc",
      query_source: "main_turn", provider_id: "account:bigmodel-individual-coding-plan", model_id: "GLM-5.3-Flash",
      started_at: NOW + 140_000, first_token_at: NOW + 141_000, completed_at: NOW + 146_000, duration_ms: 6_000,
      input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0,
    });
    // 体验套餐 / 第三方自建 account 条目：两套命名下都必须排除。
    insertUsage({
      ...baseUsage, id: "u-account-start", session_id: "sess-acc", turn_id: "turn-acc2", trace_id: "trace-acc",
      query_source: "main_turn", provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash",
      started_at: NOW + 150_000, completed_at: NOW + 156_000, duration_ms: 6_000,
      input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0,
    });
    insertUsage({
      ...baseUsage, id: "u-account-custom", session_id: "sess-acc", turn_id: "turn-acc3", trace_id: "trace-acc",
      query_source: "main_turn", provider_id: "account:custom-third-party", model_id: "GLM-5.3-Flash",
      started_at: NOW + 160_000, completed_at: NOW + 166_000, duration_ms: 6_000,
      input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0,
    });
    const imported = await runAgentLocalImportRound({ dataDir, nowMs: NOW });
    assert.equal(imported, 1, "只允许 account:bigmodel-individual-coding-plan 入账");
    const captureDir = join(dataDir, "captures", "v2");
    for (const name of await readdir(captureDir)) {
      if (!name.startsWith("import-zcode-")) continue;
      const content = await readFile(join(captureDir, name), "utf8");
      assert.ok(!content.includes("u-account-start"), "体验套餐 account 命名不得入账");
      assert.ok(!content.includes("u-account-custom"), "第三方 account 条目不得入账");
    }
    // 端到端：新 provider 行经 Worker 派生进入账本（Token 价格页链路）。
    const fixture = await createConsumingFixture();
    await mkdir(join(fixture.dataDir, "captures", "v2"), {recursive: true});
    for (const name of (await readdir(captureDir)).filter(name => name.startsWith("import-"))) {
      await writeFile(join(fixture.dataDir, "captures", "v2", name), await readFile(join(captureDir, name)));
    }
    const worker = trackedWorker(fixture);
    assert.equal(worker.acquireLease(), true);
    for (let i = 0; i < 4; i += 1) {
      const result = await worker.runOneBatch();
      if (result.processedCount === 0 && result.discoveredCount === 0) break;
    }
    const ledgerRow = fixture.db.prepare(
      `SELECT usage_source, usage_confidence, billing_channel FROM usage_ledger
       WHERE exchange_id = 'import-zcode-u-account-direct'`,
    ).get() as {usage_source: string; usage_confidence: string; billing_channel: string} | undefined;
    assert.ok(ledgerRow, "account provider 行未入账本");
    assert.equal(ledgerRow.usage_source, "agent_local_import");
    assert.equal(ledgerRow.usage_confidence, "client_declared");
    assert.equal(ledgerRow.billing_channel, "plan");
  });
});

describe("终态闸门时间窗（2026-09-22：轮次上限 → 30s 时长，与节拍解耦）", () => {
  test("窗口内连续 7 轮重试仍顺延（旧 6 轮上限会在第 7 轮降级）；超 30s 才降级导入", async () => {
    // 新会话：assistant 消息只有 text part、无 step-finish 终态标记 → 重建永远非终态。
    const completedAt = NOW + 180_000;
    insertUsage({
      ...baseUsage, id: "u-finality-gate", session_id: "sess-finality", turn_id: "turn-f1",
      trace_id: "trace-f", parent_user_message_id: "msg-user-f", assistant_message_id: "msg-asst-f",
      query_source: "main_turn", provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash",
      started_at: completedAt - 6_000, first_token_at: completedAt - 5_000,
      completed_at: completedAt, duration_ms: 6_000,
      input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0,
    });
    zcodeDb.prepare("INSERT INTO session(id, directory) VALUES ('sess-finality', '/tmp/proj-f')").run();
    insertMessage("msg-user-f", "sess-finality", 30, 30, JSON.stringify({role: "user", semantics: {providerVisibility: "visible"}}), 0);
    insertMessage("msg-asst-f", "sess-finality", 31, 31, JSON.stringify({role: "assistant", semantics: {providerVisibility: "visible"}}), 1);
    insertPart("p-uf", "msg-user-f", "sess-finality", 30, 30, JSON.stringify({type: "text", text: "终态闸门验证"}), 0);
    insertPart("p-af", "msg-asst-f", "sess-finality", 31, 31, JSON.stringify({type: "text", text: "尚无 step-finish"}), 0);

    const finalityExchangeId = "import-zcode-u-finality-gate";
    const finalityRowImported = async (): Promise<boolean> => {
      const captureDir = join(dataDir, "captures", "v2");
      if (!existsSync(captureDir)) return false;
      for (const name of await readdir(captureDir)) {
        if (!name.startsWith("import-zcode-")) continue;
        const content = await readFile(join(captureDir, name), "utf8");
        if (content.includes(`"exchangeId":"${finalityExchangeId}"`)) return true;
      }
      return false;
    };
    // 调度器语义：finalityDeferrals/sessionCaches 跨轮持久（tick 持有同一 Map）。
    const sessionCaches = new Map();
    const finalityDeferrals = new Map<string, number>();

    // 窗口内连续 7 轮（每轮 +3s，累计 18s < 30s）：全部顺延、不写导入产物。
    // 旧「6 轮上限」实现此时已降级导入——本断言锁死「按时长不按轮次」语义。
    for (let round = 0; round < 7; round += 1) {
      await runAgentLocalImportRound({
        dataDir,
        sessionCaches,
        finalityDeferrals,
        nowMs: NOW + round * 3_000,
      });
      assert.equal(await finalityRowImported(), false, `第 ${round + 1} 轮（窗口内）不得降级导入`);
    }

    // 超窗（距首延 31s > 30s）：按现状降级导入（幂等 seen 兜底在此之后生效）。
    await runAgentLocalImportRound({
      dataDir,
      sessionCaches,
      finalityDeferrals,
      nowMs: NOW + 31_000,
    });
    assert.equal(await finalityRowImported(), true, "超过 30s 等待窗后必须降级导入，不得无限顺延");
  });
});
