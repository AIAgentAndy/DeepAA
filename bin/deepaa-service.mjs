#!/usr/bin/env node

/**
 * DeepAA 用户级服务管理与智能启动器（批次 2 · C1/C3/C4/C5，2026-10-05 用户确认）。
 *
 * 设计要点（对应用户批准的方案）：
 * - **双独立服务**：macOS LaunchAgent `dev.deepaa.proxy` / `dev.deepaa.web`
 *   （RunAtLoad + KeepAlive{Crashed}——只崩溃自愈，绝不因配置/代码变更重启）；
 *   Windows 每用户计划任务 `DeepAA Proxy` / `DeepAA Web`（隐藏 VBS 包装，无窗口闪烁）。
 * - **统一入口**：`deepaa`（裸命令）= 短命智能启动器——检测 3210/3211，缺哪个补哪个
 *   （服务已装走 kickstart/bootstrap，未装走守护化 spawn），等 Web 就绪后开浏览器，
 *   自身退出；关终端/关浏览器不影响任何服务。
 * - **浏览器触发矩阵**（C4）：仅用户触发的启动/重启开一次浏览器；服务自启
 *   （launchd/计划任务拉起，env DEEPAA_LAUNCH_REASON=service）与崩溃自愈一律不开。
 * - **红线**：`deepaa service install` 是显式用户动作，接管运行中的手动实例
 *   （先优雅停止再注册）；除此之外任何路径不主动重启代理。Windows 侧仅实现
 *   命令构造，真实可用性待 Windows 环境验收（AGENTS 红线）。
 *
 * 模块以纯构造器 + 可注入副作用（exec/spawn/probe/fetchHealth/openBrowser）组织，
 * 全部行为可在测试沙箱中验证（见 tests/deepaa-service.test.ts）。
 */

import {spawn, spawnSync} from "node:child_process";
import {openSync} from "node:fs";
import {mkdir, rename, rm, stat, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join, posix, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import net from "node:net";
import http from "node:http";
import {resolveDeepaaDataDir} from "../src/lib/data-paths-runtime.mjs";

/** 展示与启动顺序统一 Web 在前（2026-10-05 用户确认：口径「Web 与代理服务」）。 */
export const SERVICE_ROLES = ["web", "proxy"];
/** 标识根（2026-10-05 用户确认）：域名 deepaa.dev 的 reverse-DNS，本地可见去个人化。 */
export const SERVICE_ID = {proxy: "dev.deepaa.proxy", web: "dev.deepaa.web"};
export const WINDOWS_TASK_NAME = {proxy: "DeepAA Proxy", web: "DeepAA Web"};
/** 代理优雅退出最坏 ~20s（连接排空 10s + 捕获落盘 10s）；launchd 默认 20s 会相切。 */
export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 40;
export const DEFAULT_WEB_PORT = 3210;
export const DEFAULT_PROXY_PORT = 3211;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export function servicePaths(options = {}) {
  const rootDir = options.rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const homeDir = options.homeDir ?? homedir();
  const dataDir = options.dataDir ?? resolveDataDir({...options, rootDir});
  return {
    rootDir,
    homeDir,
    dataDir,
    plistDir: join(homeDir, "Library", "LaunchAgents"),
    logDir: join(dataDir, "logs"),
    vbsDir: join(dataDir, "service"),
    serviceDir: join(dataDir, "service"),
    plist: role => join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID[role]}.plist`),
    log: role => join(dataDir, "logs", `${role}.log`),
    errLog: role => join(dataDir, "logs", `${role}.err.log`),
    vbs: role => join(dataDir, "service", `run-${role}.vbs`),
  };
}

function resolveDataDir(options = {}) {
  const rootDir = options.rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return resolveDeepaaDataDir(rootDir, {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? homedir(),
    sourceCheckout: false,
  });
}

// ---------------------------------------------------------------------------
// 纯构造器：macOS LaunchAgent plist（C1）
// ---------------------------------------------------------------------------

export function buildLaunchAgentPlist(options) {
  const {role, nodeExecutable, launcherPath, dataDir, pathEnv} = options;
  const label = SERVICE_ID[role];
  // LaunchAgent 是 macOS 专用产物：纯构造器必须与宿主平台无关，
  // Windows 宿主上的 join() 会把正斜杠拼成反斜杠，破坏生成与断言口径。
  const logPath = posix.join(dataDir, "logs", `${role}.log`);
  const errLogPath = posix.join(dataDir, "logs", `${role}.err.log`);
  const env = {
    DEEPAA_LAUNCH_REASON: "service",
    NODE_ENV: "production",
    ...(pathEnv ? {PATH: pathEnv} : {}),
    DEEPAA_DATA_DIR: dataDir,
  };
  const envEntries = Object.entries(env)
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeExecutable)}</string>
    <string>${escapeXml(launcherPath)}</string>
    <string>${role}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLogPath)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dirname(launcherPath))}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ---------------------------------------------------------------------------
// 纯构造器：Windows 计划任务（C2）——仅命令构造，真实行为待 Windows 验收
// ---------------------------------------------------------------------------

export function buildWindowsHiddenVbs(options) {
  const {role, nodeExecutable, launcherPath} = options;
  // VBS 字符串内的引号需成对转义：目标命令行为
  //   "C:\...\node.exe" "C:\...\deepaa.mjs" web
  // 整体作为 Run 的字符串参数，逐个 " 翻倍后嵌入。
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const commandLine = `${quote(nodeExecutable)} ${quote(launcherPath)} ${role}`;
  const vbsLiteral = commandLine.replaceAll('"', '""');
  return `' DeepAA 后台服务包装（计划任务动作）：隐藏窗口运行，无控制台闪烁。\r\n`
    + `CreateObject("WScript.Shell").Run "${vbsLiteral}", 0, False\r\n`;
}

export function buildWindowsRegisterCommand(options) {
  const {role, vbsPath} = options;
  const taskName = WINDOWS_TASK_NAME[role];
  const script = [
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbsPath.replaceAll("'", "''")}"'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)`,
    `Register-ScheduledTask -TaskName '${taskName.replaceAll("'", "''")}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join("; ");
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
  };
}

/** stop 专用（2026-10-05 用户确认）：仅结束运行实例，任务注册保留。 */
export function buildWindowsEndCommand(role) {
  return {
    command: "schtasks",
    args: ["/End", "/TN", WINDOWS_TASK_NAME[role]],
  };
}

export function buildWindowsUnregisterCommand(role) {
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `Unregister-ScheduledTask -TaskName '${WINDOWS_TASK_NAME[role].replaceAll("'", "''")}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ],
  };
}

export function buildWindowsShortcutCommand(options) {
  const {shortcutPath, iconPath} = options;
  const iconLine = iconPath
    ? `$shortcut.IconLocation = '${iconPath.replaceAll("'", "''")}'`
    : "";
  const script = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$shortcut = $ws.CreateShortcut('${shortcutPath.replaceAll("'", "''")}')`,
    `$shortcut.TargetPath = "$env:COMSPEC"`,
    `$shortcut.Arguments = '/c deepaa'`,
    `$shortcut.WorkingDirectory = $env:USERPROFILE`,
    `$shortcut.WindowStyle = 7`,
    ...(iconLine ? [iconLine] : []),
    `$shortcut.Save()`,
  ].join("; ");
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
  };
}

// ---------------------------------------------------------------------------
// 端口探测 / 健康检查 / 就绪等待（C3/C6 消费）
// ---------------------------------------------------------------------------
// 「用户在系统设置置灰停用」检测的唯一信号是 BTM 数据库（sfltool dumpbtm），
// 属 root 调试工具——在用户终端会弹管理员授权框（2026-10-07 实测），产品命令
// 一律不调用（方案 1 用户确认）；免授权的 launchctl print-disabled 不反映该
// 开关，无法替代。相关状态只能以「诚实合并文案」表达（见 deepaa status）。

export function createDefaultProbes() {
  return {
    probePort: port => new Promise(resolvePromise => {
      const socket = net.connect({port, host: "127.0.0.1"});
      socket.setTimeout(600);
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("timeout", () => { socket.destroy(); resolvePromise(false); });
      socket.once("error", () => resolvePromise(false));
    }),
    fetchHealth: port => new Promise(resolvePromise => {
      const request = http.get({host: "127.0.0.1", port, path: "/api/health", timeout: 2000}, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolvePromise({state: parsed.app === "deepaa" ? "deepaa" : "foreign"});
          } catch {
            resolvePromise({state: "foreign"});
          }
        });
      });
      request.on("timeout", () => { request.destroy(); resolvePromise({state: "down"}); });
      request.on("error", () => resolvePromise({state: "down"}));
    }),
  };
}

export async function waitForWebReady(options) {
  const {port, intervalMs = 500, probes = createDefaultProbes()} = options;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await probes.fetchHealth(port);
    if (health.state === "deepaa") return true;
    if (health.state === "foreign") {
      throw new Error(`端口 ${port} 被非 DeepAA 进程（或过旧版本）占用——请先释放该端口或设置 PORT 环境变量`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 Web 就绪超时（${Math.round(timeoutMs / 1000)}s）；日志见 logs/web.log`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs));
  }
}

/**
 * 端口就绪轮询（代理侧验证用：3211 无 /api/health，TCP 探测即就绪信号）。
 * 与 waitForWebReady 不同：超时不抛错而是返回 false，由调用方决定如何诚实报告。
 */
export async function waitForPortReady(options) {
  const {port, intervalMs = 500, probes = createDefaultProbes()} = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probes.probePort(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// 守护化 spawn / 浏览器打开（C3/C4）
// ---------------------------------------------------------------------------

export function buildBrowserOpenCommand(url, platform = process.platform) {
  if (platform === "win32") return {command: "cmd.exe", args: ["/c", "start", "", url]};
  if (platform === "darwin") return {command: "open", args: [url]};
  return {command: "xdg-open", args: [url]};
}

export function daemonizeRole(options) {
  const {role, nodeExecutable, launcherPath, dataDir, spawnProcess = spawn} = options;
  const logPath = join(dataDir, "logs", `${role}.log`);
  const errLogPath = join(dataDir, "logs", `${role}.err.log`);
  const openAppend = options.openSync ?? ((path) => openSync(path, "a"));
  const outFd = openAppend(logPath);
  const errFd = openAppend(errLogPath);
  const child = spawnProcess(nodeExecutable, [launcherPath, role], {
    cwd: dirname(launcherPath),
    env: {
      ...buildChildEnv(options.env ?? process.env),
      DEEPAA_DATA_DIR: dataDir,
      DEEPAA_LAUNCH_REASON: "manual-daemon",
    },
    stdio: ["ignore", outFd, errFd],
    detached: true,
    windowsHide: true,
  });
  child.unref?.();
  return {child, logPath, errLogPath};
}

function buildChildEnv(baseEnv) {
  const env = {...baseEnv, NODE_ENV: "production"};
  // 守护化进程不继承 launcher 的标记，避免把「手动」误标为「服务」。
  delete env.DEEPAA_LAUNCH_REASON;
  return env;
}

// ---------------------------------------------------------------------------
// 进程查找与优雅停止（deepaa stop / install 接管）
// ---------------------------------------------------------------------------

export function findPortListenerPid(port, platform = process.platform, runSync = defaultRunSync) {
  if (platform === "win32") {
    const result = runSync("netstat", ["-ano", "-p", "TCP"]);
    if (result.code !== 0) return undefined;
    for (const line of String(result.stdout).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.includes(`:${port} `) || !trimmed.includes("LISTENING")) continue;
      const pid = Number(trimmed.split(/\s+/).at(-1));
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    }
    return undefined;
  }
  const result = runSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (result.code !== 0) return undefined;
  const pid = Number(String(result.stdout).trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function defaultRunSync(command, args) {
  const result = spawnSync(command, args, {encoding: "utf8", windowsHide: true});
  return {code: result.status ?? 1, stdout: result.stdout ?? ""};
}

export async function stopPortAndWait(options) {
  const {port, timeoutMs = 25_000, platform = process.platform, runSync = defaultRunSync, kill = defaultKill, probes = createDefaultProbes()} = options;
  const pid = findPortListenerPid(port, platform, runSync);
  if (pid === undefined) return {stopped: true, pid: undefined};
  kill(pid, platform);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probes.probePort(port))) return {stopped: true, pid};
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  return {stopped: false, pid};
}

function defaultKill(pid, platform) {
  if (platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {windowsHide: true});
    return;
  }
  process.kill(pid, "SIGTERM");
}

// ---------------------------------------------------------------------------
// launchctl / 计划任务 包装（可注入 exec）
// ---------------------------------------------------------------------------

async function launchctl(exec, args) {
  const result = await exec("launchctl", args);
  if (result.code !== 0) throw new Error(`launchctl ${args.join(" ")} 失败（退出码 ${result.code}）：${result.stderr || result.stdout}`);
  return result;
}

async function launchctlBestEffort(exec, args) {
  const result = await exec("launchctl", args);
  return result.code === 0;
}

/**
 * 状态感知的服务启动（2026-10-06 事故修复，取代旧 bootstrapService）：
 * `launchctl bootstrap` 对「已在 launchd 域内的空闲标签」（进程已退出但标签仍在）
 * 直接报错，legacy `load -w` 则静默空成功——两者都不会唤醒进程，导致 install/
 * start 谎报"已启动"（实测只有先 bootout 的 restart 真正拉起）。
 *
 * reload（install 路径，2026-10-07 修复）：标签驻留域内时 kickstart 有两个缺陷
 * ——① launchd 按已加载的旧任务定义重启，改写 plist 不生效；② 登录项登记
 * （BTM）只对 bootstrap 事件可靠登记，kickstart 不触发（实测 uninstall→install
 * 循环后 proxy 条目从登录项丢失，只剩 "1 个项目"）。因此 install 一律先 bootout
 * 清出、再全新 bootstrap：新配置生效 + BTM 确定性重登记。start/smartLaunch 不
 * 改写 plist，维持 kickstart 唤醒语义（绝不无谓重启运行中的进程）。
 */
export async function ensureServiceRunning(exec, options) {
  const {role, plistPath, uid, reload = false} = options;
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${SERVICE_ID[role]}`;
  // 预愈合历史禁用覆写（旧 unload -w / launchctl disable 场景）：best-effort。
  await launchctlBestEffort(exec, ["enable", serviceTarget]);
  if (reload) {
    await launchctlBestEffort(exec, ["bootout", serviceTarget]);
    if (await launchctlBestEffort(exec, ["bootstrap", domainTarget, plistPath])) return "bootstrap";
    if (await launchctlBestEffort(exec, ["load", "-w", plistPath])) return "load";
    if (await launchctlBestEffort(exec, ["kickstart", serviceTarget])) return "kickstart";
    throw new Error(`无法启动服务 ${SERVICE_ID[role]}（enable/bootout/bootstrap 均未生效）`);
  }
  const inDomain = await launchctlBestEffort(exec, ["print", serviceTarget]);
  if (!inDomain) {
    if (await launchctlBestEffort(exec, ["bootstrap", domainTarget, plistPath])) return "bootstrap";
    if (await launchctlBestEffort(exec, ["load", "-w", plistPath])) return "load";
  }
  // 已在域内（含空闲标签）：kickstart 强制运行——RunAtLoad 只在加载瞬间生效，
  // 不会唤醒已退出的进程（2026-10-06 事故根因）。
  if (await launchctlBestEffort(exec, ["kickstart", serviceTarget])) return "kickstart";
  throw new Error(`无法启动服务 ${SERVICE_ID[role]}（enable/print/bootstrap/kickstart 均未生效）`);
}

/**
 * 仅停止当前运行（2026-10-05 用户确认）：bootout 把任务移出本次 launchd 会话并
 * 停止进程，但 **plist 保留在磁盘** → 下次登录 RunAtLoad 自动恢复运行——这正是
 * `deepaa stop` 的语义。刻意不做 `unload -w` 兜底：它会持久写入禁用标记，
 * 导致下次登录不再自启，违背"注册保留"语义。
 */
export async function bootoutService(exec, options) {
  const {role, uid} = options;
  const domainTarget = `gui/${uid}`;
  if (await launchctlBestEffort(exec, ["bootout", `${domainTarget}/${SERVICE_ID[role]}`])) return "bootout";
  return "none";
}

// ---------------------------------------------------------------------------
// 日志轮转（install/start 时执行；launchd 持有文件描述符，运行中不轮转）
// ---------------------------------------------------------------------------

export async function rotateLogIfLarge(path, maxBytes = LOG_ROTATE_BYTES) {
  try {
    const info = await stat(path);
    if (info.size < maxBytes) return false;
    await rm(`${path}.old`, {force: true});
    await rename(path, `${path}.old`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 服务生命周期（C1/C5）：install / uninstall / status / start / stop / restart
// ---------------------------------------------------------------------------

export async function installServices(options) {
  const platform = options.platform ?? process.platform;
  const paths = servicePaths(options);
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const launcherPath = options.launcherPath ?? join(paths.rootDir, "bin", "deepaa.mjs");
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const exec = options.exec ?? defaultExec;
  const probes = options.probes ?? createDefaultProbes();
  await mkdir(paths.logDir, {recursive: true});
  if (platform !== "win32") {
    // 登录项显示口径（2026-10-07 用户确认方案 A 回滚）：macOS 登录项的归组与命名
    // 来自可执行文件的代码签名团队——官方 node 构建统一签名者 "Node.js
    // Foundation"，plist 直指 node 二进制时两个服务归组为单行 "Node.js Foundation
    // — N 个项目"；本地生成的包装器 .app 无签名（npm 形态永远做不到），反而拆成
    // 多行且标「身份不明的开发者」。故 plist 维持直指 node，并清理 2026-10-06
    // 短暂引入的包装器 .app 残留（Windows 侧 service 目录承载 VBS，不动）。
    await rm(paths.serviceDir, {recursive: true, force: true});
  }
  const summary = [];
  for (const role of SERVICE_ROLES) {
    await rotateLogIfLarge(paths.log(role));
    await rotateLogIfLarge(paths.errLog(role));
    if (platform === "win32") {
      await mkdir(paths.vbsDir, {recursive: true});
      await writeFile(paths.vbs(role), buildWindowsHiddenVbs({role, nodeExecutable, launcherPath}), "utf8");
      const register = buildWindowsRegisterCommand({role, vbsPath: paths.vbs(role)});
      const result = await exec(register.command, register.args);
      if (result.code !== 0) throw new Error(`注册计划任务 ${WINDOWS_TASK_NAME[role]} 失败：${result.stderr || result.stdout}`);
      summary.push({role, mode: "windows-task"});
      continue;
    }
    await mkdir(paths.plistDir, {recursive: true});
    // 接管语义（用户显式执行 install = 同意服务托管）：注册前优雅停止现有实例，
    // 避免立即拉起时端口冲突。代理给足排空时间（红线：仅此路径可停代理）。
    const port = rolePort(role, options);
    if (await probes.probePort(port)) {
      // 标签若在域内先 bootout（best-effort）：launchd 原生停进程，避免逐 PID
      // SIGTERM 与 KeepAlive 崩溃自愈之间的「停了又起」竞态；手动守护实例
      // （bootout 管不到的）由 stopPortAndWait 按端口兜底。
      await bootoutService(exec, {role, plistPath: paths.plist(role), uid});
      const stop = await stopPortAndWait({port, platform, runSync: options.runSync, kill: options.kill, probes});
      if (!stop.stopped) throw new Error(`端口 ${port} 上的现有实例未能停止，已中止服务接管（未做任何注册）`);
      summary.push({role, mode: "takeover"});
    }
    await writeFile(paths.plist(role), buildLaunchAgentPlist({role, nodeExecutable, launcherPath, dataDir: paths.dataDir, pathEnv}));
    const mode = await ensureServiceRunning(exec, {role, plistPath: paths.plist(role), uid, reload: true});
    if (summary.at(-1)?.mode !== "takeover") summary.push({role, mode});
  }
  return summary;
}

export async function uninstallServices(options) {
  const platform = options.platform ?? process.platform;
  const paths = servicePaths(options);
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const exec = options.exec ?? defaultExec;
  const probes = options.probes ?? createDefaultProbes();
  const summary = [];
  for (const role of SERVICE_ROLES) {
    const port = rolePort(role, options);
    const running = await probes.probePort(port);
    if (platform === "win32") {
      const unregister = buildWindowsUnregisterCommand(role);
      await exec(unregister.command, unregister.args);
      await rm(paths.vbs(role), {force: true});
      summary.push({role, mode: running ? "kept-running" : "unregistered", running});
      continue;
    }
    // 注销 ≠ 停止（2026-10-07 用户确认）：用户移除注册可能只是不想开机自启，
    // 不代表要停服务。运行中（端口在听）时刻意不 bootout——bootout 会终止
    // launchd 托管进程；删除 plist 已足以取消下次登录自启，当前进程留任至
    // 自然退出或登出（期间崩溃自愈仍生效，属可接受余留）。未运行时 bootout
    // 只是把空闲标签清出 launchd 域，无任何进程影响。
    const mode = running ? "kept-running" : await bootoutService(exec, {role, plistPath: paths.plist(role), uid});
    await rm(paths.plist(role), {force: true});
    summary.push({role, mode, running});
  }
  if (platform !== "win32") {
    // dataDir/service 在 macOS 上只承载 2026-10-06 短暂引入的包装器 .app（含
    // 历史安装残留），随注销一并清理；Windows 侧该目录是 VBS 入口，逐文件删除。
    await rm(paths.serviceDir, {recursive: true, force: true});
  }
  return summary;
}

export async function readServiceStatus(options) {
  const platform = options.platform ?? process.platform;
  const paths = servicePaths(options);
  const probes = options.probes ?? createDefaultProbes();
  const runSync = options.runSync ?? defaultRunSync;
  const entries = [];
  for (const role of SERVICE_ROLES) {
    const port = rolePort(role, options);
    const running = await probes.probePort(port);
    let installed = false;
    if (platform === "win32") {
      installed = runSync("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME[role]]).code === 0;
    } else {
      try {
        await stat(paths.plist(role));
        installed = true;
      } catch {
        installed = false;
      }
    }
    entries.push({
      role,
      port,
      running,
      installed,
      pid: running ? findPortListenerPid(port, platform, runSync) : undefined,
    });
  }
  return entries;
}

export async function startServices(options) {
  const platform = options.platform ?? process.platform;
  const paths = servicePaths(options);
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const exec = options.exec ?? defaultExec;
  const probes = options.probes ?? createDefaultProbes();
  const summary = [];
  for (const role of SERVICE_ROLES) {
    const port = rolePort(role, options);
    if (await probes.probePort(port)) {
      summary.push({role, mode: "already-running"});
      continue;
    }
    if (platform === "win32") {
      const result = await exec("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME[role]]);
      if (result.code !== 0) throw new Error(`启动计划任务 ${WINDOWS_TASK_NAME[role]} 失败：${result.stderr || result.stdout}`);
      summary.push({role, mode: "windows-task"});
      continue;
    }
    const mode = await ensureServiceRunning(exec, {role, plistPath: paths.plist(role), uid});
    summary.push({role, mode});
  }
  return summary;
}

export async function stopServices(options) {
  // 统一停止（2026-10-05 用户确认语义）：仅停止当前运行，**注册一律保留**——
  // macOS bootout（plist 保留，下次登录自动运行）；Windows schtasks /End（任务
  // 保留）；未注册时直接按端口优雅停止手动实例。注销注册只属于 uninstall。
  const platform = options.platform ?? process.platform;
  const paths = servicePaths(options);
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const exec = options.exec ?? defaultExec;
  const summary = [];
  for (const role of SERVICE_ROLES) {
    const port = rolePort(role, options);
    let installed = false;
    if (platform === "win32") {
      installed = runSyncDefault(options, ["schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME[role]]]) === 0;
      if (installed) {
        const end = buildWindowsEndCommand(role);
        await exec(end.command, end.args);
      }
    } else {
      try {
        await stat(paths.plist(role));
        installed = true;
        await bootoutService(exec, {role, plistPath: paths.plist(role), uid});
      } catch {
        installed = false;
      }
    }
    const stop = await stopPortAndWait({port, platform, runSync: options.runSync, kill: options.kill, probes: options.probes});
    summary.push({role, installed, stopped: stop.stopped, pid: stop.pid});
  }
  return summary;
}

function runSyncDefault(options, [command, args]) {
  const runSync = options.runSync ?? defaultRunSync;
  return runSync(command, args).code;
}

function rolePort(role, options) {
  if (role === "web") return Number(options.webPort ?? options.env?.PORT ?? process.env.PORT ?? DEFAULT_WEB_PORT);
  return Number(options.proxyPort ?? options.env?.PROXY_PORT ?? process.env.PROXY_PORT ?? DEFAULT_PROXY_PORT);
}

// ---------------------------------------------------------------------------
// 智能启动器（C3/C4）：裸 `deepaa` 的行为
// ---------------------------------------------------------------------------

export async function smartLaunch(options) {
  const platform = options.platform ?? process.platform;
  const paths = servicePaths(options);
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const launcherPath = options.launcherPath ?? join(dirname(fileURLToPath(import.meta.url)), "deepaa.mjs");
  const exec = options.exec ?? defaultExec;
  const probes = options.probes ?? createDefaultProbes();
  const spawnProcess = options.spawnProcess ?? spawn;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const uid = options.uid ?? process.getuid?.() ?? 501;
  const webPort = rolePort("web", options);
  const proxyPort = rolePort("proxy", options);
  const output = options.output ?? (text => process.stdout.write(`${text}\n`));

  const webRunning = await probes.probePort(webPort);
  const proxyRunning = await probes.probePort(proxyPort);
  // 端口占用预检在任何启动动作之前：Web 端口被外来进程占用时直接报错，
  // 不留「代理已拉起、Web 起不来」的半启动状态（项目未上线，不做旧实例兼容）。
  if (webRunning) {
    const health = await probes.fetchHealth(webPort);
    if (health.state === "foreign") {
      throw new Error(`端口 ${webPort} 被非 DeepAA 进程占用——请释放该端口或设置 PORT 环境变量`);
    }
  }
  // F3 首次运行图标自愈（2026-10-05 用户确认）：图标缺失时静默补装，
  // 覆盖 npm --ignore-scripts 安装场景；已存在时仅一次 stat，零成本。
  const ensureIcon = options.ensureIcon ?? defaultEnsureDesktopIcon;
  await ensureIcon({platform, homeDir: paths.homeDir});
  const started = [];
  // 服务路径失败静默降级（2026-10-07 用户确认）：已注册但服务路径启动失败
  //（如曾在系统设置关闭「允许在后台」导致 bootstrap 被拒）时，退回后台守护
  // 方式拉起，保证「随时能用」且零打扰——不向用户提示机制差异（最终结果
  // 「服务在跑、控制台打开」一致）；置灰检测唯一信号是 root 调试工具
  // sfltool（用户终端会弹管理员授权框），产品命令零调用，故失败才降级。
  const launchRole = async role => {
    await mkdir(paths.logDir, {recursive: true});
    daemonizeRole({role, nodeExecutable, launcherPath, dataDir: paths.dataDir, spawnProcess, env: options.env, openSync: options.openSync});
    started.push({role, mode: "daemon"});
  };

  // 启动顺序 Web 在前（2026-10-05 用户确认：口径与展示统一「Web 与代理服务」）。
  if (!webRunning) {
    if (await isInstalled(platform, paths, "web", options)) {
      try {
        await ensureServiceRunning(exec, {role: "web", plistPath: paths.plist("web"), uid});
        started.push({role: "web", mode: "service"});
      } catch {
        await launchRole("web");
      }
    } else {
      await launchRole("web");
    }
  }
  if (!proxyRunning) {
    if (await isInstalled(platform, paths, "proxy", options)) {
      try {
        await ensureServiceRunning(exec, {role: "proxy", plistPath: paths.plist("proxy"), uid});
        started.push({role: "proxy", mode: "service"});
      } catch {
        await launchRole("proxy");
      }
    } else {
      await launchRole("proxy");
    }
  }

  // 就绪等待 + 开浏览器：仅用户触发的本次启动（崩溃自愈/登录自启不会走到这里）。
  // 预先就在运行的 Web 已通过上方健康预检，无需再等标记。
  if (!webRunning) {
    await waitForWebReady({port: webPort, probes, ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {})});
  }
  await openBrowser(`http://127.0.0.1:${webPort}`);

  const installed = await isInstalled(platform, paths, "web", options);
  output(`DeepAA 已就绪，控制台：http://127.0.0.1:${webPort}`);
  for (const item of started) {
    output(`  已启动 ${item.role === "proxy" ? `代理 (:${proxyPort})` : `Web (:${webPort})`}（${item.mode === "service" ? "系统服务" : "后台守护"}）`);
  }
  if (started.length === 0) {
    output("  Web 与代理服务本就在运行，未做任何变更");
  }
  if (!installed) {
    // 注册检测是免费只读查询（macOS plist stat / Windows schtasks /Query，无授权弹窗），
    // 因此仅未注册时提示；重复注册无害，文案不强调选择权（2026-10-08 用户确认口径）。
    output("  提示：运行 `deepaa service install` 可注册系统服务——开机自启 + 崩溃自动恢复（登录后静默运行）");
  }
  return {webPort, proxyPort, started, alreadyRunning: webRunning && proxyRunning};
}

async function isInstalled(platform, paths, role, options) {
  if (platform === "win32") {
    return runSyncDefault(options, ["schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME[role]]]) === 0;
  }
  try {
    await stat(paths.plist(role));
    return true;
  } catch {
    return false;
  }
}

/** F3 默认图标自愈：缺失时尽力补装（不抛错——图标失败不阻断启动）。 */
async function defaultEnsureDesktopIcon(options) {
  try {
    const {iconPaths, installDesktopIcon} = await import("./deepaa-icon.mjs");
    const paths = iconPaths(options);
    const target = options.platform === "win32" ? paths.shortcut : paths.appBundle;
    try {
      await stat(target);
      return;
    } catch {
      /* 缺失 → 补装 */
    }
    await installDesktopIcon(options);
  } catch {
    /* 尽力而为：下次启动再试 */
  }
}

async function defaultOpenBrowser(url) {
  const {command, args} = buildBrowserOpenCommand(url);
  const child = spawn(command, args, {detached: true, stdio: "ignore", windowsHide: true});
  child.unref?.();
}

function defaultExec(command, args) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {windowsHide: true});
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", error => resolvePromise({code: 1, stdout, stderr: String(error)}));
    child.once("close", code => resolvePromise({code: code ?? 1, stdout, stderr}));
  });
}
