import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, test} from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageSmoke = process.env.RUN_PACKAGE_SMOKE === "1" ? test : test.skip;
const smokeRoots = new Set<string>();

afterEach(async () => {
  for (const smokeRoot of smokeRoots) {
    await chmod(join(smokeRoot, "install", "node_modules", "deepaa"), 0o755).catch(() => undefined);
    await rm(smokeRoot, {recursive: true, force: true});
  }
  smokeRoots.clear();
});

describe("npm 发布包", () => {
  test("清单包含独立代理和 Next 运行产物", async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(packageJson.files).toContain("dist/proxy");
    expect(packageJson.files).toContain("bin");
    expect(packageJson.files).toContain(".next");
    expect(packageJson.files).toContain("!.next/dev");
    expect(packageJson.files).toContain("scripts/normalize-next-trace.mjs");
    expect(packageJson.files).toContain("scripts/verify-next-trace.mjs");
    expect(packageJson.files).toContain("data/defaults/litellm-model-prices.snapshot.json");
    // UI 运行时静态资源（2026-10-09 Windows 实测事故：files 白名单漏 public/，
    // 安装模式下品牌 Logo 与 Agent 徽标全部 404——源码模式因 public/ 在仓库里而不可见）。
    expect(packageJson.files).toContain("public/agent-logos");
    expect(packageJson.files).toContain("public/deepaa-mark.png");
    expect(packageJson.scripts["data:reset"]).toBe("tsx ./scripts/data-reset.ts");
    expect(existsSync(join(rootDir, "bin", "development-launch.mjs"))).toBe(true);
  });

  packageSmoke("清单包含 UI 运行时静态资源（Logo / Agent 徽标）", async () => {
    const {AGENT_LOGO_EXT} = await import("../src/lib/agent-registry");
    const smokeRoot = await mkdtemp(join(tmpdir(), "deepaa-pack-manifest-"));
    const packed = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--json", "--pack-destination", smokeRoot], {
      cwd: rootDir,
      env: process.env,
    }, 180_000);
    try {
      expect(packed.code, packed.stderr).toBe(0);
      const packResult = JSON.parse(packed.stdout) as Array<{files: Array<{path: string}>}>;
      const packagedPaths = packResult[0]!.files.map(file => file.path);
      expect(packagedPaths).toContain("public/deepaa-mark.png");
      for (const [agent, ext] of Object.entries(AGENT_LOGO_EXT)) {
        expect(packagedPaths, `agent-logos/${agent}.${ext}`).toContain(`public/agent-logos/${agent}.${ext}`);
      }
      // public/ 里的设计评审草稿不得混入发布包。
      expect(packagedPaths.filter(path => path.includes("logo-review"))).toEqual([]);
    } finally {
      await rm(smokeRoot, {recursive: true, force: true});
    }
  }, 240_000);

  packageSmoke("临时安装后代理不依赖 .next 且只写显式数据目录", async () => {
    const smokeRoot = await mkdtemp(join(tmpdir(), "deepaa-package-smoke-"));
    smokeRoots.add(smokeRoot);
    const packDir = join(smokeRoot, "pack");
    const installDir = join(smokeRoot, "install");
    await Promise.all([
      import("node:fs/promises").then(({mkdir}) => mkdir(packDir, {recursive: true})),
      import("node:fs/promises").then(({mkdir}) => mkdir(installDir, {recursive: true})),
    ]);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // npm pack 需现场打包 21MB 产物，刚构建完/冷文件系统时可超默认 30s。
    const packed = await run(npm, ["pack", "--json", "--pack-destination", packDir], {
      cwd: rootDir,
      env: process.env,
    }, 180_000);
    expect(packed.code, packed.stderr).toBe(0);
    const packResult = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{path: string}>;
    }>;
    const packagedPaths = packResult[0]!.files.map(file => file.path);
    expect(packagedPaths).toContain("bin/development-launch.mjs");
    expect(packagedPaths).toContain("scripts/normalize-next-trace.mjs");
    expect(packagedPaths).toContain("scripts/verify-next-trace.mjs");
    expect(packagedPaths).toContain("data/defaults/litellm-model-prices.snapshot.json");
    const tarball = join(packDir, packResult[0]!.filename);

    await writeFile(join(installDir, "package.json"), JSON.stringify({private: true}), "utf8");
    // vitest 全局 HOME 沙箱（tests/helpers/home-sandbox.ts）使 npm 的 cacache
    // 每次运行都落在全新临时目录，--prefer-offline 永远落空：每次都要从
    // registry.npmjs.org 全量下载整棵生产依赖树（~600 包），国内网络经代理
    // 单包可达数十~上百秒（实测 next.tgz 146s），420s 超时不够（2026-10-22
    // 发布 1.1.6 两次超时事故）。--cache 指向跨运行持久的共享目录：安装语义
    // 不变（仍完整解析+落盘依赖树），HOME 沙箱对 CLI 配置/凭据的防护不变，
    // 仅 tarball 缓存可复用；CI 冷缓存首跑行为与旧版一致。
    const npmCacheDir = join(tmpdir(), "deepaa-smoke-npm-cache");
    await mkdir(npmCacheDir, {recursive: true});
    const installed = await run(npm, [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--cache",
      npmCacheDir,
      tarball,
    ], {cwd: installDir, env: process.env}, 420_000);
    expect(installed.code, installed.stderr).toBe(0);

    const packageDir = join(installDir, "node_modules", "deepaa");
    const hiddenNext = join(packageDir, ".next.hidden");
    await rename(join(packageDir, ".next"), hiddenNext);
    await chmod(packageDir, 0o555);
    const dataDir = join(smokeRoot, "runtime-data");
    await import("node:fs/promises").then(({mkdir}) => mkdir(dataDir, {recursive: true}));
    const helperPath = join(smokeRoot, "echo-token.mjs");
    await writeFile(helperPath, "#!/usr/bin/env node\nprocess.stdout.write('bundle-token\\n');\n", "utf8");
    await chmod(helperPath, 0o755);
    const upstream = createServer((request, response) => {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({path: request.url, auth: request.headers.authorization}));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fixture 未监听 TCP 端口");
    await writeFile(join(dataDir, "proxy-config.json"), `${JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [{
        id: "fixture.example",
        name: "Fixture",
        openaiUrl: `http://127.0.0.1:${address.port}`,
        enabled: true,
        supportedModels: ["gpt-test"],
        supportedModelScopes: {"gpt-test": ["codex"]},
        supportedModelWireApis: {"gpt-test": ["responses"]},
        development: {defaultCredentials: {codex: "test-cred"}},
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      }],
      localProxyBaseUrl: "http://127.0.0.1:3211",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }, null, 2)}\n`);

    const proxy = spawn(process.execPath, [join(packageDir, "bin", "deepaa.mjs"), "proxy"], {
      cwd: smokeRoot,
      env: {
        ...process.env,
        DEEPAA_DATA_DIR: dataDir,
        DEEPAA_CREDENTIAL_HELPER: helperPath,
        PROXY_HOST: "127.0.0.1",
        PROXY_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ready = await waitForReady(proxy);
      const response = await fetch(`http://127.0.0.1:${ready.port}/codex/v1/responses`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({model: "gpt-test_fixture.example"}),
      });
      // 裸根 OpenAI base 按标准补 /v1（兼容 New API 只注册 /v1 路由的中转站）。
      expect(await response.json()).toEqual({path: "/v1/responses", auth: "Bearer bundle-token"});
      await waitFor(() => directoryHasEntries(join(dataDir, "captures", "v2")));
    } finally {
      await stopChild(proxy);
      upstream.close();
      await once(upstream, "close");
    }

    const web = spawn(process.execPath, [join(packageDir, "bin", "deepaa.mjs"), "web"], {
      cwd: smokeRoot,
      env: {...process.env, DEEPAA_DATA_DIR: dataDir, PORT: "38991"},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const webResult = await collectExit(web, 15_000);
    expect(webResult.code).not.toBe(0);
    expect(`${webResult.stdout}\n${webResult.stderr}`).toMatch(/production build|BUILD_ID|\.next/iu);
  }, 600_000);
});

function run(command: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv}, timeoutMs = 30_000) {
  return new Promise<{code: number; stdout: string; stderr: string}>((resolvePromise, reject) => {
    // Windows 的 npm 只能经 npm.cmd 执行，而新版 Node 出于安全（CVE-2024-27980）
    // 禁止无 shell 直接 spawn .cmd/.bat（EINVAL）；本测试 args 无空格（临时目录为短路径），join 安全。
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error([
        `${command} ${args.join(" ")} 执行超时`,
        stdout ? `stdout: ${stdout.slice(-2_000)}` : "stdout: <empty>",
        stderr ? `stderr: ${stderr.slice(-2_000)}` : "stderr: <empty>",
      ].join("\n")));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", code => {
      clearTimeout(timer);
      resolvePromise({code: code ?? 1, stdout, stderr});
    });
  });
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<{port: number}> {
  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`等待代理 ready 超时\nstdout: ${stdout}\nstderr: ${stderr}`)), 8_000);
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        try {
          const value = JSON.parse(line) as {event?: string; port?: number};
          if (value.event === "proxy-ready" && typeof value.port === "number") {
            clearTimeout(timer);
            resolvePromise({port: value.port});
          }
        } catch {
          // 启动器的人类可读输出不是 ready JSON，忽略即可。
        }
      }
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`代理在 ready 前退出 (${code})\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("子进程未在期限内退出")), 8_000)),
  ]);
}

async function collectExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("等待子进程退出超时")), timeoutMs)),
  ]);
  return {code, stdout, stderr};
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 raw 写入超时");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

describe("跨平台构建守护（2026-10-13 事故：构建机平台常数折叠）", () => {
  // Next Turbopack 生产构建会把 `process.platform`、甚至 `os.platform()` 的比较
  // 按「构建机」平台做编译期常数折叠并消除另一平台分支，产物留下
  // "TURBOPACK unreachable" 死分支标记（1.1.3 在 mac 构建：Windows 用户的
  // spawnCredential execPath 兜底与 zcode/dsh 启动器的 cmd.exe 分支被整体删除）。
  // 修复口径：平台判定只允许经 src/lib/runtime-platform.ts（new Function 不
  // 透明边界，构建器无法静态求值）。本组测试源码与产物两端锁死；产物断言
  // 采用「函数级窗口」+「TURBOPACK unreachable 金丝雀」——2026-10-13 复盘：
  // 早期版本只查「同一 chunk 双字面量并存」，被同 chunk 内其它副本的字符串
  // 假阳性骗过，路由实际使用的函数体已被折叠。

  const stripComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  test("源码零平台常量直接比较（process.platform 与 platform() 一并封死）", async () => {
    const offenders: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, {withFileTypes: true})) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(p);
          continue;
        }
        if (!/\.(ts|tsx|mjs)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
        const stripped = stripComments(await readFile(p, "utf8"));
        const rel = p.replace(/\\/g, "/");
        if (/process\.platform\s*(===|!==)|\bplatform\(\)\s*(===|!==)/.test(stripped)) {
          offenders.push(`${rel}（平台常量比较）`);
        }
        if (rel.endsWith("runtime-platform.ts")) continue;
        if (/import\s*\{[^}]*\bplatform\b[^}]*\}\s*from\s*["']node:os["']/.test(stripped)) {
          offenders.push(`${rel}（绕过 runtime-platform 私引 node:os 的 platform）`);
        }
      }
    };
    await walk(join(rootDir, "src"));
    expect(
      offenders,
      "平台判定一律走 @/lib/runtime-platform（isWindowsRuntime/isMacRuntime）",
    ).toEqual([]);
  });

  test("runtime-platform 模块与 5 个消费点在位", async () => {
    const core = await readFile(join(rootDir, "src/lib/runtime-platform.ts"), "utf8");
    expect(core).toContain("new Function");
    expect(core).toContain("return process.platform");
    for (const [file, marker] of [
      ["src/lib/development-launch/strategies/shared.ts", "isMacRuntime()"],
      ["src/lib/development-launch/config-resolver.ts", "isWindowsRuntime()"],
      ["src/lib/sync-engine/subscription-oauth.ts", "isMacRuntime()"],
      ["src/proxy/official-upstream.ts", "isMacRuntime()"],
      ["src/lib/sync-engine/service.ts", "process.execPath"],
      ["src/proxy/token-resolver.ts", "process.execPath"],
    ] as const) {
      expect(await readFile(join(rootDir, file), "utf8"), file).toContain(marker);
    }
  });

  packageSmoke("构建产物：零 Turbopack 折叠标记 + 关键函数窗口内双分支存活", async () => {
    const chunksDir = join(rootDir, ".next", "server", "chunks");
    if (!existsSync(chunksDir)) {
      throw new Error("缺少 .next 构建产物：先执行 pnpm build 再跑 pnpm test:package");
    }
    const chunks: Array<[string, string]> = [];
    for (const f of (await readdir(chunksDir)).filter(x => x.endsWith(".js"))) {
      chunks.push([f, await readFile(join(chunksDir, f), "utf8")]);
    }
    expect(chunks.length).toBeGreaterThan(0);

    // 金丝雀：Turbopack 折叠死分支时会在产物写入该标记。历史上正常产物为 0；
    // 若未来出现合法的其它常数折叠，应显式评估后把本断言改为窗口级。
    const unreachable = chunks.filter(([, s]) => s.includes("TURBOPACK unreachable"));
    expect(
      unreachable.map(([f]) => f),
      "检测到 Turbopack 常数折叠死分支（平台分支被按构建机消除的高危信号）",
    ).toEqual([]);

    // 函数级窗口断言：锚点是各函数体内的日志/命令字面量（压缩不改变字符串），
    // 窗口内必须同时出现双平台分支的字面量——同 chunk 其它副本不再能假阳性。
    const windowHas = (source: string, anchor: string, span: number) => {
      const results: string[] = [];
      let i = source.indexOf(anchor);
      while (i !== -1) {
        results.push(source.slice(Math.max(0, i - span), i + anchor.length + span));
        i = source.indexOf(anchor, i + 1);
      }
      return results;
    };
    const windowsWith = (anchor: string, span = 1400) => {
      const all: string[] = [];
      for (const [, s] of chunks) all.push(...windowHas(s, anchor, span));
      return all;
    };
    const expectAllWindows = (anchor: string, required: readonly string[], label: string) => {
      const windows = windowsWith(anchor);
      expect(windows.length, `${label}：锚点字符串完全消失（整分支被折叠删除）`).toBeGreaterThan(0);
      for (const w of windows) {
        for (const needle of required) {
          expect(w.includes(needle), `${label}：窗口内缺少分支字面量 ${needle}`).toBe(true);
        }
      }
    };

    expectAllWindows("zcode app launch failed", ["/usr/bin/open", "cmd.exe"], "zcode 桌面启动器");
    expectAllWindows("dsh desktop app launch failed", ["/usr/bin/open", "homedir"], "dsh 桌面启动器");
    expectAllWindows("find-generic-password", ["Claude Code-credentials"], "Claude Keychain 守卫");
    expectAllWindows("--proxy", ["scutil"], "macOS 系统代理探测");
    // 锚点用 Windows 分支独有的 “Roaming”（全产物唯一；config-sync 的 opencode
    // 适配器另有一份 XDG-only 实现读同一 env 名，用 env 名做锚会串门）。
    expectAllWindows("Roaming", ["APPDATA", ".config", "isWindowsRuntime"], "opencode 配置路径");
    expectAllWindows(
      "CREDENTIAL_HELPER_TIMEOUT",
      ["execPath"],
      "凭据 helper 启动（恒 execPath）",
    );

    const proxyBundle = join(rootDir, "dist", "proxy", "proxy-server.mjs");
    if (existsSync(proxyBundle)) {
      const proxySource = await readFile(proxyBundle, "utf8");
      expect(proxySource, "proxy 侧 token-resolver 必须保留 execPath 兜底").toContain("execPath");
      expect(proxySource, "proxy 侧平台判定必须走不透明读取").toContain("return process.platform");
    }
  });
});
