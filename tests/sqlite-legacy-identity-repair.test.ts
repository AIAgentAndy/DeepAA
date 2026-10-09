/**
 * 批次 3 存量重挂（2026-09-18）：旧指纹 donor 会话定向重放修复。
 * 隔离数据目录，绝不触碰真实 ~/.deepaa。
 * 流程：真实管线落盘+派生 → 人为把会话指纹改成 2026-09-17 统一前的旧复合形态
 * （模拟存量）→ repair 模块定向重放 → 断言并回规范会话、计数一致、donor 清空。
 */

import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, describe, test} from "node:test";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";

const NOW = 1789700000000;

const rootDir = await mkdtemp(join(tmpdir(), "deepaa-legacy-repair-"));
const dataDir = join(rootDir, "deepaa");
await mkdir(join(dataDir, "config"), {recursive: true});
await writeFile(join(dataDir, "config", "retention.json"), JSON.stringify({version: 1, rawRetentionDays: 180}) + "\n");
await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify({
  version: 3,
  revision: 1,
  updatedAt: new Date(NOW).toISOString(),
  localProxyBaseUrl: "http://localhost:3211",
  agentConnections: {},
  targets: [],
}));

const {appendRawCapturedExchangeV2} = await import("../src/proxy/capture-writer.js");
const {createIngestionWorker} = await import("../src/lib/ingestion/worker.js");
const {
  analyzeLegacyIdentityDonorSessions,
  reprojectLegacyIdentitySessions,
} = await import("../src/lib/ingestion/legacy-identity-repair.js");

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

interface CaptureInput {
  sequence: number;
  userText: string;
  replyText: string;
}

async function appendClaudeCapture(input: CaptureInput): Promise<void> {
  const captureSessionId = `capture-v2-${NOW + input.sequence}-aaaabbbb-ccc`;
  const requestBody = JSON.stringify({
    model: "claude-fixture",
    system: "You are Claude Code.",
    messages: [{role: "user", content: [{type: "text", text: input.userText}]}],
  });
  const responseBody = JSON.stringify({
    id: `msg_${input.sequence}`,
    type: "message",
    role: "assistant",
    model: "claude-fixture",
    content: [{type: "text", text: input.replyText}],
    stop_reason: "end_turn",
    usage: {input_tokens: 100, output_tokens: 20},
  });
  await appendRawCapturedExchangeV2(dataDir, {
    schemaVersion: 2,
    exchangeId: `${captureSessionId}:ex-1`,
    captureSessionId,
    sequence: 0,
    capturedAt: new Date(NOW + input.sequence * 1_000).toISOString(),
    completedAt: new Date(NOW + input.sequence * 1_000 + 500).toISOString(),
    durationMs: 500,
    routing: {
      targetId: "catapi.chat", targetName: "catapi", targetFormatHint: "anthropic",
      localUrl: "/claude/v1/messages", upstreamUrl: "https://catapi.example/v1/messages",
      localPath: "/claude/v1/messages", upstreamPath: "/v1/messages",
      method: "POST", routeMode: "model", agent: "claude", wireApi: "messages",
    },
    request: {
      headers: {
        "user-agent": "claude-cli/2.0.0 (external)",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "sess-legacy-repair-0001",
      },
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: sha256(requestBody),
    },
    response: {
      status: 200, statusText: "OK", headers: {"content-type": "application/json"},
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: sha256(responseBody),
      isStreaming: false,
    },
    bodyStorage: {policy: "inline"},
    captureDiagnostics: [],
    security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
  } as never);
}

after(async () => {
  await rm(rootDir, {recursive: true, force: true});
});

describe("批次 3：旧指纹 donor 会话定向重放", () => {
  test("派生 → 模拟旧指纹 → 重放并回规范会话", async () => {
    await appendClaudeCapture({sequence: 1, userText: "第一问", replyText: "答一"});
    await appendClaudeCapture({sequence: 2, userText: "第二问", replyText: "答二"});

    const worker = createIngestionWorker({dataDir, ownerId: "worker-legacy-repair"});
    try {
      assert.equal(worker.acquireLease(), true);
      for (let i = 0; i < 4; i += 1) {
        const batch = await worker.runOneBatch();
        if (batch.processedCount === 0 && batch.discoveredCount === 0) break;
      }
    } finally {
      await worker.close();
    }

    const dbPath = join(dataDir, "deepaa.sqlite");

    // 预检：规范派生后人为改成旧复合指纹，analyze 应圈出 donor 且不改数据。
    {
      const db = new DeepaaDatabase(dbPath);
      try {
        const before = db.prepare(
          "SELECT id, agent_fingerprint_id FROM agent_sessions WHERE agent_name = 'claude-code'",
        ).all() as Array<{id: string; agent_fingerprint_id: string}>;
        assert.equal(before.length, 1);
        assert.equal(before[0]!.agent_fingerprint_id, "fp-claude-code");

        db.prepare(
          "UPDATE agent_sessions SET agent_fingerprint_id = 'fp-claude-code-anthropic-messages-catapi.chat' WHERE id = ?",
        ).run(before[0]!.id);

        const plan = analyzeLegacyIdentityDonorSessions(db);
        assert.equal(plan.donors.length, 1);
        assert.equal(plan.donors[0]!.id, before[0]!.id);
        assert.equal(plan.affectedExchangeCount, 2);
        assert.equal(
          (db.prepare("SELECT COUNT(*) AS n FROM agent_steps").get() as {n: number}).n,
          2,
        );
        const exchangeId = (db.prepare(
          "SELECT exchange_id FROM usage_ledger ORDER BY exchange_id LIMIT 1",
        ).get() as {exchange_id: string}).exchange_id;
        db.prepare(
          `INSERT INTO relay_local_usage_events(
             exchange_id,target_id,completed_at,provider_request_id,endpoint
           ) VALUES(?,?,?,?,?)`,
        ).run(exchangeId, "catapi.chat", new Date(NOW + 1_500).toISOString(), "legacy-request", "/v1/messages");
      } finally {
        db.close();
      }
    }

    const result = await reprojectLegacyIdentitySessions(dataDir);
    assert.equal(result.rederived, 2);
    assert.equal(result.skipped.length, 0, `skipped=${JSON.stringify(result.skipped)}`);
    assert.equal(result.remainingDonors.length, 0);

    // 后置：并回规范会话、计数一致、donor 清空。
    {
      const check = new DeepaaDatabase(dbPath);
      try {
        const sessions = check.prepare(
          "SELECT id, agent_fingerprint_id, request_count FROM agent_sessions WHERE agent_name = 'claude-code'",
        ).all() as Array<{id: string; agent_fingerprint_id: string; request_count: number}>;
        assert.equal(sessions.length, 1, `sessions=${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.agent_fingerprint_id, "fp-claude-code");
        assert.equal(sessions[0]!.request_count, 2);

        const steps = check.prepare(
          "SELECT COUNT(*) AS n FROM agent_steps WHERE agent_session_id = ?",
        ).get(sessions[0]!.id) as {n: number};
        assert.equal(steps.n, 2);

        const ledger = check.prepare(
          "SELECT COUNT(*) AS n FROM usage_ledger WHERE agent_session_id = ?",
        ).get(sessions[0]!.id) as {n: number};
        assert.equal(ledger.n, 2);
        assert.equal(
          (check.prepare(
            "SELECT COUNT(*) AS n FROM relay_local_usage_events",
          ).get() as {n: number}).n,
          0,
        );

        const donorLeft = check.prepare(
          "SELECT COUNT(*) AS n FROM agent_sessions WHERE agent_fingerprint_id != 'fp-' || agent_name",
        ).get() as {n: number};
        assert.equal(donorLeft.n, 0);

        const again = analyzeLegacyIdentityDonorSessions(check);
        assert.equal(again.donors.length, 0);
      } finally {
        check.close();
      }
    }
  });
});
