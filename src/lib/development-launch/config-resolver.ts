import { readFile, realpath, stat } from "fs/promises";
import { join } from "path";
import { parse as parseToml } from "smol-toml";
import {parse as parseJsonc} from "jsonc-parser";
import {parse as parseYaml} from "yaml";
import {parseGatewayModelId} from "@/proxy/gateway-prefix";
import type {
  ConfigSource,
  ConfigurationWarning,
  LaunchConfigurationFields,
  LaunchConfigurationResolution,
  ProjectTrust,
  ResolvedConfigValue,
} from "./types";

const MAX_CONFIG_BYTES = 1024 * 1024;

interface ResolveOptions {
  homeDir: string;
  /** 未提供项目目录（如 Codex 客户端模式）时只解析用户级配置。 */
  projectDir?: string;
  profile?: string;
}

interface ConfigLayer {
  source: Exclude<ConfigSource, "manual" | "unset">;
  path: string;
  value?: Record<string, unknown>;
}

export async function resolveCodexConfiguration(
  options: ResolveOptions,
): Promise<LaunchConfigurationResolution> {
  const warnings: ConfigurationWarning[] = [];
  const userPath = join(options.homeDir, ".codex", "config.toml");
  const user = await readTomlLayer("user", userPath, warnings);
  const project = options.projectDir
    ? await readTomlLayer("project", join(options.projectDir, ".codex", "config.toml"), warnings)
    : undefined;
  const projectTrust = project
    ? await resolveProjectTrust(user.value, project.value !== undefined, options.projectDir!)
    : "not_configured";

  let profile: ConfigLayer | undefined;
  if (options.profile) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.profile)) {
      warnings.push({
        code: "INVALID_PROFILE",
        message: "Codex profile 名称只能包含字母、数字、下划线和连字符",
        sourcePath: options.profile,
      });
    } else {
      profile = await readTomlLayer(
        "profile",
        join(options.homeDir, ".codex", `${options.profile}.config.toml`),
        warnings,
      );
    }
  }

  const layers = [
    ...(projectTrust === "trusted" && project ? [project] : []),
    ...(profile ? [profile] : []),
    user,
  ];

  return {
    cli: "codex",
    model: resolveString(layers, "model"),
    modelOptions: uniqueStrings(layers.map(layer => stringValue(layer.value?.model))),
    // 2026-10-02：codex 推理档/沙箱/上下文/压缩阈值不再从 config.toml 回显——
    // 对网关模型由目录条目与 launchPreferences 决定，弹窗回显同源目录能力值。
    fields: emptyClaudeFields(),
    projectTrust,
    warnings,
  };
}

export async function resolveClaudeConfiguration(
  options: Omit<ResolveOptions, "profile">,
): Promise<LaunchConfigurationResolution> {
  const warnings: ConfigurationWarning[] = [];
  const layers: ConfigLayer[] = [];
  if (options.projectDir) {
    layers.push(
      await readJsonLayer(
        "project_local",
        join(options.projectDir, ".claude", "settings.local.json"),
        warnings,
      ),
      await readJsonLayer("project", join(options.projectDir, ".claude", "settings.json"), warnings),
    );
  }
  layers.push(await readJsonLayer("user", join(options.homeDir, ".claude", "settings.json"), warnings));

  const modelCandidates = layers.map(layer => extractClaudeModel(layer.value));
  const modelLayerIndex = modelCandidates.findIndex(Boolean);
  const model = modelLayerIndex >= 0
    ? resolved(modelCandidates[modelLayerIndex]!, layers[modelLayerIndex]!)
    : unset<string>();

  return {
    cli: "claude",
    model,
    modelOptions: uniqueStrings(modelCandidates),
    fields: {
      effortLevel: resolveClaudeString(layers, value => stringValue(value.effortLevel)),
      permissionMode: resolveClaudeString(layers, value => {
        const permissions = recordValue(value.permissions);
        return stringValue(permissions?.defaultMode);
      }),
      claudeMaxContextTokens: resolveClaudeNumber(layers, value => {
        const env = recordValue(value.env);
        return numericValue(env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
      }),
    },
    projectTrust: "not_configured",
    warnings,
  };
}

/**
 * OpenCode 配置解析：全局 opencode.json(c) + 项目 .opencode/opencode.json(c)，
 * 单文件 1 MiB，JSONC 解析；只提取 model / small_model 与 provider 摘要。
 */
export async function resolveOpenCodeConfiguration(
  options: Omit<ResolveOptions, "profile">,
): Promise<LaunchConfigurationResolution> {
  const warnings: ConfigurationWarning[] = [];
  const layers: ConfigLayer[] = [];
  const globalPath = await openCodeGlobalConfigPath(options.homeDir);
  layers.push(await readJsoncLayer("user", globalPath, warnings));
  if (options.projectDir) {
    for (const name of ["opencode.jsonc", "opencode.json"] as const) {
      layers.push(await readJsoncLayer(
        "project",
        join(options.projectDir, ".opencode", name),
        warnings,
      ));
    }
  }
  const modelCandidates = layers.map(layer => stringValue(layer.value?.model));
  const modelLayerIndex = modelCandidates.findLastIndex(Boolean);
  const model = modelLayerIndex >= 0
    ? resolved(modelCandidates[modelLayerIndex]!, layers[modelLayerIndex]!)
    : unset<string>();
  return {
    cli: "opencode",
    model,
    modelOptions: uniqueStrings(modelCandidates),
    fields: emptyLaunchFields(),
    projectTrust: "not_configured",
    warnings,
  };
}

/**
 * dsh 配置解析：$DSH_HOME/settings.yaml（默认 ~/.dsh/settings.yaml），
 * 1 MiB，提取 agent-default-model 与 llm-pi-ai.providers.deepaa-gateway.models
 * 静态列表；兼容读取旧版 llm-deepseek.models，便于配置升级期间平滑过渡。
 */
export async function resolveDshConfiguration(
  options: Omit<ResolveOptions, "profile" | "projectDir">,
): Promise<LaunchConfigurationResolution> {
  const warnings: ConfigurationWarning[] = [];
  const settingsPath = dshSettingsPath(options.homeDir);
  const layer = await readYamlLayer("user", settingsPath, warnings);
  const value = layer.value;
  const agentDefault = recordValue(value?.["agent-default-model"]);
  const llmPiAi = recordValue(value?.["llm-pi-ai"]);
  const providers = recordValue(llmPiAi?.providers);
  const deepaaGateway = recordValue(providers?.["deepaa-gateway"]);
  const llmDeepseek = recordValue(value?.["llm-deepseek"]);
  const model = stringValue(agentDefault?.model);
  const providerModels = Array.isArray(deepaaGateway?.models)
    ? (deepaaGateway.models as unknown[])
        .map(item => stringValue(recordValue(item)?.id))
        .filter((item): item is string => Boolean(item))
    : [];
  const legacyModels = Array.isArray(llmDeepseek?.models)
    ? (llmDeepseek.models as unknown[])
        .map(item => stringValue(recordValue(item)?.id))
        .filter((item): item is string => Boolean(item))
    : [];
  return {
    cli: "dsh",
    model: model ? resolved(model, layer) : unset<string>(),
    modelOptions: uniqueStrings([...(model ? [model] : []), ...providerModels, ...legacyModels]),
    fields: emptyLaunchFields(),
    projectTrust: "not_configured",
    warnings,
  };
}

/**
 * ZCode 配置解析：~/.zcode/v2/config.json（1 MiB 有界读）。
 * 提取 DeepAA 受管条目（自有条目或被接管条目）中的网关模型（<真实模型ID>_<路由ID>）；
 * 条目缺失时仅返回 unset 模型，由启动编排另行提示接管状态，不在此判定。
 */
export async function resolveZcodeConfiguration(
  options: Omit<ResolveOptions, "profile" | "projectDir">,
): Promise<LaunchConfigurationResolution> {
  const warnings: ConfigurationWarning[] = [];
  const layer = await readJsonLayer("user", zcodeConfigPath(options.homeDir), warnings);
  const provider = recordValue(layer.value?.provider) ?? {};
  // 自有条目优先，其次任意含受管 base URL 的接管条目（键名不进解析逻辑）。
  const candidateKeys = ["deepaa-gateway", ...Object.keys(provider).filter(key => key.startsWith("builtin:"))];
  const models: string[] = [];
  let activeModelLayer = layer;
  for (const key of candidateKeys) {
    const entry = recordValue(provider[key]);
    const entryModels = Object.keys(recordValue(entry?.models) ?? {});
    if (!entryModels.some(modelId => parseGatewayModelId(modelId))) continue;
    for (const modelId of entryModels) {
      if (parseGatewayModelId(modelId)) models.push(modelId);
    }
    activeModelLayer = {source: "user" as const, path: layer.path, value: entry};
    break;
  }
  return {
    cli: "zcode",
    model: models[0] ? resolved(models[0], activeModelLayer) : unset<string>(),
    modelOptions: uniqueStrings(models),
    fields: emptyLaunchFields(),
    projectTrust: "not_configured",
    warnings,
  };
}

async function readTomlLayer(
  source: ConfigLayer["source"],
  path: string,
  warnings: ConfigurationWarning[],
): Promise<ConfigLayer> {
  const raw = await readBoundedFile(path, warnings);
  if (raw === undefined) return { source, path };
  try {
    return { source, path, value: recordValue(parseToml(raw)) || {} };
  } catch {
    warnings.push({
      code: "CONFIG_PARSE_FAILED",
      message: "Codex TOML 配置解析失败",
      sourcePath: path,
    });
    return { source, path };
  }
}

async function readJsonLayer(
  source: ConfigLayer["source"],
  path: string,
  warnings: ConfigurationWarning[],
): Promise<ConfigLayer> {
  const raw = await readBoundedFile(path, warnings);
  if (raw === undefined) return { source, path };
  try {
    return { source, path, value: recordValue(JSON.parse(raw)) || {} };
  } catch {
    warnings.push({
      code: "CONFIG_PARSE_FAILED",
      message: "Claude Code settings JSON 解析失败",
      sourcePath: path,
    });
    return { source, path };
  }
}

async function readJsoncLayer(
  source: ConfigLayer["source"],
  path: string,
  warnings: ConfigurationWarning[],
): Promise<ConfigLayer> {
  const raw = await readBoundedFile(path, warnings);
  if (raw === undefined) return { source, path };
  try {
    const parsed = parseJsonc(raw);
    return { source, path, value: recordValue(parsed) || {} };
  } catch {
    warnings.push({
      code: "CONFIG_PARSE_FAILED",
      message: "OpenCode JSONC 配置解析失败",
      sourcePath: path,
    });
    return { source, path };
  }
}

async function readYamlLayer(
  source: ConfigLayer["source"],
  path: string,
  warnings: ConfigurationWarning[],
): Promise<ConfigLayer> {
  const raw = await readBoundedFile(path, warnings);
  if (raw === undefined) return { source, path };
  try {
    const parsed = parseYaml(raw);
    return { source, path, value: recordValue(parsed) || {} };
  } catch {
    warnings.push({
      code: "CONFIG_PARSE_FAILED",
      message: "dsh settings.yaml 解析失败",
      sourcePath: path,
    });
    return { source, path };
  }
}

async function openCodeGlobalConfigPath(homeDir: string): Promise<string> {
  const env = process.env;
  if (env.OPENCODE_CONFIG?.trim()) return env.OPENCODE_CONFIG;
  const directory = env.OPENCODE_CONFIG_DIR?.trim()
    || (process.platform === "win32"
      ? join(env.APPDATA || join(homeDir, "AppData", "Roaming"), "opencode")
      : join(env.XDG_CONFIG_HOME || join(homeDir, ".config"), "opencode"));
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"] as const) {
    const candidate = join(directory, name);
    if (await fileExists(candidate)) return candidate;
  }
  return join(directory, "opencode.jsonc");
}

function dshSettingsPath(homeDir: string): string {
  const dshHome = process.env.DSH_HOME?.trim();
  return join(dshHome || join(homeDir, ".dsh"), "settings.yaml");
}

/** ZCode provider 配置路径：$ZCODE_DATA_BASE_DIR 覆盖优先，缺省 ~/.zcode/v2/config.json。 */
function zcodeConfigPath(homeDir: string): string {
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || join(homeDir, ".zcode");
  return join(base, "v2", "config.json");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readBoundedFile(
  path: string,
  warnings: ConfigurationWarning[],
): Promise<string | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return undefined;
    if (metadata.size > MAX_CONFIG_BYTES) {
      warnings.push({
        code: "CONFIG_TOO_LARGE",
        message: `配置文件超过 ${MAX_CONFIG_BYTES} 字节上限`,
        sourcePath: path,
      });
      return undefined;
    }
    return await readFile(path, "utf-8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    warnings.push({
      code: "CONFIG_READ_FAILED",
      message: "配置文件读取失败",
      sourcePath: path,
    });
    return undefined;
  }
}

async function resolveProjectTrust(
  userConfig: Record<string, unknown> | undefined,
  hasProjectConfig: boolean,
  projectDir: string,
): Promise<ProjectTrust> {
  if (!hasProjectConfig) return "not_configured";
  const projects = recordValue(userConfig?.projects);
  if (!projects) return "unknown";

  const candidates = new Set([projectDir]);
  try {
    candidates.add(await realpath(projectDir));
  } catch {
    // projectDir 的存在性由启动预检单独校验。
  }

  for (const path of candidates) {
    const project = recordValue(projects[path]);
    const trust = stringValue(project?.trust_level);
    if (trust === "trusted" || trust === "untrusted") return trust;
  }
  return "unknown";
}

function resolveString(layers: ConfigLayer[], key: string): ResolvedConfigValue<string> {
  for (const layer of layers) {
    const value = stringValue(layer.value?.[key]);
    if (value !== undefined) return resolved(value, layer);
  }
  return unset<string>();
}

function resolveClaudeString(
  layers: ConfigLayer[],
  select: (value: Record<string, unknown>) => string | undefined,
): ResolvedConfigValue<string> {
  for (const layer of layers) {
    if (!layer.value) continue;
    const value = select(layer.value);
    if (value !== undefined) return resolved(value, layer);
  }
  return unset<string>();
}

function resolveClaudeNumber(
  layers: ConfigLayer[],
  select: (value: Record<string, unknown>) => number | undefined,
): ResolvedConfigValue<number> {
  for (const layer of layers) {
    if (!layer.value) continue;
    const value = select(layer.value);
    if (value !== undefined) return resolved(value, layer);
  }
  return unset<number>();
}

function extractClaudeModel(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  const env = recordValue(value.env);
  return stringValue(env?.ANTHROPIC_MODEL) ?? stringValue(value.model);
}

function resolved<T>(value: T, layer: ConfigLayer): ResolvedConfigValue<T> {
  return { value, source: layer.source, sourcePath: layer.path, overridable: true };
}

function unset<T>(): ResolvedConfigValue<T> {
  return { source: "unset", overridable: true };
}

function emptyClaudeFields(): Pick<
  LaunchConfigurationFields,
  "effortLevel" | "permissionMode" | "claudeMaxContextTokens"
> {
  return {
    effortLevel: unset<string>(),
    permissionMode: unset<string>(),
    claudeMaxContextTokens: unset<number>(),
  };
}

function emptyLaunchFields(): LaunchConfigurationFields {
  return emptyClaudeFields();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
