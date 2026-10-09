import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { buildGatewayModelId, parseGatewayModelId } from "@/proxy/gateway-prefix";
import { backupFile } from "@/lib/config-sync/sync-manager";
import type {ConfigSyncReport} from "@/lib/config-sync/sync-manager";
import type {CliSyncWarning} from "@/lib/config-sync/core/types";
import type { AgentId, AgentLaunchPreferences, ProxyConfig, ProxyTarget } from "@/types";
import type { DevelopmentManualOverrides } from "../launch-plan";
import type { LaunchConfigurationResolution } from "../types";
import {
  resolveClaudeConfiguration,
  resolveCodexConfiguration,
  resolveDshConfiguration,
  resolveOpenCodeConfiguration,
  resolveZcodeConfiguration,
} from "../config-resolver";

/**
 * Agent 启动策略共享层（docs/上线前架构升级改造.md §10.2）：
 * 纯校验/构造助手与三类标准执行路径。全部函数无状态、可注入依赖，
 * 各 Agent 策略文件与 launch-plan 共同复用，杜绝策略间复制。
 */

// ———————————————— 纯校验助手（launch-plan 同款语义） ————————————————

export function validateIdentifier(value: string, code: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(code);
  return value;
}

export function validateText(value: string, code: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

export function validateLocalBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("INVALID_LOCAL_BASE_URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("INVALID_LOCAL_BASE_URL");
  }
  return parsed.toString().replace(/\/$/, "");
}

// ———————————————— 启动偏好归一化 ————————————————

/** dsh 推理档位与权限预设值域。 */
const DSH_REASONING_LEVELS = new Set(["off", "low", "high", "max"]);
const DSH_PERMISSION_PRESETS = new Set(["read-only", "workspace-write", "danger-full-access"]);
const REASONING_EFFORT_PATTERN = /^[a-z0-9_-]{1,32}$/u;

/** 通用偏好归一化：只保留消费字段并按通用值域校验；全空返回 undefined。 */
export function genericPreferencesNormalizer(
  value: AgentLaunchPreferences | undefined,
): AgentLaunchPreferences | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result: AgentLaunchPreferences = {};
  if (value.reasoningEffort !== undefined) {
    if (typeof value.reasoningEffort !== "string") throw new Error("INVALID_LAUNCH_PREFERENCE");
    const effort = value.reasoningEffort.trim();
    if (effort && REASONING_EFFORT_PATTERN.test(effort)) {
      result.reasoningEffort = effort;
    } else if (effort) {
      throw new Error("INVALID_LAUNCH_PREFERENCE");
    }
  }
  if (value.permissionMode !== undefined) throw new Error("INVALID_LAUNCH_PREFERENCE");
  if (value.contextWindows !== undefined) {
    const windows = normalizeTokenLimitRecord(value.contextWindows);
    if (windows) result.contextWindows = windows;
  }
  if (value.autoCompactTokenLimits !== undefined) {
    const limits = normalizeTokenLimitRecord(value.autoCompactTokenLimits);
    if (limits) result.autoCompactTokenLimits = limits;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** dsh 专属偏好归一化：推理档位与权限预设均为固定值域。 */
export function dshPreferencesNormalizer(
  value: AgentLaunchPreferences | undefined,
): AgentLaunchPreferences | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result: AgentLaunchPreferences = {};
  if (value.reasoningEffort !== undefined) {
    if (typeof value.reasoningEffort !== "string") throw new Error("INVALID_LAUNCH_PREFERENCE");
    const effort = value.reasoningEffort.trim();
    if (effort && !DSH_REASONING_LEVELS.has(effort)) throw new Error("INVALID_LAUNCH_PREFERENCE");
    if (effort) result.reasoningEffort = effort;
  }
  if (value.permissionMode !== undefined) {
    if (typeof value.permissionMode !== "string" || !DSH_PERMISSION_PRESETS.has(value.permissionMode)) {
      throw new Error("INVALID_LAUNCH_PREFERENCE");
    }
    result.permissionMode = value.permissionMode;
  }
  if (value.contextWindows !== undefined) {
    const windows = normalizeTokenLimitRecord(value.contextWindows);
    if (windows) result.contextWindows = windows;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 偏好相等性比较（纯函数）：服务端据此判断「本次启动是否真的改了受管配置」，
 * 只对 dsh/zcode 这类常驻进程的「需重启生效」提示开放，避免误打扰。
 */
export function sameLaunchPreferences(
  left: AgentLaunchPreferences | null | undefined,
  right: AgentLaunchPreferences | null | undefined,
): boolean {
  const pick = (value: AgentLaunchPreferences | null | undefined) => ({
    reasoningEffort: value?.reasoningEffort ?? null,
    permissionMode: value?.permissionMode ?? null,
    contextWindows: value?.contextWindows ?? null,
    autoCompactTokenLimits: value?.autoCompactTokenLimits ?? null,
  });
  const a = pick(left);
  const b = pick(right);
  return a.reasoningEffort === b.reasoningEffort
    && a.permissionMode === b.permissionMode
    && sameRecord(a.contextWindows, b.contextWindows)
    && sameRecord(a.autoCompactTokenLimits, b.autoCompactTokenLimits);
}

function sameRecord(
  left: Record<string, number> | null,
  right: Record<string, number> | null,
): boolean {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left?.[key] !== right?.[key]) return false;
  }
  return true;
}

function normalizeTokenLimitRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_LAUNCH_PREFERENCE");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error("INVALID_LAUNCH_PREFERENCE");
  const result: Record<string, number> = {};
  for (const [modelId, tokens] of entries) {
    // 键为网关模型 ID（<模型ID>_<目标路由ID>），下划线为分隔符必含。
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(modelId)) throw new Error("INVALID_LAUNCH_PREFERENCE");
    // 必须能按「最后一个下划线」切出合法复合键：裸模型 ID 属旧格式，拒绝落库
    //（proxy-config 读取侧会静默丢弃同类死键，这里在写入前就拦住）。
    if (!parseGatewayModelId(modelId)) throw new Error("INVALID_LAUNCH_PREFERENCE");
    if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new Error("INVALID_LAUNCH_PREFERENCE");
    }
    result[modelId] = tokens;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ———————————————— 配置解析委托（config-resolver 既有实现） ————————————————

export function resolveCodexConfig(input: {homeDir: string; projectDir?: string; profile?: string}): Promise<LaunchConfigurationResolution> {
  return resolveCodexConfiguration(input);
}

export function resolveClaudeConfig(input: {homeDir: string; projectDir?: string}): Promise<LaunchConfigurationResolution> {
  return resolveClaudeConfiguration(input);
}

export function resolveOpenCodeConfig(input: {homeDir: string; projectDir?: string}): Promise<LaunchConfigurationResolution> {
  return resolveOpenCodeConfiguration(input);
}

export function resolveDshConfig(input: {homeDir: string}): Promise<LaunchConfigurationResolution> {
  return resolveDshConfiguration(input);
}

export function resolveZcodeConfig(input: {homeDir: string}): Promise<LaunchConfigurationResolution> {
  return resolveZcodeConfiguration(input);
}

// ———————————————— Codex 桌面客户端默认模型写入 ————————————————

const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;

/**
 * 把供应商网关模型与本次选择的高级设置写入 ~/.codex/config.toml 顶层默认值，
 * 供 Codex 桌面客户端启动时读取（客户端不消费 CLI 的 -c 参数）。
 * 写入前按项目统一规则备份；只替换顶层对应键，保留注释与其它配置不变。
 */
export async function writeCodexDefaultModel(
  homeDir: string,
  target: ProxyTarget,
  model: string,
  overrides: DevelopmentManualOverrides,
): Promise<void> {
  const configPath = join(homeDir, ".codex", "config.toml");
  let existing: string | undefined;
  try {
    const raw = await readFile(configPath);
    if (raw.byteLength > MAX_CODEX_CONFIG_BYTES) throw new Error("CODEX_CONFIG_TOO_LARGE");
    existing = raw.toString("utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const gatewayModel = buildGatewayModelId(target.id, model);
  let next: string;
  if (existing === undefined || existing.trim() === "") {
    next = `model = "${gatewayModel}"\nmodel_provider = "deepaa_gateway"\n`;
  } else {
    next = setTomlTopLevelValue(existing, "model_provider", tomlString("deepaa_gateway"));
    next = setTomlTopLevelValue(next, "model", tomlString(gatewayModel));
  }
  // 上下文窗口/压缩阈值/推理档走模型目录条目（launchPreferences → config-sync），
  // 此处只写 Codex 顶层确实消费的键；sandbox 无目录对应字段，仍写 config.toml。
  if (overrides.sandboxMode) {
    next = setTomlTopLevelValue(next, "sandbox_mode", tomlString(overrides.sandboxMode));
  }
  // 无差异不写：默认模型未变时不刷新 mtime，也不产生备份噪音。
  if (next === (existing ?? "")) return;
  await backupFile(configPath);
  await mkdir(join(configPath, ".."), {recursive: true});
  await writeFile(configPath, next, {encoding: "utf8", mode: 0o600});
}

/** 替换 TOML 顶层键值（保留注释与其它内容）；不存在时在文件末尾追加。 */
function setTomlTopLevelValue(toml: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}\\s*=\\s*[^\\n]*$`, "mu");
  if (pattern.test(toml)) {
    return toml.replace(pattern, `${key} = ${value}`);
  }
  const trimmed = toml.trimEnd();
  return `${trimmed}${trimmed ? "\n" : ""}${key} = ${value}\n`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ———————————————— 启动执行助手（三类标准路径） ————————————————

/**
 * 启动前受管配置同步（定向）：重读磁盘配置（避免陈旧内存视图触发 fail-safe 误判）
 * 再只同步本次启动的 Agent（2026-10-06 修复：此前全量同步把其它 Agent 适配器的
 * 内部警告也带进了启动链路）；启动后的默认链持久化仍走全量同步兜底其它 Agent。
 * 返回该 Agent 的 CLI 同步警告（preserve/回退类），供调用方过滤后透出给弹窗；
 * 同步失败仍只记日志不阻断启动，返回空数组。
 */
export async function preSyncManagedConfig(
  configOps: {
    reload(): Promise<void>;
    getConfig(): ProxyConfig;
    syncer(config: ProxyConfig, options?: {agents?: readonly AgentId[]}): Promise<ConfigSyncReport | void>;
  },
  agent: AgentId,
): Promise<CliSyncWarning[]> {
  await configOps.reload().catch(() => undefined);
  try {
    const report = await configOps.syncer(configOps.getConfig(), {agents: [agent]});
    return report?.warnings ?? [];
  } catch (error) {
    console.error("[deepaa] development launch pre-sync failed", error);
    return [];
  }
}

/** 启动 Codex 桌面客户端（codex app [PATH]），携带选填工作区路径；不阻塞当前进程。 */
export function launchCodexClientApp(codexExecutable: string, workspacePath?: string): void {
  const child = spawn(codexExecutable, workspacePath ? ["app", workspacePath] : ["app"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", error => {
    console.error("[deepaa] codex client launch failed", error);
  });
  child.unref();
}

/**
 * 拉起 ZCode 桌面 App：macOS 走 `open -a`，Windows 直接 spawn 安装位置 exe。
 * 携带工作区目录时改走 `zcode://workspace/open` 深链（未运行先启动再打开）。
 */
export function launchZcodeDesktopApp(appPath: string, workspacePath?: string): void {
  const darwin = process.platform === "darwin";
  let child: ReturnType<typeof spawn>;
  if (workspacePath) {
    const url = `zcode://workspace/open?path=${encodeURIComponent(workspacePath)}`;
    child = darwin
      ? spawn("/usr/bin/open", [url], {detached: true, stdio: "ignore"})
      : spawn("cmd.exe", ["/d", "/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
  } else {
    child = darwin
      ? spawn("/usr/bin/open", ["-a", appPath], {detached: true, stdio: "ignore"})
      : spawn(appPath, [], {detached: true, stdio: "ignore"});
  }
  child.on("error", error => {
    console.error("[deepaa] zcode app launch failed", error);
  });
  child.unref();
}

/**
 * 拉起 dsh 桌面客户端（DeepSeek Harness）：macOS `open -a` 对已运行 App 是
 * 激活而非重启；Windows 直接 spawn exe，Electron 单实例锁自带转发与聚焦。
 * 无深链概念（`dsh://open` 仅唤回窗口，等价激活），始终按 App 启动。
 */
export function launchDshDesktopApp(appPath: string): void {
  const child = process.platform === "darwin"
    ? spawn("/usr/bin/open", ["-a", appPath], {detached: true, stdio: "ignore"})
    : spawn(appPath, [], {detached: true, stdio: "ignore"});
  child.on("error", error => {
    console.error("[deepaa] dsh desktop app launch failed", error);
  });
  child.unref();
}

/** 探测本地端口是否已监听（短超时）：用于判断 dsh Web 服务是否已在运行。 */
export function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 200): Promise<boolean> {  return new Promise(resolve => {
    const socket = createConnection({host, port});
    const settled = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settled(true));
    socket.once("timeout", () => settled(false));
    socket.once("error", () => settled(false));
  });
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as {code?: unknown}).code === "ENOENT";
}
