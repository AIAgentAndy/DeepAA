import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ProxyConfig } from "../src/types.js";
import { ProxyConfigStore } from "../src/proxy-config.js";
import type {
  DevelopmentPlatformAdapter,
  DirectorySelection,
  TerminalLaunchRequest,
} from "../src/lib/development-launch/platform.js";
import type { DevelopmentCli, PlatformCapabilities, TerminalCapability } from "../src/lib/development-launch/types.js";
import { CredentialMetadataRepository, createCredentialMetadata } from "../src/lib/development-launch/credential-metadata.js";
import { DevelopmentLaunchService } from "../src/lib/development-launch/service.js";
import type {CliSyncWarning} from "../src/lib/config-sync/core/types.js";
import type { PricingConfig } from "../src/lib/pricing.js";
import {
  LaunchNonceStore,
  assertLocalReadRequest,
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
} from "../src/lib/development-launch/security.js";
import { POST as startDevelopment } from "../src/app/api/development-launch/start/route.js";

const tempRoots: string[] = [];
const RESUME_SESSION_ID = "019b4a2c-8f30-7a21-b233-4d89283f76a1";

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("development launch request security", () => {
  test("敏感只读预览只允许 same-origin loopback GET", () => {
    const allowed = new Request("http://localhost:3210/api/config-sync/file?fileId=x", {
      headers: {origin: "http://localhost:3210", host: "localhost:3210", "sec-fetch-site": "same-origin"},
    });
    expect(() => assertLocalReadRequest(allowed)).not.toThrow();
    const denied = new Request("http://localhost:3210/api/config-sync/file?fileId=x", {
      headers: {origin: "https://attacker.example", host: "localhost:3210", "sec-fetch-site": "cross-site"},
    });
    expect(() => assertLocalReadRequest(denied)).toThrow("LOCAL_ORIGIN_REQUIRED");
  });

  test("浏览器同源 GET 未携带 Origin 时仍允许读取受管文件", () => {
    const browserGet = new Request("http://localhost:3210/api/config-sync/file?fileId=codex:codex-config:0", {
      headers: {host: "localhost:3210", "sec-fetch-site": "same-origin"},
    });
    expect(() => assertLocalReadRequest(browserGet)).not.toThrow();
  });

  test("无 Origin 的跨站 GET 仍拒绝读取受管文件", () => {
    const crossSiteGet = new Request("http://localhost:3210/api/config-sync/file?fileId=codex:codex-config:0", {
      headers: {host: "localhost:3210", "sec-fetch-site": "cross-site"},
    });
    expect(() => assertLocalReadRequest(crossSiteGet)).toThrow("LOCAL_ORIGIN_REQUIRED");
  });

  test("accepts same-origin loopback JSON requests and rejects remote origins", () => {
    const allowed = new Request("http://localhost:3210/api/development-launch/start", {
      method: "POST",
      headers: {
        origin: "http://localhost:3210",
        host: "localhost:3210",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(() => assertLocalMutationRequest(allowed)).not.toThrow();

    const denied = new Request("http://localhost:3210/api/development-launch/start", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        host: "localhost:3210",
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    expect(() => assertLocalMutationRequest(denied)).toThrow("LOCAL_ORIGIN_REQUIRED");

    const invalidScheme = new Request("http://localhost:3210/api/development-launch/start", {
      method: "POST",
      headers: {
        origin: "ftp://localhost:3210",
        host: "localhost:3210",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(() => assertLocalMutationRequest(invalidScheme)).toThrow("LOCAL_ORIGIN_REQUIRED");
  });

  test("consumes a short-lived nonce only once", () => {
    const nonces = new LaunchNonceStore({ ttlMs: 1_000, now: () => 1_000 });
    const nonce = nonces.issue();

    expect(nonces.consume(nonce)).toBe(true);
    expect(nonces.consume(nonce)).toBe(false);
  });

  test("stops reading a chunked JSON body as soon as it exceeds the byte limit", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16 * 1024));
        if (pulls >= 20) controller.close();
      },
    });
    const request = new Request("http://localhost:3210/api/development-launch/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedJson(request)).rejects.toThrow("REQUEST_TOO_LARGE");
    expect(pulls).toBeLessThan(20);
  });

  test("maps validation failures to stable user-facing messages without raw details", async () => {
    const response = developmentLaunchErrorResponse(new Error("CREDENTIAL_LABEL_REQUIRED"));
    const body = await response.json() as { error: string; message: string };

    expect(body).toEqual({
      error: "CREDENTIAL_LABEL_REQUIRED",
      message: "请输入 1 至 80 个字符的密钥名称",
    });
  });

  test("价格中心冲突错误保留稳定错误码而不是退化为 DEVELOPMENT_LAUNCH_FAILED", async () => {
    const response = developmentLaunchErrorResponse(new Error("PRICING_ENTRY_ID_CONFLICT:azure/eu/gpt-4o-mini-realtime-preview-2024-12-17"));
    const body = await response.json() as {error: string; message: string};
    expect(body.error).toBe("PRICING_ENTRY_ID_CONFLICT");
    expect(body.message).toContain("价格中心");
    expect(body.message).not.toBe("操作失败：DEVELOPMENT_LAUNCH_FAILED");
  });

  test.each([
    "MODEL_PRICE_ENTRY_NOT_FOUND",
    "MODEL_PRICE_VENDOR_MISMATCH",
    "MODEL_PRICE_RUNTIME_MISMATCH",
    "MODEL_PRICE_MISSING",
  ])("价格映射错误 %s 返回可读中文提示", async code => {
    const response = developmentLaunchErrorResponse(new Error(code));
    const body = await response.json() as {error: string; message: string};
    expect(body.error).toBe(code);
    expect(body.message).not.toContain(code);
    expect(body.message).toContain("价格中心");
  });

  test("启动 API 在调用服务前拒绝非法 Session ID", async () => {
    const nonce = getLaunchNonceStore().issue();
    const response = await startDevelopment(new Request(
      "http://localhost:3210/api/development-launch/start",
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
          targetId: "openai-target",
          projectDir: "/tmp/project",
          credentialId: "cred_primary",
          terminal: "terminal.app",
              selectedModel: "gpt-5.6",
          manualOverrides: {},
          resumeSessionId: "--last",
        }),
      },
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_RESUME_SESSION_ID",
      message: "Session ID 必须是规范 UUID，或留空以新建会话",
    });
  });
});

describe("development launch service", () => {
  test("blocks a new Agent before terminal launch when proxy has not applied the config revision", async () => {
    const fixture = await serviceFixture({routingApplied: false});
    const credential = createCredentialMetadata({
      targetId: "openai-target",
      label: "Primary",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("PROXY_CONFIG_NOT_APPLIED");
    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("开发预检返回已保存目标的供应商和配置模型可用状态", async () => {
    const fixture = await serviceFixture();
    await mkdir(join(fixture.homeDir, ".codex"), { recursive: true });
    await writeFile(
      join(fixture.homeDir, ".codex", "config.toml"),
      'model = "gpt-5.6"\n',
      "utf-8",
    );

    const result = await fixture.service.preflight({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
    });

    expect(result.modelSelection).toEqual({
      vendor: "openai",
      configuredModel: {
        value: "gpt-5.6",
        source: "user",
        available: true,
      },
    });
  });

  test("重新解析目标 URL 并把无密钥的直接命令交给终端", async () => {
    const fixture = await serviceFixture();
    const secret = "sk-sensitive-never-in-plan";
    const credential = createCredentialMetadata({
      id: "cred_primary",
      targetId: "openai-target",
      label: "主密钥",
      platform: "darwin",
      secret,
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
      localBaseUrl: "https://attacker.example" as never,
    });

    const launch = fixture.adapter.launches[0]!;
    const serialized = JSON.stringify(launch);
    expect(launch.executablePath).toBe("/usr/local/bin/codex");
    expect(launch.args).toContain("-m");
    expect(serialized).toContain("http://127.0.0.1:3211/codex/v1");
    expect(serialized).toContain("gpt-5.6_openai-target");
    expect(serialized).not.toContain("attacker.example");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("development-bootstrap");
    expect(serialized).not.toContain("launch.json");
    expect(fixture.adapter.launches).toHaveLength(1);
    expect(result).not.toHaveProperty("planPath");
    expect(fixture.configProvider.config.targets?.find(item => item.id === "openai-target")?.development).toEqual({
      preferredTerminal: "terminal.app",
      defaultCredentials: {codex: "cred_primary"},
      defaultModels: {codex: "gpt-5.6"},
      lastProjectDir: await realpath(fixture.projectDir),
    });
    expect(result.defaultNotice).toBe("已设为 Codex 默认供应商，默认模型：gpt-5.6");
  });

  test("预检返回已落库 launchPreferences 供弹窗回填存量值（2026-10-06）", async () => {
    const fixture = await serviceFixture();
    // 两次预检用不同 projectDir 规避 3s 结果缓存。
    const empty = await fixture.service.preflight({cli: "codex", targetId: "openai-target"});
    expect(empty.launchPreferences).toBeNull();

    fixture.configProvider.config.agentConnections.codex!.launchPreferences = {
      reasoningEffort: "low",
      contextWindows: {"gpt-5.6_openai-target": 200000},
    };
    const stored = await fixture.service.preflight({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
    });
    expect(stored.launchPreferences).toEqual({
      reasoningEffort: "low",
      contextWindows: {"gpt-5.6_openai-target": 200000},
    });
  });

  test("Codex 客户端模式偏好确有变化时给出条件式重启提示，未变化保持静默（2026-10-06）", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_client_hint",
      targetId: "openai-target",
      label: "客户端密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);
    const launch = (contextWindows?: Record<string, number>) =>
      fixture.service.start({
        cli: "codex",
        targetId: "openai-target",
        credentialId: credential.id,
        terminal: "codex-client",
        selectedModel: "gpt-5.6",
        manualOverrides: {},
        launchPreferences: contextWindows
          ? {contextWindows}
          : {},
      });

    // 偏好确有变化（无 → 有）：给出常驻条件式提示（无法探测客户端是否在运行）。
    const changed = await launch({"gpt-5.6_openai-target": 200000});
    expect(changed.preferenceApplyHint).toContain("Codex 桌面客户端");
    expect(changed.appliedButRequiresRestart).toBeFalsy();

    // 相同偏好重复启动：无变化 → 静默不打扰。
    const unchanged = await launch({"gpt-5.6_openai-target": 200000});
    expect(unchanged.preferenceApplyHint).toBeUndefined();
  });

  test("启动前 preSync 的 CLI 同步警告透传到 start 响应（appliedSyncWarnings）", async () => {
    const fixture = await serviceFixture({
      syncReportWarnings: [{
        targetId: "openai-target",
        code: "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED",
        message: "OpenAI target 的模型 gpt-5.6 不支持推理档 medium，已回退默认档 max",
      }],
    });
    const credential = createCredentialMetadata({
      id: "cred_sync_warning",
      targetId: "openai-target",
      label: "主密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
      launchPreferences: {reasoningEffort: "high"},
    });

    expect(result.appliedSyncWarnings).toEqual([{
      code: "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED",
      message: "OpenAI target 的模型 gpt-5.6 不支持推理档 medium，已回退默认档 max",
      targetId: "openai-target",
    }]);
  });

  test("仅为本次启动传递规范化后的 Session ID", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_resume",
      targetId: "openai-target",
      label: "恢复会话",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      resumeSessionId: `  ${RESUME_SESSION_ID.toUpperCase()}  `,
      manualOverrides: {},
    });

    const launch = fixture.adapter.launches[0]!;
    expect(launch.args[0]).toBe("resume");
    expect(launch.args.at(-1)).toBe(RESUME_SESSION_ID);
    expect(fixture.configProvider.config.targets?.[0]?.development).toEqual({
      preferredTerminal: "terminal.app",
      defaultCredentials: {codex: credential.id},
      defaultModels: {codex: "gpt-5.6"},
      lastProjectDir: await realpath(fixture.projectDir),
    });
    expect(JSON.stringify(fixture.configProvider.config)).not.toContain(RESUME_SESSION_ID);
  });

  test("rejects missing model, missing credential, and disabled targets", async () => {
    const fixture = await serviceFixture();

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: "cred_missing",
      terminal: "terminal.app",
      selectedModel: "",
      manualOverrides: {},
    })).rejects.toThrow("MODEL_SELECTION_REQUIRED");

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: "cred_missing",
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("CREDENTIAL_REQUIRED");

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: "cred_missing",
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: { sandboxMode: 42 as never },
    })).rejects.toThrow("INVALID_OVERRIDE");

    await expect(fixture.service.preflight({
      cli: "codex",
      targetId: "disabled-target",
      projectDir: fixture.projectDir,
    })).rejects.toThrow("TARGET_DISABLED");
  });

  test("开发预检拒绝仅支持 chat/completions 的官方预设启动 Codex", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.targets[0] = {
      ...fixture.configProvider.config.targets[0]!,
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      supportedModelWireApis: {"gpt-5.6": ["chat_completions"]},
    };

    // Codex 只支持 Responses，chat 预设不满足时预检直接拒绝。
    await expect(fixture.service.preflight({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
    })).rejects.toThrow("PRESET_WIRE_API_UNSUPPORTED");
  });

  test("blocks deleting the last credential of a target", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_last",
      targetId: "openai-target",
      label: "唯一密钥",
      platform: "darwin",
      secret: "sk-last-secret",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.deleteCredential({
      targetId: "openai-target",
      credentialId: "cred_last",
    })).rejects.toThrow("CREDENTIAL_LAST_REQUIRED");
    // 元数据与系统凭据都保持不变。
    expect(await fixture.credentials.find("cred_last")).toBeDefined();
    expect((await fixture.credentials.list("openai-target")).map(item => item.id)).toEqual(["cred_last"]);
  });

  test("目标配置已删除后仍可级联清理该目标的凭据元数据", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_orphan",
      targetId: "openai-target",
      label: "待清理密钥",
      platform: "darwin",
      secret: "sk-orphan-secret",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);
    fixture.configProvider.config.targets = fixture.configProvider.config.targets.filter(item => item.id !== "openai-target");

    await expect(fixture.service.purgeTargetCredentials("openai-target")).resolves.toEqual({removed: 1});
    expect(await fixture.credentials.find("cred_orphan")).toBeUndefined();
  });

  test("级联清理系统凭据失败时保留元数据并返回逐条失败明细", async () => {
    const fixture = await serviceFixture({credentialDeleteFails: true});
    const credential = createCredentialMetadata({
      id: "cred_purge_failed",
      targetId: "openai-target",
      label: "清理失败密钥",
      platform: "darwin",
      secret: "sk-purge-failed",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);
    fixture.configProvider.config.targets = fixture.configProvider.config.targets.filter(item => item.id !== "openai-target");

    await expect(fixture.service.purgeTargetCredentials("openai-target")).resolves.toEqual({
      removed: 0,
      failed: [{credentialId: "cred_purge_failed", code: "CREDENTIAL_DELETE_FAILED"}],
    });
    expect(await fixture.credentials.find("cred_purge_failed")).toBeDefined();
  });

  test("未启用目标仍可配置密钥，不要求先启用；启动仍被拒绝", async () => {
    const fixture = await serviceFixture();
    // disabled-target 未启用，但凭据操作允许：先配密钥后启用。
    expect(await fixture.service.listCredentials("disabled-target")).toEqual([]);
    const created = await fixture.service.createCredential({
      targetId: "disabled-target",
      label: "预配置密钥",
      secret: "sk-disabled-secret",
      agentScope: ["codex"],
    });
    expect(created.targetId).toBe("disabled-target");
    expect((await fixture.service.listCredentials("disabled-target")).map(item => item.id)).toEqual([created.id]);
    expect(fixture.configProvider.config.targets.find(item => item.id === "disabled-target")?.development?.defaultCredentials)
      .toEqual({codex: created.id});
    // 未启用目标仍不允许启动开发。
    await expect(fixture.service.start({
      cli: "codex",
      targetId: "disabled-target",
      projectDir: fixture.projectDir,
      credentialId: created.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("TARGET_DISABLED");
  });

  test("默认链配置保存失败时回滚刚创建的凭据元数据", async () => {
    const fixture = await serviceFixture({configUpdateFails: true});

    await expect(fixture.service.createCredential({
      targetId: "openai-target",
      label: "回滚测试密钥",
      secret: "sk-rollback-secret",
      agentScope: ["codex"],
    })).rejects.toThrow("CONFIG_REVISION_CONFLICT");

    expect(await fixture.credentials.list("openai-target")).toEqual([]);
  });

  test("拒绝代理目标不支持的模型", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_model_validation",
      targetId: "openai-target",
      label: "模型校验",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "claude-sonnet-4-5",
      manualOverrides: {},
    })).rejects.toThrow("MODEL_NOT_SUPPORTED_BY_TARGET");

    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("开发启动拒绝缺少价格中心映射的模型", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_unpriced",
      targetId: "openai-target",
      label: "未定价测试",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);
    fixture.configProvider.config.targets[0]!.pricing = {vendor: "openai", rateMultiplier: 1};

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("MODEL_PRICE_MAPPING_REQUIRED");
    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("rejects an explicit unavailable terminal instead of silently falling back", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_terminal",
      targetId: "openai-target",
      label: "终端测试",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "not-installed",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("TERMINAL_NOT_FOUND");
    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("blocks launch when the operating-system credential store is unavailable", async () => {
    const fixture = await serviceFixture({ credentialStoreAvailable: false });
    const credential = createCredentialMetadata({
      id: "cred_unavailable",
      targetId: "openai-target",
      label: "不可用凭据库",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("CREDENTIAL_STORE_UNAVAILABLE");
    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("allows only one terminal launch while the first launch is still in progress", async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
    const fixture = await serviceFixture({ launchGate });
    const credential = createCredentialMetadata({
      id: "cred_concurrent",
      targetId: "openai-target",
      label: "并发测试",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);
    const input = {
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    };

    const first = fixture.service.start(input);
    await waitFor(() => fixture.adapter.launches.length === 1);
    await expect(fixture.service.start(input)).rejects.toThrow("LAUNCH_IN_PROGRESS");
    releaseLaunch();
    await first;

    expect(fixture.adapter.launches).toHaveLength(1);
  });

  test("启动成功后提升该 Agent 默认代理并写入目标默认模型，再触发 CLI 同步", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_default",
      targetId: "openai-target",
      label: "主密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    });
    expect(fixture.configProvider.config.agentConnections.codex?.defaultTargetId).toBe("openai-target");
    expect(fixture.configProvider.config.targets?.[0]?.development?.defaultModels?.codex).toBe("gpt-5.6");
    expect(fixture.configProvider.config.targets?.[0]?.development?.defaultCredentials?.codex).toBe("cred_default");
    expect(result.defaultNotice).toBe("已设为 Codex 默认供应商，默认模型：gpt-5.6");
    // 启动前预同步 + 启动后持久化同步各一次。
    expect(fixture.syncedConfigs).toHaveLength(2);
    expect(fixture.syncedConfigs[1]?.agentConnections.codex?.defaultTargetId).toBe("openai-target");
    expect(fixture.adapter.launches).toHaveLength(1);
  });

  test("启动切换默认供应商时保留 Agent 原有其它绑定供应商", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.targets?.push({
      id: "legacy-target",
      name: "Legacy target",
      openaiUrl: "https://legacy.example/v1",
      enabled: true,
      supportedModels: ["gpt-5.6"],
      supportedModelScopes: {"gpt-5.6": ["codex"]},
      supportedModelWireApis: {"gpt-5.6": ["responses"]},
      pricing: {vendor: "openai", rateMultiplier: 1, modelVendors: {
        "gpt-5.6": {vendor: "openai", priceEntryId: "openai:gpt-5.6"},
      }},
      development: {defaultModels: {codex: "gpt-5.6"}},
    });
    fixture.configProvider.config.agentConnections.codex = {
      boundTargetIds: ["legacy-target", "openai-target"],
      defaultTargetId: "legacy-target",
      cliSyncEnabled: true,
    };
    const credential = createCredentialMetadata({
      id: "cred_switch_target",
      targetId: "openai-target",
      label: "切换供应商密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    });

    expect(fixture.configProvider.config.agentConnections.codex?.defaultTargetId).toBe("openai-target");
    expect(fixture.configProvider.config.agentConnections.codex?.boundTargetIds)
      .toEqual(["legacy-target", "openai-target"]);
  });

  test("订阅目标启动不要求系统凭据，settings 省略占位 token，持久化不写默认密钥", async () => {
    const fixture = await serviceFixture({credentialStoreAvailable: false});
    fixture.configProvider.config.targets = [{
      id: "anthropic-sub",
      name: "Claude 订阅",
      billingChannel: "subscription",
      anthropicUrl: "https://api.anthropic.com",
      enabled: true,
      supportedModels: ["claude-sonnet-4-5"],
      supportedModelScopes: {"claude-sonnet-4-5": ["claude"]},
      supportedModelWireApis: {"claude-sonnet-4-5": ["messages"]},
      pricing: {vendor: "anthropic", rateMultiplier: 1, modelVendors: {
        "claude-sonnet-4-5": {vendor: "anthropic", priceEntryId: "anthropic:claude-sonnet-4-5"},
      }},
      development: {defaultModels: {claude: "claude-sonnet-4-5"}},
    }];
    fixture.configProvider.config.agentConnections = {
      claude: {defaultTargetId: "anthropic-sub", cliSyncEnabled: true},
    };

    const result = await fixture.service.start({
      cli: "claude",
      targetId: "anthropic-sub",
      projectDir: fixture.projectDir,
      terminal: "terminal.app",
      selectedModel: "claude-sonnet-4-5",
      manualOverrides: {},
    });

    expect(fixture.adapter.launches).toHaveLength(1);
    expect(result.defaultNotice).toBe("已设为 Claude Code 默认供应商，默认模型：claude-sonnet-4-5");
    const launchRoot = join(fixture.root, "deepaa-launch");
    const entries = await readdir(launchRoot);
    const settingsPath = join(launchRoot, entries[0]!, "claude-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {env: Record<string, string>};
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3211/claude");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(fixture.configProvider.config.targets?.[0]?.development?.defaultCredentials).toBeUndefined();
    expect(fixture.syncedConfigs).toHaveLength(2);
  });

  test("persists only validated development preferences on proxy targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-target-config-"));
    tempRoots.push(root);
    const store = new ProxyConfigStore({
      configPath: join(root, "proxy-config.json"),
    });
    await store.init();
    await store.updateConfig({
      targets: [{
        id: "openai-target",
        name: "openai",
        openaiUrl: "https://api.openai.com",
        enabled: true,
        supportedModels: ["gpt-5.6"],
      }],
    });
    const target = store.getConfig().targets![0]!;
    const updated = await store.updateConfig({
      targets: [{
        ...target,
        development: {
          defaultCredentials: {codex: "cred_primary"},
          preferredTerminal: "terminal.app",
        },
      }],
    });

    expect(updated.targets?.[0]?.development).toEqual({
      defaultCredentials: {codex: "cred_primary"},
      preferredTerminal: "terminal.app",
    });
    await expect(store.updateConfig({
      targets: [{
        ...target,
        development: { defaultCredentials: {codex: "../../secret"} },
      }],
    })).rejects.toThrow("Invalid development credential id");
  });

  test("目标级倍率概念已移除：pricing 不再保留 rateMultiplier", async () => {
    const root = await mkdtemp(join(tmpdir(), "proxy-config-rate-sync-"));
    tempRoots.push(root);
    const credentialsPath = join(root, "development-credentials.json");
    await writeFile(credentialsPath, JSON.stringify({
      version: 1,
      credentials: [{
        id: "cred_default",
        targetId: "openai-target",
        label: "默认密钥",
        store: "macos-keychain",
        account: "cred_default",
        fingerprintSuffix: "abcd",
        rateMultiplier: 0.16,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      }],
    }));
    const store = new ProxyConfigStore({
      configPath: join(root, "proxy-config.json"),
      developmentCredentialsPath: credentialsPath,
    });
    await store.init();

    await store.updateConfig({
      targets: [{
        id: "openai-target",
        name: "openai",
        openaiUrl: "https://api.openai.com",
        enabled: true,
        supportedModels: ["gpt-5.6"],
        pricing: {rateMultiplier: 0.8},
        development: { defaultCredentials: {codex: "cred_default"} },
      }],
    });
    // 传入的 rateMultiplier 在归一化时被丢弃；倍率只有密钥一层。
    expect(store.getConfig().targets?.[0]?.pricing?.rateMultiplier).toBeUndefined();

    await store.updateConfig({
      targetPatch: {
        id: "openai-target",
        target: { development: undefined },
      },
    });
    expect(store.getConfig().targets?.[0]?.pricing?.rateMultiplier).toBeUndefined();
  });

  test("修改任意密钥倍率都不覆盖目标级倍率", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.targets[0]!.development = { defaultCredentials: {codex: "cred_rate_sync"} };
    const credential = createCredentialMetadata({
      id: "cred_rate_sync",
      targetId: "openai-target",
      label: "倍率密钥",
      platform: "darwin",
      secret: "secret-value",
      rateMultiplier: 0.5,
      agentScope: ["codex"],
    });
    const other = createCredentialMetadata({
      id: "cred_other_rate",
      targetId: "openai-target",
      label: "备用密钥",
      platform: "darwin",
      secret: "secret-value-2",
      rateMultiplier: 0.21,
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);
    await fixture.credentials.upsert(other);

    // 非默认密钥修改倍率不影响目标级倍率。
    await fixture.service.updateCredential({
      targetId: "openai-target",
      credentialId: "cred_other_rate",
      rateMultiplier: 0.09,
    });
    expect(fixture.configProvider.config.targets?.[0]?.pricing?.rateMultiplier).toBe(1);

    // Agent 默认密钥的倍率也只保存在凭据元数据中，不覆盖目标级倍率。
    await fixture.service.updateCredential({
      targetId: "openai-target",
      credentialId: "cred_rate_sync",
      rateMultiplier: 0.16,
    });
    expect(fixture.configProvider.config.targets?.[0]?.pricing?.rateMultiplier).toBe(1);
  });

  test("更新密钥时显式清空 Agent 归属记录为空数组（未选择任何 Agent）", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_scope_clear",
      targetId: "openai-target",
      label: "Codex 专用密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    const updated = await fixture.service.updateCredential({
      targetId: "openai-target",
      credentialId: credential.id,
      agentScope: null,
    });

    // 显式记录勾选结果：清空即空数组，不做「全部 Agent」推断。
    expect(updated.agentScope).toEqual([]);
    expect((await fixture.credentials.find(credential.id))?.agentScope).toEqual([]);
  });

  test("预检不传项目目录仍可成功，并返回目标上次使用的目录", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.targets![0]!.development = { lastProjectDir: fixture.projectDir };

    const result = await fixture.service.preflight({
      cli: "codex",
      targetId: "openai-target",
    });

    expect(result.projectDir).toBeUndefined();
    expect(result.lastProjectDir).toBe(fixture.projectDir);
    expect(result.credentials).toEqual([]);
  });

  test("预检提供失效目录时仍拒绝", async () => {
    const fixture = await serviceFixture();

    await expect(fixture.service.preflight({
      cli: "codex",
      targetId: "openai-target",
      projectDir: join(fixture.root, "missing-dir"),
    })).rejects.toThrow("INVALID_PROJECT_DIR");
  });

  test("Codex 客户端模式无需项目目录：偏好落库并同步目录条目后打开客户端", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_client",
      targetId: "openai-target",
      label: "客户端密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      credentialId: credential.id,
      terminal: "codex-client",
      selectedModel: "gpt-5.6",
      manualOverrides: {sandboxMode: "workspace-write"},
      // 能力类参数经 launchPreferences 落库并写入目录条目（键为网关模型 ID）。
      launchPreferences: {
        reasoningEffort: "high",
        contextWindows: {"gpt-5.6_openai-target": 200000},
        autoCompactTokenLimits: {"gpt-5.6_openai-target": 160000},
      },
    });

    expect(fixture.codexLaunches).toEqual([{executablePath: "/usr/local/bin/codex"}]);
    expect(fixture.adapter.launches).toHaveLength(0);
    const codexToml = await readFile(join(fixture.homeDir, ".codex", "config.toml"), "utf-8");
    expect(codexToml).toContain('model = "gpt-5.6_openai-target"');
    expect(codexToml).toContain('model_provider = "deepaa_gateway"');
    expect(codexToml).toContain('sandbox_mode = "workspace-write"');
    // 2026-10-02 修复：顶层能力键对目录内网关模型被条目级能力位覆盖，
    // 不再写入 config.toml；改为写入目录条目。
    expect(codexToml).not.toContain("model_reasoning_effort");
    expect(codexToml).not.toContain("model_context_window");
    expect(codexToml).not.toContain("model_auto_compact_token_limit");
    expect(codexToml).not.toContain("approval_policy");
    // 偏好在拉起客户端前落库并随同步传递（目录条目消费同一份偏好）。
    const expectedPreferences = {
      reasoningEffort: "high",
      contextWindows: {"gpt-5.6_openai-target": 200000},
      autoCompactTokenLimits: {"gpt-5.6_openai-target": 160000},
    };
    expect(fixture.configProvider.config.agentConnections.codex?.launchPreferences)
      .toEqual(expectedPreferences);
    expect(fixture.syncedConfigs.at(-1)?.agentConnections.codex?.launchPreferences)
      .toEqual(expectedPreferences);
    // 客户端模式闭环：受管配置同步（目录条目消费偏好）发生在拉起客户端之前。
    expect(fixture.launchEvents.indexOf("codex-launch")).toBeGreaterThan(0);
    expect(fixture.launchEvents.indexOf("sync")).toBeLessThan(fixture.launchEvents.indexOf("codex-launch"));
    // 2026-10-06 定向同步：preSync 与启动后持久化同步都只刷本次 Agent（codex），
    // 其它 Agent 的受管文件不被无关启动触碰。
    expect(fixture.syncAgentsOptions).toEqual([{agents: ["codex"]}, {agents: ["codex"]}]);
    expect(fixture.configProvider.config.targets?.find(item => item.id === "openai-target")?.development).toEqual({
      defaultCredentials: {codex: "cred_client"},
      defaultModels: {codex: "gpt-5.6"},
    });
    expect(result.defaultNotice).toBe("已设为 Codex 默认供应商，默认模型：gpt-5.6");
  });

  test("客户端模式启动不持久化 lastProjectDir", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_client_no_dir",
      targetId: "openai-target",
      label: "客户端无目录",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      credentialId: credential.id,
      terminal: "codex-client",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    });

    expect(fixture.configProvider.config.targets?.[0]?.development).toEqual({
      defaultCredentials: {codex: "cred_client_no_dir"},
      defaultModels: {codex: "gpt-5.6"},
    });
    expect(fixture.codexLaunches).toHaveLength(1);
  });

  test("Codex 客户端模式选填项目目录：经 codex app [PATH] 打开该工作区并记录 lastProjectDir", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_client_dir",
      targetId: "openai-target",
      label: "客户端密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);
    const workspaceDir = join(fixture.root, "client-workspace");
    await mkdir(workspaceDir, {recursive: true});
    const canonicalWorkspace = await realpath(workspaceDir);

    await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      credentialId: credential.id,
      terminal: "codex-client",
      selectedModel: "gpt-5.6",
      projectDir: workspaceDir,
      manualOverrides: {},
    });

    expect(fixture.codexLaunches).toEqual([
      {executablePath: "/usr/local/bin/codex", workspacePath: canonicalWorkspace},
    ]);
    expect(fixture.adapter.launches).toHaveLength(0);
    // 客户端模式携带目录时同样记录 lastProjectDir，供下次弹窗预填。
    expect(fixture.configProvider.config.targets?.[0]?.development?.lastProjectDir).toBe(canonicalWorkspace);
  });

  test("官方直连形态（客户端）：不写任何网关配置直接拉起客户端，持久化跳过默认模型", async () => {
    const fixture = await serviceFixture();
    // CLI 形态为官方模式（弹窗「确认切换为官方模式并启动」切换后的落库状态），
    // 目标按 openai-subscription 预设的通道形态模拟（订阅透传）。
    const config = fixture.configProvider.config;
    config.agentConnections.codex!.cliSyncEnabled = false;
    const target = config.targets.find(item => item.id === "openai-target")!;
    target.billingChannel = "subscription";

    const result = await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      terminal: "codex-client",
      // 官方模式无网关模型概念：不携带模型/密钥/偏好。
      manualOverrides: {},
    });

    expect(fixture.codexLaunches).toEqual([{executablePath: "/usr/local/bin/codex"}]);
    expect(fixture.adapter.launches).toHaveLength(0);
    // writeCodexDefaultModel 必须跳过：config.toml 不得被写入网关键
    //（否则顶层指向已清空的 deepaa_gateway provider，形成撕裂态）。
    await expect(readFile(join(fixture.homeDir, ".codex", "config.toml"), "utf-8")).rejects.toThrow();
    // preSync 跳过：拉起客户端之前零同步；仅启动后持久化同步一次（官方模式产物为幂等清理层）。
    expect(fixture.launchEvents).toEqual(["codex-launch", "sync"]);
    expect(fixture.syncAgentsOptions).toEqual([{agents: ["codex"]}]);
    // 持久化：默认供应商已切换、cliSyncEnabled 保持官方模式，但不写默认模型（官方模式无网关模型）。
    expect(config.agentConnections.codex?.defaultTargetId).toBe("openai-target");
    expect(config.agentConnections.codex?.cliSyncEnabled).toBe(false);
    expect(target.development?.defaultModels).toBeUndefined();
    expect(result.defaultNotice).toBe("已设为 Codex 默认供应商（官方直连，模型在官方客户端内选择）");
  });

  test("官方直连形态（终端）：命令不注入任何网关 provider/模型参数", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.agentConnections.codex!.cliSyncEnabled = false;

    await fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      terminal: "terminal.app",
      manualOverrides: {sandboxMode: "read-only"},
    });

    expect(fixture.codexLaunches).toHaveLength(0);
    expect(fixture.adapter.launches).toHaveLength(1);
    const request = fixture.adapter.launches[0]!;
    expect(request.args).not.toContain("-m");
    expect(request.args.join(" ")).not.toContain("deepaa_gateway");
    expect(request.args).toContain("-C");
    // sandbox 是 Codex 原生顶层键，官方模式仍可携带。
    expect(request.args.join(" ")).toContain("read-only");
    // 终端路径同样不写 config.toml。
    await expect(readFile(join(fixture.homeDir, ".codex", "config.toml"), "utf-8")).rejects.toThrow();
  });

  test("网关模式（cliSyncEnabled 未关闭）仍强制模型选择与价格映射", async () => {
    const fixture = await serviceFixture();
    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      terminal: "codex-client",
      manualOverrides: {},
    })).rejects.toThrow("MODEL_SELECTION_REQUIRED");
  });

  test("ZCode App 形态：选填工作区经深链拉起，高级设置偏好落库并随启动前同步生效", async () => {
    // 冷启动场景：首次探测（未运行判定）返回 false，拉起后的就绪轮询返回 true。
    let zcodeProbeCalls = 0;
    const fixture = await serviceFixture({zcodeAppRunning: () => ++zcodeProbeCalls > 1});
    const config = fixture.configProvider.config;
    config.targets.push({
      id: "zhipu-zcode",
      name: "智谱 Coding Plan",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      enabled: true,
      supportedModels: ["glm-5.3"],
      supportedModelScopes: {"glm-5.3": ["zcode"]},
      supportedModelWireApis: {"glm-5.3": ["messages"]},
      pricing: {vendor: "zhipu", rateMultiplier: 1, modelVendors: {
        "glm-5.3": {vendor: "zhipu", priceEntryId: "zhipu:glm-5.3"},
      }},
    });
    config.agentConnections.zcode = {
      boundTargetIds: ["zhipu-zcode"],
      defaultTargetId: "zhipu-zcode",
      cliSyncEnabled: true,
    };
    const credential = createCredentialMetadata({
      id: "cred_zcode",
      targetId: "zhipu-zcode",
      label: "智谱密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["zcode"],
    });
    await fixture.credentials.upsert(credential);
    const workspaceDir = join(fixture.root, "workspace");
    await mkdir(workspaceDir, {recursive: true});
    // validateProjectDirectory 会 realpath 规范化（macOS /var → /private/var）。
    const canonicalWorkspace = await realpath(workspaceDir);

    const result = await fixture.service.start({
      cli: "zcode",
      targetId: "zhipu-zcode",
      credentialId: credential.id,
      selectedModel: "glm-5.3",
      projectDir: workspaceDir,
      manualOverrides: {},
      launchPreferences: {reasoningEffort: "low", contextWindows: {"glm-5.3_zhipu-zcode": 500000}},
    });

    expect(result.zcodeAlreadyRunning).toBeFalsy();
    // 冷启动 + 工作区：先拉起 App，就绪后再发 zcode:// 深链打开工作区，且不走终端。
    expect(fixture.zcodeLaunches).toEqual([
      {appPath: "/Applications/ZCode.app", workspacePath: undefined},
      {appPath: "/Applications/ZCode.app", workspacePath: canonicalWorkspace},
    ]);
    expect(fixture.adapter.launches).toHaveLength(0);
    // 偏好在启动前落库，随启动前同步传递给适配器。
    expect(config.agentConnections.zcode?.launchPreferences)
      .toEqual({reasoningEffort: "low", contextWindows: {"glm-5.3_zhipu-zcode": 500000}});
    expect(fixture.syncedConfigs.at(-1)?.agentConnections.zcode?.launchPreferences)
      .toEqual({reasoningEffort: "low", contextWindows: {"glm-5.3_zhipu-zcode": 500000}});
    expect(result.defaultNotice).toBe("已设为 ZCode 默认供应商，默认模型：glm-5.3");

    // 偏好值域校验：dsh 专属的 permissionMode 不允许出现在 zcode 偏好里。
    await expect(fixture.service.start({
      cli: "zcode",
      targetId: "zhipu-zcode",
      credentialId: credential.id,
      selectedModel: "glm-5.3",
      manualOverrides: {},
      launchPreferences: {permissionMode: "workspace-write"},
    })).rejects.toThrow("INVALID_LAUNCH_PREFERENCE");
  });

  test("ZCode 已在运行且选了工作区：深链打开工作区而非仅切焦点（2026-09-14 B 修复）", async () => {
    const fixture = await serviceFixture({zcodeAppRunning: () => true});
    const config = fixture.configProvider.config;
    config.targets.push({
      id: "zhipu-zcode2",
      name: "智谱 Coding Plan",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      enabled: true,
      supportedModels: ["glm-5.3"],
      supportedModelScopes: {"glm-5.3": ["zcode"]},
      supportedModelWireApis: {"glm-5.3": ["messages"]},
      pricing: {vendor: "zhipu", rateMultiplier: 1, modelVendors: {
        "glm-5.3": {vendor: "zhipu", priceEntryId: "zhipu:glm-5.3"},
      }},
    });
    config.agentConnections.zcode = {
      boundTargetIds: ["zhipu-zcode2"],
      defaultTargetId: "zhipu-zcode2",
      cliSyncEnabled: true,
    };
    const credential = createCredentialMetadata({
      id: "cred_zcode2",
      targetId: "zhipu-zcode2",
      label: "智谱密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["zcode"],
    });
    await fixture.credentials.upsert(credential);
    const workspaceDir = join(fixture.root, "workspace2");
    await mkdir(workspaceDir, {recursive: true});
    const canonicalWorkspace = await realpath(workspaceDir);

    const result = await fixture.service.start({
      cli: "zcode",
      targetId: "zhipu-zcode2",
      credentialId: credential.id,
      selectedModel: "glm-5.3",
      projectDir: workspaceDir,
      manualOverrides: {},
    });

    expect(result.zcodeAlreadyRunning).toBe(true);
    // 已运行 + 工作区：只发一次深链（聚焦并打开工作区），不再仅切焦点。
    expect(fixture.zcodeLaunches).toEqual([
      {appPath: "/Applications/ZCode.app", workspacePath: canonicalWorkspace},
    ]);
  });

  test("ZCode 已在运行且偏好变化：仍提示需重启（app 固定形态不受 dsh 桌面端豁免影响）", async () => {
    const fixture = await serviceFixture({zcodeAppRunning: () => true});
    const config = fixture.configProvider.config;
    config.targets.push({
      id: "zhipu-zcode-restart",
      name: "智谱 Coding Plan",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      enabled: true,
      supportedModels: ["glm-5.3"],
      supportedModelScopes: {"glm-5.3": ["zcode"]},
      supportedModelWireApis: {"glm-5.3": ["messages"]},
      pricing: {vendor: "zhipu", rateMultiplier: 1, modelVendors: {
        "glm-5.3": {vendor: "zhipu", priceEntryId: "zhipu:glm-5.3"},
      }},
    });
    config.agentConnections.zcode = {
      boundTargetIds: ["zhipu-zcode-restart"],
      defaultTargetId: "zhipu-zcode-restart",
      cliSyncEnabled: true,
    };
    const credential = createCredentialMetadata({
      id: "cred_zcode_restart",
      targetId: "zhipu-zcode-restart",
      label: "智谱密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["zcode"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "zcode",
      targetId: "zhipu-zcode-restart",
      credentialId: credential.id,
      selectedModel: "glm-5.3",
      manualOverrides: {},
      launchPreferences: {reasoningEffort: "low"},
    });

    expect(result.zcodeAlreadyRunning).toBe(true);
    // 2026-10-05 修复回归：zcode 固定 app 形态曾被「app 形态不提示重启」的
    // dsh 桌面端豁免误伤，导致偏好已落库却不再提示重启生效。
    expect(result.appliedButRequiresRestart).toBe(true);

    // 2026-10-06 收紧：ZCode 只在启动时读配置——运行中的实例永远加载不到新模型
    // 列表/默认选择，未修改偏好同样提示需完全退出重开（常驻提示不再依赖偏好变化）。
    const unchanged = await fixture.service.start({
      cli: "zcode",
      targetId: "zhipu-zcode-restart",
      credentialId: credential.id,
      selectedModel: "glm-5.3",
      manualOverrides: {},
    });
    expect(unchanged.appliedButRequiresRestart).toBe(true);
  });

  test("ZCode 已在运行且未选工作区：维持仅切焦点，不产生拉起/深链动作", async () => {
    const fixture = await serviceFixture({zcodeAppRunning: () => true});
    const config = fixture.configProvider.config;
    config.targets.push({
      id: "zhipu-zcode3",
      name: "智谱 Coding Plan",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      enabled: true,
      supportedModels: ["glm-5.3"],
      supportedModelScopes: {"glm-5.3": ["zcode"]},
      supportedModelWireApis: {"glm-5.3": ["messages"]},
      pricing: {vendor: "zhipu", rateMultiplier: 1, modelVendors: {
        "glm-5.3": {vendor: "zhipu", priceEntryId: "zhipu:glm-5.3"},
      }},
    });
    config.agentConnections.zcode = {
      boundTargetIds: ["zhipu-zcode3"],
      defaultTargetId: "zhipu-zcode3",
      cliSyncEnabled: true,
    };
    const credential = createCredentialMetadata({
      id: "cred_zcode3",
      targetId: "zhipu-zcode3",
      label: "智谱密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["zcode"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "zcode",
      targetId: "zhipu-zcode3",
      credentialId: credential.id,
      selectedModel: "glm-5.3",
      manualOverrides: {},
    });

    expect(result.zcodeAlreadyRunning).toBe(true);
    expect(fixture.zcodeLaunches).toEqual([]);
  });

  test("dsh Web 形态不再要求项目目录：空目录直接启动且不持久化 lastProjectDir", async () => {
    const fixture = await serviceFixture();
    const config = fixture.configProvider.config;
    config.targets.push({
      id: "deepseek-dsh",
      name: "DeepSeek 官方",
      openaiUrl: "https://api.deepseek.com/v1",
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      supportedModelScopes: {"deepseek-v4-flash": ["dsh"]},
      supportedModelWireApis: {"deepseek-v4-flash": ["chat_completions"]},
      pricing: {vendor: "deepseek", rateMultiplier: 1, modelVendors: {
        "deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "deepseek:deepseek-v4-flash"},
      }},
    });
    config.agentConnections.dsh = {
      boundTargetIds: ["deepseek-dsh"],
      defaultTargetId: "deepseek-dsh",
      cliSyncEnabled: true,
    };
    const credential = createCredentialMetadata({
      id: "cred_dsh",
      targetId: "deepseek-dsh",
      label: "DeepSeek 密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["dsh"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "dsh",
      targetId: "deepseek-dsh",
      credentialId: credential.id,
      selectedModel: "deepseek-v4-flash",
      manualOverrides: {},
      launchPreferences: {reasoningEffort: "high", permissionMode: "workspace-write"},
    });

    expect(result.dshAlreadyRunning).toBeFalsy();
    expect(fixture.adapter.launches).toHaveLength(1);
    // 启动命令固定为 dsh web（PATH 通道），与项目目录无关。
    expect(fixture.adapter.launches[0]!.args).toEqual(["web"]);
    expect(config.agentConnections.dsh?.launchPreferences)
      .toEqual({reasoningEffort: "high", permissionMode: "workspace-write"});
    // 无目录 → 不记录 lastProjectDir。
    expect(config.targets.find(item => item.id === "deepseek-dsh")?.development?.lastProjectDir).toBeUndefined();
  });

  test("CLI 模式缺少项目目录时拒绝启动", async () => {
    const fixture = await serviceFixture();
    const credential = createCredentialMetadata({
      id: "cred_no_dir",
      targetId: "openai-target",
      label: "无目录测试",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("INVALID_PROJECT_DIR");
    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("未显式接入 Agent 时开发启动在终端调用前被拒绝", async () => {
    const fixture = await serviceFixture({connected: false});
    const credential = createCredentialMetadata({
      id: "cred_disconnected",
      targetId: "openai-target",
      label: "未接入门禁",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["codex"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.start({
      cli: "codex",
      targetId: "openai-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "gpt-5.6",
      manualOverrides: {},
    })).rejects.toThrow("AGENT_NOT_CONNECTED");
    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("OpenCode headless 启动生成受管 provider 模型入口并注入占位 token", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.targets = [{
      id: "opencode-target",
      name: "OpenCode 目标",
      openaiUrl: "https://opencode.example/v1",
      anthropicUrl: "https://opencode.example/anthropic/v1",
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      supportedModelScopes: {"deepseek-v4-flash": ["opencode"]},
      supportedModelWireApis: {"deepseek-v4-flash": ["responses", "chat_completions"]},
      pricing: {vendor: "deepseek", rateMultiplier: 1, modelVendors: {
        "deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "deepseek:deepseek-v4-flash"},
      }},
      development: {
        defaultModels: {opencode: "deepseek-v4-flash"},
        defaultCredentials: {opencode: "cred_opencode"},
      },
    }];
    fixture.configProvider.config.agentConnections = {
      opencode: {
        boundTargetIds: ["opencode-target"],
        defaultTargetId: "opencode-target",
        cliSyncEnabled: true,
      },
    };
    const credential = createCredentialMetadata({
      id: "cred_opencode",
      targetId: "opencode-target",
      label: "OpenCode 密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["opencode"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "opencode",
      targetId: "opencode-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "deepseek-v4-flash",
      manualOverrides: {},
      launchMode: "headless",
      task: "分析这个仓库",
    });

    expect(fixture.adapter.launches).toHaveLength(1);
    const request = fixture.adapter.launches[0]!;
    const canonicalProjectDir = await realpath(fixture.projectDir);
    expect(request.args.slice(0, 4)).toEqual([
      "run",
      "分析这个仓库",
      "--dir",
      canonicalProjectDir,
    ]);
    expect(request.args.at(-1)).toBe(
      "opencode-deepaa-gateway-responses/deepseek-v4-flash_opencode-target",
    );
    expect(request.environment.DEEPAA_GATEWAY_TOKEN).toBe("deepaa-gateway");
    expect(result.defaultNotice).toContain("OpenCode");
  });

  test("dsh web 启动生成固定命令并注入占位 token，不再使用 headless", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.targets = [{
      id: "deepseek-target",
      name: "DeepSeek",
      openaiUrl: "https://api.deepseek.com/v1",
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      supportedModelScopes: {"deepseek-v4-flash": ["dsh"]},
      supportedModelWireApis: {"deepseek-v4-flash": ["chat_completions"]},
      pricing: {vendor: "deepseek", rateMultiplier: 1, modelVendors: {
        "deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "deepseek:deepseek-v4-flash"},
      }},
      development: {
        defaultModels: {dsh: "deepseek-v4-flash"},
        defaultCredentials: {dsh: "cred_dsh"},
      },
    }];
    fixture.configProvider.config.agentConnections = {
      dsh: {
        boundTargetIds: ["deepseek-target"],
        defaultTargetId: "deepseek-target",
        cliSyncEnabled: true,
      },
    };
    const credential = createCredentialMetadata({
      id: "cred_dsh",
      targetId: "deepseek-target",
      label: "dsh 密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["dsh"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "dsh",
      targetId: "deepseek-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "deepseek-v4-flash",
      manualOverrides: {},
    });

    expect(fixture.adapter.launches).toHaveLength(1);
    // dsh 固定 Web UI 形态：启动 dsh web（PATH 通道），不做一次性任务。
    expect(fixture.adapter.launches[0]!.args).toEqual(["web"]);
    expect(fixture.adapter.launches[0]!.executablePath).toBe("/usr/local/bin/dsh");
    expect(fixture.adapter.launches[0]!.environment.DEEPAA_GATEWAY_TOKEN)
      .toBe("deepaa-gateway");
    expect(result.defaultNotice).toContain("DeepSeek Harness");
  });

  test("dsh Web 服务已在运行时跳过启动并返回 dshAlreadyRunning", async () => {
    const fixture = await serviceFixture({dshPortProbe: async () => true});
    fixture.configProvider.config.targets = [{
      id: "deepseek-target",
      name: "DeepSeek",
      openaiUrl: "https://api.deepseek.com/v1",
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      supportedModelScopes: {"deepseek-v4-flash": ["dsh"]},
      supportedModelWireApis: {"deepseek-v4-flash": ["chat_completions"]},
      pricing: {vendor: "deepseek", rateMultiplier: 1, modelVendors: {
        "deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "deepseek:deepseek-v4-flash"},
      }},
      development: {defaultModels: {dsh: "deepseek-v4-flash"}},
    }];
    fixture.configProvider.config.agentConnections = {
      dsh: {boundTargetIds: ["deepseek-target"], defaultTargetId: "deepseek-target", cliSyncEnabled: true},
    };
    const credential = createCredentialMetadata({
      id: "cred_dsh",
      targetId: "deepseek-target",
      label: "dsh 密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["dsh"],
    });
    await fixture.credentials.upsert(credential);

    const result = await fixture.service.start({
      cli: "dsh",
      targetId: "deepseek-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "deepseek-v4-flash",
      manualOverrides: {},
    });

    expect(result.dshAlreadyRunning).toBe(true);
    // 已运行时不重复启动终端，避免上游 EADDRINUSE。
    expect(fixture.adapter.launches).toHaveLength(0);
  });

  test("dsh 常驻且偏好确有变化才提示需重启，未变化的重复启动保持静默", async () => {
    const fixture = await serviceFixture({dshPortProbe: async () => true});
    fixture.configProvider.config.targets = [{
      id: "deepseek-target",
      name: "DeepSeek",
      openaiUrl: "https://api.deepseek.com/v1",
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      supportedModelScopes: {"deepseek-v4-flash": ["dsh"]},
      supportedModelWireApis: {"deepseek-v4-flash": ["chat_completions"]},
      pricing: {vendor: "deepseek", rateMultiplier: 1, modelVendors: {
        "deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "deepseek:deepseek-v4-flash"},
      }},
      development: {defaultModels: {dsh: "deepseek-v4-flash"}},
    }];
    fixture.configProvider.config.agentConnections = {
      dsh: {boundTargetIds: ["deepseek-target"], defaultTargetId: "deepseek-target", cliSyncEnabled: true},
    };
    const credential = createCredentialMetadata({
      id: "cred_dsh_restart",
      targetId: "deepseek-target",
      label: "dsh 密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["dsh"],
    });
    await fixture.credentials.upsert(credential);
    const launch = (launchPreferences?: {reasoningEffort?: string; contextWindows?: Record<string, number>}) =>
      fixture.service.start({
        cli: "dsh",
        targetId: "deepseek-target",
        projectDir: fixture.projectDir,
        credentialId: credential.id,
        terminal: "terminal.app",
        selectedModel: "deepseek-v4-flash",
        manualOverrides: {},
        launchPreferences,
      });

    // 首次带偏好启动（无既有偏好 → 有变化）：dsh 免重启（2026-10-06 用户实测确认，
    // profile/凭据按请求解析），只提示「下一请求即生效」，不再要求重启。
    const changed = await launch({reasoningEffort: "low", contextWindows: {"deepseek-v4-flash_deepseek-target": 262144}});
    expect(changed.dshAlreadyRunning).toBe(true);
    expect(changed.appliedButRequiresRestart).toBeFalsy();
    expect(changed.preferenceApplyHint).toContain("下一请求即生效");

    // 相同偏好重复启动（90% 默认场景）：无变化 → 静默，不打扰。
    const unchanged = await launch({reasoningEffort: "low", contextWindows: {"deepseek-v4-flash_deepseek-target": 262144}});
    expect(unchanged.dshAlreadyRunning).toBe(true);
    expect(unchanged.preferenceApplyHint).toBeUndefined();

    // 清空偏好（空对象 = 清除）同样视为变化。
    const cleared = await launch({});
    expect(cleared.preferenceApplyHint).toContain("下一请求即生效");
  });

  test("模型缺省 scope 或 wire API 缺失时 OpenCode/dsh 一律拒绝", async () => {
    const fixture = await serviceFixture();
    fixture.configProvider.config.targets = [{
      id: "deny-target",
      name: "Deny",
      openaiUrl: "https://deny.example/v1",
      enabled: true,
      supportedModels: ["deepseek-v4-flash"],
      pricing: {vendor: "deepseek", rateMultiplier: 1, modelVendors: {
        "deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "deepseek:deepseek-v4-flash"},
      }},
      development: {
        defaultModels: {opencode: "deepseek-v4-flash"},
        defaultCredentials: {opencode: "cred_deny", dsh: "cred_deny"},
      },
    }];
    fixture.configProvider.config.agentConnections = {
      opencode: {boundTargetIds: ["deny-target"], defaultTargetId: "deny-target", cliSyncEnabled: true},
      dsh: {boundTargetIds: ["deny-target"], defaultTargetId: "deny-target", cliSyncEnabled: true},
    };
    const credential = createCredentialMetadata({
      id: "cred_deny",
      targetId: "deny-target",
      label: "拒绝密钥",
      platform: "darwin",
      secret: "secret-value",
      agentScope: ["opencode", "dsh"],
    });
    await fixture.credentials.upsert(credential);

    await expect(fixture.service.start({
      cli: "opencode",
      targetId: "deny-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "deepseek-v4-flash",
      manualOverrides: {},
      launchMode: "headless",
      task: "任务",
    })).rejects.toThrow("MODEL_NOT_SUPPORTED_BY_TARGET");

    await expect(fixture.service.start({
      cli: "dsh",
      targetId: "deny-target",
      projectDir: fixture.projectDir,
      credentialId: credential.id,
      terminal: "terminal.app",
      selectedModel: "deepseek-v4-flash",
      manualOverrides: {},
      launchMode: "headless",
      task: "任务",
    })).rejects.toThrow("MODEL_NOT_SUPPORTED_BY_TARGET");
    expect(fixture.adapter.launches).toHaveLength(0);
  });
});

async function serviceFixture(options: {
  credentialStoreAvailable?: boolean;
  credentialDeleteFails?: boolean;
  launchGate?: Promise<void>;
  routingApplied?: boolean;
  connected?: boolean;
  configUpdateFails?: boolean;
  /** dsh 端口探测结果覆盖：默认 false 避免命中测试机真实 3080。 */
  dshPortProbe?: (port: number) => Promise<boolean>;
  /** ZCode App 运行探测覆盖：默认 false（未运行）；冷启动等待就绪用 true。 */
  zcodeAppRunning?: () => boolean | Promise<boolean>;
  /** 注入 CLI 同步报告警告（验证 appliedSyncWarnings 透传到 start 响应）。 */
  syncReportWarnings?: CliSyncWarning[];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "development-launch-service-"));
  tempRoots.push(root);
  const homeDir = join(root, "home");
  const projectDir = join(root, "project");
  await mkdir(homeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const credentials = new CredentialMetadataRepository(join(root, "credentials.json"));
  const adapter = new FakePlatformAdapter(options.launchGate, options.zcodeAppRunning ?? (() => false));
  const config: ProxyConfig = {
    version: 3,
    revision: 8,
    agentConnections: options.connected === false ? {} : {
      codex: {defaultTargetId: "openai-target", cliSyncEnabled: true},
    },
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-07-19T00:00:00.000Z",
    targets: [
      {
        id: "openai-target",
        name: "OpenAI target",
        openaiUrl: "https://gateway.example/v1",
        enabled: true,
        supportedModels: ["gpt-5.6"],
        supportedModelScopes: {"gpt-5.6": ["codex"]},
        supportedModelWireApis: {"gpt-5.6": ["responses", "chat_completions"]},
        pricing: {vendor: "openai", rateMultiplier: 1, modelVendors: {
          "gpt-5.6": {vendor: "openai", priceEntryId: "openai:gpt-5.6"},
        }},
      },
      {
        id: "disabled-target",
        name: "Disabled target",
        openaiUrl: "https://disabled.example/v1",
        enabled: false,
        supportedModels: [],
      },
    ],
  };
  const configProvider = {
    config,
    async reload() {},
    getConfig() { return this.config; },
    async updateConfig(update: import("../src/proxy-config.js").ProxyConfigUpdate) {
      if (options.configUpdateFails && update.targetPatch) throw new Error("CONFIG_REVISION_CONFLICT");
      if (update.targetPatch) {
        this.config.targets = this.config.targets.map(target => target.id === update.targetPatch?.id
          ? {...target, ...update.targetPatch.target, development: mergeMockDevelopment(target.development, update.targetPatch.target.development)}
          : target);
      }
      if (update.agentConnectionPatch) {
        const patch = update.agentConnectionPatch;
        if (patch.action === "disconnect") delete this.config.agentConnections[patch.agent];
        else {
          const target = this.config.targets.find(item => item.id === patch.defaultTargetId);
          if (target) {
            target.development = {
              ...target.development,
              defaultModels: {...target.development?.defaultModels, ...(patch.defaultModelId ? {[patch.agent]: patch.defaultModelId} : {})},
              ...(patch.defaultCredentialId ? {
                defaultCredentials: {...target.development?.defaultCredentials, [patch.agent]: patch.defaultCredentialId},
              } : {}),
            };
          }
          this.config.agentConnections[patch.agent] = {
            ...this.config.agentConnections[patch.agent],
            ...(patch.boundTargetIds
              ? {boundTargetIds: patch.boundTargetIds}
              : {}),
            ...(patch.defaultTargetId || this.config.agentConnections[patch.agent]?.defaultTargetId
              ? {defaultTargetId: patch.defaultTargetId ?? this.config.agentConnections[patch.agent]?.defaultTargetId}
              : {}),
            cliSyncEnabled: patch.cliSyncEnabled ?? this.config.agentConnections[patch.agent]?.cliSyncEnabled ?? false,
            ...(patch.launchPreferences !== undefined
              ? patch.launchPreferences
                ? {launchPreferences: patch.launchPreferences}
                : {}
              : {}),
          };
        }
      }
      if (update.targets) this.config.targets = update.targets;
      if (update.agentConnections) this.config.agentConnections = update.agentConnections;
      return this.config;
    },
  };
  const syncedConfigs: ProxyConfig[] = [];
  // 定向同步断言（2026-10-06）：启动链路 preSync 与启动后持久化同步都应只刷本次 Agent。
  const syncAgentsOptions: Array<{agents?: readonly import("../src/types.js").AgentId[]} | undefined> = [];
  // 事件序（sync / codex-launch）：验证客户端模式「先同步目录条目、再拉起客户端」的顺序。
  const launchEvents: string[] = [];
  const codexLaunches: Array<{executablePath: string; workspacePath?: string}> = [];
  const zcodeLaunches: Array<{appPath: string; workspacePath?: string}> = [];
  const service = new DevelopmentLaunchService({
    platform: adapter,
    configProvider,
    credentials,
    cliConfigSyncer: async (nextConfig: ProxyConfig, syncOptions?: {agents?: readonly import("../src/types.js").AgentId[]}) => {
      syncedConfigs.push(nextConfig);
      launchEvents.push("sync");
      syncAgentsOptions.push(syncOptions);
      // 可选注入同步报告警告，验证 preSync warnings → start 响应的透传链。
      if (options.syncReportWarnings) {
        return {ok: true, writtenFiles: [], warnings: options.syncReportWarnings, errors: [], previews: {}};
      }
    },
    codexClientLauncher: (executablePath: string, workspacePath?: string) => { codexLaunches.push({executablePath, workspacePath}); launchEvents.push("codex-launch"); },
    zcodeAppLauncher: (appPath: string, workspacePath?: string) => {
      zcodeLaunches.push({appPath, workspacePath});
    },
    credentialStore: {
      async put() {},
      async get() { return "unused"; },
      async delete() {
        if (options.credentialDeleteFails) throw new Error("CREDENTIAL_DELETE_FAILED");
      },
      async isAvailable() { return options.credentialStoreAvailable !== false; },
    },
    homeDir,
    tempRoot: join(root, "deepaa-launch"),
    nodeExecutable: "/usr/local/bin/node",
    credentialHelperPath: "/app/bin/credential-helper.mjs",
    pricingConfigReader: async () => TEST_PRICING,
    // 测试环境可能真实占用 3080：默认固定探测失败，保证 dsh 走正常启动路径。
    dshPortProbe: options.dshPortProbe || (async () => false),
    routingApplicationChecker: async config => {
      expect(config.revision).toBe(8);
      return options.routingApplied !== false;
    },
  });
  return { root, homeDir, projectDir, credentials, adapter, configProvider, service, syncedConfigs, syncAgentsOptions, codexLaunches, zcodeLaunches, launchEvents };
}

/** 与真实 mergeDevelopmentSettings 一致的整体替换语义（defaultModels/defaultCredentials
 * 显式提供时整体替换），保证 mock 能正确反映「提升/清理」结果。 */
function mergeMockDevelopment(
  current: import("../src/types.js").ProxyTargetDevelopmentSettings | undefined,
  patch: import("../src/types.js").ProxyTargetDevelopmentSettings | undefined,
): import("../src/types.js").ProxyTargetDevelopmentSettings | undefined {
  if (!patch) return current;
  return {
    ...current,
    ...patch,
    defaultModels: patch.defaultModels === undefined ? current?.defaultModels : patch.defaultModels,
    defaultCredentials: patch.defaultCredentials === undefined ? current?.defaultCredentials : patch.defaultCredentials,
  };
}

const TEST_PRICING: PricingConfig = {
  version: 2,
  currency: "USD",
  unit: "per_million_tokens",
  models: [
    {
      id: "gpt-5.6",
      vendor: "openai",
      patterns: ["gpt-5.6"],
      pricing: { input: 2, output: 12 },
      confidence: "provider_docs",
    },
    {
      id: "claude-sonnet-4-5",
      vendor: "anthropic",
      patterns: ["claude-sonnet-4-5"],
      pricing: { input: 3, output: 15 },
      confidence: "provider_docs",
    },
  ],
};

class FakePlatformAdapter implements DevelopmentPlatformAdapter {
  readonly platform = "darwin" as const;
  readonly launches: TerminalLaunchRequest[] = [];
  /** 平台探测/可执行文件解析调用计数：用于断言短缓存命中时不会重复执行重活。 */
  detectCapabilitiesCalls = 0;
  resolveExecutableCalls = 0;

  private readonly zcodeAppRunning: () => boolean | Promise<boolean>;

  constructor(
    launchGate?: Promise<void>,
    zcodeAppRunning: () => boolean | Promise<boolean> = () => false,
  ) {
    this.launchGate = launchGate;
    this.zcodeAppRunning = zcodeAppRunning;
  }

  async detectCapabilities(): Promise<PlatformCapabilities> {
    this.detectCapabilitiesCalls += 1;
    return {
      supported: true,
      platform: "darwin",
      agents: {
        codex: { available: true, executablePath: "/usr/local/bin/codex" },
        claude: { available: true, executablePath: "/usr/local/bin/claude" },
        opencode: { available: false },
        dsh: { available: true, executablePath: "/usr/local/bin/dsh", launchChannel: "path" },
        zcode: { available: true, appPath: "/Applications/ZCode.app" },
      },
      terminals: await this.listTerminals(),
      credentialStoreAvailable: true,
    };
  }

  async isZcodeAppRunning(): Promise<boolean> {
    return await this.zcodeAppRunning();
  }

  async activateZcodeApp(): Promise<boolean> {
    return true;
  }

  async selectDirectory(): Promise<DirectorySelection> {
    return { cancelled: true };
  }

  async resolveExecutable(cli: DevelopmentCli): Promise<string | null> {
    this.resolveExecutableCalls += 1;
    return `/usr/local/bin/${cli}`;
  }

  async resolveDshLaunch(): Promise<{executablePath: string; channel: "path" | "npx"} | null> {
    return {executablePath: "/usr/local/bin/dsh", channel: "path"};
  }

  async listTerminals(): Promise<TerminalCapability[]> {
    return [{ id: "terminal.app", label: "Terminal", available: true }];
  }

  async openTerminal(request: TerminalLaunchRequest): Promise<void> {
    this.launches.push(request);
    await this.launchGate;
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("WAIT_TIMEOUT");
}

describe("DevelopmentLaunchService 短缓存", () => {
  test("capabilities 在 TTL 内命中缓存，不重复探测平台", async () => {
    const fixture = await serviceFixture();
    await fixture.service.capabilities();
    await fixture.service.capabilities();
    expect(fixture.adapter.detectCapabilitiesCalls).toBe(1);
  });

  test("preflight 相同参数在 TTL 内命中缓存，不重复解析可执行文件", async () => {
    const fixture = await serviceFixture();
    await fixture.service.preflight({cli: "codex", targetId: "openai-target"});
    await fixture.service.preflight({cli: "codex", targetId: "openai-target"});
    expect(fixture.adapter.resolveExecutableCalls).toBe(1);
  });

  test("preflight 不同 projectDir 不共享缓存条目", async () => {
    const fixture = await serviceFixture();
    await fixture.service.preflight({cli: "codex", targetId: "openai-target"});
    await fixture.service.preflight({cli: "codex", targetId: "openai-target", projectDir: fixture.projectDir});
    expect(fixture.adapter.resolveExecutableCalls).toBe(2);
  });

  test("并发 capabilities 共享同一个底层平台探测", async () => {
    const fixture = await serviceFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const original = fixture.adapter.detectCapabilities.bind(fixture.adapter);
    fixture.adapter.detectCapabilities = async () => {
      calls += 1;
      await gate;
      return await original();
    };

    const first = fixture.service.capabilities();
    const second = fixture.service.capabilities();
    await waitFor(() => calls >= 1);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(fixture.adapter.detectCapabilitiesCalls).toBe(1);
  });

  test("并发相同参数的 preflight 共享同一个底层解析", async () => {
    const fixture = await serviceFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const original = fixture.adapter.resolveExecutable.bind(fixture.adapter);
    fixture.adapter.resolveExecutable = async cli => {
      calls += 1;
      await gate;
      return await original(cli);
    };

    const first = fixture.service.preflight({cli: "codex", targetId: "openai-target"});
    const second = fixture.service.preflight({cli: "codex", targetId: "openai-target"});
    await waitFor(() => calls >= 1);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(fixture.adapter.resolveExecutableCalls).toBe(1);
  });

  test.each(["cli", "targetId", "projectDir", "profile"] as const)(
    "并发 preflight 的 %s 不同则独立解析",
    async field => {
      const fixture = await serviceFixture();
      const target = fixture.configProvider.config.targets[0]!;
      fixture.configProvider.config.targets[0] = {
        ...target,
        anthropicUrl: "https://gateway.example/anthropic",
      };
      fixture.configProvider.config.targets.push({
        ...target,
        id: "other-target",
        openaiUrl: "https://other.example/v1",
      });
      fixture.configProvider.config.agentConnections.codex!.boundTargetIds = ["openai-target", "other-target"];
      fixture.configProvider.config.agentConnections.claude = {defaultTargetId: "openai-target"};
      const input = {cli: "codex" as const, targetId: "openai-target"};
      const other: Parameters<DevelopmentLaunchService["preflight"]>[0] = {
        ...input,
        ...(field === "cli" ? {cli: "claude" as const} : {}),
        ...(field === "targetId" ? {targetId: "other-target"} : {}),
        ...(field === "projectDir" ? {projectDir: fixture.projectDir} : {}),
        ...(field === "profile" ? {profile: "other"} : {}),
      };
      // 同时挂起两种参数的解析，证明隔离来自 key 而非前一个请求已经完成。
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      const original = fixture.adapter.resolveExecutable.bind(fixture.adapter);
      fixture.adapter.resolveExecutable = async cli => {
        calls += 1;
        await gate;
        return await original(cli);
      };
      const first = fixture.service.preflight(input);
      const second = fixture.service.preflight(other);
      const results = Promise.allSettled([first, second]);
      try {
        await waitFor(() => calls >= 2);
      } finally {
        release();
      }
      await results;
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(calls).toBe(2);
      expect(firstResult).not.toBe(secondResult);
      expect(secondResult.cli).toBe(other.cli);
      expect(secondResult.target.id).toBe(other.targetId);
      expect(secondResult.projectDir).toBe(other.projectDir ? await realpath(other.projectDir) : undefined);
    },
  );

  test("失败的 capabilities 探测不会冻结后续重试", async () => {
    const fixture = await serviceFixture();
    const failure = new Error("CAPABILITIES_PROBE_FAILED");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const original = fixture.adapter.detectCapabilities.bind(fixture.adapter);
    fixture.adapter.detectCapabilities = async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw failure;
      }
      return await original();
    };

    const pending = Promise.allSettled([fixture.service.capabilities(), fixture.service.capabilities()]);
    await waitFor(() => calls >= 1);
    release();
    const results = await pending;
    expect(results).toEqual([{status: "rejected", reason: failure}, {status: "rejected", reason: failure}]);
    expect(calls).toBe(1);
    await expect(fixture.service.capabilities()).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  test("失败的 preflight 不会冻结后续重试", async () => {
    const fixture = await serviceFixture();
    const failure = new Error("PREFLIGHT_PROBE_FAILED");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const original = fixture.adapter.resolveExecutable.bind(fixture.adapter);
    fixture.adapter.resolveExecutable = async cli => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw failure;
      }
      return await original(cli);
    };

    const input = {cli: "codex" as const, targetId: "openai-target"};
    const pending = Promise.allSettled([fixture.service.preflight(input), fixture.service.preflight(input)]);
    await waitFor(() => calls >= 1);
    release();
    const results = await pending;
    expect(results).toEqual([{status: "rejected", reason: failure}, {status: "rejected", reason: failure}]);
    expect(calls).toBe(1);
    await expect(fixture.service.preflight({cli: "codex", targetId: "openai-target"}))
      .resolves.toBeDefined();
    expect(calls).toBe(2);
  });
});

describe("密钥适用变更的默认密钥提升", () => {
  test("混合场景：取消默认密钥的 Agent 适用时，默认密钥提升为其他适用密钥", async () => {
    const fixture = await serviceFixture();
    const targetId = "openai-target";
    const cred1 = createCredentialMetadata({targetId, label: "密钥1", platform: "darwin", secret: "s1", agentScope: ["codex"]});
    const cred2 = createCredentialMetadata({targetId, label: "密钥2", platform: "darwin", secret: "s2", agentScope: ["codex"]});
    await fixture.credentials.upsert(cred1);
    await fixture.credentials.upsert(cred2);
    fixture.configProvider.config.targets[0]!.development = {defaultCredentials: {codex: cred1.id}};

    await fixture.service.updateCredential({targetId, credentialId: cred1.id, agentScope: []});

    expect(fixture.configProvider.config.targets[0]!.development?.defaultCredentials?.codex).toBe(cred2.id);
  });

  test("无其他适用密钥时，取消默认密钥的 Agent 适用会清理默认密钥引用", async () => {
    const fixture = await serviceFixture();
    const targetId = "openai-target";
    const cred1 = createCredentialMetadata({targetId, label: "密钥1", platform: "darwin", secret: "s1", agentScope: ["codex"]});
    await fixture.credentials.upsert(cred1);
    fixture.configProvider.config.targets[0]!.development = {defaultCredentials: {codex: cred1.id}};

    await fixture.service.updateCredential({targetId, credentialId: cred1.id, agentScope: []});

    expect(fixture.configProvider.config.targets[0]!.development?.defaultCredentials?.codex).toBeUndefined();
  });
});
