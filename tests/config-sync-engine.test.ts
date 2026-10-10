import {mkdir, mkdtemp, readFile, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "vitest";
import type {CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import {syncCliConfigs, invalidateCredentialExistenceCache, type CliSyncPaths} from "../src/lib/config-sync/sync-manager.js";
import type {AgentId, ProxyConfig, ProxyTarget, WireApi} from "../src/types.js";

const template: CatalogTemplate = {
  defaults: {
    contextWindow: 128000,
    inputModalities: ["text"],
    supportedReasoningLevels: [
      {effort: "low", description: "Fast responses with lighter reasoning"},
      {effort: "high", description: "Extra high reasoning depth for complex problems"},
      {effort: "max", description: "Maximum reasoning depth for the hardest problems"},
    ],
    defaultReasoningLevel: "high",
  },
  families: {},
  agents: {},
};

function target(overrides: Partial<ProxyTarget> & Pick<ProxyTarget, "id">): ProxyTarget {
  const supportedModels = overrides.supportedModels || ["deepseek-v4-flash"];
  const wireApis = overrides.supportedModelWireApis
    || Object.fromEntries(supportedModels.map(model => [model, ["responses", "chat_completions"] as WireApi[]]));
  return {
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    openaiUrl: `https://${overrides.id}/v1`,
    anthropicUrl: `https://${overrides.id}/anthropic/v1`,
    supportedModels,
    supportedModelScopes: Object.fromEntries(supportedModels.map(model => [model, ["codex", "claude", "opencode", "dsh"]])),
    supportedModelWireApis: wireApis,
    pricing: {
      vendor: "test",
      rateMultiplier: 1,
      modelVendors: Object.fromEntries(supportedModels.map(modelId => [modelId, {vendor: "test", priceEntryId: `test:${modelId}`}])),
    },
    development: {
      defaultModels: {
        codex: "deepseek-v4-flash",
        claude: "deepseek-v4-flash",
        opencode: "deepseek-v4-flash",
        dsh: "deepseek-v4-flash",
      },
      defaultCredentials: {
        codex: "cred-codex",
        claude: "cred-claude",
        opencode: "cred-opencode",
        dsh: "cred-dsh",
      },
    },
    ...overrides,
  };
}

function config(): ProxyConfig {
  const all: AgentId[] = ["codex", "claude", "opencode", "dsh"];
  return {
    version: 3,
    revision: 1,
    agentConnections: Object.fromEntries(all.map(agent => [agent, {
      boundTargetIds: ["shared-provider"],
      defaultTargetId: "shared-provider",
      cliSyncEnabled: true,
    }])),
    targets: [target({id: "shared-provider"})],
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

test("syncCliConfigs 同时写 Codex/Claude/OpenCode/dsh/zcode 五个 Agent 的受管文件并备份", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-sync-engine-"));
  await Promise.all([
    mkdir(join(root, "codex"), {recursive: true}),
    mkdir(join(root, "claude"), {recursive: true}),
    mkdir(join(root, "opencode"), {recursive: true}),
    mkdir(join(root, "dsh"), {recursive: true}),
    mkdir(join(root, "zcode", "v2"), {recursive: true}),
  ]);
  const paths: CliSyncPaths = {
    codexConfigPath: join(root, "codex", "config.toml"),
    codexCatalogPath: join(root, "codex", "catalogs", "all.json"),
    claudeUserSettingsPath: join(root, "claude", "settings.json"),
    claudeProjectSettingsPaths: {},
    opencodeConfigPath: join(root, "opencode", "opencode.jsonc"),
    dshSettingsPath: join(root, "dsh", "settings.yaml"),
    dshCredentialsPath: join(root, "dsh", ".credentials.yaml"),
    zcodeConfigPath: join(root, "zcode", "v2", "config.json"),
    zcodeStatePath: join(root, "zcode", "v2", "deepaa", "gateway-state.json"),
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  };
  await writeFile(paths.opencodeConfigPath, `{
  // 用户插件
  "plugins": ["demo"],
  "provider": {
    "custom": {"npm": "@ai-sdk/custom", "models": {}}
  }
}`, "utf8");
  await writeFile(paths.dshSettingsPath, "custom-section:\n  enabled: true\n", "utf8");

  const report = await syncCliConfigs(config(), {paths, credentialHelperPath: "/bin/true"});
  expect(report.ok).toBe(true);
  expect(report.errors).toEqual([]);
  // ZCode 未连接：清理层对不存在的目标文件是空合并产物，sync-manager 不写出文件。
  expect(report.writtenFiles.map(item => item.path).sort()).toEqual([
    paths.claudeUserSettingsPath,
    paths.codexCatalogPath,
    paths.codexConfigPath,
    join(root, "dsh", ".credentials.yaml"),
    paths.dshSettingsPath,
    paths.opencodeConfigPath,
  ]);
  expect(Object.keys(report.previews).sort()).toEqual(["claude", "codex", "dsh", "opencode", "zcode"]);

  const opencode = await readFile(paths.opencodeConfigPath, "utf8");
  expect(opencode).toContain("// 用户插件");
  expect(opencode).toContain('"custom"');
  expect(opencode).toContain("opencode-deepaa-gateway-responses");
  const dsh = await readFile(paths.dshSettingsPath, "utf8");
  expect(dsh).toContain("custom-section:");
  expect(dsh).toContain("llm-pi-ai:");
  expect(dsh).toContain("deepaa-gateway:");
  const joined = [opencode, dsh].join("\n");
  expect(joined).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);

  // 第二次同步幂等，且备份目录出现 deepaa 备份。
  const second = await syncCliConfigs(config(), {paths, credentialHelperPath: "/bin/true"});
  expect(second.ok).toBe(true);
  expect(await readFile(paths.opencodeConfigPath, "utf8")).toBe(opencode);
  expect(await readFile(paths.dshSettingsPath, "utf8")).toBe(dsh);
});

test("单个 Agent 文件损坏时只报该 Agent 错误，其它 Agent 仍写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-sync-engine-fail-"));
  await mkdir(join(root, "opencode"), {recursive: true});
  const paths: CliSyncPaths = {
    codexConfigPath: join(root, "codex", "config.toml"),
    codexCatalogPath: join(root, "codex", "catalogs", "all.json"),
    claudeUserSettingsPath: join(root, "claude", "settings.json"),
    claudeProjectSettingsPaths: {},
    opencodeConfigPath: join(root, "opencode", "opencode.jsonc"),
    dshSettingsPath: join(root, "dsh", "settings.yaml"),
    dshCredentialsPath: join(root, "dsh", ".credentials.yaml"),
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  };
  // 既有 OpenCode 文件是数组（非常规对象），JSONC 深合并会整体替换失败被隔离。
  await writeFile(paths.opencodeConfigPath, "[1,2,3]", "utf8");
  const report = await syncCliConfigs(config(), {paths, credentialHelperPath: "/bin/true"});
  expect(report.errors.some(message => message.includes("OpenCode"))).toBe(true);
  expect(await readFile(paths.codexConfigPath, "utf8")).toContain("[model_providers.deepaa_gateway]");
  expect(await readFile(paths.dshSettingsPath, "utf8")).toContain("llm-pi-ai:");
});

test("符号链接配置被拒绝，不进入读取与写入路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-sync-engine-link-"));
  await mkdir(join(root, "dsh"), {recursive: true});
  const outside = join(root, "outside.yaml");
  await writeFile(outside, "llm-pi-ai:\n  providers: {}\n", "utf8");
  const link = join(root, "dsh", "settings.yaml");
  await symlink(outside, link);
  const paths: CliSyncPaths = {
    codexConfigPath: join(root, "codex", "config.toml"),
    codexCatalogPath: join(root, "codex", "catalogs", "all.json"),
    claudeUserSettingsPath: join(root, "claude", "settings.json"),
    claudeProjectSettingsPaths: {},
    opencodeConfigPath: join(root, "opencode", "opencode.jsonc"),
    dshSettingsPath: link,
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  };
  const report = await syncCliConfigs(config(), {paths, credentialHelperPath: "/bin/true"});
  expect(report.errors.some(message => message.includes("CONFIG_PATH_INVALID"))).toBe(true);
  expect(await readFile(outside, "utf8")).toContain("providers: {}");
});

test("dsh 链路瞬时不合格跳过写入保留现状；显式关闭同步才输出清理层", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-sync-preserve-"));
  await Promise.all([
    mkdir(join(root, "codex"), {recursive: true}),
    mkdir(join(root, "claude"), {recursive: true}),
    mkdir(join(root, "opencode"), {recursive: true}),
    mkdir(join(root, "dsh"), {recursive: true}),
    mkdir(join(root, "zcode", "v2"), {recursive: true}),
  ]);
  const paths: CliSyncPaths = {
    codexConfigPath: join(root, "codex", "config.toml"),
    codexCatalogPath: join(root, "codex", "catalogs", "all.json"),
    claudeUserSettingsPath: join(root, "claude", "settings.json"),
    claudeProjectSettingsPaths: {},
    opencodeConfigPath: join(root, "opencode", "opencode.jsonc"),
    dshSettingsPath: join(root, "dsh", "settings.yaml"),
    dshCredentialsPath: join(root, "dsh", ".credentials.yaml"),
    zcodeConfigPath: join(root, "zcode", "v2", "config.json"),
    zcodeStatePath: join(root, "zcode", "v2", "deepaa", "gateway-state.json"),
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  };
  // 预置用户自有分节：清理层必须保留、preserve 阶段不得有任何改动。
  await writeFile(paths.dshSettingsPath, "custom-section:\n  enabled: true\n", "utf8");

  // 1) 正常同步：受管分节写入。
  const first = await syncCliConfigs(config(), {paths, credentialHelperPath: "/bin/true"});
  expect(first.ok).toBe(true);
  const seeded = await readFile(paths.dshSettingsPath, "utf8");
  expect(seeded).toContain("custom-section:");
  expect(seeded).toContain("deepaa-gateway:");
  expect(seeded).toContain("agent-default-model:");

  // 2) 瞬时不合格（默认供应商悬空）：文件必须逐字节保持原样，不得输出清理层。
  const transientConfig = {
    ...config(),
    agentConnections: {
      ...config().agentConnections,
      dsh: {boundTargetIds: ["shared-provider"], defaultTargetId: "missing-provider", cliSyncEnabled: true},
    },
  };
  const transient = await syncCliConfigs(transientConfig, {paths, credentialHelperPath: "/bin/true"});
  expect(transient.ok).toBe(true);
  expect(transient.warnings.some(item => item.code === "DEFAULT_TARGET_NOT_FOUND")).toBe(true);
  expect(transient.writtenFiles.some(item => item.path === paths.dshSettingsPath)).toBe(false);
  expect(transient.writtenFiles.some(item => item.path === paths.dshCredentialsPath)).toBe(false);
  expect(transient.previews.dsh?.active).toBe(false);
  expect(await readFile(paths.dshSettingsPath, "utf8")).toBe(seeded);

  // 3) 显式关闭同步：清理层写入，删除受管分节并保留用户自有分节。
  const disabledConfig = {
    ...config(),
    agentConnections: {
      ...config().agentConnections,
      dsh: {boundTargetIds: ["shared-provider"], defaultTargetId: "shared-provider", cliSyncEnabled: false},
    },
  };
  const disabled = await syncCliConfigs(disabledConfig, {paths, credentialHelperPath: "/bin/true"});
  expect(disabled.ok).toBe(true);
  expect(disabled.writtenFiles.some(item => item.path === paths.dshSettingsPath)).toBe(true);
  const cleaned = await readFile(paths.dshSettingsPath, "utf8");
  expect(cleaned).toContain("custom-section:");
  expect(cleaned).not.toContain("deepaa-gateway:");
});

test("凭据预检：全量探测缓存去重、定向同步零 spawn（2026-10-10 B1/B2）", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-sync-probe-"));
  await Promise.all([
    mkdir(join(root, "codex"), {recursive: true}),
    mkdir(join(root, "claude"), {recursive: true}),
    mkdir(join(root, "opencode"), {recursive: true}),
    mkdir(join(root, "dsh"), {recursive: true}),
    mkdir(join(root, "zcode", "v2"), {recursive: true}),
  ]);
  // 计数 helper：记录被探测的 credentialId；probe-missing 模拟凭据不存在。
  const probeLog = join(root, "probe.log");
  const helperPath = join(root, "credential-helper-counter.sh");
  await writeFile(helperPath, [
    "#!/bin/sh",
    `printf '%s\\n' "$2" >> ${JSON.stringify(probeLog)}`,
    'case "$2" in probe-missing) exit 1 ;; *) exit 0 ;; esac',
    "",
  ].join("\n"), {mode: 0o755});
  const paths: CliSyncPaths = {
    codexConfigPath: join(root, "codex", "config.toml"),
    codexCatalogPath: join(root, "codex", "catalogs", "all.json"),
    claudeUserSettingsPath: join(root, "claude", "settings.json"),
    claudeProjectSettingsPaths: {},
    opencodeConfigPath: join(root, "opencode", "opencode.jsonc"),
    dshSettingsPath: join(root, "dsh", "settings.yaml"),
    dshCredentialsPath: join(root, "dsh", ".credentials.yaml"),
    zcodeConfigPath: join(root, "zcode", "v2", "config.json"),
    zcodeStatePath: join(root, "zcode", "v2", "deepaa", "gateway-state.json"),
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  };
  // 独立凭据 id 防止与其它用例共享的模块级缓存串扰；用例边界显式清缓存。
  invalidateCredentialExistenceCache();
  const probeConfig: ProxyConfig = {
    ...config(),
    targets: [target({
      id: "shared-provider",
      development: {
        defaultModels: {
          codex: "deepseek-v4-flash",
          claude: "deepseek-v4-flash",
          opencode: "deepseek-v4-flash",
          dsh: "deepseek-v4-flash",
        },
        defaultCredentials: {
          codex: "probe-codex",
          claude: "probe-missing",
          opencode: "probe-opencode",
          dsh: "probe-dsh",
        },
      },
    })],
  };
  const probedIds = async () => (await readFile(probeLog, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).sort();

  try {
    // 1) 全量同步：4 个默认凭据引用各探测一次，probe-missing 产出警告。
    const first = await syncCliConfigs(probeConfig, {paths, credentialHelperPath: helperPath});
    expect(first.ok).toBe(true);
    expect(await probedIds()).toEqual(["probe-codex", "probe-dsh", "probe-missing", "probe-opencode"]);
    expect(first.warnings).toContainEqual({
      targetId: "shared-provider",
      code: "CREDENTIAL_MISSING",
      message: "shared-provider 的 Claude Code 默认系统凭据不存在",
    });

    // 2) 再次全量：全部命中缓存，零新增 spawn。
    await syncCliConfigs(probeConfig, {paths, credentialHelperPath: helperPath});
    expect((await probedIds()).length).toBe(4);

    // 3) 失效单个 id 后重新全量：只重新探测该 id（probe-missing 累计出现两次）。
    invalidateCredentialExistenceCache("probe-missing");
    await syncCliConfigs(probeConfig, {paths, credentialHelperPath: helperPath});
    expect((await probedIds()).length).toBe(5);
    expect((await readFile(probeLog, "utf8")).split("\n").filter(id => id === "probe-missing").length).toBe(2);

    // 4) 定向同步（开发启动链/能力跟随形态）：零 spawn、零凭据警告。
    const before = (await readFile(probeLog, "utf8")).split("\n").filter(Boolean).length;
    const targeted = await syncCliConfigs(probeConfig, {paths, credentialHelperPath: helperPath, agents: ["codex"]});
    expect(targeted.ok).toBe(true);
    expect((await readFile(probeLog, "utf8")).split("\n").filter(Boolean).length).toBe(before);
    expect(targeted.warnings.some(item => item.code === "CREDENTIAL_MISSING")).toBe(false);
  } finally {
    invalidateCredentialExistenceCache();
  }
});
