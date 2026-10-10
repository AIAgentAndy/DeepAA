import {EventEmitter} from "node:events";
import {access, mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, test} from "vitest";
import {
  assertSupportedNodeVersion,
  buildDeepaaProcessSpecs,
  createNextBannerFilter,
  isSuppressedNextBannerLine,
  parseDeepaaArguments,
  runDeepaa,
} from "../bin/deepaa.mjs";

describe("跨平台 Deepaa 启动器", () => {
  test("零参数解析为智能启动器（批次 2 定稿：补缺服务 + 开浏览器 + 退出）", () => {
    expect(parseDeepaaArguments([])).toEqual({
      command: "launch",
      production: true,
      nextArgs: [],
      commandArgs: [],
    });
  });

  test("语义互换（2026-10-05 用户定稿）：start=智能启动别名，open=前台组合", () => {
    expect(parseDeepaaArguments(["start"])).toEqual({
      command: "launch", production: true, nextArgs: [], commandArgs: [],
    });
    expect(parseDeepaaArguments(["open"])).toEqual({
      command: "all", production: true, nextArgs: [], commandArgs: [],
    });
    expect(parseDeepaaArguments(["--hostname", "dev"])).toEqual({
      command: "all", production: true, nextArgs: ["--hostname", "dev"], commandArgs: [],
    });
  });

  test("dev proxy：仅代理的开发模式（热更新）", () => {
    expect(parseDeepaaArguments(["dev", "proxy"])).toEqual({
      command: "proxy", production: false, nextArgs: [], commandArgs: [],
    });
    expect(parseDeepaaArguments(["dev", "web"])).toEqual({
      command: "web", production: false, nextArgs: [], commandArgs: [],
    });
  });

  test("F4：help 三形态解析；未知命令词报错引导；旗标参数仍透传", () => {
    expect(parseDeepaaArguments(["help"])).toMatchObject({command: "help"});
    expect(parseDeepaaArguments(["--help"])).toMatchObject({command: "help"});
    expect(parseDeepaaArguments(["-h"])).toMatchObject({command: "help"});
    expect(() => parseDeepaaArguments(["foo"])).toThrow("未知命令：foo");
    expect(() => parseDeepaaArguments(["instal"])).toThrow("deepaa help");
    // 旗标首参保持前台 all 透传语义（next 的 -p/-H 等）
    expect(parseDeepaaArguments(["-p", "4000"])).toEqual({
      command: "all", production: true, nextArgs: ["-p", "4000"], commandArgs: [],
    });
  });

  test("F4：help 文案按 2026-10-05 用户定稿覆盖全部命令与关键语义", async () => {
    const {buildDeepaaHelpText} = await import("../bin/deepaa.mjs");
    const text = buildDeepaaHelpText();
    for (const keyword of [
      "1. 启动与停止", "2. 系统服务（可选）", "3. 快捷入口", "4. 开发与进阶",
      "Web 与代理服务", "同上，deepaa 的别名",
      "仅停止当前运行，不取消服务注册",
      "deepaa service install", "deepaa service uninstall",
      "deepaa icon uninstall", "deepaa open", "deepaa dev [web / proxy]",
      "deepaa proxy", "deepaa web", "deepaa build", "进程崩溃自动恢复。",
      // 2026-10-06 语义定稿：install/start 一条命令完成「确保运行 + 打开控制台」
      "注册并启动系统服务", "启动完成后自动打开 Web 控制台",
      "启动已注册的系统服务，并打开 Web 控制台",
      // 2026-10-07 用户确认：注销 ≠ 停止
      "注销系统服务，不再开机自启", "如需停止请执行 deepaa stop",
    ]) {
      expect(text).toContain(keyword);
    }
    // 危险命令与旧口径不再出现
    expect(text).not.toContain("data purge");
    expect(text).not.toContain("两个服务");
    expect(text).not.toContain("icon install");
  });

  test("批次 2 服务子命令解析", () => {
    expect(parseDeepaaArguments(["open"])).toMatchObject({command: "all"});
    expect(parseDeepaaArguments(["stop"])).toMatchObject({command: "stop"});
    expect(parseDeepaaArguments(["status"])).toMatchObject({command: "status"});
    expect(parseDeepaaArguments(["service", "install"])).toEqual({
      command: "service", production: true, nextArgs: [], commandArgs: ["install"],
    });
    expect(parseDeepaaArguments(["icon", "install", "--silent"])).toEqual({
      command: "icon", production: true, nextArgs: [], commandArgs: ["install", "--silent"],
    });
    // data purge 已移除（2026-10-05 用户确认：不提供危险命令）
    expect(() => parseDeepaaArguments(["data", "purge", "--yes"])).toThrow("未知命令：data");
  });

  test("dev 组合模式只消费首个命令参数", () => {
    expect(parseDeepaaArguments(["dev", "--hostname", "127.0.0.1"])).toEqual({
      command: "all",
      production: false,
      nextArgs: ["--hostname", "127.0.0.1"],
      commandArgs: [],
    });
    expect(parseDeepaaArguments(["--hostname", "dev"])).toEqual({
      command: "all",
      production: true,
      nextArgs: ["--hostname", "dev"],
      commandArgs: [],
    });
  });

  test("dev web 只启动跨平台的 Next 开发进程", () => {
    expect(parseDeepaaArguments(["dev", "web", "--turbo"])).toEqual({
      command: "web",
      production: false,
      nextArgs: ["--turbo"],
      commandArgs: [],
    });
  });

  test.each([
    ["proxy", "proxy"],
    ["web", "web"],
    ["build", "build"],
  ] as const)("解析 %s 独立命令", (argument, command) => {
    expect(parseDeepaaArguments([argument])).toEqual({
      command,
      production: true,
      nextArgs: [],
      commandArgs: [],
    });
  });

  test("Node 版本门禁：≥22.13 或 ≥23.4（node:sqlite 免 flag 矩阵）", () => {
    expect(() => assertSupportedNodeVersion("21.9.0")).toThrow("Node.js 22.13+ 或 23.4+");
    // 22.0–22.12 拒绝；23.0–23.3 仍需实验旗标同样拒绝（2026-10-08 Claude 审核
    // 修复：旧门禁放行 23.0–23.3 会导致 Web 启动失败）。
    expect(() => assertSupportedNodeVersion("22.0.0")).toThrow("Node.js 22.13+ 或 23.4+");
    expect(() => assertSupportedNodeVersion("22.12.9")).toThrow("Node.js 22.13+ 或 23.4+");
    expect(() => assertSupportedNodeVersion("22.13.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("23.3.0")).toThrow("Node.js 22.13+ 或 23.4+");
    expect(() => assertSupportedNodeVersion("23.4.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.0.0")).not.toThrow();
  });

  test("代理使用独立 Node 产物且运行命令不包含隐式构建（dev = tsx watch 热更新）", () => {
    // Windows 宿主上 join() 产物是反斜杠路径，命令参数统一归一化为 posix 再比较。
    const toPosix = (value: string) => value.replaceAll("\\", "/");
    const posixSpec = <T extends {command: string; args: string[]}>(spec: T): T => ({
      ...spec,
      args: spec.args.map(toPosix),
    });
    const specs = buildDeepaaProcessSpecs({
      rootDir: "/app/deepaa",
      production: false,
      nextArgs: [],
      nodeExecutable: "/usr/local/bin/node",
      port: "4321",
    });

    // 开发模式代理走 tsx watch 源码热更新（2026-10-05 用户确认）。
    expect(specs.proxy.command).toBe("/usr/local/bin/node");
    expect(toPosix(specs.proxy.args[0]!).endsWith("tsx/dist/cli.mjs")).toBe(true);
    expect(specs.proxy.args[1]).toBe("watch");
    expect(toPosix(specs.proxy.args[2]!).endsWith("src/proxy-server.ts")).toBe(true);
    // 生产模式仍为独立 dist 产物。
    const prod = buildDeepaaProcessSpecs({
      rootDir: "/app/deepaa",
      production: true,
      nextArgs: [],
      nodeExecutable: "/usr/local/bin/node",
      port: "4321",
    });
    expect(posixSpec(prod.proxy)).toEqual({
      command: "/usr/local/bin/node",
      args: ["/app/deepaa/dist/proxy/proxy-server.mjs"],
    });
    // 生产 web 进程独占堆上限（2026-10-10 用户确认 768M）：进程级旗标，只进 web
    // spec；代理 / 构建不携带。
    expect(posixSpec(prod.web)).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "--disable-warning=ExperimentalWarning",
        "--max-old-space-size=768",
        "/app/deepaa/node_modules/next/dist/bin/next",
        "start",
        "-p",
        "4321",
        "-H",
        "127.0.0.1",
      ],
    });
    expect(posixSpec(specs.web)).toEqual({
      command: "/usr/local/bin/node",
      args: [
        // node:sqlite experimental 警告抑制（web 进程打开数据库）。
        "--disable-warning=ExperimentalWarning",
        "/app/deepaa/node_modules/next/dist/bin/next",
        "dev",
        "-p",
        "4321",
        // 全站统一 127.0.0.1：Web 进程只绑定回环地址。
        "-H",
        "127.0.0.1",
      ],
    });
    expect(posixSpec(specs.proxyBuild)).toEqual({
      command: "/usr/local/bin/node",
      args: ["/app/deepaa/scripts/build-proxy.mjs"],
    });
    expect(specs.webBuild.args).toContain("build");
    expect(posixSpec(specs.traceNormalize)).toEqual({
      command: "/usr/local/bin/node",
      args: ["/app/deepaa/scripts/normalize-next-trace.mjs"],
    });
    expect(posixSpec(specs.traceVerify)).toEqual({
      command: "/usr/local/bin/node",
      args: ["/app/deepaa/scripts/verify-next-trace.mjs"],
    });
  });

  test.each([
    {args: ["open"], expected: ["proxy", "web"]},
    {args: ["dev"], expected: ["proxy", "web"]},
    {args: ["dev", "web"], expected: ["web"]},
    {args: ["proxy"], expected: ["proxy"]},
    {args: ["web"], expected: ["web"]},
  ])("$args 运行时不隐式构建", async ({args, expected}) => {
    const harness = createSpawnHarness();
    const running = runDeepaa({
      args,
      rootDir: "/app/deepaa",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "22.19.0",
      spawnProcess: harness.spawnProcess,
      signalEmitter: harness.signals,
      stdout: harness.stdout,
      stderr: harness.stderr,
    });
    await nextTurn();

    expect(harness.calls.map(call => processName(call.args))).toEqual(expected);
    for (const child of harness.children) child.finish(0);
    await running;
  });

  test("build 显式且顺序构建代理、Web、规范化并校验 Next 追踪清单", async () => {
    const harness = createSpawnHarness();
    const running = runDeepaa({
      args: ["build"],
      rootDir: "/app/deepaa",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "22.19.0",
      spawnProcess: harness.spawnProcess,
      signalEmitter: harness.signals,
      stdout: harness.stdout,
      stderr: harness.stderr,
    });
    await nextTurn();
    expect(harness.calls.map(call => processName(call.args))).toEqual(["proxyBuild"]);

    harness.children[0]!.finish(0);
    await nextTurn();
    expect(harness.calls.map(call => processName(call.args))).toEqual([
      "proxyBuild",
      "webBuild",
    ]);
    harness.children[1]!.finish(0);
    await nextTurn();
    expect(harness.calls.map(call => processName(call.args))).toEqual([
      "proxyBuild",
      "webBuild",
      "traceNormalize",
    ]);
    harness.children[2]!.finish(0);
    await nextTurn();
    expect(harness.calls.map(call => processName(call.args))).toEqual([
      "proxyBuild",
      "webBuild",
      "traceNormalize",
      "traceVerify",
    ]);
    harness.children[3]!.finish(0);

    await expect(running).resolves.toMatchObject({command: "build", code: 0});
  });

  test("代理退出不会终止或重启 Web，等待 Web 自行退出", async () => {
    const harness = createSpawnHarness();
    let settled = false;
    const running = runDeepaa({
      args: ["open"],
      rootDir: "/app/deepaa",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "22.19.0",
      spawnProcess: harness.spawnProcess,
      signalEmitter: harness.signals,
      stdout: harness.stdout,
      stderr: harness.stderr,
    }).finally(() => {
      settled = true;
    });
    await nextTurn();

    harness.children[0]!.finish(17);
    await nextTurn();
    expect(settled).toBe(false);
    expect(harness.children[1]!.killed).toBe(false);
    expect(harness.calls).toHaveLength(2);

    harness.children[1]!.finish(0);
    await expect(running).resolves.toMatchObject({
      command: "all",
      results: [
        {process: "proxy", code: 17},
        {process: "web", code: 0},
      ],
    });
  });

  test("Web 退出不会终止或重启代理", async () => {
    const harness = createSpawnHarness();
    const running = runDeepaa({
      args: ["open"],
      rootDir: "/app/deepaa",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "22.19.0",
      spawnProcess: harness.spawnProcess,
      signalEmitter: harness.signals,
      stdout: harness.stdout,
      stderr: harness.stderr,
    });
    await nextTurn();

    harness.children[1]!.finish(1);
    await nextTurn();
    expect(harness.children[0]!.killed).toBe(false);
    expect(harness.calls).toHaveLength(2);

    harness.children[0]!.finish(0);
    await running;
  });

  test("只有显式终止信号才停止仍存活的子进程", async () => {
    const harness = createSpawnHarness();
    const running = runDeepaa({
      args: ["open"],
      rootDir: "/app/deepaa",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "22.19.0",
      // 钉住 POSIX kill 语义：本用例经 harness fake child 验证信号→kill 接线；
      // win32 分支会 spawn 真实 taskkill.exe 而不调用 child.kill，fake child
      // 永不退出导致超时（taskkill 行为属生产路径，不在单测覆盖）。
      platform: "darwin",
      spawnProcess: harness.spawnProcess,
      signalEmitter: harness.signals,
      stdout: harness.stdout,
      stderr: harness.stderr,
    });
    await nextTurn();

    harness.signals.emit("SIGTERM");
    await expect(running).resolves.toMatchObject({command: "all"});
    expect(harness.children.map(child => child.killed)).toEqual([true, true]);
  });

  test("发布 Node ESM bin 且不存在 Bash 入口", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")) as {
      bin: Record<string, string>;
    };
    const source = await readFile(new URL("../bin/deepaa.mjs", import.meta.url), "utf-8");

    expect(packageJson.bin["deepaa"]).toBe("./bin/deepaa.mjs");
    expect(source).toContain("SIGINT");
    expect(source).toContain("SIGTERM");
    if (process.platform !== "win32") {
      const info = await stat(new URL("../bin/deepaa.mjs", import.meta.url));
      expect(info.mode & 0o111).not.toBe(0);
    }
    await expect(access(new URL("../bin/inspector", import.meta.url))).rejects.toThrow();
  });
});

describe("Next 启动横幅过滤", () => {
  test.each([
    ["- Local:         http://127.0.0.1:3210\n", true],
    ["- Network:       http://127.0.0.1:3210\n", true],
    ["\u001B[32m- Local:\u001B[39m         http://127.0.0.1:3210\n", true],
    ["▲ Next.js 16.2.6\n", false],
    ["✓ Ready in 312ms\n", false],
    ["- Debugger port: 9229\n", false],
    ["- Environments: .env.local\n", false],
    ["[deepaa] provider sync scheduler started (tick 10s)\n", false],
  ])("按行判定是否抑制 %j", (line, expected) => {
    expect(isSuppressedNextBannerLine(line)).toBe(expected);
  });

  test("过滤流丢弃横幅行并按字节保留其余输出", () => {
    const output: string[] = [];
    const filter = createNextBannerFilter({write: (chunk: string) => {
      output.push(chunk);
      return true;
    }});
    const input = [
      "▲ Next.js 16.2.6\n",
      "- Local:         http://127.0.0.1:3210\n",
      "- Network:       http://127.0.0.1:3210\n",
      "✓ Ready in 312ms\n",
      "[deepaa] web ready\n",
    ].join("");
    for (let offset = 0; offset < input.length; offset += 13) {
      filter.write(input.slice(offset, offset + 13));
    }

    expect(output.join("")).toBe("▲ Next.js 16.2.6\n✓ Ready in 312ms\n[deepaa] web ready\n");
  });

  test("无换行的尾行在 flush 时保留且横幅行被丢弃", () => {
    const output: string[] = [];
    const filter = createNextBannerFilter({write: (chunk: string) => {
      output.push(chunk);
      return true;
    }});

    filter.write("- Network:       http://127.0.0.1:3210\nwaiting for shutdown");
    expect(output).toEqual([]);
    filter.flush();
    expect(output).toEqual(["waiting for shutdown"]);
  });

  test("Web 子进程 stdout 走管道并隐藏重复的 Local/Network 行", async () => {
    const harness = createSpawnHarness();
    const running = runDeepaa({
      args: ["web"],
      rootDir: "/app/deepaa",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "22.19.0",
      spawnProcess: harness.spawnProcess,
      signalEmitter: harness.signals,
      stdout: harness.stdout,
      stderr: harness.stderr,
    });
    await nextTurn();

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.stdio).toEqual(["inherit", "pipe", "inherit"]);
    const web = harness.children[0]!;
    web.stdout!.emit(
      "data",
      "▲ Next.js 16.2.6\n"
        + "- Local:         http://127.0.0.1:3210\n"
        + "- Network:       http://127.0.0.1:3210\n"
        + "✓ Ready in 312ms\n",
    );
    web.stdout!.emit("data", "waiting for shutdown");
    web.stdout!.emit("end");
    web.finish(0);
    await running;

    const text = harness.output.join("");
    expect(text).toContain("Web UI: http://127.0.0.1:3210");
    expect(text).toContain("▲ Next.js 16.2.6");
    expect(text).toContain("✓ Ready in 312ms");
    expect(text).toContain("waiting for shutdown");
    expect(text).not.toContain("- Local:");
    expect(text).not.toContain("- Network:");
  });

  test("代理与构建子进程仍使用继承的 stdio", async () => {
    const harness = createSpawnHarness();
    const running = runDeepaa({
      args: ["proxy"],
      rootDir: "/app/deepaa",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "22.19.0",
      spawnProcess: harness.spawnProcess,
      signalEmitter: harness.signals,
      stdout: harness.stdout,
      stderr: harness.stderr,
    });
    await nextTurn();

    expect(harness.calls[0]!.stdio).toBe("inherit");
    harness.children[0]!.finish(0);
    await running;
  });
});

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  killed: boolean;
  pid: number;
  stdout?: FakeStdout;
  kill(signal?: NodeJS.Signals): boolean;
  finish(code: number, signal?: NodeJS.Signals | null): void;
}

interface FakeStdout extends EventEmitter {
  setEncoding(): FakeStdout;
  pause(): FakeStdout;
  resume(): FakeStdout;
}

function createSpawnHarness() {
  const calls: Array<{command: string; args: string[]; stdio: unknown}> = [];
  const children: FakeChild[] = [];
  const signals = new EventEmitter();
  const output: string[] = [];
  const spawnProcess = (command: string, args: string[], options?: {stdio?: unknown}) => {
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.killed = false;
    child.pid = children.length + 1;
    if (Array.isArray(options?.stdio) && options.stdio[1] === "pipe") {
      const stdout = new EventEmitter() as FakeStdout;
      stdout.setEncoding = () => stdout;
      stdout.pause = () => stdout;
      stdout.resume = () => stdout;
      child.stdout = stdout;
    }
    child.finish = (code, signal = null) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      queueMicrotask(() => child.emit("exit", code, signal));
    };
    child.kill = () => {
      if (child.exitCode !== null || child.killed) return false;
      child.killed = true;
      child.finish(0, "SIGTERM");
      return true;
    };
    calls.push({command, args: [...args], stdio: options?.stdio});
    children.push(child);
    return child;
  };
  return {
    calls,
    children,
    signals,
    spawnProcess,
    output,
    stdout: {write: (value: string) => output.push(value)},
    stderr: {write: (value: string) => output.push(value)},
  };
}

function processName(args: string[]): string {
  if (args[0]?.endsWith("proxy-server.mjs")) return "proxy";
  // 开发模式代理：tsx watch <cli.mjs> watch src/proxy-server.ts
  if (args[1] === "watch" && args[2]?.endsWith("proxy-server.ts")) return "proxy";
  if (args[0]?.endsWith("build-proxy.mjs")) return "proxyBuild";
  if (args[0]?.endsWith("normalize-next-trace.mjs")) return "traceNormalize";
  if (args[0]?.endsWith("verify-next-trace.mjs")) return "traceVerify";
  if (args[1] === "build") return "webBuild";
  return "web";
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe("service install / start CLI 收尾（2026-10-06：验证 + 诚实输出 + 打开控制台）", () => {
  const cliSandbox = join(tmpdir(), `deepaa-bin-cli-${process.pid}`);
  const cliHome = join(cliSandbox, "home");
  const cliData = join(cliSandbox, "data");
  const noListenerRunSync = () => ({code: 1, stdout: ""});

  /** 拟真 launchctl：print 按 inDomain 返回，其余成功。 */
  function launchctlStubExec(options: {inDomain?: boolean} = {}) {
    const calls: Array<{command: string; args: string[]}> = [];
    const exec = (command: string, args: string[]) => {
      calls.push({command, args: [...args]});
      if (command === "launchctl" && args[0] === "print") {
        return Promise.resolve({code: options.inDomain ? 0 : 1, stdout: "", stderr: ""});
      }
      return Promise.resolve({code: 0, stdout: "", stderr: ""});
    };
    return {calls, exec};
  }

  async function writeStubPlists() {
    await mkdir(join(cliHome, "Library", "LaunchAgents"), {recursive: true});
    await writeFile(join(cliHome, "Library", "LaunchAgents", "dev.deepaa.web.plist"), "stub", "utf8");
    await writeFile(join(cliHome, "Library", "LaunchAgents", "dev.deepaa.proxy.plist"), "stub", "utf8");
  }

  afterAll(async () => {
    await rm(cliSandbox, {recursive: true, force: true});
  });

  test("install：注册输出 + 端口就绪验证 + 打开一次控制台", async () => {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    const lines: string[] = [];
    const opened: string[] = [];
    // 前 2 次端口探测（install 阶段 web/proxy）视为空闲 → 不触发接管；
    // 之后（验证阶段）视为就绪。
    let probeCalls = 0;
    const result = await runDeepaaCommand({
      args: ["service", "install"],
      platform: "darwin",
      uid: 501,
      homeDir: cliHome,
      dataDir: cliData,
      exec: launchctlStubExec({inDomain: false}).exec,
      runSync: noListenerRunSync,
      probes: {
        probePort: async () => ++probeCalls > 2,
        fetchHealth: async () => ({state: "deepaa"}),
      },
      openBrowser: async url => opened.push(url),
      output: text => lines.push(text),
    });
    expect(result.command).toBe("service");
    const text = lines.join("\n");
    expect(text).toContain("已注册（登录自启；崩溃自动恢复）");
    expect(text).toContain("Web 服务：已启动（:3210）");
    expect(text).toContain("代理服务：已启动（:3211）");
    expect(text).toContain("控制台已打开：http://127.0.0.1:3210");
    expect(opened).toEqual(["http://127.0.0.1:3210"]);
  });

  test("install 验证失败：诚实报告未确认 + 日志路径，并抛错（退出码非 0）", async () => {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    const lines: string[] = [];
    const opened: string[] = [];
    await expect(runDeepaaCommand({
      args: ["service", "install"],
      platform: "darwin",
      uid: 501,
      homeDir: cliHome,
      dataDir: cliData,
      exec: launchctlStubExec({inDomain: false}).exec,
      runSync: noListenerRunSync,
      probes: {
        probePort: async () => false,
        fetchHealth: async () => ({state: "down"}),
      },
      timeoutMs: 30,
      openBrowser: async url => opened.push(url),
      output: text => lines.push(text),
    })).rejects.toThrow("服务启动未确认");
    const text = lines.join("\n");
    expect(text).toContain("启动未确认");
    expect(text).toContain(join(cliData, "logs", "web.err.log"));
    expect(text).toContain(join(cliData, "logs", "proxy.err.log"));
    expect(opened).toEqual([]);
  });

  test("start 未注册：给出可执行指引而非 launchctl 报错翻译", async () => {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    const emptyHome = join(cliSandbox, "home-empty");
    await expect(runDeepaaCommand({
      args: ["service", "start"],
      platform: "darwin",
      uid: 501,
      homeDir: emptyHome,
      dataDir: cliData,
      exec: launchctlStubExec().exec,
      runSync: noListenerRunSync,
      probes: {probePort: async () => false, fetchHealth: async () => ({state: "down"})},
      output: () => {},
    })).rejects.toThrow("尚未注册系统服务");
  });

  test("start 已注册且已在运行：报告本就在运行 + 仍打开一次控制台", async () => {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    await writeStubPlists();
    const lines: string[] = [];
    const opened: string[] = [];
    await runDeepaaCommand({
      args: ["service", "start"],
      platform: "darwin",
      uid: 501,
      homeDir: cliHome,
      dataDir: cliData,
      exec: launchctlStubExec().exec,
      runSync: noListenerRunSync,
      probes: {probePort: async () => true, fetchHealth: async () => ({state: "deepaa"})},
      openBrowser: async url => opened.push(url),
      output: text => lines.push(text),
    });
    const text = lines.join("\n");
    expect(text).toContain("Web 服务：本就在运行（:3210）");
    expect(text).toContain("代理服务：本就在运行（:3211）");
    expect(text).toContain("控制台已打开：http://127.0.0.1:3210");
    expect(opened).toEqual(["http://127.0.0.1:3210"]);
  });
});

describe("service uninstall 文案（2026-10-07 用户确认：注销 ≠ 停止）", () => {
  const unSandbox = join(tmpdir(), `deepaa-bin-uninstall-${process.pid}`);
  const unHome = join(unSandbox, "home");
  const unData = join(unSandbox, "data");
  const noListenerRunSync = () => ({code: 1, stdout: ""});

  afterAll(async () => {
    await rm(unSandbox, {recursive: true, force: true});
  });

  test("运行中：移除注册、提示 deepaa stop，绝不停止进程", async () => {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    const lines: string[] = [];
    await runDeepaaCommand({
      args: ["service", "uninstall"],
      platform: "darwin",
      uid: 501,
      homeDir: unHome,
      dataDir: unData,
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      runSync: noListenerRunSync,
      probes: {probePort: async () => true, fetchHealth: async () => ({state: "deepaa"})},
      output: text => lines.push(text),
    });
    const text = lines.join("\n");
    expect(text).toContain("服务注册已移除（不再开机自启）");
    expect(text).toContain("正常运行中，如需停止请执行 deepaa stop。");
    expect(text).not.toContain("进程已停止");
    expect(text).not.toContain("数据目录保持不变");
  });

  test("未运行：只报移除注册，不提 stop 提示", async () => {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    const lines: string[] = [];
    await runDeepaaCommand({
      args: ["service", "uninstall"],
      platform: "darwin",
      uid: 501,
      homeDir: unHome,
      dataDir: unData,
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      runSync: noListenerRunSync,
      probes: {probePort: async () => false, fetchHealth: async () => ({state: "down"})},
      output: text => lines.push(text),
    });
    const text = lines.join("\n");
    expect(text.trim()).toBe("服务注册已移除（不再开机自启）。");
  });
});

describe("deepaa status 注册口径（2026-10-07 方案 1：零 sfltool，合并文案）", () => {
  const stSandbox = join(tmpdir(), `deepaa-bin-status-${process.pid}`);
  const stHome = join(stSandbox, "home");
  const stData = join(stSandbox, "data");

  afterAll(async () => {
    await rm(stSandbox, {recursive: true, force: true});
  });

  async function runStatus(
    probes: {probePort: (port: number) => Promise<boolean>; fetchHealth: (port: number) => Promise<{state: string}>},
    platform = "darwin",
  ) {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    const lines: string[] = [];
    await runDeepaaCommand({
      args: ["status"],
      platform,
      uid: 501,
      homeDir: stHome,
      dataDir: stData,
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      runSync: () => ({code: 0, stdout: "321"}),
      probes,
      output: text => lines.push(text),
    });
    return lines.join("\n");
  }

  test("已注册但未运行（macOS）：诚实合并文案——统一限定语覆盖置灰可能", async () => {
    await mkdir(join(stHome, "Library", "LaunchAgents"), {recursive: true});
    await writeFile(join(stHome, "Library", "LaunchAgents", "dev.deepaa.web.plist"), "stub", "utf8");
    await writeFile(join(stHome, "Library", "LaunchAgents", "dev.deepaa.proxy.plist"), "stub", "utf8");
    const text = await runStatus({probePort: async () => false, fetchHealth: async () => ({state: "down"})});
    expect(text).toContain("Web 服务（:3210）：未运行；已注册系统服务（当前停止；下次登录自动运行——若你曾在系统设置关闭「允许在后台」则不会）");
    expect(text).toContain("代理服务（:3211）：未运行；已注册系统服务（当前停止；下次登录自动运行——若你曾在系统设置关闭「允许在后台」则不会）");
  });

  test("已注册且运行中（macOS）：登录自启断言带统一限定语", async () => {
    const text = await runStatus({probePort: async () => true, fetchHealth: async () => ({state: "deepaa"})});
    expect(text).toContain("Web 服务（:3210）：运行中（PID 321）；已注册系统服务（登录自启——若你曾在系统设置关闭「允许在后台」则不会）");
    expect(text).toContain("代理服务（:3211）：运行中（PID 321）；已注册系统服务（登录自启——若你曾在系统设置关闭「允许在后台」则不会）");
  });

  test("Windows：置灰是 macOS 登录项语义，文案不加限定语", async () => {
    const text = await runStatus({probePort: async () => true, fetchHealth: async () => ({state: "deepaa"})}, "win32");
    expect(text).toContain("已注册系统服务（登录自启）");
    expect(text).not.toContain("允许在后台");
  });

  test("未注册：「未注册服务」", async () => {
    await rm(join(stHome, "Library", "LaunchAgents", "dev.deepaa.web.plist"), {force: true});
    await rm(join(stHome, "Library", "LaunchAgents", "dev.deepaa.proxy.plist"), {force: true});
    const text = await runStatus({probePort: async () => false, fetchHealth: async () => ({state: "down"})});
    expect(text).toContain("未注册服务");
    expect(text).not.toContain("当前停止");
  });
});

describe("deepaa stop 尾行限定语（2026-10-07 用户确认）", () => {
  const stopSandbox = join(tmpdir(), `deepaa-bin-stop-${process.pid}`);
  const stopHome = join(stopSandbox, "home");
  const stopData = join(stopSandbox, "data");

  afterAll(async () => {
    await rm(stopSandbox, {recursive: true, force: true});
  });

  async function runStop(platform: string) {
    const {runDeepaaCommand} = await import("../bin/deepaa.mjs");
    // 预置 plist（macOS 注册判定）；Windows 由 schtasks 桩判定已注册。
    await mkdir(join(stopHome, "Library", "LaunchAgents"), {recursive: true});
    await writeFile(join(stopHome, "Library", "LaunchAgents", "dev.deepaa.web.plist"), "stub", "utf8");
    await writeFile(join(stopHome, "Library", "LaunchAgents", "dev.deepaa.proxy.plist"), "stub", "utf8");
    const lines: string[] = [];
    await runDeepaaCommand({
      args: ["stop"],
      platform,
      uid: 501,
      homeDir: stopHome,
      dataDir: stopData,
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      runSync: () => ({code: 0, stdout: ""}),
      probes: {probePort: async () => false, fetchHealth: async () => ({state: "down"})},
      output: text => lines.push(text),
    });
    return lines.join("\n");
  }

  test("macOS：下次登录自动运行断言带统一限定语", async () => {
    const text = await runStop("darwin");
    expect(text).toContain("已注册系统服务：仅停止当前运行，注册保留（下次登录自动运行——若你曾在系统设置关闭「允许在后台」则不会）。");
  });

  test("Windows：保持原文，不加限定语", async () => {
    const text = await runStop("win32");
    expect(text).toContain("已注册系统服务：仅停止当前运行，注册保留（下次登录自动运行）。");
    expect(text).not.toContain("允许在后台");
  });
});
