/**
 * 目录能力变化的定向静默 CLI 同步（2026-09-21 能力下发）：门控与 Agent 判定纯函数。
 *
 * 语义（用户确认）：
 * - 纯价格变化绝不触发 CLI 同步（价格链与能力链分离）；
 * - 新模型（无既有条目）不进受影响集合——无人引用时写了也无内容，
 *   用户在供应商添加配置时由既有前端触发器写入；
 * - 既有模型能力变化（inputModalities / contextWindow / maxOutput / wireApis）
 *   只定向更新「绑定目标包含该模型且 CLI 同步开启」的 Agent，其它 Agent 文件字节不变。
 */

import {KNOWN_AGENT_IDS, type AgentId, type ProxyConfig} from "@/types";
import {normalizePricingConfig, pricingEntryRuntimeModelId, type ModelPriceEntry, type PricingConfig} from "@/lib/pricing";
import {boundTargetsForAgent} from "@/lib/config-sync/core/target-eligibility";
import {agentLabelOf} from "@/lib/config-sync/adapters/common";

/** 能力字段集合：这些字段变化才触发 CLI 静默同步（价格字段不算）。 */
const CAPABILITY_FIELDS = ["inputModalities", "contextWindow", "maxOutput"] as const;

/** 受影响模型键：vendor\u0000runtimeModelId（与 wire-api-follow 的匹配口径一致）。 */
function modelChangeKey(entry: ModelPriceEntry): string {
  return `${entry.vendor.trim().toLowerCase()}\u0000${pricingEntryRuntimeModelId(entry).trim().toLowerCase()}`;
}

/**
 * 对比合并前后价格中心条目的能力字段，收集发生变化的既有模型键集合。
 * 纯价格变化与新增条目不进集合（新增模型无人引用，语义见文件头）。
 */
export function collectCapabilityModelChanges(
  before: PricingConfig,
  after: PricingConfig,
): Set<string> {
  const afterByKey = new Map(normalizePricingConfig(after).models.map(entry => [modelChangeKey(entry), entry]));
  const changed = new Set<string>();
  for (const entry of normalizePricingConfig(before).models) {
    const key = modelChangeKey(entry);
    const next = afterByKey.get(key);
    if (!next) continue;
    for (const field of CAPABILITY_FIELDS) {
      const previousValue = entry[field];
      const nextValue = next[field];
      const same = previousValue === undefined && nextValue === undefined
        || JSON.stringify(previousValue ?? null) === JSON.stringify(nextValue ?? null);
      if (!same) {
        changed.add(key);
        break;
      }
    }
  }
  return changed;
}

/**
 * 反查受影响 Agent：对每个已接入且 cliSyncEnabled 的 Agent，按 boundTargetsForAgent
 * 同一判定（绑定目标 ∩ 协议/凭据/模型合格）检查其绑定目标是否含受影响模型。
 * 判定与 CLI 写入的模型选择完全同源，保证「判受影响 = 会被写」。
 */
export function resolveAgentsForModelChanges(
  config: ProxyConfig,
  changedModelKeys: ReadonlySet<string>,
): AgentId[] {
  if (changedModelKeys.size === 0) return [];
  const agents: AgentId[] = [];
  for (const agent of KNOWN_AGENT_IDS) {
    const connection = config.agentConnections?.[agent];
    if (!connection?.cliSyncEnabled) continue;
    const defaultTarget = config.targets.find(target => target.id === connection.defaultTargetId);
    const targets = boundTargetsForAgent(config, agent, defaultTarget, [], agentLabelOf);
    const affected = targets.some(target => {
      return target.supportedModels.some(modelId =>
        changedModelKeys.has(modelChangeKeyForTarget(target, modelId)));
    });
    if (affected) agents.push(agent);
  }
  return agents;
}

function modelChangeKeyForTarget(
  target: ProxyConfig["targets"][number],
  modelId: string,
): string {
  const mapping = target.pricing?.modelVendors?.[modelId];
  const vendor = mapping?.vendor?.trim().toLowerCase()
    || target.pricing?.vendor?.trim().toLowerCase();
  return `${vendor || ""}\u0000${modelId.trim().toLowerCase()}`;
}
