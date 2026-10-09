import { access, realpath, stat } from "fs/promises";
import { homedir } from "os";
import { basename, delimiter, extname, join } from "path";
import type { DevelopmentCli, PlatformCapabilities, TerminalCapability } from "./types";
import {LAUNCH_EXECUTABLE_BY_AGENT, agentLaunchStrategy, launchStrategyList} from "./strategies";
import {
  type CommandSpec,
  type DevelopmentCommandRunner,
  type DevelopmentTerminalLauncher,
  type DevelopmentPlatformAdapter,
  type DirectorySelection,
  type PlatformAdapterOptions,
  type TerminalLaunchRequest,
  runDevelopmentCommand,
  launchDevelopmentTerminal,
} from "./platform";

const DIRECTORY_PICKER_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择项目目录'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
} else {
  [Console]::Out.Write('__DEEPAA_CANCELLED__')
}`;

const DIRECT_CLI_LAUNCH_SCRIPT = String.raw`
param(
  [string]$Executable,
  [string]$ArgumentsJson,
  [string]$WorkingDirectory,
  [string]$EnvironmentJson
)
$ErrorActionPreference = 'Stop'
$cliArguments = @(ConvertFrom-Json -InputObject $ArgumentsJson)
$environment = ConvertFrom-Json -InputObject $EnvironmentJson
foreach ($property in $environment.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}
Set-Location -LiteralPath $WorkingDirectory
& $Executable @cliArguments`;

export function windowsPowerShellPath(systemRoot = process.env.SystemRoot || "C:\\Windows"): string {
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function buildWindowsDirectoryPickerCommand(systemRoot?: string): CommandSpec {
  return {
    command: windowsPowerShellPath(systemRoot),
    args: ["-NoLogo", "-NoProfile", "-STA", "-Command", DIRECTORY_PICKER_SCRIPT],
  };
}

export function buildWindowsTerminalCommand(input: {
  terminalId: string;
  terminalExecutable: string;
  powershellExecutable: string;
  executablePath: string;
  args: string[];
  environment: Record<string, string>;
  projectDir: string;
}): CommandSpec {
  const powershellArguments = [
    "-NoLogo",
    "-NoProfile",
    "-NoExit",
    "-Command",
    DIRECT_CLI_LAUNCH_SCRIPT,
    input.executablePath,
    JSON.stringify(input.args),
    input.projectDir,
    JSON.stringify(input.environment),
  ];
  if (input.terminalId === "windows-terminal") {
    return {
      command: input.terminalExecutable,
      args: [
        "-w",
        "0",
        "new-tab",
        "-d",
        input.projectDir,
        input.powershellExecutable,
        ...powershellArguments,
      ],
    };
  }
  if (input.terminalId === "powershell") {
    return {
      command: input.powershellExecutable,
      args: powershellArguments,
    };
  }
  throw new Error("TERMINAL_NOT_FOUND");
}

export class WindowsDevelopmentPlatformAdapter implements DevelopmentPlatformAdapter {
  readonly platform = "win32" as const;
  private readonly run: DevelopmentCommandRunner;
  private readonly launch: DevelopmentTerminalLauncher;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;

  constructor(options: PlatformAdapterOptions = {}) {
    this.run = options.run || runDevelopmentCommand;
    this.launch = options.launch || launchDevelopmentTerminal;
    this.env = options.env || process.env;
    this.homeDir = options.homeDir || homedir();
  }

  /** 探测结果进程级缓存：Windows 可执行查找较重，60s 内复用。 */
  private static readonly PROBE_TTL_MS = 60_000;
  private executableProbeCache = new Map<DevelopmentCli, {value: string | null; expires: number}>();

  async detectCapabilities(): Promise<PlatformCapabilities> {
    const cliPaths = await Promise.all(launchStrategyList().map(strategy =>
      this.resolveExecutable(strategy.agent),
    ));
    // 按键访问，禁止位置索引（新增 Agent 时避免错位）。
    const pathByCli = new Map<DevelopmentCli, string | null>(
      launchStrategyList().map((strategy, index) => [strategy.agent as DevelopmentCli, cliPaths[index]]),
    );
    const [terminals, dshLaunch, dshDesktopApp, zcodeApp] = await Promise.all([
      this.listTerminals(),
      this.resolveDshLaunch(pathByCli.get("dsh")).catch(() => null),
      detectDshDesktopApp(this.env),
      detectZcodeApp(this.env),
    ]);
    const powershellAvailable = await pathExists(windowsPowerShellPath(this.env.SystemRoot));
    // 能力组装按策略声明的探测类型分发（2026-09-14 策略化二期）。
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
      platform: "win32",
      agents,
      terminals,
      credentialStoreAvailable: powershellAvailable,
    };
  }

  async selectDirectory(): Promise<DirectorySelection> {
    const result = await this.run(buildWindowsDirectoryPickerCommand(this.env.SystemRoot), {
      timeoutMs: 5 * 60_000,
    });
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
    this.executableProbeCache.set(cli, {value, expires: Date.now() + WindowsDevelopmentPlatformAdapter.PROBE_TTL_MS});
    return value;
  }

  private async resolveExecutableUncached(cli: DevelopmentCli): Promise<string | null> {
    const executable = LAUNCH_EXECUTABLE_BY_AGENT[cli];
    const direct = await findWindowsExecutable(executable, this.env);
    if (direct) return direct;
    for (const candidate of agentLaunchStrategy(cli).executableCandidates) {
      const path = join(this.homeDir, candidate);
      const found = await findWindowsExecutableWithExtensions(path, this.env);
      if (found) return found;
    }
    return null;
  }

  /** dsh 启动通道解析（只读探测、不安装、不触发网络请求）：PATH dsh → npx 免装通道。 */
  /** dsh 桌面客户端（DeepSeek Harness）安装位置探测（只读）。 */
  async detectDshDesktopApp(): Promise<string | null> {
    return detectDshDesktopApp(this.env);
  }

  async resolveDshLaunch(preResolvedDsh?: string | null): Promise<{executablePath: string; channel: "path" | "npx"} | null> {
    const direct = preResolvedDsh ?? await this.resolveExecutable("dsh");
    if (direct) return {executablePath: direct, channel: "path"};
    const npxPath = await findWindowsExecutable("npx", this.env);
    if (!npxPath) return null;
    return {executablePath: npxPath, channel: "npx"};
  }

  /** ZCode 桌面 App 运行检测：PowerShell 进程名查询。 */
  async isZcodeAppRunning(): Promise<boolean> {
    const result = await this.run({
      command: windowsPowerShellPath(this.env.SystemRoot),
      args: ["-NoLogo", "-NoProfile", "-Command", "Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue | Select-Object -First 1 | Measure-Object | ForEach-Object { $_.Count }"],
    }).catch(() => undefined);
    return result?.exitCode === 0 && result.stdout.trim() !== "0";
  }

  /** ZCode 已运行时的焦点切换：WScript AppActivate 按进程名前置窗口（尽力而为）。 */
  async activateZcodeApp(): Promise<boolean> {
    const result = await this.run({
      command: windowsPowerShellPath(this.env.SystemRoot),
      args: ["-NoLogo", "-NoProfile", "-Command", "(New-Object -ComObject WScript.Shell).AppActivate('ZCode') | Out-Null"],
    }).catch(() => undefined);
    return result?.exitCode === 0;
  }

  async listTerminals(): Promise<TerminalCapability[]> {
    const [windowsTerminal, powershell] = await Promise.all([
      findWindowsExecutable("wt", this.env),
      pathExists(windowsPowerShellPath(this.env.SystemRoot)),
    ]);
    return [
      {
        id: "windows-terminal",
        label: "Windows Terminal",
        available: Boolean(windowsTerminal),
        executablePath: windowsTerminal || undefined,
      },
      {
        id: "powershell",
        label: "PowerShell",
        available: powershell,
        executablePath: powershell ? windowsPowerShellPath(this.env.SystemRoot) : undefined,
      },
    ];
  }

  async openTerminal(request: TerminalLaunchRequest): Promise<void> {
    const terminals = await this.listTerminals();
    const selected = terminals.find(item => item.id === request.terminalId && item.available);
    if (!selected?.executablePath) throw new Error("TERMINAL_NOT_FOUND");
    const powershellExecutable = windowsPowerShellPath(this.env.SystemRoot);
    await this.launch(buildWindowsTerminalCommand({
      terminalId: request.terminalId,
      terminalExecutable: selected.executablePath,
      powershellExecutable,
      executablePath: request.executablePath,
      args: request.args,
      environment: request.environment,
      projectDir: request.projectDir,
    }), "win32");
  }
}

async function findWindowsExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const directory of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const found = await findWindowsExecutableWithExtensions(join(directory, name), env);
    if (found) return found;
  }
  return null;
}

/** 字面路径优先，其次按 PATHEXT 追加扩展名（兼容 .exe / .cmd）。 */
async function findWindowsExecutableWithExtensions(
  candidate: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (await pathExists(candidate)) return candidate;
  if (extname(candidate)) return null;
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map(value => value.toLowerCase());
  for (const extension of extensions) {
    const withExtension = `${candidate}${extension}`;
    if (await pathExists(withExtension)) return withExtension;
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

/**
 * dsh 桌面客户端（DeepSeek Harness）安装位置探测（只读）：NSIS per-user 默认
 * 安装于 %LOCALAPPDATA%\Programs\DeepSeek Harness\；未安装返回 null。
 * 真实可用性需 Windows 环境验收，此处仅做位置存在性判断。
 */
async function detectDshDesktopApp(env: NodeJS.ProcessEnv): Promise<string | null> {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  const candidate = join(localAppData, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");
  return await pathExists(candidate) ? candidate : null;
}

/**
 * ZCode 桌面 App 探测（只读）：按常见安装位置查找（LocalAppData 程序目录与
 * Program Files）；真实可用性需 Windows 环境验收，此处仅做位置存在性判断。
 */
async function detectZcodeApp(env: NodeJS.ProcessEnv): Promise<{available: boolean; appPath?: string; version?: string} | null> {
  const localAppData = env.LOCALAPPDATA;
  const candidates = [
    ...(localAppData ? [join(localAppData, "Programs", "ZCode", "ZCode.exe")] : []),
    join(env.ProgramFiles || "C:\\Program Files", "ZCode", "ZCode.exe"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return {available: true, appPath: candidate};
    }
  }
  return null;
}

function executableCapability(
  executablePath: string | null,
): { available: boolean; executablePath?: string; version?: string } {
  if (!executablePath) return { available: false };
  // 版本字段不参与启动门禁；只确认路径存在，避免打开弹窗时启动 CLI 初始化进程。
  return { available: true, executablePath };
}
