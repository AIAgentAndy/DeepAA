import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {readFile} from "node:fs/promises";
import {chmod, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDeepaaDatabase} from "../src/lib/db/connection.js";
import {SyncScheduler} from "../src/lib/sync-engine/scheduler.js";
import {SyncService} from "../src/lib/sync-engine/service.js";
import type {ProxyConfigStore} from "../src/proxy-config.js";
import {ProxyConfigStore as RealProxyConfigStore} from "../src/proxy-config.js";
import {POST as savePlanConfig} from "../src/app/api/proxy-sync/plan-config/route.js";
import {getLaunchNonceStore} from "../src/lib/development-launch/security.js";
import {clearReconciliationSessions} from "../src/lib/sync-engine/reconciliation/session-cache.js";
import {insertReconciliationAdjustment} from "../src/lib/sync-engine/reconciliation/ledger.js";
import type {ProviderCatalog} from "../src/lib/provider-catalog/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

async function createFixture(
  fetchImpl?: typeof fetch,
  options: {codexHome?: string; claudeHome?: string; planCatalog?: ProviderCatalog; planTarget?: boolean} = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sync-plan-service-"));
  tempRoots.push(root);
  const credentialsPath = join(root, "development-credentials.json");
  const configStore = new RealProxyConfigStore({
    configPath: join(root, "proxy-config.json"),
    developmentCredentialsPath: credentialsPath,
    localProxyBaseUrl: "http://localhost:3211",
  });
  await configStore.init();
  await configStore.updateConfig({
    targets: [{
      id: "target-1",
      name: "Kimi",
      openaiUrl: "https://api.moonshot.cn/v1",
      ...(options.planTarget ? {presetId: "kimi-coding", billingChannel: "plan", vendorFamily: "kimi"} : {}),
      enabled: true,
      supportedModels: ["kimi-k2.7-code"],
      development: {defaultCredentials: {codex: "cred-good"}},
    }],
  });
  const now = "2026-08-17T00:00:00.000Z";
  await writeFile(credentialsPath, JSON.stringify({
    version: 1,
    credentials: [
      {
        id: "cred-good",
        targetId: "target-1",
        label: "正确密钥",
        store: "macos-keychain",
        account: "cred-good",
        fingerprintSuffix: "sk-g****0001",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cred-other",
        targetId: "target-2",
        label: "其他目标密钥",
        store: "macos-keychain",
        account: "cred-other",
        fingerprintSuffix: "sk-o****0002",
        createdAt: now,
        updatedAt: now,
      },
    ],
  }), "utf8");
  const helperPath = join(root, "credential-helper.mjs");
  await writeFile(
    helperPath,
    "#!/usr/bin/env node\n"
      + "if (process.argv[2] === 'get') process.stdout.write('secret-key\\n');\n"
      + "else process.exitCode = 0;\n",
    "utf8",
  );
  await chmod(helperPath, 0o755);
  const db = openDeepaaDatabase({dataDir: root});
  // 对账夹具模拟已完成来源发现的 Worker；无此水位时真实环境必须继续 pending。
  db.prepare(
    `INSERT INTO worker_lease(id,owner_id,expires_at)
     VALUES(1,'sync-service-test','2099-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    "UPDATE schema_meta SET last_source_scan_completed_at='2099-01-01T00:00:00.000Z'",
  ).run();
  const service = new SyncService({
    db,
    configStore,
    developmentCredentialsPath: credentialsPath,
    consoleCredentialsPath: join(root, "console-credentials.json"),
    credentialHelperPath: helperPath,
    subscriptionCodexHome: options.codexHome,
    subscriptionClaudeHome: options.claudeHome,
    // 保存配置后会立即执行首次同步；缺省给 401 stub 防止测试访问真实网络。
    fetchImpl: fetchImpl ?? (async () => new Response("{}", {status: 401})) as typeof fetch,
    ...(options.planCatalog ? {loadPlanCatalog: async () => options.planCatalog} : {}),
  });
  return {root, db, service, configStore, revision: configStore.getConfig().revision};
}

async function createPlanFixture(
  fetchImpl?: typeof fetch,
  options: {codexHome?: string; claudeHome?: string; planCatalog?: ProviderCatalog} = {},
) {
  return createFixture(fetchImpl, {...options, planTarget: true});
}

describe("套餐同步服务", () => {
  test("官方预设目标拒绝调用 /models，模型目录只能通过预设刷新维护", async () => {
    const fixture = await createFixture();
    try {
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        targetPatch: {id: "target-1", target: {presetId: "moonshot-cn"}},
      });
      await expect(fixture.service.discoverModels("target-1", "cred-good"))
        .rejects.toThrow("PRESET_MODEL_DISCOVERY_UNSUPPORTED");
    } finally {
      fixture.db.close();
    }
  });

  test("模型发现没有先选择目标密钥时不调用上游 /models，也不修改目标", async () => {
    let fetchCount = 0;
    const fixture = await createFixture((async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({data: [{id: "gpt-5.6-sol"}]}), {status: 200});
    }) as typeof fetch);
    try {
      // 本测试验证自定义目标的空密钥分支；官方 URL 现在会按已确认的预设识别规则
      // 进入“预设目录模型”流程，不能再作为自定义目标夹具使用。
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        targetPatch: {id: "target-1", target: {openaiUrl: "https://gateway.example/v1", presetId: undefined}},
      });
      const before = fixture.configStore.getConfig();
      const result = await fixture.service.discoverModels("target-1");
      expect(result).toMatchObject({ok: false, authRequired: true, added: [], existing: [], removed: []});
      expect(fetchCount).toBe(0);
      expect(fixture.configStore.getConfig()).toEqual(before);
    } finally {
      fixture.db.close();
    }
  });

  test("确认模型时自动保留本密钥未返回的既有模型，不同密钥的模型集合不互相覆盖", async () => {
    let probeCount = 0;
    const probeFetch = (async () => {
      probeCount += 1;
      return new Response(JSON.stringify({data: [{id: "gpt-5.6-sol"}]}), {status: 200});
    }) as typeof fetch;
    // probeOpenAiModels 使用全局 fetch：stub 全局，确保探测不触网。
    vi.stubGlobal("fetch", probeFetch);
    const fixture = await createFixture(probeFetch);
    try {
      vi.stubEnv("DEEPAA_DATA_DIR", fixture.root);
      await mkdir(join(fixture.root, "config"), {recursive: true});
      await writeFile(join(fixture.root, "config", "model-pricing.json"), JSON.stringify({
        version: 2,
        currency: "USD",
        unit: "per_million_tokens",
        models: [
          {id: "openai/gpt-5.6-sol", vendor: "openai", runtimeModelId: "gpt-5.6-sol", patterns: ["gpt-5.6-sol"], mode: "chat", pricing: {input: 4, output: 20}},
          {id: "anthropic/claude-sonnet-4", vendor: "anthropic", runtimeModelId: "claude-sonnet-4", patterns: ["claude-sonnet-4"], mode: "chat", pricing: {input: 3, output: 15}},
        ],
      }), "utf8");
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        targetPatch: {id: "target-1", target: {
          openaiUrl: "https://gateway.example/v1",
          presetId: undefined,
          supportedModels: ["claude-sonnet-4"],
          supportedModelScopes: {"claude-sonnet-4": ["claude", "opencode"]},
          pricing: {rateMultiplier: 1, modelVendors: {
            "claude-sonnet-4": {vendor: "anthropic", priceEntryId: "anthropic/claude-sonnet-4"},
          }},
        }},
      });

      const result = await fixture.service.confirmDiscoveredModels("target-1", "cred-good", ["gpt-5.6-sol"]);
      expect(result.ok).toBe(true);
      expect(result.removed).toEqual(["claude-sonnet-4"]);
      expect(result.message).toContain("保留 1 个");

      const saved = fixture.configStore.getConfig().targets[0]!;
      expect(saved.supportedModels.sort()).toEqual(["claude-sonnet-4", "gpt-5.6-sol"].sort());
      expect(saved.supportedModelScopes?.["claude-sonnet-4"]).toEqual(["claude", "opencode"]);
      expect(saved.pricing?.modelVendors?.["claude-sonnet-4"]).toEqual({
        vendor: "anthropic", priceEntryId: "anthropic/claude-sonnet-4",
      });
      expect(probeCount).toBeGreaterThanOrEqual(1);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      fixture.db.close();
    }
  });

  test("历史五分钟窗口只读可见，冻结差额不再允许直接写账本", async () => {
    const fixture = await createFixture();
    try {
      const now = new Date();
      const windowStart = new Date(now.getTime() - 60_000).toISOString();
      const windowEnd = now.toISOString();
      // usage_ledger 外键依赖 raw_exchange_refs → ingestion_sources：先建合成链路。
      fixture.db.prepare(
        `INSERT INTO ingestion_sources(relative_path, file_id, generation, byte_offset, scan_offset, file_size, processed_count, status, updated_at)
         VALUES('recon-e2e://synthetic', 'recon-e2e', 0, 0, 0, 0, 0, 'ready', ?)`,
      ).run(windowEnd);
      const sourceId = (fixture.db.prepare(
        `SELECT id FROM ingestion_sources WHERE relative_path = 'recon-e2e://synthetic'`,
      ).get() as {id: number}).id;
      const refInsert = fixture.db.prepare(
        `INSERT INTO raw_exchange_refs(
           exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
           captured_at, completed_at, target_id, target_name, agent_name,
           agent_fingerprint_id, model, wire_api, status, is_streaming,
           request_body_bytes, response_body_bytes
         ) VALUES(?, 'recon-e2e', ?, 0, 1, ?, ?, 'target-1', 't', 'codex', 'f1', 'm', NULL, 0, 0, 0, 0)`,
      );
      const insert = fixture.db.prepare(
        `INSERT INTO usage_ledger(
           exchange_id, agent_fingerprint_id, agent_name, model, vendor, target_id,
           rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_tokens,
           currency, vendor_cost, actual_cost, duration_ms, usage_source, usage_confidence,
           pricing_snapshot_json, request_kind, result_class, created_at,
           actual_cost_nano, vendor_cost_nano
         ) VALUES(?, 'f1', 'codex', 'm', 'demo', 'target-1',
           1, 1, 0, 0, 1, 2, 'USD', 0.1, 0.1, 0, ?, 'provider',
           '{}', 'model', 'success', ?,
           100000000, 100000000)`,
      );
      refInsert.run("recon-e2e-ok", sourceId, new Date(now.getTime() - 50_000).toISOString(), new Date(now.getTime() - 50_000).toISOString());
      refInsert.run("recon-e2e-est", sourceId, new Date(now.getTime() - 40_000).toISOString(), new Date(now.getTime() - 40_000).toISOString());
      insert.run("recon-e2e-ok", "provider_usage", new Date(now.getTime() - 50_000).toISOString());
      insert.run("recon-e2e-est", "tokenizer_estimated", new Date(now.getTime() - 40_000).toISOString());
      fixture.db.prepare(
        `UPDATE usage_ledger SET actual_cost = 5.0, actual_cost_nano = 5000000000,
           result_class = 'upstream_error', usage_source = 'tokenizer_estimated'
         WHERE exchange_id = 'recon-e2e-est'`,
      ).run();
      fixture.db.prepare(
        `INSERT INTO reconciliation_windows(target_id, window_start, window_end, site_spend, local_spend, diff_amount, currency, status, created_at)
         VALUES('target-1', ?, ?, 0.35, 0.10, 0.25, 'USD', 'needs_review', ?)`,
      ).run(windowStart, windowEnd, windowEnd);

      const pending = fixture.service.listPendingReconciliationWindows("target-1");
      expect(pending.windows).toHaveLength(1);
      expect(pending.total).toBe(1);
      expect(pending.page).toBe(1);
      expect(pending.windows[0]!.siteSpend).toBeCloseTo(0.35);
      expect(pending.windows[0]!.diffAmount).toBeCloseTo(0.25);

      await expect(fixture.service.applyReconciliationWindow(pending.windows[0]!.id))
        .rejects.toThrow("LEGACY_WINDOW_RECHECK_REQUIRED");
      expect(fixture.service.listPendingReconciliationWindows("target-1").windows).toHaveLength(1);
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  test("必须显式选择属于目标的密钥，不回退 Agent 默认密钥", async () => {
    const fixture = await createPlanFixture();
    try {
      await expect(fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        expectedRevision: fixture.revision,
      })).rejects.toThrow("PLAN_CREDENTIAL_REQUIRED");
      await expect(fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-other",
        expectedRevision: fixture.revision,
      })).rejects.toThrow("PLAN_CREDENTIAL_TARGET_MISMATCH");
      await expect(fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision - 1,
      })).rejects.toThrow("CONFIG_REVISION_CONFLICT");

      const {config: saved} = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      expect(saved).toMatchObject({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
      });
    } finally {
      fixture.db.close();
    }
  });

  test("目标配置删除后仍可按最新 revision 清理残留套餐配置", async () => {
    const fixture = await createPlanFixture();
    try {
      await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      await fixture.configStore.updateConfig({
        expectedRevision: fixture.revision,
        targetPatch: {id: "target-1", target: {enabled: false}},
      });
      const deleted = await fixture.configStore.updateConfig({
        expectedRevision: fixture.revision + 1,
        targetDelete: {id: "target-1"},
      });

      await expect(fixture.service.removePlanSyncConfig("target-1", deleted.revision)).resolves.toBe(true);
    } finally {
      fixture.db.close();
    }
  });

  test("套餐适配器必须与目标供应商匹配，DeepSeek 目标拒绝保存套餐配置", async () => {
    const fixture = await createFixture();
    try {
      const nextRevision = fixture.revision + 1;
      await fixture.configStore.updateConfig({
        expectedRevision: fixture.revision,
        targets: [
          ...fixture.configStore.getConfig().targets,
          {
            id: "deepseek",
            name: "DeepSeek（官方）",
            openaiUrl: "https://api.deepseek.com",
            enabled: true,
            supportedModels: ["deepseek-v4-flash"],
            pricing: {vendor: "deepseek"},
          },
        ],
      });

      await expect(fixture.service.savePlanSyncConfig({
        targetId: "deepseek",
        providerType: "kimi-coding",
        expectedRevision: nextRevision,
      })).rejects.toThrow("PLAN_PROVIDER_TARGET_MISMATCH");
    } finally {
      fixture.db.close();
    }
  });

  test("OpenAI 订阅套餐配置无需密钥，自动发现 Codex 凭据并同步窗口", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "sync-codex-oauth-"));
    tempRoots.push(codexHome);
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {access_token: "access-token", account_id: "account-1"},
    }));
    const fetchImpl = (async () => new Response(JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: {used_percent: 10, limit_window_seconds: 18000, reset_at: 1744502400},
        secondary_window: {used_percent: 20, limit_window_seconds: 604800, reset_at: 1744934400},
      },
    }), {status: 200, headers: {"content-type": "application/json"}})) as typeof fetch;
    const fixture = await createFixture(fetchImpl, {codexHome});
    try {
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        targets: [
          ...current.targets,
          {
            id: "openai-sub",
            name: "OpenAI 订阅",
            openaiUrl: "https://api.openai.com/v1",
            presetId: "openai-subscription",
            billingChannel: "subscription",
            enabled: true,
            supportedModels: ["gpt-5.6-sol"],
          },
        ],
      });
      const nextRevision = fixture.configStore.getConfig().revision;
      const {config: saved} = await fixture.service.savePlanSyncConfig({
        targetId: "openai-sub",
        providerType: "openai-subscription",
        expectedRevision: nextRevision,
      });
      expect(saved).toMatchObject({
        targetId: "openai-sub",
        providerType: "openai-subscription",
        credentialId: null,
      });
      const result = await fixture.service.runPlanSync("openai-sub");
      expect(result.planQuota?.length).toBe(2);
      const status = await fixture.service.status("openai-sub");
      expect(status.plan.config?.status).toBe("ok");
      expect(status.plan.quota.items.map(item => item.windowLabel)).toEqual(["5h", "weekly"]);
    } finally {
      fixture.db.close();
    }
  });

  test("Anthropic 订阅套餐配置无需密钥，未登录时返回明确错误", async () => {
    const claudeHome = await mkdtemp(join(tmpdir(), "sync-claude-oauth-empty-"));
    tempRoots.push(claudeHome);
    const fixture = await createFixture(undefined, {claudeHome});
    try {
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        targets: [
          ...current.targets,
          {
            id: "anthropic-sub",
            name: "Anthropic 订阅",
            anthropicUrl: "https://api.anthropic.com",
            presetId: "anthropic-subscription",
            billingChannel: "subscription",
            enabled: true,
            supportedModels: ["claude-sonnet-5"],
          },
        ],
      });
      const nextRevision = fixture.configStore.getConfig().revision;
      const {config: saved} = await fixture.service.savePlanSyncConfig({
        targetId: "anthropic-sub",
        providerType: "anthropic-subscription",
        expectedRevision: nextRevision,
      });
      expect(saved.credentialId).toBeNull();
      await expect(fixture.service.runPlanSync("anthropic-sub"))
        .rejects.toThrow("SUBSCRIPTION_OAUTH_NOT_FOUND");
      const status = await fixture.service.status("anthropic-sub");
      expect(status.plan.config?.status).toBe("auth_required");
    } finally {
      fixture.db.close();
    }
  });

  test("无余额官方预设禁止保存控制台账号，存量账号同步报不支持且不再自动重试", async () => {
    const fixture = await createFixture();
    try {
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        targets: [
          ...current.targets,
          {
            id: "openai-1",
            name: "OpenAI（官方）",
            openaiUrl: "https://api.openai.com/v1",
            enabled: true,
            supportedModels: ["gpt-5.6-sol"],
            development: {defaultCredentials: {codex: "cred-good"}},
          },
        ],
      });

      await expect(fixture.service.saveConsoleAccount({
        targetId: "openai-1",
        providerType: "openai",
        consoleBaseUrl: "https://platform.openai.com",
        username: "legacy",
        password: "secret",
      })).rejects.toThrow("ACCOUNT_SYNC_UNSUPPORTED");

      // 存量账号直接落库后同步：应稳定报不支持，且状态不再被调度重试。
      await fixture.service.store.upsertConsoleAccount({
        id: "console_openai_1",
        targetId: "openai-1",
        providerType: "openai",
        consoleBaseUrl: "https://platform.openai.com",
        username: "legacy",
        passwordRef: "openai-1",
        loginMode: "manual",
        status: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: new Date().toISOString(),
        syncIntervalMinutes: 30,
      });
      await fixture.service.consoleCredentials.upsert({
        targetId: "openai-1",
        providerType: "openai",
        consoleBaseUrl: "https://platform.openai.com",
        username: "legacy",
        password: "secret",
        updatedAt: new Date().toISOString(),
      });

      await expect(fixture.service.runSync("openai-1")).rejects.toThrow("ACCOUNT_SYNC_UNSUPPORTED");
      const status = await fixture.service.status("openai-1");
      expect(status.account?.status).toBe("failed");
      expect(status.account?.lastSyncError).toBe("ACCOUNT_SYNC_UNSUPPORTED");
      expect(status.account?.nextSyncAt).toBeNull();
      expect(status.runs[0]).toMatchObject({status: "failed", mode: "http"});
    } finally {
      fixture.db.close();
    }
  });

  test("失败保留最近成功套餐快照并记录独立调度状态", async () => {
    let fail = false;
    const fetchImpl = (async () => {
      if (fail) return new Response("{}", {status: 429});
      return new Response(JSON.stringify({
        limits: [{detail: {limit: 100, remaining: 40, resetTime: 1_780_329_600_000}}],
      }), {status: 200, headers: {"content-type": "application/json"}});
    }) as typeof fetch;
    const fixture = await createPlanFixture(fetchImpl);
    try {
      await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      await fixture.service.runPlanSync("target-1");
      const first = await fixture.service.status("target-1");
      expect(first.plan.quota.items).toEqual([
        expect.objectContaining({windowLabel: "5h", used: 60, total: 100, remaining: 40}),
      ]);

      fail = true;
      await expect(fixture.service.runPlanSync("target-1")).rejects.toThrow("PLAN_HTTP_429");
      const failed = await fixture.service.status("target-1");
      expect(failed.plan.config?.status).toBe("failed");
      expect(failed.plan.quota.items).toEqual([
        expect.objectContaining({windowLabel: "5h", used: 60, total: 100, remaining: 40}),
      ]);
      expect(failed.runs[0]).toMatchObject({status: "failed", mode: "plan"});
    } finally {
      fixture.db.close();
    }
  });

  test("智谱历史百分比快照从有界 raw 恢复真实积分预览", async () => {
    const fixture = await createPlanFixture();
    try {
      fixture.service.store.upsertPlanSyncConfig({
        id: "plan-zhipu",
        targetId: "target-1",
        providerType: "zhipu",
        credentialId: "cred-good",
        accessKeyRef: null,
        secretKeyRef: null,
        status: "ok",
        lastSyncAt: "2026-08-30T09:12:09.941Z",
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null,
        syncIntervalMinutes: 5,
      });
      fixture.service.store.insertPlanQuotaSnapshots([{
        targetId: "target-1",
        planSyncId: "plan-zhipu",
        consoleAccountId: null,
        credentialId: "cred-good",
        providerType: "zhipu",
        planName: "pro",
        windowLabel: "weekly",
        used: 54,
        total: 100,
        remaining: null,
        unit: "percent",
        resetAt: "2026-09-02T14:32:53.997Z",
        rawJson: JSON.stringify({usage: 60_000, currentValue: 32_604, remaining: 27_395, percentage: 54}),
        capturedAt: "2026-08-30T09:12:09.941Z",
      }]);

      const status = await fixture.service.status("target-1");
      expect(status.plan.quota.items).toEqual([
        expect.objectContaining({used: 32_604, total: 60_000, remaining: 27_395, unit: "credits"}),
      ]);
    } finally {
      fixture.db.close();
    }
  });
});

describe("同步周期与保存后立即同步", () => {
  test("套餐同步周期默认 5 分钟，显式可改，编辑缺省保留原值", async () => {
    const fixture = await createPlanFixture();
    try {
      const first = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      expect(first.config.syncIntervalMinutes).toBe(5);
      const second = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
        syncIntervalMinutes: 1,
      });
      expect(second.config.syncIntervalMinutes).toBe(1);
      // 编辑时不传周期：保留上次保存值，不回退默认。
      const third = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      expect(third.config.syncIntervalMinutes).toBe(1);
    } finally {
      fixture.db.close();
    }
  });

  test("保存套餐后立即同步：鉴权失败折叠为结果返回且状态记为 auth_required", async () => {
    const fixture = await createPlanFixture();
    try {
      const {config, sync} = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      // 保存本身已生效（不回滚），首次同步 401 折叠为可展示结果。
      expect(config.providerType).toBe("kimi-coding");
      expect(config.status).toBe("auth_required");
      expect(sync).toEqual({ok: false, authRequired: true, message: "PLAN_AUTH_401"});
      // 失败进入固定重试节奏而非周期排程。
      expect(config.nextSyncAt).not.toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  test("保存套餐后立即同步成功：next_sync_at 按所选周期加抖动排程", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      limits: [{detail: {limit: 100, remaining: 40, resetTime: 1_780_329_600_000}}],
    }), {status: 200, headers: {"content-type": "application/json"}})) as typeof fetch;
    const fixture = await createPlanFixture(fetchImpl);
    try {
      const before = Date.now();
      const {config, sync} = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
        syncIntervalMinutes: 10,
      });
      expect(sync).toEqual({ok: true, authRequired: false, message: null});
      expect(config.status).toBe("ok");
      // 上界补偿调用期间的墙钟流逝：服务的排程基准取自调用内部时刻，
      // 若不补偿，抖动接近上限时任何毫秒级漂移都会造成偶发失败。
      const elapsedMs = Date.now() - before;
      const deltaMs = new Date(config.nextSyncAt!).getTime() - before;
      expect(deltaMs).toBeGreaterThan(10 * 60_000 * 0.9);
      expect(deltaMs).toBeLessThanOrEqual(10 * 60_000 * 1.1 + elapsedMs);
    } finally {
      fixture.db.close();
    }
  });

  test("套餐同步成功后按目录档位表自动回填月费：未手填才填、歧义不填", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      limits: [{detail: {limit: 100, remaining: 40, resetTime: 1_780_329_600_000}}],
    }), {status: 200, headers: {"content-type": "application/json"}})) as typeof fetch;
    const planCatalog: ProviderCatalog = {
      publishedAt: "2026-09-04",
      providers: {
        "moonshot-cn": {
          name: "Kimi / Moonshot（中国区）",
          brandId: "moonshot",
          pricingProviderId: "moonshot-cn",
          region: "cn",
          category: "cn_official",
          planTiers: [{name: "Kimi For Coding 标准版", monthlyFee: 49}],
          models: [],
        },
      },
    };
    const fixture = await createPlanFixture(fetchImpl, {planCatalog});
    try {
      const {sync} = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      expect(sync).toEqual({ok: true, authRequired: false, message: null});
      const saved = fixture.configStore.getConfig().targets.find(target => target.id === "target-1");
      // planName「Kimi For Coding」唯一命中档位「Kimi For Coding 标准版」→ 自动回填 49。
      expect(saved?.pricing?.planMonthlyFee).toBe(49);

      // 用户已手动录入后不再覆盖：手工改成 99，再同步不回填。
      await fixture.configStore.updateConfig({
        targetPatch: {id: "target-1", target: {pricing: {...saved?.pricing, planMonthlyFee: 99}}},
      });
      await fixture.service.runPlanSync("target-1");
      const after = fixture.configStore.getConfig().targets.find(target => target.id === "target-1");
      expect(after?.pricing?.planMonthlyFee).toBe(99);
    } finally {
      fixture.db.close();
    }
  });

  test("档位表多档位而套餐名未带档位时不自动回填（歧义保护）", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      limits: [{detail: {limit: 100, remaining: 40, resetTime: 1_780_329_600_000}}],
    }), {status: 200, headers: {"content-type": "application/json"}})) as typeof fetch;
    const planCatalog: ProviderCatalog = {
      publishedAt: "2026-09-04",
      providers: {
        "moonshot-cn": {
          name: "Kimi / Moonshot（中国区）",
          brandId: "moonshot",
          pricingProviderId: "moonshot-cn",
          region: "cn",
          category: "cn_official",
          planTiers: [
            {id: "lite", name: "Kimi For Coding 尝鲜版", monthlyFee: 19},
            {id: "pro", name: "Kimi For Coding 标准版", monthlyFee: 49},
          ],
          models: [],
        },
      },
    };
    const fixture = await createPlanFixture(fetchImpl, {planCatalog});
    try {
      const {sync} = await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      expect(sync).toEqual({ok: true, authRequired: false, message: null});
      const saved = fixture.configStore.getConfig().targets.find(target => target.id === "target-1");
      // 「Kimi For Coding」同时包含命中两个档位 → 歧义不回填，等待用户手动录入。
      expect(saved?.pricing?.planMonthlyFee).toBeUndefined();
    } finally {
      fixture.db.close();
    }
  });

  test("plan-config API 拒绝值域外的同步周期", async () => {
    const nonce = getLaunchNonceStore().issue();
    const response = await savePlanConfig(new Request(
      "http://localhost:3210/api/proxy-sync/plan-config",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3210",
          host: "localhost:3210",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          nonce,
          targetId: "target-1",
          providerType: "kimi-coding",
          expectedRevision: 1,
          syncIntervalMinutes: 7,
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error: "INVALID_REQUEST"});
  });
});

describe("套餐与控制台双调度", () => {
  test("同一 tick 串行消费两个到期来源且单项失败不阻断后续", async () => {
    const calls: string[] = [];
    const service = {
      store: {
        dueAccounts: () => [{targetId: "console-1"}, {targetId: "console-2"}],
        duePlanConfigs: () => ({
          items: [{targetId: "plan-1"}],
          candidateCount: 1,
          processedCount: 1,
          limited: false,
        }),
        prune: () => calls.push("prune"),
      },
      runSync: async (targetId: string) => {
        calls.push(`console:${targetId}`);
        if (targetId === "console-1") throw new Error("expected");
      },
      runPlanSync: async (targetId: string) => {
        calls.push(`plan:${targetId}`);
      },
      reconcileDueHours: async () => { calls.push("reconcile"); },
    };
    const scheduler = new SyncScheduler(service as unknown as SyncService);
    await scheduler.runOnce();
    expect(calls).toEqual([
      "console:console-1",
      "console:console-2",
      "plan:plan-1",
      "reconcile",
      "prune",
    ]);
  });
});

describe("套餐配置 API 门禁", () => {
  test("跨站请求和无效 nonce 均在调用服务前拒绝", async () => {
    const crossSite = await savePlanConfig(new Request(
      "http://localhost:3210/api/proxy-sync/plan-config",
      {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          host: "localhost:3210",
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({}),
      },
    ));
    expect(crossSite.status).toBe(403);

    const invalidNonce = await savePlanConfig(new Request(
      "http://localhost:3210/api/proxy-sync/plan-config",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3210",
          host: "localhost:3210",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({nonce: "invalid"}),
      },
    ));
    expect(invalidNonce.status).toBe(403);
    expect(await invalidNonce.json()).toMatchObject({error: "LAUNCH_NONCE_INVALID"});

    // 确认测试未意外消耗其它合法 nonce。
    const nonce = getLaunchNonceStore().issue();
    expect(getLaunchNonceStore().consume(nonce)).toBe(true);
  });

  test("新增套餐预设 vendor 映射到既有套餐适配器", async () => {
    const {resolvePlanProviderForTarget} = await import("../src/lib/sync-engine/plan-provider.js");
    expect(resolvePlanProviderForTarget({pricing: {vendor: "kimi-coding", rateMultiplier: 1}})).toBe("kimi-coding");
    expect(resolvePlanProviderForTarget({pricing: {vendor: "moonshot-cn", rateMultiplier: 1}})).toBe("kimi-coding");
    expect(resolvePlanProviderForTarget({pricing: {vendor: "zhipu-coding-plan", rateMultiplier: 1}})).toBe("zhipu");
    expect(resolvePlanProviderForTarget({pricing: {vendor: "minimax-plan", rateMultiplier: 1}})).toBe("minimax");
    expect(resolvePlanProviderForTarget({pricing: {vendor: "volcengine-coding-plan", rateMultiplier: 1}})).toBe("volcengine-coding-plan");
    // 订阅适配器必须显式订阅元数据，避免自定义按量目标误命中。
    expect(resolvePlanProviderForTarget({pricing: {vendor: "openai", rateMultiplier: 1}})).toBeUndefined();
    expect(resolvePlanProviderForTarget({pricing: {vendor: "openai", rateMultiplier: 1}, presetId: "openai-subscription", billingChannel: "subscription"})).toBe("openai-subscription");
    expect(resolvePlanProviderForTarget({pricing: {vendor: "anthropic", rateMultiplier: 1}})).toBeUndefined();
    expect(resolvePlanProviderForTarget({pricing: {vendor: "anthropic", rateMultiplier: 1}, presetId: "anthropic-subscription", billingChannel: "subscription"})).toBe("anthropic-subscription");
    expect(resolvePlanProviderForTarget({openaiUrl: "https://api.kimi.com/coding/v1"})).toBe("kimi-coding");
  });
});


describe("sync service 凭据明文取回（reveal）", () => {
  test("credential 校验目标归属；plan 未配置时报 PLAN_SECRET_NOT_CONFIGURED", async () => {
    const fixture = await createFixture();
    try {
      // fixture 的 credential-helper 对任意 get 返回 secret-key
      const value = await fixture.service.revealSecret({kind: "credential", targetId: "target-1", credentialId: "cred-good"});
      expect(value).toBe("secret-key");
      // 其他目标的密钥：拒绝取回
      await expect(fixture.service.revealSecret({kind: "credential", targetId: "target-2", credentialId: "cred-good"}))
        .rejects.toThrow("CREDENTIAL_NOT_FOUND");
      // 套餐 AK/SK 未配置
      await expect(fixture.service.revealSecret({kind: "plan-ak", targetId: "target-1"}))
        .rejects.toThrow("PLAN_SECRET_NOT_CONFIGURED");
      // 控制台凭据未配置
      await expect(fixture.service.revealSecret({kind: "console", targetId: "target-1"}))
        .rejects.toThrow("CONSOLE_CREDENTIALS_MISSING");
    } finally {
      fixture.db.close();
    }
  });

  test("status() 携带控制台密码打码串；明文绝不出现在 status 载荷", async () => {
    const fixture = await createFixture();
    try {
      // fixture 未写 console-credentials → account 为 null；此处只验证 plan 侧 AK/SK 无泄漏。
      const payload = await fixture.service.status("target-1");
      expect(payload.plan.config?.accessKeyMasked).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain("secretAccessKey");
    } finally {
      fixture.db.close();
    }
  });
});

describe("同步时点对账补差（B 兜底）", () => {
  beforeEach(() => {
    // 对账登录会话是进程级内存态，跨用例必须清空，
    // 否则上一个用例缓存的凭据会泄漏到下一个用例的取数计数里。
    clearReconciliationSessions();
  });

  function newApiFetchStub(logQuotaByWindow: (startIso: string, endIso: string) => number) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/user/login")) {
        return new Response(JSON.stringify({success: true, message: "", data: {id: 7, username: "u"}}), {
          status: 200,
          headers: {"content-type": "application/json", "set-cookie": "session=S1; Path=/; HttpOnly"},
        });
      }
      if (url.endsWith("/api/user/self")) {
        return new Response(JSON.stringify({success: true, data: {quota: 2_500_000}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.includes("/api/token/")) {
        return new Response(JSON.stringify({success: true, data: {items: []}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.endsWith("/api/pricing")) {
        return new Response(JSON.stringify({success: true, data: {group_ratio: {}}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.includes("/api/log/self")) {
        const params = new URL(url).searchParams;
        const start = new Date(Number(params.get("start_timestamp")) * 1000).toISOString();
        const end = new Date(Number(params.get("end_timestamp")) * 1000).toISOString();
        const quota = Math.round(logQuotaByWindow(start, end) * 500_000);
        if (url.includes("/api/log/self/stat")) {
          return new Response(JSON.stringify({success: true, data: {quota}}), {
            status: 200, headers: {"content-type": "application/json"},
          });
        }
        return new Response(JSON.stringify({success: true, data: {items: [{quota}], total: 1}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      throw new Error(`unexpected ${url} ${init?.method ?? ""}`);
    }) as typeof fetch;
  }

  function seedLedgerRow(db: import("../src/lib/db/sqlite-driver.js").DeepaaDatabase, exchangeId: string, actualCost: number, createdAt: string) {
    db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, updated_at)
       VALUES(?, 'seed', ?) ON CONFLICT(relative_path) DO NOTHING`,
    ).run(`seed://${exchangeId}`, createdAt);
    const sourceId = (db.prepare(`SELECT id FROM ingestion_sources WHERE relative_path = ?`).get(`seed://${exchangeId}`) as {id: number}).id;
    db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
        captured_at, completed_at, target_id, target_name, agent_name,
        agent_fingerprint_id, model, status, is_streaming,
        request_body_bytes, response_body_bytes
      ) VALUES(?, 'seed', ?, 0, 1, ?, ?, 'target-1', 'Kimi', 'codex', 'fp-a', 'gpt-5.6-sol', 200, 0, 0, 0)`,
    ).run(exchangeId, sourceId, createdAt, createdAt);
    db.prepare(
      `INSERT INTO usage_ledger(
        exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor,
        rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, total_tokens, currency, vendor_cost, actual_cost,
        duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
        request_kind, result_class, usage_quality, pricing_status,
        audit_eligible, total_tokens_basis, cost_basis,
        vendor_cost_nano, actual_cost_nano, created_at
      ) VALUES(?, 'target-1', 'fp-a', 'codex', 'gpt-5.6-sol', 'openai',
        1, 1000, 0, 0, 100, 0, 1100, 'USD', ?, ?, 500,
        'provider_usage', 'exact', '{}', 'model', 'success', 'exact', 'priced',
        0, 'derived', 'payg_rate', ?, ?, ?)`,
    ).run(exchangeId, actualCost, actualCost, Math.round(actualCost * 1e9), Math.round(actualCost * 1e9), createdAt);
  }

  async function setupAccountFixture(logQuotaByWindow: (startIso: string, endIso: string) => number) {
    const fixture = await createFixture(newApiFetchStub(logQuotaByWindow));
    fixture.service.store.upsertConsoleAccount({
      id: "acct-1", targetId: "target-1", providerType: "newapi",
      consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "ref",
      loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
      consecutiveAutoFailures: 0,
      consecutiveFailureKind: null,
      nextSyncAt: null, syncIntervalMinutes: 5,
    });
    await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
      version: 1,
      accounts: [{
        targetId: "target-1", providerType: "newapi",
        consoleBaseUrl: "https://relay.example.com", username: "u", password: "p",
        updatedAt: new Date().toISOString(),
      }],
    }), "utf8");
    return fixture;
  }

  test("同步不再预种对账小时；小时行由本地活动发现创建", async () => {
    const fixture = await setupAccountFixture(() => 0.007);
    try {
      await fixture.service.runSync("target-1", {automatic: false});
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM reconciliation_windows WHERE target_id='target-1'",
      ).get() as {n: number}).n).toBe(0);
      // 2026-09-28 用户确认：同步阶段零小时行；无本地活动时复核也零记录零站点流量。
      await fixture.service.reconcileDueHours("2026-09-26T12:10:00.000Z");
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM relay_reconciliation_hours WHERE target_id='target-1'",
      ).get() as {n: number}).n).toBe(0);
      // 有本地完成时刻事件的小时被自动发现并创建。
      const at = "2026-09-26T04:10:00.000Z";
      seedLedgerRow(fixture.db, "ex-discovery", 0.007, at);
      fixture.db.prepare(
        `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,endpoint)
         VALUES('ex-discovery','target-1',?,'/v1/responses')`,
      ).run(at);
      await fixture.service.reconcileDueHours("2026-09-26T05:20:00.000Z");
      const rows = fixture.db.prepare(
        "SELECT status,hour_start_utc FROM relay_reconciliation_hours WHERE target_id='target-1'",
      ).all() as Array<{status: string; hour_start_utc: string}>;
      expect(rows).toEqual([{status: "pending", hour_start_utc: "2026-09-26T04:00:00.000Z"}]);
    } finally {
      fixture.db.close();
    }
  });

  test("目标停用或账号异常时不发起站点请求，恢复后自动续跑", async () => {
    let statCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith("/api/user/login")
        ? {success: true, data: {access_token: "session", id: 7}}
        : url.endsWith("/api/user/self")
          ? {success: true, data: {quota: 2_500_000}}
          : url.includes("/api/token/")
            ? {success: true, data: {items: [{id: 7, name: "唯一", key: "k", status: 1}]}}
            : url.endsWith("/api/pricing")
              ? {success: true, data: {group_ratio: {}}}
              : url.includes("/api/log/self/stat")
                ? (statCalls++, {success: true, data: {quota: 15_000}})
                : url.includes("/api/log/self")
                  ? {success: true, data: {total: 0, items: []}}
                  : undefined;
      if (!payload) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(payload), {
        status: 200, headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const fixture = await createFixture(fetchImpl);
    try {
      fixture.service.store.upsertConsoleAccount({
        id: "acct-1", targetId: "target-1", providerType: "newapi",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "ref",
        loginMode: "http", status: "ok", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0, consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1, accounts: [{
          targetId: "target-1", providerType: "newapi",
          consoleBaseUrl: "https://relay.example.com", username: "u",
          password: "p", updatedAt: new Date().toISOString(),
        }],
      }));
      const hourStart = "2026-09-24T04:00:00.000Z";
      const at = "2026-09-24T04:10:00.000Z";
      seedLedgerRow(fixture.db, "ex-eligibility", 0.02, at);
      fixture.db.prepare(
        `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,endpoint)
         VALUES('ex-eligibility','target-1',?,'/v1/responses')`,
      ).run(at);
      // 停用目标：发现与复核都不得发起任何站点请求。
      const config = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: config.revision,
        targetPatch: {id: "target-1", target: {enabled: false}},
      });
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      expect(statCalls).toBe(0);
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM relay_reconciliation_hours",
      ).get() as {n: number}).n).toBe(0);
      // 重新启用：发现创建小时行并正常核对。
      const reEnabled = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: reEnabled.revision,
        targetPatch: {id: "target-1", target: {enabled: true}},
      });
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      expect(statCalls).toBeGreaterThanOrEqual(1);
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)?.status)
        .toBe("pending");
    } finally {
      fixture.db.close();
    }
  });

  test("到期小时至少两轮稳定站点统计才出待复核，未匹配残差不自动补", async () => {
    const fixture = await setupAccountFixture(() => 0.03);
    try {
      const hourStart = "2026-09-24T04:00:00.000Z";
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)?.status).toBe("pending");
      await fixture.service.reconcileDueHours("2026-09-24T06:16:00.000Z");
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)).toMatchObject({
        status: "needs_review", siteAmountNano: 30_000_000,
        localAmountNano: 0, residualNano: 30_000_000,
      });
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  test("结算系数仅用于人民币展示：非 1:1 目标照常按原始 USD 对账", async () => {
    const fixture = await setupAccountFixture(() => 0.03);
    try {
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        targetPatch: {id: "target-1", target: {pricing: {
          ...current.targets[0]?.pricing, rateMultiplier: 1, settlementFx: 16,
        }}},
      });
      const hourStart = "2026-09-24T04:00:00.000Z";
      // 本地一行 $0.015（fx=16 仅影响其人民币物化，不影响 USD 口径）。
      seedLedgerRow(fixture.db, "ex-fx-origin", 0.015, "2026-09-24T04:10:00.000Z");
      fixture.db.prepare(
        "UPDATE usage_ledger SET actual_cost_cny=0.24,fx_rate_to_cny=16 WHERE exchange_id='ex-fx-origin'",
      ).run();
      fixture.db.prepare(
        `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,endpoint)
         VALUES('ex-fx-origin','target-1','2026-09-24T04:10:00.000Z','/v1/responses')`,
      ).run();
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      await fixture.service.reconcileDueHours("2026-09-24T06:16:00.000Z");
      // 站点 $0.03 - 本地 $0.015 = $0.015，与汇率无关；补差行人民币按 fx=16 物化。
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)).toMatchObject({
        status: "needs_review", siteAmountNano: 30_000_000, localAmountNano: 15_000_000,
        residualNano: 15_000_000,
      });
    } finally {
      fixture.db.close();
    }
  });

  test("远端密钥对比条数相同但凭据 ID 已换，不能继续用旧密钥映射自动归属", async () => {
    const fixture = await setupAccountFixture(() => 0.03);
    try {
      fixture.service.store.insertSyncRun({
        consoleAccountId: "acct-1", targetId: "target-1", status: "ok", mode: "http",
        detailJson: JSON.stringify({credentialComparison: [{
          credentialId: "already-removed", label: "旧密钥", matched: true, remoteKeyId: "7",
        }]}),
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      const hourStart = "2026-09-24T04:00:00.000Z";
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      const keys = await fixture.service["reconciliationRemoteKeys"](
        fixture.service.reconciliation.getHour("target-1", hourStart)!);
      expect(keys).toEqual([]);
    } finally {
      fixture.db.close();
    }
  });

  test("控制台账号 ID 未变但站点地址变化时旧小时不能归给新账号", async () => {
    const fixture = await setupAccountFixture(() => 0.03);
    try {
      const hourStart = "2026-09-24T04:00:00.000Z";
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      fixture.service.store.upsertConsoleAccount({
        id: "acct-1", targetId: "target-1", providerType: "newapi",
        consoleBaseUrl: "https://another-relay.example.com", username: "u",
        passwordRef: "ref", loginMode: "http", status: "idle", lastSyncAt: null,
        lastSyncError: null, consecutiveAutoFailures: 0, consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)).toMatchObject({
        status: "incomplete", siteAmountNano: null,
      });
    } finally {
      fixture.db.close();
    }
  });

  test("人工确认前重读站点；金额变化拒绝旧快照补差", async () => {
    let siteSpend = 0.03;
    const fixture = await setupAccountFixture(() => siteSpend);
    try {
      const hourStart = "2026-09-24T04:00:00.000Z";
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      await fixture.service.reconcileDueHours("2026-09-24T06:16:00.000Z");
      siteSpend = 0.05;
      await expect(fixture.service.confirmReconciliationHour("target-1", hourStart))
        .rejects.toThrow("RECONCILIATION_SNAPSHOT_CHANGED");
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  test("new-api 密钥范围唯一且真实 Token 双向唯一时只自动补逐条价差", async () => {
    const at = "2026-09-24T04:10:00.000Z";
    const hourStart = "2026-09-24T04:00:00.000Z";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith("/api/user/login")
        ? {success: true, data: {access_token: "session", id: 7}}
        : url.endsWith("/api/user/self")
          ? {success: true, data: {quota: 2_500_000}}
          : url.includes("/api/token/")
            ? {success: true, data: {items: [
              {id: 7, name: "唯一", key: "secret-key", status: 1},
            ]}}
            : url.endsWith("/api/pricing")
              ? {success: true, data: {group_ratio: {}}}
              : url.includes("/api/log/self/stat")
                ? {success: true, data: {quota: 15_000}}
                : url.includes("/api/log/self")
                  ? {success: true, data: {total: 1, items: [{
                    id: 18, request_id: "stable-request-18",
                    token_id: 7, model_name: "gpt-5.6-sol",
                    created_at: Date.parse(at) / 1000,
                    quota: 15_000, prompt_tokens: 1000, completion_tokens: 100,
                    other: JSON.stringify({
                      input_tokens_total: 1000, cache_tokens: 0, cache_write_tokens: 0,
                      request_path: "/v1/responses",
                    }),
                  }]}}
                  : undefined;
      if (!payload) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(payload), {
        status: 200, headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const fixture = await createFixture(fetchImpl);
    try {
      fixture.service.store.upsertConsoleAccount({
        id: "acct-1", targetId: "target-1", providerType: "newapi",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "ref",
        loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0, consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1, accounts: [{
          targetId: "target-1", providerType: "newapi",
          consoleBaseUrl: "https://relay.example.com", username: "u",
          password: "p", updatedAt: new Date().toISOString(),
        }],
      }));
      await fixture.service.runSync("target-1", {automatic: false});
      seedLedgerRow(fixture.db, "ex-matched-price", 0.02, at);
      fixture.db.prepare(
        `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,endpoint)
         VALUES('ex-matched-price','target-1',?,'/v1/responses')`,
      ).run(at);
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      await fixture.service.reconcileDueHours("2026-09-24T06:16:00.000Z");
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)).toMatchObject({
        status: "applied", appliedAmountNano: 10_000_000, residualNano: 0,
        matchedCount: 1,
      });
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(1);
    } finally {
      fixture.db.close();
    }
  });

  test("弱匹配瀑布：错误行按模型+端点+时间唯一自动归属站点扣费并落补差行", async () => {
    const at = "2026-09-24T04:10:00.000Z";
    const hourStart = "2026-09-24T04:00:00.000Z";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith("/api/user/login")
        ? {success: true, data: {access_token: "session", id: 7}}
        : url.endsWith("/api/user/self")
          ? {success: true, data: {quota: 2_500_000}}
          : url.includes("/api/token/")
            ? {success: true, data: {items: [
              {id: 7, name: "唯一", key: "secret-key", status: 1},
            ]}}
            : url.endsWith("/api/pricing")
              ? {success: true, data: {group_ratio: {}}}
              : url.includes("/api/log/self/stat")
                ? {success: true, data: {quota: 20_000}}
                : url.includes("/api/log/self")
                  ? {success: true, data: {total: 2, items: [
                    {id: 1, request_id: "ok-request-1", token_id: 7, model_name: "gpt-5.6-sol",
                      created_at: Date.parse(at) / 1000, quota: 15_000,
                      prompt_tokens: 1000, completion_tokens: 100,
                      other: JSON.stringify({input_tokens_total: 1000, cache_tokens: 0,
                        cache_write_tokens: 0, request_path: "/v1/responses"})},
                    // 站点扣了费的 502：本地有同分钟唯一错误行（无 ID、无真实 Token）。
                    {id: 2, request_id: "err-request-2", token_id: 7, model_name: "gpt-5.6-sol",
                      created_at: Date.parse("2026-09-24T04:40:00.000Z") / 1000, quota: 5_000,
                      other: JSON.stringify({request_path: "/v1/responses"})},
                  ]}}
                  : undefined;
      if (!payload) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(payload), {
        status: 200, headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const fixture = await createFixture(fetchImpl);
    try {
      fixture.service.store.upsertConsoleAccount({
        id: "acct-1", targetId: "target-1", providerType: "newapi",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "ref",
        loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0, consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1, accounts: [{
          targetId: "target-1", providerType: "newapi",
          consoleBaseUrl: "https://relay.example.com", username: "u",
          password: "p", updatedAt: new Date().toISOString(),
        }],
      }));
      await fixture.service.runSync("target-1", {automatic: false});
      // 本地：一条 success（Token 全等高置信）+ 一条 upstream_error（估算、零成本）。
      seedLedgerRow(fixture.db, "ex-ok", 0.015, at);
      seedLedgerRow(fixture.db, "ex-err", 0, "2026-09-24T04:39:50.000Z");
      fixture.db.prepare(
        `UPDATE usage_ledger SET result_class='upstream_error', usage_source='tokenizer_estimated'
         WHERE exchange_id='ex-err'`,
      ).run();
      fixture.db.prepare(
        `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,endpoint)
         VALUES('ex-ok','target-1',?,'/v1/responses')`,
      ).run(at);
      fixture.db.prepare(
        `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,endpoint)
         VALUES('ex-err','target-1','2026-09-24T04:40:00.500Z','/v1/responses')`,
      ).run();
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      await fixture.service.reconcileDueHours("2026-09-24T06:16:00.000Z");
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)).toMatchObject({
        status: "applied", matchedCount: 2, residualNano: 0,
      });
      const matches = fixture.db.prepare(
        "SELECT site_log_id,confidence,adjustment_nano FROM relay_reconciliation_matches ORDER BY site_log_id",
      ).all() as Array<{site_log_id: string; confidence: string; adjustment_nano: number}>;
      expect(matches).toEqual([
        {site_log_id: "request:err-request-2", confidence: "weak", adjustment_nano: 10_000_000},
        {site_log_id: "request:ok-request-1", confidence: "high", adjustment_nano: 15_000_000},
      ]);
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(2);
    } finally {
      fixture.db.close();
    }
  });

  test("站点连续失败写入退避并抑制到期小时重试，成功后自动恢复", async () => {
    const hourStart = "2026-09-24T04:00:00.000Z";
    let usageStatus = 429;
    let usageCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/login")) {
        return new Response(JSON.stringify({code: 0, data: {access_token: "token"}}), {
          status: 200, headers: {"content-type": "application/json"},
        });
      }
      // 空小时探测走 trend：本用例聚焦整日取数失败路径，让探测不可用以强制回退。
      if (url.includes("/api/v1/usage/dashboard/trend")) {
        return new Response("not available", {status: 404});
      }
      if (url.includes("/api/v1/usage")) {
        usageCalls++;
        if (usageStatus !== 200) return new Response("rate limited", {status: usageStatus});
        return new Response(JSON.stringify({data: {total: 0, items: []}}), {
          status: 200, headers: {"content-type": "application/json"},
        });
      }
      if (url.includes("/api/v1/api-keys") || url.includes("/api/v1/user/api-keys")) {
        return new Response(JSON.stringify({data: {items: []}}), {
          status: 200, headers: {"content-type": "application/json"},
        });
      }
      if (url.includes("/api/v1/user/self") || url.includes("/api/v1/balance")) {
        return new Response(JSON.stringify({data: {}}), {
          status: 200, headers: {"content-type": "application/json"},
        });
      }
      throw new Error(`unexpected ${url} ${init?.method ?? ""}`);
    }) as typeof fetch;
    const fixture = await createFixture(fetchImpl);
    try {
      fixture.service.store.upsertConsoleAccount({
        id: "acct-1", targetId: "target-1", providerType: "sub2api",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "ref",
        loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0, consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1, accounts: [{
          targetId: "target-1", providerType: "sub2api",
          resolvedProvider: "sub2api",
          consoleBaseUrl: "https://relay.example.com", username: "u",
          password: "p", updatedAt: new Date().toISOString(),
        }],
      }));
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "sub2api", hourStart);
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      expect(usageCalls).toBe(1);
      const backoff = fixture.db.prepare(
        "SELECT fail_count,retry_after FROM relay_site_backoff WHERE target_id='target-1'",
      ).get() as {fail_count: number; retry_after: string};
      expect(backoff.fail_count).toBe(1);
      expect(Date.parse(backoff.retry_after)).toBe(Date.parse("2026-09-24T06:10:00.000Z") + 5 * 60_000);
      // 退避期内（5 分钟）到期小时不再触达站点。
      await fixture.service.reconcileDueHours("2026-09-24T06:14:00.000Z");
      expect(usageCalls).toBe(1);
      // 站点恢复后下一次到期复核成功并清零退避。
      usageStatus = 200;
      await fixture.service.reconcileDueHours("2026-09-24T06:16:00.000Z");
      expect(usageCalls).toBe(2);
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM relay_site_backoff WHERE target_id='target-1'",
      ).get()).toEqual({n: 0});
    } finally {
      fixture.db.close();
    }
  });

  test("已定稿小时轻量复查命中时不重拉明细，只推进检查时刻", async () => {
    const hourStart = "2026-09-24T04:00:00.000Z";
    let statCalls = 0;
    let detailCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith("/api/user/login")
        ? {success: true, data: {access_token: "session", id: 7}}
        : url.endsWith("/api/user/self")
          ? {success: true, data: {quota: 2_500_000}}
          : url.includes("/api/token/")
            ? {success: true, data: {items: [{id: 7, name: "唯一", key: "k", status: 1}]}}
            : url.endsWith("/api/pricing")
              ? {success: true, data: {group_ratio: {}}}
              : url.includes("/api/log/self/stat")
                ? (statCalls++, {success: true, data: {quota: 0}})
                : url.includes("/api/log/self")
                  ? (detailCalls++, {success: true, data: {total: 0, items: []}})
                  : undefined;
      if (!payload) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(payload), {
        status: 200, headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const fixture = await createFixture(fetchImpl);
    try {
      fixture.service.store.upsertConsoleAccount({
        id: "acct-1", targetId: "target-1", providerType: "newapi",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "ref",
        loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0, consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1, accounts: [{
          targetId: "target-1", providerType: "newapi",
          consoleBaseUrl: "https://relay.example.com", username: "u",
          password: "p", updatedAt: new Date().toISOString(),
        }],
      }));
      await fixture.service.runSync("target-1", {automatic: false});
      fixture.service.reconciliation.seedHour("target-1", "acct-1", "newapi", hourStart);
      await fixture.service.reconcileDueHours("2026-09-24T06:10:00.000Z");
      await fixture.service.reconcileDueHours("2026-09-24T06:16:00.000Z");
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)).toMatchObject({
        status: "balanced", siteLightCheck: "newapi_stat:q:0",
      });
      const statBefore = statCalls;
      const detailBefore = detailCalls;
      // 48 小时复查窗口内的下一次到期（+1 小时）：轻量键未变 → 只调 stat，不再拉明细。
      await fixture.service.reconcileDueHours("2026-09-24T07:17:00.000Z");
      expect(statCalls).toBe(statBefore + 1);
      expect(detailCalls).toBe(detailBefore);
      expect(fixture.service.reconciliation.getHour("target-1", hourStart)).toMatchObject({
        status: "balanced", lastCheckedAt: "2026-09-24T07:17:00.000Z",
      });
    } finally {
      fixture.db.close();
    }
  });

  test("同步阶段不因差额大小生成旧窗口、小时行或补差，改由活动发现与小时复核决策", async () => {
    const fixture = await setupAccountFixture(() => 0.007);
    try {
      await fixture.service.runSync("target-1", {automatic: false});
      await fixture.service.runSync("target-1", {automatic: false});
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM reconciliation_windows WHERE target_id='target-1'",
      ).get() as {n: number}).n).toBe(0);
      // 2026-09-28 用户确认：同步不再预种小时行。
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM relay_reconciliation_hours WHERE target_id='target-1'",
      ).get() as {n: number}).n).toBe(0);
      expect((fixture.db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  test("待复核对账窗口列表分页：total/pageCount/pageSize 上限与越界页", async () => {
    const fixture = await createFixture();
    try {
      const insertReview = fixture.db.prepare(
        `INSERT INTO reconciliation_windows(target_id, window_start, window_end, site_spend, local_spend, diff_amount, currency, status, created_at)
         VALUES('target-1', ?, ?, 1, 0.5, 0.5, 'USD', 'needs_review', ?)`,
      );
      const insertBalanced = fixture.db.prepare(
        `INSERT INTO reconciliation_windows(target_id, window_start, window_end, site_spend, local_spend, diff_amount, currency, status, created_at)
         VALUES('target-1', ?, ?, 1, 1, 0, 'USD', 'balanced', ?)`,
      );
      const base = Date.now();
      for (let i = 0; i < 7; i += 1) {
        const start = new Date(base + i * 1_000).toISOString();
        const end = new Date(base + (i + 1) * 1_000).toISOString();
        insertReview.run(start, end, end);
      }
      insertBalanced.run(
        new Date(base + 7_000).toISOString(),
        new Date(base + 8_000).toISOString(),
        new Date(base + 8_000).toISOString(),
      );

      const page1 = fixture.service.listPendingReconciliationWindows("target-1", {page: 1, pageSize: 3});
      expect(page1.total).toBe(7);
      expect(page1.pageCount).toBe(3);
      expect(page1.pageSize).toBe(3);
      expect(page1.windows).toHaveLength(3);
      // window_end DESC：第一页是最近的三个窗口
      expect(page1.windows[0]!.windowEnd).toBe(new Date(base + 7_000).toISOString());

      const page3 = fixture.service.listPendingReconciliationWindows("target-1", {page: 3, pageSize: 3});
      expect(page3.windows).toHaveLength(1);
      expect(page3.windows[0]!.windowEnd).toBe(new Date(base + 1_000).toISOString());

      // pageSize 收敛到上限 100；balanced 不计入
      const clamped = fixture.service.listPendingReconciliationWindows("target-1", {page: 1, pageSize: 500});
      expect(clamped.pageSize).toBe(100);
      expect(clamped.windows).toHaveLength(7);

      // 越界页返回空但 total 不变；非法参数有界回退（page→1，负 pageSize→1）
      const beyond = fixture.service.listPendingReconciliationWindows("target-1", {page: 9, pageSize: 3});
      expect(beyond.windows).toHaveLength(0);
      expect(beyond.total).toBe(7);
      const fallback = fixture.service.listPendingReconciliationWindows("target-1", {page: 0, pageSize: -5});
      expect(fallback.page).toBe(1);
      expect(fallback.pageSize).toBe(1);
    } finally {
      fixture.db.close();
    }
  });

  test("站点无差异也不生成旧窗口或补差；小时行只由本地活动发现创建", async () => {
    const fixture = await setupAccountFixture(() => 0.25);
    try {
      await fixture.service.runSync("target-1", {automatic: false});
      await fixture.service.runSync("target-1", {automatic: false});
      const windows = fixture.db.prepare(
        `SELECT status FROM reconciliation_windows WHERE target_id='target-1' ORDER BY window_end`,
      ).all() as Array<{status: string}>;
      expect(windows).toEqual([]);
      const reconCount = fixture.db.prepare(
        `SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'`,
      ).get() as {n: number};
      expect(reconCount.n).toBe(0);
    } finally {
      fixture.db.close();
    }
  });
});

describe("密钥无有效倍率：只做黄标提醒，不再拆链", () => {
  function sub2FetchStub(maskedKey: string, withRate: boolean) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/login")) {
        return new Response(JSON.stringify({code: 0, message: "success", data: {access_token: "t"}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.endsWith("/api/v1/user/profile")) {
        return new Response(JSON.stringify({code: 0, data: {balance: 5}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.includes("/api/v1/keys")) {
        return new Response(JSON.stringify({code: 0, data: {items: [
          {name: "k1", key: maskedKey, group_id: 66, group: withRate ? {id: 66, rate_multiplier: 0.5} : undefined, status: "active"},
        ]}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.endsWith("/api/v1/groups/rates")) {
        return new Response(JSON.stringify({code: 0, data: {}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.includes("/api/v1/model-plaza")) {
        return new Response("{}", {status: 404});
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
  }

  /**
   * 2026-09-18 用户决策：中转站倍率同步失败（远端找到了密钥但没返回有效倍率）
   * 只允许产出黄标提醒，**不得**改动密钥适用 / 密钥倍率 / 默认密钥 /
   * 目标绑定 / Agent 连接中的任何一项。
   */
  test("matched 无倍率：只返回黄标提醒，密钥、默认链与 Agent 绑定全部保持不变", async () => {
    const fixture = await createFixture(sub2FetchStub("sec****key", false));
    try {
      // fixture 目标是 moonshot 官方预设（chat-only），先改为自定义中转以支持 codex 接入。
      // targetPatch 是整体替换：必须展开完整 target，否则 supportedModels 丢失。
      const base = fixture.configStore.getConfig();
      const baseTarget = base.targets[0]!;
      await fixture.configStore.updateConfig({
        expectedRevision: base.revision,
        targetPatch: {id: "target-1", target: {
          ...baseTarget,
          openaiUrl: "https://gateway.example/v1",
          presetId: undefined,
          // 显式模型适用：scope 缺省=拒绝所有 Agent
          supportedModelScopes: {"kimi-k2.7-code": ["codex", "claude"]},
        }},
      });
      const current = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: current.revision,
        agentConnectionPatch: {
          agent: "codex", action: "connect", boundTargetIds: ["target-1"],
          defaultTargetId: "target-1", cliSyncEnabled: false,
        },
      });
      const afterConnect = fixture.configStore.getConfig();
      const target = afterConnect.targets[0]!;
      await fixture.configStore.updateConfig({
        expectedRevision: afterConnect.revision,
        targetPatch: {id: "target-1", target: {...target,
          development: {...target.development, defaultCredentials: {codex: "cred-good", claude: "cred-good"}},
        } as never},
      });
      // 显式补 codex+claude 适用，并预置一条手动倍率：拆链旧实现会把它清掉。
      const credFile = JSON.parse(await readFile(join(fixture.root, "development-credentials.json"), "utf8")) as {
        credentials: Array<{id: string; agentScope?: string[]; rateMultiplier?: number}>;
      };
      for (const credential of credFile.credentials) {
        if (credential.id === "cred-good") {
          credential.agentScope = ["codex", "claude"];
          credential.rateMultiplier = 0.3;
        }
      }
      await writeFile(join(fixture.root, "development-credentials.json"), JSON.stringify(credFile), "utf8");
      fixture.service.store.upsertConsoleAccount({
        id: "acct-c", targetId: "target-1", providerType: "sub2api",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "r",
        loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1,
        accounts: [{targetId: "target-1", providerType: "sub2api",
          consoleBaseUrl: "https://relay.example.com", username: "u", password: "p",
          updatedAt: new Date().toISOString()}],
      }), "utf8");

      const result = await fixture.service.runSync("target-1", {automatic: false});

      // ── 1. 只提示：文案必须指向「去站点确认倍率」，且不含任何已执行动作 ──
      expect(result.rateSyncWarnings?.length).toBe(1);
      const warning = result.rateSyncWarnings?.[0] ?? "";
      // 文案只让用户去站点确认倍率；不复述「不会改动密钥/模型/Agent 关联」
      // 这类内部保证（2026-09-18 用户确认：没必要提醒到用户）。
      expect(warning).toBe("密钥「正确密钥」远端未返回有效倍率，请在供应商站点确认实际倍率");
      expect(warning).not.toContain("不会因此改动");
      expect(warning).not.toContain("已收回");
      expect(warning).not.toContain("默认密钥已");
      // 旧字段必须彻底消失，避免任何消费端误以为还会级联。
      expect((result as {cascadeNotes?: string[]}).cascadeNotes).toBeUndefined();

      // ── 2. 配置侧：默认密钥与 Agent 绑定保持原样 ──
      const config = fixture.configStore.getConfig();
      expect(config.targets[0]?.development?.defaultCredentials?.codex).toBe("cred-good");
      expect(config.targets[0]?.development?.defaultCredentials?.claude).toBe("cred-good");
      expect(config.agentConnections.codex?.boundTargetIds ?? []).toContain("target-1");
      expect(config.agentConnections.codex?.defaultTargetId).toBe("target-1");

      // ── 3. 密钥侧：适用范围与（手动）倍率都不被清除 ──
      const after = JSON.parse(await readFile(join(fixture.root, "development-credentials.json"), "utf8")) as {
        credentials: Array<{id: string; agentScope?: string[]; rateMultiplier?: number}>;
      };
      const credential = after.credentials.find(item => item.id === "cred-good")!;
      expect(credential.agentScope).toEqual(["codex", "claude"]);
      expect(credential.rateMultiplier).toBe(0.3);
    } finally {
      fixture.db.close();
    }
  });

  test("概览接口按目标透出倍率黄标计数（只读有界，供供应商列表消费）", async () => {
    const fixture = await createFixture(sub2FetchStub("sec****key", false));
    try {
      const base = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: base.revision,
        targetPatch: {id: "target-1", target: {
          ...base.targets[0]!,
          openaiUrl: "https://gateway.example/v1",
          presetId: undefined,
        }},
      });
      fixture.service.store.upsertConsoleAccount({
        id: "acct-c", targetId: "target-1", providerType: "sub2api",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "r",
        loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1,
        accounts: [{targetId: "target-1", providerType: "sub2api",
          consoleBaseUrl: "https://relay.example.com", username: "u", password: "p",
          updatedAt: new Date().toISOString()}],
      }), "utf8");
      await fixture.service.runSync("target-1", {automatic: false});

      const overview = await fixture.service.overview(["target-1", "target-missing"]);
      expect(overview.limited).toBe(false);
      expect(overview.processedCount).toBe(2);
      const summary = overview.targets.find(item => item.targetId === "target-1")!;
      expect(summary.rateUnconfirmedCount).toBe(1);
      expect(summary.rateUnconfirmedLabels).toEqual(["正确密钥"]);
      expect(summary.hasConsoleAccount).toBe(true);
      expect(summary.hasPlanConfig).toBe(false);
      expect(summary.balance?.amount).toBe(5);
      // 连续失败计数字段随概览投影（成功同步后保持 0；无配置链路为 0）。
      expect(summary.accountConsecutiveFailures).toBe(0);
      expect(summary.planConsecutiveFailures).toBe(0);
      expect(summary.planLastError).toBeNull();
      // 无账号的目标必须如实返回空态，而不是抛错或返回伪造的 0 余额。
      const missing = overview.targets.find(item => item.targetId === "target-missing")!;
      expect(missing.hasConsoleAccount).toBe(false);
      expect(missing.hasPlanConfig).toBe(false);
      expect(missing.balance).toBeNull();
      expect(missing.plan).toBeNull();
      expect(missing.rateUnconfirmedCount).toBe(0);
      expect(missing.accountConsecutiveFailures).toBe(0);
      expect(missing.planConsecutiveFailures).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  test("概览结果短 TTL 缓存：同参数命中共享负载，写路径立即失效", async () => {
    const fixture = await createFixture(sub2FetchStub("sec****key", false));
    try {
      const base = fixture.configStore.getConfig();
      await fixture.configStore.updateConfig({
        expectedRevision: base.revision,
        targetPatch: {id: "target-1", target: {
          ...base.targets[0]!,
          openaiUrl: "https://gateway.example/v1",
          presetId: undefined,
        }},
      });
      fixture.service.store.upsertConsoleAccount({
        id: "acct-cache", targetId: "target-1", providerType: "sub2api",
        consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "r",
        loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1,
        accounts: [{targetId: "target-1", providerType: "sub2api",
          consoleBaseUrl: "https://relay.example.com", username: "u", password: "p",
          updatedAt: new Date().toISOString()}],
      }), "utf8");
      await fixture.service.runSync("target-1", {automatic: false});

      const first = await fixture.service.overview(["target-1"]);
      // TTL 内同参数直接复用共享负载（路由层只做 JSON 序列化）。
      const second = await fixture.service.overview(["target-1"]);
      expect(second).toBe(first);
      // 参数不同（目标集合变化）不命中，各自重建。
      const widened = await fixture.service.overview(["target-1", "target-missing"]);
      expect(widened).not.toBe(first);
      expect(widened.processedCount).toBe(2);

      // 写路径（删除控制台账号）立即失效：下一次读取不再返回旧快照。
      await fixture.service.removeConsoleAccount("target-1");
      const afterRemoval = await fixture.service.overview(["target-1"]);
      expect(afterRemoval).not.toBe(first);
      expect(afterRemoval.targets[0]?.hasConsoleAccount).toBe(false);
      expect(afterRemoval.targets[0]?.balance).toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  test("概览接口目标数超上限时截断并标记 limited", async () => {
    const fixture = await createFixture();
    try {
      const many = Array.from({length: 250}, (_, index) => `t-${index}`);
      const overview = await fixture.service.overview(many);
      expect(overview.limited).toBe(true);
      expect(overview.processedCount).toBe(200);
      expect(overview.targets.length).toBe(200);
    } finally {
      fixture.db.close();
    }
  });
});

describe("连续自动失败计数（同步失败红标，2026-09-20）", () => {
  /** sub2api 开关 stub：ok = 完整成功链路；fail = 全部 401（登录即失败）。 */
  function switchableSub2Fetch(mode: () => "ok" | "fail") {
    return (async (input: RequestInfo | URL) => {
      if (mode() === "fail") return new Response("{}", {status: 401});
      const url = String(input);
      if (url.endsWith("/api/v1/auth/login")) {
        return new Response(JSON.stringify({code: 0, message: "success", data: {access_token: "t"}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.endsWith("/api/v1/user/profile")) {
        return new Response(JSON.stringify({code: 0, data: {balance: 5}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.includes("/api/v1/keys")) {
        return new Response(JSON.stringify({code: 0, data: {items: []}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.endsWith("/api/v1/groups/rates")) {
        return new Response(JSON.stringify({code: 0, data: {}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.includes("/api/v1/model-plaza")) {
        return new Response("{}", {status: 404});
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
  }

  async function prepareRelayTarget(fixture: Awaited<ReturnType<typeof createFixture>>) {
    const base = fixture.configStore.getConfig();
    const baseTarget = base.targets[0]!;
    await fixture.configStore.updateConfig({
      expectedRevision: base.revision,
      targetPatch: {id: "target-1", target: {
        ...baseTarget,
        openaiUrl: "https://gateway.example/v1",
        presetId: undefined,
      }},
    });
    fixture.service.store.upsertConsoleAccount({
      id: "acct-c", targetId: "target-1", providerType: "sub2api",
      consoleBaseUrl: "https://relay.example.com", username: "u", passwordRef: "r",
      loginMode: "http", status: "idle", lastSyncAt: null, lastSyncError: null,
      consecutiveAutoFailures: 0,
      consecutiveFailureKind: null,
      nextSyncAt: null, syncIntervalMinutes: 5,
    });
    await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
      version: 1,
      accounts: [{targetId: "target-1", providerType: "sub2api",
        consoleBaseUrl: "https://relay.example.com", username: "u", password: "p",
        updatedAt: new Date().toISOString()}],
    }), "utf8");
  }

  test("账号链：自动失败递增、手动失败不加、任何一次成功立即清零", async () => {
    let mode: "ok" | "fail" = "fail";
    const fixture = await createFixture(switchableSub2Fetch(() => mode));
    try {
      await prepareRelayTarget(fixture);
      const counter = () => fixture.service.store.getConsoleAccount("target-1")?.consecutiveAutoFailures;
      const kind = () => fixture.service.store.getConsoleAccount("target-1")?.consecutiveFailureKind;

      await expect(fixture.service.runSync("target-1", {automatic: true})).rejects.toThrow();
      expect(counter()).toBe(1);
      // 中转站 401 会先走 Playwright 兜底，兜底缺失时包装为普通 Error（保留根因文案）：
      // 该路径归类 default，走「连续两次」门槛（鉴权一次即亮由下方 OpenRouter 用例验证）。
      expect(kind()).toBe("default");
      expect((await fixture.service.status("target-1")).account?.consecutiveFailureKind).toBe("default");
      const overview = await fixture.service.overview(["target-1"]);
      expect(overview.targets[0]?.accountConsecutiveFailures).toBe(1);
      expect(overview.targets[0]?.accountFailureKind).toBe("default");

      await expect(fixture.service.runSync("target-1", {automatic: true})).rejects.toThrow();
      expect(counter()).toBe(2);

      // 手动失败：页面已有即时反馈，计数与类别都不加不清。
      await expect(fixture.service.runSync("target-1")).rejects.toThrow();
      expect(counter()).toBe(2);
      expect(kind()).toBe("default");

      // 任何一次成功（此处为手动）立即清零并清空类别，标识随之消失。
      mode = "ok";
      await fixture.service.runSync("target-1");
      expect(counter()).toBe(0);
      expect(kind()).toBeNull();
      const status = await fixture.service.status("target-1");
      expect(status.account?.status).toBe("ok");
      expect(status.account?.consecutiveAutoFailures).toBe(0);
      expect(status.account?.consecutiveFailureKind).toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  test("账号链：官方 API Key 凭证被拒（401/403）一次即亮", async () => {
    const fixture = await createFixture((async () => new Response("{}", {status: 403})) as typeof fetch);
    try {
      // fixture 目标 target-1 自带默认密钥 cred-good（helper stub 可解析）。
      // 2026-09-29：SiliconFlow /user/info 已下线（注册表降级 NoBalance），鉴权一次即亮
      // 用例改用 OpenRouter（credits 端点 401/403 → SyncAuthRequiredError）。
      fixture.service.store.upsertConsoleAccount({
        id: "acct-or", targetId: "target-1", providerType: "openrouter",
        consoleBaseUrl: "https://openrouter.ai", username: "u", passwordRef: "r",
        loginMode: "api_key", status: "idle", lastSyncAt: null, lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null, syncIntervalMinutes: 5,
      });
      await writeFile(join(fixture.root, "console-credentials.json"), JSON.stringify({
        version: 1,
        accounts: [{targetId: "target-1", providerType: "openrouter",
          consoleBaseUrl: "https://openrouter.ai", username: "u", password: "p",
          updatedAt: new Date().toISOString()}],
      }), "utf8");

      await expect(fixture.service.runSync("target-1", {automatic: true})).rejects.toThrow("SYNC_AUTH_403");
      const row = fixture.service.store.getConsoleAccount("target-1")!;
      expect(row.status).toBe("auth_required");
      expect(row.consecutiveAutoFailures).toBe(1);
      expect(row.consecutiveFailureKind).toBe("auth");

      const {resolveTargetBadge, badgeInputFromOverview} = await import("../src/lib/sync-engine/target-health-badge.js");
      const overview = await fixture.service.overview(["target-1"]);
      const badge = resolveTargetBadge(badgeInputFromOverview(
        fixture.configStore.getConfig().targets[0]!,
        overview.targets[0],
      ), "Kimi");
      expect(badge).toMatchObject({kind: "sync_failure", label: "同步失败"});
      expect(badge?.title).toContain("凭证/鉴权失败");
    } finally {
      fixture.db.close();
    }
  });

  test("账号链：重新保存账号即重置计数，保存后首次同步失败自动从 1 起算", async () => {
    let mode: "ok" | "fail" = "fail";
    const fixture = await createFixture(switchableSub2Fetch(() => mode));
    try {
      await prepareRelayTarget(fixture);
      // 两次自动失败把计数抬到 2。
      await expect(fixture.service.runSync("target-1", {automatic: true})).rejects.toThrow();
      await expect(fixture.service.runSync("target-1", {automatic: true})).rejects.toThrow();
      expect(fixture.service.store.getConsoleAccount("target-1")?.consecutiveAutoFailures).toBe(2);
      expect(fixture.service.store.getConsoleAccount("target-1")?.consecutiveFailureKind).toBe("default");

      // 重新保存账号：配置已变，计数清零；保存后的首次立即同步属于自动链，失败后从 1 起算。
      const {sync} = await fixture.service.saveConsoleAccount({
        targetId: "target-1",
        providerType: "sub2api",
        consoleBaseUrl: "https://relay.example.com",
        username: "u",
        password: "p",
      });
      expect(sync.ok).toBe(false);
      expect(fixture.service.store.getConsoleAccount("target-1")?.consecutiveAutoFailures).toBe(1);
      expect(fixture.service.store.getConsoleAccount("target-1")?.consecutiveFailureKind).toBe("default");
    } finally {
      fixture.db.close();
    }
  });

  test("套餐链：自动失败递增、手动成功清零，status() 同步暴露计数", async () => {
    let fail = false;
    const fetchImpl = (async () => {
      if (fail) return new Response("{}", {status: 429});
      return new Response(JSON.stringify({
        limits: [{detail: {limit: 100, remaining: 40, resetTime: 1_780_329_600_000}}],
      }), {status: 200, headers: {"content-type": "application/json"}});
    }) as typeof fetch;
    const fixture = await createPlanFixture(fetchImpl);
    try {
      await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      // 保存即同步成功：计数与类别都保持空。
      const fresh = fixture.service.store.getPlanSyncConfig("target-1");
      expect(fresh?.consecutiveAutoFailures).toBe(0);
      expect(fresh?.consecutiveFailureKind).toBeNull();

      fail = true;
      await expect(fixture.service.runPlanSync("target-1", {automatic: true})).rejects.toThrow("PLAN_HTTP_429");
      // HTTP 429 不是鉴权类：走默认「连续两次」门槛，第一次失败不亮。
      expect(fixture.service.store.getPlanSyncConfig("target-1")?.consecutiveAutoFailures).toBe(1);
      expect(fixture.service.store.getPlanSyncConfig("target-1")?.consecutiveFailureKind).toBe("default");
      await expect(fixture.service.runPlanSync("target-1", {automatic: true})).rejects.toThrow("PLAN_HTTP_429");
      expect(fixture.service.store.getPlanSyncConfig("target-1")?.consecutiveAutoFailures).toBe(2);
      const midStatus = await fixture.service.status("target-1");
      expect(midStatus.plan.config?.consecutiveAutoFailures).toBe(2);
      expect(midStatus.plan.config?.consecutiveFailureKind).toBe("default");

      // 手动成功立即清零并清空类别。
      fail = false;
      await fixture.service.runPlanSync("target-1");
      const recovered = fixture.service.store.getPlanSyncConfig("target-1");
      expect(recovered?.consecutiveAutoFailures).toBe(0);
      expect(recovered?.consecutiveFailureKind).toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  test("套餐链：凭证被远端拒绝（403）一次即亮，重试退避保持 30 分钟不变", async () => {
    let status = 403;
    const fetchImpl = (async () => new Response("{}", {status})) as typeof fetch;
    const fixture = await createPlanFixture(fetchImpl);
    try {
      await fixture.service.savePlanSyncConfig({
        targetId: "target-1",
        providerType: "kimi-coding",
        credentialId: "cred-good",
        expectedRevision: fixture.revision,
      });
      // 保存后的首次同步即 403（自动链）：类别 auth + 计数 1。
      const row = fixture.service.store.getPlanSyncConfig("target-1")!;
      expect(row.status).toBe("auth_required");
      expect(row.lastSyncError).toBe("PLAN_AUTH_403");
      expect(row.consecutiveAutoFailures).toBe(1);
      expect(row.consecutiveFailureKind).toBe("auth");
      // 鉴权退避保持 30 分钟（2026-09-20 用户确认：重试频率不动，只提前亮标）。
      expect(Date.parse(row.nextSyncAt!) - Date.now()).toBeGreaterThanOrEqual(25 * 60_000);

      const {resolveTargetBadge, badgeInputFromOverview} = await import("../src/lib/sync-engine/target-health-badge.js");
      const overview = await fixture.service.overview(["target-1"]);
      const badge = resolveTargetBadge(badgeInputFromOverview(
        fixture.configStore.getConfig().targets[0]!,
        overview.targets[0],
      ), "Kimi");
      expect(badge).toMatchObject({kind: "sync_failure", label: "同步失败"});
      expect(badge?.title).toContain("套餐同步连续失败 1 次");
      expect(badge?.title).toContain("凭证/鉴权失败");

      // 恢复成功后标识立即消失。
      status = 200;
      await fixture.service.runPlanSync("target-1");
      const recovered = fixture.service.store.getPlanSyncConfig("target-1")!;
      expect(recovered.consecutiveAutoFailures).toBe(0);
      expect(recovered.consecutiveFailureKind).toBeNull();
    } finally {
      fixture.db.close();
    }
  });
});

describe("对账摘要口径（2026-09-28 修正）", () => {
  test("近24小时摘要读人民币 nano 物化列、仅自动补差、携带目标过滤", async () => {
    const fixture = await createFixture();
    try {
      const recent = new Date(Date.now() - 3_600_000).toISOString();
      const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
      // 自动补差：USD 2 × 冻结 fx 7 → actual_cost_nano = 14e9（人民币）。
      insertReconciliationAdjustment(fixture.db, {
        targetId: "target-1", provider: "sub2api", source: "matched", uniqueKey: "auto-recent",
        amountNano: 2_000_000_000, occurredAt: recent, hourStartUtc: recent, fxRateToCny: 7,
      });
      // 人工补差（同目标、同窗口）：不混入「已自动补差」。
      insertReconciliationAdjustment(fixture.db, {
        targetId: "target-1", provider: "sub2api", source: "manual", uniqueKey: "manual-recent",
        amountNano: 1_000_000_000, occurredAt: recent, hourStartUtc: recent, fxRateToCny: 1,
      });
      // 48 小时前的自动补差：不进 24h 窗口。
      insertReconciliationAdjustment(fixture.db, {
        targetId: "target-1", provider: "sub2api", source: "matched", uniqueKey: "auto-stale",
        amountNano: 5_000_000_000, occurredAt: stale, hourStartUtc: stale, fxRateToCny: 7,
      });

      const scoped = fixture.service.listReconciliationHours({targetId: "target-1"});
      expect(scoped.summary.autoApplied24hCount).toBe(1);
      // 修复前该值取 SUM(actual_cost)（USD 原币 2）；修复后为人民币 nano（2 × 7 = 14）。
      expect(scoped.summary.autoApplied24hNano).toBe(14_000_000_000);

      const all = fixture.service.listReconciliationHours({});
      expect(all.summary.autoApplied24hCount).toBe(1);
      expect(all.summary.autoApplied24hNano).toBe(14_000_000_000);
      expect(all.summary.needsReviewCount).toBe(0);
    } finally {
      fixture.db.close();
    }
  });
});
