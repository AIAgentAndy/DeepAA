import type { ProxyConfig, ProxyTarget } from "../types";
import {
  displayNameFromUpstreamUrl as displayNameFromUrl,
  resolveDerivedRouteId,
  type RouteIdOccupant,
} from "./proxy-url";
import { validateTargetModelFallbacks } from "./proxy-management-domain";

/** 校验并归一化单个代理供应商草稿的选项。 */
export interface SingleTargetDraftOptions {
  /** 本地代理入口地址；V3 只用于保持调用签名稳定，不再写入供应商。 */
  localProxyBaseUrl?: string;
  /** 其余代理供应商，用于路由 ID 和双协议上游 URL 唯一性校验。 */
  otherTargets?: ProxyTarget[];
  /** 价格倍率输入草稿；缺省时回退到供应商已配置值。 */
  /** 已持久化供应商锁定路由 ID：修改 BaseURL 不再跟随派生，避免外部引用（CLI 配置、密钥、价格映射、历史数据）失配。 */
  lockRouteId?: boolean;
}

export interface SingleTargetDraftResult {
  ok: boolean;
  errors: string[];
  target?: ProxyTarget;
}

export function createProxyTargetDraft(
  _existingTargetCount: number,
  timestamp: string,
  localProxyBaseUrl = "http://127.0.0.1:3211",
): ProxyTarget {
  // 新增代理默认全部为空；路由 ID 留空，保存时按必填的上游 URL 自动派生。
  void localProxyBaseUrl;
  void _existingTargetCount;
  const id = "";
  return {
    id,
    name: "",
    openaiUrl: "",
    anthropicUrl: "",
    enabled: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    supportedModels: [],
    pricing: {
      vendor: "",
    },
  };
}

export function routeIdPatchForNameSync(
  _target: ProxyTarget,
  nextId: string,
  nameWasManuallyEdited: boolean
): Pick<ProxyTarget, "id"> | Pick<ProxyTarget, "id" | "name"> {
  if (nameWasManuallyEdited) {
    return { id: nextId };
  }

  return {
    id: nextId,
    name: nextId,
  };
}

export function deriveProxyTargetPatchFromBaseUrl(
  /** 已合并最新两个协议 URL 的目标草稿；路由 ID 候选链同时参考两个协议来源。 */
  target: ProxyTarget,
  nameSourceUrl: string,
  nameWasManuallyEdited: boolean,
  localProxyBaseUrl = "http://127.0.0.1:3211",
  lockRouteId = false,
  existingTargets: readonly RouteIdOccupant[] = [],
): Pick<ProxyTarget, "id"> & Partial<Pick<ProxyTarget, "name">> {
  // 已持久化供应商的路由 ID 是 CLI 配置、密钥、价格映射与历史数据的锚点，保存后锁定。
  if (lockRouteId && target.id) {
    return {id: target.id, name: nameWasManuallyEdited ? target.name : displayNameFromUrl(nameSourceUrl)};
  }
  void localProxyBaseUrl;
  // 统一候选链（主域优先五层链）取全局唯一候选；冲突或无可用 URL 时返回空，
  // 由保存校验按冲突原因引导手动修改。
  const resolution = resolveDerivedRouteId(
    target.openaiUrl || undefined,
    target.anthropicUrl || undefined,
    existingTargets,
  );
  return {
    id: resolution.status === "resolved" ? resolution.id : "",
    name: nameWasManuallyEdited ? target.name : displayNameFromUrl(nameSourceUrl),
  };
}

export function displayNameFromUpstreamUrl(value: string): string {
  return displayNameFromUrl(value);
}

export function proxyTargetUiKey(target: ProxyTarget, index: number): string {
  if (target.createdAt) {
    return `${target.createdAt}-${index}`;
  }

  return `${target.id}-${index}`;
}

/**
 * 校验并归一化单个代理供应商草稿：自动派生路由 ID 和名称，
 * 并对必填项和与其它供应商的唯一性做校验。全局保存与单供应商保存共用同一套规则。
 */
export function normalizeSingleTargetDraft(
  target: ProxyTarget,
  index: number,
  options: SingleTargetDraftOptions = {},
): SingleTargetDraftResult {
  const errors: string[] = [];
  const localProxyBaseUrl = options.localProxyBaseUrl || "http://127.0.0.1:3211";
  const normalizedOpenaiUrl = normalizeHttpUrlDraft(target.openaiUrl || "");
  const normalizedAnthropicUrl = normalizeHttpUrlDraft(target.anthropicUrl || "");
  const primaryUrl = normalizedOpenaiUrl || normalizedAnthropicUrl;
  // 已持久化供应商锁定路由 ID；新增草稿优先使用用户手动填写的 ID（非 new-target-* 占位），
  // 未手动填写时按统一候选链自动派生。
  const draftId = target.id && !target.id.startsWith("new-target-") ? target.id : "";
  let id = options.lockRouteId && target.id ? target.id : draftId;
  let routeIdConflict: "identical_upstream_urls" | "candidates_exhausted" | null = null;
  if (!id) {
    const resolution = resolveDerivedRouteId(
      normalizedOpenaiUrl || undefined,
      normalizedAnthropicUrl || undefined,
      options.otherTargets || [],
    );
    if (resolution.status === "resolved") id = resolution.id;
    else if (resolution.status === "conflict") routeIdConflict = resolution.reason;
  }
  void localProxyBaseUrl;
  const name = target.name.trim() || (primaryUrl ? displayNameFromUrl(primaryUrl) : "");
  // 校验提示优先使用用户可见的代理名称，未命名时回退到序号。
  const label = name || `供应商 ${index + 1}`;
  const vendor = target.pricing?.vendor?.trim() || "";

  if (!name) errors.push(`${label} 的名称必填`);
  if (routeIdConflict === "identical_upstream_urls") {
    errors.push(`${label} 与已有供应商的上游 URL 完全相同，无法自动生成可区分的路由 ID，请在「自定义设置」中手动填写（例如追加 -plan 等区分词）`);
  } else if (routeIdConflict === "candidates_exhausted") {
    errors.push(`${label} 自动生成的路由 ID 已被其它供应商占用，请在「自定义设置」中手动修改路由 ID`);
  } else if (!id) {
    errors.push(`${label} 的路由 ID 必填`);
  }
  if (!normalizedOpenaiUrl && !normalizedAnthropicUrl) {
    errors.push(`${label} 至少需要配置一个协议上游 URL（OpenAI 或 Anthropic）`);
  }
  // 供应商必须至少配置一个支持的模型，否则网关无法路由任何请求；新建与修改都强制。
  if (!(target.supportedModels?.length)) {
    errors.push(`${label} 至少需要配置一个支持的模型`);
  }

  const otherTargets = options.otherTargets || [];
  const otherRouteIds = new Set(otherTargets.map(other => other.id));
  const otherBaseUrls = new Set(
    otherTargets
      .flatMap(other => [other.openaiUrl, other.anthropicUrl])
      .map(value => normalizeHttpUrlDraft(value || ""))
      .filter((value): value is string => value !== null),
  );
  if (id && otherRouteIds.has(id)) {
    errors.push(`${label} 的路由 ID 与其他供应商重复`);
  }
  if (normalizedOpenaiUrl && otherBaseUrls.has(normalizedOpenaiUrl)) {
    errors.push(`${label} 的 OpenAI 上游 URL 与其他供应商重复`);
  }
  if (normalizedAnthropicUrl && otherBaseUrls.has(normalizedAnthropicUrl)) {
    errors.push(`${label} 的 Anthropic 上游 URL 与其他供应商重复`);
  }
  // 备份模型链：条目指向、Agent 适用交集与上限校验（删除级联由服务端 prune 兜底）。
  errors.push(...validateTargetModelFallbacks(target, [target, ...otherTargets]));

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    target: {
      ...target,
      id,
      name,
      openaiUrl: normalizedOpenaiUrl || undefined,
      anthropicUrl: normalizedAnthropicUrl || undefined,
      pricing: {
        ...(target.pricing || {}),
        vendor,
      },
    },
  };
}

/** 解析代理供应商列表：仅当配置显式含非空 targets 时使用；空配置返回空列表，不再回退合成默认供应商。 */
export function resolveProxyTargets(config: ProxyConfig): ProxyTarget[] {
  if (Array.isArray(config.targets) && config.targets.length > 0) return config.targets;
  return [];
}

/** 判断两个代理供应商在业务字段上是否一致，忽略 createdAt / updatedAt。 */
export function proxyTargetsEqual(a: ProxyTarget, b: ProxyTarget): boolean {
  return JSON.stringify(comparableProxyTarget(a)) === JSON.stringify(comparableProxyTarget(b));
}

/** 业务可比较的供应商字段；与开发启动的“未保存修改”判定保持一致。 */
export function comparableProxyTarget(target: ProxyTarget): Omit<ProxyTarget, "createdAt" | "updatedAt"> {
  return {
    id: target.id,
    name: target.name,
    openaiUrl: target.openaiUrl,
    anthropicUrl: target.anthropicUrl,
    enabled: target.enabled,
    supportedModels: target.supportedModels,
    supportedModelScopes: target.supportedModelScopes,
    supportedModelFallbacks: target.supportedModelFallbacks,
    cliSyncExclusions: target.cliSyncExclusions,
    pricing: target.pricing,
    development: target.development,
  };
}

/**
 * 把服务端返回的已保存配置合并回本地草稿：
 * 已保存供应商采用服务端归一化版本，其它未保存草稿与新增草稿保留，
 * 被删除供应商需由调用方先从本地草稿移除后再合并，避免被当作新增草稿保留。
 */
export function reconcileDraftWithPersisted(current: ProxyConfig, persisted: ProxyConfig): ProxyConfig {
  const persistedTargets = persisted.targets ?? [];
  const currentTargets = current.targets ?? [];
  const nextTargets: ProxyTarget[] = [...persistedTargets];
  const matchedPersistedIndexes = new Set<number>();

  for (const draftTarget of currentTargets) {
    const persistedIndex = persistedTargets.findIndex((persistedTarget, index) =>
      !matchedPersistedIndexes.has(index) && sameDraftIdentity(persistedTarget, draftTarget)
    );
    if (persistedIndex < 0) {
      // 服务端不存在该供应商：属于新增且尚未保存的草稿，追加到末尾。
      nextTargets.push(draftTarget);
      continue;
    }
    matchedPersistedIndexes.add(persistedIndex);
    if (!proxyTargetsEqual(persistedTargets[persistedIndex], draftTarget)) {
      // 该供应商仍有未保存修改：保留本地草稿版本；
      // 但启用状态始终以服务端为准（新增草稿首次保存自动启用、启用开关即时生效），
      // 避免旧草稿的 enabled:false 覆盖服务端已启用的状态。
      nextTargets[persistedIndex] = { ...draftTarget, enabled: persistedTargets[persistedIndex].enabled };
    }
  }

  return {
    ...persisted,
    targets: nextTargets,
    agentConnections: current.agentConnections,
  };
}

function sameDraftIdentity(a: ProxyTarget, b: ProxyTarget): boolean {
  if (a.createdAt && b.createdAt) return a.createdAt === b.createdAt;
  return a.id === b.id;
}

/** 归一化 http/https URL；不合法时返回 null，供前端校验与派生共用。 */
export function normalizeHttpUrlDraft(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
