import { access, realpath, stat } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, delimiter, dirname, join } from "path";
import type { DevelopmentCli, PlatformCapabilities, TerminalCapability } from "./types";
import {LAUNCH_EXECUTABLE_BY_AGENT, agentLaunchStrategy, launchStrategyList} from "./strategies";
import {
  cleanupTerminalLaunchPlan,
  prepareTerminalLaunchPlan,
} from "./terminal-launch-plan";
import {
  type CommandSpec,
  type DevelopmentCommandRunner,
  type DevelopmentPlatformAdapter,
  type DirectorySelection,
  type PlatformAdapterOptions,
  type TerminalLaunchRequest,
  runDevelopmentCommand,
} from "./platform";

export const TERMINAL_APP_DIRECT_COMMAND_MAX_BYTES = 1024;

const DIRECTORY_PICKER_SCRIPT = String.raw`
try
  set chosenFolder to choose folder with prompt "选择项目目录"
  return POSIX path of chosenFolder
on error number -128
  return "__DEEPAA_CANCELLED__"
end try`;

/** 标签页 UI 自动化不可用时回退可见新窗口，不能让宿主应用权限阻断 CLI 启动。 */
const TERMINAL_APP_LAUNCH_SCRIPT = String.raw`
on run argv
  set launchCommand to item 1 of argv
  tell application "Terminal"
    set hasOpenWindow to (count of windows) > 0
    activate
    if hasOpenWindow then
      set originalWindowCount to count of windows
      try
        tell application "System Events"
          tell process "Terminal"
            set frontmost to true
            click menu item 1 of menu 1 of menu item 2 of menu "Shell" of menu bar item "Shell" of menu bar 1
          end tell
        end tell
        set tabCreated to false
        repeat 50 times
          if (count of windows) > originalWindowCount then
            set tabCreated to true
            exit repeat
          end if
          delay 0.02
        end repeat
        if not tabCreated then error "TERMINAL_TAB_CREATION_FAILED"
        do script launchCommand in selected tab of front window
      on error
        do script launchCommand
      end try
    else
      do script launchCommand
    end if
  end tell
end run`;

const ITERM_LAUNCH_SCRIPT = String.raw`
on run argv
  set launchCommand to item 1 of argv
  tell application "iTerm"
    activate
    if (count of windows) > 0 then
      tell current window
        set launchTab to (create tab with default profile)
      end tell
      tell current session of launchTab to write text launchCommand
    else
      set launchWindow to (create window with default profile)
      tell current session of launchWindow to write text launchCommand
    end if
  end tell
end run`;

export function buildMacDirectoryPickerCommand(): CommandSpec {
  return { command: "/usr/bin/osascript", args: ["-e", DIRECTORY_PICKER_SCRIPT] };
}

export function buildMacTerminalCommand(input: {
  terminalId: string;
  projectDir: string;
  executablePath: string;
  args: string[];
  environment: Record<string, string>;
}): CommandSpec {
  if (input.terminalId !== "terminal.app" && input.terminalId !== "iterm2") {
    throw new Error("TERMINAL_NOT_FOUND");
  }
  return {
    command: "/usr/bin/osascript",
    args: [
      "-e",
      input.terminalId === "terminal.app" ? TERMINAL_APP_LAUNCH_SCRIPT : ITERM_LAUNCH_SCRIPT,
      "--",
      buildPosixLaunchLine(input),
    ],
  };
}

export function requiresTerminalLaunchPlan(input: TerminalLaunchRequest): boolean {
  if (input.terminalId !== "terminal.app") return false;
  const directCommand = buildMacTerminalCommand(input);
  return macTerminalLaunchBytes(directCommand) >= TERMINAL_APP_DIRECT_COMMAND_MAX_BYTES;
}

/** AppleScript 只接收完整命令参数，不把用户路径插入脚本源码。 */
function buildPosixLaunchLine(input: {
  projectDir: string;
  executablePath: string;
  args: string[];
  environment: Record<string, string>;
}): string {
  const environment = Object.entries(input.environment).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error("INVALID_LAUNCH_ENVIRONMENT");
    return `${key}=${quotePosixArgument(value)}`;
  });
  const executable = [input.executablePath, ...input.args]
    .map(quotePosixArgument)
    .join(" ");
  const launch = environment.length > 0
    ? `env ${environment.join(" ")} ${executable}`
    : executable;
  return `cd ${quotePosixArgument(input.projectDir)} && ${launch}`;
}

function quotePosixArgument(value: string): string {
  if (/[\u0000\r\n]/u.test(value)) throw new Error("INVALID_LAUNCH_ARGUMENT");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class MacDevelopmentPlatformAdapter implements DevelopmentPlatformAdapter {
  readonly platform = "darwin" as const;
  private readonly run: DevelopmentCommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly tempRoot: string;
  private readonly nodeExecutable: string;
  private readonly developmentLaunchHelperPath: string;

  constructor(options: PlatformAdapterOptions = {}) {
    this.run = options.run || runDevelopmentCommand;
    this.env = options.env || process.env;
    this.homeDir = options.homeDir || homedir();
    this.tempRoot = options.tempRoot || join(tmpdir(), "deepaa-launch");
    this.nodeExecutable = options.nodeExecutable || process.execPath;
    this.developmentLaunchHelperPath = options.developmentLaunchHelperPath
      || join(process.cwd(), "bin", "development-launch.mjs");
  }

  /** 探测结果进程级缓存：zsh 登录壳 command -v / 终端存在性探测都很重，60s 内复用。 */
  private static readonly PROBE_TTL_MS = 60_000;
  private executableProbeCache = new Map<DevelopmentCli, {value: string | null; expires: number}>();
  private terminalsProbeCache: {value: TerminalCapability[]; expires: number} | null = null;

  async detectCapabilities(): Promise<PlatformCapabilities> {
    const cliPaths = await Promise.all(launchStrategyList().map(strategy =>
      this.resolveExecutable(strategy.agent),
    ));
    // 按键访问，禁止位置索引（新增 Agent 时避免错位）。
    const pathByCli = new Map<DevelopmentCli, string | null>(
      launchStrategyList().map((strategy, index) => [strategy.agent as DevelopmentCli, cliPaths[index]]),
    );
    const [terminals, credentialStoreAvailable, dshLaunch, dshDesktopApp, zcodeApp] = await Promise.all([
      this.listTerminals(),
      pathExists("/usr/bin/security"),
      this.resolveDshLaunch(pathByCli.get("dsh")).catch(() => null),
      detectDshDesktopAppImpl(),
      detectZcodeApp(),
    ]);
    // 能力组装按策略声明的探测类型分发（2026-09-14 策略化二期）：
    // path→可执行文件存在性、dsh-channel→通道探测、zcode-app→安装位置探测。
    const agents: PlatformCapabilities["agents"] = {};
    for (const strategy of launchStrategyList()) {
      if (strategy.capabilityProbe === "dsh-channel") {
        agents[strategy.agent] = dshLaunch
          ? {
            available: true,
            executablePath: dshLaunch.executablePath,
            launchChannel: dshLaunch.channel,
            ...(dshDesktopApp ? {appPath: dshDesktopApp} : {}),
          }
          : {available: false};
      } else if (strategy.capabilityProbe === "zcode-app") {
        agents[strategy.agent] = zcodeApp ?? {available: false};
      } else {
        agents[strategy.agent] = executableCapability(
          pathByCli.get(strategy.agent) ?? null,
        );
      }
    }
    return {
      supported: true,
      platform: "darwin",
      agents,
      terminals,
      credentialStoreAvailable,
    };
  }

  async selectDirectory(): Promise<DirectorySelection> {
    const result = await this.run(buildMacDirectoryPickerCommand(), { timeoutMs: 5 * 60_000 });
    if (result.exitCode !== 0) throw new Error("DIRECTORY_PICKER_FAILED");
    const selected = result.stdout.trim();
    if (!selected || selected === "__DEEPAA_CANCELLED__") return { cancelled: true };
    const canonicalPath = await realpath(selected);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error("INVALID_PROJECT_DIR");
    return { cancelled: false, path: canonicalPath, name: basename(canonicalPath) };
  }

  async resolveExecutable(cli: DevelopmentCli): Promise<string | null> {
    const cached = this.executableProbeCache.get(cli);
    if (cached && Date.now() < cached.expires) return cached.value;
    const value = await this.resolveExecutableUncached(cli);
    this.executableProbeCache.set(cli, {value, expires: Date.now() + MacDevelopmentPlatformAdapter.PROBE_TTL_MS});
    return value;
  }

  private async resolveExecutableUncached(cli: DevelopmentCli): Promise<string | null> {
    const executable = LAUNCH_EXECUTABLE_BY_AGENT[cli];
    const direct = await findExecutableOnPath(executable, this.env.PATH || "");
    if (direct) return direct;
    // PATH 优先，随后是注册表声明的 home 白名单安装路径（禁止扫描 npx cache）。
    for (const candidate of agentLaunchStrategy(cli).executableCandidates) {
      const path = join(this.homeDir, candidate);
      if (await pathExists(path)) return path;
    }
    const result = await this.run({
      command: "/bin/zsh",
      args: ["-lic", `command -v ${executable}`],
    }).catch(() => undefined);
    if (!result || result.exitCode !== 0) return null;
    const path = result.stdout.trim().split(/\r?\n/).at(-1) || "";
    return path.startsWith("/") && await pathExists(path) ? path : null;
  }

  /**
   * dsh 启动通道解析（只读探测、不安装、不触发任何网络请求）：
   * 1. PATH 全局 dsh → path 通道；
   * 2. 否则找 npx（PATH 或 Node 同目录）→ npx 通道（免安装启动，首次自动下载、之后走 npx 缓存）；
   * 3. 都没有 → null。
   */
  async resolveDshLaunch(preResolvedDsh?: string | null): Promise<{executablePath: string; channel: "path" | "npx"} | null> {
    const direct = preResolvedDsh ?? await this.resolveExecutable("dsh");
    if (direct) return {executablePath: direct, channel: "path"};
    const npxPath = await findExecutableOnPath("npx", this.env.PATH || "")
      || (await pathExists(join(dirname(this.nodeExecutable), "npx")) ? join(dirname(this.nodeExecutable), "npx") : null);
    if (!npxPath) return null;
    return {executablePath: npxPath, channel: "npx"};
  }

  /** dsh 桌面客户端（DeepSeek Harness）安装位置探测（只读）。 */
  async detectDshDesktopApp(): Promise<string | null> {
    return detectDshDesktopAppImpl();
  }

  /** ZCode 桌面 App 运行检测：pgrep 精确匹配主 App 二进制名，避免误报。 */
  async isZcodeAppRunning(): Promise<boolean> {
    const result = await this.run({
      command: "/usr/bin/pgrep",
      args: ["-x", "ZCode"],
    }).catch(() => undefined);
    return result?.exitCode === 0;
  }

  /** ZCode 已运行时的焦点切换：open -a 对已运行 App 是激活而非重启。 */
  async activateZcodeApp(appPath: string): Promise<boolean> {
    const result = await this.run({
      command: "/usr/bin/open",
      args: ["-a", appPath],
    }).catch(() => undefined);
    return result?.exitCode === 0;
  }

  async listTerminals(): Promise<TerminalCapability[]> {
    if (this.terminalsProbeCache && Date.now() < this.terminalsProbeCache.expires) {
      return this.terminalsProbeCache.value;
    }
    const [terminal, iterm] = await Promise.all([
      pathExists("/System/Applications/Utilities/Terminal.app"),
      pathExists("/Applications/iTerm.app"),
    ]);
    const value = [
      { id: "terminal.app", label: "Terminal", available: terminal },
      { id: "iterm2", label: "iTerm2", available: iterm },
    ];
    this.terminalsProbeCache = {value, expires: Date.now() + MacDevelopmentPlatformAdapter.PROBE_TTL_MS};
    return value;
  }

  async openTerminal(request: TerminalLaunchRequest): Promise<void> {
    let command = buildMacTerminalCommand(request);
    let runtimeDirectory: string | undefined;
    if (requiresTerminalLaunchPlan(request)) {
      const prepared = await prepareTerminalLaunchPlan({
        tempRoot: this.tempRoot,
        nodeExecutable: this.nodeExecutable,
        helperPath: this.developmentLaunchHelperPath,
        request,
      });
      runtimeDirectory = prepared.runtimeDirectory;
      command = buildMacTerminalCommand(prepared.helperRequest);
      if (macTerminalLaunchBytes(command) >= TERMINAL_APP_DIRECT_COMMAND_MAX_BYTES) {
        await cleanupTerminalLaunchPlan(runtimeDirectory);
        throw new Error("TERMINAL_LAUNCH_FAILED");
      }
    }
    try {
      const result = await this.run(command);
      if (result.exitCode !== 0) throw new Error("TERMINAL_LAUNCH_FAILED");
    } catch (error) {
      if (runtimeDirectory) await cleanupTerminalLaunchPlan(runtimeDirectory);
      throw error;
    }
  }
}

function macTerminalLaunchBytes(command: CommandSpec): number {
  return Buffer.byteLength(command.args.at(-1) || "", "utf8");
}

/**
 * ZCode 桌面 App 探测（只读）：标准 /Applications 安装位置 + Info.plist 版本。
 * App 形态没有 PATH 可执行文件，不参与 resolveExecutable 链路。
 */
async function detectZcodeApp(): Promise<{available: boolean; appPath?: string; version?: string} | null> {
  const appPath = "/Applications/ZCode.app";
  if (!(await pathExists(appPath))) return null;
  return {available: true, appPath};
}

/**
 * dsh 桌面客户端（DeepSeek Harness）安装位置探测（只读）：dmg 拖入的
 * /Applications 与用户级 ~/Applications 两个标准位置；未安装返回 null。
 */
async function detectDshDesktopAppImpl(): Promise<string | null> {
  const candidates = [
    "/Applications/DeepSeek Harness.app",
    join(homedir(), "Applications", "DeepSeek Harness.app"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function findExecutableOnPath(name: string, rawPath: string): Promise<string | null> {
  for (const directory of rawPath.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

function executableCapability(
  executablePath: string | null,
): { available: boolean; executablePath?: string; version?: string } {
  if (!executablePath) return { available: false };
  // 版本字段不参与启动门禁；只确认路径存在，避免打开弹窗时启动 CLI 初始化进程。
  return { available: true, executablePath };
}
