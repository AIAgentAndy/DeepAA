#!/usr/bin/env node

import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist", "proxy");
const tempDir = join(rootDir, "dist", `.proxy-build-${randomUUID()}`);
const tempBundle = join(tempDir, "proxy-server.mjs");
const tempMetadata = join(tempDir, "proxy-server.meta.json");

try {
  await runTypecheck();
  await mkdir(tempDir, {recursive: true});
  const result = await build({
    absWorkingDir: rootDir,
    entryPoints: ["src/proxy-server.ts"],
    outfile: tempBundle,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
  verifyDependencyClosure(result.metafile);
  await writeFile(tempMetadata, `${JSON.stringify(result.metafile, null, 2)}\n`, "utf8");
  if (process.env.PROXY_BUILD_SKIP_SMOKE !== "1") await smokeBundle(tempBundle);

  await mkdir(distDir, {recursive: true});
  await rename(tempBundle, join(distDir, "proxy-server.mjs"));
  await rename(tempMetadata, join(distDir, "proxy-server.meta.json"));
  process.stdout.write(`Node proxy bundle: ${relative(rootDir, join(distDir, "proxy-server.mjs"))}\n`);
} finally {
  await rm(tempDir, {recursive: true, force: true});
}

async function runTypecheck() {
  const tsc = join(rootDir, "node_modules", "typescript", "bin", "tsc");
  const result = await run(process.execPath, [tsc, "-p", "tsconfig.proxy.json", "--noEmit"], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.code !== 0 || result.signal) {
    throw new Error(`代理 TypeScript 检查失败 (${result.signal || result.code})`);
  }
}

function verifyDependencyClosure(metadata) {
  const forbiddenBundleInputs = [
    "node_modules",
    "next",
    "react",
    "node:sqlite",
    "sqlite",
    "stream-json",
    "worker",
    "terminal",
    "credential",
    "src/lib/harness",
    "src/lib/ingestion",
    "export-content-events",
    "raw-stream-gateway",
    "app/api/export/content",
    "src/store.ts",
  ];
  const banned = new RegExp(forbiddenBundleInputs.map(escapeRegExp).join("|"), "iu");
  const invalidInput = Object.keys(metadata.inputs).find(input => banned.test(input));
  if (invalidInput) throw new Error(`代理 bundle 包含禁止依赖: ${invalidInput}`);
  for (const output of Object.values(metadata.outputs)) {
    for (const imported of output.imports || []) {
      if (!imported.path.startsWith("node:")) {
        throw new Error(`代理 bundle 存在非 Node 外部依赖: ${imported.path}`);
      }
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function smokeBundle(bundlePath) {
  const smokeRoot = await mkdtemp(join(tmpdir(), "deepaa-proxy-build-"));
  const child = spawn(process.execPath, [bundlePath], {
    cwd: smokeRoot,
    env: {
      ...process.env,
      DEEPAA_DATA_DIR: join(smokeRoot, "data"),
      PROXY_HOST: "127.0.0.1",
      PROXY_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await new Promise((resolvePromise, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error(`代理构建 smoke 超时: ${stderr}`)), 5_000);
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        const ready = stdout.split("\n").some(line => {
          try {
            return JSON.parse(line).event === "proxy-ready";
          } catch {
            return false;
          }
        });
        if (ready) {
          clearTimeout(timer);
          resolvePromise();
        }
      });
      child.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`代理构建 smoke 提前退出 (${code}): ${stderr}`));
      });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolvePromise => child.once("exit", resolvePromise)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("代理构建 smoke 未退出")), 5_000)),
      ]);
    }
    await rm(smokeRoot, {recursive: true, force: true});
  }
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({code: code ?? 1, signal}));
  });
}
