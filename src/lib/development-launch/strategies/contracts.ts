import type {AgentId} from "@/types";
import {GATEWAY_PLACEHOLDER_TOKEN} from "@/lib/config-sync/core/placeholder-auth";

/**
 * Agent 启动策略的声明层（client-safe 纯数据，零 Node 依赖）。
 *
 * UI（启动弹窗等客户端组件）只消费本文件的声明字段；行为钩子（可执行探测、
 * 命令构造、执行动作）位于各 Agent 策略文件并引用 Node 模块，仅服务端可用。
 * 声明与行为在同一 Agent 的策略文件中拼装（strategies/<agent>.ts 以本声明为底、
 * 附加行为），保证单一事实来源的同时让客户端 bundle 不引入 Node 内置模块。
 */

export type AgentLaunchForm = "terminal-cli" | "desktop-app" | "web-service";
export type AgentLaunchMode = "tui" | "headless" | "web" | "app";
/** 项目目录严格性：required=必填校验；optional=选填（提供时仍校验存在性）。 */
export type ProjectDirPolicy = "required" | "optional";
/** 终端策略：standard=系统终端选择；none=无终端概念（App/Web 形态，用 fixedTerminalId）。 */
export type TerminalPolicy = "standard" | "none";

/** 会话恢复 ID 值域：codex 接受 UUID 或会话名称；claude 只接受 UUID；
 * opencode 接受 ses_ 前缀；dsh/zcode 不开放恢复。 */
export type ResumeIdKind = "uuid" | "codex-name-or-uuid" | "opencode-ses" | "unsupported";

/**
 * 弹窗高级设置字段名（advanced 状态键）。2026-10-02 参数分流规范：
 * 进程旗标类（manualOverrideKeys，经 -c/--flag 本次生效）与受管配置类
 * （launchPreferenceFields，经 launchPreferences 落库并写入目录/受管条目）
 * 由各 Agent 声明表唯一裁定，弹窗不得自带 agent 条件分派。
 */
export type LaunchAdvancedField =
  | "modelReasoningEffort"
  | "sandboxMode"
  | "permissionMode"
  | "modelContextWindow"
  | "modelAutoCompactTokenLimit"
  | "effortLevel"
  | "claudeMaxContextTokens"
  | "claudeAutoCompactTokens";

export interface AgentLaunchDeclarations {
  agent: AgentId;
  /** 会话恢复 ID 值域（UI 即时校验与服务端归一化共用同一实现）。 */
  resumeIdKind: ResumeIdKind;
  /** CLI 可执行名与 PATH 外的候选安装路径（相对 home；支持单个 `*` 通配目录段 =
   *  版本哈希目录，平台适配层枚举取 mtime 最新）。 */
  executable: string;
  executableCandidates: readonly string[];
  /** config-sync 适配器键名。 */
  configAdapter: AgentId;
  /** 启动形态。 */
  form: AgentLaunchForm;
  /** 支持的启动形态（UI 选择与输入校验）。 */
  launchModes: readonly AgentLaunchMode[];
  /** 固定启动形态（zcode=app；忽略用户选择）。 */
  fixedLaunchMode?: AgentLaunchMode;
  /** 项目目录严格性（codex 客户端模式的例外由 clientTerminalId 表达）。 */
  requiresProjectDir: ProjectDirPolicy;
  /** 专用终端模式 id（codex: codex-client）；命中时目录选填、跳过系统终端选择。 */
  clientTerminalId?: string;
  terminalPolicy: TerminalPolicy;
  /** terminalPolicy=none 时的固定终端标识（zcode: zcode-app）。 */
  fixedTerminalId?: string;
  /** 是否支持会话恢复。 */
  supportsResume: boolean;
  /** 环境注入（占位 token，绝不包含真实密钥）。 */
  launchEnv: Readonly<Record<string, string>>;
  /** 启动是否需要私有临时 settings（仅 Claude Code）。 */
  requiresTempSettings: boolean;
  /** 弹窗总是提交完整启动偏好、启动前落库的 Agent（codex/zcode/dsh/opencode）。 */
  consumesLaunchPreferences: boolean;
  /** 策略以进程旗标（-c / --flag / env）真正消费的弹窗高级字段白名单。 */
  manualOverrideKeys: readonly LaunchAdvancedField[];
  /** 经 launchPreferences 落库写入受管配置（codex 目录条目 / 其它 Agent 受管条目）的字段。 */
  launchPreferenceFields: readonly LaunchAdvancedField[];
  /** headless 一次性任务内容消费（opencode）。 */
  consumesHeadlessTask?: boolean;
  /**
   * 模型选择由受管配置默认模型承载（无 CLI 旗标）：opencode v2 TUI 已移除
   * -m 旗标（实测 v2.0.26 Unrecognized flag: -m 直接拒参退出），启动前须把
   * 本次所选模型预落库（service 扩展 pre-execute patch），随 preSync 写入
   * 受管配置 model 字段，TUI 启动即读到所选模型。声明驱动，勿写 agent 分派。
   */
  modelFromManagedConfig?: boolean;
  /**
   * 官方直连形态启动（2026-10-09 用户确认，本期仅 codex）：CLI 形态为官方模式
   * （cliSyncEnabled=false，受管层已清空）时，启动不注入任何网关参数、不写受管
   * 配置（含 config.toml 顶层默认模型——否则指向已删除的 provider），原生拉起
   * CLI/客户端；模型在官方客户端内选择，用量经通道 B 本地导入捕获。
   */
  supportsOfficialFormLaunch?: boolean;
  /** alreadyRunning 时响应体携带的标记键（UI 依据它打开浏览器/聚焦窗口）。 */
  alreadyRunningResponseKey?: "dshAlreadyRunning" | "zcodeAlreadyRunning";
  /** 平台能力探测类型：path=PATH 解析；dsh-channel=dsh 通道探测；zcode-app=桌面 App 安装位置。 */
  capabilityProbe: "path" | "dsh-channel" | "zcode-app";
}

export const AGENT_LAUNCH_DECLARATIONS: Readonly<Record<AgentId, AgentLaunchDeclarations>> = {
  codex: {
    agent: "codex",
    resumeIdKind: "codex-name-or-uuid",
    executable: "codex",
    // Windows 桌面客户端（MSIX）不注册 PATH codex 命令（应用别名仅
    // codex-chrome-native-host / codex-core-command-runner），核心 CLI 捆绑于
    // %LOCALAPPDATA%\OpenAI\Codex\bin\<版本哈希>\codex.exe（2026-10-11 实证
    // 0.162.0：完整 CLI，`codex app [PATH]` 可拉起桌面客户端）。相对 home 即
    // 下方通配候选，枚举哈希目录取 mtime 最新；macOS 无此路径自然跳过。
    // 这是安装位置探测，不是 npx 缓存扫描（禁扫 npx cache 的既有决策不变）。
    executableCandidates: ["AppData/Local/OpenAI/Codex/bin/*/codex.exe"],
    configAdapter: "codex",
    form: "terminal-cli",
    launchModes: ["tui"],
    requiresProjectDir: "required",
    clientTerminalId: "codex-client",
    terminalPolicy: "standard",
    supportsResume: true,
    launchEnv: {},
    requiresTempSettings: false,
    // 2026-10-02：上下文窗口/压缩阈值/推理档对网关模型由模型目录条目决定，
    // 弹窗高级设置经 launchPreferences 落库并写入目录条目（sandbox 仍走 CLI 参数）。
    consumesLaunchPreferences: true,
    manualOverrideKeys: ["sandboxMode"],
    launchPreferenceFields: ["modelReasoningEffort", "modelContextWindow", "modelAutoCompactTokenLimit"],
    // 官方直连形态启动（OpenAI 订阅预设：ChatGPT 原生 wire 无法经网关路由）。
    supportsOfficialFormLaunch: true,
    capabilityProbe: "path",
  },
  claude: {
    agent: "claude",
    resumeIdKind: "uuid",
    executable: "claude",
    executableCandidates: [],
    configAdapter: "claude",
    form: "terminal-cli",
    launchModes: ["tui"],
    requiresProjectDir: "required",
    terminalPolicy: "standard",
    supportsResume: true,
    launchEnv: {},
    requiresTempSettings: true,
    consumesLaunchPreferences: false,
    manualOverrideKeys: ["effortLevel", "permissionMode", "claudeMaxContextTokens", "claudeAutoCompactTokens"],
    launchPreferenceFields: [],
    capabilityProbe: "path",
  },
  opencode: {
    agent: "opencode",
    resumeIdKind: "opencode-ses",
    executable: "opencode",
    executableCandidates: [".opencode/bin/opencode", ".local/bin/opencode"],
    configAdapter: "opencode",
    form: "terminal-cli",
    launchModes: ["tui", "headless"],
    requiresProjectDir: "required",
    terminalPolicy: "standard",
    supportsResume: true,
    launchEnv: {DEEPAA_GATEWAY_TOKEN: GATEWAY_PLACEHOLDER_TOKEN},
    requiresTempSettings: false,
    consumesLaunchPreferences: true,
    consumesHeadlessTask: true,
    modelFromManagedConfig: true,
    manualOverrideKeys: [],
    launchPreferenceFields: ["modelReasoningEffort", "modelContextWindow"],
    capabilityProbe: "path",
  },
  dsh: {
    agent: "dsh",
    resumeIdKind: "unsupported",
    executable: "dsh",
    executableCandidates: [],
    configAdapter: "dsh",
    form: "web-service",
    // 双形态（2026-10-05）：web = 终端常驻 `dsh web`（3080）；app = 桌面客户端
    // （DeepSeek Harness.app，拉起/聚焦不走终端）。弹窗按客户端安装与否选择，
    // 已安装默认 app（dialog capabilities 加载后通用规则切换）。
    launchModes: ["web", "app"],
    // dsh web 命令仍在系统终端中启动（常驻服务日志留在终端窗口），走标准终端选择；
    // app 模式由 execute 分支拉起客户端，UI 以 launchMode 隐藏终端选择。
    requiresProjectDir: "optional",
    terminalPolicy: "standard",
    supportsResume: false,
    launchEnv: {DEEPAA_GATEWAY_TOKEN: GATEWAY_PLACEHOLDER_TOKEN},
    requiresTempSettings: false,
    consumesLaunchPreferences: true,
    alreadyRunningResponseKey: "dshAlreadyRunning",
    manualOverrideKeys: [],
    launchPreferenceFields: ["modelReasoningEffort", "permissionMode", "modelContextWindow"],
    capabilityProbe: "dsh-channel",
  },
  zcode: {
    agent: "zcode",
    resumeIdKind: "unsupported",
    executable: "zcode",
    executableCandidates: [],
    configAdapter: "zcode",
    form: "desktop-app",
    launchModes: ["app"],
    fixedLaunchMode: "app",
    requiresProjectDir: "optional",
    terminalPolicy: "none",
    fixedTerminalId: "zcode-app",
    supportsResume: false,
    // 凭据由配置文件条目承载，无需环境注入。
    launchEnv: {},
    requiresTempSettings: false,
    consumesLaunchPreferences: true,
    alreadyRunningResponseKey: "zcodeAlreadyRunning",
    manualOverrideKeys: [],
    launchPreferenceFields: ["modelReasoningEffort", "modelContextWindow"],
    capabilityProbe: "zcode-app",
  },
};

/** UI/服务端共用的声明读取入口（client-safe）。 */
export function agentLaunchDeclarations(agent: AgentId): AgentLaunchDeclarations {
  return AGENT_LAUNCH_DECLARATIONS[agent];
}

// ———————— 会话恢复 ID 归一化（UI 即时校验与服务端共用） ————————

const RESUME_SESSION_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const OPENCODE_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{8,128}$/u;
/** Codex 会话名称：resume 同时接受 UUID 与会话名称（桌面端/CLI 共享会话存储）。 */
const CODEX_SESSION_NAME_PATTERN = /^[\p{L}\p{N}][^\u0000-\u001f\u007f"'\\]{0,127}$/u;

/** 按值域归一化会话恢复 ID；空值返回 undefined（显式新建），非法值抛稳定错误码。 */
export function normalizeResumeSessionIdByKind(
  value: unknown,
  kind: ResumeIdKind,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("INVALID_RESUME_SESSION_ID");
  const normalized = value.trim().toLowerCase();
  // 空值表示显式新建会话，任何 Agent 都放行。
  if (!normalized) return undefined;
  if (kind === "unsupported") throw new Error("RESUME_NOT_SUPPORTED");
  if (kind === "opencode-ses") {
    if (!OPENCODE_SESSION_ID_PATTERN.test(value.trim())) {
      throw new Error("INVALID_RESUME_SESSION_ID");
    }
    return value.trim();
  }
  if (RESUME_SESSION_ID_PATTERN.test(normalized)) return normalized;
  if (kind === "codex-name-or-uuid" && CODEX_SESSION_NAME_PATTERN.test(value.trim())) {
    return value.trim();
  }
  throw new Error("INVALID_RESUME_SESSION_ID");
}
