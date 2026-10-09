import {findNodeAtLocation, parseTree, type Node as JsonNode} from "jsonc-parser";
import {parseDocument} from "yaml";
import type {AgentId} from "@/types";
import type {CliFileKind} from "@/lib/config-sync/core/types";
import {OPENCODE_PROVIDER_PREFIX} from "@/lib/config-sync/core/placeholder-auth";
import {isGatewayModelForTarget} from "@/proxy/gateway-prefix";

/**
 * 受管文件「段级高亮」纯计算模块。
 *
 * 供供应商管理页「Agent 接入」展示：对每个已接入 Agent 的受管配置文件（同步后
 * 合并完整的最终内容），按行切分成三种块：
 * - current-target：涉及「当前正在查看的供应商」的块（按 targetId 前缀/命名空间判定）；
 * - managed-other：属 DeepAA 网关但对应其它供应商的受管块；
 * - unmanaged：用户自定义内容（前端默认折叠，展开时再做敏感值打码）。
 *
 * 只输出行区间与归属，不做任何文件 I/O，便于前端自由渲染与单元测试。
 */

export type ConfigFileSectionKind = "current-target" | "shared-managed" | "managed-other" | "unmanaged";

export interface ConfigFileSection {
  kind: ConfigFileSectionKind;
  /** 1-based 起始行（含）。 */
  startLine: number;
  /** 1-based 结束行（含）。 */
  endLine: number;
  /** 展示说明，例如受管命名空间或「用户自定义内容」。 */
  label: string;
}

export type ConfigFileOwnership = "partial" | "full" | "sensitive";
export type ConfigFileStatus = "ready" | "missing" | "pending-create" | "sensitive" | "error";

/** Agent 接入页首屏只返回的文件清单；严禁包含配置正文。 */
export interface ConfigFileDisplayManifest {
  fileId: string;
  agent: AgentId;
  specId: string;
  path: string;
  kind: CliFileKind;
  active: boolean;
  sensitive: boolean;
  description: string;
  managedNamespaces: string[];
  ownership: ConfigFileOwnership;
  status: ConfigFileStatus;
  statusMessage?: string;
  exists: boolean;
  bytes: number;
  maxBytes: number;
  note?: string;
}

/** 用户展开单个白名单文件后返回的服务端脱敏预览。 */
export interface ConfigFileDisplayData extends ConfigFileDisplayManifest {
  /** 同步后该文件将被写成的完整内容（sensitive 文件为空）。 */
  content: string;
  /** 同步前的服务端脱敏内容；用于全屏查看时对照。 */
  beforeContent: string;
  sections: ConfigFileSection[];
}

interface SectionContext {
  content: string;
  /** 该 Agent 当前默认供应商 targetId；未设置默认时为 undefined。 */
  defaultTargetId: string | undefined;
  currentTargetId: string;
}

/**
 * 计算单个受管文件的行级归属分块。非 agent/specId 感知场景（内容为空）返回空数组。
 * 各格式在合并后内容里定位受管命名空间，并叠加「当前供应商」前缀判定。
 */
export function computeManagedFileSections(input: {
  agent: AgentId;
  kind: CliFileKind;
  specId: string;
  content: string;
  defaultTargetId: string | undefined;
  currentTargetId: string;
}): ConfigFileSection[] {
  const {content} = input;
  if (!content.trim()) return [];
  const context: SectionContext = {
    content,
    defaultTargetId: input.defaultTargetId,
    currentTargetId: input.currentTargetId,
  };
  switch (input.agent) {
    case "codex":
      return input.kind === "toml"
        ? codexTomlSections(context)
        : codexCatalogSections(context);
    case "claude":
      return claudeSettingsSections(context);
    case "opencode":
      return opencodeJsoncSections(context);
    case "dsh":
      if (input.specId === "dsh-settings") return dshSettingsSections(context);
      if (input.specId === "dsh-profile-patch") return dshProfilePatchSections(context);
      return dshCredentialsSections(context);
    case "zcode":
      return input.specId === "zcode-state"
        ? zcodeStateSections(context)
        : zcodeConfigSections(context);
    default:
      return [];
  }
}

/** 单行的归属标签：kind + 可选的显式展示说明（用于同一 kind 内再分段）。 */
interface RowTag {
  kind: ConfigFileSectionKind;
  label?: string;
}

/**
 * 把逐行归属标签归一为连续段。
 *
 * 规则：
 * - 空白行继承前一行标记，避免在受管块之间产生孤立的 unmanaged 空段；
 * - 未标记行按「用户自定义内容」处理（unmanaged）；
 * - 相邻同 kind 行归并为一段；双方都有显式 label 且 label 不同时在段内断开
 *   （如 Claude 的 env 与 model、OpenCode 的 model 与 small_model 各自成段）。
 */
function toSections(
  content: string,
  tags: (RowTag | undefined)[],
  fallbackLabel: (startLine: number) => string,
): ConfigFileSection[] {
  const lines = content.split("\n");
  const total = lines.length;
  // 空白行继承前一行标记，避免在受管块之间产生孤立的 unmanaged 空段。
  for (let line = 1; line <= total; line++) {
    if (tags[line]) continue;
    const previous = tags[line - 1];
    if (line > 1 && lines[line - 1]!.trim() === "" && previous) {
      tags[line] = previous;
    }
  }
  const sections: ConfigFileSection[] = [];
  let row = 1;
  while (row <= total) {
    const kind: ConfigFileSectionKind = tags[row]?.kind ?? "unmanaged";
    const startLabel = tags[row]?.label || "";
    const start = row;
    while (row + 1 <= total) {
      const next = tags[row + 1];
      const nextKind: ConfigFileSectionKind = next?.kind ?? "unmanaged";
      if (nextKind !== kind) break;
      const nextLabel = next?.label || "";
      if (kind !== "unmanaged" && startLabel && nextLabel && nextLabel !== startLabel) break;
      row++;
    }
    sections.push({
      kind,
      startLine: start,
      endLine: row,
      label: startLabel || fallbackLabel(start) || "用户自定义内容",
    });
    row++;
  }
  return sections;
}

interface PropertyEntry {
  key: string;
  valueNode: JsonNode;
}

/**
 * 枚举对象节点的属性子节点为「键名 + 值 Node」条目。
 * jsonc-parser 的 property 节点不暴露 key/value，而是 children=[keyNode, valueNode]；
 * key 必须为字符串字面量，否则跳过该条目。
 */
function propertyEntries(node: JsonNode | undefined): PropertyEntry[] {
  if (!node?.children) return [];
  const entries: PropertyEntry[] = [];
  for (const child of node.children) {
    if (child.type !== "property") continue;
    const pair = child.children || [];
    const keyNode = pair[0];
    const valueNode = pair[1];
    if (typeof keyNode?.value !== "string" || !valueNode) continue;
    entries.push({key: keyNode.value, valueNode});
  }
  return entries;
}

/** 读取 Node 的字符串字面量值；非字符串返回 undefined。 */
function nodeStringValue(node: unknown): string | undefined {
  return typeof (node as JsonNode | undefined)?.value === "string"
    ? (node as JsonNode).value as string
    : undefined;
}

/** 1-based 行号：偏移量位于该行内。 */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** 1-based 结束行号（offset+length 处可能落在换行上，减 1 对齐到实际内容行）。 */
function lineEnd(text: string, offset: number, length: number): number {
  return Math.max(lineAt(text, offset), lineAt(text, offset + Math.max(length - 1, 0)));
}

/**
 * Codex config.toml：受管段为顶层 model/model_provider/model_catalog_json 标量、
 * [model_providers.deepaa_gateway] 与 profiles.deepaa_* 表。
 * 合并后内容由 smol-toml 重新序列化，格式确定，可逐行按 section 头与顶层键定位。
 */
function codexTomlSections(context: SectionContext): ConfigFileSection[] {
  const {content, currentTargetId} = context;
  const lines = content.split("\n");
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  const targetProfileKey = codexProfileKey(currentTargetId);
  const managedScalarKeys = new Set(["model", "model_provider", "model_catalog_json"]);
  let currentSection = "";

  // 受管顶级标量键行（仅在首个 table 之前出现；合并产物里 table 在标量之后）。
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const scalar = /^([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (scalar && managedScalarKeys.has(scalar[1]!)) {
      // model 指向当前供应商默认模型时记 current；其余网关标量记 managed。
      const value = line.slice(line.indexOf("=") + 1).trim();
      const modelValue = /^"(.*)"$/u.exec(value)?.[1] ?? "";
      const isCurrent = scalar[1] === "model" && isGatewayModelForTarget(modelValue, currentTargetId);
      tags[index + 1] = {kind: isCurrent ? "current-target" : "managed-other", label: scalar[1]};
      continue;
    }
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) currentSection = section[1]!;
  }

  // 表级别的受管判读：逐行按所在 section 归类。
  currentSection = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const name = section[1]!;
      currentSection = name;
      if (name === "model_providers.deepaa_gateway") {
        tags[index + 1] = {kind: "managed-other", label: name};
      } else if (name.startsWith("profiles.deepaa_")) {
        tags[index + 1] = {
          kind: name === `profiles.${targetProfileKey}` ? "current-target" : "managed-other",
          label: name,
        };
      }
      // 其它表不标记 → 保持用户自定义内容。
      continue;
    }
    if (tags[index + 1]) continue; // 已标记的标量行不覆盖
    if (currentSection === "model_providers.deepaa_gateway") {
      tags[index + 1] = {kind: "managed-other"};
    } else if (currentSection.startsWith("profiles.deepaa_")) {
      tags[index + 1] = {
        kind: currentSection === `profiles.${targetProfileKey}` ? "current-target" : "managed-other",
      };
    }
  }

  return toSections(content, tags, row => {
    const line = lines[row - 1]!;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) return section[1]!;
    const scalar = /^([A-Za-z0-9_.-]+)\s*=/.exec(line);
    return scalar ? scalar[1]! : "当前供应商相关块";
  });
}

/** profiles.deepaa_* 键名，与 codex adapter 生成侧保持一致的清洗规则。 */
function codexProfileKey(targetId: string): string {
  return `deepaa_${targetId.replace(/[^a-z0-9]/gu, "_")}`;
}

/**
 * Codex catalog.json：整体受管文件，models[] 中 id 前缀为当前供应商的可逐
 * 条供应商注 current / managed；结构行并入相邻条目，不留未命名块。
 */
function codexCatalogSections(context: SectionContext): ConfigFileSection[] {
  const {content, currentTargetId} = context;
  const lines = content.split("\n");
  const tree = parseTree(content, [], {allowTrailingComma: true});
  const modelsNode = tree && findNodeAtLocation(tree, ["models"]);
  if (!modelsNode || !modelsNode.children) return [];
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  // 整文件受管：先铺 managed-other，再对当前供应商条目覆盖为 current。
  for (let line = 1; line <= lines.length; line++) tags[line] = {kind: "managed-other"};
  for (const item of modelsNode.children) {
    if (item.type !== "object") continue;
    // Codex 模型目录的真实主键是 slug；兼容读取旧测试/旧目录中的 id，
    // 但绝不能要求 id 存在，否则真实 all.json 会被整体误判为其它供应商。
    const modelId = nodeStringValue(item && findNodeAtLocation(item, ["slug"]))
      ?? nodeStringValue(item && findNodeAtLocation(item, ["id"]));
    if (!modelId) continue;
    const start = lineAt(content, item.offset);
    const end = lineEnd(content, item.offset, item.length);
    const kind = isGatewayModelForTarget(modelId, currentTargetId) ? "current-target" : "managed-other";
    for (let row = start; row <= end; row++) tags[row] = {kind, label: `models[${modelId}]`};
  }
  return toSections(content, tags, () => "受管模型目录");
}

/**
 * Claude Code settings.json（用户级/项目级共用）：受管键 env 与 model 属于
 * 当前默认供应商；仅当默认供应商正是当前查看的 target 时标记 current。
 */
function claudeSettingsSections(context: SectionContext): ConfigFileSection[] {
  const {content, defaultTargetId, currentTargetId} = context;
  const lines = content.split("\n");
  const tree = parseTree(content, [], {allowTrailingComma: true});
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  const envNode = tree && findNodeAtLocation(tree, ["env"]);
  if (envNode) {
    const start = lineAt(content, envNode.offset);
    const end = lineEnd(content, envNode.offset, envNode.length);
    for (let row = start; row <= end; row++) {
      tags[row] = {kind: "shared-managed", label: "env"};
    }
    for (const entry of propertyEntries(envNode)) {
      if (!entry.key.startsWith("ANTHROPIC_")) continue;
      const value = nodeStringValue(entry.valueNode) || "";
      const isShared = entry.key === "ANTHROPIC_BASE_URL" || entry.key === "ANTHROPIC_AUTH_TOKEN";
      const kind: ConfigFileSectionKind = isShared
        ? "shared-managed"
        : isGatewayModelForTarget(value, currentTargetId)
          ? "current-target"
          : "managed-other";
      const valueStart = lineAt(content, entry.valueNode.offset);
      const valueEnd = lineEnd(content, entry.valueNode.offset, entry.valueNode.length);
      for (let row = valueStart; row <= valueEnd; row++) {
        tags[row] = {kind, label: `env.${entry.key}`};
      }
    }
  }
  const modelNode = tree && findNodeAtLocation(tree, ["model"]);
  if (modelNode) {
    const value = nodeStringValue(modelNode) || "";
    const isCurrent = isGatewayModelForTarget(value, currentTargetId)
      || (!value && (defaultTargetId === undefined || defaultTargetId === currentTargetId));
    const start = lineAt(content, modelNode.offset);
    const end = lineEnd(content, modelNode.offset, modelNode.length);
    for (let row = start; row <= end; row++) {
      tags[row] = {kind: isCurrent ? "current-target" : "managed-other", label: "model"};
    }
  }
  return toSections(content, tags, () => "受管键");
}

/**
 * ZCode config.json：DeepAA 自有 Provider/自还原因子属于共享接管，
 * models 字典中的每个带路由模型再按 targetId 精确归属。
 */
function zcodeConfigSections(context: SectionContext): ConfigFileSection[] {
  const {content, currentTargetId} = context;
  const lines = content.split("\n");
  const tree = parseTree(content, [], {allowTrailingComma: true});
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  const providerNode = tree && findNodeAtLocation(tree, ["provider"]);
  for (const entry of propertyEntries(providerNode)) {
    const options = findNodeAtLocation(entry.valueNode, ["options"]);
    const baseUrl = nodeStringValue(options && findNodeAtLocation(options, ["baseURL"])) || "";
    const managed = entry.key === "deepaa-gateway"
      || entry.key === "deepaa-state"
      || baseUrl.includes("/zcode");
    if (!managed) continue;
    const start = lineAt(content, entry.valueNode.offset);
    const end = lineEnd(content, entry.valueNode.offset, entry.valueNode.length);
    for (let row = start; row <= end; row++) {
      tags[row] = {kind: "shared-managed", label: `provider.${entry.key}`};
    }
    const modelsNode = findNodeAtLocation(entry.valueNode, ["models"]);
    for (const modelEntry of propertyEntries(modelsNode)) {
      const modelStart = lineAt(content, modelEntry.valueNode.offset);
      const modelEnd = lineEnd(content, modelEntry.valueNode.offset, modelEntry.valueNode.length);
      const kind: ConfigFileSectionKind = isGatewayModelForTarget(modelEntry.key, currentTargetId)
        ? "current-target"
        : "managed-other";
      for (let row = modelStart; row <= modelEnd; row++) {
        tags[row] = {kind, label: `provider.${entry.key}.models[${modelEntry.key}]`};
      }
    }
  }
  return toSections(content, tags, () => "用户自定义内容");
}

/** ZCode 私有 state 文件整体受管，targets[] 中每个目标按 targetId 归属。 */
function zcodeStateSections(context: SectionContext): ConfigFileSection[] {
  const {content, currentTargetId} = context;
  const lines = content.split("\n");
  const tree = parseTree(content, [], {allowTrailingComma: true});
  if (!tree) return [];
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  for (let row = 1; row <= lines.length; row++) {
    tags[row] = {kind: "shared-managed", label: "deepaa"};
  }
  const targetsNode = findNodeAtLocation(tree, ["deepaa", "targets"]);
  for (const item of targetsNode?.children || []) {
    if (item.type !== "object") continue;
    const targetId = nodeStringValue(findNodeAtLocation(item, ["targetId"]));
    if (!targetId) continue;
    const start = lineAt(content, item.offset);
    const end = lineEnd(content, item.offset, item.length);
    const kind: ConfigFileSectionKind = targetId === currentTargetId ? "current-target" : "managed-other";
    for (let row = start; row <= end; row++) {
      tags[row] = {kind, label: `targets[${targetId}]`};
    }
  }
  return toSections(content, tags, () => "deepaa");
}

/**
 * OpenCode opencode.jsonc：受管 provider（opencode-deepaa-gateway-*）与
 * model/small_model。provider 段内再按 models 键前缀把当前供应商模型标为
 * current，从而在同一 provider 下精确定位「当前供应商」条目。
 */
function opencodeJsoncSections(context: SectionContext): ConfigFileSection[] {
  const {content, currentTargetId, defaultTargetId} = context;
  const lines = content.split("\n");
  const tree = parseTree(content, [], {allowTrailingComma: true});
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);

  // 受管 provider 段：先整体 managed，再在段内精标 current 模型条目。
  const providerNode = tree && findNodeAtLocation(tree, ["provider"]);
  const managedProviders = propertyEntries(providerNode)
    .filter(entry => entry.key.startsWith(OPENCODE_PROVIDER_PREFIX));
  for (const entry of managedProviders) {
    const start = lineAt(content, entry.valueNode.offset);
    const end = lineEnd(content, entry.valueNode.offset, entry.valueNode.length);
    for (let row = start; row <= end; row++) tags[row] = {kind: "managed-other", label: `provider.${entry.key}`};
  }
  // provider.models 内当前供应商模型条目精标（覆盖其上 managed-other 标记）。
  for (const entry of managedProviders) {
    const modelsNode = findNodeAtLocation(entry.valueNode, ["models"]);
    for (const modelEntry of propertyEntries(modelsNode)) {
      if (!isGatewayModelForTarget(modelEntry.key, currentTargetId)) continue;
      const start = lineAt(content, modelEntry.valueNode.offset);
      const end = lineEnd(content, modelEntry.valueNode.offset, modelEntry.valueNode.length);
      for (let row = start; row <= end; row++) {
        tags[row] = {kind: "current-target", label: `provider.${entry.key}.models["${modelEntry.key}"]`};
      }
    }
  }
  // model / small_model：指向受管 provider 且默认供应商是当前供应商时标 current。
  const isDefault = defaultTargetId !== undefined && defaultTargetId === currentTargetId;
  for (const key of ["model", "small_model"] as const) {
    const node = tree && findNodeAtLocation(tree, [key]);
    if (!node) continue;
    const start = lineAt(content, node.offset);
    const end = lineEnd(content, node.offset, node.length);
    const kind = isDefault ? "current-target" : "managed-other";
    for (let row = start; row <= end; row++) tags[row] = {kind, label: key};
  }
  return toSections(content, tags, () => "用户自定义内容");
}

/**
 * dsh settings.yaml：受管 llm-pi-ai.providers.deepaa-gateway、agent-default-model
 * 与 permission。DeepAA Provider 的 models 列表内当前供应商条目精标 current；agent-default-model 只有
 * 默认供应商是当前供应商时才标 current。
 */
function dshSettingsSections(context: SectionContext): ConfigFileSection[] {
  const {content, currentTargetId, defaultTargetId} = context;
  const lines = content.split("\n");
  const doc = parseDocument(content);
  const map =
    doc.contents && Array.isArray((doc.contents as unknown as {items?: unknown[]}).items)
      ? doc.contents as unknown as {items: {key?: {value?: unknown}; value?: {range?: number[]}}[]}
      : undefined;
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  if (!map) return [];
  for (const pair of map.items) {
    const key = typeof pair.key?.value === "string" ? pair.key.value : "";
    const range = pair.value?.range;
    if (!range || range.length < 2) continue;
    // 段起点对齐到键行（value.range 只从值块首行起），便于整段高亮。
    const keyOffset = (pair.key as unknown as {range?: number[]})?.range?.[0];
    const start = lineAt(content, keyOffset ?? range[0]!);
    const end = lineEnd(content, range[1]!, 0);
    if (key === "llm-pi-ai") {
      for (let row = start; row <= end; row++) tags[row] = {kind: "managed-other", label: "llm-pi-ai.providers.deepaa-gateway"};
    } else if (key === "agent-default-model") {
      const kind = defaultTargetId !== undefined && defaultTargetId === currentTargetId
        ? "current-target"
        : "managed-other";
      for (let row = start; row <= end; row++) tags[row] = {kind, label: "agent-default-model"};
    } else if (key === "permission") {
      for (let row = start; row <= end; row++) tags[row] = {kind: "managed-other", label: "permission"};
    }
  }
  // DeepAA Provider models 列表内当前供应商条目精标（seq 条目是带 .items 的 YAMLMap）。
  const seq = (() => {
    try {
      const value = doc.getIn(["llm-pi-ai", "providers", "deepaa-gateway", "models"], true) as unknown;
      if (!value || typeof value !== "object" || !("items" in value)) return null;
      return value as {
        items: Array<{range?: number[]; items: Array<{key?: {value?: unknown}; value?: {value?: unknown}}>}>;
      };
    } catch {
      return null;
    }
  })();
  if (seq && Array.isArray(seq.items)) {
    for (const item of seq.items) {
      const idPair = item.items.find(pair => pair.key?.value === "id");
      const id = nodeStringValue(idPair?.value);
      if (!id || !isGatewayModelForTarget(id, currentTargetId)) continue;
      const range = item.range;
      if (!range || range.length < 2) continue;
      const start = lineAt(content, range[0]!);
      const end = lineEnd(content, range[1]!, 0);
      for (let row = start; row <= end; row++) tags[row] = {kind: "current-target", label: `deepaa-gateway.models[${id}]`};
    }
  }
  return toSections(content, tags, () => "用户自定义内容");
}

/**
 * dsh profile patch（cordis.patch.yml，≥0.1.7 布局）：顶层数组按行 id 打标签——
 * 受管三行行级高亮（agent-default-model 按当前供应商精标、models 条目按目标
 * 精标），用户行与注释原样保留为用户自定义内容。
 */
function dshProfilePatchSections(context: SectionContext): ConfigFileSection[] {
  const {content, currentTargetId, defaultTargetId} = context;
  const lines = content.split("\n");
  const doc = parseDocument(content);
  const seq = doc.contents && "items" in doc.contents && Array.isArray(doc.contents.items)
    ? doc.contents as unknown as {
      items: Array<{
        range?: number[];
        items: Array<{key?: {value?: unknown}; value?: unknown}>;
      }>;
    }
    : undefined;
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  if (!seq) return [];
  for (const row of seq.items) {
    const idPair = row.items.find(pair => pair.key?.value === "id");
    const id = nodeStringValue(idPair?.value as {value?: unknown} | undefined);
    const range = row.range;
    if (!id || !range || range.length < 2) continue;
    const start = lineAt(content, range[0]!);
    const end = lineEnd(content, range[1]!, 0);
    if (id === "llm-pi-ai") {
      for (let line = start; line <= end; line++) tags[line] = {kind: "managed-other", label: "llm-pi-ai.providers.deepaa-gateway"};
    } else if (id === "agent-default-model") {
      const kind = defaultTargetId !== undefined && defaultTargetId === currentTargetId
        ? "current-target"
        : "managed-other";
      for (let line = start; line <= end; line++) tags[line] = {kind, label: "agent-default-model"};
    } else if (id === "permission") {
      for (let line = start; line <= end; line++) tags[line] = {kind: "managed-other", label: "permission"};
    }
  }
  // 受管行内 models 列表的当前供应商条目精标（复用 settings 版的定位约定）。
  try {
    // patch 是顶层数组：先按行 id 定位 llm-pi-ai 行，再取行内 config 路径。
    const llmRow = seq.items
      .map(row => row as unknown as {getIn?: (path: string[], keep: boolean) => unknown})
      .find(row => typeof row.getIn === "function"
        && nodeStringValue(row.getIn(["id"], true) as {value?: unknown} | undefined) === "llm-pi-ai");
    const models = llmRow?.getIn?.(["config", "providers", "deepaa-gateway", "models"], true) as unknown;
    if (models && typeof models === "object" && "items" in models && Array.isArray((models as {items?: unknown}).items)) {
      for (const item of (models as {
        items: Array<{range?: number[]; items: Array<{key?: {value?: unknown}; value?: {value?: unknown}}>}>;
      }).items) {
        const idPair = item.items.find(pair => pair.key?.value === "id");
        const id = nodeStringValue(idPair?.value);
        if (!id || !isGatewayModelForTarget(id, currentTargetId)) continue;
        const range = item.range;
        if (!range || range.length < 2) continue;
        const start = lineAt(content, range[0]!);
        const end = lineEnd(content, range[1]!, 0);
        for (let line = start; line <= end; line++) tags[line] = {kind: "current-target", label: `deepaa-gateway.models[${id}]`};
      }
    }
  } catch {
    // models 路径缺失（清理层形态）时跳过条目精标。
  }
  return toSections(content, tags, () => "用户自定义内容");
}

/** dsh credentials：refs 下的 DeepAA 占位键是共享接管，其它凭据仍归用户保留。 */
function dshCredentialsSections(context: SectionContext): ConfigFileSection[] {  const {content} = context;
  const lines = content.split("\n");
  const tags: (RowTag | undefined)[] = new Array(lines.length + 2).fill(undefined);
  let inRefs = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*refs\s*:/u.test(line)) {
      inRefs = true;
      tags[index + 1] = {kind: "shared-managed", label: "refs"};
      continue;
    }
    if (inRefs && /^\S/u.test(line)) inRefs = false;
    if (!inRefs) continue;
    tags[index + 1] = /DEEPAA_GATEWAY_TOKEN\s*:/u.test(line)
      ? {kind: "shared-managed", label: "refs.DEEPAA_GATEWAY_TOKEN"}
      : {kind: "unmanaged", label: "用户凭据"};
  }
  return toSections(content, tags, () => "用户凭据");
}

/** 本地配置查看器默认只隐藏中段，保留首尾各 4 个字符；完整值由显式展开动作请求。 */
export function maskSecretValue(value: string): string {
  if (value === "deepaa-gateway" || value === "DEEPAA_GATEWAY_TOKEN" || value.startsWith("<DeepAA ")) return value;
  if (value.length <= 8) {
    if (value.length <= 4) return "**";
    const edge = Math.max(1, Math.floor(value.length / 2) - 1);
    return `${value.slice(0, edge)}**${value.slice(-edge)}`;
  }
  return `${value.slice(0, 4)}**${value.slice(-4)}`;
}

/** 判断一行是否包含本查看器生成的局部隐藏标记，避免普通 Markdown 的 ** 误触发展开按钮。 */
export function hasMaskedSecret(text: string): boolean {
  return /(?:\bsk-[^\s"'`]*\*\*[^\s"'`]*|\beyJ[^\s"'`]*\*\*[^\s"'`]*|\b(?:api[_-]?key|token|secret|password|bearer|credential)\b[^\n]*\*\*)/iu.test(text);
}

/** 对非受管自定义内容做疑似密钥打码；完整值只在用户显式点击后单独请求。 */
export function maskSensitiveValues(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-]{8,}/gu, match => maskSecretValue(match))
    .replace(/((?:api[_-]?key|token|secret|password|bearer)\s*[:=]\s*["']?)([A-Za-z0-9_\-./=+]{8,})(["']?)/giu,
      (_match, prefix: string, value: string, suffix: string) => `${prefix}${maskSecretValue(value)}${suffix}`);
}
