import {posix, win32} from "node:path";
import {buildGatewayModelId, parseGatewayModelId} from "@/proxy/gateway-prefix";
import {resolveDefaultReasoningLevel, resolveModelRuntimeCaps} from "@/lib/config-sync/model-capabilities";
import {
  GATEWAY_PLACEHOLDER_TOKEN,
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

/**
 * ZCode 受管文件：~/.zcode/v2/config.json。
 * 该文件合法包含用户其它供应商的明文 API Key，因此跳过密钥扫描（保留备份）；
 * 适配器只增删改受管键，其余条目与顶层字段原样保留。
 */
const ZCODE_CONFIG_SPEC: CliConfigFileSpec = {
  id: "zcode-config",
  kind: "json",
  managedNamespaces: [
    "provider.<接管条目>.options.baseURL",
    "provider.<接管条目>.models",
    "provider.deepaa-gateway",
    "provider.deepaa-gateway-responses",
    "provider.deepaa-gateway-chat",
    "defaultModelSelection",
  ],
  description: "ZCode provider 配置受管条目与应用内默认模型选择（登录透传接管或网关三协议注入）",
  skipSecretScan: true,
};

/**
 * ZCode 个人供应商规则层：~/.zcode/v2/provider_config.json（2026-10-06 asar 实证）。
 * 新架构 ZCode 的设置界面与运行时真相文件：{schemaVersion:1, config:{providerConfigRules,
 * modelConfigRules, defaultModelSelection?}}，约 1 秒轮询热加载（免重启）；legacy
 * config.json 只在该文件缺失时被一次性 importLegacy 迁移，此后不再读取——只写
 * config.json 会导致运行中的新架构 App 永远看不到受管供应商。本文件同样合法包含
 * 用户自有供应商的明文 API Key，跳过密钥扫描（保留备份）。schema 为 strict：规则内
 * 不能携带 marker 字段，受管识别完全依赖 DeepAA 品牌键命名空间（deepaa-gateway*
 * 与前身键）。
 */
const ZCODE_PROVIDER_CONFIG_SPEC: CliConfigFileSpec = {
  id: "zcode-provider-config",
  kind: "json",
  managedNamespaces: [
    "config.providerConfigRules.providerRules.deepaa-gateway*",
    "config.modelConfigRules.providerModelRules.deepaa-gateway*",
    "config.defaultModelSelection",
  ],
  description: "ZCode 个人供应商规则层的 DeepAA 受管规则（新架构真相文件，热加载）",
  skipSecretScan: true,
};

/** ZCode 同步状态文件：适配器私有、整文件拥有，只含脱敏元数据。 */
const ZCODE_STATE_SPEC: CliConfigFileSpec = {
  id: "zcode-state",
  kind: "json",
  managedNamespaces: ["deepaa"],
  description: "DeepAA 对 ZCode 的同步状态摘要",
};

/**
 * 网关自有 provider 条目（2026-10-06 三协议支持）：ZCode 官方 schema 中每个供应商
 * 只有一个 kind（anthropic=messages / openai=responses / openai-compatible=chat，
 * App 包内 apiFormat↔kind 双向映射实证），三协议必须分条目承载；按需写入——
 * 该协议无模型时不落条目，客户端供应商列表不出现空条目。
 * openai 系请求路径不带 /v1 前缀（官方端点映射：baseURL+"/responses"、
 * baseURL+"/chat/completions"），故 openai 系路由 baseURL 需以 /zcode/v1 结尾。
 */
const ZCODE_GATEWAY_PROVIDER_KEY = "deepaa-gateway";
const ZCODE_GATEWAY_RESPONSES_PROVIDER_KEY = "deepaa-gateway-responses";
const ZCODE_GATEWAY_CHAT_PROVIDER_KEY = "deepaa-gateway-chat";

/** 模型归一分配的协议偏好（defaultBinding 优先）：每模型只进一个路由。 */
const ZCODE_WIRE_PREFERENCE = ["messages", "responses", "chat_completions"] as const;
type ZcodeRouteWire = (typeof ZCODE_WIRE_PREFERENCE)[number];

const ZCODE_ROUTES: Readonly<Record<ZcodeRouteWire, {
  key: string;
  kind: "anthropic" | "openai" | "openai-compatible";
  baseURL: (gatewayBaseUrl: string) => string;
}>> = {
  messages: {
    key: ZCODE_GATEWAY_PROVIDER_KEY,
    kind: "anthropic",
    baseURL: gatewayBaseUrl => `${gatewayBaseUrl}/zcode`,
  },
  responses: {
    key: ZCODE_GATEWAY_RESPONSES_PROVIDER_KEY,
    kind: "openai",
    baseURL: gatewayBaseUrl => `${gatewayBaseUrl}/zcode/v1`,
  },
  chat_completions: {
    key: ZCODE_GATEWAY_CHAT_PROVIDER_KEY,
    kind: "openai-compatible",
    baseURL: gatewayBaseUrl => `${gatewayBaseUrl}/zcode/v1`,
  },
};

/**
 * 受管标记字段：挂在被管理条目内部的未知字段上（实测 App 对条目内未知字段原样
 * 保留——既有 managed/zcode 标记跨多次 App 重写存活），绝不作为独立 provider 条目
 * 存在（2026-10-06 用户确认：客户端供应商列表只应出现 DeepAA 网关系列条目）。
 * inject 条目带 added 标记（清理层按此删除）；透传接管把原始 baseURL/models
 * 记入被接管条目的标记（清理层按此还原）。
 */
const ZCODE_MANAGED_MARKER = "deepaaManaged";
const LEGACY_BRAND_KEBAB = ["llm", "inspector"].join("-");
const LEGACY_ZCODE_GATEWAY_PROVIDER_KEY = `${LEGACY_BRAND_KEBAB}-gateway`;
const LEGACY_ZCODE_STATE_PROVIDER_KEY = `${LEGACY_BRAND_KEBAB}-state`;
/** 旧自还原因子载体（独立 provider 条目，会泄漏到客户端 UI）：读取迁移后删除。 */
const ZCODE_STATE_PROVIDER_KEY = "deepaa-state";

/** 登录透传模式：目标 anthropicUrl → 被接管的 ZCode 内置 Coding Plan 条目。 */
const ZCODE_BUILTIN_TAKEOVER_MAP: Readonly<Record<string, string>> = {
  "https://open.bigmodel.cn/api/anthropic": "builtin:bigmodel-coding-plan",
  "https://api.z.ai/api/anthropic": "builtin:zai-coding-plan",
};

interface TakeoverInstructionEntry {
  gatewayBaseURL: string;
  models: Record<string, GatewayModelInstruction>;
}

interface GatewayModelInstruction {
  /** 原始模型 ID（不含路由后缀），供 mergeFile 匹配既有条目元数据。 */
  baseId: string;
  name?: string;
  contextWindow?: number;
  /** 推理档位指令：优先于同名既有条目元数据；缺省时保留 preserved 值。 */
  reasoning?: {
    enabled: boolean;
    variants: string[];
    defaultVariant?: string;
  };
  /** 输入模态指令（2026-09-21 能力下发）：优先于同名既有条目元数据。 */
  modalities?: {
    input: string[];
    output: string[];
  };
}

interface ConfigArtifactInstruction {
  version: 1;
  mode: "passthrough" | "inject" | "cleanup";
  /** passthrough 模式：被接管的内置条目指令。 */
  takeovers?: Record<string, TakeoverInstructionEntry>;
  /** inject 模式：新增的自有自定义条目（已含占位 apiKey）。 */
  additions?: Record<string, Record<string, unknown>>;
  /**
   * 应用内默认模型选择（2026-10-06，ZCode 官方 schema：根级 defaultModelSelection
   * = {providerId, modelId, options.reasoningLevel?}）：跟随 Agent 默认链写入，
   * 使「在 ZCode 中开发」启动后默认供应商/模型即本次选择。合并层保留用户在
   * App 内自选的非 DeepAA 项（见 pointsAtManagedSelection）。
   */
  defaultModelSelection?: {
    providerId: string;
    modelId: string;
    reasoningLevel?: string;
  };
}

interface StateFileContent {
  deepaa: {
    version: 1;
    agent: "zcode";
    mode: "passthrough" | "inject" | "cleanup";
    targets: Array<{targetId: string; models: number}>;
    updatedAt: string;
    notes?: string[];
  };
}

/** 个人层 rule 的 api.type 值（ZCode 官方三协议枚举）与 wire 的映射。 */
const ZCODE_PERSONAL_API_TYPE: Readonly<Record<ZcodeRouteWire, "anthropic-messages" | "openai-responses" | "openai-chat-completions">> = {
  messages: "anthropic-messages",
  responses: "openai-responses",
  chat_completions: "openai-chat-completions",
};

/**
 * 个人层（provider_config.json）的受管键命名空间：DeepAA 品牌键全集（三路由 +
 * 旧独立 state 因子 + 品牌切换前身）。个人层 schema strict 无法携带 marker，
 * 受管识别与清理完全依赖该命名空间；用户自建同名条目视为品牌保留键冲突，一并
 * 受管（与 config.json 层同名键语义一致）。
 */
const PERSONAL_MANAGED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  ZCODE_GATEWAY_PROVIDER_KEY,
  ZCODE_GATEWAY_RESPONSES_PROVIDER_KEY,
  ZCODE_GATEWAY_CHAT_PROVIDER_KEY,
  ZCODE_STATE_PROVIDER_KEY,
  LEGACY_ZCODE_GATEWAY_PROVIDER_KEY,
  LEGACY_ZCODE_STATE_PROVIDER_KEY,
]);

/**
 * 个人层受管指令：inject = 三路由 providerRules + 每模型 contextWindow 规则 +
 * 应用内默认选择；cleanup = 删除全部受管痕迹（透传模式与停用同步时使用——个人层
 * 的 builtin 接管语义（templateId 覆盖）未实证，透传接管暂只写 legacy config.json）。
 */
interface PersonalConfigInstruction {
  version: 1;
  mode: "inject" | "cleanup";
  rules?: Array<{
    providerId: string;
    providerName: string;
    apiType: "anthropic-messages" | "openai-responses" | "openai-chat-completions";
    baseUrl: string;
    /** 网关模型 ID（复合键）列表：personalModelIds 与 modelOrder 同源。 */
    modelIds: string[];
    /** 模型 → contextWindow；有值的模型生成 modelConfigRules 规则。 */
    contextWindows?: Record<string, number>;
  }>;
  defaultModelSelection?: ConfigArtifactInstruction["defaultModelSelection"];
}

export const zcodeCliConfigAdapter: AgentCliConfigAdapter = {
  agent: "zcode",
  files: [ZCODE_CONFIG_SPEC, ZCODE_PROVIDER_CONFIG_SPEC, ZCODE_STATE_SPEC],

  resolvePaths(context: CliSyncContext): CliResolvedPaths {
    return {
      filePaths: {
        [ZCODE_CONFIG_SPEC.id]: resolveZcodeConfigPath(context),
        [ZCODE_PROVIDER_CONFIG_SPEC.id]: resolveZcodeProviderConfigPath(context),
        [ZCODE_STATE_SPEC.id]: resolveZcodeStatePath(context),
      },
    };
  },

  build(context: CliSyncContext, paths: CliResolvedPaths): AgentCliPlan {
    const warnings: CliSyncWarning[] = [];
    const connection = context.config.agentConnections.zcode;
    const defaultTarget = resolveSyncDefaultTarget(context.config, "zcode", warnings, agentLabelOf);
    if (!connection || !connection.cliSyncEnabled) {
      return inactivePlan(paths, warnings);
    }
    if (!defaultTarget) {
      return preservePlan("zcode", warnings);
    }
    const defaultHasAnyModel = ZCODE_WIRE_PREFERENCE.some(wire =>
      modelsForAgentWireApi(defaultTarget, "zcode", wire).length > 0);
    if (!defaultHasAnyModel) {
      warnings.push({
        targetId: defaultTarget.id,
        code: "NO_MODELS",
        message: `${defaultTarget.name} 没有 ZCode 可用（messages/responses/chat_completions 任一协议且归属含 zcode）的模型`,
      });
      return preservePlan("zcode", warnings);
    }

    // 登录透传模式：接管与默认目标 anthropicUrl 匹配的内置 Coding Plan 条目。
    // 只接入默认目标一个供应商——透传会把客户端 Bearer 转发给上游，
    // 混入其它目标的模型会造成凭据跨供应商泄漏，属于安全红线。
    // 官方 Coding Plan 端点只有 anthropic 协议，透传始终只消费 messages 模型。
    if (defaultTarget.credentialMode === "passthrough") {
      const defaultModels = modelsForAgentWireApi(defaultTarget, "zcode", "messages");
      if (defaultModels.length === 0) {
        warnings.push({
          targetId: defaultTarget.id,
          code: "NO_MODELS",
          message: `${defaultTarget.name} 透传接管需要 messages 协议模型，当前没有可用模型`,
        });
        return preservePlan("zcode", warnings);
      }
      const upstreamKey = defaultTarget.anthropicUrl
        ? ZCODE_BUILTIN_TAKEOVER_MAP[normalizeUpstreamUrl(defaultTarget.anthropicUrl)]
        : undefined;
      if (!upstreamKey) {
        warnings.push({
          targetId: defaultTarget.id,
          code: "ADAPTER_WARNING",
          message: `${defaultTarget.name} 的 anthropicUrl 不匹配 ZCode 内置 Coding Plan 条目（暂只支持 BigModel/Z.ai 官方端点），未生成接管层`,
        });
        return preservePlan("zcode", warnings);
      }
      const takeoverModels: Record<string, GatewayModelInstruction> = Object.fromEntries(defaultModels.map(modelId =>
        [buildGatewayModelId(defaultTarget.id, modelId), modelInstruction(context, defaultTarget, modelId, warnings)]));
      const instruction: ConfigArtifactInstruction = {
        version: 1,
        mode: "passthrough",
          takeovers: {
            [upstreamKey]: {
              gatewayBaseURL: `${context.gatewayBaseUrl}/zcode`,
              models: takeoverModels,
            },
          },
      };
      // 应用内默认选择跟随默认链（透传：指向被接管的内置条目）。
      const passthroughDefault = defaultModelOf(defaultTarget, "zcode")!;
      const passthroughKey = buildGatewayModelId(defaultTarget.id, passthroughDefault);
      instruction.defaultModelSelection = buildDefaultModelSelection({
        providerId: upstreamKey,
        modelId: passthroughKey,
        reasoningLevel: readDefaultReasoningVariant(takeoverModels[passthroughKey]),
      });
      const targets = [{targetId: defaultTarget.id, models: defaultModels.length}];
      return planWithArtifacts(paths, {
        configContent: JSON.stringify(instruction),
        // 个人层不承载透传接管（builtin 条目的 templateId 覆盖语义未实证），
        // 只清理 inject 时代的受管规则，避免残留失效的 DeepAA 网关条目。
        personalContent: JSON.stringify(renderPersonalCleanupInstruction()),
        stateContent: renderStateContent({mode: "passthrough", targets}),
        activeNotes: [
          `登录透传接管 ${upstreamKey}：仅改 baseURL 与 models，apiKey/OAuth 凭据原样保留，套餐额度照常扣减`,
          "接管写入 legacy config.json：旧版 ZCode 重启后生效；新架构 ZCode（provider_config.json 个人层）暂不支持透传接管",
          "关闭同步会自动还原原始 baseURL 与模型列表",
        ],
        warnings,
      });
    }

    // API Key 注入模式：按协议分路由新增自有 provider 条目。模型归一分配
    // （messages > responses > chat，defaultBinding 优先），每模型只进一个路由，
    // 避免同 id 跨条目重复。
    const targets = boundTargetsForAgent(context.config, "zcode", defaultTarget, warnings, agentLabelOf)
      .filter(target => target.credentialMode !== "passthrough");
    if (!targets.some(target => target.id === defaultTarget.id)) {
      targets.unshift(defaultTarget);
    }
    const assignments = new Map<string, {wire: ZcodeRouteWire; targetId: string; instruction: GatewayModelInstruction}>();
    for (const wire of ZCODE_WIRE_PREFERENCE) {
      for (const target of targets) {
        for (const modelId of modelsForAgentWireApi(target, "zcode", wire)) {
          const key = buildGatewayModelId(target.id, modelId);
          if (assignments.has(key)) continue;
          assignments.set(key, {wire, targetId: target.id, instruction: modelInstruction(context, target, modelId, warnings)});
        }
      }
    }
    if (assignments.size === 0) {
      warnings.push({
        targetId: defaultTarget.id,
        code: "NO_MODELS",
        message: "接入范围内没有供应商提供 ZCode 可用（messages/responses/chat_completions 任一协议）的模型",
      });
      return preservePlan("zcode", warnings);
    }
    const routeModels: Record<ZcodeRouteWire, Record<string, GatewayModelInstruction>> = {
      messages: {},
      responses: {},
      chat_completions: {},
    };
    const perTargetCounts = new Map<string, number>();
    for (const [key, assignment] of assignments) {
      routeModels[assignment.wire][key] = assignment.instruction;
      perTargetCounts.set(assignment.targetId, (perTargetCounts.get(assignment.targetId) ?? 0) + 1);
    }
    const additions: Record<string, Record<string, unknown>> = {};
    for (const wire of ZCODE_WIRE_PREFERENCE) {
      const models = routeModels[wire];
      if (Object.keys(models).length === 0) continue;
      const route = ZCODE_ROUTES[wire];
      additions[route.key] = {
        name: GATEWAY_PROVIDER_DISPLAY_NAMES[wire],
        kind: route.kind,
        options: {
          apiKey: GATEWAY_PLACEHOLDER_TOKEN,
          baseURL: route.baseURL(context.gatewayBaseUrl),
        },
        enabled: true,
        source: "custom",
        models,
      };
    }
    const instruction: ConfigArtifactInstruction = {
      version: 1,
      mode: "inject",
      additions,
    };
    // 应用内默认选择跟随默认链（注入：指向该模型归一分配的路由条目）。
    const defaultModel = defaultModelOf(defaultTarget, "zcode")!;
    const defaultKey = buildGatewayModelId(defaultTarget.id, defaultModel);
    const defaultAssignment = assignments.get(defaultKey);
    if (defaultAssignment) {
      instruction.defaultModelSelection = buildDefaultModelSelection({
        providerId: ZCODE_ROUTES[defaultAssignment.wire].key,
        modelId: defaultKey,
        reasoningLevel: readDefaultReasoningVariant(defaultAssignment.instruction),
      });
    }
    // 个人层指令（新架构真相文件）：三路由 providerRules + 每模型 contextWindow 规则。
    const personalInstruction = renderPersonalInjectInstruction(
      context.gatewayBaseUrl, routeModels, instruction.defaultModelSelection);
    return planWithArtifacts(paths, {
      configContent: JSON.stringify(instruction),
      personalContent: JSON.stringify(personalInstruction),
      stateContent: renderStateContent({
        mode: "inject",
        targets: [...perTargetCounts.entries()].map(([targetId, models]) => ({targetId, models})),
      }),
      activeNotes: [
        "已按协议新增自定义供应商「DeepAA 网关（Messages/Responses/Chat Completions）」系列条目（按需落条目），真实密钥由网关按目标从系统凭据库注入",
        "新架构 ZCode 会自动加载最新供应商与模型（约 1 秒，免重启）；同时写 legacy config.json 兜底（旧版 ZCode 或个人层文件被删后的导入源）",
      ],
      warnings,
    });
  },

  mergeFile(input: {
    file: CliConfigFileSpec;
    existingRaw: string | undefined;
    artifact: CliFileArtifact;
  }): string {
    if (input.file.id === ZCODE_STATE_SPEC.id) {
      return input.artifact.content;
    }
    if (input.file.id === ZCODE_PROVIDER_CONFIG_SPEC.id) {
      return applyPersonalInstruction({
        existingRaw: input.existingRaw,
        instructionRaw: input.artifact.active ? input.artifact.content : undefined,
      });
    }
    return applyConfigInstruction({
      existingRaw: input.existingRaw,
      instructionRaw: input.artifact.active ? input.artifact.content : undefined,
      updatedAt: new Date().toISOString(),
    });
  },

  validate(plan: AgentCliPlan): void {
    for (const artifact of plan.artifacts) {
      assertNoRealSecrets(artifact.content, "zcode");
      if (!artifact.active || artifact.specId === ZCODE_STATE_SPEC.id || !artifact.content.trim()) continue;
      if (artifact.specId === ZCODE_PROVIDER_CONFIG_SPEC.id) {
        validatePersonalInstruction(artifact.content);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(artifact.content);
      } catch {
        throw new Error("ZCODE_PLAN_INVALID: 指令内容必须是合法 JSON");
      }
      const instruction = asRecord(parsed);
      if (!instruction || instruction.version !== 1) {
        throw new Error("ZCODE_PLAN_INVALID: 缺少版本声明");
      }
      for (const [key, entry] of Object.entries(asRecord(instruction.additions))) {
        const record = asRecord(entry);
        const expectedKind = (Object.values(ZCODE_ROUTES) as Array<{key: string; kind: string}>)
          .find(route => route.key === key)?.kind;
        if (!expectedKind) {
          throw new Error(`ZCODE_PLAN_INVALID: 自有条目 ${key} 不是受管路由键`);
        }
        if (record.kind !== expectedKind) {
          throw new Error(`ZCODE_PLAN_INVALID: 自有条目 ${key} kind 必须为 ${expectedKind}`);
        }
        const options = asRecord(record.options);
        if (options.apiKey !== GATEWAY_PLACEHOLDER_TOKEN) {
          throw new Error("ZCODE_PLAN_INVALID: 自有条目 apiKey 必须为本地网关占位 token");
        }
        if (typeof options.baseURL !== "string" || !options.baseURL.includes("/zcode")) {
          throw new Error("ZCODE_PLAN_INVALID: 自有条目 baseURL 不是本地网关 zcode 入口");
        }
        assertGatewayModels(asRecord(record.models));
      }
      for (const takeover of Object.values(asRecord(instruction.takeovers))) {
        const record = asRecord(takeover);
        if (typeof record.gatewayBaseURL !== "string" || !record.gatewayBaseURL.includes("/zcode")) {
          throw new Error("ZCODE_PLAN_INVALID: 接管条目 baseURL 不是本地网关 zcode 入口");
        }
        assertGatewayModels(asRecord(record.models));
      }
      const selection = asRecord(instruction.defaultModelSelection) as Partial<NonNullable<ConfigArtifactInstruction["defaultModelSelection"]>>;
      if (Object.keys(selection).length > 0) {
        const knownProviders = new Set([
          ...Object.keys(asRecord(instruction.additions)),
          ...Object.keys(asRecord(instruction.takeovers)),
        ]);
        if (typeof selection.providerId !== "string" || !knownProviders.has(selection.providerId)) {
          throw new Error(`ZCODE_PLAN_INVALID: 默认选择 providerId 未在受管条目中 ${String(selection.providerId)}`);
        }
        if (typeof selection.modelId !== "string" || !parseGatewayModelId(selection.modelId)) {
          throw new Error("ZCODE_PLAN_INVALID: 默认选择 modelId 必须为带路由后缀的网关模型");
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

function planWithArtifacts(paths: CliResolvedPaths, input: {
  configContent: string;
  personalContent: string;
  stateContent: string;
  activeNotes: string[];
  warnings: CliSyncWarning[];
}): AgentCliPlan {
  return {
    agent: "zcode",
    active: true,
    artifacts: [
      {
        specId: ZCODE_CONFIG_SPEC.id,
        path: paths.filePaths[ZCODE_CONFIG_SPEC.id]!,
        kind: "json",
        active: true,
        content: input.configContent,
      },
      {
        specId: ZCODE_PROVIDER_CONFIG_SPEC.id,
        path: paths.filePaths[ZCODE_PROVIDER_CONFIG_SPEC.id]!,
        kind: "json",
        active: true,
        content: input.personalContent,
      },
      {
        specId: ZCODE_STATE_SPEC.id,
        path: paths.filePaths[ZCODE_STATE_SPEC.id]!,
        kind: "json",
        active: true,
        content: input.stateContent,
        note: "同步状态摘要（脱敏）",
      },
    ],
    warnings: input.warnings,
    notes: input.activeNotes,
  };
}

function inactivePlan(paths: CliResolvedPaths, warnings: CliSyncWarning[]): AgentCliPlan {
  return {
    agent: "zcode",
    active: false,
    artifacts: [
      {
        specId: ZCODE_CONFIG_SPEC.id,
        path: paths.filePaths[ZCODE_CONFIG_SPEC.id]!,
        kind: "json",
        active: false,
        content: JSON.stringify({version: 1, mode: "cleanup"} satisfies ConfigArtifactInstruction),
        note: "清理层：按文件内自还原因子还原被接管条目、删除自有条目，其余内容不动",
      },
      {
        specId: ZCODE_PROVIDER_CONFIG_SPEC.id,
        path: paths.filePaths[ZCODE_PROVIDER_CONFIG_SPEC.id]!,
        kind: "json",
        active: false,
        content: JSON.stringify(renderPersonalCleanupInstruction()),
        note: "清理层：删除个人规则层的 DeepAA 受管规则与受管默认选择，其余内容不动",
      },
      {
        specId: ZCODE_STATE_SPEC.id,
        path: paths.filePaths[ZCODE_STATE_SPEC.id]!,
        kind: "json",
        active: false,
        content: "",
        note: "清理层：清空同步状态摘要",
      },
    ],
    warnings,
  };
}

/**
 * 配置合并（纯函数）：把指令应用于既有 config.json 文本。
 *
 * - passthrough 接管：首次执行时把该条目原始 baseURL/models 记入条目自身的
 *   deepaaManaged 标记（App 对条目内未知字段原样保留）；后续重复同步刷新受管
 *   字段但不覆盖已记录的原始值。接管目标缺失时跳过（保护用户文件）。
 * - inject 新增：写入/刷新自有条目并携带 added 标记；先移除带标记但不再需要的
 *   历史条目（如某协议模型清空后的空路由）。
 * - cleanup：按条目标记逐一还原/删除；兼容迁移旧版「独立 deepaa-state 因子条目」
 *   （读取其内容完成同样还原后删除该条目——它会在客户端供应商列表泄漏为空条目）。
 */
function applyConfigInstruction(input: {
  existingRaw: string | undefined;
  instructionRaw: string | undefined;
  updatedAt: string;
}): string {
  if (!input.existingRaw?.trim()) {
    // 目标文件不存在时不创建壳配置：ZCode 未安装或从未启动过，等用户初始化后再同步。
    return "";
  }
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(input.existingRaw) as Record<string, unknown>;
  } catch {
    // 无法解析的用户文件拒绝改写，避免破坏用户凭据存储。
    return input.existingRaw;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return input.existingRaw;
  if (!isObject(root.provider)) {
    root.provider = {};
  }
  const provider = asRecord(root.provider);
  cleanupLegacyProviderArtifacts(provider);

  if (!input.instructionRaw) {
    // 从未被本适配器接管过的文件：清理层必须是真正 no-op（返回空串，
    // 由公共引擎跳过写入），绝不因无关的代理保存动作改写或备份用户配置。
    return hasManagedTraces(provider, root)
      ? renderCleanup(provider, root)
      : "";
  }
  let instruction: ConfigArtifactInstruction;
  try {
    instruction = JSON.parse(input.instructionRaw) as ConfigArtifactInstruction;
  } catch {
    return input.existingRaw;
  }

  // 1. 注入模式：先清理带 added 标记但不再出现的条目，再写入当前自有条目。
  //    additions 内是内部指令对象（含 baseId 等中间字段），落盘前必须经
  //    buildManagedModels 渲染为 ZCode 规范模型条目（name/reasoning/limit/modalities）。
  const desiredAdditions = asRecord(instruction.additions);
  for (const [key, entry] of Object.entries(provider)) {
    if (readManagedMarker(entry)?.added && !desiredAdditions[key]) delete provider[key];
  }
  for (const [key, value] of Object.entries(desiredAdditions)) {
    const instructionEntry = asRecord(value);
    const existingEntry = asRecord(provider[key]);
    const previousModels = isObject(existingEntry.models) ? existingEntry.models : {};
    provider[key] = {
      ...instructionEntry,
      models: buildManagedModels(instructionEntry.models, previousModels),
      // 受管标记随条目落盘：清理层据此识别自有条目（不依赖任何外部状态存活）。
      [ZCODE_MANAGED_MARKER]: {version: 1, added: true, updatedAt: input.updatedAt},
    };
  }

  // 2. 透传模式：记录原始值（只在首次）、应用 baseURL/models 接管。
  for (const [key, takeoverRaw] of Object.entries(asRecord(instruction.takeovers))) {
    const takeover = asRecord(takeoverRaw);
    const entry = asRecord(provider[key]);
    if (!entry) continue;
    const options = asRecord(entry.options);
    const marker = readManagedMarker(entry) ?? {version: 1};
    if (marker.originalBaseURL === undefined) {
      marker.originalBaseURL = typeof options.baseURL === "string" ? options.baseURL : "";
      marker.originalModels = isObject(entry.models) ? entry.models : {};
    }
    marker.updatedAt = input.updatedAt;
    options.baseURL = takeover.gatewayBaseURL;
    entry.models = buildManagedModels(takeover.models, entry.models);
    entry[ZCODE_MANAGED_MARKER] = marker;
  }

  // 3. 应用内默认选择：跟随默认链写入；用户在 App 内自选的非 DeepAA 项保留。
  if (instruction.defaultModelSelection
    && (!isObject(root.defaultModelSelection) || pointsAtManagedSelection(root.defaultModelSelection))) {
    root.defaultModelSelection = instruction.defaultModelSelection;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** 读取条目上的受管标记（version 不符视为无标记）。 */
function readManagedMarker(entry: unknown): Partial<{version: number; added: boolean; originalBaseURL: string; originalModels: Record<string, unknown>; updatedAt: string}> | undefined {
  const marker = asRecord(asRecord(entry)[ZCODE_MANAGED_MARKER]);
  return marker.version === 1 ? marker : undefined;
}

/** 应用内默认选择对象（ZCode 官方 schema：providerId/modelId/options.reasoningLevel?）。 */
function buildDefaultModelSelection(input: {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}): NonNullable<ConfigArtifactInstruction["defaultModelSelection"]> {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.reasoningLevel ? {options: {reasoningLevel: input.reasoningLevel}} : {}),
  };
}

/** 从模型指令读取默认推理档（reasoning.defaultVariant；模板无档位时无值）。 */
function readDefaultReasoningVariant(instruction: GatewayModelInstruction | undefined): string | undefined {
  const variant = instruction?.reasoning?.defaultVariant;
  return typeof variant === "string" && variant ? variant : undefined;
}

/**
 * 判断 config.json 根级 defaultModelSelection 是否由 DeepAA 写入/接管：
 * 指向受管路由键（deepaa-gateway*，含前身）或模型为网关复合 ID 即视为受管；
 * 用户在 App 内自选的第三方供应商条目返回 false（合并与清理都保留用户选择）。
 */
function pointsAtManagedSelection(selection: unknown): boolean {
  const record = asRecord(selection);
  if (Object.keys(record).length === 0) return false;
  const providerId = typeof record.providerId === "string" ? record.providerId : "";
  if (providerId.startsWith("deepaa-gateway") || providerId === LEGACY_ZCODE_GATEWAY_PROVIDER_KEY) return true;
  const modelId = typeof record.modelId === "string" ? record.modelId : "";
  return Boolean(parseGatewayModelId(modelId));
}

/** 文件中是否存在任何受管痕迹（新标记、旧独立因子条目或受管默认选择）：清理层是否需要动文件。 */
function hasManagedTraces(provider: Record<string, unknown>, root: Record<string, unknown>): boolean {
  if (provider[ZCODE_STATE_PROVIDER_KEY] !== undefined) return true;
  if (pointsAtManagedSelection(root.defaultModelSelection)) return true;
  return Object.values(provider).some(entry => readManagedMarker(entry) !== undefined);
}

/**
 * 清理品牌切换前写入的前身命名空间条目与旧版独立 state 因子条目。旧 state 与
 * 现行标记同构：先恢复被接管的内置条目，再删除旧自有 Provider 与旧 state，
 * 保证清理幂等；现行 deepaa-state 独立因子（会泄漏到客户端 UI）同样在此迁移删除。
 */
function cleanupLegacyProviderArtifacts(provider: Record<string, unknown>): void {
  for (const stateKey of [LEGACY_ZCODE_STATE_PROVIDER_KEY, ZCODE_STATE_PROVIDER_KEY]) {
    const state = asRecord(provider[stateKey]);
    const managed = asRecord(state.managed);
    if (Object.keys(managed).length === 0) continue;
    for (const [key, originalRaw] of Object.entries(asRecord(managed.takeovers))) {
      const entry = asRecord(provider[key]);
      if (!entry) continue;
      const original = asRecord(originalRaw);
      const options = asRecord(entry.options);
      if (original.baseURL !== undefined) options.baseURL = original.baseURL;
      if (original.models !== undefined) entry.models = original.models;
    }
    for (const key of Array.isArray(managed.addedKeys) ? managed.addedKeys.filter(isString) : []) {
      delete provider[key];
    }
    delete provider[stateKey];
  }
  delete provider[LEGACY_ZCODE_GATEWAY_PROVIDER_KEY];
}

/** 清理层：按条目标记还原接管条目、删除自有条目与受管默认选择；旧独立因子先迁移处理。 */
function renderCleanup(
  provider: Record<string, unknown>,
  root: Record<string, unknown>,
): string {
  cleanupLegacyProviderArtifacts(provider);
  for (const [key, entryRaw] of Object.entries(provider)) {
    const marker = readManagedMarker(entryRaw);
    if (!marker) continue;
    const entry = asRecord(entryRaw);
    if (marker.originalBaseURL !== undefined) {
      const options = asRecord(entry.options);
      options.baseURL = marker.originalBaseURL;
      entry.models = marker.originalModels ?? {};
    }
    if (marker.added) {
      delete provider[key];
    } else {
      delete entry[ZCODE_MANAGED_MARKER];
    }
  }
  // 应用内默认选择指向受管项时删除（用户自选第三方供应商条目保留）。
  if (pointsAtManagedSelection(root.defaultModelSelection)) {
    delete root.defaultModelSelection;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

// ———————— 个人规则层（provider_config.json，新架构真相文件） ————————

/** 个人层清理指令（透传模式与停用同步共用）。 */
function renderPersonalCleanupInstruction(): PersonalConfigInstruction {
  return {version: 1, mode: "cleanup"};
}

/** 个人层注入指令：三路由 rules（全量重建受管键）+ 受管默认选择。 */
function renderPersonalInjectInstruction(
  gatewayBaseUrl: string,
  routeModels: Record<ZcodeRouteWire, Record<string, GatewayModelInstruction>>,
  defaultModelSelection: ConfigArtifactInstruction["defaultModelSelection"],
): PersonalConfigInstruction {
  const rules: NonNullable<PersonalConfigInstruction["rules"]> = [];
  for (const wire of ZCODE_WIRE_PREFERENCE) {
    const models = routeModels[wire];
    const modelIds = Object.keys(models);
    if (modelIds.length === 0) continue;
    const route = ZCODE_ROUTES[wire];
    const contextWindows: Record<string, number> = {};
    for (const [key, instruction] of Object.entries(models)) {
      if (typeof instruction.contextWindow === "number" && Number.isFinite(instruction.contextWindow)) {
        contextWindows[key] = instruction.contextWindow;
      }
    }
    rules.push({
      providerId: route.key,
      providerName: GATEWAY_PROVIDER_DISPLAY_NAMES[wire],
      apiType: ZCODE_PERSONAL_API_TYPE[wire],
      baseUrl: route.baseURL(gatewayBaseUrl),
      modelIds,
      contextWindows,
    });
  }
  return {
    version: 1,
    mode: "inject",
    rules,
    ...(defaultModelSelection ? {defaultModelSelection} : {}),
  };
}

/**
 * 个人层配置合并（纯函数）：把指令应用于既有 provider_config.json 文本。
 *
 * - 文件不存在时 no-op：新架构 App 首次启动会从 legacy config.json（本适配器
 *   已双写三路由）importLegacy 自动生成个人层；旧版 App 不识别该文件。
 * - inject：回收受管键的历史规则（含 deepaa-state 迁移残留、协议清空后的空路由）
 *   后全量重建；每模型写 contextWindow 规则；受管默认选择跟随指令。
 * - cleanup：删除全部受管痕迹；无痕迹时 no-op（绝不因无关动作改写用户文件）。
 * - 用户自有内容（非受管 providerRules / modelConfigRules / manualProviderModelRules /
 *   providerOrder / 第三方默认选择）逐字保留；无法解析的文件拒绝改写。
 */
function applyPersonalInstruction(input: {
  existingRaw: string | undefined;
  instructionRaw: string | undefined;
}): string {
  if (!input.existingRaw?.trim()) return "";
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(input.existingRaw) as Record<string, unknown>;
  } catch {
    return input.existingRaw;
  }
  if (!isObject(root)) return input.existingRaw;
  // 只支持 schemaVersion 1（App 当前编码）；缺失补 1，未知版本拒绝改写。
  if (root.schemaVersion !== undefined
    && (!Number.isInteger(root.schemaVersion) || root.schemaVersion !== 1)) {
    return input.existingRaw;
  }
  let instruction: PersonalConfigInstruction | undefined;
  if (input.instructionRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.instructionRaw);
    } catch {
      return input.existingRaw;
    }
    const record = asRecord(parsed);
    if (record.version !== 1 || (record.mode !== "inject" && record.mode !== "cleanup")) {
      return input.existingRaw;
    }
    instruction = record as unknown as PersonalConfigInstruction;
  }
  const config = asRecord(root.config);
  if (!instruction || instruction.mode === "cleanup") {
    if (!hasPersonalManagedTraces(config)) return "";
    removePersonalManaged(root, config);
    return `${JSON.stringify(root, null, 2)}\n`;
  }
  root.schemaVersion = 1;
  root.config = config;
  const providerConfigRules = asRecord(config.providerConfigRules);
  config.providerConfigRules = providerConfigRules;
  const providerRules: unknown[] = Array.isArray(providerConfigRules.providerRules)
    ? providerConfigRules.providerRules as unknown[]
    : [];
  const modelConfigRules = asRecord(config.modelConfigRules);
  config.modelConfigRules = modelConfigRules;
  const modelRules: unknown[] = Array.isArray(modelConfigRules.providerModelRules)
    ? modelConfigRules.providerModelRules as unknown[]
    : [];
  // 回收受管键的历史规则，再全量重建（键序模仿 App 编码产物，减少其 canonical 重写）。
  const keptProviderRules = providerRules.filter(rule => !isPersonalManagedRule(rule));
  const keptModelRules = modelRules.filter(rule => !isPersonalManagedRule(rule));
  for (const rule of instruction.rules ?? []) {
    keptProviderRules.push({
      providerId: rule.providerId,
      providerName: rule.providerName,
      enabled: true,
      config: {
        group: "standard-personal",
        access: {type: "api-key", apiKey: GATEWAY_PLACEHOLDER_TOKEN},
        api: {type: rule.apiType, baseUrl: rule.baseUrl},
        personalModelIds: [...rule.modelIds],
        modelOrder: [...rule.modelIds],
      },
    });
    for (const [modelId, contextWindow] of Object.entries(rule.contextWindows ?? {})) {
      if (!Number.isFinite(contextWindow)) continue;
      keptModelRules.push({
        modelId,
        config: {properties: {contextWindow}},
        providerId: rule.providerId,
      });
    }
  }
  providerConfigRules.providerRules = keptProviderRules;
  modelConfigRules.providerModelRules = keptModelRules;
  if (instruction.defaultModelSelection
    && (!isObject(config.defaultModelSelection) || pointsAtManagedSelection(config.defaultModelSelection))) {
    config.defaultModelSelection = {...instruction.defaultModelSelection};
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** 规则（providerRule 或 modelRule）是否落在 DeepAA 受管键命名空间。 */
function isPersonalManagedRule(rule: unknown): boolean {
  const providerId = asRecord(rule).providerId;
  return isString(providerId) && PERSONAL_MANAGED_PROVIDER_KEYS.has(providerId);
}

/** 个人层是否存在任何受管痕迹：受管 provider/model 规则或受管默认选择。 */
function hasPersonalManagedTraces(config: Record<string, unknown>): boolean {
  const providerRules = asRecord(config.providerConfigRules).providerRules;
  if (Array.isArray(providerRules) && providerRules.some(rule => isPersonalManagedRule(rule))) return true;
  const modelRules = asRecord(config.modelConfigRules).providerModelRules;
  if (Array.isArray(modelRules) && modelRules.some(rule => isPersonalManagedRule(rule))) return true;
  return pointsAtManagedSelection(config.defaultModelSelection);
}

/** 删除个人层全部受管痕迹；缺失的容器保持缺失，用户内容逐字保留。 */
function removePersonalManaged(root: Record<string, unknown>, config: Record<string, unknown>): void {
  const providerRules = asRecord(config.providerConfigRules).providerRules;
  if (Array.isArray(providerRules)) {
    asRecord(config.providerConfigRules).providerRules = providerRules.filter(rule => !isPersonalManagedRule(rule));
  }
  const modelRules = asRecord(config.modelConfigRules).providerModelRules;
  if (Array.isArray(modelRules)) {
    asRecord(config.modelConfigRules).providerModelRules = modelRules.filter(rule => !isPersonalManagedRule(rule));
  }
  if (pointsAtManagedSelection(config.defaultModelSelection)) {
    delete config.defaultModelSelection;
  }
  if (root.schemaVersion === undefined) root.schemaVersion = 1;
}

/** 个人层指令校验：路由键、协议映射、网关入口、模型复合键与默认选择归属。 */
function validatePersonalInstruction(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("ZCODE_PLAN_INVALID: 个人层指令必须是合法 JSON");
  }
  const instruction = asRecord(parsed);
  if (instruction.version !== 1) {
    throw new Error("ZCODE_PLAN_INVALID: 个人层指令缺少版本声明");
  }
  if (instruction.mode !== "inject" && instruction.mode !== "cleanup") {
    throw new Error("ZCODE_PLAN_INVALID: 个人层指令 mode 非法");
  }
  const rules = Array.isArray(instruction.rules) ? instruction.rules : [];
  const ruleKeys = new Set<string>();
  for (const ruleRaw of rules) {
    const rule = asRecord(ruleRaw);
    const wire = ZCODE_WIRE_PREFERENCE.find(candidate => ZCODE_ROUTES[candidate].key === rule.providerId);
    if (!wire) {
      throw new Error(`ZCODE_PLAN_INVALID: 个人层规则 ${String(rule.providerId)} 不是受管路由键`);
    }
    if (rule.apiType !== ZCODE_PERSONAL_API_TYPE[wire]) {
      throw new Error(`ZCODE_PLAN_INVALID: 个人层规则 ${String(rule.providerId)} apiType 必须为 ${ZCODE_PERSONAL_API_TYPE[wire]}`);
    }
    if (!isString(rule.baseUrl) || !rule.baseUrl.includes("/zcode")) {
      throw new Error("ZCODE_PLAN_INVALID: 个人层规则 baseUrl 不是本地网关 zcode 入口");
    }
    if (!isString(rule.providerName) || !rule.providerName) {
      throw new Error("ZCODE_PLAN_INVALID: 个人层规则 providerName 不能为空");
    }
    const modelIds = Array.isArray(rule.modelIds) ? rule.modelIds : [];
    for (const modelId of modelIds) {
      if (!isString(modelId) || !parseGatewayModelId(modelId)) {
        throw new Error(`ZCODE_PLAN_INVALID: 个人层模型 ID 缺少合法供应商路由后缀 ${String(modelId)}`);
      }
    }
    for (const [key, value] of Object.entries(asRecord(rule.contextWindows))) {
      if (!modelIds.includes(key)) {
        throw new Error(`ZCODE_PLAN_INVALID: 个人层 contextWindow 键不在模型列表中 ${key}`);
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`ZCODE_PLAN_INVALID: 个人层 contextWindow 必须为有限数字 ${key}`);
      }
    }
    ruleKeys.add(String(rule.providerId));
  }
  const selection = asRecord(instruction.defaultModelSelection) as Partial<NonNullable<ConfigArtifactInstruction["defaultModelSelection"]>>;
  if (Object.keys(selection).length > 0) {
    if (typeof selection.providerId !== "string" || !ruleKeys.has(selection.providerId)) {
      throw new Error(`ZCODE_PLAN_INVALID: 个人层默认选择 providerId 未在受管规则中 ${String(selection.providerId)}`);
    }
    if (typeof selection.modelId !== "string" || !parseGatewayModelId(selection.modelId)) {
      throw new Error("ZCODE_PLAN_INVALID: 个人层默认选择 modelId 必须为带路由后缀的网关模型");
    }
  }
}

/** 生成受管 models 字典：以解析层模态（目录下发）与上一条目元数据补齐。 */
function buildManagedModels(
  instructions: unknown,
  previousModels: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const previous = asRecord(previousModels);
  for (const [modelKey, instructionValue] of Object.entries(asRecord(instructions))) {
    const instruction = asRecord(instructionValue);
    // ZCode 官方条目的模型键常为首字母大写（如 GLM-5.3），受管网关模型键是小写：
    // 匹配上一条目元数据时忽略大小写。
    const baseId = isString(instruction.baseId) ? instruction.baseId : "";
    const baseIdLower = baseId.toLowerCase();
    const preserved =
      asRecord(previous[modelKey])
      || (baseId ? findPreviousExact(previous, baseId) : {})
      || findPreviousBySuffix(previous, baseIdLower);
    const limitSource = preserved.limit ?? {};
    const contextWindow = finiteNumber(instruction.contextWindow)
      ?? finiteNumber(asRecord(limitSource).context);
    // 推理档位：指令值（开发启动偏好 / 目录档位）优先，其次沿用上一条目元数据。
    const reasoning = isRecord(instruction.reasoning)
      ? instruction.reasoning
      : preserved.reasoning;
    // 模态优先级（2026-09-21 能力下发）：解析层值（价格中心/目录）> 沿用上一条目 > 兜底 text。
    const instructionModalities = asRecord(instruction.modalities);
    const modalities = Object.keys(instructionModalities).length > 0
      ? instructionModalities
      : preserved.modalities !== undefined
        ? preserved.modalities
        : {input: ["text"], output: ["text"]};
    const model: Record<string, unknown> = {
      ...(isString(instruction.name) ? {name: instruction.name}
        : isString(preserved.name) ? {name: preserved.name}
          : {}),
      ...(reasoning !== undefined ? {reasoning} : {}),
      limit: {
        ...asRecord(limitSource),
        ...(contextWindow !== undefined ? {context: contextWindow} : {}),
        ...(finiteNumber(asRecord(limitSource).output) !== undefined
          ? {output: asRecord(limitSource).output}
          : {output: 128000}),
      },
      modalities,
      ...(preserved.zcode !== undefined
        ? {zcode: {...asRecord(preserved.zcode), modified: true}}
        : {zcode: {modified: true}}),
    };
    result[modelKey] = model;
  }
  return result;
}

function findPreviousExact(previous: Record<string, unknown>, baseId: string): Record<string, unknown> {
  const needle = baseId.toLowerCase();
  for (const [key, value] of Object.entries(previous)) {
    if (key.toLowerCase() === needle) return asRecord(value);
  }
  return {};
}

function findPreviousBySuffix(previous: Record<string, unknown>, baseIdLower: string): Record<string, unknown> {
  if (!baseIdLower) return {};
  const suffix = `_${baseIdLower}`;
  for (const [key, value] of Object.entries(previous)) {
    if (key.toLowerCase().endsWith(suffix)) return asRecord(value);
  }
  return {};
}

/** 单条模型指令：目录能力经共享解析层求值，元数据由 mergeFile 从既有条目补齐。 */
function modelInstruction(
  context: CliSyncContext,
  target: Parameters<typeof modelsForAgentWireApi>[0],
  modelId: string,
  warnings: CliSyncWarning[],
): GatewayModelInstruction {
  // 能力下发（2026-09-21）：窗口/模态经共享解析层（价格中心 → 模板兜底 → 常量）。
  const caps = resolveModelRuntimeCaps({
    target,
    modelId,
    template: context.template,
    overrides: context.overrides,
    ...(context.pricingEntriesById ? {pricingEntriesById: context.pricingEntriesById} : {}),
  });
  // 入参为原始模型 ID；万一传入的是带路由后缀的网关串也能还原出模型部分。
  const baseId = parseGatewayModelId(modelId)?.modelId || modelId;
  // 启动偏好按网关模型 ID（目标+模型复合键）覆盖：同一模型跨目标可各自覆盖。
  const slug = buildGatewayModelId(target.id, baseId);
  const preferences = context.config.agentConnections.zcode?.launchPreferences;
  const contextWindow = launchPreferenceContextWindow(preferences, slug) ?? caps.contextWindow;
  const reasoning = reasoningInstruction(context, target, baseId, warnings);
  return {
    baseId,
    name: `${target.name} · ${modelId}`,
    ...(contextWindow !== undefined ? {contextWindow} : {}),
    ...(reasoning ? {reasoning} : {}),
    // 模态指令（audio 由 zcode 忽略，仅 text/image）。
    modalities: {
      input: caps.inputModalities.includes("image") ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

/**
 * 推理档位指令：模板 defaults.supportedReasoningLevels 提供档位集合（2026-09-21 起
 * 档位表为全局中立层，不再有模型级条目），默认档经共享家族推断
 * （anthropic/responses → xhigh、其余 → max，落表校验），开发启动偏好覆盖；
 * 模板无档位时返回 undefined（保留既有条目元数据）。偏好档位不在表内时与 codex
 * 同口径回退并记 LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED（不再静默吞掉）。
 */
function reasoningInstruction(
  context: CliSyncContext,
  target: Parameters<typeof modelsForAgentWireApi>[0],
  modelId: string,
  warnings: CliSyncWarning[],
): GatewayModelInstruction["reasoning"] | undefined {
  const levels = context.template.defaults.supportedReasoningLevels
    .map(level => (isString(level.effort) ? level.effort : ""))
    .filter(Boolean);
  const variants = [...new Set(levels)];
  if (variants.length === 0) return undefined;
  const inferred = resolveDefaultReasoningLevel(modelId, context.template);
  const preferred = context.config.agentConnections.zcode?.launchPreferences?.reasoningEffort;
  const defaultVariant = preferred && variants.includes(preferred)
    ? preferred
    : variants.includes(inferred)
      ? inferred
      : variants[0];
  if (preferred && preferred !== defaultVariant) {
    warnings.push({
      targetId: target.id,
      code: "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED",
      message: `${target.name} 的模型 ${modelId} 不支持推理档 ${preferred}，已回退默认档 ${defaultVariant}`,
    });
  }
  return {enabled: true, variants, defaultVariant};
}

function assertGatewayModels(models: Record<string, unknown>): void {
  for (const key of Object.keys(models)) {
    if (!parseGatewayModelId(key)) {
      throw new Error(`ZCODE_PLAN_INVALID: 模型 ID 缺少合法供应商路由后缀 ${key}`);
    }
  }
}

/** ZCode v2/config.json 路径：$ZCODE_DATA_BASE_DIR 覆盖优先，缺省 ~/.zcode/v2/config.json。 */
export function resolveZcodeConfigPath(context: CliSyncContext): string {
  if (context.paths.zcodeConfigPath?.trim()) return context.paths.zcodeConfigPath;
  return joinZcodeBase(context, "v2", "config.json");
}

/** ZCode 个人供应商规则层路径：缺省 ~/.zcode/v2/provider_config.json（新架构真相文件）。 */
export function resolveZcodeProviderConfigPath(context: CliSyncContext): string {
  if (context.paths.zcodeProviderConfigPath?.trim()) return context.paths.zcodeProviderConfigPath;
  return joinZcodeBase(context, "v2", "provider_config.json");
}

/** ZCode 同步状态文件路径：v2/deepaa/gateway-state.json。 */
export function resolveZcodeStatePath(context: CliSyncContext): string {
  if (context.paths.zcodeStatePath?.trim()) return context.paths.zcodeStatePath;
  return joinZcodeBase(context, "v2", "deepaa", "gateway-state.json");
}

function joinZcodeBase(context: CliSyncContext, ...segments: string[]): string {
  const pathModule = context.platform === "win32" ? win32 : posix;
  const base = context.env.ZCODE_DATA_BASE_DIR?.trim() || pathModule.join(context.homeDir, ".zcode");
  return pathModule.join(base, ...segments);
}

function normalizeUpstreamUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function renderStateContent(input: {
  mode: "passthrough" | "inject";
  targets: Array<{targetId: string; models: number}>;
}): string {
  const content: StateFileContent = {
    deepaa: {
      version: 1,
      agent: "zcode",
      mode: input.mode,
      targets: input.targets,
      updatedAt: new Date().toISOString(),
    },
  };
  return `${JSON.stringify(content, null, 2)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type {CliSyncWarning};
