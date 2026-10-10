import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
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
  runDevelopmentCommand,
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

  test("Windows 目录选择对话框带 TopMost 属主并在弹出前写就绪标记（2026-10-11 置顶修复）", () => {
    const script = buildWindowsDirectoryPickerCommand("C:\\Windows").args.join(" ");

    // 属主 TopMost（能传播的上下文直接受益）+ 就绪标记先于 ShowDialog。
    expect(script).toContain("$owner.TopMost = $true");
    expect(script).toContain("ShowDialog($owner)");
    expect(script).toContain("__DEEPAA_DIALOG_UP__");
    expect(script.indexOf("__DEEPAA_DIALOG_UP__")).toBeLessThan(script.indexOf("ShowDialog($owner)"));
    // 确定性置顶：伴随子进程对对话框本体 SetWindowPos(HWND_TOPMOST)，
    // 不依赖属主样式传播（实测 Next.js 服务端上下文传播失效，对话框被压底不可见）。
    expect(script).toContain("SetWindowPos");
    expect(script).toContain("[IntPtr](-1)");
    expect(script).toContain("__PICKER_PID__");
  });

  test("Windows 选择目录：就绪超时映射为 DIRECTORY_PICKER_NOT_SHOWN", async () => {
    const runOptions: unknown[] = [];
    const adapter = new WindowsDevelopmentPlatformAdapter({
      run: async (_command, options) => {
        runOptions.push(options);
        throw new Error("COMMAND_NOT_READY");
      },
    });

    await expect(adapter.selectDirectory()).rejects.toThrow("DIRECTORY_PICKER_NOT_SHOWN");
    expect(runOptions[0]).toMatchObject({
      timeoutMs: 5 * 60_000,
      readyMarker: "__DEEPAA_DIALOG_UP__",
      readyTimeoutMs: 30_000,
    });
  });

  test("Windows 选择目录：剥离就绪标记后解析所选路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-picker-path-"));
    tempRoots.push(root);
    const adapter = new WindowsDevelopmentPlatformAdapter({
      run: async () => ({
        stdout: `__DEEPAA_DIALOG_UP__${root}`,
        stderr: "",
        exitCode: 0,
      }),
    });

    const selection = await adapter.selectDirectory();

    expect(selection.cancelled).toBe(false);
    expect(selection.path).toBe(await realpath(root));
  });

  test("Windows 选择目录：就绪标记与取消标记同块到达仍判取消", async () => {
    const adapter = new WindowsDevelopmentPlatformAdapter({
      run: async () => ({
        stdout: "__DEEPAA_DIALOG_UP____DEEPAA_CANCELLED__",
        stderr: "",
        exitCode: 0,
      }),
    });

    expect(await adapter.selectDirectory()).toEqual({cancelled: true});
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

  test("传统 PowerShell 经 cmd start 新控制台执行固化脚本（2026-10-11 可见性修复）", () => {
    const command = buildWindowsTerminalCommand({
      terminalId: "powershell",
      terminalExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      systemRoot: "C:\\Windows",
      executablePath: "C:\\tools\\codex.cmd",
      args: ["-m", "gpt-5.6"],
      environment: {},
      projectDir: "C:\\demo",
      launcherScriptPath: "C:\\Temp\\deepaa-launch\\launch_abc.ps1",
    });

    // DETACHED 直接 spawn powershell 实测无控制台；必须经 cmd /c start 建新控制台。
    expect(command.command.toLowerCase()).toContain("cmd.exe");
    expect(command.args.slice(0, 3)).toEqual(["/c", "start", '"DeepAA"']);
    expect(command.args).toContain("-NoExit");
    expect(command.args).toContain("-File");
    expect(command.args.at(-1)).toBe("C:\\Temp\\deepaa-launch\\launch_abc.ps1");
    // CLI 细节全部走固化脚本，不进命令行（规避 cmd 引号二次解析）。
    expect(command.args.join(" ")).not.toContain("codex.cmd");
    expect(command.args.join(" ")).not.toContain("new-tab");
    expect(command.args.join(" ")).not.toContain("-w");
  });

  test("powershell 终端启动固化脚本内容并保持可见形态", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-terminal-launch-"));
    tempRoots.push(root);
    const systemRoot = join(root, "windows");
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await mkdir(dirname(powershell), {recursive: true});
    await writeFile(powershell, "x", "utf8");
    const tempRoot = join(root, "launch");
    const launched: CommandSpec[] = [];
    const adapter = new WindowsDevelopmentPlatformAdapter({
      env: {PATH: "", SystemRoot: systemRoot},
      tempRoot,
      launch: async command => { launched.push(command); },
    });

    await adapter.openTerminal({
      terminalId: "powershell",
      projectDir: "D:\\项目 'demo'",
      executablePath: "C:\\Users\\andy\\AppData\\Roaming\\npm\\opencode.cmd",
      args: ["D:\\项目 'demo'", "-m", "model_x"],
      environment: {OPENCODE_API_KEY: "sk 'value'"},
    });

    expect(launched).toHaveLength(1);
    expect(launched[0].command.toLowerCase()).toContain("cmd.exe");
    expect(launched[0].args).toContain("start");
    const scriptPath = launched[0].args.at(-1)!;
    const script = await readFile(scriptPath, "utf8");
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("$env:OPENCODE_API_KEY = 'sk ''value'''");
    expect(script).toContain("Set-Location -LiteralPath 'D:\\项目 ''demo'''");
    expect(script).toContain("& 'C:\\Users\\andy\\AppData\\Roaming\\npm\\opencode.cmd' @('D:\\项目 ''demo''', '-m', 'model_x')");
  });

  test("Windows 可执行解析 PATHEXT 优先于无扩展名 sh shim（2026-10-11 修复）", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-pathtext-"));
    tempRoots.push(root);
    const npmBin = join(root, "npm");
    await mkdir(npmBin, {recursive: true});
    // npm 目录典型布局：无扩展名 sh shim + .cmd 才是 Windows 可执行入口。
    await writeFile(join(npmBin, "opencode"), "#!/bin/sh\n", "utf8");
    await writeFile(join(npmBin, "opencode.cmd"), "@echo off\n", "utf8");
    const adapter = new WindowsDevelopmentPlatformAdapter({
      env: {PATH: npmBin},
      homeDir: join(root, "home"),
    });

    expect(await adapter.resolveExecutable("opencode")).toBe(join(npmBin, "opencode.cmd"));
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

  test("macOS 登录壳兜底先非交互 -lc，命中即不启动交互壳（2026-10-10 A1）", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-login-shell-"));
    tempRoots.push(root);
    // 登录壳返回的路径必须真实存在（探测会做存在性校验）。
    const fakeCli = join(root, "bin", "codex");
    await mkdir(join(root, "bin"), {recursive: true});
    await writeFile(fakeCli, "#!/bin/sh\n", {mode: 0o755});
    const shellCommands: CommandSpec[] = [];
    const adapter = new MacDevelopmentPlatformAdapter({
      env: {PATH: ""},
      homeDir: join(root, "home"),
      run: async command => {
        if (command.command === "/bin/zsh") shellCommands.push(command);
        // 非交互登录壳命中；交互壳永不命中（若被调用说明顺序错误）。
        if (command.args[0] === "-lc") return {stdout: `${fakeCli}\n`, stderr: "", exitCode: 0};
        return {stdout: "", stderr: "", exitCode: 1};
      },
    });

    expect(await adapter.resolveExecutable("codex")).toBe(fakeCli);
    // 只允许跑一次登录壳，且必须是非交互形态（交互壳实测秒级，是冷探测瓶颈）。
    expect(shellCommands).toHaveLength(1);
    expect(shellCommands[0].args).toEqual(["-lc", "command -v codex"]);
  });

  test("macOS 登录壳兜底 -lc 未命中时回退交互 -lic（2026-10-10 A1 兜底链）", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-login-shell-fallback-"));
    tempRoots.push(root);
    const fakeCli = join(root, "bin", "claude");
    await mkdir(join(root, "bin"), {recursive: true});
    await writeFile(fakeCli, "#!/bin/sh\n", {mode: 0o755});
    const shellCommands: CommandSpec[] = [];
    const adapter = new MacDevelopmentPlatformAdapter({
      env: {PATH: ""},
      homeDir: join(root, "home"),
      run: async command => {
        if (command.command === "/bin/zsh") shellCommands.push(command);
        // PATH 只在交互层初始化的用户环境：-lc 找不到，-lic 命中。
        if (command.args[0] === "-lic") return {stdout: `${fakeCli}\n`, stderr: "", exitCode: 0};
        return {stdout: "", stderr: "", exitCode: 1};
      },
    });

    expect(await adapter.resolveExecutable("claude")).toBe(fakeCli);
    expect(shellCommands.map(command => command.args[0])).toEqual(["-lc", "-lic"]);
  });

  test("macOS 探测缓存：成功长 TTL、失败短 TTL 内均不重复探测（2026-10-10 A2）", async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), "platform-probe-ttl-"));
      tempRoots.push(root);
      const fakeCli = join(root, "bin", "opencode");
      await mkdir(join(root, "bin"), {recursive: true});
      await writeFile(fakeCli, "#!/bin/sh\n", {mode: 0o755});
      let shellCalls = 0;
      const succeed = new Map<string, boolean>([["opencode", true]]);
      const adapter = new MacDevelopmentPlatformAdapter({
        env: {PATH: ""},
        homeDir: join(root, "home"),
        run: async command => {
          if (command.command !== "/bin/zsh") return {stdout: "", stderr: "", exitCode: 1};
          shellCalls += 1;
          const executable = command.args.at(-1)!.replace("command -v ", "");
          return succeed.get(executable)
            ? {stdout: `${fakeCli}\n`, stderr: "", exitCode: 0}
            : {stdout: "", stderr: "", exitCode: 1};
        },
      });

      // 失败（dsh 未命中两次登录壳）：短 TTL 内命中缓存，零新增 shell。
      expect(await adapter.resolveExecutable("dsh")).toBeNull();
      expect(shellCalls).toBe(2);
      await adapter.resolveExecutable("dsh");
      expect(shellCalls).toBe(2);

      // 成功（opencode）：30 分钟长 TTL 内命中缓存。
      expect(await adapter.resolveExecutable("opencode")).toBe(fakeCli);
      expect(shellCalls).toBe(3);
      vi.setSystemTime(Date.now() + 29 * 60_000);
      await adapter.resolveExecutable("opencode");
      expect(shellCalls).toBe(3);
      // 超过成功 TTL 后重新探测（且此时改为失败，验证确实重新执行）。
      vi.setSystemTime(Date.now() + 2 * 60_000);
      succeed.set("opencode", false);
      expect(await adapter.resolveExecutable("opencode")).toBeNull();
      expect(shellCalls).toBe(5);
    } finally {
      vi.useRealTimers();
    }
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

  test("runDevelopmentCommand：就绪标记到点未见即终止并报 COMMAND_NOT_READY", async () => {
    // 子进程不输出标记且保持存活：就绪超时（500ms）先于总超时（5s）触发。
    await expect(runDevelopmentCommand({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 15000)"],
    }, {
      timeoutMs: 5_000,
      readyMarker: "__READY__",
      readyTimeoutMs: 500,
    })).rejects.toThrow("COMMAND_NOT_READY");
  });

  test("runDevelopmentCommand：见到就绪标记后就绪超时不再计时，仅受总超时约束", async () => {
    // 子进程立刻输出标记，随后存活 1.2s（超过 500ms 就绪窗口）后正常退出。
    const result = await runDevelopmentCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('__READY__'); setTimeout(() => process.exit(0), 1200)"],
    }, {
      timeoutMs: 5_000,
      readyMarker: "__READY__",
      readyTimeoutMs: 500,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("__READY__");
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
