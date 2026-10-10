#!/usr/bin/env node

import {spawn} from "node:child_process";
import {realpathSync} from "node:fs";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {resolveDeepaaDataDir} from "../src/lib/data-paths-runtime.mjs";

const MINIMUM_NODE_MAJOR = 22;
/**
 * node:sqlite（2026-10-08 起的唯一 SQLite 驱动）免实验旗标的最低版本：
 * 22.x 线自 22.13 起、23.x 线自 23.4 起（23.0–23.3 仍需 --experimental-sqlite，
 * 不放行）；24+ 不在表内即任意版本可用（2026-10-08 Claude 审核修复）。
 */
const NODE_SQLITE_FREE_FLAG_MINORS = new Map([[22, 13], [23, 4]]);
const RUNTIME_COMMANDS = new Set(["proxy", "web"]);
/** 批次 2（2026-10-05 用户确认）：短命智能启动器与服务管理子命令。
 * 语义互换（2026-10-05 用户定稿）：deepaa start = 智能启动别名（与 service start
 * 含义对齐）；deepaa open = 前台运行（开发/调试）。 */
const SERVICE_COMMANDS = new Set(["service", "icon"]);
const LAUNCH_COMMANDS = new Set(["launch", "start"]);
const CONTROL_COMMANDS = new Set(["stop", "status"]);
/** F4：已知首参全集——集合外的非旗标首参按未知命令报错并引导 help。 */
const KNOWN_FIRST_ARGUMENTS = new Set([
  ...LAUNCH_COMMANDS, ...CONTROL_COMMANDS, ...SERVICE_COMMANDS,
  "open", "dev", "proxy", "web", "build", "help", "--help", "-h", "--prod",
]);

export function buildDeepaaHelpText() {
  return `DeepAA 命令清单

1. 启动与停止

  deepaa                启动 DeepAA，自动启动 Web 与代理服务，并打开 Web 控制台：
                        http://127.0.0.1:3210
                        关闭终端或浏览器不影响 DeepAA 运行。

  deepaa start          同上，deepaa 的别名。

  deepaa stop           停止 Web 与代理服务。
                        已注册系统服务时，仅停止当前运行，不取消服务注册。

  deepaa status         查看 Web 与代理服务的运行状态。
                        只读，不修改任何配置。

2. 系统服务（可选）

  deepaa service install     注册并启动系统服务：
                             登录系统后自动运行，进程崩溃自动恢复。
                             启动完成后自动打开 Web 控制台。

  deepaa service uninstall   注销系统服务，不再开机自启。
                             运行中的 Web 与代理服务不受影响，
                             如需停止请执行 deepaa stop。

  deepaa service status      查看系统服务的注册与运行状态。

  deepaa service start       启动已注册的系统服务，并打开 Web 控制台。

  deepaa service stop        停止系统服务，但保留注册状态。
                             下次登录或执行 start 时可再次启动。

  deepaa service restart     重启系统服务，并打开 Web 控制台。

3. 快捷入口

  DeepAA 安装时自动创建应用快捷入口：
  macOS：应用程序 → DeepAA
  Windows：开始菜单 → DeepAA
  → 点击即可启动并打开控制台

  deepaa icon uninstall     移除 DeepAA 应用快捷入口。

4. 开发与进阶

  deepaa open           前台运行 Web 与代理服务。
                        Ctrl-C 停止，仅用于开发与调试。

  deepaa dev [web / proxy]
                        开发模式，支持源码热更新。
                        默认运行 Web 与代理；web / proxy 仅运行对应进程。

  deepaa proxy           仅前台运行代理服务（:3211）。

  deepaa web             仅前台运行 Web 服务（:3210）。

  deepaa build           构建生产环境产物。`;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const [majorPart, minorPart] = String(version).split(".");
  const major = Number.parseInt(majorPart || "", 10);
  const minor = Number.parseInt((minorPart || "0").split(/[^\d]/)[0] || "0", 10);
  const requiredMinor = NODE_SQLITE_FREE_FLAG_MINORS.get(major);
  const supported = Number.isInteger(major)
    && major >= MINIMUM_NODE_MAJOR
    && (requiredMinor === undefined || minor >= requiredMinor);
  if (!supported) {
    throw new Error(`需要 Node.js 22.13+ 或 23.4+（当前版本为 ${version}）`);
  }
}

export function parseDeepaaArguments(args = []) {
  const values = [...args];
  const first = values[0];
  let command = "all";
  let production = true;
  let commandArgs = [];

  if (first === undefined) {
    // 裸 `deepaa`（零参数）= 短命智能启动器（批次 2 定稿）：检测端口、补缺服务、
    // 开浏览器、退出。任何显式参数（含未知旗标）保持既有前台 all 语义不变。
    command = "launch";
  } else if (first === "launch" || first === "start") {
    // start（2026-10-05 用户定稿）= 智能启动别名，与 service start 含义对齐。
    command = "launch";
    values.shift();
  } else if (first === "help" || first === "--help" || first === "-h") {
    command = "help";
    values.shift();
  } else if (CONTROL_COMMANDS.has(first) || SERVICE_COMMANDS.has(first)) {
    command = first;
    values.shift();
    commandArgs = values.splice(0);
  } else if (!KNOWN_FIRST_ARGUMENTS.has(first) && !first.startsWith("-")) {
    // F4：未知命令词直接报错并引导 help（旗标参数仍按原样透传给底层 CLI）。
    throw new Error(`未知命令：${first} —— 执行 deepaa help 查看全部命令`);
  } else if (first === "dev") {
    command = "all";
    production = false;
    values.shift();
    if (values[0] === "web" || values[0] === "proxy") {
      command = values[0];
      values.shift();
    }
  } else if (first === "open") {
    // open（2026-10-05 用户定稿）= 前台运行 Web 与代理（开发/调试）。
    command = "all";
    values.shift();
  } else if (first === "proxy" || first === "web" || first === "build") {
    command = first;
    values.shift();
  } else if (first === "--prod") {
    command = "all";
    values.shift();
  }

  if (!production && values.includes("--prod")) {
    throw new Error("不能同时指定 dev 和 --prod");
  }
  if (command === "proxy" || command === "build") {
    if (values.length > 0) throw new Error(`${command} 命令不接受额外参数`);
  }

  return {command, production, nextArgs: values, commandArgs};
}

/**
 * 开发模式代理热更新（2026-10-05 用户确认）：production=false 时代理子进程改走
 * `tsx watch src/proxy-server.ts`（此前跑 dist 产物无热更）。tsx 为 devDependency
 * ——发布安装形态下不存在，解析失败时回退 dist 产物（终端用户本就不该用 dev）。
 */
export function resolveTsxWatchCli(rootDir) {
  try {
    const tsxPackageJson = createRequire(import.meta.url).resolve("tsx/package.json");
    return join(dirname(tsxPackageJson), "dist", "cli.mjs");
  } catch {
    return join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

export function buildDeepaaProcessSpecs(input) {
  const nextCli = input.nextCli
    || join(input.rootDir, "node_modules", "next", "dist", "bin", "next");
  const proxyDistSpec = {
    command: input.nodeExecutable,
    args: [join(input.rootDir, "dist", "proxy", "proxy-server.mjs")],
  };
  const proxySpec = input.production === true
    ? proxyDistSpec
    : (() => {
        const tsxCli = input.tsxCli ?? resolveTsxWatchCli(input.rootDir);
        return tsxCli
          ? {command: input.nodeExecutable, args: [tsxCli, "watch", join(input.rootDir, "src", "proxy-server.ts")]}
          : proxyDistSpec;
      })();
  return {
    proxyBuild: {
      command: input.nodeExecutable,
      args: [join(input.rootDir, "scripts", "build-proxy.mjs")],
    },
    webBuild: {
      command: input.nodeExecutable,
      args: [nextCli, "build"],
    },
    traceNormalize: {
      command: input.nodeExecutable,
      args: [join(input.rootDir, "scripts", "normalize-next-trace.mjs")],
    },
    traceVerify: {
      command: input.nodeExecutable,
      args: [join(input.rootDir, "scripts", "verify-next-trace.mjs")],
    },
    proxy: proxySpec,
    web: {
      command: input.nodeExecutable,
      args: [
        // node:sqlite 在文档口径仍标 experimental：抑制其一次性 ExperimentalWarning，
        // 避免每次启动在用户终端/日志里制造噪音（仅 web 进程会打开数据库）。
        "--disable-warning=ExperimentalWarning",
        // web 进程 V8 老生代堆上限（2026-10-10 用户确认 768M）：进程级旗标，只约束
        // 本 web 进程树——代理 / next build / 任何其它 Node 进程不受影响。堆逼近上限
        // 时 GC 提前收割瞬态垃圾（导入回放/派生解析的大字符串），把活跃使用期的
        // RSS 峰值钉住（实测无上限时可拖到 1.4G+）。仅生产服务设置：dev 编译自身
        // 需要更大堆，不设。
        ...(input.production ? ["--max-old-space-size=768"] : []),
        nextCli,
        input.production ? "start" : "dev",
        "-p",
        input.port,
        // 全站统一 127.0.0.1：只绑定回环地址（用户可用 nextArgs 传 -H 覆盖）。
        "-H",
        "127.0.0.1",
        ...input.nextArgs,
      ],
    },
  };
}

export function resolveLauncherDataDir(options) {
  // 源码模式与安装模式统一使用用户目录（~/.deepaa），
  // 只有显式 sourceCheckout: true 才回退到项目根 data/（测试等场景）。
  const sourceCheckout = options.sourceCheckout ?? false;
  return resolveDeepaaDataDir(options.rootDir, {
    env: options.env,
    platform: options.platform || process.platform,
    homeDir: options.homeDir || homedir(),
    sourceCheckout,
  });
}

export function buildDeepaaChildEnvironment(input) {
  const common = {
    ...input.baseEnv,
    DEEPAA_DATA_DIR: input.dataDir,
    NODE_ENV: input.production ? "production" : "development",
  };
  return {
    proxy: {...common},
    web: {...common},
  };
}

const NEXT_BANNER_LINE_PATTERN = /^\s*-\s*(?:Local|Network):/;
const ANSI_SGR_PATTERN = /\u001B\[[0-9;]*m/g;

export function isSuppressedNextBannerLine(line) {
  return NEXT_BANNER_LINE_PATTERN.test(line.replace(ANSI_SGR_PATTERN, ""));
}

export function createNextBannerFilter(output) {
  let pending = "";
  let lastFlow = true;
  return {
    write(chunk) {
      pending += chunk;
      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newlineIndex + 1);
        pending = pending.slice(newlineIndex + 1);
        if (isSuppressedNextBannerLine(line)) continue;
        lastFlow = output.write(line);
      }
      return lastFlow;
    },
    flush() {
      const rest = pending;
      pending = "";
      if (rest && !isSuppressedNextBannerLine(rest)) output.write(rest);
    },
  };
}

// DeepAA 启动行已打印 Web UI 地址，且 Web 固定绑定 127.0.0.1，
// Next 的 Local/Network 两行必然与之重复，故对 web 子进程 stdout 做行级过滤；
// 代理与构建子进程仍直通。
function attachNextBannerFilter(child, output) {
  const source = child.stdout;
  if (!source) return;
  const filter = createNextBannerFilter({
    write(chunk) {
      const flowed = output.write(chunk);
      if (!flowed) source.pause();
      return flowed;
    },
  });
  const drain = () => source.resume();
  output.on?.("drain", drain);
  source.setEncoding("utf8");
  source.on("data", chunk => filter.write(String(chunk)));
  source.once("end", () => {
    output.off?.("drain", drain);
    filter.flush();
  });
}

export async function runDeepaa(options = {}) {
  assertSupportedNodeVersion(options.nodeVersion || process.versions.node);
  const rootDir = options.rootDir || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseDeepaaArguments(options.args ?? process.argv.slice(2));
  const baseEnv = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const signalEmitter = options.signalEmitter || process;
  const spawnProcess = options.spawnProcess || spawn;
  const port = baseEnv.PORT || "3210";
  const proxyPort = baseEnv.PROXY_PORT || "3211";
  const dataDir = resolveLauncherDataDir({
    rootDir,
    cwd: options.cwd || process.cwd(),
    env: baseEnv,
    platform: options.platform,
    homeDir: options.homeDir,
    sourceCheckout: options.sourceCheckout,
  });
  const specs = buildDeepaaProcessSpecs({
    rootDir,
    production: parsed.production,
    nextArgs: parsed.nextArgs,
    nodeExecutable: options.nodeExecutable || process.execPath,
    nextCli: parsed.command === "proxy" ? undefined : resolveNextCli(rootDir),
    port,
  });
  const childEnvironments = buildDeepaaChildEnvironment({
    baseEnv,
    dataDir,
    production: parsed.production,
  });
  const buildSpawnOptions = {
    cwd: rootDir,
    env: childEnvironments.web,
    stdio: "inherit",
    // Windows：控制台子进程必须显式要求隐藏（2026-10-09 Windows 实测事故：
    // 守护化的 web/proxy 父进程本身无控制台，其派生的 next-server / 代理孙进程
    // 在 windowsHide:false 下会被 Windows 分配全新可见控制台窗口，关窗即杀进程）。
    // 前台交互场景父进程持有控制台，此标志无副作用。
    windowsHide: true,
  };

  if (parsed.command === "build") {
    return await runBuildCommand(specs, buildSpawnOptions, {
      spawnProcess,
      signalEmitter,
      stderr,
      platform: options.platform,
    });
  }

  const requested = parsed.command === "all"
    ? ["proxy", "web"]
    : [parsed.command];
  for (const name of requested) {
    if (!RUNTIME_COMMANDS.has(name)) throw new Error(`不支持的运行命令: ${name}`);
  }
  const startupLines = [
    "Starting DeepAA...",
    requested.includes("web") ? `  Web UI: http://127.0.0.1:${port}` : undefined,
    requested.includes("proxy") ? `  Proxy:  http://127.0.0.1:${proxyPort}` : undefined,
    `  Mode:   ${parsed.production ? "production" : "development"}`,
  ].filter(Boolean);
  stdout.write(`${startupLines.join("\n")}\n`);

  const activeChildren = new Set();
  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of activeChildren) {
      terminateChild(child, signal, options.platform);
    }
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  signalEmitter.on("SIGINT", onSigint);
  signalEmitter.on("SIGTERM", onSigterm);

  try {
    const results = await Promise.all(requested.map(name => runChild(
      name,
      specs[name],
      {
        cwd: rootDir,
        env: childEnvironments[name],
        stdio: name === "web" ? ["inherit", "pipe", "inherit"] : "inherit",
        // 同 buildSpawnOptions 注释：守护化（无控制台）父进程派生的运行时孙进程
        // 必须 windowsHide:true，否则 Windows 各弹一个可见控制台、关窗即停服务。
        windowsHide: true,
      },
      spawnProcess,
      activeChildren,
      name === "web" ? child => attachNextBannerFilter(child, stdout) : undefined,
    )));
    return {command: parsed.command, results};
  } finally {
    signalEmitter.off("SIGINT", onSigint);
    signalEmitter.off("SIGTERM", onSigterm);
  }
}

function resolveNextCli(rootDir) {
  try {
    return createRequire(import.meta.url).resolve("next/dist/bin/next");
  } catch {
    return join(rootDir, "node_modules", "next", "dist", "bin", "next");
  }
}

async function runBuildCommand(specs, spawnOptions, options) {
  const activeChildren = new Set();
  let currentChild;
  const shutdown = signal => {
    if (currentChild) terminateChild(currentChild, signal, options.platform);
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  options.signalEmitter.on("SIGINT", onSigint);
  options.signalEmitter.on("SIGTERM", onSigterm);

  try {
    for (const [name, spec] of [
      ["proxyBuild", specs.proxyBuild],
      ["webBuild", specs.webBuild],
      ["traceNormalize", specs.traceNormalize],
      ["traceVerify", specs.traceVerify],
    ]) {
      const result = await runChild(
        name,
        spec,
        spawnOptions,
        options.spawnProcess,
        activeChildren,
        child => { currentChild = child; },
      );
      currentChild = undefined;
      if (result.signal || result.code !== 0) {
        options.stderr.write(`${name} 失败${result.signal ? `，信号 ${result.signal}` : `，退出码 ${result.code}`}\n`);
        return {command: "build", ...result};
      }
    }
    return {command: "build", process: "build", code: 0, signal: null};
  } finally {
    options.signalEmitter.off("SIGINT", onSigint);
    options.signalEmitter.off("SIGTERM", onSigterm);
  }
}

function runChild(name, spec, spawnOptions, spawnProcess, activeChildren, onSpawn) {
  return new Promise(resolvePromise => {
    let child;
    try {
      child = spawnProcess(spec.command, spec.args, spawnOptions);
    } catch (error) {
      resolvePromise({process: name, code: 1, signal: null, error});
      return;
    }
    activeChildren.add(child);
    onSpawn?.(child);
    let settled = false;
    const settle = result => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      child.removeListener("error", handleError);
      child.removeListener("exit", handleExit);
      resolvePromise({process: name, ...result});
    };
    const handleError = error => settle({code: 1, signal: null, error});
    const handleExit = (code, signal) => settle({code: code ?? 1, signal});
    child.once("error", handleError);
    child.once("exit", handleExit);
  });
}

function terminateChild(child, signal, platform = process.platform) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (platform === "win32" && child.pid) {
    const taskkill = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.unref();
    return;
  }
  child.kill(signal);
}

function resultExitCode(result) {
  if (typeof result.code === "number") return result.code;
  const failed = result.results?.find(item => item.signal || item.code !== 0);
  return failed ? failed.code || 1 : 0;
}

export function isDeepaaMainModule(argvPath, moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return resolve(argvPath) === resolve(fileURLToPath(moduleUrl));
  }
}

/**
 * 登录项置灰限定语（2026-10-07 用户确认）：免密无法检测用户是否在系统设置关闭
 * 「允许在后台」（唯一信号是 root 调试工具 sfltool，用户终端会弹管理员授权框，
 * 产品命令零调用），因此所有「登录自启 / 下次登录自动运行」断言统一带此限定。
 * 仅 macOS（置灰是 macOS 登录项语义；Windows 禁用入口不同且未真机验收）。
 */
export function loginAutostartCaveat(platform = process.platform) {
  return platform === "darwin" ? "——若你曾在系统设置关闭「允许在后台」则不会" : "";
}

/**
 * 批次 2 服务命令分派（launch/stop/status/service/icon）。
 * 独立于 runDeepaa 的前台编排：短命令完成后即退出，不持有子进程生命周期。
 * options 直接透传给 bin/deepaa-service.mjs / bin/deepaa-icon.mjs（测试可注入
 * exec/spawn/probe/openBrowser/output）。
 */
export async function runDeepaaCommand(options = {}) {
  const parsed = parseDeepaaArguments(options.args ?? process.argv.slice(2));
  const service = await import("./deepaa-service.mjs");
  const output = options.output ?? (text => process.stdout.write(`${text}\n`));
  const shared = {
    ...(options.rootDir !== undefined ? {rootDir: options.rootDir} : {}),
    ...(options.homeDir !== undefined ? {homeDir: options.homeDir} : {}),
    ...(options.dataDir !== undefined ? {dataDir: options.dataDir} : {}),
    ...(options.env !== undefined ? {env: options.env} : {}),
    ...(options.platform !== undefined ? {platform: options.platform} : {}),
    ...(options.uid !== undefined ? {uid: options.uid} : {}),
    ...(options.exec !== undefined ? {exec: options.exec} : {}),
    ...(options.runSync !== undefined ? {runSync: options.runSync} : {}),
    ...(options.kill !== undefined ? {kill: options.kill} : {}),
    ...(options.probes !== undefined ? {probes: options.probes} : {}),
    ...(options.spawnProcess !== undefined ? {spawnProcess: options.spawnProcess} : {}),
    ...(options.openBrowser !== undefined ? {openBrowser: options.openBrowser} : {}),
    ...(options.openSync !== undefined ? {openSync: options.openSync} : {}),
    ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
  };
  if (parsed.command === "launch") {
    return {command: "launch", result: await service.smartLaunch({...shared, output})};
  }
  if (parsed.command === "help") {
    output(buildDeepaaHelpText());
    return {command: "help"};
  }
  if (parsed.command === "stop") {
    const summary = await service.stopServices(shared);
    for (const item of summary) {
      output(`  ${item.role === "web" ? "Web 服务" : "代理服务"}：${item.stopped ? "已停止" : "仍在运行（未能确认停止）"}`);
    }
    if (summary.some(item => item.installed)) {
      output(`  已注册系统服务：仅停止当前运行，注册保留（下次登录自动运行${loginAutostartCaveat(shared.platform)}）。`);
    }
    return {command: "stop", result: summary};
  }
  if (parsed.command === "status") {
    const entries = await service.readServiceStatus(shared);
    output("DeepAA 服务状态：");
    for (const entry of entries) {
      const name = entry.role === "web" ? "Web 服务" : "代理服务";
      const runState = entry.running ? `运行中${entry.pid ? `（PID ${entry.pid}）` : ""}` : "未运行";
      // 注册口径（2026-10-07 方案 1 用户确认）：置灰检测的唯一信号是 root 调试
      // 工具（会弹管理员授权框），产品命令零调用——「登录自启」断言统一带限定语
      //（仅 macOS），不猜用户是否置灰。
      const caveat = loginAutostartCaveat(shared.platform);
      let registration;
      if (!entry.installed) {
        registration = "未注册服务";
      } else if (entry.running) {
        registration = `已注册系统服务（登录自启${caveat}）`;
      } else {
        registration = `已注册系统服务（当前停止；下次登录自动运行${caveat}）`;
      }
      output(`  ${name}（:${entry.port}）：${runState}；${registration}`);
    }
    return {command: "status", result: entries};
  }
  if (parsed.command === "service") {
    const sub = parsed.commandArgs[0];
    if (sub === "install") {
      const summary = await service.installServices(shared);
      for (const item of summary) {
        output(`  ${item.role === "proxy" ? "代理" : "Web"}：${item.mode === "takeover" ? "已接管运行中的实例" : "已注册"}（登录自启；崩溃自动恢复）`);
      }
      await reportServiceReadiness({service, shared, output, summary});
      return {command: "service", result: summary};
    }
    if (sub === "uninstall") {
      const summary = await service.uninstallServices(shared);
      // 注销 ≠ 停止（2026-10-07 用户确认）：运行中的进程不受影响。
      if (summary.some(item => item.running)) {
        output("  服务注册已移除（不再开机自启），DeepAA 的 Web 与代理服务正常运行中，如需停止请执行 deepaa stop。");
      } else {
        output("  服务注册已移除（不再开机自启）。");
      }
      return {command: "service", result: summary};
    }
    if (sub === "status" || sub === undefined) {
      const entries = await service.readServiceStatus(shared);
      for (const entry of entries) {
        output(`  ${entry.role}：running=${entry.running} installed=${entry.installed}`);
      }
      return {command: "service", result: entries};
    }
    if (sub === "start") {
      // 未注册直接 start 是常见误用：给出可执行指引而不是 launchctl 报错翻译。
      const status = await service.readServiceStatus(shared);
      if (!status.some(entry => entry.installed)) {
        throw new Error("尚未注册系统服务——请先执行 deepaa service install；或直接运行 deepaa 以后台守护方式启动");
      }
      const summary = await service.startServices(shared);
      await reportServiceReadiness({service, shared, output, summary});
      return {command: "service", result: summary};
    }
    if (sub === "restart") {
      await service.stopServices(shared);
      const summary = await service.startServices(shared);
      await reportServiceReadiness({service, shared, output, summary});
      return {command: "service", result: summary};
    }
    if (sub === "stop") {
      const summary = await service.stopServices(shared);
      output("  服务已停止（注册保留，下次登录或 deepaa service start 再启动）。");
      return {command: "service", result: summary};
    }
    throw new Error(`未知的 service 子命令：${sub ?? "(空)"}（可用：install/uninstall/status/start/stop/restart）`);
  }
  if (parsed.command === "icon") {
    const icon = await import("./deepaa-icon.mjs");
    const sub = parsed.commandArgs[0];
    if (sub === "install") {
      // F2（2026-10-05 用户确认）：图标随 npm 安装自动完成，用户入口废弃。
      output("  桌面图标已随 npm 安装自动完成，无需手动安装。");
      output("  若图标缺失：直接运行 deepaa 会自动补齐；或重新执行 npm install -g deepaa。");
      return {command: "icon", result: {deprecated: "install"}};
    }
    if (sub === "uninstall") {
      const result = await icon.uninstallDesktopIcon(shared);
      output("  应用快捷入口已移除。");
      return {command: "icon", result};
    }
    throw new Error(`未知的 icon 子命令：${sub ?? "(空)"}（可用：uninstall；安装已自动化）`);
  }
  throw new Error(`DEEPAA_UNKNOWN_COMMAND:${parsed.command}`);
}

/**
 * install / start / restart 的公共收尾（2026-10-06 用户确认语义：一条命令完成
 * 「确保运行 + 验证 + 打开控制台」）：端口真的在监听才报告运行中，绝不谎报
 * "已启动"；任一角色未确认即抛错（退出码非 0）并给出日志路径。
 */
async function reportServiceReadiness({service, shared, output, summary}) {
  const probes = shared.probes ?? service.createDefaultProbes();
  const webPort = Number(shared.env?.PORT ?? process.env.PORT ?? service.DEFAULT_WEB_PORT);
  const proxyPort = Number(shared.env?.PROXY_PORT ?? process.env.PROXY_PORT ?? service.DEFAULT_PROXY_PORT);
  const dataDir = service.servicePaths({
    ...(shared.rootDir !== undefined ? {rootDir: shared.rootDir} : {}),
    ...(shared.homeDir !== undefined ? {homeDir: shared.homeDir} : {}),
    ...(shared.dataDir !== undefined ? {dataDir: shared.dataDir} : {}),
    ...(shared.env !== undefined ? {env: shared.env} : {}),
    ...(shared.platform !== undefined ? {platform: shared.platform} : {}),
  }).dataDir;
  const label = role => summary?.find(item => item.role === role)?.mode === "already-running"
    ? "本就在运行"
    : "已启动";
  const failures = [];
  try {
    await service.waitForWebReady({port: webPort, probes, ...(shared.timeoutMs !== undefined ? {timeoutMs: shared.timeoutMs} : {})});
    output(`  Web 服务：${label("web")}（:${webPort}）`);
  } catch (error) {
    output(`  Web 服务：${error instanceof Error ? error.message : "启动未确认"}——日志：${join(dataDir, "logs", "web.err.log")}`);
    failures.push("Web");
  }
  if (await service.waitForPortReady({port: proxyPort, probes, ...(shared.timeoutMs !== undefined ? {timeoutMs: shared.timeoutMs} : {})})) {
    output(`  代理服务：${label("proxy")}（:${proxyPort}）`);
  } else {
    output(`  代理服务：启动未确认（等待超时）——日志：${join(dataDir, "logs", "proxy.err.log")}`);
    failures.push("代理");
  }
  if (failures.length > 0) {
    throw new Error(`服务启动未确认（${failures.join("、")}）；请检查上述日志，或重试 deepaa service restart`);
  }
  await (shared.openBrowser ?? defaultOpenBrowserOnce)(`http://127.0.0.1:${webPort}`);
  output(`  控制台已打开：http://127.0.0.1:${webPort}`);
}

async function defaultOpenBrowserOnce(url) {
  const service = await import("./deepaa-service.mjs");
  const {command, args} = service.buildBrowserOpenCommand(url);
  const child = spawn(command, args, {detached: true, stdio: "ignore", windowsHide: true});
  child.unref?.();
}

if (isDeepaaMainModule(process.argv[1], import.meta.url)) {
  Promise.resolve().then(() => {
    const parsedForDispatch = parseDeepaaArguments(process.argv.slice(2));
    const commandMode = parsedForDispatch.command === "launch"
      || parsedForDispatch.command === "stop"
      || parsedForDispatch.command === "status"
      || parsedForDispatch.command === "help"
      || SERVICE_COMMANDS.has(parsedForDispatch.command);
    return (commandMode ? runDeepaaCommand() : runDeepaa()).then(result => {
      process.exitCode = commandMode ? 0 : resultExitCode(result);
    });
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "DEEPAA_START_FAILED"}\n`);
    process.exitCode = 1;
  });
}
