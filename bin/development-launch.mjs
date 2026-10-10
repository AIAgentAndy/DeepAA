#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const PLAN_FILE_NAME = "terminal-launch.json";
const RUNTIME_DIRECTORY_PATTERN = /^launch_terminal_[a-f0-9]{32}$/u;
// 只有 codex/claude 走「一次性私有启动计划」通道（macOS Terminal.app 超长命令场景）；
// opencode/dsh/zcode 由 web 服务其它启动通道直接拉起，不经过本脚本。
const ALLOWED_EXECUTABLES = new Set(["codex", "claude"]);
const PLAN_KEYS = ["args", "environment", "executablePath", "projectDir", "version"];
const MAX_PATH_LENGTH = 4096;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 16 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 32;

export const MAX_LAUNCH_PLAN_BYTES = 64 * 1024;

/**
 * 计划只能从专用临时根领取；读取后先删除工件，避免 CLI 生命周期延长落盘时间。
 */
export async function claimDevelopmentLaunchPlan(planPath, options = {}) {
  const tempRoot = options.tempRoot || join(tmpdir(), "deepaa-launch");
  const runtimeDirectory = validatePlanLocation(planPath, tempRoot);
  await assertPrivateRuntimeDirectory(runtimeDirectory, tempRoot);
  let handle;
  try {
    handle = await open(
      planPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
  } catch {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }

  let plan;
  try {
    const metadata = await handle.stat();
    assertPrivateRegularFile(metadata);
    if (metadata.size > MAX_LAUNCH_PLAN_BYTES) {
      throw new Error("DEVELOPMENT_LAUNCH_PLAN_TOO_LARGE");
    }
    const buffer = Buffer.alloc(MAX_LAUNCH_PLAN_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LAUNCH_PLAN_BYTES) {
      throw new Error("DEVELOPMENT_LAUNCH_PLAN_TOO_LARGE");
    }
    let value;
    try {
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
    }
    plan = validateLaunchPlan(value);
  } finally {
    await handle.close().catch(() => undefined);
  }

  try {
    await unlink(planPath);
    await rmdir(runtimeDirectory);
  } catch {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_CLEANUP_FAILED");
  }
  return plan;
}

export async function runDevelopmentLaunchFromPlan(planPath, options = {}) {
  const plan = await claimDevelopmentLaunchPlan(planPath, options);
  const spawnProcess = options.spawnProcess || spawn;
  let child;
  try {
    child = spawnProcess(plan.executablePath, plan.args, {
      cwd: plan.projectDir,
      env: { ...process.env, ...plan.environment },
      stdio: "inherit",
      windowsHide: false,
    });
  } catch {
    throw new Error("DEVELOPMENT_LAUNCH_PROCESS_FAILED");
  }

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once("error", () => {
      finish(() => reject(new Error("DEVELOPMENT_LAUNCH_PROCESS_FAILED")));
    });
    child.once("close", code => {
      finish(() => resolvePromise(code ?? 1));
    });
  });
}

function validatePlanLocation(planPath, tempRoot) {
  if (
    typeof planPath !== "string"
    || !isAbsolute(planPath)
    || basename(planPath) !== PLAN_FILE_NAME
  ) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  const resolvedRoot = resolve(tempRoot);
  const resolvedPlan = resolve(planPath);
  const runtimeDirectory = dirname(resolvedPlan);
  if (
    dirname(runtimeDirectory) !== resolvedRoot
    || !RUNTIME_DIRECTORY_PATTERN.test(basename(runtimeDirectory))
  ) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  return runtimeDirectory;
}

async function assertPrivateRuntimeDirectory(runtimeDirectory, tempRoot) {
  let metadata;
  let actualRoot;
  let actualRuntime;
  try {
    [metadata, actualRoot, actualRuntime] = await Promise.all([
      lstat(runtimeDirectory),
      realpath(tempRoot),
      realpath(runtimeDirectory),
    ]);
  } catch {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (POSIX_MODE_BITS_ENFORCED && (metadata.mode & 0o077) !== 0)
    || dirname(actualRuntime) !== actualRoot
    || !ownedByCurrentUser(metadata)
  ) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_NOT_PRIVATE");
  }
}

// Windows 的 fs.stat().mode 是合成值（可写恒 0o666、只读 0o444），表达不了
// POSIX group/other 权限位；等价隔离由用户临时目录 ACL 承担（与
// tests/helpers/posix-permissions.ts 同口径）。生产上该启动计划路径只属于
// macOS Terminal.app 超长命令场景（Windows 不进入），跳过仅使库级校验在
// Windows 宿主可测；目录/符号链接/属主/父目录约束全部保留。
const POSIX_MODE_BITS_ENFORCED = process.platform !== "win32";

function assertPrivateRegularFile(metadata) {
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  if (
    (POSIX_MODE_BITS_ENFORCED && (metadata.mode & 0o077) !== 0)
    || !ownedByCurrentUser(metadata)
  ) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_NOT_PRIVATE");
  }
}

function ownedByCurrentUser(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

function validateLaunchPlan(value) {
  if (!isPlainRecord(value) || value.version !== 1) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== PLAN_KEYS.length || keys.some((key, index) => key !== PLAN_KEYS[index])) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  const projectDir = validateAbsolutePath(value.projectDir);
  const executablePath = validateAbsolutePath(value.executablePath);
  if (!ALLOWED_EXECUTABLES.has(basename(executablePath))) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  if (!Array.isArray(value.args) || value.args.length > MAX_ARGUMENTS) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  const args = value.args.map(argument => validateString(argument, MAX_ARGUMENT_LENGTH));
  if (
    !isPlainRecord(value.environment)
    || Object.keys(value.environment).length > MAX_ENVIRONMENT_ENTRIES
  ) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  const environment = {};
  for (const [key, rawValue] of Object.entries(value.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
    }
    environment[key] = validateString(rawValue, MAX_ARGUMENT_LENGTH);
  }
  return { version: 1, projectDir, executablePath, args, environment };
}

function validateAbsolutePath(value) {
  const path = validateString(value, MAX_PATH_LENGTH);
  if (!isAbsolute(path)) throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  return path;
}

function validateString(value, maxLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function main() {
  const [planPath, ...extraArguments] = process.argv.slice(2);
  if (!planPath || extraArguments.length > 0) {
    throw new Error("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  }
  process.exitCode = await runDevelopmentLaunchFromPlan(planPath);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  main().catch(() => {
    process.stderr.write("DEVELOPMENT_LAUNCH_FAILED\n");
    process.exitCode = 1;
  });
}
