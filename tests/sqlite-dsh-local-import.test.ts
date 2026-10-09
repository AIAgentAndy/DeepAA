/**
 * dsh 双链路端到端（2026-09-17，隔离数据目录 + 隔离 DSH_CLI_DIR，绝不触碰真实
 * ~/.deepaa 与 ~/.dsh）：
 * - 官方直连步骤 → 合成 chat_completions capture（zcode 模式后链路零分叉）；
 * - 经网关步骤（provider=deepaa-gateway）→ 不入账，仅身份标注落库（responseId
 *   → session/turn/step），供 Worker 把原生身份回填给网关捕获行；
 * - 模型白名单（绑定目标 supportedModelScopes）外的本地记录不入候选；
 * - 子代理会话（parentSession）在身份覆写下折入父会话（thread-identity 纯函数验证）。
 */

import assert from "node:assert/strict";
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile, copyFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, describe, test} from "node:test";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {createHash} from "node:crypto";

const NOW = 1789610247831;

const rootDir = await mkdtemp(join(tmpdir(), "deepaa-dsh-import-"));
const dataDir = join(rootDir, "deepaa");
const dshCliDir = join(rootDir, "dsh");
process.env.DSH_CLI_DIR = dshCliDir;

await mkdir(join(dataDir, "config"), {recursive: true});
await writeFile(join(dataDir, "config", "retention.json"), JSON.stringify({version: 1, rawRetentionDays: 180}) + "\n");
await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify({
  version: 3,
  revision: 1,
  updatedAt: new Date(NOW).toISOString(),
  localProxyBaseUrl: "http://localhost:3211",
  agentConnections: {dsh: {defaultTargetId: "deepseek-fixture", enabled: true}},
  targets: [{
    id: "deepseek-fixture",
    name: "DeepSeek（夹具）",
    presetId: "deepseek",
    billingChannel: "pay_as_you_go",
    vendorFamily: "deepseek",
    enabled: true,
    supportedModels: ["deepseek-chat"],
    supportedModelScopes: {"deepseek-chat": ["dsh"]},
    development: {defaultCredentials: {dsh: "cred-dsh-fixture"}},
  }],
}));

// 会话文件落位：workspace 目录 + 会话 UUID 目录 + session.v3.jsonl.zstd。
const workspaceDir = join(dshCliDir, "sessions", "--tmp-proj--", "sess-dsh-fixture-0001");
await mkdir(workspaceDir, {recursive: true});
await copyFile(
  join(import.meta.dirname, "fixtures", "dsh", "session.v3.jsonl.zstd"),
  join(workspaceDir, "session.v3.jsonl.zstd"),
);
// 子会话（parentSession 折叠 + 官方直连无 responseId 形态）夹具。
const childDir = join(dshCliDir, "sessions", "--tmp-proj--", "sess-dsh-child-0002");
await mkdir(childDir, {recursive: true});
await copyFile(
  join(import.meta.dirname, "fixtures", "dsh-child", "session.v3.jsonl.zstd"),
  join(childDir, "session.v3.jsonl.zstd"),
);

const {runAgentLocalImportRound, readAgentLocalImportStatus} = await import(
  "../src/lib/agent-local-source/local-import-scheduler.js"
);
const {readAgentScanReadiness, resetAgentScanReadinessForTests} = await import(
  "../src/lib/agent-local-source/scan-readiness.js"
);
const {openDeepaaDatabase} = await import("../src/lib/db/connection.js");

after(async () => {
  await rm(rootDir, {recursive: true, force: true});
  delete process.env.DSH_CLI_DIR;
});

describe("本地原生身份覆写（thread-identity 纯函数）", () => {
  test("子代理会话折入父会话并挂根 Thread；原生 turn 键可推导", async () => {
    const { resolveAgentPath } = await import("../src/lib/ingestion/thread-identity.js");
    const { applyAgentLocalIdentityOverride } = await import("../src/lib/ingestion/thread-identity.js");
    const base = resolveAgentPath({
      exchangeId: "x",
      captureSessionId: "cap",
      routing: {
        targetId: "deepseek-fixture", targetName: "deepseek", targetFormatHint: "openai",
        localUrl: "/dsh/v1/chat/completions", upstreamUrl: "https://api.deepseek.com/v1/chat/completions",
        localPath: "/dsh/v1/chat/completions", upstreamPath: "/v1/chat/completions",
        method: "POST", agent: "dsh", wireApi: "chat_completions",
      },
      request: {headers: {}, rawBody: "{}", parsedBody: {}, bodySizeBytes: 2, bodySha256: "0".repeat(64)},
      response: {status: 200, statusText: "OK", headers: {}, rawBody: "{}", parsedBody: {}, bodySizeBytes: 2, bodySha256: "1".repeat(64), isStreaming: false},
    } as never);

    // 顶层会话：自成 Session，根 Thread。
    const top = applyAgentLocalIdentityOverride(base, {externalSessionId: "sess-parent"});
    assert.equal(top.path.sessionSource, "session-header");
    assert.equal(top.path.confidence, "exact");
    assert.equal(top.path.isRootThread, true);
    assert.equal(top.nativeTurnId, undefined);

    // 子代理会话：折入父 Session，Thread 挂父的根，原生 turn 键携带会话与序号。
    const child = applyAgentLocalIdentityOverride(base, {
      externalSessionId: "sess-child",
      parentExternalSessionId: "sess-parent",
      turnNumber: 2,
    });
    assert.equal(child.path.agentSessionId, top.path.agentSessionId);
    assert.notEqual(child.path.agentThreadId, top.path.agentThreadId);
    assert.equal(child.path.parentAgentThreadId, top.path.rootAgentThreadId);
    assert.equal(child.path.isRootThread, false);
    assert.ok(child.path.displayName!.includes("sess-chi"));
    assert.equal(child.nativeTurnId, "sess-child:turn:2");
  });
});

describe("dsh 双链路（直连导入关闭：仅身份标注 + 网关行原生身份回填）", () => {
  test("插件开关声明：dsh 默认关直连导入，zcode 显式开启", async () => {
    const {AGENT_LOCAL_SOURCE_ADAPTERS} = await import("../src/lib/agent-local-source/registry.js");
    const dsh = AGENT_LOCAL_SOURCE_ADAPTERS.find(adapter => adapter.agentId === "dsh");
    const zcode = AGENT_LOCAL_SOURCE_ADAPTERS.find(adapter => adapter.agentId === "zcode");
    assert.equal(dsh?.directImportEnabled, false, "dsh 直连与代理计费同价，默认仅身份标注");
    assert.equal(zcode?.directImportEnabled, true, "zcode 直连权益必需，直连导入必须开启");
  });

  test("直连导入关闭：不合成 capture、不入账、不写 seen；身份标注照常落库", async () => {
    const imported = await runAgentLocalImportRound({dataDir, nowMs: NOW + 60_000});
    // 直连步（主会话 t1_s1 + 子会话 2 步）全部不入账；网关 step2 本就不入账。
    assert.equal(imported, 0);

    const captureDir = join(dataDir, "captures", "v2");
    const files = existsSync(captureDir)
      ? (await readdir(captureDir)).filter(name => name.startsWith("import-dsh-"))
      : [];
    assert.equal(files.length, 0, "直连导入关闭后不得产生任何导入 capture 文件");

    // 身份标注照常落库：扫描覆盖全部带 responseId 的步骤（直连与网关步骤都记录）。
    const db = new DeepaaDatabase(join(dataDir, "deepaa.sqlite"));
    try {
      const links = db.prepare(
        "SELECT response_id, external_session_id, turn_number, step_number FROM agent_local_identity_links ORDER BY response_id",
      ).all() as Array<{response_id: string; external_session_id: string; turn_number: number; step_number: number}>;
      assert.deepEqual(links, [
        {response_id: "resp-direct-0001", external_session_id: "sess-dsh-fixture-0001", turn_number: 1, step_number: 1},
        {response_id: "resp-gateway-0001", external_session_id: "sess-dsh-fixture-0001", turn_number: 1, step_number: 2},
      ]);
      // 不入账 ⇒ seen 反联表保持为空。
      const seen = db.prepare("SELECT exchange_id FROM agent_local_import_seen").all();
      assert.equal(seen.length, 0);
    } finally {
      db.close();
    }

    const status = await readAgentLocalImportStatus(dataDir);
    const dshStatus = status.find(entry => entry.agentId === "dsh");
    assert.ok(dshStatus);
    assert.equal(dshStatus.binding.state, "bound");
    assert.equal(dshStatus.source?.state, "available");
  });

  test("幂等重放：关闭状态下持续零导入", async () => {
    const imported = await runAgentLocalImportRound({dataDir, nowMs: NOW + 120_000});
    assert.equal(imported, 0);
    void openDeepaaDatabase;
  });

  test("默认目标非 deepseek 时身份标注照常（2026-10-06 修复）", async () => {
    // 事故形态：dsh 默认目标 = 第三方预设目标，deepseek 官方目标存在且启用——旧规则
    // 判定 disabled 后连身份标注都停止，网关行降级 dsh_identity_missing（匿名兜底会话）。
    const configPath = join(dataDir, "proxy-config.json");
    const original = await readFile(configPath, "utf8");
    const modified = JSON.parse(original) as {
      agentConnections: {dsh: {defaultTargetId: string; enabled: boolean}};
      targets: unknown[];
    };
    modified.agentConnections.dsh.defaultTargetId = "opencode-go-fixture";
    modified.targets.push({
      id: "opencode-go-fixture",
      name: "OpenCode Go（夹具）",
      presetId: "opencode-go",
      billingChannel: "plan",
      vendorFamily: "opencode",
      enabled: true,
      supportedModels: ["deepseek-chat"],
      supportedModelScopes: {"deepseek-chat": ["dsh"]},
    });
    try {
      await writeFile(configPath, JSON.stringify(modified));
      // 删掉一条已落库标注再跑一轮：绑定仍指向 deepseek 目标 → 扫描照常、标注重建。
      const db = new DeepaaDatabase(join(dataDir, "deepaa.sqlite"));
      try {
        db.prepare("DELETE FROM agent_local_identity_links WHERE response_id = 'resp-gateway-0001'").run();
      } finally {
        db.close();
      }
      const imported = await runAgentLocalImportRound({dataDir, nowMs: NOW + 150_000});
      assert.equal(imported, 0, "dsh 直连导入保持关闭，不因绑定解耦而入账");
      const verify = new DeepaaDatabase(join(dataDir, "deepaa.sqlite"));
      try {
        const link = verify.prepare(
          "SELECT external_session_id, turn_number, step_number FROM agent_local_identity_links WHERE response_id = 'resp-gateway-0001'",
        ).get() as {external_session_id: string; turn_number: number; step_number: number} | undefined;
        assert.ok(link, "扫描轮必须重建被删除的身份标注");
        assert.equal(link.external_session_id, "sess-dsh-fixture-0001");
        assert.equal(link.turn_number, 1);
        assert.equal(link.step_number, 2);
      } finally {
        verify.close();
      }
      const status = await readAgentLocalImportStatus(dataDir);
      const dshStatus = status.find(entry => entry.agentId === "dsh");
      assert.equal(dshStatus?.binding.state, "bound");
      assert.equal(dshStatus?.binding.targetId, "deepseek-fixture");
      assert.equal(dshStatus?.binding.viaDefaultTarget, false);
    } finally {
      await writeFile(configPath, original);
    }
  });

  test("Worker 派生：网关行经标注回填原生身份与原生 step id；无直连行、无重复入账", async () => {
    const {appendRawCapturedExchangeV2} = await import("../src/proxy/capture-writer.js");
    const gatewayCaptureSessionId = "capture-v2-1789610247831-abcdef12-345";
    const {createIngestionWorker} = await import("../src/lib/ingestion/worker.js");
    const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
    // 真实网关捕获形态：response.id = resp-gateway-0001（已在标注表）。
    const requestBody = JSON.stringify({model: "deepseek-flash", messages: [
      {role: "system", content: "You are an AI agent powered by DeepSeek Harness."},
      {role: "user", content: "这是啥项目？ 只读分析。"},
      {role: "assistant", content: "", tool_calls: [{id: "call_00_abc", type: "function", function: {name: "bash", arguments: "{}"}}]},
      {role: "tool", tool_call_id: "call_00_abc", content: "file-a\nfile-b"},
    ]});
    const responseBody = JSON.stringify({
      id: "resp-gateway-0001", object: "chat.completion", model: "deepseek-flash",
      choices: [{index: 0, message: {role: "assistant", content: "经网关的收尾回答。"}, finish_reason: "stop"}],
      usage: {prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, prompt_cache_hit_tokens: 50},
    });
    await appendRawCapturedExchangeV2(dataDir, {
      schemaVersion: 2,
      exchangeId: `${gatewayCaptureSessionId}:ex-1`,
      captureSessionId: gatewayCaptureSessionId,
      sequence: 0,
      capturedAt: new Date(NOW + 2_000).toISOString(),
      completedAt: new Date(NOW + 8_000).toISOString(),
      durationMs: 6_000,
      routing: {
        targetId: "deepseek-fixture", targetName: "DeepSeek（夹具）", targetFormatHint: "openai",
        localUrl: "/dsh/v1/chat/completions", upstreamUrl: "https://api.deepseek.com/v1/chat/completions",
        localPath: "/dsh/v1/chat/completions", upstreamPath: "/v1/chat/completions",
        method: "POST", routeMode: "model", agent: "dsh", wireApi: "chat_completions",
      },
      request: {
        headers: {"user-agent": "deepseek-harness/0.1.5-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)"},
        rawBody: requestBody,
        bodySizeBytes: Buffer.byteLength(requestBody),
        bodySha256: sha256(requestBody),
      },
      response: {
        status: 200, statusText: "OK", headers: {},
        rawBody: responseBody,
        bodySizeBytes: Buffer.byteLength(responseBody),
        bodySha256: sha256(responseBody),
        isStreaming: false,
      },
      bodyStorage: {policy: "inline"},
      captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    } as never);

    const worker = createIngestionWorker({dataDir, ownerId: "worker-dsh-identity"});
    try {
      assert.equal(worker.acquireLease(), true);
      for (let i = 0; i < 4; i += 1) {
        const batch = await worker.runOneBatch();
        if (batch.processedCount === 0 && batch.discoveredCount === 0) break;
      }
    } finally {
      await worker.close();
    }
    const db = new DeepaaDatabase(join(dataDir, "deepaa.sqlite"));
    try {
      // 网关行是唯一入账路径：会话/线程/步骤全部来自 wire 捕获 + 标注回填。
      const sessions = db.prepare(
        "SELECT id, external_session_id, confidence, source FROM agent_sessions WHERE agent_name = 'dsh'",
      ).all() as Array<{id: string; external_session_id: string; confidence: string; source: string}>;
      assert.equal(sessions.length, 1, `sessions=${JSON.stringify(sessions)}`);
      assert.equal(sessions[0]!.external_session_id, "sess-dsh-fixture-0001");
      assert.equal(sessions[0]!.confidence, "exact");

      const steps = db.prepare(
        `SELECT st.exchange_id, st.identity_source, st.identity_confidence,
          st.native_step_id, r.origin
         FROM agent_steps st
         JOIN raw_exchange_refs r ON r.exchange_id = st.exchange_id
         ORDER BY st.exchange_id`,
      ).all() as Array<{exchange_id: string; identity_source: string; identity_confidence: string; native_step_id: string | null; origin: string}>;
      assert.equal(steps.length, 1, `steps=${JSON.stringify(steps)}`);
      assert.equal(steps[0]!.origin, "gateway");
      assert.equal(steps[0]!.identity_source, "native-header");
      assert.equal(steps[0]!.identity_confidence, "exact");
      // 原生 step 键由标注 step_number 物化（session:step:N）。
      assert.equal(steps[0]!.native_step_id, "sess-dsh-fixture-0001:step:2");

      // 账本单行、来源网关：直连流量已关闭，不存在 import 来源行（无重复入账）。
      const ledger = db.prepare(
        "SELECT usage_source FROM usage_ledger",
      ).all() as Array<{usage_source: string}>;
      assert.deepEqual(ledger.map(row => row.usage_source), ["provider_usage"]);

      // 直连子会话从未导入：不得出现。
      const dupChildSession = db.prepare(
        "SELECT COUNT(*) AS n FROM agent_sessions WHERE external_session_id = 'sess-dsh-child-0002'",
      ).get() as {n: number};
      assert.equal(dupChildSession.n, 0, "直连导入关闭后子会话不得入账");

      // 关闭直连导入不影响身份标注链路：无 identity missing 误报。
      const identityDiags = db.prepare(
        "SELECT code FROM derivation_diagnostics WHERE code = 'dsh_identity_missing'",
      ).all();
      assert.equal(identityDiags.length, 0);
    } finally {
      db.close();
    }
  });

  test("扫描就绪门控（2026-09-22）：一轮扫描后待索引归零并置收敛信号", async () => {
    resetAgentScanReadinessForTests();
    const {AGENT_LOCAL_SOURCE_ADAPTERS} = await import("../src/lib/agent-local-source/registry.js");
    const dsh = AGENT_LOCAL_SOURCE_ADAPTERS.find(adapter => adapter.agentId === "dsh");
    assert.ok(dsh?.reportScanStatus, "dsh 适配器必须实现 reportScanStatus");

    await runAgentLocalImportRound({dataDir});

    // 夹具会话全部索引（未变化文件零解压）→ 待索引余量必须归零。
    assert.equal(
      dsh!.reportScanStatus!().pendingIndexFiles,
      0,
      "全部索引后待索引文件数必须为 0（收敛）",
    );
    // 调度器在收敛轮必须置位信号：派生侧旧行的等待边界到此为止。
    const readiness = readAgentScanReadiness("dsh");
    assert.ok(readiness?.convergedAt, "调度器必须在收敛轮置位 convergedAt");
  });

});
