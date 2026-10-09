/**
 * 官方目录 wireApis 自动跟随（终极方案 2026-09-10 用户确认）：
 * 目标侧的模型协议能力（supportedModelWireApis）不是用户决策，价格中心条目的
 * wireApis 变化后由本模块物化到所有引用目标——代理进程按红线不读价格中心，
 * 必须写入 proxy-config（经 ProxyConfigStore 文件锁 + revision 安全更新）。
 *
 * 只覆盖「目标白名单内且价格中心 wireApis 实际变化」的模型；
 * 白名单/Agent 归属/价格等用户决策字段一概不动（方案 a：归属不自动加宽，
 * 官方能力收窄由运行时闸门按最新 wireApis 自动收严）。
 */
import {ProxyConfigStore} from "@/proxy-config";
import type {ProxyConfig, WireApi} from "@/types";
import {normalizePricingConfig, pricingEntryRuntimeModelId, type PricingConfig} from "@/lib/pricing";

export interface WireApiFollowResult {
  /** 发生 wireApis 变化并被物化的目标数量。 */
  updatedTargetCount: number;
  /** 物化覆盖的（目标 × 模型）数量。 */
  patchedModelCount: number;
}

/** 对比合并前后价格中心条目 wireApis，收集需要物化的（vendor/model → wireApis）补丁。 */
export function collectWireApiChanges(
  before: PricingConfig,
  after: PricingConfig,
): Map<string, readonly WireApi[]> {
  const afterByIdentity = new Map(normalizePricingConfig(after).models.map(entry => [
    `${entry.vendor.trim().toLowerCase()}\u0000${pricingEntryRuntimeModelId(entry).trim().toLowerCase()}`,
    entry,
  ]));
  const changes = new Map<string, readonly WireApi[]>();
  for (const entry of normalizePricingConfig(before).models) {
    const identity = `${entry.vendor.trim().toLowerCase()}\u0000${pricingEntryRuntimeModelId(entry).trim().toLowerCase()}`;
    const next = afterByIdentity.get(identity);
    if (!next) continue;
    const beforeApis = entry.supportedWireApis ?? [];
    const afterApis = next.supportedWireApis ?? [];
    const same = beforeApis.length === afterApis.length && beforeApis.every(api => afterApis.includes(api));
    if (same) continue;
    changes.set(`${next.vendor}\u0000${pricingEntryRuntimeModelId(next)}`, afterApis);
  }
  return changes;
}

/**
 * 把价格中心 wireApis 变化物化到引用目标：按目标 pricing.vendor + supportedModels
 * 命中变化条目，经 ProxyConfigStore 原子更新（无实际变化不递增 revision）。
 */
export async function applyWireApiFollowUp(
  config: ProxyConfig,
  changes: Map<string, readonly WireApi[]>,
): Promise<WireApiFollowResult> {
  if (changes.size === 0) return {updatedTargetCount: 0, patchedModelCount: 0};
  const followUp: Record<string, Record<string, readonly WireApi[]>> = {};
  let patchedModelCount = 0;
  for (const target of config.targets) {
    const modelPatch: Record<string, readonly WireApi[]> = {};
    for (const modelId of target.supportedModels) {
      const mapping = target.pricing?.modelVendors?.[modelId];
      const vendor = mapping?.vendor?.trim().toLowerCase()
        || target.pricing?.vendor?.trim().toLowerCase();
      if (!vendor) continue;
      const wireApis = changes.get(`${vendor}\u0000${modelId.trim().toLowerCase()}`);
      if (wireApis) {
        modelPatch[modelId] = wireApis;
        patchedModelCount += 1;
      }
    }
    if (Object.keys(modelPatch).length > 0) {
      followUp[target.id] = modelPatch;
    }
  }
  if (Object.keys(followUp).length === 0) return {updatedTargetCount: 0, patchedModelCount: 0};
  const store = new ProxyConfigStore();
  await store.init();
  await store.updateConfig({wireApiFollowUp: followUp});
  return {updatedTargetCount: Object.keys(followUp).length, patchedModelCount};
}
