import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import {ProxyConfigStore} from "../src/proxy-config.js";

describe("ProxyConfigStore V3", () => {
  test("首次初始化创建没有 Agent 和目标的 V3 配置", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "deepaa-v3-empty-"));
    const configPath = join(dataDir, "proxy-config.json");
    const store = new ProxyConfigStore({configPath, localProxyBaseUrl: "http://localhost:3211"});

    await store.init();

    expect(store.getConfig()).toMatchObject({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [],
      localProxyBaseUrl: "http://localhost:3211",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("defaultCodexTargetId");
  });

  test("拒绝读取 V2 配置且不执行迁移", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "deepaa-v3-reject-v2-"));
    const configPath = join(dataDir, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({version: 2, revision: 7, targets: []}));
    const store = new ProxyConfigStore({configPath});

    await expect(store.init()).rejects.toThrow("PROXY_CONFIG_VERSION_UNSUPPORTED");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({version: 2, revision: 7});
  });

  test("按 expectedRevision 原子接入 Agent 并保存目标默认模型和密钥", async () => {
    const fixture = await createTargetFixture();

    const updated = await fixture.store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "ai98pro",
        defaultModelId: "gpt-5.6",
        defaultCredentialId: "cred-codex",
        cliSyncEnabled: true,
      },
    });

    expect(updated.revision).toBe(3);
    expect(updated.agentConnections.codex).toEqual({
      enabled: true,
      boundTargetIds: ["ai98pro"],
      defaultTargetId: "ai98pro",
      cliSyncEnabled: true,
    });
    expect(updated.targets[0]?.development).toMatchObject({
      defaultModels: {codex: "gpt-5.6"},
      defaultCredentials: {codex: "cred-codex"},
    });
  });

  test("目标路由 ID 创建后不可修改", async () => {
    const fixture = await createTargetFixture();
    await expect(fixture.store.updateConfig({
      expectedRevision: 2,
      targetPatch: {id: "ai98pro", target: {id: "renamed-target"}},
    })).rejects.toThrow("TARGET_ID_IMMUTABLE");
  });

  test("revision 冲突返回稳定错误且不写文件", async () => {
    const fixture = await createTargetFixture();
    const before = await readFile(fixture.configPath, "utf8");

    await expect(fixture.store.updateConfig({
      expectedRevision: 1,
      agentConnectionPatch: {agent: "codex", action: "connect", cliSyncEnabled: false},
    })).rejects.toThrow("CONFIG_REVISION_CONFLICT");

    expect(await readFile(fixture.configPath, "utf8")).toBe(before);
  });

  test("服务端拒绝仅支持 chat/completions 的官方预设设为 Codex 默认目标", async () => {
    const fixture = await createTargetFixture();
    await fixture.store.updateConfig({
      expectedRevision: 2,
      targetPatch: {id: "ai98pro", target: {
        openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
        anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      }},
    });

    // Codex 只支持 Responses，chat 预设不满足时接入直接拒绝。
    await expect(fixture.store.updateConfig({
      expectedRevision: 3,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "ai98pro",
        defaultModelId: "gpt-5.6",
        defaultCredentialId: "cred-codex",
        cliSyncEnabled: true,
      },
    })).rejects.toThrow("PRESET_WIRE_API_UNSUPPORTED");
  });

  test("服务端拒绝保存默认模型 wire API 与目标可用 binding 无交集的 Agent 默认链", async () => {
    const fixture = await createTargetFixture();
    // 同一次更新先改 wire 声明再连默认链：写路径不做读侧 scope 清理，
    // 因此 wire 交集校验是首个失败点（分两次更新时读侧清理会先剔除
    // scope 死键、以 SCOPE_MISMATCH 拒绝，同为正确拒绝）。
    await expect(fixture.store.updateConfig({
      expectedRevision: 2,
      targetPatch: {id: "ai98pro", target: {
        supportedModelWireApis: {"gpt-5.6": ["messages"]},
      }},
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "ai98pro",
        defaultModelId: "gpt-5.6",
        cliSyncEnabled: true,
      },
    })).rejects.toThrow("DEFAULT_MODEL_WIRE_API_MISMATCH");
  });

  test("配置归一化会丢弃 wire API 与目标 binding 无交集的默认模型与 scope 死键", async () => {
    const fixture = await createTargetFixture();
    // 直接落盘一份不兼容存量（绕过写入门禁，模拟旧版本数据）；读取归一化必须
    // 丢弃该默认模型，并剔除 scope 中与声明协议无交集的 Agent 死键（2026-10-06）。
    const raw = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      targets: Array<Record<string, unknown>>;
    };
    raw.targets[0]!.supportedModelWireApis = {"gpt-5.6": ["messages"]};
    raw.targets[0]!.development = {defaultModels: {codex: "gpt-5.6"}};
    await writeFile(fixture.configPath, JSON.stringify(raw));

    const reloaded = new ProxyConfigStore({
      configPath: fixture.configPath,
      developmentCredentialsPath: join(fixture.configPath, "..", "development-credentials.json"),
      localProxyBaseUrl: "http://localhost:3211",
    });
    await reloaded.init();
    const target = reloaded.getConfig().targets[0]!;
    expect(target.development?.defaultModels?.codex).toBeUndefined();
    expect(target.supportedModelScopes?.["gpt-5.6"]).toBeUndefined();
  });

  test("断开 Agent 只删除连接，不删除共享目标默认资源", async () => {
    const fixture = await createTargetFixture();
    await fixture.store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "ai98pro",
        defaultModelId: "gpt-5.6",
        defaultCredentialId: "cred-codex",
        cliSyncEnabled: true,
      },
    });

    const disconnected = await fixture.store.updateConfig({
      expectedRevision: 3,
      agentConnectionPatch: {agent: "codex", action: "disconnect"},
    });

    expect(disconnected.agentConnections.codex).toBeUndefined();
    expect(disconnected.targets[0]?.development?.defaultModels?.codex).toBe("gpt-5.6");
    expect(disconnected.targets[0]?.development?.defaultCredentials?.codex).toBe("cred-codex");
  });

  test("首次接入目标会自动设置默认目标并保留默认模型/密钥待补齐", async () => {
    const fixture = await createTargetFixture();

    const updated = await fixture.store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        boundTargetIds: ["ai98pro"],
        cliSyncEnabled: true,
      },
    });

    expect(updated.agentConnections.codex).toEqual({
      enabled: true,
      boundTargetIds: ["ai98pro"],
      defaultTargetId: "ai98pro",
      cliSyncEnabled: true,
    });
    expect(updated.targets[0]?.development).toEqual({
      defaultCredentials: {codex: "cred-codex"},
    });
  });

  test("当前默认目标不能直接解除绑定，清空默认链后可以解除", async () => {
    const fixture = await createTargetFixture();
    await fixture.store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        boundTargetIds: ["ai98pro"],
        cliSyncEnabled: true,
      },
    });

    await expect(fixture.store.updateConfig({
      expectedRevision: 3,
      agentConnectionPatch: {
        agent: "codex",
        action: "unbind",
        targetId: "ai98pro",
      },
    })).rejects.toThrow("TARGET_DEFAULT_REFERENCE_EXISTS");

    await fixture.store.updateConfig({
      expectedRevision: 3,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "",
        cliSyncEnabled: true,
      },
    });

    const unbound = await fixture.store.updateConfig({
      expectedRevision: 4,
      agentConnectionPatch: {
        agent: "codex",
        action: "unbind",
        targetId: "ai98pro",
      },
    });

    expect(unbound.agentConnections.codex).toEqual({enabled: true, cliSyncEnabled: true});

    await fixture.store.updateConfig({
      expectedRevision: 5,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "ai98pro",
        cliSyncEnabled: true,
      },
    });
    await expect(fixture.store.updateConfig({
      expectedRevision: 6,
      agentConnectionPatch: {
        agent: "codex",
        action: "unbind",
        targetId: "ai98pro",
      },
    })).rejects.toThrow("TARGET_DEFAULT_REFERENCE_EXISTS");
  });

  test("已有默认目标时，未传默认目标只保留原值", async () => {
    const fixture = await createTargetFixture();
    await fixture.store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "ai98pro",
        cliSyncEnabled: true,
      },
    });

    const updated = await fixture.store.updateConfig({
      expectedRevision: 3,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        boundTargetIds: ["ai98pro"],
        cliSyncEnabled: true,
      },
    });

    expect(updated.agentConnections.codex?.defaultTargetId).toBe("ai98pro");
  });

  test("拒绝保存只有供应商或只有价格条目 ID 的半映射", async () => {
    const fixture = await createTargetFixture();

    await expect(fixture.store.updateConfig({
      expectedRevision: 2,
      targetPatch: {
        id: "ai98pro",
        target: {pricing: {modelVendors: {"gpt-5.6": {vendor: "openai"}}}},
      },
    })).rejects.toThrow("MODEL_PRICE_MAPPING_INCOMPLETE");
  });

  test("删除目标必须先停用且不能仍被 Agent 默认链引用", async () => {
    const fixture = await createTargetFixture();
    await expect(fixture.store.updateConfig({
      expectedRevision: 2,
      targetDelete: {id: "ai98pro"},
    })).rejects.toThrow("TARGET_MUST_BE_DISABLED");

    await fixture.store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "ai98pro",
        cliSyncEnabled: true,
      },
    });
    await fixture.store.updateConfig({
      expectedRevision: 3,
      targetPatch: {id: "ai98pro", target: {enabled: false}},
    });

    await expect(fixture.store.updateConfig({
      expectedRevision: 4,
      targetDelete: {id: "ai98pro"},
    })).rejects.toThrow("TARGET_DEFAULT_REFERENCE_EXISTS");
  });

  test("删除已停用且无默认引用的目标时清理 Agent 绑定引用", async () => {
    const fixture = await createTargetFixture();
    await fixture.store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        boundTargetIds: ["ai98pro"],
        cliSyncEnabled: true,
      },
    });
    await fixture.store.updateConfig({
      expectedRevision: 3,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        defaultTargetId: "",
        cliSyncEnabled: true,
      },
    });
    await fixture.store.updateConfig({
      expectedRevision: 4,
      targetPatch: {id: "ai98pro", target: {enabled: false}},
    });

    const deleted = await fixture.store.updateConfig({
      expectedRevision: 5,
      targetDelete: {id: "ai98pro"},
    });

    expect(deleted.targets).toEqual([]);
    expect(deleted.agentConnections.codex?.boundTargetIds).toBeUndefined();
  });

  test("停用目标后清理 Claude 指向该目标的模型别名", async () => {
    const fixture = await createTargetFixture();
    await fixture.store.updateConfig({
      expectedRevision: 2,
      targetPatch: {id: "ai98pro", target: {anthropicUrl: "https://proxy.example/anthropic/v1"}},
    });
    await fixture.store.updateConfig({
      expectedRevision: 3,
      agentConnectionPatch: {
        agent: "claude",
        action: "connect",
        boundTargetIds: ["ai98pro"],
        defaultTargetId: "ai98pro",
        cliSyncEnabled: true,
        modelAliases: {sonnet: "gpt-5.6_ai98pro"},
      },
    });

    const disabled = await fixture.store.updateConfig({
      expectedRevision: 4,
      targetPatch: {id: "ai98pro", target: {enabled: false}},
    });

    expect(disabled.agentConnections.claude?.modelAliases).toBeUndefined();
  });

  test("默认模型在目标未声明 wire API 时按 URL 推断保留，不被 normalize 剔除", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "deepaa-v3-default-model-"));
    const configPath = join(dataDir, "proxy-config.json");
    const store = new ProxyConfigStore({configPath, localProxyBaseUrl: "http://localhost:3211"});
    await store.init();
    // 不写 supportedModelWireApis：gpt 系列按 URL+家族推断 responses
    await store.updateConfig({
      expectedRevision: 1,
      targetPatch: {
        target: {
          id: "relay.example",
          name: "relay",
          enabled: true,
          openaiUrl: "https://relay.example/v1",
          supportedModels: ["gpt-5.6-sol"],
          supportedModelScopes: {"gpt-5.6-sol": ["codex"]},
        },
      },
    });
    const updated = await store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "codex",
        action: "connect",
        boundTargetIds: ["relay.example"],
        defaultTargetId: "relay.example",
        defaultModelId: "gpt-5.6-sol",
        cliSyncEnabled: true,
      },
    });
    expect(updated.targets[0]?.development?.defaultModels?.codex).toBe("gpt-5.6-sol");
    // 重新加载后依然保留（normalize 不再剔除）
    await store.reload();
    expect(store.getConfig().targets[0]?.development?.defaultModels?.codex).toBe("gpt-5.6-sol");
  });

  test("Claude 别名保存时丢弃 wire API 不兼容的模型并保留兼容别名", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "deepaa-v3-alias-wire-"));
    const configPath = join(dataDir, "proxy-config.json");
    const store = new ProxyConfigStore({configPath, localProxyBaseUrl: "http://localhost:3211"});
    await store.init();
    await store.updateConfig({
      expectedRevision: 1,
      targetPatch: {
        target: {
          id: "relay.example",
          name: "relay",
          enabled: true,
          openaiUrl: "https://relay.example/v1",
          anthropicUrl: "https://relay.example/anthropic",
          supportedModels: ["chat-only-model", "messages-model"],
          supportedModelScopes: {
            "chat-only-model": ["claude"],
            "messages-model": ["claude"],
          },
          supportedModelWireApis: {
            "chat-only-model": ["chat_completions"],
            "messages-model": ["messages", "chat_completions"],
          },
        },
      },
    });

    const updated = await store.updateConfig({
      expectedRevision: 2,
      agentConnectionPatch: {
        agent: "claude",
        action: "connect",
        boundTargetIds: ["relay.example"],
        defaultTargetId: "relay.example",
        cliSyncEnabled: true,
        modelAliases: {
          opus: "chat-only-model_relay.example",
          sonnet: "messages-model_relay.example",
        },
      },
    });

    // chat-only 模型无法被 Claude Code 的 messages binding 路由，
    // 与下拉过滤一致：保存侧必须丢弃，而不是存进去后由网关报错。
    expect(updated.agentConnections.claude?.modelAliases).toEqual({
      sonnet: "messages-model_relay.example",
    });
  });
});

async function createTargetFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-v3-target-"));
  const configPath = join(dataDir, "proxy-config.json");
  const credentialsPath = join(dataDir, "development-credentials.json");
  await writeFile(credentialsPath, JSON.stringify({
    version: 1,
    credentials: [{
      id: "cred-codex",
      targetId: "ai98pro",
      label: "Codex key",
      store: "macos-keychain",
      account: "deepaa/cred-codex",
      fingerprintSuffix: "1234",
      agentScope: ["codex"],
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    }],
  }));
  const store = new ProxyConfigStore({
    configPath,
    developmentCredentialsPath: credentialsPath,
    localProxyBaseUrl: "http://localhost:3211",
  });
  await store.init();
  await store.updateConfig({
    expectedRevision: 1,
    targetPatch: {
      target: {
        id: "ai98pro",
        name: "AI98PRO",
        enabled: true,
        openaiUrl: "https://proxy.example/v1",
        supportedModels: ["gpt-5.6"],
        supportedModelScopes: {"gpt-5.6": ["codex"]},
        supportedModelWireApis: {"gpt-5.6": ["responses", "chat_completions"]},
      },
    },
  });
  return {store, configPath};
}

describe("ProxyConfigStore V3 启动偏好与显式字段保留", () => {
  test("launchPreferences 落库、清洗非法值，connect 补丁与重载后均保留 preferredWireApi", async () => {
    const fixture = await createTargetFixture();
    const targetValue = fixture.store.getConfig().targets[0]!;
    // opencode 支持 messages/chat 的目标才能设 preferredWireApi。
    await fixture.store.updateConfig({
      targets: [{
        ...targetValue,
        id: "shared-oc",
        name: "shared-oc",
        anthropicUrl: `${targetValue.openaiUrl?.replace(/\/v1$/, "")}/anthropic`,
        supportedModels: ["gpt-5.6", "claude-sonnet-4-5"],
        supportedModelScopes: { "gpt-5.6": ["opencode"], "claude-sonnet-4-5": ["opencode"] },
        supportedModelWireApis: { "gpt-5.6": ["responses", "chat_completions"], "claude-sonnet-4-5": ["messages"] },
        pricing: { vendor: "test", rateMultiplier: 1, modelVendors: {
          "gpt-5.6": { vendor: "test", priceEntryId: "test:gpt-5.6" },
          "claude-sonnet-4-5": { vendor: "test", priceEntryId: "test:claude-sonnet-4-5" },
        } },
      }],
    });
    await fixture.store.updateConfig({
      agentConnectionPatch: {
        agent: "opencode",
        action: "connect",
        defaultTargetId: "shared-oc",
        defaultModelId: "gpt-5.6",
        cliSyncEnabled: true,
      },
    });
    // 用补丁落库 launchPreferences，并验证后续普通 connect 补丁不会丢已落库字段。
    const withPrefs = await fixture.store.updateConfig({
      agentConnectionPatch: {
        agent: "opencode",
        action: "connect",
        launchPreferences: {
          reasoningEffort: "low",
          permissionMode: "should-be-dropped-for-opencode",
          contextWindows: {"gpt-5.6_shared-oc": 262144, "openai/gpt-5.6-sol_shared-oc": 3500000, "bad key!": 1, "neg": -5, "bare-legacy-key": 100},
        },
      },
    });
    const connection = withPrefs.agentConnections.opencode!;
    // 值域清洗：非法模型键、裸模型 ID 死键（复合键规范前旧格式）与非法数字被丢弃；
    // permissionMode 字段保留但由消费方校验。
    expect(connection.launchPreferences).toEqual({
      reasoningEffort: "low",
      permissionMode: "should-be-dropped-for-opencode",
      contextWindows: {"gpt-5.6_shared-oc": 262144, "openai/gpt-5.6-sol_shared-oc": 3500000},
    });

    // 后续普通 connect 补丁（如开发启动默认链写入）不丢失 launchPreferences。
    const afterDefaults = await fixture.store.updateConfig({
      agentConnectionPatch: {
        agent: "opencode",
        action: "connect",
        defaultModelId: "claude-sonnet-4-5",
      },
    });
    expect(afterDefaults.agentConnections.opencode?.launchPreferences).toEqual({
      reasoningEffort: "low",
      permissionMode: "should-be-dropped-for-opencode",
      contextWindows: {"gpt-5.6_shared-oc": 262144, "openai/gpt-5.6-sol_shared-oc": 3500000},
    });

    // 显式 null 清空偏好。
    const cleared = await fixture.store.updateConfig({
      agentConnectionPatch: {agent: "opencode", action: "connect", launchPreferences: null},
    });
    expect(cleared.agentConnections.opencode?.launchPreferences).toBeUndefined();

    // 从磁盘重载后偏好字段仍然保留（归一化不丢弃）。
    const reloaded = new ProxyConfigStore({configPath: fixture.configPath, localProxyBaseUrl: "http://localhost:3211"});
    await reloaded.init();
    await reloaded.updateConfig({
      agentConnectionPatch: {agent: "opencode", action: "connect", launchPreferences: {reasoningEffort: "high"}},
    });
    const reread = new ProxyConfigStore({configPath: fixture.configPath, localProxyBaseUrl: "http://localhost:3211"});
    await reread.init();
    expect(reread.getConfig().agentConnections.opencode?.launchPreferences).toEqual({reasoningEffort: "high"});
  });
});
