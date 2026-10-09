import {expect, test} from "vitest";
import {
  agentCompatibleModelsForTarget,
  boundCompatibleTargetsForAgent,
  buildAgentDropPatch,
  buildClaudeSettingsPreview,
  buildClaudeTargetSettingsPreview,
  claudeAliasModelOptions,
  isAgentConnected,
  servedAgentsForTarget,
  targetSupportsAgent,
} from "../src/components/proxy-management/agent-catalog.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

/**
 * 预览与别名选项的行为测试。
 * 场景固定为两个启用目标：bigmodel（Claude 当前默认目标，glm-5.2）与
 * volces（向导正在配置的目标，kimi-k3 仅归属 claude），复现
 * 「预览显示别的目标模型」与「别名只能选当前目标模型」两个问题。
 */
function bigmodelTarget(): ProxyTarget {
  return {
    id: "open.bigmodel.cn-api-paas-v4",
    name: "bigmodel",
    enabled: true,
    anthropicUrl: "https://open.bigmodel.cn/api/paas/v4",
    supportedModels: ["glm-5.1", "glm-5.2"],
    supportedModelScopes: {
      "glm-5.1": ["claude"],
      "glm-5.2": ["claude"],
    },
    development: {
      defaultModels: {codex: "glm-5.2", claude: "glm-5.2"},
      defaultCredentials: {claude: "cred-glm"},
    },
  };
}

function volcesTarget(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    id: "ark.cn-beijing.volces.com-api-plan",
    name: "volces",
    enabled: true,
    anthropicUrl: "https://ark.cn-beijing.volces.com/api/plan",
    supportedModels: ["kimi-k3"],
    supportedModelScopes: {"kimi-k3": ["claude"]},
    development: {
      defaultModels: {claude: "kimi-k3"},
      defaultCredentials: {claude: "cred-kimi"},
    },
    ...overrides,
  };
}

function previewConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {
      claude: {defaultTargetId: "open.bigmodel.cn-api-paas-v4", cliSyncEnabled: true},
    },
    targets: [bigmodelTarget(), volcesTarget()],
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

test("向导预览按当前目标计算模型，不受 Claude 当前默认目标影响", () => {
  const preview = buildClaudeTargetSettingsPreview(previewConfig(), volcesTarget());

  expect(preview.targetPreviewed).toBe("ark.cn-beijing.volces.com-api-plan");
  expect(preview.model).toBe("kimi-k3_ark.cn-beijing.volces.com-api-plan");
  const env = preview.env as Record<string, string>;
  expect(env.ANTHROPIC_MODEL).toBe("kimi-k3_ark.cn-beijing.volces.com-api-plan");
  expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("kimi-k3_ark.cn-beijing.volces.com-api-plan");
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("kimi-k3_ark.cn-beijing.volces.com-api-plan");
  expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("kimi-k3_ark.cn-beijing.volces.com-api-plan");
});

test("向导预览在目标未显式设置默认模型时保持待配置", () => {
  const target = volcesTarget({development: {defaultCredentials: {claude: "cred-kimi"}}});
  const preview = buildClaudeTargetSettingsPreview(previewConfig(), target);

  expect(preview.model).toBe("(待配置)");
});

test("向导预览应用全局别名时仍以当前目标模型为回退", () => {
  const config = previewConfig();
  config.agentConnections.claude!.modelAliases = {opus: "glm-5.1_open.bigmodel.cn-api-paas-v4"};
  const preview = buildClaudeTargetSettingsPreview(config, volcesTarget());

  const env = preview.env as Record<string, string>;
  expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.1_open.bigmodel.cn-api-paas-v4");
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("kimi-k3_ark.cn-beijing.volces.com-api-plan");
});

test("默认访问链预览的 targetPreviewed 与实际模型来源目标一致", () => {
  // 「Agent 接入」页在 volces 目标上展开预览，但 Claude 默认目标仍是 bigmodel：
  // 模型来自 bigmodel，targetPreviewed 也必须标 bigmodel，不得混搭。
  const preview = buildClaudeSettingsPreview(previewConfig(), volcesTarget());

  expect(preview.model).toBe("glm-5.2_open.bigmodel.cn-api-paas-v4");
  expect(preview.targetPreviewed).toBe("open.bigmodel.cn-api-paas-v4");
});

test("Claude 别名选项只覆盖已接入（绑定）Claude Code 的供应商模型", () => {
  // previewConfig 的 claude 连接只绑定了 bigmodel（默认目标）：
  // volces 未接入 Claude Code，其 kimi-k3 不应出现在别名候选中，
  // 否则保存时会被 normalizeModelAliases 静默丢弃（选了也设置不上）。
  const options = claudeAliasModelOptions(previewConfig());

  expect(options).toContain("glm-5.1_open.bigmodel.cn-api-paas-v4");
  expect(options).toContain("glm-5.2_open.bigmodel.cn-api-paas-v4");
  expect(options).not.toContain("kimi-k3_ark.cn-beijing.volces.com-api-plan");

  // volces 接入（绑定）后其归属 claude 的模型进入候选。
  const config = previewConfig();
  config.agentConnections.claude = {
    defaultTargetId: "open.bigmodel.cn-api-paas-v4",
    boundTargetIds: ["open.bigmodel.cn-api-paas-v4", "ark.cn-beijing.volces.com-api-plan"],
    cliSyncEnabled: true,
  };
  expect(claudeAliasModelOptions(config)).toContain("kimi-k3_ark.cn-beijing.volces.com-api-plan");
});

test("Claude 别名选项排除 wire API 不兼容（chat-only）的模型", () => {
  // 场景：glm-5.3 归属了 claude，但供应商只把它声明为 chat_completions，
  // Claude Code 的 messages binding 无法路由，别名下拉不得展示。
  const config = previewConfig({
    targets: [
      {
        ...bigmodelTarget(),
        supportedModels: ["glm-5.3", "glm-5.3-flash"],
        supportedModelScopes: {
          "glm-5.3": ["claude"],
          "glm-5.3-flash": ["claude"],
        },
        supportedModelWireApis: {
          "glm-5.3": ["chat_completions"],
          "glm-5.3-flash": ["chat_completions"],
        },
      },
    ],
  });

  expect(claudeAliasModelOptions(config)).toEqual([]);
});

test("Claude 别名选项排除停用目标与仅归属其他 Agent 的模型", () => {
  const config = previewConfig({
    targets: [
      bigmodelTarget(),
      volcesTarget(),
      {
        id: "api.deepseek.com",
        name: "deepseek",
        enabled: false,
        anthropicUrl: "https://api.deepseek.com/anthropic",
        supportedModels: ["deepseek-v4-flash"],
      },
      {
        id: "ai98pro.xyz",
        name: "ai98pro",
        enabled: true,
        openaiUrl: "https://ai98pro.xyz/v1",
        supportedModels: ["gpt-5.6-sol"],
        supportedModelScopes: {"gpt-5.6-sol": ["codex"]},
      },
    ],
  });
  const options = claudeAliasModelOptions(config);

  expect(options).not.toContain("deepseek-v4-flash_api.deepseek.com");
  expect(options).not.toContain("gpt-5.6-sol_ai98pro.xyz");
});

test("只有绑定目标而没有默认目标时，Agent 仍视为已接入但处于待配置", () => {
  const config = previewConfig({
    agentConnections: {codex: {enabled: true, boundTargetIds: ["ark.cn-beijing.volces.com-api-plan"], cliSyncEnabled: true}},
  });

  expect(isAgentConnected(config, "codex")).toBe(true);
});

test("开发入口候选只保留已绑定、已启用且存在兼容模型的供应商", () => {
  const config = previewConfig({
    agentConnections: {
      codex: {
        boundTargetIds: ["open.bigmodel.cn-api-paas-v4", "disabled"],
        defaultTargetId: "open.bigmodel.cn-api-paas-v4",
        cliSyncEnabled: true,
      },
    },
    targets: [
      {
        id: "open.bigmodel.cn-api-paas-v4",
        name: "bigmodel",
        enabled: true,
        // 使用非官方 URL，避免智谱中国区预设的 chat-only 能力影响本测试的 Codex Responses 判定。
        openaiUrl: "https://relay.example/v1",
        supportedModels: ["gpt-5.6"],
        supportedModelScopes: {"gpt-5.6": ["codex"]},
      },
      {
        id: "disabled",
        name: "停用供应商",
        enabled: false,
        openaiUrl: "https://relay.example/v1",
        supportedModels: ["gpt-5.6"],
        supportedModelScopes: {"gpt-5.6": ["codex"]},
      },
      {
        id: "unbound",
        name: "未绑定供应商",
        enabled: true,
        openaiUrl: "https://relay.example/v1",
        supportedModels: ["gpt-5.6"],
        supportedModelScopes: {"gpt-5.6": ["codex"]},
      },
      {
        id: "no-model",
        name: "无兼容模型",
        enabled: true,
        anthropicUrl: "https://relay.example/anthropic",
        supportedModels: ["claude-sonnet"],
        supportedModelScopes: {"claude-sonnet": ["claude"]},
      },
    ],
  });

  expect(boundCompatibleTargetsForAgent(config, "codex").map(target => target.id))
    .toEqual(["open.bigmodel.cn-api-paas-v4"]);
});

test("订阅目标不要求系统密钥即可支持 Agent，预览省略 AUTH_TOKEN", () => {
  const sub: ProxyTarget = {
    id: "anthropic-sub",
    name: "Claude 订阅",
    billingChannel: "subscription",
    enabled: true,
    anthropicUrl: "https://api.anthropic.com",
    supportedModels: ["claude-sonnet-4-5"],
    supportedModelScopes: {"claude-sonnet-4-5": ["claude"]},
    development: {defaultModels: {claude: "claude-sonnet-4-5"}},
  };
  const config: ProxyConfig = {
    version: 3,
    revision: 1,
    agentConnections: {claude: {defaultTargetId: sub.id, cliSyncEnabled: true}},
    targets: [sub],
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };

  expect(targetSupportsAgent(sub, "claude", [], {requireEnabled: false})).toBe(true);
  const preview = buildClaudeSettingsPreview(config, sub);
  const env = preview.env as Record<string, string>;
  expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3211/claude");
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});

test("模型下拉按 wire API 兼容性过滤：Chat 模型不提供给只支持 Responses 的 Codex", () => {
  const target: ProxyTarget = {
    id: "opencode.go",
    name: "OpenCode Go",
    enabled: true,
    openaiUrl: "https://opencode.ai/zen/go/v1",
    anthropicUrl: "https://opencode.ai/zen/go/v1",
    supportedModels: ["grok-4.5", "glm-5.3", "minimax-m3"],
    supportedModelScopes: {
      "grok-4.5": ["codex", "opencode"],
      "glm-5.3": ["opencode", "dsh"],
      "minimax-m3": ["claude", "opencode"],
    },
    supportedModelWireApis: {
      "grok-4.5": ["responses"],
      "glm-5.3": ["chat_completions"],
      "minimax-m3": ["messages"],
    },
  };
  expect(agentCompatibleModelsForTarget(target, "codex")).toEqual(["grok-4.5"]);
  expect(agentCompatibleModelsForTarget(target, "opencode")).toEqual(["grok-4.5", "glm-5.3", "minimax-m3"]);
  expect(agentCompatibleModelsForTarget(target, "claude")).toEqual(["minimax-m3"]);

  // 未声明 wire API 的自定义目标（URL 不匹配任何预设）按 URL + 模型家族推断：
  // grok-4.5 非 gpt 家族 → chat + messages，与只支持 Responses 的 Codex 无交集。
  const custom: ProxyTarget = {...target, openaiUrl: "https://relay.example/v1", anthropicUrl: "https://relay.example/anthropic", supportedModelWireApis: undefined};
  expect(agentCompatibleModelsForTarget(custom, "codex")).toEqual([]);
  expect(agentCompatibleModelsForTarget(custom, "opencode")).toEqual(["grok-4.5", "glm-5.3", "minimax-m3"]);
  expect(agentCompatibleModelsForTarget(custom, "dsh")).toEqual(["glm-5.3"]);
});

test("servedAgentsForTarget 只返回协议+归属模型+归属密钥齐备的 Agent，且不要求目标启用", () => {
  const target: ProxyTarget = {
    id: "opencode.go",
    name: "OpenCode Go",
    enabled: false,
    openaiUrl: "https://opencode.ai/zen/go/v1",
    anthropicUrl: "https://opencode.ai/zen/go/v1",
    supportedModels: ["grok-4.5", "glm-5.3", "minimax-m3"],
    supportedModelScopes: {
      "grok-4.5": ["codex", "opencode"],
      "glm-5.3": ["opencode", "dsh"],
      "minimax-m3": ["claude", "opencode"],
    },
    supportedModelWireApis: {
      "grok-4.5": ["responses"],
      "glm-5.3": ["chat_completions"],
      "minimax-m3": ["messages"],
    },
  };
  const credentials = [{id: "cred-1", targetId: "opencode.go", agentScope: ["codex", "claude", "opencode", "dsh"]}];
  // 停用不影响「归属选项可用」判定，与 Agent 接入页签的启用判断区分开。
  expect(servedAgentsForTarget(target, credentials)).toEqual(["codex", "claude", "opencode", "dsh"]);

  // 唯一密钥勾掉 Claude Code 目标后，Claude 不再被服务：模型/密钥归属选项必须联动消失。
  const afterDrop = [{id: "cred-1", targetId: "opencode.go", agentScope: ["codex", "opencode", "dsh"]}];
  expect(servedAgentsForTarget(target, afterDrop)).not.toContain("claude");
  expect(servedAgentsForTarget(target, afterDrop)).toEqual(["codex", "opencode", "dsh"]);

  // 没有任何密钥时没有任何 Agent 被服务（官方预设创建时的模型归属不构成服务能力）。
  expect(servedAgentsForTarget(target, [])).toEqual([]);
});

test("buildAgentDropPatch 从模型归属与 Agent 级默认链联动移除指定 Agent", () => {
  const target: ProxyTarget = {
    id: "opencode.go",
    name: "OpenCode Go",
    enabled: true,
    openaiUrl: "https://opencode.ai/zen/go/v1",
    anthropicUrl: "https://opencode.ai/zen/go/v1",
    supportedModels: ["grok-4.5", "glm-5.3", "minimax-m3"],
    supportedModelScopes: {
      "grok-4.5": ["codex", "opencode"],
      "glm-5.3": ["opencode", "dsh"],
      "minimax-m3": ["claude", "opencode"],
    },
    development: {
      lastProjectDir: "/tmp/proj",
      defaultModels: {codex: "grok-4.5", claude: "minimax-m3"},
      defaultCredentials: {codex: "cred-1", claude: "cred-1"},
    },
  };
  const patch = buildAgentDropPatch(target, ["claude"]);
  expect(patch).toBeDefined();
  // 模型归属：claude 从各模型移除；只剩 claude 的归属条目整条删除。
  expect(patch?.supportedModelScopes?.["minimax-m3"]).toEqual(["opencode"]);
  expect(patch?.supportedModelScopes?.["grok-4.5"]).toEqual(["codex", "opencode"]);
  expect(patch?.supportedModelScopes?.["glm-5.3"]).toEqual(["opencode", "dsh"]);
  // 默认链：defaultModels / defaultCredentials 中 claude 引用清除，其它 Agent 保留。
  expect(patch?.development?.defaultModels?.claude).toBeUndefined();
  expect(patch?.development?.defaultCredentials?.claude).toBeUndefined();
  expect(patch?.development?.defaultModels?.codex).toBe("grok-4.5");
  expect(patch?.development?.lastProjectDir).toBe("/tmp/proj");

  // 无任何字段受影响时返回 undefined，调用方不产生空补丁。
  expect(buildAgentDropPatch(target, [])).toBeUndefined();
  const untouched = buildAgentDropPatch({...target, supportedModelScopes: undefined, development: undefined}, ["opencode"]);
  expect(untouched).toBeUndefined();
});
