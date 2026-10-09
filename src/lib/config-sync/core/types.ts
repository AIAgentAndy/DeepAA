import type {AgentId, ProxyConfig, WireApi} from "@/types";
import type {CatalogOverrides, CatalogTemplate} from "@/lib/config-sync/catalog-template";
import type {ModelPriceEntry} from "@/lib/pricing";

/**
 * CLI 配置同步公共类型。
 *
 * 这里的接口只描述“同步什么、写到哪里、如何合并”，不包含任何 Agent 特有结构。
 * Agent 特有实现全部放在 adapters/ 下，新增 Agent 只需新增 adapter 并在
 * agent-plan-registry 注册，公共引擎与其它 Agent 不需要回归。
 */

/** 受管配置文件格式。 */
export type CliFileKind = "toml" | "json" | "jsonc" | "yaml";

/**
 * dsh 受管配置布局：dsh 0.1.7-rc.1 起移除 settings.yaml（启动时一次性导入
 * 活跃 profile 的 cordis.patch.yml 并改名 settings.yaml.imported），受管写入
 * 必须跟随迁移切换目标，否则写一个没有任何版本读取的死文件。
 */
export type DshConfigLayout = "legacy-settings" | "profile-patch";

/** 同步警告码：公共引擎与各 adapter 共用；新增 Agent 在此扩展枚举。 */
export type CliSyncWarningCode =
  | "AGENT_NOT_CONNECTED"
  | "CLI_SYNC_DISABLED"
  | "CLI_SYNC_TARGET_EXCLUDED"
  | "DEFAULT_TARGET_REQUIRED"
  | "DEFAULT_TARGET_NOT_FOUND"
  | "DEFAULT_TARGET_NOT_BOUND"
  | "CREDENTIAL_MISSING"
  | "NO_MODELS"
  | "MODEL_PRICE_MAPPING_REQUIRED"
  | "PROTOCOL_EXCLUDED"
  | "PRESET_WIRE_API_UNSUPPORTED"
  | "SUBSCRIPTION_UNSUPPORTED"
  | "MODEL_WIRE_API_UNSUPPORTED"
  | "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED"
  | "ADAPTER_WARNING";

export interface CliSyncWarning {
  targetId: string;
  code: CliSyncWarningCode;
  message: string;
}

/**
 * 同步路径输入：兼容 development-launch 与测试。
 * OpenCode / dsh 路径可由调用方显式注入，否则由 path-resolver 按平台规则解析。
 */
export interface CliSyncPaths {
  codexConfigPath: string;
  codexCatalogPath: string;
  claudeUserSettingsPath: string;
  /** 项目目录 → 项目级 settings.json；Claude 每项目一个受管文件。 */
  claudeProjectSettingsPaths: Record<string, string>;
  /** 写入受管配置时使用的本地网关入口，缺省 http://127.0.0.1:3211；localhost 别名在写盘前统一归一化为 127.0.0.1。 */
  gatewayBaseUrl?: string;
  /** 写入受管配置的本地网关占位 token；缺省 deepaa-gateway。 */
  gatewayBearerToken?: string;
  codexCatalogTemplatePath?: string;
  codexCatalogOverridesPath?: string;
  /** OpenCode 全局配置文件；显式提供时跳过平台路径探测。 */
  opencodeConfigPath?: string;
  /** dsh settings.yaml；显式提供时跳过平台路径探测。 */
  dshSettingsPath?: string;
  /** dsh 凭据文件；显式提供时跳过平台路径探测。 */
  dshCredentialsPath?: string;
  /** dsh profile patch（cordis.patch.yml）写入目标；键为 profile 名（web/desktop），显式提供时跳过探测与布局判定。 */
  dshProfilePatchPaths?: Readonly<Record<string, string>>;
  /**
   * dsh 配置布局（测试注入位）：legacy-settings = 持续写 $DSH_HOME/settings.yaml；
   * profile-patch = 写 $DSH_HOME/profiles/<name>/cordis.patch.yml。生产缺省由
   * sync-context 探测 settings.yaml.imported 迁移痕迹决定，显式注入优先。
   */
  dshConfigLayout?: DshConfigLayout;
  /**
   * dsh 已存在的 profile 名单（测试注入位）：受管 patch 只写已初始化的 profile
   * 目录，绝不凭空创建（缺 package.json 骨架的目录会让 dsh profile 加载失败）；
   * 生产由 sync-context 探测 $DSH_HOME/profiles/<name> 目录存在性。
   */
  dshProfileNames?: readonly string[];
  /** ZCode 桌面 App provider 配置（v2/config.json，legacy 层）；显式提供时跳过平台路径探测。 */
  zcodeConfigPath?: string;
  /** ZCode 个人供应商规则层（v2/provider_config.json，新架构真相文件）；显式提供时跳过平台路径探测。 */
  zcodeProviderConfigPath?: string;
  /** ZCode 同步状态文件；显式提供时跳过平台路径探测。 */
  zcodeStatePath?: string;
}

/** 公共同步上下文：每个 adapter 的 resolvePaths/build/merge 都只消费它。 */
export interface CliSyncContext {
  readonly config: ProxyConfig;
  readonly paths: CliSyncPaths;
  readonly template: CatalogTemplate;
  readonly overrides: CatalogOverrides;
  /**
   * 价格中心条目索引（按条目 id；2026-09-21 能力下发）：供 model-capabilities 共享解析层
   * 按 modelVendors[modelId].priceEntryId 精确命中。缺省 = 解析层跳过价格中心级
   * （价格中心读取失败绝不阻断同步）。
   */
  readonly pricingEntriesById?: ReadonlyMap<string, ModelPriceEntry>;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** 已归一化（去尾部斜杠）的本地网关入口。 */
  readonly gatewayBaseUrl: string;
  readonly gatewayBearerToken: string;
  /** dsh 配置布局（探测结果或测试注入）：决定受管分节写 settings.yaml 还是 profile patch。 */
  readonly dshConfigLayout: DshConfigLayout;
  /** dsh 已初始化的 profile 名单（探测结果或测试注入）：受管 patch 的写入目标集合。 */
  readonly dshProfileNames: readonly string[];
  /**
   * 本机 Claude CLI 登录态（2026-10-08 路由级订阅透传；2026-10-09 收缩为
   * claude-only）：由 sync-manager 编排层探测（存在 anthropic-subscription
   * 预设路由时才探测）注入；缺省视为未登录。codex 侧因 ChatGPT 原生 wire
   * 阻断已回退恒占位 token（见 adapters/codex.ts），不再探测其登录态。
   * 探测本身绝不让同步失败。
   */
  readonly cliLogin?: {readonly claude: boolean};
}

/** 单个受管文件的声明（白名单、格式、命名空间与字节预算）。 */
export interface CliConfigFileSpec {
  readonly id: string;
  readonly kind: CliFileKind;
  /** 展示与校验用受管命名空间说明，例如 ["model_providers.deepaa_gateway"]。 */
  readonly managedNamespaces: readonly string[];
  readonly description: string;
  /** 单文件字节预算，缺省 1 MiB。 */
  readonly maxBytes?: number;
  /**
   * 敏感凭据文件（如 dsh 的 ~/.dsh/.credentials.yaml）：同步跳过真实密钥扫描与备份，
   * 只 patch 占位 refs 键；Agent 接入页按需查看默认局部隐藏，用户显式展开后才展示本地原值。
   */
  readonly sensitive?: boolean;
  /**
   * 文件本身合法包含用户自有密钥（如 ZCode config.json 的其它供应商条目）：
   * 跳过密钥扫描（避免用户既有密钥误报阻断同步），但保留写入前备份；
   * 与 sensitive 的区别在于仍执行完整备份。适配器产出的受管层自身仍须通过校验。
   */
  readonly skipSecretScan?: boolean;
}

/** 待写文件产物：受管层或清理层。 */
export interface CliFileArtifact {
  readonly specId: string;
  readonly path: string;
  readonly kind: CliFileKind;
  /** true=写入受管配置；false=只清理旧受管段（清理层）。 */
  readonly active: boolean;
  /** 期望写入原文（生成内容或清理层内容）。 */
  readonly content: string;
  /** 可展示说明（例如“新建 opencode.jsonc”）。 */
  readonly note?: string;
}

/** adapter 解析出的待处理文件路径集合。 */
export interface CliResolvedPaths {
  /** specId → 文件路径；Claude 项目 settings 会有多条同 specId 路径。 */
  readonly filePaths: Readonly<Record<string, string>>;
  /** 供 UI / 日志展示的附加路径（如 Codex catalog）。 */
  readonly extraPaths?: readonly string[];
}

/** 单个 Agent 的完整生成计划。 */
export interface AgentCliPlan {
  readonly agent: AgentId;
  readonly active: boolean;
  /**
   * 链路瞬时不合格的保守计划：跳过该 Agent 的一切文件写入（既不写受管配置，
   * 也不写清理层），保留磁盘现状并透出 warning。只有显式断开（未接入/关闭
   * 同步）才允许清理层破坏性移除受管分节（2026-09-02 用户确认的 fail-safe 语义）。
   */
  readonly preserve?: boolean;
  readonly artifacts: readonly CliFileArtifact[];
  readonly warnings: readonly CliSyncWarning[];
  readonly notes?: readonly string[];
}

/** 脱敏预览：只返回摘要，不返回用户完整配置内容。 */
export interface AgentCliPreviewFile {
  readonly specId: string;
  readonly path: string;
  readonly kind: CliFileKind;
  readonly active: boolean;
  readonly bytes: number;
  readonly note?: string;
}

export interface AgentCliPreview {
  readonly agent: AgentId;
  readonly active: boolean;
  readonly files: readonly AgentCliPreviewFile[];
  readonly warnings: readonly CliSyncWarning[];
  readonly notes: readonly string[];
}

/** Agent 特有适配器接口：公共引擎只调用这 6 个方法。 */
export interface AgentCliConfigAdapter {
  readonly agent: AgentId;
  /** 声明可能写入的文件，用于路径白名单、预览与回滚。 */
  readonly files: readonly CliConfigFileSpec[];
  /** 只做路径决策，不做 I/O。 */
  resolvePaths(context: CliSyncContext): CliResolvedPaths;
  /** 生成受管层；inactive 时也必须生成清理层。 */
  build(context: CliSyncContext, paths: CliResolvedPaths): AgentCliPlan;
  /** 对单个文件做 Agent 特有深合并；输入为已有原文，输出为待写原文。 */
  mergeFile(input: {
    file: CliConfigFileSpec;
    existingRaw: string | undefined;
    artifact: CliFileArtifact;
  }): string;
  /** 写入前校验：受管键、占位 token、模型格式、无真实密钥。 */
  validate(plan: AgentCliPlan): void;
  /** API / UI 预览，只返回脱敏摘要。 */
  describe(plan: AgentCliPlan): AgentCliPreview;
}

/** 模型 wire API 能力过滤：返回允许的 wire API 子集。 */
export function filterModelWireApis(
  declared: readonly WireApi[] | undefined,
  available: readonly WireApi[],
): WireApi[] {
  if (!Array.isArray(declared) || declared.length === 0) return [];
  return available.filter(wireApi => declared.includes(wireApi));
}
