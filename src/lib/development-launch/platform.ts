import { spawn, type SpawnOptions } from "child_process";
import type { DevelopmentCli, DshLaunchChannel, PlatformCapabilities, TerminalCapability } from "./types";
import {launchStrategyList} from "./strategies";
import { MacDevelopmentPlatformAdapter } from "./platform-macos";
import { WindowsDevelopmentPlatformAdapter } from "./platform-windows";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export interface CommandSpec {
  command: string;
  args: string[];
  stdin?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DevelopmentCommandRunner = (
  command: CommandSpec,
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;

export type DevelopmentTerminalLauncher = (
  command: CommandSpec,
  platform: "darwin" | "win32",
) => Promise<void>;

export interface DirectorySelection {
  cancelled: boolean;
  path?: string;
  name?: string;
}

export interface TerminalLaunchRequest {
  terminalId: string;
  projectDir: string;
  executablePath: string;
  args: string[];
  environment: Record<string, string>;
}

export interface DevelopmentPlatformAdapter {
  readonly platform: "darwin" | "win32";
  detectCapabilities(): Promise<PlatformCapabilities>;
  selectDirectory(): Promise<DirectorySelection>;
  resolveExecutable(cli: DevelopmentCli): Promise<string | null>;
  /** 解析 dsh 启动通道（PATH 全局安装 / npx 缓存 / npx 免装）；返回可执行文件与通道。 */
  resolveDshLaunch?(): Promise<{ executablePath: string; channel: DshLaunchChannel } | null>;
  /** 探测 dsh 桌面客户端（DeepSeek Harness）安装位置；未安装返回 null（只读探测）。 */
  detectDshDesktopApp?(): Promise<string | null>;
  /** 检测 ZCode 桌面 App 是否已在本机运行（app 形态防重复启动）。 */
  isZcodeAppRunning?(): Promise<boolean>;
  /** 已运行的 ZCode 桌面 App 切换到前台（尽力而为，失败不阻断启动流程）。 */
  activateZcodeApp?(appPath: string): Promise<boolean>;
  listTerminals(): Promise<TerminalCapability[]>;
  openTerminal(request: TerminalLaunchRequest): Promise<void>;
}

export interface PlatformAdapterOptions {
  run?: DevelopmentCommandRunner;
  launch?: DevelopmentTerminalLauncher;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  tempRoot?: string;
  nodeExecutable?: string;
  developmentLaunchHelperPath?: string;
}

export function createDevelopmentPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
  options: PlatformAdapterOptions = {},
): DevelopmentPlatformAdapter {
  if (platform === "darwin") return new MacDevelopmentPlatformAdapter(options);
  if (platform === "win32") return new WindowsDevelopmentPlatformAdapter(options);
  throw new Error("UNSUPPORTED_PLATFORM");
}

export function unsupportedDevelopmentCapabilities(
  platform: NodeJS.Platform,
): PlatformCapabilities {
  return {
    supported: false,
    platform,
    agents: Object.fromEntries(
      launchStrategyList().map(strategy => [strategy.agent, {available: false}]),
    ),
    terminals: [],
    credentialStoreAvailable: false,
  };
}

export async function runDevelopmentCommand(
  spec: CommandSpec,
  options: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current: string, chunk: Buffer | string): string => {
      const value = String(chunk);
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(new Error("COMMAND_OUTPUT_TOO_LARGE")));
        return current;
      }
      return current + value;
    };

    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", error => finish(() => reject(error)));
    child.once("close", code => finish(() => resolvePromise({
      stdout,
      stderr,
      exitCode: code ?? 1,
    })));
    if (spec.stdin === undefined) child.stdin.end();
    else child.stdin.end(spec.stdin);

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("COMMAND_TIMEOUT")));
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    timer.unref();
  });
}

export function terminalProcessOptions(platform: "darwin" | "win32"): SpawnOptions {
  return {
    detached: platform === "win32",
    stdio: "ignore",
    windowsHide: false,
  };
}

export async function launchDevelopmentTerminal(
  spec: CommandSpec,
  platform: "darwin" | "win32",
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(spec.command, spec.args, terminalProcessOptions(platform));
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}
