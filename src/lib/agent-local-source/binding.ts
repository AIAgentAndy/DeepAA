/**
 * 绑定推导（双链路观测）：通道 B 的启用、归属与模型过滤完全由现有供应商目标配置
 * 推导，零独立配置——归因目标 = 该 Agent 对应官方预设的合格供应商目标（目标启用
 * 且模型 scope 含该 Agent），绑定即现有模型归属机制，无任何新配置面。
 *
 * 归因目标选取（2026-10-06 修订，取代「默认目标必须为对应官方预设」旧规则）：
 * 本地直连行的 provider 白名单已在适配器层锁定官方套餐身份，数据自证归属官方预设，
 * 归因不依赖默认目标猜测。顺序：默认目标在合格候选内 → 归它（显式选择优先，兼容
 * 旧语义）；否则取创建时间最早的合格候选（并列按 id 稳定排序）。默认目标指向第三方
 * （如 zcode 默认切到火山套餐走网关）不再静默关闭直连导入；多同预设目标（个人/
 * 公司双账号）想精确分账时，把默认目标指向对应账号即可。预设与 URL 均无唯一性
 * 硬校验（identical_upstream_urls 只护栏路由 ID 自动派生、可手动区分词绕过），
 * 因此「最早创建」兜底必须稳定可复现。
 */

import {LOCAL_IMPORT_LOOKBACK_DAYS_MS} from "./windows";
import {readProxyConfigForPricing} from "@/lib/pricing";
import {PROVIDER_PRESETS} from "@/lib/provider-presets";
import {agentScopeIncludes} from "@/types";
import type {AgentId, ProxyTarget} from "@/types";

import {localImportPresetForAgent} from "./presets";

export interface LocalImportBinding {
  agentId: AgentId;
  targetId: string;
  targetName: string;
  /** 模型白名单（scope 含该 Agent 的归一模型名）。 */
  allowedModels: ReadonlySet<string>;
  /** 选中目标是否为该 Agent 的默认目标（false = 默认不在候选内、按创建时间兜底选中）。 */
  viaDefaultTarget: boolean;
  defaultCredentialId?: string;
  /**
   * 导入下界（epoch 毫秒）= max(回看窗口 30 天, 目标供应商创建时刻)：
   * 供应商建立之前的请求对本系统没有归因意义（用户确认 2026-09-16）。
   */
  floorEpochMs: number;
}

export type LocalImportBindingStatus =
  | {state: "bound"; binding: LocalImportBinding}
  | {state: "disabled"; reason: string};

/** 目标创建时刻（epoch 毫秒）：缺失/不可解析视为 0（最早），保证排序稳定。 */
function targetCreatedAtMs(target: ProxyTarget): number {
  const parsed = target.createdAt !== undefined ? Date.parse(target.createdAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 目标上 scope 含该 Agent 的归一模型名集合（空集 = 该目标未绑定此 Agent 的模型面）。 */
function agentScopedModels(target: ProxyTarget, agentId: AgentId): Set<string> {
  return new Set(
    Object.entries(target.supportedModelScopes ?? {})
      .filter(([, scopes]) => agentScopeIncludes(scopes, agentId))
      .map(([model]) => model.trim().toLowerCase()),
  );
}

/** 无合格候选时的诊断 reason：逐个说明官方预设目标为何不合格，缺什么说什么。 */
function disabledReason(presetTargets: readonly ProxyTarget[], presetId: string, agentId: AgentId): string {
  if (presetTargets.length === 0) {
    return `未配置官方预设 ${presetId} 的供应商目标`;
  }
  const preset = PROVIDER_PRESETS.find(item => item.id === presetId);
  const notes = presetTargets.map(target => {
    if (target.enabled === false) return `${target.id} 已停用`;
    if (preset && target.billingChannel !== undefined && target.billingChannel !== preset.billingChannel) {
      return `${target.id} 计费通道与预设不符（${target.billingChannel}）`;
    }
    if (agentScopedModels(target, agentId).size === 0) {
      return `${target.id} 没有任何模型 scope 含 ${agentId}`;
    }
    return `${target.id} 不合格`;
  });
  return `官方预设 ${presetId} 目标均不可用：${notes.join("；")}`;
}

export async function resolveLocalImportBinding(
  dataDir: string,
  agentId: AgentId,
): Promise<LocalImportBindingStatus> {
  const presetId = localImportPresetForAgent(agentId);
  if (!presetId) {
    return {state: "disabled", reason: `agent ${agentId} 无官方直连导入适配（未声明官方预设映射）`};
  }
  const config = await readProxyConfigForPricing(dataDir);
  const preset = PROVIDER_PRESETS.find(item => item.id === presetId);
  const presetTargets = (config?.targets ?? []).filter(target => target.presetId === presetId);
  const candidates = presetTargets
    .filter(target => target.enabled !== false)
    .filter(target => !(preset && target.billingChannel !== undefined && target.billingChannel !== preset.billingChannel))
    .map(target => ({target, models: agentScopedModels(target, agentId)}))
    .filter(entry => entry.models.size > 0)
    .sort((left, right) =>
      targetCreatedAtMs(left.target) - targetCreatedAtMs(right.target)
      || (left.target.id < right.target.id ? -1 : 1));
  if (candidates.length === 0) {
    return {state: "disabled", reason: disabledReason(presetTargets, presetId, agentId)};
  }
  // 默认目标在候选内 → 显式选择优先；否则取创建时间最早的候选。
  const defaultTargetId = config?.agentConnections?.[agentId]?.defaultTargetId;
  const chosen = candidates.find(entry => entry.target.id === defaultTargetId) ?? candidates[0]!;
  const target = chosen.target;
  const defaultCredentialId = target.development?.defaultCredentials?.[agentId];
  return {
    state: "bound",
    binding: {
      agentId,
      targetId: target.id,
      targetName: target.name,
      allowedModels: chosen.models,
      viaDefaultTarget: target.id === defaultTargetId,
      floorEpochMs: Math.max(
        Date.now() - LOCAL_IMPORT_LOOKBACK_DAYS_MS,
        targetCreatedAtMs(target),
      ),
      ...(defaultCredentialId ? {defaultCredentialId} : {}),
    },
  };
}
