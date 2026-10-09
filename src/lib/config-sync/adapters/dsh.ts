import {posix, win32} from "node:path";
import {isMap, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml} from "yaml";
import type {ProxyTarget} from "@/types";
import {buildGatewayModelId, parseGatewayModelId} from "@/proxy/gateway-prefix";
import {resolveModelRuntimeCaps} from "@/lib/config-sync/model-capabilities";
import {resolveDshHomeDir} from "@/lib/config-sync/core/sync-context";
import {
  DSH_API_KEY_ENV,
  GATEWAY_PLACEHOLDER_TOKEN,
  assertNoRealSecrets,
} from "@/lib/config-sync/core/placeholder-auth";
import {
  boundTargetsForAgent,
  defaultModelOf,
  resolveSyncDefaultTarget,
} from "@/lib/config-sync/core/target-eligibility";
import {
  agentLabelOf,
  launchPreferenceContextWindow,
  modelsForAgentWireApi,
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

const DSH_SETTINGS_SPEC: CliConfigFileSpec = {
  id: "dsh-settings",
  kind: "yaml",
  managedNamespaces: [
    "llm-pi-ai.providers.deepaa-gateway",
    "llm-pi-ai.providers.deepaa-gateway-responses",
    "llm-pi-ai.providers.deepaa-gateway-anthropic",
    "agent-default-model",
    "permission",
  ],
  description: "DeepSeek Harness settings.yaml 的 DeepAA Provider 受管分节（dsh ≤0.1.6 布局）",
};

/**
 * dsh 0.1.7+ profile patch（$DSH_HOME/profiles/<name>/cordis.patch.yml）：顶层数组、
 * 每行 id 定向覆盖 entry config。与 dsh Web UI 设置写入同一文件同一层——UI 后续
 * 编辑会读出含本受管行的完整合并态写回，双方共存互不破坏；严禁改写 home 级
 * patch（会让 UI 编辑报 settings/rejected）。
 */
const DSH_PROFILE_PATCH_SPEC: CliConfigFileSpec = {
  id: "dsh-profile-patch",
  kind: "yaml",
  managedNamespaces: [
    "llm-pi-ai.providers.deepaa-gateway",
    "llm-pi-ai.providers.deepaa-gateway-responses",
    "llm-pi-ai.providers.deepaa-gateway-anthropic",
    "agent-default-model",
    "permission",
  ],
  description: "DeepSeek Harness profile patch（cordis.patch.yml）的 DeepAA 受管行（dsh ≥0.1.7 布局）",
};

/**
 * dsh 凭据文件（$DSH_HOME/.credentials.yaml）：只 patch 占位 token refs 键，
 * 让任意方式启动的 dsh 都能拿到非空凭据并被本地网关接管；真实密钥扫描与备份
 * 由 sync-manager 按 sensitive 标记跳过（该文件本身就是用户的密钥存储）。
 */
const DSH_CREDENTIALS_SPEC: CliConfigFileSpec = {
  id: "dsh-credentials",
  kind: "yaml",
  managedNamespaces: ["refs"],
  description: "DeepSeek Harness 凭据文件占位 token 键",
  sensitive: true,
};

/** 网关占位凭据的 refs 键名（与 DSH_API_KEY_ENV 保持一致）。 */
const DSH_GATEWAY_CREDENTIAL_KEY = "DEEPAA_GATEWAY_TOKEN";
/** 受管 Provider 路由 ID：官方 dsh 模型目录更新不会覆盖这些路由。 */
const DSH_PROVIDER_ID = "deepaa-gateway";
const DSH_PROVIDER_RESPONSES_ID = "deepaa-gateway-responses";
const DSH_PROVIDER_ANTHROPIC_ID = "deepaa-gateway-anthropic";
const DSH_MANAGED_PROVIDER_IDS: readonly string[] = [
  DSH_PROVIDER_ID,
  DSH_PROVIDER_RESPONSES_ID,
  DSH_PROVIDER_ANTHROPIC_ID,
];

/**
 * dsh 三协议路由（2026-10-06 官方核实：dsh 0.2.0-rc.2 / pi-ai 0.87.1 的 KnownApi
 * 含 openai-responses 与 anthropic-messages，README 明确自定义网关路由可声明）。
 * 模型按 chat > responses > messages 偏好归一分配（defaultBinding 优先），每模型
 * 只进一个路由；compat 形状按 api 区分（supportsDeveloperRole/maxTokensField 仅
 * openai-completions 适用）。anthropic-messages 请求路径由 pi-ai 拼 baseURL+"/v1/messages"，
 * 该路由 baseURL 不带 /v1。
 */
const DSH_WIRE_PREFERENCE = ["chat_completions", "responses", "messages"] as const;
type DshRouteWire = (typeof DSH_WIRE_PREFERENCE)[number];

const DSH_ROUTES: Readonly<Record<DshRouteWire, {
  id: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  displayName: string;
  baseURL: (gatewayBaseUrl: string) => string;
  compat?: Record<string, unknown>;
}>> = {
  chat_completions: {
    id: DSH_PROVIDER_ID,
    api: "openai-completions",
    displayName: "DeepAA 网关",
    baseURL: gatewayBaseUrl => `${gatewayBaseUrl}/dsh/v1`,
    compat: {supportsDeveloperRole: false, maxTokensField: "max_tokens"},
  },
  responses: {
    id: DSH_PROVIDER_RESPONSES_ID,
    api: "openai-responses",
    displayName: "DeepAA 网关（Responses）",
    baseURL: gatewayBaseUrl => `${gatewayBaseUrl}/dsh/v1`,
  },
  messages: {
    id: DSH_PROVIDER_ANTHROPIC_ID,
    api: "anthropic-messages",
    displayName: "DeepAA 网关（Anthropic）",
    baseURL: gatewayBaseUrl => `${gatewayBaseUrl}/dsh`,
  },
};

/** dsh 推理强度值域（llm-pi-ai：off | low | high | max）。 */
const DSH_REASONING_EFFORTS = ["off", "low", "high", "max"] as const;
/** dsh 权限预设值域（permission-presets 组合表键）。 */
const DSH_PERMISSION_PRESET_IDS = ["read-only", "workspace-write", "danger-full-access"] as const;

/**
 * 官方三权限预设（照抄 dsh base bundle / permission-presets 官方定义）。
 * read-only 不在 dsh 内置默认表（schema default 只有 workspace-write /
 * danger-full-access 两项），受管分节/行必须自带全表：patch 行 config 对低层是
 * 整行替换，只写 defaultPreset 会把 bundle 基线的 presets 一并替换掉，导致
 * read-only 选择在 dsh 侧报 unknown preset。
 */
const OFFICIAL_PERMISSION_PRESETS = {
  "read-only": {sandbox: "read-only", approval: "ask"},
  "workspace-write": {sandbox: "workspace-write", approval: "ask"},
  "danger-full-access": {sandbox: "danger-full-access", approval: "never"},
} as const;

/**
 * dsh 适配器：受管分节按布局写入——dsh ≤0.1.6 持续写 $DSH_HOME/settings.yaml；
 * dsh ≥0.1.7（检测到 settings.yaml.imported 迁移痕迹）改写每个已初始化 profile 的
 * cordis.patch.yml（web/desktop），一份受管内容多 profile 生效。只消费
 * chat_completions binding。apiKeyEnv 固定为 DEEPAA_GATEWAY_TOKEN 本地占位环境
 * 变量名，绝不是供应商真实密钥。
 */
export const dshCliConfigAdapter: AgentCliConfigAdapter = {
  agent: "dsh",
  files: [DSH_SETTINGS_SPEC, DSH_PROFILE_PATCH_SPEC, DSH_CREDENTIALS_SPEC],

  resolvePaths(context: CliSyncContext): CliResolvedPaths {
    return {
      filePaths: {
        ...(context.dshConfigLayout === "legacy-settings"
          ? {[DSH_SETTINGS_SPEC.id]: resolveDshSettingsPath(context)}
          : dshProfilePatchPaths(context)),
        [DSH_CREDENTIALS_SPEC.id]: resolveDshCredentialsPath(context),
      },
    };
  },

  build(context: CliSyncContext, paths: CliResolvedPaths): AgentCliPlan {
    const warnings: CliSyncWarning[] = [];
    const connection = context.config.agentConnections.dsh;
    const defaultTarget = resolveSyncDefaultTarget(context.config, "dsh", warnings, agentLabelOf);
    if (!connection || !connection.cliSyncEnabled) {
      return inactivePlan(context, paths, warnings);
    }
    if (!defaultTarget) {
      return preservePlan("dsh", warnings);
    }
    const targets = boundTargetsForAgent(context.config, "dsh", defaultTarget, warnings, agentLabelOf);
    if (!targets.some(target => target.id === defaultTarget.id)) {
      return preservePlan("dsh", warnings);
    }

    const defaultModel = defaultModelOf(defaultTarget, "dsh")!;
    const assignments = assignDshModels(context, targets);
    const defaultAssignment = assignments.get(buildGatewayModelId(defaultTarget.id, defaultModel));
    if (!defaultAssignment) {
      warnings.push({
        targetId: defaultTarget.id,
        code: "MODEL_WIRE_API_UNSUPPORTED",
        message: `${defaultTarget.name} 的默认模型不支持 dsh 可用协议（chat_completions/responses/messages），已跳过写入`,
      });
      return preservePlan("dsh", warnings);
    }

    const sections = buildManagedSections(context, assignments, defaultTarget, defaultModel, defaultAssignment.wire);
    const credentialsContent = renderCredentialsRefs({
      [DSH_GATEWAY_CREDENTIAL_KEY]: context.gatewayBearerToken,
    });
    const artifacts: CliFileArtifact[] = context.dshConfigLayout === "legacy-settings"
      ? [
        {
          specId: DSH_SETTINGS_SPEC.id,
          path: paths.filePaths[DSH_SETTINGS_SPEC.id]!,
          kind: "yaml",
          active: true,
          content: stringifyYaml(settingsRootOf(sections)),
        },
      ]
      : profilePatchTargets(context, paths).map(({profile, path}) => ({
        specId: DSH_PROFILE_PATCH_SPEC.id,
        path,
        kind: "yaml" as const,
        active: true,
        content: profilePatchContentOf(sections),
        note: `${profile} profile 受管行（与 dsh 设置界面同文件同层共存）`,
      }));
    return {
      agent: "dsh",
      active: true,
      artifacts: [
        ...artifacts,
        {
          specId: DSH_CREDENTIALS_SPEC.id,
          path: paths.filePaths[DSH_CREDENTIALS_SPEC.id]!,
          kind: "yaml",
          active: true,
          content: credentialsContent,
        },
      ],
      warnings,
      notes: [
        "dsh 占位凭据写入 $DSH_HOME/.credentials.yaml，任何方式启动都会命中本地网关；真实密钥只存在于系统凭据库",
        "dsh 手动运行若未注入 DEEPAA_GATEWAY_TOKEN 会得到 MISSING_CREDENTIAL，这是受管网关模式的预期行为",
        context.dshConfigLayout === "legacy-settings"
          ? "settings.yaml 与 .credentials.yaml 使用 YAML AST 定点修改，保留非受管分节及其注释"
          : `受管行写入各已初始化 profile 的 cordis.patch.yml（当前：${context.dshProfileNames.join("/") || "无"}），与 dsh 设置界面同文件同层共存；使用 YAML AST 定点修改，保留非受管行及其注释`,
      ],
    };
  },

  mergeFile(input: {
    file: CliConfigFileSpec;
    existingRaw: string | undefined;
    artifact: CliFileArtifact;
  }): string {
    if (input.file.id === DSH_CREDENTIALS_SPEC.id) {
      return mergeCredentialsFile(input.existingRaw, input.artifact.active);
    }
    if (input.file.id === DSH_PROFILE_PATCH_SPEC.id) {
      return mergeProfilePatchFile(input);
    }
    if (!input.existingRaw?.trim()) return input.artifact.content;
    const document = parseDocument(input.existingRaw);
    if (document.errors.length > 0 || !isMap(document.contents)) return input.artifact.content;
    const legacyNode = document.get("llm-deepseek", true);
    const legacy = isMap(legacyNode) ? legacyNode.toJSON() : legacyNode;
    if (isLegacyDeepaaSection(legacy)) document.delete("llm-deepseek");
    const existingDefaultNode = document.get("agent-default-model", true);
    const existingDefault = asRecord(isMap(existingDefaultNode) ? existingDefaultNode.toJSON() : existingDefaultNode);
    const existingProvider = stringValue(existingDefault.provider);
    const managedDefault = DSH_MANAGED_PROVIDER_IDS.includes(existingProvider || "")
      || (existingProvider === "deepseek-official" && Boolean(parseGatewayModelId(stringValue(existingDefault.model) || "")));
    if (managedDefault) document.delete("agent-default-model");
    // permission 只接管 defaultPreset 与受管 presets；其它用户权限设置必须保留。
    // presets 与官方三预设完全等价（我们写入的）→ 整键删除；含用户自定义 → 只删 read-only。
    const permissionNode = document.get("permission", true);
    if (isMap(permissionNode)) {
      document.deleteIn(["permission", "defaultPreset"]);
      const presets = asRecord(asRecord(permissionNode.toJSON()).presets);
      if (isOfficialPermissionPresets(presets)) {
        document.deleteIn(["permission", "presets"]);
      } else {
        document.deleteIn(["permission", "presets", "read-only"]);
      }
    }
    if (input.artifact.active) {
      const generated = parseYaml(input.artifact.content) as Record<string, unknown>;
      const generatedPiAi = asRecord(generated["llm-pi-ai"]);
      const generatedProviders = asRecord(generatedPiAi.providers);
      // 多路由按需落键；历史路由（如该协议模型清空后）整体删除。
      for (const providerId of DSH_MANAGED_PROVIDER_IDS) {
        const route = generatedProviders[providerId];
        if (isObject(route)) {
          document.setIn(["llm-pi-ai", "providers", providerId], route);
        } else if (isMap(document.getIn(["llm-pi-ai", "providers", providerId], true))) {
          document.deleteIn(["llm-pi-ai", "providers", providerId]);
        }
      }
      if (isObject(generated["agent-default-model"])) {
        document.set("agent-default-model", generated["agent-default-model"]);
      }
      const permission = asRecord(generated.permission);
      const defaultPreset = permission.defaultPreset;
      if (typeof defaultPreset === "string") {
        if (isMap(document.get("permission", true))) {
          document.setIn(["permission", "defaultPreset"], defaultPreset);
          document.setIn(["permission", "presets", "read-only"], OFFICIAL_PERMISSION_PRESETS["read-only"]);
        } else {
          // 新建分节写全（presets 三预设 + defaultPreset）：settings 分节的读取合并
          // 语义随版本不同，全量自持才能保证 read-only 可选且不覆盖官方预设。
          document.set("permission", permission);
        }
      }
    } else {
      for (const providerId of DSH_MANAGED_PROVIDER_IDS) {
        if (isMap(document.getIn(["llm-pi-ai", "providers", providerId], true))) {
          document.deleteIn(["llm-pi-ai", "providers", providerId]);
        }
      }
    }
    removeEmptyYamlMap(document, ["permission", "presets"]);
    removeEmptyYamlMap(document, ["permission"]);
    removeEmptyYamlMap(document, ["llm-pi-ai", "providers"]);
    removeEmptyYamlMap(document, ["llm-pi-ai"]);
    return isMap(document.contents) && document.contents.items.length > 0 ? document.toString() : "";
  },

  validate(plan: AgentCliPlan): void {
    for (const artifact of plan.artifacts) {
      assertNoRealSecrets(artifact.content, "dsh");
      if (!artifact.active || !artifact.content.trim()) continue;
      const parsed = parseYaml(artifact.content) as unknown;
      const rows = artifact.specId === DSH_PROFILE_PATCH_SPEC.id
        ? profilePatchManagedRows(parsed)
        : [parsed as Record<string, unknown>];
      for (const root of rows) {
        validateManagedSections(root);
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

/** 按设计文档 9.4 路径规则解析 dsh settings.yaml（≤0.1.6 布局的写入目标）。 */
export function resolveDshSettingsPath(context: CliSyncContext): string {
  if (context.paths.dshSettingsPath?.trim()) return context.paths.dshSettingsPath;
  const pathModule = context.platform === "win32" ? win32 : posix;
  return pathModule.join(
    resolveDshHomeDir({homeDir: context.homeDir, env: context.env, platform: context.platform}),
    "settings.yaml",
  );
}

/**
 * dsh profile patch 路径（≥0.1.7 布局）：每个已初始化 profile 一个写入目标
 * （复合键 dsh-profile-patch:<name>）。测试经 paths.dshProfilePatchPaths 注入。
 */
export function dshProfilePatchPaths(context: CliSyncContext): Record<string, string> {
  const pathModule = context.platform === "win32" ? win32 : posix;
  const injected = context.paths.dshProfilePatchPaths;
  const dshHome = resolveDshHomeDir({homeDir: context.homeDir, env: context.env, platform: context.platform});
  return Object.fromEntries(context.dshProfileNames.map(profile => {
    const path = injected?.[profile]?.trim()
      || pathModule.join(dshHome, "profiles", profile, "cordis.patch.yml");
    return [`${DSH_PROFILE_PATCH_SPEC.id}:${profile}`, path];
  }));
}

/** dsh 凭据文件路径：$DSH_HOME/.credentials.yaml（0.1.x 与 0.2.x 布局一致，version 1 refs）。 */
export function resolveDshCredentialsPath(context: CliSyncContext): string {
  if (context.paths.dshCredentialsPath?.trim()) return context.paths.dshCredentialsPath;
  const pathModule = context.platform === "win32" ? win32 : posix;
  return pathModule.join(
    resolveDshHomeDir({homeDir: context.homeDir, env: context.env, platform: context.platform}),
    ".credentials.yaml",
  );
}

/**
 * 生成凭据文件内容（version 1 + refs）或清理层表达：
 * 只 patch 网关占位 refs 键，用户已有的其它 refs/records 键原样保留。
 */
function renderCredentialsRefs(refs: Record<string, string>): string {
  return stringifyYaml({version: 1, refs});
}

/**
 * 凭据文件合并：保留用户已有的 refs/records，仅设置/删除网关占位键。
 * 兼容 dsh 预发布 flat 布局（无 version 键）——按 dsh 自身迁移规则嵌套进 refs。
 */
function mergeCredentialsFile(existingRaw: string | undefined, active: boolean): string {
  if (!existingRaw?.trim()) {
    return active ? renderCredentialsRefs({[DSH_GATEWAY_CREDENTIAL_KEY]: GATEWAY_PLACEHOLDER_TOKEN}) : "";
  }
  const existing = parseYaml(existingRaw) as Record<string, unknown>;
  if (!isObject(existing)) {
    // 非对象内容（如数组）拒绝改写，避免破坏用户凭据文件。
    return existingRaw;
  }
  const version = typeof existing["version"] === "number" ? existing["version"] : undefined;
  if (version === 1) {
    const document = parseDocument(existingRaw);
    if (document.errors.length > 0 || !isMap(document.contents)) return existingRaw;
    if (active) document.setIn(["refs", DSH_GATEWAY_CREDENTIAL_KEY], GATEWAY_PLACEHOLDER_TOKEN);
    else document.deleteIn(["refs", DSH_GATEWAY_CREDENTIAL_KEY]);
    return document.toString();
  }
  const refsRaw = (version === 1 && isObject(existing["refs"])) ? existing["refs"] : existing;
  const refs: Record<string, unknown> = {...refsRaw};
  if (active) refs[DSH_GATEWAY_CREDENTIAL_KEY] = GATEWAY_PLACEHOLDER_TOKEN;
  else delete refs[DSH_GATEWAY_CREDENTIAL_KEY];
  const next: Record<string, unknown> = {...existing};
  if (version === 1) {
    next["refs"] = refs;
    return stringifyYaml(next);
  }
  // flat 布局迁移：version 1 + refs 嵌套（dsh 自身识别的迁移形态）。
  return stringifyYaml({...next, version: 1, refs});
}

/** 删除 AST 中已经为空的受管映射；不影响带有其它用户键的父分节及注释。 */
function removeEmptyYamlMap(
  document: ReturnType<typeof parseDocument>,
  path: string[],
): void {
  const node = document.getIn(path, true);
  if (isMap(node) && node.items.length === 0) document.deleteIn(path);
}

function inactivePlan(context: CliSyncContext, paths: CliResolvedPaths, warnings: CliSyncWarning[]): AgentCliPlan {
  const layoutArtifacts: CliFileArtifact[] = context.dshConfigLayout === "legacy-settings"
    ? [{
      specId: DSH_SETTINGS_SPEC.id,
      path: paths.filePaths[DSH_SETTINGS_SPEC.id]!,
      kind: "yaml",
      active: false,
      content: "",
      note: "清理层：删除 DeepAA Provider 与受管默认模型，让 dsh 回退用户/官方默认组合",
    }]
    : profilePatchTargets(context, paths).map(({profile, path}) => ({
      specId: DSH_PROFILE_PATCH_SPEC.id,
      path,
      kind: "yaml" as const,
      active: false,
      content: "",
      note: `清理层：删除 ${profile} profile patch 中的 DeepAA 受管行`,
    }));
  return {
    agent: "dsh",
    active: false,
    artifacts: [
      ...layoutArtifacts,
      {
        specId: DSH_CREDENTIALS_SPEC.id,
        path: paths.filePaths[DSH_CREDENTIALS_SPEC.id]!,
        kind: "yaml",
        active: false,
        content: "",
        note: "清理层：删除网关占位凭据键，保留用户其它凭据",
      },
    ],
    warnings,
  };
}

// ———————— 受管内容构造（两种布局共享同一份语义） ————————

interface DshManagedSections {
  /** 按协议分路由的 provider 条目（llm-pi-ai.providers.<routeId>）。 */
  readonly providers: Record<string, Record<string, unknown>>;
  readonly defaultModel: Record<string, unknown>;
  readonly permission?: {defaultPreset: string; presets: typeof OFFICIAL_PERMISSION_PRESETS};
}

/** 模型归一分配：chat > responses > messages（defaultBinding 优先），每模型只进一个路由。 */
function assignDshModels(
  context: CliSyncContext,
  targets: readonly ProxyTarget[],
): Map<string, {wire: DshRouteWire; target: ProxyTarget; modelId: string}> {
  const assignments = new Map<string, {wire: DshRouteWire; target: ProxyTarget; modelId: string}>();
  for (const wire of DSH_WIRE_PREFERENCE) {
    for (const target of targets) {
      for (const modelId of modelsForAgentWireApi(target, "dsh", wire)) {
        const key = buildGatewayModelId(target.id, modelId);
        if (assignments.has(key)) continue;
        assignments.set(key, {wire, target, modelId});
      }
    }
  }
  return assignments;
}

function buildManagedSections(
  context: CliSyncContext,
  assignments: Map<string, {wire: DshRouteWire; target: ProxyTarget; modelId: string}>,
  defaultTarget: ProxyTarget,
  defaultModel: string,
  defaultWire: DshRouteWire,
): DshManagedSections {
  const preferences = context.config.agentConnections.dsh?.launchPreferences;
  const reasoningEffort = preferences?.reasoningEffort;
  const permissionMode = preferences?.permissionMode;
  const routeModels: Record<DshRouteWire, Array<Record<string, unknown>>> = {
    chat_completions: [],
    responses: [],
    messages: [],
  };
  for (const [key, assignment] of assignments) {
    const {target, modelId} = assignment;
    // 能力下发（2026-09-21）：窗口/模态经共享解析层（价格中心 → 模板兜底 → 常量）。
    const caps = resolveModelRuntimeCaps({
      target,
      modelId,
      template: context.template,
      overrides: context.overrides,
      ...(context.pricingEntriesById ? {pricingEntriesById: context.pricingEntriesById} : {}),
    });
    // 启动偏好按网关模型 ID（目标+模型复合键）覆盖：同一模型跨目标可各自覆盖。
    const contextWindow = launchPreferenceContextWindow(preferences, key) ?? caps.contextWindow;
    routeModels[assignment.wire].push({
      id: key,
      name: `${target.name} · ${modelId}`,
      contextWindow,
      // 输出上限优先价格中心条目声明（maxOutput），无声明时回落 32768
      // （dsh provider 的 defaultMaxTokens 同值，行为不变）。
      maxTokens: caps.maxOutput ?? 32_768,
      // dsh input 值域为 text/image；audio 由 dsh 忽略。
      input: caps.inputModalities.includes("image") ? ["text", "image"] : ["text"],
      reasoningEfforts: {
        off: null,
        low: "low",
        high: "high",
        max: "max",
      },
    });
  }
  const providers: Record<string, Record<string, unknown>> = {};
  for (const wire of DSH_WIRE_PREFERENCE) {
    const models = routeModels[wire];
    if (models.length === 0) continue;
    const route = DSH_ROUTES[wire];
    providers[route.id] = {
      displayName: route.displayName,
      apiKeyEnv: DSH_API_KEY_ENV,
      api: route.api,
      baseURL: route.baseURL(context.gatewayBaseUrl),
      defaultContextWindow: 272_000,
      defaultMaxTokens: 32_768,
      ...(route.compat ? {compat: route.compat} : {}),
      models,
      // llm-pi-ai 的 provider 级默认推理字段，避免官方 route 复写模型选择；
      // 只写在承载默认模型的路由上。
      ...(reasoningEffort && wire === defaultWire ? {reasoning: reasoningEffort} : {}),
    };
  }
  return {
    providers,
    defaultModel: {
      provider: DSH_ROUTES[defaultWire].id,
      model: buildGatewayModelId(defaultTarget.id, defaultModel),
      ...(reasoningEffort ? {reasoningEffort} : {}),
    },
    // 新建会话的默认权限预设（沙箱 + 审批捆绑）；缺省时不写该分节。
    // presets 全表自持（见 OFFICIAL_PERMISSION_PRESETS 注释）。
    ...(permissionMode ? {permission: {defaultPreset: permissionMode, presets: OFFICIAL_PERMISSION_PRESETS}} : {}),
  };
}

/** legacy 布局：settings.yaml 的受管分节 mapping（顶层键 = entry id）。 */
function settingsRootOf(sections: DshManagedSections): Record<string, unknown> {
  return {
    "llm-pi-ai": {
      providers: sections.providers,
    },
    "agent-default-model": sections.defaultModel,
    ...(sections.permission ? {permission: sections.permission} : {}),
  };
}

/** profile patch 布局的受管 artifact 目标（复合键 dsh-profile-patch:<name>）。 */
function profilePatchTargets(
  context: CliSyncContext,
  paths: CliResolvedPaths,
): Array<{profile: string; path: string}> {
  return context.dshProfileNames
    .map(profile => {
      const path = paths.filePaths[`${DSH_PROFILE_PATCH_SPEC.id}:${profile}`];
      return path ? {profile, path} : null;
    })
    .filter((item): item is {profile: string; path: string} => item !== null);
}

/** profile patch 布局：受管行数组文本（顶层数组，每行 id 定向覆盖 entry config）。 */
function profilePatchContentOf(sections: DshManagedSections): string {
  const rows: Array<Record<string, unknown>> = [
    {id: "llm-pi-ai", config: {providers: sections.providers}},
    {id: "agent-default-model", config: sections.defaultModel},
  ];
  if (sections.permission) {
    rows.push({id: "permission", config: sections.permission});
  }
  return `# DeepAA 受管行（由 DeepAA 配置同步维护；dsh 设置界面可读取并共存编辑）\n${stringifyYaml(rows)}\n`;
}

// ———————— profile patch 合并（YAML AST 定点修改，保留非受管行及注释） ————————

/**
 * profile patch 合并：与 dsh 设置界面同文件同层——llm-pi-ai / permission 共享行
 * 只定点修改受管键（保留用户 providers 与 presets），agent-default-model 为整行
 * 受管（同 id 多行最后一行胜，追加到末尾保证受管生效）。解析失败时原样返回：
 * patch 文件由 dsh 自身解析，宁可本次不同步也不破坏用户行。
 */
function mergeProfilePatchFile(input: {
  existingRaw: string | undefined;
  artifact: CliFileArtifact;
}): string {
  if (!input.existingRaw?.trim()) {
    return input.artifact.active ? input.artifact.content : "";
  }
  const document = parseDocument(input.existingRaw);
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    return input.existingRaw;
  }
  // 自愈 2026-10-05 事故产物：追加分支曾把受管键写成 config.config 双层嵌套
  // （dsh 剥未知键后 provider 不注册）。特征精确：llm-pi-ai 行 config 下只有
  // 一个 "config" 键且其值含 providers——提升内层，后续定点写键落在正确路径。
  healNestedConfigRows(document);
  if (input.artifact.active) {
    const generated = parseYaml(input.artifact.content) as unknown;
    const managed = profilePatchManagedRows(generated)[0] ?? {};
    const generatedProviders = asRecord(asRecord(asRecord(managed["llm-pi-ai"]).providers));
    // 多路由按需落键；历史路由（该协议模型清空后）整体删除。
    for (const providerId of DSH_MANAGED_PROVIDER_IDS) {
      const providerEntry = asRecord(generatedProviders[providerId]);
      if (Object.keys(providerEntry).length > 0) {
        upsertPatchRowKey(document, "llm-pi-ai", ["config", "providers", providerId], providerEntry);
      } else {
        deletePatchRowKey(document, "llm-pi-ai", ["config", "providers", providerId]);
      }
    }
    if (isObject(managed["agent-default-model"])) {
      deleteManagedDefaultRows(document);
      appendPatchRow(document, "agent-default-model", managed["agent-default-model"]);
    }
    const permission = asRecord(managed.permission);
    if (typeof permission.defaultPreset === "string") {
      const permissionRow = findPatchRowIndex(document, "permission");
      if (permissionRow >= 0) {
        // 已有行（多为 dsh 设置界面写入的合并态）：只定点受管键，保留用户 presets。
        document.setIn([permissionRow, "config", "defaultPreset"], permission.defaultPreset);
        document.setIn([permissionRow, "config", "presets", "read-only"], OFFICIAL_PERMISSION_PRESETS["read-only"]);
      } else {
        // 新行必须全表自持：patch 行 config 对低层整行替换，只写部分键会丢 bundle
        // 基线的官方 presets（read-only 不在内置默认表，见 OFFICIAL_PERMISSION_PRESETS）。
        appendPatchRow(document, "permission", permission);
      }
    }
  } else {
    for (const providerId of DSH_MANAGED_PROVIDER_IDS) {
      deletePatchRowKey(document, "llm-pi-ai", ["config", "providers", providerId]);
    }
    deleteManagedDefaultRows(document);
    deletePatchRowKey(document, "permission", ["config", "defaultPreset"]);
    pruneManagedPermissionPresets(document);
    // 清理层收尾：config 已空的 permission 行整行删除，回退 bundle 基线。
    pruneManagedPermissionRow(document);
    pruneEmptyManagedRows(document);
  }
  const text = document.toString();
  // dsh 要求 patch 文件至少为 []（空文件会解析失败）；清空且原文件存在时保留空数组。
  return text.trim() === "" ? "[]\n" : text;
}

/** 最后一个 id 匹配行的下标（同 id 多行最后一行胜）；无匹配返回 -1。 */
function findPatchRowIndex(document: ReturnType<typeof parseDocument>, rowId: string): number {
  const seq = document.contents;
  if (!isSeq(seq)) return -1;
  for (let index = seq.items.length - 1; index >= 0; index -= 1) {
    const row = seq.items[index];
    if (isMap(row) && row.get("id") === rowId) return index;
  }
  return -1;
}

/** 修复 config.config 双层嵌套的 llm-pi-ai 坏行（特征精确匹配，绝不动用户行）。 */
function healNestedConfigRows(document: ReturnType<typeof parseDocument>): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  for (let index = 0; index < seq.items.length; index += 1) {
    const row = seq.items[index];
    if (!isMap(row) || row.get("id") !== "llm-pi-ai") continue;
    const configNode = row.get("config", true);
    if (!isMap(configNode) || configNode.items.length !== 1) continue;
    const pair = configNode.items[0] as {key?: {value?: unknown}; value?: unknown} | undefined;
    if (pair?.key?.value !== "config") continue;
    // 校验用 toJSON，替换必须用原 YAML node：中间路径位置存 plain object 会让
    // 后续 setIn 深穿透报 "Expected YAML collection"（yaml 包只保证末段包装）。
    const nestedJson = isMap(pair.value) ? pair.value.toJSON() : pair.value;
    if (!isObject(nestedJson) || !isObject(nestedJson.providers)) continue;
    if (isMap(pair.value)) {
      row.set("config", pair.value);
    } else {
      document.setIn([index, "config"], nestedJson);
    }
  }
}

/**
 * 在最后一个 id 匹配的行内定点写键；行不存在时追加新行。keyPath 首段固定为
 * "config"（行内路径前缀），追加分支必须剥掉它——appendPatchRow 会把传入对象
 * 包进行的 config 键，不剥会写成 config.config 双层嵌套（dsh 剥未知键后
 * providers 落空、provider 永远不注册，2026-10-05 桌面端实测事故）。
 */
function upsertPatchRowKey(
  document: ReturnType<typeof parseDocument>,
  rowId: string,
  keyPath: readonly string[],
  value: unknown,
): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  const existing = findPatchRowIndex(document, rowId);
  if (existing >= 0) {
    document.setIn([existing, ...keyPath], value);
    return;
  }
  if (keyPath[0] !== "config" || keyPath.length < 2) {
    throw new Error(`DSH_PATCH_INVALID: 受管键路径必须以 config 开头 ${keyPath.join("/")}`);
  }
  const innerPath = keyPath.slice(1);
  const config: Record<string, unknown> = {};
  let cursor = config;
  for (const key of innerPath.slice(0, -1)) {
    cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[innerPath[innerPath.length - 1]!] = value;
  appendPatchRow(document, rowId, config);
}

function appendPatchRow(
  document: ReturnType<typeof parseDocument>,
  rowId: string,
  config: unknown,
): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  seq.add(document.createNode({id: rowId, config}));
}

/** 在所有 id 匹配的行内定点删键（多行场景逐行清理）；删行收尾由 prune 函数负责。 */
function deletePatchRowKey(
  document: ReturnType<typeof parseDocument>,
  rowId: string,
  keyPath: readonly string[],
): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  for (let index = seq.items.length - 1; index >= 0; index -= 1) {
    const row = seq.items[index];
    if (!isMap(row) || row.get("id") !== rowId) continue;
    document.deleteIn([index, ...keyPath]);
  }
}

/** 删除 agent-default-model 的受管特征行（我们写的或接管过的）；用户自选的官方默认模型行不动。 */
function deleteManagedDefaultRows(document: ReturnType<typeof parseDocument>): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  for (let index = seq.items.length - 1; index >= 0; index -= 1) {
    const row = seq.items[index];
    if (!isMap(row) || row.get("id") !== "agent-default-model") continue;
    const config = row.get("config", true);
    const entry = asRecord(isMap(config) ? config.toJSON() : config);
    const provider = stringValue(entry.provider);
    const managed = DSH_MANAGED_PROVIDER_IDS.includes(provider || "")
      || (provider === "deepseek-official" && Boolean(parseGatewayModelId(stringValue(entry.model) || "")));
    if (managed) seq.delete(index);
  }
}

/** presets 是否与官方三预设完全等价（受管写入形态）。 */
function isOfficialPermissionPresets(value: unknown): boolean {
  return isObject(value) && JSON.stringify(value) === JSON.stringify(OFFICIAL_PERMISSION_PRESETS);
}

/**
 * 清理层收尾：permission 行的 presets 与官方三预设完全等价（我们写入的）→ 整键
 * 删除；含用户自定义预设 → 只删 read-only 键（官方等价内容，删除后回落内置表）。
 */
function pruneManagedPermissionPresets(document: ReturnType<typeof parseDocument>): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  for (let index = seq.items.length - 1; index >= 0; index -= 1) {
    const row = seq.items[index];
    if (!isMap(row) || row.get("id") !== "permission") continue;
    const configNode = row.get("config", true);
    const presets = asRecord(asRecord(isMap(configNode) ? configNode.toJSON() : configNode).presets);
    if (Object.keys(presets).length === 0) continue;
    if (isOfficialPermissionPresets(presets)) {
      document.deleteIn([index, "config", "presets"]);
    } else {
      document.deleteIn([index, "config", "presets", "read-only"]);
    }
  }
}

/** 清理层收尾：只剩与官方基线等价 presets（或空 config）的 permission 行整行删除。 */
function pruneManagedPermissionRow(document: ReturnType<typeof parseDocument>): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  for (let index = seq.items.length - 1; index >= 0; index -= 1) {
    const row = seq.items[index];
    if (!isMap(row) || row.get("id") !== "permission") continue;
    const configNode = row.get("config", true);
    const config = asRecord(isMap(configNode) ? configNode.toJSON() : configNode);
    if (Object.keys(config).length === 0) {
      seq.delete(index);
      continue;
    }
    const presets = config.presets;
    if (Object.keys(config).length === 1 && isOfficialPermissionPresets(presets)) {
      seq.delete(index);
    }
  }
}

/** 删除已无受管内容的 llm-pi-ai 行（config 空、或只剩空 providers 映射，回退 dormant 挂载）。 */
function pruneEmptyManagedRows(document: ReturnType<typeof parseDocument>): void {
  const seq = document.contents;
  if (!isSeq(seq)) return;
  for (let index = seq.items.length - 1; index >= 0; index -= 1) {
    const row = seq.items[index];
    if (!isMap(row) || row.get("id") !== "llm-pi-ai") continue;
    const configNode = row.get("config", true);
    const config = asRecord(isMap(configNode) ? configNode.toJSON() : configNode);
    const keys = Object.keys(config);
    if (keys.length === 0) {
      seq.delete(index);
      continue;
    }
    if (keys.length === 1 && keys[0] === "providers" && Object.keys(asRecord(config.providers)).length === 0) {
      seq.delete(index);
    }
  }
}

/** 把 patch 行数组还原为 settings-root 形状（validate 复用同一套受管校验）。 */
function profilePatchManagedRows(parsed: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parsed)) return [{}];
  const root: Record<string, unknown> = {};
  for (const row of parsed) {
    const entry = asRecord(row);
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id !== "llm-pi-ai" && id !== "agent-default-model" && id !== "permission") continue;
    root[id] = isObject(entry.config) ? entry.config : {};
  }
  return [root];
}

/** 受管分节校验（两种布局共用）：受管路由键、api/baseURL 对应关系、占位 token、模型格式与值域。 */
function validateManagedSections(root: Record<string, unknown>): void {
  const llmPiAi = asRecord(root["llm-pi-ai"]);
  const providers = asRecord(llmPiAi.providers);
  const routeById = new Map(Object.values(DSH_ROUTES).map(route => [route.id, route]));
  for (const providerId of DSH_MANAGED_PROVIDER_IDS) {
    const provider = asRecord(providers[providerId]);
    if (Object.keys(provider).length === 0) continue;
    const route = routeById.get(providerId)!;
    if (typeof provider.baseURL === "string" && !provider.baseURL.includes("/dsh")) {
      throw new Error("DSH_PLAN_INVALID: baseURL 不是本地网关 dsh 入口");
    }
    if (provider.api !== undefined && provider.api !== route.api) {
      throw new Error(`DSH_PLAN_INVALID: ${providerId} 的 api 必须为 ${route.api}`);
    }
    if (provider.apiKeyEnv !== undefined && provider.apiKeyEnv !== DSH_API_KEY_ENV) {
      throw new Error(`DSH_PLAN_INVALID: apiKeyEnv 必须为 ${DSH_API_KEY_ENV}`);
    }
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      const row = asRecord(model);
      const id = typeof row.id === "string" ? row.id : "";
      if (!parseGatewayModelId(id)) {
        throw new Error(`DSH_PLAN_INVALID: 模型 ID 缺少合法供应商路由后缀 ${id}`);
      }
    }
  }
  const defaultModel = asRecord(root["agent-default-model"]);
  if (defaultModel.provider !== undefined
    && !(DSH_MANAGED_PROVIDER_IDS.includes(String(defaultModel.provider)) || defaultModel.provider === "deepseek-official")) {
    throw new Error(`DSH_PLAN_INVALID: agent-default-model.provider 必须为受管路由（${DSH_MANAGED_PROVIDER_IDS.join("/")}）`);
  }
  if (defaultModel.model !== undefined
    && (typeof defaultModel.model !== "string"
      || !parseGatewayModelId(String(defaultModel.model)))) {
    throw new Error("DSH_PLAN_INVALID: agent-default-model.model 必须为带路由后缀的网关模型");
  }
  const providerSections = DSH_MANAGED_PROVIDER_IDS
    .map(providerId => asRecord(providers[providerId]))
    .filter(section => Object.keys(section).length > 0);
  for (const section of [...providerSections, defaultModel]) {
    const effort = section.reasoning ?? section.reasoningEffort;
    if (effort !== undefined && !(DSH_REASONING_EFFORTS as readonly string[]).includes(String(effort))) {
      throw new Error(`DSH_PLAN_INVALID: reasoningEffort 必须为 ${DSH_REASONING_EFFORTS.join("/")}`);
    }
  }
  const permission = asRecord(root["permission"]);
  if (permission.defaultPreset !== undefined
    && !(DSH_PERMISSION_PRESET_IDS as readonly string[]).includes(String(permission.defaultPreset))) {
    throw new Error(`DSH_PLAN_INVALID: permission.defaultPreset 必须为 ${DSH_PERMISSION_PRESET_IDS.join("/")}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 只识别 DeepAA 旧版本写入的 llm-deepseek，绝不删除用户自己的同名配置。 */
function isLegacyDeepaaSection(value: unknown): boolean {
  const section = asRecord(value);
  return section.apiKeyEnv === DSH_API_KEY_ENV
    && typeof section.baseURL === "string"
    && section.baseURL.includes("/dsh/v1");
}

export type {CliSyncWarning};
