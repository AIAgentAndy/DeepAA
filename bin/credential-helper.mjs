#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// 钥匙串服务名（2026-10-05 用户确认）：dev.deepaa = 域名 deepaa.dev 的 reverse-DNS，
// 本地可见标识去个人化。存量 com.aiagentandy.deepaa 条目已于 2026-10-05 通过
// 一次性脚本完成迁移（脚本用后即删，迁移逻辑不进运行时代码）。
const SERVICE_NAME = "dev.deepaa";
const WINDOWS_TARGET_PREFIX = "DeepAA:";
const OPERATIONS = new Set(["check", "put", "get", "delete", "exists"]);
const MAX_METADATA_BYTES = 1024 * 1024;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60_000;

export function validateCredentialId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("INVALID_CREDENTIAL_ID");
  }
  return value;
}

export function buildMacCredentialCommand(
  operation,
  credentialId,
  label = credentialId,
  scriptPath = join(dirname(fileURLToPath(import.meta.url)), "macos-keychain-write.exp"),
) {
  const id = validateCredentialId(credentialId);
  if (operation === "put") {
    return {
      command: "/usr/bin/expect",
      args: ["-f", scriptPath, id, label, SERVICE_NAME],
    };
  }
  if (operation === "get") {
    return {
      command: "/usr/bin/security",
      args: ["find-generic-password", "-a", id, "-s", SERVICE_NAME, "-w"],
    };
  }
  if (operation === "exists") {
    return {
      command: "/usr/bin/security",
      args: ["find-generic-password", "-a", id, "-s", SERVICE_NAME],
    };
  }
  if (operation === "delete") {
    return {
      command: "/usr/bin/security",
      args: ["delete-generic-password", "-a", id, "-s", SERVICE_NAME],
    };
  }
  throw new Error("INVALID_CREDENTIAL_OPERATION");
}

export function buildWindowsCredentialCommand(operation, credentialId, label, scriptPath) {
  const id = validateCredentialId(credentialId);
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    command,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-Operation",
      operation,
      "-TargetName",
      `${WINDOWS_TARGET_PREFIX}${id}`,
      "-UserName",
      label || id,
    ],
  };
}

/** OAuth access token 到期前 5 分钟即视为不可用，避免代理缓存跨过真实过期点。 */
export function resolveCredentialAccess(metadata, now = Date.now()) {
  if (!metadata || metadata.kind !== "oauth") {
    return {credentialId: metadata?.id, kind: "api_key"};
  }
  const expiresAt = Date.parse(metadata.oauth?.expiresAt || "");
  const accessTokenCredentialId = metadata.oauth?.accessTokenCredentialId;
  if (!Number.isFinite(expiresAt) || typeof accessTokenCredentialId !== "string") {
    throw new Error("CREDENTIAL_OAUTH_METADATA_INVALID");
  }
  if (expiresAt <= now + OAUTH_EXPIRY_SKEW_MS) throw new Error("CREDENTIAL_OAUTH_EXPIRED");
  return {credentialId: validateCredentialId(accessTokenCredentialId), kind: "oauth"};
}

async function main() {
  const [operation, rawId, label] = process.argv.slice(2);
  if (!OPERATIONS.has(operation)) throw new Error("INVALID_CREDENTIAL_OPERATION");
  if (operation === "check") {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      throw new Error("UNSUPPORTED_PLATFORM");
    }
    return;
  }

  const id = validateCredentialId(rawId);
  const secret = operation === "put" ? await readStdinSecret() : undefined;
  const access = operation === "get" || operation === "exists"
    ? resolveCredentialAccess(await readCredentialMetadata(id), Date.now())
    : {credentialId: id, kind: "api_key"};
  const storedId = access.credentialId || id;
  const command = process.platform === "darwin"
    ? buildMacCredentialCommand(operation, storedId, label || id)
      : process.platform === "win32"
      ? buildWindowsCredentialCommand(
        operation,
        storedId,
        label || id,
        join(dirname(fileURLToPath(import.meta.url)), "windows-credential.ps1"),
      )
      : undefined;
  if (!command) throw new Error("UNSUPPORTED_PLATFORM");
  if (operation === "exists") {
    const result = await run(command.command, command.args, undefined, {discardStdout: true});
    process.exitCode = result.exitCode === 0 ? 0 : 1;
    return;
  }

  const result = await run(command.command, command.args, secret);
  if (result.exitCode !== 0) throw new Error(`CREDENTIAL_${operation.toUpperCase()}_FAILED`);
  if (operation === "get") {
    const value = result.stdout.replace(/[\r\n]+$/, "");
    if (!value) throw new Error("CREDENTIAL_READ_FAILED");
    process.stdout.write(`${value}\n`);
  }
}

async function readCredentialMetadata(credentialId) {
  const dataDir = process.env.DEEPAA_DATA_DIR || join(homedir(), ".deepaa");
  const path = join(dataDir, "config", "development-credentials.json");
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_METADATA_BYTES) return undefined;
    const raw = await readFile(path);
    if (raw.byteLength > MAX_METADATA_BYTES) return undefined;
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || !Array.isArray(parsed.credentials)) return undefined;
    return parsed.credentials.find(item => item && item.id === credentialId);
  } catch {
    return undefined;
  }
}

async function readStdinSecret() {
  let value = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) value += chunk;
  value = value.replace(/[\r\n]+$/, "");
  if (!value) throw new Error("CREDENTIAL_SECRET_REQUIRED");
  return value;
}

async function run(command, args, stdin, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", options.discardStdout ? "ignore" : "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    if (!options.discardStdout) {
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", chunk => { stdout += chunk; });
    }
    child.stderr.resume();
    // stdin EPIPE（子进程提前退出后写入）无监听即未捕获异常；吞掉流错误，
    // 失败仍以 close 退出码上报（Windows 2026-10-09 实测事故加固）。
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", code => resolvePromise({ stdout, exitCode: code ?? 1 }));
    if (stdin !== undefined) child.stdin.end(`${stdin}\n`);
    else child.stdin.end();
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "CREDENTIAL_HELPER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
