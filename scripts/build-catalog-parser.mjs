#!/usr/bin/env node
/**
 * 构建目录解析 CLI 产物 dist/catalog-parser.mjs（官网编辑/草稿/发布链路的
 * 唯一权威校验器，2026-09-23 架构：官网 spawn 本产物，与仓库路径配置化配套）。
 *
 * 产物要求：零外部依赖（解析器闭包只允许 normalize.ts + types.ts + diagnostics.ts 类型），
 * banner 注入构建标识供官网展示「当前使用的解析器版本」。
 */

import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");
const tempDir = join(rootDir, "dist", `.catalog-parser-build-${randomUUID()}`);
const tempBundle = join(tempDir, "catalog-parser.mjs");

/** 解析器闭包白名单：新增依赖必须同步评估（保持产物零依赖、无 web/Node 重模块）。 */
const ALLOWED_BUNDLE_INPUTS = new Set([
  "scripts/catalog-parse-cli.ts",
  "src/lib/provider-catalog/normalize.ts",
  "src/lib/provider-catalog/types.ts",
  "src/lib/provider-catalog/diagnostics.ts",
  // 契约格式判定（版本/时刻正则）与活动比率 DSL：纯函数，normalize 深校验依赖。
  "src/lib/provider-catalog/catalog-contract.ts",
  "src/lib/provider-catalog/rule-dsl.ts",
]);

try {
  await mkdir(tempDir, {recursive: true});
  const parserBuild = new Date().toISOString();
  const result = await build({
    absWorkingDir: rootDir,
    entryPoints: ["scripts/catalog-parse-cli.ts"],
    outfile: tempBundle,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    banner: {
      js: `globalThis.__CATALOG_PARSER_BUILD__ = ${JSON.stringify(parserBuild)};`,
    },
  });
  verifyDependencyClosure(result.metafile);
  await smokeBundle(tempBundle);

  await mkdir(distDir, {recursive: true});
  await rename(tempBundle, join(distDir, "catalog-parser.mjs"));
  process.stdout.write(`Catalog parser bundle: ${relative(rootDir, join(distDir, "catalog-parser.mjs"))} (build ${parserBuild})\n`);
} finally {
  await rm(tempDir, {recursive: true, force: true});
}

function verifyDependencyClosure(metadata) {
  const invalidInput = Object.keys(metadata.inputs)
    .filter(input => !ALLOWED_BUNDLE_INPUTS.has(input));
  if (invalidInput.length > 0) {
    throw new Error(`解析器 bundle 闭包超出白名单（新增依赖需评估产物边界）: ${invalidInput.join(", ")}`);
  }
  for (const output of Object.values(metadata.outputs)) {
    for (const imported of output.imports || []) {
      if (!imported.path.startsWith("node:")) {
        throw new Error(`解析器 bundle 存在非 Node 外部依赖: ${imported.path}`);
      }
    }
  }
}

/** smoke：用随包源文件喂 stdin，要求解析通过且报告为构建产物形态。 */
async function smokeBundle(bundlePath) {
  const catalogText = await readFile(join(rootDir, "data", "defaults", "llm_catalog.jsonl"), "utf8");
  const child = spawn(process.execPath, [bundlePath, "-"], {stdio: ["pipe", "pipe", "pipe"]});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdin.write(catalogText);
  child.stdin.end();
  const exitCode = await new Promise(resolvePromise => {
    child.once("error", () => resolvePromise(-1));
    child.once("exit", code => resolvePromise(code ?? -1));
  });
  if (exitCode !== 0) {
    throw new Error(`解析器 smoke 失败 (exit ${exitCode}): ${stderr || stdout}`);
  }
  let report;
  try {
    report = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    throw new Error(`解析器 smoke 输出不是 JSON: ${stdout.slice(0, 200)}`);
  }
  if (report.ok !== true || typeof report.providerCount !== "number" || report.parserBuild === "source") {
    throw new Error(`解析器 smoke 报告异常: ${stdout.slice(0, 300)}`);
  }
}
