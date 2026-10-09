import type {AgentId} from "@/types";

export type DevelopmentCli = AgentId;
// 各 Agent CLI 可执行文件名的唯一来源已收敛到 strategies（LAUNCH_EXECUTABLE_BY_AGENT）。
export type SupportedDevelopmentPlatform = "darwin" | "win32";
export type ConfigSource = "project_local" | "project" | "profile" | "user" | "manual" | "unset";
export type ProjectTrust = "trusted" | "untrusted" | "unknown" | "not_configured";

export interface ResolvedConfigValue<T> {
  value?: T;
  source: ConfigSource;
  sourcePath?: string;
  overridable: boolean;
}

export interface ConfigurationWarning {
  code: "CONFIG_PARSE_FAILED" | "CONFIG_TOO_LARGE" | "CONFIG_READ_FAILED" | "INVALID_PROFILE";
  message: string;
  sourcePath: string;
}

/**
 * 预检配置回显字段（2026-10-02 收敛）：codex 的推理档/沙箱/上下文/压缩阈值改由
 * 目录能力值与 launchPreferences 决定（弹窗回显同源），不再从 config.toml 回显；
 * 此处只保留 Claude 进程旗标类字段（读取 ~/.claude/settings.json 真实状态）。
 */
export interface LaunchConfigurationFields {
  effortLevel: ResolvedConfigValue<string>;
  permissionMode: ResolvedConfigValue<string>;
  claudeMaxContextTokens: ResolvedConfigValue<number>;
}

export interface LaunchConfigurationResolution {
  cli: DevelopmentCli;
  model: ResolvedConfigValue<string>;
  modelOptions: string[];
  fields: LaunchConfigurationFields;
  projectTrust: ProjectTrust;
  warnings: ConfigurationWarning[];
}

export interface DevelopmentModelSelectionContext {
  vendor?: string;
  configuredModel?: {
    value: string;
    source: ConfigSource;
    available: boolean;
  };
}

export interface DevelopmentCredentialMetadata {
  id: string;
  targetId: string;
  label: string;
  /** 旧记录读取时归一化为 api_key。 */
  kind: "api_key" | "oauth";
  store: "macos-keychain" | "windows-credential-manager";
  account: string;
  fingerprintSuffix: string;
  /** OAuth 仅保存系统凭据引用与状态元数据，绝不保存 access/refresh token。 */
  oauth?: {
    provider: "openai";
    expiresAt: string;
    accessTokenCredentialId: string;
    refreshTokenCredentialId?: string;
    accountId?: string;
  };
  /** 该密钥对应的价格倍率，默认 1；代理按请求密钥读取并写入 raw 成本快照。 */
  rateMultiplier?: number;
  /**
   * 适用 Agent 白名单（codex / claude / opencode / dsh）；
   * 空/缺省 = 不允许任何 Agent（默认拒绝），只影响网关密钥池过滤与 CLI 同步，
   * 不影响凭据存取；新增 Agent 必须显式加入 scope。
   */
  agentScope?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TerminalCapability {
  id: string;
  label: string;
  available: boolean;
  executablePath?: string;
}

/** 单 Agent 能力（动态形状：新增 Agent 自动出现，UI/服务零改动）。 */
export interface AgentCapability {
  available: boolean;
  executablePath?: string;
  version?: string;
  /** dsh 启动通道：path=全局 dsh；npx=npx 免安装启动（首次自动下载、之后走缓存）。 */
  launchChannel?: DshLaunchChannel;
  /** zcode 为 Electron 桌面 App 形态：探测安装位置而非 PATH 可执行文件。 */
  appPath?: string;
}

export interface PlatformCapabilities {
  supported: boolean;
  platform: NodeJS.Platform;
  /** 按 Agent 键的能力集合（2026-09-14 策略化二期：固定字段改动态 Record）。 */
  agents: Record<string, AgentCapability>;
  terminals: TerminalCapability[];
  credentialStoreAvailable: boolean;
}

/** dsh 启动通道：PATH 全局安装 / npx 免安装启动（首次自动下载、之后走 npx 缓存）。 */
export type DshLaunchChannel = "path" | "npx";
