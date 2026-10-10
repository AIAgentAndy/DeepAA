import {describe, expect, test} from "vitest";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";
import {
  eligibleDefaultModelForAgent,
  ensureProxyTargetAgentDefaults,
  firstSidebarTargetId,
  getAgentReadiness,
  getTargetReadiness,
  inferDiscoveredVendor,
  proxyManagementTargetHref,
  resolveProxyOnboardingStartStep,
  resolveTargetModelPriceEntry,
  selectFallbackTarget,
} from "../src/lib/proxy-management-domain.js";
import {resolveAgentConnection} from "../src/lib/agent-connections.js";

function target(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    id: "relay",
    name: "Relay",
    enabled: true,
    openaiUrl: "https://relay.example/v1",
    supportedModels: ["gpt-5.6-sol"],
    supportedModelScopes: {"gpt-5.6-sol": ["codex"]},
    supportedModelWireApis: {"gpt-5.6-sol": ["responses", "chat_completions"]},
    pricing: {rateMultiplier: 1, modelVendors: {
      "gpt-5.6-sol": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-sol"},
    }},
    development: {
      defaultModels: {codex: "gpt-5.6-sol"},
      defaultCredentials: {codex: "cred-relay"},
    },
    ...overrides,
  };
}

describe("代理管理领域规则", () => {
  test("删除目标后回退到侧栏第一个目标（供应商族分组排序，而非配置数组首项）", () => {
    const targets = [
      target({id: "openai-sub", name: "OpenAI 订阅", vendorFamily: "openai"}),
      target({id: "zhipu-cn", name: "智谱", vendorFamily: "zhipu"}),
      target({id: "kimi-cn", name: "Kimi", vendorFamily: "kimi"}),
      target({id: "vol-plan", name: "火山", vendorFamily: "volcengine"}),
    ];
    // 配置数组首项是 openai-sub，但侧栏按供应商族中文排序后第一个是 Kimi。
    expect(firstSidebarTargetId(targets)).toBe("kimi-cn");
    // 无供应商族的自定义目标归入 other，排在任意具名族之前。
    expect(firstSidebarTargetId([
      target({id: "custom", name: "自定义", vendorFamily: undefined}),
      target({id: "zhipu-cn", name: "智谱", vendorFamily: "zhipu"}),
    ])).toBe("custom");
    // 侧栏有搜索词时，只从当前可见目标中取第一个。
    expect(firstSidebarTargetId(targets, "火山")).toBe("vol-plan");
    expect(firstSidebarTargetId(targets, "不存在的目标")).toBeUndefined();
    expect(firstSidebarTargetId([])).toBeUndefined();
  });

  test("首次配置自动补齐可用 Agent 的默认模型和默认密钥，但不覆盖已有默认值", () => {
    const initial = target({development: undefined});
    const completed = ensureProxyTargetAgentDefaults(initial, [
      {id: "cred-new", targetId: initial.id, agentScope: ["codex"]},
    ]);
    expect(completed.development).toMatchObject({
      defaultModels: {codex: "gpt-5.6-sol"},
      defaultCredentials: {codex: "cred-new"},
    });

    const preserved = ensureProxyTargetAgentDefaults({...completed, development: {
      ...completed.development,
      defaultCredentials: {codex: "cred-old"},
    }}, [
      {id: "cred-new", targetId: initial.id, agentScope: ["codex"]},
      {id: "cred-old", targetId: initial.id, agentScope: ["codex"]},
    ]);
    expect(preserved.development?.defaultModels?.codex).toBe("gpt-5.6-sol");
    expect(preserved.development?.defaultCredentials?.codex).toBe("cred-old");
  });

  test("双协议目标按模型 scope 分别补齐 Codex 与 Claude 默认模型", () => {
    const dual = target({
      anthropicUrl: "https://relay.example/anthropic",
      supportedModels: ["gpt-5.6-sol", "claude-sonnet-5"],
      supportedModelScopes: {"gpt-5.6-sol": ["codex"], "claude-sonnet-5": ["claude"]},
      supportedModelWireApis: {
        "gpt-5.6-sol": ["responses", "chat_completions"],
        "claude-sonnet-5": ["messages"],
      },
      pricing: {rateMultiplier: 1, modelVendors: {
        "gpt-5.6-sol": {vendor: "openai", priceEntryId: "openai:gpt-5.6-sol"},
        "claude-sonnet-5": {vendor: "anthropic", priceEntryId: "anthropic:claude-sonnet-5"},
      }},
      development: undefined,
    });
    const completed = ensureProxyTargetAgentDefaults(dual, [
      {id: "cred-dual", targetId: dual.id, agentScope: ["codex", "claude"]},
    ]);
    expect(completed.development).toMatchObject({
      defaultModels: {codex: "gpt-5.6-sol", claude: "claude-sonnet-5"},
      defaultCredentials: {codex: "cred-dual", claude: "cred-dual"},
    });
  });

  test("默认模型补齐同时要求模型 wire API 与目标可用 binding 有交集", () => {
    const messagesOnly = target({
      openaiUrl: "https://relay.example/v1",
      anthropicUrl: undefined,
      supportedModelWireApis: {"gpt-5.6-sol": ["messages"]},
      development: undefined,
    });
    // openaiUrl 只提供 openai 协议 binding，messages 模型对 Codex 不可用 → 不自动补齐。
    const completed = ensureProxyTargetAgentDefaults(messagesOnly, [
      {id: "cred-relay", targetId: messagesOnly.id, agentScope: ["codex"]},
    ]);
    expect(completed.development?.defaultModels?.codex).toBeUndefined();
    expect(completed.development?.defaultCredentials?.codex).toBe("cred-relay");

    // 已保存但 wire API 失效的默认模型会被清理，而不是保留为不可用引用。
    const stale = target({
      openaiUrl: "https://relay.example/v1",
      anthropicUrl: undefined,
      supportedModelWireApis: {"gpt-5.6-sol": ["messages"]},
      development: {defaultModels: {codex: "gpt-5.6-sol"}},
    });
    const cleaned = ensureProxyTargetAgentDefaults(stale, []);
    expect(cleaned.development?.defaultModels?.codex).toBeUndefined();
  });

  test("默认模型失效且没有替代项时清理模型，凭据引用留给凭据服务处理", () => {
    const invalid = target({
      supportedModels: [],
      pricing: {rateMultiplier: 1, modelVendors: {}},
      development: {
        defaultModels: {codex: "removed-model"},
        defaultCredentials: {codex: "removed-credential"},
      },
    });

    const completed = ensureProxyTargetAgentDefaults(invalid, []);

    expect(completed.development).toEqual({
      defaultCredentials: {codex: "removed-credential"},
    });
  });

  test("自定义模型按家族给出供应商建议，未知模型不猜供应商", () => {
    expect(inferDiscoveredVendor("gpt-5.6-sol")).toEqual({vendor: "openai", reason: "openai_model_family"});
    expect(inferDiscoveredVendor("o3-mini")).toEqual({vendor: "openai", reason: "openai_model_family"});
    expect(inferDiscoveredVendor("claude-sonnet-5")).toEqual({vendor: "anthropic", reason: "anthropic_model_family"});
    expect(inferDiscoveredVendor("glm-5.3")).toEqual({vendor: "zhipu-cn", reason: "zhipu_model_family"});
    expect(inferDiscoveredVendor("kimi-k3")).toEqual({vendor: "moonshot-cn", reason: "moonshot_model_family"});
    // 2026-10-04 中国区 vendor 改名：deepseek/dashscope → deepseek-cn/qwenai-cn。
    expect(inferDiscoveredVendor("deepseek-v4-pro")).toEqual({vendor: "deepseek-cn", reason: "deepseek_model_family"});
    expect(inferDiscoveredVendor("qwen3.8-max")).toEqual({vendor: "qwenai-cn", reason: "qwen_model_family"});
    expect(inferDiscoveredVendor("MiniMax-M3")).toEqual({vendor: "minimax-cn", reason: "minimax_model_family"});
    expect(inferDiscoveredVendor("unknown-model")).toBeUndefined();
  });

  test("目标 ready 必须要求每个 Agent 可见模型都有有效价格映射", () => {
    expect(getTargetReadiness(target())).toMatchObject({ready: true});
    expect(getTargetReadiness(target({pricing: {rateMultiplier: 1}}))).toMatchObject({
      ready: false,
      reasons: ["MODEL_PRICE_MAPPING_REQUIRED"],
    });
    expect(getTargetReadiness(target(), [{targetId: "other"}])).toMatchObject({
      ready: false,
      reasons: ["CREDENTIAL_REQUIRED"],
    });
  });

  test("Agent ready 同时校验绑定关系、协议、默认模型和默认密钥", () => {
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-08-18T00:00:00.000Z",
      targets: [target()],
      agentConnections: {
        codex: {enabled: true, boundTargetIds: ["relay"], defaultTargetId: "relay", cliSyncEnabled: true},
      },
    };
    expect(getAgentReadiness(config, "codex")).toMatchObject({ready: true});
    expect(getAgentReadiness({...config, agentConnections: {
      codex: {enabled: true, boundTargetIds: [], defaultTargetId: "relay", cliSyncEnabled: true},
    }}, "codex")).toMatchObject({ready: false, reasons: ["DEFAULT_TARGET_NOT_BOUND"]});
  });

  test("官方预设仅支持 chat/completions 时 Codex 默认链不可就绪", () => {
    const glmTarget = target({
      id: "zhipu-cn",
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      supportedModelWireApis: {"gpt-5.6-sol": ["chat_completions"]},
    });
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-08-18T00:00:00.000Z",
      targets: [glmTarget],
      agentConnections: {
        codex: {enabled: true, boundTargetIds: [glmTarget.id], defaultTargetId: glmTarget.id, cliSyncEnabled: true},
      },
    };

    // Codex 只支持 Responses，预设无该能力时默认链整体不可用。
    expect(getAgentReadiness(config, "codex")).toMatchObject({
      ready: false,
      reasons: ["PRESET_WIRE_API_UNSUPPORTED", "DEFAULT_MODEL_WIRE_API_MISMATCH"],
    });
  });

  test("页面 Agent 默认链与领域 ready 一样阻止缺少价格映射的模型", () => {
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-08-18T00:00:00.000Z",
      targets: [target({pricing: {rateMultiplier: 1}})],
      agentConnections: {
        codex: {enabled: true, boundTargetIds: ["relay"], defaultTargetId: "relay", cliSyncEnabled: true},
      },
    };

    expect(resolveAgentConnection(config, "codex", [{
      id: "cred-relay",
      targetId: "relay",
      label: "主密钥",
      agentScope: ["codex"],
    }] as never)).toMatchObject({
      proxyReady: false,
      reasonCodes: ["DEFAULT_MODEL_PRICE_MAPPING_REQUIRED"],
    });
  });

  test("停用默认目标时只选择完整 ready 的已绑定候选", () => {
    const current = target({id: "current"});
    const ready = target({id: "ready", openaiUrl: "https://ready.example/v1"});
    const incomplete = target({id: "incomplete", openaiUrl: undefined, supportedModels: []});
    expect(selectFallbackTarget([current, ready, incomplete], "codex", "current", ["current", "ready", "incomplete"])?.id)
      .toBe("ready");
    expect(selectFallbackTarget([current, incomplete], "codex", "current", ["current", "incomplete"])).toBeUndefined();
    expect(selectFallbackTarget([current, ready], "codex", "current", ["current", "ready"], new Set())).toBeUndefined();
  });

  test("新建目标即使命中同路由 ID 的旧凭据缓存，也必须从系统密钥步骤开始", () => {
    const official = target({
      id: "opencode.ai-zen-go-v1",
      presetId: "opencode-go",
      openaiUrl: "https://opencode.ai/zen/go/v1",
      anthropicUrl: "https://opencode.ai/zen/go/v1",
      supportedModelScopes: undefined,
    });
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-08-19T00:00:00.000Z",
      targets: [official],
      agentConnections: {},
    };

    expect(resolveProxyOnboardingStartStep({
      target: official,
      config,
      credentials: [{id: "stale-credential", targetId: official.id}],
      isNewTarget: true,
    })).toBe("credentials");
    expect(resolveProxyOnboardingStartStep({
      target: official,
      config,
      credentials: [{id: "real-credential", targetId: official.id}],
    })).toBe("agent");
  });

  test("订阅目标就绪与接入不要求系统凭据，向导跳过系统密钥步骤", () => {
    const sub = target({
      id: "anthropic-sub",
      billingChannel: "subscription",
      openaiUrl: undefined,
      anthropicUrl: "https://api.anthropic.com",
      supportedModels: ["claude-sonnet-4-5"],
      supportedModelScopes: {"claude-sonnet-4-5": ["claude"]},
      pricing: {rateMultiplier: 1, modelVendors: {
        "claude-sonnet-4-5": {vendor: "anthropic", priceEntryId: "anthropic:claude-sonnet-4-5"},
      }},
      development: {defaultModels: {claude: "claude-sonnet-4-5"}},
    });
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-08-20T00:00:00.000Z",
      targets: [sub],
      agentConnections: {
        claude: {enabled: true, boundTargetIds: [sub.id], defaultTargetId: sub.id, cliSyncEnabled: true},
      },
    };

    expect(getTargetReadiness(sub, []).reasons).not.toContain("CREDENTIAL_REQUIRED");
    expect(getAgentReadiness(config, "claude").reasons).not.toContain("DEFAULT_CREDENTIAL_REQUIRED");
    expect(resolveProxyOnboardingStartStep({
      target: sub,
      config,
      credentials: [],
      agent: "claude",
    })).not.toBe("credentials");
    expect(resolveProxyOnboardingStartStep({
      target: sub,
      config,
      credentials: [],
      isNewTarget: true,
    })).not.toBe("credentials");
  });

  test("为指定 Agent 接入时按 wire 兼容判定起始步骤，不强制重走模型探测", () => {
    // gpt-5.6-sol 归属只有 codex，但 opencode 的 responses binding 与其 wire 兼容：
    // 完成阶段本就能自动合并归属，入口应直接进入接入步骤而不是 discover。
    const relay = target({
      supportedModels: ["gpt-5.6-sol"],
      supportedModelWireApis: {"gpt-5.6-sol": ["responses"]},
    });
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-09-02T00:00:00.000Z",
      targets: [relay],
      agentConnections: {},
    };
    const credentials = [{id: "cred-relay", targetId: relay.id, agentScope: ["codex"]}];
    expect(resolveProxyOnboardingStartStep({target: relay, config, credentials, agent: "opencode"})).toBe("agent");
    // 2026-10-06 dsh 三协议：responses 模型对 dsh 可用，接入向导可直接进入 agent 步骤。
    expect(resolveProxyOnboardingStartStep({target: relay, config, credentials, agent: "dsh"})).toBe("agent");
    // 目标下已有任意密钥（即使归属不含该 Agent）不再强制进入密钥步骤：完成阶段会补齐归属。
    const unscoped = [{id: "cred-relay", targetId: relay.id, agentScope: ["codex"]}];
    const claudeOnly = target({
      openaiUrl: undefined,
      anthropicUrl: "https://relay.example",
      supportedModels: ["claude-sonnet-4-5"],
      supportedModelScopes: {"claude-sonnet-4-5": ["claude"]},
      supportedModelWireApis: {"claude-sonnet-4-5": ["messages"]},
    });
    expect(resolveProxyOnboardingStartStep({
      target: claudeOnly,
      config,
      credentials: unscoped,
      agent: "claude",
    })).toBe("agent");
    // 完全没有密钥时仍从密钥步骤开始。
    expect(resolveProxyOnboardingStartStep({
      target: relay, config, credentials: [], agent: "codex",
    })).toBe("credentials");
  });

  test("存量 wire 声明为空数组导致无任何兼容 Agent 时，起始步骤进入模型探测自救", () => {
    // catapi 场景：claude 模型落库空数组（显式拒绝），任何 Agent 都不兼容；
    // 未指定 Agent 的入口必须进入 discover，由重新确认按当前 URL 重算协议能力。
    const stale = target({
      openaiUrl: "https://catapi.example",
      anthropicUrl: "https://catapi.example",
      supportedModels: ["claude-fable-5"],
      supportedModelScopes: undefined,
      supportedModelWireApis: {"claude-fable-5": []},
    });
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-09-02T00:00:00.000Z",
      targets: [stale],
      agentConnections: {},
    };
    expect(resolveProxyOnboardingStartStep({
      target: stale, config, credentials: [{id: "c", targetId: stale.id, agentScope: ["codex"]}],
    })).toBe("discover");
  });

  test("代理目标回退会同步替换或移除 URL target，同时保留其它查询参数和 hash", () => {
    expect(proxyManagementTargetHref(
      "http://localhost:3210/proxy-management?target=missing&agent=codex#resources",
      "ai98pro",
    )).toBe("/proxy-management?target=ai98pro&agent=codex#resources");
    expect(proxyManagementTargetHref(
      "http://localhost:3210/proxy-management?target=missing&agent=codex#resources",
      "",
    )).toBe("/proxy-management?agent=codex#resources");
  });

  test("目标模型解析价格中心条目必须锁定供应商，禁止跨供应商按模型名猜测", () => {
    const azureEntry = {
      id: "azure/gpt-5.6-sol",
      vendor: "azure",
      runtimeModelId: "gpt-5.6-sol",
      patterns: ["azure/gpt-5.6-sol"],
      confidence: "third_party" as const,
    };
    const opencodeEntry = {
      id: "catalog:opencode-go:gpt-5.6-sol",
      vendor: "opencode-go",
      runtimeModelId: "gpt-5.6-sol",
      patterns: ["gpt-5.6-sol"],
      confidence: "official" as const,
    };
    const mapping = {vendor: "opencode-go", priceEntryId: "catalog:opencode-go:gpt-5.6-sol"};
    // 权威条目已加载：按 priceEntryId 精确命中，不能命中 azure 同名条目。
    expect(resolveTargetModelPriceEntry([azureEntry, opencodeEntry], "gpt-5.6-sol", mapping)?.id)
      .toBe("catalog:opencode-go:gpt-5.6-sol");
    // 权威条目因分页未加载时，不能退回 azure 的同名条目，展示应为缺失而非错误供应商。
    expect(resolveTargetModelPriceEntry([azureEntry], "gpt-5.6-sol", mapping)).toBeUndefined();
    // 没有供应商映射时绝不跨供应商猜测。
    expect(resolveTargetModelPriceEntry([azureEntry], "gpt-5.6-sol", undefined)).toBeUndefined();
  });

  test("eligibleDefaultModelForAgent：scope ∩ wire API ∩ 价格映射三条件、正序第一个、可排除自身", () => {
    // scope 不含该 Agent 的模型不入选；无价格映射的不入选；均合格时取正序第一个。
    const multi = target({
      supportedModels: ["gpt-5.6-sol", "gpt-5.6", "gpt-5.6-mini"],
      supportedModelScopes: {"gpt-5.6-sol": ["codex"], "gpt-5.6": ["codex"], "gpt-5.6-mini": ["claude"]},
      supportedModelWireApis: {
        "gpt-5.6-sol": ["responses", "chat_completions"],
        "gpt-5.6": ["responses"],
        "gpt-5.6-mini": ["chat_completions"],
      },
      pricing: {rateMultiplier: 1, modelVendors: {
        "gpt-5.6-sol": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-sol"},
        "gpt-5.6": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6"},
        "gpt-5.6-mini": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-mini"},
      }},
    });
    expect(eligibleDefaultModelForAgent(multi, "codex")).toBe("gpt-5.6-sol");
    // 排除自身后取下一个合格模型：UI 适用收窄兜底与服务端修复同源依赖该语义。
    expect(eligibleDefaultModelForAgent(multi, "codex", {excludeModelId: "gpt-5.6-sol"})).toBe("gpt-5.6");

    // wire API 不兼容的模型不入选（codex 只绑 responses；mini 只声明 chat_completions）。
    const wireMismatch = target({
      supportedModels: ["gpt-5.6-mini", "gpt-5.6"],
      supportedModelScopes: {"gpt-5.6-mini": ["codex"], "gpt-5.6": ["codex"]},
      supportedModelWireApis: {"gpt-5.6-mini": ["chat_completions"], "gpt-5.6": ["responses"]},
      pricing: {rateMultiplier: 1, modelVendors: {
        "gpt-5.6-mini": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6-mini"},
        "gpt-5.6": {vendor: "openai", priceEntryId: "catalog:openai:gpt-5.6"},
      }},
    });
    expect(eligibleDefaultModelForAgent(wireMismatch, "codex")).toBe("gpt-5.6");

    // 缺价格映射的模型不入选：全部不合格时返回 undefined（调用方清除默认键）。
    const noMapping = target({
      pricing: {rateMultiplier: 1},
    });
    expect(eligibleDefaultModelForAgent(noMapping, "codex")).toBeUndefined();

    // 协议能力不支持（目标无 anthropicUrl 但问 claude）：恒 undefined。
    expect(eligibleDefaultModelForAgent(target(), "claude")).toBeUndefined();
  });
});
