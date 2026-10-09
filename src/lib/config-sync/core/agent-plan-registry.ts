import {codexCliConfigAdapter} from "@/lib/config-sync/adapters/codex";
import {claudeCliConfigAdapter} from "@/lib/config-sync/adapters/claude";
import {opencodeCliConfigAdapter} from "@/lib/config-sync/adapters/opencode";
import {dshCliConfigAdapter} from "@/lib/config-sync/adapters/dsh";
import {zcodeCliConfigAdapter} from "@/lib/config-sync/adapters/zcode";
import type {
  AgentCliConfigAdapter,
} from "@/lib/config-sync/core/types";
import type {AgentId} from "@/types";

/**
 * CLI 配置适配器注册表：新增 Agent 只在这里注册一个 adapter，
 * 公共引擎、API 预览与开发启动自动扩展，不再出现 if agent === 分支。
 */
const ADAPTERS: readonly AgentCliConfigAdapter[] = [
  codexCliConfigAdapter,
  claudeCliConfigAdapter,
  opencodeCliConfigAdapter,
  dshCliConfigAdapter,
  zcodeCliConfigAdapter,
];

export function cliConfigAdapters(): readonly AgentCliConfigAdapter[] {
  return ADAPTERS;
}

export function cliConfigAdapterFor(agent: AgentId): AgentCliConfigAdapter {
  const adapter = ADAPTERS.find(item => item.agent === agent);
  if (!adapter) throw new Error(`UNSUPPORTED_AGENT: ${agent}`);
  return adapter;
}
