import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  MacDevelopmentPlatformAdapter,
  buildMacDirectoryPickerCommand,
  buildMacTerminalCommand,
} from "../src/lib/development-launch/platform-macos.js";
import {
  buildWindowsDirectoryPickerCommand,
  buildWindowsTerminalCommand,
  WindowsDevelopmentPlatformAdapter,
} from "../src/lib/development-launch/platform-windows.js";
import {
  createDevelopmentPlatformAdapter,
  type CommandSpec,
  terminalProcessOptions,
  unsupportedDevelopmentCapabilities,
} from "../src/lib/development-launch/platform.js";

const RESUME_SESSION_ID = "019fa355-e50d-7731-8a60-c29dbd506666";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("development launch platform adapters", () => {
  test("macOS 终端直接执行逐参数引用后的 CLI 命令", () => {
    const projectDir = "/tmp/项目 ' alpha";
    const command = buildMacTerminalCommand({
      terminalId: "terminal.app",
      projectDir,
      executablePath: "/opt/homebrew/bin/codex",
      args: ["-C", projectDir, "-m", "gpt-5.6"],
      environment: {},
    });

    expect(command.command).toBe("/usr/bin/osascript");
    const launchLine = command.args.at(-1)!;
    expect(launchLine).toContain("/opt/homebrew/bin/codex");
    expect(launchLine).toContain("gpt-5.6");
    expect(launchLine).toContain("'\"'\"'");
    expect(command.args.slice(0, -1).join("\n")).not.toContain(projectDir);
    expect(command.args.join(" ")).not.toContain("development-bootstrap");
    expect(command.args.join(" ")).not.toContain("launch.json");
  });

  test("Terminal.app 启动脚本不编译未安装的 iTerm2 专有语法", () => {
    const command = buildMacTerminalCommand({
      terminalId: "terminal.app",
      projectDir: "/tmp/demo",
      executablePath: "/usr/local/bin/codex",
      args: ["-m", "gpt-5.6"],
      environment: {},
    });

    expect(command.args[1]).toContain('tell application "Terminal"');
    expect(command.args[1]).not.toContain('tell application "iTerm"');
    expect(command.args[1]).not.toContain("current session");
  });

  test("Terminal.app 有窗口时复用新标签页，无窗口时创建窗口", () => {
    const command = buildMacTerminalCommand({
      terminalId: "terminal.app",
      projectDir: "/tmp/demo",
      executablePath: "/usr/local/bin/codex",
      args: ["-m", "gpt-5.6"],
      environment: {},
    });
    const script = command.args[1]!;

    expect(script).toContain("count of windows");
    expect(script).toContain('tell application "System Events"');
    expect(script).toContain("menu item 1 of menu 1 of menu item 2");
    expect(script).toContain("originalWindowCount");
    expect(script).toContain("repeat 50 times");
    expect(script).toContain("selected tab of front window");
    expect(script).toContain("do script launchCommand");
  });

  test("Terminal.app 标签页自动化无权限时回退新窗口启动", () => {
    const command = buildMacTerminalCommand({
      terminalId: "terminal.app",
      projectDir: "/tmp/demo",
      executablePath: "/usr/local/bin/codex",
      args: ["-m", "gpt-5.6"],
      environment: {},
    });
    const script = command.args[1]!;

    expect(script).toContain('try\n        tell application "System Events"');
    expect(script).toContain("on error\n        do script launchCommand\n      end try");
  });

  test("Terminal.app 超长命令改用短启动器命令且计划保留完整 Session ID", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "terminal-launch-plan-test-"));
    tempRoots.push(tempRoot);
    const commands: CommandSpec[] = [];
    const adapter = new MacDevelopmentPlatformAdapter({
      tempRoot,
      nodeExecutable: "/usr/local/bin/node",
      developmentLaunchHelperPath: "/app/bin/development-launch.mjs",
      run: async command => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await adapter.openTerminal(longTerminalRequest());

    const launchLine = commands[0]!.args.at(-1)!;
    expect(Buffer.byteLength(launchLine, "utf8")).toBeLessThan(1024);
    expect(launchLine).toContain("development-launch.mjs");
    const entries = await readdir(tempRoot);
    expect(entries).toHaveLength(1);
    const plan = await readFile(
      join(tempRoot, entries[0]!, "terminal-launch.json"),
      "utf8",
    );
    expect(plan).toContain(RESUME_SESSION_ID);
  });

  test("Terminal.app 短命令保持直接启动且不创建计划", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "terminal-direct-test-"));
    tempRoots.push(tempRoot);
    const commands: CommandSpec[] = [];
    const adapter = new MacDevelopmentPlatformAdapter({
      tempRoot,
      run: async command => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await adapter.openTerminal({
      terminalId: "terminal.app",
      projectDir: "/tmp/demo",
      executablePath: "/usr/local/bin/codex",
      args: ["-m", "gpt-5.6"],
      environment: {},
    });

    expect(commands[0]!.args.at(-1)).toContain("/usr/local/bin/codex");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("iTerm2 超长命令保持直接启动且不创建计划", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "iterm-direct-test-"));
    tempRoots.push(tempRoot);
    const commands: CommandSpec[] = [];
    const adapter = new MacDevelopmentPlatformAdapter({
      tempRoot,
      run: async command => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const request = { ...longTerminalRequest(), terminalId: "iterm2" };

    await adapter.openTerminal(request);

    expect(Buffer.byteLength(commands[0]!.args.at(-1)!, "utf8")).toBeGreaterThan(1024);
    expect(commands[0]!.args.at(-1)).toContain(RESUME_SESSION_ID);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("Terminal.app 打开失败时立即清理超长命令计划", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "terminal-failed-test-"));
    tempRoots.push(tempRoot);
    const adapter = new MacDevelopmentPlatformAdapter({
      tempRoot,
      nodeExecutable: "/usr/local/bin/node",
      developmentLaunchHelperPath: "/app/bin/development-launch.mjs",
      run: async () => ({ stdout: "", stderr: "failed", exitCode: 1 }),
    });

    await expect(adapter.openTerminal(longTerminalRequest()))
      .rejects.toThrow("TERMINAL_LAUNCH_FAILED");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("iTerm2 有窗口时创建标签页，无窗口时创建窗口", () => {
    const command = buildMacTerminalCommand({
      terminalId: "iterm2",
      projectDir: "/tmp/demo",
      executablePath: "/usr/local/bin/claude",
      args: ["--model", "claude-sonnet-4-5"],
      environment: {},
    });
    const script = command.args[1]!;

    expect(script).toContain("count of windows");
    expect(script).toContain("create tab with default profile");
    expect(script).toContain("create window with default profile");
  });

  test("uses a fixed macOS directory picker script", () => {
    const command = buildMacDirectoryPickerCommand();

    expect(command.command).toBe("/usr/bin/osascript");
    expect(command.args.join(" ")).toContain("choose folder");
  });

  test("uses PowerShell STA for the Windows directory picker", () => {
    const command = buildWindowsDirectoryPickerCommand("C:\\Windows");

    expect(command.command.toLowerCase()).toContain("powershell.exe");
    expect(command.args).toContain("-STA");
    expect(command.args.join(" ")).toContain("FolderBrowserDialog");
  });

  test("Windows Terminal 使用固定 PowerShell 脚本直接执行参数数组", () => {
    const cliArgs = ["-C", "C:\\开发\\demo", "-m", "gpt-5.6"];
    const command = buildWindowsTerminalCommand({
      terminalId: "windows-terminal",
      terminalExecutable: "C:\\Program Files\\WindowsApps\\wt.exe",
      powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      executablePath: "C:\\tools\\codex.cmd",
      args: cliArgs,
      environment: { CODEX_TEST_VALUE: "value with spaces" },
      projectDir: "C:\\开发\\demo",
    });

    expect(command.command).toContain("wt.exe");
    expect(command.args.slice(0, 3)).toEqual(["-w", "0", "new-tab"]);
    expect(command.args).toContain("C:\\开发\\demo");
    expect(command.args).toContain("C:\\tools\\codex.cmd");
    expect(command.args).toContain(JSON.stringify(cliArgs));
    expect(command.args).toContain(JSON.stringify({ CODEX_TEST_VALUE: "value with spaces" }));
    expect(command.args.join(" ")).not.toContain("launch.ps1");
    expect(command.args.join(" ")).not.toContain("launch.json");
  });

  test("传统 PowerShell 保持独立窗口且不伪造标签页能力", () => {
    const command = buildWindowsTerminalCommand({
      terminalId: "powershell",
      terminalExecutable: "C:\\Program Files\\WindowsApps\\wt.exe",
      powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      executablePath: "C:\\tools\\codex.cmd",
      args: ["-m", "gpt-5.6"],
      environment: {},
      projectDir: "C:\\demo",
    });

    expect(command.args).not.toContain("new-tab");
    expect(command.args).not.toContain("-w");
  });

  test("rejects unsupported desktop platforms", () => {
    expect(() => createDevelopmentPlatformAdapter("linux")).toThrow("UNSUPPORTED_PLATFORM");
    expect(unsupportedDevelopmentCapabilities("linux")).toEqual({
      supported: false,
      platform: "linux",
      agents: {
        codex: { available: false },
        claude: { available: false },
        opencode: { available: false },
        dsh: { available: false },
        zcode: { available: false },
      },
      terminals: [],
      credentialStoreAvailable: false,
    });
  });

  test("opens Windows terminals in a visible detached console", () => {
    expect(terminalProcessOptions("win32")).toMatchObject({
      detached: true,
      windowsHide: false,
      stdio: "ignore",
    });
  });

  test("macOS OpenCode 按 PATH > home 白名单路径探测，dsh 只认 PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-executable-"));
    tempRoots.push(root);
    const homeDir = join(root, "home");
    const pathDir = join(root, "bin");
    const dotOpenCode = join(homeDir, ".opencode", "bin", "opencode");
    const dotLocal = join(homeDir, ".local", "bin", "opencode");
    await Promise.all([
      mkdir(pathDir, {recursive: true}),
      mkdir(join(homeDir, ".opencode", "bin"), {recursive: true}),
      mkdir(join(homeDir, ".local", "bin"), {recursive: true}),
    ]);
    await Promise.all([
      writeFile(join(pathDir, "opencode"), "#!/bin/sh\n", {mode: 0o755}),
      writeFile(dotOpenCode, "#!/bin/sh\n", {mode: 0o755}),
      writeFile(dotLocal, "#!/bin/sh\n", {mode: 0o755}),
    ]);

    const adapter = new MacDevelopmentPlatformAdapter({
      homeDir,
      env: {PATH: pathDir},
      run: async () => ({stdout: "", stderr: "", exitCode: 1}),
    });
    expect(await adapter.resolveExecutable("opencode")).toBe(join(pathDir, "opencode"));

    const homeAdapter = new MacDevelopmentPlatformAdapter({
      homeDir,
      env: {PATH: ""},
      run: async () => ({stdout: "", stderr: "", exitCode: 1}),
    });
    expect(await homeAdapter.resolveExecutable("opencode")).toBe(dotOpenCode);
    expect(await homeAdapter.resolveExecutable("dsh")).toBeNull();
    // 白名单候选不包含 npx cache，未安装时不得自动发现。
    expect(await homeAdapter.resolveExecutable("codex")).toBeNull();
  });

  test("Windows OpenCode 白名单路径按 home 解析", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-executable-win-"));
    tempRoots.push(root);
    const homeDir = join(root, "home");
    const candidate = join(homeDir, ".opencode", "bin", "opencode.exe");
    await mkdir(join(homeDir, ".opencode", "bin"), {recursive: true});
    await writeFile(candidate, "x", {mode: 0o755});
    const adapter = new WindowsDevelopmentPlatformAdapter({
      homeDir,
      env: {PATH: ""},
    });
    expect(await adapter.resolveExecutable("opencode")).toBe(candidate);
    expect(await adapter.resolveExecutable("dsh")).toBeNull();
  });

  test("macOS 能力探测只确认可执行文件存在，不启动 --version", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-capabilities-macos-"));
    tempRoots.push(root);
    const pathDir = join(root, "bin");
    await mkdir(pathDir, {recursive: true});
    await Promise.all(["codex", "claude", "opencode", "dsh"].map(name =>
      writeFile(join(pathDir, name), "#!/bin/sh\n", {mode: 0o755}),
    ));
    const commands: CommandSpec[] = [];
    const adapter = new MacDevelopmentPlatformAdapter({
      env: {PATH: pathDir},
      homeDir: join(root, "home"),
      nodeExecutable: join(root, "node"),
      run: async command => {
        commands.push(command);
        return {stdout: "", stderr: "", exitCode: 0};
      },
    });

    const result = await adapter.detectCapabilities();

    expect(result.agents.codex).toMatchObject({available: true, executablePath: join(pathDir, "codex")});
    expect(result.agents.claude).toMatchObject({available: true, executablePath: join(pathDir, "claude")});
    expect(result.agents.opencode).toMatchObject({available: true, executablePath: join(pathDir, "opencode")});
    expect(commands.every(command => !command.args.includes("--version"))).toBe(true);
  });

  test("Windows 能力探测只确认可执行文件存在，不启动 --version", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-capabilities-windows-"));
    tempRoots.push(root);
    const pathDir = join(root, "bin");
    await mkdir(pathDir, {recursive: true});
    await Promise.all(["codex", "claude", "opencode", "dsh"].map(name =>
      writeFile(join(pathDir, name), "x", {mode: 0o755}),
    ));
    const commands: CommandSpec[] = [];
    const adapter = new WindowsDevelopmentPlatformAdapter({
      env: {PATH: pathDir, SystemRoot: join(root, "windows")},
      homeDir: join(root, "home"),
      run: async command => {
        commands.push(command);
        return {stdout: "", stderr: "", exitCode: 0};
      },
    });

    const result = await adapter.detectCapabilities();

    expect(result.agents.codex).toMatchObject({available: true, executablePath: join(pathDir, "codex")});
    expect(result.agents.claude).toMatchObject({available: true, executablePath: join(pathDir, "claude")});
    expect(result.agents.opencode).toMatchObject({available: true, executablePath: join(pathDir, "opencode")});
    expect(commands.every(command => !command.args.includes("--version"))).toBe(true);
  });
});

function longTerminalRequest() {
  const projectDir = `/Users/andy/Documents/UGit/AIAgentAndy/EffiRoom/${"module/".repeat(180)}`;
  const providerId = "deepaa_gateway";
  return {
    terminalId: "terminal.app",
    projectDir,
    executablePath: "/Users/andy/.nvm/versions/node/v22.12.0/bin/codex",
    args: [
      "resume",
      "-C",
      projectDir,
      "-m",
      "glm-5.2_ark.cn-beijing.volces.com",
      "-c",
      `model_provider="${providerId}"`,
      "-c",
      `model_providers.${providerId}.name="Deepaa 网关"`,
      "-c",
      `model_providers.${providerId}.base_url="http://localhost:3211/v1"`,
      "-c",
      `model_providers.${providerId}.wire_api="responses"`,
      "-c",
      `model_providers.${providerId}.experimental_bearer_token="deepaa-gateway"`,
      RESUME_SESSION_ID,
    ],
    environment: {},
  };
}
