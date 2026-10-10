import {existsSync} from "node:fs";
import {posix, win32} from "node:path";
import {
  applyEdits,
  modify,
  parse,
} from "jsonc-parser";
import {buildGatewayModelId, parseGatewayModelId} from "@/proxy/gateway-prefix";
import {resolveModelRuntimeCaps} from "@/lib/config-sync/model-capabilities";
import {
  OPENCODE_PROVIDERS,
  OPENCODE_PROVIDER_PREFIX,
  assertNoRealSecrets,
} from "@/lib/config-sync/core/placeholder-auth";
import {GATEWAY_PROVIDER_DISPLAY_NAMES} from "@/lib/config-sync/core/gateway-provider-names";
import {
  boundTargetsForAgent,
  defaultModelOf,
  resolveSyncDefaultTarget,
} from "@/lib/config-sync/core/target-eligibility";
import {
  agentLabelOf,
  launchPreferenceContextWindow,
  modelWireApisForTarget,
  modelsForAgentWireApi,
  preferredWireApi,
  preservePlan,
} from "@/lib/config-sync/adapters/common";
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
import type {WireApi} from "@/types";

const OPENCODE_GLOBAL_SPEC: CliConfigFileSpec = {
  id: "opencode-global",
  kind: "jsonc",
  managedNamespaces: [
    `provider.${OPENCODE_PROVIDER_PREFIX}-*`,
    "model",
    "small_model",
  ],
  description: "OpenCode 全局配置（opencode.jsonc）受管 provider 与默认模型",
};

const OPENCODE_NPM: Record<WireApi, string> = {
  responses: "@ai-sdk/openai",
  chat_completions: "@ai-sdk/openai-compatible",
  messages: "@ai-sdk/anthropic",
};

const WIRE_API_ORDER: readonly WireApi[] = ["responses", "chat_completions", "messages"];
const LEGACY_BRAND_KEBAB = ["llm", "inspector"].join("-");
const LEGACY_OPENCODE_PROVIDER_PREFIX = `opencode-${LEGACY_BRAND_KEBAB}-gateway`;

/**
 * OpenCode 适配器：XDG / OPENCODE_CONFIG* 路径、JSONC 深合并、三个受管
 * provider（responses / chat_completions / messages）、静态模型列表。
 * 受管 provider ID 统一带 opencode-deepaa-gateway 前缀，确保最新
 * OpenCode 发送 x-opencode-session / x-opencode-request 身份头。
 */
export const opencodeCliConfigAdapter: AgentCliConfigAdapter = {
  agent: "opencode",
  files: [OPENCODE_GLOBAL_SPEC],

  resolvePaths(context: CliSyncContext): CliResolvedPaths {
    return {
      filePaths: {
        [OPENCODE_GLOBAL_SPEC.id]: resolveOpenCodeConfigPath(context),
      },
    };
  },

  build(context: CliSyncContext, paths: CliResolvedPaths): AgentCliPlan {
    const warnings: CliSyncWarning[] = [];
    const connection = context.config.agentConnections.opencode;
    const defaultTarget = resolveSyncDefaultTarget(context.config, "opencode", warnings, agentLabelOf);
    if (!connection || !connection.cliSyncEnabled) {
      return inactivePlan(paths, warnings);
    }
    if (!defaultTarget) {
      return preservePlan("opencode", warnings);
    }
    const targets = boundTargetsForAgent(context.config, "opencode", defaultTarget, warnings, agentLabelOf);
    if (!targets.some(target => target.id === defaultTarget.id)) {
      return preservePlan("opencode", warnings);
    }

    const providerModels: Record<WireApi, Record<string, Record<string, unknown>>> = {
      responses: {},
      chat_completions: {},
      messages: {},
    };
    const preferences = context.config.agentConnections.opencode?.launchPreferences;
    for (const target of targets) {
      for (const wireApi of WIRE_API_ORDER) {
        const models = modelsForAgentWireApi(target, "opencode", wireApi);
        for (const modelId of models) {
          // 能力下发（2026-09-21）：窗口/模态经共享解析层（价格中心 → 模板兜底 → 常量）。
          const caps = resolveModelRuntimeCaps({
            target,
            modelId,
            template: context.template,
            overrides: context.overrides,
            ...(context.pricingEntriesById ? {pricingEntriesById: context.pricingEntriesById} : {}),
          });
          const meta = openCodeModelMeta(caps, context.template);
          // 展示名组合兜底（2026-09-21）：模板不再携带模型条目，用必有的供应商名 × 模型 ID。
          meta.name = `${target.name} · ${modelId}`;
          // 开发启动偏好：按网关模型 ID（目标+模型复合键）覆盖上下文窗口（limit.context）。
          const slug = buildGatewayModelId(target.id, modelId);
          const contextWindow = launchPreferenceContextWindow(preferences, slug) ?? caps.contextWindow;
          // limit 必须同时提供 context 与 output：新版 opencode 对缺 output 的配置
          // 直接判定无效并回退到帮助页（实测 opencode 1.18.21）。统一使用 32K 兜底，
          // 避免输出预算被低估导致过早截断。
          meta.limit = {context: contextWindow, ...(asRecord(meta.limit).output !== undefined
            ? {output: asRecord(meta.limit).output}
            : {output: DEFAULT_OPENCODE_OUTPUT_LIMIT})};
          providerModels[wireApi][slug] = meta;
        }
      }
    }

    const defaultWireApi = preferredWireApi(context, "opencode", defaultTarget, WIRE_API_ORDER);
    if (!defaultWireApi || Object.keys(providerModels[defaultWireApi]).length === 0) {
      warnings.push({
        targetId: defaultTarget.id,
        code: "MODEL_WIRE_API_UNSUPPORTED",
        message: `${defaultTarget.name} 的默认模型没有任何可用 wire API，已跳过写入`,
      });
      return preservePlan("opencode", warnings);
    }

    const providers: Record<string, Record<string, unknown>> = {};
    // 开发启动偏好：默认推理强度经 provider options 透传（字段名单点隔离，便于实测后调整）。
    const reasoningEffort = context.config.agentConnections.opencode?.launchPreferences?.reasoningEffort;
    for (const wireApi of WIRE_API_ORDER) {
      const providerId = OPENCODE_PROVIDERS.find(provider => provider.endsWith(`-${openCodeProviderSuffix(wireApi)}`))!;
      providers[providerId] = {
        npm: OPENCODE_NPM[wireApi],
        name: GATEWAY_PROVIDER_DISPLAY_NAMES[wireApi],
        options: {
          baseURL: `${context.gatewayBaseUrl}/opencode/v1`,
          apiKey: context.gatewayBearerToken,
          ...(reasoningEffort ? {reasoningEffort} : {}),
        },
        models: providerModels[wireApi],
      };
    }

    const defaultPrefixedModel = buildGatewayModelId(defaultTarget.id, defaultModelOf(defaultTarget, "opencode")!);
    const defaultProviderId = OPENCODE_PROVIDERS.find(provider => provider.endsWith(`-${openCodeProviderSuffix(defaultWireApi)}`))!;
    const root: Record<string, unknown> = {
      provider: providers,
      model: `${defaultProviderId}/${defaultPrefixedModel}`,
      small_model: `${defaultProviderId}/${defaultPrefixedModel}`,
    };
    return {
      agent: "opencode",
      active: true,
      artifacts: [{
        specId: OPENCODE_GLOBAL_SPEC.id,
        path: paths.filePaths[OPENCODE_GLOBAL_SPEC.id]!,
        kind: "jsonc",
        active: true,
        content: `${JSON.stringify(root, null, 2)}\n`,
      }],
      warnings,
      notes: [
        `默认 wire API：${defaultWireApi}`,
        "OpenCode 首期不支持订阅通道，订阅供应商已排除",
      ],
    };
  },

  mergeFile(input: {
    file: CliConfigFileSpec;
    existingRaw: string | undefined;
    artifact: CliFileArtifact;
  }): string {
    const generated = JSON.parse(input.artifact.content) as Record<string, unknown>;
    return mergeOpenCodeJsonc(input.existingRaw, generated, input.artifact.active);
  },

  validate(plan: AgentCliPlan): void {
    for (const artifact of plan.artifacts) {
      assertNoRealSecrets(artifact.content, "OpenCode");
      const parsed = JSON.parse(artifact.content) as Record<string, unknown>;
      if (!artifact.active) continue;
      const providers = asRecord(parsed.provider);
      for (const [providerId, value] of Object.entries(providers)) {
        if (!providerId.startsWith(OPENCODE_PROVIDER_PREFIX)) {
          throw new Error(`OPENCODE_PLAN_INVALID: 非受管 provider ${providerId}`);
        }
        const provider = asRecord(value);
        const options = asRecord(provider.options);
        if (typeof options.baseURL !== "string" || !options.baseURL.includes("/opencode/v1")) {
          throw new Error(`OPENCODE_PLAN_INVALID: ${providerId} baseURL 不是本地网关`);
        }
        if (options.apiKey !== "deepaa-gateway") {
          throw new Error(`OPENCODE_PLAN_INVALID: ${providerId} 必须使用占位 token`);
        }
        for (const modelId of Object.keys(asRecord(provider.models))) {
          if (!parseGatewayModelId(modelId)) {
            throw new Error(`OPENCODE_PLAN_INVALID: 模型 ID 缺少合法供应商路由后缀 ${modelId}`);
          }
        }
      }
      for (const key of ["model", "small_model"] as const) {
        const value = parsed[key];
        if (!isManagedProviderReference(value)) {
          throw new Error(`OPENCODE_PLAN_INVALID: ${key} 必须指向受管 provider`);
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

/** 按设计文档 9.2/9.3 路径规则解析 OpenCode 全局配置文件。 */
export function resolveOpenCodeConfigPath(context: CliSyncContext): string {
  if (context.paths.opencodeConfigPath?.trim()) return context.paths.opencodeConfigPath;
  const explicitFile = context.env.OPENCODE_CONFIG?.trim();
  if (explicitFile) return explicitFile;
  const pathModule = context.platform === "win32" ? win32 : posix;
  const directory = context.env.OPENCODE_CONFIG_DIR?.trim()
    || (context.platform === "win32"
      ? pathModule.join(context.env.APPDATA || pathModule.join(context.homeDir, "AppData", "Roaming"), "opencode")
      : pathModule.join(context.env.XDG_CONFIG_HOME || pathModule.join(context.homeDir, ".config"), "opencode"));
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"];
  for (const name of candidates) {
    const candidate = pathModule.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return pathModule.join(directory, "opencode.jsonc");
}

function inactivePlan(paths: CliResolvedPaths, warnings: CliSyncWarning[]): AgentCliPlan {
  return {
    agent: "opencode",
    active: false,
    artifacts: [{
      specId: OPENCODE_GLOBAL_SPEC.id,
      path: paths.filePaths[OPENCODE_GLOBAL_SPEC.id]!,
      kind: "jsonc",
      active: false,
      content: "{}\n",
      note: "清理层：删除受管 provider 与默认模型引用",
    }],
    warnings,
  };
}

function openCodeModelMeta(
  caps: {inputModalities: readonly string[]},
  template: {defaults: {supportedReasoningLevels: ReadonlyArray<{effort: string}>}},
): Record<string, unknown> {
  // opencode 的 modalities.input 值域为 text/image；audio 忽略。
  const inputModalities = caps.inputModalities.filter(item => item === "text" || item === "image");
  return {
    name: "",
    status: "active",
    tool_call: true,
    temperature: true,
    reasoning: template.defaults.supportedReasoningLevels.length > 0,
    attachment: inputModalities.includes("image"),
    modalities: {
      input: inputModalities.length > 0 ? inputModalities : ["text"],
      output: ["text"],
    },
  };
}

/** OpenCode 模型 limit.output 兜底值（模板未提供最大输出 token 时的默认预算）。 */
const DEFAULT_OPENCODE_OUTPUT_LIMIT = 32_768;

/**
 * 默认推理强度透传字段名。实测 opencode 1.18.x provider options schema 支持
 * reasoningEffort；若后续版本改名，只需调整此常量。
 */
export const OPENCODE_REASONING_EFFORT_OPTION = "reasoningEffort";

/**
 * JSONC 深合并：保留用户插件、MCP、permissions、其它 provider 与注释；
 * 受管 provider 与指向受管 provider 的 model/small_model 由 jsonc-parser
 * 按路径替换，未触碰的节点格式原样保留。
 */
export function mergeOpenCodeJsonc(
  existingRaw: string | undefined,
  generated: Record<string, unknown>,
  active: boolean,
): string {
  if (!existingRaw?.trim()) {
    return active ? `${JSON.stringify(generated, null, 2)}\n` : "{}\n";
  }
  const parsed = parse(existingRaw, [], {allowTrailingComma: true});
  if (!isObject(parsed)) {
    // 既有文件不是对象（如数组）时拒绝写入，避免破坏用户配置；
    // 空文件在调用方已按“无既有内容”处理。
    throw new Error("OPENCODE_CONFIG_INVALID: 既有 opencode 配置不是 JSON 对象");
  }
  const formattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: existingRaw.includes("\r\n") ? "\r\n" : "\n",
  };
  const existingProviders = asRecord(parsed.provider);
  let next = existingRaw;
  for (const providerId of Object.keys(existingProviders)) {
    if (isDeepaaProviderId(providerId)) {
      next = applyEdits(next, modify(next, ["provider", providerId], undefined, {formattingOptions}));
    }
  }
  if (active) {
    const generatedProviders = asRecord(generated.provider);
    for (const [providerId, value] of Object.entries(generatedProviders)) {
      next = applyEdits(next, modify(next, ["provider", providerId], value, {formattingOptions}));
    }
    for (const key of ["model", "small_model"] as const) {
      next = applyEdits(next, modify(next, [key], generated[key], {formattingOptions}));
    }
  } else {
    for (const key of ["model", "small_model"] as const) {
      const value = parsed[key];
      if (isManagedProviderReference(value)) {
        next = applyEdits(next, modify(next, [key], undefined, {formattingOptions}));
      }
    }
  }
  // 删除 provider 后若受管对象为空，清掉空 provider 段。
  const nextParsed = parse(next, [], {allowTrailingComma: true});
  if (isObject(nextParsed) && isObject(nextParsed.provider) && Object.keys(nextParsed.provider).length === 0) {
    const cleanup = modify(next, ["provider"], undefined, {formattingOptions});
    next = applyEdits(next, cleanup);
  }
  return next.trim() ? (next.endsWith("\n") ? next : `${next}\n`) : "{}\n";
}

function openCodeProviderSuffix(wireApi: WireApi): string {
  if (wireApi === "responses") return "responses";
  if (wireApi === "messages") return "anthropic";
  return "chat";
}

/** model/small_model 是否指向受管 provider（provider ID 以受管前缀开头）。 */
function isManagedProviderReference(value: unknown): boolean {
  return typeof value === "string"
    && isDeepaaProviderId(value.split("/")[0] || "");
}

function isDeepaaProviderId(providerId: string): boolean {
  return providerId.startsWith(OPENCODE_PROVIDER_PREFIX)
    || providerId.startsWith(LEGACY_OPENCODE_PROVIDER_PREFIX);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type {CliSyncWarning};
