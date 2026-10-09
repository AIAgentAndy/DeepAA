/**
 * Agent 本地数据源适配器注册表（双链路观测可插拔点）：新增 Agent = 一个 adapter
 * 文件 + 此处一行，公共编排/Worker/UI 零改动。条目由类型层约束 agentId 合法。
 */

import type {AgentId} from "@/types";
import type {AgentLocalSourceAdapter} from "./types";
import {createZcodeLocalSourceAdapter} from "./adapters/zcode";
import {createDshLocalSourceAdapter} from "./adapters/dsh";
import {createCodexLocalSourceAdapter} from "./adapters/codex";

export const AGENT_LOCAL_SOURCE_ADAPTERS: readonly AgentLocalSourceAdapter[] = [
  createZcodeLocalSourceAdapter(),
  createDshLocalSourceAdapter(),
  createCodexLocalSourceAdapter(),
];

export function findLocalSourceAdapter(agentId: AgentId): AgentLocalSourceAdapter | undefined {
  return AGENT_LOCAL_SOURCE_ADAPTERS.find(adapter => adapter.agentId === agentId);
}
