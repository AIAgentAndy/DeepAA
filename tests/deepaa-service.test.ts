/**
 * 批次 2 服务化测试（C1/C3/C5，2026-10-05 用户确认）：
 * 全部副作用注入（exec/spawn/probe/kill/openSync），不执行真实 launchctl/计划任务，
 * 不触碰真实 HOME 与运行中的 3210/3211（写操作一律落在 vitest HOME 沙箱与临时目录）。
 */

import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import http from "node:http";
import {
  DEFAULT_PROXY_PORT,
  DEFAULT_WEB_PORT,
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  SERVICE_ID,
  buildBrowserOpenCommand,
  buildLaunchAgentPlist,
  buildWindowsEndCommand,
  buildWindowsHiddenVbs,
  buildWindowsRegisterCommand,
  buildWindowsShortcutCommand,
  buildWindowsUnregisterCommand,
  daemonizeRole,
  ensureServiceRunning,
  findPortListenerPid,
  installServices,
  readServiceStatus,
  smartLaunch,
  stopPortAndWait,
  stopServices,
  uninstallServices,
  waitForPortReady,
  waitForWebReady,
} from "../bin/deepaa-service.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "deepaa-service-test-"));
const homeDir = join(sandbox, "home");
const dataDir = join(sandbox, "data");

beforeAll(async () => {
  await mkdir(homeDir, {recursive: true});
  await mkdir(dataDir, {recursive: true});
});

afterAll(async () => {
  await rm(sandbox, {recursive: true, force: true});
});

function recordingExec() {
  const calls: Array<{command: string; args: string[]}> = [];
  const exec = (command: string, args: string[]) => {
    calls.push({command, args: [...args]});
    return Promise.resolve({code: 0, stdout: "", stderr: ""});
  };
  return {calls, exec};
}

/**
 * 拟真 launchctl 语义（2026-10-06 修复配套；2026-10-11 状态化）：`print` 按
 * 「该标签当前是否在域内」返回退出码——初始由 inDomain 指定；bootstrap / load -w
 * 成功后视为进域、bootout 成功后出域（模拟真实 launchd 生命周期，供 print
 * 复核断言）。状态按标签（web/proxy）独立跟踪，与真实 launchd 一致。
 * fail 列表内的子命令恒失败（stderr=stub failure）且不改变域内状态。
 */
function launchctlExec(overrides: {inDomain?: boolean; fail?: string[]} = {}) {
  const calls: Array<{command: string; args: string[]}> = [];
  const inDomainByLabel = new Map<string, boolean>();
  const labelOfArgs = (args: string[]) =>
    args.join(" ").includes("proxy") ? "dev.deepaa.proxy" : "dev.deepaa.web";
  const exec = (command: string, args: string[]) => {
    calls.push({command, args: [...args]});
    if (command !== "launchctl") return Promise.resolve({code: 0, stdout: "", stderr: ""});
    if (overrides.fail?.includes(args[0])) return Promise.resolve({code: 1, stdout: "", stderr: "stub failure"});
    const label = labelOfArgs(args);
    if (args[0] === "print") {
      const inDomain = inDomainByLabel.get(label) ?? overrides.inDomain ?? false;
      return Promise.resolve({code: inDomain ? 0 : 1, stdout: "", stderr: ""});
    }
    if (args[0] === "bootstrap" || args[0] === "load") inDomainByLabel.set(label, true);
    if (args[0] === "bootout") inDomainByLabel.set(label, false);
    return Promise.resolve({code: 0, stdout: "", stderr: ""});
  };
  return {calls, exec};
}

function fixedProbes(overrides: {web?: boolean; proxy?: boolean; health?: string} = {}) {
  return {
    probePort: async (port: number) =>
      port === DEFAULT_WEB_PORT ? (overrides.web ?? false)
        : port === DEFAULT_PROXY_PORT ? (overrides.proxy ?? false)
        : false,
    fetchHealth: async (port: number) => {
      if (port !== DEFAULT_WEB_PORT) return {state: "down"};
      if (overrides.health === undefined) return {state: "down"};
      return {state: overrides.health};
    },
  };
}

function recordingSpawn() {
  const calls: Array<{command: string; args: string[]; options: Record<string, unknown>}> = [];
  const spawnProcess = (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({command, args: [...args], options});
    return {unref: () => {}, pid: 424242};
  };
  return {calls, spawnProcess};
}

/**
 * 动作驱动的就绪翻转（2026-10-11 修复配套）：smartLaunch 现在以端口真实监听
 * 作为「已启动 代理」判据，测试需在对应动作成功后翻转端口就绪，模拟进程起监听：
 * - launchctl bootstrap/kickstart 成功 → 该角色端口就绪（服务路径拉起）；
 * - 守护化 spawn(角色) → 该角色端口就绪（daemon 拉起）。
 */
function readinessSimulation() {
  const readyPorts = new Set<number>();
  const markRoleReady = (role: string) => {
    if (role === "web") readyPorts.add(DEFAULT_WEB_PORT);
    if (role === "proxy") readyPorts.add(DEFAULT_PROXY_PORT);
  };
  const probes = {
    probePort: async (port: number) => readyPorts.has(port),
    fetchHealth: async (port: number) =>
      ({state: port === DEFAULT_WEB_PORT && readyPorts.has(DEFAULT_WEB_PORT) ? "deepaa" : "down"}),
  };
  return {probes, markRoleReady};
}

/** 包装 launchctl exec：bootstrap/kickstart 成功后按目标角色翻转端口就绪。 */
function serviceLaunchExec(
  exec: (command: string, args: string[]) => Promise<{code: number; stdout: string; stderr: string}>,
  markRoleReady: (role: string) => void,
) {
  const roleOfArgs = (args: string[]) => {
    if (args[0] !== "bootstrap" && args[0] !== "kickstart") return undefined;
    return args.join(" ").includes("proxy") ? "proxy" : "web";
  };
  return async (command: string, args: string[]) => {
    const result = await exec(command, args);
    if (result.code === 0) {
      const role = roleOfArgs(args);
      if (role) markRoleReady(role);
    }
    return result;
  };
}

/** 包装守护化 spawn：按角色参数翻转端口就绪，同时保留调用记录。 */
function readinessSpawn(markRoleReady: (role: string) => void) {
  const recorder = recordingSpawn();
  const spawnProcess = (command: string, args: string[], options: Record<string, unknown>) => {
    const child = recorder.spawnProcess(command, args, options);
    if (args[1] === "web" || args[1] === "proxy") markRoleReady(args[1]);
    return child;
  };
  return {calls: recorder.calls, spawnProcess};
}

describe("C1 macOS LaunchAgent plist 生成", () => {
  const plist = buildLaunchAgentPlist({
    role: "web",
    nodeExecutable: "/usr/local/bin/node",
    launcherPath: "/opt/deepaa/bin/deepaa.mjs",
    dataDir: "/Users/t/.deepaa",
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
  });

  test("标签与标识根 dev.deepaa", () => {
    expect(plist).toContain(`<string>${SERVICE_ID.web}</string>`);
    expect(plist).not.toContain("aiagentandy");
  });

  test("KeepAlive 仅崩溃自愈；绝不无条件重启（代理红线）", () => {
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>Crashed</key>");
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  test("ExitTimeOut ≥ 30s（代理最坏 20s 排空不被强杀）", () => {
    expect(plist).toContain(`<integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>`);
    expect(LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(30);
  });

  test("RunAtLoad 注册即拉起；日志与 PATH 环境齐备；不含任何密钥形态字段", () => {
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("/Users/t/.deepaa/logs/web.log");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).not.toContain("token");
    expect(plist).not.toContain("secret");
  });

  test("ProgramArguments 直指签名 node 二进制（2026-10-07 方案 A 回滚：官方 node 签名团队 Node.js Foundation 使两服务归组单行；无签名包装器反而拆行 + 身份不明）", () => {
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/deepaa/bin/deepaa.mjs</string>");
    expect(plist).toContain("<string>web</string>");
    expect(plist).not.toContain("DeepAA Service.app");
  });

  test("XML 转义：路径含 & 与引号不破坏结构", () => {
    const weird = buildLaunchAgentPlist({
      role: "proxy",
      nodeExecutable: "/usr/local/bin/node",
      launcherPath: "/opt/a&b\"c/bin/deepaa.mjs",
      dataDir: "/Users/t/.deepaa",
      pathEnv: "",
    });
    expect(weird).toContain("&amp;");
  });
});

describe("C2 Windows 计划任务构造（仅命令构造，待真实环境验收）", () => {
  test("隐藏 VBS 包装：无窗口运行 node 启动器（引号成对转义）", () => {
    const vbs = buildWindowsHiddenVbs({role: "web", nodeExecutable: "C:\\node\\node.exe", launcherPath: "C:\\deepaa\\bin\\deepaa.mjs"});
    expect(vbs).toContain("WScript.Shell");
    // 期望形态：Run """C:\node\node.exe"" ""C:\deepaa\bin\deepaa.mjs"" web", 0, False
    expect(vbs).toContain('"""C:\\node\\node.exe"" ""C:\\deepaa\\bin\\deepaa.mjs"" web"');
    expect(vbs).toContain(", 0, False");
    expect(vbs.trimEnd()).not.toContain("deepaa-gateway");
  });

  test("注册命令含 AtLogOn 触发、失败重启与无限执行时限", () => {
    const command = buildWindowsRegisterCommand({role: "proxy", vbsPath: "C:\\Users\\t\\.deepaa\\service\\run-proxy.vbs"});
    expect(command.args.join(" ")).toContain("-AtLogOn");
    expect(command.args.join(" ")).toContain("-RestartCount 3");
    expect(command.args.join(" ")).toContain("-ExecutionTimeLimit (New-TimeSpan -Seconds 0)");
    expect(command.args.join(" ")).toContain("DeepAA Proxy");
  });

  test("注销与快捷方式构造", () => {
    expect(buildWindowsUnregisterCommand("web").args.join(" ")).toContain("DeepAA Web");
    const shortcut = buildWindowsShortcutCommand({shortcutPath: "C:\\Users\\t\\...\\DeepAA.lnk"});
    expect(shortcut.args.join(" ")).toContain("/c deepaa");
  });
});

describe("C3/C6 探测与就绪等待", () => {
  test("fetchHealth 识别 DeepAA 标记 / 外来进程 / 未监听（真实 HTTP）", async () => {
    const {createDefaultProbes} = await import("../bin/deepaa-service.mjs");
    const probes = createDefaultProbes();
    const server = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end("nope");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as {port: number}).port;
    expect(await probes.fetchHealth(port)).toEqual({state: "foreign"});
    // 换成 deepaa 标记响应
    const server2 = http.createServer((_request, response) => {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({app: "deepaa", status: "ok"}));
    });
    await new Promise<void>(resolve => server2.listen(0, "127.0.0.1", resolve));
    const port2 = (server2.address() as {port: number}).port;
    expect(await probes.fetchHealth(port2)).toEqual({state: "deepaa"});
    expect(await probes.fetchHealth(59999)).toEqual({state: "down"});
    expect(await probes.probePort(port2)).toBe(true);
    expect(await probes.probePort(59999)).toBe(false);
    server.close();
    server2.close();
  });

  test("waitForWebReady：就绪成功 / 外来进程立即报错 / 超时报错", async () => {
    await expect(waitForWebReady({port: DEFAULT_WEB_PORT, probes: fixedProbes({health: "deepaa"})})).resolves.toBe(true);
    await expect(waitForWebReady({port: DEFAULT_WEB_PORT, probes: fixedProbes({health: "foreign"})})).rejects.toThrow("非 DeepAA");
    await expect(waitForWebReady({port: DEFAULT_WEB_PORT, timeoutMs: 10, intervalMs: 5, probes: fixedProbes({health: "down"})}))
      .rejects.toThrow("超时");
  });

  test("waitForPortReady：就绪 true / 超时 false（不抛错，由调用方诚实报告）", async () => {
    await expect(waitForPortReady({port: DEFAULT_PROXY_PORT, probes: fixedProbes({proxy: true})})).resolves.toBe(true);
    await expect(waitForPortReady({port: DEFAULT_PROXY_PORT, timeoutMs: 10, intervalMs: 5, probes: fixedProbes({proxy: false})}))
      .resolves.toBe(false);
  });
});

describe("ensureServiceRunning 状态感知启动（2026-10-06 事故修复 + 2026-10-11 谎报拦截）", () => {
  test("不在域内：enable → print（失败）→ bootstrap 加载 → print 复核进域", async () => {
    const {calls, exec} = launchctlExec({inDomain: false});
    const mode = await ensureServiceRunning(exec, {role: "web", plistPath: "/tmp/dev.deepaa.web.plist", uid: 501});
    expect(mode).toBe("bootstrap");
    expect(calls.map(call => call.args[0])).toEqual(["enable", "print", "bootstrap", "print"]);
  });

  test("已在域内（空闲标签）：kickstart 强制唤醒——RunAtLoad 不会唤醒已退出进程", async () => {
    const {calls, exec} = launchctlExec({inDomain: true});
    const mode = await ensureServiceRunning(exec, {role: "web", plistPath: "/tmp/dev.deepaa.web.plist", uid: 501});
    expect(mode).toBe("kickstart");
    expect(calls.map(call => call.args[0])).toEqual(["enable", "print", "kickstart"]);
  });

  test("enable/print/bootstrap/load/kickstart 全失败：抛错并携带服务标签", async () => {
    const {exec} = launchctlExec({inDomain: false, fail: ["bootstrap", "load", "kickstart"]});
    await expect(ensureServiceRunning(exec, {role: "proxy", plistPath: "/tmp/dev.deepaa.proxy.plist", uid: 501}))
      .rejects.toThrow(SERVICE_ID.proxy);
  });

  test("2026-10-11 事故形态：bootstrap/load 退出码 0 但任务从未进域（load -w 静默空成功）——print 复核拦截谎报，抛错保留 stderr 诊断", async () => {
    const calls: Array<{command: string; args: string[]}> = [];
    // print 恒失败 = 任务从未真正加载；enable/bootstrap/load 全部退出码 0（假成功）。
    const exec = (command: string, args: string[]) => {
      calls.push({command, args: [...args]});
      if (command !== "launchctl") return Promise.resolve({code: 0, stdout: "", stderr: ""});
      if (args[0] === "print" || args[0] === "kickstart") {
        return Promise.resolve({code: 1, stdout: "", stderr: "stub failure"});
      }
      return Promise.resolve({code: 0, stdout: "", stderr: ""});
    };
    await expect(ensureServiceRunning(exec, {role: "proxy", plistPath: "/tmp/dev.deepaa.proxy.plist", uid: 501}))
      .rejects.toThrow("stub failure");
    expect(calls.map(call => call.args[0])).toEqual(["enable", "print", "bootstrap", "print", "load", "print", "kickstart"]);
  });

  test("reload=true（install 路径）：先 bootout 清出再全新 bootstrap（新配置 + BTM 重登记）→ print 复核", async () => {
    const {calls, exec} = launchctlExec({inDomain: true});
    const mode = await ensureServiceRunning(exec, {role: "web", plistPath: "/tmp/dev.deepaa.web.plist", uid: 501, reload: true});
    expect(mode).toBe("bootstrap");
    expect(calls.map(call => call.args[0])).toEqual(["enable", "bootout", "bootstrap", "print"]);
  });

  test("reload=true 全部失败：抛错并携带服务标签", async () => {
    const {exec} = launchctlExec({fail: ["bootstrap", "load", "kickstart"]});
    await expect(ensureServiceRunning(exec, {role: "proxy", plistPath: "/tmp/dev.deepaa.proxy.plist", uid: 501, reload: true}))
      .rejects.toThrow(SERVICE_ID.proxy);
  });
});

describe("C3 守护化 spawn", () => {
  test("detached + windowsHide + 日志 fd + 生产环境与数据目录注入", () => {
    const recorder = recordingSpawn();
    const openedLogs: string[] = [];
    daemonizeRole({
      role: "web",
      nodeExecutable: "/usr/local/bin/node",
      launcherPath: "/opt/deepaa/bin/deepaa.mjs",
      dataDir,
      spawnProcess: recorder.spawnProcess,
      env: {PATH: "/usr/bin", DEEPAA_LAUNCH_REASON: "service"},
      openSync: (path: string) => {
        openedLogs.push(path);
        return 11;
      },
    });
    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0]!;
    expect(call.command).toBe("/usr/local/bin/node");
    expect(call.args).toEqual(["/opt/deepaa/bin/deepaa.mjs", "web"]);
    expect(call.options.detached).toBe(true);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.env.NODE_ENV).toBe("production");
    expect(call.options.env.DEEPAA_DATA_DIR).toBe(dataDir);
    expect(call.options.env.DEEPAA_LAUNCH_REASON).toBe("manual-daemon");
    expect(openedLogs).toEqual([join(dataDir, "logs", "web.log"), join(dataDir, "logs", "web.err.log")]);
  });
});

describe("停止与端口监听者识别", () => {
  test("findPortListenerPid 解析 lsof 输出", () => {
    const runSync = (_command: string, _args: string[]) => ({code: 0, stdout: "999\n1000\n"});
    expect(findPortListenerPid(DEFAULT_PROXY_PORT, "darwin", runSync)).toBe(999);
    const miss = (_command: string, _args: string[]) => ({code: 1, stdout: ""});
    expect(findPortListenerPid(DEFAULT_PROXY_PORT, "darwin", miss)).toBeUndefined();
  });

  test("stopPortAndWait：SIGTERM 后端口释放才算停止", async () => {
    const killed: number[] = [];
    let portUp = true;
    const stop = await stopPortAndWait({
      port: 4321,
      runSync: () => ({code: 0, stdout: "777"}),
      kill: pid => killed.push(pid),
      probes: {probePort: async () => !portUp, fetchHealth: async () => ({state: "down"})},
      platform: "darwin",
    });
    expect(stop).toEqual({stopped: true, pid: 777});
    expect(killed).toEqual([777]);
    portUp = true;
    const stuck = await stopPortAndWait({
      port: 4321,
      timeoutMs: 30,
      runSync: () => ({code: 0, stdout: "777"}),
      kill: () => {},
      probes: {probePort: async () => true, fetchHealth: async () => ({state: "down"})},
      platform: "darwin",
    });
    expect(stuck.stopped).toBe(false);
  });
});

describe("C5 install / uninstall / status（macOS 路径，注入 exec）", () => {
  test("install：写 plist（直指 node）、域外 bootstrap、空闲时无接管", async () => {
    const {calls, exec} = launchctlExec({inDomain: false});
    const summary = await installServices({
      homeDir,
      dataDir,
      platform: "darwin",
      uid: 501,
      exec,
      probes: fixedProbes({web: false, proxy: false}),
      launcherPath: "/opt/deepaa/bin/deepaa.mjs",
      nodeExecutable: "/usr/local/bin/node",
    });
    expect(summary.map(item => item.mode)).toEqual(["bootstrap", "bootstrap"]);
    expect(calls.filter(call => call.args[0] === "bootstrap")).toHaveLength(2);
    const webPlist = await readFile(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), "utf8");
    expect(webPlist).toContain(SERVICE_ID.web);
    expect(webPlist).toContain("<string>/usr/local/bin/node</string>");
    expect(webPlist).toContain("<string>/opt/deepaa/bin/deepaa.mjs</string>");
  });

  test("install 清理 2026-10-06 包装器 .app 历史残留（方案 A 回滚）", async () => {
    // 预置残留形态：~/.deepaa/service/DeepAA Service.app/…
    const legacyApp = join(dataDir, "service", "DeepAA Service.app", "Contents", "MacOS");
    await mkdir(legacyApp, {recursive: true});
    await writeFile(join(legacyApp, "deepaa-service"), "stub", "utf8");
    await installServices({
      homeDir,
      dataDir,
      platform: "darwin",
      uid: 501,
      exec: launchctlExec({inDomain: false}).exec,
      probes: fixedProbes({web: false, proxy: false}),
      launcherPath: "/opt/deepaa/bin/deepaa.mjs",
      nodeExecutable: "/usr/local/bin/node",
    });
    await expect(stat(join(dataDir, "service"))).rejects.toThrow();
  });

  test("install 标签驻留域内（2026-10-07 修复）：bootout → 全新 bootstrap——改写的 plist 生效且 BTM（登录项）确定性重登记，绝不 kickstart 旧定义", async () => {
    const {calls, exec} = launchctlExec({inDomain: true});
    const summary = await installServices({
      homeDir,
      dataDir,
      platform: "darwin",
      uid: 501,
      exec,
      probes: fixedProbes({web: false, proxy: false}),
      launcherPath: "/opt/deepaa/bin/deepaa.mjs",
      nodeExecutable: "/usr/local/bin/node",
    });
    expect(summary.map(item => item.mode)).toEqual(["bootstrap", "bootstrap"]);
    expect(calls.filter(call => call.args[0] === "bootout")).toHaveLength(2);
    expect(calls.filter(call => call.args[0] === "bootstrap")).toHaveLength(2);
    expect(calls.filter(call => call.args[0] === "kickstart")).toHaveLength(0);
    expect(calls.some(call => call.args[0] === "enable")).toBe(true);
  });

  test("install 接管：端口被占时先优雅停止再注册（唯一可停代理的路径）", async () => {
    const {calls, exec} = launchctlExec({inDomain: false});
    const killed: number[] = [];
    // 模拟真实语义：两个端口初始各被一个实例占用；kill(端口对应 pid) 后该端口
    // 短暂延迟释放（stopPortAndWait 以 500ms 轮询确认）。
    const busyPorts = new Set([DEFAULT_PROXY_PORT, DEFAULT_WEB_PORT]);
    const portOf = (args: string[]) =>
      Number((args.find(arg => arg.startsWith("-iTCP:")) ?? "").slice("-iTCP:".length));
    const summary = await installServices({
      homeDir,
      dataDir,
      platform: "darwin",
      uid: 501,
      exec,
      probes: {
        probePort: async port => busyPorts.has(port),
        fetchHealth: async () => ({state: "down"}),
      },
      runSync: (_command: string, args: string[]) => ({code: 0, stdout: String(portOf(args))}),
      kill: pid => {
        killed.push(pid);
        setTimeout(() => busyPorts.delete(pid), 10);
      },
      launcherPath: "/opt/deepaa/bin/deepaa.mjs",
      nodeExecutable: "/usr/local/bin/node",
    });
    expect(summary.map(item => item.mode)).toEqual(["takeover", "takeover"]);
    expect(killed).toEqual([DEFAULT_WEB_PORT, DEFAULT_PROXY_PORT]);
    expect(calls.some(call => call.args[0] === "bootstrap")).toBe(true);
  });

  test("uninstall 运行中（2026-10-07 用户确认：注销 ≠ 停止）：不 bootout、不杀进程，仅删注册文件与 service 目录", async () => {
    const {calls, exec} = recordingExec();
    // 预置 service 目录（模拟 2026-10-06 包装器残留或任何历史内容）。
    await mkdir(join(dataDir, "service"), {recursive: true});
    const summary = await uninstallServices({
      homeDir,
      dataDir,
      platform: "darwin",
      uid: 501,
      exec,
      probes: fixedProbes({web: true, proxy: true}),
    });
    expect(summary.map(item => ({role: item.role, mode: item.mode, running: item.running}))).toEqual([
      {role: "web", mode: "kept-running", running: true},
      {role: "proxy", mode: "kept-running", running: true},
    ]);
    // 运行中刻意不 bootout（bootout 会终止 launchd 托管进程），也没有任何端口停止动作。
    expect(calls.filter(call => call.command === "launchctl")).toHaveLength(0);
    await expect(readFile(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`))).rejects.toThrow();
    await expect(stat(join(dataDir, "service"))).rejects.toThrow();
  });

  test("uninstall 未运行：bootout 清出空闲标签（无进程影响）+ 删除注册文件", async () => {
    const {calls, exec} = recordingExec();
    const summary = await uninstallServices({
      homeDir,
      dataDir,
      platform: "darwin",
      uid: 501,
      exec,
      probes: fixedProbes({web: false, proxy: false}),
    });
    expect(summary.every(item => !item.running)).toBe(true);
    expect(calls.filter(call => call.args[0] === "bootout")).toHaveLength(2);
    await expect(readFile(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`))).rejects.toThrow();
  });

  test("Windows /End：stop 专用命令（注册保留，区别于 Unregister）", () => {
    const end = buildWindowsEndCommand("web");
    expect(end.command).toBe("schtasks");
    expect(end.args).toEqual(["/End", "/TN", "DeepAA Web"]);
  });

  test("stop 语义（2026-10-05 用户确认）：已注册时仅 bootout，注册文件保留；未注册不 bootout", async () => {
    // 独立 homeDir：桩 plist 不与其它用例共享，失败也不泄漏。
    const stopHome = join(sandbox, "home-stop");
    const {calls, exec} = recordingExec();
    const {mkdir: mk, writeFile: wf} = await import("node:fs/promises");
    await mk(join(stopHome, "Library", "LaunchAgents"), {recursive: true});
    await wf(join(stopHome, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), "stub", "utf8");
    await wf(join(stopHome, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), "stub", "utf8");
    let freed = new Set();
    const summary = await stopServices({
      homeDir: stopHome,
      dataDir,
      platform: "darwin",
      uid: 501,
      exec,
      probes: {
        probePort: async port => !freed.has(port),
        fetchHealth: async () => ({state: "down"}),
      },
      runSync: (_c, args) => ({code: 0, stdout: String(Number((args.find(a => a.startsWith("-iTCP:")) ?? "").slice("-iTCP:".length)))}),
      kill: pid => { freed = new Set([pid, ...freed]); },
    });
    expect(summary.every(item => item.installed && item.stopped)).toBe(true);
    const launchctlCalls = calls.filter(call => call.command === "launchctl");
    expect(launchctlCalls.filter(call => call.args[0] === "bootout")).toHaveLength(2);
    expect(launchctlCalls.some(call => call.args[0] === "unload")).toBe(false);
    const {stat: st} = await import("node:fs/promises");
    await st(join(stopHome, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`)); // 注册保留

    // 未注册：无 bootout，直接按端口停止
    const {calls: calls2, exec: exec2} = recordingExec();
    const summary2 = await stopServices({
      homeDir: join(sandbox, "home-stop-empty"),
      dataDir,
      platform: "darwin",
      uid: 501,
      exec: exec2,
      probes: fixedProbes({web: false, proxy: false}),
      runSync: () => ({code: 1, stdout: ""}),
    });
    expect(summary2.every(item => !item.installed)).toBe(true);
    expect(calls2.filter(call => call.command === "launchctl")).toHaveLength(0);
  });

  test("status：安装/运行状态组合", async () => {
    const entries = await readServiceStatus({
      homeDir,
      dataDir,
      platform: "darwin",
      probes: fixedProbes({web: true, proxy: false}),
      runSync: () => ({code: 0, stdout: "123"}),
    });
    expect(entries).toEqual([
      {role: "web", port: DEFAULT_WEB_PORT, running: true, installed: false, pid: 123},
      {role: "proxy", port: DEFAULT_PROXY_PORT, running: false, installed: false, pid: undefined},
    ]);
  });
});

describe("C3/C4 智能启动器 smartLaunch", () => {
  test("两服务已在运行：只开浏览器、零 spawn、零 exec（零特权调用，绝不弹密）", async () => {
    const recorder = recordingSpawn();
    const {calls: execCalls, exec} = recordingExec();
    const opened: string[] = [];
    const lines: string[] = [];
    const result = await smartLaunch({
      homeDir,
      dataDir,
      platform: "darwin",
      probes: fixedProbes({web: true, proxy: true, health: "deepaa"}),
      spawnProcess: recorder.spawnProcess,
      exec,
      openBrowser: async url => opened.push(url),
      ensureIcon: async () => {},
      output: text => lines.push(text),
    });
    expect(result.alreadyRunning).toBe(true);
    expect(result.started).toEqual([]);
    expect(recorder.calls).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
    expect(opened).toEqual([`http://127.0.0.1:${DEFAULT_WEB_PORT}`]);
    expect(lines.join("\n")).toContain("Web 与代理服务本就在运行");
    expect(lines.join("\n")).toContain("service install");
  });

  test("两服务都没跑：守护化补齐 → 就绪 → 开浏览器一次", async () => {
    const sim = readinessSimulation();
    const {calls: spawnCalls, spawnProcess} = readinessSpawn(sim.markRoleReady);
    const opened: string[] = [];
    const result = await smartLaunch({
      homeDir,
      dataDir,
      platform: "darwin",
      probes: sim.probes,
      spawnProcess,
      exec: recordingExec().exec,
      openBrowser: async url => opened.push(url),
      openSync: () => 7,
      ensureIcon: async () => {},
      output: () => {},
    });
    expect(result.started.map(item => `${item.role}:${item.mode}`)).toEqual(["web:daemon", "proxy:daemon"]);
    expect(spawnCalls.map(call => call.args[1])).toEqual(["web", "proxy"]);
    expect(opened).toEqual([`http://127.0.0.1:${DEFAULT_WEB_PORT}`]);
  });

  test("Web 端口被外来进程占用：启动前即报错，零 spawn（不留半启动状态）", async () => {
    const recorder = recordingSpawn();
    await expect(smartLaunch({
      homeDir,
      dataDir,
      platform: "darwin",
      probes: fixedProbes({web: true, proxy: false, health: "foreign"}),
      spawnProcess: recorder.spawnProcess,
      openBrowser: async () => {},
      ensureIcon: async () => {},
      output: () => {},
    })).rejects.toThrow("非 DeepAA");
    expect(recorder.calls).toHaveLength(0);
  });

  test("F3 图标自愈：smartLaunch 每次启动前调用一次（注入点）", async () => {
    const ensureIconCalls: Array<{platform?: string; homeDir?: string}> = [];
    await smartLaunch({
      homeDir,
      dataDir,
      platform: "darwin",
      probes: fixedProbes({web: true, proxy: true, health: "deepaa"}),
      spawnProcess: recordingSpawn().spawnProcess,
      exec: recordingExec().exec,
      openBrowser: async () => {},
      ensureIcon: async options => ensureIconCalls.push(options),
      output: () => {},
    });
    expect(ensureIconCalls).toHaveLength(1);
    expect(ensureIconCalls[0]).toEqual({platform: "darwin", homeDir});
  });

  test("服务已注册且未运行：走 bootstrap 而非守护化；「已启动 代理」以端口就绪为判据", async () => {
    const sim = readinessSimulation();
    const recorder = recordingSpawn();
    const {calls: execCalls, exec} = launchctlExec({inDomain: false});
    // 预置 plist 文件 → isInstalled = true
    const {mkdir: mk} = await import("node:fs/promises");
    await mk(join(homeDir, "Library", "LaunchAgents"), {recursive: true});
    const {writeFile: wf} = await import("node:fs/promises");
    await wf(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), "stub", "utf8");
    await wf(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), "stub", "utf8");
    const result = await smartLaunch({
      homeDir,
      dataDir,
      platform: "darwin",
      probes: sim.probes,
      spawnProcess: recorder.spawnProcess,
      exec: serviceLaunchExec(exec, sim.markRoleReady),
      openBrowser: async () => {},
      ensureIcon: async () => {},
      output: () => {},
    });
    expect(result.started.map(item => item.mode)).toEqual(["service", "service"]);
    expect(recorder.calls).toHaveLength(0);
    expect(execCalls.filter(call => call.args[0] === "bootstrap")).toHaveLength(2);
    // 清理 stub
    await rm(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), {force: true});
    await rm(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), {force: true});
  });

  test("空闲标签场景（2026-10-06 修复）：smartLaunch 走 kickstart 唤醒，不再干等 45s 超时", async () => {
    const sim = readinessSimulation();
    const recorder = recordingSpawn();
    const {calls: execCalls, exec} = launchctlExec({inDomain: true});
    const {mkdir: mk, writeFile: wf} = await import("node:fs/promises");
    await mk(join(homeDir, "Library", "LaunchAgents"), {recursive: true});
    await wf(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), "stub", "utf8");
    await wf(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), "stub", "utf8");
    const result = await smartLaunch({
      homeDir,
      dataDir,
      platform: "darwin",
      probes: sim.probes,
      spawnProcess: recorder.spawnProcess,
      exec: serviceLaunchExec(exec, sim.markRoleReady),
      openBrowser: async () => {},
      ensureIcon: async () => {},
      output: () => {},
    });
    expect(result.started.map(item => item.mode)).toEqual(["service", "service"]);
    expect(recorder.calls).toHaveLength(0);
    expect(execCalls.filter(call => call.args[0] === "kickstart")).toHaveLength(2);
    await rm(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), {force: true});
    await rm(join(homeDir, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), {force: true});
  });
});

describe("浏览器打开命令", () => {
  test("平台分派", () => {
    expect(buildBrowserOpenCommand("http://127.0.0.1:3210", "darwin")).toEqual({command: "open", args: ["http://127.0.0.1:3210"]});
    expect(buildBrowserOpenCommand("http://127.0.0.1:3210", "win32").args[0]).toBe("/c");
    expect(buildBrowserOpenCommand("http://127.0.0.1:3210", "linux").command).toBe("xdg-open");
  });
});

describe("服务路径失败静默降级（2026-10-07 用户确认：零 sfltool、零提示，失败才降级守护化）", () => {
  test("已注册但服务路径全失败（如系统设置置灰导致 bootstrap 被拒）→ 静默后台守护拉起，无提示输出", async () => {
    const sim = readinessSimulation();
    const {calls: spawnCalls, spawnProcess} = readinessSpawn(sim.markRoleReady);
    // launchctl 全失败：enable 成功、print 失败（域外）、bootstrap/load/kickstart 全拒。
    const {calls: execCalls, exec} = launchctlExec({inDomain: false, fail: ["bootstrap", "load", "kickstart"]});
    const fallbackHome = join(sandbox, "home-fallback");
    await mkdir(join(fallbackHome, "Library", "LaunchAgents"), {recursive: true});
    await writeFile(join(fallbackHome, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), "stub", "utf8");
    await writeFile(join(fallbackHome, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), "stub", "utf8");
    const lines: string[] = [];
    const result = await smartLaunch({
      homeDir: fallbackHome,
      dataDir,
      platform: "darwin",
      probes: sim.probes,
      spawnProcess,
      exec,
      openBrowser: async () => {},
      ensureIcon: async () => {},
      output: text => lines.push(text),
    });
    expect(result.started.map(item => item.mode)).toEqual(["daemon", "daemon"]);
    expect(spawnCalls.map(call => call.args[1])).toEqual(["web", "proxy"]);
    // 全程零 sfltool（置灰检测的唯一信号是 root 调试工具，用户终端会弹授权框）。
    expect(execCalls.some(call => call.command === "sfltool")).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("后台守护");
    // 静默降级：不向用户提示机制差异（最终结果一致，提示反而令人困惑）。
    expect(text).not.toContain("系统服务启动未成功");
    expect(text).not.toContain("置灰");
    expect(text).not.toContain("允许在后台");
  });

  test("2026-10-11 事故形态：bootstrap 被拒 + load -w 静默空成功（退出码 0）→ 不谎报「系统服务」，bootout 清出后降级守护且端口就绪", async () => {
    // 复刻 10-11 实测现场：print 恒失败（任务从未进域）、bootstrap 被拒、kickstart
    // 失败；enable / load -w 退出码 0（后者静默空成功——旧代码据此返回 "load"
    // 并打印「已启动 代理（系统服务）」，而 launchd 域内无此服务、代理从未运行）。
    const execCalls: Array<{command: string; args: string[]}> = [];
    const exec = (command: string, args: string[]) => {
      execCalls.push({command, args: [...args]});
      if (command !== "launchctl") return Promise.resolve({code: 0, stdout: "", stderr: ""});
      if (["print", "bootstrap", "kickstart"].includes(args[0])) {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: args[0] === "bootstrap" ? "Bootstrap failed: 125" : "Could not find service",
        });
      }
      return Promise.resolve({code: 0, stdout: "", stderr: ""});
    };
    const sim = readinessSimulation();
    const {calls: spawnCalls, spawnProcess} = readinessSpawn(sim.markRoleReady);
    const lieHome = join(sandbox, "home-lie");
    await mkdir(join(lieHome, "Library", "LaunchAgents"), {recursive: true});
    await writeFile(join(lieHome, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), "stub", "utf8");
    await writeFile(join(lieHome, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), "stub", "utf8");
    const lines: string[] = [];
    const result = await smartLaunch({
      homeDir: lieHome,
      dataDir,
      platform: "darwin",
      probes: sim.probes,
      spawnProcess,
      exec,
      openBrowser: async () => {},
      ensureIcon: async () => {},
      output: text => lines.push(text),
    });
    expect(result.started.map(item => `${item.role}:${item.mode}`)).toEqual(["web:daemon", "proxy:daemon"]);
    expect(spawnCalls.map(call => call.args[1])).toEqual(["web", "proxy"]);
    // 绝不打印「系统服务」——端口未就绪的服务路径声明不得成为成功依据。
    const text = lines.join("\n");
    expect(text).toContain("已启动 代理");
    expect(text).toContain("后台守护");
    expect(text).not.toContain("系统服务");
  });

  test("服务路径与守护化全部未就绪：诚实抛错并给出日志路径，绝不打印「已启动」", async () => {
    const recorder = recordingSpawn();
    // 守护化 spawn 不翻转端口（守护也起不来）→ 最终校验超时（注入 30ms 加速）。
    const {exec} = launchctlExec({inDomain: false, fail: ["bootstrap", "load", "kickstart"]});
    const deadHome = join(sandbox, "home-dead");
    await mkdir(join(deadHome, "Library", "LaunchAgents"), {recursive: true});
    await writeFile(join(deadHome, "Library", "LaunchAgents", `${SERVICE_ID.web}.plist`), "stub", "utf8");
    await writeFile(join(deadHome, "Library", "LaunchAgents", `${SERVICE_ID.proxy}.plist`), "stub", "utf8");
    const lines: string[] = [];
    await expect(smartLaunch({
      homeDir: deadHome,
      dataDir,
      platform: "darwin",
      probes: fixedProbes({web: false, proxy: false, health: "deepaa"}),
      spawnProcess: recorder.spawnProcess,
      exec,
      openBrowser: async () => {},
      ensureIcon: async () => {},
      output: text => lines.push(text),
      proxyReadyTimeoutMs: 30,
    })).rejects.toThrow("代理服务启动未确认");
    // 守护化兜底确实执行过，但未就绪 → 诚实失败（无任何「已启动」输出）。
    expect(recorder.calls.map(call => call.args[1])).toContain("proxy");
    expect(lines.join("\n")).not.toContain("已启动");
  });
});
