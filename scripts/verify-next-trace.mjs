#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_RELATIVE_PATH = "data/defaults/litellm-model-prices.snapshot.json";
const MAX_TRACED_SOURCE_FILES = 64;
const TRACE_TARGETS = [
  {
    label: "价格导入 Route",
    relativePath: ".next/server/app/api/model-pricing/import/route.js.nft.json",
  },
  {
    label: "instrumentation",
    relativePath: ".next/server/instrumentation.js.nft.json",
  },
];

export async function verifyNextTrace(rootDir = SCRIPT_ROOT) {
  const root = resolve(rootDir);
  const snapshotPath = join(root, SNAPSHOT_RELATIVE_PATH);
  const violations = [];

  for (const target of TRACE_TARGETS) {
    const manifestPath = join(root, target.relativePath);
    const files = await readManifestFiles(manifestPath, target.label);
    const resolvedFiles = files.map(path => resolve(dirname(manifestPath), path));
    if (!resolvedFiles.includes(snapshotPath)) {
      violations.push(`${target.label}: 缺少 ${SNAPSHOT_RELATIVE_PATH}`);
    }

    const tracedSourceFiles = resolvedFiles.filter(path => isWithin(join(root, "src"), path));
    if (tracedSourceFiles.length > MAX_TRACED_SOURCE_FILES) {
      violations.push(
        `${target.label}: 意外追踪 ${tracedSourceFiles.length} 个 src 文件，疑似纳入整个源码目录`,
      );
    }

    for (const path of resolvedFiles) {
      const displayPath = toDisplayPath(root, path);
      if (path === join(root, "next.config.ts")) {
        violations.push(`${target.label}: 意外追踪 ${displayPath}`);
      } else if (isWithin(join(root, "data"), path) && path !== snapshotPath) {
        violations.push(`${target.label}: 意外追踪业务数据 ${displayPath}`);
      } else if (isWithin(join(root, "tests"), path)) {
        violations.push(`${target.label}: 意外追踪测试文件 ${displayPath}`);
      } else if (
        isWithin(join(root, "src", "app", "api"), path)
        && path !== join(root, "src", "app", "api", "model-pricing", "import", "route.ts")
      ) {
        violations.push(`${target.label}: 意外追踪无关 API ${displayPath}`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`Next trace verification failed:\n${violations.map(item => `- ${item}`).join("\n")}`);
  }
}

async function readManifestFiles(manifestPath, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: 无法读取 NFT 清单 ${manifestPath}: ${message}`);
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || !Array.isArray(parsed.files)
    || parsed.files.some(path => typeof path !== "string" || isAbsolute(path))
  ) {
    throw new Error(`${label}: NFT 清单 files 必须是相对路径字符串数组`);
  }
  return parsed.files;
}

function isWithin(parent, child) {
  const childRelative = relative(parent, child);
  return childRelative !== ""
    && childRelative !== ".."
    && !childRelative.startsWith(`..${sep}`)
    && !isAbsolute(childRelative);
}

function toDisplayPath(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative)
    ? pathRelative.split(sep).join("/")
    : path;
}

function parseRootArgument(args) {
  if (args.length === 0) return SCRIPT_ROOT;
  if (args.length === 2 && args[0] === "--root" && args[1]) return resolve(args[1]);
  throw new Error("用法: verify-next-trace.mjs [--root <项目目录>]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyNextTrace(parseRootArgument(process.argv.slice(2)));
    process.stdout.write("Next trace verification passed.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
