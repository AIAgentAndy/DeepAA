import {buildGatewayModelId} from "@/proxy/gateway-prefix";
import {agentLabel as registryAgentLabel} from "@/lib/agent-registry";
import {availableWireApisForAgent} from "@/lib/provider-preset-capabilities";
import {resolveTargetModelWireApis} from "@/lib/proxy-management-domain";
import {
  GATEWAY_PLACEHOLDER_TOKEN,
  assertNoRealSecrets,
} from "@/lib/config-sync/core/placeholder-auth";
import {
  defaultModelOf,
  resolveSyncDefaultTarget,
} from "@/lib/config-sync/core/target-eligibility";
import {hasSubscriptionPresetRoute} from "@/lib/config-sync/core/subscription-route";
import {explicitlyDisconnected, modelAllowedForAgent, preservePlan} from "@/lib/config-sync/adapters/common";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import type {
  AgentCliConfigAdapter,
  AgentCliPlan,
  AgentCliPreview,
  CliConfigFileSpec,
  CliFileArtifact,
  CliResolvedPaths,
  CliSyncContext,
  CliSyncWarning,
} from "@/lib/config-sync/core/types";
import type {ProxyConfig, ProxyTarget} from "@/types";

export interface ClaudeUserArtifacts {
  active: boolean;
  settings: Record<string, unknown>;
  warnings: CliSyncWarning[];
}

const CLAUDE_USER_SPEC: CliConfigFileSpec = {
  id: "claude-user",
  kind: "json",
  managedNamespaces: [
    "env.ANTHROPIC_BASE_URL",
    "env.ANTHROPIC_AUTH_TOKEN",
    "env.ANTHROPIC_MODEL",
    "env.ANTHROPIC_SMALL_FAST_MODEL",
    "env.ANTHROPIC_DEFAULT_*_MODEL",
    "model",
  ],
  description: "Claude Code 用户级 settings.json 受管键",
};

const CLAUDE_PROJECT_SPEC: CliConfigFileSpec = {
  id: "claude-project",
  kind: "json",
  managedNamespaces: ["model"],
  description: "Claude Code 项目级 settings.json 受管键",
};

const MANAGED_CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

/**
 * Claude 适配器：用户级与项目级 settings 的 env/model 受管键。
 * 未接入 / 关闭同步 / 默认链不完整时输出显式清理层，删除旧受管键。
 */
export const claudeCliConfigAdapter: AgentCliConfigAdapter = {
  agent: "claude",
  files: [CLAUDE_USER_SPEC, CLAUDE_PROJECT_SPEC],

  resolvePaths(context: CliSyncContext): CliResolvedPaths {
    const filePaths: Record<string, string> = {
      [CLAUDE_USER_SPEC.id]: context.paths.claudeUserSettingsPath,
    };
    for (const [projectDir, settingsPath] of Object.entries(context.paths.claudeProjectSettingsPaths)) {
      filePaths[`${CLAUDE_PROJECT_SPEC.id}:${projectDir}`] = settingsPath;
    }
    return {filePaths};
  },

  build(context: CliSyncContext, paths: CliResolvedPaths): AgentCliPlan {
    const artifacts = buildClaudeUserSettings(context.config, context.paths, {claudeCliLoggedIn: context.cliLogin?.claude === true});
    // 已接入且开启同步但链路瞬时不合格：跳过写入保留现状，绝不输出清理层。
    if (!artifacts.active && !explicitlyDisconnected(context.config, "claude")) {
      return preservePlan("claude", artifacts.warnings);
    }
    const artifactsList: CliFileArtifact[] = [
      {
        specId: CLAUDE_USER_SPEC.id,
        path: paths.filePaths[CLAUDE_USER_SPEC.id]!,
        kind: "json",
        active: artifacts.active,
        content: `${JSON.stringify(artifacts.settings, null, 2)}`,
      },
    ];
    const defaultTarget = context.config.targets.find(item =>
      item.id === context.config.agentConnections.claude?.defaultTargetId
      && item.enabled && item.anthropicUrl);
    for (const [projectDir, settingsPath] of Object.entries(context.paths.claudeProjectSettingsPaths)) {
      artifactsList.push({
        specId: CLAUDE_PROJECT_SPEC.id,
        path: settingsPath,
        kind: "json",
        active: artifacts.active,
        content: `${JSON.stringify(
          defaultTarget && artifacts.active
            ? buildClaudeProjectSettings(defaultTarget)
            : {model: null},
          null,
          2,
        )}`,
        note: `项目 ${projectDir}`,
      });
    }
    return {
      agent: "claude",
      active: artifacts.active,
      artifacts: artifactsList,
      warnings: artifacts.warnings,
    };
  },

  mergeFile(input: {
    file: CliConfigFileSpec;
    existingRaw: string | undefined;
    artifact: CliFileArtifact;
  }): string {
    const generated = JSON.parse(input.artifact.content) as Record<string, unknown>;
    const merged = mergeJsonSettings(input.existingRaw, generated);
    return `${JSON.stringify(merged, null, 2)}\n`;
  },

  validate(plan: AgentCliPlan): void {
    for (const artifact of plan.artifacts) {
      assertNoRealSecrets(artifact.content, `Claude ${artifact.specId}`);
      const parsed = JSON.parse(artifact.content) as Record<string, unknown>;
      if (artifact.specId === CLAUDE_USER_SPEC.id) {
        const env = asRecord(parsed.env);
        for (const key of Object.keys(env)) {
          if (key.startsWith("ANTHROPIC_") && !MANAGED_CLAUDE_ENV_KEYS.includes(key as (typeof MANAGED_CLAUDE_ENV_KEYS)[number])) {
            throw new Error(`CLAUDE_PLAN_INVALID: 未受管 env 键 ${key}`);
          }
        }
      }
    }
  },

  describe(plan: AgentCliPlan): AgentCliPreview {
    return {
      agent: plan.agent,
      active: plan.active,
      files: plan.artifacts.map(artifact => ({
        specId: artifact.specId,
        path: artifact.path,
        kind: artifact.kind,
        active: artifact.active,
        bytes: Buffer.byteLength(artifact.content),
        note: artifact.note,
      })),
      warnings: plan.warnings,
      notes: plan.notes || [],
    };
  },
};

/** 生成 Claude Code 用户级 settings；无有效连接时返回显式清理层。 */
export function buildClaudeUserSettings(
  config: ProxyConfig,
  paths: {gatewayBaseUrl?: string; gatewayBearerToken?: string},
  options?: {claudeCliLoggedIn?: boolean},
): ClaudeUserArtifacts {
  const warnings: CliSyncWarning[] = [];
  const connection = config.agentConnections.claude;
  const active = resolveSyncDefaultTarget(config, "claude", warnings, registryAgentLabel);
  if (!connection || !connection.cliSyncEnabled || !active) {
    return {active: false, settings: {env: {}, model: null}, warnings};
  }

  const gatewayBaseUrl = resolveGatewayBaseUrl(paths.gatewayBaseUrl);
  // 模型列表与默认链统一走 wire 校验（2026-10-06 门禁补全）：Claude Code 仅
  // messages 协议，默认模型不兼容时回退首个兼容模型并出 warning（与别名校验同口径）。
  const models = active.supportedModels.filter(model =>
    modelAllowedForAgent(active, model, "claude") && claudeModelWireApiCompatible(active, model));
  const configuredDefault = defaultModelOf(active, "claude")!;
  const defaultModel = claudeModelWireApiCompatible(active, configuredDefault)
    ? configuredDefault
    : (models[0] ?? configuredDefault);
  if (defaultModel !== configuredDefault && models.length > 0) {
    warnings.push({
      targetId: active.id,
      code: "MODEL_WIRE_API_UNSUPPORTED",
      message: `${active.name} 的默认模型不支持 Claude（messages）协议，已回退 ${models[0]}`,
    });
  }
  const mainModel = buildGatewayModelId(active.id, defaultModel);
  const aliases = connection.modelAliases;
  const aliasModel = (value: string | undefined): string | undefined =>
    value && isKnownPrefixedModel(config, value, "claude") ? value : undefined;
  const defaultAliasModel = aliasModel(aliases?.opus)
    || aliasModel(aliases?.sonnet)
    || aliasModel(aliases?.haiku)
    || mainModel;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${gatewayBaseUrl}/claude`,
    ANTHROPIC_MODEL: mainModel,
    ANTHROPIC_SMALL_FAST_MODEL: buildGatewayModelId(active.id, models.at(-1) || defaultModel),
    ANTHROPIC_DEFAULT_OPUS_MODEL: aliasModel(aliases?.opus) || defaultAliasModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: aliasModel(aliases?.sonnet) || defaultAliasModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: aliasModel(aliases?.haiku) || defaultAliasModel,
  };
  // 订阅路由透传判据（2026-10-08 用户确认，取代「默认目标必须是订阅」）：
  // 存在 anthropic-subscription 预设路由目标（含别名可指向的启用目标）+ 本机
  // Claude 已登录 → 省略占位 token，Claude Code 携带本机 OAuth；默认目标可为
  // 任意供应商，其中转模型由网关 inject 无条件替换凭据。未登录时写占位 token，
  // 误选订阅模型由网关 passthrough 防御给出 SUBSCRIPTION_LOGIN_REQUIRED 明确报错。
  const subscriptionRouteReady = hasSubscriptionPresetRoute(config, "anthropic-subscription")
    && options?.claudeCliLoggedIn === true;
  if (!subscriptionRouteReady) {
    env.ANTHROPIC_AUTH_TOKEN = paths.gatewayBearerToken || GATEWAY_PLACEHOLDER_TOKEN;
  }
  return {active: true, settings: {env, model: mainModel}, warnings};
}

/** 项目级 settings 只覆盖已显式配置的 Claude 默认模型。 */
export function buildClaudeProjectSettings(target: ProxyTarget): Record<string, unknown> {
  const model = defaultModelOf(target, "claude");
  return model ? {model: buildGatewayModelId(target.id, model)} : {model: null};
}

function mergeJsonSettings(existingRaw: string | undefined, generated: Record<string, unknown>): Record<string, unknown> {
  const existing = existingRaw?.trim()
    ? JSON.parse(existingRaw) as Record<string, unknown>
    : {};
  const generatedEnv = asRecord(generated.env);
  const existingEnv = asRecord(existing.env);
  if (generatedEnv) {
    // 受管 env key 先清空再合并，保证停用供应商后旧的模型 env 不残留。
    for (const key of MANAGED_CLAUDE_ENV_KEYS) delete existingEnv[key];
    existing.env = {...existingEnv, ...generatedEnv};
  }
  if (generated.model === null) {
    delete existing.model;
  } else if (generated.model !== undefined) {
    existing.model = generated.model;
  }
  return existing;
}

function isKnownPrefixedModel(config: ProxyConfig, value: string, agent: "claude"): boolean {
  return config.targets.some(target =>
    target.enabled
    && target.supportedModels.some(model =>
      modelAllowedForAgent(target, model, agent)
      && buildGatewayModelId(target.id, model) === value
      && claudeModelWireApiCompatible(target, model)));
}

/** 别名模型必须与 Claude binding 存在 wire API 交集，与保存校验一致；无效别名回退默认链。 */
function claudeModelWireApiCompatible(target: ProxyTarget, modelId: string): boolean {
  const bindingWireApis = availableWireApisForAgent(target, "claude");
  if (bindingWireApis.length === 0) return false;
  const modelWireApis = resolveTargetModelWireApis(target, modelId);
  return modelWireApis.length > 0 && modelWireApis.some(wireApi => bindingWireApis.includes(wireApi));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type {CliSyncWarning};
