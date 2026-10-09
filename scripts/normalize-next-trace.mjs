#!/usr/bin/env node

import {randomUUID} from "node:crypto";
import {open, readFile, rename, unlink} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_RELATIVE_PATH = "data/defaults/litellm-model-prices.snapshot.json";
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

/**
 * Next 16 不会把 outputFileTracingExcludes 应用到 instrumentation 清单。
 * 这里只清理已知的项目运行时状态和源码引用，依赖、原生模块与构建 chunk 原样保留。
 */
export async function normalizeNextTrace(rootDir = SCRIPT_ROOT) {
  const root = resolve(rootDir);
  const snapshotPath = join(root, SNAPSHOT_RELATIVE_PATH);
  let removedCount = 0;

  for (const target of TRACE_TARGETS) {
    const manifestPath = join(root, target.relativePath);
    const manifest = await readTraceManifest(manifestPath, target.label);
    const manifestDir = dirname(manifestPath);
    const files = manifest.files.filter(file => {
      const resolvedPath = resolve(manifestDir, file);
      const shouldRemove = isRemovableProjectPath(root, snapshotPath, resolvedPath);
      if (shouldRemove) removedCount += 1;
      return !shouldRemove;
    });
    if (files.length !== manifest.files.length) {
      await writeManifestAtomically(manifestPath, {...manifest, files});
    }
  }

  return {removedCount};
}

async function readTraceManifest(manifestPath, label) {
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
  return parsed;
}

function isRemovableProjectPath(root, snapshotPath, path) {
  if (path === snapshotPath) return false;
  return path === join(root, "next.config.ts")
    || isWithin(join(root, "data"), path)
    || isWithin(join(root, "src"), path)
    || isWithin(join(root, "tests"), path);
}

function isWithin(parent, child) {
  const childRelative = relative(parent, child);
  return childRelative !== ""
    && childRelative !== ".."
    && !childRelative.startsWith(`..${sep}`)
    && !isAbsolute(childRelative);
}

async function writeManifestAtomically(manifestPath, manifest) {
  const temporaryPath = join(
    dirname(manifestPath),
    `.${manifestPath.split(sep).at(-1)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(JSON.stringify(manifest), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseRootArgument(args) {
  if (args.length === 0) return SCRIPT_ROOT;
  if (args.length === 2 && args[0] === "--root" && args[1]) return resolve(args[1]);
  throw new Error("用法: normalize-next-trace.mjs [--root <项目目录>]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await normalizeNextTrace(parseRootArgument(process.argv.slice(2)));
    process.stdout.write(`Next trace normalization completed: removed ${result.removedCount} files.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
