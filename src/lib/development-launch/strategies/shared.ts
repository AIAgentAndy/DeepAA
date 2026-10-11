import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import {parse as parseToml} from "smol-toml";
import { buildGatewayModelId, parseGatewayModelId } from "@/proxy/gateway-prefix";
import { backupFile } from "@/lib/config-sync/sync-manager";
import type {ConfigSyncReport} from "@/lib/config-sync/sync-manager";
import {readOptionalBounded} from "@/lib/config-sync/core/file-io";
import {GATEWAY_PLACEHOLDER_TOKEN} from "@/lib/config-sync/core/placeholder-auth";
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
  // 写入前可加载性自校验（2026-10-11）：绝不落盘 codex 无法加载的配置——
  // codex 对 config.toml 的加载是整体反序列化，任何非法键都会让客户端与 CLI
  // 全量回退默认配置（网关 provider 等于没写），代价远高于放弃本次写入。
  try {
    parseCodexConfigLoadable(next);
  } catch {
    throw new Error("CODEX_CONFIG_WRITE_INVALID");
  }
  await backupFile(configPath);
  await mkdir(join(configPath, ".."), {recursive: true});
  await writeFile(configPath, next, {encoding: "utf8", mode: 0o600});
}

/**
 * 替换 TOML 顶层键值（保留注释与其它内容）。顶层区 = 首个 [section] 头之前：
 * section 内同名键（如 [profiles.work] 的 model）绝不匹配；键不存在时插入
 * 顶层区末尾，绝不追加文件末尾——文件末尾处于最后一个 section 内，追加即
 * 非法 TOML（2026-10-11 Windows 事故：sandbox_mode 落入 [profiles] 使 codex
 * 整份配置反序列化失败、网关配置与用户设置全部失效）。
 */
export function setTomlTopLevelValue(toml: string, key: string, value: string): string {
  const lines = toml.split("\n");
  const existingKey = new RegExp(`^${key}\\s*=`);
  let sectionHeaderIndex = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) {
      sectionHeaderIndex = index;
      break;
    }
    if (existingKey.test(line)) {
      lines[index] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }
  // 插入点：顶层区内最后一个非空行之后；全 section 文件（无顶层区）插到文件最前。
  let insertion = sectionHeaderIndex;
  while (insertion > 0 && lines[insertion - 1].trim() === "") insertion--;
  lines.splice(insertion, 0, `${key} = ${value}`);
  return lines.join("\n");
}

/**
 * codex 侧配置可加载性校验：smol-toml 只保证通用 TOML 语法，codex 的 serde
 * 反序列化还有结构约束——已知致命形态是 struct 段内出现标量键（2026-10-11
 * 事故：[profiles] 下的 sandbox_mode 字符串让语法合法的文件整体加载失败、
 * 全量回退默认配置）。按已知风险面校验（profiles / model_providers 必须是
 * 表套表），不追求完整复刻 codex schema；抛错即视为不可加载。
 */
export function parseCodexConfigLoadable(raw: string): Record<string, unknown> {
  const parsed = parseToml(raw) as Record<string, unknown>;
  for (const sectionKey of ["profiles", "model_providers"]) {
    const value = parsed[sectionKey];
    if (value === undefined) continue;
    assertTableOfTables(sectionKey, value);
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      assertTableOfTables(`${sectionKey}.${childKey}`, child);
    }
  }
  return parsed;
}

function assertTableOfTables(label: string, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`CODEX_CONFIG_STRUCTURE_INVALID: ${label}`);
  }
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ———————————————— Codex config.toml 健康自愈（2026-10-11） ————————————————

/**
 * 启动链路前的 Codex 配置健康检查：config.toml 解析失败时从 deepaa 滚动备份
 * （config.toml_bk_*）恢复最近一份可解析版本，坏文件先另存 *_invalid_* 留证。
 * 背景：codex 对 config.toml 是整体反序列化，任何非法键都让客户端与 CLI 全量
 * 回退默认配置，且 config-sync 的结构化合并也依赖 parse——坏文件会让受管同步
 * 持续抛错，DeepAA 自身无法修复，死锁在坏状态。返回恢复提示供弹窗透出；
 * 无可解析备份时文件保持原样并返回不可恢复提示。
 */
export async function ensureCodexConfigParsable(homeDir: string): Promise<CliSyncWarning | undefined> {
  const configPath = join(homeDir, ".codex", "config.toml");
  const raw = await readOptionalBounded(configPath);
  if (raw === undefined) return undefined;
  try {
    parseCodexConfigLoadable(raw);
    return undefined;
  } catch {
    // 不可加载（语法或结构）→ 尝试从备份恢复。
  }
  const backupDir = join(homeDir, ".codex", "deepaa");
  let candidates: string[] = [];
  try {
    candidates = (await readdir(backupDir))
      .filter(name => /^config\.toml_bk_/.test(name))
      .sort()
      .reverse();
  } catch {
    // 备份目录不存在 → 无备份可恢复。
  }
  for (const name of candidates) {
    const backupRaw = await readOptionalBounded(join(backupDir, name));
    if (backupRaw === undefined) continue;
    try {
      parseCodexConfigLoadable(backupRaw);
    } catch {
      continue;
    }
    await writeFile(join(backupDir, `config.toml_invalid_${backupStamp()}`), raw, {mode: 0o600});
    await writeFile(configPath, backupRaw, {encoding: "utf8", mode: 0o600});
    return {
      targetId: "",
      code: "CODEX_CONFIG_RESTORED_FROM_BACKUP",
      message: "检测到 ~/.codex/config.toml 已损坏，已自动恢复最近一次 DeepAA 备份（原文件另存于 ~/.codex/deepaa 留证）",
    };
  }
  return {
    targetId: "",
    code: "CODEX_CONFIG_CORRUPT_UNRECOVERABLE",
    message: "~/.codex/config.toml 已损坏且无可用备份，Codex 将回退默认配置，请手动修复后重试",
  };
}

function backupStamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

// ———————————————— Codex 客户端占位登录（2026-10-11 用户确认） ————————————————

/**
 * Codex 桌面客户端的登录门只检查 ~/.codex/auth.json 是否存在、不校验内容
 * （实测任意值即可进入）；网关模式下模型流量走 model_providers.deepaa_gateway
 * 的占位 bearer token，auth.json 里的 key 永不被使用、不出本机。因此网关形态
 * 客户端启动时预填占位登录，用户免 ChatGPT 登录直进。仅在文件缺失时写入
 * （真实 ChatGPT 登录或用户自有 key 绝不覆盖）；config.toml 显式配置
 * cli_auth_credentials_store = "keyring" 时凭据走系统钥匙串、占位文件不会被
 * 读取，跳过写入。返回是否写入了占位。
 */
export async function ensureCodexGatewayPlaceholderAuth(homeDir: string): Promise<boolean> {
  const authPath = join(homeDir, ".codex", "auth.json");
  const existing = await readOptionalBounded(authPath);
  if (existing !== undefined) return false;
  const configRaw = await readOptionalBounded(join(homeDir, ".codex", "config.toml"));
  if (configRaw !== undefined) {
    try {
      const config = parseToml(configRaw) as Record<string, unknown>;
      if (config.cli_auth_credentials_store === "keyring") return false;
    } catch {
      // 配置解析失败不阻断：占位文件存在与否对该形态无影响。
    }
  }
  const content = `${JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: GATEWAY_PLACEHOLDER_TOKEN,
  }, null, 2)}\n`;
  await mkdir(join(authPath, ".."), {recursive: true});
  await writeFile(authPath, content, {encoding: "utf8", mode: 0o600});
  return true;
}

/**
 * 切回官方模式时清理自己的占位登录：仅当 auth.json 内容仍是本占位（apikey +
 * 占位 key）时删除——官方模式需要真实 ChatGPT 登录，残留占位会让客户端误判
 * 已登录、官方请求全部 401。用户已真实登录（tokens/自有 key）则绝不触碰。
 * 返回是否执行了清理。
 */
export async function removeCodexPlaceholderAuth(homeDir: string): Promise<boolean> {
  const authPath = join(homeDir, ".codex", "auth.json");
  const existing = await readOptionalBounded(authPath);
  if (existing === undefined) return false;
  try {
    const parsed = JSON.parse(existing) as {auth_mode?: unknown; OPENAI_API_KEY?: unknown};
    if (parsed.auth_mode !== "apikey" || parsed.OPENAI_API_KEY !== GATEWAY_PLACEHOLDER_TOKEN) {
      return false;
    }
  } catch {
    return false;
  }
  await unlink(authPath).catch(() => undefined);
  return true;
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
