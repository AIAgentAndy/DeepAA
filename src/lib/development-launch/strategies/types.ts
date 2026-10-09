import type {ConfigSyncReport} from "@/lib/config-sync/sync-manager";
import type {CliSyncWarning} from "@/lib/config-sync/core/types";
import type {
  AgentId,
  AgentLaunchPreferences,
  ProxyConfig,
  ProxyTarget,
  WireApi,
} from "@/types";
import type { DevelopmentLaunchCommand, DevelopmentLaunchCommandInput, DevelopmentManualOverrides } from "../launch-plan";
import type {AgentLaunchDeclarations, AgentLaunchMode} from "./contracts";
import type { DevelopmentPlatformAdapter } from "../platform";
import type { LaunchConfigurationResolution, PlatformCapabilities } from "../types";

/**
 * Agent 启动策略契约（docs/上线前架构升级改造.md §10.2）。
 *
 * 每个 Agent 一个策略文件（strategies/<agent>.ts），声明其全部「CLI 面」数据与
 * 行为钩子；service/platform/launch-plan 只消费本接口做通用编排。新增 Agent =
 * 新增一个策略文件 + index 注册一行，公共链路零改动（由「假想 Agent 接入演练」
 * 验收测试锁定该契约）。
 */

// 声明性数据字段与类型位于 client-safe 的 ./contracts（UI 消费）；
// 本接口在声明之上附加行为钩子（仅服务端策略文件实现）。
export type {
  AgentLaunchForm,
  AgentLaunchMode,
  ProjectDirPolicy,
  TerminalPolicy,
} from "./contracts";

/** 可执行解析结果（start 阶段）。 */
export interface StrategyExecutable {
  executablePath: string;
  /** dsh 启动通道（path/npx）。 */
  channel?: "path" | "npx";
  /** 常驻实例已在运行（dsh Web 端口 / zcode App 单例）。 */
  alreadyRunning?: boolean;
}

/** 可执行解析钩子上下文（service 注入平台句柄与探测函数）。 */
export interface StrategyExecutableContext {
  platform: DevelopmentPlatformAdapter;
  capabilities(): Promise<PlatformCapabilities>;
  /** 端口探测（测试可注入）；缺省 net 短超时探测。 */
  portProbe(port: number): Promise<boolean>;
}

/** 命令参数构造输入（launch-plan 校验后传入）。 */
export interface StrategyCommandArgsInput {
  input: DevelopmentLaunchCommandInput & {
    manualOverrides: DevelopmentManualOverrides;
  };
  targetId: string;
  /** 官方直连形态启动时为 undefined（无网关模型概念），网关形态必填。 */
  resolvedModel: string | undefined;
}

export interface StrategyCommandArgs {
  args: string[];
  environment: Record<string, string>;
}

/** 启动执行钩子上下文（service 注入全部执行依赖）。 */
export interface StrategyExecuteContext {
  homeDir: string;
  target: ProxyTarget;
  /** 官方直连形态启动时为 undefined（无网关模型概念），网关形态必填。 */
  resolvedModel: string | undefined;
  manualOverrides: DevelopmentManualOverrides;
  executablePath: string;
  projectDir: string | undefined;
  /** 请求携带的终端选择（可能是专用终端 id，如 codex-client）。 */
  requestedTerminal: string | undefined;
  isClientTerminal: boolean;
  /** 生效启动形态（fixedLaunchMode ?? 请求值；请求未携带时为 undefined，策略按非 app 形态兜底）。 */
  launchMode: AgentLaunchMode | undefined;
  /** 可执行解析阶段的 alreadyRunning（dsh 端口 / zcode 单例）。 */
  alreadyRunning: boolean;
  /**
   * 官方直连形态启动（声明 supportsOfficialFormLaunch 且 cliSyncEnabled=false）：
   * 策略必须跳过一切受管配置写入与网关参数注入，原生拉起 CLI/客户端。
   */
  officialFormLaunch: boolean;
  /** launch-plan 产出的命令（终端路径使用）。 */
  command: DevelopmentLaunchCommand;
  configOps: {
    reload(): Promise<void>;
    getConfig(): ProxyConfig;
    /** 返回 CLI 同步报告（默认实现携带 warnings/preserve 信息；测试桩可返回 void）。
     * options.agents 定向同步（2026-10-06）：启动前只刷本次启动的 Agent。 */
    syncer(config: ProxyConfig, options?: {agents?: readonly AgentId[]}): Promise<ConfigSyncReport | void>;
  };
  launchers: {
    codexClient(executablePath: string, workspacePath?: string): void;
    zcodeApp(appPath: string, workspacePath?: string): void;
    /** dsh 桌面客户端（DeepSeek Harness）拉起/聚焦；app 形态不走终端。 */
    dshDesktopApp(appPath: string): void;
  };
  platform: DevelopmentPlatformAdapter;
}

export interface AgentLaunchStrategy extends AgentLaunchDeclarations {

  // ———————— 行为钩子 ————————

  /** 可执行解析；缺省实现 = platform.resolveExecutable(agent)。 */
  resolveExecutable?(ctx: StrategyExecutableContext): Promise<StrategyExecutable>;

  /** 模型 wire API 契约（返回实际 wireApi；违约抛 MODEL_WIRE_API_UNSUPPORTED）。 */
  resolveLaunchWireApi?(config: ProxyConfig, target: ProxyTarget, modelId: string): WireApi | undefined;

  /** 预检配置解析。 */
  resolveConfiguration(input: {
    homeDir: string;
    projectDir?: string;
    profile?: string;
  }): Promise<LaunchConfigurationResolution>;

  /** 会话恢复 ID 归一化；supportsResume=false 时非空值应抛 RESUME_NOT_SUPPORTED。 */
  normalizeResumeSessionId(value: unknown): string | undefined;

  /** 启动偏好归一化（值域校验）；全空返回 undefined。 */
  normalizePreferences(value: AgentLaunchPreferences | undefined): AgentLaunchPreferences | undefined;

  /** 命令参数构造（终端形态）。 */
  buildCommandArgs(input: StrategyCommandArgsInput): StrategyCommandArgs;

  /** 启动执行（三类标准路径助手位于 ./shared）；结果透出 preSync 的 CLI 同步警告。 */
  execute(ctx: StrategyExecuteContext): Promise<StrategyExecuteResult | void>;
}

/** 启动执行结果：syncWarnings 为启动前 preSync 收集的 CLI 同步警告（preserve/回退类），供弹窗如实展示。 */
export interface StrategyExecuteResult {
  syncWarnings?: readonly CliSyncWarning[];
}
