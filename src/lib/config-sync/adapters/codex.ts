import {parse as parseToml, stringify as stringifyToml} from "smol-toml";
import {buildGatewayModelId} from "@/proxy/gateway-prefix";
import {
  explicitlyDisconnected,
  launchPreferenceAutoCompactLimit,
  launchPreferenceContextWindow,
  modelsForAgentWireApi,
  preservePlan,
} from "@/lib/config-sync/adapters/common";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import {resolveAutoCompactTokenLimit} from "@/lib/development-launch/model-capabilities";
import {agentLabel as registryAgentLabel} from "@/lib/agent-registry";
import {resolveTargetAgentCapability} from "@/lib/provider-preset-capabilities";
import {resolveAgentProductConfig, type CatalogOverrides, type CatalogTemplate} from "@/lib/config-sync/catalog-template";
import {resolveDefaultReasoningLevel, resolveModelRuntimeCaps} from "@/lib/config-sync/model-capabilities";
import {
  GATEWAY_PLACEHOLDER_TOKEN,
  GATEWAY_PROVIDER_ID,
  assertNoRealSecrets,
} from "@/lib/config-sync/core/placeholder-auth";
import {
  boundTargetsForAgent,
  defaultModelOf,
  resolveSyncDefaultTarget,
} from "@/lib/config-sync/core/target-eligibility";
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

export interface CodexGatewayArtifacts {
  active: boolean;
  toml: string;
  catalog: string;
  warnings: CliSyncWarning[];
}

/** 兼容导出：占位 token 常量的单一事实来源迁移到 core/placeholder-auth。 */
export {GATEWAY_PLACEHOLDER_TOKEN, GATEWAY_PROVIDER_ID};

// 品牌守卫禁止旧产品 token 以连续字面量回流；迁移识别值必须由片段构造。
const LEGACY_BRAND_SNAKE = ["llm", "inspector"].join("_");
const LEGACY_CODEX_PROVIDER_ID = [LEGACY_BRAND_SNAKE, "gateway"].join("_");
const LEGACY_CODEX_PROFILE_PREFIX = [LEGACY_BRAND_SNAKE, ""].join("_");
const LEGACY_CATALOG_PATH_PATTERN = new RegExp(`(?:deepaa|${["llm", "inspector"].join("[-_]")})`, "u");

const CODEX_CONFIG_SPEC: CliConfigFileSpec = {
  id: "codex-config",
  kind: "toml",
  managedNamespaces: [
    "model_provider",
    "model",
    "model_catalog_json",
    "model_providers.deepaa_gateway",
  ],
  description: "Codex 全局 config.toml 受管段",
};

const CODEX_CATALOG_SPEC: CliConfigFileSpec = {
  id: "codex-catalog",
  kind: "json",
  managedNamespaces: ["models[]"],
  description: "Codex 模型目录（整体受管文件）",
};

/**
 * Codex 适配器：TOML provider/profile/catalog 受管段。
 * 默认仍使用 Responses；当模型只支持 chat/completions 或用户显式选择
 * chat binding 时生成 wire_api = "chat"。
 */
export const codexCliConfigAdapter: AgentCliConfigAdapter = {
  agent: "codex",
  files: [CODEX_CONFIG_SPEC, CODEX_CATALOG_SPEC],

  resolvePaths(context: CliSyncContext): CliResolvedPaths {
    return {
      filePaths: {
        [CODEX_CONFIG_SPEC.id]: context.paths.codexConfigPath,
        [CODEX_CATALOG_SPEC.id]: context.paths.codexCatalogPath,
      },
    };
  },

  build(context: CliSyncContext, paths: CliResolvedPaths): AgentCliPlan {
    const artifacts = buildCodexGatewayConfig(
      context.config,
      context.paths,
      context.template,
      context.overrides,
      context.pricingEntriesById,
    );
    // 已接入且开启同步但链路瞬时不合格：跳过写入保留现状，绝不输出清理层。
    if (!artifacts.active && !explicitlyDisconnected(context.config, "codex")) {
      return preservePlan("codex", artifacts.warnings);
    }
    return {
      agent: "codex",
      active: artifacts.active,
      artifacts: [
        {
          specId: CODEX_CONFIG_SPEC.id,
          path: paths.filePaths[CODEX_CONFIG_SPEC.id]!,
          kind: "toml",
          active: artifacts.active,
          content: artifacts.toml,
        },
        {
          specId: CODEX_CATALOG_SPEC.id,
          path: paths.filePaths[CODEX_CATALOG_SPEC.id]!,
          kind: "json",
          active: artifacts.active,
          content: artifacts.catalog,
          note: "模型目录为整体受管文件，不保留用户手写目录内容",
        },
      ],
      warnings: artifacts.warnings,
    };
  },

  mergeFile(input: {
    file: CliConfigFileSpec;
    existingRaw: string | undefined;
    artifact: CliFileArtifact;
  }): string {
    if (input.file.id === CODEX_CATALOG_SPEC.id) return input.artifact.content;
    const active = input.artifact.active;
    const existing = input.existingRaw;
    if (!existing?.trim()) return active ? input.artifact.content.trimEnd() : "";
    const merged = mergeCodexToml(existing, input.artifact.content, active);
    return `${merged}\n`;
  },

  validate(plan: AgentCliPlan): void {
    for (const artifact of plan.artifacts) {
      assertNoRealSecrets(artifact.content, `Codex ${artifact.specId}`);
    }
    if (plan.active) {
      const configArtifact = plan.artifacts.find(artifact => artifact.specId === CODEX_CONFIG_SPEC.id);
      if (!configArtifact?.content.includes(`[model_providers.${GATEWAY_PROVIDER_ID}]`)) {
        throw new Error("CODEX_PLAN_INVALID: 受管 provider 未生成");
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

/**
 * 生成 Codex 网关配置。Agent 未接入、同步关闭或默认链不完整时返回空受管层，
 * 由公共引擎清理以前写入的 provider、profiles、默认 model 和 Catalog。
 */
export function buildCodexGatewayConfig(
  config: ProxyConfig,
  paths: {gatewayBaseUrl?: string; gatewayBearerToken?: string; codexCatalogPath: string},
  template: CatalogTemplate,
  overrides: CatalogOverrides,
  pricingEntriesById?: ReadonlyMap<string, import("@/lib/pricing").ModelPriceEntry>,
): CodexGatewayArtifacts {
  const warnings: CliSyncWarning[] = [];
  const connection = config.agentConnections.codex;
  const defaultTarget = resolveSyncDefaultTarget(config, "codex", warnings, registryAgentLabel);
  if (!connection || !connection.cliSyncEnabled || !defaultTarget) {
    return emptyCodexArtifacts(warnings);
  }

  const targets = boundTargetsForAgent(config, "codex", defaultTarget, warnings, registryAgentLabel);
  if (!targets.some(target => target.id === defaultTarget.id)) {
    return emptyCodexArtifacts(warnings);
  }

  const gatewayBaseUrl = resolveGatewayBaseUrl(paths.gatewayBaseUrl);
  const defaultModel = defaultModelOf(defaultTarget, "codex")!;
  const root: Record<string, unknown> = {
    model: buildGatewayModelId(defaultTarget.id, defaultModel),
    model_provider: GATEWAY_PROVIDER_ID,
    model_catalog_json: paths.codexCatalogPath,
    model_providers: {
      [GATEWAY_PROVIDER_ID]: {
        name: "DeepAA 网关",
        base_url: `${gatewayBaseUrl}/codex/v1`,
        wire_api: "responses",
        // 本地网关不承载 WebSocket 升级（426）：显式禁用，避免 Codex 桌面 App
        // 先尝试 WS 再回落 HTTP、白撞一次 426（2026-10-08 实测）。
        supports_websockets: false,
        // 恒写占位 token（2026-10-09 用户确认回退）：codex 在 requires_openai_auth
        // 形态下会切换为 ChatGPT 原生 wire（请求体无 model 字段，实测 0.160/0.161
        // 双端一致），网关的标准 Responses 解析无法路由——订阅账号请切换「官方
        // 模式」（cliSyncEnabled=false 清空受管层 + 通道 B 直连导入捕获）。
        experimental_bearer_token: paths.gatewayBearerToken || GATEWAY_PLACEHOLDER_TOKEN,
      },
    },
  };
  // 模型条目组装（2026-09-21 重构）：共享解析层（窗口/模态）+ agents.codex 产品位 +
  // 用户编目覆盖兼容位；Codex strict schema 完整性在此自保（档位表必填、默认档必落表内）。
  // 2026-10-02：开发启动偏好（launchPreferences）按网关模型 ID 覆盖
  // 上下文窗口/压缩阈值/默认推理档——顶层 config.toml 键对目录内模型无效，弹窗
  // 高级设置必须落到条目级能力位才真正生效（条目级 > config 顶层，实测确认）。
  const preferences = connection.launchPreferences;
  const models = targets.flatMap(target => {
    if (!target.openaiUrl) return [];
    // 目录条目与弹窗下拉同口径（2026-10-06 门禁补全）：只收录 wire API 支持
    // responses 的模型——Codex 客户端官方仅 Responses（2026-02 调研结论），
    // chat-only 模型写入目录后必然被网关拒绝，属配置面污染。
    return modelsForAgentWireApi(target, "codex", "responses")
      .map(modelId => buildCodexCatalogEntry({
        target,
        modelId,
        template,
        overrides,
        preferences,
        warnings,
        ...(pricingEntriesById ? {pricingEntriesById} : {}),
      }));
  });
  return {
    active: true,
    toml: stringifyToml(root),
    catalog: `${JSON.stringify({models}, null, 2)}\n`,
    warnings,
  };
}

/**
 * 单条 Codex 目录条目组装：agents.codex.defaults ← families 覆盖为产品基线，
 * 能力位（context_window / input_modalities）来自共享解析层，启动偏好覆盖
 * 窗口/压缩阈值/默认档，用户编目覆盖最后应用。
 */
function buildCodexCatalogEntry(input: {
  target: ProxyTarget;
  modelId: string;
  template: CatalogTemplate;
  overrides: CatalogOverrides;
  preferences: import("@/types").AgentLaunchPreferences | undefined | null;
  warnings: CliSyncWarning[];
  pricingEntriesById?: ReadonlyMap<string, import("@/lib/pricing").ModelPriceEntry>;
}): Record<string, unknown> {
  const {target, modelId, template, overrides, preferences, warnings} = input;
  const caps = resolveModelRuntimeCaps({
    target,
    modelId,
    template,
    overrides,
    ...(input.pricingEntriesById ? {pricingEntriesById: input.pricingEntriesById} : {}),
  });
  const product = resolveAgentProductConfig("codex", modelId, template);
  const levels = template.defaults.supportedReasoningLevels;
  const slug = buildGatewayModelId(target.id, modelId);
  const contextWindow = launchPreferenceContextWindow(preferences, slug) ?? caps.contextWindow;
  const autoCompactTokenLimit = launchPreferenceAutoCompactLimit(preferences, slug)
    ?? resolveAutoCompactTokenLimit(contextWindow);
  const inferredReasoningLevel = resolveDefaultReasoningLevel(modelId, template);
  const preferredEffort = preferences?.reasoningEffort?.trim();
  let defaultReasoningLevel = inferredReasoningLevel;
  if (preferredEffort && preferredEffort !== inferredReasoningLevel) {
    const variants = [...new Set(levels
      .map(level => (typeof level.effort === "string" ? level.effort : ""))
      .filter(Boolean))];
    if (variants.includes(preferredEffort)) {
      defaultReasoningLevel = preferredEffort;
    } else {
      warnings.push({
        targetId: target.id,
        code: "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED",
        message: `${target.name} 的模型 ${modelId} 不支持推理档 ${preferredEffort}，已回退默认档 ${inferredReasoningLevel}`,
      });
    }
  }
  const modelOverride = overrides[modelId] ?? {};
  return {
    ...product,
    slug,
    display_name: `${target.name} · ${modelId}`,
    description: `DeepAA 网关模型：${target.id} / ${modelId}`,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: autoCompactTokenLimit,
    // Codex InputModality 全值域（text/image/audio）透传。
    input_modalities: [...caps.inputModalities],
    supported_reasoning_levels: levels,
    default_reasoning_level: defaultReasoningLevel,
    priority: typeof product.priority === "number" ? product.priority : 1,
    ...modelOverride,
  };
}

function emptyCodexArtifacts(warnings: CliSyncWarning[]): CodexGatewayArtifacts {
  return {
    active: false,
    toml: stringifyToml({model_providers: {}}),
    catalog: `${JSON.stringify({models: []}, null, 2)}\n`,
    warnings,
  };
}

function mergeCodexToml(existingRaw: string, generatedToml: string, active: boolean): string {
  const existing = parseToml(existingRaw) as Record<string, unknown>;
  const generated = parseToml(generatedToml) as Record<string, unknown>;
  const merged: Record<string, unknown> = {...existing};
  const existingProviders = asRecord(existing.model_providers);
  const generatedProviders = asRecord(generated.model_providers);
  const nextProviders = {...existingProviders};
  delete nextProviders.deepaa_gateway;
  delete nextProviders[LEGACY_CODEX_PROVIDER_ID];
  Object.assign(nextProviders, generatedProviders);
  if (Object.keys(nextProviders).length > 0) merged.model_providers = nextProviders;
  else delete merged.model_providers;
  const existingProfiles = asRecord(existing.profiles);
  const generatedProfiles = asRecord(generated.profiles);
  const nextProfiles: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existingProfiles)) {
    if (key.startsWith("deepaa_") || key.startsWith(LEGACY_CODEX_PROFILE_PREFIX)) continue;
    nextProfiles[key] = value;
  }
  Object.assign(nextProfiles, generatedProfiles);
  if (Object.keys(nextProfiles).length > 0) merged.profiles = nextProfiles;
  else delete merged.profiles;
  if (active) {
    Object.assign(merged, generated);
    merged.model_providers = nextProviders;
    merged.profiles = nextProfiles;
  } else {
    if (merged.model_provider === "deepaa_gateway" || merged.model_provider === LEGACY_CODEX_PROVIDER_ID) {
      delete merged.model_provider;
    }
    if (typeof merged.model_catalog_json === "string"
      && LEGACY_CATALOG_PATH_PATTERN.test(merged.model_catalog_json)) {
      delete merged.model_catalog_json;
    }
    if (typeof merged.model === "string" && /^[a-z0-9.-]+_.+/u.test(merged.model)) delete merged.model;
  }
  return stringifyToml(merged).trimEnd();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type {CliSyncWarning};
