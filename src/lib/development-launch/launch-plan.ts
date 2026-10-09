import { randomUUID } from "crypto";
import { chmod, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { GATEWAY_PLACEHOLDER_TOKEN } from "@/lib/config-sync/core/placeholder-auth";
import type { SupportedDevelopmentPlatform } from "./types";
import { agentLaunchStrategy } from "./strategies";
import {
  validateIdentifier,
  validateLocalBaseUrl,
  validateText,
} from "./strategies/shared";

export interface DevelopmentManualOverrides {
  /** Codex 沙箱模式（-s / -c sandbox_mode）；能力类参数（上下文窗口/推理档/压缩阈值）
   *  对网关模型由模型目录条目决定，经 launchPreferences 走受管配置，不走 CLI 覆盖。 */
  sandboxMode?: string;
  /** Claude 推理档位（--effort）。 */
  effortLevel?: string;
  /** Claude 权限模式（--permission-mode）。 */
  permissionMode?: string;
  claudeMaxContextTokens?: number;
  /** Claude 自动压缩窗口 token 数（--autocompact）；留空表示 auto。 */
  claudeAutoCompactTokens?: number;
}

export interface DevelopmentLaunchCommandInput {
  launchId?: string;
  cli: import("./types").DevelopmentCli;
  platform: SupportedDevelopmentPlatform;
  targetId: string;
  targetName: string;
  localBaseUrl: string;
  projectDir: string;
  executablePath: string;
  terminal: string;
  credentialId?: string;
  credentialHelperPath: string;
  nodeExecutable: string;
  /** 网关模型 ID；官方直连形态启动（officialFormLaunch）时为 undefined。 */
  resolvedModel?: string;
  resumeSessionId?: string;
  manualOverrides: DevelopmentManualOverrides;
  /** 订阅通道透传：不写入占位 token，由官方 CLI 携带 OAuth；credentialId 可不传。 */
  subscriptionPassthrough?: boolean;
  /**
   * 官方直连形态启动（2026-10-09，仅 codex 声明消费）：命令不注入任何网关
   * provider/模型参数，resolvedModel 可缺省。
   */
  officialFormLaunch?: boolean;
  settingsPath?: string;
  /** OpenCode / dsh 启动形态；缺省 TUI（dsh 固定 web，忽略该值）。 */
  launchMode?: "tui" | "headless" | "web" | "app";
  /** headless 一次性任务内容；仅 OpenCode 使用。 */
  task?: string;
  /** dsh 启动通道（path / npx）；决定 web 启动命令前缀。 */
  dshChannel?: "path" | "npx";
  /** OpenCode 默认 wire API，决定 provider 与模型入口；由 service 按配置解析。 */
  opencodeWireApi?: import("@/types").WireApi;
}

/** 只存在于当前请求内存中；平台适配器用它直接打开真实 CLI。 */
export interface DevelopmentLaunchCommand {
  launchId: string;
  cli: import("./types").DevelopmentCli;
  platform: SupportedDevelopmentPlatform;
  targetId: string;
  projectDir: string;
  executablePath: string;
  terminal: string;
  args: string[];
  environment: Record<string, string>;
}

export interface PreparedDevelopmentLaunch {
  command: DevelopmentLaunchCommand;
  runtimeDirectory?: string;
  settingsPath?: string;
}

/**
 * 命令组装（策略驱动，2026-09-14 策略化一期）：公共校验在此，Agent 专属参数
 * 构造在 strategies/<agent>.ts 的 buildCommandArgs；环境注入 = 策略声明 launchEnv
 * 与 args 构造结果的合并。
 */
export function buildDevelopmentLaunchCommand(
  input: DevelopmentLaunchCommandInput,
): DevelopmentLaunchCommand {
  const launchId = validateIdentifier(
    input.launchId || `launch_${randomUUID().replaceAll("-", "")}`,
    "INVALID_LAUNCH_ID",
  );
  const targetId = validateIdentifier(input.targetId, "INVALID_TARGET_ID");
  if (input.credentialId) validateIdentifier(input.credentialId, "INVALID_CREDENTIAL_ID");
  // 官方直连形态启动无网关模型概念（策略按 officialFormLaunch 分支构造原生命令）。
  if (input.resolvedModel !== undefined) validateText(input.resolvedModel, "MODEL_REQUIRED", 256);
  validateLocalBaseUrl(input.localBaseUrl);
  const projectDir = validateText(input.projectDir, "INVALID_PROJECT_DIR", 4096);
  const executablePath = validateText(input.executablePath, "CLI_NOT_FOUND", 4096);
  const terminal = validateText(input.terminal, "TERMINAL_NOT_FOUND", 128);
  const manualOverrides = normalizeDevelopmentManualOverrides(input.manualOverrides);
  const strategy = agentLaunchStrategy(input.cli);
  const resumeSessionId = strategy.normalizeResumeSessionId(input.resumeSessionId);
  const built = strategy.buildCommandArgs({
    input: {...input, manualOverrides, resumeSessionId},
    targetId,
    resolvedModel: input.resolvedModel,
  });
  return {
    launchId,
    cli: input.cli,
    platform: input.platform,
    targetId,
    projectDir,
    executablePath,
    terminal,
    args: built.args,
    environment: {...strategy.launchEnv, ...built.environment},
  };
}

/** Codex 零落盘；Claude 只写不含密钥的临时 settings（策略声明 requiresTempSettings）。 */
export async function prepareDevelopmentLaunch(options: {
  tempRoot: string;
  input: DevelopmentLaunchCommandInput;
}): Promise<PreparedDevelopmentLaunch> {
  const launchId = validateIdentifier(
    options.input.launchId || `launch_${randomUUID().replaceAll("-", "")}`,
    "INVALID_LAUNCH_ID",
  );
  const strategy = agentLaunchStrategy(options.input.cli);
  if (!strategy.requiresTempSettings) {
    // OpenCode 使用全局 JSONC、dsh 使用 settings.yaml、ZCode 使用 v2/config.json，
    // Codex 零落盘：均由 config-sync 托管，启动不需要私有临时 settings。
    return {
      command: buildDevelopmentLaunchCommand({ ...options.input, launchId }),
    };
  }

  await mkdir(options.tempRoot, { recursive: true, mode: 0o700 });
  const runtimeDirectory = join(options.tempRoot, launchId);
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await chmod(runtimeDirectory, 0o700).catch(() => undefined);
  try {
    const settingsPath = join(runtimeDirectory, "claude-settings.json");
    await writePrivateJson(settingsPath, buildClaudeSettings({
      platform: options.input.platform,
      localBaseUrl: options.input.localBaseUrl,
      subscriptionPassthrough: options.input.subscriptionPassthrough,
    }));
    return {
      runtimeDirectory,
      settingsPath,
      command: buildDevelopmentLaunchCommand({
        ...options.input,
        launchId,
        settingsPath,
      }),
    };
  } catch (error) {
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function buildClaudeSettings(input: {
  platform: SupportedDevelopmentPlatform;
  localBaseUrl: string;
  subscriptionPassthrough?: boolean;
}): { env: { ANTHROPIC_BASE_URL: string; ANTHROPIC_AUTH_TOKEN?: string } } {
  const gatewayBaseUrl = new URL(validateLocalBaseUrl(input.localBaseUrl)).origin;
  const env: {ANTHROPIC_BASE_URL: string; ANTHROPIC_AUTH_TOKEN?: string} = {
    ANTHROPIC_BASE_URL: `${gatewayBaseUrl}/claude`,
  };
  if (!input.subscriptionPassthrough) {
    env.ANTHROPIC_AUTH_TOKEN = GATEWAY_PLACEHOLDER_TOKEN;
  }
  return {env};
}

export function normalizeDevelopmentManualOverrides(
  value: unknown,
): DevelopmentManualOverrides {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new Error("INVALID_OVERRIDE");

  const result: DevelopmentManualOverrides = {};
  const stringKeys = [
    "sandboxMode",
    "effortLevel",
    "permissionMode",
  ] as const;
  for (const key of stringKeys) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string") throw new Error("INVALID_OVERRIDE");
    result[key] = validateText(field, "INVALID_OVERRIDE", 256);
  }
  const numberKeys = [
    "claudeMaxContextTokens",
    "claudeAutoCompactTokens",
  ] as const;
  for (const key of numberKeys) {
    const number = value[key];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error("INVALID_OVERRIDE");
    }
    result[key] = number;
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => undefined);
}
