import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:http";
import {chmod, mkdtemp, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {describe, expect, test} from "vitest";
import {ProxyExchangeStore} from "../src/proxy/exchange-store.js";
import type {CollectedRawBody} from "../src/proxy/raw-v2-contract.js";

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Node 代理进程隔离", () => {
  test("代理 Store 不导入 SQLite、业务派生或 UI", async () => {
    const sources = await Promise.all([
      "src/reverse-proxy.ts",
      "src/proxy/exchange-store.ts",
      "src/proxy/routing-config.ts",
      "src/proxy/raw-body-collector.ts",
      "src/proxy/capture-writer.ts",
    ].map(path => readFile(join(rootDir, path), "utf8")));

    expect(sources.join("\n")).not.toMatch(
      /better-sqlite3|node:sqlite|capture-index|derivation|src\/lib\/harness|next\/|react|terminal|from\s+["'][^"']*(credential|development-launch)["']/iu,
    );
  });

  test("两个独立 Store 只追加 v2 raw 且 ID 不重复", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "deepaa-proxy-isolation-"));
    const first = new ProxyExchangeStore({dataDir});
    const second = new ProxyExchangeStore({dataDir});
    await Promise.all([first.init(), second.init()]);

    const [firstExchange, secondExchange] = await Promise.all([
      first.record(captureInput("first")),
      second.record(captureInput("second")),
    ]);

    expect(firstExchange?.schemaVersion).toBe(2);
    expect(secondExchange?.schemaVersion).toBe(2);
    expect(firstExchange?.captureSessionId).not.toBe(secondExchange?.captureSessionId);
    expect(firstExchange?.exchangeId).not.toBe(secondExchange?.exchangeId);
    expect((await readdir(join(dataDir, "captures", "v2"))).length).toBe(2);
    await expect(readdir(join(dataDir, "derived"))).rejects.toThrow();
    await expect(readdir(join(dataDir, "indexes"))).rejects.toThrow();
  });

  test("bundle 闭包只包含独立代理模块", async () => {
    await execFileAsync(process.execPath, ["scripts/build-proxy.mjs"], {
      cwd: rootDir,
      env: {...process.env, PROXY_BUILD_SKIP_SMOKE: "1"},
    });
    const metadata = JSON.parse(await readFile(
      join(rootDir, "dist", "proxy", "proxy-server.meta.json"),
      "utf8",
    )) as {inputs: Record<string, unknown>; outputs: Record<string, {imports?: Array<{path: string}>}>};
    const closure = Object.keys(metadata.inputs).join("\n");
    const outputImports = Object.values(metadata.outputs)
      .flatMap(output => output.imports ?? [])
      .map(item => item.path);

    expect(closure).toContain("src/proxy-server.ts");
    expect(closure).not.toMatch(
      /node_modules|next|react|better-sqlite3|node:sqlite|sqlite|stream-json|worker|terminal|credential|src\/lib\/db\/schema|src\/lib\/ingestion|raw-stream-gateway|src\/lib\/harness|src\/store\.ts/iu,
    );
    expect(outputImports.length).toBeGreaterThan(0);
    expect(outputImports.every(path => path.startsWith("node:"))).toBe(true);
  });

  test("代理构建门禁显式排除完整内容读取链路", async () => {
    const buildScript = await readFile(join(rootDir, "scripts", "build-proxy.mjs"), "utf8");

    for (const forbidden of [
      "stream-json",
      "export-content-events",
      "raw-stream-gateway",
      "app/api/export/content",
    ]) {
      expect(buildScript).toContain(forbidden);
    }
  });

  test("没有 .next 时独立产物仍可启动并转发", async () => {
    await execFileAsync(process.execPath, ["scripts/build-proxy.mjs"], {
      cwd: rootDir,
      env: {...process.env, PROXY_BUILD_SKIP_SMOKE: "1"},
    });
    const runtimeDir = await mkdtemp(join(tmpdir(), "deepaa-proxy-bundle-"));
    const dataDir = join(runtimeDir, "runtime-data");
    // node 脚本 + shebang：POSIX 直接执行，Windows 由 token-resolver 经 process.execPath 启动。
    const helperPath = join(runtimeDir, "echo-token.mjs");
    await mkdir(dataDir, {recursive: true});
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
        supportedModelScopes: {"gpt-test": ["codex", "claude", "opencode", "dsh"]},
        supportedModelWireApis: {"gpt-test": ["responses", "chat_completions", "messages"]},
        development: {defaultCredentials: {codex: "test-cred"}},
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      }],
      localProxyBaseUrl: "http://127.0.0.1:3211",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }, null, 2)}\n`);

    const child = (await import("node:child_process")).spawn(
      process.execPath,
      [join(rootDir, "dist", "proxy", "proxy-server.mjs")],
      {
        cwd: runtimeDir,
        env: {
          ...process.env,
          DEEPAA_DATA_DIR: dataDir,
          DEEPAA_CREDENTIAL_HELPER: helperPath,
          PROXY_HOST: "127.0.0.1",
          PROXY_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const ready = await waitForReady(child);
      expect(ready).toMatchObject({
        event: "proxy-ready",
        host: "127.0.0.1",
        captureDegraded: false,
      });
      expect(ready.port).toBeGreaterThan(0);
      await expect(fetch(`http://127.0.0.1:${ready.port}/codex/v1/models`).then(response => response.json()))
        .resolves.toMatchObject({
          object: "list",
          data: [{id: "gpt-test_fixture.example", object: "model", owned_by: "fixture.example"}],
        });
      await expect(fetch(`http://127.0.0.1:${ready.port}/codex/v1/responses`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({model: "gpt-test_fixture.example"}),
      }).then(response => response.json()))
        .resolves.toMatchObject({path: "/v1/responses", auth: "Bearer bundle-token"});
      // Windows 无法投递真实 SIGTERM（kill 即 TerminateProcess，优雅排水与
      // proxy-stopped 事件不会执行）；优雅停止契约只在 POSIX 矩阵验证。
      if (process.platform !== "win32") {
        const stoppedEvent = waitForJsonEvent(child, "proxy-stopped");
        child.kill("SIGTERM");
        const stopped = await stoppedEvent;
        expect(stopped).toMatchObject({
          event: "proxy-stopped",
          capture: {
            capturePendingBytes: 0,
            activeFinalizers: 0,
            queuedFinalizers: 0,
            capturePendingTasks: 0,
            capturePendingRecordBytes: 0,
            captureDroppedRecords: 0,
            captureMissingBodies: 0,
          },
        });
        await once(child, "exit");
      } else {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "exit"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("代理未在期限内退出")), 5_000)),
        ]);
      }
      upstream.close();
      await once(upstream, "close");
    }
  }, 60_000);
});

async function waitForJsonEvent(
  child: import("node:child_process").ChildProcessWithoutNullStreams,
  event: string,
): Promise<Record<string, unknown>> {
  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(`等待代理 ${event} 超时`)), 15_000);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {event?: string};
          if (parsed.event === event) {
            clearTimeout(timeout);
            resolvePromise(parsed as Record<string, unknown>);
            return;
          }
        } catch {
          // 忽略非协议输出。
        }
      }
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`代理在 ${event} 前退出 (${code})`));
    });
  });
}

function captureInput(marker: string) {
  const requestText = JSON.stringify({model: "fixture-model", input: marker});
  const responseText = JSON.stringify({output: marker});
  return {
    capturedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.025Z",
    model: "fixture-model",
    routing: {
      targetId: "target-proxy",
      targetName: "Proxy Target",
      targetFormatHint: "openai" as const,
      localUrl: "http://127.0.0.1:3211/codex/v1/responses",
      upstreamUrl: "http://127.0.0.1:4311/v1/responses",
      localPath: "/codex/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: {
      headers: {"content-type": "application/json"},
      body: inlineBody(requestText),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {"content-type": "application/json"},
      body: inlineBody(responseText),
      isStreaming: false,
    },
  };
}

function inlineBody(rawBody: string): CollectedRawBody {
  const body = Buffer.from(rawBody);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    rawBody,
    rawBodyRef: {storage: "inline", encoding: "identity", sha256, sizeBytes: body.length},
    bodySizeBytes: body.length,
    bodySha256: sha256,
    missing: false,
  };
}

async function waitForReady(child: import("node:child_process").ChildProcessWithoutNullStreams): Promise<{
  event: string;
  host: string;
  port: number;
  captureDegraded: boolean;
}> {
  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`等待代理 ready 超时: ${stderr}`)), 5_000);
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {event?: string};
          if (parsed.event === "proxy-ready") {
            clearTimeout(timeout);
            resolvePromise(parsed as Awaited<ReturnType<typeof waitForReady>>);
            return;
          }
        } catch {
          // ready 协议只消费完整 JSON 行；其他诊断输出留给超时错误。
        }
      }
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`代理在 ready 前退出 (${code}): ${stderr}`));
    });
  });
}
