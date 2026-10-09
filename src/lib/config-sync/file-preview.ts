import {parse as parseJsonc, applyEdits, modify} from "jsonc-parser";
import {lstat} from "node:fs/promises";
import {parse as parseToml, stringify as stringifyToml} from "smol-toml";
import {parse as parseYaml, stringify as stringifyYaml} from "yaml";
import {
  MAX_CONFIG_BYTES,
  readOptionalBounded,
  safeRegularFile,
} from "@/lib/config-sync/core/file-io";
import type {
  AgentCliConfigAdapter,
  AgentCliPlan,
  CliConfigFileSpec,
  CliFileArtifact,
  CliFileKind,
} from "@/lib/config-sync/core/types";
import type {
  ConfigFileDisplayData,
  ConfigFileDisplayManifest,
  ConfigFileOwnership,
} from "@/lib/config-sync/file-display";
import {computeManagedFileSections, maskSecretValue} from "@/lib/config-sync/file-display";
import type {AgentId} from "@/types";

const SECRET_KEY = /(api.?key|token|secret|password|bearer|credential|authorization|access.?token)/iu;

/** 稳定 fileId 只引用当前 adapter 计划中的序号，不接受浏览器传入任意路径。 */
export function configFileId(agent: AgentId, artifact: CliFileArtifact, fileIndex: number): string {
  return `${agent}:${artifact.specId}:${fileIndex}`;
}

export function buildConfigFileManifest(input: {
  agent: AgentId;
  fileIndex: number;
  spec: CliConfigFileSpec;
  artifact: CliFileArtifact;
  exists: boolean;
  bytes: number;
  statusMessage?: string;
}): ConfigFileDisplayManifest {
  const {agent, fileIndex, spec, artifact, exists, bytes, statusMessage} = input;
  return {
    fileId: configFileId(agent, artifact, fileIndex),
    agent,
    specId: artifact.specId,
    path: artifact.path,
    kind: artifact.kind,
    active: artifact.active,
    sensitive: Boolean(spec.sensitive),
    description: spec.description,
    managedNamespaces: [...spec.managedNamespaces],
    ownership: ownershipOf(spec, artifact),
    status: statusMessage
      ? "error"
      : spec.sensitive
        ? "sensitive"
        : exists
          ? "ready"
          : artifact.active
            ? "pending-create"
            : "missing",
    ...(statusMessage ? {statusMessage} : {}),
    exists,
    bytes,
    maxBytes: spec.maxBytes ?? MAX_CONFIG_BYTES,
    ...(artifact.note ? {note: artifact.note} : {}),
  };
}

/** fileId 必须命中当前即时生成计划；命不中时拒绝，而不是解析路径。 */
export function findPlannedFile(input: {
  agent: AgentId;
  plan: AgentCliPlan;
  files: readonly CliConfigFileSpec[];
  fileId: string;
}): {artifact: CliFileArtifact; spec: CliConfigFileSpec; fileIndex: number} | undefined {
  const {agent, plan, files, fileId} = input;
  for (let fileIndex = 0; fileIndex < plan.artifacts.length; fileIndex++) {
    const artifact = plan.artifacts[fileIndex]!;
    if (configFileId(agent, artifact, fileIndex) !== fileId) continue;
    const spec = files.find(item => item.id === artifact.specId);
    return spec ? {artifact, spec, fileIndex} : undefined;
  }
  return undefined;
}

/** 为 Agent 首屏生成不含正文的文件清单。 */
export async function buildAgentFileManifests(input: {
  adapter: AgentCliConfigAdapter;
  plan: AgentCliPlan;
}): Promise<ConfigFileDisplayManifest[]> {
  const {adapter, plan} = input;
  const manifests: ConfigFileDisplayManifest[] = [];
  for (let fileIndex = 0; fileIndex < plan.artifacts.length; fileIndex++) {
    const artifact = plan.artifacts[fileIndex]!;
    const spec = adapter.files.find(item => item.id === artifact.specId);
    if (!spec) continue;
    try {
      const exists = await safeRegularFile(artifact.path);
      const bytes = exists ? (await lstat(artifact.path)).size : 0;
      manifests.push(buildConfigFileManifest({agent: adapter.agent, fileIndex, spec, artifact, exists, bytes}));
    } catch (error) {
      manifests.push(buildConfigFileManifest({
        agent: adapter.agent,
        fileIndex,
        spec,
        artifact,
        exists: false,
        bytes: 0,
        statusMessage: errorMessage(error),
      }));
    }
  }
  return manifests;
}

/** 按 fileId 读取单个白名单文件，合并后生成默认局部脱敏或显式完整预览。 */
export async function buildConfigFilePreview(input: {
  adapter: AgentCliConfigAdapter;
  plan: AgentCliPlan;
  fileId: string;
  defaultTargetId: string | undefined;
  currentTargetId: string;
  revealSecrets?: boolean;
}): Promise<ConfigFileDisplayData | undefined> {
  const found = findPlannedFile({
    agent: input.adapter.agent,
    plan: input.plan,
    files: input.adapter.files,
    fileId: input.fileId,
  });
  if (!found) return undefined;
  const {artifact, spec, fileIndex} = found;
  let exists = false;
  let bytes = 0;
  try {
    exists = await safeRegularFile(artifact.path);
    bytes = exists ? (await lstat(artifact.path)).size : 0;
  } catch (error) {
    return {
      ...buildConfigFileManifest({
        agent: input.adapter.agent,
        fileIndex,
        spec,
        artifact,
        exists: false,
        bytes: 0,
        statusMessage: errorMessage(error),
      }),
      content: "",
      beforeContent: "",
      sections: [],
    };
  }
  const manifest = buildConfigFileManifest({agent: input.adapter.agent, fileIndex, spec, artifact, exists, bytes});
  try {
    const existingRaw = await readOptionalBounded(artifact.path, spec.maxBytes);
    const merged = input.adapter.mergeFile({file: spec, existingRaw, artifact});
    const content = sanitizeConfigContent(artifact.kind, merged, {revealSecrets: input.revealSecrets});
    const beforeContent = sanitizeConfigContent(artifact.kind, existingRaw || "", {revealSecrets: input.revealSecrets});
    return {
      ...manifest,
      content,
      beforeContent,
      sections: computeManagedFileSections({
        agent: input.adapter.agent,
        kind: artifact.kind,
        specId: artifact.specId,
        content,
        defaultTargetId: input.defaultTargetId,
        currentTargetId: input.currentTargetId,
      }),
    };
  } catch (error) {
    return {
      ...manifest,
      status: "error",
      statusMessage: errorMessage(error),
      content: "",
      beforeContent: "",
      sections: [],
    };
  }
}

/** 兼容旧调用方的敏感文件摘要构造；新预览路径会按需读取并局部脱敏实际文件。 */
export function sensitiveConfigPreview(manifest: ConfigFileDisplayManifest): ConfigFileDisplayData {
  const content = manifest.specId === "dsh-credentials"
    ? "refs:\n  DEEPAA_GATEWAY_TOKEN: <DeepAA 网关占位凭据>\n"
    : "<敏感文件：仅展示 DeepAA 受管键摘要>\n";
  return {
    ...manifest,
    content,
    beforeContent: "",
    sections: [{
      kind: "shared-managed",
      startLine: 1,
      endLine: Math.max(1, content.trimEnd().split("\n").length),
      label: "DeepAA 安全占位配置",
    }],
  };
}

/**
 * 服务端结构化脱敏：先按格式识别敏感键，再执行字符串兜底遮罩。
 * 返回内容可以进入浏览器响应；输入原文不得被调用方直接序列化。
 */
export function sanitizeConfigContent(
  kind: CliFileKind,
  content: string,
  options: {revealSecrets?: boolean} = {},
): string {
  if (!content.trim()) return content;
  if (options.revealSecrets) return content;
  try {
    if (kind === "json") {
      const parsed = JSON.parse(content) as unknown;
      redactObject(parsed);
      return maskSecretStrings(`${JSON.stringify(parsed, null, 2)}\n`);
    }
    if (kind === "jsonc") {
      const parsed = parseJsonc(content, [], {allowTrailingComma: true}) as unknown;
      const paths: Array<Array<string | number>> = [];
      collectSecretPaths(parsed, [], paths);
      let next = content;
      const formattingOptions = {tabSize: 2, insertSpaces: true, eol: content.includes("\r\n") ? "\r\n" : "\n"};
      for (const path of paths) {
        const rawValue = valueAtPath(parsed, path);
        const replacement = typeof rawValue === "string" ? maskSecretValue(rawValue) : "***";
        next = applyEdits(next, modify(next, path, replacement, {formattingOptions}));
      }
      return maskSecretStrings(next);
    }
    if (kind === "toml") {
      const parsed = parseToml(content) as Record<string, unknown>;
      redactObject(parsed);
      return maskSecretStrings(`${stringifyToml(parsed).trimEnd()}\n`);
    }
    const parsed = parseYaml(content) as unknown;
    redactObject(parsed);
    return maskSecretStrings(stringifyYaml(parsed));
  } catch {
    return maskSecretStrings(content);
  }
}

function ownershipOf(spec: CliConfigFileSpec, artifact: CliFileArtifact): ConfigFileOwnership {
  if (spec.sensitive) return "sensitive";
  if (artifact.specId === "codex-catalog" || artifact.specId === "zcode-state") return "full";
  return "partial";
}

function redactObject(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(redactObject);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key) && child !== undefined && child !== null) {
      (value as Record<string, unknown>)[key] = typeof child === "string"
        ? maskSecretValue(child)
        : "***";
    } else {
      redactObject(child);
    }
  }
}

function collectSecretPaths(
  value: unknown,
  path: Array<string | number>,
  result: Array<Array<string | number>>,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectSecretPaths(child, [...path, index], result));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (SECRET_KEY.test(key) && child !== undefined && child !== null) result.push(childPath);
    else collectSecretPaths(child, childPath, result);
  }
}

function maskSecretStrings(content: string): string {
  return content
    .replace(/sk-[A-Za-z0-9_\-]{8,}/gu, match => maskSecretValue(match))
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/giu,
      (_match, prefix: string, value: string) => `${prefix}${maskSecretValue(value)}`)
    .replace(/eyJ[A-Za-z0-9_-]{12,}/gu, match => maskSecretValue(match));
}

function valueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "配置文件读取失败";
  if (error.message === "CONFIG_PATH_INVALID") return "配置路径不是安全的普通文件";
  if (/too large|exceed|MAX|limit/iu.test(error.message)) return "配置文件超过 1 MiB 读取上限";
  return error.message || "配置文件读取失败";
}
