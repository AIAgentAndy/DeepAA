import { access, mkdir, realpath, stat, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { homedir, tmpdir } from "os";
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
  resolveWildcardExecutableCandidate,
  runDevelopmentCommand,
  launchDevelopmentTerminal,
} from "./platform";

/**
 * 目录选择对话框就绪标记：脚本在 ShowDialog 阻塞等待用户前写入 stdout，
 * Node 侧据此判定「对话框已弹出」，就绪超时到点未见标记则终止并报
 * DIRECTORY_PICKER_NOT_SHOWN（对话框被环境吞掉时不再干等总超时）。
 */
const DIRECTORY_PICKER_READY_MARKER = "__DEEPAA_DIALOG_UP__";
const DIRECTORY_PICKER_READY_TIMEOUT_MS = 30_000;
const DIRECTORY_PICKER_TOTAL_TIMEOUT_MS = 5 * 60_000;

/**
 * 置顶伴随进程（经 -EncodedCommand 注入隐藏子进程运行）：主进程对话框出现后，
 * 找到其可见的 #32770 对话框并直接 SetWindowPos(HWND_TOPMOST) + 请求前置。
 * 实测（2026-10-11）：仅凭属主窗体 TopMost（句柄未创建时设置）在部分后台进程
 * 上下文（如 Next.js 服务端拉起）不会传播到对话框（对话框 NOTOPMOST、被压在
 * 浏览器等窗口后且无任务栏入口，用户完全看不见）；对对话框本体施加置顶是
 * 上下文无关的确定性修复。新拉起的子进程有短暂前台权限，置顶后通常可一并
 * 拿到焦点；即使焦点被前台锁拒绝，置顶也保证可见可点。
 */
const DIRECTORY_PICKER_FORCE_TOPMOST_HELPER = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DeepAAPickerTopmost {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$pickerPid = __PICKER_PID__
$deadline = [DateTime]::UtcNow.AddSeconds(25)
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 150
  $script:found = [IntPtr]::Zero
  $cb = {
    param($hWnd, $lParam)
    $wpid = 0
    [Void][DeepAAPickerTopmost]::GetWindowThreadProcessId($hWnd, [Ref]$wpid)
    if ($wpid -eq $pickerPid -and [DeepAAPickerTopmost]::IsWindowVisible($hWnd)) {
      $cls = New-Object System.Text.StringBuilder 256
      [Void][DeepAAPickerTopmost]::GetClassName($hWnd, $cls, 256)
      if ($cls.ToString() -eq '#32770') { $script:found = $hWnd; return $false }
    }
    return $true
  }
  [Void][DeepAAPickerTopmost]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:found -ne [IntPtr]::Zero) {
    [Void][DeepAAPickerTopmost]::SetWindowPos($script:found, [IntPtr](-1), 0, 0, 0, 0, 0x3)
    [Void][DeepAAPickerTopmost]::SetForegroundWindow($script:found)
    break
  }
}`;

const DIRECTORY_PICKER_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择项目目录'
$dialog.ShowNewFolderButton = $false
$forcer = @'
${DIRECTORY_PICKER_FORCE_TOPMOST_HELPER}
'@
$forcer = $forcer.Replace('__PICKER_PID__', [string]$PID)
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($forcer))
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand', $encoded)
[Console]::Out.Write('${DIRECTORY_PICKER_READY_MARKER}')
[Console]::Out.Flush()
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
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

export function windowsCmdPath(systemRoot = process.env.SystemRoot || "C:\\Windows"): string {
  return join(systemRoot, "System32", "cmd.exe");
}

/** PowerShell 单引号字面量：内嵌单引号翻倍，任何内容安全固化进脚本。 */
function powershellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const CLI_LAUNCH_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 固化 CLI 启动脚本（tempRoot 下 launch_<uuid>.ps1）：环境变量、工作目录与
 * 参数全部烘焙进文件，cmd /c start 只携带简单路径参数，规避 cmd 对引号与
 * JSON 参数的二次解析破坏（实测 2026-10-11）。脚本由 service 的
 * cleanupExpiredLaunchArtifacts 按 24h 规则回收。
 */
async function writeWindowsCliLaunchScript(input: {
  tempRoot: string;
  executablePath: string;
  args: string[];
  environment: Record<string, string>;
  projectDir: string;
}): Promise<string> {
  await mkdir(input.tempRoot, {recursive: true});
  const scriptPath = join(input.tempRoot, `launch_${randomUUID().replaceAll("-", "")}.ps1`);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    ...Object.entries(input.environment)
      .filter(([key]) => CLI_LAUNCH_ENV_KEY_PATTERN.test(key))
      .map(([key, value]) => `$env:${key} = ${powershellSingleQuoted(String(value))}`),
    `Set-Location -LiteralPath ${powershellSingleQuoted(input.projectDir)}`,
    `& ${powershellSingleQuoted(input.executablePath)} @(${input.args.map(powershellSingleQuoted).join(", ")})`,
  ];
  await writeFile(scriptPath, lines.join("\r\n"), "utf8");
  return scriptPath;
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
  systemRoot?: string;
  /** powershell 终端：已固化的启动脚本路径（writeWindowsCliLaunchScript 产物）。 */
  launcherScriptPath?: string;
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
    // DETACHED + stdio ignore 直接 spawn powershell 实测无控制台（进程即死或
    // 不可见，CLI 静默失败）；cmd /c start 为目标进程显式创建新控制台（用户
    // 会话实测窗口可见可点，2026-10-11）。CLI 细节全部走 -File 固化脚本。
    if (!input.launcherScriptPath) throw new Error("TERMINAL_NOT_FOUND");
    return {
      command: windowsCmdPath(input.systemRoot),
      args: [
        "/c",
        "start",
        '"DeepAA"',
        input.powershellExecutable,
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        input.launcherScriptPath,
      ],
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
  private readonly tempRoot: string;

  constructor(options: PlatformAdapterOptions = {}) {
    this.run = options.run || runDevelopmentCommand;
    this.launch = options.launch || launchDevelopmentTerminal;
    this.env = options.env || process.env;
    this.homeDir = options.homeDir || homedir();
    this.tempRoot = options.tempRoot || join(tmpdir(), "deepaa-launch");
  }

  /**
   * 探测结果进程级缓存：与 macOS 同规则——成功长缓存（安装位置低频变化），
   * 失败短缓存（用户装好 CLI 后重开弹窗即可见）。
   */
  private static readonly PROBE_SUCCESS_TTL_MS = 30 * 60_000;
  private static readonly PROBE_FAILURE_TTL_MS = 60_000;
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
      timeoutMs: DIRECTORY_PICKER_TOTAL_TIMEOUT_MS,
      readyMarker: DIRECTORY_PICKER_READY_MARKER,
      readyTimeoutMs: DIRECTORY_PICKER_READY_TIMEOUT_MS,
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "COMMAND_NOT_READY") {
        throw new Error("DIRECTORY_PICKER_NOT_SHOWN");
      }
      throw error;
    });
    if (result.exitCode !== 0) throw new Error("DIRECTORY_PICKER_FAILED");
    // stdout 形如「<就绪标记><所选路径>」：剥离标记后解析，兼容标记与路径同块到达。
    const selected = result.stdout.split(DIRECTORY_PICKER_READY_MARKER).join("").trim();
    if (!selected || selected === "__DEEPAA_CANCELLED__") return { cancelled: true };
    const canonicalPath = await realpath(selected);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error("INVALID_PROJECT_DIR");
    return { cancelled: false, path: canonicalPath, name: basename(canonicalPath) };
  }

  async resolveExecutable(cli: DevelopmentCli): Promise<string | null> {
    const cached = this.executableProbeCache.get(cli);
    if (cached && Date.now() < cached.expires) return cached.value;
    const value = await this.resolveExecutableUncached(cli);
    this.executableProbeCache.set(cli, {
      value,
      expires: Date.now() + (value
        ? WindowsDevelopmentPlatformAdapter.PROBE_SUCCESS_TTL_MS
        : WindowsDevelopmentPlatformAdapter.PROBE_FAILURE_TTL_MS),
    });
    return value;
  }

  private async resolveExecutableUncached(cli: DevelopmentCli): Promise<string | null> {
    const executable = LAUNCH_EXECUTABLE_BY_AGENT[cli];
    const direct = await findWindowsExecutable(executable, this.env);
    if (direct) return direct;
    for (const candidate of agentLaunchStrategy(cli).executableCandidates) {
      const path = join(this.homeDir, candidate);
      // 通配候选（版本哈希目录，如 Codex 桌面客户端捆绑 CLI）：枚举取 mtime 最新；
      // 候选已带显式 .exe，不走 PATHEXT 扩展名解析。
      const found = candidate.includes("*")
        ? await resolveWildcardExecutableCandidate(path)
        : await findWindowsExecutableWithExtensions(path, this.env);
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
    if (request.terminalId === "powershell") {
      // 传统 PowerShell：先固化 CLI 启动脚本，再经 cmd /c start 建新控制台
      //（直接 DETACHED spawn 实测无控制台，见 buildWindowsTerminalCommand 注释）。
      const launcherScriptPath = await writeWindowsCliLaunchScript({
        tempRoot: this.tempRoot,
        executablePath: request.executablePath,
        args: request.args,
        environment: request.environment,
        projectDir: request.projectDir,
      });
      await this.launch(buildWindowsTerminalCommand({
        terminalId: request.terminalId,
        terminalExecutable: selected.executablePath,
        powershellExecutable,
        systemRoot: this.env.SystemRoot,
        executablePath: request.executablePath,
        args: request.args,
        environment: request.environment,
        projectDir: request.projectDir,
        launcherScriptPath,
      }), "win32");
      return;
    }
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

/**
 * 扩展名解析（Windows）：PATHEXT 后缀优先，字面路径兜底。npm 等包管理器在
 * Windows 同时落地无扩展名 sh shim（供 Git Bash/WSL）与 .cmd/.exe（供
 * CreateProcess）；字面优先会命中 sh 脚本，PowerShell `&` 无法执行导致 CLI
 * 启动静默失败（实测 2026-10-11，opencode / npx 均踩中）。
 */
async function findWindowsExecutableWithExtensions(
  candidate: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (extname(candidate)) {
    return await pathExists(candidate) ? candidate : null;
  }
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map(value => value.toLowerCase());
  for (const extension of extensions) {
    const withExtension = `${candidate}${extension}`;
    if (await pathExists(withExtension)) return withExtension;
  }
  return await pathExists(candidate) ? candidate : null;
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
