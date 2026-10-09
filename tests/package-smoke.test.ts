import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {chmod, mkdtemp, readFile, readdir, rename, rm, writeFile} from "node:fs/promises";
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
    const installed = await run(npm, [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      tarball,
      // 从本地 tarball 安装需解析整棵生产依赖树；本项目日常用 pnpm（npm 自身
      // cacache 常为冷缓存），在国内网络对 registry.npmjs.org 的解析可超 120s
      // （实测零输出挂满旧超时被杀）。这里只放宽等待，不改变安装语义。
    ], {cwd: installDir, env: process.env}, 420_000);
    expect(installed.code, installed.stderr).toBe(0);

    const packageDir = join(installDir, "node_modules", "deepaa");
    const hiddenNext = join(packageDir, ".next.hidden");
    await rename(join(packageDir, ".next"), hiddenNext);
    await chmod(packageDir, 0o555);
    const dataDir = join(smokeRoot, "runtime-data");
    await import("node:fs/promises").then(({mkdir}) => mkdir(dataDir, {recursive: true}));
    const helperPath = join(smokeRoot, "echo-token.sh");
    await writeFile(helperPath, "#!/bin/sh\nprintf 'bundle-token\\n'\n", "utf8");
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
    const child = spawn(command, args, {...options, stdio: ["ignore", "pipe", "pipe"]});
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
